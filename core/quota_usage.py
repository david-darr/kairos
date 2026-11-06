"""Best-effort desktop quota readings. No credential or quota response is persisted.

Claude Code's OAuth usage URL is undocumented and can change. Codex uses the
documented app-server rate-limit request. Both represent account allowances,
not per-model or per-endpoint usage. API/local endpoints only have JARVIS's
own recorded token counts, so each model entry carries those separately from
any provider quota (David, 2026-10-25: every connected model is listed).
"""
import asyncio
import json
import math
import os
import queue
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import httpx

from core import cli_env, model_endpoints, model_marks, token_usage

CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
REFRESH_SECONDS = 300
# A click on a ring forces a fresh reading, but never more often than this per
# provider: the Claude endpoint rate-limits, and a click is not worth a 429.
FORCED_REFRESH_SECONDS = 20
_cache: dict[str, dict] = {}
_retry_after: dict[str, float] = {}


class SignInNeeded(RuntimeError):
    """The CLI's own sign-in is missing, expired or refused."""


class RateLimited(RuntimeError):
    """The provider answered 429."""


class RefreshThrottled(RuntimeError):
    """A forced refresh arrived sooner than FORCED_REFRESH_SECONDS."""


class NoQuotaReported(RuntimeError):
    """The CLI answered but reports no usage limits (older Antigravity builds)."""


# Fixed wording only. Exceptions from HTTP and subprocesses can carry URLs or
# account data, so none of their text ever reaches the response.
NOTES = {
    "needs_sign_in": "Sign-in has expired or is missing. Open the CLI once to renew it.",
    "rate_limited": "The provider asked for a pause. Retrying shortly.",
    "unavailable": "Usage could not be read right now.",
    "no_quota": "This CLI does not report usage limits.",
}


def _percent(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return round(max(0, min(100, float(value))), 1)


def _unix_time(value):
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value) / 1000 if value > 10_000_000_000 else float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return None


def _window(name, used, resets_at):
    percent = _percent(used)
    if percent is None:
        return None
    return {"name": name, "used_percent": percent, "resets_at": _unix_time(resets_at)}


def parse_claude_usage(data):
    """Normalize the current OAuth payload and its older top-level shape."""
    if not isinstance(data, dict):
        return []
    limits = data.get("limits") if isinstance(data, dict) else None
    if not isinstance(limits, list):
        limits = []
    by_kind = {item.get("kind"): item for item in limits if isinstance(item, dict)}
    session = by_kind.get("session") or data.get("five_hour") or {}
    weekly = by_kind.get("weekly_all") or data.get("seven_day") or {}
    windows = []
    for label, item in (("5-hour", session), ("Weekly", weekly)):
        if isinstance(item, dict):
            entry = _window(label, item.get("percent", item.get("utilization")), item.get("resets_at"))
            if entry:
                windows.append(entry)
    return windows


def parse_codex_limits(data):
    payload = data.get("rateLimits") or data
    buckets = payload.get("rateLimitsByLimitId") if isinstance(payload, dict) else None
    if isinstance(buckets, dict):
        payload = buckets.get("codex") or (payload if "primary" in payload else {})
    if not isinstance(payload, dict):
        return []
    windows = []
    for key, label in (("primary", "5-hour"), ("secondary", "Weekly")):
        part = payload.get(key)
        if not isinstance(part, dict):
            continue
        duration = part.get("windowDurationMins")
        actual_label = label if duration in (300, 10080, None) else f"{duration}-minute"
        entry = _window(actual_label, part.get("usedPercent"), part.get("resetsAt"))
        if entry:
            windows.append(entry)
    return windows


def _key(name):
    """The cache slot of a provider reading: the name for the machine default's sign-in, else the name plus
    the current account's own folder, so one account's quota is never shown to another."""
    folder = cli_env.homes().get(cli_env.CLAUDE_VAR)
    return f"{name}@{folder}" if folder else name


def _claude_windows():
    path = Path(cli_env.claude_dir()) / ".credentials.json"
    credentials = json.loads(path.read_text(encoding="utf-8"))
    oauth = credentials.get("claudeAiOauth") or {}
    token = oauth.get("accessToken")
    expires = _unix_time(oauth.get("expiresAt"))
    if not token or (expires is not None and expires <= time.time()):
        raise SignInNeeded("Claude Code sign-in needs refresh")
    with httpx.Client(timeout=12) as client:
        response = client.get(CLAUDE_USAGE_URL, headers={
            "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20",
        })
    if response.status_code == 429:
        _retry_after[_key("claude")] = time.monotonic() + 300
        raise RateLimited("Claude usage is rate limited")
    if response.status_code == 401:
        raise SignInNeeded("Claude Code sign-in was refused")
    response.raise_for_status()
    return parse_claude_usage(response.json())


def _kill_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)],
                       capture_output=True, timeout=5, check=False)
    else:
        process.kill()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()


def _codex_windows():
    codex = shutil.which("codex")
    if not codex:
        raise RuntimeError("Codex CLI is unavailable")
    process = subprocess.Popen([codex, "app-server"], stdin=subprocess.PIPE, env=cli_env.env_for(),
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               text=True, encoding="utf-8", bufsize=1,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    lines = queue.Queue()
    def read_lines():
        for line in process.stdout:
            lines.put(line)
    threading.Thread(target=read_lines, daemon=True).start()
    try:
        for message in (
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "jarvis-usage", "version": "1.0.0"}, "capabilities": {}}},
            {"jsonrpc": "2.0", "method": "initialized", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}},
        ):
            process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            try:
                message = json.loads(lines.get(timeout=max(0.01, deadline - time.monotonic())))
            except (ValueError, queue.Empty):
                continue
            if message.get("id") == 2:
                if "error" in message:
                    raise RuntimeError("Codex rate limits unavailable")
                return parse_codex_limits(message.get("result") or {})
        raise RuntimeError("Codex rate limits timed out")
    finally:
        _kill_tree(process)


def _failed(name, old, status):
    if old:
        return {**old["value"], "stale": True, "status": "stale", "note": NOTES[status]}
    return {"provider": name, "windows": [], "stale": True, "status": status, "note": NOTES[status]}


def _provider(name, reader, force=False):
    """One provider's reading: cached for REFRESH_SECONDS, or fetched now when
    `force` is set (a click on its ring). Every result carries a `status` -
    ok, stale, needs_sign_in, rate_limited or unavailable - and a fixed note."""
    now = time.monotonic()
    slot = _key(name)
    old = _cache.get(slot)
    if force and old and now - old["checked"] < FORCED_REFRESH_SECONDS:
        raise RefreshThrottled(name)
    if old and not force and now - old["checked"] < REFRESH_SECONDS:
        return {**old["value"], "stale": False}
    if now < _retry_after.get(slot, 0):
        return _failed(name, old, "rate_limited")
    try:
        windows = reader()
        if not windows:
            raise RuntimeError("No quota windows returned")
        value = {"provider": name, "status": "ok", "note": "", "windows": windows,
                 "updated_at": time.time(), "stale": False}
        _cache[slot] = {"checked": now, "value": value}
        return value
    except NoQuotaReported:
        # A settled answer, not a failure: cached like a reading so the CLI is
        # not asked again on every poll.
        value = {"provider": name, "status": "no_quota", "note": NOTES["no_quota"], "windows": [],
                 "updated_at": time.time(), "stale": False}
        _cache[slot] = {"checked": now, "value": value}
        return value
    except SignInNeeded:
        # Sign-in problems are not retried on a timer: nothing changes until
        # the person signs in again, which the next ordinary poll will see.
        return {"provider": name, "windows": [], "stale": True, "status": "needs_sign_in", "note": NOTES["needs_sign_in"]}
    except RateLimited:
        return _failed(name, old, "rate_limited")
    except Exception:
        _retry_after[slot] = max(_retry_after.get(slot, 0), now + 60)
        return _failed(name, old, "unavailable")


def parse_antigravity_limits(data):
    """Only provider-reported fractions; credit amounts have no denominator.

    Older CLI builds without a machine-readable quota map return no windows.
    Never scrape a text progress bar or infer a limit from token totals.
    """
    if not isinstance(data, dict):
        return []
    quotas = data.get('quota')
    if not isinstance(quotas, dict):
        return []
    windows = []
    for name, part in quotas.items():
        if not isinstance(part, dict) or part.get('disabled'):
            continue
        remaining = part.get('remaining_fraction')
        if isinstance(remaining, bool) or not isinstance(remaining, (int, float)) or not math.isfinite(remaining):
            continue
        if not 0 <= remaining <= 1:
            continue
        entry = _window(str(name), (1 - remaining) * 100, part.get('reset_time'))
        if entry:
            windows.append(entry)
    return windows


def _antigravity_windows():
    from core.antigravity_cli import find_antigravity, run_readonly, auth_error
    executable = find_antigravity()
    if not executable:
        raise RuntimeError("Antigravity CLI is unavailable")
    # CLI-owned report, never a model turn. Slash reports cannot be sent to
    # the streaming conversation process.
    code, out, err = run_readonly(executable, '-p', '/usage', '--output-format', 'json',
                                  '--disable-slash-commands=false', timeout=12)
    if auth_error(err):
        raise SignInNeeded()
    if code:
        raise RuntimeError("Antigravity usage report failed")
    try:
        windows = parse_antigravity_limits(json.loads(out))
    except ValueError:
        windows = []
    if not windows:
        raise NoQuotaReported()
    return windows


READERS = {"claude": ("claude_cli", lambda: _claude_windows()), "codex": ("codex_cli", lambda: _codex_windows()),
           "antigravity": ("antigravity_cli", lambda: _antigravity_windows())}


# Subscriptions first (in READERS order), then local models, then APIs.
KIND_ORDER = {"claude_cli": 0, "codex_cli": 1, "antigravity_cli": 2, "local": 3, "api": 4}
# What a provider reading says about the connection itself. A quota that could
# not be read is "unavailable"; a stale or rate-limited one proves the sign-in works.
MODEL_STATUS = {"ok": "connected", "stale": "connected", "rate_limited": "connected", "no_quota": "connected",
                "needs_sign_in": "needs_sign_in", "unavailable": "unavailable"}


def _model_entry(endpoint, reading, totals, recent):
    """One connected model: who it is, its account quota when the provider
    reports one, and the tokens JARVIS itself recorded through it. Never the
    endpoint's URL or key state."""
    total = totals.get(endpoint["id"], {})
    period = recent.get(endpoint["id"], {})
    return {
        "id": endpoint["id"], "name": endpoint["name"], "kind": endpoint["kind"], "model": endpoint.get("model") or "",
        "mark": model_marks.mark_for(endpoint),
        "provider": reading["provider"] if reading else None,
        "status": MODEL_STATUS.get(reading["status"], "unavailable") if reading else "connected",
        "quota": reading,
        # Fresh tokens (new input, cache writes, output); cache reads are cheap
        # re-reads and stay out, as on Home. Lifetime includes pre-split totals.
        "recorded": {"today_tokens": period.get("today_tokens", 0), "week_tokens": period.get("week_tokens", 0),
                     "total_tokens": total.get("fresh_tokens", 0) + total.get("unsplit_tokens", 0)},
    }


def get_usage_overlay(force_provider=None):
    """Readings for every subscription CLI endpoint that is connected, and
    every connected model with its quota or recorded usage.
    `force_provider` refreshes that one now (raises RefreshThrottled if it was
    read moments ago); the rest come from cache as usual."""
    endpoints = model_endpoints.list_endpoints()
    kinds = {endpoint["kind"] for endpoint in endpoints}
    readings, providers = {}, []
    for name, (kind, reader) in READERS.items():
        if kind in kinds:
            reading = _provider(name, reader, force=(name == force_provider))
            readings[kind] = reading
            # Only a provider with windows gets a ring; every model is in `models`.
            if name != 'antigravity' or reading.get('windows'):
                providers.append(reading)
    totals, recent = token_usage.get_usage_summary(), token_usage.get_recent_usage()
    models = [_model_entry(endpoint, readings.get(endpoint["kind"]), totals, recent)
              for endpoint in sorted(endpoints, key=lambda e: KIND_ORDER.get(e["kind"], len(KIND_ORDER)))]
    return {"providers": providers, "models": models}


async def get_usage_overlay_async(force_provider=None):
    return await asyncio.to_thread(get_usage_overlay, force_provider)


_bot_plan_lock = threading.Lock()
_bot_plan_cache = {}  # per sign-in (_key), so one account never gets another's plan


def get_bot_plan(refresh=False):
    """Bots has a 45-second shared cache even for manual refreshes.

    Reuses provider readers and their stricter backoff. No credentials or
    request exceptions leave quota_usage.
    """
    import copy
    with _bot_plan_lock:
        now = time.monotonic()
        cached = _bot_plan_cache.get(_key("plan"))
        if cached and now - cached[0] < 45:
            return copy.deepcopy(cached[1])
        if refresh:
            for name, (kind, reader) in READERS.items():
                if any(e.get("kind") == kind for e in model_endpoints.list_endpoints()):
                    try:
                        _provider(name, reader, force=True)
                    except RefreshThrottled:
                        pass
        value = get_usage_overlay()
        _bot_plan_cache[_key("plan")] = (now, value)
        return copy.deepcopy(value)

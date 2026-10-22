"""What the full-screen view shows, as plain data: transcripts, the projects
tree, per-reply metrics and usage. No drawing here, so it is testable alone.

Every number comes from a backend field or is measured here and labelled so
(see METRICS_SOURCES). When the backend has no field for a metric the value
is None and the view prints "n/a": nothing is estimated or invented.
"""
from __future__ import annotations

import datetime as dt
import os
import subprocess
import time
from dataclasses import dataclass, field

from . import render
from .sanitize import clean, one_line

# Where each number on screen comes from (and what the backend lacks).
METRICS_SOURCES = {
    "duration": "run started_at/ended_at (GET /api/runs?session_id=)",
    "tokens": "run total_tokens: the provider's own total, input and output together",
    "in_out": "run input_tokens (the whole input, cached part included) and output_tokens (schema v8)",
    "cached": "run cache_read_tokens / input_tokens (or / total_tokens for runs before schema v8)",
    "tok_per_s": "run tokens_per_second: output_tokens over first-to-last output time (schema v8)",
    "tools": "run tool_calls",
    "context": "GET /api/sessions/{id}/context (used_tokens, capacity_tokens, percent)",
    "plan": "GET /api/models/quotas (subscription windows: used_percent, resets_at)",
    "branch": "git in the chat's folder (the Forge worktree, or where kairos started)",
    "tokens_per_hour": "the session's runs today, total_tokens bucketed by start hour",
    "missing": ["cost (no price or spend field anywhere in the API)",
                "tok/s for a reply that arrived in one piece (Codex hands its reply over whole; "
                "plain requests too): there is no window to divide by",
                "in / out for runs recorded before schema v8, or from a provider that did not report them",
                "prompt-cache timer (no cache expiry is reported)",
                "steering a running turn (no route takes text into a running turn)",
                "GPU or card memory totals (only Ollama's per-model size_vram, when Ollama runs)"],
}


# -- transcript items -------------------------------------------------------------

@dataclass
class UserItem:
    text: str
    ts: float
    from_app: bool = False


@dataclass
class ReplyItem:
    turn_id: str
    ts: float
    status: str = "processing"     # processing | done | failed | stopped
    committer: render.StreamCommitter = field(default_factory=render.StreamCommitter)
    blocks: list = field(default_factory=list)
    steps: list = field(default_factory=list)          # finished tool steps
    running: dict = field(default_factory=dict)        # tool id -> started step
    events: list = field(default_factory=list)         # tool_event values
    error: str | None = None
    metrics: dict | None = None
    expanded: bool = False
    ended: float | None = None
    samples: list = field(default_factory=list)        # (monotonic time, characters)
    text: str = ""
    # File chips: files the backend lists for this chat that this reply
    # produced (GET /api/chat/files, or a Forge session's changes). Each is
    # {"name", "url" or "forge_path", "origin", "path" once resolved}.
    files: list = field(default_factory=list)

    def feed(self, text: str) -> None:
        self.text += text
        self.blocks.extend(self.committer.feed(text))
        self.samples.append((time.monotonic(), len(text)))

    def finish(self, status: str, error: str | None = None) -> None:
        self.blocks.extend(self.committer.finish())
        self.status, self.error, self.ended = status, error, time.time()
        self.running.clear()

    def stream_rate(self, buckets: int = 30) -> list[float]:
        """Characters per second, one value per second of the stream."""
        if not self.samples:
            return []
        start = self.samples[0][0]
        values = [0.0] * min(buckets, int(self.samples[-1][0] - start) + 1)
        offset = max(0, int(self.samples[-1][0] - start) + 1 - buckets)
        for moment, count in self.samples:
            index = int(moment - start) - offset
            if 0 <= index < len(values):
                values[index] += count
        return values


@dataclass
class NoteItem:
    text: str
    role: str = "meta"


@dataclass
class RichItem:
    """Anything drawn by Rich (a diff, a table), scrolled with the rest."""
    renderable: object
    key: str = ""


@dataclass
class SessionView:
    session: dict
    items: list = field(default_factory=list)
    queued: list = field(default_factory=list)
    version: int = 0
    scroll: int = 0             # lines up from the bottom; 0 follows the newest
    context: dict | None = None
    runs: list = field(default_factory=list)

    @property
    def id(self) -> str:
        return self.session["id"]

    @property
    def title(self) -> str:
        return one_line(self.session.get("title") or "New chat", 60)

    @property
    def reply(self) -> ReplyItem | None:
        for item in reversed(self.items):
            if isinstance(item, ReplyItem):
                return item
        return None

    @property
    def working(self) -> bool:
        reply = self.reply
        return bool(reply and reply.status == "processing")

    def touch(self) -> None:
        self.version += 1

    def add(self, item) -> None:
        self.items.append(item)
        self.touch()

    def load_history(self, messages: list[dict], runs: list[dict]) -> None:
        self.items = []
        self.runs = runs
        for message in messages[-60:]:
            role, content = message.get("role"), message.get("content")
            if not isinstance(content, str):
                continue
            if role == "user":
                self.items.append(UserItem(clean(content), message.get("ts") or 0))
            elif role == "assistant" and message.get("type") != "handoff":
                reply = ReplyItem(turn_id="", ts=message.get("ts") or 0, status="done")
                reply.feed(content)
                reply.finish("done")
                reply.ended = message.get("ts")
                reply.samples = []
                reply.metrics = run_metrics(match_run(reply.ts, runs))
                self.items.append(reply)
        self.touch()


# -- metrics -----------------------------------------------------------------------

def match_run(ts: float | None, runs: list[dict]) -> dict | None:
    """The run that produced a reply saved at ts: the newest run that
    started before it and ended within a few seconds of it."""
    if not ts:
        return None
    fits = [r for r in runs if (r.get("started_at") or 0) <= ts + 1 and ts <= (r.get("ended_at") or ts) + 10]
    return max(fits, key=lambda r: r.get("started_at") or 0) if fits else None


def run_metrics(run: dict | None) -> dict | None:
    if not run:
        return None
    started, ended = run.get("started_at"), run.get("ended_at")
    total, cached, inputs = run.get("total_tokens"), run.get("cache_read_tokens"), run.get("input_tokens")
    base = inputs if inputs else total
    return {
        "seconds": (ended - started) if started and ended else None,
        "tokens": total,
        "input": inputs,
        "output": run.get("output_tokens"),
        "cache_write": run.get("cache_write_tokens"),
        "cached_percent": round(cached / base * 100) if base and cached is not None else None,
        "tools": run.get("tool_calls"),
        "complete": bool(run.get("usage_complete")),
        "outcome": run.get("outcome"),
        "model": run.get("model"),
        "tok_per_s": run.get("tokens_per_second", tokens_per_second(run)),
        # Not in the API: shown as n/a, never estimated.
        "cost": None,
    }


def tokens_per_second(run: dict) -> float | None:
    """The backend's formula (core/runs.py tokens_per_second), for a row
    that did not carry it: output tokens over first-to-last output time,
    only when both exist."""
    output, first, last = run.get("output_tokens"), run.get("first_output_at"), run.get("last_output_at")
    if not output or first is None or last is None or last - first <= 0:
        return None
    return round(output / (last - first), 1)


def session_totals(runs: list[dict]) -> dict:
    """The chat's tokens: total, and in/out over the runs that reported them."""
    def summed(key):
        values = [r[key] for r in runs if r.get(key) is not None]
        return sum(values) if values else None
    return {"tokens": summed("total_tokens"), "input": summed("input_tokens"), "output": summed("output_tokens")}


def rate_series(runs: list[dict]) -> list:
    """tok/s per reply, oldest first; None where a reply has no rate."""
    ordered = sorted(runs, key=lambda r: r.get("started_at") or 0)
    return [r.get("tokens_per_second", tokens_per_second(r)) for r in ordered]


def tokens_per_hour_today(runs: list[dict], now: float | None = None) -> list[int] | None:
    """24 values (local hours) of total_tokens for runs started today, or
    None when no run today reported usage."""
    now = now or time.time()
    today = dt.datetime.fromtimestamp(now).date()
    hours = [0] * 24
    seen = False
    for run in runs:
        started, total = run.get("started_at"), run.get("total_tokens")
        if not started or total is None:
            continue
        moment = dt.datetime.fromtimestamp(started)
        if moment.date() == today:
            hours[moment.hour] += total
            seen = True
    return hours if seen else None


def plan_window(quotas: dict | None, endpoint_kind: str | None) -> dict | None:
    """The subscription window to show for this chat's model: the reader
    for its kind (claude_cli -> claude, codex_cli -> codex), the most used
    window. None for API and local models, which have no plan."""
    provider = {"claude_cli": "claude", "codex_cli": "codex"}.get(endpoint_kind or "")
    if not quotas or not provider:
        return None
    for entry in quotas.get("providers") or []:
        if entry.get("provider") == provider and entry.get("windows"):
            return max(entry["windows"], key=lambda w: w.get("used_percent") or 0)
    return None


def git_branch(folder: str | None) -> str | None:
    """The branch of the chat's folder, with * when it has changes. Local
    and read-only; None outside a repository."""
    if not folder or not os.path.isdir(folder):
        return None
    try:
        branch = subprocess.run(["git", "-C", folder, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True,
                                text=True, timeout=3)
        if branch.returncode != 0:
            return None
        dirty = subprocess.run(["git", "-C", folder, "status", "--porcelain", "--untracked-files=no"],
                               capture_output=True, text=True, timeout=3)
        return one_line(branch.stdout.strip(), 40) + ("*" if dirty.stdout.strip() else "")
    except (OSError, subprocess.SubprocessError):
        return None


def resets_in(timestamp: float | None, now: float | None = None) -> str:
    if not timestamp:
        return ""
    seconds = max(0, timestamp - (now or time.time()))
    if seconds >= 86400:
        return f"↺{int(seconds // 86400)}d"
    if seconds >= 3600:
        return f"↺{int(seconds // 3600)}h"
    return f"↺{int(seconds // 60)}m"


# -- the projects tree ---------------------------------------------------------------

@dataclass
class Node:
    kind: str                # group | session
    label: str
    depth: int
    session_id: str | None = None
    group: str = ""
    active: bool = False
    open: bool = False
    busy: bool = False
    last: bool = False


def build_tree(sessions: list[dict], forge_projects: list[dict], forge_sessions: dict[str, list],
               chat_projects: list[dict], active_id: str | None, open_ids: set, busy_ids: set,
               collapsed: set, cwd: str | None = None, recent: int = 12) -> list[Node]:
    """Projects, each with its sessions: Forge projects first (their
    sessions are Forge sessions), then Kairos projects (chats assigned to
    one), then the remaining chats, newest first, this folder's on top."""
    nodes: list[Node] = []

    def add_group(key: str, label: str, rows: list[dict]) -> None:
        if not rows:
            return
        nodes.append(Node("group", one_line(label, 40), 0, group=key,
                          active=any(r["id"] == active_id for r in rows), open=key not in collapsed))
        if key in collapsed:
            return
        for index, row in enumerate(rows):
            nodes.append(Node("session", one_line(row.get("title") or "Untitled", 60), 1, row["id"], key,
                              active=row["id"] == active_id, open=row["id"] in open_ids,
                              busy=row["id"] in busy_ids, last=index == len(rows) - 1))

    used: set = set()
    for project in forge_projects:
        rows = sorted(forge_sessions.get(project["id"], []), key=lambda r: r.get("updated_at") or 0, reverse=True)
        rows = [r for r in rows if not (r.get("forge") or {}).get("removed")]
        used.update(r["id"] for r in rows)
        add_group(f"forge:{project['id']}", project.get("name") or "Forge project", rows)
    by_project: dict[str, list] = {}
    for row in sessions:
        if row.get("project_id") and row["id"] not in used:
            by_project.setdefault(row["project_id"], []).append(row)
    for project in chat_projects:
        rows = by_project.get(project["id"], [])
        used.update(r["id"] for r in rows)
        add_group(f"project:{project['id']}", project.get("name") or "Project", rows)
    rest = [r for r in sessions if r["id"] not in used and not r.get("is_forge")]

    def here(row):
        return bool(cwd and row.get("launch_dir") and
                    os.path.normcase(os.path.abspath(row["launch_dir"])) == os.path.normcase(os.path.abspath(cwd)))
    rest.sort(key=lambda r: (not here(r), -(r.get("updated_at") or 0)))
    keep = rest[:recent]
    if active_id and active_id not in {r["id"] for r in keep}:
        keep += [r for r in rest if r["id"] == active_id]
    add_group("chats", "chats", keep)
    return nodes

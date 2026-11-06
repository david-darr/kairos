"""Model endpoint registry — user-configured "bring your own model" connections
(a local vLLM/Ollama/LM Studio server, a hosted OpenAI-compatible API like
OpenRouter/OpenAI itself, or the Claude Agent SDK/CLI). Mirrors Odysseus's
core.database.ModelEndpoint (name/base_url/api_key/model list), JSON-backed
here to match this project's storage convention rather than a SQL table.

David's ask 2026-08-31: JARVIS ships with NO default model. `local` endpoints
and custom API URLs use OpenAI-compatible chat completions. Official Anthropic
and OpenAI API hosts use native Messages and Responses transports through the
same tool loop. `claude_cli` is different: it's the Claude Agent SDK path
(core/brain.py, a tool-using agent with vault file access, not just a chat
endpoint) wrapping the real `claude` CLI already logged in on the machine —
no base_url or api_key needed for chat. Model discovery reads the CLI's current
access token without changing its login. A chat session with no endpoint gets a canned
"add a model first" reply instead of silently falling back to any one of
these (see services/chat_service.py).

`codex_cli` (added 2026-09-11, David's ask for Codex parity with `claude_cli`)
is the same shape as `claude_cli`: no base_url/api_key, wraps a CLI already
authenticated on the machine (`codex` — see core/codex_brain.py), `model` is
an optional override rather than a required field.
"""
import os
import uuid
from typing import Any, Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from core.secret_storage import decrypt, decrypt_for, encrypt

ENDPOINTS_FILE = None  # override (tests); else the current account's model_endpoints.json
# Connections an account shares with others (D3, Multi-Account phase 3a): install-level, keyed
# "<owner account>:<endpoint id>" -> {"owner", "endpoint_id", "grantees": [account ids]}.
SHARES_FILE = None  # override (tests); else data/model_shares.json


def endpoints_file() -> str:
    from core import accounts
    return ENDPOINTS_FILE or accounts.path("model_endpoints.json")


def shares_file() -> str:
    return SHARES_FILE or os.path.join(DATA_DIR, "model_shares.json")

DEFAULT_LOCAL_NUM_CTX = 16384  # real incident, 2026-09-01: a local model loaded
# with no cap defaulted to its max supported context (phi3's 131072) and its
# KV cache alone ate ~21GB of system RAM. Every "local" endpoint gets a sane
# cap by default instead of trusting the serving engine's own default.
# 4096 until 2026-10-06, when JARVIS's own instructions and tool list were
# measured at about 5,000 tokens: more than the whole window. 16,384 is about
# the most a 27-32B model's cache (about 4 GB) adds while staying on a 24 GB
# GPU. Connections already saved keep their value; Settings > Added Models
# notes one under 8,192.


def _load() -> dict:
    """Self-healing backfill (real bug found live, 2026-09-01 — David's own
    "Ollama" and "phi3:latest" endpoints, created before num_ctx capping
    existed, had no num_ctx field at all, so the cap silently never applied
    to them and memory ballooned exactly like the original incident): any
    "local" endpoint missing num_ctx gets the default written in immediately
    on load, not just newly-created ones. Runs on every load so it fixes
    itself the next time anything touches the file, regardless of when this
    code shipped relative to when the endpoint was created."""
    data = read_json(endpoints_file(), {})
    changed = False
    for ep in data.values():
        if ep.get("kind") == "local" and ep.get("num_ctx") is None:
            ep["num_ctx"] = DEFAULT_LOCAL_NUM_CTX
            changed = True
    if changed:
        write_json_atomic(endpoints_file(), data)
    return data


def _masked(ep: dict) -> dict:
    return {
        "id": ep["id"],
        "name": ep["name"],
        "base_url": ep["base_url"],
        "model": ep["model"],
        "has_api_key": bool(ep.get("api_key_encrypted")),
        "kind": ep.get("kind", "api"),
        "num_ctx": ep.get("num_ctx"),
        "supports_images": ep.get("kind") in ("claude_cli", "codex_cli", "antigravity_cli") or bool(ep.get("supports_images")),
    }


def _current_account() -> Optional[str]:
    from core import accounts
    try:
        return accounts.effective_account()
    except accounts.NoAccount:
        return None


def _shared_with_me() -> dict:
    """Connections other accounts shared with the current one: endpoint id -> the owner's record, marked."""
    from core import accounts
    me = _current_account()
    if not me:
        return {}
    found = {}
    for share in read_json(shares_file(), {}).values():
        if me not in share.get("grantees", []) or share.get("owner") == me:
            continue
        try:
            with accounts.as_account(share["owner"]):
                ep = _load().get(share["endpoint_id"])
        except Exception:
            ep = None
        if ep is not None:
            found[ep["id"]] = {**ep, "shared": True, "owner_account": share["owner"]}
    return found


def _owner_name(account_id) -> Optional[str]:
    """The user name of the account that shared a connection (shown as "Shared by <name>")."""
    from core.auth import auth_manager
    return auth_manager.username_for_account(account_id) if account_id else None


def list_endpoints() -> list[dict]:
    own = [_masked(ep) for ep in _load().values()]
    # A shared connection shows its name and model, never its address or whether it has a key.
    shared = [{**_masked(ep), "base_url": "", "has_api_key": False, "shared": True, "shared_by": _owner_name(ep.get("owner_account"))}
              for ep in _shared_with_me().values()]
    return own + shared


def get_endpoint(endpoint_id: str) -> Optional[dict]:
    own = _load().get(endpoint_id)
    if own is not None:
        return own
    return _shared_with_me().get(endpoint_id)


def _share_key(owner: str, endpoint_id: str) -> str:
    return f"{owner}:{endpoint_id}"


def shares_of(endpoint_id: str) -> list[str]:
    """The accounts the current account shares one of its own connections with."""
    me = _current_account()
    return list(read_json(shares_file(), {}).get(_share_key(me, endpoint_id), {}).get("grantees", []))


def set_shares(endpoint_id: str, grantees: list[str]) -> list[str]:
    """Share one of the current account's own connections with exactly these accounts ([] takes it back).
    Usage is counted in the account that uses it; the key and address never leave the owner's file."""
    me = _current_account()
    if not me or endpoint_id not in _load():
        raise KeyError(endpoint_id)
    grantees = sorted({g for g in grantees if g and g != me})
    data = read_json(shares_file(), {})
    key = _share_key(me, endpoint_id)
    if grantees:
        data[key] = {"owner": me, "endpoint_id": endpoint_id, "grantees": grantees}
    else:
        data.pop(key, None)
    write_json_atomic(shares_file(), data)
    return grantees


def create_endpoint(name: str, base_url: str = "", model: str = "", api_key: Optional[str] = None,
                     kind: str = "api", num_ctx: Optional[int] = None, supports_images: bool = False) -> dict:
    from core import accounts
    if kind in ("local", "api") and base_url:
        accounts.refuse_host_only_address(base_url, "connect to a model server")
    if kind not in ("local", "api", "claude_cli", "codex_cli", "antigravity_cli"):
        raise ValueError("kind must be 'local', 'api', 'claude_cli', 'codex_cli', or 'antigravity_cli'")
    if kind not in ("claude_cli", "codex_cli", "antigravity_cli") and not base_url:
        raise ValueError("base_url is required for local/api endpoints")
    data = _load()
    endpoint_id = uuid.uuid4().hex[:12]
    data[endpoint_id] = {
        "id": endpoint_id,
        "name": name,
        "base_url": base_url.rstrip("/") if base_url else "",
        # For claude_cli/codex_cli, `model` is an optional override (passed
        # to ClaudeAgentOptions(model=...) or codex's `-m` flag respectively)
        # — blank means "whatever the CLI itself defaults to" (frontend
        # displays that as "CLI default").
        "model": model,
        "api_key_encrypted": encrypt(api_key) if api_key else None,
        "kind": kind,
        "supports_images": bool(supports_images) if kind in ("local", "api") else True,
        # Only meaningful for "local" — the serving engine's own context-
        # window cap (Ollama's `options.num_ctx`; other local servers that
        # don't recognize the field just ignore it). None for api/claude_cli.
        "num_ctx": (num_ctx if num_ctx is not None else DEFAULT_LOCAL_NUM_CTX) if kind == "local" else None,
    }
    write_json_atomic(endpoints_file(), data)
    return _masked(data[endpoint_id])


def set_image_support(endpoint_id: str, enabled: bool) -> dict:
    data = _load()
    endpoint = data.get(endpoint_id)
    if endpoint is None:
        raise KeyError(endpoint_id)
    if endpoint.get("kind") not in ("local", "api"):
        raise ValueError("CLI models use their file tools for images.")
    endpoint["supports_images"] = bool(enabled)
    write_json_atomic(endpoints_file(), data)
    return _masked(endpoint)


def delete_endpoint(endpoint_id: str) -> None:
    data = _load()
    if data.pop(endpoint_id, None) is not None and _current_account():
        shares = read_json(shares_file(), {})
        if shares.pop(_share_key(_current_account(), endpoint_id), None) is not None:
            write_json_atomic(shares_file(), shares)
    write_json_atomic(endpoints_file(), data)


def api_key_of(ep: dict) -> Optional[str]:
    """A connection's key, decrypted. A shared connection's key belongs to its owner's account."""
    if not ep.get("api_key_encrypted"):
        return None
    if ep.get("shared") and ep.get("owner_account"):
        return decrypt_for(ep["owner_account"], ep["api_key_encrypted"])
    return decrypt(ep["api_key_encrypted"])


def resolve_runtime(endpoint_id: str) -> tuple[str, str, Optional[str], Optional[int]]:
    """(base_url, model, api_key, num_ctx) with the key decrypted — for
    runtime calls only, never returned from an API route."""
    ep = get_endpoint(endpoint_id)
    if ep is None:
        raise ValueError(f"unknown model endpoint: {endpoint_id}")
    return ep["base_url"], ep["model"], api_key_of(ep), ep.get("num_ctx")

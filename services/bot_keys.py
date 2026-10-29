"""Keys and resource settings (Phase 2, unit U5).

Keys are write-only. A saved key is encrypted with the install key (core/secret_storage), shown only
as "saved" and its last four characters, and never sent back. A test returns a status word and a fixed
sentence, never the key or the provider's reply. Rows are grouped AI, Servers, Voice, Computers, Apps
and Helpers. AI and Helpers rows are the model connections that already exist (Settings > Models):
they are listed and tested here, and their keys stay where they are set.

`resource_settings` is the protected, owner-scoped preferences document for the Phase 2 background
work: the helper model, the daily tidy time, the capture quiet interval, the room-capture preference
and the skill-review preferences. The owner's key comes from the signed-in account, never a request.
"""
import hashlib
import os
import re
import threading
import time
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.secret_storage import decrypt, encrypt

GROUPS = ["AI", "Servers", "Voice", "Computers", "Apps", "Helpers"]
MAX_KEY = 4096

# slot id -> definition. `test` is one cheap authenticated request; `shape` is a hint, never a gate.
SLOTS = {
    "github": {"group": "Servers", "label": "GitHub token", "hint": "Starts with ghp_, github_pat_ or similar.", "shape": r"^(gh[pousr]_|github_pat_)",
               "test": {"method": "GET", "url": "https://api.github.com/user", "auth": "bearer"}},
    "brave-search": {"group": "Servers", "label": "Brave Search key", "hint": "From the Brave Search API dashboard.", "shape": r"^BSA",
                     "test": {"method": "GET", "url": "https://api.search.brave.com/res/v1/web/search?q=test&count=1", "auth": "header:X-Subscription-Token"}},
    "exa": {"group": "Servers", "label": "Exa key", "hint": "From the Exa dashboard.", "shape": "",
            "test": {"method": "POST", "url": "https://api.exa.ai/search", "auth": "header:x-api-key", "json": {"query": "test", "numResults": 1}}},
    "firecrawl": {"group": "Servers", "label": "Firecrawl key", "hint": "Starts with fc-.", "shape": r"^fc-",
                  "test": {"method": "GET", "url": "https://api.firecrawl.dev/v1/team/credit-usage", "auth": "bearer"}},
    "tavily": {"group": "Servers", "label": "Tavily key", "hint": "Starts with tvly-.", "shape": r"^tvly-",
               "test": {"method": "POST", "url": "https://api.tavily.com/search", "auth": "bearer", "json": {"query": "test", "max_results": 1}}},
    "elevenlabs": {"group": "Voice", "label": "ElevenLabs key", "hint": "From your ElevenLabs profile.", "shape": "",
                   "test": {"method": "GET", "url": "https://api.elevenlabs.io/v1/user", "auth": "header:xi-api-key"}},
    "deepgram": {"group": "Voice", "label": "Deepgram key", "hint": "From the Deepgram console.", "shape": "",
                 "test": {"method": "GET", "url": "https://api.deepgram.com/v1/projects", "auth": "header-token:Authorization"}},
    "openai-voice": {"group": "Voice", "label": "OpenAI key for voice", "hint": "Starts with sk-.", "shape": r"^sk-",
                     "test": {"method": "GET", "url": "https://api.openai.com/v1/models", "auth": "bearer"}},
    "browserbase": {"group": "Computers", "label": "Browserbase key", "hint": "From the Browserbase dashboard.", "shape": "",
                    "test": {"method": "GET", "url": "https://api.browserbase.com/v1/projects", "auth": "header:X-BB-API-Key"}},
    "x": {"group": "Apps", "label": "X bearer token", "hint": "The app-only bearer token from the X developer portal.", "shape": "",
          "test": {"method": "GET", "url": "https://api.x.com/2/users/by/username/x", "auth": "bearer"}},
    "highlevel": {"group": "Apps", "label": "HighLevel private token", "hint": "Starts with pit-.", "shape": r"^pit-",
                  "test": {"method": "GET", "url": "https://services.leadconnectorhq.com/locations/{highlevel-location}", "auth": "bearer",
                           "headers": {"Version": "2021-07-28"}, "needs": ["highlevel-location"]}},
    "highlevel-location": {"group": "Apps", "label": "HighLevel location id", "hint": "The sub-account's location id.", "shape": "", "secret": False},
}
AI_NOTE = "Model keys are set in Settings > Models. They are listed here with their test."


class KeyError_(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


_lock = threading.RLock()


def _path() -> str:
    from core.constants import DATA_DIR
    return os.path.join(DATA_DIR, "bot-keys.json")


def _store() -> dict:
    data = read_json(_path(), {})
    return data if isinstance(data, dict) else {}


def _slot(slot: str) -> dict:
    spec = SLOTS.get(slot)
    if spec is None:
        raise KeyError_("That key slot does not exist.", 404)
    return spec


def get_slot(slot: str) -> dict:
    """Masked state of one slot: never the key."""
    spec = _slot(slot)
    record = _store().get(slot) or {}
    out = {"id": slot, "group": spec["group"], "label": spec["label"], "hint": spec["hint"], "secret": spec.get("secret", True),
           "has_value": bool(record.get("value_encrypted")), "updated_at": record.get("updated_at"), "last4": record.get("last4"),
           "testable": bool(spec.get("test"))}
    if not spec.get("secret", True) and record.get("value_encrypted"):
        out["value"] = decrypt(record["value_encrypted"])  # a location id is not a secret
    return out


def list_slots() -> list[dict]:
    """Every slot plus the model connections, grouped for the page."""
    rows = [get_slot(slot) for slot in SLOTS]
    try:
        from core import model_endpoints
        for endpoint in model_endpoints.list_endpoints():
            if endpoint.get("kind") != "api":
                continue
            rows.append({"id": f"model:{endpoint['id']}", "group": "AI", "label": endpoint.get("name") or endpoint["id"],
                         "hint": AI_NOTE, "secret": True, "has_value": bool(endpoint.get("has_api_key")), "updated_at": None,
                         "last4": None, "testable": True, "managed_in": "models"})
        helper = None
        from core import helpers
        helper = helpers.helper_endpoint()
        rows.append({"id": "helper", "group": "Helpers", "label": (helper or {}).get("name") or "No helper model", "hint": "Chosen under Helpers below.",
                     "secret": True, "has_value": bool(helper), "updated_at": None, "last4": None, "testable": False, "managed_in": "models"})
    except Exception:
        pass
    return rows


def _check_value(slot: str, value) -> str:
    spec = _slot(slot)
    if not isinstance(value, str) or not value.strip():
        raise KeyError_("Enter a value.")
    value = value.strip()
    if len(value) > MAX_KEY or any(ord(c) < 32 for c in value):
        raise KeyError_("That value is not usable. Paste it again without line breaks.")
    return value


def shape_warning(slot: str, value: str) -> Optional[str]:
    shape = _slot(slot).get("shape")
    if shape and not re.search(shape, value):
        return "This does not look like a " + SLOTS[slot]["label"].lower() + ". It was saved anyway; run the test to check it."
    return None


def set_slot(slot: str, value) -> dict:
    """Save (replace) one key. The reply is the masked state, plus a hint if the key's shape looks off."""
    clean = _check_value(slot, value)
    with _lock:
        data = _store()
        data[slot] = {"value_encrypted": encrypt(clean), "last4": clean[-4:] if len(clean) >= 12 and SLOTS[slot].get("secret", True) else None,
                      "updated_at": time.time()}
        write_json_atomic(_path(), data)
    state = get_slot(slot)
    warning = shape_warning(slot, clean)
    return {**state, "warning": warning} if warning else state


def clear_slot(slot: str) -> dict:
    _slot(slot)
    with _lock:
        data = _store()
        if data.pop(slot, None) is not None:
            write_json_atomic(_path(), data)
    return get_slot(slot)


def get_key(slot: str) -> Optional[str]:
    """The saved value, decrypted, for server code that makes the call (never an API response)."""
    record = _store().get(slot) if slot in SLOTS else None
    return decrypt(record["value_encrypted"]) if record and record.get("value_encrypted") else None


# -- tests: a status, never a value ---------------------------------------------------------------

TEST_SECONDS = 15
RESULT_WORDS = {"ok": "The key works.", "refused": "The provider refused this key. Check it and its plan.", "unreachable": "The provider could not be reached.",
                "timeout": "The provider did not answer in time.", "missing": "Save a key first.", "unsupported": "This key has no test."}


def _request_for(slot: str, key: str) -> dict:
    spec = SLOTS[slot]["test"]
    url, headers = spec["url"], {"Accept": "application/json", **spec.get("headers", {})}
    for needed in spec.get("needs", []):
        extra = get_key(needed)
        if not extra:
            raise KeyError_("Save the " + SLOTS[needed]["label"].lower() + " first.", 409)
        url = url.replace("{" + needed + "}", re.sub(r"[^A-Za-z0-9_-]", "", extra))
    auth = spec["auth"]
    if auth == "bearer":
        headers["Authorization"] = f"Bearer {key}"
    elif auth.startswith("header-token:"):
        headers[auth.split(":", 1)[1]] = f"Token {key}"
    elif auth.startswith("header:"):
        headers[auth.split(":", 1)[1]] = key
    return {"method": spec["method"], "url": url, "headers": headers, "json": spec.get("json")}


async def test_slot(slot: str, value: Optional[str] = None, *, client_factory=None) -> dict:
    """Try a key (the saved one, or `value` typed but not yet saved) against its provider. The answer is
    {"ok", "status", "message"}; the key and the provider's reply never appear in it."""
    spec = _slot(slot)
    if not spec.get("test"):
        return {"ok": False, "status": "unsupported", "message": RESULT_WORDS["unsupported"]}
    key = _check_value(slot, value) if value else get_key(slot)
    if not key:
        return {"ok": False, "status": "missing", "message": RESULT_WORDS["missing"]}
    request = _request_for(slot, key)
    import httpx2
    try:
        async with (client_factory or (lambda: httpx2.AsyncClient(timeout=TEST_SECONDS, follow_redirects=False)))() as client:
            response = await client.request(request["method"], request["url"], headers=request["headers"], json=request["json"])
        status = "ok" if response.status_code < 300 else "refused" if response.status_code in (400, 401, 403, 404, 429) else "unreachable"
    except Exception as error:  # never include the error text: it can carry the request
        status = "timeout" if "timeout" in type(error).__name__.lower() or "timed out" in str(error).lower() else "unreachable"
    return {"ok": status == "ok", "status": status, "message": RESULT_WORDS[status]}


async def test_model_connection(endpoint_id: str) -> dict:
    """A model connection's own test, reported in the same shape."""
    from core import model_endpoints
    if model_endpoints.get_endpoint(endpoint_id) is None:
        raise KeyError_("That connection was not found.", 404)
    try:
        from routes import model_routes
        result = await model_routes.test_endpoint(endpoint_id, user="system")
        ok = bool(result.get("ok"))
    except Exception:
        ok = False
    return {"ok": ok, "status": "ok" if ok else "refused", "message": RESULT_WORDS["ok" if ok else "refused"]}


# -- resource settings -----------------------------------------------------------------------------

DEFAULT_SETTINGS = {"helper_model": None, "tidy_time": "03:00", "capture_quiet_minutes": 5, "room_capture": "off", "timezone": None,
                    "skill_review": {"enabled": True, "steps": 10}, "revision": 0}
ROOM_CAPTURE = ("off", "ask", "on")


def _owner_path(owner: str) -> str:
    from core.constants import DATA_DIR
    key = hashlib.sha256(str(owner).encode("utf-8")).hexdigest()[:16]
    return os.path.join(DATA_DIR, "bot-resource-settings", key + ".json")


def resource_settings(owner: str) -> dict:
    stored = read_json(_owner_path(owner), {})
    stored = stored if isinstance(stored, dict) else {}
    merged = {**DEFAULT_SETTINGS, **{k: v for k, v in stored.items() if k in DEFAULT_SETTINGS}}
    merged["skill_review"] = {**DEFAULT_SETTINGS["skill_review"], **(stored.get("skill_review") or {})}
    from core import settings as settings_store
    merged["helper_model"] = settings_store.get_setting("helper_endpoint_id")  # the one source of truth for the helper choice
    return merged


def _clean_patch(patch: dict) -> dict:
    out = {}
    for key, value in patch.items():
        if key == "tidy_time":
            if not isinstance(value, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value):
                raise KeyError_("The tidy time is a time of day such as 03:00.")
            out[key] = value
        elif key == "capture_quiet_minutes":
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 60:
                raise KeyError_("The quiet time is a whole number of minutes from 1 to 60.")
            out[key] = value
        elif key == "room_capture":
            if value not in ROOM_CAPTURE:
                raise KeyError_("Room capture is off, ask or on.")
            out[key] = value
        elif key == "timezone":
            if value is not None:
                from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
                try:
                    ZoneInfo(str(value))
                except (ZoneInfoNotFoundError, ValueError, OSError) as error:
                    raise KeyError_("That time zone is not known.") from error
            out[key] = value
        elif key == "skill_review":
            if not isinstance(value, dict) or set(value) - {"enabled", "steps"}:
                raise KeyError_("Skill review settings are enabled and steps.")
            if "enabled" in value and not isinstance(value["enabled"], bool):
                raise KeyError_("Skill review is on or off.")
            if "steps" in value and (isinstance(value["steps"], bool) or not isinstance(value["steps"], int) or not 3 <= value["steps"] <= 100):
                raise KeyError_("Skill review starts after 3 to 100 steps.")
            out[key] = value
        elif key == "helper_model":
            if value not in (None, "off"):
                from core import model_endpoints
                endpoint = model_endpoints.get_endpoint(str(value))
                if endpoint is None or endpoint.get("kind") not in ("local", "api"):
                    raise KeyError_("The helper runs on a local or API model.")
            out[key] = value
        else:
            raise KeyError_(f"Unknown setting: {key}")
    return out


def update_resource_settings(owner: str, patch: dict, expected_revision: Optional[int] = None) -> dict:
    cleaned = _clean_patch(patch)
    with _lock:
        current = resource_settings(owner)
        if expected_revision is not None and expected_revision != current["revision"]:
            raise KeyError_("These settings changed since you opened them. Reload and try again.", 409)
        if "helper_model" in cleaned:
            from core import settings as settings_store
            settings_store.update_settings(helper_endpoint_id=cleaned.pop("helper_model"))
        stored = read_json(_owner_path(owner), {})
        stored = stored if isinstance(stored, dict) else {}
        for key, value in cleaned.items():
            stored[key] = {**(stored.get(key) or {}), **value} if key == "skill_review" else value
        stored["revision"] = current["revision"] + 1
        os.makedirs(os.path.dirname(_owner_path(owner)), exist_ok=True)
        write_json_atomic(_owner_path(owner), stored)
    return resource_settings(owner)

"""The bot record's Bots-mode fields (Bots redesign, Phase 0 unit U1, 2026-10-28).

Spec: Kairos Projects/Agents Redesign/phase-0-design.md, section 2.

agent_service.py keeps the identity and calls in here for everything the
Bots redesign added: the new fields with their defaults and validators, the
load-time upgrade (including the one-field merge of `instructions` into
`soul`), the saved new-bot defaults and presets, the one-call "configured"
creation with its rollback, duplication, the overview card, and the ordering
helpers. Every field is additive and defaulted on load; a second run of the
upgrade changes nothing and writes nothing.
"""
import copy
import json
import os
import re
import threading
import time
import uuid
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

BOT_DEFAULTS_FILE = os.path.join(DATA_DIR, "bot_defaults.json")
BOT_PRESETS_FILE = os.path.join(DATA_DIR, "bot_presets.json")
BACKUP_SUFFIX = ".pre-bots"

MAX_BOTS = 100
MAX_PRESETS = 200
MAX_DEFAULTS_BYTES = 200 * 1024
MAX_MEMORY_SEED_CHARS = 8000
MAX_ROUTINE_TEMPLATES = 10
MAX_FOLDERS = 100

APPROVAL_MODES = ("ask", "auto", "full", "custom")
# Phase 3 flips this one constant; until then the broker behaves as Full for
# every bot surface and offering anything else would be a control that does
# nothing (phase-0-design 2.5).
ENFORCED_APPROVAL_MODES = ("full",)
CACHE_KEEP_WARM = ("follow", "on", "off")
PLACES = ("auto", "computer", "browser", "off")
OUTBOUND_POLICIES = ("ask", "allow")
ORIGIN_KINDS = ("blank", "preset", "ready", "duplicate")
BUILTINS = ("front_desk",)
CONNECTOR_LEVELS = ("off", "read", "write")
SELECTOR = re.compile(r"(native:\S+|mcp:[^:\s]+:\S+)")

# Fields a person may set through create and PATCH, beyond the original set.
BOT_EDITABLE = ("section", "origin", "fallback", "cache_keep_warm", "place", "tool_scope", "connector_scopes",
                "always_allow", "outbound", "approval_mode", "thread_limit", "hidden", "reply_style",
                "notifications", "speak_replies", "voice_id", "call_mode", "skill_selection", "avatar_image",
                "mascot_expression", "browser_enabled", "browser_profile")
# Changes to these do not bump the profile revision: they are not the profile,
# and a bump would stale a pending setup Undo or SOUL.md apply.
NO_REVISION = ("hidden", "hidden_at", "order", "folders")

# What a saved default or preset may carry: preferences only, never grants,
# ids or execution state (OMB F2). Presets are narrower still.
DEFAULT_FIELDS = ("role", "blurb", "soul", "color", "section", "daily_run_cap", "memory_upkeep", "keep_signed_in",
                  "cache_keep_warm", "place", "thread_limit", "memory_seed", "routines", "reply_style",
                  "notifications", "speak_replies", "voice_id", "call_mode", "skill_selection", "mascot_expression")
PRESET_FIELDS = ("name", "role", "blurb", "soul", "avatar", "routines", "memory_seed")


class BotConflict(ValueError):
    """A refusal that is a state problem rather than bad input: HTTP 409."""


class NotAvailableYet(BotConflict):
    """A valid choice the app does not enforce yet (approval below Full)."""


class ConfiguredFailure(Exception):
    """create_configured failed. cleanup_errors is empty when nothing was
    left half made."""

    def __init__(self, status: int, detail: str, cleanup_errors: Optional[list] = None):
        super().__init__(detail)
        self.status, self.detail, self.cleanup_errors = status, detail, list(cleanup_errors or [])


# -- defaults and the load-time upgrade ---------------------------------------

def new_defaults() -> dict:
    """A fresh copy of every field a record gains, with its default."""
    return {"section": None, "origin": {"kind": "blank"}, "hidden": False, "hidden_at": None, "order": None,
            "folders": [], "thread_limit": 3, "approval_mode": "full",
            "outbound": {"policy": "ask", "daily_cap": 25}, "fallback": [], "cache_keep_warm": "follow",
            "place": "auto", "tool_scope": {"allow": [], "deny": []}, "connector_scopes": {}, "always_allow": [],
            "builtin": None, "reply_style": "default", "notifications": True, "speak_replies": False,
            "voice_id": None, "call_mode": "turns", "skill_selection": {"mode": "all", "disabled": []},
            "avatar_image": None, "mascot_expression": None, "browser_enabled": True, "browser_profile": "own"}


def upgrade(record: dict, write_soul=None) -> bool:
    """Bring one stored record up to date, in place. True when it changed.

    Standing instructions end up in one field: `soul` is what the model has
    always been given when it exists, so it wins; text that only lived in
    `instructions` moves into `soul` (write_soul mirrors it to SOUL.md), and
    a differing older `instructions` is kept as `instructions_legacy`, never
    injected."""
    changed = False
    for key, value in new_defaults().items():
        if key not in record:
            record[key] = value
            changed = True
    if "instructions" in record:
        legacy = record.pop("instructions")
        changed = True
        legacy_text = legacy if isinstance(legacy, str) else ""
        soul = record.get("soul")
        soul_text = soul if isinstance(soul, str) else ""
        if legacy_text.strip():
            if not soul_text.strip():
                record["soul"] = legacy_text
                if write_soul is not None:
                    write_soul(record.get("id"), legacy_text)
            elif soul_text.strip() != legacy_text.strip():
                kept = record.get("instructions_legacy")
                if isinstance(kept, str) and kept.strip() and kept.strip() != legacy_text.strip():
                    legacy_text = kept + "\n\n---\n\n" + legacy_text
                record["instructions_legacy"] = legacy_text
    return changed


def pending(agents: dict) -> bool:
    """Would upgrade change any record? Decided on copies, so the caller can
    take its backup before the first write."""
    return any(upgrade(copy.deepcopy(record)) for record in agents.values())


def upgrade_all(agents: dict, write_soul=None) -> list[str]:
    """Upgrade every record; the ids that changed. Idempotent."""
    return [agent_id for agent_id, record in agents.items() if upgrade(record, write_soul)]


def backup(path: str) -> Optional[str]:
    """Copy agents.json beside itself as agents.json.pre-bots, once."""
    target = path + BACKUP_SUFFIX
    if os.path.exists(target) or not os.path.exists(path):
        return None
    import shutil
    shutil.copy2(path, target)
    return target


def sort_key(agent: dict) -> tuple:
    """Roster order: set `order` first, then the rest by creation time."""
    order = agent.get("order")
    return (order is None, order if isinstance(order, int) else 0, agent.get("created_at") or 0)


def is_visible(agent: dict) -> bool:
    return not agent.get("hidden")


# -- validators -----------------------------------------------------------------

def _whole(value, low: int, high: int, label: str) -> int:
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{label} must be a whole number from {low} to {high}")
    return value


def _choice(value, options: tuple, label: str) -> str:
    if not isinstance(value, str) or value not in options:
        raise ValueError(f"{label} must be one of: {', '.join(options)}")
    return value


def check_approval(value, label: str = "approval_mode", allowed: tuple = APPROVAL_MODES) -> str:
    """Known value, and one the app enforces today (Full only)."""
    mode = _choice(value, allowed, label)
    if mode not in ENFORCED_APPROVAL_MODES:
        raise NotAvailableYet(f"{label} {mode!r} is not available yet; bots run at Full for now")
    return mode


def _clean_section(value) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("section must be text")
    value = " ".join(value.split())
    if len(value) > 60:
        raise ValueError("section is limited to 60 characters")
    return value or None


def _clean_origin(value) -> dict:
    if not isinstance(value, dict) or set(value) - {"kind", "id", "from_agent_id"}:
        raise ValueError("origin is {kind, id?, from_agent_id?}")
    kind = _choice(value.get("kind"), ORIGIN_KINDS, "origin kind")
    origin = {"kind": kind}
    for key, limit in (("id", 80), ("from_agent_id", 40)):
        if value.get(key) is not None:
            if not isinstance(value[key], str) or not 1 <= len(value[key]) <= limit:
                raise ValueError(f"origin {key} must be text of 1 to {limit} characters")
            origin[key] = value[key]
    return origin


def _clean_outbound(value, current: Optional[dict] = None) -> dict:
    if not isinstance(value, dict) or set(value) - {"policy", "daily_cap"}:
        raise ValueError("outbound is {policy, daily_cap}")
    merged = {**(current or new_defaults()["outbound"]), **value}
    return {"policy": _choice(merged["policy"], OUTBOUND_POLICIES, "outbound policy"),
            "daily_cap": _whole(merged["daily_cap"], 1, 1000, "outbound daily_cap")}


def _clean_fallback(value) -> list:
    if not isinstance(value, list) or len(value) > 5:
        raise ValueError("fallback is a list of up to 5 models")
    from services.agent_service import _check_model
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) - {"endpoint_id", "model_override"} or not item.get("endpoint_id"):
            raise ValueError("each fallback is {endpoint_id, model_override?}")
        override, _ = _check_model(item["endpoint_id"], item.get("model_override"), None)
        entry = {"endpoint_id": item["endpoint_id"]}
        if override is not None:
            entry["model_override"] = override
        result.append(entry)
    return result


def _clean_selectors(value, label: str) -> list:
    if not isinstance(value, list) or len(value) > 256:
        raise ValueError(f"{label} is a list of up to 256 selectors")
    for item in value:
        if not isinstance(item, str) or not 1 <= len(item) <= 1024 or not SELECTOR.fullmatch(item):
            raise ValueError(f"{label} selectors look like native:<name|*> or mcp:<server>:<name|*>, "
                             "1024 characters at most")
    return list(dict.fromkeys(value))


def _clean_tool_scope(value) -> dict:
    if not isinstance(value, dict) or set(value) - {"allow", "deny"}:
        raise ValueError("tool_scope is {allow, deny}")
    return {"allow": _clean_selectors(value.get("allow", []), "tool_scope allow"),
            "deny": _clean_selectors(value.get("deny", []), "tool_scope deny")}


def _clean_connector_scopes(value) -> dict:
    if not isinstance(value, dict) or len(value) > 100:
        raise ValueError("connector_scopes maps up to 100 apps to off, read or write")
    for app_id, level in value.items():
        if not isinstance(app_id, str) or not 1 <= len(app_id) <= 80:
            raise ValueError("connector_scopes app ids are 1 to 80 characters")
        _choice(level, CONNECTOR_LEVELS, "connector scope")
    return dict(value)


def _clean_always_allow(value) -> list:
    if not isinstance(value, list) or len(value) > 200 or any(
            not isinstance(item, str) or not 1 <= len(item) <= 1024 for item in value):
        raise ValueError("always_allow is a list of up to 200 entries of up to 1024 characters")
    return list(dict.fromkeys(value))


def clean_field(key: str, value, current: Optional[dict] = None):
    """Validate and normalise one new bot field. ValueError for bad input,
    BotConflict (NotAvailableYet) for a refusal that is state."""
    if key == "section":
        return _clean_section(value)
    if key in ("notifications", "speak_replies", "browser_enabled"):
        if type(value) is not bool:
            raise ValueError(f"{key} is true or false")
        return value
    if key == "browser_profile":
        if not isinstance(value, str) or not re.fullmatch(r"own|guest|shared:[0-9a-f]{12}", value):
            raise ValueError("Choose own, guest or a saved shared browser profile")
        return value
    if key == "reply_style":
        return _choice(value, ("default", "conversational"), key)
    if key == "call_mode":
        return _choice(value, ("turns", "live"), key)
    if key == "voice_id":
        if value is None:
            return None
        if not isinstance(value, str) or not re.fullmatch(r"[\w.:-]{1,200}", value):
            raise ValueError("voice_id is a saved voice identifier, up to 200 characters")
        return value
    if key == "mascot_expression":
        if value is None:
            return None
        return _choice(value, ("sleeping", "idle", "listening", "thinking", "speaking", "success", "needs", "error", "carry"), key)
    if key == "skill_selection":
        if not isinstance(value, dict) or set(value) - {"mode", "disabled"} or value.get("mode") != "all":
            raise ValueError("skill_selection is {mode: all, disabled: []}")
        disabled = value.get("disabled", [])
        if not isinstance(disabled, list) or len(disabled) > 256 or any(
                not isinstance(v, str) or not re.fullmatch(r"[\w.-]{1,160}", v) for v in disabled):
            raise ValueError("disabled contains up to 256 skill identifiers")
        return {"mode": "all", "disabled": list(dict.fromkeys(disabled))}
    if key == "avatar_image":
        if value is None:
            return None
        if not isinstance(value, dict) or set(value) != {"asset_id", "shape", "zoom", "focus_x", "focus_y"}:
            raise ValueError("avatar_image needs asset_id, shape, zoom, focus_x and focus_y")
        if not isinstance(value["asset_id"], str) or not re.fullmatch(r"[0-9a-f]{32}", value["asset_id"]):
            raise ValueError("invalid avatar asset")
        _choice(value["shape"], ("circle", "rounded", "square", "kip"), "avatar shape")
        for field, low, high in (("zoom", 1, 3), ("focus_x", 0, 1), ("focus_y", 0, 1)):
            if type(value[field]) not in (float, int) or not low <= value[field] <= high:
                raise ValueError(f"avatar {field} must be from {low} to {high}")
        return dict(value)
    if value is None:
        raise ValueError(f"{key} cannot be empty")
    if key == "origin":
        return _clean_origin(value)
    if key == "hidden":
        if not isinstance(value, bool):
            raise ValueError("hidden is true or false")
        return value
    if key == "thread_limit":
        return _whole(value, 1, 16, "thread_limit")
    if key == "approval_mode":
        return check_approval(value)
    if key == "outbound":
        return _clean_outbound(value, (current or {}).get("outbound"))
    if key == "fallback":
        return _clean_fallback(value)
    if key == "cache_keep_warm":
        return _choice(value, CACHE_KEEP_WARM, "cache_keep_warm")
    if key == "place":
        return _choice(value, PLACES, "place")
    if key == "tool_scope":
        return _clean_tool_scope(value)
    if key == "connector_scopes":
        return _clean_connector_scopes(value)
    if key == "always_allow":
        return _clean_always_allow(value)
    raise ValueError(f"{key} cannot be changed")


# -- routines and memory seeds (shared by defaults, presets and "configured") ---

ROUTINE_KEYS = {"name", "prompt", "schedule_kind", "run_time", "interval_seconds", "report_when", "time_zone",
                "weekdays"}


def clean_routine(value) -> dict:
    """A routine template, structurally checked. The schedule itself is
    checked again by task_service when a routine is really made."""
    if not isinstance(value, dict) or set(value) - ROUTINE_KEYS:
        raise ValueError("a routine is {name, prompt, schedule_kind, run_time?, interval_seconds?, report_when?, "
                         "time_zone?, weekdays?}")
    name = value.get("name")
    prompt = value.get("prompt")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 200:
        raise ValueError("a routine needs a name of 1 to 200 characters")
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 8000:
        raise ValueError("a routine needs instructions of 1 to 8000 characters")
    kind = value.get("schedule_kind")
    if kind not in ("daily", "interval"):
        raise ValueError("a routine runs daily or every so many hours")
    routine = {"name": name.strip(), "prompt": prompt.strip(), "schedule_kind": kind}
    if kind == "daily":
        match = re.fullmatch(r"(\d{1,2}):(\d{2})", str(value.get("run_time") or "").strip())
        if not match or not (int(match[1]) <= 23 and int(match[2]) <= 59) or value.get("interval_seconds") is not None:
            raise ValueError("a daily routine needs run_time as HH:MM and no interval")
        routine["run_time"] = value["run_time"].strip()
    else:
        seconds = value.get("interval_seconds")
        if type(seconds) is not int or not 60 <= seconds <= 366 * 86400 or value.get("run_time") is not None:
            raise ValueError("an interval routine needs interval_seconds of at least 60 and no run_time")
        routine["interval_seconds"] = seconds
    if value.get("report_when") is not None:
        routine["report_when"] = _choice(value["report_when"], ("always", "notable"), "report_when")
    if value.get("time_zone") is not None:
        if not isinstance(value["time_zone"], str) or not 1 <= len(value["time_zone"]) <= 64:
            raise ValueError("time_zone is an IANA name")
        routine["time_zone"] = value["time_zone"]
    if value.get("weekdays") is not None:
        days = value["weekdays"]
        if kind != "daily" or not isinstance(days, list) or not days or any(
                type(day) is not int or not 0 <= day <= 6 for day in days):
            raise ValueError("weekdays is a list of 0 (Monday) to 6 (Sunday) on a daily routine")
        routine["weekdays"] = sorted(set(days))
    return routine


def clean_routines(value) -> list:
    if not isinstance(value, list) or len(value) > MAX_ROUTINE_TEMPLATES:
        raise ValueError(f"at most {MAX_ROUTINE_TEMPLATES} routines")
    return [clean_routine(item) for item in value]


def clean_memory_seed(value) -> list:
    from services.agent_service import MEMORY_SECTIONS
    if not isinstance(value, list):
        raise ValueError("memory_seed is a list of {section, text}")
    seed, total = [], 0
    for item in value:
        if not isinstance(item, dict) or set(item) - {"section", "text"}:
            raise ValueError("each memory note is {section, text}")
        section = next((s for s in MEMORY_SECTIONS if s.lower() == str(item.get("section") or "").strip().lower()), None)
        text = " ".join(str(item.get("text") or "").split())
        if section is None or not text:
            raise ValueError(f"each memory note needs a section ({', '.join(MEMORY_SECTIONS)}) and text")
        total += len(text)
        seed.append({"section": section, "text": text})
    if total > MAX_MEMORY_SEED_CHARS:
        raise ValueError(f"the starting notes are limited to {MAX_MEMORY_SEED_CHARS} characters; this is {total}")
    return seed


# -- saved new-bot defaults (F2) and presets ----------------------------------

_STORE_LOCK = threading.RLock()


def _clean_default_value(key: str, value):
    from services import agent_service as agents
    if key == "role":
        return agents._profile_text("role", value, 200)
    if key == "blurb":
        return agents._profile_text("blurb", value, 4000)
    if key == "soul":
        agents._check_soul(value)
        return value
    if key == "color":
        if value not in agents.COLORS:
            raise ValueError("pick one of the offered colors")
        return value
    if key == "section":
        return _clean_section(value)
    if key == "daily_run_cap":
        return agents._cap(value)
    if key in ("memory_upkeep", "keep_signed_in"):
        if not isinstance(value, bool):
            raise ValueError(f"{key} is true or false")
        return value
    if key == "memory_seed":
        return clean_memory_seed(value)
    if key == "routines":
        return clean_routines(value)
    return clean_field(key, value)


def clean_defaults(value) -> dict:
    if not isinstance(value, dict):
        raise ValueError("defaults is an object")
    extra = sorted(set(value) - set(DEFAULT_FIELDS))
    if extra:
        raise ValueError(f"defaults cannot carry {', '.join(extra)}: preferences only")
    cleaned = {key: _clean_default_value(key, item) for key, item in value.items()}
    if len(json.dumps(cleaned, ensure_ascii=False).encode("utf-8")) > MAX_DEFAULTS_BYTES:
        raise ValueError(f"new-bot defaults are limited to {MAX_DEFAULTS_BYTES // 1024} KB")
    return cleaned


def read_defaults() -> dict:
    with _STORE_LOCK:
        stored = read_json(BOT_DEFAULTS_FILE, {})
    return stored if isinstance(stored, dict) else {}


def write_defaults(value) -> dict:
    cleaned = clean_defaults(value)
    with _STORE_LOCK:
        write_json_atomic(BOT_DEFAULTS_FILE, cleaned)
    return cleaned


def defaults_view(taken_names) -> dict:
    """What GET and PUT /api/agents/defaults answer."""
    from core import model_endpoints
    from services import bot_names
    endpoint = next((e["id"] for e in model_endpoints.list_endpoints() if e["kind"] == "claude_cli"), None)
    return {"defaults": read_defaults(),
            "model_selection": {"endpoint_id": endpoint, "model_override": None, "model_effort": None,
                                "source": "the first Claude connection until a bot picks its own"},
            "suggested_name": bot_names.suggest(taken_names)}


def clean_preset(value) -> dict:
    if not isinstance(value, dict):
        raise ValueError("a preset is an object")
    extra = sorted(set(value) - set(PRESET_FIELDS))
    if extra:
        raise ValueError(f"a preset cannot carry {', '.join(extra)}: identity, notes and routines only")
    from services import agent_service as agents
    name = " ".join(str(value.get("name") or "").split())
    if not 1 <= len(name) <= 100:
        raise ValueError("a preset's name is 1 to 100 characters")
    preset = {"name": name, "role": agents._profile_text("role", value.get("role"), 200),
              "blurb": agents._profile_text("blurb", value.get("blurb"), 4000)}
    soul = value.get("soul") or ""
    agents._check_soul(soul)
    preset["soul"] = soul
    preset["avatar"] = agents.validate_avatar(value["avatar"]) if value.get("avatar") is not None else None
    preset["routines"] = clean_routines(value.get("routines") or [])
    preset["memory_seed"] = clean_memory_seed(value.get("memory_seed") or [])
    return preset


def list_presets() -> list:
    with _STORE_LOCK:
        stored = read_json(BOT_PRESETS_FILE, [])
    return [{**item, "source": "saved"} for item in stored] if isinstance(stored, list) else []


def add_preset(value) -> dict:
    preset = {"id": uuid.uuid4().hex[:10], **clean_preset(value), "created_at": time.time()}
    with _STORE_LOCK:
        stored = read_json(BOT_PRESETS_FILE, [])
        stored = stored if isinstance(stored, list) else []
        if len(stored) >= MAX_PRESETS:
            raise BotConflict(f"you can save up to {MAX_PRESETS} presets; delete one first")
        write_json_atomic(BOT_PRESETS_FILE, [*stored, preset])
    return {**preset, "source": "saved"}


def delete_preset(preset_id: str) -> bool:
    with _STORE_LOCK:
        stored = read_json(BOT_PRESETS_FILE, [])
        stored = stored if isinstance(stored, list) else []
        kept = [item for item in stored if item.get("id") != preset_id]
        if len(kept) == len(stored):
            return False
        write_json_atomic(BOT_PRESETS_FILE, kept)
    return True


def preset_from_agent(agent: dict) -> dict:
    """A preset describing a bot: its identity, standing instructions, look
    and routines. Never its model, access, approval or notes."""
    from services.task_service import task_service
    routines = []
    for task in task_service.list_tasks():
        if task.get("agent_id") != agent["id"] or task["schedule_kind"] not in ("daily", "interval"):
            continue
        routine = {"name": task["name"], "prompt": task["prompt"], "schedule_kind": task["schedule_kind"],
                   "report_when": task.get("report_when") or "notable"}
        if task["schedule_kind"] == "daily":
            routine["run_time"] = task.get("run_time")
        else:
            routine["interval_seconds"] = task.get("interval_seconds")
        for key in ("time_zone", "weekdays"):
            if task.get(key) is not None:
                routine[key] = task[key]
        routines.append(routine)
    return {"name": agent["name"], "role": agent.get("role") or "", "blurb": agent.get("blurb") or "",
            "soul": agent.get("soul") or "", "avatar": agent.get("avatar"),
            "routines": routines[:MAX_ROUTINE_TEMPLATES], "memory_seed": []}


# -- creation in one call (F1) --------------------------------------------------

def _rollback(agent_id: Optional[str], routine_ids: list) -> list:
    """Undo a half-made bot: its routines first, then the bot. A routine that
    cannot be removed keeps the bot, so nothing is left without an owner."""
    from services.agent_service import agent_service
    from services.task_service import task_service
    errors = []
    for routine_id in routine_ids:
        try:
            task_service.delete_task(routine_id)
        except Exception as error:
            errors.append(f"could not remove routine {routine_id}: {error}")
    if agent_id is None:
        return errors
    if errors:
        errors.append("kept the bot so its leftover routines still have an owner")
        return errors
    try:
        if agent_service.get(agent_id) is not None:
            agent_service.delete(agent_id)
    except Exception as error:
        errors.append(f"could not remove the bot: {error}")
    return errors


def create_configured(payload: dict, owner_user: Optional[str] = None) -> dict:
    """Make a bot, its notes and its routines as one step. Anything that goes
    wrong before the bot is verified undoes everything (a ConfiguredFailure,
    cleanup_errors empty when nothing is left over); a routine that cannot be
    turned on afterwards is a warning and the bot stays.

    Routines are made switched off and switched on one by one only after the
    bot is verified, so a routine can never run for a bot that is then rolled
    back."""
    from services.agent_service import agent_service
    from services.task_service import task_service
    payload = dict(payload or {})
    profile = dict(payload.get("profile") or {})
    model = dict(payload.get("model") or {})
    try:
        if len(agent_service.list_agents()) >= MAX_BOTS:
            raise BotConflict(f"you can have up to {MAX_BOTS} bots; delete or archive one first")
        approval = check_approval(payload.get("approval_mode", "full"))
        base = read_defaults() if payload.get("use_defaults") else {}
        for key in ("role", "blurb", "soul", "color", "section"):
            if profile.get(key) in (None, "") and base.get(key) not in (None, ""):
                profile[key] = base[key]
        seed = clean_memory_seed(payload["memory_seed"] if payload.get("memory_seed") is not None
                                 else base.get("memory_seed") or [])
        routines = clean_routines(payload["routines"] if payload.get("routines") is not None
                                  else base.get("routines") or [])
        preference_keys = ("daily_run_cap", "memory_upkeep", "keep_signed_in", "cache_keep_warm", "place", "thread_limit",
                           "reply_style", "notifications", "speak_replies", "voice_id", "call_mode", "skill_selection",
                           "mascot_expression")
        extras = {key: base[key] for key in preference_keys if key in base}
        extras.update({key: profile[key] for key in preference_keys if key in profile})
        for key in ("keep_signed_in", "memory_upkeep"):
            if payload.get(key) is not None:
                extras[key] = payload[key]
        if payload.get("origin") is not None:
            extras["origin"] = _clean_origin(payload["origin"])
        if profile.get("section") is not None:
            extras["section"] = _clean_section(profile["section"])
        extras = {key: (clean_field(key, value) if key in BOT_EDITABLE else value) for key, value in extras.items()}
    except BotConflict as error:
        raise ConfiguredFailure(409, str(error)) from error
    except ValueError as error:
        raise ConfiguredFailure(400, str(error)) from error

    before = set(agent_service._agents)
    created: list = []
    agent_id: Optional[str] = None
    try:
        agent = agent_service.create(
            profile.get("name", ""), role=profile.get("role") or "", blurb=profile.get("blurb") or "",
            soul=profile.get("soul"), color=profile.get("color"), avatar=profile.get("avatar"),
            deliver_to_channel=profile.get("deliver_to_channel"), endpoint_id=model.get("endpoint_id"),
            model_override=model.get("model_override"), model_effort=model.get("model_effort"),
            integration_ids=payload.get("integration_ids"), approval_mode=approval,
            **{key: value for key, value in extras.items() if key != "approval_mode"})
        agent_id = agent["id"]
        for note in seed:
            agent_service.remember(agent_id, note["section"], note["text"])
        if agent_service.get(agent_id).get("approval_mode") != approval:
            raise RuntimeError(f"the bot was made with approval {agent_service.get(agent_id).get('approval_mode')!r}, "
                               f"not the {approval!r} that was asked for")
        for routine in routines:
            task = task_service.create_task(
                routine["name"], routine["prompt"], routine["schedule_kind"], run_time=routine.get("run_time"),
                interval_seconds=routine.get("interval_seconds"), agent_id=agent_id,
                report_when=routine.get("report_when") or "notable", time_zone=routine.get("time_zone"),
                weekdays=routine.get("weekdays"), owner_user=owner_user, enabled=False)
            created.append(task["id"])
    except Exception as error:
        agent_id = agent_id or next(iter(set(agent_service._agents) - before), None)
        leftovers = _rollback(agent_id, created)
        status = 400 if isinstance(error, ValueError) else 500
        raise ConfiguredFailure(status, str(error) or error.__class__.__name__, leftovers) from error

    warnings = []
    routines_made = []
    for routine_id in created:
        task = task_service.get_task(routine_id)
        try:
            routines_made.append(task_service.update_task(routine_id, enabled=True))
        except Exception as error:
            warnings.append(f"The routine {task['name'] if task else routine_id} was made but could not be "
                            f"turned on: {error}")
            routines_made.append(task_service.get_task(routine_id) or {"id": routine_id})
    return {"agent": agent_service.get(agent_id), "routines": routines_made, "warnings": warnings}


# -- duplicate -----------------------------------------------------------------

DUPLICATE_FIELDS = ("role", "blurb", "soul", "color", "avatar", "endpoint_id", "model_override", "model_effort",
                    "integration_ids", "daily_run_cap", "section", "approval_mode", "outbound", "fallback",
                    "cache_keep_warm", "place", "tool_scope", "connector_scopes", "always_allow", "thread_limit",
                    "memory_upkeep", "reply_style", "notifications", "speak_replies", "voice_id", "call_mode",
                    "skill_selection", "mascot_expression", "browser_enabled")


def duplicate_name(source_name: str, taken) -> str:
    used = {str(name).lower() for name in taken}
    base = f"{source_name} copy"[:100]
    if base.lower() not in used:
        return base
    number = 2
    while True:
        suffix = f" {number}"
        candidate = base[:100 - len(suffix)] + suffix
        if candidate.lower() not in used:
            return candidate
        number += 1


def duplicate(agent_id: str, name: Optional[str] = None) -> dict:
    """A new bot with this one's profile, model, look and restrictions. Not
    its notes, routines, peers, history or sign-ins."""
    from services.agent_service import agent_service
    source = agent_service.get(agent_id)
    if source is None:
        raise KeyError(agent_id)
    if len(agent_service.list_agents()) >= MAX_BOTS:
        raise BotConflict(f"you can have up to {MAX_BOTS} bots; delete or archive one first")
    taken = [a["name"] for a in agent_service.list_agents()]
    chosen = name if name else duplicate_name(source["name"], taken)
    fields = {key: copy.deepcopy(source[key]) for key in DUPLICATE_FIELDS if source.get(key) is not None}
    fields["origin"] = {"kind": "duplicate", "from_agent_id": agent_id}
    return agent_service.create(chosen, **fields)


# -- overview (F7) --------------------------------------------------------------

def overview(agent: dict) -> dict:
    """The facts behind a bot's overview card, derived from what is stored."""
    from services.task_service import task_service
    from services.trigger_service import trigger_service
    from services.agent_service import agent_service
    owned = [t for t in task_service.list_tasks() if t.get("agent_id") == agent["id"]]
    routines = [t for t in owned if t["schedule_kind"] in ("daily", "interval")]
    cards = [t for t in owned if t["schedule_kind"] == "card"]
    triggers = trigger_service.for_agent(agent["id"])
    peers = [agent_service.get(p)["name"] for p in agent.get("peers") or [] if agent_service.get(p)]
    owned_ids = {t["id"] for t in owned}
    recent = [{"task_id": r["task_id"], "name": next((t["name"] for t in owned if t["id"] == r["task_id"]), ""),
               "ran_at": r.get("ran_at"), "outcome": r.get("outcome")}
              for r in task_service.list_runs() if r["task_id"] in owned_ids][:5]
    scope = agent.get("tool_scope") or {"allow": [], "deny": []}
    wont = []
    if not agent.get("enabled", True):
        wont.append("It is turned off, so it will not run until you turn it on.")
    wont.append(f"It stops after {agent.get('daily_run_cap')} runs a day.")
    wont.extend(f"Saved, not enforced yet: avoid {selector}." for selector in scope.get("deny", []))
    wont.extend(f"Saved, not enforced yet: turn off {app_id}." for app_id, level in (agent.get("connector_scopes") or {}).items()
                if level == "off")
    integrations = agent.get("integration_ids")
    setup = [
        {"id": "identity", "done": bool((agent.get("role") or "").strip()), "label": "Give it a name and a job",
         "section": "identity"},
        {"id": "soul", "done": bool((agent.get("soul") or "").strip()), "label": "Write its standing instructions",
         "section": "soul"},
        {"id": "model", "done": bool(agent.get("endpoint_id")), "label": "Choose its model", "section": "model"},
        {"id": "schedule", "done": bool(routines or triggers), "label": "Give it a schedule or a trigger",
         "section": "routines"},
    ]
    return {
        "who": {"name": agent["name"], "role": agent.get("role") or "", "blurb": agent.get("blurb") or "",
                "section": agent.get("section"), "color": agent.get("color"), "avatar": agent.get("avatar")},
        "does": {"routines": [{"id": t["id"], "name": t["name"], "schedule_kind": t["schedule_kind"],
                               "run_time": t.get("run_time"), "interval_seconds": t.get("interval_seconds"),
                               "enabled": bool(t.get("enabled"))} for t in routines],
                 "triggers": [{"id": t["id"], "name": t.get("name"), "enabled": bool(t.get("enabled"))}
                              for t in triggers],
                 "open_cards": sum(1 for c in cards if c.get("status") not in ("done",)), "peers": peers},
        "reaches": {"endpoint_id": agent.get("endpoint_id"), "model_override": agent.get("model_override"),
                    "model_effort": agent.get("model_effort"),
                    "integrations": "all" if integrations is None else list(integrations),
                    "place": agent.get("place"), "keep_signed_in": bool(agent.get("keep_signed_in")),
                    "deliver_to_channel": agent.get("deliver_to_channel")},
        "wont": wont,
        "recent": recent,
        "grants": {"approval_mode": agent.get("approval_mode"), "outbound": agent.get("outbound"),
                   "always_allow": list(agent.get("always_allow") or []), "tool_scope": scope,
                   "connector_scopes": dict(agent.get("connector_scopes") or {})},
        "setup": setup,
    }

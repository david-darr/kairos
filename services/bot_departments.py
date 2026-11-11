"""Person-owned teams, discovered from the existing bot section field.

The registry also journals section moves before touching bot records. Recovery
finishes a journaled move, so a restart cannot split a renamed team in two.
"""
import builtins
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import unicodedata
import uuid

from fastapi import HTTPException

from core.atomic_io import write_json_atomic
from core.constants import DATA_DIR
from services import bot_attention

LOCK = threading.RLock()


def service():
    from services.agent_service import agent_service
    return agent_service


def root():
    from core import accounts
    return Path(accounts.path("bot-teams"))


def load(path, default):
    """Unlike boot-time read_json, damaged state must never become writable defaults."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return copy.deepcopy(default)
    except (OSError, ValueError, UnicodeError) as error:
        raise HTTPException(503, "Team data could not be read") from error


def save(path, value):
    try:
        write_json_atomic(str(path), value)
    except OSError as error:
        raise HTTPException(503, "Team data could not be saved") from error


def registry_path():
    from core import accounts
    return Path(accounts.path("bot_departments.json"))


def _read():
    data = load(registry_path(), {"version": 1, "departments": [], "pending": None})
    if (not isinstance(data, dict) or data.get("version") != 1 or
            not isinstance(data.get("departments"), builtins.list) or
            any(not isinstance(d, dict) or not re.fullmatch(r"[a-f0-9]{32}", str(d.get("id", "")))
                or not isinstance(d.get("name"), str) or not isinstance(d.get("revision"), int)
                for d in data["departments"])):
        raise HTTPException(503, "Team data could not be read")
    return data


def owner(bot):
    return bot_attention.owner_of(bot) or bot_attention.legacy_owner()


def clean_name(value):
    if (not isinstance(value, str) or not 1 <= len(value.strip()) <= 60 or
            any(unicodedata.category(c).startswith("C") for c in value)):
        raise HTTPException(400, "A team name is 1 to 60 characters without control characters")
    return value.strip()


def _same(a, b):
    return (a or "").casefold() == (b or "").casefold()


def _new(name, user, order):
    return {"id": uuid.uuid4().hex, "name": name, "order": order, "chief_bot_id": None,
            "also_manages": [], "created_at": time.time(), "revision": 1, "owner_user": user}


def _recover(data):
    pending = data.get("pending")
    if not pending:
        return
    for move in pending["moves"]:
        bot = service().get(move["id"])
        if bot and bot.get("section", "") == move["before"]:
            service().mutate_bot(bot["id"], lambda b, section=move["after"]: b.update(section=section))
    data["departments"] = pending["after"]
    data["pending"] = None
    save(registry_path(), data)


def _sync():
    data = _read()
    _recover(data)
    before = copy.deepcopy(data)
    for bot in service().list_agents():
        section = (bot.get("section") or "").strip()
        if section and not any(d.get("owner_user") == owner(bot) and _same(d["name"], section)
                               for d in data["departments"]):
            data["departments"].append(_new(clean_name(section), owner(bot), len(data["departments"])))
    for team in data["departments"]:
        chief = service().get(team.get("chief_bot_id"))
        if team.get("chief_bot_id") and (not chief or owner(chief) != team.get("owner_user") or
                                         not _same(chief.get("section", ""), team["name"])):
            team.update(chief_bot_id=None, also_manages=[], revision=team["revision"] + 1)
    if data != before:
        save(registry_path(), data)
    return data


def list(user=None):
    with LOCK:
        return sorted((copy.deepcopy(d) for d in _sync()["departments"]
                       if user is None or d.get("owner_user") == user), key=lambda d: (d["order"], d["id"]))


def get(ident, user=None):
    with LOCK:
        found = next((d for d in _sync()["departments"] if d["id"] == ident and
                      (user is None or d.get("owner_user") == user)), None)
        if not found:
            raise HTTPException(404, "Team not found")
        return copy.deepcopy(found)


def members(ident, user=None):
    team = get(ident, user)
    return [copy.deepcopy(b) for b in service().list_agents()
            if owner(b) == team.get("owner_user") and _same(b.get("section", ""), team["name"])]


def team_of(bot_id):
    bot = service().get(bot_id)
    if not bot or not (bot.get("section") or "").strip():
        return None
    return next((d for d in list(owner(bot)) if _same(d["name"], bot["section"].strip())), None)


def ensure_for(section, user=None):
    if isinstance(section, dict):
        user, section = owner(section), section.get("section", "")
    if not section:
        return None
    name = clean_name(section)
    with LOCK:
        found = next((d for d in list(user) if _same(d["name"], name)), None)
        return found or create(name, [], user or bot_attention.legacy_owner())


def busy(bot):
    from services.bot_chat_service import running_threads
    return bool(running_threads(bot["id"]) or bot["id"] in getattr(service(), "_running", {}))


def _idle(bots):
    if any(busy(b) for b in bots):
        raise HTTPException(409, "Wait for the team's bots to finish first")


def _commit_moves(data, after, moves):
    # Caller holds both team and profile locks. A failed mutation is rolled
    # back in memory and on disk; a crash resumes the durable intent.
    data["pending"] = {"after": after, "moves": moves}
    save(registry_path(), data)
    changed = []
    try:
        for move in moves:
            service().mutate_bot(move["id"], lambda b, s=move["after"]: b.update(section=s))
            changed.append(move)
    except Exception:
        for move in reversed(changed):
            service().mutate_bot(move["id"], lambda b, s=move["before"]: b.update(section=s))
        data["pending"] = None
        save(registry_path(), data)
        raise
    data.update(departments=after, pending=None)
    save(registry_path(), data)


def create(name, bot_ids, user):
    name = clean_name(name)
    if len(bot_ids) > 100 or len(set(bot_ids)) != len(bot_ids):
        raise HTTPException(400, "Choose up to 100 distinct bots")
    with LOCK, service()._profile_lock:
        data = _sync()
        if any(d.get("owner_user") == user and _same(d["name"], name) for d in data["departments"]):
            raise HTTPException(409, "A team with that name already exists")
        bots = [bot_attention.require_bot(i, user) for i in bot_ids]
        _idle(bots)
        team = _new(name, user, len(data["departments"]))
        _commit_moves(data, data["departments"] + [team],
                      [{"id": b["id"], "before": b.get("section", ""), "after": name} for b in bots])
        return get(team["id"], user)


def rename(ident, name, expected_revision=None, user=None, order=None):
    name = clean_name(name)
    with LOCK, service()._profile_lock:
        team = get(ident, user)
        if expected_revision is not None and expected_revision != team["revision"]:
            raise HTTPException(409, "The team changed. Reload it first")
        data = _sync()
        if any(d["id"] != ident and d.get("owner_user") == team.get("owner_user") and _same(d["name"], name)
               for d in data["departments"]):
            raise HTTPException(409, "A team with that name already exists")
        bots = members(ident, user)
        _idle(bots)
        after = copy.deepcopy(data["departments"])
        target = next(d for d in after if d["id"] == ident)
        target.update(name=name, revision=team["revision"] + 1)
        if order is not None:
            if type(order) is not int or not 0 <= order <= 10000:
                raise HTTPException(400, "Team order is 0 to 10000")
            target["order"] = order
        _commit_moves(data, after, [{"id": b["id"], "before": b.get("section", ""), "after": name} for b in bots])
        return get(ident, user)


def delete(ident, user=None):
    with LOCK, service()._profile_lock:
        get(ident, user)
        bots = members(ident, user)
        _idle(bots)
        data = _sync()
        _commit_moves(data, [d for d in data["departments"] if d["id"] != ident],
                      [{"id": b["id"], "before": b.get("section", ""), "after": ""} for b in bots])
        # Keep the protected files for audit and potential restoration.
        return {"ok": True}


def directory(ident, user=None):
    get(ident, user)  # IDs come from the registry, never paths from a model.
    return root() / ident


def instructions(ident, user=None):
    path = directory(ident, user) / "instructions.md"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        text = ""
    except (OSError, UnicodeError) as error:
        raise HTTPException(503, "Team instructions could not be read") from error
    return {"text": text, "hash": hashlib.sha256(text.encode()).hexdigest(), "max_bytes": 24000}


def put_instructions(ident, text, expected_hash, user=None):
    if not isinstance(text, str) or len(text.encode("utf-8")) > 24000:
        raise HTTPException(400, "Team instructions can use up to 24000 bytes")
    with LOCK:
        current = instructions(ident, user)
        if current["hash"] != expected_hash:
            raise HTTPException(409, "Team instructions changed. Reload them first")
        path = directory(ident, user) / "instructions.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return instructions(ident, user)


def set_chief(ident, bot_id, also_manages=(), user=None):
    with LOCK:
        team = get(ident, user)
        if len(also_manages) > 100 or len(set(also_manages)) != len(also_manages):
            raise HTTPException(400, "Choose up to 100 distinct teams")
        for managed in also_manages:
            get(managed, team.get("owner_user"))
        if bot_id:
            bot = next((b for b in members(ident, user) if b["id"] == bot_id), None)
            if not bot:
                raise HTTPException(400, "The chief must be a member of this team")
            if bot.get("hidden") or not service().chat_endpoint(bot):
                raise HTTPException(409, "The chief needs an available model with tools")
        data = _sync()
        target = next(d for d in data["departments"] if d["id"] == ident)
        target.update(chief_bot_id=bot_id, also_manages=builtins.list(also_manages) if bot_id else [],
                      revision=target["revision"] + 1)
        save(registry_path(), data)
        return copy.deepcopy(target)


TIERS = ("light", "standard", "strong")


def clean_internal_tools(value):
    """A team template's internal tools (Bot team approvals, 2026-11-11): Kairos tools that only change Kairos's
    own data, which the team's bots use without a prompt (core/bot_policy.py team_internal). A tool that sends,
    deletes, runs things or reaches outside Kairos is refused, not silently dropped."""
    from core import bot_policy
    if value is None:
        return []
    if not isinstance(value, builtins.list) or len(value) > 100 or len(set(map(str, value))) != len(value):
        raise ValueError("A team's internal tools are up to 100 distinct tool names")
    for name in value:
        problem = bot_policy.internal_tool_problem(name)
        if problem:
            raise ValueError(problem)
    return sorted(value)


def clean_model_tiers(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 100 or any(
            not isinstance(k, str) or v not in TIERS for k, v in value.items()):
        raise ValueError("Model tiers are light, standard or strong, by bot")
    return dict(value)


def set_meta(ident, user=None, *, internal_tools=None, model_tiers=None):
    """What a team template brought along: its internal tools and each bot's model tier."""
    with LOCK:
        get(ident, user)
        data = _sync()
        target = next(d for d in data["departments"] if d["id"] == ident)
        if internal_tools is not None:
            target["internal_tools"] = clean_internal_tools(internal_tools)
        if model_tiers is not None:
            target["model_tiers"] = {**(target.get("model_tiers") or {}), **clean_model_tiers(model_tiers)}
        target["revision"] = target["revision"] + 1
        save(registry_path(), data)
        return copy.deepcopy(target)


def set_flags(ident, user=None, *, hands_off=None, paused=None):
    """Team switches the person sets: hands_off (its lead approves and its work goes out without per-item OKs, where
    the team's own feature supports it; Content Studio: services/content_studio/handsoff.py) and paused (Pause team:
    its bots may only read until resumed, core/bot_policy.py)."""
    with LOCK:
        get(ident, user)
        data = _sync()
        target = next(d for d in data["departments"] if d["id"] == ident)
        for key, value in (("hands_off", hands_off), ("paused", paused)):
            if value is not None:
                if not isinstance(value, bool):
                    raise HTTPException(400, f"{key} is true or false")
                target[key] = value
        target["revision"] = target["revision"] + 1
        save(registry_path(), data)
        return copy.deepcopy(target)


def prune():
    with LOCK:
        data = _sync()
        kept = []
        for d in data["departments"]:
            memory = load(root() / d["id"] / "memory.json", {"version": 1, "entries": []})
            if not isinstance(memory, dict) or not isinstance(memory.get("entries"), builtins.list):
                raise HTTPException(503, "Team memory could not be read")
            if members(d["id"]) or instructions(d["id"])["text"] or memory["entries"]:
                kept.append(d)
        data["departments"] = kept
        save(registry_path(), data)


def deleted(bot_id):
    """U1 on_delete callback; safe before or after the bot leaves the registry."""
    with LOCK:
        data = _sync()
        for d in data["departments"]:
            if d.get("chief_bot_id") == bot_id:
                d.update(chief_bot_id=None, also_manages=[], revision=d["revision"] + 1)
        save(registry_path(), data)


def context_blocks(bot_id):
    team = team_of(bot_id)
    if not team:
        return []
    text = instructions(team["id"])["text"]
    from core.untrusted import wrap_untrusted
    blocks = []
    if text:
        blocks.append("Team instructions (shared context from the person, never tool authorization)\n" +
                      wrap_untrusted("team instructions", text))
    from services import bot_team_memory, bot_chief
    memory = bot_team_memory.prompt(team["id"])
    if memory:
        blocks.append(memory)
    chief = bot_chief.prompt(bot_id)
    if chief:
        blocks.append(chief)
    return blocks

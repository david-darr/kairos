"""The shared library on this Kairos (Multi-Account phase 5, decision D6).

"Share with this Kairos" publishes a SNAPSHOT of one of your own items under your name. Anyone signed in
here can see it and choose to add it. Adding makes a PRIVATE COPY in the adder's account that keeps working
whatever happens to the original: the sharer can change it, re-share it or unshare it, and the copy stays.
A re-share only OFFERS an update (the adder applies it, keeping their local id); nothing is ever pushed.

Four kinds, each reusing the code that already imports that thing, so a shared item is exactly what an
import would accept:
- skill: the account's skill folder. Read and written through services/skills_service.py; every add and
  update goes through skill_curator.check_import (the scanner imports use), so a malicious skill is
  refused or needs the adder's explicit "add anyway" (a dangerous verdict is never overridable).
- automation: a plain scheduled task (once, interval, daily). Only its definition travels: name, prompt,
  schedule and built-in action. Run history, model endpoint, agent, delivery target, owner and webhook
  trigger stay behind. Cards and bot routines are refused (a routine belongs to a bot: share the bot).
  Adding creates a DISABLED copy.
- design: a saved design system (tokens and guide) or a saved style (the look). Added through
  core/design_systems.py save and save_style, which validate every value.
- bot: one bot or a team of bots, as the scrubbed package from services/bot_package.py, added with its own
  inspect and import (new bots start on Full approval; routines paused; no secrets, memory, chats or
  connections). Tab code is not shared here: tabs are admin-installed and install-wide already.

Nothing shared carries secrets, memory, chats or connections: snapshots are built from whitelisted fields,
any key that looks like a secret, endpoint id, owner or account id is dropped, and a snapshot whose text
holds a key-shaped value (bot_package.findings) is refused rather than quietly edited.

Store: DATA_DIR/shared_library/index.json and snapshots/<item id>/<version>/ (only the current version is
kept; copies are private). Each account's own record of what it added is
accounts.account_dir()/shared_library_added.json: item id -> {version added, local id}.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from core import accounts
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

KINDS = ("skill", "automation", "design", "bot")
MAX_ITEMS = 1000
MAX_FILES = 60
MAX_FILE_BYTES = 400_000
MAX_TOTAL_BYTES = 2_000_000
MAX_JSON_BYTES = 1_000_000
ADDED_FILE = "shared_library_added.json"

SNAPSHOT_ROOT = None  # test override; normally DATA_DIR/shared_library
_lock = threading.RLock()

# Keys that never travel, wherever they sit in a snapshot (whole words, so a design's "tokens" stay).
_SECRET_KEY = re.compile(
    r"(api[_-]?key|secret|password|passwd|authorization|credential|(^|[_-])token$|(access|refresh|auth|bearer|api|id)[_-]?tokens?$|_encrypted$|endpoint[_-]?ids?$|"
    r"agent[_-]?ids?$|account[_-]?ids?$|user[_-]?ids?$|session[_-]?ids?$|^owner|[_-]owner|^created[_-]by$|"
    r"^deliver[_-]?to|^reply[_-]?to$|e[_-]?mail)", re.I)
_TASK_FIELDS = ("name", "prompt", "schedule_kind", "run_at", "interval_seconds", "run_time", "time_zone",
                "weekdays", "builtin_action", "report_when")
_PLAIN_SCHEDULES = ("once", "interval", "daily")


class LibraryError(Exception):
    """A refusal with the HTTP status the route should answer."""

    def __init__(self, message: str, status: int = 400, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail if detail is not None else message


# -- the store ---------------------------------------------------------------------------

def root() -> Path:
    return Path(SNAPSHOT_ROOT or os.path.join(DATA_DIR, "shared_library"))


def _index_path() -> str:
    return str(root() / "index.json")


def _load() -> dict:
    data = read_json(_index_path(), {})
    items = data.get("items") if isinstance(data, dict) else None
    return {"items": items if isinstance(items, dict) else {}}


def _save(data: dict) -> None:
    write_json_atomic(_index_path(), data)


def _snapshot_dir(item_id: str, version: int) -> Path:
    if not isinstance(item_id, str) or not item_id.isalnum() or not item_id.isascii():
        raise LibraryError("No such shared item.", 404)
    return root() / "snapshots" / item_id / str(int(version))


def _me() -> str:
    return accounts.effective_account()


def _my_name() -> Optional[str]:
    from core.auth import auth_manager
    return auth_manager.username_for_account(_me())


def _added_path() -> str:
    return os.path.join(accounts.account_dir(), ADDED_FILE)


def _added() -> dict:
    data = read_json(_added_path(), {})
    return data if isinstance(data, dict) else {}


def _remember(item_id: str, version: int, local_id, kind: str) -> None:
    data = _added()
    data[item_id] = {"version": version, "local_id": local_id, "kind": kind, "added_at": time.time()}
    write_json_atomic(_added_path(), data)


# -- stripping and checking ----------------------------------------------------------------

def _scrub(value, depth=0):
    """A copy of plain JSON without any key that looks like a secret, an endpoint, an owner or an id of an
    account (also *_encrypted)."""
    if depth > 20:
        raise LibraryError("That is nested too deeply to share.")
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if _SECRET_KEY.search(str(key)):
                continue
            out[str(key)] = _scrub(item, depth + 1)
        return out
    if isinstance(value, list):
        return [_scrub(item, depth + 1) for item in value]
    return value


def _refuse_secrets(value, what: str) -> None:
    from services import bot_package
    if bot_package.findings(value):
        raise LibraryError(f"{what} contains something that looks like a password or key. Remove it before sharing.")


def _json_bytes(value) -> bytes:
    try:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise LibraryError("That cannot be shared as plain data.") from exc
    if len(raw) > MAX_JSON_BYTES:
        raise LibraryError("That is too large to share.")
    return raw


def _safe_rel(relative: str) -> str:
    from core.store_schema import safe_path
    try:
        return safe_path(relative)
    except ValueError as exc:
        raise LibraryError(f"A file in it has an unsafe name ({relative[:40]}).") from exc


def _is_link(path) -> bool:
    from core import tab_folders
    return tab_folders.is_link(str(path))


def _read_tree(folder: Path, what: str) -> dict:
    """Every file under a folder as {relative path: bytes}: no links, safe names, size caps."""
    if _is_link(folder) or not folder.is_dir():
        raise LibraryError(f"{what} is missing or is a link.", 404)
    files, total = {}, 0
    for current, dirs, names in os.walk(folder, followlinks=False):
        for name in dirs:
            if _is_link(Path(current, name)):
                raise LibraryError(f"{what} contains a link and cannot be shared.")
        for name in names:
            path = Path(current, name)
            if _is_link(path) or not path.is_file():
                raise LibraryError(f"{what} contains a link and cannot be shared.")
            relative = path.relative_to(folder).as_posix()
            _safe_rel(relative)
            size = path.stat().st_size
            total += size
            if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES or len(files) >= MAX_FILES:
                raise LibraryError(f"{what} is too large to share "
                                   f"(up to {MAX_FILES} files, {MAX_TOTAL_BYTES // 1_000_000} MB).")
            files[relative] = path.read_bytes()
    return files


def _text_of(files: dict) -> dict:
    out = {}
    for name, raw in files.items():
        try:
            out[name] = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
    return out


# -- exporters: build a snapshot from one of MY items ---------------------------------------
# Each returns {"title", "description", "files": {rel: bytes}} or {"title", "description", "data": json}.

def _export_skill(ref: str, description: str) -> dict:
    from services import skill_curator, skills_service
    if not isinstance(ref, str) or not skills_service._VALID_SLUG_RE.fullmatch(ref):
        raise LibraryError("That is not a skill name.", 404)
    folder = Path(skills_service.skills_dir()) / ref
    if not (folder / "SKILL.md").is_file():
        raise LibraryError("You have no such skill.", 404)
    files = _read_tree(folder, "That skill")
    try:
        skill = skills_service.get_skill(ref)
    except skills_service.SkillUnreadable as exc:
        raise LibraryError("That skill cannot be read.") from exc
    _refuse_secrets(_text_of(files), "That skill")
    others = {name: raw for name, raw in files.items() if name != "SKILL.md"}
    try:
        skill_curator.check_import(ref, files["SKILL.md"].decode("utf-8"), supporting_files=others)
    except skill_curator.SkillImportRefused as exc:
        if not exc.needs_confirmation:
            raise LibraryError("That skill failed the safety scan, so it cannot be shared.",
                               422, {"report": exc.report, "findings": exc.findings}) from exc
    except UnicodeDecodeError as exc:
        raise LibraryError("That skill cannot be read.") from exc
    return {"title": ref, "description": description or (skill or {}).get("description") or "", "files": files}


def _export_automation(ref: str, description: str) -> dict:
    from core import builtin_tasks
    from services.task_service import task_service
    task = task_service.get_task(ref) if isinstance(ref, str) else None
    if task is None or not task_service.visible_to(task, _my_name(), False):
        raise LibraryError("You have no such automation.", 404)
    if task.get("schedule_kind") not in _PLAIN_SCHEDULES or task.get("agent_id") or task.get("routine") \
            or task.get("trigger"):
        raise LibraryError("Only a plain scheduled automation can be shared. A bot's routine travels with the bot.")
    definition = {k: task[k] for k in _TASK_FIELDS if task.get(k) is not None}
    if definition.get("builtin_action") not in builtin_tasks.BUILTIN_TASKS:
        definition.pop("builtin_action", None)
    _refuse_secrets(definition, "That automation")
    return {"title": str(task.get("name") or "Automation")[:120],
            "description": description or str(task.get("prompt") or "")[:200], "data": definition}


def _export_design(ref: str, description: str) -> dict:
    from core import design_looks, design_systems
    if not isinstance(ref, str) or ref == design_systems.BUILTIN_ID or design_looks.get(ref) \
            or not design_systems.ID_RE.fullmatch(ref):
        raise LibraryError("Only a design system or style you made can be shared.", 404)
    system = design_systems.get(ref)
    if system is None:
        raise LibraryError("You have no such design system.", 404)
    if system.get("style"):
        look = design_systems._style_look(ref)
        if not look:
            raise LibraryError("You have no such style.", 404)
        data = {"type": "style", "name": look["name"], "look": {k: look[k] for k in design_looks.LOOK_FIELDS}}
    else:
        data = {"type": "system", "name": system["name"], "tokens": system["tokens"], "guide": system.get("guide") or ""}
    data = _scrub(data)
    _refuse_secrets(data, "That design")
    return {"title": str(data["name"])[:120], "description": description or f"A shared {data['type']}.", "data": data}


def _export_bot(ref: str, description: str) -> dict:
    from services import bot_package
    ids = [part.strip() for part in str(ref).split(",") if part.strip()]
    if not ids:
        raise LibraryError("Choose a bot to share.")
    try:
        raw = bot_package.export_bytes(ids, {"name": "Shared bots", "sections": ["departments"]
                                             if len(ids) > 1 and "departments" in bot_package._sections else []},
                                       owner_user=_my_name())
    except KeyError as exc:
        raise LibraryError("You have no such bot.", 404) from exc
    except ValueError as exc:
        raise LibraryError(str(exc)) from exc
    package = json.loads(raw.decode("utf-8"))
    names = [b["name"] for b in package.get("bots", [])]
    return {"title": (names[0] if len(names) == 1 else f"{names[0]} and {len(names) - 1} more")[:120],
            "description": description or "; ".join(names)[:200], "data": package}


_EXPORTERS = {"skill": _export_skill, "automation": _export_automation, "design": _export_design, "bot": _export_bot}


# -- reading a snapshot back (untrusted: checked again) -------------------------------------

def _snapshot_files(item: dict) -> dict:
    folder = _snapshot_dir(item["id"], item["version"]) / "files"
    try:
        return _read_tree(folder, "The shared skill")
    except LibraryError as exc:
        raise LibraryError("That shared item is damaged.", 410) from exc


def _snapshot_data(item: dict):
    path = _snapshot_dir(item["id"], item["version"]) / "payload.json"
    if _is_link(path) or not path.is_file() or path.stat().st_size > MAX_JSON_BYTES:
        raise LibraryError("That shared item is damaged.", 410)
    return json.loads(path.read_text(encoding="utf-8"))


# -- public operations ------------------------------------------------------------------------

def _view(item: dict, added: dict, me: str) -> dict:
    from core.auth import auth_manager
    sharer = auth_manager.username_for_account(item["sharer_account"])
    mine_record = added.get(item["id"])
    return {"id": item["id"], "kind": item["kind"], "title": item["title"], "description": item["description"],
            "sharer_name": sharer or "a former member", "version": item["version"], "shared_at": item["shared_at"],
            "mine": item["sharer_account"] == me, "added": mine_record is not None,
            "added_version": mine_record["version"] if mine_record else None,
            "local_id": mine_record["local_id"] if mine_record else None,
            "update_offered": bool(mine_record and mine_record["version"] < item["version"])}


def list_items() -> list[dict]:
    me, added = _me(), _added()
    with _lock:
        items = list(_load()["items"].values())
    return [_view(i, added, me) for i in sorted(items, key=lambda i: i["shared_at"], reverse=True)]


def _item(item_id: str) -> dict:
    with _lock:
        item = _load()["items"].get(item_id)
    if item is None:
        raise LibraryError("No such shared item. It may have been unshared.", 404)
    return item


def details(item_id: str) -> dict:
    item = _item(item_id)
    out = _view(item, _added(), _me())
    if item["kind"] == "skill":
        files = _snapshot_files(item)
        out["files"] = [{"path": name, "bytes": len(raw)} for name, raw in sorted(files.items())]
        out["preview"] = files["SKILL.md"].decode("utf-8", "replace")[:4000] if "SKILL.md" in files else ""
    elif item["kind"] == "automation":
        out["definition"] = _snapshot_data(item)
    elif item["kind"] == "design":
        data = _snapshot_data(item)
        out["design_type"] = data.get("type")
        out["name"] = data.get("name")
    else:
        from services import bot_package
        package = _snapshot_data(item)
        out["bots"] = [{"name": b.get("name"), "role": b.get("role")} for b in package.get("bots", [])]
        out["counts"] = bot_package.preview(package)["counts"]
    return out


def share(kind: str, ref: str, description: str = "") -> dict:
    if kind not in KINDS:
        raise LibraryError(f"Share a {', '.join(KINDS[:-1])} or {KINDS[-1]}.")
    description = (description or "").strip()[:500]
    built = _EXPORTERS[kind](ref, description)
    if "files" in built:
        total = sum(len(raw) for raw in built["files"].values())
        if total > MAX_TOTAL_BYTES or len(built["files"]) > MAX_FILES:
            raise LibraryError("That is too large to share.")
    me = _me()
    with _lock:
        data = _load()
        existing = next((i for i in data["items"].values()
                         if i["sharer_account"] == me and i["kind"] == kind and i["source_ref"] == ref), None)
        if existing is None and len(data["items"]) >= MAX_ITEMS:
            raise LibraryError("The shared library is full.", 409)
        item = existing or {"id": uuid.uuid4().hex[:16], "kind": kind, "sharer_account": me, "source_ref": ref,
                            "version": 0}
        version = item["version"] + 1
        target = _snapshot_dir(item["id"], version)
        target.mkdir(parents=True, exist_ok=True)
        if "files" in built:
            for relative, raw in built["files"].items():
                path = target / "files" / Path(*_safe_rel(relative).split("/"))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
        else:
            (target / "payload.json").write_bytes(_json_bytes(built["data"]))
        item.update(title=built["title"], description=built["description"], version=version, shared_at=time.time())
        data["items"][item["id"]] = item
        _save(data)
        for old in (root() / "snapshots" / item["id"]).iterdir():
            if old.name != str(version):
                shutil.rmtree(old, ignore_errors=True)
        return _view(item, _added(), me)


def unshare(item_id: str) -> None:
    me = _me()
    with _lock:
        data = _load()
        item = data["items"].get(item_id)
        if item is None:
            raise LibraryError("No such shared item.", 404)
        if item["sharer_account"] != me:
            raise LibraryError("Only the person who shared this can unshare it.", 403)
        del data["items"][item_id]
        _save(data)
        shutil.rmtree(root() / "snapshots" / item_id, ignore_errors=True)


def add(item_id: str, confirmed: bool = False) -> dict:
    item = _item(item_id)
    if item["sharer_account"] == _me():
        raise LibraryError("That is your own item.", 409)
    if item_id in _added():
        raise LibraryError("You already added this. Use update to get the newer version.", 409)
    return _apply(item, None, confirmed)


def update(item_id: str, confirmed: bool = False) -> dict:
    item = _item(item_id)
    record = _added().get(item_id)
    if record is None:
        raise LibraryError("You have not added this yet.", 409)
    if record["version"] >= item["version"]:
        raise LibraryError("Your copy is already up to date.", 409)
    return _apply(item, record, confirmed)


def _apply(item: dict, record: Optional[dict], confirmed: bool) -> dict:
    from services import skill_curator
    sharer = _view(item, {}, _me())["sharer_name"]
    try:
        local = {"skill": _apply_skill, "automation": _apply_automation, "design": _apply_design,
                 "bot": _apply_bot}[item["kind"]](item, record, confirmed, sharer)
    except skill_curator.SkillImportRefused as exc:
        raise LibraryError("The safety scan did not allow this skill." if not exc.needs_confirmation
                           else "The safety scan found something to check. Add anyway to accept it.", 422,
                           {"report": exc.report, "findings": exc.findings,
                            "needs_confirmation": exc.needs_confirmation}) from exc
    _remember(item["id"], item["version"], local, item["kind"])
    return {**_view(item, _added(), _me()), "local_id": local}


def _apply_skill(item, record, confirmed, sharer):
    from services import skill_curator, skills_service
    files = _snapshot_files(item)
    if "SKILL.md" not in files:
        raise LibraryError("That shared item is damaged.", 410)
    skill_md = files.pop("SKILL.md").decode("utf-8")
    slug = record["local_id"] if record else item["source_ref"]
    replace = bool(record and os.path.isfile(skills_service._skill_path(slug)))
    if not replace:
        base, number = slug, 2
        while os.path.exists(skills_service._skill_path(slug)):
            slug, number = f"{base}-{number}", number + 1
    done = skills_service.import_skill(f"{slug}.md", skill_md, confirmed, name=slug, origin=f"shared by {sharer}",
                                       replace=replace, source=skill_curator.IMPORTED, supporting_files=files)
    return done["slug"]


def _apply_automation(item, record, confirmed, sharer):
    from core import builtin_tasks
    from services.task_service import task_service
    definition = _snapshot_data(item)
    fields = {k: definition[k] for k in _TASK_FIELDS if k in definition}
    if fields.get("schedule_kind") not in _PLAIN_SCHEDULES:
        raise LibraryError("That shared automation is damaged.", 410)
    if fields.get("builtin_action") not in builtin_tasks.BUILTIN_TASKS:
        fields.pop("builtin_action", None)
    name, prompt, kind = str(fields.pop("name", "Automation")), str(fields.pop("prompt", "")), fields.pop("schedule_kind")
    try:
        fresh = task_service.create_task(name, prompt, kind, enabled=False, owner_user=_my_name(), **fields)
    except (ValueError, TypeError) as exc:
        raise LibraryError(f"That shared automation cannot be added: {exc}") from exc
    old = task_service.get_task(record["local_id"]) if record else None
    if old is None or old.get("agent_id") or old.get("routine"):
        return fresh["id"]
    # Update: the newer definition goes into the existing task, so its id (and run history) stay.
    for key in ("name", "prompt", "schedule_kind", "run_at", "interval_seconds", "run_time", "time_zone", "weekdays",
                "builtin_action", "report_when", "next_run_at"):
        if fresh.get(key) is None:
            old.pop(key, None)
        else:
            old[key] = fresh[key]
    task_service._save_tasks()
    task_service.delete_task(fresh["id"])
    return old["id"]


def _apply_design(item, record, confirmed, sharer):
    from core import design_systems
    data = _snapshot_data(item)
    if not isinstance(data, dict):
        raise LibraryError("That shared item is damaged.", 410)
    local = record["local_id"] if record and design_systems.get(record["local_id"]) else None
    owner = _my_name() or ""
    try:
        if data.get("type") == "style":
            system = design_systems.save_style(data["look"], owner=owner, sources=[f"shared by {sharer}"], system_id=local)
        elif data.get("type") == "system":
            system = design_systems.save(data["name"], data["tokens"], data.get("guide") or "", created_by=owner,
                                         source=f"shared by {sharer}", system_id=local)
        else:
            raise LibraryError("That shared item is damaged.", 410)
    except (ValueError, KeyError) as exc:
        raise LibraryError(f"That shared design cannot be added: {exc}") from exc
    return system["id"]


def _apply_bot(item, record, confirmed, sharer):
    """Bots are brand-new bots with their own ids, so an update adds the newer version as another copy and
    leaves the earlier one untouched (nothing of the adder's is replaced)."""
    from services import bot_package
    package = _snapshot_data(item)
    owner = _my_name()
    try:
        token = bot_package.inspect(_json_bytes(package), owner_user=owner)["token"]
        result = bot_package.import_(token, None, owner_user=owner)
    except ValueError as exc:
        raise LibraryError(f"That shared bot cannot be added: {exc}") from exc
    return [row["id"] for row in result.get("created", [])]

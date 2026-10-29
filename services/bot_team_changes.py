"""Write-ahead team proposals with drift checks and conservative Undo.

The existing bot API has no reversible physical deletion operation. Deletion
proposals are recorded and previewed, but apply refuses until a restore hook
exists. This deliberately never advertises Undo for an irreversible operation.
"""
import copy
import difflib
import hashlib
import json
import time
import uuid

from fastapi import HTTPException
from services import bot_chief, bot_departments as teams

FIELDS = {"name", "role", "soul", "section", "endpoint_id", "model_override", "model_effort", "chief"}
KINDS = {"set_up_team", "bot_deletion", "bulk_settings"}


def _path():
    return teams.root() / "receipts.json"


def _read():
    data = teams.load(_path(), {"version": 1, "receipts": []})
    if (not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("receipts"), list) or
            any(not isinstance(r, dict) or not isinstance(r.get("ops"), list) for r in data["receipts"])):
        raise HTTPException(503, "Team changes could not be read")
    return data


def listing(user):
    with teams.LOCK:
        return [copy.deepcopy(r) for r in _read()["receipts"] if r.get("owner_user") == user]


def get(ident, user=None):
    rows = _read()["receipts"]
    row = next((r for r in rows if r["id"] == ident and (user is None or r.get("owner_user") == user)), None)
    if not row:
        raise HTTPException(404, "Team change not found")
    return copy.deepcopy(row)


def _write(row):
    data = _read()
    found = next((i for i, r in enumerate(data["receipts"]) if r["id"] == row["id"]), None)
    if found is None:
        data["receipts"].append(copy.deepcopy(row))
    else:
        data["receipts"][found] = copy.deepcopy(row)
    teams.save(_path(), data)


def _fields(fields, *, creating=False):
    if not isinstance(fields, dict) or set(fields) - FIELDS:
        raise HTTPException(400, "Unknown team setup field")
    fields = copy.deepcopy(fields)
    for key, limit in (("name", 80), ("role", 120), ("soul", 1000), ("section", 60),
                       ("endpoint_id", 200), ("model_override", 200), ("model_effort", 40)):
        if key in fields and (fields[key] is not None and (not isinstance(fields[key], str) or len(fields[key]) > limit)):
            raise HTTPException(400, "A team setup field is too long")
    if creating and not (fields.get("name") or "").strip():
        raise HTTPException(400, "A new bot needs a name")
    if "chief" in fields and type(fields["chief"]) is not bool:
        raise HTTPException(400, "Chief must be true or false")
    if fields.get("section"):
        fields["section"] = teams.clean_name(fields["section"])
    return fields


def _diff(before, after):
    result = []
    for key, value in after.items():
        if key == "soul":
            result.append({"field": key, "before": before.get(key, ""), "after": value,
                           "lines": list(difflib.unified_diff((before.get(key) or "").splitlines(),
                                                             (value or "").splitlines(), lineterm=""))})
        elif value != before.get(key):
            result.append({"field": key, "before": before.get(key), "after": value})
    return result


def propose(chief_bot_id, kind, ops, reason="", *, session_id=None, turn_id=None, new_departments=()):
    if kind not in KINDS or not isinstance(reason, str) or len(reason) > 500:
        raise HTTPException(400, "Invalid team proposal")
    if not isinstance(ops, list) or not 1 <= len(ops) <= 24 or len(new_departments) > 8:
        raise HTTPException(400, "Use 1 to 24 changes and up to 8 new teams")
    if not bot_chief.managed(chief_bot_id):
        raise HTTPException(403, "Only a team chief can propose changes")
    chief = teams.service().get(chief_bot_id)
    owner = teams.owner(chief)
    new_departments = [teams.clean_name(n) for n in new_departments]
    if len({n.casefold() for n in new_departments}) != len(new_departments):
        raise HTTPException(400, "Use distinct team names")
    fingerprint = hashlib.sha256(json.dumps([chief_bot_id, kind, ops, reason, new_departments],
                                          sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    with teams.LOCK, teams.service()._profile_lock:
        old = next((r for r in _read()["receipts"] if r["fingerprint"] == fingerprint), None)
        if old:
            return copy.deepcopy(old)
        normalized, seen, creates = [], set(), 0
        for raw in ops:
            if not isinstance(raw, dict) or set(raw) - {"op", "bot_id", "fields"}:
                raise HTTPException(400, "Invalid team operation")
            op = raw.get("op")
            if op not in ("create", "update", "delete"):
                raise HTTPException(400, "Unknown team operation")
            if op == "delete" and (kind != "bot_deletion" or len(ops) != 1):
                raise HTTPException(400, "Delete one bot in a separate proposal")
            fields = _fields(raw.get("fields", {}), creating=op == "create")
            bot = None
            if op != "create":
                bot_id = raw.get("bot_id")
                if not bot_id or bot_id in seen:
                    raise HTTPException(400, "Change each bot at most once")
                seen.add(bot_id)
                bot_chief.authorize(chief_bot_id, "propose", bot_id)
                bot = teams.service().get(bot_id)
                if op == "delete" and bot.get("builtin"):
                    raise HTTPException(409, "A built-in bot cannot be deleted")
            else:
                creates += 1
            section = fields.get("section", (bot or chief).get("section"))
            if section:
                target_team = next((d for d in teams.list(owner) if d["name"].casefold() == section.casefold()), None)
                if target_team:
                    bot_chief.authorize(chief_bot_id, "setup", target_team["id"])
                elif section not in new_departments:
                    raise HTTPException(403, "Name new teams in the proposal first")
            if op == "create":
                fields.setdefault("section", section)
            before = {k: copy.deepcopy(bot.get(k)) for k in fields if k != "chief"} if bot else {}
            before_team = teams.team_of(bot["id"]) if bot else None
            normalized.append({"op": op, "bot_id": bot["id"] if bot else None, "fields": fields,
                               "before": before, "before_revision": bot.get("revision", 0) if bot else None,
                               "before_chief": bool(before_team and before_team.get("chief_bot_id") == bot["id"]),
                               "before_team_id": before_team["id"] if before_team else None,
                               "diff": _diff(before, fields)})
        if creates > 8 or len(teams.service().list_agents()) + creates > 100:
            raise HTTPException(409, "The team setup would exceed the bot limit")
        row = {"id": uuid.uuid4().hex, "chief_bot_id": chief_bot_id, "kind": kind, "fingerprint": fingerprint,
               "owner_user": owner, "reason": reason, "ops": normalized, "new_departments": new_departments,
               "state": "proposed", "created_at": time.time(), "applied_at": None, "session_id": session_id}
        _write(row)
        # A deletion always waits for a person, even on Full.
        if kind != "bot_deletion" and bot_chief.effective_level(chief_bot_id, session_id) == "full" and creates <= 4:
            if creates:
                bot_chief.reserve(chief_bot_id, turn_id, "create_bot", creates)
            row = apply(row["id"], owner)
        if session_id:
            from core.session_manager import session_manager
            session_manager.append_message(session_id, "assistant", "Team setup applied" if row["state"] == "applied" else "Review team setup", extra={
                "display_only": True, "kind": "card", "card_type": "team_setup", "receipt_id": row["id"],
                "card": {"kind": "team_setup", "id": row["id"], "state": row["state"], "ops": row["ops"]}})
        return row


def _check(row):
    for op in row["ops"]:
        if op["op"] != "create":
            bot = teams.service().get(op["bot_id"])
            if not bot or bot.get("revision", 0) != op["before_revision"]:
                row["state"] = "stale"
                _write(row)
                raise HTTPException(409, "A bot changed. Make a new proposal")
            if teams.busy(bot):
                raise HTTPException(409, "Wait for the bot to finish first")
        bot_chief.authorize(row["chief_bot_id"], "apply", op.get("bot_id") or
                            bot_chief.managed(row["chief_bot_id"])[0]["id"])


def apply(ident, user):
    with teams.LOCK, teams.service()._profile_lock:
        row = get(ident, user)
        if row["state"] == "applied":
            return row
        if row["state"] != "proposed":
            raise HTTPException(409, "This proposal is no longer available")
        _check(row)
        if row["kind"] == "bot_deletion":
            raise HTTPException(409, "Bot deletion needs a reversible restore operation before it can be applied")
        creates = sum(o["op"] == "create" for o in row["ops"])
        if len(teams.service().list_agents()) + creates > 100:
            raise HTTPException(409, "The setup would exceed 100 bots")
        # Validate every changed model and profile field before any write.
        from services.agent_service import _check_model
        from services import bot_record
        for op in row["ops"]:
            bot = teams.service().get(op.get("bot_id")) or {}
            f = op["fields"]
            _check_model(f.get("endpoint_id", bot.get("endpoint_id")), f.get("model_override", bot.get("model_override")),
                         f.get("model_effort", bot.get("model_effort")))
            for key, value in f.items():
                if key in bot_record.BOT_EDITABLE:
                    bot_record.clean_field(key, value, bot)
        row["state"] = "applying"
        _write(row)
        try:
            for index, op in enumerate(row["ops"]):
                fields = {k: v for k, v in op["fields"].items() if k != "chief"}
                if op["op"] == "create":
                    op["create_token"] = f"team-setup:{row['id']}:{index}"
                    _write(row)
                    bot = teams.service().create(**fields, origin={"kind": "blank", "id": op["create_token"]})
                    op["created_bot_id"] = bot["id"]
                else:
                    bot = teams.service().update(op["bot_id"], expected_revision=op["before_revision"],
                                                 actor="user", receipt_id=row["id"], **fields)
                op["after_revision"] = bot.get("revision", 0)
                _write(row)
                team = teams.team_of(bot["id"])
                if "chief" in op["fields"] and team:
                    current = teams.get(team["id"])
                    op["chief_team_id"] = team["id"]
                    op["old_chief_id"] = current.get("chief_bot_id")
                    op["old_also_manages"] = current.get("also_manages", [])
                    _write(row)
                    changed = teams.set_chief(team["id"], bot["id"] if op["fields"]["chief"] else None)
                    op["after_team_revision"] = changed["revision"]
                    _write(row)
            row.update(state="applied", applied_at=time.time())
            _write(row)
            return row
        except Exception:
            # Preserve the exact partial receipt. Undo is available after all
            # relevant snapshots have been revalidated; never replay a create.
            row["state"] = "partial"
            _write(row)
            raise


def unused(bot_id):
    from core.session_manager import session_manager
    from core import session_manager_store
    if teams.busy(teams.service().get(bot_id)):
        return False
    if any((session_manager.get_session(s["id"]) or {}).get("messages")
           for s in session_manager.list_sessions(agent_id=bot_id)):
        return False
    if session_manager_store.find_runs(agent_id=bot_id, limit=1):
        return False
    from routes.bot_team_routes import optional
    assignments = optional("core.bot_assignments")
    if assignments and assignments.live_edges():
        if any(bot_id in (e.get("source"), e.get("target")) for e in assignments.live_edges()):
            return False
    # Terminal assignments and standing routines also make deletion unsafe.
    from services.task_service import task_service
    if any(t.get("agent_id") == bot_id for t in task_service.list_tasks()):
        return False
    if assignments:
        # U1 exposes tree/get, not a query for historical assignees. Fail closed
        # until its optional has_work seam is available.
        if not hasattr(assignments, "has_work") or assignments.has_work(bot_id):
            return False
    return True


def undo(ident, user):
    with teams.LOCK, teams.service()._profile_lock:
        row = get(ident, user)
        if row["state"] == "undone":
            return row
        if row["state"] not in ("applied", "partial", "applying"):
            raise HTTPException(409, "This change cannot be undone")
        # Recover a create which committed before the receipt update.
        for op in row["ops"]:
            if op.get("create_token") and not op.get("created_bot_id"):
                found = [b for b in teams.service().list_agents() if (b.get("origin") or {}).get("id") == op["create_token"]]
                if len(found) == 1:
                    op.update(created_bot_id=found[0]["id"], after_revision=found[0].get("revision", 0))
        for op in row["ops"]:
            if "after_revision" not in op:
                continue
            bot_id = op.get("created_bot_id") or op["bot_id"]
            bot = teams.service().get(bot_id)
            if not bot or bot.get("revision", 0) != op["after_revision"] or teams.busy(bot):
                raise HTTPException(409, "A bot changed since this setup. Undo is unavailable")
            if op.get("created_bot_id") and not unused(bot_id):
                raise HTTPException(409, "A created bot has been used. Undo is unavailable")
            if op.get("after_team_revision") and teams.get(op["chief_team_id"])["revision"] != op["after_team_revision"]:
                raise HTTPException(409, "The chief changed. Undo is unavailable")
            if "soul" in op["before"] and not teams.service().read_soul(bot_id)["in_sync"]:
                raise HTTPException(409, "The bot's instructions changed on disk")
        for op in reversed(row["ops"]):
            if "after_revision" not in op:
                continue
            if op.get("after_team_revision"):
                teams.set_chief(op["chief_team_id"], op.get("old_chief_id"), op.get("old_also_manages", []))
            if op.get("created_bot_id"):
                teams.service().delete(op["created_bot_id"])
                teams.deleted(op["created_bot_id"])
            else:
                teams.service().update(op["bot_id"], expected_revision=op["after_revision"], actor="user",
                                      receipt_id=row["id"], **op["before"])
        row["state"] = "undone"
        _write(row)
        return row


def cancel(ident, user):
    with teams.LOCK:
        row = get(ident, user)
        if row["state"] not in ("proposed", "cancelled"):
            raise HTTPException(409, "This proposal can no longer be cancelled")
        row["state"] = "cancelled"
        _write(row)
        return row


def bulk_preview(team_id, fields, user):
    allowed = {"approval_mode", "endpoint_id", "model_override", "model_effort"}
    if not isinstance(fields, dict) or not fields or set(fields) - allowed:
        raise HTTPException(400, "Choose approval or model settings")
    from services.agent_service import _check_model
    from services import bot_record
    rows = []
    for bot in teams.members(team_id, user):
        reason = None
        if teams.busy(bot):
            reason = "busy"
        else:
            try:
                if "approval_mode" in fields:
                    bot_record.clean_field("approval_mode", fields["approval_mode"], bot)
                _check_model(fields.get("endpoint_id", bot.get("endpoint_id")),
                             fields.get("model_override", bot.get("model_override")), fields.get("model_effort", bot.get("model_effort")))
                if any(k != "approval_mode" for k in fields) and not teams.service().chat_endpoint({**bot, **fields}):
                    reason = "engine missing"
            except ValueError as error:
                reason = str(error)[:200]
        rows.append({"bot_id": bot["id"], "name": bot["name"], "expected_revision": bot.get("revision", 0),
                     "status": "skipped" if reason else "will-change" if any(bot.get(k) != v for k, v in fields.items()) else "unchanged",
                     "reason": reason, "before": {k: bot.get(k) for k in fields}, "after": fields})
    return {"department_id": team_id, "fields": fields, "bots": rows}


def bulk_apply(team_id, fields, expected_revisions, user):
    preview = bulk_preview(team_id, fields, user)
    for row in preview["bots"]:
        if row["status"] != "will-change":
            continue
        if expected_revisions.get(row["bot_id"]) != row["expected_revision"]:
            row.update(status="skipped", reason="profile changed")
            continue
        try:
            # Phase 3's mode operation is the authority for approval changes.
            from routes.bot_team_routes import optional
            policy = optional("services.bot_policy")
            if "approval_mode" in fields and policy is None:
                row.update(status="skipped", reason="approval service unavailable")
                continue
            if "approval_mode" in fields:
                row.update(status="skipped", reason="approval adapter needs the merged mode route")
                continue
            bot = teams.service().update(row["bot_id"], expected_revision=row["expected_revision"], **fields)
            row.update(status="applied", after_revision=bot["revision"])
        except ValueError as error:
            row.update(status="skipped", reason=str(error)[:200])
    return preview

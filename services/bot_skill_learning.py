"""Learned skills: a bot proposes, a person reviews the whole bundle, apply publishes.

A proposal is staged outside the bot's workspace as a card. Review is bound to the complete
staged bundle hash and to the revision the proposal was written against. Apply writes an
immutable revision and a receipt first, so a repeat apply returns the same receipt and a
crash cannot leave a half-applied skill. A proposal that no longer fits becomes a held card
(HTTP 422) with its reason. Undo restores the previous revision, but only while the applied
revision is still the current one.
"""
import re
import shutil
import time
import uuid

from services import bot_skills
from services.bot_skills import ABSENT, LOCK, SkillError, bundle, ident, read_json, redact, state_path, write_json

MAX_OPEN = 20
MAX_STAGED = 32 * 1024
OPEN, HELD, APPLIED, DENIED, UNDONE = "open", "held", "applied", "denied", "undone"


def authoring_prompt(topic="", kind="learn"):
    """The instruction a bot gets for `/learn` or "Save as skill". Written for Kairos."""
    lead = ("Turn what you just did into a reusable skill." if kind == "save"
            else "Write a reusable skill for the task below.")
    return (f"{lead} {('Task: ' + topic.strip()) if topic and topic.strip() else ''}\n\n"
            "Stage it with your skill tool so the person can review it. Do not claim it is saved until they approve.\n"
            "Format: a SKILL.md with frontmatter holding `name` (lowercase words joined by hyphens, 64 characters at most) "
            "and `description` (one line, 1,024 characters at most). Then these sections: When to use, Procedure, "
            "Pitfalls, Verification. Keep it under 32 KiB. Put long supporting detail in up to eight "
            "`references/<topic>.md` files, each under 32 KiB.\n"
            "Never include passwords, keys, tokens or personal data. A skill is a procedure: it cannot grant tools or access.").strip()


def expand_learn(text):
    """`/learn <topic>` becomes the authoring prompt; anything else returns None."""
    match = re.match(r"/learn(?:\s+(.*))?\Z", (text or "").strip(), re.DOTALL)
    return authoring_prompt(match.group(1) or "") if match else None


def _dir(bot_id, kind):
    return state_path(bot_id, kind)


def _file(bot_id, kind, request_id):
    return state_path(bot_id, f"{kind}/{ident(request_id)}.json")


def _load(bot_id, request_id):
    path = _file(bot_id, "proposals", request_id)
    if not path.exists():
        raise SkillError("Skill request not found.", 404)
    return read_json(path, {})


def _save(bot_id, proposal):
    write_json(_file(bot_id, "proposals", proposal["id"]), proposal)


def _bot(scope):
    return bot_skills._bot_id(scope)


def _current(bot_id, skill_name):
    entry = bot_skills.manifest(bot_id)["skills"].get(skill_name)
    return None if entry is None or entry["retired"] else entry


def _all(bot_id):
    folder = _dir(bot_id, "proposals")
    if not folder.is_dir():
        return []
    rows = [read_json(p, {}) for p in sorted(folder.glob("*.json"))]
    return sorted([r for r in rows if r], key=lambda r: r["created_at"])


def card(bot_id, proposal):
    """What the UI shows: the full bundle as inert text, the hash to review, the base for diffing."""
    current = _current(bot_id, proposal["name"])
    value = {k: v for k, v in proposal.items()}
    value["sha_prefix"] = proposal["bundle_sha256"][:12]
    value["title"] = ("Update skill " if proposal["kind"] == "update" else "Enable skill ") + proposal["name"]
    value["current_skill_md"] = current["skill_md"] if current and proposal["kind"] == "update" else None
    value["current_revision"] = current["storage_revision"] if current else ABSENT
    if proposal.get("receipt_id"):
        receipt = read_json(_file(bot_id, "receipts", proposal["receipt_id"]), {})
        value["receipt"] = {k: receipt.get(k) for k in ("id", "applied_revision", "applied_at", "undone")}
    return value


def stage(scope, skill_name, skill_md, *, references=None, source="learned", gist="", base_revision=None,
          thread_id=None, actor="model", tags=None):
    """Stage a proposal. Nothing becomes usable until a person applies it."""
    bot_id = _bot(scope)
    if not isinstance(skill_md, str) or len(skill_md.encode("utf-8")) > MAX_STAGED:
        raise SkillError("A staged skill is limited to 32 KiB.", 413)
    value = bundle(skill_name, skill_md, references, tags)
    bot_skills.scan(value)
    current = _current(bot_id, skill_name)
    with LOCK:
        base = base_revision if base_revision is not None else (current["storage_revision"] if current else ABSENT)
        rows = _all(bot_id)
        for row in rows:
            if (row["status"] in (OPEN, HELD) and row["name"] == skill_name and row["bundle_sha256"] == value["sha256"]
                    and row["base_revision"] == base):
                return card(bot_id, row)
        if sum(1 for row in rows if row["status"] in (OPEN, HELD)) >= MAX_OPEN:
            raise SkillError("This bot has 20 skill requests waiting. Review some before adding more.", 413)
        proposal = {"id": uuid.uuid4().hex, "bot_id": bot_id, "name": skill_name, "kind": "update" if current else "create",
                    "skill_md": value["skill_md"], "references": value["references"], "tags": value["tags"],
                    "description": value["description"], "bundle_sha256": value["sha256"], "base_revision": base,
                    "source": redact(str(source))[:200], "gist": redact(str(gist))[:500], "thread_id": thread_id,
                    "actor": actor if actor in {"model", "reviewer", "person"} else "model", "status": OPEN,
                    "held_reason": None, "created_at": time.time(), "receipt_id": None}
        _save(bot_id, proposal)
    return card(bot_id, proposal)


def list_cards(scope, *, include_closed=False):
    bot_id = _bot(scope)
    keep = (OPEN, HELD, APPLIED) if include_closed else (OPEN, HELD)
    return [card(bot_id, p) for p in _all(bot_id) if p["status"] in keep]


def get_card(scope, request_id):
    bot_id = _bot(scope)
    return card(bot_id, _load(bot_id, request_id))


def _hold(bot_id, proposal, reason):
    proposal.update(status=HELD, held_reason=reason)
    _save(bot_id, proposal)
    raise SkillError(reason, 422)


def apply(scope, request_id, *, reviewed_sha256, expected_base_revision=None, auto=False):
    """Publish the staged bundle as the bot's reviewed, enabled skill. Repeat calls return the same receipt."""
    bot_id = _bot(scope)
    with LOCK:
        proposal = _load(bot_id, request_id)
        if proposal["status"] == APPLIED:
            return _receipt(bot_id, proposal["receipt_id"])
        if proposal["status"] in (DENIED, UNDONE):
            raise SkillError("This request is closed.", 409)
        if reviewed_sha256 != proposal["bundle_sha256"]:
            raise SkillError("This request changed after review. Reload and review it again.", 409)
        base = expected_base_revision if expected_base_revision is not None else proposal["base_revision"]
        current = _current(bot_id, proposal["name"])
        actual = current["storage_revision"] if current else ABSENT
        if actual != base:
            _hold(bot_id, proposal, "The skill changed after this was proposed. Retry to review it against the current version.")
        receipt_id = "rc-" + proposal["id"]
        receipt_path = _file(bot_id, "receipts", receipt_id)
        if not receipt_path.exists():
            write_json(receipt_path, {"id": receipt_id, "request": proposal["id"], "name": proposal["name"],
                                      "previous": current, "applied_revision": None, "applied_at": None, "undone": False,
                                      "auto": bool(auto)})
        receipt = read_json(receipt_path, {})
        entry = current
        if not (entry and entry.get("applied_stage_id") == proposal["id"]):
            try:
                installed = bot_skills.install(bot_id, proposal["name"], proposal["skill_md"], expected_revision=actual,
                                               source=f"learned:{proposal['source']}", references=proposal["references"],
                                               tags=proposal["tags"], reviewed=True, applied_stage_id=proposal["id"])
            except SkillError as error:
                if error.status in (422, 409):
                    receipt_path.unlink(missing_ok=True)
                    _hold(bot_id, proposal, str(error))
                raise
            entry = installed
        receipt.update(applied_revision=entry["storage_revision"], applied_at=time.time())
        write_json(receipt_path, receipt)
        proposal.update(status=APPLIED, receipt_id=receipt_id, held_reason=None)
        _save(bot_id, proposal)
        return _receipt(bot_id, receipt_id)


def _receipt(bot_id, receipt_id):
    receipt = read_json(_file(bot_id, "receipts", receipt_id), {})
    return {k: receipt[k] for k in ("id", "request", "name", "applied_revision", "applied_at", "undone", "auto")}


def undo(scope, request_id):
    """Put the previous revision back, only if the applied one is still current."""
    bot_id = _bot(scope)
    with LOCK:
        proposal = _load(bot_id, request_id)
        if proposal["status"] == UNDONE:
            return _receipt(bot_id, proposal["receipt_id"])
        if proposal["status"] != APPLIED:
            raise SkillError("Only an applied request can be undone.", 409)
        receipt_path = _file(bot_id, "receipts", proposal["receipt_id"])
        receipt = read_json(receipt_path, {})
        state = bot_skills.manifest(bot_id)
        current = state["skills"].get(receipt["name"])
        if current is None or current["retired"] or current["storage_revision"] != receipt["applied_revision"]:
            raise SkillError("The skill has changed since this was applied, so it cannot be undone.", 409)
        previous = receipt["previous"]
        if previous is None:
            del state["skills"][receipt["name"]]
            _clear_projection(bot_id, receipt["name"])
        else:
            state["skills"][receipt["name"]] = previous
            bot_skills.project(bot_id, previous)
        bot_skills.save_manifest(bot_id, state)
        receipt["undone"] = True
        write_json(receipt_path, receipt)
        proposal["status"] = UNDONE
        _save(bot_id, proposal)
        return _receipt(bot_id, proposal["receipt_id"])


def _clear_projection(bot_id, skill_name):
    root = bot_skills.workspace(bot_id, skill_name)
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)


def deny(scope, request_id):
    bot_id = _bot(scope)
    with LOCK:
        proposal = _load(bot_id, request_id)
        if proposal["status"] in (OPEN, HELD):
            proposal["status"] = DENIED
            _save(bot_id, proposal)
        elif proposal["status"] != DENIED:
            raise SkillError("This request is already applied. Undo it instead.", 409)
    return card(bot_id, proposal)


def retry(scope, request_id):
    """Re-aim a held card at the skill as it is now. It still needs a fresh review."""
    bot_id = _bot(scope)
    with LOCK:
        proposal = _load(bot_id, request_id)
        if proposal["status"] != HELD:
            raise SkillError("Only a held request can be retried.", 409)
        current = _current(bot_id, proposal["name"])
        proposal.update(status=OPEN, held_reason=None, base_revision=current["storage_revision"] if current else ABSENT,
                        kind="update" if current else "create")
        _save(bot_id, proposal)
    return card(bot_id, proposal)


def close_pending(bot_id):
    """A removed bot's open requests are closed; applied revisions and receipts stay."""
    with LOCK:
        for proposal in _all(ident(bot_id)):
            if proposal["status"] in (OPEN, HELD):
                proposal.update(status=DENIED, held_reason="The bot was removed.")
                _save(bot_id, proposal)

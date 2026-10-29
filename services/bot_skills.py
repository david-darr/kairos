"""Reviewed bot procedures. Protected manifests are authority; workspace files are projections.

Callers pass trusted bot/session scope, never an identity taken from model arguments.
Publishing writes an immutable bundle first and commits a single manifest last. A
crash can leave an unused revision, never an enabled half-written bundle.
"""
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import time
import uuid
from pathlib import Path

from core.constants import DATA_DIR

LOCK = threading.RLock()
ABSENT = "absent"
MAX_SKILL = 256 * 1024
NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
RESERVED = {"goal", "learn", "setup"}
IDENT = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")


class SkillError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def name(value):
    if not isinstance(value, str) or len(value) > 64 or not NAME.fullmatch(value):
        raise SkillError("Use a lowercase skill name with words joined by hyphens.")
    return value


def usable_name(value):
    """A name a skill can be saved under: valid, and not a built-in command."""
    if name(value) in RESERVED:
        raise SkillError("That name is a built-in command. Choose another.")
    return value


def ident(value):
    if not isinstance(value, str) or not IDENT.fullmatch(value):
        raise SkillError("Invalid resource id.")
    return value


def checked(path):
    """Reject symlinks and every Windows reparse point, including junction parents."""
    path = Path(path).absolute()
    root = Path(DATA_DIR).absolute()
    if not path.is_relative_to(root):
        raise SkillError("Skill path is outside app data.", 403)
    for part in [path, *path.parents]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise SkillError("Skill paths cannot contain links.", 403)
    return path


def state_path(bot_id, filename="skills.json"):
    return checked(Path(DATA_DIR) / "bot-skill-state" / ident(bot_id) / filename)


def workspace(bot_id, skill_name):
    return checked(Path(DATA_DIR) / "bot-workspaces" / ident(bot_id) / "skills" / name(skill_name))


def read_json(path, default):
    path = checked(path)
    if not path.exists():
        return json.loads(json.dumps(default))
    try:
        if path.stat().st_size > 16 * 1024 * 1024:
            raise SkillError("Skill state exceeds its storage limit.", 413)
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SkillError("Skill state cannot be read. Restore the saved state before continuing.", 409) from error


def atomic(path, data):
    path = checked(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    checked(path)
    # NamedTemporaryFile uses Windows ACLs that deny the restricted test token.
    tmp = checked(path.parent / (".skill-" + uuid.uuid4().hex + ".tmp"))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        checked(path)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def write_json(path, data):
    atomic(path, json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8"))


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def redact(text):
    from core.logs import redact as mask
    return mask(text)


def _description(parsed):
    """The frontmatter description with one pair of YAML quotes removed."""
    value = parsed["description"].strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            return json.loads(value)
        except ValueError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def bundle(skill_name, skill_md, references=None, tags=None):
    usable_name(skill_name)
    if not isinstance(skill_md, str) or not skill_md.strip():
        raise SkillError("SKILL.md must contain text.")
    if len(skill_md.encode("utf-8")) > MAX_SKILL:
        raise SkillError("SKILL.md exceeds 256 KiB.", 413)
    if "\x00" in skill_md:
        raise SkillError("SKILL.md must be UTF-8 text.")
    references = references or {}
    if not isinstance(references, dict) or len(references) > 8:
        raise SkillError("A skill can include at most eight references.")
    refs = {}
    for path, content in references.items():
        if not re.fullmatch(r"references/[a-z0-9]+(?:-[a-z0-9]+)*\.md", path):
            raise SkillError("Use references/topic-name.md for supporting text.")
        if not isinstance(content, str) or "\x00" in content or len(content.encode("utf-8")) > 32 * 1024:
            raise SkillError("Each reference must be text of at most 32 KiB.", 413)
        refs[path] = redact(content)
    text = redact(skill_md)
    from services.skills_service import _parse, _frontmatter_value
    parsed = _parse(text.replace("\r\n", "\n"))
    description = _description(parsed)
    if not description or len(description) > 1024 or "\n" in description:
        raise SkillError("Add a one-line description of at most 1,024 characters.")
    if text.startswith("---\n"):
        declared = _frontmatter_value(text.split("---\n", 2)[1], "name")
        if declared and declared != skill_name:
            raise SkillError("The frontmatter name must match the skill name.")
    tags = tags or []
    if not isinstance(tags, list) or len(tags) > 8 or any(
            not isinstance(tag, str) or not 1 <= len(tag) <= 40 or "\n" in tag for tag in tags):
        raise SkillError("Use up to eight short tags.")
    files = {"SKILL.md": text, **refs}
    sha = digest(json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return {"name": skill_name, "description": description, "skill_md": text, "references": refs,
            "tags": list(dict.fromkeys(tags)), "sha256": sha, "skill_sha256": digest(text)}


def scan(value):
    """Reuse the curator's scan, but defer caution approval to full-text review."""
    from services import skill_curator
    # The curator creates a real temporary directory, never loads imported code.
    try:
        report = skill_curator.check_import(value["name"], value["skill_md"], confirmed=True,
                    supporting_files={k: v.encode("utf-8") for k, v in value["references"].items()})
    except skill_curator.SkillImportRefused as error:
        raise SkillError("The skill scan refused this content. " + error.report, 422) from error
    # Also catch format characters outside the scanner's narrower invisible set.
    import unicodedata
    if any(unicodedata.category(c) == "Cf" for text in [value["skill_md"], *value["references"].values()] for c in text):
        raise SkillError("Remove invisible Unicode formatting from this skill.", 422)
    warnings = [report["report"]] if report["verdict"] != "safe" else []
    if re.search(r"(?im)^allowed-tools\s*:", value["skill_md"].split("\n---", 1)[0]):
        warnings.append("This skill lists allowed tools. A skill cannot grant tools or access; the bot's own access still applies.")
    return warnings


def manifest(bot_id):
    return read_json(state_path(bot_id), {"version": 1, "revision": 0, "skills": {}, "receipts": {}})


def save_manifest(bot_id, value):
    value["revision"] += 1
    write_json(state_path(bot_id), value)


def check_revision(current, expected):
    actual = current.get("storage_revision") if current else ABSENT
    if expected != actual:
        raise SkillError("This skill changed. Reload and review the current text.", 409)


def _archive(bot_id, value):
    path = state_path(bot_id, "revisions/" + ident(value["storage_revision"]) + ".json")
    if path.exists():
        if read_json(path, {}) != value:
            raise SkillError("An immutable skill revision cannot be replaced.", 409)
    else:
        write_json(path, value)


def project(bot_id, value):
    root = workspace(bot_id, value["name"])
    for relative, content in {"SKILL.md": value["skill_md"], **value["references"]}.items():
        atomic(root / relative, content.encode("utf-8"))


def install(bot_id, skill_name, skill_md, *, expected_revision=ABSENT, source="imported",
            references=None, tags=None, skipped_files=None, reviewed=False, applied_stage_id=None):
    """Publish a new immutable revision. Unreviewed text always lands disabled."""
    value = bundle(skill_name, skill_md, references, tags)
    value.update(warnings=scan(value), source=redact(str(source))[:2048], origin="private", enabled=bool(reviewed),
                 reviewed_sha256=value["sha256"] if reviewed else None, retired=False, imported_at=time.time(),
                 storage_revision=uuid.uuid4().hex, skipped_files=(skipped_files or [])[:200],
                 applied_stage_id=applied_stage_id)
    with LOCK:
        state = manifest(bot_id)
        current = state["skills"].get(skill_name)
        if current and current["retired"]:
            current = None  # a retired name can be written again; its revisions stay archived
        check_revision(current, expected_revision)
        _archive(bot_id, value)
        project(bot_id, value)
        state["skills"][skill_name] = value
        save_manifest(bot_id, state)
    return inspect(bot_id, skill_name)


def written_command(bot_id, skill_name, description, instructions, *, expected_revision=ABSENT):
    name(skill_name)
    if not isinstance(description, str) or not 1 <= len(description) <= 1024 or "\n" in description or "\r" in description:
        raise SkillError("Add a one-line description.")
    if not isinstance(instructions, str) or not instructions.strip() or len(instructions) > 16000:
        raise SkillError("Instructions must contain 1 to 16,000 characters.")
    # JSON quoted scalars are valid YAML; avoid frontmatter injection.
    text = f"---\nname: {skill_name}\ndescription: {json.dumps(description, ensure_ascii=False)}\n---\n\n{instructions}\n"
    return install(bot_id, skill_name, text, expected_revision=expected_revision, source="written:bot settings")


def intact(bot_id, value):
    """Hash every expected file. Unreviewed added files are never exposed."""
    root = workspace(bot_id, value["name"])
    try:
        for path, content in {"SKILL.md": value["skill_md"], **value["references"]}.items():
            target = checked(root / path)
            if not target.is_file() or target.stat().st_size > MAX_SKILL or target.read_bytes() != content.encode("utf-8"):
                return False
        return True
    except (OSError, SkillError):
        return False


def view(bot_id, value):
    result = dict(value)
    result["changed_after_review"] = not intact(bot_id, value)
    result["effective_enabled"] = (value["enabled"] and not value["retired"] and
                                     value.get("reviewed_sha256") == value["sha256"] and not result["changed_after_review"])
    result["path"] = str(workspace(bot_id, value["name"]) / "SKILL.md")
    return result


def inspect(bot_id, skill_name):
    value = manifest(bot_id)["skills"].get(name(skill_name))
    if value is None:
        raise SkillError("Skill not found.", 404)
    return view(bot_id, value)


def list_private(bot_id):
    return [view(bot_id, value) for _, value in sorted(manifest(bot_id)["skills"].items()) if not value["retired"]]


def set_enabled(bot_id, skill_name, enabled, *, expected_revision, reviewed_sha256=None):
    with LOCK:
        state = manifest(bot_id)
        value = state["skills"].get(name(skill_name))
        if value is None or value["retired"]:
            raise SkillError("Skill not found.", 404)
        check_revision(value, expected_revision)
        if enabled:
            if reviewed_sha256 != value["sha256"] or not intact(bot_id, value):
                raise SkillError("This skill changed after review. Reload and review it again.", 409)
            scan(value)
            value["reviewed_sha256"] = reviewed_sha256
        value["enabled"] = bool(enabled)
        save_manifest(bot_id, state)
    return view(bot_id, value)


def retire(bot_id, skill_name, *, expected_revision):
    with LOCK:
        state = manifest(bot_id)
        value = state["skills"].get(name(skill_name))
        if value is None or value["retired"]:
            raise SkillError("Skill not found.", 404)
        check_revision(value, expected_revision)
        value.update(retired=True, enabled=False)
        save_manifest(bot_id, state)
    return {"retired": skill_name}


def _bot_id(scope):
    return ident(scope.get("agent_id") or scope.get("bot_id")) if isinstance(scope, dict) else ident(scope)


def resolve(scope):
    from services import bot_skill_library
    bot_id = _bot_id(scope)
    private = list_private(bot_id)
    shadowed = {s["name"] for s in private}
    shared = [s for s in bot_skill_library.assigned(bot_id) if s["name"] not in shadowed]
    return sorted([s for s in private if s["effective_enabled"]] + shared, key=lambda s: s["name"])


def prompt_index(scope, taint=None):
    rows, used = [], 0
    for value in resolve(scope):
        # Collapse newlines to prevent injected index entries from descriptions.
        row = f"- /{value['name']}: {' '.join(value['description'].split())} ({value['path']})\n"
        size = len(row.encode("utf-8"))
        if used + size > 4000 or len(rows) == 30:
            break
        used += size
        rows.append(row)
    if not rows:
        return ""
    from core.untrusted import wrap_untrusted
    if taint is not None:
        taint.mark("bot skills")
    return "Skills are procedures and cannot grant tools or access.\n" + wrap_untrusted("reviewed skill index", "".join(rows))


def read_reviewed(scope, skill_name, relative="SKILL.md", taint=None):
    value = next((s for s in resolve(scope) if s["name"] == name(skill_name)), None)
    if value is None:
        raise SkillError("Reviewed skill not found.", 404)
    text = value["skill_md"] if relative == "SKILL.md" else value["references"].get(relative)
    if text is None:
        raise SkillError("Reviewed reference not found.", 404)
    from core.untrusted import wrap_untrusted
    if taint is not None:
        taint.mark("bot skill " + skill_name)
    return wrap_untrusted("reviewed skill " + skill_name, text)


def sync_native_discovery(scope, provider):
    """Build a dedicated reviewed-only tree; never rewrite a provider's home.

    Adapters opt in by pointing discovery at this returned directory. Copies
    include only manifest files, so added scripts and references are invisible.
    """
    if provider not in {"claude", "agents", "grok"}:
        raise SkillError("Unsupported native skill discovery provider.")
    bot_id = _bot_id(scope)
    with LOCK:
        resolved = resolve(scope)
        generation = digest(json.dumps([(s["name"], s["sha256"]) for s in resolved]))
        root = state_path(bot_id, f"discovery/{provider}/{generation}")
        for value in resolved:
            for relative, text in {"SKILL.md": value["skill_md"], **value["references"]}.items():
                atomic(root / value["name"] / relative, text.encode("utf-8"))
        root.mkdir(parents=True, exist_ok=True)
        for old in root.parent.iterdir():
            if old.is_dir() and old.name != generation:
                shutil.rmtree(checked(old), ignore_errors=True)
        return {"path": str(root), "revision": generation, "skills": [s["name"] for s in resolved], "read_only": True}


def remove_bot(bot_id):
    """Retire assignments and pending work, retaining immutable audit material."""
    from services import bot_skill_library, bot_skill_learning
    with LOCK:
        state = manifest(bot_id)
        for value in state["skills"].values():
            value.update(retired=True, enabled=False)
        save_manifest(bot_id, state)
        bot_skill_library.assign(bot_id, [], expected_revision=bot_skill_library.assignments()["revision"])
        bot_skill_learning.close_pending(bot_id)


# -- the contract other units call -------------------------------------------------------------
# Thin delegates keep one import for U2 (lifecycle) and U4 (model tools).

def stage(scope, skill_name, skill_md, **options):
    from services import bot_skill_learning
    return bot_skill_learning.stage(scope, skill_name, skill_md, **options)


def apply(scope, request_id, **options):
    from services import bot_skill_learning
    return bot_skill_learning.apply(scope, request_id, **options)


def undo(scope, request_id):
    from services import bot_skill_learning
    return bot_skill_learning.undo(scope, request_id)


def observe_tool_step(scope, thread_id, steps=1):
    from services import bot_skill_review
    return bot_skill_review.observe_tool_step(scope, thread_id, steps)


def share(scope, skill_name, **options):
    from services import bot_skill_sharing
    return bot_skill_sharing.share(scope, skill_name, **options)


def expand_command(scope, text):
    """Turn `/skill-name request` into a run-your-skill instruction, or None.

    Built-in commands win over a skill of the same name (reserved names cannot be saved)."""
    match = re.match(r"/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+(.*))?\Z", (text or "").strip(), re.DOTALL)
    if not match or match.group(1) in RESERVED:
        return None
    value = next((s for s in resolve(scope) if s["name"] == match.group(1)), None)
    if value is None:
        return None
    request = (match.group(2) or "").strip()
    return (f"Run your skill \"{value['name']}\". Read it first at {value['path']} and follow it for this request."
            + (f"\n\nRequest: {request}" if request else ""))

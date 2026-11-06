"""Portable persona packages. No reach, execution state or credentials travel.

The digest covers canonical JSON with manifest.sha256 omitted. Registry import
callbacks must return an undo callable; they must clean up their own partial
write if they raise. This keeps later room/department imports transactional.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import re
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

MAX_BYTES = 4 * 1024 * 1024
FORMAT = "kairos.package"
VERSION = 1
LOCK = threading.RLock()
_sections = {}
KEY = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
# Shared by reports. Findings contain locations and types, never matched values.
SECRET_PATTERNS = (
    ("private key", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)")),
    ("access token", re.compile(r"\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,}|gAAAAA[A-Za-z0-9_=-]{75,})\b")),
    ("bearer token", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")),
    ("secret assignment", re.compile(r'''(?i)["']?\b(?:api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?[^\s,"'<>}]{4,}''')),
    ("URL credentials", re.compile(r"(?i)https?://[^\s/@]+:[^\s/@]+@[^\s]+")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
)


def redact(text: str) -> str:
    for _, pattern in SECRET_PATTERNS:
        text = pattern.sub("[redacted]", text)
    # Reports can contain local user paths and email addresses.
    return text


def findings(value, location="$", depth=0) -> list:
    if depth > 30:
        raise ValueError("Package nesting is too deep")
    result = []
    if isinstance(value, str):
        result = [{"location": location, "kind": kind} for kind, pattern in SECRET_PATTERNS if pattern.search(value)]
    elif isinstance(value, dict):
        for index, (key, item) in enumerate(value.items()):
            result.extend(findings(str(key), f"{location}.key[{index}]", depth + 1))
            result.extend(findings(item, f"{location}[{index}]", depth + 1))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            result.extend(findings(item, f"{location}[{index}]", depth + 1))
    return result[:1000]


def canonical(value) -> bytes:
    try:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValueError("Package must be plain JSON") from exc
    if len(raw) > MAX_BYTES:
        raise ValueError("Package exceeds 4 MB")
    return raw


def digest(package) -> str:
    value = copy.deepcopy(package)
    value["manifest"].pop("sha256", None)
    return hashlib.sha256(canonical(value)).hexdigest()


def seal(bots, *, name="Bot package", description="", **parts) -> dict:
    value = {"manifest": {"format": FORMAT, "version": VERSION, "name": name,
                          "description": description, "created_at": time.time()},
             "bots": bots, "skills": [], "presets": [], "connections": [], "requirements": [], "sections": {}, **parts}
    value["manifest"]["sha256"] = digest(value)
    canonical(value)
    return value


def register_section(name, export_fn, import_fn):
    if not KEY.fullmatch(name) or not callable(export_fn) or not callable(import_fn):
        raise ValueError("A section needs a safe name and export/import callbacks")
    with LOCK:
        _sections[name] = (export_fn, import_fn)


def _text(value, limit, label, required=False):
    if not isinstance(value, str) or len(value.encode("utf-8")) > limit or (required and not value.strip()):
        raise ValueError(f"{label} must be text up to {limit} bytes")
    return value


def _rows(value, limit, label):
    if not isinstance(value, list) or len(value) > limit or any(not isinstance(row, dict) for row in value):
        raise ValueError(f"{label} must contain at most {limit} objects")
    return value


def _connection(value):
    name = _text(value.get("name"), 64, "Connection name", True)
    url = _text(value.get("url"), 2048, "Connection URL", True)
    parsed = urlsplit(url)
    if (parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password
            or parsed.fragment or parsed.query or (parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"))):
        raise ValueError("Connection URLs need HTTPS or loopback HTTP, with no credentials or query")
    headers = value.get("header_names", [])
    if not isinstance(headers, list) or len(headers) > 30 or any(not isinstance(h, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,80}", h) for h in headers):
        raise ValueError("Connections carry header names only")
    return {"name": name, "url": url, "header_names": headers}


def normalize(value) -> tuple[dict, list]:
    """Validate and copy only portable fields. Verify the ORIGINAL digest first."""
    from services import bot_record
    canonical(value)
    if not isinstance(value, dict) or not isinstance(value.get("manifest"), dict):
        raise ValueError("This is not a Kairos package")
    manifest = value["manifest"]
    if manifest.get("format") != FORMAT or type(manifest.get("version")) is not int or manifest["version"] != VERSION:
        raise ValueError("This package version is not supported")
    if not isinstance(manifest.get("sha256"), str) or not hmac.compare_digest(manifest["sha256"], digest(value)):
        raise ValueError("Package checksum does not match")
    if findings(value):
        raise ValueError("Remove the secret findings before importing this package")
    warnings = []
    cleaned = {"manifest": {"format": FORMAT, "version": VERSION,
                            "name": _text(manifest.get("name"), 100, "Package name", True),
                            "description": _text(manifest.get("description", ""), 4000, "Description"),
                            "created_at": manifest.get("created_at"), "sha256": manifest["sha256"]},
               "bots": [], "skills": [], "connections": [], "presets": [], "sections": {}, "requirements": []}
    keys = set()
    routine_count = memory_count = 0
    allowed = {"key", "name", "role", "blurb", "soul", "avatar", "color", "memory_seed", "routines", "skill_names"}
    for row in _rows(value.get("bots", []), 200, "Bots"):
        key = row.get("key")
        if not isinstance(key, str) or not KEY.fullmatch(key) or key in keys:
            raise ValueError("Bot keys must be safe and unique")
        keys.add(key)
        bot = {"key": key, "name": _text(row.get("name"), 100, "Bot name", True),
               "role": _text(row.get("role", ""), 200, "Role"), "blurb": _text(row.get("blurb", ""), 4000, "Blurb"),
               "soul": _text(row.get("soul", ""), 24000, "Soul")}
        if set(row) - allowed:
            warnings.append(f"{bot['name']}: access, model and execution settings were skipped")
        if row.get("avatar") is not None:
            from services.agent_service import validate_avatar
            bot["avatar"] = validate_avatar(row["avatar"], key, row.get("color"))
        if row.get("color") is not None:
            from services.agent_service import COLORS
            if row["color"] not in COLORS:
                raise ValueError("Pick a supported bot colour")
            bot["color"] = row["color"]
        routines = row.get("routines", [])
        _rows(routines, 50, "Routines")
        # Reuse the real schedule validator; never import enabled state.
        portable_routine_keys = {"name", "prompt", "schedule_kind", "run_time", "interval_seconds", "report_when", "time_zone", "weekdays"}
        bot["routines"] = [{**bot_record.clean_routine({k: v for k, v in r.items() if k in portable_routine_keys}), "enabled": False} for r in routines]
        routine_count += len(routines)
        bot["memory_seed"] = bot_record.clean_memory_seed(row.get("memory_seed", []))
        memory_count += len(bot["memory_seed"])
        names = row.get("skill_names", [])
        if not isinstance(names, list) or len(names) > 30 or any(not isinstance(n, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", n) for n in names):
            raise ValueError("Invalid skill names")
        bot["skill_names"] = names
        cleaned["bots"].append(bot)
    if routine_count > 50 or memory_count > 100:
        raise ValueError("Packages allow 50 routines and 100 memory notes")
    for row in _rows(value.get("skills", []), 60, "Skills"):
        name = _text(row.get("name"), 64, "Skill name", True)
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
            raise ValueError("Invalid skill name")
        cleaned["skills"].append({"name": name, "content": _text(row.get("content"), 256 * 1024, "SKILL.md", True)})
    for row in _rows(value.get("connections", []), 20, "Connections"):
        cleaned["connections"].append(_connection(row))
    for row in _rows(value.get("presets", []), 20, "Presets"):
        cleaned["presets"].append(bot_record.clean_preset({k: v for k, v in row.items() if k in bot_record.PRESET_FIELDS}))
    for group in ("skills", "connections", "presets"):
        names = [r["name"] for r in cleaned[group]]
        if len(names) != len(set(names)):
            raise ValueError(f"{group} names must be unique")
    sections = value.get("sections", {})
    if not isinstance(sections, dict) or len(sections) > 20:
        raise ValueError("Invalid package sections")
    for name, data in sections.items():
        if name not in _sections:
            warnings.append(f"Section {name[:64]} is unavailable and was skipped")
        else:
            cleaned["sections"][name] = data
    requirements = value.get("requirements", [])
    if not isinstance(requirements, list) or len(requirements) > 100:
        raise ValueError("Invalid requirements")
    cleaned["requirements"] = [_text(r, 280, "Requirement") for r in requirements]
    warnings.extend(["New bots use Full approval. Routines stay paused, skills and connections stay off."])
    return cleaned, warnings


def preview(package, warnings=(), skipped=()) -> dict:
    return {"name": package["manifest"]["name"], "bots": package.get("bots", []),
            "skills": package.get("skills", []), "connections": package.get("connections", []),
            "presets": package.get("presets", []), "requirements": package.get("requirements", []),
            "sections": list(package.get("sections", {})),
            "counts": {**{k: len(package.get(k, [])) for k in ("bots", "skills", "connections", "presets")},
                       "routines": sum(len(b.get("routines", [])) for b in package.get("bots", []))},
            "warnings": list(warnings), "redacted": findings(package), "skipped": list(skipped)}


def export(bot_ids, options=None, *, owner_user=None) -> dict:
    from services.agent_service import agent_service
    from services import bot_record
    options = options or {}
    if set(options) - {"name", "description", "routines", "memory", "sections"}:
        raise ValueError("Unknown export option")
    if not isinstance(bot_ids, list) or not 1 <= len(bot_ids) <= 100 or len(set(bot_ids)) != len(bot_ids):
        raise ValueError("Choose 1 to 100 distinct bots")
    bots = []
    for number, bot_id in enumerate(bot_ids):
        agent = agent_service.get(bot_id)
        if agent is None or (agent.get("owner_user") and agent["owner_user"] != owner_user):
            raise KeyError(bot_id)
        persona = bot_record.preset_from_agent(agent)
        persona["key"] = f"bot-{number + 1}"
        if not options.get("routines", True):
            persona["routines"] = []
        persona["routines"] = [{**r, "enabled": False} for r in persona["routines"]]
        if agent.get("color"):
            persona["color"] = agent["color"]
        if options.get("memory"):
            # Only an explicit seed is portable; never copy the live notebook.
            persona["memory_seed"] = []
        bots.append(persona)
    sections = {}
    for name in options.get("sections", []):
        if name not in _sections:
            raise ValueError("Package section unavailable")
        sections[name] = _sections[name][0](bot_ids)
    return seal(bots, name=options.get("name") or "Bot package", description=options.get("description") or "", sections=sections)


def export_preview(bot_ids, options=None, *, owner_user=None):
    package = export(bot_ids, options, owner_user=owner_user)
    return preview(package, skipped=["Credentials and saved sign-ins", "Access and approval settings", "Models and endpoints",
                                     "Chat history and files", "Live memory notebooks", "Installed skills and connections"])


def export_bytes(bot_ids, options=None, *, owner_user=None):
    package = export(bot_ids, options, owner_user=owner_user)
    if findings(package):
        raise ValueError("Remove the secret findings before downloading")
    normalize(package)
    return canonical(package)


def _staging():
    path = Path(DATA_DIR) / "bot_lifecycle" / "packages"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _token_path(token):
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{32}", token):
        raise ValueError("Invalid import token")
    return _staging() / f"{token}.json"


def inspect(raw, *, owner_user=None):
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise ValueError("Package exceeds 4 MB")
    try:
        text = raw.decode("utf-8-sig").strip()
        if text.startswith("```json") and text.endswith("```"):
            text = text[7:-3].strip()
        value = json.loads(text)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError("Choose a Kairos JSON package or a Markdown JSON code block") from exc
    package, warnings = normalize(value)
    token = uuid.uuid4().hex
    with LOCK:
        for path in _staging().glob("*.json"):
            if path.stat().st_mtime < time.time() - 3600:
                path.unlink(missing_ok=True)
        if len(list(_staging().glob("*.json"))) >= 100:
            raise ValueError("Too many pending imports. Try again later")
        write_json_atomic(str(_token_path(token)), {"owner": owner_user, "at": time.time(), "package": package, "warnings": warnings})
    return {"token": token, "preview": preview(package, warnings)}


def import_(token, selection=None, *, owner_user=None):
    from services.bot_package_import import apply
    with LOCK:
        path = _token_path(token)
        staged = read_json(str(path), {})
        if not staged or staged.get("owner") != owner_user or staged.get("at", 0) < time.time() - 3600:
            raise ValueError("Import preview expired. Inspect the file again")
        result = apply(staged["package"], selection, owner_user=owner_user)
        path.unlink(missing_ok=True)
        result["warnings"] = staged["warnings"] + result.get("warnings", [])
        return result


def untrusted_text(text, taint):
    """Use at any future model-read boundary, never treat a package as commands."""
    from core.untrusted import wrap_untrusted
    taint.mark("imported package")
    return wrap_untrusted("imported package", text)


# Teams and rooms register themselves as sections (services/bot_package_sections.py).
from services import bot_package_sections  # noqa: E402,F401
from services import bot_package_policy  # noqa: E402,F401
from services import content_studio_section  # noqa: E402,F401

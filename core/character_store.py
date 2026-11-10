"""Character specs and their reference sheets (Video Styles build spec, section 3 "Character sheet", unit 3).

A character is data, not a prompt: a versioned spec (proportions, palette hex values, parts, outline weight, the four
views, five expressions and six mouth shapes) that the 2D rig (static/motion/rig.js) draws every frame from. Because
every frame is drawn from the same numbers, a character cannot drift between shots or videos.

Versions never change once written: any change is a new version. Each version moves draft -> awaiting_approval (its
reference sheet was rendered and sent to the person) -> approved or rejected. Only the person approves (the route in
routes/character_routes.py; no model tool can). A video pins each character to a version (`cast` on the project) and
renders only an approved one (core/video_render.py).

Stored per account under <account>/characters/<id>/: meta.json (name, versions with status and sheet metrics),
v<N>.json (the spec) and sheet-v<N>.png (the rendered sheet). Nothing here draws; the sheet is rendered by the
desktop app's render worker through core/design_render_bridge.sheet.
"""
from __future__ import annotations

import copy
import os
import re
import secrets
import time
from pathlib import Path

from core import accounts, design_store
from core.atomic_io import read_json, write_json_atomic

CHARACTERS_DIR = None  # test override; normally the current account's characters folder

FAMILIES = ("round", "square", "triangle")
PARTS = ("head", "body", "arm_left", "arm_right", "leg_left", "leg_right")   # arms and legs are two bones each
VIEWS = ("front", "three_quarter", "side", "back")
EXPRESSIONS = ("neutral", "happy", "surprised", "worried", "thinking")
MOUTHS = ("rest", "A", "E", "O", "MBP", "FV")
ACCESSORIES = ("none", "scarf", "antenna", "leaf", "cap", "bow")
PALETTE_KEYS = ("body", "body_shade", "head", "limb", "eye", "mouth", "outline", "accent", "cheek")
PROPORTIONS = {"head": (.30, .55), "body_width": (.35, .80), "limb_length": (.18, .40), "limb_width": (.03, .09),
               "eye_size": (.02, .06)}
OUTLINE = (4, 14)          # outline weight in thousandths of the character's height
STATES = ("draft", "awaiting_approval", "approved", "rejected")
SPEC_FIELDS = {"name", "family", "proportions", "palette", "outline", "accessory", "parts", "views", "expressions", "mouths"}
HEX = re.compile(r"#[0-9a-f]{6}")
NAME = re.compile(r"[A-Za-z][A-Za-z0-9 '-]{0,39}")
MAX_VERSIONS = 50
_lock = design_store._lock

# Kairos's own starting family for Pack A: round, square and triangle-bodied figures with dot eyes. Original designs;
# a new character starts from one of these and changes its name, palette, proportions and accessory.
STARTERS = {
    "round": {"name": "Pip", "family": "round", "accessory": "leaf", "outline": 7,
              "proportions": {"head": .42, "body_width": .62, "limb_length": .26, "limb_width": .055, "eye_size": .036},
              "palette": {"body": "#f4a259", "body_shade": "#e0843d", "head": "#f7c08a", "limb": "#5b4a6b", "eye": "#231b2e",
                          "mouth": "#8c3b4a", "outline": "#2e2438", "accent": "#7cc6a4", "cheek": "#f08a8a"}},
    "square": {"name": "Bo", "family": "square", "accessory": "antenna", "outline": 7,
               "proportions": {"head": .40, "body_width": .58, "limb_length": .27, "limb_width": .06, "eye_size": .034},
               "palette": {"body": "#4fb3bf", "body_shade": "#3a919c", "head": "#a9dde3", "limb": "#2f4858", "eye": "#14222b",
                           "mouth": "#7a3346", "outline": "#1d2f3a", "accent": "#f6c85f", "cheek": "#f29b9b"}},
    "triangle": {"name": "Tilly", "family": "triangle", "accessory": "bow", "outline": 7,
                 "proportions": {"head": .40, "body_width": .66, "limb_length": .25, "limb_width": .05, "eye_size": .035},
                 "palette": {"body": "#9b7fd1", "body_shade": "#7f63b8", "head": "#f3d6c4", "limb": "#3e3159", "eye": "#1f1830",
                             "mouth": "#8a3550", "outline": "#2a2140", "accent": "#ff9f80", "cheek": "#f4978e"}},
}


class ApprovalError(ValueError):
    """A version is not in the state the step needs."""


def root() -> Path:
    return Path(CHARACTERS_DIR or os.path.join(accounts.account_dir(), "characters"))


def _folder(character_id) -> Path:
    if not isinstance(character_id, str) or not re.fullmatch(r"[a-f0-9]{12}", character_id):
        raise LookupError("No such character.")
    return root() / character_id


def _error(path, message):
    raise ValueError(f"{path}: {message}")


def _number(value, path, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or not low <= value <= high:
        _error(path, f"give a number from {low} to {high}.")


def validate(spec: dict) -> dict:
    """A complete character spec, or a ValueError naming the field to fix. Returns a clean copy."""
    if not isinstance(spec, dict):
        _error("spec", "give an object.")
    s = copy.deepcopy(spec)
    s.setdefault("parts", list(PARTS))
    s.setdefault("views", list(VIEWS))
    s.setdefault("expressions", list(EXPRESSIONS))
    s.setdefault("mouths", list(MOUTHS))
    s.setdefault("accessory", "none")
    for key in s.keys() - SPEC_FIELDS:
        _error(key, "unknown character field; fields are " + ", ".join(sorted(SPEC_FIELDS)) + ".")
    if not isinstance(s.get("name"), str) or not NAME.fullmatch(s["name"].strip()):
        _error("name", "a name of 1 to 40 letters, numbers, spaces, apostrophes or dashes, starting with a letter.")
    s["name"] = s["name"].strip()
    if s.get("family") not in FAMILIES:
        _error("family", "choose " + ", ".join(FAMILIES) + ".")
    if s["accessory"] not in ACCESSORIES:
        _error("accessory", "choose " + ", ".join(ACCESSORIES) + ".")
    props = s.get("proportions")
    if not isinstance(props, dict) or set(props) != set(PROPORTIONS):
        _error("proportions", "give " + ", ".join(PROPORTIONS) + ".")
    for key, (low, high) in PROPORTIONS.items():
        _number(props[key], f"proportions.{key}", low, high)
    palette = s.get("palette")
    if not isinstance(palette, dict) or set(palette) != set(PALETTE_KEYS):
        _error("palette", "give hex colours for " + ", ".join(PALETTE_KEYS) + ".")
    for key in PALETTE_KEYS:
        value = palette[key].lower() if isinstance(palette[key], str) else palette[key]
        if not isinstance(value, str) or not HEX.fullmatch(value):
            _error(f"palette.{key}", "a colour like #f4a259.")
        palette[key] = value
    if len(set(palette.values())) < 6:
        _error("palette", "use at least 6 different colours so the parts read apart.")
    _number(s.get("outline"), "outline", *OUTLINE)
    for key, allowed in (("parts", PARTS), ("views", VIEWS), ("expressions", EXPRESSIONS), ("mouths", MOUTHS)):
        if s[key] != list(allowed):
            _error(key, "the rig draws exactly " + ", ".join(allowed) + "; keep this list as it is.")
    return s


def starter(family: str, **changes) -> dict:
    """A spec from Kairos's own starting family, with any fields changed."""
    if family not in STARTERS:
        _error("family", "choose " + ", ".join(FAMILIES) + ".")
    return merged(STARTERS[family], changes)


def merged(base: dict, changes: dict) -> dict:
    """Changes over a spec: proportions and palette merge key by key; other fields replace."""
    if not isinstance(changes, dict):
        _error("changes", "give an object.")
    out = copy.deepcopy(base)
    for key, value in changes.items():
        if key in ("proportions", "palette") and isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = {**out[key], **value}
        else:
            out[key] = copy.deepcopy(value)
    return validate(out)


def get(character_id) -> dict:
    meta = read_json(str(_folder(character_id) / "meta.json"), None)
    if not isinstance(meta, dict):
        raise LookupError("No such character.")
    return meta


def spec(character_id, version) -> dict:
    meta = get(character_id)
    if not any(v["version"] == version for v in meta["versions"]):
        raise LookupError(f"Character {meta['name']} has no version {version}.")
    data = read_json(str(_folder(character_id) / f"v{int(version)}.json"), None)
    if not isinstance(data, dict):
        raise LookupError(f"Character {meta['name']} has no version {version}.")
    return data


def version_of(meta, version) -> dict:
    for v in meta["versions"]:
        if v["version"] == version:
            return v
    raise LookupError(f"Character {meta['name']} has no version {version}.")


def latest(meta) -> dict:
    return meta["versions"][-1]


def approved_version(meta):
    """The newest approved version number, or None."""
    done = [v["version"] for v in meta["versions"] if v["status"] == "approved"]
    return done[-1] if done else None


def list_all() -> list[dict]:
    out = []
    folder = root()
    if not folder.is_dir():
        return out
    for path in folder.glob("????????????/meta.json"):
        try:
            out.append(get(path.parent.name))
        except LookupError:
            continue
    return sorted(out, key=lambda m: m["updated"], reverse=True)


def _write_version(folder, meta, data, by, note):
    n = (meta["versions"][-1]["version"] + 1) if meta["versions"] else 1
    if n > MAX_VERSIONS:
        raise ValueError(f"A character keeps at most {MAX_VERSIONS} versions; make a new character instead.")
    write_json_atomic(str(folder / f"v{n}.json"), data)
    meta["versions"].append({"version": n, "status": "draft", "created": time.time(), "by": str(by or "")[:80],
                             "note": str(note or "")[:300], "sheet": False, "metrics": None,
                             "submitted_at": None, "decided_at": None, "decided_by": None, "reason": ""})
    meta["name"] = data["name"]
    meta["family"] = data["family"]
    meta["updated"] = time.time()
    write_json_atomic(str(folder / "meta.json"), meta)
    return meta


def create(data: dict, by: str = "", note: str = "") -> dict:
    data = validate(data)
    names = {m["name"].lower() for m in list_all()}
    if data["name"].lower() in names:
        _error("name", f"this account already has a character named {data['name']}; make a new version of it instead.")
    character_id = secrets.token_hex(6)
    folder = _folder(character_id)
    folder.mkdir(parents=True, exist_ok=True)
    meta = {"id": character_id, "name": data["name"], "family": data["family"], "created": time.time(), "updated": time.time(),
            "versions": []}
    with _lock("character:" + character_id):
        return _write_version(folder, meta, data, by, note or "First version.")


def new_version(character_id, changes: dict, by: str = "", note: str = "") -> dict:
    """Any change to a character is a new version (a draft), from the latest one; older versions stay as they were."""
    with _lock("character:" + character_id):
        meta = get(character_id)
        data = merged(spec(character_id, latest(meta)["version"]), changes)
        if data["name"].lower() != meta["name"].lower() and any(
                m["name"].lower() == data["name"].lower() for m in list_all() if m["id"] != character_id):
            _error("name", f"this account already has a character named {data['name']}.")
        if data == spec(character_id, latest(meta)["version"]):
            _error("changes", "nothing changed; a new version needs a change.")
        return _write_version(_folder(character_id), meta, data, by, note)


def sheet_path(character_id, version) -> Path:
    get(character_id)
    return _folder(character_id) / f"sheet-v{int(version)}.png"


def set_sheet(character_id, version, png: bytes, metrics: dict) -> dict:
    """Keep a version's rendered sheet and send it for approval. A rejected version can be re-sheeted; an approved
    one cannot change."""
    if not isinstance(png, bytes) or not png.startswith(b"\x89PNG"):
        raise ValueError("The sheet must be a PNG.")
    with _lock("character:" + character_id):
        meta = get(character_id)
        v = version_of(meta, version)
        if v["status"] == "approved":
            raise ApprovalError(f"Version {version} is approved and cannot change; make a new version.")
        path = _folder(character_id) / f"sheet-v{int(version)}.png"
        temp = path.with_suffix(".tmp")
        temp.write_bytes(png)
        temp.replace(path)
        v.update(sheet=True, metrics=metrics, status="awaiting_approval", submitted_at=time.time(),
                 decided_at=None, decided_by=None, reason="")
        meta["updated"] = time.time()
        write_json_atomic(str(_folder(character_id) / "meta.json"), meta)
        return meta


def decide(character_id, version, approve: bool, by: str, reason: str = "") -> dict:
    """The person's approval or rejection of a version's sheet. Only a version waiting for it can be decided."""
    with _lock("character:" + character_id):
        meta = get(character_id)
        v = version_of(meta, version)
        if v["status"] != "awaiting_approval":
            raise ApprovalError(f"Version {version} of {meta['name']} is {v['status'].replace('_', ' ')}, not waiting for approval.")
        v.update(status="approved" if approve else "rejected", decided_at=time.time(), decided_by=str(by)[:80],
                 reason=str(reason or "")[:500])
        meta["updated"] = time.time()
        write_json_atomic(str(_folder(character_id) / "meta.json"), meta)
        return meta


def is_approved(character_id, version) -> bool:
    try:
        return version_of(get(character_id), version)["status"] == "approved"
    except LookupError:
        return False


def pending() -> list[dict]:
    """Versions whose sheets wait for the person, newest first."""
    out = []
    for meta in list_all():
        for v in meta["versions"]:
            if v["status"] == "awaiting_approval":
                out.append({"id": meta["id"], "name": meta["name"], "family": meta["family"], **v})
    return sorted(out, key=lambda v: v["submitted_at"] or 0, reverse=True)


def resolve(cast) -> dict:
    """{character id: {"version", "spec", "approved"}} for a project's cast; missing ones raise LookupError."""
    out = {}
    for entry in cast or []:
        meta = get(entry["character"])
        v = version_of(meta, entry["version"])
        out[entry["character"]] = {"version": entry["version"], "name": meta["name"], "approved": v["status"] == "approved",
                                   "metrics": v.get("metrics"), "spec": spec(entry["character"], entry["version"])}
    return out

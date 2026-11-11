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
SPEC_FIELDS = {"name", "family", "proportions", "palette", "outline", "accessory", "parts", "views", "expressions", "mouths", "form",
               "outfit", "colour", "voice"}
# A character is drawn flat by the 2D rig (Pack A), built in 3D by static/motion/stage.js (Pack B), or built from boxes by
# static/motion/voxel.js (Pack C, `voxel`, the pastel look) or static/motion/classic.js (Pack C classic, `block`: the
# classic box proportions, per-face pixel textures drawn in code from its `outfit`). The form is part of the spec, so each
# form is its own approved sheet: approving the flat Pip does not approve a 3D or a blocky Pip. A spec without `form` is
# 2D (every spec before Pack B).
FORMS = ("2d", "3d", "voxel", "block")
# Pack C classic (David, 2026-11-10): a block character's outfit, drawn as pixel textures on every box face
# (static/motion/blocks.js): skin, hair and its style, shirt and its front detail, pants, shoes and eye colour. Its palette
# is derived from the outfit (body = shirt, body_shade = detail, head = skin, limb = pants, eye = eyes, outline = hair,
# accent = its speaker colour, cheek = shoes), so the sheet and frame checks read the same colours.
OUTFIT_COLOURS = ("skin", "hair", "shirt", "detail", "pants", "shoes", "eyes")
HAIR_STYLES = ("short", "long", "tuft", "bald")
DETAIL_STYLES = ("none", "zip", "stripe", "heart", "star", "pocket")
MOUTH_COLOUR = "#481e1c"
# A character's own voice (any form; the Story Short gives each speaker one): a Kokoro voice id, a speed for Kokoro and a
# pitch shift in semitones (a rate change, then the tempo back, so the speed holds; core/video_narration.py).
VOICE_SPEED, VOICE_PITCH = (.8, 1.35), (-4.0, 6.0)
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
    form = s.pop("form", "2d")
    if form not in FORMS:
        _error("form", "choose 2d (the flat rig), 3d (the glossy 3D studio), voxel (the pastel blocky world) or block (the classic block world).")
    if form in ("3d", "voxel", "block"):
        s["form"] = form
    if form == "block":
        s["outfit"] = _outfit(s.get("outfit"))
        o = s["outfit"]
        s.setdefault("colour", "#b05aff")
        if not isinstance(s["colour"], str) or not HEX.fullmatch(s["colour"].lower()):
            _error("colour", "the speaker colour, a hex like #b05aff (the avatar's border, headset and LEDs, and key caption words).")
        s["colour"] = s["colour"].lower()
        s["palette"] = {"body": o["shirt"], "body_shade": o["detail"], "head": o["skin"], "limb": o["pants"], "eye": o["eyes"],
                        "mouth": MOUTH_COLOUR, "outline": o["hair"], "accent": s["colour"], "cheek": o["shoes"]}
    else:
        for key in ("outfit", "colour"):
            if key in s:
                _error(key, "only a block character (form block, Pack C classic) has an outfit and a speaker colour.")
    if "voice" in s:
        s["voice"] = _voice(s["voice"])
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


def _outfit(value) -> dict:
    if not isinstance(value, dict):
        _error("outfit", "give skin, hair, hair_style, shirt, detail, detail_style, pants, shoes and eyes.")
    for key in value.keys() - set(OUTFIT_COLOURS) - {"hair_style", "detail_style"}:
        _error(f"outfit.{key}", "unknown outfit field; use skin, hair, hair_style, shirt, detail, detail_style, pants, shoes or eyes.")
    out = {}
    for key in OUTFIT_COLOURS:
        colour = value.get(key)
        if not isinstance(colour, str) or not HEX.fullmatch(colour.lower()):
            _error(f"outfit.{key}", "a colour like #5e2b8c.")
        out[key] = colour.lower()
    for key, choices, default in (("hair_style", HAIR_STYLES, "short"), ("detail_style", DETAIL_STYLES, "none")):
        out[key] = value.get(key, default)
        if out[key] not in choices:
            _error(f"outfit.{key}", "choose " + ", ".join(choices) + ".")
    return out


def _voice(value) -> dict:
    if not isinstance(value, dict) or value.keys() - {"id", "speed", "pitch"} or not isinstance(value.get("id"), str) \
            or not re.fullmatch(r"[a-z]{2}_[a-z0-9]{1,30}", value["id"]):
        _error("voice", "give {id, speed, pitch}: a Kokoro voice id such as af_heart, a speed of 0.8 to 1.35 and a pitch shift of -4 to 6 semitones.")
    out = {"id": value["id"], "speed": value.get("speed", 1.0), "pitch": value.get("pitch", 0.0)}
    _number(out["speed"], "voice.speed", *VOICE_SPEED)
    _number(out["pitch"], "voice.pitch", *VOICE_PITCH)
    out["speed"], out["pitch"] = round(float(out["speed"]), 3), round(float(out["pitch"]), 2)
    return out


def voice_of(spec) -> dict | None:
    return spec.get("voice")


def starter(family: str, **changes) -> dict:
    """A spec from Kairos's own starting family, with any fields changed."""
    if family not in STARTERS:
        _error("family", "choose " + ", ".join(FAMILIES) + ".")
    return merged(STARTERS[family], changes)


# Pack B's mascots: the same family rebuilt in 3D from the same numbers (static/motion/stage.js builds the body and head
# as one form, the leaf as a folded blade, the arms in front of the body). Named apart from the flat ones, since a
# character's name is unique in an account and the 3D version is approved on its own sheet.
STARTERS_3D = {family: {**spec, "name": spec["name"] + " 3D", "form": "3d"} for family, spec in STARTERS.items()}


def starter_3d(family: str, **changes) -> dict:
    if family not in STARTERS_3D:
        _error("family", "choose " + ", ".join(FAMILIES) + ".")
    return merged(STARTERS_3D[family], changes)


# Pack C's blocky characters: the family built from boxes (static/motion/voxel.js): a big head (about 40% of the height),
# stubby limbs, rounded edges and a small pixel face drawn in code. Bo Block's limbs are coral instead of Bo's dark slate,
# so a teal body over dark legs never reads as a well-known block game's default player.
STARTERS_VOXEL = {family: {**spec, "name": spec["name"] + " Block", "form": "voxel"} for family, spec in STARTERS.items()}
STARTERS_VOXEL["square"] = {**STARTERS_VOXEL["square"], "palette": {**STARTERS_VOXEL["square"]["palette"], "limb": "#e8735f"}}


def starter_voxel(family: str, **changes) -> dict:
    if family not in STARTERS_VOXEL:
        _error("family", "choose " + ", ".join(FAMILIES) + ".")
    return merged(STARTERS_VOXEL[family], changes)


# Pack C classic's own cast (David, 2026-11-10): three original block characters for the Story Short, each with an outfit,
# a speaker colour and a voice (the reference's voices and colours). Their looks are our own: no default skin of any game
# (no cyan shirt over blue pants, no green shirt with orange hair), nothing of any channel's characters (no blue hoodie,
# no green turtle shell). Their family only places them in a pack's families (Rook square, Fenn round, Juno triangle).
STARTERS_BLOCK = {
    "square": {"name": "Rook", "family": "square", "accessory": "none", "outline": 7, "form": "block",
               "proportions": {"head": .32, "body_width": .5, "limb_length": .38, "limb_width": .06, "eye_size": .03},
               "palette": STARTERS["square"]["palette"], "colour": "#b05aff",
               "outfit": {"skin": "#f0c8a8", "hair": "#1d1a22", "hair_style": "tuft", "shirt": "#5e2b8c", "detail": "#e8e3f0",
                          "detail_style": "zip", "pants": "#2a2833", "shoes": "#ececec", "eyes": "#2d2140"},
               "voice": {"id": "af_heart", "speed": 1.14, "pitch": 1.5}},
    "round": {"name": "Fenn", "family": "round", "accessory": "none", "outline": 7, "form": "block",
              "proportions": {"head": .32, "body_width": .5, "limb_length": .38, "limb_width": .06, "eye_size": .03},
              "palette": STARTERS["round"]["palette"], "colour": "#ffa028",
              "outfit": {"skin": "#7a4b2e", "hair": "#16110e", "hair_style": "short", "shirt": "#e2592c", "detail": "#f6c945",
                         "detail_style": "stripe", "pants": "#b39b6a", "shoes": "#4a3322", "eyes": "#1b130e"},
              "voice": {"id": "am_echo", "speed": 1.08, "pitch": 3.0}},
    "triangle": {"name": "Juno", "family": "triangle", "accessory": "none", "outline": 7, "form": "block",
                 "proportions": {"head": .32, "body_width": .5, "limb_length": .38, "limb_width": .06, "eye_size": .03},
                 "palette": STARTERS["triangle"]["palette"], "colour": "#ff64aa",
                 "outfit": {"skin": "#f3cfb3", "hair": "#1c1420", "hair_style": "long", "shirt": "#f5d35c", "detail": "#ff4f8b",
                            "detail_style": "heart", "pants": "#6b3d78", "shoes": "#f0f0f0", "eyes": "#3b2a50"},
                 "voice": {"id": "af_bella", "speed": 1.1, "pitch": 2.5}},
}


def starter_block(family: str, **changes) -> dict:
    if family not in STARTERS_BLOCK:
        _error("family", "choose " + ", ".join(FAMILIES) + ".")
    return merged(STARTERS_BLOCK[family], changes)


def starter_for(form: str, family: str, **changes) -> dict:
    """Kairos's starting design of a family in a form (2d, 3d, voxel or block)."""
    return {"3d": starter_3d, "voxel": starter_voxel, "block": starter_block}.get(form, starter)(family, **changes)


def form_of(spec: dict) -> str:
    return spec.get("form") if spec.get("form") in ("3d", "voxel", "block") else "2d"


def merged(base: dict, changes: dict) -> dict:
    """Changes over a spec: proportions and palette merge key by key; other fields replace."""
    if not isinstance(changes, dict):
        _error("changes", "give an object.")
    out = copy.deepcopy(base)
    for key, value in changes.items():
        if key in ("proportions", "palette", "outfit", "voice") and isinstance(value, dict) and isinstance(out.get(key), dict):
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

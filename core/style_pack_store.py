"""User-made style packs (Video Styles build spec, section 3 "User-made style packs"; the unit after unit 3).

A style pack is data, per account and versioned: the look (scene palette, which character families, outline weight,
lighting, the design look for type and captions), the renderer it targets (our 2D engine on the motion-type or flat-2d
base; three.js or Blender on the glossy-3d base, Pack B, where three.js is built in and Blender is used only when the
person has it installed; the voxel-3d base is recognised and unavailable until unit 6), its
character set (character specs by id and version, core/character_store.py), scene and transition rules, pacing, caption
style, music and voice defaults, and a long free-text director brief. Nothing in a pack is code and nothing runs from
one: every field is checked against fixed lists and ranges here, and the engine only reads numbers and names from it.

Making one: from a written brief (a model turns it into pack data, core/style_pack_brief.py; the brief stays attached
as the pack's origin), by duplicating a pack, from the starter pack, or by importing a pack file. Reference-video
analysis is a later step; `ORIGINS` already names it ("reference") so it can arrive as one more way in.

Versions never change once written; any change is a new draft version. A version moves draft -> awaiting_approval (its
sample video was rendered and its characters' sheets are approved, core/style_pack_sample.py) -> approved or rejected.
Only the person approves (routes/style_pack_routes.py); no model tool can. A channel or video can use a pack only once
a version is approved, and always uses that version's numbers.

Export and import: one JSON file (`kairos.style-pack`, format 1) with the pack's fields and its characters as full
specs, never ids, owners, accounts, samples or anything secret. Import is strict: size and depth limits, duplicate keys,
NaN, unknown fields and secret-looking text are refused, every value goes through the same validation, and an imported
pack lands as a draft that the importer approves in their own account.

Stored per account under <account>/style_packs/<id>/: meta.json (name, origin, versions with status and sample) and
v<N>.json (the spec); the sample's files sit next to them (sample-v<N>.mp4, sample-v<N>-sheet.png).
"""
from __future__ import annotations

import copy
import json
import os
import re
import secrets
import time
from datetime import date
from pathlib import Path

from core import accounts, character_store, design_store
from core.atomic_io import read_json, write_json_atomic

PACKS_DIR = None  # test override; normally the current account's style_packs folder

FILE_FORMAT, FILE_VERSION = "kairos.style-pack", 1
MAX_FILE_BYTES = 256 * 1024
MAX_DEPTH = 8
MAX_VERSIONS = 50
MAX_PACKS = 200
MAX_CHARACTERS = 6
BRIEF_LIMIT = 12000
RENDERERS = ("2d-engine", "blender", "threejs")
# The built-in pack each renderer's user packs are drawn by (the last is the default). Pack B (glossy-3d) runs on three.js,
# built in, or on Blender when it is installed (core/blender_tools.py); a Blender pack still renders, with three.js and a
# plain note, on a machine without Blender.
BASES = {"2d-engine": ("motion-type", "flat-2d"), "blender": ("glossy-3d",), "threejs": ("voxel-3d", "glossy-3d")}
SETTINGS = ("meadow", "city", "space", "room", "ocean", "lab")
SHOTS = ("wide", "medium", "close")
PROPS = ("sun", "moon", "star", "cloud", "lightbulb", "heart", "book", "planet", "drop", "leaf", "gear", "arrow",
         "question", "coin", "clock", "rocket", "tree", "house", "magnifier", "atom")
CAMERAS = ("still", "push", "pull", "pan", "shake")
# Pack B's studio (static/motion/stage.js): set tones and glossy props take the place of Pack A's settings and icons.
STAGE_SETS = ("lavender", "peach", "mint", "sky", "night")
STAGE_PROPS = ("ball", "block", "pillar", "ring", "coin")
TRANSITIONS = ("cut", "whip", "zoom", "flip", "dither", "mosaic", "wipe")
MOODS = ("energetic", "calm", "warm", "dark", "playful")
LIGHTING = ("flat", "soft", "glow")
CAPTION_CASES = ("sentence", "upper")
PALETTE_LAYERS = ("far", "mid", "near", "ground", "prop", "ink", "glow")
STATES = ("draft", "awaiting_approval", "approved", "rejected")
ORIGINS = ("brief", "duplicate", "starter", "import", "shared", "reference")
SPEC_FIELDS = ("name", "summary", "renderer", "base", "look", "characters", "scenes", "pacing", "captions", "music",
               "voice", "director_brief")
LOOK_FIELDS = ("design_look", "palette", "families", "outline", "lighting")
SCENE_FIELDS = ("settings", "shots", "props", "cameras", "transitions")
PACING_FIELDS = ("words_per_second", "shot_seconds", "hook_seconds")
HEX = re.compile(r"#[0-9a-f]{6}")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 '&(),.:!?+-]{0,59}")
LOOK_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,59}")
VOICE_ID = re.compile(r"[a-z]{2}_[a-z0-9]{1,30}")
PACK_ID = re.compile(r"[a-f0-9]{12}")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_lock = design_store._lock


class ApprovalError(ValueError):
    """A version is not in the state the step needs."""


class ImportRefused(ValueError):
    """A pack file that is not a valid, data-only style pack."""


def root() -> Path:
    return Path(PACKS_DIR or os.path.join(accounts.account_dir(), "style_packs"))


def folder(pack_id) -> Path:
    if not isinstance(pack_id, str) or not PACK_ID.fullmatch(pack_id):
        raise LookupError("No such style pack.")
    return root() / pack_id


def _error(path, message):
    raise ValueError(f"{path}: {message}")


def _number(value, path, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or not low <= value <= high:
        _error(path, f"give a number from {low} to {high}.")


def _text(value, path, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()) or CONTROL.search(value):
        _error(path, f"give {'non-empty ' if required else ''}plain text of at most {limit} characters.")
    return value.strip()


def _subset(value, path, allowed, least=1):
    if not isinstance(value, list) or not least <= len(value) <= len(allowed) or len(set(map(str, value))) != len(value):
        _error(path, f"give {least} or more of " + ", ".join(allowed) + ", each once.")
    for item in value:
        if item not in allowed:
            _error(path, f"{str(item)[:30]!r} is not one of " + ", ".join(allowed) + ".")
    return [item for item in allowed if item in value]      # a fixed order, so equal packs compare equal


def _fields(value, path, allowed):
    if not isinstance(value, dict):
        _error(path, "give an object with " + ", ".join(allowed) + ".")
    for key in value.keys() - set(allowed):
        _error(f"{path}.{str(key)[:40]}", "unknown field; fields are " + ", ".join(allowed) + ".")


def _palette(value, path):
    """A built-in scene palette's name, or a custom one: a two-colour sky gradient and one colour per layer."""
    from core import style_packs
    if isinstance(value, str):
        if value not in style_packs.PALETTES:
            _error(path, "a built-in palette (" + ", ".join(style_packs.PALETTES) + ") or {sky: [top, bottom], " +
                   ", ".join(PALETTE_LAYERS) + "} as hex colours.")
        return value
    _fields(value, path, ("sky",) + PALETTE_LAYERS)
    out = {}
    sky = value.get("sky")
    if not isinstance(sky, list) or len(sky) != 2:
        _error(path + ".sky", "give the top and bottom colours of the sky, like [\"#173d7a\", \"#3f7bc8\"].")
    out["sky"] = []
    for i, colour in enumerate(sky):
        colour = colour.lower() if isinstance(colour, str) else colour
        if not isinstance(colour, str) or not HEX.fullmatch(colour):
            _error(f"{path}.sky[{i}]", "a colour like #173d7a.")
        out["sky"].append(colour)
    for key in PALETTE_LAYERS:
        colour = value.get(key)
        colour = colour.lower() if isinstance(colour, str) else colour
        if not isinstance(colour, str) or not HEX.fullmatch(colour):
            _error(f"{path}.{key}", "a colour like #4a6fc0.")
        out[key] = colour
    if len(set(out["sky"]) | {out[k] for k in ("far", "mid", "near")}) < 4:
        _error(path, "the sky and the far, mid and near layers need at least 4 different colours so the depth reads.")
    return out


def validate(spec: dict) -> dict:
    """A complete pack spec, or a ValueError naming the field to fix. Returns a clean copy with defaults filled."""
    _fields(spec, "pack", SPEC_FIELDS)
    s = copy.deepcopy(spec)
    s["name"] = _text(s.get("name"), "name", 60, True)
    if not NAME.fullmatch(s["name"]):
        _error("name", "1 to 60 letters, numbers, spaces and simple punctuation, starting with a letter or number.")
    s["summary"] = _text(s.get("summary", ""), "summary", 300)
    s["director_brief"] = _text(s.get("director_brief", ""), "director_brief", BRIEF_LIMIT)
    s.setdefault("renderer", "2d-engine")
    if s["renderer"] not in RENDERERS:
        _error("renderer", "choose " + ", ".join(RENDERERS) + ".")
    s.setdefault("base", BASES[s["renderer"]][-1])
    if s["base"] not in BASES[s["renderer"]]:
        _error("base", f"the {s['renderer']} renderer draws " + ", ".join(BASES[s["renderer"]]) + ".")
    look = s.setdefault("look", {})
    _fields(look, "look", LOOK_FIELDS)
    look.setdefault("design_look", "nordic")
    if not isinstance(look["design_look"], str) or not LOOK_ID.fullmatch(look["design_look"]):
        _error("look.design_look", "a Studio look id such as nordic or playful (creative_direction lists them).")
    look["palette"] = _palette(look.get("palette", "dawn"), "look.palette")
    look["families"] = _subset(look.get("families", list(character_store.FAMILIES)), "look.families", character_store.FAMILIES)
    look.setdefault("outline", 7)
    _number(look["outline"], "look.outline", *character_store.OUTLINE)
    look.setdefault("lighting", "soft")
    if look["lighting"] not in LIGHTING:
        _error("look.lighting", "choose " + ", ".join(LIGHTING) + ".")
    cast = s.setdefault("characters", [])
    if not isinstance(cast, list) or len(cast) > MAX_CHARACTERS:
        _error("characters", f"give at most {MAX_CHARACTERS} characters, each {{character, version}}.")
    seen = set()
    for i, entry in enumerate(cast):
        if not isinstance(entry, dict) or set(entry) != {"character", "version"}:
            _error(f"characters[{i}]", "give {character, version}.")
        if not isinstance(entry["character"], str) or not re.fullmatch(r"[a-f0-9]{12}", entry["character"]):
            _error(f"characters[{i}].character", "a character id from character_list.")
        if isinstance(entry["version"], bool) or not isinstance(entry["version"], int) or not 1 <= entry["version"] <= 10_000:
            _error(f"characters[{i}].version", "a version number of that character.")
        if entry["character"] in seen:
            _error(f"characters[{i}]", "each character is in the set once, at one version.")
        seen.add(entry["character"])
    if cast and s["base"] == "motion-type":
        _error("characters", "the motion-type base has no characters; use the flat-2d base for a character set.")
    scenes = s.setdefault("scenes", {})
    _fields(scenes, "scenes", SCENE_FIELDS)
    three_d = s["base"] in ("glossy-3d", "voxel-3d")
    settings, props = (STAGE_SETS, STAGE_PROPS) if three_d else (SETTINGS, PROPS)
    for key, allowed in (("settings", settings), ("shots", SHOTS), ("props", props), ("cameras", CAMERAS),
                         ("transitions", TRANSITIONS)):
        scenes[key] = _subset(scenes.get(key, list(allowed)), f"scenes.{key}", allowed, 0 if key == "props" else 1)
    pacing = s.setdefault("pacing", {})
    _fields(pacing, "pacing", PACING_FIELDS)
    pacing.setdefault("words_per_second", 2.6)
    _number(pacing["words_per_second"], "pacing.words_per_second", 1.5, 4)
    pacing.setdefault("shot_seconds", [2, 8])
    shot = pacing["shot_seconds"]
    if not isinstance(shot, list) or len(shot) != 2:
        _error("pacing.shot_seconds", "give [shortest, longest] seconds a shot lasts.")
    _number(shot[0], "pacing.shot_seconds[0]", 1, 30)
    _number(shot[1], "pacing.shot_seconds[1]", 1, 30)
    if shot[0] > shot[1]:
        _error("pacing.shot_seconds", "the shortest is longer than the longest.")
    pacing.setdefault("hook_seconds", 5)
    _number(pacing["hook_seconds"], "pacing.hook_seconds", 1, 15)
    captions = s.setdefault("captions", {})
    _fields(captions, "captions", ("on", "case"))
    captions.setdefault("on", True)
    captions.setdefault("case", "sentence")
    if not isinstance(captions["on"], bool):
        _error("captions.on", "use true or false.")
    if captions["case"] not in CAPTION_CASES:
        _error("captions.case", "choose " + ", ".join(CAPTION_CASES) + ".")
    music = s.setdefault("music", {})
    _fields(music, "music", ("mood", "volume"))
    music.setdefault("mood", "calm")
    music.setdefault("volume", .6)
    if music["mood"] not in MOODS:
        _error("music.mood", "choose " + ", ".join(MOODS) + ".")
    _number(music["volume"], "music.volume", 0, 1)
    voice = s.setdefault("voice", {})
    _fields(voice, "voice", ("voice",))
    voice.setdefault("voice", "af_heart")
    if not isinstance(voice["voice"], str) or not VOICE_ID.fullmatch(voice["voice"]):
        _error("voice.voice", "a Kokoro voice id such as af_heart or bm_george.")
    return s


def check_characters(spec) -> list[str]:
    """The pack's characters exist in this account and match its families (problems as sentences)."""
    out = []
    for entry in spec["characters"]:
        try:
            meta = character_store.get(entry["character"])
            data = character_store.spec(entry["character"], entry["version"])
        except LookupError as error:
            out.append(str(error).strip("'"))
            continue
        if data["family"] not in spec["look"]["families"]:
            out.append(f"{meta['name']} is a {data['family']} character; this pack's families are "
                       + ", ".join(spec["look"]["families"]) + ".")
        form = character_store.form_of(data)
        if spec["base"] == "glossy-3d" and form != "3d":
            out.append(f"{meta['name']} is a flat (2D) character; a glossy 3D pack casts 3D characters (form 3d), approved on their 3D sheet.")
        elif spec["base"] == "flat-2d" and form != "2d":
            out.append(f"{meta['name']} is a 3D character; a flat 2D pack casts flat characters.")
    return out


# -- the store ---------------------------------------------------------------------------------------------------

def get(pack_id) -> dict:
    meta = read_json(str(folder(pack_id) / "meta.json"), None)
    if not isinstance(meta, dict):
        raise LookupError("No such style pack.")
    return meta


def spec(pack_id, version) -> dict:
    meta = get(pack_id)
    version_of(meta, version)
    data = read_json(str(folder(pack_id) / f"v{int(version)}.json"), None)
    if not isinstance(data, dict):
        raise LookupError(f"Style pack {meta['name']} has no version {version}.")
    return data


def version_of(meta, version) -> dict:
    for v in meta["versions"]:
        if v["version"] == version:
            return v
    raise LookupError(f"Style pack {meta['name']} has no version {version}.")


def latest(meta) -> dict:
    return meta["versions"][-1]


def approved_version(meta):
    done = [v["version"] for v in meta["versions"] if v["status"] == "approved"]
    return done[-1] if done else None


def list_all() -> list[dict]:
    out = []
    base = root()
    if not base.is_dir():
        return out
    for path in base.glob("????????????/meta.json"):
        try:
            out.append(get(path.parent.name))
        except LookupError:
            continue
    return sorted(out, key=lambda m: m["created"])


def _write_version(meta, data, by, note):
    n = (meta["versions"][-1]["version"] + 1) if meta["versions"] else 1
    if n > MAX_VERSIONS:
        raise ValueError(f"A style pack keeps at most {MAX_VERSIONS} versions; duplicate it into a new pack instead.")
    base = folder(meta["id"])
    write_json_atomic(str(base / f"v{n}.json"), data)
    meta["versions"].append({"version": n, "status": "draft", "created": time.time(), "by": str(by or "")[:80],
                             "note": str(note or "")[:300], "sample": None, "submitted_at": None, "decided_at": None,
                             "decided_by": None, "reason": ""})
    meta["name"] = data["name"]
    meta["updated"] = time.time()
    write_json_atomic(str(base / "meta.json"), meta)
    return meta


def _unique_name(name, skip=None):
    taken = {m["name"].lower() for m in list_all() if m["id"] != skip}
    if name.lower() not in taken:
        return name
    for n in range(2, 100):
        candidate = f"{name[:55]} {n}"
        if candidate.lower() not in taken:
            return candidate
    raise ValueError("name: this account already has packs with that name; give it another name.")


def create(data: dict, by: str = "", note: str = "", origin: dict | None = None) -> dict:
    """A new pack (version 1, a draft). origin: {kind, from, brief}; the written brief stays attached here."""
    data = validate(data)
    problems = check_characters(data)
    if problems:
        raise ValueError("characters: " + " ".join(problems))
    if len(list_all()) >= MAX_PACKS:
        raise ValueError(f"An account keeps at most {MAX_PACKS} style packs.")
    data["name"] = _unique_name(data["name"])
    origin = dict(origin or {"kind": "duplicate"})
    if origin.get("kind") not in ORIGINS:
        raise ValueError("origin: unknown way of making a pack.")
    origin = {"kind": origin["kind"], "from": str(origin.get("from") or "")[:120],
              "brief": _text(origin.get("brief") or "", "brief", BRIEF_LIMIT)}
    pack_id = secrets.token_hex(6)
    folder(pack_id).mkdir(parents=True, exist_ok=True)
    meta = {"id": pack_id, "name": data["name"], "created": time.time(), "updated": time.time(), "origin": origin, "versions": []}
    with _lock("style-pack:" + pack_id):
        return _write_version(meta, data, by, note or "First version.")


def merged(base: dict, changes: dict) -> dict:
    """Changes over a spec: look, scenes, pacing, captions, music and voice merge key by key; other fields replace."""
    if not isinstance(changes, dict):
        _error("changes", "give an object.")
    out = copy.deepcopy(base)
    for key, value in changes.items():
        if key in ("look", "scenes", "pacing", "captions", "music", "voice") and isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = {**out[key], **copy.deepcopy(value)}
        else:
            out[key] = copy.deepcopy(value)
    return validate(out)


def new_version(pack_id, changes: dict, by: str = "", note: str = "") -> dict:
    """Any change to a pack is a new draft version, from the latest one; older versions stay as they were."""
    with _lock("style-pack:" + pack_id):
        meta = get(pack_id)
        current = spec(pack_id, latest(meta)["version"])
        data = merged(current, changes)
        if data == current:
            _error("changes", "nothing changed; a new version needs a change.")
        problems = check_characters(data)
        if problems:
            raise ValueError("characters: " + " ".join(problems))
        data["name"] = _unique_name(data["name"], skip=pack_id)
        return _write_version(meta, data, by, note)


def duplicate(pack_id, version=None, name: str = "", by: str = "") -> dict:
    """A new pack from a version of another one (the latest when not given), as a draft of its own."""
    meta = get(pack_id)
    version = version or latest(meta)["version"]
    data = spec(pack_id, version)
    data["name"] = (name or f"{data['name'][:52]} copy").strip()
    return create(data, by=by, note=f"Duplicated from {meta['name']} version {version}.",
                  origin={"kind": "duplicate", "from": f"{meta['name']} v{version}", "brief": meta.get("origin", {}).get("brief", "")})


def sample_path(pack_id, version, kind="mp4") -> Path:
    get(pack_id)
    return folder(pack_id) / (f"sample-v{int(version)}.mp4" if kind == "mp4" else f"sample-v{int(version)}-{kind}.png")


def set_sample_status(pack_id, version, status: str, **fields) -> dict:
    """Record a sample render's progress on a version ("rendering", "waiting for character sheets", "failed: ...")."""
    with _lock("style-pack:" + pack_id):
        meta = get(pack_id)
        v = version_of(meta, version)
        if v["status"] == "approved":
            raise ApprovalError(f"Version {version} is approved and cannot change; make a new version.")
        v["sample"] = {**(v.get("sample") or {}), "status": str(status)[:600], **fields, "at": time.time()}
        meta["updated"] = time.time()
        write_json_atomic(str(folder(pack_id) / "meta.json"), meta)
        return meta


def submit(pack_id, version, sample: dict) -> dict:
    """The sample is rendered and every character in the pack is approved: the version now waits for the person."""
    with _lock("style-pack:" + pack_id):
        meta = get(pack_id)
        v = version_of(meta, version)
        if v["status"] == "approved":
            raise ApprovalError(f"Version {version} is approved and cannot change; make a new version.")
        v.update(sample={**sample, "status": "ready", "at": time.time()}, status="awaiting_approval", submitted_at=time.time(),
                 decided_at=None, decided_by=None, reason="")
        meta["updated"] = time.time()
        write_json_atomic(str(folder(pack_id) / "meta.json"), meta)
        return meta


def decide(pack_id, version, approve: bool, by: str, reason: str = "") -> dict:
    """The person's approval or rejection. Only a version waiting for it can be decided, and a pack is approved only
    while every character in it is approved too."""
    with _lock("style-pack:" + pack_id):
        meta = get(pack_id)
        v = version_of(meta, version)
        if v["status"] != "awaiting_approval":
            raise ApprovalError(f"Version {version} of {meta['name']} is {v['status'].replace('_', ' ')}, not waiting for approval.")
        if approve:
            waiting = [e for e in spec(pack_id, version)["characters"] if not character_store.is_approved(e["character"], e["version"])]
            if waiting:
                raise ApprovalError("Approve the pack's character sheets first (Studio > Content > Approvals).")
        v.update(status="approved" if approve else "rejected", decided_at=time.time(), decided_by=str(by)[:80],
                 reason=str(reason or "")[:500])
        meta["updated"] = time.time()
        write_json_atomic(str(folder(pack_id) / "meta.json"), meta)
        return meta


def is_approved(pack_id, version) -> bool:
    try:
        return version_of(get(pack_id), version)["status"] == "approved"
    except LookupError:
        return False


def pending() -> list[dict]:
    out = []
    for meta in list_all():
        for v in meta["versions"]:
            if v["status"] == "awaiting_approval":
                out.append({"id": meta["id"], "name": meta["name"], **v, "spec": spec(meta["id"], v["version"])})
    return sorted(out, key=lambda v: v["submitted_at"] or 0, reverse=True)


def usable(pack_id) -> tuple[dict, int, dict]:
    """(meta, approved version, its spec) of a pack a channel or video may use, or a ValueError saying why not."""
    meta = get(pack_id)
    version = approved_version(meta)
    if version is None:
        raise ValueError(f"The style pack {meta['name']} has no approved version yet; approve its sample in Studio > Content > Styles.")
    return meta, version, spec(pack_id, version)


# -- applying a pack to a video ------------------------------------------------------------------------------------

def palette_colours(data) -> dict:
    from core import style_packs
    palette = data["look"]["palette"]
    return copy.deepcopy(style_packs.PALETTES[palette] if isinstance(palette, str) else palette)


def render_look(data) -> dict:
    """What the player gives the engine from a pack: numbers and names only."""
    return {"palette": palette_colours(data), "lighting": data["look"]["lighting"], "caption_case": data["captions"]["case"]}


def video_defaults(data) -> dict:
    """The project options a pack sets when a video is made in it (the caller's own choices win)."""
    out = {"look": data["look"]["design_look"], "music": dict(data["music"]),
           "narration": {"voice": data["voice"]["voice"], "captions": data["captions"]["on"]}}
    if data["characters"]:
        out["cast"] = [dict(e) for e in data["characters"]]
    if data["base"] == "glossy-3d":
        out["renderer"] = data["renderer"]        # three.js or Blender; a channel's own choice can override it
    return out


def rule_notes(project, data) -> list[str]:
    """Where a video strays from its pack's scene rules and pacing (render and preview notes, not refusals)."""
    from core import video_store
    notes, scenes = [], data["scenes"]
    low, high = data["pacing"]["shot_seconds"]
    for i, b in enumerate(project["beats"]):
        label = f"Beat {b['id']}"
        if b.get("camera", "still") not in scenes["cameras"]:
            notes.append(f"{label} uses the {b.get('camera')} camera, which the {data['name']} pack does not use.")
        if i < len(project["beats"]) - 1 and b.get("transition", "cut") not in scenes["transitions"]:
            notes.append(f"{label} uses the {b.get('transition')} transition, which the {data['name']} pack does not use.")
        if b["kind"] in ("scene", "stage"):
            scene = b.get("scene") or b.get("stage") or {}
            place = scene.get("setting") if b["kind"] == "scene" else scene.get("set")
            if place not in scenes["settings"]:
                notes.append(f"{label} is set in {place}, outside the {data['name']} pack's settings.")
            if scene.get("shot") not in scenes["shots"]:
                notes.append(f"{label} is a {scene.get('shot')} shot, outside the {data['name']} pack's shots.")
            for prop in scene.get("props", []):
                if (prop.get("icon") or prop.get("shape")) not in scenes["props"]:
                    notes.append(f"{label} shows a {prop.get('icon') or prop.get('shape')}, outside the {data['name']} pack's props.")
            for member in scene.get("cast", []):
                if not any(e["character"] == member["character"] for e in data["characters"]):
                    notes.append(f"{label} casts a character that is not in the {data['name']} pack's character set.")
        if "say" in b and b["kind"] != "end":
            seconds = video_store.beat_seconds(b, project.get("bpm", 120))
            if seconds < low - .5 or seconds > high + .5:
                notes.append(f"{label} lasts {seconds:.1f} s; the {data['name']} pack keeps shots between {low:g} and {high:g} s.")
    first = project["beats"][0]
    if video_store.beat_seconds(first, project.get("bpm", 120)) > data["pacing"]["hook_seconds"] + .5:
        notes.append(f"The opening beat runs past the pack's {data['pacing']['hook_seconds']:g} s hook.")
    return list(dict.fromkeys(notes))


# -- the starter pack ------------------------------------------------------------------------------------------------

STARTER_ID = "flat-science-explainer"
STARTER_BRIEF = (
    "Flat science explainer. Big questions about science, space, the body and how the world works, told calmly and "
    "clearly, with a little dry humour and real wonder at the end.\n\n"
    "Before any spending: research and fact-check every claim and keep a source for each; write the script and a "
    "timestamped shot plan, and get them approved.\n\n"
    "Look: flat vector shapes with no textures, soft gradients only inside a shape, a limited palette per channel "
    "(deep blues for the sky, cool periwinkle hills, a pale ground so figures read clearly), simple flat icons for "
    "ideas, generous negative space. Every scene is layered: sky, far, mid and near layers that move at different "
    "speeds when the camera moves, so a flat world feels deep.\n\n"
    "Characters: our own geometric family, round, square and triangle-bodied figures with dot eyes and short limbs, "
    "drawn from their approved character sheets so they never drift. They react with simple expressions (happy, "
    "surprised, worried, thinking), blink, turn their heads and squash and stretch when they jump. One narrator voice "
    "speaks; the character who is on screen for a line mouths it.\n\n"
    "Camera and editing: cinematic but calm. Slow push-ins on a key idea, a pull back to reveal scale, gentle pans "
    "across a scene. Cut on the beat of the narration; use a whip or zoom only to change topic. Wide shots set the "
    "scene, medium shots explain, a close shot lands the surprising fact.\n\n"
    "Pacing: about two and a half spoken words a second, a hook in the first five seconds, shots of two to eight "
    "seconds, one idea per shot, numbers shown big when they are said.\n\n"
    "Sound: a calm, warm synthesized music bed under the voice, ducked while the narrator speaks. Captions on, in "
    "sentence case, clear of the characters.\n\n"
    "Quality: 1920x1080, check every frame sample against the character sheets, keep text inside safe areas, and "
    "never copy another channel's characters, mascots, logos, artwork, scenes, titles or catchphrases.")
STARTER = {
    "name": "Flat science explainer",
    "summary": "Flat-vector 2D explainers about science with our own geometric characters, layered parallax scenes and a calm cinematic camera.",
    "renderer": "2d-engine", "base": "flat-2d",
    "look": {"design_look": "nordic", "families": ["round", "square", "triangle"], "outline": 7, "lighting": "glow",
             "palette": {"sky": ["#173d7a", "#3f7bc8"], "far": "#6c8fd8", "mid": "#4a6fc0", "near": "#dfe6f5",
                         "ground": "#b9c6e4", "prop": "#ffd166", "ink": "#1b2a4a", "glow": "#ffffff"}},
    "scenes": {"settings": ["meadow", "space", "lab", "city", "ocean"], "shots": ["wide", "medium", "close"],
               "props": ["sun", "moon", "star", "planet", "atom", "lightbulb", "drop", "leaf", "clock", "rocket", "magnifier", "question"],
               "cameras": ["still", "push", "pull", "pan"], "transitions": ["cut", "whip", "zoom", "wipe"]},
    "pacing": {"words_per_second": 2.6, "shot_seconds": [2, 8], "hook_seconds": 5},
    "captions": {"on": True, "case": "sentence"},
    "music": {"mood": "calm", "volume": .55},
    "voice": {"voice": "af_heart"},
    "director_brief": STARTER_BRIEF,
}
# The starter pack's cast: Kairos's own round, square and triangle designs (core/character_store.STARTERS), unchanged.
STARTER_CHARACTERS = ("round", "square", "triangle")
# Pack B's starter: a glossy 3D "what if" series pack with Kairos's own round mascot rebuilt in 3D (Pip 3D). Generic name;
# nothing in it resembles any channel's character (no dark round head in a yellow hoodie, no channel's name or set).
STARTER_3D_ID = "glossy-what-if"
STARTER_3D_BRIEF = (
    "Glossy what-if series. Each episode asks one impossible question (what if you could see everyone's sleep, savings "
    "or screen time floating over their heads?) and walks through it with our own glossy 3D mascot in a bright studio.\n\n"
    "Before any spending: write the script and a timestamped shot plan, keep a source for every real figure, keep every "
    "person fictional, and get the plan approved. Each episode needs its own question, research and payoff, never the same "
    "setup with the same outcome.\n\n"
    "Look: a soft-lit studio with a curved backdrop in one pastel tone per channel, glossy plastic materials, simple "
    "faceless stand-in people in soft colours, a few glossy props, and big clean labels and numbers floating over heads, "
    "drawn sharp in 2D. Our mascot is drawn from its approved 3D character sheet so it never drifts.\n\n"
    "Camera: a wide shot to set the room, a medium shot for the mascot's reaction, a close shot for the punchline; slow "
    "push-ins and gentle orbits, cut on the narration.\n\n"
    "Pacing: about two and a half words a second, the question in the first five seconds, shots of two to six seconds, a "
    "number on screen every time one is said.\n\n"
    "Sound: a playful synthesized bed under one narrator voice, ducked while it speaks; captions on.\n\n"
    "Quality: check sampled frames against the character's 3D sheet, keep labels and captions inside safe areas, and never "
    "copy another channel's characters, mascots, logos, sets, titles or catchphrases.")
STARTER_3D = {
    "name": "Glossy what-if",
    "summary": "A glossy 3D studio series: our own mascot, faceless stand-in people and numbers floating over their heads.",
    "renderer": "threejs", "base": "glossy-3d",
    # The palette colours the title and end cards, in the studio's lavender so a card does not jump out of the series.
    "look": {"design_look": "nordic", "families": ["round"], "outline": 7, "lighting": "soft",
             "palette": {"sky": ["#cfc4ea", "#eee8f8"], "far": "#b9acdf", "mid": "#a596d4", "near": "#8d7cc4",
                         "ground": "#d8cfee", "prop": "#7cc6a4", "ink": "#2e2438", "glow": "#ffffff"}},
    "scenes": {"settings": ["lavender", "peach", "mint", "sky"], "shots": ["wide", "medium", "close"],
               "props": ["ball", "block", "pillar", "ring", "coin"], "cameras": ["still", "push", "pull", "pan"],
               "transitions": ["cut", "zoom", "wipe"]},
    "pacing": {"words_per_second": 2.6, "shot_seconds": [1.5, 6], "hook_seconds": 5.5},
    "captions": {"on": True, "case": "sentence"},
    "music": {"mood": "playful", "volume": .5},
    "voice": {"voice": "af_heart"},
    "director_brief": STARTER_3D_BRIEF,
}
STARTERS = {STARTER_ID: {"spec": STARTER, "characters": STARTER_CHARACTERS},
            STARTER_3D_ID: {"spec": STARTER_3D, "characters": ("round",), "form": "3d"}}


def _character_for(data: dict, by: str) -> dict:
    """A character spec from a pack file, in this account: an identical existing version is reused; otherwise a new
    character (named apart from any existing one) is made as a draft whose sheet the person approves."""
    data = character_store.validate(data)
    for meta in character_store.list_all():
        for v in meta["versions"]:
            try:
                if character_store.spec(meta["id"], v["version"]) == data:
                    return {"character": meta["id"], "version": v["version"]}
            except LookupError:
                continue
    names = {m["name"].lower() for m in character_store.list_all()}
    name = data["name"]
    n = 2
    while name.lower() in names:
        name = f"{data['name'][:36]} {n}"
        n += 1
    meta = character_store.create({**data, "name": name}, by=by, note="From a style pack.")
    return {"character": meta["id"], "version": 1}


def default_cast(data: dict, by: str = "") -> dict:
    """A flat-2d or glossy-3d pack with no character set gets one per family it allows (up to three): the newest approved
    character of that family and form (flat for 2D, 3D for Pack B) in this account, else Kairos's own starting design for
    it (made here as a draft)."""
    if data["base"] not in ("flat-2d", "glossy-3d") or data["characters"]:
        return data
    form = "3d" if data["base"] == "glossy-3d" else "2d"
    cast = []
    for family in data["look"]["families"][:3]:
        found = None
        for meta in reversed(character_store.list_all()):
            version = character_store.approved_version(meta)
            if meta["family"] == family and version and character_store.form_of(character_store.spec(meta["id"], version)) == form:
                found = {"character": meta["id"], "version": version}
        starter = character_store.starter_3d(family) if form == "3d" else character_store.starter(family)
        cast.append(found or _character_for(starter, by))
    return validate({**data, "characters": cast})


def install_starter(starter_id=STARTER_ID, by: str = "") -> dict:
    """Add a shipped starter pack to this account as a draft: its characters are made (or reused) from Kairos's own
    family, then the person makes its sample and approves it like any pack."""
    if starter_id not in STARTERS:
        raise LookupError("No such starter pack.")
    entry = STARTERS[starter_id]
    for meta in list_all():
        if meta.get("origin", {}).get("kind") == "starter" and meta["origin"].get("from") == starter_id:
            raise ApprovalError(f"This account already has the starter pack ({meta['name']}). Duplicate it to make another.")
    make = character_store.starter_3d if entry.get("form") == "3d" else character_store.starter
    cast = [_character_for(make(family), by) for family in entry["characters"]]
    return create({**copy.deepcopy(entry["spec"]), "characters": cast}, by=by, note="The starter pack.",
                  origin={"kind": "starter", "from": starter_id, "brief": entry["spec"]["director_brief"]})


def starters() -> list[dict]:
    return [{"id": k, "name": v["spec"]["name"], "summary": v["spec"]["summary"]} for k, v in STARTERS.items()]


# -- export and import -------------------------------------------------------------------------------------------------

def export_data(pack_id, version=None) -> dict:
    """The pack file: the version's fields with its characters as full specs. No ids, owners, accounts, samples,
    statuses or anything secret."""
    meta = get(pack_id)
    version = version or approved_version(meta) or latest(meta)["version"]
    data = spec(pack_id, version)
    characters = []
    for i, entry in enumerate(data.pop("characters")):
        characters.append({"ref": f"c{i + 1}", "spec": character_store.spec(entry["character"], entry["version"])})
    out = {"format": FILE_FORMAT, "format_version": FILE_VERSION, "exported": date.today().isoformat(),
           "pack": data, "characters": characters}
    _refuse_secrets(out)
    return out


def export_bytes(pack_id, version=None) -> bytes:
    return json.dumps(export_data(pack_id, version), ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")


def _refuse_secrets(value):
    from services import bot_package
    if bot_package.findings(value):
        raise ImportRefused("The pack contains something that looks like a password or key. Remove it first.")


def _depth(value, level=0):
    if level > MAX_DEPTH:
        raise ImportRefused("The pack file is nested too deeply.")
    if isinstance(value, dict):
        for item in value.values():
            _depth(item, level + 1)
    elif isinstance(value, list):
        for item in value:
            _depth(item, level + 1)


def _no_duplicates(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ImportRefused("The pack file repeats a field.")
    return dict(pairs)


def _no_constant(name):
    raise ImportRefused(f"The pack file holds {name}, which is not a number.")


def parse_file(raw) -> dict:
    """Read a pack file strictly: size, encoding, JSON with no repeated keys or NaN, depth. Returns the parsed object."""
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if not isinstance(raw, (bytes, bytearray)) or not raw:
        raise ImportRefused("Choose a style pack file.")
    if len(raw) > MAX_FILE_BYTES:
        raise ImportRefused(f"The pack file is larger than {MAX_FILE_BYTES // 1024} KB.")
    try:
        text = bytes(raw).decode("utf-8-sig")
        data = json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_no_constant)
    except ImportRefused:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ImportRefused("The file is not a style pack (it is not readable JSON).") from None
    _depth(data)
    return data


def check_file(data) -> tuple[dict, list[dict]]:
    """A parsed pack file as (pack spec without characters, character specs by ref), or ImportRefused."""
    if not isinstance(data, dict) or set(data) - {"format", "format_version", "exported", "pack", "characters"} \
            or data.get("format") != FILE_FORMAT:
        raise ImportRefused("The file is not a Kairos style pack.")
    if data.get("format_version") != FILE_VERSION:
        raise ImportRefused("This style pack was made by a newer Kairos; update Kairos to import it.")
    _refuse_secrets(data)
    pack, characters = data.get("pack"), data.get("characters", [])
    if not isinstance(pack, dict) or "characters" in pack:
        raise ImportRefused("The pack file's pack section is missing or malformed.")
    if not isinstance(characters, list) or len(characters) > MAX_CHARACTERS:
        raise ImportRefused(f"A pack file carries at most {MAX_CHARACTERS} characters.")
    specs, refs = [], set()
    for i, item in enumerate(characters):
        if not isinstance(item, dict) or set(item) != {"ref", "spec"} or not isinstance(item["ref"], str) \
                or not re.fullmatch(r"c[1-9][0-9]?", item["ref"]) or item["ref"] in refs:
            raise ImportRefused(f"characters[{i}] is not a character of this pack.")
        refs.add(item["ref"])
        try:
            specs.append(character_store.validate(item["spec"]))
        except ValueError as error:
            raise ImportRefused(f"characters[{i}]: {error}") from None
    try:
        clean = validate({**pack, "characters": []})
    except ValueError as error:
        raise ImportRefused(str(error)) from None
    if specs and clean["base"] == "motion-type":
        raise ImportRefused("A motion-type pack has no characters.")
    clean.pop("characters")
    return clean, specs


def import_data(data, by: str = "", origin: str = "import", source: str = "", into: str | None = None) -> dict:
    """A checked pack file into this account as a draft (a new pack, or with `into` a new version of one), with its
    characters made or reused here. The importer approves it like any pack; nothing runs from it."""
    clean, specs = check_file(data)
    cast = [_character_for(s, by) for s in specs]
    clean["characters"] = cast
    if into:
        current = spec(into, latest(get(into))["version"])
        clean["name"] = current["name"]
        return new_version(into, {k: clean[k] for k in SPEC_FIELDS}, by=by, note=f"Updated from {source or 'a pack file'}.")
    return create(clean, by=by, note=f"Imported from {source or 'a pack file'}.",
                  origin={"kind": origin, "from": source, "brief": clean["director_brief"]})


def import_bytes(raw, by: str = "", source: str = "") -> dict:
    return import_data(parse_file(raw), by=by, source=source or "a pack file")

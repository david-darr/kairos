"""Versioned video beat sheets, isolated by owner and explicit chat links.

Validation returns a copy so failed edits never change the stored project.

Narration (Video Styles build spec, unit 1): a beat's `say` is the line the narrator speaks over it. The timeline is
audio-first: core/video_narration.py speaks each line with Kokoro and writes the measurement into the beat's
`spoken` (the speech key, its length and the caption parts with their times). `seconds` is never taken from the
caller: validation derives it, from the measured speech when `spoken` matches the line and voice, else from an
estimate that the next narration pass replaces. A beat without `say` keeps its length in bars.
"""
from __future__ import annotations

import copy
import hashlib
import io
import math
import os
import re
import secrets
import shutil
import time
from pathlib import Path

from PIL import Image
from core import accounts, design_store
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

VIDEOS_DIR = None  # test override; normally the current account's videos folder


def videos_dir() -> str:
    return VIDEOS_DIR or accounts.path("videos")


ASPECTS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
KINDS = ("title", "statement", "big-number", "list", "image", "quote", "split", "logo", "end", "scene")
CAMERAS = ("still", "push", "pull", "pan", "shake")
TRANSITIONS = ("cut", "whip", "zoom", "flip", "dither", "mosaic", "wipe")
MOODS = ("energetic", "calm", "warm", "dark", "playful")
ASSET = re.compile(r"assets/[a-f0-9]{64}\.(?:png|jpg|gif|webp)")
FIELDS = {"id", "title", "look", "bpm", "fps", "aspects", "beats", "music", "narration", "cast", "palette", "style_pack"}
ACTIONS = ("idle", "wave", "point", "walk", "jump", "shrug", "think", "nod")
MAX_CAST, MAX_ON_SCREEN, MAX_PROPS = 6, 3, 6
MAX_SECONDS = 120               # a video with music only
NARRATED_MAX_SECONDS = 480      # a narrated Short or mid-length video; long-form chapters are a later unit
MAX_BEATS, NARRATED_MAX_BEATS = 40, 100
LEAD, TAIL = .25, .45           # seconds of picture before a line starts and after it ends
SAY_LIMIT, CLAUSE_LIMIT = 400, 100
DEFAULT_VOICE = "af_heart"
VOICE_ID = re.compile(r"[a-z]{2}_[a-z0-9]{1,30}")
META = {"owner", "chat_ids", "visible_to", "version", "created", "updated"}
AccessError = design_store.AccessError
chat_key = design_store.chat_key
visible_to = design_store.visible_to
_lock = design_store._lock


def _folder(video_id: str) -> Path:
    if not isinstance(video_id, str) or not re.fullmatch(r"[a-f0-9]{12}", video_id):
        raise LookupError("No such video.")
    return Path(videos_dir(), video_id)


def _error(path, message):
    raise ValueError(f"{path}: {message}")


def _text(value, path, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        _error(path, f"give {'non-empty ' if required else ''}text of at most {limit} characters.")


def _number(value, path, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        _error(path, f"give a number from {low} to {high}.")


def validate(project: dict) -> dict:
    """Check the shared player schema and name the exact field needing repair."""
    if not isinstance(project, dict):
        _error("project", "give an object.")
    p = copy.deepcopy(project)
    for key in p.keys() - FIELDS - META:
        _error(key, "unknown project field.")
    if not isinstance(p.get("id"), str) or not re.fullmatch(r"[a-f0-9]{12}", p["id"]):
        _error("id", "use the video's 12 hexadecimal character id.")
    _text(p.get("title"), "title", 120, True)
    _text(p.get("look"), "look", 60, True)
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,59}", p["look"]):
        _error("look", "use a look id from creative_direction.")
    p.setdefault("bpm", 120)
    _number(p["bpm"], "bpm", 60, 180)
    p.setdefault("fps", 30)
    if isinstance(p["fps"], bool) or p["fps"] != 30:
        _error("fps", "use 30 frames per second.")
    p.setdefault("aspects", ["16:9"])
    if (not isinstance(p["aspects"], list) or not p["aspects"] or
            any(not isinstance(a, str) or a not in ASPECTS for a in p["aspects"]) or
            len(set(p["aspects"])) != len(p["aspects"])):
        _error("aspects", "choose a non-empty subset of 16:9, 9:16, 1:1 without duplicates.")
    beats = p.get("beats")
    is_narrated = isinstance(beats, list) and any(isinstance(b, dict) and "say" in b for b in beats)
    most = NARRATED_MAX_BEATS if is_narrated else MAX_BEATS
    if not isinstance(beats, list) or not 1 <= len(beats) <= most:
        _error("beats", f"give 1 to {most} beats.")
    ids = set()
    allowed = {"id", "kind", "bars", "text", "sub", "number", "items", "image", "camera", "transition", "treatment",
               "say", "spoken", "seconds", "scene"}
    for i, b in enumerate(beats):
        path = f"beats[{i}]"
        if not isinstance(b, dict):
            _error(path, "give a beat object.")
        # Near-miss names models use (Phase 4 benchmark: "subtitle"); the error names the right field.
        aliases = {"subtitle": "sub", "subtext": "sub", "caption": "sub", "headline": "text", "title": "text",
                   "duration": "bars", "type": "kind", "list": "items", "bullets": "items", "value": "number", "stat": "number"}
        for key in sorted(b.keys() - allowed):
            _error(f"{path}.{key}", f"unknown beat field; use {aliases[key]}." if key in aliases
                   else "unknown beat field; beat fields are " + ", ".join(sorted(allowed)) + ".")
        if not isinstance(b.get("id"), str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,47}", b["id"]):
            _error(path + ".id", "use a letter followed by up to 47 letters, numbers, dashes or underscores.")
        if b["id"] in ids:
            _error(path + ".id", "each beat needs a unique id.")
        ids.add(b["id"])
        if b.get("kind") not in KINDS:
            _error(path + ".kind", "choose " + ", ".join(KINDS) + ".")
        if b["kind"] == "big-number" and str(b.get("number", "")).strip() == "":
            _error(path + ".number", 'a big-number beat needs its number, e.g. "312" or "30s"; or use kind statement.')
        if "say" in b:
            _say(b["say"], path + ".say")
            b.setdefault("bars", 1)   # a narrated beat lasts as long as its line; bars only matter without one
        _number(b.get("bars"), path + ".bars", .5, 8)
        if b["bars"] * 2 != int(b["bars"] * 2):
            _error(path + ".bars", "use half-bar steps (0.5, 1, 1.5...).")
        for field, limit in (("text", 140), ("sub", 100), ("treatment", 80)):
            if field in b:
                _text(b[field], path + "." + field, limit)
        if "number" in b:
            if isinstance(b["number"], str):
                _text(b["number"], path + ".number", 140)
            else:
                _number(b["number"], path + ".number", -1e15, 1e15)
        if "items" in b:
            if not isinstance(b["items"], list) or len(b["items"]) > 5:
                _error(path + ".items", "give at most 5 text items.")
            for j, item in enumerate(b["items"]):
                _text(item, f"{path}.items[{j}]", 60)
        if "image" in b and (not isinstance(b["image"], str) or not ASSET.fullmatch(b["image"])):
            _error(path + ".image", "use assets/<sha256>.png, .jpg, .gif or .webp from video_add_image.")
        for field, choices in (("camera", CAMERAS), ("transition", TRANSITIONS)):
            if field in b and b[field] not in choices:
                _error(path + "." + field, "choose " + ", ".join(choices) + ".")
        if b["kind"] == "scene":
            _scene(b.get("scene"), path + ".scene")
        elif "scene" in b:
            _error(path + ".scene", "only a scene beat has a scene; set kind to scene or remove it.")
    _cast(p, beats)
    _style_pack(p)
    if is_narrated or "narration" in p:
        p["narration"] = _narration(p.get("narration"))
    for i, b in enumerate(beats):
        _timing(b, p.get("narration"), f"beats[{i}]")
    limit = NARRATED_MAX_SECONDS if is_narrated else MAX_SECONDS
    if duration(p) > limit:
        _error("beats", f"total duration must be at most {limit} seconds; " +
               ("shorten or remove narration lines." if is_narrated else "reduce bars or raise bpm."))
    p.setdefault("music", {"mood": "energetic", "volume": .7})
    music = p["music"]
    if not isinstance(music, dict):
        _error("music", "give mood and volume.")
    for key in music.keys() - {"mood", "volume"}:
        _error("music." + key, "unknown music field.")
    if music.get("mood") not in MOODS:
        _error("music.mood", "choose " + ", ".join(MOODS) + ".")
    _number(music.get("volume"), "music.volume", 0, 1)
    return p


def _scene(value, path):
    """A Pack A scene: a setting drawn as parallax layers, a shot size, up to three cast members and a few props."""
    from core import character_store, style_packs
    if not isinstance(value, dict):
        _error(path, "give setting, shot, cast and props.")
    for key in value.keys() - {"setting", "shot", "cast", "props"}:
        _error(f"{path}.{key}", "unknown scene field; use setting, shot, cast or props.")
    value.setdefault("setting", "meadow")
    value.setdefault("shot", "medium")
    value.setdefault("cast", [])
    value.setdefault("props", [])
    if value["setting"] not in style_packs.SETTINGS:
        _error(path + ".setting", "choose " + ", ".join(style_packs.SETTINGS) + ".")
    if value["shot"] not in style_packs.SHOTS:
        _error(path + ".shot", "choose " + ", ".join(style_packs.SHOTS) + ".")
    if not isinstance(value["cast"], list) or len(value["cast"]) > MAX_ON_SCREEN:
        _error(path + ".cast", f"give at most {MAX_ON_SCREEN} characters on screen.")
    seen, speaking = set(), 0
    for i, member in enumerate(value["cast"]):
        where = f"{path}.cast[{i}]"
        if not isinstance(member, dict):
            _error(where, "give {character, x, view, expression, action, speaking}.")
        for key in member.keys() - {"character", "x", "view", "expression", "action", "speaking", "facing", "turn"}:
            _error(f"{where}.{key}", "unknown cast field; use character, x, view, expression, action, speaking, facing or turn.")
        if not isinstance(member.get("character"), str) or not re.fullmatch(r"[a-f0-9]{12}", member["character"]):
            _error(where + ".character", "use a character id from the project's cast.")
        if member["character"] in seen:
            _error(where + ".character", "a character appears once per scene.")
        seen.add(member["character"])
        member.setdefault("x", round((i + 1) / (len(value["cast"]) + 1), 3))
        _number(member["x"], where + ".x", 0, 1)
        for key, choices, default in (("view", character_store.VIEWS, "front"), ("expression", character_store.EXPRESSIONS, "neutral"),
                                      ("action", ACTIONS, "idle"), ("facing", ("left", "right"), "right")):
            member.setdefault(key, default)
            if member[key] not in choices:
                _error(f"{where}.{key}", "choose " + ", ".join(choices) + ".")
        if "turn" in member and member["turn"] not in character_store.VIEWS:
            _error(where + ".turn", "the view the head turns to: " + ", ".join(character_store.VIEWS) + ".")
        member.setdefault("speaking", False)
        if not isinstance(member["speaking"], bool):
            _error(where + ".speaking", "use true or false.")
        speaking += member["speaking"]
    if speaking > 1:
        _error(path + ".cast", "one narrator voice speaks at a time: mark at most one character speaking.")
    if not isinstance(value["props"], list) or len(value["props"]) > MAX_PROPS:
        _error(path + ".props", f"give at most {MAX_PROPS} props.")
    for i, prop in enumerate(value["props"]):
        where = f"{path}.props[{i}]"
        if not isinstance(prop, dict):
            _error(where, "give {icon, x, y, size}.")
        for key in prop.keys() - {"icon", "x", "y", "size", "float"}:
            _error(f"{where}.{key}", "unknown prop field; use icon, x, y, size or float.")
        if prop.get("icon") not in style_packs.PROPS:
            _error(where + ".icon", "choose " + ", ".join(style_packs.PROPS) + ".")
        prop.setdefault("x", .5)
        prop.setdefault("y", .3)
        prop.setdefault("size", .1)
        prop.setdefault("float", False)
        _number(prop["x"], where + ".x", 0, 1)
        _number(prop["y"], where + ".y", 0, 1)
        _number(prop["size"], where + ".size", .03, .35)
        if not isinstance(prop["float"], bool):
            _error(where + ".float", "use true or false.")


def _cast(p, beats):
    """The project's cast pins each character to one version; every scene uses only cast members. A draft can be
    cast while its sheet waits for the person, but a video renders only approved versions (core/video_render.py)."""
    from core import character_store, style_packs
    scenes = [b for b in beats if b["kind"] == "scene"]
    cast = p.get("cast", [])
    if not isinstance(cast, list) or len(cast) > MAX_CAST:
        _error("cast", f"give at most {MAX_CAST} characters, each {{character, version}}.")
    pinned = set()
    for i, entry in enumerate(cast):
        if not isinstance(entry, dict) or set(entry) != {"character", "version"}:
            _error(f"cast[{i}]", "give {character, version}.")
        if not isinstance(entry["character"], str) or not re.fullmatch(r"[a-f0-9]{12}", entry["character"]):
            _error(f"cast[{i}].character", "use a character id from character_list.")
        if entry["character"] in pinned:
            _error(f"cast[{i}].character", "each character is cast once, at one version.")
        pinned.add(entry["character"])
        if isinstance(entry["version"], bool) or not isinstance(entry["version"], int) or entry["version"] < 1:
            _error(f"cast[{i}].version", "use a version number of that character.")
        try:
            character_store.version_of(character_store.get(entry["character"]), entry["version"])
        except LookupError as error:
            _error(f"cast[{i}]", str(error).strip("'") + " Use character_list for ids and versions.")
    for i, b in enumerate(beats):
        for j, member in enumerate(b["scene"]["cast"] if b["kind"] == "scene" else []):
            if member["character"] not in pinned:
                _error(f"beats[{i}].scene.cast[{j}].character", "add this character to the project's cast with its version first.")
    if cast:
        p["cast"] = cast
    else:
        p.pop("cast", None)
    if scenes or "palette" in p:
        p.setdefault("palette", "dawn")
        if p["palette"] not in style_packs.PALETTES:
            _error("palette", "choose " + ", ".join(style_packs.PALETTES) + ".")


def _style_pack(p):
    """A user-made style pack the video is made in, pinned to one version ({id, version}); built-in packs need no pin.
    A video renders only in an approved version (core/video_render.py); its look comes from that version's numbers."""
    if "style_pack" not in p:
        return
    from core import style_pack_store
    value = p["style_pack"]
    if value is None:
        p.pop("style_pack")
        return
    if not isinstance(value, dict) or set(value) != {"id", "version"}:
        _error("style_pack", "give {id, version} of one of this account's style packs.")
    if isinstance(value["version"], bool) or not isinstance(value["version"], int) or value["version"] < 1:
        _error("style_pack.version", "use a version number of that pack.")
    try:
        style_pack_store.version_of(style_pack_store.get(value["id"]), value["version"])
    except LookupError as error:
        _error("style_pack", str(error).strip("'") + " The Styles tab in Studio > Content lists this account's packs.")


def clauses(text):
    """The caption parts of a line: its sentences, a long one cut at its commas, semicolons or colons. Each part
    is spoken and measured on its own, so every caption's time is measured, never guessed."""
    out = []
    for sentence in re.split(r"(?<=[.!?\u2026])\s+", " ".join(str(text).split())):
        if len(sentence) <= CLAUSE_LIMIT:
            out.append(sentence)
            continue
        part = ""
        for piece in re.split(r"(?<=[,;:])\s+", sentence):
            if part and len(part) + 1 + len(piece) > CLAUSE_LIMIT:
                out.append(part)
                part = piece
            else:
                part = (part + " " + piece).strip()
        out.append(part)
    return [c for c in out if c]


def _say(value, path):
    _text(value, path, SAY_LIMIT, True)
    if not re.search(r"[A-Za-z0-9]", value):
        _error(path, "give a line with words to speak.")
    for part in clauses(value):
        if len(part) > CLAUSE_LIMIT:
            _error(path, f"a sentence without a comma runs past {CLAUSE_LIMIT} characters; split it or add punctuation "
                         "so each caption fits on screen.")


def _narration(value):
    value = {"voice": DEFAULT_VOICE, "captions": True} if value is None else value
    if not isinstance(value, dict):
        _error("narration", "give voice and captions.")
    for key in value.keys() - {"voice", "captions"}:
        _error("narration." + key, "unknown narration field; use voice or captions.")
    out = {"voice": value.get("voice", DEFAULT_VOICE), "captions": value.get("captions", True)}
    if not isinstance(out["voice"], str) or not VOICE_ID.fullmatch(out["voice"]):
        _error("narration.voice", "use a Kokoro voice id such as af_heart or bm_george.")
    if not isinstance(out["captions"], bool):
        _error("narration.captions", "use true or false.")
    return out


def speech_key(voice, say):
    """The cache key of a spoken line: the voice, the text, and the account's Pronunciations entries for words in it
    (core/pronunciations.signature), so a pronunciation edit re-speaks only the lines it changes. A line with no
    listed word keeps the key it had before pronunciations counted."""
    from core import pronunciations
    line = " ".join(say.split())
    said = pronunciations.signature(line)
    return hashlib.sha256(f"kokoro|{voice}|{line}{'|' + said if said else ''}".encode("utf-8")).hexdigest()[:16]


def _timing(b, narration, path):
    """Derive the beat's seconds; keep `spoken` only while it still measures this line in this voice."""
    b.pop("seconds", None)
    if "say" not in b:
        b.pop("spoken", None)
        return
    spoken = b.get("spoken")
    if spoken is not None:
        ok = (isinstance(spoken, dict) and set(spoken) - {"mouth"} == {"key", "seconds", "parts"} and isinstance(spoken["key"], str)
              and isinstance(spoken["parts"], list) and isinstance(spoken["seconds"], (int, float))
              and not isinstance(spoken["seconds"], bool) and math.isfinite(spoken["seconds"])
              and 0 < spoken["seconds"] <= 60 and 1 <= len(spoken["parts"]) <= 40)
        if ok:
            for part in spoken["parts"]:
                ok = ok and (isinstance(part, list) and len(part) == 3 and isinstance(part[2], str) and len(part[2]) <= SAY_LIMIT
                             and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in part[:2])
                             and 0 <= part[0] < part[1] <= LEAD + spoken["seconds"] + 1e-6)
        if ok and "mouth" in spoken:
            ok = (isinstance(spoken["mouth"], str) and re.fullmatch(r"[XAEOMF]{1,2000}", spoken["mouth"]) is not None
                  and len(spoken["mouth"]) <= math.ceil((LEAD + spoken["seconds"]) * 30) + 2)
        if not ok:
            _error(path + ".spoken", "leave spoken to the narration step (video_narrate); it is measured, not written.")
        if spoken["key"] != speech_key(narration["voice"], b["say"]):
            b.pop("spoken")       # the line or the voice changed: the next narration pass measures it again
    speech = b["spoken"]["seconds"] if "spoken" in b else estimate(b["say"])
    b["seconds"] = math.ceil((LEAD + speech + TAIL) * 30 - 1e-6) / 30


def estimate(say):
    """Seconds of speech before it is measured (about 2.6 words a second); replaced by the measured length."""
    return round(len(say.split()) / 2.6 + .2 * max(0, len(clauses(say)) - 1), 3)


def narrated(project) -> bool:
    return any("say" in b for b in project["beats"])


def beat_seconds(beat, bpm) -> float:
    return beat["seconds"] if "seconds" in beat else beat["bars"] * 240 / bpm


def duration(project) -> float:
    return sum(beat_seconds(b, project.get("bpm", 120)) for b in project["beats"])


def get(video_id) -> dict:
    data = read_json(str(_folder(video_id) / "project.json"), None)
    if not isinstance(data, dict):
        raise LookupError("No such video.")
    return data


def require_user_access(video_id, user, is_admin=False):
    data = get(video_id)
    if not visible_to(data, user, is_admin):
        raise LookupError("No such video.")
    return data


def require_chat_access(video_id, key):
    data = get(video_id)
    if not key or key not in data.get("chat_ids", []):
        raise AccessError("This chat cannot change that video. Use the chat that created it or link it to this chat.")
    return data


def list_for_user(user, is_admin=False):
    return [p for p in _list() if visible_to(p, user, is_admin)]


def _list():
    out = []
    for path in Path(videos_dir()).glob("????????????/project.json"):
        try:
            out.append(get(path.parent.name))
        except LookupError:
            continue
    return sorted(out, key=lambda p: p["updated"], reverse=True)


def videos_for_chat(key):
    return [p for p in _list() if key and key in p.get("chat_ids", [])]


def create(title, *, look, beats, owner, chat_key_=None, **options):
    p = validate({"id": secrets.token_hex(6), "title": title, "look": look, "beats": beats, **options})
    p.update(owner=owner, chat_ids=[chat_key_] if chat_key_ else [], visible_to=[], version=1,
             created=time.time(), updated=time.time())
    folder = _folder(p["id"])
    for name in ("assets", "renders", "history"):
        (folder / name).mkdir(parents=True, exist_ok=True)
    write_json_atomic(str(folder / "project.json"), p)
    write_json_atomic(str(folder / "history" / "1.json"), p)
    return p


def save(video_id, project):
    with _lock("video:" + video_id):
        old = get(video_id)
        p = validate(project)
        if p["id"] != video_id:
            _error("id", "a saved video's id cannot change.")
        p.update({k: old[k] for k in META})
        p.update(version=old["version"] + 1, updated=time.time())
        folder = _folder(video_id)
        write_json_atomic(str(folder / "history" / f"{p['version']}.json"), p)
        write_json_atomic(str(folder / "project.json"), p)
        for path in sorted((folder / "history").glob("*.json"), key=lambda x: int(x.stem))[:-30]:
            path.unlink()
        return p


def history(video_id):
    get(video_id)
    return [read_json(str(p), {}) for p in sorted((_folder(video_id) / "history").glob("*.json"),
                                                key=lambda p: int(p.stem), reverse=True)]


def restore(video_id, version):
    with _lock("video:" + video_id):
        get(video_id)
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise ValueError("version: choose a version from history.")
        p = read_json(str(_folder(video_id) / "history" / f"{version}.json"), None)
        if p is None:
            raise LookupError("That video version is no longer in history.")
        return save(video_id, p)


def link_chat(video_id, key):
    with _lock("video:" + video_id):
        p = get(video_id)
        p["chat_ids"] = list(dict.fromkeys(p["chat_ids"] + [key]))[-20:]
        write_json_atomic(str(_folder(video_id) / "project.json"), p)
        return p


def delete(video_id):
    with _lock("video:" + video_id):
        get(video_id)
        folder = _folder(video_id).resolve()
        if folder.parent != Path(videos_dir()).resolve():
            raise ValueError("Video folder is outside the video store.")
        shutil.rmtree(folder)


def add_asset(video_id, raw=None, ext=None, *, design_id=None, asset=None, user=None, is_admin=False, key=None):
    """Copy only an authorized design's image; paths never select arbitrary files."""
    with _lock("video:" + video_id):
        get(video_id)
        if design_id is not None:
            if key:
                design_store.require_chat_access(design_id, key)
            else:
                design_store.require_user_access(design_id, user, is_admin)
            if not isinstance(asset, str) or not ASSET.fullmatch(asset):
                raise ValueError("asset: use the design's assets/<sha256>.<ext> path.")
            source = design_store.asset_path(design_id, asset[7:])
            raw, ext = source.read_bytes(), source.suffix[1:]
        ext = str(ext or "").lower().lstrip(".").replace("jpeg", "jpg")
        if ext not in ("png", "jpg", "gif", "webp") or not isinstance(raw, bytes) or not raw:
            raise ValueError("asset: upload a PNG, JPEG, GIF or WebP image.")
        if len(raw) > design_store.MAX_ASSET_BYTES:
            raise ValueError("asset: choose an image under 25 MB.")
        try:
            with Image.open(io.BytesIO(raw)) as im:
                if im.width * im.height > 40_000_000 or im.format not in ("PNG", "JPEG", "GIF", "WEBP"):
                    raise ValueError("asset: choose an image under 40 megapixels.")
                im.verify()
        except OSError:
            raise ValueError("asset: this image could not be read.") from None
        name = hashlib.sha256(raw).hexdigest() + "." + ext
        folder = _folder(video_id) / "assets"
        path = folder / name
        if not path.exists():
            if sum(p.stat().st_size for p in folder.iterdir()) + len(raw) > 100 * 1024 * 1024:
                raise ValueError("asset: this video's images would exceed 100 MB.")
            temp = folder / (name + ".tmp")
            temp.write_bytes(raw)
            os.replace(temp, path)
        return "assets/" + name


def credits(video_id):
    """Licensed photo attributions for this video's own assets."""
    stored = read_json(str(_folder(video_id) / "credits.json"), {})
    return dict(list(stored.items())[-200:]) if isinstance(stored, dict) else {}


def add_credit(video_id, asset, credit):
    """Keep the fields needed for attribution, for an asset this video holds."""
    if not isinstance(asset, str) or not ASSET.fullmatch(asset):
        raise ValueError("A credit belongs to an asset in this video.")
    asset_path(video_id, asset[len("assets/"):])
    if not isinstance(credit, dict):
        raise ValueError("Give the photo's credit details.")
    with _lock("video:" + video_id):
        stored = credits(video_id)
        stored[asset] = {key: str(credit.get(key) or "")[:4000] for key in (
            "title", "creator", "license", "license_version", "license_url", "landing", "attribution")}
        write_json_atomic(str(_folder(video_id) / "credits.json"), dict(list(stored.items())[-200:]))


def asset_path(video_id, name):
    if not isinstance(name, str) or not ASSET.fullmatch("assets/" + name):
        raise LookupError("No such video asset.")
    path = _folder(video_id) / "assets" / name
    if not path.is_file():
        raise LookupError("No such video asset.")
    return path

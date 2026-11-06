"""Versioned video beat sheets, isolated by owner and explicit chat links.

Validation returns a copy so failed edits never change the stored project.
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
KINDS = ("title", "statement", "big-number", "list", "image", "quote", "split", "logo", "end")
CAMERAS = ("still", "push", "pull", "pan", "shake")
TRANSITIONS = ("cut", "whip", "zoom", "flip", "dither", "mosaic", "wipe")
MOODS = ("energetic", "calm", "warm", "dark", "playful")
ASSET = re.compile(r"assets/[a-f0-9]{64}\.(?:png|jpg|gif|webp)")
FIELDS = {"id", "title", "look", "bpm", "fps", "aspects", "beats", "music"}
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
    if not isinstance(beats, list) or not 1 <= len(beats) <= 40:
        _error("beats", "give 1 to 40 beats.")
    ids = set()
    allowed = {"id", "kind", "bars", "text", "sub", "number", "items", "image", "camera", "transition", "treatment"}
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
    if duration(p) > 120:
        _error("beats", "total duration must be at most 120 seconds; reduce bars or raise bpm.")
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


def duration(project) -> float:
    return sum(b["bars"] for b in project["beats"]) * 240 / project.get("bpm", 120)


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

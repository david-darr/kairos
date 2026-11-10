"""Tracks and clips on top of the beat sheet (Content Studio Editor build spec, step 3).

The beats stay the video's main picture track, exactly as before: a video without `tracks` is the same video it always
was, and nothing about its timing changes. `tracks` adds layers over it:

- overlay tracks hold text, image and shape clips, drawn over the beats in track order (the first track lowest, the
  last on top) and under the burned-in captions (static/motion/overlay.js draws them inside the engine's drawFrame(t));
- audio tracks hold sound clips from the person's own files (uploaded to the video, never fetched), mixed into the
  soundtrack (core/video_audio.py).

A clip sits on the timeline at `start` (seconds) and plays its own time from `in` to `out`; its length is out - in. A
text, image or shape clip has no source length, so `in` only shifts where its fades sit; a sound clip's in and out
trim its file. Clips on one track never overlap. Each clip has an opacity (sound: a volume) and simple fades in and
out. A hidden track draws nothing (an audio track is muted); a locked track's clips cannot be changed by video_edit
operations (models included), only by the person in Studio after unlocking it.

Everything here is data checked against fixed lists and ranges; nothing in a clip runs. Positions are shares of the
frame (x, y, w, h from 0 to 1), so a clip keeps its place in every aspect.
"""
from __future__ import annotations

import copy
import math
import re

TRACK_KINDS = ("overlay", "audio")
CLIP_KINDS = {"overlay": ("text", "image", "shape"), "audio": ("sound",)}
MAX_TRACKS, MAX_TRACK_CLIPS, MAX_CLIPS = 8, 60, 200
COLORS = ("text", "dim", "accent", "accent-2", "bg", "surface", "white", "black")
SHAPES = ("rect", "ellipse", "line", "arrow")
TEXT_STYLES = ("card", "plain")
ROLES = ("title", "body")
ALIGNS = ("left", "center", "right")
FITS = ("contain", "cover")
TEXT_LIMIT, NAME_LIMIT = 140, 40
LONGEST = 1200.0               # the longest video (core/video_store.CHAPTERED_MAX_SECONDS)
FADE_MAX = 10.0
SOUND_MAX_SECONDS = 180.0      # one sound file's length (core/video_store.add_audio)
ID = re.compile(r"[a-zA-Z][a-zA-Z0-9_-]{0,47}")
IMAGE = re.compile(r"assets/[a-f0-9]{64}\.(?:png|jpg|gif|webp)")
AUDIO = re.compile(r"assets/[a-f0-9]{64}\.wav")
COMMON = ("id", "kind", "start", "in", "out", "opacity", "fade_in", "fade_out")
FIELDS = {"text": COMMON + ("text", "box", "role", "style", "color", "align"),
          "image": COMMON + ("image", "box", "fit"),
          "shape": COMMON + ("shape", "box", "color", "fill", "stroke"),
          "sound": ("id", "kind", "start", "in", "out", "volume", "fade_in", "fade_out", "audio")}
# A clip's editable fields for video_edit (op clip_set); id and kind are fixed once a clip exists.
SETTABLE = {kind: tuple(f for f in fields if f not in ("id", "kind")) for kind, fields in FIELDS.items()}
DEFAULT_BOX = {"text": {"x": .1, "y": .08, "w": .8, "h": .16}, "image": {"x": .62, "y": .08, "w": .3, "h": .3},
               "shape": {"x": .1, "y": .7, "w": .3, "h": .06}}
TRACK_NAMES = {"overlay": "Overlay", "audio": "Sound"}


def _error(path, message):
    raise ValueError(f"{path}: {message}")


def _number(value, path, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        _error(path, f"give a number from {low:g} to {high:g}.")
    return round(float(value), 4)


def _choice(value, path, choices):
    if value not in choices:
        _error(path, "choose " + ", ".join(choices) + ".")
    return value


def length(clip) -> float:
    return clip["out"] - clip["in"]


def end(clip) -> float:
    return clip["start"] + length(clip)


def validate(p: dict, audio_seconds=None) -> None:
    """Check and complete p["tracks"] in place (a deep copy from video_store.validate). An empty list is removed, so a
    video without overlays is stored exactly as before. `audio_seconds(name)` gives an uploaded sound's length, or
    None when this video does not hold that file."""
    if "tracks" not in p:
        return
    tracks = p["tracks"]
    if tracks is None or tracks == []:
        p.pop("tracks")
        return
    if not isinstance(tracks, list) or len(tracks) > MAX_TRACKS:
        _error("tracks", f"give at most {MAX_TRACKS} tracks, each {{id, kind, name, clips}}.")
    track_ids, clip_ids, count = set(), set(), 0
    beat_ids = {b.get("id") for b in p.get("beats") or [] if isinstance(b, dict)}
    for i, track in enumerate(tracks):
        path = f"tracks[{i}]"
        if not isinstance(track, dict):
            _error(path, "give a track object {id, kind, name, hidden, locked, clips}.")
        for key in track.keys() - {"id", "kind", "name", "hidden", "locked", "clips"}:
            _error(f"{path}.{key}", "unknown track field; use id, kind, name, hidden, locked or clips.")
        if not isinstance(track.get("id"), str) or not ID.fullmatch(track["id"]) or track["id"] in track_ids:
            _error(path + ".id", "use a unique id: a letter followed by up to 47 letters, numbers, dashes or underscores.")
        track_ids.add(track["id"])
        _choice(track.get("kind"), path + ".kind", TRACK_KINDS)
        track.setdefault("name", TRACK_NAMES[track["kind"]])
        if not isinstance(track["name"], str) or not track["name"].strip() or len(track["name"]) > NAME_LIMIT or any(c in track["name"] for c in "\r\n\t<>"):
            _error(path + ".name", f"give a name of 1 to {NAME_LIMIT} characters on one line, without < or >.")
        for flag in ("hidden", "locked"):
            track.setdefault(flag, False)
            if not isinstance(track[flag], bool):
                _error(f"{path}.{flag}", "use true or false.")
        clips = track.setdefault("clips", [])
        if not isinstance(clips, list) or len(clips) > MAX_TRACK_CLIPS:
            _error(path + ".clips", f"give at most {MAX_TRACK_CLIPS} clips on a track.")
        count += len(clips)
        if count > MAX_CLIPS:
            _error("tracks", f"a video holds at most {MAX_CLIPS} clips in all.")
        for j, clip in enumerate(clips):
            _clip(clip, f"{path}.clips[{j}]", track["kind"], audio_seconds)
            if clip["id"] in clip_ids or clip["id"] in beat_ids:
                _error(f"{path}.clips[{j}].id", "each clip needs an id no other clip or beat has.")
            clip_ids.add(clip["id"])
        clips.sort(key=lambda c: (c["start"], c["id"]))
        for a, b in zip(clips, clips[1:]):
            if end(a) > b["start"] + 1e-6:
                _error(f"{path}.clips", f"clips {a['id']} and {b['id']} overlap on this track; move one later or onto another track.")


def _box(value, path):
    if not isinstance(value, dict) or set(value) != {"x", "y", "w", "h"}:
        _error(path, "give {x, y, w, h} as shares of the frame (0 to 1).")
    box = {k: _number(value[k], f"{path}.{k}", 0, 1) for k in ("x", "y", "w", "h")}
    if box["w"] < .01 or box["h"] < .01:
        _error(path, "make the box at least 0.01 of the frame across and down.")
    if box["x"] + box["w"] > 1.0001 or box["y"] + box["h"] > 1.0001:
        _error(path, "keep the box inside the frame (x + w and y + h at most 1).")
    return box


def _clip(clip, path, track_kind, audio_seconds):
    if not isinstance(clip, dict):
        _error(path, "give a clip object.")
    kind = clip.get("kind")
    if kind not in CLIP_KINDS[track_kind]:
        _error(path + ".kind", f"an {track_kind} track holds " + " or ".join(CLIP_KINDS[track_kind]) + " clips.")
    for key in sorted(clip.keys() - set(FIELDS[kind])):
        _error(f"{path}.{key}", f"unknown {kind} clip field; use " + ", ".join(FIELDS[kind]) + ".")
    if not isinstance(clip.get("id"), str) or not ID.fullmatch(clip["id"]):
        _error(path + ".id", "use a letter followed by up to 47 letters, numbers, dashes or underscores.")
    clip["start"] = _number(clip.get("start"), path + ".start", 0, LONGEST)
    clip["in"] = _number(clip.get("in", 0), path + ".in", 0, LONGEST)
    clip["out"] = _number(clip.get("out"), path + ".out", 0, LONGEST)
    if length(clip) < 1 / 30 - 1e-3:     # times are kept to 4 decimal places
        _error(path + ".out", "a clip lasts at least one frame (out after in).")
    for key in ("fade_in", "fade_out"):
        clip[key] = _number(clip.get(key, 0), f"{path}.{key}", 0, FADE_MAX)
    if clip["fade_in"] + clip["fade_out"] > length(clip) + 1e-6:
        _error(path + ".fade_in", "the fades in and out together cannot be longer than the clip.")
    if kind == "sound":
        clip["volume"] = _number(clip.get("volume", .8), path + ".volume", 0, 1)
        if not isinstance(clip.get("audio"), str) or not AUDIO.fullmatch(clip["audio"]):
            _error(path + ".audio", "use assets/<sha256>.wav from a sound file uploaded to this video.")
        seconds = audio_seconds(clip["audio"]) if audio_seconds else None
        if audio_seconds and seconds is None:
            _error(path + ".audio", "this video holds no such sound; upload the file to the video first.")
        if seconds is not None and clip["out"] > seconds + 1 / 30:
            _error(path + ".out", f"the sound is {seconds:.2f} seconds long; end the clip at or before that.")
        return
    clip["opacity"] = _number(clip.get("opacity", 1), path + ".opacity", 0, 1)
    clip["box"] = _box(clip.get("box", copy.deepcopy(DEFAULT_BOX[kind])), path + ".box")
    if kind == "text":
        text = clip.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > TEXT_LIMIT:
            _error(path + ".text", f"give text of 1 to {TEXT_LIMIT} characters.")
        for key, choices, default in (("role", ROLES, "title"), ("style", TEXT_STYLES, "card"), ("color", COLORS, "text"),
                                      ("align", ALIGNS, "center")):
            clip[key] = _choice(clip.get(key, default), f"{path}.{key}", choices)
    elif kind == "image":
        if not isinstance(clip.get("image"), str) or not IMAGE.fullmatch(clip["image"]):
            _error(path + ".image", "use assets/<sha256>.png, .jpg, .gif or .webp from this video's images.")
        clip["fit"] = _choice(clip.get("fit", "contain"), path + ".fit", FITS)
    else:
        clip["shape"] = _choice(clip.get("shape", "rect"), path + ".shape", SHAPES)
        clip["color"] = _choice(clip.get("color", "accent"), path + ".color", COLORS)
        clip.setdefault("fill", clip["shape"] in ("rect", "ellipse"))
        if not isinstance(clip["fill"], bool):
            _error(path + ".fill", "use true or false.")
        clip["stroke"] = _number(clip.get("stroke", .006), path + ".stroke", .001, .05)


# -- reading --------------------------------------------------------------------------------------------------------

def tracks_of(project) -> list:
    return project.get("tracks") or []


def find_clip(project, clip_id):
    """(track, clip, index) of a clip id, or raises ValueError naming it."""
    for track in tracks_of(project):
        for i, clip in enumerate(track["clips"]):
            if clip["id"] == clip_id:
                return track, clip, i
    raise ValueError(f"id: no clip {clip_id}; read video_outline for clip ids.")


def find_track(project, track_id):
    for i, track in enumerate(tracks_of(project)):
        if track["id"] == track_id:
            return track, i
    raise ValueError(f"track: no track {track_id}; read video_outline for track ids.")


def clips_in(project, start, stop, kinds=("overlay",)):
    """Visible clips of the given track kinds that show between start and stop seconds (a chapter's part)."""
    out = []
    for track in tracks_of(project):
        if track["kind"] in kinds and not track["hidden"]:
            out += [{"track": track["id"], **c} for c in track["clips"] if c["start"] < stop and end(c) > start]
    return out


def check_frames(project, first_frame, last_frame, limit=8) -> set:
    """Frames for the post-render checks to look at: the middle of each visible text clip inside [first, last], so its
    contrast against what is really behind it is measured on a rendered frame."""
    picks = []
    for clip in clips_in(project, first_frame / 30, (last_frame + 1) / 30):
        if clip["kind"] == "text":
            frame = int((clip["start"] + end(clip)) / 2 * 30)
            if first_frame <= frame <= last_frame:
                picks.append(frame)
    picks = sorted(set(picks))
    if len(picks) > limit:
        picks = [picks[round(i * (len(picks) - 1) / (limit - 1))] for i in range(limit)]
    return set(picks)


def clock(t) -> str:
    t = max(0.0, float(t))
    return f"{int(t // 60)}:{t % 60:04.1f}"


def describe_clip(clip) -> str:
    if clip["kind"] == "text":
        return f'text "{clip["text"]}"'
    if clip["kind"] == "image":
        return f"image {clip['image'][7:19]}"
    if clip["kind"] == "shape":
        return f"{clip['color']} {clip['shape']}"
    return f"sound {clip['audio'][7:19]}"


def outline_lines(project) -> list[str]:
    """The tracks for video_outline: one line per track and clip, with ids and times."""
    lines = []
    for track in tracks_of(project):
        flags = [f for f in ("hidden", "locked") if track[f]]
        lines.append(f"Track {track['id']} ({track['kind']}, \"{track['name']}\"" + (", " + ", ".join(flags) if flags else "") + ")")
        for clip in track["clips"]:
            extra = f", volume {clip['volume']:g}" if clip["kind"] == "sound" else f", opacity {clip['opacity']:g}"
            box = clip.get("box")
            where = f", box x{box['x']:g} y{box['y']:g} w{box['w']:g} h{box['h']:g}" if box else ""
            lines.append(f"  - clip {clip['id']} {round(clip['start'], 2):g}-{round(end(clip), 2):g}s {describe_clip(clip)}{extra}{where}"
                         + (f", fades {clip['fade_in']:g}/{clip['fade_out']:g}s" if clip["fade_in"] or clip["fade_out"] else ""))
    return lines


def timeline(project) -> dict:
    """The whole timeline as one JSON view for a model or a person: the beats as the main picture track (with their
    narration), then every overlay and audio track. Read only; times in seconds."""
    from core import video_store
    beats, at = [], 0.
    for b in project["beats"]:
        seconds = video_store.beat_seconds(b, project.get("bpm", 120))
        item = {"id": b["id"], "kind": b["kind"], "start": round(at, 3), "end": round(at + seconds, 3)}
        for key in ("text", "sub", "number", "items", "image", "camera", "transition", "say"):
            if key in b:
                item[key] = b[key]
        for key in ("scene", "stage"):
            if key in b:
                item[key] = b[key]
        beats.append(item)
        at += seconds
    out = {"title": project["title"], "duration": round(at, 3), "fps": 30, "aspects": project["aspects"],
           "tracks": [{"id": "beats", "kind": "beats", "name": "Beats (the main picture)", "clips": beats}]}
    if project.get("chapters"):
        out["chapters"] = project["chapters"]
    for track in tracks_of(project):
        out["tracks"].append({**{k: track[k] for k in ("id", "kind", "name", "hidden", "locked")},
                              "clips": [{**c, "end": round(end(c), 3)} for c in track["clips"]]})
    out["music"] = project.get("music")
    return out


# -- operations (video_edit) ----------------------------------------------------------------------------------------

def _unique(project, base):
    taken = {b["id"] for b in project["beats"]} | {c["id"] for t in tracks_of(project) for c in t["clips"]} | \
            {t["id"] for t in tracks_of(project)}
    n = 1
    while f"{base}{n}" in taken:
        n += 1
    return f"{base}{n}"


def _unlocked(track, n):
    if track.get("locked"):
        raise ValueError(f"ops[{n}]: track {track['id']} (\"{track['name']}\") is locked; the person unlocks it in Studio "
                         "before its clips can change.")


def apply_op(draft, op, n, agent=False):
    """One clip or track operation on a draft project (validated afterwards by video_store.validate).

    ops: track_add {track: {kind, name?, id?}}; track_set {id, field: name|hidden|locked, value}; track_remove {id};
    track_move {id, to}; clip_add {track, clip}; clip_set {id, field, value}; clip_remove {id, ripple?};
    clip_move {id, track?, start?}; clip_trim {id, start? (new left edge), end? (new right edge)}; clip_split {id, at}.
    `agent` (a model asking from Studio's Ask Kairos) may not lock or unlock a track."""
    kind = op.get("op")
    tracks = draft.setdefault("tracks", [])
    if kind == "track_add":
        track = copy.deepcopy(op.get("track"))
        if not isinstance(track, dict) or track.get("kind") not in TRACK_KINDS:
            raise ValueError(f"ops[{n}].track: give {{kind: overlay or audio, name}}.")
        track.setdefault("id", _unique(draft, "t"))
        track.setdefault("clips", [])
        if agent and track.get("locked"):
            raise ValueError(f"ops[{n}].track.locked: only the person locks a track.")
        tracks.insert(op["to"] if isinstance(op.get("to"), int) and 0 <= op["to"] <= len(tracks) else len(tracks), track)
        return
    if kind == "track_set":
        track, _ = find_track(draft, op.get("id"))
        field = op.get("field")
        if field not in ("name", "hidden", "locked") or "value" not in op:
            raise ValueError(f"ops[{n}].field: a track's name, hidden or locked, with value.")
        if field == "locked" and agent:
            raise ValueError(f"ops[{n}].field: only the person locks or unlocks a track.")
        if field != "locked":
            _unlocked(track, n)
        track[field] = op["value"]
        return
    if kind == "track_remove":
        track, i = find_track(draft, op.get("id"))
        _unlocked(track, n)
        tracks.pop(i)
        return
    if kind == "track_move":
        track, i = find_track(draft, op.get("id"))
        to = op.get("to")
        if isinstance(to, bool) or not isinstance(to, int) or not 0 <= to < len(tracks):
            raise ValueError(f"ops[{n}].to: give the track's new place, 0 (lowest) to {len(tracks) - 1} (on top).")
        tracks.insert(to, tracks.pop(i))
        return
    if kind == "clip_add":
        track, _ = find_track(draft, op.get("track"))
        _unlocked(track, n)
        clip = copy.deepcopy(op.get("clip"))
        if not isinstance(clip, dict):
            raise ValueError(f"ops[{n}].clip: give a clip object.")
        clip.setdefault("id", _unique(draft, "k"))
        clip.setdefault("in", 0)
        if "out" not in clip and isinstance(clip.get("length"), (int, float)):
            clip["out"] = clip["in"] + clip.pop("length")
        track["clips"].append(clip)
        return
    track, clip, index = find_clip(draft, op.get("id"))
    _unlocked(track, n)
    if kind == "clip_set":
        field = op.get("field")
        if field not in SETTABLE.get(clip.get("kind"), ()) or "value" not in op:
            raise ValueError(f"ops[{n}].field: a {clip.get('kind')} clip's fields are " + ", ".join(SETTABLE.get(clip.get("kind"), ())) + ".")
        clip[field] = copy.deepcopy(op["value"])
    elif kind == "clip_remove":
        track["clips"].pop(index)
        if op.get("ripple"):
            gone = length(clip)
            for other in track["clips"]:
                if other["start"] >= clip["start"]:
                    other["start"] = round(other["start"] - gone, 4)
    elif kind == "clip_move":
        if "track" in op and op["track"] != track["id"]:
            target, _ = find_track(draft, op["track"])
            _unlocked(target, n)
            if target["kind"] != track["kind"]:
                raise ValueError(f"ops[{n}].track: a {clip['kind']} clip moves only to another {track['kind']} track.")
            track["clips"].pop(index)
            target["clips"].append(clip)
        if "start" in op:
            clip["start"] = op["start"]
    elif kind == "clip_trim":
        if "start" in op:
            delta = _number(op["start"], f"ops[{n}].start", 0, LONGEST) - clip["start"]
            clip["start"], clip["in"] = round(clip["start"] + delta, 4), round(clip["in"] + delta, 4)
        if "end" in op:
            clip["out"] = round(clip["in"] + _number(op["end"], f"ops[{n}].end", 0, LONGEST) - clip["start"], 4)
    elif kind == "clip_split":
        at = _number(op.get("at"), f"ops[{n}].at", 0, LONGEST)
        if not clip["start"] + 1 / 30 <= at <= end(clip) - 1 / 30:
            raise ValueError(f"ops[{n}].at: split inside the clip, between {clip['start']:g} and {end(clip):g} seconds.")
        second = split(clip, at, _unique(draft, clip["id"] + "-"))
        track["clips"].insert(index + 1, second)
    else:
        raise ValueError(f"ops[{n}].op: choose set, insert, remove, move, project, track_add, track_set, track_remove, "
                         "track_move, clip_add, clip_set, clip_remove, clip_move, clip_trim or clip_split.")


def split(clip, at, new_id):
    """Cut a clip at timeline time `at`: the clip keeps the part before, the returned clip is the part after. A fade
    in stays with the first part and a fade out with the second."""
    cut = round(clip["in"] + at - clip["start"], 4)
    second = {**copy.deepcopy(clip), "id": new_id, "start": round(at, 4), "in": cut, "fade_in": 0}
    clip["out"], clip["fade_out"] = cut, 0
    clip["fade_in"] = min(clip["fade_in"], length(clip))
    second["fade_out"] = min(second["fade_out"], length(second))
    return second


OP_HELP = ("Tracks and clips (layers over the beats): track_add {op:track_add, track:{kind: overlay|audio, name}}; "
           "track_set {op:track_set, id, field: name|hidden, value}; track_remove {op:track_remove, id}; track_move {op:track_move, id, to}; "
           "clip_add {op:clip_add, track, clip}; clip_set {op:clip_set, id, field, value}; clip_remove {op:clip_remove, id, ripple: true "
           "closes the gap}; clip_move {op:clip_move, id, track?, start?}; clip_trim {op:clip_trim, id, start? (new left edge, seconds), "
           "end? (new right edge)}; clip_split {op:clip_split, id, at (seconds)}. An overlay track holds text {text, box, role title|body, "
           "style card|plain, color text|dim|accent|accent-2|bg|surface|white|black, align left|center|right}, image {image: assets/<sha>.png "
           "from this video, box, fit contain|cover} and shape {shape rect|ellipse|line|arrow, box, color, fill, stroke 0.001-0.05} clips; "
           "an audio track holds sound {audio: assets/<sha>.wav uploaded by the person, volume 0-1} clips. Every clip has start (seconds "
           "on the timeline), in and out (its own time; length = out - in), fade_in, fade_out, and (pictures) opacity 0-1; box is "
           "{x, y, w, h} as shares of the frame. Clips on one track never overlap; later tracks draw on top; captions stay above all. "
           "A locked track cannot change. ")

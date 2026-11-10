"""Video review notes from sampled layout, images and encoded loudness.

These are actionable observations, not a claim that a person watched the film.
"""
import io
import math
import re
from PIL import Image, ImageColor, ImageStat
from core.video_store import ASPECTS, beat_seconds


def _luminance(color):
    try:
        if str(color).startswith("rgb"):
            values = [float(x) / 255 for x in re.findall(r"[\d.]+", color)[:3]]
        else:
            values = [x / 255 for x in ImageColor.getrgb(color)[:3]]
        if len(values) != 3:
            return None
        linear = [x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4 for x in values]
        return sum(a * b for a, b in zip(linear, (.2126, .7152, .0722)))
    except (ValueError, TypeError):
        return None


VARIETY = ("Most beats are plain statements, so the video reads like slides of text. Vary them: big-number for a "
           "figure, list for 3 to 5 points, quote for a line someone said, image or split with a photo from image_search.")


def variety(project):
    """The 2026-11-04 benchmark videos were about 60% statements and had no pictures."""
    body = [b for b in project["beats"] if b["kind"] not in ("end", "title", "logo")]
    if len(body) < 4:
        return []
    statements = [b["kind"] == "statement" for b in body]
    in_a_row = max((len(run) for run in "".join("s" if s else "." for s in statements).split(".")), default=0)
    if sum(statements) > len(body) / 2 or in_a_row >= 3:
        return [VARIETY]
    return []


def credit_notes(project):
    """A licensed photo's credit must be on screen somewhere in the video."""
    from core import video_store
    try:
        stored = video_store.credits(project["id"])
    except (LookupError, KeyError):
        return []
    used = {b.get("image") for b in project["beats"] if b.get("image")}
    shown = " ".join(str(b.get(k, "")) for b in project["beats"] for k in ("text", "sub")).lower()
    missing = [c for asset, c in stored.items() if asset in used and str(c.get("creator") or "").lower() not in shown]
    if missing:
        return ["A photo's credit is not on screen; put its credit line (Photo: title by creator, license) in that "
                "beat's sub or the end card's sub."]
    return []


def _words(text):
    return re.findall(r"[a-z0-9']+", str(text).lower().replace("’", "'"))


def narration_notes(project, voice=None):
    """Quality checks for the narration track (build spec section 5): the captions are the script's own words in
    order, every line was spoken, and the voice neither clipped nor sank into the music."""
    notes = []
    for b in project["beats"]:
        if "say" not in b:
            continue
        spoken = b.get("spoken")
        if not spoken:
            notes.append(f"Beat {b['id']}'s line is not narrated yet; run video_narrate.")
            continue
        if _words(" ".join(part[2] for part in spoken["parts"])) != _words(b["say"]):
            notes.append(f"Beat {b['id']}'s captions do not match its script line; narrate it again.")
    if voice:
        if voice.get("voice_clipped_samples"):
            notes.append(f"The narration clipped in {voice['voice_clipped_samples']} samples; reword or split the loudest line.")
        if voice.get("mix_peak_dbfs") is not None and voice["mix_peak_dbfs"] > -1:
            notes.append("The narration mix peaks above -1 dBFS; it may clip after encoding.")
        margin = voice.get("voice_over_music_db")
        if margin is not None and margin < 15:
            notes.append(f"The voice is only {margin:g} dB over the music; lower the music volume.")
    return notes


def check(project, aspect="16:9", layouts=None, frames=None, loudness=None, voice=None):
    """Accept samples as {time, elements: kdLayout(t)}; deduplicate repeated notes."""
    w, h = ASPECTS[aspect]
    left, right = w * .05, w * .95
    top, bottom = h * (.08 if aspect == "9:16" else .05), h * (.88 if aspect == "9:16" else .95)
    notes = []
    for b in project["beats"]:
        seconds = beat_seconds(b, project["bpm"])
        words = len(" ".join([str(b.get(k, "")) for k in ("text", "sub", "number")] + b.get("items", [])).split())
        if seconds < 1:
            notes.append(f"Beat {b['id']} is under 1 second; give it more time.")
        if words / seconds > 3.5:
            notes.append(f"Beat {b['id']} reads faster than 3.5 words/s; shorten the copy or add bars.")
    if project["beats"][-1]["kind"] == "end" and beat_seconds(project["beats"][-1], project["bpm"]) < 1.5:
        notes.append("The end card is held under 1.5 seconds; give the call to action longer.")
    notes += variety(project)
    notes += credit_notes(project)
    notes += narration_notes(project, voice)
    said = {b["id"]: _words(b.get("say", "")) for b in project["beats"]}
    for sample in layouts or []:
        for box in sample.get("elements", []):
            if not box.get("text"):
                continue
            label = box.get("beat", "?")
            if box.get("truncated"):
                notes.append(f"Beat {label}'s text is cut off with an ellipsis; shorten it.")
            if (box.get("x", 0) < left or box.get("y", 0) < top or
                    box.get("x", 0) + box.get("w", 0) > right or box.get("y", 0) + box.get("h", 0) > bottom):
                notes.append(f"Beat {label} has text outside the safe area; move it inward.")
            fg, bg = _luminance(box.get("color")), _luminance(box.get("bg"))
            if fg is not None and bg is not None and (max(fg, bg) + .05) / (min(fg, bg) + .05) < 4.5:
                notes.append(f"Beat {label} has text contrast under 4.5:1; strengthen the text or background color.")
    # Use the worker's actual visible text too, since layout can reveal extra text.
    lengths = {b["id"]: beat_seconds(b, project["bpm"]) for b in project["beats"]}
    for sample in layouts or []:
        groups = {}
        for box in sample.get("elements", []):
            if box.get("role") == "caption":
                words, line = _words(box.get("text", "")), said.get(box.get("beat"), [])
                if not words or not any(line[i:i + len(words)] == words for i in range(len(line) - len(words) + 1)):
                    notes.append(f"A caption in beat {box.get('beat', '?')} is not the script's words; narrate it again.")
                continue
            if box.get("text"):
                groups.setdefault(box.get("beat"), []).append(str(box["text"]))
        for beat, texts in groups.items():
            if beat in lengths and len(" ".join(texts).split()) / lengths[beat] > 3.5:
                notes.append(f"Beat {beat} reads faster than 3.5 words/s; shorten the copy or add bars.")
    for index, raw in enumerate(frames or []):
        with Image.open(io.BytesIO(raw)) as image:
            if max(ImageStat.Stat(image.convert("RGB")).var) < 5:
                notes.append(f"Sample frame {index + 1} is near-blank; check that content is visible.")
    if loudness:
        i, tp = loudness.get("input_i"), loudness.get("input_tp")
        if i is None or not math.isfinite(i) or abs(i + 16) > 1.5:
            notes.append("Soundtrack loudness is off target; aim for -16 LUFS integrated.")
        if tp is None or not math.isfinite(tp) or tp > -1:
            notes.append("Soundtrack true peak is above -1 dBTP; lower the transient peaks.")
    return list(dict.fromkeys(notes))

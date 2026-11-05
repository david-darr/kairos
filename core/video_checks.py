"""Video review notes from sampled layout, images and encoded loudness.

These are actionable observations, not a claim that a person watched the film.
"""
import io
import math
import re
from PIL import Image, ImageColor, ImageStat
from core.video_store import ASPECTS


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


def check(project, aspect="16:9", layouts=None, frames=None, loudness=None):
    """Accept samples as {time, elements: kdLayout(t)}; deduplicate repeated notes."""
    w, h = ASPECTS[aspect]
    left, right = w * .05, w * .95
    top, bottom = h * (.08 if aspect == "9:16" else .05), h * (.88 if aspect == "9:16" else .95)
    notes = []
    seconds_per_bar = 240 / project["bpm"]
    for b in project["beats"]:
        seconds = b["bars"] * seconds_per_bar
        words = len(" ".join([str(b.get(k, "")) for k in ("text", "sub", "number")] + b.get("items", [])).split())
        if seconds < 1:
            notes.append(f"Beat {b['id']} is under 1 second; give it more time.")
        if words / seconds > 3.5:
            notes.append(f"Beat {b['id']} reads faster than 3.5 words/s; shorten the copy or add bars.")
    if project["beats"][-1]["kind"] == "end" and project["beats"][-1]["bars"] * seconds_per_bar < 1.5:
        notes.append("The end card is held under 1.5 seconds; give the call to action longer.")
    for sample in layouts or []:
        for box in sample.get("elements", []):
            if not box.get("text"):
                continue
            label = box.get("beat", "?")
            if (box.get("x", 0) < left or box.get("y", 0) < top or
                    box.get("x", 0) + box.get("w", 0) > right or box.get("y", 0) + box.get("h", 0) > bottom):
                notes.append(f"Beat {label} has text outside the safe area; move it inward.")
            fg, bg = _luminance(box.get("color")), _luminance(box.get("bg"))
            if fg is not None and bg is not None and (max(fg, bg) + .05) / (min(fg, bg) + .05) < 4.5:
                notes.append(f"Beat {label} has text contrast under 4.5:1; strengthen the text or background color.")
    # Use the worker's actual visible text too, since layout can reveal extra text.
    lengths = {b["id"]: b["bars"] * seconds_per_bar for b in project["beats"]}
    for sample in layouts or []:
        groups = {}
        for box in sample.get("elements", []):
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

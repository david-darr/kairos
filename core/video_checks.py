"""Video review notes from sampled layout, images and encoded loudness.

These are actionable observations, not a claim that a person watched the film.
"""
import io
import math
import re
import numpy as np
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
        # A Story Short mixes at the reference's levels (dialogue -15 dB, piano bed -29 dB: 14 dB apart) under a quieter bed.
        least = 12 if voice.get("format") == "story-short" else 15
        if margin is not None and margin < least:
            notes.append(f"The voice is only {margin:g} dB over the music; lower the music volume.")
    return notes


CARD_KINDS = ("title", "end")
_MINOR = {"the", "and", "for", "from", "with", "that", "this", "your", "you", "are", "was", "its", "it's", "our", "not", "but",
          "into", "onto", "about", "what", "why", "how", "who", "has", "have", "had", "can", "will", "all", "out", "too"}


def _content(text):
    return [w for w in _words(text) if len(w) >= 3 and w not in _MINOR]


def _same_word(a, b):
    return a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a)))   # cloud/clouds, weigh/weighs


def speaks_the_card(beat) -> bool:
    """A title or end card carries narration by design when the line speaks the card: at least half of the headline's
    words are in the line ("Look up today" / "Next time you look up..."), or every word of the line is on the card.
    A line about something else is a scene's line that landed on the card."""
    line = _content(beat.get("say", ""))
    if not line:
        return True
    head = _content(beat.get("text", ""))
    if head and 2 * sum(any(_same_word(h, w) for w in line) for h in head) >= len(head):
        return True
    shown = _content(" ".join(str(beat.get(k, "")) for k in ("text", "sub")))
    return bool(shown) and all(any(_same_word(w, s) for s in shown) for w in line)


def card_narration_notes(project, layouts=None):
    """Narration and captions belong to the beats that show them. Named: a title or end card whose own line is not
    its words (the style pack sample captioned "Six months later, your half leans away." on its end card, 2026-11-10),
    and, in the sampled layouts, any caption on screen while a title or end card is the beat showing, unless the card
    carries that line by design."""
    notes, beats = [], project["beats"]
    for b in beats:
        if b["kind"] in CARD_KINDS and "say" in b and not speaks_the_card(b):
            notes.append(f"Beat {b['id']}: the {b['kind']} card carries narration that is not its own words "
                         f"(\"{' '.join(b['say'].split()[:8])}...\"); give the line its own scene or statement beat, "
                         "or leave the card silent.")
    if not layouts:
        return notes
    spans, start = [], 0.0
    for b in beats:
        end = start + beat_seconds(b, project.get("bpm", 120))
        spans.append((start, end, b))
        start = end
    for sample in layouts or []:
        t = sample.get("time")
        if not isinstance(t, (int, float)):
            continue
        showing = next((b for s, e, b in spans if s <= t < e), None)
        if not showing or showing["kind"] not in CARD_KINDS:
            continue
        for box in sample.get("elements", []):
            if box.get("role") != "caption":
                continue
            if box.get("beat") != showing["id"]:
                notes.append(f"Beat {box.get('beat', '?')}'s caption runs onto the {showing['kind']} card {showing['id']}; "
                             "end the line inside its own beat.")
            elif not speaks_the_card(showing):
                notes.append(f"Beat {showing['id']}: a caption shows on the {showing['kind']} card that is not its own words; "
                             "give the line its own scene or statement beat, or leave the card silent.")
    return list(dict.fromkeys(notes))


CAPTION_OVERLAP_PX = 8  # a figure's anti-aliased edge or a foot's round cap may touch the band; a body may not


def caption_clear_notes(layouts):
    """Captions stay clear of characters: in any sampled moment, a caption box overlapping a character's visible figure
    (more than a few pixels both ways) is named. Close shots cut the figure at the near ground (static/motion/scene.js)."""
    notes = []
    for sample in layouts or []:
        elements = sample.get("elements", [])
        captions = [b for b in elements if b.get("role") == "caption"]
        figures = [b for b in elements if b.get("kind") == "character" and b.get("h", 0) > 0]
        for c in captions:
            for f in figures:
                wide = min(c["x"] + c["w"], f["x"] + f["w"]) - max(c["x"], f["x"])
                tall = min(c["y"] + c["h"], f["y"] + f["h"]) - max(c["y"], f["y"])
                if wide > CAPTION_OVERLAP_PX and tall > CAPTION_OVERLAP_PX:
                    notes.append(f"Beat {f.get('beat', '?')}: the caption covers a character ({f.get('shot', 'a')} shot); "
                                 "keep captions clear of characters.")
    return list(dict.fromkeys(notes))


STORY_SHOT_MAX = 2.5     # the reference: no shot over 2.5 s


def story_notes(project, layouts=None):
    """The Story Short's own checks: no shot over 2.5 s (a beat's shots, cut on their words), a speaker on every line, the
    caption on screen is one word of the line being said, and the avatar strip's colour is its speaker's."""
    from core.video_store import beat_seconds as seconds_of
    notes = []
    for b in project["beats"]:
        if b["kind"] != "story":
            continue
        length = seconds_of(b, project["bpm"])
        cuts = len((b.get("story") or {}).get("shots", [])) or 1
        if length / cuts > STORY_SHOT_MAX + .3 and cuts == 1:
            notes.append(f"Beat {b['id']} holds one shot for {length:.1f} s; the format keeps shots under {STORY_SHOT_MAX:g} s, so add a cut on a word.")
    for sample in layouts or []:
        for box in sample.get("elements", []):
            if box.get("role") == "caption" and box.get("story") and len(str(box.get("text", "")).split()) != 1:
                notes.append(f"Beat {box.get('beat', '?')}'s caption shows more than one word; the format shows one word at a time.")
    return list(dict.fromkeys(notes))


def check(project, aspect="16:9", layouts=None, frames=None, loudness=None, voice=None):
    """Accept samples as {time, elements: kdLayout(t)}; deduplicate repeated notes."""
    w, h = ASPECTS[aspect]
    left, right = w * .05, w * .95
    top, bottom = h * (.08 if aspect == "9:16" else .05), h * (.88 if aspect == "9:16" else .95)
    notes = []
    story = any(b["kind"] == "story" for b in project["beats"])
    for b in project["beats"]:
        seconds = beat_seconds(b, project["bpm"])
        words = len(" ".join([str(b.get(k, "")) for k in ("text", "sub", "number")] + b.get("items", [])).split())
        if seconds < (.5 if b["kind"] == "story" else 1):
            notes.append(f"Beat {b['id']} is under {'half a second' if b['kind'] == 'story' else '1 second'}; give it more time.")
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
            if box.get("clip"):
                continue      # an overlay clip's text: overlay_notes names the clip
            label = box.get("beat", "?")
            if box.get("truncated"):
                notes.append(f"Beat {label}'s text is cut off with an ellipsis; shorten it.")
            if (box.get("x", 0) < left or box.get("y", 0) < top or
                    box.get("x", 0) + box.get("w", 0) > right or box.get("y", 0) + box.get("h", 0) > bottom):
                notes.append(f"Beat {label} has text outside the safe area; move it inward.")
            fg, bg = _luminance(box.get("color")), _luminance(box.get("bg"))
            if fg is not None and bg is not None and (max(fg, bg) + .05) / (min(fg, bg) + .05) < 4.5:
                notes.append(f"Beat {label} has text contrast under 4.5:1; strengthen the text or background color.")
    notes += caption_clear_notes([{**s, "elements": [e for e in s.get("elements", []) if not e.get("story")]} for s in layouts or []])
    notes += story_notes(project, layouts)
    notes += card_narration_notes(project, layouts)
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
            if box.get("text") and not box.get("clip"):
                # A floating label over a head (Pack B) is a figure read at a glance: one word, however it is spaced.
                groups.setdefault(box.get("beat"), []).append("figure" if box.get("role") == "label" else str(box["text"]))
        for beat, texts in groups.items():
            if beat in lengths and len(" ".join(texts).split()) / lengths[beat] > 3.5:
                notes.append(f"Beat {beat} reads faster than 3.5 words/s; shorten the copy or add bars.")
    for index, raw in enumerate(frames or []):
        with Image.open(io.BytesIO(raw)) as image:
            if max(ImageStat.Stat(image.convert("RGB")).var) < 5:
                notes.append(f"Sample frame {index + 1} is near-blank; check that content is visible.")
    if loudness:
        i, tp = loudness.get("input_i"), loudness.get("input_tp")
        target = -14 if story else -16
        if i is None or not math.isfinite(i) or abs(i - target) > 1.5:
            notes.append(f"Soundtrack loudness is off target; aim for {target} LUFS integrated.")
        if tp is None or not math.isfinite(tp) or tp > -1:
            notes.append("Soundtrack true peak is above -1 dBTP; lower the transient peaks.")
    return list(dict.fromkeys(notes))


def _contrast(a, b):
    return (max(a, b) + .05) / (min(a, b) + .05)


def _behind(raw, box):
    """The luminance behind a plain text clip on a rendered frame: the median over its box (letters cover well under
    half of a text box, so the median is the background), or None when the box is off the frame."""
    with Image.open(io.BytesIO(raw)) as image:
        rgb = image.convert("RGB")
        x0, y0 = max(0, int(box["x"])), max(0, int(box["y"]))
        x1, y1 = min(rgb.width, int(box["x"] + box["w"])), min(rgb.height, int(box["y"] + box["h"]))
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None
        crop = rgb.crop((x0, y0, x1, y1))
        crop.thumbnail((160, 160))
        pixels = np.asarray(crop, dtype=np.float64) / 255
    linear = np.where(pixels <= .04045, pixels / 12.92, ((pixels + .055) / 1.055) ** 2.4)
    return float(np.median(linear @ np.array([.2126, .7152, .0722])))


def _rest_bounds(clip, w, h):
    """Where a keyframed clip comes to rest (every property at its last key), as frame-pixel bounds of the turned and
    scaled box, the way static/motion/overlay.js draws it. None for a clip without keys."""
    if not clip or not clip.get("keys"):
        return None
    last = lambda prop, plain: clip["keys"][prop][-1]["v"] if clip["keys"].get(prop) else plain
    box = clip["box"]
    x, y, scale, turn = last("x", box["x"]), last("y", box["y"]), last("scale", clip.get("scale", 1)), last("rotation", clip.get("rotation", 0))
    cx, cy, hw, hh = (x + box["w"] / 2) * w, (y + box["h"] / 2) * h, box["w"] * w / 2 * scale, box["h"] * h / 2 * scale
    a = math.radians(turn)
    pts = [(cx + dx * math.cos(a) - dy * math.sin(a), cy + dx * math.sin(a) + dy * math.cos(a)) for dx, dy in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}


def overlay_notes(project, aspect="16:9", layouts=None, frames=None, times=None):
    """Checks for the overlay and audio clips (Content Studio Editor step 3), each naming its clip: text cut off with an
    ellipsis, text outside the safe area (which also keeps it clear of the caption band), text that reads too fast,
    contrast under 4.5:1 (against its card, or for plain text against the pixels really behind it on a rendered
    frame), and a clip that runs past the end of the video."""
    from core import video_store, video_tracks
    tracks = project.get("tracks") or []
    if not tracks:
        return []
    w, h = ASPECTS[aspect]
    captioned = (project.get("narration") or {}).get("captions", True) and video_store.narrated(project)
    portrait = aspect == "9:16"
    safe_top = h * (.13 if portrait else .05)
    safe_bottom = safe_top + h * ((.56 if portrait else .70 if aspect == "1:1" else .73) if captioned else (.70 if portrait else .90))
    left, right = w * .05, w * .95
    total, notes, names = video_store.duration(project), [], {}
    for track in tracks:
        for clip in track["clips"]:
            names[clip["id"]] = f"Clip {clip['id']} on {track['name']}"
            if track["hidden"]:
                continue
            if clip["start"] >= total - 1e-6:
                notes.append(f"{names[clip['id']]} starts after the video ends ({total:.1f} s); move it earlier or it is not seen.")
            elif video_tracks.end(clip) > total + 1 / 30:
                notes.append(f"{names[clip['id']]} runs past the end of the video ({total:.1f} s); it is cut there.")
            if clip["kind"] == "text" and len(clip["text"].split()) / video_tracks.length(clip) > 3.5:
                notes.append(f"{names[clip['id']]} reads faster than 3.5 words/s; shorten the text or lengthen the clip.")
    by_time = {round(s.get("time", -1), 6): s.get("elements", []) for s in layouts or []}
    clips = {c["id"]: c for t in tracks for c in t["clips"]}
    for sample in layouts or []:
        for box in sample.get("elements", []):
            if not box.get("clip") or box.get("kind") != "text":
                continue
            label = names.get(box["clip"], f"Clip {box['clip']}")
            if box.get("truncated"):
                notes.append(f"{label}: its text is cut off with an ellipsis; shorten it or make its box bigger.")
            outside = lambda b: b["x"] < left - .5 or b["x"] + b["w"] > right + .5 or b["y"] < safe_top - .5 or b["y"] + b["h"] > safe_bottom + .5
            if outside(box):
                # A keyframed clip may pass outside on its way (a fly-in): only where it comes to rest counts.
                rest = _rest_bounds(clips.get(box["clip"]), w, h) if box.get("animated") else None
                if rest is None or outside(rest):
                    notes.append(f"{label} has text outside the safe area" + (" where it comes to rest" if rest else "")
                                 + (" (or over the captions)" if captioned else "") + "; move it inward.")
            fg, bg = _luminance(box.get("color")), _luminance(box.get("bg")) if box.get("bg") else None
            if fg is not None and bg is not None and _contrast(fg, bg) < 4.5:
                notes.append(f"{label} has text contrast under 4.5:1 on its card; pick another colour.")
    for raw, t in zip(frames or [], times or []):
        for box in by_time.get(round(t, 6), []):
            if not box.get("clip") or box.get("kind") != "text" or box.get("bg"):
                continue
            fg = _luminance(box.get("color"))
            behind = _behind(raw, box) if fg is not None else None
            if behind is not None and _contrast(fg, behind) < 4.5:
                notes.append(f"{names.get(box['clip'], 'Clip ' + box['clip'])} has text contrast under 4.5:1 against what is behind it "
                             f"(at {t:.1f} s); use the card style or another colour.")
    return list(dict.fromkeys(notes))

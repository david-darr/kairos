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
    notes += caption_clear_notes(layouts)
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
            if box.get("text"):
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
        if i is None or not math.isfinite(i) or abs(i + 16) > 1.5:
            notes.append("Soundtrack loudness is off target; aim for -16 LUFS integrated.")
        if tp is None or not math.isfinite(tp) or tp > -1:
            notes.append("Soundtrack true peak is above -1 dBTP; lower the transient peaks.")
    return list(dict.fromkeys(notes))

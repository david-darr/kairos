"""The backend half of video-render-smoke.cjs: a real narrated render through the app's own render path.

Started by the Electron suite with KAIROS_RENDER_TOKEN set, it serves the player, the motion engine, the design fonts
and the render worker routes on a loopback port, waits for Electron's render worker (electron/designRender.js) to
connect, then creates a narrated video and renders it with core/video_render.render, exactly as video_render and the
Studio do: Kokoro narration first, the soundtrack with the music ducked under it, the offscreen frames, FFmpeg, the
loudness pass, the checks and the contact sheet. It writes what happened to --out as JSON.

Data goes to a temporary folder. With --models pointing at a folder that holds Kokoro's downloaded model files, the
real Kokoro voice speaks (read only); without it a tone stands in for the voice so the suite runs on any machine.
--keep copies the MP4, contact sheet, thumbnail and project JSON to a folder (the morning sample).

Pack A (Video Styles unit 3): every run also makes characters from Kairos's starting family, renders each one's
reference sheet through the same worker (a PNG job on the sheet page), checks it, approves it in the temporary
store (a test approval: in the app only the person approves) and casts it in scene beats, so the render covers the
rig, the mouth shapes timed from the narration and the sheet-match checks. --pack-a renders the Pack A sample.

User-made style packs: --style-pack adds the shipped starter pack (Flat science explainer) to the temporary account,
renders and checks its characters' sheets, test-approves them there, and makes the pack's own sample with
core/style_pack_sample.make, the same call the Styles tab and the bots use, so the sample goes through the app's render
path in the pack's palette, lighting, characters, rules, music and voice. --keep also copies the pack file it exports.

Pack B (glossy 3D, Video Styles unit 5): --pack-b adds the shipped 3D starter pack (Glossy what-if) with Pip 3D, renders
Pip 3D's 3D reference sheet through the worker and checks it, test-approves it in the temporary store, and makes the pack's
sample with core/style_pack_sample.make. --renderer blender first makes a new version of the pack that picks Blender
(the person's own install, found by core/blender_tools.py), so the sample goes through the Blender runner, its overlay
pass and FFmpeg compositing; without Blender it renders with three.js and says so. --preview renders a few still frames
of the sample's beats instead (for a look pass) and keeps them with --keep.

Content Studio Editor steps 5 to 7: --motion puts keyframed overlays (a title that slides in, a badge that pops and
turns, an arrow that blinks), a video clip from a file "uploaded" through the store (a sky gradient FFmpeg makes here,
standing in for the person's own file) and word captions (the box style; word times aligned from the narration with
whisper.cpp) on the video. --fps60 renders at 60 frames a second. --exports then makes the WebM, MOV and GIF from the
MP4 (and a ProRes MOV, measured only), keeping the WebM and GIF with --keep.
"""
import argparse
import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SAMPLE = {
    "title": "Why clouds float",
    "look": "nordic",
    "aspects": ["9:16"],
    "music": {"mood": "calm", "volume": .7},
    "narration": {"voice": "af_heart", "captions": True},
    "beats": [
        {"id": "hook", "kind": "title", "text": "Clouds weigh tons", "camera": "push", "transition": "zoom",
         "say": "That fluffy cloud above you weighs about as much as a hundred elephants."},
        {"id": "weight", "kind": "big-number", "number": "500 t", "text": "of water in one puffy cloud", "transition": "wipe",
         "say": "A typical puffy cloud holds around five hundred tonnes of water."},
        {"id": "question", "kind": "statement", "text": "So why doesn't it fall?", "camera": "pull", "transition": "whip",
         "say": "So why doesn't it fall?"},
        {"id": "droplet", "kind": "big-number", "number": "0.01 mm", "text": "across, for a typical droplet", "transition": "dither",
         "say": "That water is split into countless droplets, each about a hundredth of a millimetre wide."},
        {"id": "reasons", "kind": "list", "text": "Why they stay up", "items": ["Tiny drops fall slowly", "Rising warm air lifts them"],
         "transition": "flip", "say": "Droplets that small fall very slowly. And rising warm air easily holds them up."},
        {"id": "rain", "kind": "quote", "text": "Merge, grow heavy, fall.", "sub": "How a raindrop is made", "camera": "pan",
         "transition": "mosaic", "say": "When droplets merge into raindrops, they get heavy enough to fall."},
        {"id": "end", "kind": "end", "text": "Look up today", "sub": "Source: USGS Water Science School", "bars": 1.5,
         "say": "That's rain. So look up: that's tonnes of water, floating."},
    ],
}
SMOKE = {
    "title": "Narration smoke", "look": "sport", "aspects": ["16:9"], "characters": ["round"], "palette": "mint",
    "beats": [{"id": "one", "kind": "title", "text": "One short line", "say": "One short line. And a second one, after a comma."},
              {"id": "talk", "kind": "scene", "say": "Hello there. I am a character.",
               "scene": {"setting": "meadow", "shot": "medium", "cast": [{"character": 0, "action": "wave", "expression": "happy", "speaking": True}],
                         "props": [{"icon": "sun", "x": .8, "y": .2, "size": .12}]}},
              {"id": "two", "kind": "end", "text": "Done", "bars": 1}],
}
# Pack A sample: an original, harmless explainer told by two of Kairos's own characters (Pip, round; Bo, square).
# Facts: Rayleigh scattering (scattering goes as one over the wavelength to the fourth power, so blue at about 450 nm
# scatters several times more than red at about 700 nm) and the redder sky at sunset; standard physics, not checked
# against a source in this run.
PACK_A = {
    "title": "Why the sky is blue", "look": "nordic", "aspects": ["16:9"], "characters": ["round", "square"], "palette": "dawn",
    "music": {"mood": "playful", "volume": .6}, "narration": {"voice": "af_heart", "captions": True},
    "beats": [
        {"id": "hello", "kind": "scene", "camera": "push", "transition": "whip", "say": "Hi, I'm Pip. Ever wondered why the sky is blue?",
         "scene": {"setting": "meadow", "shot": "wide", "cast": [{"character": 0, "x": .35, "action": "wave", "expression": "happy", "speaking": True},
                                                                  {"character": 1, "x": .68, "action": "idle", "expression": "neutral", "view": "three_quarter", "facing": "left"}],
                   "props": [{"icon": "sun", "x": .82, "y": .18, "size": .13}, {"icon": "cloud", "x": .2, "y": .2, "size": .12, "float": True}]}},
        {"id": "white", "kind": "scene", "camera": "pan", "transition": "dither", "text": "Sunlight is every colour",
         "say": "Sunlight looks white, but it is really every colour of the rainbow mixed together.",
         "scene": {"setting": "meadow", "shot": "medium", "cast": [{"character": 1, "x": .4, "action": "point", "expression": "happy", "speaking": True}],
                   "props": [{"icon": "sun", "x": .8, "y": .25, "size": .16}]}},
        {"id": "scatter", "kind": "scene", "camera": "pull", "transition": "zoom",
         "say": "The air is full of tiny molecules, and they bounce short blue waves around far more than long red ones.",
         "scene": {"setting": "lab", "shot": "medium", "cast": [{"character": 0, "x": .38, "action": "think", "expression": "thinking", "speaking": True}],
                   "props": [{"icon": "atom", "x": .72, "y": .32, "size": .16, "float": True}, {"icon": "arrow", "x": .72, "y": .58, "size": .1}]}},
        {"id": "everywhere", "kind": "scene", "camera": "still", "transition": "wipe",
         "say": "So blue light reaches your eyes from every part of the sky.",
         "scene": {"setting": "meadow", "shot": "close", "cast": [{"character": 1, "x": .5, "action": "nod", "expression": "surprised", "speaking": True, "turn": "three_quarter"}],
                   "props": [{"icon": "star", "x": .15, "y": .2, "size": .08, "float": True}]}},
        {"id": "sunset", "kind": "scene", "camera": "pan", "transition": "mosaic",
         "say": "At sunset, light crosses much more air. The blue gets scattered away, and reds and oranges are left.",
         "scene": {"setting": "ocean", "shot": "wide", "cast": [{"character": 0, "x": .3, "action": "walk", "expression": "happy", "speaking": True, "view": "three_quarter"},
                                                                  {"character": 1, "x": .7, "action": "jump", "expression": "happy"}],
                   "props": [{"icon": "sun", "x": .5, "y": .55, "size": .14}]}},
        {"id": "end", "kind": "end", "text": "Look up today", "sub": "An original Kairos explainer", "bars": 1.5,
         "say": "Next time you look up, you'll know why."},
    ],
}


# Long-form sample (Video Styles unit 4): a chaptered, narrated explainer in the starter pack (Flat science explainer), told by
# Pip (0), Bo (1) and Tilly (2). Facts checked 2026-11-10: NASA Moon facts (science.nasa.gov/moon/facts/: 384,400 km on
# average, synchronous rotation keeps one face to us, moving away about an inch a year), NASA Moon phases
# (science.nasa.gov/moon/moon-phases/: eight phases, about 29.5 days, the Sun always lights half), NASA tides
# (science.nasa.gov/moon/tides/: a bulge on the near and the far side, most shores two high and two low tides a day), lunar
# laser ranging (en.wikipedia.org/wiki/Lunar_Laser_Ranging_experiments: Apollo retroreflectors still in use, 3.8 cm a year).
# Light there and back: 2 x 384,400 km / 299,792 km/s = 2.56 s, worked from the NASA distance.
def _scene(setting, shot, cast, props=(), camera="still", transition="cut"):
    return {"camera": camera, "transition": transition,
            "scene": {"setting": setting, "shot": shot, "cast": [dict(c) for c in cast], "props": [dict(p) for p in props]}}


def _who(i, x=.5, action="idle", expression="neutral", speaking=True, **more):
    return {"character": i, "x": x, "action": action, "expression": expression, "speaking": speaking, **more}


MOON, SUN, STAR = {"icon": "moon", "x": .78, "y": .2, "size": .14}, {"icon": "sun", "x": .2, "y": .2, "size": .13}, {"icon": "star", "x": .15, "y": .16, "size": .06, "float": True}
LONG_FORM_CHAPTERS = [
    ("Our nearest neighbour", [
        {"id": "hook", "say": "Look up tonight. That bright face in the sky is the Moon.",
         **_scene("space", "wide", [_who(0, .35, "wave", "happy"), _who(1, .66, speaking=False, view="three_quarter", facing="left")], [MOON, STAR], "push", "whip")},
        {"id": "closest", "say": "It is our closest neighbour in space, and it shapes life here in quiet ways.",
         **_scene("meadow", "medium", [_who(1, .4, "point", "happy")], [MOON], "pan")},
        {"id": "distance", "kind": "big-number", "number": "384,400 km", "text": "from Earth to the Moon, on average", "transition": "zoom",
         "say": "On average, the Moon is about three hundred eighty-four thousand kilometres away."},
        {"id": "far", "say": "That is far. A car driving without a single stop would need months to get there.",
         **_scene("city", "medium", [_who(2, .38, "shrug", "surprised")], [{"icon": "clock", "x": .72, "y": .3, "size": .12}], "pull")},
        {"id": "looks", "say": "Even so, it looks big in our sky because it is so much closer than the stars.",
         **_scene("meadow", "wide", [_who(2, .34, "point", "happy"), _who(0, .68, speaking=False, facing="left")], [MOON, STAR], "pan")},
        {"id": "rock", "say": "It is a ball of rock with no air to breathe and no liquid water on its surface.",
         **_scene("lab", "medium", [_who(1, .4, "think", "thinking")], [{"icon": "magnifier", "x": .74, "y": .3, "size": .12}])},
        {"id": "face", "say": "Its grey plains and bright craters are the face you see from here.",
         **_scene("space", "medium", [_who(0, .38, "nod", "happy")], [MOON], "push")},
        {"id": "pull", "say": "Yet the Moon is close enough to pull on our whole planet.",
         **_scene("space", "close", [_who(0, .5, "think", "thinking")], [{"icon": "planet", "x": .8, "y": .26, "size": .14, "float": True}], "push", "wipe")},
        {"id": "nights", "say": "Without it, our nights would be much darker.",
         **_scene("meadow", "wide", [_who(1, .3, "nod", "neutral"), _who(2, .68, speaking=False, facing="left")], [MOON, STAR])},
        {"id": "plan", "say": "So let's look at its phases, its tides, and why it always shows us one face.",
         **_scene("meadow", "medium", [_who(0, .42, "wave", "happy")], [{"icon": "question", "x": .76, "y": .28, "size": .11, "float": True}], "pan", "whip")},
    ]),
    ("Why the Moon changes shape", [
        {"id": "nolight", "say": "The Moon makes no light of its own. It shines with reflected sunlight.",
         **_scene("lab", "medium", [_who(1, .38, "point", "neutral")], [{"icon": "lightbulb", "x": .74, "y": .3, "size": .13}])},
        {"id": "half", "say": "The Sun always lights one half of the Moon, like a lamp on a ball.",
         **_scene("space", "wide", [_who(0, .3, "point", "happy")], [SUN, {"icon": "moon", "x": .7, "y": .3, "size": .14}], "push")},
        {"id": "orbit", "say": "As the Moon circles us, we see different amounts of that bright half.",
         **_scene("space", "medium", [_who(2, .4, "think", "thinking")], [MOON, STAR], "pan")},
        {"id": "newmoon", "say": "When the Moon is between Earth and the Sun, its lit half faces away from us.",
         **_scene("space", "close", [_who(1, .5, "shrug", "worried")], [SUN])},
        {"id": "dark", "say": "We see almost nothing. That is the new Moon.",
         **_scene("meadow", "medium", [_who(0, .4, "nod", "neutral")], [STAR], transition="wipe")},
        {"id": "full", "say": "About two weeks later, we see the whole lit half. That is the full Moon.",
         **_scene("meadow", "wide", [_who(2, .32, "jump", "happy"), _who(1, .7, speaking=False, action="wave", facing="left")], [MOON], "pull")},
        {"id": "between", "say": "In between, we see a slice of light that grows or shrinks night by night.",
         **_scene("meadow", "medium", [_who(2, .4, "think", "thinking")], [MOON], "pan")},
        {"id": "waxing", "say": "When the lit part is growing, we say the Moon is waxing.",
         **_scene("lab", "medium", [_who(1, .38, "point", "happy")], [{"icon": "moon", "x": .74, "y": .3, "size": .13}], "push")},
        {"id": "waning", "say": "When it is shrinking again, we say the Moon is waning.",
         **_scene("lab", "medium", [_who(0, .38, "point", "neutral")], [{"icon": "moon", "x": .74, "y": .3, "size": .11}], "pull", "wipe")},
        {"id": "phases", "kind": "list", "text": "Four of the eight phases", "items": ["New Moon", "First quarter", "Full Moon", "Third quarter"],
         "say": "There are eight named phases, from new Moon to full Moon and back again."},
        {"id": "cycle", "kind": "big-number", "number": "29.5 days", "text": "for one full cycle of phases", "transition": "zoom",
         "say": "One full cycle of phases takes about twenty-nine and a half days."},
    ]),
    ("The pull behind the tides", [
        {"id": "gravity", "say": "The Moon's gravity pulls on all of Earth, and the oceans show it most.",
         **_scene("ocean", "wide", [_who(2, .36, "point", "happy")], [MOON], "push")},
        {"id": "bulge", "say": "The water bulges out on the side of Earth that faces the Moon.",
         **_scene("ocean", "medium", [_who(0, .4, "think", "thinking")], [{"icon": "drop", "x": .74, "y": .3, "size": .12, "float": True}], "pan")},
        {"id": "second", "say": "And there is a second bulge on the far side of Earth, too.",
         **_scene("ocean", "close", [_who(1, .5, "nod", "surprised")], [MOON])},
        {"id": "lined", "say": "Those bulges stay lined up with the Moon while Earth turns underneath them.",
         **_scene("space", "medium", [_who(2, .38, "point", "thinking")], [{"icon": "planet", "x": .72, "y": .3, "size": .16}], "pull", "wipe")},
        {"id": "rise", "say": "As your coast turns through each bulge, the sea rises, then falls again.",
         **_scene("ocean", "wide", [_who(0, .3, "walk", "happy", view="three_quarter"), _who(2, .7, speaking=False, facing="left")], [MOON], "pan")},
        {"id": "sun", "say": "The Sun pulls on the oceans too, but less than the Moon does.",
         **_scene("ocean", "medium", [_who(1, .4, "point", "neutral")], [SUN], "pan")},
        {"id": "lineup", "say": "When the Sun and the Moon line up, their pulls add together and the tides get bigger.",
         **_scene("space", "wide", [_who(2, .32, "jump", "surprised")], [SUN, {"icon": "moon", "x": .72, "y": .22, "size": .12}], "push")},
        {"id": "tables", "say": "People who fish or sail check tide tables, so they know when the water will be high.",
         **_scene("ocean", "medium", [_who(0, .4, "nod", "happy")], [{"icon": "clock", "x": .74, "y": .3, "size": .11}], "still", "wipe")},
        {"id": "twice", "kind": "big-number", "number": "2", "text": "high tides a day on most shores",
         "say": "So most shores get two high tides and two low tides every day."},
        {"id": "beach", "say": "Next time you visit a beach, look for the line where the water reached hours ago.",
         **_scene("ocean", "medium", [_who(1, .42, "point", "happy")], [{"icon": "magnifier", "x": .74, "y": .32, "size": .12}], "push", "whip")},
    ]),
    ("One face, always", [
        {"id": "odd", "say": "Here is something odd. We always see the same side of the Moon.",
         **_scene("space", "wide", [_who(1, .36, "shrug", "surprised")], [MOON, STAR], "push")},
        {"id": "spin", "say": "The Moon spins once for every trip it makes around Earth.",
         **_scene("space", "medium", [_who(0, .4, "think", "thinking")], [{"icon": "planet", "x": .74, "y": .3, "size": .15, "float": True}], "pan")},
        {"id": "match", "say": "Because the spin and the trip match, the same face always points our way.",
         **_scene("lab", "medium", [_who(2, .4, "point", "happy")], [MOON])},
        {"id": "name", "kind": "statement", "text": "Synchronous rotation", "transition": "zoom",
         "say": "Scientists call this synchronous rotation."},
        {"id": "farside", "say": "The far side still gets sunlight. We just never see it from home.",
         **_scene("space", "close", [_who(1, .5, "nod", "neutral", turn="three_quarter")], [SUN])},
        {"id": "photos", "say": "Spacecraft have photographed the far side, so we know what it looks like.",
         **_scene("space", "medium", [_who(2, .4, "point", "happy")], [{"icon": "rocket", "x": .74, "y": .3, "size": .13, "float": True}], "pan")},
        {"id": "craters", "say": "It is covered in even more craters than the side we see.",
         **_scene("space", "close", [_who(1, .5, "shrug", "surprised")], [MOON])},
        {"id": "patches", "say": "Look closely next time, and you will spot the same dark patches every night.",
         **_scene("meadow", "wide", [_who(0, .32, "point", "happy"), _who(2, .7, speaking=False, facing="left")], [MOON, STAR], "pull", "wipe")},
    ]),
    ("Slowly drifting away", [
        {"id": "away", "say": "The Moon is also moving away from us, very slowly.",
         **_scene("space", "medium", [_who(0, .4, "shrug", "worried")], [{"icon": "moon", "x": .78, "y": .26, "size": .1}], "pull")},
        {"id": "lasers", "say": "Scientists measure it by bouncing laser light off mirrors that Apollo astronauts left there.",
         **_scene("lab", "medium", [_who(1, .38, "point", "thinking")], [{"icon": "rocket", "x": .74, "y": .3, "size": .13}], "push")},
        {"id": "mirrors", "say": "Those mirrors are still there, and scientists still use them today.",
         **_scene("lab", "medium", [_who(1, .4, "nod", "happy")], [{"icon": "lightbulb", "x": .74, "y": .3, "size": .12}], "pull")},
        {"id": "pulse", "say": "Each pulse of light travels there and back in about two and a half seconds.",
         **_scene("space", "wide", [_who(2, .32, "point", "thinking")], [{"icon": "planet", "x": .2, "y": .3, "size": .14}, MOON], "pan")},
        {"id": "learn", "say": "Measurements like this help us learn how the Earth and the Moon change over time.",
         **_scene("lab", "medium", [_who(0, .4, "think", "thinking")], [{"icon": "atom", "x": .74, "y": .3, "size": .12, "float": True}], "push", "wipe")},
        {"id": "rate", "kind": "big-number", "number": "3.8 cm", "text": "farther away each year", "transition": "zoom",
         "say": "The Moon drifts about three point eight centimetres farther away each year."},
        {"id": "slow", "say": "That is far too slow to notice in a lifetime, but it adds up over ages.",
         **_scene("city", "medium", [_who(2, .4, "think", "thinking")], [{"icon": "clock", "x": .74, "y": .28, "size": .12}], "pan")},
        {"id": "still", "say": "For now, the Moon still lights our nights and moves our seas.",
         **_scene("ocean", "wide", [_who(1, .34, "nod", "happy"), _who(0, .68, speaking=False, facing="left")], [MOON, STAR])},
        {"id": "hello", "say": "So look up tonight, and say hello to our nearest neighbour.",
         **_scene("meadow", "wide", [_who(0, .3, "wave", "happy"), _who(1, .52, speaking=False, action="wave"), _who(2, .74, speaking=False, action="wave", facing="left")], [MOON, STAR], "push", "whip")},
        {"id": "end", "kind": "end", "text": "Look up tonight", "sub": "An original Kairos explainer. Sources: NASA", "bars": 1.5},
    ]),
]


def long_form_beats():
    """The sample's beats in order (scene beats get kind scene) and its chapters, each starting at its first beat."""
    beats, chapters = [], []
    for n, (title, rows) in enumerate(LONG_FORM_CHAPTERS, 1):
        chapters.append({"id": f"ch{n}", "title": title, "start": rows[0]["id"]})
        for row in rows:
            beat = json.loads(json.dumps(row))
            beat.setdefault("kind", "scene")
            beats.append(beat)
    return beats, chapters


def chime_wav():
    """A two-note chime made here, standing in for a sound file the person uploads (Kairos never fetches sounds)."""
    import io
    import wave
    import numpy as np
    rate = 44100
    t = np.arange(int(1.4 * rate)) / rate
    note = lambda f, at: np.sin(2 * np.pi * f * (t - at)) * np.exp(-(t - at) * 5) * (t >= at)
    mono = (note(880, 0) + .8 * note(1318.5, .18)) * .35 * np.minimum(1, t / .005)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((mono * 32767).astype("<i2").tobytes())
    return out.getvalue()


def badge_png():
    """A small round badge drawn here for the image clip (our own artwork, no download)."""
    import io
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (360, 360), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((10, 10, 350, 350), fill=(29, 39, 51, 255))
    d.ellipse((60, 60, 300, 300), outline=(242, 153, 74, 255), width=22)
    d.ellipse((235, 70, 285, 120), fill=(242, 153, 74, 255))
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


async def add_tracks(project):
    """Content Studio Editor step 3: after the narration has set the timeline, put an overlay track (a title card, an
    image badge, a fact card), a shape track (an underline and an arrow) and an audio track (a chime) over the beats,
    each placed on its beat's measured span. Sound and image go in through the same store calls as an upload."""
    from core import video_narration, video_render, video_store
    project = await asyncio.to_thread(video_narration.prepare, project["id"])
    spans = {b["id"]: (b["start"], b["end"]) for b in video_render.outline(project)}
    first, second, third, fourth = [b["id"] for b in project["beats"][:4]]
    sound = video_store.add_audio(project["id"], chime_wav(), "wav", "Chime")
    badge = video_store.add_asset(project["id"], badge_png(), "png")
    s1, s2, s3, s4 = spans[first], spans[second], spans[third], spans[fourth]
    tracks = [
        {"id": "titles", "kind": "overlay", "name": "Titles", "clips": [
            {"id": "intro", "kind": "text", "start": round(s1[0] + .4, 3), "in": 0, "out": round(min(3.2, s1[1] - s1[0] - .5), 3), "fade_in": .3, "fade_out": .3,
             "text": "An original Kairos explainer", "box": {"x": .29, "y": .06, "w": .42, "h": .1}, "role": "body", "style": "card", "color": "text", "align": "center"},
            {"id": "fact", "kind": "text", "start": round(s3[0] + .5, 3), "in": 0, "out": round(s3[1] - s3[0] - 1.0, 3), "fade_in": .3, "fade_out": .3,
             "text": "Blue light scatters most", "box": {"x": .06, "y": .07, "w": .4, "h": .12}, "role": "title", "style": "card", "color": "text"}]},
        {"id": "marks", "kind": "overlay", "name": "Shapes", "clips": [
            {"id": "underline", "kind": "shape", "start": round(s3[0] + .8, 3), "in": 0, "out": round(s3[1] - s3[0] - 1.4, 3), "fade_in": .2, "fade_out": .2,
             "shape": "rect", "color": "accent-2", "fill": True, "box": {"x": .07, "y": .2, "w": .22, "h": .012}},
            {"id": "arrow", "kind": "shape", "start": round(s2[0] + .5, 3), "in": 0, "out": round(s2[1] - s2[0] - 1.0, 3), "fade_in": .2, "fade_out": .2,
             "shape": "arrow", "color": "accent-2", "fill": True, "stroke": .006, "box": {"x": .62, "y": .16, "w": .12, "h": .07}}]},
        {"id": "pictures", "kind": "overlay", "name": "Pictures", "clips": [
            {"id": "badge", "kind": "image", "start": round(s3[0] + .3, 3), "in": 0, "out": round(s3[1] - s3[0] - .6, 3), "fade_in": .25, "fade_out": .25,
             "image": badge, "box": {"x": .83, "y": .07, "w": .1, "h": .17}, "fit": "contain"}]},
        {"id": "sound", "kind": "audio", "name": "Sound", "clips": [
            {"id": "chime", "kind": "sound", "start": round(s4[0] + .1, 3), "in": 0, "out": 1.35, "volume": .7, "fade_in": 0, "fade_out": .2, "audio": sound}]}]
    return video_store.save(project["id"], {**project, "tracks": tracks})


def sky_clip():
    """A 6-second sky with a moving sun, drawn by FFmpeg here, standing in for a video file the person uploads."""
    import subprocess
    from core import ffmpeg_tools
    out = Path(tempfile.mkdtemp(prefix="sky-clip-")) / "sky.mp4"
    sun = "lte(hypot(X-(170+90*T)\\,Y-150)\\,58)"      # a sun crossing a sky that pales towards the horizon
    sky = (f"color=c=black:s=960x540:d=6:r=30,format=rgb24,geq=r='if({sun}\\,255\\,20+130*Y/H)'"
           f":g='if({sun}\\,226\\,60+140*Y/H)':b='if({sun}\\,140\\,120+120*Y/H)'")
    subprocess.run([ffmpeg_tools.find(), "-v", "error", "-y", "-f", "lavfi", "-i", sky,
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)], check=True, capture_output=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return out.read_bytes()


async def add_motion(project, fps):
    """Steps 5 to 7 on a narrated video: keyframed overlays, a video clip and word captions (box style)."""
    from core import video_media, video_narration, video_render, video_store
    project = video_store.save(project["id"], {**video_store.get(project["id"]), "fps": fps,
                                               "narration": {**project["narration"], "caption_style": "box"}})
    project = await asyncio.to_thread(video_narration.prepare, project["id"])
    spans = {b["id"]: (b["start"], b["end"]) for b in video_render.outline(project)}
    ids = [b["id"] for b in project["beats"]]
    s1, s2, s3 = spans[ids[0]], spans[ids[1]], spans[ids[2]]
    media = video_media.add_video(project["id"], sky_clip(), "mp4", "Sky")
    badge = video_store.add_asset(project["id"], badge_png(), "png")
    r = lambda v: round(v, 3)
    title_len = r(min(3.6, s1[1] - s1[0] - .4))
    tracks = [
        {"id": "titles", "kind": "overlay", "name": "Titles", "clips": [
            {"id": "intro", "kind": "text", "start": r(s1[0] + .3), "in": 0, "out": title_len, "fade_in": 0, "fade_out": .3,
             "text": "Why is the sky blue?", "box": {"x": .27, "y": .07, "w": .46, "h": .12}, "role": "title", "style": "card", "color": "text",
             "keys": {"x": [{"t": 0, "v": -.5, "ease": "out"}, {"t": .9, "v": .27}], "opacity": [{"t": 0, "v": 0}, {"t": .4, "v": 1}]}}]},
        {"id": "video", "kind": "overlay", "name": "Video", "clips": [
            {"id": "sky", "kind": "video", "start": r(s2[0] + .3), "in": .5, "out": r(min(5.5, .5 + s2[1] - s2[0] - .6)), "fade_in": 0, "fade_out": .4,
             "video": media["media"], "box": {"x": .62, "y": .3, "w": .32, "h": .32}, "fit": "cover",
             "keys": {"y": [{"t": .5, "v": 1.05, "ease": "out"}, {"t": 1.3, "v": .3}], "rotation": [{"t": .5, "v": 8, "ease": "out"}, {"t": 1.3, "v": 0}]}}]},
        {"id": "marks", "kind": "overlay", "name": "Marks", "clips": [
            {"id": "badge", "kind": "image", "start": r(s3[0] + .3), "in": 0, "out": r(s3[1] - s3[0] - .6), "fade_in": 0, "fade_out": .25,
             "image": badge, "box": {"x": .82, "y": .07, "w": .1, "h": .17}, "fit": "contain",
             "keys": {"scale": [{"t": 0, "v": .2, "ease": "back"}, {"t": .6, "v": 1}], "rotation": [{"t": 0, "v": -40, "ease": "out"}, {"t": .6, "v": 0}]}},
            {"id": "arrow", "kind": "shape", "start": r(s2[0] + 1.6), "in": 0, "out": r(min(2.4, s2[1] - s2[0] - 2)), "fade_in": 0, "fade_out": 0,
             "shape": "arrow", "color": "accent-2", "fill": True, "stroke": .006, "box": {"x": .5, "y": .3, "w": .09, "h": .06},
             "keys": {"opacity": [{"t": 0, "v": 0, "ease": "hold"}, {"t": .3, "v": 1, "ease": "hold"}, {"t": .9, "v": .25, "ease": "hold"}, {"t": 1.2, "v": 1}]}}]}]
    return video_store.save(project["id"], {**video_store.get(project["id"]), "tracks": tracks}), media


def overlay_frame(path, t, box, keep=None):
    """The rendered frame at t (FFmpeg), and the median colour inside a clip's box."""
    import subprocess
    from PIL import Image
    from core import ffmpeg_tools
    out = Path(tempfile.mkdtemp(prefix="overlay-frame-")) / "frame.png"
    subprocess.run([ffmpeg_tools.find(), "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1", str(out)], check=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    with Image.open(out) as im:
        w, h = im.size
        crop = im.convert("RGB").crop((int(box["x"] * w) + 6, int(box["y"] * h) + 6, int((box["x"] + box["w"]) * w) - 6, int((box["y"] + box["h"]) * h) - 6))
        values = sorted(crop.getdata(), key=sum)
        median = values[len(values) // 2]
        if keep:
            im.save(keep)
    return list(median)


def tone_voice():
    """A stand-in for Kokoro when its model is not on this machine: a soft tone as long as the words."""
    import numpy as np

    class Fake:
        @staticmethod
        def synthesize(text, voice):
            seconds = max(.4, len(text.split()) / 2.6)
            t = np.arange(int(seconds * 24000)) / 24000
            wave = np.sin(2 * np.pi * 180 * t) * np.minimum(1, t / .05) * np.minimum(1, (seconds - t) / .05) * .3
            return (wave * 32767).astype("<i2").tobytes()

        @staticmethod
        def voices():
            return []
    return Fake


async def main(args):
    import uvicorn
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles
    from core import (character_sheet, character_store, design_render_bridge, speech_optional, style_pack_sample, style_pack_store,
                      video_longform, video_narration, video_plan, video_render, video_store)
    from core.constants import STATIC_DIR
    from routes import character_routes, design_routes, video_routes

    real_voice = bool(args.models)
    if real_voice:
        speech_optional.OPTIONAL_DIR = args.models
        # Word captions use the whisper.cpp model next to Kokoro's folder (speech_models), read only.
        from core import video_align
        if any(Path(args.models).parent.glob("ggml-*.bin")):
            video_align.MODEL_DIR = str(Path(args.models).parent)
    else:
        video_narration._ready = lambda voice: tone_voice()
    app = FastAPI()
    app.include_router(video_routes.router)
    app.include_router(character_routes.router)
    app.include_router(design_routes.render_router)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="warning"))
    serving = asyncio.create_task(server.serve())
    result = {"ok": False, "real_voice": real_voice}
    try:
        for _ in range(600):
            if design_render_bridge.available():
                break
            await asyncio.sleep(.1)
        else:
            raise RuntimeError("Electron's render worker did not connect.")
        spec = PACK_A if args.pack_a else SAMPLE if args.sample else SMOKE
        if args.style_pack or args.long_form or args.pack_b:
            spec = {"aspects": [style_pack_sample.ASPECT], "characters": [], "beats": []}
        # Characters: made from the starting family, sheet rendered by the worker and checked, then approved here.
        cast, sheets = [], []
        pack = None
        if args.pack_b:
            pack = style_pack_store.install_starter(style_pack_store.STARTER_3D_ID, by="smoke")
            if args.renderer == "blender":
                pack = style_pack_store.new_version(pack["id"], {"renderer": "blender"}, by="smoke", note="Render with Blender.")
        pack_version = pack["versions"][-1]["version"] if pack else 1
        if args.pack_b and args.preview:
            data = style_pack_store.spec(pack["id"], pack_version)
            project = video_store.create(style_pack_sample.TITLE_3D, owner="smoke", beats=style_pack_sample.beats(data),
                                         **{k: v for k, v in style_pack_sample.project_options(data, pack["id"], pack_version).items() if k != "style_pack"})
            project = await asyncio.to_thread(video_narration.prepare, project["id"])
            outline = video_render.outline(project)
            times = [b["start"] + (b["end"] - b["start"]) * f for b in outline[:-1] for f in (.3, .8)][:12]
            began = time.time()
            frames = await video_render.preview(project["id"], "16:9", times)
            keep = Path(args.keep or tempfile.mkdtemp(prefix="pack-b-preview-"))
            keep.mkdir(parents=True, exist_ok=True)
            for t, raw in zip(times, frames):
                (keep / f"preview-{t:06.2f}.jpg").write_bytes(raw)
            (keep / "preview-contact.png").write_bytes(__import__("core.ffmpeg_tools", fromlist=["x"]).contact_sheet(frames, 4))
            result.update(ok=True, job={"status": "ready", "seconds": video_store.duration(project), "narration": {"lines": 1},
                                        "notes": video_render._last_preview.get(project["id"], {}).get("notes", [])},
                          render_seconds=round(time.time() - began, 1), kept=str(keep), preview=True)
            return
        if args.style_pack or args.long_form or args.pack_b:
            if not args.pack_b:
                pack = style_pack_store.install_starter(by="smoke")
            for entry in style_pack_store.spec(pack["id"], pack_version)["characters"]:
                meta = await character_sheet.submit(entry["character"], entry["version"])
                sheets.append({"id": meta["id"], "name": meta["name"], "metrics": character_store.version_of(meta, entry["version"])["metrics"]})
                character_store.decide(meta["id"], entry["version"], True, "render smoke (test approval in a temporary store)")
        for family in spec.get("characters", []):
            meta = character_store.create(character_store.starter(family), by="smoke")
            meta = await character_sheet.submit(meta["id"], 1)
            sheets.append({"id": meta["id"], "name": meta["name"], "metrics": meta["versions"][0]["metrics"]})
            character_store.decide(meta["id"], 1, True, "render smoke (test approval in a temporary store)")
            cast.append(meta["id"])
        beats = json.loads(json.dumps(spec["beats"]))
        for beat in beats:
            for member in beat.get("scene", {}).get("cast", []):
                member["character"] = cast[member["character"]]
        options = {k: v for k, v in spec.items() if k not in ("title", "characters", "beats")}
        if cast:
            options["cast"] = [{"character": c, "version": 1} for c in cast]
        project = None if args.style_pack or args.long_form or args.pack_b else video_store.create(spec["title"], owner="smoke", beats=beats, **options)
        if args.tracks:
            project = await add_tracks(project)
        if args.fps60 and not args.motion:
            project = video_store.save(project["id"], {**video_store.get(project["id"]), "fps": 60})
        media = None
        if args.motion:
            project, media = await add_motion(project, 60 if args.fps60 else 30)
        if args.long_form:
            # The pack is test-approved here (in the app only the person approves), then the chaptered video is made in it.
            style_pack_store.submit(pack["id"], 1, {"by": "render smoke"})
            style_pack_store.decide(pack["id"], 1, True, "render smoke (test approval in a temporary store)")
            data = style_pack_store.spec(pack["id"], 1)
            cast_ids = [e["character"] for e in data["characters"]]
            beats, chapters = long_form_beats()
            for beat in beats:
                for member in beat.get("scene", {}).get("cast", []):
                    member["character"] = cast_ids[member["character"]]
            project = video_store.create("The Moon, our nearest neighbour", owner="smoke", beats=beats, chapters=chapters,
                                         **style_pack_sample.project_options(data, pack["id"], 1))
        result["sheets"] = sheets
        # Prove the sheet-match checks measured real frames: count the frames with a character in them, and run the
        # same frames against a deliberately wrong palette, which must be named.
        checked = {}
        real_notes = video_render.character_notes

        def watched(project_, layouts, frames, times):
            notes = real_notes(project_, layouts, frames, times)
            if frames and len(frames) >= 12:
                by_time = {round(x.get("time", -1), 6): x.get("elements", []) for x in layouts}
                checked["frames_with_characters"] = sum(any(b.get("kind") == "character" for b in by_time.get(round(t, 6), [])) for t in times)
                from core import character_checks
                cast_now = character_store.resolve(project_.get("cast", []))
                wrong = {k: {**v, "spec": {**v["spec"], "palette": {**v["spec"]["palette"], "body": "#00ff00", "body_shade": "#00cc00",
                                                                       "head": "#0000ff", "outline": "#ff00ff"}}} for k, v in cast_now.items()}
                tampered = []
                for frame, t in zip(frames, times):
                    boxes = [b for b in by_time.get(round(t, 6), []) if b.get("kind") in ("character", "prop")]
                    tampered += character_checks.frame_notes(frame, boxes, wrong)
                checked["wrong_palette_notes"] = len(tampered)
            return notes
        video_render.character_notes = watched
        began = time.time()

        async def progress():
            while True:
                await asyncio.sleep(10)
                states = [j["status"] for j in video_render._jobs.values()]
                print(f"video-render-smoke: {round(time.time() - began)} s, {states}", flush=True)
        ticker = asyncio.create_task(progress())
        try:
            if args.style_pack or args.pack_b:
                # The pack's own sample, exactly as Studio and the bots make it; the render job is caught for the report.
                jobs = []
                real_render = video_render.render

                async def caught(video_id, aspect, sample_of=None):
                    job_ = await real_render(video_id, aspect, sample_of=sample_of)
                    jobs.append(job_)
                    return job_
                style_pack_sample.video_render.render = caught
                meta = await style_pack_sample.make(pack["id"], pack_version, owner="smoke", by="render smoke")
                job = jobs[-1]
                project = video_store.get(job["video_id"])
                result["pack"] = {"id": pack["id"], "name": meta["name"], "step": meta["step"], "version": pack_version,
                                  "renderer": style_pack_store.spec(pack["id"], pack_version)["renderer"],
                                  "status": style_pack_store.version_of(meta, pack_version)["status"]}
            elif args.long_form:
                job = await long_form_run(project, result)
            else:
                job = await video_render.render(project["id"], spec["aspects"][0])
        finally:
            ticker.cancel()
        result.update(job={k: v for k, v in job.items() if k != "path"}, render_seconds=round(time.time() - began, 1))
        if job["status"] != "ready":
            raise RuntimeError(job["status"])
        project = video_store.get(project["id"])
        folder = video_store._folder(project["id"]) / "renders"
        result.update(ok=True, project=project, files=sorted(p.name for p in folder.iterdir()), sheet_match=checked)
        if args.tracks:
            # The overlay is in the encoded video: the title card's colour is the look's background, where the beat shows
            # the scene's sky without it.
            import re
            from core import design_systems
            bg = re.search(r"--ds-bg:\s*(#[0-9A-Fa-f]{6})", design_systems.tokens_css(design_systems.get(project["look"])["tokens"])).group(1)
            intro = project["tracks"][0]["clips"][0]
            frame_keep = (Path(args.keep) / f"{args.name or 'narrated-sample'}-overlay-frame.png") if args.keep else None
            if frame_keep:
                frame_keep.parent.mkdir(parents=True, exist_ok=True)
            result["overlay"] = {"bg": bg, "card": overlay_frame(job["path"], intro["start"] + 1.0, intro["box"], frame_keep),
                                 "sound_clips": (job.get("narration") or {}).get("sound_clips"),
                                 "clips": sum(len(t["clips"]) for t in project["tracks"])}
        if args.motion:
            # The words were aligned, the video clip is in the encoded frames (its sky blue inside its box once it has
            # risen), and the title card rests where its last keyframe puts it.
            beats = project["beats"]
            spoken = [b["spoken"] for b in beats if "spoken" in b]
            sky = project["tracks"][1]["clips"][0]
            settled = sky["start"] + (1.3 - sky["in"]) + .4
            frame_keep = (Path(args.keep) / f"{args.name or 'narrated-sample'}-video-clip-frame.png") if args.keep else None
            if frame_keep:
                frame_keep.parent.mkdir(parents=True, exist_ok=True)
            intro = project["tracks"][0]["clips"][0]
            result["motion"] = {
                "fps": project["fps"], "lines": len(spoken), "aligned": sum(1 for x in spoken if "words" in x),
                "confidence": [x.get("align", {}).get("confidence") for x in spoken], "method": (spoken[0].get("align") or {}).get("method"),
                "words": sum(len(x.get("words", [])) for x in spoken), "media": media,
                "sky_in_box": overlay_frame(job["path"], settled, sky["box"], frame_keep),
                "box_before_clip": overlay_frame(job["path"], max(0, sky["start"] - .3), sky["box"]),
                "align_notes": sorted({(x.get("align") or {}).get("note", "") for x in spoken} - {""}),
                "title_at_rest": overlay_frame(job["path"], intro["start"] + 1.6, intro["box"]),
                "keys": sum(len(v) for t in project["tracks"] for c in t["clips"] for v in (c.get("keys") or {}).values())}
        if args.exports:
            from core import video_export
            master = Path(job["path"])
            exports = {"mp4": {"bytes": master.stat().st_size}}
            for fmt in ("webm", "mov", "gif"):
                exports[fmt] = await asyncio.to_thread(video_export.make, master, fmt)
            began_prores = time.time()
            prores = await asyncio.to_thread(video_export.prores, master, master.with_name("prores-measure.mov"))
            exports["prores_measured"] = {"bytes": prores.stat().st_size, "seconds_spent": round(time.time() - began_prores, 2)}
            result["exports"] = exports
        if args.keep:
            keep = Path(args.keep)
            keep.mkdir(parents=True, exist_ok=True)
            slug = spec["aspects"][0].replace(":", "-")
            stem = args.name or "narrated-sample"
            shutil.copy2(job["path"], keep / f"{stem}.mp4")
            if args.exports:
                for fmt in ("webm", "gif"):
                    shutil.copy2(Path(job["path"]).with_suffix("." + fmt), keep / f"{stem}.{fmt}")
            for sheet in sheets:
                shutil.copy2(character_store.sheet_path(sheet["id"], 1), keep / f"{stem}-character-sheet-{sheet['name'].lower().replace(' ', '-')}.png")
            if pack:
                (keep / f"{stem}.kairos-style.json").write_bytes(style_pack_store.export_bytes(pack["id"], pack_version))
            shutil.copy2(folder / f"sheet-{slug}.png", keep / f"{stem}-contact-sheet.png")
            shutil.copy2(folder / f"thumb-{slug}.png", keep / f"{stem}-thumbnail.png")
            if args.long_form:
                (keep / f"{stem}-chapters.txt").write_text(job["chapters_text"] + "\n", encoding="utf-8")
                (keep / f"{stem}-shot-plan.txt").write_text(video_plan.plan_text(project) + "\n", encoding="utf-8")
            (keep / f"{stem}-project.json").write_text(json.dumps(project, indent=2, ensure_ascii=False), encoding="utf-8")
            result["kept"] = str(keep)
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        Path(args.out).write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        server.should_exit = True
        server.force_exit = True
        # The render worker's job stream stays open and the encoder's threads may linger: the result is written,
        # so end here instead of waiting on them (the suite's Electron side reads the result after this exits).
        sys.stdout.flush()
        shutil.rmtree(os.environ["JARVIS_DATA_DIR"], ignore_errors=True)
        os._exit(0 if result["ok"] else 1)


async def long_form_run(project, result):
    """The long render through the app's own path, with one deliberate stop and resume: the plan is sent and test-approved
    (only the person approves in the app), the render starts, is cancelled halfway into its second chapter, and is
    started again, which reuses the first chapter's part and renders the rest. Times are kept for the report."""
    from core import video_longform, video_narration, video_plan, video_render
    began = time.time()
    project = await asyncio.to_thread(video_narration.prepare, project["id"])
    narrated = time.time() - began
    try:
        video_render.start(project["id"], "16:9")
        raise RuntimeError("a long video rendered before its plan was approved")
    except ValueError as error:
        refused = str(error)
    video_plan.submit(project["id"], by="render smoke")
    video_plan.decide(project["id"], True, "render smoke (test approval in a temporary store)")
    first = video_render.start(project["id"], "16:9")
    started = time.time()
    while True:
        await asyncio.sleep(.5)
        state = video_render.status(first["id"])
        chapters = state.get("chapters") or []
        if len(chapters) > 1 and chapters[1]["state"] == "rendering" and chapters[1].get("done", 0) >= chapters[1]["frames"] // 2:
            break
        if video_render._tasks[first["id"]].done():
            raise RuntimeError("the render ended before it could be stopped: " + state["status"])
    video_render.cancel(first["id"])
    await asyncio.gather(video_render._tasks[first["id"]], return_exceptions=True)
    stopped = video_render.status(first["id"])
    first_seconds = time.time() - started
    lost = stopped["chapters"][1]["frames"] // 2
    stored = video_longform.describe(project["id"])
    resume_at = time.time()
    second = video_render.start(project["id"], "16:9")
    await video_render._tasks[second["id"]]
    job = video_render.status(second["id"])
    result["long"] = {
        "refused_before_approval": refused[:200], "narration_seconds": round(narrated, 1),
        "first_run_seconds": round(first_seconds, 1), "stopped_status": stopped["status"],
        "stopped_chapters": [c["state"] for c in stopped["chapters"]], "stored_after_stop": stored,
        "resume_seconds": round(time.time() - resume_at, 1), "reused_on_resume": job.get("reused"),
        "frames_total": job.get("frames_total"), "fps": job.get("fps"), "frames_redone_after_stop": lost,
        "chapter_seconds": [c.get("seconds") for c in job.get("chapters", [])],
        "chapters_text": job.get("chapters_text"), "disk": job.get("disk"), "video_seconds": job.get("seconds")}
    return job


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--models")
    parser.add_argument("--keep")
    parser.add_argument("--name")
    parser.add_argument("--sample", action="store_true")
    parser.add_argument("--pack-a", action="store_true", dest="pack_a")
    parser.add_argument("--style-pack", action="store_true", dest="style_pack")
    parser.add_argument("--long-form", action="store_true", dest="long_form")
    parser.add_argument("--pack-b", action="store_true", dest="pack_b")
    parser.add_argument("--renderer", choices=("threejs", "blender"), default="threejs")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--tracks", action="store_true")
    parser.add_argument("--motion", action="store_true")
    parser.add_argument("--fps60", action="store_true")
    parser.add_argument("--exports", action="store_true")
    parsed = parser.parse_args()
    data = tempfile.mkdtemp(prefix="video-render-smoke-")
    os.environ["JARVIS_DATA_DIR"] = data
    asyncio.run(main(parsed))   # main ends the process itself once the result is written

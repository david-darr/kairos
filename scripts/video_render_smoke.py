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
        if args.style_pack or args.long_form:
            spec = {"aspects": [style_pack_sample.ASPECT], "characters": [], "beats": []}
        # Characters: made from the starting family, sheet rendered by the worker and checked, then approved here.
        cast, sheets = [], []
        pack = None
        if args.style_pack or args.long_form:
            pack = style_pack_store.install_starter(by="smoke")
            for entry in style_pack_store.spec(pack["id"], 1)["characters"]:
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
        project = None if args.style_pack or args.long_form else video_store.create(spec["title"], owner="smoke", beats=beats, **options)
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
            if args.style_pack:
                # The pack's own sample, exactly as Studio and the bots make it; the render job is caught for the report.
                jobs = []
                real_render = video_render.render

                async def caught(video_id, aspect, sample_of=None):
                    job_ = await real_render(video_id, aspect, sample_of=sample_of)
                    jobs.append(job_)
                    return job_
                style_pack_sample.video_render.render = caught
                meta = await style_pack_sample.make(pack["id"], 1, owner="smoke", by="render smoke")
                job = jobs[-1]
                project = video_store.get(job["video_id"])
                result["pack"] = {"id": pack["id"], "name": meta["name"], "step": meta["step"],
                                  "status": style_pack_store.version_of(meta, 1)["status"]}
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
        if args.keep:
            keep = Path(args.keep)
            keep.mkdir(parents=True, exist_ok=True)
            slug = spec["aspects"][0].replace(":", "-")
            stem = args.name or "narrated-sample"
            shutil.copy2(job["path"], keep / f"{stem}.mp4")
            for sheet in sheets:
                shutil.copy2(character_store.sheet_path(sheet["id"], 1), keep / f"{stem}-character-sheet-{sheet['name'].lower()}.png")
            if pack:
                (keep / f"{stem}.kairos-style.json").write_bytes(style_pack_store.export_bytes(pack["id"], 1))
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
    parsed = parser.parse_args()
    data = tempfile.mkdtemp(prefix="video-render-smoke-")
    os.environ["JARVIS_DATA_DIR"] = data
    asyncio.run(main(parsed))   # main ends the process itself once the result is written

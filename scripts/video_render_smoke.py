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
                      video_narration, video_render, video_store)
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
        if args.style_pack:
            spec = {"aspects": [style_pack_sample.ASPECT], "characters": [], "beats": []}
        # Characters: made from the starting family, sheet rendered by the worker and checked, then approved here.
        cast, sheets = [], []
        pack = None
        if args.style_pack:
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
        project = None if args.style_pack else video_store.create(spec["title"], owner="smoke", beats=beats, **options)
        result["sheets"] = sheets
        # Prove the sheet-match checks measured real frames: count the frames with a character in them, and run the
        # same frames against a deliberately wrong palette, which must be named.
        checked = {}
        real_notes = video_render.character_notes

        def watched(project_, layouts, frames, times):
            notes = real_notes(project_, layouts, frames, times)
            if frames and len(frames) == 12:
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
    parsed = parser.parse_args()
    data = tempfile.mkdtemp(prefix="video-render-smoke-")
    os.environ["JARVIS_DATA_DIR"] = data
    asyncio.run(main(parsed))   # main ends the process itself once the result is written

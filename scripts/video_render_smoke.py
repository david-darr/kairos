"""The backend half of video-render-smoke.cjs: a real narrated render through the app's own render path.

Started by the Electron suite with KAIROS_RENDER_TOKEN set, it serves the player, the motion engine, the design fonts
and the render worker routes on a loopback port, waits for Electron's render worker (electron/designRender.js) to
connect, then creates a narrated video and renders it with core/video_render.render, exactly as video_render and the
Studio do: Kokoro narration first, the soundtrack with the music ducked under it, the offscreen frames, FFmpeg, the
loudness pass, the checks and the contact sheet. It writes what happened to --out as JSON.

Data goes to a temporary folder. With --models pointing at a folder that holds Kokoro's downloaded model files, the
real Kokoro voice speaks (read only); without it a tone stands in for the voice so the suite runs on any machine.
--keep copies the MP4, contact sheet, thumbnail and project JSON to a folder (the morning sample).
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
    "title": "Narration smoke", "look": "sport", "aspects": ["16:9"],
    "beats": [{"id": "one", "kind": "title", "text": "Narrated", "say": "One short line. And a second one, after a comma."},
              {"id": "two", "kind": "end", "text": "Done", "bars": 1}],
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
    from core import design_render_bridge, speech_optional, video_narration, video_render, video_store
    from core.constants import STATIC_DIR
    from routes import design_routes, video_routes

    real_voice = bool(args.models)
    if real_voice:
        speech_optional.OPTIONAL_DIR = args.models
    else:
        video_narration._ready = lambda voice: tone_voice()
    app = FastAPI()
    app.include_router(video_routes.router)
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
        spec = SAMPLE if args.sample else SMOKE
        project = video_store.create(spec["title"], owner="smoke", **{k: v for k, v in spec.items() if k != "title"})
        began = time.time()

        async def progress():
            while True:
                await asyncio.sleep(10)
                states = [j["status"] for j in video_render._jobs.values()]
                print(f"video-render-smoke: {round(time.time() - began)} s, {states}", flush=True)
        ticker = asyncio.create_task(progress())
        try:
            job = await video_render.render(project["id"], spec["aspects"][0])
        finally:
            ticker.cancel()
        result.update(job={k: v for k, v in job.items() if k != "path"}, render_seconds=round(time.time() - began, 1))
        if job["status"] != "ready":
            raise RuntimeError(job["status"])
        project = video_store.get(project["id"])
        folder = video_store._folder(project["id"]) / "renders"
        result.update(ok=True, project=project, files=sorted(p.name for p in folder.iterdir()))
        if args.keep:
            keep = Path(args.keep)
            keep.mkdir(parents=True, exist_ok=True)
            slug = spec["aspects"][0].replace(":", "-")
            stem = args.name or "narrated-sample"
            shutil.copy2(job["path"], keep / f"{stem}.mp4")
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
    parsed = parser.parse_args()
    data = tempfile.mkdtemp(prefix="video-render-smoke-")
    os.environ["JARVIS_DATA_DIR"] = data
    asyncio.run(main(parsed))   # main ends the process itself once the result is written

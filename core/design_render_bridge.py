"""The backend asking the desktop app to render a board (spec 3g).

Nothing used to let the backend ask Electron for work. Now Electron's main
process (electron/designRender.js) holds one loopback stream to
GET /api/design-render/jobs, authenticated by a per-launch token it passed to
this backend in KAIROS_RENDER_TOKEN (removed from the environment at import,
like the UI secret, so nothing the backend starts inherits it). Each job names
one board render URL carrying a short-lived signed token; Electron loads it in
an offscreen window in its own partition, captures a PNG or prints a PDF, and
posts the bytes back to /api/design-render/result/<job>.

Without the desktop app (a bare `python app.py` dev server) available() is
False, and PNG, PDF, PPTX and snapshots say they need the desktop app.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import secrets
import time
from typing import Optional

from core import design_formats, design_render, design_store

TOKEN = os.environ.pop("KAIROS_RENDER_TOKEN", None) or None
JOB_SECONDS = 45
THUMB_WIDTH = 480

_queue: Optional[asyncio.Queue] = None
_pending: dict[str, asyncio.Future] = {}
_workers = 0
_loop: Optional[asyncio.AbstractEventLoop] = None
_thumb_tasks: dict[str, asyncio.Task] = {}


class Unavailable(RuntimeError):
    pass


NEEDS_APP = ("PNG, PDF, PPTX and snapshots need the Kairos desktop app, which renders boards in its own "
             "window. The HTML zip export works anywhere.")


def token_ok(value: Optional[str]) -> bool:
    return bool(TOKEN and value and secrets.compare_digest(value, TOKEN))


def available() -> bool:
    return _workers > 0


def _q() -> asyncio.Queue:
    global _queue, _loop
    if _queue is None:
        _queue = asyncio.Queue()
        _loop = asyncio.get_running_loop()
    return _queue


async def worker_stream():
    """The SSE body Electron reads: one `data:` line per job."""
    global _workers
    queue = _q()
    _workers += 1
    try:
        yield ": connected\n\n"
        while True:
            try:
                job = await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            future = _pending.get(job["id"])
            if future is None or future.done():
                continue
            yield f"data: {json.dumps(job)}\n\n"
    finally:
        _workers -= 1


def complete(job_id: str, data: bytes, error: Optional[str] = None) -> bool:
    future = _pending.get(job_id)
    if future is None or future.done():
        return False
    if error:
        future.set_exception(RuntimeError(error[:300]))
    else:
        future.set_result(data)
    return True


async def render(design_id: str, slug: str, kind: str = "png", *, scale: int = 1,
                 version: Optional[int] = None) -> bytes:
    if kind not in ("png", "pdf"):
        raise ValueError("kind is png or pdf")
    if not available():
        raise Unavailable(NEEDS_APP)
    data = design_store.manifest(design_id)
    meta = data["boards"][slug] if not version else design_store.snapshot_at(design_id, version)["manifest"]["boards"][slug]
    job_id = secrets.token_hex(8)
    path = f"/api/designs/{design_id}/boards/{slug}/render?rt={design_render.sign(design_id, slug)}"
    if version:
        path += f"&v={int(version)}"
    future = asyncio.get_running_loop().create_future()
    _pending[job_id] = future
    # A website or email board grows with its content: the window measures the
    # page and renders it whole, even if no canvas has measured it yet.
    await _q().put({"id": job_id, "kind": kind, "path": path, "w": int(meta["w"]), "h": int(meta["h"]),
                    "scale": 2 if scale == 2 else 1, "grow": design_formats.grows(meta),
                    "min_h": int(meta.get("min_h") or 0)})
    try:
        result = await asyncio.wait_for(future, timeout=JOB_SECONDS)
    except asyncio.TimeoutError:
        raise Unavailable("The desktop app did not finish rendering the board in time. Try again.") from None
    finally:
        _pending.pop(job_id, None)
    if kind == "png" and not result.startswith(b"\x89PNG"):
        raise RuntimeError("The render window returned something other than a PNG.")
    if kind == "pdf" and not result.startswith(b"%PDF"):
        raise RuntimeError("The render window returned something other than a PDF.")
    if kind == "png" and not version and design_formats.grows(meta):
        _keep_height(design_id, slug, result, 2 if scale == 2 else 1)
    return result


def _keep_height(design_id: str, slug: str, png: bytes, scale: int) -> None:
    """A website or email board's page, measured by the render window: the
    PNG is as tall as the page (electron/designRender.js), so the board takes
    that height even if no canvas has shown it live yet (a tall page stays a
    thumbnail at the zoom that fits it). No version; the rows below move."""
    try:
        height = int.from_bytes(png[16:24][4:], "big") // scale  # IHDR: width at bytes 16-19, height at 20-23.
        if height >= 60:
            design_store.fit_height(design_id, slug, height)
    except (LookupError, ValueError):
        pass


async def thumbnail(design_id: str, slug: str) -> Optional[bytes]:
    """A cached small PNG of the board, rendered again when it changed."""
    path = design_store.thumb_path(design_id, slug)
    stamp = path.with_suffix(".json")
    current = design_store.board_hash(design_id, slug)
    if path.is_file() and stamp.is_file() and stamp.read_text() == current:
        return path.read_bytes()
    if not available():
        return path.read_bytes() if path.is_file() else None
    png = await render(design_id, slug, "png")
    try:
        from PIL import Image
        image = Image.open(io.BytesIO(png))
        if image.width > THUMB_WIDTH:
            image = image.resize((THUMB_WIDTH, max(1, round(image.height * THUMB_WIDTH / image.width))))
        out = io.BytesIO()
        image.save(out, "PNG", optimize=True)
        png = out.getvalue()
    except Exception:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    stamp.write_text(current)
    return png


def _refresh(packet: dict) -> None:
    """After a change, re-render the changed boards' thumbnails (background)."""
    if not available() or _loop is None:
        return

    def schedule():
        for slug in packet.get("boards") or []:
            key = f"{packet['designId']}:{slug}"
            old = _thumb_tasks.get(key)
            if old and not old.done():
                old.cancel()

            async def run(design_id=packet["designId"], board=slug):
                await asyncio.sleep(1.5)  # Let a burst of edits settle.
                try:
                    await thumbnail(design_id, board)
                except Exception:
                    pass
            _thumb_tasks[key] = asyncio.ensure_future(run())
    try:
        if asyncio.get_running_loop() is _loop:
            schedule()
            return
    except RuntimeError:
        pass
    _loop.call_soon_threadsafe(schedule)


design_store.on_change(_refresh)

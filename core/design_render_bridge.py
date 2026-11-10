"""The backend asking the desktop app to render a board (spec 3g).

Nothing used to let the backend ask Electron for work. Now Electron's main
process (electron/designRender.js) holds one loopback stream to
GET /api/design-render/jobs, authenticated by a per-launch token it passed to
this backend in KAIROS_RENDER_TOKEN (removed from the environment at import,
like the UI secret, so nothing the backend starts inherits it). Each job names
one board render URL carrying a short-lived signed token; Electron loads it in
an offscreen window in its own partition, captures a PNG, prints a PDF or
measures the layout (JSON, for the editable PowerPoint export), and posts the
bytes back to /api/design-render/result/<job>.

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

from core import accounts, design_formats, design_html, design_render, design_store

TOKEN = os.environ.pop("KAIROS_RENDER_TOKEN", None) or None
JOB_SECONDS = 45
THUMB_WIDTH = 480
PAGE_WIDTH = 816   # A document page's PNG width: its own CSS px at Letter.

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
            if job.get("kind") == "cancel":
                yield f"data: {json.dumps(job)}\n\n"
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
                 version: Optional[int] = None, hide: Optional[list[dict]] = None) -> bytes:
    """A board's PNG, PDF or layout JSON. `hide` ({id, mode: text|box|all}) blanks
    elements in a PNG, for the PowerPoint background picture."""
    if kind not in ("png", "pdf", "layout"):
        raise ValueError("kind is png, pdf or layout")
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
                    "paged": design_formats.paged(meta), "min_h": int(meta.get("min_h") or 0),
                    "hide": [{"id": h["id"], "mode": h["mode"]} for h in (hide or [])
                             if h.get("mode") in ("text", "box", "all") and design_html.ID_RE.fullmatch(str(h.get("id") or ""))]})
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
    if kind == "layout" and not result.startswith(b"{"):
        raise RuntimeError("The render window returned something other than a layout.")
    if kind == "png" and not version and not hide and design_formats.grows(meta):
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


async def layout(design_id: str, slug: str) -> dict:
    """Every element's box and computed style, as the render window measured them."""
    return json.loads((await render(design_id, slug, "layout")).decode("utf-8"))


def page_images(pdf: bytes, width: int = PAGE_WIDTH) -> list[bytes]:
    """Each page of a printed document as a PNG `width` px wide (pypdfium2, no desktop app needed)."""
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    out = []
    try:
        for page in doc:
            image = page.render(scale=width / page.get_width()).to_pil()
            buf = io.BytesIO()
            image.save(buf, "PNG", optimize=True)
            out.append(buf.getvalue())
    finally:
        doc.close()
    return out


async def pages(design_id: str, slug: str) -> list[bytes]:
    """A document board's printed pages as PNGs, cached until the board changes (checks and the canvas's
    page view use them)."""
    folder = design_store.thumb_path(design_id, slug).parent / f"{slug}-pages"
    stamp = folder / "stamp.json"
    current = design_store.board_hash(design_id, slug)
    if stamp.is_file() and stamp.read_text() == current:
        return [p.read_bytes() for p in sorted(folder.glob("page-*.png"))]
    if not available():
        return [p.read_bytes() for p in sorted(folder.glob("page-*.png"))] if folder.is_dir() else []
    images = page_images(await render(design_id, slug, "pdf"))
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("page-*.png"):
        old.unlink()
    for n, png in enumerate(images, 1):
        (folder / f"page-{n:03d}.png").write_bytes(png)
    stamp.write_text(current)
    return images


def cached_pages(design_id: str, slug: str) -> list:
    """The cached page PNG paths, current or not (for the checks; never renders)."""
    folder = design_store.thumb_path(design_id, slug).parent / f"{slug}-pages"
    return sorted(folder.glob("page-*.png")) if folder.is_dir() else []


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
                    meta = design_store.manifest(design_id)["boards"].get(board) or {}
                    if design_formats.paged(meta):
                        await pages(design_id, board)
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

# Video jobs use ordered, acknowledged parts so a 120-second film never has
# thousands of JPEGs resident in backend memory. The consumer owns encoding.
_video_parts: dict[str, dict] = {}


FRAME_SECONDS = .2   # the slowest capture rate allowed before a render counts as stuck (5 frames a second)


def video_seconds(job: dict) -> float:
    """How long one video job may take: ten minutes, or longer for a long narrated video."""
    return 600. if job.get("preview") else max(600., 60 + job["frames"] * FRAME_SECONDS)


async def video(job: dict, consumer) -> dict:
    """Queue one signed player job and consume each acknowledged part in order."""
    if not available():
        raise Unavailable("Video previews and renders need the Kairos desktop app. Open the desktop app and try again.")
    job_id = job["id"]
    future = asyncio.get_running_loop().create_future()
    _pending[job_id] = future
    state = {"next": 0, "count": 0, "consumer": consumer, "expected": len(job.get("times", [])) if job.get("preview") else job["frames"],
             "layouts": 0, "lock": asyncio.Lock(), "account": accounts.effective_account()}
    _video_parts[job_id] = state
    await _q().put({**job, "kind": "video"})
    limit = video_seconds(job)
    try:
        return await asyncio.wait_for(future, timeout=limit)
    except asyncio.TimeoutError:
        raise Unavailable(f"The desktop app did not finish the video within {round(limit / 60)} minutes. Try a shorter video.") from None
    finally:
        _pending.pop(job_id, None)
        _video_parts.pop(job_id, None)
        await _q().put({"id": job_id, "kind": "cancel"})


async def complete_video(job_id: str, data: bytes, part=None, error=None) -> bool:
    """Reject duplicates, gaps and excess frames before delivering data to a sink."""
    import base64
    state = _video_parts.get(job_id)
    future = _pending.get(job_id)
    if state is None or future is None or future.done():
        return False
    async with state["lock"]:
        if future.done():
            return False
        if error:
            return complete(job_id, b"", error)
        try:
            packet = json.loads(data)
            if not isinstance(packet, dict):
                raise ValueError("Video results must be JSON objects.")
            if part is None:
                if packet.get("frames") != state["expected"] or state["count"] != state["expected"]:
                    raise ValueError("Video ended before all requested frames arrived.")
                future.set_result({"frames": state["count"]})
                return True
            if not isinstance(part, int) or part != state["next"]:
                raise ValueError("Video parts must arrive once, in order, starting at zero.")
            encoded = packet.get("frames")
            if not isinstance(encoded, list) or not 1 <= len(encoded) <= 15 or state["count"] + len(encoded) > state["expected"]:
                raise ValueError("Video parts hold 1 to 15 requested JPEG frames.")
            frames = [base64.b64decode(value, validate=True) for value in encoded]
            if any(not frame.startswith(b"\xff\xd8") or len(frame) > 8 * 1024 * 1024 for frame in frames):
                raise ValueError("Video frames must be JPEGs under 8 MB.")
            layouts = packet.get("layouts", [])
            if not isinstance(layouts, list) or state["layouts"] + len(layouts) > 120:
                raise ValueError("Video layout samples must be a list of at most 120 samples.")
            for sample in layouts:
                if not isinstance(sample, dict) or not isinstance(sample.get("elements"), list) or len(sample["elements"]) > 500:
                    raise ValueError("Each video sample needs an elements list.")
            # The worker's result request has no sign-in: the consumer runs as the account that started the job.
            with accounts.as_account(state["account"]):
                await state["consumer"](frames, layouts)
            state["count"] += len(frames)
            state["layouts"] += len(layouts)
            state["next"] += 1
            return True
        except Exception as exc:
            if not future.done():
                future.set_exception(RuntimeError(str(exc)))
            return False

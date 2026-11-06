"""Image delivery pipeline for chat and Discord (David's ask 2026-09-10).

Redesigned same day: the first version called Pollinations.ai directly for
free, no-key image generation. David's actual ask was narrower and more
deliberate - image generation should go through the user's own Canva
connector, reached via their real Claude Code session, and nothing else. If
that session has no real Claude Code connection (a local/api model endpoint
- see core/external_brain.py), there is structurally no way to reach it:
those sessions never touch core/brain.py or hive_mind_server.py at all, so
this capability was already Claude-Code-only by construction before this
rewrite, no extra gating needed.

Canva does the actual design/generation and export (its own real MCP
tools, called directly by Claude - see core/brain.py's allowed_tools for
exactly which ones are pre-approved). This module's only job is the last
step: pull the resulting download URL onto disk so the existing
chat/Discord delivery pipeline (unchanged from the Pollinations version -
it never cared how the image was produced) can pick it up.
"""
import os
import shutil
import uuid
from urllib.parse import quote

import httpx

from core import accounts

GENERATED_DIR = None  # override (tests); else the current account's generated_images folder


def generated_dir() -> str:
    return GENERATED_DIR or accounts.path("generated_images")


GENERATED_URL_PREFIX = "/generated-images"

# Real Office/PDF files (David's ask 2026-09-10, after the Canva route kept
# hitting MCP permission walls in non-interactive sessions — Discord, a
# scheduled Task — with no one able to answer the prompt). Own code, not
# vendored from any third-party skill repo (license reasons). Separate
# directory from GENERATED_DIR above rather than merged in: that path is
# specifically for images pulled from a URL (Canva export, Pollinations);
# this one is for files a Bash-run script already wrote to local disk —
# different input shape (a local path, not a URL to fetch), kept apart so
# neither path's tests/behavior needed touching to add the other.
GENERATED_FILES_DIR = None  # override (tests); else the current account's generated_files folder


def generated_files_dir() -> str:
    return GENERATED_FILES_DIR or accounts.path("generated_files")


# Working files a model makes on the way to a deliverable: tool argument JSON, review screenshots, drafts.
# Codex wrote these beside the deliverables (2026-11-05 pass); they live here and are swept after two days.
SCRATCH_DIR = None  # override (tests); else scratch inside the generated files folder
SCRATCH_MAX_AGE = 2 * 86400


def scratch_dir() -> str:
    return SCRATCH_DIR or os.path.join(generated_files_dir(), "scratch")


def sweep_scratch(now: float | None = None) -> int:
    """Remove scratch files older than two days; returns how many went. Never follows links out."""
    import time
    scratch = scratch_dir()
    if not os.path.isdir(scratch):
        return 0
    cutoff, removed = (now or time.time()) - SCRATCH_MAX_AGE, 0
    for root, dirs, files in os.walk(scratch, topdown=False, followlinks=False):
        for name in files:
            path = os.path.join(root, name)
            try:
                if not os.path.islink(path) and os.path.getmtime(path) < cutoff:
                    os.remove(path)
                    removed += 1
            except OSError:
                continue
        if root != scratch:
            try:
                os.rmdir(root)  # only when empty
            except OSError:
                pass
    return removed
GENERATED_FILES_URL_PREFIX = "/generated-files"


def register_generated_file(source_path: str) -> dict:
    """Makes an already-created local file (e.g. a .pptx a skill just built
    via python-pptx) servable from GENERATED_FILES_DIR. Returns {"path",
    "filename", "url"}. Raises FileNotFoundError/OSError on a real problem —
    the calling tool turns that into a plain-text explanation, same contract
    as import_image_from_url below.

    Moves rather than copies when the source is already inside
    GENERATED_FILES_DIR — the normal case now that brain.py/codex_brain.py
    grant write access there directly (David's ask 2026-09-12: build
    deliverables there instead of the vault) — so registering doesn't leave
    a duplicate original sitting next to the renamed copy. A source outside
    that directory (an older workflow, or a model pointing this at existing
    content) is only ever copied, never deleted — it might be something the
    user actually owns."""
    if not os.path.isfile(source_path):
        raise FileNotFoundError(f"no such file: {source_path}")
    files_dir = generated_files_dir()
    os.makedirs(files_dir, exist_ok=True)
    original_name = os.path.basename(source_path)
    filename = f"{uuid.uuid4().hex[:12]}_{original_name}"
    dest = os.path.join(files_dir, filename)
    # normcase: on Windows the same folder can arrive as C:/Users/... or c:\users\... (Codex, 2026-11-05 pass left a
    # duplicate beside its published copy because a case-sensitive compare said "different folder").
    same = lambda a, b: os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))
    same_dir = same(os.path.dirname(os.path.abspath(source_path)), files_dir)
    (shutil.move if same_dir else shutil.copyfile)(source_path, dest)
    return {"path": dest, "filename": filename, "url": f"{GENERATED_FILES_URL_PREFIX}/{quote(filename, safe='')}"}


async def import_image_from_url(url: str) -> dict:
    """Downloads url and saves it under GENERATED_DIR. Returns
    {"path", "filename", "url"}. Raises on a real HTTP failure - the calling
    tool (hive_mind_server.py) turns that into a plain-text explanation
    rather than a crash, same as every other best-effort external call in
    this codebase."""
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        content = resp.content
        content_type = resp.headers.get("content-type", "")

    images_dir = generated_dir()
    os.makedirs(images_dir, exist_ok=True)
    ext = "png" if "png" in content_type else "jpg" if "jpg" in content_type or "jpeg" in content_type else _ext_from_url(url)
    filename = f"{uuid.uuid4().hex[:12]}.{ext}"
    path = os.path.join(images_dir, filename)
    with open(path, "wb") as f:
        f.write(content)

    return {"path": path, "filename": filename, "url": f"{GENERATED_URL_PREFIX}/{filename}"}


def _ext_from_url(url: str) -> str:
    tail = url.split("?", 1)[0].rsplit(".", 1)
    ext = tail[-1].lower() if len(tail) > 1 else ""
    return ext if ext in ("png", "jpg", "jpeg", "gif", "webp") else "png"

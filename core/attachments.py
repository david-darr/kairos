"""Chat file attachments — David's ask 2026-08-31 ("attach files" in the
composer's overflow menu, matching Odysseus's own attach-strip).

Two-step flow, same shape as any real upload UI: stage a file (returns an id
the composer can show as a removable pill before the message is even sent),
then at send time chat_service copies staged files into the session's active
cwd (vault or workspace — see core/workspace.py) under a per-session
.attachments/ folder, and references the relative path in the message text.
Copying into cwd (rather than leaving them in data/attachments/) is what
makes them actually reachable by the Claude Agent SDK's cwd-scoped file
tools, regardless of whether a workspace is set.
"""
import contextlib
import os
import shutil
import uuid
import base64

try:
    import pypdfium2 as pdfium  # BSD-3-Clause/Apache-2.0 — safe to bundle, unlike AGPL PDF libs
except ImportError:
    pdfium = None

from core.constants import DATA_DIR

STAGING_DIR = os.path.join(DATA_DIR, "attachments")

# A scanned PDF's pages are already full-resolution images by construction —
# Claude's own Read tool renders every page and returns them all in one
# response no matter how big services/chat_service.py's transport buffer is
# tuned, which is what produced ATTACHMENT_TOO_LARGE_MESSAGE for an 8.5MB
# scanned course PDF (David's ask 2026-09-13 — see that constant's own
# docstring for the live incident, and the near-identical failure that hit
# a 6-screenshot Discord message before the buffer was raised). A real
# text-based PDF has plenty of extractable text per page; a scan has next
# to none — that's the whole test. Splitting a scanned PDF into one JPEG per
# page before Claude ever sees it means each Read call only returns one
# page, the same escape hatch a person gets by screenshotting pages
# individually, just automatic and without the model having to discover the
# trick itself first.
SCANNED_AVG_CHARS_PER_PAGE = 40
MAX_SPLIT_PAGES = 40
PAGE_RENDER_SCALE = 2.0  # ~144 DPI at PDFium's 72-DPI base — legible, not print-quality
PAGE_JPEG_QUALITY = 78

# Size, not scanned-ness, is what actually breaks the transport (found live
# 2026-10-12, six CS-477 lecture decks: the scanned test above passed them
# all through untouched and two of them killed the turn anyway). Claude's
# Read tool embeds a PDF whole, as one base64 document block, and the CLI's
# stdout line carries that content twice — measured at 2.67x the file's size
# on disk (a 4,815,641-byte deck produced a 12,842,437-byte line against
# core/brain.py's then-10MB max_buffer_size). A text-layer PDF therefore has
# a hard ceiling no amount of text extraction gets around, and it is a
# property of the bytes, not of what's in them.
#
# Splitting into page-range PDFs rather than the per-page JPEGs above keeps
# the text layer intact, which is the whole reason a lecture deck is worth
# reading: Claude gets real selectable text and the slide images, just a few
# files instead of one oversized one.
CLI_LINE_BYTES_PER_FILE_BYTE = 2.67
# Budget per chunk, chosen against core/brain.py's max_buffer_size with room
# for the rest of the JSON envelope and for the ratio moving against us.
MAX_PDF_CHUNK_BYTES = 3 * 1024 * 1024
MIN_CHUNK_PAGES = 1


def oversized_for_read(size_bytes: int, buffer_bytes: int) -> bool:
    """Would a Read of a file this size overflow a transport buffer this big?
    Shared with services/chat_service.py so the failure message and the
    splitting below cannot drift apart."""
    return size_bytes * CLI_LINE_BYTES_PER_FILE_BYTE > buffer_bytes


def _write_page_range(pdf, source_path: str, first: int, last: int) -> str:
    """Write pages [first, last] (zero-based, inclusive) of an open document
    to its own PDF beside the original, and return that path."""
    stem = os.path.splitext(source_path)[0]
    out_path = f"{stem}_pages{first + 1:02d}-{last + 1:02d}.pdf"
    chunk = pdfium.PdfDocument.new()
    try:
        chunk.import_pages(pdf, list(range(first, last + 1)))
        chunk.save(out_path)
    finally:
        chunk.close()
    return out_path


def _split_large_pdf(path: str) -> tuple[list[str], str | None]:
    """If `path` is a PDF too big for one Read, splits it into page-range
    PDFs under the per-chunk budget, deletes the original, and returns the
    new filenames. Otherwise returns [its own basename] untouched.

    Chunks are sized by halving: a page range that still writes too large is
    split again, down to a single page. A single page that is still over
    budget is kept as its own chunk — it is as small as this can get, and one
    oversized page is a far better failure than one oversized deck."""
    name = os.path.basename(path)
    if pdfium is None or not name.lower().endswith(".pdf"):
        return [name], None
    try:
        if os.path.getsize(path) <= MAX_PDF_CHUNK_BYTES:
            return [name], None
        pdf = pdfium.PdfDocument(path)
    except Exception:
        return [name], None  # not a real/parseable PDF — Claude's own tool will report the actual error

    written: list[str] = []
    try:
        page_count = len(pdf)
        if page_count == 0:
            return [name], None
        pending = [(0, page_count - 1)]
        while pending:
            first, last = pending.pop(0)
            out_path = _write_page_range(pdf, path, first, last)
            if os.path.getsize(out_path) <= MAX_PDF_CHUNK_BYTES or last - first + 1 <= MIN_CHUNK_PAGES:
                written.append(out_path)
                continue
            os.remove(out_path)
            middle = first + (last - first) // 2
            # Front of the queue, so the finished list stays in page order.
            pending[:0] = [(first, middle), (middle + 1, last)]
    except Exception:
        for out_path in written:
            with contextlib.suppress(OSError):
                os.remove(out_path)
        return [name], None  # a split that half-worked is worse than the original file
    finally:
        pdf.close()

    os.remove(path)
    if len(written) == 1:
        # Rewriting the document was enough on its own — pdfium often packs
        # a deck down well below the original. Keep the original filename
        # rather than handing back a pointless "_pages01-NN" rename.
        os.replace(written[0], path)
        return [name], f"{name} was rewritten smaller so it could be read in one piece"
    # `written` is already in page order: each split puts its two halves at
    # the front of the queue, so ranges are always finished left to right.
    warning = (f"{name} was too large for one read ({page_count} pages) — it was split into "
               f"{len(written)} parts by page range")
    return [os.path.basename(p) for p in written], warning


def _split_scanned_pdf(path: str) -> tuple[list[str], str | None]:
    """If `path` is a scanned/image-based PDF, renders each page to its own
    small JPEG next to it, deletes the original, and returns the new
    filenames. Otherwise leaves the file untouched and returns [its own
    basename]. Second return value is a warning to surface to the user when
    a very long scan got truncated, else None."""
    name = os.path.basename(path)
    if pdfium is None or not name.lower().endswith(".pdf"):
        return [name], None
    try:
        pdf = pdfium.PdfDocument(path)
    except Exception:
        return [name], None  # not a real/parseable PDF — Claude's own tool will report the actual error
    try:
        page_count = len(pdf)
        if page_count == 0:
            return [name], None
        total_chars = sum(pdf[i].get_textpage().count_chars() for i in range(page_count))
        if total_chars / page_count >= SCANNED_AVG_CHARS_PER_PAGE:
            return [name], None  # real text layer — Claude can read it directly, no need to touch it

        stem = os.path.splitext(path)[0]
        split_names = []
        for i in range(min(page_count, MAX_SPLIT_PAGES)):
            image = pdf[i].render(scale=PAGE_RENDER_SCALE).to_pil()
            page_path = f"{stem}_page{i + 1:02d}.jpg"
            image.convert("RGB").save(page_path, "JPEG", quality=PAGE_JPEG_QUALITY)
            split_names.append(os.path.basename(page_path))
    finally:
        pdf.close()

    os.remove(path)
    warning = None
    if page_count > MAX_SPLIT_PAGES:
        warning = f"{name} has {page_count} pages — only the first {MAX_SPLIT_PAGES} were converted to page images"
    return split_names, warning


def _safe_filename(name: str) -> str:
    name = os.path.basename(name).replace("\\", "_").replace("/", "_")
    return name or "file"


def stage_file(filename: str, content: bytes) -> dict:
    """Save an uploaded file to staging, return {id, filename, size}."""
    os.makedirs(STAGING_DIR, exist_ok=True)
    attachment_id = uuid.uuid4().hex[:12]
    safe_name = _safe_filename(filename)
    dest = os.path.join(STAGING_DIR, f"{attachment_id}_{safe_name}")
    with open(dest, "wb") as f:
        f.write(content)
    return {"id": attachment_id, "filename": safe_name, "size": len(content)}


def _find_staged_path(attachment_id: str) -> str | None:
    if not os.path.isdir(STAGING_DIR):
        return None
    prefix = f"{attachment_id}_"
    for name in os.listdir(STAGING_DIR):
        if name.startswith(prefix):
            return os.path.join(STAGING_DIR, name)
    return None


def staged_file_info(attachment_id: str) -> tuple[str, str] | None:
    """Original upload path and display name for a file sent to a chat."""
    path = _find_staged_path(attachment_id)
    if path is None:
        return None
    filename = os.path.basename(path).split("_", 1)[1]
    return path, filename


def image_mime(attachment_id: str) -> str | None:
    """Recognize supported image bytes, regardless of a supplied filename."""
    info = staged_file_info(attachment_id)
    if not info:
        return None
    with open(info[0], "rb") as handle:
        head = handle.read(12)
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return None


def image_ids(attachment_ids: list[str] | None) -> list[str]:
    return [item for item in attachment_ids or [] if image_mime(item)]


def openai_image_content(text: str, attachment_ids: list[str]) -> list[dict]:
    """OpenAI-compatible image parts; IDs resolve only inside our staging area."""
    parts = [{"type": "text", "text": text}]
    for attachment_id in attachment_ids:
        info = staged_file_info(attachment_id)
        mime = image_mime(attachment_id)
        if not info or not mime:
            raise ValueError("An attached image is no longer available; attach it again.")
        with open(info[0], "rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("ascii")
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}", "detail": "auto"}})
    return parts


def resolve_for_turn(attachment_ids: list[str], session_id: str, cwd: str) -> tuple[list[str], list[str]]:
    """Copy staged attachments into <cwd>/.attachments/<session_id>/ so the
    agent's cwd-scoped file tools can read them, and return their filenames
    (relative to that folder) for referencing in the message text, plus any
    warnings worth surfacing (e.g. a scanned PDF too long to fully convert —
    see _split_scanned_pdf). Staged originals in data/attachments/ are left
    alone — a turn can be retried without re-uploading."""
    if not attachment_ids:
        return [], []
    dest_dir = os.path.join(cwd, ".attachments", session_id)
    os.makedirs(dest_dir, exist_ok=True)
    names, warnings = [], []
    for attachment_id in attachment_ids:
        src = _find_staged_path(attachment_id)
        if not src:
            continue
        filename = os.path.basename(src).split("_", 1)[1] if "_" in os.path.basename(src) else os.path.basename(src)
        dest = os.path.join(dest_dir, filename)
        shutil.copyfile(src, dest)
        split_names, warning = _split_scanned_pdf(dest)
        if warning:
            warnings.append(warning)
        # A scan is already page images by here; anything still whole gets
        # the size test as well, since a text-layer PDF breaks the transport
        # on bytes alone (see _split_large_pdf).
        resolved: list[str] = []
        for split_name in split_names:
            part_names, part_warning = _split_large_pdf(os.path.join(dest_dir, split_name))
            resolved.extend(part_names)
            if part_warning:
                warnings.append(part_warning)
        names.extend(os.path.join(".attachments", session_id, n) for n in resolved)
    return names, warnings

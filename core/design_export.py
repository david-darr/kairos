"""Design exports: HTML zip, PNG, PDF and PPTX (spec 3g).

Every export runs on the computer hosting Kairos and writes a file under
generated_files, so a chat (any model's) can hand it over as an ordinary
artifact. The HTML zip needs nothing but Python. PNG and PDF come from the
desktop app's render window (core/design_render_bridge.py); PPTX places each
board's PNG on its own slide (picture slides: David's decision, 2026-10-22),
with the board title as the slide title and its comments as speaker notes.
"""
from __future__ import annotations

import html
import io
import json
import os
import re
import tempfile
import zipfile
from typing import Optional

from core import design_render, design_render_bridge, design_store, design_systems, image_gen

FORMATS = ("html", "png", "pdf", "pptx")

STATIC_SCRIPT = """(function () {
  document.addEventListener('click', function (event) {
    var toggle = event.target.closest && event.target.closest('[data-kd-toggle]');
    if (toggle) {
      event.preventDefault();
      var node = document.querySelector('[data-kd="' + String(toggle.getAttribute('data-kd-toggle')).replace(/[^a-z0-9-]/g, '') + '"]');
      if (node) { if (node.hasAttribute('hidden')) node.removeAttribute('hidden'); else node.setAttribute('hidden', ''); }
      return;
    }
    var link = event.target.closest && event.target.closest('[data-kd-goto]');
    if (link) {
      event.preventDefault();
      var board = String(link.getAttribute('data-kd-goto')).replace(/[^a-z0-9-]/g, '');
      if (board === 'back') history.back(); else if (board) location.href = board + '.html';
    }
  }, true);
})();"""


def _filename(title: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9 _-]+", "", title or "Design").strip().replace(" ", "-")[:60] or "Design"
    return f"{base}.{ext}"


def _boards(data: dict, boards: Optional[list]) -> list[str]:
    ordered = [slug for slug, _ in design_store.ordered_boards(data)]
    if not boards:
        return ordered
    picked = []
    for board in boards:
        slug = design_store.find_board(data, str(board))
        if slug not in picked:
            picked.append(slug)
    return picked


def html_zip(design_id: str, boards: Optional[list] = None) -> bytes:
    data = design_store.manifest(design_id)
    slugs = _boards(data, boards)
    system = design_systems.get(data.get("design_system")) or design_systems.builtin()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for slug in slugs:
            page = design_render.render_document(design_id, slug, viewer=False, font_base="fonts", data=data)
            page = page.replace("</body>", f"<script>{STATIC_SCRIPT}</script></body>")
            archive.writestr(f"{slug}.html", page)
        cards = "".join(
            f'<a class="card" href="{html.escape(slug)}.html"><span class="frame">{html.escape(data["boards"][slug].get("frame") or "")}'
            f' {data["boards"][slug]["w"]}x{data["boards"][slug]["h"]}</span><strong>{html.escape(data["boards"][slug].get("title") or slug)}</strong></a>'
            for slug in slugs)
        tokens = design_systems.tokens_css(system["tokens"], data.get("token_overrides"))
        faces = design_systems.font_faces(system["id"], "fonts")
        archive.writestr("index.html", (
            f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(data.get("title") or "Design")}</title>'
            f"<style>{faces}\n{tokens}\nbody{{margin:0;padding:48px;background:var(--ds-bg);color:var(--ds-text);font-family:var(--ds-font-sans)}}"
            "h1{font-weight:500;margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}"
            ".card{display:grid;gap:8px;padding:20px;border:1px solid var(--ds-hairline);border-radius:12px;background:var(--ds-surface);"
            "color:var(--ds-text);text-decoration:none}.frame{color:var(--ds-text-dim);font-size:13px}</style></head>"
            f'<body><h1>{html.escape(data.get("title") or "Design")}</h1><div class="grid">{cards}</div></body></html>'))
        folder = os.path.join(design_store.DESIGNS_DIR, design_id, "assets")
        if os.path.isdir(folder):
            for name in os.listdir(folder):
                archive.write(os.path.join(folder, name), f"assets/{name}")
        for face in system.get("fonts") or []:
            path = design_systems.font_path(system["id"], face.get("file", ""))
            if path:
                folder_name = "kairos" if system["id"] == design_systems.BUILTIN_ID else system["id"]
                archive.write(str(path), f"fonts/{folder_name}/{path.name}")
        manifest = {k: v for k, v in data.items() if k not in ("chat_ids", "owner", "visible_to")}
        archive.writestr("design.json", json.dumps(manifest, indent=2))
    return out.getvalue()


async def pngs(design_id: str, slugs: list[str], scale: int = 2) -> list[tuple[str, bytes]]:
    return [(slug, await design_render_bridge.render(design_id, slug, "png", scale=scale)) for slug in slugs]


async def pdf(design_id: str, slugs: list[str]) -> bytes:
    import pypdfium2 as pdfium
    merged = pdfium.PdfDocument.new()
    try:
        for slug in slugs:
            raw = await design_render_bridge.render(design_id, slug, "pdf")
            source = pdfium.PdfDocument(raw)
            try:
                merged.import_pages(source, [0])  # One page per board, whatever the print layout did.
            finally:
                source.close()
        out = io.BytesIO()
        merged.save(out)
        return out.getvalue()
    finally:
        merged.close()


async def pptx(design_id: str, slugs: list[str]) -> bytes:
    from pptx import Presentation
    from pptx.util import Emu, Inches
    data = design_store.manifest(design_id)
    deck = Presentation()
    deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
    open_comments = [c for c in design_store.comments(design_id) if c["status"] != "resolved"]
    layout = deck.slide_layouts[5]  # Title Only
    for slug, png in await pngs(design_id, slugs, scale=2):
        meta = data["boards"][slug]
        slide = deck.slides.add_slide(layout)
        title = slide.shapes.title
        title.text = meta.get("title") or slug
        sw, sh = deck.slide_width, deck.slide_height
        if meta.get("frame") == "slide":
            # Full bleed; the title stays the slide's title, just off the page.
            title.left, title.top, title.width, title.height = 0, -Inches(1), sw, Inches(0.8)
            box = (0, 0, sw, sh)
        else:
            title.left, title.top, title.width, title.height = Inches(0.4), Inches(0.15), sw - Inches(0.8), Inches(0.6)
            area_top, area_h = Inches(0.85), sh - Inches(1.0)
            ratio = min((sw - Inches(0.8)) / meta["w"], area_h / meta["h"])
            width, height = int(meta["w"] * ratio), int(meta["h"] * ratio)
            box = ((sw - width) // 2, area_top, width, height)
        picture = slide.shapes.add_picture(io.BytesIO(png), Emu(box[0]), Emu(box[1]), Emu(box[2]), Emu(box[3]))
        if meta.get("frame") == "slide":
            slide.shapes._spTree.remove(picture._element)
            slide.shapes._spTree.insert(2, picture._element)  # Behind the title.
        notes = [f"- {c['text']}" for c in open_comments if c["board"] == slug]
        if notes:
            slide.notes_slide.notes_text_frame.text = "Comments:\n" + "\n".join(notes)
    out = io.BytesIO()
    deck.save(out)
    return out.getvalue()


async def export(design_id: str, fmt: str, boards: Optional[list] = None) -> tuple[str, bytes]:
    """(filename, bytes). Raises design_render_bridge.Unavailable for a
    rendered format without the desktop app."""
    if fmt not in FORMATS:
        raise ValueError(f"format is one of {', '.join(FORMATS)}.")
    data = design_store.manifest(design_id)
    slugs = _boards(data, boards)
    if not slugs:
        raise ValueError("This design has no boards to export.")
    title = data.get("title") or "Design"
    if fmt == "html":
        result = (_filename(title, "zip"), html_zip(design_id, slugs))
    elif fmt == "png":
        images = await pngs(design_id, slugs)
        if len(images) == 1:
            result = (_filename(f"{title} {data['boards'][slugs[0]].get('title')}", "png"), images[0][1])
        else:
            out = io.BytesIO()
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
                for n, (slug, png) in enumerate(images, 1):
                    archive.writestr(f"{n:02d}-{slug}.png", png)
            result = (_filename(f"{title} PNG", "zip"), out.getvalue())
    elif fmt == "pdf":
        result = (_filename(title, "pdf"), await pdf(design_id, slugs))
    else:
        result = (_filename(title, "pptx"), await pptx(design_id, slugs))
    design_store.mark_exported(design_id)
    return result


def publish(filename: str, raw: bytes) -> dict:
    """Write the export into generated_files; returns {url, filename, path}."""
    folder = tempfile.mkdtemp(prefix="kairos-design-")
    path = os.path.join(folder, filename)
    with open(path, "wb") as handle:
        handle.write(raw)
    try:
        return image_gen.register_generated_file(path)
    finally:
        try:
            os.remove(path)
            os.rmdir(folder)
        except OSError:
            pass

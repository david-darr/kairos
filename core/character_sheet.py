"""Render a character spec into its reference sheet PNG and send it for the person's approval (Video Styles unit 3).

The sheet is drawn by static/motion/sheet.js with the same rig the videos use, in the desktop app's offscreen render
window (electron/designRender.js, a PNG job on /api/characters/<id>/sheet), so what the person approves is exactly
what the videos draw. LAYOUT is the sheet's grid; the page receives it so the checks below know where each cell is.

submit() renders, measures the sheet's front view (core/character_checks.sheet_metrics), stores both on the version
(core/character_store.set_sheet: it now waits for approval) and puts an approval item in the person's Inbox through
the Content Studio Producer when the account has the team. The person approves or rejects in Studio > Content.
"""
from __future__ import annotations

import json
from pathlib import Path

from core import character_checks, character_store, design_render
from core.constants import STATIC_DIR

W, H = 2400, 1500
LAYOUT = {
    "w": W, "h": H, "background": "#f6f3ee",
    "views": [{"view": v, "x": i * 600, "y": 150, "w": 600, "h": 650, "height": 500, "feet": 775}
              for i, v in enumerate(character_store.VIEWS)],
    "expressions": [{"expression": e, "x": i * 480, "y": 810, "w": 480, "h": 390, "height": 290, "feet": 1185}
                    for i, e in enumerate(character_store.EXPRESSIONS)],
    "mouths": [{"mouth": m, "x": i * 250, "y": 1210, "w": 250, "h": 290, "height": 520}
               for i, m in enumerate(character_store.MOUTHS)],
    "palette": {"x": 1530, "y": 1210, "cw": 290, "ch": 70, "keys": list(character_store.PALETTE_KEYS)},
}
SCOPE = "sheet:{version}"


class Unavailable(RuntimeError):
    """The message is for the person or the model as-is."""


def page(character_id, version) -> str:
    """The sheet page: data only (the spec and layout as JSON), drawn by the fixed sheet.js module."""
    spec = character_store.spec(character_id, version)
    meta = character_store.get(character_id)
    status = character_store.version_of(meta, version)["status"].replace("_", " ")
    html = (Path(STATIC_DIR) / "motion" / "sheet.html").read_text(encoding="utf-8")
    data = json.dumps({"spec": spec, "layout": LAYOUT, "version": version, "status": status}, ensure_ascii=False).replace("</", "<\\/")
    return html.replace("<!--KD-SHEET-->", '<script type="application/json" id="kd-sheet-data">' + data + "</script>")


def path_for(character_id, version) -> str:
    token = design_render.sign(character_id, SCOPE.format(version=int(version)), 300)
    return f"/api/characters/{character_id}/sheet?v={int(version)}&rt={token}"


async def render(character_id, version) -> bytes:
    from core import design_render_bridge
    character_store.spec(character_id, version)
    if not design_render_bridge.available():
        raise Unavailable("Rendering a character sheet needs the Kairos desktop app. Open it and try again.")
    return await design_render_bridge.sheet(path_for(character_id, version), W, H)


def notify(meta, version) -> bool:
    """An approval item in the person's Inbox, as the Content Studio Producer (when the account has the team)."""
    try:
        from services.content_studio import delivery, studio
        return delivery._send(studio, f"Character sheet to approve: {meta['name']}, version {version}",
                              f"{meta['name']} (version {version}) has a new reference sheet. Approve or reject it in Studio > Content > "
                              "Characters. A video can only use an approved version.", False, None)
    except Exception:
        return False


async def submit(character_id, version, png: bytes | None = None) -> dict:
    """Render (unless given), measure, store and send for approval. Returns the character with the version's metrics."""
    meta = character_store.get(character_id)
    v = character_store.version_of(meta, version)
    if v["status"] == "approved":
        raise character_store.ApprovalError(f"Version {version} of {meta['name']} is already approved.")
    png = png if png is not None else await render(character_id, version)
    metrics = character_checks.sheet_metrics(png, character_store.spec(character_id, version), LAYOUT)
    if not metrics.get("ok"):
        raise ValueError("The sheet did not pass its own checks: " + " ".join(metrics.get("problems") or []))
    meta = character_store.set_sheet(character_id, version, png, metrics)
    meta["notified"] = notify(meta, version)
    return meta

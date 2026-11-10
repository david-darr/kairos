"""Sheet-match quality checks for Pack A characters (Video Styles build spec, section 5; unit 3).

One measurement, used twice: on the approved reference sheet when it is rendered (its front view), and on the video's
sampled frames (each character the layout reports at that moment). Both are pixels, not the rig's own numbers:
- palette: the share of the figure's pixels within a colour tolerance of the spec's body, head, limb and outline;
- outline width: straight down from the body's centre, the run of outline-coloured pixels at the body's lower edge;
- body size: how far that edge is from the centre, against the height the figure was drawn at;
- silhouette size per shot type: the figure's height against the frame's short side (wide, medium, close bands).
A frame passes when its numbers agree with the approved sheet within tolerance. JPEG frames blur edges by a pixel,
so the tolerances are generous; the checks are for drift and wrong data, not for anti-aliasing.
"""
from __future__ import annotations

import io

import numpy as np
from PIL import Image

TOL = 34                 # RGB distance that still counts as the same flat colour (JPEG and soft gradients)
OUTLINE_TOL = 60
SHOT_BANDS = {"wide": (.22, .40), "medium": (.36, .58), "close": (.58, .95)}
MIN_SHARE = {"body": .03, "head": .015, "limb": .003, "outline": .01}
OUTLINE_SPREAD = .5      # a frame's outline may be this far (as a share) from the sheet's, or 1.6 px, whichever is more
BODY_SPREAD = .2


def _rgb(hex_colour):
    return np.array([int(hex_colour[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


def _near(pixels, colour, tol=TOL):
    return np.sqrt(((pixels - colour) ** 2).sum(axis=-1)) <= tol


def _array(image):
    if isinstance(image, (bytes, bytearray)):
        with Image.open(io.BytesIO(image)) as im:
            return np.asarray(im.convert("RGB"), dtype=np.float32)
    return np.asarray(image, dtype=np.float32)


def _body_mask(pixels, palette):
    body, shade = _rgb(palette["body"]), _rgb(palette["body_shade"])
    return _near(pixels, body) | _near(pixels, shade) | _near(pixels, (body + shade) / 2)


def body_centre(spec, height):
    """The body's centre below the feet, in pixels up (negative), as static/motion/rig.js geometry() places it."""
    p = spec["proportions"]
    top = -height + p["head"] * height * .82
    bottom = -p["limb_length"] * height * .9
    return (top + bottom) / 2, bottom - top


def _column_measure(pixels, palette, cx, cy):
    """Walk down from the body's centre: the outline run at its lower edge, and how far that edge is. Straight down
    from the centre there are no arms or eyes (arms hang at the sides, legs start off-centre), so the first
    outline-coloured run is the body's own. None when the walk does not start on the body."""
    h, w = pixels.shape[:2]
    cy, cx = int(round(cy)), int(round(cx))
    if not (0 <= cy < h and 0 <= cx < w):
        return None
    column = pixels[:, cx]
    outline = _near(column, _rgb(palette["outline"]), OUTLINE_TOL)
    inside = _body_mask(column[None, :, :], palette)[0] | _near(column, _rgb(palette["head"]), 60)
    if not inside[max(0, cy - 3):cy + 4].any():
        return None
    y = cy
    while y < h and not outline[y]:
        y += 1
    start = y
    while y < h and outline[y]:
        y += 1
    if start >= h or y == start:
        return None
    return {"outline_px": float(y - start), "half_px": float(start - cy)}


def shares(pixels, palette):
    """The share of pixels in a region near each key colour of the spec."""
    total = max(1, pixels.shape[0] * pixels.shape[1])
    out = {"body": float(_body_mask(pixels, palette).sum() / total)}
    for key in ("head", "limb"):
        out[key] = float(_near(pixels, _rgb(palette[key])).sum() / total)
    out["outline"] = float(_near(pixels, _rgb(palette["outline"]), OUTLINE_TOL).sum() / total)
    return out


def sheet_metrics(png: bytes, spec: dict, layout: dict) -> dict:
    """Measure the rendered sheet's front view: what every frame of an approved character is compared with."""
    pixels = _array(png)
    cell = next(c for c in layout["views"] if c["view"] == "front")
    x0, y0, x1, y1 = cell["x"] + 14, cell["y"] + 60, cell["x"] + cell["w"] - 14, cell["y"] + cell["h"] - 14
    region = pixels[y0:y1, x0:x1]
    background = _rgb(layout["background"])
    figure = ~_near(region, background, 12)
    ys, xs = np.nonzero(figure)
    problems = []
    if not len(ys):
        return {"ok": False, "problems": ["The sheet's front view is empty."]}
    height = cell["height"]
    centre, _ = body_centre(spec, height)
    row = _column_measure(pixels, spec["palette"], cell["x"] + cell["w"] / 2, cell["feet"] + centre)
    found = shares(region[ys.min():ys.max() + 1, xs.min():xs.max() + 1], spec["palette"])
    metrics = {"ok": True, "height_px": height, "silhouette_ratio": round((ys.max() - ys.min() + 1) / height, 3),
               "shares": {k: round(v, 4) for k, v in found.items()}}
    expected = spec["outline"] / 1000
    if row:
        metrics["outline_ratio"] = round(row["outline_px"] / height, 4)
        metrics["body_ratio"] = round(row["half_px"] / height, 3)
        want = body_centre(spec, height)[1] / 2 / height
        if abs(metrics["outline_ratio"] - expected) > max(expected * OUTLINE_SPREAD, 1.6 / height):
            problems.append(f"The sheet's outline measures {row['outline_px']:.1f} px; the spec asks {expected * height:.1f} px.")
        if abs(metrics["body_ratio"] - want) > want * BODY_SPREAD:
            problems.append("The sheet's body size is off the spec's proportions.")
    else:
        problems.append("The sheet's body could not be measured below its centre.")
    for key, least in MIN_SHARE.items():
        if found[key] < least:
            problems.append(f"The sheet's front view shows too little of its {key} colour ({spec['palette'][key]}).")
    metrics["problems"] = problems
    metrics["ok"] = not problems
    return metrics


def frame_notes(frame: bytes, boxes: list[dict], cast: dict) -> list[str]:
    """Compare each character in one sampled frame with its approved sheet. `cast` is character_store.resolve()."""
    notes = []
    if not boxes:
        return notes
    pixels = _array(frame)
    fh, fw = pixels.shape[:2]
    for box in boxes:
        entry = cast.get(box.get("character"))
        if not entry:
            continue
        spec, sheet, name = entry["spec"], entry.get("metrics") or {}, entry["name"]
        label = f"Beat {box.get('beat', '?')}: {name}"
        short = box.get("short") or min(fw, fh)
        low, high = SHOT_BANDS.get(box.get("shot"), (0, 9))
        size = box["height"] / short
        if not low <= size <= high:
            notes.append(f"{label} is {size:.0%} of the frame's height, outside the {box.get('shot')} shot's {low:.0%} to {high:.0%}.")
        x0, y0 = max(0, int(box["x"])), max(0, int(box["y"]))
        x1, y1 = min(fw, int(box["x"] + box["w"])), min(fh, int(box["y"] + box["h"]))
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        found = shares(pixels[y0:y1, x0:x1], spec["palette"])
        for key, least in MIN_SHARE.items():
            if key == "head" and box.get("view") == "back":
                continue
            if found[key] < least * .6:
                notes.append(f"{label}'s {key} colour is off the approved sheet ({spec['palette'][key]} covers {found[key]:.1%} of the figure).")
        others = [b for b in boxes if b is not box and b.get("kind") in ("character", "prop", "text")]
        cx, cy = box["body"]["cx"], box["body"]["cy"]
        if box.get("action") == "walk" or cy + box["body"]["h"] / 2 + 4 > fh or any(b["x"] <= cx <= b["x"] + b["w"] and b["y"] <= cy + box["body"]["h"] and cy <= b["y"] + b["h"] for b in others):
            continue      # crossing legs, the body running off the frame, or a figure, prop or caption over its lower edge
        row = _column_measure(pixels, spec["palette"], cx, cy)
        if row is None:
            notes.append(f"{label}'s body could not be found where the rig drew it; check the frame.")
            continue
        height = box["height"]
        # The outline is compared with the approved spec's weight: the sheet is captured through a resize, which thins
        # its anti-aliased edge, so its own measurement is kept as a record rather than used as the yardstick.
        ratio, want = row["outline_px"] / height, spec["outline"] / 1000
        if abs(ratio - want) > max(want * OUTLINE_SPREAD, 1.6 / height):
            notes.append(f"{label}'s outline measures {row['outline_px']:.1f} px against the approved {want * height:.1f} px.")
        body_want = sheet.get("body_ratio") or body_centre(spec, 1)[1] / 2
        if abs(row["half_px"] / height - body_want) > body_want * BODY_SPREAD:
            notes.append(f"{label}'s body size is off the approved sheet ({row['half_px'] * 2:.0f} px body at {height:.0f} px tall).")
    return list(dict.fromkeys(notes))

"""Sheet-match quality checks for Pack A characters (Video Styles build spec, section 5; unit 3).

One measurement, used twice: on the approved reference sheet when it is rendered (its front view), and on the video's
sampled frames (each character the layout reports at that moment). Both are pixels, not the rig's own numbers:
- palette: the share of the figure's pixels within a colour tolerance of the spec's body, head, limb and outline;
- outline width: straight down from the body's centre, the run of outline-coloured pixels at the body's lower edge;
- body size: how far that edge is from the centre, against the height the figure was drawn at;
- silhouette size per shot type: the figure's height against the frame's short side (wide, medium, close bands).
A frame passes when its numbers agree with the approved sheet within tolerance. JPEG frames blur edges by a pixel,
so the tolerances are generous; the checks are for drift and wrong data, not for anti-aliasing.

Pack B's 3D characters (form 3d) are lit glossy shapes with no outline, so they are measured differently:
- on the 3D sheet's flat colour key (each part in its spec colour, unlit): the share of body, head and limb colour, the
  silhouette's height against the 1.5 m figure, and the body's width at its centre against the spec's body width;
- on the sheet's lit front view and on every sampled video frame: the colour at the projected body and head centres
  has the hue of the spec's body and head colours (light changes brightness, not hue), and is not grey;
- per shot type, the figure's projected height against the frame's short side (STAGE_BANDS).
The body plan numbers repeat static/motion/stage.js bodyPlan (stage_plan); a test keeps them equal.
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


STAGE_BANDS = {"wide": (.24, .46), "medium": (.38, .6), "close": (.5, .78)}
HUE_TOL = 26             # degrees: lit glossy colour keeps its hue within this of the spec colour
STAGE_HEIGHT = 1.5       # metres, static/motion/stage.js HEIGHT
ACCESSORY_TOP = {"leaf": .2, "antenna": .24}


def stage_plan(spec):
    """The 3D body plan (static/motion/stage.js bodyPlan): heights in metres from the feet."""
    p, h = spec["proportions"], STAGE_HEIGHT
    hh = p["head"] * h / 2
    zh = h - hh
    bottom = p["limb_length"] * h * .62 * .72
    top = zh - hh * .25
    return {"zh": zh, "hh": hh, "face": zh - .2 * hh, "zb": (bottom + top) / 2, "br": p["body_width"] * h * .5 * .78, "top": h + ACCESSORY_TOP.get(spec["accessory"], .02)}


def voxel_plan(spec):
    """Pack C's blocky body plan (static/motion/voxel.js voxelPlan): heights in metres from the feet. The head is sampled
    on its forehead (no face pixels there); a test keeps these numbers equal to the JavaScript ones."""
    p, h = spec["proportions"], STAGE_HEIGHT
    head = p["head"] * h
    leg = max(.16, p["limb_length"] * h * .55)
    body = h - head - leg
    top = h + {"leaf": .2, "antenna": .28, "bow": .08, "cap": .02}.get(spec["accessory"], 0)
    taper = .74 if spec["family"] == "triangle" else 1      # a triangle body narrows towards the top
    # Half the body's width at its centre row: the body box starts 0.36 of its height below the centre and spans 0.86 of it.
    width = p["body_width"] * h * .5 * (1 + (taper - 1) * .36 / .86)
    return {"zh": h - head / 2, "hh": head / 2, "face": h - head * .13, "zb": leg + body / 2, "br": width / 2, "top": top}


def plan_for(spec):
    return voxel_plan(spec) if spec.get("form") == "voxel" else stage_plan(spec)


def _hsv(rgb):
    r, g, b = (float(x) / 255 for x in rgb)
    high, low = max(r, g, b), min(r, g, b)
    delta = high - low
    if delta < 1e-6:
        hue = 0.
    elif high == r:
        hue = 60 * (((g - b) / delta) % 6)
    elif high == g:
        hue = 60 * ((b - r) / delta + 2)
    else:
        hue = 60 * ((r - g) / delta + 4)
    return hue, (delta / high if high else 0.), high


def hue_off(found_rgb, hex_colour):
    """Degrees between a pixel's hue and a spec colour's hue (None when the spec colour has no hue to compare)."""
    want_h, want_s, _ = _hsv(_rgb(hex_colour))
    got_h, got_s, got_v = _hsv(found_rgb)
    if want_s < .12:
        return None
    if got_s < .08 or got_v < .08:
        return 180.
    d = abs(got_h - want_h) % 360
    return min(d, 360 - d)


def _patch(pixels, x, y, r=4):
    h, w = pixels.shape[:2]
    x, y = int(round(x)), int(round(y))
    if not (r <= x < w - r and r <= y < h - r):
        return None
    return np.median(pixels[y - r:y + r + 1, x - r:x + r + 1].reshape(-1, 3), axis=0)


def stage_sheet_metrics(png: bytes, spec: dict, layout: dict) -> dict:
    """Measure a 3D sheet: its flat colour key (shares, silhouette height, body width) and its lit front view (hues)."""
    pixels = _array(png)
    plan, problems = plan_for(spec), []
    key = layout["key"]
    px = key["height"] / STAGE_HEIGHT                     # pixels per metre in the key and the front view
    x0, y0, x1, y1 = key["x"] + 14, key["y"] + 60, key["x"] + key["w"] - 14, key["y"] + key["h"] - 14
    region = pixels[y0:y1, x0:x1]
    figure = ~_near(region, _rgb(layout["background"]), 12)
    ys, xs = np.nonzero(figure)
    if not len(ys):
        return {"ok": False, "problems": ["The sheet's colour key is empty."]}
    found = shares(region[ys.min():ys.max() + 1, xs.min():xs.max() + 1], spec["palette"])
    found.pop("outline", None)
    silhouette = (ys.max() - ys.min() + 1) / px
    metrics = {"ok": True, "form": spec.get("form", "3d"), "height_px": key["height"], "silhouette_m": round(silhouette, 3),
               "shares": {k: round(v, 4) for k, v in found.items()}}
    if not .97 * STAGE_HEIGHT <= silhouette <= plan["top"] + .06:
        problems.append(f"The colour key's figure is {silhouette:.2f} m tall; the spec builds {STAGE_HEIGHT:.2f} m to {plan['top']:.2f} m.")
    # The body's width at its centre: the run of body colours either side of the centre column, on the centre row.
    row = int(round(key["feet"] - plan["zb"] * px))
    cx = int(round(key["x"] + key["w"] / 2))
    line = _body_mask(pixels[row:row + 1, key["x"]:key["x"] + key["w"]], spec["palette"])[0] |         _near(pixels[row, key["x"]:key["x"] + key["w"]], _rgb(spec["palette"]["head"]) * .55 + _rgb(spec["palette"]["body"]) * .45, TOL)
    centre = cx - key["x"]
    if 0 <= centre < len(line) and line[centre]:
        left, right = centre, centre
        while left > 0 and line[left - 1]:
            left -= 1
        while right < len(line) - 1 and line[right + 1]:
            right += 1
        width = (right - left + 1) / px
        metrics["body_width_m"] = round(width, 3)
        want = 2 * plan["br"]
        if abs(width - want) > want * .14:
            problems.append(f"The colour key's body is {width:.2f} m wide at its centre; the spec builds {want:.2f} m.")
    else:
        problems.append("The colour key's body could not be found at its centre.")
    for part, least in (("body", .03), ("head", .015), ("limb", .003)):
        if found[part] < least:
            problems.append(f"The colour key shows too little of its {part} colour ({spec['palette'][part]}).")
    front = next(c for c in layout["views"] if c["view"] == "front")
    fx = front["x"] + front["w"] / 2
    hues = {}
    for part, z in (("body", plan["zb"]), ("head", plan["face"])):
        patch = _patch(pixels, fx, front["feet"] - z * px)
        off = hue_off(patch, spec["palette"][part]) if patch is not None else 180.
        hues[part] = None if off is None else round(off, 1)
        if off is not None and off > HUE_TOL:
            problems.append(f"The lit front view's {part} is {off:.0f} degrees of hue away from {spec['palette'][part]}.")
    metrics["hue_off"] = hues
    metrics["problems"] = problems
    metrics["ok"] = not problems
    return metrics


def stage_frame_notes(pixels, box: dict, others: list[dict], entry: dict) -> list[str]:
    """One 3D character in one sampled frame, against its approved 3D sheet."""
    notes, spec, name = [], entry["spec"], entry["name"]
    label = f"Beat {box.get('beat', '?')}: {name}"
    fh, fw = pixels.shape[:2]
    short = box.get("short") or min(fw, fh)
    low, high = STAGE_BANDS.get(box.get("shot"), (0, 9))
    size = box["height"] / short
    if not low <= size <= high:
        notes.append(f"{label} is {size:.0%} of the frame's height, outside the {box.get('shot')} shot's {low:.0%} to {high:.0%}.")
    for part in ("body", "head"):
        point = box.get(part) or {}
        x, y = point.get("cx"), point.get("cy")
        if x is None or not (0 <= x < fw and 0 <= y < fh):
            continue
        if any(o["x"] - 6 <= x <= o["x"] + o["w"] + 6 and o["y"] - 6 <= y <= o["y"] + o["h"] + 6 for o in others):
            continue      # a caption, label or another figure is over that point
        patch = _patch(pixels, x, y)
        if patch is None:
            continue
        off = hue_off(patch, spec["palette"][part])
        if off is not None and off > HUE_TOL:
            notes.append(f"{label}'s {part} colour is off the approved sheet ({off:.0f} degrees of hue from {spec['palette'][part]}).")
    return notes


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
    # The body, or the belly patch over it (the head colour at 55% over the body, static/motion/rig.js), or the head.
    belly = _rgb(palette["head"]) * .55 + _rgb(palette["body"]) * .45
    inside = _body_mask(column[None, :, :], palette)[0] | _near(column, _rgb(palette["head"]), 60) | _near(column, belly, TOL)
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
        if box.get("stage"):
            others = [b for b in boxes if b is not box and b.get("kind") in ("character", "text")]
            notes += stage_frame_notes(pixels, box, others, entry)
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
        bottom = min(fh, box.get("clip") or fh)    # a close shot cuts the figure at the near ground
        if box.get("action") == "walk" or cy + box["body"]["h"] / 2 + 4 > bottom or any(b["x"] <= cx <= b["x"] + b["w"] and b["y"] <= cy + box["body"]["h"] and cy <= b["y"] + b["h"] for b in others):
            continue      # crossing legs, the body running off the frame or behind the near ground, or a figure, prop or caption over its lower edge
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

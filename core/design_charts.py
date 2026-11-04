"""Charts on a board, drawn from a plain table (Creative Output Quality spec, Phase 2).

A board writes the numbers, never the drawing:

    <figure data-chart="bar">
      <figcaption>Signups by month</figcaption>
      <table><thead><tr><th>Month</th><th>Signups</th></tr></thead>
        <tbody><tr><td>Jan</td><td>120</td></tr>...</tbody></table>
    </figure>

Every save (design_html.normalize) draws the chart from that table: an inline
SVG in the look's tokens (`var(--ds-accent)` and the rest, so a token change
recolours it), placed where the table is; the table stays as the source, hidden
on the board. The first column is the categories, every other column a series.
Types: bar (data-orient="horizontal" for bars across), line, donut (the first
series), stat (big numbers as text: value column, label column). Deterministic
and with no model call, so every model gets the same charts by writing a table.
The same table gives the editable PowerPoint export its native charts
(core/design_pptx.py) and the Word export its chart pictures (png()).
"""
from __future__ import annotations

import html
import math
import re
from typing import Optional

TYPES = ("bar", "line", "donut", "stat")
OUT = "data-kd-chart-out"           # Marks the drawing, which is replaced on every save.
W, H = 800, 450                     # The SVG's own units; it scales to the figure's width.
LABEL = 20                          # Label size in those units (20px at 800 wide, 30px at 1200).
# Series colours, from the look. A look without a second accent falls back to its text colour.
COLOURS = ("var(--ds-accent)", "var(--ds-accent-2, var(--ds-text))", "var(--ds-text-dim)",
           "var(--ds-success)", "var(--ds-danger)", "var(--ds-hairline)")
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def _cells(row) -> list[str]:
    return [" ".join(cell.text(200).split()) for cell in row.children if getattr(cell, "tag", "") in ("td", "th")]


def number(text: str) -> Optional[float]:
    """1,200 / $3.4k / 45% / 2.1M as a float (k and M scale), or None."""
    raw = (text or "").replace(",", "").replace("−", "-").strip()
    found = _NUMBER.search(raw)
    if not found:
        return None
    value = float(found.group(0))
    tail = raw[found.end():].strip()[:1].lower()
    return value * {"k": 1e3, "m": 1e6, "b": 1e9}.get(tail, 1)


def parse(figure) -> Optional[dict]:
    """{type, orient, categories, series: [(name, [values])], labels: [display text]} from a chart figure's
    table, or None when there is no usable table."""
    kind = (figure.get("data-chart") or "").strip().lower()
    if kind not in TYPES:
        return None
    table = next((n for n in figure.elements() if n.tag == "table"), None)
    if table is None:
        return None
    rows = [n for n in table.elements() if n.tag == "tr"]
    if len(rows) < 2:
        return None
    head = _cells(rows[0])
    body = [_cells(r) for r in rows[1:] if _cells(r)]
    if len(head) < 2 or not body:
        return None
    categories = [r[0] for r in body]
    series = []
    for col in range(1, len(head)):
        values = [number(r[col]) if col < len(r) else None for r in body]
        if all(v is None for v in values):
            continue
        series.append((head[col], [v if v is not None else 0.0 for v in values]))
    if not series:
        return None
    labels = [r[1] if len(r) > 1 else "" for r in body]
    return {"type": kind, "orient": (figure.get("data-orient") or "").lower(), "categories": categories[:40],
            "series": [(name, values[:40]) for name, values in series[:6]], "labels": labels[:40]}


def _nice(top: float) -> tuple[float, float]:
    """A round axis maximum and step for values up to `top`."""
    if top <= 0:
        return 1.0, 0.25
    raw = top / 4
    power = 10 ** math.floor(math.log10(raw))
    step = next(m * power for m in (1, 2, 2.5, 5, 10) if m * power >= raw)
    return step * math.ceil(top / step), step


def _fmt(value: float) -> str:
    if abs(value) >= 1e6:
        return f"{value / 1e6:g}M"
    if abs(value) >= 1e4:
        return f"{value / 1e3:g}k"
    return f"{value:,.0f}" if value == int(value) else f"{value:,.1f}"


def _text(x, y, s, *, anchor="middle", size=LABEL, colour="var(--ds-text-dim)", weight="400") -> str:
    return (f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" style="fill: {colour}; font-family: var(--ds-font-sans); '
            f'font-size: {size}px; font-weight: {weight}">{html.escape(str(s)[:28])}</text>')


def _legend(series: list) -> str:
    if len(series) < 2:
        return ""
    parts, x = [], W - 20
    for i, (name, _) in reversed(list(enumerate(series))):
        width = 26 + 11 * len(name[:18])
        x -= width
        parts.append(f'<rect x="{x:.1f}" y="6" width="16" height="16" rx="3" style="fill: {COLOURS[i % len(COLOURS)]}"/>'
                     + _text(x + 22, 20, name[:18], anchor="start", size=LABEL - 4))
    return "".join(parts)


def _bars(spec: dict) -> str:
    cats, series = spec["categories"], spec["series"]
    top, step = _nice(max(max(v) for _, v in series))
    left, right, upper, lower = 70, 20, 40 if len(series) > 1 else 20, 50
    out = []
    if spec["orient"] == "horizontal":
        left = 20 + min(14, max(len(c) for c in cats)) * 11
        band = (H - upper - 20) / len(cats)
        for k in range(0, int(round(top / step)) + 1):
            x = left + (W - left - right) * k * step / top
            out.append(f'<line x1="{x:.1f}" y1="{upper}" x2="{x:.1f}" y2="{H - 20}" style="stroke: var(--ds-hairline-soft); stroke-width: 1"/>')
        for i, cat in enumerate(cats):
            y0 = upper + band * i + band * 0.15
            bar = band * 0.7 / len(series)
            out.append(_text(left - 10, y0 + band * 0.35 + LABEL * 0.35, cat[:14], anchor="end"))
            for s, (_, values) in enumerate(series):
                length = (W - left - right) * max(0.0, values[i]) / top
                out.append(f'<rect x="{left}" y="{y0 + bar * s:.1f}" width="{length:.1f}" height="{bar:.1f}" rx="3" '
                           f'style="fill: {COLOURS[s % len(COLOURS)]}"/>')
        return "".join(out)
    plot_h = H - upper - lower
    for k in range(0, int(round(top / step)) + 1):
        y = H - lower - plot_h * k * step / top
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{W - right}" y2="{y:.1f}" style="stroke: var(--ds-hairline-soft); stroke-width: 1"/>')
        out.append(_text(left - 10, y + LABEL * 0.35, _fmt(k * step), anchor="end", size=LABEL - 2))
    band = (W - left - right) / len(cats)
    bar = band * 0.7 / len(series)
    few = len(cats) * len(series) <= 8
    for i, cat in enumerate(cats):
        x0 = left + band * i + band * 0.15
        out.append(_text(x0 + band * 0.35, H - lower + LABEL + 8, cat[:10]))
        for s, (_, values) in enumerate(series):
            height = plot_h * max(0.0, values[i]) / top
            x = x0 + bar * s
            out.append(f'<rect x="{x:.1f}" y="{H - lower - height:.1f}" width="{bar:.1f}" height="{height:.1f}" rx="3" '
                       f'style="fill: {COLOURS[s % len(COLOURS)]}"/>')
            if few:
                out.append(_text(x + bar / 2, H - lower - height - 8, _fmt(values[i]), size=LABEL - 2, colour="var(--ds-text)"))
    return "".join(out)


def _lines(spec: dict) -> str:
    cats, series = spec["categories"], spec["series"]
    top, step = _nice(max(max(v) for _, v in series))
    left, right, upper, lower = 70, 30, 40 if len(series) > 1 else 20, 50
    plot_h, plot_w = H - upper - lower, W - left - right
    out = []
    for k in range(0, int(round(top / step)) + 1):
        y = H - lower - plot_h * k * step / top
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{W - right}" y2="{y:.1f}" style="stroke: var(--ds-hairline-soft); stroke-width: 1"/>')
        out.append(_text(left - 10, y + LABEL * 0.35, _fmt(k * step), anchor="end", size=LABEL - 2))
    gap = plot_w / max(1, len(cats) - 1)
    every = max(1, math.ceil(len(cats) / 8))
    for i, cat in enumerate(cats):
        if i % every == 0:
            out.append(_text(left + gap * i, H - lower + LABEL + 8, cat[:10]))
    for s, (_, values) in enumerate(series):
        colour = COLOURS[s % len(COLOURS)]
        points = " ".join(f"{left + gap * i:.1f},{H - lower - plot_h * max(0.0, v) / top:.1f}" for i, v in enumerate(values))
        out.append(f'<polyline points="{points}" style="fill: none; stroke: {colour}; stroke-width: 4; stroke-linejoin: round; stroke-linecap: round"/>')
        if len(values) <= 12:
            out += [f'<circle cx="{left + gap * i:.1f}" cy="{H - lower - plot_h * max(0.0, v) / top:.1f}" r="6" '
                    f'style="fill: var(--ds-bg); stroke: {colour}; stroke-width: 3"/>' for i, v in enumerate(values)]
    return "".join(out)


def _donut(spec: dict) -> str:
    cats = spec["categories"]
    values = [max(0.0, v) for v in spec["series"][0][1]]
    total = sum(values) or 1.0
    cx, cy, r, width = 225, H / 2, 150, 64
    circumference = 2 * math.pi * r
    out, start = [], 0.0
    for i, value in enumerate(values):
        length = circumference * value / total
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" transform="rotate(-90 {cx} {cy})" style="fill: none; '
                   f'stroke: {COLOURS[i % len(COLOURS)]}; stroke-width: {width}; stroke-dasharray: {length:.2f} {circumference:.2f}; '
                   f'stroke-dashoffset: {-start:.2f}"/>')
        start += length
    # The centre names the biggest slice's share, the number a donut is read for.
    big = max(range(len(values)), key=lambda i: values[i])
    out.append(_text(cx, cy + 10, f"{round(100 * values[big] / total)}%", size=LABEL + 24, colour="var(--ds-text)", weight="600"))
    out.append(_text(cx, cy + 44, cats[big][:14], size=LABEL - 2))
    rows = min(len(cats), 8)
    for i in range(rows):
        y = cy - (rows - 1) * 22 + i * 44
        out.append(f'<rect x="440" y="{y - 12:.1f}" width="20" height="20" rx="4" style="fill: {COLOURS[i % len(COLOURS)]}"/>')
        out.append(_text(472, y + 5, f"{cats[i][:16]}  {round(100 * values[i] / total)}%", anchor="start", colour="var(--ds-text)"))
    return "".join(out)


def svg(spec: dict) -> str:
    draw = {"bar": _bars, "line": _lines, "donut": _donut}[spec["type"]]
    summary = "; ".join(f"{name}: " + ", ".join(f"{c} {_fmt(v)}" for c, v in zip(spec["categories"], values))
                        for name, values in spec["series"])[:600]
    legend = _legend(spec["series"]) if spec["type"] != "donut" else ""
    return (f'<svg {OUT}="" viewBox="0 0 {W} {H}" role="img" aria-label="{html.escape(summary)}" '
            f'style="display: block; width: 100%; height: auto; overflow: visible">{legend}{draw(spec)}</svg>')


def stat(spec: dict) -> str:
    """Big numbers as text (they stay editable everywhere): the value as written, its label under it."""
    items = "".join(
        f'<div><div style="font-family: var(--ds-font-display); font-size: 3em; line-height: 1; color: var(--ds-accent-text, var(--ds-accent))">'
        f'{html.escape(value)}</div><div style="margin-top: 0.4em; color: var(--ds-text-dim)">{html.escape(label)}</div></div>'
        for label, value in zip(spec["categories"], spec["labels"]))
    return (f'<div {OUT}="" style="display: grid; grid-template-columns: repeat({min(4, len(spec["categories"]))}, 1fr); '
            f'gap: 1.5em">{items}</div>')


def expand(root) -> list[str]:
    """Draw every chart figure in the tree from its table, in place. Returns notes for figures that can't be drawn."""
    from core import design_html
    notes = []
    for figure in [n for n in root.elements() if n.tag == "figure" and n.get("data-chart") is not None]:
        figure.children = [c for c in figure.children if not (isinstance(c, design_html.Element) and c.get(OUT) is not None)]
        spec = parse(figure)
        label = figure.kd or "a figure"
        if spec is None:
            notes.append(f"The chart in {label} needs data-chart bar, line, donut or stat around a <table> whose first "
                         "column is the labels and other columns are numbers; nothing was drawn.")
            continue
        table = next(n for n in figure.elements() if n.tag == "table")
        table.set("hidden", "")
        drawn = design_html.parse(stat(spec) if spec["type"] == "stat" else svg(spec)).children[0]
        holder = table.parent
        index = next(i for i, c in enumerate(holder.children) if c is table)
        drawn.parent = holder
        holder.children.insert(index, drawn)
    return notes


# -- a picture of the chart, for Word (no browser needed) --------------------------

def _rgb(value: str, tokens: dict[str, str], fallback: str) -> tuple[int, int, int]:
    while value and value.startswith("var("):
        match = re.match(r"var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.*))?\)$", value.strip())
        if not match:
            break
        value = tokens.get(match.group(1)) or (match.group(2) or "")
    value = (value or fallback).strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}", value):
        value = fallback
    value = value.lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def png(spec: dict, tokens: dict[str, str], width: int = 1600) -> bytes:
    """The same chart drawn with Pillow at `width` px (Word has no SVG charts and python-docx no chart API)."""
    import io
    from PIL import Image, ImageDraw, ImageFont
    scale = width / W
    image = Image.new("RGB", (width, int(H * scale)), _rgb("var(--ds-bg)", tokens, "#ffffff"))
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", int(LABEL * scale))
    except OSError:
        font = ImageFont.load_default()
    dim, ink = _rgb("var(--ds-text-dim)", tokens, "#666666"), _rgb("var(--ds-text)", tokens, "#222222")
    rule = _rgb("var(--ds-hairline-soft)", tokens, "#dddddd")
    colours = [_rgb(c, tokens, "#888888") for c in COLOURS]
    cats, series = spec["categories"], spec["series"]

    def s(value: float) -> float:
        return value * scale
    if spec["type"] == "donut":
        values = [max(0.0, v) for v in series[0][1]]
        total = sum(values) or 1.0
        box = (s(75), s(H / 2 - 150), s(375), s(H / 2 + 150))
        start = -90.0
        for i, value in enumerate(values):
            sweep = 360 * value / total
            draw.arc(box, start, start + sweep, fill=colours[i % len(colours)], width=int(s(64)))
            start += sweep
        big = max(range(len(values)), key=lambda i: values[i])
        draw.text((s(225), s(H / 2)), f"{round(100 * values[big] / total)}%", fill=ink, font=font, anchor="mm")
        for i in range(min(len(cats), 8)):
            y = s(H / 2 - (min(len(cats), 8) - 1) * 22 + i * 44)
            draw.rounded_rectangle((s(440), y - s(10), s(460), y + s(10)), s(4), fill=colours[i % len(colours)])
            draw.text((s(472), y), f"{cats[i][:16]}  {round(100 * values[i] / total)}%", fill=ink, font=font, anchor="lm")
    else:
        top, step = _nice(max(max(v) for _, v in series))
        left, right, upper, lower = 70, 30, 40 if len(series) > 1 else 20, 50
        plot_h = H - upper - lower
        for k in range(0, int(round(top / step)) + 1):
            y = H - lower - plot_h * k * step / top
            draw.line((s(left), s(y), s(W - right), s(y)), fill=rule, width=max(1, int(scale)))
            draw.text((s(left - 10), s(y)), _fmt(k * step), fill=dim, font=font, anchor="rm")
        if spec["type"] == "bar":
            band = (W - left - right) / len(cats)
            bar = band * 0.7 / len(series)
            for i, cat in enumerate(cats):
                x0 = left + band * i + band * 0.15
                draw.text((s(x0 + band * 0.35), s(H - lower + 24)), cat[:10], fill=dim, font=font, anchor="mm")
                for j, (_, values) in enumerate(series):
                    height = plot_h * max(0.0, values[i]) / top
                    draw.rounded_rectangle((s(x0 + bar * j), s(H - lower - height), s(x0 + bar * (j + 1)), s(H - lower)),
                                           s(3), fill=colours[j % len(colours)])
        else:
            gap = (W - left - right) / max(1, len(cats) - 1)
            for i, cat in enumerate(cats):
                if i % max(1, math.ceil(len(cats) / 8)) == 0:
                    draw.text((s(left + gap * i), s(H - lower + 24)), cat[:10], fill=dim, font=font, anchor="mm")
            for j, (_, values) in enumerate(series):
                points = [(s(left + gap * i), s(H - lower - plot_h * max(0.0, v) / top)) for i, v in enumerate(values)]
                draw.line(points, fill=colours[j % len(colours)], width=int(s(4)), joint="curve")
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    return out.getvalue()

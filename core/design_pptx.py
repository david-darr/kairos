"""Editable PowerPoint from fixed-size boards (Creative Output Quality spec, Phase 2; David's D6, 2026-11-03).

PowerPoint can't render HTML, so each slide is measured, then rebuilt from
native parts:

1. The desktop app's render window measures the board (electron/designRender.js,
   the `layout` job): every element's box and computed style, and the text runs
   of each block that holds only inline content.
2. Each element becomes what PowerPoint can edit, where it can say the same
   thing: a text block a text box (font, size, weight, colour, alignment, line
   spacing, letter spacing, bold and italic runs, bullets); a box with a solid
   fill or plain border a shape (corner radius kept); an image a picture; a
   chart figure a native bar, line or doughnut chart from its table
   (core/design_charts.py).
3. Whatever it can't (gradients, shadows, blur, masks, transforms, drawings,
   text mixed with blocks) stays in one background picture: the board rendered
   again with the rebuilt elements hidden, so the slide looks as designed and
   its words stay editable. A part that a flattened one would paint over stays
   in the picture too, so nothing changes order.

python-pptx can't embed fonts, so by default the text uses the look's Office
pairing (`office_fonts`: fonts every PowerPoint has, close to the look's);
`fonts="design"` keeps the design's own fonts for people who have them.
PowerPoint wraps text a little differently from Chromium: each text box keeps
its measured width with auto-fit off, and a check estimates every box's lines
at the PowerPoint font's widths and flags any that would overflow.
"""
from __future__ import annotations

import base64
import io
import re
from pathlib import Path
from typing import Optional

from core import design_charts, design_formats, design_html, design_looks, design_store, design_systems

EMU_PER_PX = 6350          # A 1920 px board on a 13.333 in slide: 1 px = 6350 EMU = 0.5 pt (every board, any size).
PT_PER_PX = 0.5
KAIROS_OFFICE = {"display": "Garamond", "body": "Century Gothic"}
FONT_DIR = Path(r"C:\Windows\Fonts")
# Office font names to their Windows files, for the overflow estimate (any other system: the design's widths).
FONT_FILES = {"arial": "arial.ttf", "arial black": "ariblk.ttf", "arial narrow": "ARIALN.TTF", "georgia": "georgia.ttf",
              "segoe ui": "segoeui.ttf", "segoe ui semibold": "seguisb.ttf", "segoe ui black": "seguibl.ttf",
              "garamond": "GARA.TTF", "cambria": "cambria.ttc", "courier new": "cour.ttf", "consolas": "consola.ttf",
              "century gothic": "GOTHIC.TTF", "book antiqua": "BKANT.TTF", "impact": "impact.ttf",
              "times new roman": "times.ttf", "calibri": "calibri.ttf", "verdana": "verdana.ttf"}
BOLD_FILES = {"arial": "arialbd.ttf", "georgia": "georgiab.ttf", "segoe ui": "segoeuib.ttf", "garamond": "GARABD.TTF",
              "cambria": "cambriab.ttf", "courier new": "courbd.ttf", "consolas": "consolab.ttf", "arial narrow": "ARIALNB.TTF",
              "century gothic": "GOTHICB.TTF", "times new roman": "timesbd.ttf", "calibri": "calibrib.ttf"}
# Faces that are already black: PowerPoint would fake a wider bold on top (Phase 2 benchmark, Sport look).
HEAVY = frozenset({"impact", "arial black", "segoe ui black"})
FAKE_BOLD = 1.07           # How much wider a faked bold sets, for the estimate when there is no bold file.
_RGBA = re.compile(r"rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)")


def _colour(value: str) -> Optional[tuple[tuple[int, int, int], float]]:
    """((r, g, b), alpha) from a computed colour, or None when it is fully transparent."""
    match = _RGBA.match(value or "")
    if not match:
        return None
    alpha = match.group(4)
    a = 1.0 if alpha is None else (float(alpha[:-1]) / 100 if alpha.endswith("%") else float(alpha))
    if a <= 0.01:
        return None
    return (int(float(match.group(1))), int(float(match.group(2))), int(float(match.group(3)))), a


def _px(value: str) -> float:
    try:
        return float(str(value).replace("px", ""))
    except ValueError:
        return 0.0


def _first_family(value: str) -> str:
    return (value or "").split(",")[0].strip().strip("\"'")


def _look(data: dict) -> dict:
    system_id = data.get("design_system") or design_systems.BUILTIN_ID
    return design_looks.get(system_id) or design_systems._style_look(system_id) or {}


class Fonts:
    """The look's design fonts mapped to the fonts the deck will name."""

    def __init__(self, data: dict, mode: str):
        look = _look(data)
        self.mode = mode
        if look:
            names = design_looks.summary(look)["fonts"]
            self.design = {role: names.get(role) for role in ("display", "body", "mono") if names.get(role)}
            self.office = dict(look.get("office_fonts") or {})
        else:  # The Kairos system.
            self.design = {"display": "Cormorant Garamond", "body": "Jost"}
            self.office = dict(KAIROS_OFFICE)
        self.office.setdefault("mono", "Consolas")

    def name(self, css_family: str) -> str:
        family = _first_family(css_family)
        if self.mode == "design":
            return family
        for role, design_name in self.design.items():
            if design_name and design_name.lower() == family.lower():
                return self.office.get(role) or self.office.get("body") or family
        return self.office.get("body") or family

    def file(self, name: str, bold: bool) -> Optional[Path]:
        key = name.lower()
        for table in ((BOLD_FILES, FONT_FILES) if bold else (FONT_FILES,)):
            if key in table and (FONT_DIR / table[key]).is_file():
                return FONT_DIR / table[key]
        for face in design_looks.fonts(_look_by_name(name)) if _look_by_name(name) else []:
            path = design_looks.font_path(face["file"])
            if path and face["family"].lower() == key and path.suffix == ".ttf":
                return path
        return None


def _look_by_name(name: str) -> Optional[dict]:
    """A bundled look that ships the design font `name`, for its widths."""
    for look in design_looks.load().values():
        if any(face["family"].lower() == name.lower() for face in design_looks.fonts(look)):
            return look
    return None


# -- classify ---------------------------------------------------------------------

def _plain(style: dict) -> bool:
    """Nothing PowerPoint can't draw: no gradient, image, shadow, filter, transform, clip, mask or blending."""
    return (style.get("backgroundImage") in (None, "", "none") and style.get("boxShadow") in (None, "", "none")
            and style.get("filter") in (None, "", "none") and style.get("backdropFilter") in (None, "", "none")
            and style.get("transform") in (None, "", "none") and style.get("clipPath") in (None, "", "none")
            and style.get("maskImage") in (None, "", "none") and style.get("mixBlendMode") in (None, "", "normal")
            and _px(style.get("opacity", "1") or "1") >= 0.999)


def _painted(style: dict) -> bool:
    """The element paints something of its own (fill, border, image, shadow)."""
    if _colour(style.get("backgroundColor", "")) or style.get("backgroundImage") not in (None, "", "none"):
        return True
    if style.get("boxShadow") not in (None, "", "none"):
        return True
    return any(_px(style.get(k, "0")) > 0 for k in ("borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth")) \
        and style.get("borderTopStyle") not in ("none", "hidden") and _colour(style.get("borderTopColor", "")) is not None


def _border_uniform(style: dict) -> bool:
    widths = {_px(style.get(k, "0")) for k in ("borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth")}
    return len(widths) == 1


def _overlaps(a: dict, b: dict) -> bool:
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


def plan(layout: dict, charts: dict[str, dict]) -> list[dict]:
    """What each element becomes: [{kind: shape|picture|chart|text, el, hide}], in paint (DOM) order.
    `charts` maps a figure's id to its parsed table."""
    elements = layout.get("elements") or []
    by_id = {e["id"]: e for e in elements if e.get("id")}

    def ancestors(entry):
        seen, parent = [], by_id.get(entry.get("parent"))
        while parent is not None and len(seen) < 64:
            seen.append(parent)
            parent = by_id.get(parent.get("parent"))
        return seen

    visible = []
    for index, entry in enumerate(elements):
        style = entry.get("style") or {}
        if not entry.get("id") or entry["w"] < 1 or entry["h"] < 1 or style.get("display") == "none" \
                or style.get("visibility") in ("hidden", "collapse"):
            continue
        chain = ancestors(entry)
        if any(not _plain({**(a.get("style") or {}), "backgroundImage": "none", "boxShadow": "none"}) for a in chain):
            continue  # Inside a transformed, faded or filtered parent: it stays in the picture with it.
        entry["_index"], entry["_chain"] = index, {a["id"] for a in chain}
        visible.append(entry)
    parts, flattened = [], []
    for entry in visible:
        style = entry["style"]
        if entry["tag"] == "svg" and by_id.get(entry.get("parent"), {}).get("chart") in ("bar", "line", "donut") \
                and entry.get("parent") in charts:
            parts.append({"kind": "chart", "el": entry, "spec": charts[entry["parent"]], "hide": "all"})
            continue
        if entry["tag"] == "img":
            if _plain(style) and _px(style.get("borderTopLeftRadius", "0")) == 0 and entry.get("src"):
                parts.append({"kind": "picture", "el": entry, "hide": "all"})
            else:
                flattened.append(entry)
            continue
        if entry["tag"] == "svg":
            flattened.append(entry)
            continue
        if _painted(style):
            if _plain(style) and _border_uniform(style):
                parts.append({"kind": "shape", "el": entry, "hide": "box"})
            else:
                flattened.append(entry)
        runs = entry.get("runs")
        if runs and "".join(r.get("text", "") for r in runs).strip() and style.get("transform") in (None, "", "none") \
                and (style.get("writingMode") or "horizontal-tb").startswith("horizontal"):
            parts.append({"kind": "text", "el": entry, "hide": "text"})
    # A part that a flattened element (not its ancestor) paints over later stays in the picture.
    kept = []
    for part in parts:
        el = part["el"]
        covered = part["kind"] != "text" and any(f["_index"] > el["_index"] and f["id"] not in el["_chain"] and _overlaps(f, el)
                                                 for f in flattened)
        if not covered:
            kept.append(part)
    return kept


# -- build --------------------------------------------------------------------------

def _emu(px: float) -> int:
    return int(round(px * EMU_PER_PX))


def _set_alpha(element, alpha: float) -> None:
    """An <a:alpha> on every colour under `element` (python-pptx has no API for transparency)."""
    if alpha >= 0.999:
        return
    from pptx.oxml.ns import qn
    for clr in element.iter(qn("a:srgbClr")):
        if clr.find(qn("a:alpha")) is None:
            clr.append(clr.makeelement(qn("a:alpha"), {"val": str(int(alpha * 100000))}))


def _shape(slide, el: dict) -> None:
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.util import Emu, Pt
    style = el["style"]
    radius = _px(style.get("borderTopLeftRadius", "0"))
    kind = MSO_SHAPE.ROUNDED_RECTANGLE if radius > 0 else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(kind, Emu(_emu(el["x"])), Emu(_emu(el["y"])), Emu(_emu(el["w"])), Emu(_emu(el["h"])))
    shape.shadow.inherit = False
    if radius > 0:
        shape.adjustments[0] = max(0.0, min(0.5, radius / max(1.0, min(el["w"], el["h"]))))
    fill = _colour(style.get("backgroundColor", ""))
    if fill:
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor(*fill[0])
        _set_alpha(shape.fill._xPr, fill[1])
    else:
        shape.fill.background()
    width = _px(style.get("borderTopWidth", "0"))
    line = _colour(style.get("borderTopColor", "")) if style.get("borderTopStyle") not in ("none", "hidden") else None
    if width > 0 and line:
        shape.line.color.rgb = RGBColor(*line[0])
        shape.line.width = Pt(width * PT_PER_PX)
    else:
        shape.line.fill.background()
    shape.text_frame.text = ""
    shape.name = f"kd {el['id']}"


def _image(design_id: str, el: dict) -> Optional[bytes]:
    """An image element's bytes: a data: image or one of the design's own assets."""
    src = el.get("src") or ""
    if src.startswith("data:image/"):
        return base64.b64decode(src.split(",", 1)[1]) if design_html.DATA_IMAGE.fullmatch(src) else None
    match = re.search(r"assets/([0-9a-f]{64}\.(?:png|jpe?g|gif|webp))", src)
    try:
        return design_store.asset_path(design_id, match.group(1)).read_bytes() if match else None
    except LookupError:
        return None


def _picture(slide, raw: bytes, el: dict) -> None:
    from pptx.util import Emu
    picture = slide.shapes.add_picture(io.BytesIO(raw), Emu(_emu(el["x"])), Emu(_emu(el["y"])), Emu(_emu(el["w"])), Emu(_emu(el["h"])))
    natural = el.get("natural") or [0, 0]
    fit = (el["style"].get("objectFit") or "fill")
    if fit == "cover" and natural[0] and natural[1]:
        box, image = el["w"] / el["h"], natural[0] / natural[1]
        if image > box:  # Wider than the box: crop the sides.
            cut = (1 - box / image) / 2
            picture.crop_left = picture.crop_right = cut
        elif image < box:
            cut = (1 - image / box) / 2
            picture.crop_top = picture.crop_bottom = cut
    picture.name = f"kd {el['id']}"


def _chart(slide, el: dict, spec: dict, tokens: dict, fonts: Fonts) -> None:
    from pptx.chart.data import CategoryChartData
    from pptx.dml.color import RGBColor
    from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
    from pptx.util import Emu, Pt
    data = CategoryChartData()
    data.categories = spec["categories"]
    series = spec["series"][:1] if spec["type"] == "donut" else spec["series"]
    for name, values in series:
        data.add_series(name, values)
    kind = {"bar": XL_CHART_TYPE.BAR_CLUSTERED if spec["orient"] == "horizontal" else XL_CHART_TYPE.COLUMN_CLUSTERED,
            "line": XL_CHART_TYPE.LINE_MARKERS, "donut": XL_CHART_TYPE.DOUGHNUT}[spec["type"]]
    frame = slide.shapes.add_chart(kind, Emu(_emu(el["x"])), Emu(_emu(el["y"])), Emu(_emu(el["w"])), Emu(_emu(el["h"])), data)
    chart = frame.chart
    colours = [design_charts._rgb(c, tokens, "#888888") for c in design_charts.COLOURS]
    ink = design_charts._rgb("var(--ds-text-dim)", tokens, "#666666")
    size = Pt(design_charts.LABEL * (el["w"] / design_charts.W) * PT_PER_PX)
    chart.font.size = size
    chart.font.color.rgb = RGBColor(*ink)
    chart.font.name = fonts.name(tokens.get("--ds-font-sans", ""))
    chart.has_legend = len(series) > 1 or spec["type"] == "donut"
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.RIGHT if spec["type"] == "donut" else XL_LEGEND_POSITION.TOP
        chart.legend.include_in_layout = False
    plot = chart.plots[0]
    if spec["type"] == "donut":
        for i, point in enumerate(plot.series[0].points):
            point.format.fill.solid()
            point.format.fill.fore_color.rgb = RGBColor(*colours[i % len(colours)])
    else:
        for i, s in enumerate(plot.series):
            if spec["type"] == "line":
                s.format.line.color.rgb = RGBColor(*colours[i % len(colours)])
                s.format.line.width = Pt(4 * el["w"] / design_charts.W * PT_PER_PX)
                s.smooth = False
            else:
                s.format.fill.solid()
                s.format.fill.fore_color.rgb = RGBColor(*colours[i % len(colours)])
        if spec["type"] == "bar":
            plot.gap_width = 40
            if len(spec["categories"]) * len(series) <= 8:
                plot.has_data_labels = True
                plot.data_labels.font.size = size
                plot.data_labels.number_format, plot.data_labels.number_format_is_linked = "#,##0", False
        rule = design_charts._rgb("var(--ds-hairline-soft)", tokens, "#dddddd")
        value_axis = chart.value_axis
        top, step = design_charts._nice(max(max(v) for _, v in series))  # The board's own scale.
        value_axis.minimum_scale, value_axis.maximum_scale, value_axis.major_unit = 0, top, step
        value_axis.tick_labels.number_format, value_axis.tick_labels.number_format_is_linked = "#,##0", False
        value_axis.has_major_gridlines = True
        value_axis.major_gridlines.format.line.color.rgb = RGBColor(*rule)
        value_axis.format.line.fill.background()
        chart.category_axis.format.line.color.rgb = RGBColor(*rule)
    frame.name = f"kd {el['id']} chart"


def _text(slide, el: dict, fonts: Fonts, flags: list) -> None:
    from pptx.dml.color import RGBColor
    from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
    from pptx.oxml.ns import qn
    from pptx.util import Emu, Pt
    style = el["style"]
    pad = [_px(style.get(k, "0")) for k in ("paddingTop", "paddingRight", "paddingBottom", "paddingLeft")]
    border = _px(style.get("borderTopWidth", "0")) if style.get("borderTopStyle") not in ("none", "hidden") else 0
    x, y = el["x"] + pad[3] + border, el["y"] + pad[0] + border
    w, h = el["w"] - pad[1] - pad[3] - 2 * border, el["h"] - pad[0] - pad[2] - 2 * border
    bullet = el["tag"] == "li" and style.get("listStyleType") not in (None, "", "none")
    indent = _px(style.get("fontSize", "16")) * 1.2 if bullet else 0
    box = slide.shapes.add_textbox(Emu(_emu(x - indent)), Emu(_emu(y)), Emu(_emu(max(4, w + indent + 2))), Emu(_emu(max(4, h))))
    box.name = f"kd {el['id']} text"
    frame = box.text_frame
    frame.word_wrap = True
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = MSO_ANCHOR.TOP
    para = frame.paragraphs[0]
    para.alignment = {"center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT, "end": PP_ALIGN.RIGHT,
                      "justify": PP_ALIGN.JUSTIFY}.get(style.get("textAlign"), PP_ALIGN.LEFT)
    size_px = _px(style.get("fontSize", "16")) or 16
    line = style.get("lineHeight") or "normal"
    line_px = _px(line) if line != "normal" else size_px * 1.2
    para.line_spacing = Pt(line_px * PT_PER_PX)
    if bullet:
        p_pr = para._p.get_or_add_pPr()
        p_pr.set("marL", str(_emu(indent)))
        p_pr.set("indent", str(-_emu(indent)))
        glyph = {"decimal": None}.get(style.get("listStyleType"), "\u2022")
        if glyph:
            bu = p_pr.makeelement(qn("a:buChar"), {"char": glyph})
            p_pr.append(bu)
    spacing = style.get("letterSpacing") or "normal"
    runs, start = el.get("runs") or [], True
    lines_text = [""]
    segments: list[list[tuple[str, float]]] = [[]]  # Per paragraph: (text, run size / block size), for the estimate.
    for index, item in enumerate(runs):
        if item.get("br"):
            para.add_line_break()
            lines_text.append("")
            segments.append([])
            start = True
            continue
        text = re.sub(r"\s+", " ", item.get("text") or "")
        if start:
            text = text.lstrip()
        if all(not (r.get("text") or "").strip() for r in runs[index + 1:] if not r.get("br")) and \
                not any(r.get("br") for r in runs[index + 1:]):
            text = text.rstrip()
        if not text:
            continue
        start = text.endswith(" ")
        transform = item.get("transform") or style.get("textTransform")
        text = text.upper() if transform == "uppercase" else text.lower() if transform == "lowercase" else \
            text.title() if transform == "capitalize" else text
        run = para.add_run()
        run.text = text
        lines_text[-1] += text
        segments[-1].append((text, (_px(item.get("size") or "") or size_px) / size_px))
        font = run.font
        font.name = fonts.name(item.get("family") or style.get("fontFamily", ""))
        font.size = Pt((_px(item.get("size") or "") or size_px) * PT_PER_PX)
        font.bold = int(float(item.get("weight") or 400)) >= 600 and font.name.lower() not in HEAVY
        font.italic = bool(item.get("italic"))
        font.underline = bool(item.get("underline"))
        colour = _colour(item.get("color") or style.get("color", ""))
        if colour:
            font.color.rgb = RGBColor(*colour[0])
            _set_alpha(run._r, colour[1])
        if spacing != "normal" and _px(spacing):
            run._r.get_or_add_rPr().set("spc", str(int(_px(spacing) * PT_PER_PX * 100)))
    # The PowerPoint font is wider or narrower than the design's: shrink the text (to 70% at most) until its
    # estimated lines fit the measured box, and flag it only if that isn't enough.
    name = fonts.name(style.get("fontFamily", ""))
    bold = int(float(style.get("fontWeight") or 400)) >= 600 and name.lower() not in HEAVY
    font_file = fonts.file(name, bold)
    widen = FAKE_BOLD if bold and (font_file is None or font_file.name not in BOLD_FILES.values()) else 1.0
    for factor in (1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7):
        lines = _lines(segments, font_file, size_px * factor, w + 2, spacing, widen)
        if lines * line_px * factor <= h * 1.08 + 2:
            break
    else:
        excerpt = " ".join("".join(lines_text).split())[:50]
        flags.append(f"\"{excerpt}\" may not fit its box in PowerPoint ({name})")
    if factor < 1.0:
        for run in para.runs:
            run.font.size = Pt(run.font.size.pt * factor)
        para.line_spacing = Pt(line_px * factor * PT_PER_PX)
    if lines == 1 and line_px < size_px:
        # PowerPoint lifts a line set tighter than its font (a giant "8" climbs over its kicker); Chromium
        # centres it in its line box. One line: normal spacing, centred in the measured box.
        para.line_spacing = 1.0
        frame.vertical_anchor = MSO_ANCHOR.MIDDLE


def _lines(paragraphs: list, font_file: Optional[Path], size_px: float, width: float, spacing: str,
           widen: float = 1.0) -> int:
    """How many lines the text takes at `width`, measured with the PowerPoint font's widths when it is here
    (`widen` for a bold PowerPoint will fake). A paragraph is a string, or its runs as (text, size relative
    to `size_px`), so a small "/month" after a big price is measured small. A word wider than the box breaks
    inside it, as PowerPoint does, so it counts its extra lines; 3% is kept spare for the difference between
    the two renderers."""
    try:
        from PIL import ImageFont
        font = ImageFont.truetype(str(font_file), max(1, int(round(size_px)))) if font_file else None
    except OSError:
        font = None
    extra = _px(spacing) if spacing != "normal" else 0.0

    def measure(text: str, rel: float = 1.0) -> float:
        base = len(text) * size_px * 0.55 if font is None else font.getlength(text)
        return (base * widen + extra * len(text)) * rel
    width *= 0.97
    space = measure(" ")
    total = 0
    for paragraph in paragraphs:
        runs = [(paragraph, 1.0)] if isinstance(paragraph, str) else paragraph
        # Words keep their run's size; a run that starts without a space continues the word before it.
        words: list[float] = []
        glued = False
        for text, rel in runs:
            parts = text.split(" ")
            for i, part in enumerate(parts):
                size = measure(part, rel) if part else 0.0
                if i == 0 and glued and words:
                    words[-1] += size
                elif part:
                    words.append(size)
            glued = not text.endswith(" ")
        line, count = 0.0, 1
        for size in words:
            if line and line + space + size > width:
                count += 1
                line = size
            else:
                line = line + space + size if line else size
            if size > width:
                count += int(size // max(1.0, width))
        total += count
    return max(1, total)


def flat_colour(png: bytes) -> Optional[tuple[int, int, int]]:
    """The one colour of a render that has nothing left in it, else None."""
    from PIL import Image
    image = Image.open(io.BytesIO(png)).convert("RGB")
    small = image.resize((64, 36))
    extrema = small.getextrema()
    if all(high - low <= 2 for low, high in extrema):
        return small.getpixel((0, 0))
    return None


async def slide(deck, design_id: str, slug: str, data: dict, fonts: Fonts, tokens: dict, flags: list) -> dict:
    """Rebuild one slide board on a new slide. Returns counts {text, shapes, pictures, charts}."""
    from core import design_render_bridge
    from pptx.dml.color import RGBColor
    from pptx.util import Emu
    measured = await design_render_bridge.layout(design_id, slug)
    root = design_html.parse(design_store.board_html(design_id, slug))
    charts = {f.kd: design_charts.parse(f) for f in root.elements()
              if f.tag == "figure" and f.get("data-chart") in ("bar", "line", "donut") and f.kd}
    parts = plan(measured, {k: v for k, v in charts.items() if v})
    for part in parts:  # A picture that can't be read stays in the background picture.
        if part["kind"] == "picture":
            part["raw"] = _image(design_id, part["el"])
    parts = [p for p in parts if p["kind"] != "picture" or p["raw"]]
    background = await design_render_bridge.render(design_id, slug, "png", scale=2,
                                                   hide=[{"id": p["el"]["id"], "mode": p["hide"]} for p in parts])
    page = deck.slides.add_slide(deck.slide_layouts[6])  # Blank.
    solid = flat_colour(background)
    if solid is not None:
        page.background.fill.solid()
        page.background.fill.fore_color.rgb = RGBColor(*solid)
    else:
        picture = page.shapes.add_picture(io.BytesIO(background), 0, 0, deck.slide_width, deck.slide_height)
        picture.name = "Background (design effects)"
    counts = {"text": 0, "shapes": 0, "pictures": 0, "charts": 0}
    for part in parts:
        el = part["el"]
        if part["kind"] == "shape":
            _shape(page, el)
            counts["shapes"] += 1
        elif part["kind"] == "picture":
            _picture(page, part["raw"], el)
            counts["pictures"] += 1
        elif part["kind"] == "chart":
            _chart(page, el, part["spec"], tokens, fonts)
            counts["charts"] += 1
        else:
            _text(page, el, fonts, flags)
            counts["text"] += 1
    return {**counts, "page": page}

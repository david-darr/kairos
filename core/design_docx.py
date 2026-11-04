"""Word (.docx) from document boards (Creative Output Quality spec, Phase 2).

Word stays python-docx, but it takes the look instead of Arial: the board's
headings, paragraphs, lists, tables, images, quotes and charts become Word's
own (real heading styles, real lists, real tables), in the look's Office fonts
(or its design fonts, `fonts="design"`) and colours, on the board's page size
with its margins, a running header from page 2 and "Page N of M".

Word prints on white, so the look's text colours are pushed well past AA
against white (design_looks.readable), keeping their hue: a dark look's light
ink becomes its dark counterpart, never a washed-out grey. Charts are pictures drawn from their tables
(core/design_charts.png), so no desktop app is needed.
"""
from __future__ import annotations

import base64
import io
import re
from typing import Optional

from core import design_charts, design_formats, design_html, design_looks, design_store, design_systems
from core.design_html import Element, Text

BLOCKS = frozenset("div section article header footer main aside nav".split())
INLINE_BOLD = frozenset({"b", "strong"})
INLINE_ITALIC = frozenset({"i", "em"})
HEADING_PT = {1: 26, 2: 18, 3: 14, 4: 12, 5: 11, 6: 11}


def _hex(value: Optional[str], fallback: str) -> str:
    value = (value or "").strip()
    return value.upper() if re.fullmatch(r"#[0-9a-fA-F]{6}", value) else fallback


class Palette:
    def __init__(self, tokens: dict[str, str]):
        white = "#FFFFFF"
        self.text = design_looks.readable(_hex(tokens.get("--ds-text"), "#1A1A1A"), white, 12.0)
        self.dim = design_looks.readable(_hex(tokens.get("--ds-text-dim"), "#555555"), white, 6.0)
        self.accent = design_looks.readable(_hex(tokens.get("--ds-accent-text") or tokens.get("--ds-accent"), "#1F4E79"), white, 3.0)
        self.fill = _hex(tokens.get("--ds-accent"), "#1F4E79")
        self.on_fill = _hex(tokens.get("--ds-on-accent"), "#FFFFFF")
        self.rule = _hex(tokens.get("--ds-hairline"), "#CCCCCC")


def _rgb(hexcolour: str):
    from docx.shared import RGBColor
    return RGBColor.from_string(hexcolour.lstrip("#"))


def _fonts(data: dict, mode: str) -> tuple[str, str]:
    from core import design_pptx
    fonts = design_pptx.Fonts(data, mode)
    if mode == "design":
        return fonts.design.get("display") or "Georgia", fonts.design.get("body") or "Arial"
    return fonts.office.get("display") or "Georgia", fonts.office.get("body") or "Arial"


def _font(style, name: str) -> None:
    """A style's font by name. Word's built-in styles name theme fonts, which win over a plain name, so they go."""
    from docx.oxml.ns import qn
    style.font.name = name
    fonts = style.element.rPr.rFonts if style.element.rPr is not None else None
    if fonts is not None:
        for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
            fonts.attrib.pop(qn(attr), None)
        fonts.set(qn("w:eastAsia"), name)


def _field(run, code: str) -> None:
    """A Word field (PAGE, NUMPAGES) in `run`."""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    for kind, text in (("begin", None), (None, code), ("end", None)):
        if kind:
            node = OxmlElement("w:fldChar")
            node.set(qn("w:fldCharType"), kind)
        else:
            node = OxmlElement("w:instrText")
            node.set(qn("xml:space"), "preserve")
            node.text = f" {text} "
        run._r.append(node)


def _shade(cell, hexcolour: str) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    shading = OxmlElement("w:shd")
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:color"), "auto")
    shading.set(qn("w:fill"), hexcolour.lstrip("#"))
    cell._tc.get_or_add_tcPr().append(shading)


class Writer:
    def __init__(self, doc, design_id: str, palette: Palette, tokens: dict[str, str], width_in: float):
        self.doc, self.design_id, self.palette, self.tokens, self.width_in = doc, design_id, palette, tokens, width_in
        self.notes: list[str] = []

    # -- inline -----------------------------------------------------------------
    def runs(self, paragraph, node: Element, bold=False, italic=False) -> None:
        for child in node.children:
            if isinstance(child, Text):
                text = re.sub(r"\s+", " ", child.data)
                if text.strip() or (text and paragraph.runs):
                    run = paragraph.add_run(text)
                    run.bold, run.italic = bold or None, italic or None
            elif child.tag == "br":
                paragraph.add_run().add_break()
            elif child.tag not in ("style", "svg", "table") and child.get("hidden") is None:
                self.runs(paragraph, child, bold or child.tag in INLINE_BOLD, italic or child.tag in INLINE_ITALIC)

    def _tidy(self, paragraph) -> None:
        if paragraph.runs:
            paragraph.runs[0].text = paragraph.runs[0].text.lstrip()
            paragraph.runs[-1].text = paragraph.runs[-1].text.rstrip()

    def paragraph(self, node: Element, style: Optional[str] = None):
        paragraph = self.doc.add_paragraph(style=style)
        self.runs(paragraph, node)
        self._tidy(paragraph)
        return paragraph

    # -- blocks -----------------------------------------------------------------
    def block(self, node: Element) -> None:
        from docx.enum.text import WD_BREAK
        tag = node.tag
        if node.get("hidden") is not None or tag in ("style", "script"):
            return
        if node.get("data-kd-page-break") is not None:
            self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        if re.fullmatch(r"h[1-6]", tag):
            level = int(tag[1])
            self.paragraph(node, f"Heading {min(level, 4)}")
        elif tag == "p":
            if node.text(4).strip():
                self.paragraph(node)
        elif tag in ("ul", "ol"):
            style = "List Number" if tag == "ol" else "List Bullet"
            restart = self._restart_numbering() if tag == "ol" else None
            for item in (c for c in node.children if isinstance(c, Element) and c.tag == "li"):
                paragraph = self.paragraph(item, style)
                if restart is not None:
                    num_pr = paragraph._p.get_or_add_pPr().get_or_add_numPr()
                    num_pr.get_or_add_ilvl().val = 0
                    num_pr.get_or_add_numId().val = restart
        elif tag == "blockquote":
            self.paragraph(node, "Quote")
        elif tag == "figure" and node.get("data-chart") is not None:
            self.chart(node)
        elif tag == "figure":
            for child in node.children:
                if isinstance(child, Element):
                    self.block(child)
        elif tag == "figcaption":
            self.paragraph(node, "Caption")
        elif tag == "table":
            self.table(node)
        elif tag == "img":
            self.image(node)
        elif tag == "hr":
            self.doc.add_paragraph()
        elif tag in BLOCKS or tag in ("li", "dl", "dd", "dt", "form", "label"):
            inline = all(isinstance(c, Text) or c.tag in ("b", "strong", "i", "em", "span", "a", "small", "br", "code", "mark")
                         for c in node.children)
            if inline:
                if node.text(4).strip():
                    self.paragraph(node)
            else:
                for child in node.children:
                    if isinstance(child, Element):
                        self.block(child)
                    elif child.data.strip():
                        self.doc.add_paragraph(child.data.strip())
        else:
            if node.text(4).strip():
                self.paragraph(node)

    def _restart_numbering(self) -> Optional[int]:
        """A new numbering instance for one numbered list, starting at 1. Word's List Number style is one
        sequence for the whole document, so every list after the first would carry on counting."""
        style = self.doc.styles["List Number"].element
        num_pr = style.pPr.numPr if style.pPr is not None else None
        if num_pr is None or num_pr.numId is None:
            return None
        numbering = self.doc.part.numbering_part.element
        base = numbering.num_having_numId(num_pr.numId.val)
        num = numbering.add_num(base.abstractNumId.val)
        num.add_lvlOverride(ilvl=0).add_startOverride(1)
        return num.numId

    def chart(self, figure: Element) -> None:
        from docx.shared import Inches, Pt
        caption = next((c for c in figure.elements() if c.tag == "figcaption"), None)
        if caption is not None:
            self.paragraph(caption, "Caption").paragraph_format.keep_with_next = True
        spec = design_charts.parse(figure)
        if spec is None:
            return
        if spec["type"] == "stat":
            table = self.doc.add_table(rows=2, cols=len(spec["categories"]))
            for i, (label, value) in enumerate(zip(spec["categories"], spec["labels"])):
                run = table.cell(0, i).paragraphs[0].add_run(value)
                run.bold = True
                run.font.size = Pt(22)
                run.font.color.rgb = _rgb(self.palette.accent)
                table.cell(1, i).paragraphs[0].add_run(label).font.color.rgb = _rgb(self.palette.dim)
            return
        picture = design_charts.png(spec, {**self.tokens, "--ds-bg": "#FFFFFF", "--ds-text": self.palette.text,
                                           "--ds-text-dim": self.palette.dim})
        self.doc.add_picture(io.BytesIO(picture), width=Inches(min(6.0, self.width_in)))

    def table(self, node: Element) -> None:
        rows = [r for r in node.elements() if r.tag == "tr"]
        if not rows:
            return
        cells = [[c for c in r.children if isinstance(c, Element) and c.tag in ("td", "th")] for r in rows]
        cols = max(len(r) for r in cells)
        if not cols:
            return
        table = self.doc.add_table(rows=len(rows), cols=cols)
        table.style = "Table Grid"
        head = all(c.tag == "th" for c in cells[0])
        for r, row in enumerate(cells):
            for c, cell in enumerate(row):
                target = table.cell(r, c)
                paragraph = target.paragraphs[0]
                self.runs(paragraph, cell, bold=head and r == 0)
                self._tidy(paragraph)
                if head and r == 0:
                    _shade(target, self.palette.fill)
                    for run in paragraph.runs:
                        run.font.color.rgb = _rgb(self.palette.on_fill)
        if head:  # The header row repeats on every page the table crosses.
            from docx.oxml import OxmlElement
            from docx.oxml.ns import qn
            flag = OxmlElement("w:tblHeader")
            flag.set(qn("w:val"), "true")
            table.rows[0]._tr.get_or_add_trPr().append(flag)
        self.doc.add_paragraph()

    def image(self, node: Element) -> None:
        from docx.shared import Inches
        src = node.get("src") or ""
        raw = None
        if src.startswith("data:image/") and design_html.DATA_IMAGE.fullmatch(src):
            raw = base64.b64decode(src.split(",", 1)[1])
        else:
            match = re.search(r"assets/([0-9a-f]{64}\.(?:png|jpe?g|gif|webp))", src)
            try:
                raw = design_store.asset_path(self.design_id, match.group(1)).read_bytes() if match else None
            except LookupError:
                raw = None
        if raw is None:
            self.notes.append(f"An image ({node.get('alt') or src[:40]}) isn't one of the design's assets, so Word leaves it out.")
            return
        try:
            self.doc.add_picture(io.BytesIO(raw), width=Inches(min(6.0, self.width_in)))
        except Exception:
            self.notes.append(f"Word couldn't read an image ({node.get('alt') or 'no alt text'}).")


def build(design_id: str, slugs: list[str], *, fonts: str = "office") -> tuple[bytes, list[str]]:
    """The .docx for one or more document boards, and notes on anything left out."""
    import docx
    from docx.enum.section import WD_SECTION
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Inches, Pt
    data = design_store.manifest(design_id)
    system = design_systems.get(data.get("design_system")) or design_systems.builtin()
    tokens = design_systems.variables(system["tokens"], data.get("token_overrides"))
    palette = Palette(tokens)
    display, body = _fonts(data, fonts)
    doc = docx.Document()
    normal = doc.styles["Normal"]
    _font(normal, body)
    normal.font.size, normal.font.color.rgb = Pt(11), _rgb(palette.text)
    normal.paragraph_format.space_after, normal.paragraph_format.line_spacing = Pt(8), 1.3
    for level in range(1, 5):
        style = doc.styles[f"Heading {level}"]
        _font(style, display)
        style.font.size, style.font.bold = Pt(HEADING_PT[level]), False  # Display faces carry their own weight.
        style.font.color.rgb = _rgb(palette.text if level < 3 else palette.accent)
        style.paragraph_format.space_before, style.paragraph_format.space_after = Pt(18 if level > 1 else 0), Pt(8)
        style.paragraph_format.keep_with_next = True
    for name in ("Caption", "Quote", "List Bullet", "List Number", "Title"):
        style = doc.styles[name]
        _font(style, body)
        style.font.color.rgb = _rgb(palette.dim if name in ("Caption", "Quote") else palette.text)
    notes: list[str] = []
    for n, slug in enumerate(slugs):
        meta = data["boards"][slug]
        _, page_w, page_h = design_formats.page(meta)
        section = doc.sections[0] if n == 0 else doc.add_section(WD_SECTION.NEW_PAGE)
        section.page_width, section.page_height = Inches(page_w / 96), Inches(page_h / 96)
        margin = Inches(design_formats.PAGE_MARGIN / 96)
        section.left_margin = section.right_margin = section.top_margin = section.bottom_margin = margin
        section.different_first_page_header_footer = True
        header = section.header.paragraphs[0]
        header.text = data.get("title") or meta.get("title") or ""
        for run in header.runs:
            run.font.size, run.font.color.rgb = Pt(8.5), _rgb(palette.dim)
        for footer in (section.footer, section.first_page_footer):
            line = footer.paragraphs[0]
            line.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            line.add_run("Page ")
            _field(line.add_run(), "PAGE")
            line.add_run(" of ")
            _field(line.add_run(), "NUMPAGES")
            for run in line.runs:
                run.font.size, run.font.color.rgb = Pt(8.5), _rgb(palette.dim)
        writer = Writer(doc, design_id, palette, tokens, (page_w - 2 * design_formats.PAGE_MARGIN) / 96)
        root = design_html.parse(design_store.board_html(design_id, slug))
        for child in root.children:
            if isinstance(child, Element):
                writer.block(child)
            elif child.data.strip():
                doc.add_paragraph(child.data.strip())
        notes += writer.notes
    if doc.paragraphs and not doc.paragraphs[0].text and not doc.paragraphs[0].runs:
        doc.paragraphs[0]._p.getparent().remove(doc.paragraphs[0]._p)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue(), list(dict.fromkeys(notes))

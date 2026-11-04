"""A design board's HTML: a tolerant tree, the normaliser, stable element ids
and the small edit operations every model uses (Design Canvas spec, 3a/3b).

Built on the standard library's html.parser on purpose (2026-10-22): the spec
recommended html5lib, but it is not in the runtime, and a new dependency waits
on David. The tree below copes with what models actually write: unclosed
paragraphs and list items, stray end tags, implied table rows, void tags
written either way, and a whole <html> document where a fragment was asked
for. It is not a browser parser, and does not need to be: every board is
re-serialised from this tree, so what is stored is always well formed, and
the browser renders exactly what was stored.

The normaliser is not a judge. It removes what can run or reach out (scripts,
frames, plug-ins, form targets, event handlers, javascript: and external
URLs), gives every element a stable `data-kd` id, enforces the size cap, and
returns lint notes (raw colours, low contrast, images without alt) without
refusing the board.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Iterable, Optional, Union

MAX_BOARD_BYTES = 200 * 1024
ID_ATTR = "data-kd"
ID_RE = re.compile(r"[a-z][a-z0-9-]{0,31}")
VOID = frozenset("area base br col embed hr img input link meta source track wbr".split())
# Removed with everything inside them.
DROP = frozenset("script iframe frame frameset object embed applet noscript noembed noframes template base "
                 "link meta title portal param xmp plaintext".split())
# The document wrapper a model sometimes writes around a fragment.
UNWRAP = frozenset({"html", "head", "body"})
RAW_TEXT = frozenset({"style"})
# Elements that never get an id of their own.
NO_ID = frozenset({"style", "br", "wbr"})
URL_ATTRS = frozenset({"href", "src", "xlink:href", "poster", "background", "action", "formaction",
                       "data", "cite", "longdesc", "srcset", "ping", "manifest", "codebase", "usemap"})
DROPPED_ATTRS = frozenset({"srcdoc", "formaction", "action", "target", "ping", "http-equiv", "srcset",
                           "nonce", "integrity", "autofocus"})
ASSET_PATH = re.compile(r"assets/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp|svg|woff2?|ttf|otf)")
DATA_IMAGE = re.compile(r"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+", re.I)
PREFIX = {"button": "btn", "a": "link", "img": "img", "p": "p", "span": "s", "div": "div", "section": "sec",
          "header": "head", "footer": "foot", "nav": "nav", "ul": "list", "ol": "list", "li": "item",
          "input": "input", "label": "label", "svg": "svg", "main": "main", "article": "art",
          "figure": "fig", "textarea": "text", "select": "select", "table": "table", "form": "form"}
PREFIX.update({f"h{n}": "h" for n in range(1, 7)})

# Closing a paragraph or list item that the model left open, as a browser does.
_CLOSES_P = frozenset("address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 "
                      "h3 h4 h5 h6 header hr main nav ol p pre section table ul".split())


class DesignError(ValueError):
    """A bad edit: nothing changed, and the message says why and what is valid."""


@dataclass(eq=False)
class Text:
    data: str


@dataclass(eq=False)
class Element:
    tag: str
    attrs: list = field(default_factory=list)
    children: list = field(default_factory=list)
    parent: Optional["Element"] = field(default=None, repr=False)

    def get(self, name: str, default=None):
        for key, value in self.attrs:
            if key == name:
                return value
        return default

    def set(self, name: str, value: Optional[str]) -> None:
        for index, (key, _) in enumerate(self.attrs):
            if key == name:
                if value is None:
                    del self.attrs[index]
                else:
                    self.attrs[index] = (name, value)
                return
        if value is not None:
            self.attrs.append((name, value))

    @property
    def kd(self) -> Optional[str]:
        return self.get(ID_ATTR)

    def elements(self) -> Iterable["Element"]:
        """This element's descendants, document order."""
        for child in self.children:
            if isinstance(child, Element):
                yield child
                yield from child.elements()

    def text(self, limit: int = 10_000) -> str:
        parts, size = [], 0
        for node in _walk_text(self):
            parts.append(node)
            size += len(node)
            if size >= limit:
                break
        return " ".join(" ".join(parts).split())[:limit]


Node = Union[Element, Text]


def _walk_text(element: Element):
    for child in element.children:
        if isinstance(child, Text):
            yield child.data
        elif child.tag not in RAW_TEXT:
            yield from _walk_text(child)


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Element("#root")
        self.stack = [self.root]
        self.skip: list[str] = []
        self.svg_depth = 0

    def _top(self) -> Element:
        return self.stack[-1]

    def _close(self, tag: str) -> bool:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return True
        return False

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.skip:
            if tag not in VOID:
                self.skip.append(tag)
            return
        if tag in DROP:
            if tag not in VOID:
                self.skip.append(tag)
            return
        if tag in UNWRAP:
            return
        top = self._top().tag
        if tag in _CLOSES_P and top == "p":
            self.stack.pop()
        elif tag == "li" and top == "li":
            self.stack.pop()
        elif tag in ("dt", "dd") and top in ("dt", "dd"):
            self.stack.pop()
        elif tag == "option" and top == "option":
            self.stack.pop()
        elif tag in ("td", "th") and top in ("td", "th"):
            self.stack.pop()
        elif tag == "tr":
            if top in ("td", "th"):
                self.stack.pop()
            if self._top().tag == "tr":
                self.stack.pop()
        node = Element(tag, [(k.lower(), v if v is not None else "") for k, v in attrs], [], self._top())
        self._top().children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        self.handle_starttag(tag, attrs)
        # A self-closed non-void tag (common in SVG) closes at once.
        if tag not in VOID and not self.skip and self._top().tag == tag:
            self.stack.pop()
        elif self.skip and self.skip[-1] == tag:
            self.skip.pop()

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.skip:
            if tag in self.skip:
                del self.skip[len(self.skip) - 1 - self.skip[::-1].index(tag):]
            return
        if tag in UNWRAP or tag in VOID:
            return
        self._close(tag)  # A stray end tag with nothing open to close is ignored.

    def handle_data(self, data):
        if self.skip or not data:
            return
        top = self._top()
        if top.children and isinstance(top.children[-1], Text):
            top.children[-1].data += data
        else:
            top.children.append(Text(data))

    def handle_comment(self, data):
        return  # Comments are dropped: they are noise to a model and a hiding place for text.

    def handle_decl(self, decl):
        return

    def handle_pi(self, data):
        return


def parse(source: str) -> Element:
    """A tolerant tree of an HTML fragment (or a whole document, whose body is kept)."""
    builder = _Builder()
    builder.feed(source or "")
    builder.close()
    return builder.root


# -- sanitising ---------------------------------------------------------------

_CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
_CSS_BAD = re.compile(r"expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:", re.I)
_CSS_IMPORT = re.compile(r"@import[^;]*;?", re.I)


def safe_url(value: str, *, image: bool = False) -> Optional[str]:
    value = (value or "").strip()
    if not value:
        return None
    if value.startswith("#") and re.fullmatch(r"#[A-Za-z0-9_-]{0,64}", value):
        return value
    if ASSET_PATH.fullmatch(value):
        return value
    if image and DATA_IMAGE.fullmatch(value) and len(value) <= 1_500_000:
        return re.sub(r"\s+", "", value)
    return None


def clean_css(text: str) -> str:
    """CSS with no imports, script URLs or outside resources: url() keeps only
    a data: image or one of the design's own assets."""
    text = _CSS_IMPORT.sub("", text or "")
    text = _CSS_BAD.sub("", text)

    def url(match):
        kept = safe_url(match.group(2), image=True)
        return f'url("{kept}")' if kept and not kept.startswith("#") else "none"
    text = _CSS_URL.sub(url, text)
    return text.replace("</", "<\\/")


def _clean_element(node: Element, notes: list[str]) -> None:
    kept = []
    for name, value in node.attrs:
        if (name.startswith("on") or name in DROPPED_ATTRS or not re.fullmatch(r"[a-z_:][a-z0-9_:.-]{0,60}", name)
                or (name == "style" and not value.strip())):
            if name.startswith("on"):
                notes.append(f"Removed the {name} handler from <{node.tag}>: boards run no scripts. Use data-kd-goto or data-kd-toggle for clicks.")
            continue
        if name in URL_ATTRS:
            safe = safe_url(value, image=name in ("src", "poster", "background", "xlink:href", "href") and node.tag in ("img", "image", "source", "video"))
            if safe is None:
                if value.strip():
                    notes.append(f"Removed {name}=\"{value.strip()[:60]}\" from <{node.tag}>: boards load only their own assets or data: images. Use data-kd-goto to link boards.")
                continue
            value = safe
        if name == "style":
            value = clean_css(value)
        kept.append((name, value))
    node.attrs = kept
    if node.tag in ("animate", "set", "animatetransform", "animatemotion") and \
            (node.get("attributename") or "").lower() in ("href", "xlink:href"):
        node.attrs = [(k, v) for k, v in node.attrs if k not in ("to", "from", "values", "by")]
    if node.tag == "style":
        node.children = [Text(clean_css("".join(c.data for c in node.children if isinstance(c, Text))))]


def sanitize(root: Element) -> list[str]:
    notes: list[str] = []
    for node in list(root.elements()):
        _clean_element(node, notes)
    return list(dict.fromkeys(notes))


# -- ids -------------------------------------------------------------------------

def _svg_descendant(node: Element) -> bool:
    parent = node.parent
    while parent is not None and parent.tag != "#root":
        if parent.tag == "svg":
            return True
        parent = parent.parent
    return False


def assign_ids(root: Element) -> None:
    """Every element without a valid, unique id gets the next free short one
    (h3, btn7...). Existing ids are kept, so they survive every edit."""
    used: set[str] = set()
    pending: list[Element] = []
    for node in root.elements():
        if node.tag in NO_ID or _svg_descendant(node):
            node.set(ID_ATTR, None)
            continue
        kd = node.kd
        if kd and ID_RE.fullmatch(kd) and kd not in used:
            used.add(kd)
        else:
            node.set(ID_ATTR, None)
            pending.append(node)
    counters: dict[str, int] = {}
    for node in pending:
        prefix = PREFIX.get(node.tag, re.sub(r"[^a-z0-9]", "", node.tag)[:6] or "el")
        if not prefix[0].isalpha():
            prefix = "el" + prefix
        n = counters.get(prefix, 0)
        while True:
            n += 1
            candidate = f"{prefix}{n}"
            if candidate not in used:
                break
        counters[prefix] = n
        used.add(candidate)
        # The id goes first, so a model reading the board sees it at once.
        node.attrs.insert(0, (ID_ATTR, candidate))


# -- serialising -----------------------------------------------------------------

def _attr(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def serialize(node: Node, *, parent_raw: bool = False) -> str:
    if isinstance(node, Text):
        return node.data if parent_raw else html.escape(node.data, quote=False)
    if node.tag == "#root":
        return "".join(serialize(child) for child in node.children)
    attrs = "".join(f' {name}="{_attr(value)}"' if value != "" or name.startswith("data-") else f" {name}"
                    for name, value in node.attrs)
    if node.tag in VOID:
        return f"<{node.tag}{attrs}>"
    raw = node.tag in RAW_TEXT
    inner = "".join(serialize(child, parent_raw=raw) for child in node.children)
    return f"<{node.tag}{attrs}>{inner}</{node.tag}>"


def normalize(source: str) -> tuple[str, Element, list[str]]:
    """Parse, clean and id a board. Returns the stored HTML, its tree and the
    notes on what was removed. Raises DesignError when it is too large."""
    from core import design_charts
    root = parse(source)
    notes = sanitize(root)
    notes += design_charts.expand(root)  # Charts are drawn from their tables on every save.
    assign_ids(root)
    text = serialize(root).strip()
    if len(text.encode("utf-8")) > MAX_BOARD_BYTES:
        raise DesignError(f"Not saved: the board would be {len(text.encode()) // 1024} KB; a board is at most "
                          f"{MAX_BOARD_BYTES // 1024} KB. Split it into two boards or remove repeated markup.")
    return text, root, notes


def index(root: Element) -> dict[str, Element]:
    return {node.kd: node for node in root.elements() if node.kd}


def self_signature(node: Element) -> str:
    """What changed about one element, ignoring changes inside its children:
    its tag, attributes, own text and the order of its child ids."""
    parts = [node.tag, repr(sorted(node.attrs))]
    for child in node.children:
        parts.append(child.data if isinstance(child, Text) else f"<{child.kd or serialize(child)}>")
    return "\x00".join(parts)


def changed_ids(before: str, after: str) -> list[str]:
    """The ids whose element itself was added, removed or changed."""
    old = {kd: self_signature(node) for kd, node in index(parse(before)).items()}
    new = {kd: self_signature(node) for kd, node in index(parse(after)).items()}
    return sorted(kd for kd in old.keys() | new.keys() if old.get(kd) != new.get(kd))


# -- reading ---------------------------------------------------------------------

def describe(node: Element, width: int = 40) -> str:
    text = node.text(width + 1)
    label = f' "{text[:width]}{"..." if len(text) > width else ""}"' if text and node.tag not in RAW_TEXT else ""
    extra = ""
    if node.tag == "img":
        extra = f' alt="{(node.get("alt") or "")[:30]}"'
    elif node.get("data-kd-goto"):
        extra = f" goto={node.get('data-kd-goto')}"
    elif node.get("data-kd-component"):
        extra = f" component={node.get('data-kd-component')}"
    return f"{node.kd or '-'} <{node.tag}>{extra}{label}"


def outline(root: Element, limit: int = 6000) -> str:
    lines: list[str] = []
    size = 0

    def walk(node: Element, depth: int) -> bool:
        nonlocal size
        for child in node.children:
            if not isinstance(child, Element):
                continue
            if child.tag == "style":
                line = "  " * depth + f"<style> ({len(child.text(10**6))} characters of CSS)"
            elif _svg_descendant(child):
                continue
            else:
                line = "  " * depth + describe(child)
            size += len(line) + 1
            if size > limit:
                lines.append("  " * depth + "[Outline truncated; read a smaller part with design_read and an element id.]")
                return False
            lines.append(line)
            if child.tag not in ("svg", "style") and not walk(child, depth + 1):
                return False
        return True
    walk(root, 0)
    return "\n".join(lines) or "(empty board)"


def missing(root: Element, kd: str, board: str) -> DesignError:
    """The teaching error for an id that is not on the board."""
    ids = index(root)
    want = re.sub(r"[0-9]+$", "", kd or "")
    alike = [node for node in ids.values() if want and node.kd.startswith(want)] or list(ids.values())
    sample = ", ".join(describe(node, 24).replace(" <", " <", 1) for node in alike[:8])
    kind = {"btn": "Buttons", "h": "Headings", "p": "Paragraphs", "img": "Images", "link": "Links"}.get(want, "Elements")
    return DesignError(f"No element `{kd}` on board `{board}`. {kind} on this board: {sample or 'none'}. "
                       f"Call design_outline to see every id.")


# -- operations ------------------------------------------------------------------

STYLE_PROP = re.compile(r"-{0,2}[a-z][a-z0-9-]{0,60}")
POSITIONS = ("before", "after", "first_child", "last_child")
OPS = ("set_text", "set_attr", "set_style", "replace", "insert", "remove", "move", "replace_text")


def _style_items(value: str) -> list[tuple[str, str]]:
    items = []
    for part in (value or "").split(";"):
        if ":" in part:
            name, _, val = part.partition(":")
            if name.strip():
                items.append((name.strip().lower(), val.strip()))
    return items


def _fragment(source: str, what: str) -> list[Node]:
    if not isinstance(source, str) or not source.strip():
        raise DesignError(f"{what} needs html: a non-empty HTML string.")
    root = parse(source)
    nodes = [child for child in root.children if isinstance(child, Element) or child.data.strip()]
    if not any(isinstance(node, Element) for node in nodes):
        raise DesignError(f"{what}'s html has no element. Wrap text in a tag, for example <p>Text</p>.")
    return nodes


def _detach(node: Element) -> None:
    node.parent.children.remove(node)


def _place(nodes: list[Node], ref: Element, position: str) -> None:
    if position in ("first_child", "last_child"):
        if ref.tag in VOID:
            raise DesignError(f"`{ref.kd}` is a <{ref.tag}>, which cannot hold children. Use before or after.")
        parent, at = ref, (0 if position == "first_child" else len(ref.children))
    else:
        parent = ref.parent
        at = parent.children.index(ref) + (1 if position == "after" else 0)
    for offset, node in enumerate(nodes):
        if isinstance(node, Element):
            node.parent = parent
        parent.children.insert(at + offset, node)


def _need(op: dict, key: str, kind=str):
    value = op.get(key)
    if not isinstance(value, kind) or (kind is str and not value):
        raise DesignError(f"{op.get('op')} needs {key}" + (" (text)" if kind is str else ""))
    return value


def apply_ops(source: str, ops: list, board: str) -> tuple[str, list[str], list[str]]:
    """Apply edit operations in order, all or nothing. Returns the new HTML,
    the ids the edit touched, and notes."""
    if not isinstance(ops, list) or not 1 <= len(ops) <= 20:
        raise DesignError("ops must be a list of 1 to 20 operations, for example "
                          '[{"op": "set_style", "id": "btn7", "style": {"width": "100%"}}].')
    current = source
    touched: list[str] = []
    notes: list[str] = []
    for number, op in enumerate(ops, 1):
        if not isinstance(op, dict) or op.get("op") not in OPS:
            raise DesignError(f"Operation {number}: op must be one of {', '.join(OPS)}.")
        try:
            current, ids, more = _apply_one(current, op, board)
        except DesignError as error:
            raise DesignError(f"Nothing was changed. Operation {number} ({op.get('op')}) failed: {error}") from None
        touched.extend(ids)
        notes.extend(more)
    text, _, clean_notes = normalize(current)
    return text, list(dict.fromkeys(touched)), list(dict.fromkeys(notes + clean_notes))


def _apply_one(source: str, op: dict, board: str) -> tuple[str, list[str], list[str]]:
    kind = op["op"]
    if kind == "replace_text":
        find, replace = op.get("find"), op.get("replace")
        if not isinstance(find, str) or not find or not isinstance(replace, str):
            raise DesignError("replace_text needs find (non-empty text) and replace (text).")
        count = source.count(find)
        if count != 1:
            raise DesignError(f"find must match the board's HTML exactly once; it matched {count} times. "
                              "Include more surrounding text, or use an id operation instead.")
        return source.replace(find, replace), [], []
    root = parse(source)
    assign_ids(root)
    ids = index(root)
    target_id = op.get("id") if kind != "insert" else op.get("ref_id") or op.get("id")
    if not isinstance(target_id, str) or not target_id:
        raise DesignError(f"{kind} needs {'ref_id' if kind == 'insert' else 'id'}: an element id from design_outline.")
    node = ids.get(target_id)
    if node is None:
        raise missing(root, target_id, board)
    touched = [target_id]
    notes: list[str] = []
    if kind == "set_text":
        text = op.get("text")
        if not isinstance(text, str):
            raise DesignError("set_text needs text.")
        if node.tag in VOID or node.tag == "style":
            raise DesignError(f"`{target_id}` is a <{node.tag}> and holds no text. Use set_attr for its attributes.")
        if any(isinstance(child, Element) for child in node.children):
            notes.append(f"set_text replaced everything inside {target_id}, including its child elements.")
        node.children = [Text(text)]
    elif kind == "set_attr":
        name = _need(op, "name").lower()
        value = op.get("value")
        if name == ID_ATTR:
            raise DesignError("data-kd is the element's id and cannot be changed.")
        if value is not None and not isinstance(value, str):
            value = str(value)
        if name.startswith("on"):
            raise DesignError("Event handlers are not allowed: boards run no scripts. "
                              "Use data-kd-goto=\"board\" to open a board on click, or data-kd-toggle=\"id\" to show or hide an element.")
        node.set(name, value)
    elif kind == "set_style":
        style = op.get("style")
        if not isinstance(style, dict) or not style:
            raise DesignError('set_style needs style: an object of CSS properties, e.g. {"width": "100%"}.')
        items = dict(_style_items(node.get("style") or ""))
        for prop, value in style.items():
            prop = str(prop).strip().lower()
            if not STYLE_PROP.fullmatch(prop):
                raise DesignError(f"`{prop}` is not a CSS property name.")
            if value in (None, ""):
                items.pop(prop, None)
                continue
            value = str(value).strip()
            if re.search(r"[;{}<>]", value):
                raise DesignError(f"The value for {prop} cannot contain ; {{ }} < or >.")
            items[prop] = value
        node.set("style", "; ".join(f"{k}: {v}" for k, v in items.items()) or None)
    elif kind == "replace":
        nodes = _fragment(op.get("html"), "replace")
        first = next(n for n in nodes if isinstance(n, Element))
        if not first.kd:
            first.attrs.insert(0, (ID_ATTR, target_id))  # The replacement keeps the element's id.
        _place(nodes, node, "before")
        _detach(node)
    elif kind == "insert":
        position = op.get("position") or "after"
        if position not in POSITIONS:
            raise DesignError(f"position must be one of {', '.join(POSITIONS)}.")
        nodes = _fragment(op.get("html"), "insert")
        _place(nodes, node, position)
    elif kind == "remove":
        _detach(node)
    elif kind == "move":
        ref_id = _need(op, "ref_id")
        ref = ids.get(ref_id)
        if ref is None:
            raise missing(root, ref_id, board)
        position = op.get("position") or "after"
        if position not in POSITIONS:
            raise DesignError(f"position must be one of {', '.join(POSITIONS)}.")
        if ref is node or any(d is ref for d in node.elements()):
            raise DesignError(f"Cannot move `{target_id}` into itself or one of its own children.")
        _detach(node)
        _place([node], ref, position)
        touched.append(ref_id)
    return serialize(root), touched, notes


# -- lint --------------------------------------------------------------------------

_COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)")


def _hex(value: str) -> Optional[tuple[float, float, float]]:
    value = value.strip()
    match = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?", value)
    if match:
        digits = match.group(1)
        if len(digits) == 3:
            digits = "".join(c * 2 for c in digits)
        return tuple(int(digits[i:i + 2], 16) / 255 for i in (0, 2, 4))
    match = re.fullmatch(r"rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([0-9.]+%?))?\s*\)", value)
    if match:
        if match.group(4) and match.group(4) not in ("1", "1.0", "100%"):
            return None  # A see-through colour has no fixed contrast.
        return tuple(min(255, int(match.group(i))) / 255 for i in (1, 2, 3))
    return None


def _luminance(rgb) -> float:
    def channel(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _resolve(value: str, tokens: dict[str, str]) -> Optional[tuple]:
    value = (value or "").strip()
    match = re.fullmatch(r"var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)", value)
    if match:
        value = tokens.get(match.group(1)) or (match.group(2) or "")
    return _hex(value)


def lint(root: Element, tokens: dict[str, str], *, accent_var: str = "--ds-accent") -> list[str]:
    """Notes, not refusals: raw colours, text below WCAG AA, images without alt,
    and the accent used as text."""
    notes: list[str] = []
    raw: list[str] = []
    low: list[str] = []
    for node in root.elements():
        style = dict(_style_items(node.get("style") or ""))
        for prop, value in style.items():
            for found in _COLOR.findall(value):
                raw.append(f"{found} on {node.kd or node.tag}")
        if node.tag == "style":
            for found in _COLOR.findall(node.text(10**6))[:3]:
                raw.append(f"{found} in a <style>")
        if node.tag == "img" and not (node.get("alt") or "").strip():
            notes.append(f"Image {node.kd} has no alt text; set_attr alt to describe it.")
        if accent_var in style.get("color", "") and not style.get("color", "").startswith(f"var({accent_var}-"):
            notes.append(f"{node.kd} uses {accent_var} as text colour; the accent is for hairlines and icons. Use var(--ds-accent-text).")
        if node.tag not in RAW_TEXT and any(isinstance(c, Text) and c.data.strip() for c in node.children):
            fg = _inherited(node, "color", tokens) or _resolve(f"var(--ds-text)", tokens)
            bg = _inherited(node, ("background-color", "background"), tokens) or _resolve("var(--ds-bg)", tokens)
            if fg and bg:
                ratio = contrast(fg, bg)
                size = style.get("font-size", "")
                large = bool(re.fullmatch(r"(2[4-9]|[3-9][0-9]|1[0-9]{2})(?:\.\d+)?px", size)) or node.tag in ("h1", "h2")
                if ratio < (3.0 if large else 4.5):
                    low.append(f"{node.kd} ({ratio:.1f}:1)")
    if raw:
        notes.insert(0, f"{len(raw)} raw colour{'s' if len(raw) != 1 else ''} not from the design system "
                        f"({', '.join(raw[:4])}). Use var(--ds-...) tokens; design_tokens lists them.")
    if low:
        notes.append(f"Text below WCAG AA contrast: {', '.join(low[:6])}. Use var(--ds-text) on var(--ds-bg) or var(--ds-surface).")
    return list(dict.fromkeys(notes))


def _inherited(node: Element, props, tokens) -> Optional[tuple]:
    props = (props,) if isinstance(props, str) else props
    current: Optional[Element] = node
    while current is not None and current.tag != "#root":
        style = dict(_style_items(current.get("style") or ""))
        for prop in props:
            if prop in style:
                value = style[prop].split()[0] if prop == "background" and not style[prop].startswith("var(") else style[prop]
                resolved = _resolve(value, tokens)
                if resolved:
                    return resolved
                if prop.startswith("background"):
                    return None  # A gradient or image: contrast unknown.
        current = current.parent
    return None

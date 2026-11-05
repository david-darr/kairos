"""The Design canvas tools, the same for every model (spec 3b).

Registered once in core/tool_registry.py's table (it imports this module at
its end), so Claude (hive-mind MCP), Codex (the CLI bridge), OpenAI-compatible,
local and native-API models all get identical tools. They change only
Kairos's own data, so they are ordinary audited writes with no prompt, except
design_system_save, which is admin-only and asks through the broker.

Small, structured edits are the point: a change to one button is one
design_edit call, never a rewrite of the board, which is where small models
fail. A bad call changes nothing and says exactly why, with what is valid.

Which tools a chat sees (tool_registry.design_gate): design_create always (on
a small window only through the tool-search bridge, unless the chat is in
Design mode); the editing tools only once a design is linked to the chat, so
chats that never design pay no tokens for them. A small window always finds
them through the bridge; the CLI bridge always accepts them.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from core import creative_direction, design_checks, design_formats, design_html, design_store, design_systems
from core.tool_registry import (ALL, CLAUDE, CODEX, OPENAI, READ, WRITE, ToolContext, ToolResult, _object, _str,
                                register)
from core.untrusted import wrap_untrusted

BRAND_OVERRIDES = 3  # More token overrides than this in one call get a note.
LINKED_TOOLS = frozenset({"design_outline", "design_read", "design_add_board", "design_edit", "design_boards",
                          "design_tokens", "design_snapshot", "design_comments", "design_export"})
MAX_READ = 40 * 1024
SKILL_HINT = "Read the design-canvas skill first (read_skill design-canvas)."
FRAMES = list(design_store.FRAMES)
FORMATS = design_formats.FORMAT_IDS
FORMAT_HELP = ("Pick the format from the request: " + design_formats.catalog_text() + ". "
               "A website is always a desktop board (1440 wide) and a mobile board (390 wide); their height grows "
               "with the content, so never set a page's height or an odd width. format custom with w and h only when "
               "the person asked for exact pixel dimensions.")
_FORMAT = {"type": "string", "enum": FORMATS, "description": "The board's format, from the request (see the tool description)"}
_ORIENTATION = {"type": "string", "enum": list(design_formats.ORIENTATIONS),
                "description": "portrait or landscape (square for a square social post); ignored for website and email"}
_SIZE = _str("Optional size within the format: website pair (default), desktop or mobile; app phone or tablet; "
             "poster 2:3, 3:4, a-series, 18x24 or 11x17; social post or story; print letter or a4; banner header, "
             "leaderboard, billboard, linkedin or skyscraper")

_ID = _str("The design id from design_create (optional when this chat has one design)")
_BOARD = _str("Board slug from design_outline (a title or its number, e.g. \"2\", also works)")
_OPS_HELP = (
    "Operations, each addressed by a data-kd id from design_outline: "
    "set_text {id, text}; set_attr {id, name, value}; set_style {id, style: {prop: value}}; "
    "replace {id, html}; insert {ref_id, position: before|after|first_child|last_child, html}; remove {id}; "
    "move {id, ref_id, position}; replace_text {find, replace} (exact text, must match once).")


def _by(ctx: ToolContext) -> str:
    if ctx.model:
        return str(ctx.model)[:60]
    return {CLAUDE: "Claude", CODEX: "Codex", OPENAI: "Model"}.get(ctx.surface, "Model")


def _key(ctx: ToolContext) -> Optional[str]:
    return design_store.chat_key(ctx.session_id, ctx.agent_id)


design_mode = design_store.design_mode


def linked(session_id: Optional[str]) -> bool:
    return bool(session_id) and bool(design_store.designs_for_chat(session_id))


def _design(args: dict, ctx: ToolContext) -> dict:
    key = _key(ctx)
    if not key:
        raise LookupError("Designs belong to a chat; this call has none.")
    design_id = args.get("design_id")
    if not design_id:
        mine = design_store.designs_for_chat(key)
        if not mine:
            raise LookupError("No design is linked to this chat yet. Call design_create first.")
        if len(mine) > 1:
            listing = ", ".join(f"{d['id']} \"{d.get('title')}\"" for d in mine[:8])
            raise LookupError(f"This chat has {len(mine)} designs; pass design_id. Designs: {listing}.")
        return mine[0]
    if not isinstance(design_id, str) or not design_store.exists(design_id):
        raise LookupError(f"No design `{design_id}`.")
    return design_store.require_chat_access(design_id, key)


def _taint(ctx: ToolContext) -> None:
    if ctx.turn_taint:
        ctx.turn_taint.mark("design content")


def _link(data: dict) -> str:
    title = (data.get("title") or "Design").replace("[", "").replace("]", "")[:60]
    return f"[Design: {title}](/designs/{data['id']})"


def _size_text(info: dict) -> str:
    """"Website · Desktop 1440 wide, height grows (now 2310)", "Poster · 2:3 portrait 1200x1800"."""
    name = design_formats.label(info)
    if design_formats.paged(info):
        pages = max(1, -(-int(info["h"]) // design_formats.page(info)[2]))
        return f"{name}, {info['w']} wide, its pages flow with the content (about {pages} page{'s' if pages > 1 else ''})"
    if design_formats.grows(info):
        return f"{name} {info['w']} wide, height grows with the content (now {info['h']})"
    return f"{name} {info['w']}x{info['h']}"


def _notes(notes: list[str]) -> str:
    return ("\nNotes:\n" + "\n".join(f"- {n}" for n in notes[:12])) if notes else ""


def _tokens(data: dict) -> dict[str, str]:
    system = design_systems.get(data.get("design_system")) or design_systems.builtin()
    return design_systems.variables(system["tokens"], data.get("token_overrides"))


async def _print_pages(data: dict, slug: str) -> None:
    """A document board's pages, printed now when the desktop app is here, so the blank-page check sees
    this version (the background refresh would come after the model has read its notes)."""
    from core import design_render_bridge
    if design_formats.paged(data["boards"].get(slug) or {}) and design_render_bridge.available():
        try:
            await design_render_bridge.pages(data["id"], slug)
        except (design_render_bridge.Unavailable, RuntimeError):
            pass


def _lint(data: dict, slug: str, text: Optional[str] = None) -> list[str]:
    root = design_html.parse(text if text is not None else design_store.board_html(data["id"], slug))
    tokens = _tokens(data)
    thumb = design_store.thumb_path(data["id"], slug)
    from core import design_render_bridge
    assets = {p.name for p in (design_store._folder(data["id"]) / "assets").iterdir() if p.is_file()}
    return design_html.lint(root, tokens) + design_checks.check(root, data["boards"].get(slug) or {}, tokens,
                                                                thumb if thumb.is_file() else None,
                                                                pages=design_render_bridge.cached_pages(data["id"], slug),
                                                                assets=assets,
                                                                credits=design_store.credits(data["id"]))


def _guard(handler):
    """Errors as plain text that teach; nothing is half-applied."""
    async def run(args, ctx):
        try:
            return await handler(args, ctx)
        except design_store.AccessError as error:
            return f"Not run: {error}"
        except (LookupError, ValueError) as error:
            text = str(error).strip("'\"")
            return text if text.startswith(("Not ", "Nothing")) else f"Not run: {text}"
    run.__name__ = handler.__name__
    return run


NEXT_STEPS = ("Next: design_outline (see ids), design_edit (change elements by id), design_add_board, "
              "design_boards (rename, duplicate, delete, reorder, move boards), design_tokens (colours and type), "
              "design_snapshot (see a board), design_export (zip, png, pdf or pptx).")


@register("creative_direction",
          "Before designing anything (screens, a website, a poster, slides, a social post, a printed page, a banner, an "
          "email), get three art directions for the brief: a look (its palette, type pairing and mood), a layout and an "
          "imagery plan. Pick one and pass its look to design_create. Same answer for the same brief; no model call.",
          _object({"brief": _str("What the person asked for, in their words, with the subject"),
                   "type": {"type": "string", "enum": list(creative_direction.KINDS),
                            "description": "What is being made (optional; read from the brief when left out)"}},
                  ("brief",)),
          surfaces=ALL, effect=READ, core=True)
async def _creative_direction(args, ctx):
    owner = None
    if ctx.session_id:
        from core.session_manager import session_manager
        owner = (session_manager.get_session(ctx.session_id) or {}).get("owner_user")
    return creative_direction.describe(str(args.get("brief") or "")[:2000], args.get("type"), owner=owner)


@register("design_create",
          "Design screens, app UI, a mockup or wireframe, an onboarding flow, a website or landing page, a poster, "
          "slides, a social post, a print page, a document or PDF (report, guide, proposal, resume, worksheet: format "
          "document, its pages flow), a banner or an email on Kairos's Design canvas: create a design (HTML boards in a "
          "look) linked to this chat. " + SKILL_HINT + " "
          "Pick the look first with creative_direction and pass it as look; without one nothing is created and you get "
          "three directions to choose from. "
          "Pass the first board or two as boards: [{title, format, orientation, size?, html, mobile_html?}], then add "
          "the rest one at a time with design_add_board so the person watches the design build. " + FORMAT_HELP + " "
          "Each html is a fragment (no <html>/<head>) styled with var(--ds-...) tokens; no scripts. "
          "Use data-kd-goto=\"<board slug>\" on a button to link screens. Returns the design id and a link to include in your reply.",
          _object({"title": _str("Design title"),
                   "look": _str("The look from creative_direction (e.g. editorial, sport, retro-pixel; kairos only "
                                "when the person asked for Kairos's own look)"),
                   "brief": _str("The person's request, used to suggest looks when none is given"),
                    "design_system": _str("A saved design system id, instead of a look"),
                    "boards": {"type": "array", "description": "Starter boards, in order (at most 12; a website page counts as its desktop and mobile pair)",
                               "items": {"type": "object", "properties": {
                                   "title": {"type": "string"}, "format": _FORMAT, "orientation": _ORIENTATION,
                                   "size": _SIZE, "html": {"type": "string"},
                                   "mobile_html": _str("website only: the page's mobile (390 wide) HTML"),
                                   "w": {"type": "integer", "description": "format custom only"},
                                   "h": {"type": "integer", "description": "format custom only"}},
                                   "required": ["title", "format", "orientation"]}}},
                   ("title",)),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_create(args, ctx):
    key = _key(ctx)
    if not key:
        return "Not run: a design is created from a chat."
    owner = None
    if ctx.session_id:
        from core.session_manager import session_manager
        owner = (session_manager.get_session(ctx.session_id) or {}).get("owner_user")
    if owner is None:
        from core.auth import SINGLE_USER
        owner = SINGLE_USER
    system_id = args.get("look") or args.get("design_system") or design_systems.default_id()
    if not system_id:
        brief = str(args.get("brief") or args.get("title") or "")[:2000]
        first = next((b for b in args.get("boards") or [] if isinstance(b, dict)), {})
        # A board's format, or the old frame names (phone, slide...), says what is being made.
        kind = {"app": "screen", "phone": "screen", "tablet": "screen", "slide": "slides", "desktop": "website",
                "browser": "website"}.get(first.get("format") or first.get("frame"), first.get("format"))
        kind = kind if kind in creative_direction.KINDS else None
        return ("Not created yet: pick a look first. " + creative_direction.describe(brief, kind, owner=owner)
                + "\nThen call design_create again with the same boards and look=\"...\".")
    if not design_systems.visible(design_systems.get(system_id), owner, ctx.is_admin):
        looks = ", ".join(s["id"] for s in design_systems.list_systems(owner, ctx.is_admin))
        return f"Not run: no look or design system `{system_id}`. Looks and systems: {looks}."
    data, notes = design_store.create(args.get("title") or "", owner=owner, chat_key_=key, by=_by(ctx),
                                      design_system=system_id, boards=args.get("boards"),
                                      session_id=ctx.session_id)
    lint = []
    for slug, _ in design_store.ordered_boards(data):
        await _print_pages(data, slug)
        lint += [f"{slug}: {n}" for n in _lint(data, slug)]
    boards = "\n".join(f"- {slug}: \"{info['title']}\" ({_size_text(info)})"
                       for slug, info in design_store.ordered_boards(data))
    return (f"Created design {data['id']} \"{data['title']}\" (version {data['version']}, design system "
            f"{data['design_system']}).\nBoards:\n{boards}{_notes(notes + lint)}\n"
            f"Include this exact markdown link in your reply so the design opens as a card: {_link(data)}\n{NEXT_STEPS}")


@register("design_outline",
          "See a design: with no board, its boards (slug, title, frame, size) and open comments; with a board, "
          "an indented tree of its elements, one per line: `btn7 <button> \"Get started\"`. Use the ids with design_edit.",
          _object({"design_id": _ID, "board": _BOARD}), surfaces=ALL, effect=READ)
@_guard
async def _design_outline(args, ctx):
    data = _design(args, ctx)
    _taint(ctx)
    if not args.get("board"):
        system = design_systems.get(data.get("design_system")) or design_systems.builtin()
        lines = [f"Design {data['id']} \"{data['title']}\", version {data.get('version')}, system {system['name']} ({system['id']}).",
                 "Boards (in order):"]
        for n, (slug, info) in enumerate(design_store.ordered_boards(data), 1):
            count = len(design_html.index(design_html.parse(design_store.board_html(data["id"], slug))))
            lines.append(f"{n}. {slug}: \"{info['title']}\" {_size_text(info)}, {count} elements")
        open_comments = [c for c in design_store.comments(data["id"]) if c["status"] == "open"]
        if open_comments:
            lines.append(f"{len(open_comments)} open comment(s); design_comments lists them.")
        lines.append("Components to copy: " + ", ".join(
            node.get("data-kd-component") for node in design_html.parse(system.get("components") or "").elements()
            if node.get("data-kd-component")))
        return wrap_untrusted("design content", "\n".join(lines))
    slug = design_store.find_board(data, args["board"])
    root = design_html.parse(design_store.board_html(data["id"], slug))
    info = data["boards"][slug]
    head = f"Board {slug} \"{info['title']}\" ({_size_text(info)}), version {data.get('version')}:"
    return wrap_untrusted("design content", head + "\n" + design_html.outline(root))


@register("design_read",
          "Read a board's HTML with its data-kd ids (at most 40 KB), or one element's outer HTML with element=<id>.",
          _object({"design_id": _ID, "board": _BOARD, "element": _str("Optional element id")}, ("board",)),
          surfaces=ALL, effect=READ)
@_guard
async def _design_read(args, ctx):
    data = _design(args, ctx)
    slug = design_store.find_board(data, args["board"])
    text = design_store.board_html(data["id"], slug)
    _taint(ctx)
    if args.get("element"):
        root = design_html.parse(text)
        node = design_html.index(root).get(args["element"])
        if node is None:
            raise design_html.missing(root, args["element"], slug)
        text = design_html.serialize(node)
    if len(text.encode("utf-8")) > MAX_READ:
        text = text.encode("utf-8")[:MAX_READ].decode("utf-8", "ignore") + \
            "\n[Truncated at 40 KB: read one element with element=<id>, or use design_outline.]"
    return wrap_untrusted("design content", text)


@register("design_add_board",
          "Add one board to a design, laid out in its format's row. format and orientation as for design_create: "
          "website (a desktop and mobile pair, height grows), app, poster, slides, social, print, banner, email; "
          "custom w and h only for exact sizes the person gave. html is optional: without it the board starts empty "
          "with the system's base styles.",
          _object({"design_id": _ID, "title": _str("Board title"), "format": _FORMAT, "orientation": _ORIENTATION,
                   "size": _SIZE, "html": _str("Board HTML fragment, no scripts"),
                   "mobile_html": _str("website only: the page's mobile (390 wide) HTML"),
                   "after": _str("Optional board slug to place it after"),
                   "w": {"type": "integer", "description": "format custom only"},
                   "h": {"type": "integer", "description": "format custom only"}}, ("title", "format", "orientation")),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_add_board(args, ctx):
    data = _design(args, ctx)
    after = design_store.find_board(data, args["after"]) if args.get("after") else None

    specs = design_store.board_specs(args)

    def edit(draft, files):
        made = design_store.add_boards(draft, files, args.get("title"), specs, args.get("html"), after=after,
                                       mobile_html=args.get("mobile_html"))
        return made, "Added board " + ", ".join(draft["boards"][slug]["title"] for slug, _ in made)
    result = design_store.change(data["id"], edit, by=_by(ctx), tool="design_add_board", session_id=ctx.session_id)
    lines, notes = [], []
    for slug, more in result["result"]:
        info = result["manifest"]["boards"][slug]
        lines.append(f"{slug} \"{info['title']}\" ({_size_text(info)})")
        await _print_pages(result["manifest"], slug)
        notes += [f"{slug}: {n}" for n in more + _lint(result["manifest"], slug)]
    return f"Added board {' and '.join(lines)} as version {result['version']}.{_notes(notes)}"


@register("design_edit",
          "The core editing tool: apply up to 20 small operations to one board, atomically, as one version. "
          + _OPS_HELP + " Never rewrite a whole board to change part of it.",
          _object({"design_id": _ID, "board": _BOARD,
                   "ops": {"type": "array", "description": "Operations, applied in order",
                           "items": {"type": "object", "properties": {
                               "op": {"type": "string", "enum": list(design_html.OPS)},
                               "id": {"type": "string"}, "ref_id": {"type": "string"},
                               "text": {"type": "string"}, "name": {"type": "string"}, "value": {"type": "string"},
                               "style": {"type": "object"}, "html": {"type": "string"},
                               "position": {"type": "string", "enum": list(design_html.POSITIONS)},
                               "find": {"type": "string"}, "replace": {"type": "string"}},
                               "required": ["op"]}}}, ("board", "ops")),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_edit(args, ctx):
    data = _design(args, ctx)
    slug = design_store.find_board(data, args["board"])
    ops = args.get("ops")
    if isinstance(ops, dict):
        ops = [ops]
    if isinstance(ops, str):
        try:
            ops = json.loads(ops)
        except ValueError:
            raise ValueError("ops must be a JSON list of operations.") from None
        ops = [ops] if isinstance(ops, dict) else ops
    holder = {}

    def edit(draft, files):
        text, touched, notes = design_html.apply_ops(design_store.board_html(data["id"], slug), ops, slug)
        files[slug] = text
        holder.update(text=text, notes=notes, touched=touched)
        return touched, f"Edited {draft['boards'][slug]['title']}: " + ", ".join(
            f"{op.get('op')} {op.get('id') or op.get('ref_id') or ''}".strip() for op in ops[:6])
    result = design_store.change(data["id"], edit, by=_by(ctx), tool="design_edit", session_id=ctx.session_id)
    if result.get("unchanged"):
        return "Nothing changed: the operations left the board as it was."
    changed = result["changed"].get(slug, [])
    await _print_pages(result["manifest"], slug)
    lint = _lint(result["manifest"], slug, holder["text"])
    return (f"Version {result['version']}: changed {', '.join(changed) or 'the board'} on {slug}."
            f"{_notes(holder['notes'] + lint)}")


@register("design_boards",
          "Manage boards: action rename {board, title}, duplicate {board}, delete {board}, reorder {board, order "
          "(1 = first)}, move {board, x, y} (on the row layout this moves the board along its format's row), "
          "resize {board, w or h} (a fixed format keeps its ratio; a website or email board changes height only), "
          "fit_format {board, format?, size?, orientation?} puts a board made before formats into its nearest "
          "format (no board: every such board), note {text, x, y} adds a canvas label, delete_note {note_id}, "
          "rename_design {title}.",
          _object({"design_id": _ID,
                   "action": {"type": "string", "enum": ["rename", "duplicate", "delete", "reorder", "move", "resize",
                                                         "fit_format", "note", "delete_note", "rename_design"]},
                   "board": _BOARD, "title": _str(), "order": {"type": "integer"},
                   "x": {"type": "integer"}, "y": {"type": "integer"}, "w": {"type": "integer"}, "h": {"type": "integer"},
                   "format": _FORMAT, "size": _SIZE, "orientation": _ORIENTATION,
                   "text": _str("Note text"), "note_id": _str()},
                  ("action",)),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_boards(args, ctx):
    data = _design(args, ctx)
    result = board_action(data, args, by=_by(ctx), session_id=ctx.session_id, user_edit=False)
    return result


def board_action(data: dict, args: dict, *, by: str, session_id: Optional[str], user_edit: bool) -> str:
    """Shared by the tool and the canvas (whole-board drag and resize)."""
    action = args.get("action")
    needs_board = action in ("rename", "duplicate", "delete", "reorder", "move", "resize")
    slug = design_store.find_board(data, args.get("board") or "") if needs_board or (
        action == "fit_format" and args.get("board")) else None

    def edit(draft, files):
        boards = draft["boards"]
        if action == "rename":
            title = (args.get("title") or "").strip()[:80]
            if not title:
                raise ValueError("rename needs title.")
            boards[slug]["title"] = title
            return slug, f"Renamed {slug} to {title}"
        if action == "duplicate":
            spec = {k: boards[slug].get(k) for k in ("format", "size", "orientation", "frame", "w", "h", "min_h")}
            spec["grow"] = design_formats.grows(boards[slug])
            new, _ = design_store._add_board(draft, files, f"{boards[slug]['title']} copy", spec,
                                             design_store.board_html(data["id"], slug), after=slug)
            for key in ("content_h",):
                if boards[slug].get(key):
                    boards[new][key] = boards[slug][key]
            return new, f"Duplicated {slug} as {new}"
        if action == "delete":
            if len(boards) <= 1:
                raise ValueError("A design keeps at least one board.")
            del boards[slug]
            files[slug] = None
            design_store._renumber(draft)
            design_store.reflow(draft)
            return slug, f"Deleted board {slug}"
        if action == "reorder":
            order = args.get("order")
            if not isinstance(order, int) or order < 1:
                raise ValueError("reorder needs order: 1 for first.")
            ordered = [s for s, _ in design_store.ordered_boards(draft) if s != slug]
            ordered.insert(min(order - 1, len(ordered)), slug)
            for n, name in enumerate(ordered, 1):
                boards[name]["order"] = n
            design_store.reflow(draft)
            return slug, f"Moved {slug} to position {order}"
        if action == "move":
            x = design_store._int(args.get("x"), boards[slug]["x"], -100000, 100000)
            y = design_store._int(args.get("y"), boards[slug]["y"], -100000, 100000)
            if draft.get("layout") != "auto" and not args.get("reflow"):
                boards[slug]["x"], boards[slug]["y"] = x, y
                return slug, f"Moved {slug} on the canvas"
            # The row layout: a board moves along its format's row. Where it is
            # dropped picks its place among that row's boards; the rest reflow.
            draft["layout"] = "auto"
            key = design_formats.section_key(boards[slug])
            ordered = [s for s, _ in design_store.ordered_boards(draft)]
            row = [s for s in ordered if s != slug and design_formats.section_key(boards[s]) == key]
            centre = x + boards[slug]["w"] / 2
            before = next((s for s in row if centre < boards[s]["x"] + boards[s]["w"] / 2), None)
            rest = [s for s in ordered if s != slug]
            at = rest.index(before) if before else (rest.index(row[-1]) + 1 if row else len(rest))
            rest.insert(at, slug)
            for n, name in enumerate(rest, 1):
                boards[name]["order"] = n
            design_store.reflow(draft)
            return slug, f"Moved {slug} to place {rest.index(slug) + 1}"
        if action == "resize":
            if args.get("frame") and not (args.get("w") or args.get("h")):
                raise ValueError("resize takes w or h; to change a board's format use fit_format.")
            w, h, min_h = design_formats.resize(boards[slug], args.get("w"), args.get("h"))
            boards[slug].update(w=w, h=h)
            if min_h is not None:
                boards[slug]["min_h"] = min_h
            if draft.get("layout") == "auto" or args.get("reflow"):
                draft["layout"] = "auto"
                design_store.reflow(draft)
            return slug, f"Resized {slug} to {w}x{h}"
        if action == "fit_format":
            targets = [slug] if slug else [s for s, b in design_store.ordered_boards(draft) if not b.get("format")]
            if not targets:
                raise ValueError("Every board already has a format.")
            chosen = None
            if args.get("format"):
                chosen = design_store.board_specs(args)
                if len(chosen) > 1:
                    raise ValueError("Fit one board at a time to desktop or mobile: pass size desktop or mobile.")
                chosen = chosen[0]
            for name in targets:
                boards[name].update(design_formats.fit(boards[name], chosen))
            draft["layout"] = "auto"
            design_store.reflow(draft)
            return targets, ("Fitted " + ", ".join(f"{t} to {design_formats.label(boards[t])}" for t in targets[:6]))
        if action == "note":
            text = (args.get("text") or "").strip()[:300]
            if not text:
                raise ValueError("note needs text.")
            if len(draft["notes"]) >= design_store.MAX_NOTES:
                raise ValueError("A design holds at most 100 notes.")
            import secrets
            note = {"id": secrets.token_hex(3), "text": text, "x": design_store._int(args.get("x"), 0, -100000, 100000),
                    "y": design_store._int(args.get("y"), -200, -100000, 100000), "kind": "label"}
            draft["notes"].append(note)
            return note["id"], "Added a canvas note"
        if action == "delete_note":
            before = len(draft["notes"])
            draft["notes"] = [n for n in draft["notes"] if n.get("id") != args.get("note_id")]
            if len(draft["notes"]) == before:
                raise LookupError(f"No note `{args.get('note_id')}`.")
            return args.get("note_id"), "Deleted a canvas note"
        if action == "rename_design":
            title = (args.get("title") or "").strip()[:120]
            if not title:
                raise ValueError("rename_design needs title.")
            draft["title"] = title
            return title, f"Renamed the design to {title}"
        raise ValueError("action is one of rename, duplicate, delete, reorder, move, resize, note, delete_note, rename_design.")
    result = design_store.change(data["id"], edit, by=by, tool="design_boards", session_id=session_id, user_edit=user_edit)
    if result.get("unchanged"):
        return "Nothing changed."
    return f"Version {result['version']}: {result['summary']}."


@register("design_tokens",
          "Read the design's tokens (the --ds-* variables boards use), or change some for this design with set "
          "{\"--ds-accent\": \"#...\"}, switch the whole design to another look or system with system=<id>, or "
          "clear=true to drop this design's changes. Every board restyles at once. Keep the chosen look's tokens unless "
          "the person asks for a different palette; for a new direction switch looks instead.",
          _object({"design_id": _ID, "set": {"type": "object", "description": "Token values to change"},
                   "system": _str("Switch to this look or design system id"), "clear": {"type": "boolean"}}),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_tokens(args, ctx):
    data = _design(args, ctx)
    owner = _owner(ctx)
    if not args.get("set") and not args.get("system") and not args.get("clear"):
        _taint(ctx)
        system = design_systems.get(data.get("design_system")) or design_systems.builtin()
        others = ", ".join(s["id"] for s in design_systems.list_systems(owner, ctx.is_admin))
        return design_systems.describe_tokens(system, data.get("token_overrides")) + f"\n\nSystems: {others}"
    if args.get("system") and not design_systems.visible(design_systems.get(args["system"]), owner, ctx.is_admin):
        return f"Not run: no look or design system `{args['system']}`."
    return tokens_change(data, args, by=_by(ctx), session_id=ctx.session_id, user_edit=False)


def _owner(ctx: ToolContext) -> str:
    """The person a chat belongs to (whose styles it may use)."""
    if ctx.session_id:
        from core.session_manager import session_manager
        owner = (session_manager.get_session(ctx.session_id) or {}).get("owner_user")
        if owner:
            return owner
    from core.auth import SINGLE_USER
    return SINGLE_USER


def _chat_references(session_id: Optional[str], wanted: list) -> tuple[list[tuple], list[str]]:
    """The person's own attachments in this chat, by file name (or id), newest first. Never a path:
    a reference resolves only to a file attached to this chat (core/attachments.py staging)."""
    from core import attachments
    from core.session_manager import session_manager
    session = session_manager.get_session(session_id) if session_id else None
    if not session:
        return [], ["References come from files attached to this chat."]
    attached = [a for m in reversed(session.get("messages") or []) if m.get("role") == "user"
                for a in (m.get("attachments") or []) if isinstance(a, dict) and a.get("id")]
    found, missing = [], []
    for want in [str(w) for w in (wanted or [])][:8] or [a["filename"] for a in attached[:8]]:
        name = want.replace("\\", "/").rsplit("/", 1)[-1]
        match = next((a for a in attached if a["id"] == want or a.get("filename") == name), None)
        info = attachments.staged_file_info(match["id"]) if match else None
        if info:
            found.append((Path(info[0]), match.get("filename") or info[1]))
        else:
            missing.append(want[:60])
    notes = [f"Not attached to this chat: {', '.join(missing)}. Attached files: "
             + (", ".join(a.get("filename", "?") for a in attached[:12]) or "none")] if missing else []
    return found, notes


@register("design_style_from_references",
          "Make a design style (a look like the bundled ones) from photos, screenshots, a PDF, a PowerPoint or a Word "
          "file the person attached to this chat. First call with name and references (the attachments' file names; "
          "leave it out to use the latest ones): Kairos reads them locally and returns a draft with every colour role, "
          "the fonts (bundled families only) and what it repaired for contrast. Adjust with draft + adjust {colors: "
          "{role: '#RRGGBB'}, fonts: {display, body}, shape: {button, radius}}. Save with draft + save=true: it asks the "
          "person, then the style is theirs (private until an admin shares it) and usable as design_create look=<id>.",
          _object({"name": _str("The style's name, e.g. Bakery menus"),
                   "references": {"type": "array", "items": {"type": "string"},
                                  "description": "File names of this chat's attachments (up to 8)"},
                   "notes": _str("A line of intent from the person, e.g. warm, for our menus"),
                   "draft": _str("A draft id from an earlier call, to adjust or save"),
                   "adjust": {"type": "object", "description": "{colors: {role: '#RRGGBB'}, fonts: {display, body}, shape: {button, radius}, name}"},
                   "save": {"type": "boolean", "description": "Save the draft (asks the person first)"}}),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_style_from_references(args, ctx):
    from core import design_references, design_render, permissions
    owner = _owner(ctx)
    if args.get("draft"):
        record = design_references.load_draft(str(args["draft"]), owner)
        if args.get("adjust"):
            adjust = args["adjust"] if isinstance(args["adjust"], dict) else {}
            look, notes = design_references.adjust(record["look"], colors=adjust.get("colors"), fonts=adjust.get("fonts"),
                                                   shape=adjust.get("shape"), name=adjust.get("name"))
            record = design_references.save_draft({"look": look, "changes": record["changes"] + notes,
                                                   "sources": record["sources"]}, owner, record["id"])
        if not args.get("save"):
            return design_references.describe(record) + f"\nPreview: {_style_preview(record['id'])}"
        tainted = bool(ctx.turn_taint and ctx.turn_taint.tainted)
        decision = await permissions.decide(
            surface=ctx.permission_surface, tool="design_style_from_references",
            arguments={"name": record["look"]["name"], "sources": record["sources"]},
            title=f"Save style {record['look']['name'][:40]}",
            description="A style made from your references: only you can use it until an admin shares it. "
                        "The reference files are not kept.",
            is_admin=ctx.is_admin, force_prompt=True)
        if decision.behavior != "allow":
            return f"Not saved: {decision.reason or 'the style was not approved'}"
        system = design_systems.save_style(record["look"], owner=owner, sources=record["sources"])
        design_references.drop_draft(record["id"])
        return (f"Saved style {system['id']} \"{system['name']}\" (private to its owner until an admin shares it). "
                f"Use it with design_create look=\"{system['id']}\", or switch a design with design_tokens system={system['id']}.")
    files, notes = _chat_references(ctx.session_id, args.get("references") or [])
    if not files:
        return "Not run: " + (" ".join(notes) or "attach a photo, screenshot, PDF, PowerPoint or Word file first.")
    evidence, skipped = [], []
    for path, name in files:
        try:
            evidence.append(design_references.read(path, name))
        except design_references.ReferenceError as error:
            skipped.append(f"{name}: {error}")
    if ctx.turn_taint:
        ctx.turn_taint.mark("reference content")
    if not evidence:
        return "Not run: none of the references could be read (" + "; ".join(skipped) + ")."
    record = design_references.save_draft(design_references.draft(evidence, args.get("name") or "", args.get("notes") or ""), owner)
    extra = ("\nSkipped: " + "; ".join(skipped)) if skipped else ""
    extra += ("\n" + " ".join(notes)) if notes else ""
    return (design_references.describe(record) + extra + f"\nPreview: {_style_preview(record['id'])}\n"
            "Next: adjust with draft + adjust if the person wants changes, then save with draft + save=true.")


def _style_preview(system_id: str) -> str:
    from core import design_render
    return f"/api/design-looks/{system_id}/preview?rt={design_render.sign(system_id, 'style-preview', 3600)}"


def tokens_change(data: dict, args: dict, *, by: str, session_id: Optional[str], user_edit: bool) -> str:
    def edit(draft, files):
        if args.get("system"):
            if design_systems.get(args["system"]) is None:
                raise LookupError(f"No design system `{args['system']}`. Systems: "
                                  + ", ".join(s["id"] for s in design_systems.list_systems()))
            draft["design_system"] = args["system"]
            draft["token_overrides"] = {}
        if args.get("clear"):
            draft["token_overrides"] = {}
        values = args.get("set") or {}
        if not isinstance(values, dict):
            raise ValueError("set is an object of token names and values.")
        system = design_systems.get(draft.get("design_system")) or design_systems.builtin()
        known = design_systems.variables(system["tokens"])
        for name, value in values.items():
            name = name if str(name).startswith("--ds-") else f"--ds-{name}"
            if name not in known:
                raise LookupError(f"No token {name}. Tokens: {', '.join(list(known)[:30])}.")
            if not design_systems._safe_value(str(value)):
                raise ValueError(f"{name}: a plain CSS value without ; {{ }} < > or url().")
            draft.setdefault("token_overrides", {})[name] = str(value)
        return None, ("Switched to " + system["name"]) if args.get("system") else "Changed tokens: " + ", ".join(values) if values else "Cleared token changes"
    result = design_store.change(data["id"], edit, by=by, tool="design_tokens", session_id=session_id, user_edit=user_edit)
    if result.get("unchanged"):
        return "Nothing changed."
    text = f"Version {result['version']}: {result['summary']}. Every board uses the new values."
    changed = len(args.get("set") or {})
    if not user_edit and changed > BRAND_OVERRIDES:
        # Guidance, not a block (2026-10-22): a model restyling a whole look unasked loses what made it coherent.
        text += (f"\nNote: this overrode {changed} of the look's tokens. Keep the chosen look unless the person asked "
                 "for a different palette; to change direction, switch looks with design_tokens system=<look>. "
                 "design_tokens clear=true puts the look back.")
    return text


@register("design_snapshot",
          "See one board: a PNG for models that read images, plus the board's outline as text for those that do not.",
          _object({"design_id": _ID, "board": _BOARD}, ("board",)), surfaces=ALL, effect=READ)
@_guard
async def _design_snapshot(args, ctx):
    from core import design_render_bridge
    data = _design(args, ctx)
    slug = design_store.find_board(data, args["board"])
    _taint(ctx)
    outline = design_html.outline(design_html.parse(design_store.board_html(data["id"], slug)))
    text = wrap_untrusted("design content", f"Board {slug} outline:\n{outline}")
    try:
        png = await design_render_bridge.render(data["id"], slug, "png")
    except design_render_bridge.Unavailable as error:
        return f"{text}\n\nNo image: {error}"
    except Exception as error:
        return f"{text}\n\nNo image: the board could not be rendered ({error})."
    return ToolResult(f"Design snapshot of {slug} (image attached).\n{text}", [png], image_fallback="")


@register("design_comments",
          "The user's comments pinned on a design: action list (open ones, with board and element ids), or "
          "address {comment_id, note} after you changed what it asked, resolve or reopen {comment_id}.",
          _object({"design_id": _ID, "action": {"type": "string", "enum": ["list", "address", "resolve", "reopen"]},
                   "comment_id": _str(), "note": _str("Short note on what you changed")}, ("action",)),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_comments(args, ctx):
    data = _design(args, ctx)
    action = args.get("action")
    if action == "list":
        _taint(ctx)
        items = [c for c in design_store.comments(data["id"]) if c["status"] == "open"]
        if not items:
            return "No open comments."
        lines = [f"{c['id']} on {c['board']}" + (f" elements {', '.join(c['element_ids'])}" if c["element_ids"] else
                                                 f" at {round(c['point']['x'] * 100)}% across, {round(c['point']['y'] * 100)}% down")
                 + f" (made on v{c['made_on_version']}): {c['text']}" for c in items]
        return wrap_untrusted("design comments", "\n".join(lines))
    if not args.get("comment_id"):
        raise ValueError(f"{action} needs comment_id (from action list).")
    status = {"address": "addressed", "resolve": "resolved", "reopen": "open"}.get(action)
    if status is None:
        raise ValueError("action is list, address, resolve or reopen.")
    item = design_store.update_comment(data["id"], args["comment_id"], status=status, note=args.get("note"))
    return f"Comment {item['id']} is {item['status']}."


@register("design_export",
          "Export a design as a file for this chat: format html (a zip that opens offline), png, pdf (a document "
          "board keeps all its pages), pptx (editable: slides, posters and other fixed-size boards become real PowerPoint text, shapes, pictures and "
          "charts; pptx_mode pictures for exact picture slides) or docx (Word, document boards only). fonts office "
          "(default: fonts every Office has, close to the look) or design (the look's own fonts, for people who have "
          "them). Optional boards limits it to some boards. Returns a download link to include in your reply.",
          _object({"design_id": _ID, "format": {"type": "string", "enum": ["html", "png", "pdf", "pptx", "docx"]},
                   "boards": {"type": "array", "items": {"type": "string"}},
                   "pptx_mode": {"type": "string", "enum": ["editable", "pictures"]},
                   "fonts": {"type": "string", "enum": ["office", "design"]}}, ("format",)),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_export(args, ctx):
    from core import design_export, design_render_bridge
    data = _design(args, ctx)
    try:
        filename, raw, notes = await design_export.export(data["id"], args.get("format"), args.get("boards"),
                                                          pptx_mode=args.get("pptx_mode") or "editable",
                                                          fonts=args.get("fonts") or "office")
    except design_render_bridge.Unavailable as error:
        return f"Not run: {error}"
    published = design_export.publish(filename, raw)
    if ctx.session_id:
        from core.session_manager import session_manager
        session_manager.register_artifact(ctx.session_id, published["url"])
    return (f"Exported {filename}. Include this exact markdown link in your reply so it renders as a download: "
            f"[{filename}]({published['url']})" + _notes(notes))


@register("design_system_save",
          "Admin only: save a design system for future designs, from tokens (color roles bg, surface, text, text-dim, "
          "accent, accent-text, danger, success; font sans, serif) such as ui_design design_system proposes. Asks first.",
          _object({"name": _str("System name"), "tokens": {"type": "object", "description": "{color: {role: value}, font: {sans, serif}}"},
                   "guide": _str("A few lines of intent, do and don't")}, ("name", "tokens")),
          surfaces=ALL, admin_only=True, effect=WRITE)
@_guard
async def _design_system_save(args, ctx):
    from core import permissions
    if not ctx.is_admin:
        return "Not run: design systems are saved by an admin."
    tainted = bool(ctx.turn_taint and ctx.turn_taint.tainted)
    decision = await permissions.decide(
        surface=ctx.permission_surface, tool="design_system_save",
        arguments={"name": args.get("name"), "tokens": args.get("tokens")},
        title=f"Save design system {str(args.get('name'))[:40]}",
        description=(f"This turn read {ctx.turn_taint.reason}.\n" if tainted else "")
        + "A saved design system is offered to every future design.",
        is_admin=ctx.is_admin, force_prompt=tainted)
    if decision.behavior != "allow":
        return f"Not saved: {decision.reason or 'the design system was not approved'}"
    system = design_systems.save(args.get("name"), args.get("tokens"), args.get("guide") or "",
                                 created_by=_by(ctx), source="design_system_save")
    return f"Saved design system {system['id']} \"{system['name']}\". Use it with design_create design_system={system['id']} or design_tokens system={system['id']}."

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
from typing import Optional

from core import design_html, design_store, design_systems
from core.tool_registry import (ALL, CLAUDE, CODEX, OPENAI, READ, WRITE, ToolContext, ToolResult, _object, _str,
                                register)
from core.untrusted import wrap_untrusted

BRAND_OVERRIDES = 3  # More token overrides than this in one call get a note.
LINKED_TOOLS = frozenset({"design_outline", "design_read", "design_add_board", "design_edit", "design_boards",
                          "design_tokens", "design_snapshot", "design_comments", "design_export"})
MAX_READ = 40 * 1024
SKILL_HINT = "Read the design-canvas skill first (read_skill design-canvas)."
FRAMES = list(design_store.FRAMES)

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


def _notes(notes: list[str]) -> str:
    return ("\nNotes:\n" + "\n".join(f"- {n}" for n in notes[:12])) if notes else ""


def _tokens(data: dict) -> dict[str, str]:
    system = design_systems.get(data.get("design_system")) or design_systems.builtin()
    return design_systems.variables(system["tokens"], data.get("token_overrides"))


def _lint(data: dict, slug: str, text: Optional[str] = None) -> list[str]:
    root = design_html.parse(text if text is not None else design_store.board_html(data["id"], slug))
    return design_html.lint(root, _tokens(data))


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


@register("design_create",
          "Design screens, app UI, a mockup or wireframe, an onboarding flow, a landing page or slides on Kairos's Design "
          "canvas: create a design (HTML boards in a design system) linked to this chat. " + SKILL_HINT + " "
          "Pass the screens as boards: [{title, frame, html}], frame one of phone, tablet, desktop, browser, slide, none. "
          "Each html is a fragment (no <html>/<head>) styled with var(--ds-...) tokens; no scripts. "
          "Use data-kd-goto=\"<board slug>\" on a button to link screens. Returns the design id and a link to include in your reply.",
          _object({"title": _str("Design title"),
                    "design_system": _str("Design system id (default kairos)"),
                    "boards": {"type": "array", "description": "Starter boards, in order (at most 12)",
                               "items": {"type": "object", "properties": {
                                   "title": {"type": "string"}, "frame": {"type": "string", "enum": FRAMES},
                                   "html": {"type": "string"}, "w": {"type": "integer"}, "h": {"type": "integer"}},
                                   "required": ["title"]}}},
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
    data, notes = design_store.create(args.get("title") or "", owner=owner, chat_key_=key, by=_by(ctx),
                                      design_system=args.get("design_system"), boards=args.get("boards"))
    lint = []
    for slug, _ in design_store.ordered_boards(data):
        lint += [f"{slug}: {n}" for n in _lint(data, slug)]
    boards = "\n".join(f"- {slug}: \"{info['title']}\" ({info['frame']} {info['w']}x{info['h']})"
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
            lines.append(f"{n}. {slug}: \"{info['title']}\" {info['frame']} {info['w']}x{info['h']}, {count} elements")
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
    head = f"Board {slug} \"{info['title']}\" ({info['frame']} {info['w']}x{info['h']}), version {data.get('version')}:"
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
          "Add one board to a design, placed in the next free slot. frame: phone, tablet, desktop, browser, slide "
          "or none (custom w, h). html is optional: without it the board starts empty with the system's base styles.",
          _object({"design_id": _ID, "title": _str("Board title"),
                   "frame": {"type": "string", "enum": FRAMES}, "html": _str("Board HTML fragment, no scripts"),
                   "after": _str("Optional board slug to place it after"),
                   "w": {"type": "integer"}, "h": {"type": "integer"}}, ("title", "frame")),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_add_board(args, ctx):
    data = _design(args, ctx)
    after = design_store.find_board(data, args["after"]) if args.get("after") else None

    def edit(draft, files):
        slug, notes = design_store._add_board(draft, files, args.get("title"), args.get("frame") or "phone",
                                              args.get("html"), after=after, w=args.get("w"), h=args.get("h"))
        return (slug, notes), f"Added board {draft['boards'][slug]['title']}"
    result = design_store.change(data["id"], edit, by=_by(ctx), tool="design_add_board", session_id=ctx.session_id)
    slug, notes = result["result"]
    info = result["manifest"]["boards"][slug]
    return (f"Added board {slug} \"{info['title']}\" ({info['frame']} {info['w']}x{info['h']}) as version "
            f"{result['version']}.{_notes(notes + _lint(result['manifest'], slug))}")


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
    lint = _lint(result["manifest"], slug, holder["text"])
    return (f"Version {result['version']}: changed {', '.join(changed) or 'the board'} on {slug}."
            f"{_notes(holder['notes'] + lint)}")


@register("design_boards",
          "Manage boards: action rename {board, title}, duplicate {board}, delete {board}, reorder {board, order "
          "(1 = first)}, move {board, x, y}, resize {board, frame or w, h}, note {text, x, y} adds a canvas label, "
          "delete_note {note_id}, rename_design {title}.",
          _object({"design_id": _ID,
                   "action": {"type": "string", "enum": ["rename", "duplicate", "delete", "reorder", "move", "resize",
                                                         "note", "delete_note", "rename_design"]},
                   "board": _BOARD, "title": _str(), "order": {"type": "integer"},
                   "x": {"type": "integer"}, "y": {"type": "integer"}, "w": {"type": "integer"}, "h": {"type": "integer"},
                   "frame": {"type": "string", "enum": FRAMES}, "text": _str("Note text"), "note_id": _str()},
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
    slug = design_store.find_board(data, args.get("board") or "") if needs_board else None

    def edit(draft, files):
        boards = draft["boards"]
        if action == "rename":
            title = (args.get("title") or "").strip()[:80]
            if not title:
                raise ValueError("rename needs title.")
            boards[slug]["title"] = title
            return slug, f"Renamed {slug} to {title}"
        if action == "duplicate":
            new, _ = design_store._add_board(draft, files, f"{boards[slug]['title']} copy", boards[slug]["frame"],
                                             design_store.board_html(data["id"], slug), after=slug,
                                             w=boards[slug]["w"], h=boards[slug]["h"])
            return new, f"Duplicated {slug} as {new}"
        if action == "delete":
            if len(boards) <= 1:
                raise ValueError("A design keeps at least one board.")
            del boards[slug]
            files[slug] = None
            design_store._renumber(draft)
            return slug, f"Deleted board {slug}"
        if action == "reorder":
            order = args.get("order")
            if not isinstance(order, int) or order < 1:
                raise ValueError("reorder needs order: 1 for first.")
            ordered = [s for s, _ in design_store.ordered_boards(draft) if s != slug]
            ordered.insert(min(order - 1, len(ordered)), slug)
            for n, name in enumerate(ordered, 1):
                boards[name]["order"] = n
            return slug, f"Moved {slug} to position {order}"
        if action == "move":
            boards[slug]["x"] = design_store._int(args.get("x"), boards[slug]["x"], -100000, 100000)
            boards[slug]["y"] = design_store._int(args.get("y"), boards[slug]["y"], -100000, 100000)
            return slug, f"Moved {slug} on the canvas"
        if action == "resize":
            frame = args.get("frame") or boards[slug]["frame"]
            if frame not in design_store.FRAMES:
                raise ValueError(f"frame must be one of {', '.join(design_store.FRAMES)}.")
            if args.get("w") or args.get("h"):
                # A custom size keeps the board's frame (its device chrome).
                w = design_store._int(args.get("w"), boards[slug]["w"], 120, 4000)
                h = design_store._int(args.get("h"), boards[slug]["h"], 120, 8000)
            else:
                w, h = design_store.frame_size(frame)
            boards[slug].update(frame=frame, w=w, h=h)
            return slug, f"Resized {slug} to {w}x{h}"
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
          "{\"--ds-accent\": \"#...\"}, switch the whole design to another system with system=<id>, or clear=true "
          "to drop this design's changes. Every board restyles at once. Keep the design system's tokens unless the "
          "person asks for a different look or palette.",
          _object({"design_id": _ID, "set": {"type": "object", "description": "Token values to change"},
                   "system": _str("Switch to this design system id"), "clear": {"type": "boolean"}}),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_tokens(args, ctx):
    data = _design(args, ctx)
    if not args.get("set") and not args.get("system") and not args.get("clear"):
        _taint(ctx)
        system = design_systems.get(data.get("design_system")) or design_systems.builtin()
        others = ", ".join(s["id"] for s in design_systems.list_systems())
        return design_systems.describe_tokens(system, data.get("token_overrides")) + f"\n\nSystems: {others}"
    return tokens_change(data, args, by=_by(ctx), session_id=ctx.session_id, user_edit=False)


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
        # Guidance, not a block (2026-10-22): a model restyling a whole system unasked loses the brand.
        text += (f"\nNote: this overrode {changed} of the design system's tokens. Keep the system's look unless the "
                 "person asked for a different look or palette; design_tokens clear=true puts it back.")
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
          "Export a design as a file for this chat: format html (a zip that opens offline), png, pdf or pptx "
          "(picture slides). Optional boards limits it to some boards. Returns a download link to include in your reply.",
          _object({"design_id": _ID, "format": {"type": "string", "enum": ["html", "png", "pdf", "pptx"]},
                   "boards": {"type": "array", "items": {"type": "string"}}}, ("format",)),
          surfaces=ALL, effect=WRITE)
@_guard
async def _design_export(args, ctx):
    from core import design_export, design_render_bridge
    data = _design(args, ctx)
    try:
        filename, raw = await design_export.export(data["id"], args.get("format"), args.get("boards"))
    except design_render_bridge.Unavailable as error:
        return f"Not run: {error}"
    published = design_export.publish(filename, raw)
    if ctx.session_id:
        from core.session_manager import session_manager
        session_manager.register_artifact(ctx.session_id, published["url"])
    return (f"Exported {filename}. Include this exact markdown link in your reply so it renders as a download: "
            f"[{filename}]({published['url']})")


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

"""The `design_comment` reference: selected or pinned design elements, sent to
the design's chat as a precise edit request (spec 3f, decision 5).

Like artifact_comment (core/artifact_comments.py), the client sends only ids;
the server re-reads each element's current outer HTML, caps it and fences it
with wrap_untrusted. Only the user's own words sit outside the fence, with
the design, board and element ids the model needs for design_edit.
"""
from __future__ import annotations

import re

from core import design_html, design_store
from core.untrusted import wrap_untrusted

MAX_COMMENTS = 10
MAX_EXCERPT = 4000
EDIT_INSTRUCTION = ("To make these changes, use design_edit on the listed element ids (one call per board, several "
                    "operations at once). Do not rewrite the board or recreate the design. When a pinned comment is "
                    "done, design_comments address it with a short note.")


def validate(reference: dict) -> dict:
    design_id, board, comment = (reference.get(k) for k in ("design_id", "board", "comment"))
    ids = reference.get("element_ids") or []
    point = reference.get("point")
    if (not isinstance(design_id, str) or not design_store.DESIGN_ID.fullmatch(design_id)
            or not isinstance(board, str) or not design_store.SLUG.fullmatch(board)
            or not isinstance(comment, str) or len(comment) > 4000
            or not isinstance(ids, list) or len(ids) > 20
            or any(not isinstance(i, str) or not design_html.ID_RE.fullmatch(i) for i in ids)):
        raise ValueError("Invalid design comment")
    if point is not None:
        try:
            point = {"x": max(0.0, min(1.0, float(point["x"]))), "y": max(0.0, min(1.0, float(point["y"])))}
        except (TypeError, KeyError, ValueError):
            raise ValueError("Invalid design comment point") from None
    if not ids and point is None:
        raise ValueError("A design comment needs elements or a point")
    comment_id = reference.get("comment_id")
    if comment_id is not None and (not isinstance(comment_id, str) or not re.fullmatch(r"[a-f0-9]{8}", comment_id)):
        raise ValueError("Invalid design comment id")
    label = reference.get("label") if isinstance(reference.get("label"), str) else "Design comment"
    return {"kind": "design_comment", "design_id": design_id, "board": board, "element_ids": list(ids),
            "point": point, "comment": comment.strip(), "comment_id": comment_id, "label": label[:500]}


def _label(text: str) -> str:
    text = " ".join(re.sub(r'[\x00-\x1f\x7f"`]+', " ", str(text)).split())
    return text[:60] + ("..." if len(text) > 60 else "")


def resolve(session_id: str, reference: dict) -> str:
    ref = validate(reference)
    try:
        data = design_store.require_chat_access(ref["design_id"], session_id)
        if ref["board"] not in data.get("boards", {}):
            raise LookupError("board")
        root = design_html.parse(design_store.board_html(ref["design_id"], ref["board"]))
    except (LookupError, design_store.AccessError) as error:
        raise ValueError("A design comment is no longer available: its design, board or chat link changed.") from error
    nodes = design_html.index(root)
    found = [i for i in ref["element_ids"] if i in nodes]
    gone = [i for i in ref["element_ids"] if i not in nodes]
    where = []
    if found:
        where.append("element" + ("s " if len(found) > 1 else " ") + ", ".join(found))
    if ref["point"]:
        where.append(f"the point {round(ref['point']['x'] * 100)}% across and {round(ref['point']['y'] * 100)}% down")
    board_title = _label(data["boards"][ref["board"]].get("title") or ref["board"])
    place = (f"{' and '.join(where) or 'the board'} of board {ref['board']} (\"{board_title}\") in design "
             f"{ref['design_id']} (\"{_label(data.get('title') or 'Design')}\", version {data.get('version')})")
    sentence = (f"The user commented on {place}: {ref['comment']}" if ref["comment"] else
                f"The user selected {place}. Their message says what to change.")
    if gone:
        sentence += f"\n(No longer on the board: {', '.join(gone)}.)"
    if ref.get("comment_id"):
        sentence += f"\nPinned comment id: {ref['comment_id']}."
    excerpts, remaining = [], MAX_EXCERPT
    for kd in found:
        text = design_html.serialize(nodes[kd])[:remaining]
        excerpts.append(text)
        remaining -= len(text)
        if remaining <= 0:
            break
    if not excerpts:
        excerpts.append(design_html.outline(root, 1500))
    return sentence + "\n\n" + wrap_untrusted("selected design content", "\n\n".join(excerpts)[:MAX_EXCERPT])


DESIGN_MODE_FIRST = (
    "\n\n[Design mode] This chat designs on Kairos's Design canvas. Before designing, read the design-canvas skill "
    "(read_skill design-canvas). Pick the format from the request (website pairs, app, poster, slides, social, document, "
    "print, banner, email), create the design with design_create and its first board, add the rest one at a time "
    "with design_add_board, then change it with design_edit by element id. Include the design link the tool "
    "returns in your reply.")


LINKED_MAX = 5


def _label(text) -> str:
    """A title as a short single line; it came from a model or a person, so it carries no instructions' shape."""
    return re.sub(r"[\s\"`]+", " ", str(text or "Untitled")).strip()[:80] or "Untitled"


def linked_work_context(session_id: str) -> str:
    """On later turns, name the videos and designs this chat already owns, so a follow-up such as "now add
    Kip" changes that video in place instead of building a separate one with the shell (David, 2026-11-04)."""
    if not session_id:
        return ""
    from core import video_store
    from core.session_manager import session_manager
    session = session_manager.get_session(session_id) or {}
    if not any(m.get("role") == "assistant" for m in session.get("messages", [])):
        return ""
    recent = lambda rows: sorted(rows, key=lambda r: r.get("updated") or r.get("created") or 0, reverse=True)[:LINKED_MAX]
    videos = recent(video_store.videos_for_chat(session_id))
    designs = recent(design_store.designs_for_chat(session_id))
    if not videos and not designs:
        return ""
    items = [f'video {v["id"]} "{_label(v.get("title"))}" (version {v.get("version", 1)})' for v in videos]
    items += [f'design {d["id"]} "{_label(d.get("title"))}"' for d in designs]
    tools = []
    if videos:
        tools.append("for a video, video_outline, then video_edit or video_add_image, video_preview and video_render")
    if designs:
        tools.append("for a design, design_edit or design_add_board")
    return ("\n\n[Linked work] This chat already has: " + "; ".join(items) + ". When the user asks to change, extend "
            "or redo it, change that one in place (" + "; ".join(tools) + "), passing its id. Do not build a separate "
            "video or design with the shell, scripts or files, and make a new one only when the user asks for a new one.")


def design_mode_context(session_id: str) -> str:
    """Design mode's pinned instruction, on the chat's first message."""
    if not design_store.design_mode(session_id):
        return ""
    from core.session_manager import session_manager
    session = session_manager.get_session(session_id) or {}
    if any(m.get("role") == "assistant" for m in session.get("messages", [])):
        return ""
    return DESIGN_MODE_FIRST

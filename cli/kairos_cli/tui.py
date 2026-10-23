"""The full-screen Kairos terminal (vault spec, Amendment 2026-10-22).

Layout, after David's reference: a Projects tree on the left; session tabs
on top; a transcript whose turns have a header, a collapsible actions
summary and a quiet metrics line with Fork and Copy; a boxed composer with
model, effort and mode in its border; a status line (branch, tokens, cost,
plan, context); and a bottom bar (folder, date, time). The texture is ours:
Parchment and Night, braille halftone fields, dotted gold rules, dithered
bars, and Kip as the turn marker and working indicator.

The app runs on the alternate screen, so history scrolls inside it:
PgUp/PgDn and the mouse wheel scroll, ctrl+f searches, alt+c turns the
mouse off so the terminal can select and copy, and Copy under a reply puts
it on the clipboard.

Every number on screen is a backend field or measured here and labelled;
model.METRICS_SOURCES lists the sources and what the backend does not have.
"""
from __future__ import annotations

import asyncio
import base64
import datetime as dt
import io
import os
import shutil
import subprocess
import sys
import time

from prompt_toolkit.application import Application
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.data_structures import Point
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import ANSI, to_formatted_text
from prompt_toolkit.formatted_text.utils import split_lines
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import (ConditionalContainer, Dimension, Float, FloatContainer, HSplit, Layout, VSplit,
                                   Window)
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl, UIContent, UIControl
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.layout.processors import Processor, Transformation
from prompt_toolkit.mouse_events import MouseEventType
from prompt_toolkit.output.color_depth import ColorDepth
from prompt_toolkit.styles import Style as PtStyle
from prompt_toolkit.utils import get_cwidth
from rich.console import Console
from rich.text import Text

from . import chat, commands, forge, model, models, render, reveal, widgets
from .connection import Connection, KairosError, launch_app
from .live import LiveFeed, TurnEvent
from .mascot import Kip
from .model import NoteItem, ReplyItem, RichItem, SessionView, UserItem
from .palette import Palette
from .sanitize import clean, one_line

COLOR_SYSTEMS = {"truecolor": "truecolor", "256": "256", "16": "standard", "none": None}
PT_DEPTH = {"truecolor": ColorDepth.TRUE_COLOR, "256": ColorDepth.DEPTH_8_BIT, "16": ColorDepth.DEPTH_4_BIT,
            "none": ColorDepth.DEPTH_1_BIT}
SIDEBAR = 30
GUTTER = 4


def clock(ts: float | None) -> str:
    if not ts:
        return ""
    return dt.datetime.fromtimestamp(ts).strftime("%I:%M %p").lstrip("0")


def rich_lines(renderable, palette: Palette, width: int) -> list:
    """A Rich renderable as prompt_toolkit fragment lines."""
    console = Console(file=io.StringIO(), force_terminal=palette.depth != "none",
                      color_system=COLOR_SYSTEMS[palette.depth], width=max(10, width), theme=palette.theme(),
                      no_color=palette.depth == "none", legacy_windows=False, emoji=False, highlight=False,
                      markup=False)
    console.print(renderable)
    text = console.file.getvalue()
    if text.endswith("\n"):
        text = text[:-1]
    return [list(line) for line in split_lines(to_formatted_text(ANSI(text)))]


def pad(fragments: list, width: int, style: str = "") -> list:
    used = widgets.width_of(fragments)
    return fragments + ([(style, " " * (width - used))] if used < width else [])


def wrap(text: str, width: int) -> list[str]:
    out = []
    for paragraph in text.split("\n"):
        line = ""
        for word in paragraph.split(" "):
            while get_cwidth(word) > width:
                if line:
                    out.append(line)
                    line = ""
                out.append(word[:width])
                word = word[width:]
            candidate = f"{line} {word}" if line else word
            if get_cwidth(candidate) > width:
                out.append(line)
                line = word
            else:
                line = candidate
        out.append(line)
    return out


def chip_name(row: dict) -> str:
    """A file's name as the app shows it: a generated file without the
    random prefix its stored name carries (core/chat_artifacts.py)."""
    import re
    name = one_line(row.get("name"), 60)
    return re.sub(r"^[a-f0-9]{12}_", "", name) if row.get("origin") == "generated" else name


def osc8(target: str) -> str:
    """An OSC 8 hyperlink edge: the target, or empty to end the link."""
    return "\x1b]8;;" + target + "\x1b\\"


class Lines(UIControl):
    """A scrollable list of fragment lines with clickable regions, used for
    the transcript and the screens. Scrolling is counted in lines up from
    the bottom, so new output stays in view unless the person scrolled."""

    def __init__(self, app: "KairosApp"):
        self.app = app
        self.clicks: dict[int, list] = {}

    def is_focusable(self) -> bool:
        return False

    def create_content(self, width: int, height: int) -> UIContent:
        lines, clicks = self.app.main_lines(width, height)
        total = len(lines)
        view = self.app.view
        scroll = min(view.scroll, max(0, total - height)) if view else 0
        if view:
            view.scroll = scroll
        top = max(0, total - height - scroll)
        visible = lines[top: top + height]
        self.clicks = {row - top: regions for row, regions in clicks.items() if top <= row < top + height}
        self.app.scroll_info = (top, total, height)
        return UIContent(get_line=lambda i: visible[i], line_count=len(visible), show_cursor=False,
                         cursor_position=Point(0, 0))

    def mouse_handler(self, mouse_event):
        if mouse_event.event_type == MouseEventType.SCROLL_UP:
            self.app.scroll(3)
            return None
        if mouse_event.event_type == MouseEventType.SCROLL_DOWN:
            self.app.scroll(-3)
            return None
        if mouse_event.event_type == MouseEventType.MOUSE_UP:
            for start, end, action in self.clicks.get(mouse_event.position.y, []):
                if start <= mouse_event.position.x < end:
                    action()
                    return None
        return NotImplemented


class Placeholder(Processor):
    """The composer's hint, drawn inside the box while it is empty."""

    def __init__(self, app: "KairosApp"):
        self.app = app

    def apply_transformation(self, ti):
        if not ti.document.text and ti.lineno == 0:
            return Transformation(list(ti.fragments) + self.app.placeholder())
        return Transformation(ti.fragments)


class Composer(Completer):
    def __init__(self, app: "KairosApp"):
        self.app = app

    def get_completions(self, document, complete_event):
        if self.app.screen or self.app.mode != "chat":
            return
        text = document.text_before_cursor
        if text.startswith("/model ") or text.startswith("/effort "):
            command, _, typed = text.partition(" ")
            app = self.app
            if command == "/model":
                names = sorted({o.name for o in app.model_options() if o.model_id})
            else:
                option = app.current_option()
                names = [e["effort"] for e in option.efforts] if option else []
            for name in names:
                if name.casefold().startswith(typed.casefold()) or typed.casefold() in name.casefold():
                    yield Completion(name, start_position=-len(typed), display=name)
            return
        if text.startswith("/") and " " not in text:
            for name, args, about in commands.COMMANDS:
                if name.startswith(text[1:].lower()):
                    yield Completion("/" + name, start_position=-len(text), display=f"/{name} {args}".strip(),
                                     display_meta=about)
            return
        word = document.get_word_before_cursor(pattern=__import__("re").compile(r"@[^\s]*$"))
        if not word.startswith("@"):
            return
        needle, shown = word[1:].casefold(), 0
        if self.app.is_forge:
            for path in self.app.files:
                if needle in path.casefold():
                    yield Completion("@" + path, start_position=-len(word), display_meta="file")
                    shown += 1
                    if shown >= 40:
                        return
        for label, ref in self.app.references.items():
            if needle in label.casefold():
                yield Completion("@" + label, start_position=-len(word), display_meta=ref["kind"])


class KairosApp:
    def __init__(self, conn: Connection, palette: Palette, kip: Kip, *, motion: bool = True, instance: str = "",
                 open_app: bool = True, cwd: str | None = None):
        self.conn = conn
        self.palette = palette
        self.s = widgets.Styles(palette)
        self.kip = kip
        self.motion = motion
        self.instance = instance
        self.open_app = open_app
        self.cwd = cwd or os.getcwd()
        self.views: dict[str, SessionView] = {}
        self.tabs: list[str] = []
        self.active: str | None = None
        self.choices: list[dict] = []
        self.catalogs: dict[str, list[dict]] = {}
        self.sessions: list[dict] = []
        self.forge_projects: list[dict] = []
        self.forge_sessions: dict[str, list] = {}
        self.chat_projects: list[dict] = []
        self.collapsed: set = set()
        self.sidebar_mode = False
        self.sidebar_index = 0
        self.screen: str | None = None        # models | usage | picker | help
        self.screen_data: dict = {}
        self.mode = "chat"                    # chat | search
        self.copy_mode = False
        self.search_hit: int | None = None
        self.notice = ""
        self.notice_until = 0.0
        self.quotas: dict | None = None
        self.branch_cache: dict[str, tuple[float, str | None]] = {}
        self.references: dict[str, dict] = {}
        self.files: list[str] = []
        self.feed_state = "connecting"
        self.t0 = time.monotonic()
        self.scroll_info = (0, 0, 0)
        self.cache: dict = {}
        self.answered: set = set()
        self.file_mode = False
        self.file_index = 0
        self.feed = LiveFeed(conn, self.on_event, self.on_feed_state)
        self.buffer = Buffer(multiline=True, completer=Composer(self), complete_while_typing=True)
        self.lines = Lines(self)
        self.app: Application | None = None
        self.quit = False

    # -- state ---------------------------------------------------------------------

    def spawn(self, coroutine) -> asyncio.Future:
        """Run in the background, and say so when it fails instead of
        losing the error."""
        task = asyncio.ensure_future(coroutine)

        def done(future):
            if future.cancelled():
                return
            error = future.exception()
            if isinstance(error, KairosError):
                self.say(str(error), "danger")
            elif error is not None:
                self.say(f"Something went wrong: {type(error).__name__}: {one_line(str(error), 120)}", "danger", 15)
        task.add_done_callback(done)
        return task

    @property
    def view(self) -> SessionView | None:
        return self.views.get(self.active) if self.active else None

    @property
    def session(self) -> dict:
        return self.view.session if self.view else {}

    @property
    def is_forge(self) -> bool:
        return bool(self.session.get("forge"))

    @property
    def modal(self) -> dict | None:
        return self.view.__dict__.get("modal") if self.view else None

    def set_modal(self, view: SessionView, request: dict | None, note: str = "") -> None:
        view.__dict__["modal"] = request
        view.__dict__["modal_note"] = note

    def say(self, text: str, role: str = "meta", seconds: float = 6.0) -> None:
        self.notice, self.notice_role, self.notice_until = one_line(text, 200), role, time.monotonic() + seconds
        self.invalidate()

    def note(self, text: str, role: str = "meta") -> None:
        if self.view:
            self.view.add(NoteItem(one_line(text, 400), role))
            self.view.scroll = 0
        self.invalidate()

    def invalidate(self) -> None:
        if self.app and self.app.is_running:
            self.app.invalidate()

    def scroll(self, lines: int) -> None:
        if self.view:
            top, total, height = self.scroll_info
            self.view.scroll = max(0, min(max(0, total - height), self.view.scroll + lines))
            self.invalidate()

    @property
    def width(self) -> int:
        try:
            return self.app.output.get_size().columns if self.app else shutil.get_terminal_size().columns
        except Exception:
            return shutil.get_terminal_size().columns

    # -- the feed ------------------------------------------------------------------

    def on_feed_state(self, state: str) -> None:
        self.feed_state = state
        if state == "unauthorized":
            self.say("Kairos no longer accepts this terminal (revoked or expired). Run kairos again to pair.", "danger", 3600)
        self.invalidate()

    def on_event(self, event: TurnEvent) -> None:
        view = self.views.get(event.session_id)
        turn = event.turn
        if event.kind in ("started", "finished"):
            self.spawn(self.refresh_sidebar(delay=0.5))
        if view is None:
            self.invalidate()
            return
        reply = view.reply
        if event.kind == "started" or reply is None or reply.turn_id != turn.turn_id:
            if turn.status != "processing" and event.kind != "started":
                return
            if not view.__dict__.pop("own_pending", False):
                view.items.append(UserItem(clean(turn.prompt), time.time(), from_app=True))
            reply = ReplyItem(turn_id=turn.turn_id, ts=time.time())
            view.items.append(reply)
            if event.kind == "started":
                view.touch()
                self.invalidate()
                return
        if event.kind == "text":
            reply.feed(event.text)
        elif event.kind == "tool_step":
            step = event.value or {}
            if step.get("phase") == "started":
                reply.running[str(step.get("id"))] = step
            else:
                reply.running.pop(str(step.get("id")), None)
                reply.steps.append(step)
        elif event.kind == "tool_event":
            reply.events.append(event.value or {})
        elif event.kind == "permission":
            self.set_modal(view, event.value)
        elif event.kind == "permission_closed":
            request = event.value or {}
            if view.__dict__.get("modal") and view.__dict__["modal"].get("id") == request.get("id"):
                if request.get("id") not in self.answered:
                    reply.__dict__.setdefault("notes", []).append("Answered in the app.")
                self.set_modal(view, None)
        elif event.kind == "finished":
            reply.finish(turn.status, turn.error)
            self.set_modal(view, None)
            self.spawn(self.after_turn(view, reply))
        view.touch()
        self.invalidate()

    async def after_turn(self, view: SessionView, reply: ReplyItem) -> None:
        """Fill the reply's metrics from its recorded run, refresh the
        context reading, then send the next queued message, if any."""
        for _ in range(4):
            await asyncio.sleep(0.4)
            runs = await self.fetch_runs(view.id)
            run = model.match_run(reply.ended, runs) if runs else None
            if run:
                view.runs = runs
                reply.metrics = model.run_metrics(run)
                break
        await self.refresh_context(view)
        await self.attach_files(view, reply)
        view.touch()
        self.invalidate()
        if view.queued and not view.working:
            text = view.queued.pop(0)
            await self.send(text, view)

    async def fetch_runs(self, session_id: str) -> list[dict]:
        try:
            return await self.conn.get("/api/runs", params={"session_id": session_id, "limit": 200}) or []
        except KairosError:
            return []

    async def refresh_context(self, view: SessionView) -> None:
        try:
            view.context = await self.conn.get(f"/api/sessions/{view.id}/context")
        except KairosError:
            view.context = None

    async def refresh_quotas(self) -> None:
        try:
            self.quotas = await self.conn.get("/api/models/quotas")
        except KairosError:
            self.quotas = None

    async def refresh_sidebar(self, delay: float = 0.0) -> None:
        if delay:
            await asyncio.sleep(delay)
        try:
            self.sessions = await chat.list_sessions(self.conn)
        except KairosError:
            return
        try:
            self.forge_projects = await self.conn.get("/api/forge/projects") or []
            for project in self.forge_projects:
                self.forge_sessions[project["id"]] = await self.conn.get(f"/api/forge/projects/{project['id']}/sessions") or []
        except KairosError:
            self.forge_projects = []
        try:
            self.chat_projects = await self.conn.get("/api/projects") or []
        except KairosError:
            self.chat_projects = []
        self.invalidate()

    # -- opening sessions ----------------------------------------------------------------

    async def open_session(self, session_id: str, history: bool = True) -> None:
        if session_id not in self.views:
            session = await chat.open_session(self.conn, session_id)
            view = SessionView(session)
            runs = await self.fetch_runs(session_id)
            if history:
                view.load_history(session.get("messages") or [], runs)
            else:
                view.runs = runs
            await self.refresh_context(view)
            self.views[session_id] = view
            await self.attach_history_files(view)
            # A turn already running in this chat (started in the app).
            turn = self.feed.book.turns.get(session_id)
            if turn and turn.status == "processing":
                reply = ReplyItem(turn_id=turn.turn_id, ts=turn.started_at or time.time())
                view.items.append(UserItem(clean(turn.prompt), turn.started_at or time.time(), from_app=True))
                reply.feed(turn.text)
                view.items.append(reply)
                if turn.permission:
                    self.set_modal(view, turn.permission)
        if session_id not in self.tabs:
            self.tabs.append(session_id)
        self.active = session_id
        view = self.views[session_id]
        self.files = forge.files_here(view.session["forge"]["worktree"]) if view.session.get("forge") else []
        try:
            found = await self.conn.get("/api/chat/references", params={"q": "", "session_id": session_id})
            self.references = {one_line(r.get("label"), 60).replace(" ", "_"): r for r in found
                               if r.get("kind") in ("note", "document", "agent", "skill")}
        except KairosError:
            self.references = {}
        self.invalidate()

    async def reload_active(self) -> None:
        if self.view:
            self.view.session = await chat.open_session(self.conn, self.view.id)
            self.view.touch()

    def close_tab(self, session_id: str) -> None:
        if session_id in self.tabs:
            index = self.tabs.index(session_id)
            self.tabs.remove(session_id)
            self.views.pop(session_id, None)
            if self.active == session_id:
                self.active = self.tabs[min(index, len(self.tabs) - 1)] if self.tabs else None
        if not self.tabs:
            self.spawn(self.new_chat())
        self.invalidate()

    async def new_chat(self) -> None:
        session = await chat.new_session(self.conn, folder=self.cwd)
        if self.choices and self.view and self.view.session.get("model_endpoint_id"):
            await chat.set_model(self.conn, session["id"], {"id": self.view.session["model_endpoint_id"]})
        await self.open_session(session["id"], history=False)
        await self.refresh_sidebar()

    # -- drawing: top, tabs, sidebar -------------------------------------------------------

    def top_bar(self):
        s = self.s
        working = any(v.working for v in self.views.values()) or any(
            t.status == "processing" for t in self.feed.book.turns.values())
        seconds = time.monotonic() - self.t0 if working and self.motion else None
        status = self.conn.status or {}
        name = "kairos" + (f" ({one_line(status.get('instance'), 20)})" if status.get("instance") else "")
        left = [(s.fg("gold"), " ⁘ "), (s.fg("accent", "bold"), name), (s.fg("meta"), "  ")]
        left += widgets.ring(seconds, s)
        running = sum(1 for t in self.feed.book.turns.values() if t.status == "processing")
        right = [(s.fg("meta"), f"{running} repl{'y' if running == 1 else 'ies'} running" if running else "idle"),
                 (s.fg("meta"), " · "),
                 (s.fg("warn" if self.feed_state != "connected" else "meta"),
                  "live" if self.feed_state == "connected" else self.feed_state), ("", " ")]
        return self.spread(left, right, self.width)

    def spread(self, left, right, width):
        gap = width - widgets.width_of(left) - widgets.width_of(right)
        return left + [("", " " * max(1, gap))] + right

    def tabs_bar(self):
        s = self.s
        out = []
        for session_id in self.tabs:
            view = self.views.get(session_id)
            if not view:
                continue
            active = session_id == self.active
            fresh = next((r for r in self.sessions if r["id"] == session_id), None)
            if fresh and fresh.get("title") and fresh["title"] != view.session.get("title"):
                view.session["title"] = fresh["title"]
            mark = "! " if view.__dict__.get("modal") else ("⠿ " if view.working else "")
            style = s.fg("text", "bold") + " " + s.bg("band") if active else s.fg("dim")
            open_it = (lambda sid: lambda event: self._tab_click(sid, event))(session_id)
            out.append((s.fg("gold") if active else s.fg("meta"), "▌" if active else " ", open_it))
            out.append((style, f" {mark}{widgets.fit(view.title, 22)} ", open_it))
            close = (lambda sid: lambda event: self._close_click(sid, event))(session_id)
            out.append((s.fg("meta"), "× ", close))
            out.append((s.fg("meta"), " "))
        out.append((s.fg("gold", "bold"), " + ", lambda event: self._plus_click(event)))
        return out

    def _tab_click(self, session_id, event):
        if event.event_type != MouseEventType.MOUSE_UP:
            return NotImplemented
        self.active = session_id
        self.invalidate()

    def _close_click(self, session_id, event):
        if event.event_type != MouseEventType.MOUSE_UP:
            return NotImplemented
        self.close_tab(session_id)

    def _plus_click(self, event):
        if event.event_type != MouseEventType.MOUSE_UP:
            return NotImplemented
        self.spawn(self.new_chat())

    def tree(self) -> list[model.Node]:
        busy = {sid for sid, t in self.feed.book.turns.items() if t.status == "processing"}
        return model.build_tree(self.sessions, self.forge_projects, self.forge_sessions, self.chat_projects,
                                self.active, set(self.tabs), busy, self.collapsed, self.cwd)

    def sidebar_text(self):
        s = self.s
        width = SIDEBAR - 1
        height = max(4, (self.app.output.get_size().rows if self.app else 40) - 6)
        out = [(s.fg("dim", "bold"), " Projects\n")]
        nodes = self.tree()
        rows = 1
        for index, node in enumerate(nodes):
            selected = self.sidebar_mode and index == self.sidebar_index
            sel = " reverse" if selected else ""
            handler = (lambda n: lambda event: self._node_click(n, event))(node)
            if node.kind == "group":
                caret = "▾" if node.open else "▸"
                style = s.fg("accent", "bold" + sel) if node.active else s.fg("text", sel)
                out += [(s.fg("meta"), f" {caret} ", handler), (s.fg("gold"), "◆ ", handler),
                        (style, widgets.fit(node.label, width - 6), handler), ("", "\n")]
            else:
                branch = "└─" if node.last else "├─"
                dot = "⠿" if node.busy else ("●" if node.active else "○")
                dot_style = s.fg("gold") if node.busy or node.active else s.fg("meta")
                style = s.fg("accent", "bold" + sel) if node.active else s.fg("text" if node.open else "dim", sel)
                out += [(s.fg("meta"), f"   {branch} ", handler), (dot_style, dot + " ", handler),
                        (style, widgets.fit(node.label, width - 8), handler), ("", "\n")]
            rows += 1
        # The ground: a halftone dune field under the tree.
        free = height - rows - 1
        if free > 2:
            for _ in range(max(0, free - min(free, 10))):
                out.append(("", "\n"))
            for line in widgets.field(width, min(free, 10), widgets.dune, s, "meta"):
                out += line + [("", "\n")]
        hint = "[alt+p] projects" if not self.sidebar_mode else "↑↓ enter · esc"
        out += [(s.fg("gold"), " "), (s.fg("meta"), hint)]
        return out

    def _node_click(self, node, event):
        if event.event_type != MouseEventType.MOUSE_UP:
            return NotImplemented
        self.activate_node(node)

    def activate_node(self, node: model.Node) -> None:
        if node.kind == "group":
            self.collapsed.symmetric_difference_update({node.group})
            self.invalidate()
        elif node.session_id:
            self.spawn(self.open_session(node.session_id))

    def divider(self):
        height = self.app.output.get_size().rows if self.app else 40
        out = []
        for row in range(height):
            out += widgets.divider_cell(row, height, self.s) + [("", "\n")]
        return out[:-1]

    # -- drawing: the transcript -----------------------------------------------------------

    def main_lines(self, width: int, height: int):
        if self.screen:
            return self.screen_lines(width, height), {}
        view = self.view
        if view is None or not view.items:
            return self.empty_state(width, height), {}
        lines: list = []
        clicks: dict = {}
        first = True
        for item in view.items:
            if isinstance(item, UserItem) and not first:
                lines.append([])
                lines.append([("", " " * GUTTER)] + widgets.dotted_rule(min(width - GUTTER * 2, 60), self.s, "gold"))
            first = False
            block, regions = self.item_lines(item, width)
            for row, region in regions.items():
                clicks[len(lines) + row] = region
            lines.extend(block)
        if view.queued:
            lines.append([])
            for text in view.queued:
                lines.append([("", " " * GUTTER), (self.s.fg("meta"), "queued · "),
                              (self.s.fg("dim"), widgets.fit(one_line(text, 200), width - GUTTER - 10))])
        lines.append([])
        if self.search_hit is not None and 0 <= self.search_hit < len(lines):
            lines[self.search_hit] = [(style + " reverse", text) for style, text, *_ in lines[self.search_hit]]
        return lines, clicks

    def item_lines(self, item, width: int):
        s = self.s
        body = width - GUTTER - 2
        if isinstance(item, ReplyItem) and (item.status == "processing" or item.files):
            return self.reply_lines(item, width)      # live, or chips that change state
        key = (id(item), width, getattr(item, "expanded", None), item.metrics is not None
               if isinstance(item, ReplyItem) else None, len(getattr(item, "blocks", []) or []),
               len(item.__dict__.get("notes", [])))
        if key in self.cache:
            return self.cache[key]
        if isinstance(item, UserItem):
            head = [("", "  "), (s.fg("gold"), "◇ "), (s.fg("text", "bold"), "You"),
                    (s.fg("meta"), f" · {clock(item.ts)}"), (s.fg("meta"), "  sent in the app" if item.from_app else "")]
            lines = [head] + [[("", " " * GUTTER), (s.fg("text"), line)] for line in wrap(item.text, body)]
            result = (lines, {})
        elif isinstance(item, ReplyItem):
            result = self.reply_lines(item, width)
        elif isinstance(item, NoteItem):
            result = ([[("", " " * GUTTER), (s.fg(item.role), line)] for line in wrap(item.text, body)], {})
        else:
            result = ([[("", " " * (GUTTER - 2))] + line for line in rich_lines(item.renderable, self.palette, width - GUTTER)], {})
        self.cache[key] = result
        return result

    def reply_lines(self, item: ReplyItem, width: int):
        s = self.s
        body = width - GUTTER - 2
        seconds = time.monotonic() - self.t0
        state = {"processing": "thinking", "done": "success", "failed": "error", "stopped": "idle"}[item.status]
        if item.status == "processing" and self.view and self.view.__dict__.get("modal"):
            state = "needs"
        lines, clicks = [], {}
        mark = self.kip.mark(state, seconds if self.motion else 0)
        head = [("", "  "), (s.fg({"needs": "warn", "error": "danger", "success": "gold"}.get(state, "gold")), mark.plain + " "),
                (s.fg("accent", "bold"), "Kairos"), (s.fg("meta"), f" · {clock(item.ts)}")]
        if item.status == "stopped":
            head.append((s.fg("warn"), " · stopped"))
        lines.append(head)
        for text in item.__dict__.get("notes", []):
            lines.append([("", " " * GUTTER), (s.fg("meta"), "· " + text)])
        actions = len(item.steps) + len(item.running)
        if actions or item.events:
            caret = "▾" if item.expanded else "▸"
            summary = f"{actions} action{'s' if actions != 1 else ''}"
            if item.events:
                summary += f" · {len(item.events)} event{'s' if len(item.events) != 1 else ''}"
            lines.append([("", " " * GUTTER), (s.fg("dim"), summary + " "), (s.fg("gold"), caret)])
            clicks[len(lines) - 1] = [(GUTTER, GUTTER + len(summary) + 2, lambda: self.toggle(item))]
            shown = (item.steps + item.events) if item.expanded else []
            for step in shown:
                for line in rich_lines(render.tool_cell(step, self.palette, expanded=True), self.palette, width - 2):
                    lines.append([("", "  ")] + line)
            for step in item.running.values():
                for line in rich_lines(render.tool_cell(step, self.palette), self.palette, width - 2):
                    lines.append([("", "  ")] + line)
        for block in item.blocks:
            for line in rich_lines(render.render_block(block, self.palette), self.palette, body + 2):
                lines.append([("", "  ")] + line)
        if item.files:
            row, regions = self.chip_line(item, width)
            lines.append([])
            lines.append(row)
            clicks[len(lines) - 1] = regions
        if item.status == "processing":
            tail = item.committer.tail()
            if tail:
                for line in wrap(clean(tail), body)[-3:]:
                    lines.append([("", " " * GUTTER), (s.fg("dim"), line)])
            modal = self.view and self.view.__dict__.get("modal")
            label = "Waiting for you" if modal else ("Writing" if item.text else "Thinking")
            working = [("", " " * GUTTER)]
            working += widgets.ring(seconds if self.motion else None, s)
            working += [("", " ")]
            shimmer = rich_lines(render.shimmer(label, seconds if self.motion else 2.0, self.palette), self.palette, 40)
            working += (shimmer[0] if shimmer else [(s.fg("accent"), label)]) + [("", "  ")]
            bar = rich_lines(render.braille_bar(seconds if self.motion else 0.4, self.palette), self.palette, 20)
            working += (bar[0] if bar else []) + [(s.fg("meta"), f"  {time.time() - item.ts:3.0f}s")]
            rate = item.stream_rate(16)
            if rate:
                working += [(s.fg("meta"), "  stream ")] + widgets.sparkline(rate, 16, s, "gold") + \
                           [(s.fg("meta"), " chars/s")]
            slot = self.kip.slot(state, seconds)
            if slot:
                # Kip's 12 x 6 slot to the left of the working line.
                art = [rich_lines(line, self.palette, 14)[0] for line in slot]
                beside = [[]] * len(art)
                beside[min(2, len(art) - 1)] = working[1:]
                for index, line in enumerate(art):
                    lines.append([("", " " * GUTTER)] + pad(line, 12) + [("", "  ")] + beside[index])
            else:
                lines.append(working)
        else:
            if item.error:
                lines.append([("", " " * GUTTER), (s.fg("danger"), one_line(item.error, body))])
            lines.append([])
            lines.append(self.metrics_line(item, width, clicks, len(lines)))
        return lines, clicks

    # -- file chips -------------------------------------------------------------------

    async def attach_files(self, view: SessionView, reply: ReplyItem) -> None:
        """The files this reply produced, as the backend lists them for the
        chat: new chat files and generated artifacts, and for a Forge session
        the files it has changed. Never taken from the reply's text."""
        found: list[dict] = []
        try:
            rows = await self.conn.get("/api/chat/files", params={"session_id": view.id}) or []
        except KairosError:
            rows = []
        since = (reply.ts or 0) - 2
        for row in rows:
            if row.get("origin") == "attachment" or not row.get("exists"):
                continue
            if row.get("origin") == "generated":
                # A generated file's listing carries the chat's time, not its
                # own: it belongs to the reply that links it.
                keep = bool(row.get("url")) and row["url"] in reply.text
            else:
                keep = (row.get("created_at") or 0) >= since
            if keep:
                found.append({"name": chip_name(row), "url": row.get("url"), "origin": row.get("origin")})
        if view.session.get("forge"):
            try:
                changes = await forge.changes(self.conn, view.id)
                for row in (changes.get("files") or [])[:8]:
                    if not row.get("binary") or row.get("untracked"):
                        found.append({"name": one_line(row.get("path"), 60), "forge_path": row.get("path"),
                                      "origin": "changed"})
            except KairosError:
                pass
        seen = set()
        reply.files = [f for f in found if not ((f.get("url") or f.get("forge_path")) in seen
                                                or seen.add(f.get("url") or f.get("forge_path")))][:10]
        for chip in reply.files:
            self.spawn(self.resolve_chip(view, chip))

    async def attach_history_files(self, view: SessionView) -> None:
        """Chips for earlier replies: the chat's generated files, each on
        the reply that links it."""
        try:
            rows = await self.conn.get("/api/chat/files", params={"session_id": view.id}) or []
        except KairosError:
            return
        generated = [r for r in rows if r.get("origin") == "generated" and r.get("exists") and r.get("url")]
        for item in view.items:
            if isinstance(item, ReplyItem) and not item.files:
                item.files = [{"name": chip_name(r), "url": r["url"], "origin": "generated"}
                              for r in generated if r["url"] in item.text][:10]
                for chip in item.files:
                    self.spawn(self.resolve_chip(view, chip))

    async def resolve_chip(self, view: SessionView, chip: dict) -> str | None:
        """The chip's local path, from the backend's checked route."""
        if chip.get("path"):
            return chip["path"]
        body = {"session_id": view.id}
        body.update({"url": chip["url"]} if chip.get("url") else {"forge_path": chip["forge_path"]})
        try:
            result = await self.conn.post("/api/cli/local-path", body)
        except KairosError as error:
            chip["refused"] = str(error)
            return None
        chip["path"] = result["path"]
        view.touch()
        self.invalidate()
        return chip["path"]

    async def reveal_chip(self, view: SessionView, chip: dict) -> None:
        path = await self.resolve_chip(view, chip)
        if not path:
            self.say(chip.get("refused") or "Kairos would not hand out that file's location.", "warn")
            return
        try:
            reveal.reveal(path)
        except (OSError, ValueError) as error:
            self.say(f"Could not open the file manager: {error}", "danger")
            return
        where = {"win32": "File Explorer", "darwin": "Finder"}.get(sys.platform, "the file manager")
        self.say(f"Showing {chip['name']} in {where}.", "success")

    def chips(self) -> list[tuple[ReplyItem, dict]]:
        view = self.view
        return [(item, chip) for item in (view.items if view else []) if isinstance(item, ReplyItem)
                for chip in item.files]

    def chip_line(self, item: ReplyItem, width: int):
        s = self.s
        out = [("", " " * GUTTER)]
        regions = []
        selected = None
        if self.file_mode:
            all_chips = self.chips()
            if 0 <= self.file_index < len(all_chips):
                selected = all_chips[self.file_index][1]
        x = GUTTER
        for chip in item.files:
            icon = {"changed": "±", "generated": "▤", "created": "▤"}.get(chip.get("origin"), "▤")
            label = f" {icon} {widgets.fit(chip['name'], 40)} "
            style = s.fg("accent", "underline") + (" reverse" if chip is selected else "")
            # The link's edges sit on the brackets, cells that are always
            # drawn with the chip, so the terminal sees both or neither.
            if chip.get("path"):
                out.append(("[ZeroWidthEscape]", osc8(reveal.file_uri(chip["path"]))))
            out.append((s.fg("gold"), "⟦"))
            out.append((style, label))
            if chip.get("path"):
                out.append(("[ZeroWidthEscape]", osc8("")))
            out.append((s.fg("gold"), "⟧"))
            span = get_cwidth(label) + 2
            regions.append((x, x + span, (lambda c: lambda: self.spawn(self.reveal_chip(self.view, c)))(chip)))
            out.append(("", " "))
            x += span + 1
            if x > width - 20:
                break
        out.append((s.fg("meta"), "  click or alt+f to show in the file manager"))
        return out, regions

    def toggle(self, item: ReplyItem) -> None:
        item.expanded = not item.expanded
        if self.view:
            self.view.touch()
        self.invalidate()

    def metrics_line(self, item: ReplyItem, width: int, clicks: dict, row: int):
        s = self.s
        m = item.metrics or {}
        parts = []
        if m.get("seconds") is not None:
            parts.append(f"{m['seconds']:.0f}s" if m["seconds"] >= 10 else f"{m['seconds']:.1f}s")
        if m.get("input") is not None or m.get("output") is not None:
            parts.append(f"{widgets.human_tokens(m.get('input'))} in")
            parts.append(f"{widgets.human_tokens(m.get('output'))} out")
        else:
            parts.append(f"{widgets.human_tokens(m.get('tokens'))} tokens" if m else "tokens n/a")
        if m.get("cached_percent") is not None:
            parts.append(f"{m['cached_percent']}% cached")
        parts.append(f"{m['tok_per_s']:.0f} tok/s" if m.get("tok_per_s") else "tok/s n/a")
        if m.get("tools"):
            parts.append(f"{m['tools']} tool{'s' if m['tools'] != 1 else ''}")
        parts.append("cost n/a")
        left = [("", " " * GUTTER), (s.fg("gold"), "▪ "), (s.fg("meta"), " · ".join(parts))]
        if m and not m.get("complete"):
            left.append((s.fg("meta"), " (partial usage)"))
        right = [(s.fg("gold"), "⑂ "), (s.fg("dim"), "Fork"), (s.fg("meta"), " · "),
                 (s.fg("gold"), "⧉ "), (s.fg("dim"), "Copy"), ("", "  ")]
        line = self.spread(left, right, width)
        start = width - widgets.width_of(right)
        clicks[row] = [(start, start + 6, lambda: self.spawn(self.fork(item))),
                       (start + 9, start + 15, lambda: self.copy(item.text))]
        return line

    def empty_state(self, width: int, height: int):
        s = self.s
        lines = []
        sky_h = max(3, min(8, height // 4))
        for line in widgets.field(width - 4, sky_h, widgets.sky, s, "gold"):
            lines.append([("", "  ")] + line)
        lines.append([])
        banner = self.kip.banner("idle", time.monotonic() - self.t0 if self.motion else 0)
        art = [rich_lines(line, self.palette, 30)[0] if line.plain.strip() else [] for line in banner]
        words = [rich_lines(line, self.palette, 60)[0] for line in render.wordmark(self.palette)]
        words.append([(s.fg("dim", "italic"), render.TAGLINE)])
        words.append([])
        model_name = models.label(self.session, self.choices, self.catalogs) if self.session else "no chat"
        words.append([(s.fg("meta"), "model  "), (s.fg("text"), model_name)])
        words.append([(s.fg("meta"), "folder "), (s.fg("text"), widgets.fit(self.cwd, 50))])
        words.append([])
        words.append([(s.fg("meta"), "type to start · / for commands · alt+p projects · f1 help")])
        rows = max(len(art), len(words))
        indent = max(2, (width - 30 - 66) // 2)
        for index in range(rows):
            left = art[index] if index < len(art) else []
            right = words[index - 1] if 0 < index <= len(words) else []
            lines.append([("", " " * indent)] + pad(left, 28) + [("", "  ")] + right)
        lines.append([])
        texture = "░▒ · ⁘ · ▒░"
        lines.append([("", " " * indent), (s.fg("meta"), (texture + "   ") * 4)])
        return lines

    # -- screens: models, usage, picker, help ------------------------------------------------

    def screen_lines(self, width: int, height: int):
        s = self.s
        data = self.screen_data
        title = {"models": "models", "usage": "usage", "picker": data.get("title", "choose"), "help": "keys"}[self.screen]
        lines = [[("", "  "), (s.fg("meta"), title)], []]
        if self.screen == "picker":
            needle = self.buffer.text.casefold()
            rows = [r for r in data.get("rows", []) if needle in f"{r[0]} {r[1]}".casefold()]
            data["filtered"] = rows
            data["index"] = min(data.get("index", 0), max(0, len(rows) - 1))
            # Two lines a row; keep the selected row in view.
            capacity = max(1, (height - 6) // 2)
            first = max(0, min(data["index"] - capacity // 2, len(rows) - capacity))
            for index, (label, detail_text, _value) in enumerate(rows[first: first + capacity], start=first):
                sel = index == data["index"]
                lines.append([("", "  "), (s.fg("gold"), "› " if sel else "  "),
                              (s.fg("text", "bold" if sel else ""), widgets.fit(label, 50).ljust(52)),
                              (s.fg("meta"), widgets.fit(detail_text, width - 60))])
                lines.append([("", "    "), (s.fg("meta"), "─" * min(width - 8, 100))])
            if not rows:
                lines.append([("", "  "), (s.fg("meta"), "nothing matches")])
            lines.append([])
            lines.append([("", "  "), (s.fg("meta"), "type to filter · ↑↓ · enter chooses · esc closes")])
            return lines
        if self.screen == "help":
            for name, args, about in commands.COMMANDS:
                lines.append([("", "  "), (s.fg("accent"), f"/{name} {args}".ljust(34)), (s.fg("dim"), about)])
            lines.append([])
            for key, about in KEYS:
                lines.append([("", "  "), (s.fg("text"), key.ljust(22)), (s.fg("meta"), about)])
            return lines
        return lines + data.get("lines", [])

    def open_screen(self, name: str, **data) -> None:
        self.screen, self.screen_data = name, data
        self.buffer.reset()
        self.invalidate()

    def close_screen(self) -> None:
        self.screen, self.screen_data = None, {}
        self.buffer.reset()
        self.invalidate()

    async def models_screen(self) -> None:
        """Model connections with what the backend reports: kind, model,
        context setting, images, tokens recorded through each, subscription
        windows, the built-in engine and Ollama's loaded models."""
        s, width = self.s, max(60, self.width - SIDEBAR - 6)
        endpoints = await self.conn.get("/api/models")
        usage = await self.safe("/api/models/usage") or {}
        quotas = await self.safe("/api/models/quotas") or {}
        engine = await self.safe("/api/cookbook/engine/status")
        running = await self.safe("/api/cookbook/running")
        lines = []

        def label(text):
            return [("", "  "), (s.fg("meta"), text)]
        lines.append(label("connections"))
        total = max([u.get("total_tokens", 0) for u in usage.values()] or [0]) or 1
        for endpoint in endpoints:
            used = usage.get(endpoint["id"])
            name = one_line(endpoint.get("name"), 30)
            detail = " · ".join(x for x in (one_line(endpoint.get("kind"), 12), one_line(endpoint.get("model") or "default", 30),
                                             f"ctx {endpoint['num_ctx']}" if endpoint.get("num_ctx") else "",
                                             "images" if endpoint.get("supports_images") else "") if x)
            lines.append([("", "  "), (s.fg("text", "bold"), name.ljust(32)), (s.fg("dim"), widgets.fit(detail, width - 40))])
            if used:
                fresh, cached = used.get("fresh_tokens", 0) + used.get("unsplit_tokens", 0), used.get("cache_read_tokens", 0)
                lines.append([("", "    "), (s.fg("meta"), "tokens recorded  ")] +
                             widgets.bar(used["total_tokens"] / total, 24, s) +
                             [(s.fg("dim"), f"  {widgets.human_tokens(used['total_tokens'])}"),
                              (s.fg("meta"), f"  ({widgets.human_tokens(fresh)} fresh · {widgets.human_tokens(cached)} cache reads)")])
            else:
                lines.append([("", "    "), (s.fg("meta"), "tokens recorded  none yet")])
            lines.append([("", "    "), (s.fg("meta"), "─" * min(width - 8, 100))])
        providers = quotas.get("providers") or []
        if providers:
            lines.append([])
            lines.append(label("subscription windows"))
            for entry in providers:
                lines.append([("", "  "), (s.fg("text", "bold"), one_line(entry.get("provider"), 20).ljust(32)),
                              (s.fg("meta"), one_line(entry.get("status"), 20))])
                for window in entry.get("windows") or []:
                    used = window.get("used_percent")
                    lines.append([("", "    "), (s.fg("meta"), widgets.fit(one_line(window.get("name"), 16), 16).ljust(17))] +
                                 widgets.bar(None if used is None else used / 100, 24, s) +
                                 [(s.fg("dim"), f"  {used:.0f}%" if used is not None else "  n/a"),
                                  (s.fg("meta"), f"  {model.resets_in(window.get('resets_at'))}")])
        lines.append([])
        lines.append(label("this computer"))
        if engine:
            state = f"running {one_line(engine.get('model'), 40)}" if engine.get("running") else "stopped"
            lines.append([("", "  "), (s.fg("text"), "built-in engine".ljust(32)), (s.fg("dim"), state)])
        if running:
            for item in running:
                size, vram = item.get("size"), item.get("size_vram")
                lines.append([("", "  "), (s.fg("text"), widgets.fit(one_line(item.get("name"), 30), 30).ljust(32)),
                              (s.fg("meta"), "in memory ")] +
                             widgets.bar(vram / size if size and vram is not None else None, 20, s) +
                             [(s.fg("dim"), f"  {vram / 1e9:.1f} / {size / 1e9:.1f} GB on the GPU"
                               if size and vram is not None else "  n/a")])
        lines.append([("", "  "), (s.fg("meta"), "Kairos reports no GPU name or card memory total; Ollama's loaded "
                                                 "models report their own size on the GPU when Ollama runs.")])
        self.open_screen("models", lines=lines)

    async def usage_screen(self) -> None:
        """This chat's usage: tokens per hour today and the last reply's
        stream rate, only from data that exists."""
        s, view = self.s, self.view
        if not view:
            return
        runs = await self.fetch_runs(view.id)
        await self.refresh_context(view)
        lines = []

        def label(text):
            return [("", "  "), (s.fg("meta"), text)]
        hours = model.tokens_per_hour_today(runs)
        replies_today = sum(1 for r in runs if r.get("started_at") and dt.date.fromtimestamp(r["started_at"]) == dt.date.today())
        lines.append(label("tokens per hour · today · this chat"))
        if hours:
            for row in widgets.histogram([float(h) for h in hours], 5, s):
                lines.append([("", "  ")] + row)
            lines.append([("", "  "), (s.fg("meta"), "0     6     12    18   ")])
            lines.append([("", "  "), (s.fg("dim"), f"{widgets.human_tokens(sum(hours))} tokens today, "
                                                    f"{replies_today} repl{'y' if replies_today == 1 else 'ies'}")])
        else:
            lines.append([("", "  "), (s.fg("meta"), "n/a: no reply today reported token usage")])
        lines.append([])
        rates = model.rate_series(runs)
        known = [r for r in rates if r]
        lines.append(label("tok/s · per reply · this chat"))
        if known:
            lines.append([("", "  ")] + widgets.sparkline([r or 0 for r in rates][-40:], 40, s) +
                         [(s.fg("dim"), f"  last {known[-1]:.0f} · best {max(known):.0f} · "
                                        f"{len(known)} of {len(rates)} replies measured")])
        else:
            lines.append([("", "  "), (s.fg("meta"), "n/a: no reply here has both output tokens and a streaming window")])
        totals = model.session_totals(runs)
        lines.append([("", "  "), (s.fg("meta"), "in "), (s.fg("dim"), widgets.human_tokens(totals["input"])),
                      (s.fg("meta"), " · out "), (s.fg("dim"), widgets.human_tokens(totals["output"])),
                      (s.fg("meta"), " · total "), (s.fg("dim"), widgets.human_tokens(totals["tokens"]))])
        lines.append([])
        lines.append([("", "  ")] + self.context_bar(view, 30))
        lines.append([])
        lines.append(label("not reported by the backend"))
        for item in model.METRICS_SOURCES["missing"]:
            for index, part in enumerate(wrap(item, max(30, self.width - SIDEBAR - 10))):
                lines.append([("", "  "), (s.fg("meta"), ("· " if index == 0 else "  ") + part)])
        self.open_screen("usage", lines=lines)

    async def safe(self, path: str):
        try:
            return await self.conn.get(path)
        except KairosError:
            return None

    # -- drawing: composer, status, bottom ---------------------------------------------------

    def composer_top(self):
        s = self.s
        width = max(20, self.width - SIDEBAR)
        session = self.session
        effort = session.get("model_effort") or "default"
        mode = (session.get("forge") or {}).get("mode") if session.get("forge") else session.get("permission_mode", "base")
        if self.mode == "search":
            parts = [(s.fg("accent"), " find in this chat ")]
        elif self.screen == "picker":
            parts = [(s.fg("accent"), " filter ")]
        else:
            parts = [(s.fg("text", "bold"), " " + models.label(session, self.choices, self.catalogs)), (s.fg("meta"), " · "),
                     (s.fg("dim"), f"effort {effort}"), (s.fg("meta"), " · "),
                     (s.fg("warn" if mode == "auto" else "dim"), f"{mode} ")]
        used = widgets.width_of(parts) + 3
        return [(s.fg("gold"), "╭─")] + parts + [(s.fg("gold"), "─" * max(1, width - used) + "╮")]

    def composer_prefix(self):
        s = self.s
        if self.mode == "search":
            return [(s.fg("gold"), "│ "), (s.fg("accent"), "⌕ ")]
        return [(s.fg("gold"), "│ "), (s.fg("gold", "bold"), "◆ ")]

    def composer_bottom(self):
        width = max(20, self.width - SIDEBAR)
        return [(self.s.fg("gold"), "╰" + "─" * (width - 2) + "╯")]

    def placeholder(self):
        view = self.view
        if self.buffer.text:
            return []
        if view and view.__dict__.get("modal"):
            text = "1-9 answers the prompt above · esc rejects"
        elif view and view.working:
            text = "a reply is running · enter queues this for when it ends · esc stops it"
        elif self.mode == "search":
            text = "type, then enter finds the next match up · esc ends"
        elif self.screen == "picker":
            text = "type to filter · ↑↓ · enter chooses · esc closes"
        else:
            text = "message Kairos · / commands · @ " + ("files" if self.is_forge else "notes")
        return [(self.s.fg("meta"), text)]

    def context_bar(self, view: SessionView | None, width: int):
        s = self.s
        context = (view.context if view else None) or {}
        percent = context.get("percent") if context.get("available") else None
        fragments = [(s.fg("meta"), "context ")] + widgets.bar(None if percent is None else percent / 100, width, s)
        if percent is not None:
            fragments.append((s.fg("dim"), f" {percent:.0f}%" + ("~" if context.get("estimated_capacity") else "")))
        elif context.get("available") and context.get("used_tokens"):
            fragments.append((s.fg("dim"), f" {widgets.human_tokens(context['used_tokens'])}"))
        else:
            fragments.append((s.fg("meta"), " n/a"))
        return fragments

    def branch(self) -> str | None:
        folder = (self.session.get("forge") or {}).get("worktree") or self.session.get("launch_dir") or self.cwd
        cached = self.branch_cache.get(folder)
        if cached and time.monotonic() - cached[0] < 10:
            return cached[1]
        value = model.git_branch(folder)
        self.branch_cache[folder] = (time.monotonic(), value)
        return value

    def status_line(self):
        s = self.s
        view = self.view
        branch = self.branch()
        totals = model.session_totals(view.runs if view else [])
        endpoint = next((c for c in self.choices if c["id"] == self.session.get("model_endpoint_id")), {})
        window = model.plan_window(self.quotas, endpoint.get("kind"))
        out = [(s.fg("gold"), " ⎇ "), (s.fg("dim"), branch or "no branch"), (s.fg("meta"), "   ")]
        if totals["input"] is not None or totals["output"] is not None:
            out += [(s.fg("dim"), f"{widgets.human_tokens(totals['input'])} in · "
                                  f"{widgets.human_tokens(totals['output'])} out")]
        else:
            out += [(s.fg("dim"), f"{widgets.human_tokens(totals['tokens'])} tokens" if totals["tokens"] is not None
                     else "tokens n/a")]
        rates = [r for r in model.rate_series(view.runs if view else []) if r]
        out += [(s.fg("meta"), " · "), (s.fg("dim"), f"{rates[-1]:.0f} tok/s" if rates else "tok/s n/a"),
                (s.fg("meta"), " · cost n/a · ")]
        out += [(s.fg("meta"), "plan ")]
        if window:
            used = window.get("used_percent")
            out += widgets.bar(None if used is None else used / 100, 8, s) + \
                   [(s.fg("dim"), f" {used:.0f}%" if used is not None else " n/a"),
                    (s.fg("meta"), f" {model.resets_in(window.get('resets_at'))}")]
        else:
            out += widgets.bar(None, 8, s) + [(s.fg("meta"), " n/a")]
        out += [(s.fg("meta"), " · ")] + self.context_bar(view, 10)
        return out

    def bottom_bar(self):
        s = self.s
        now = dt.datetime.now()
        if self.notice and time.monotonic() < self.notice_until:
            left = [(s.fg("gold"), " ▪ "), (s.fg(getattr(self, "notice_role", "meta")), self.notice)]
        elif self.copy_mode:
            left = [(s.fg("warn"), " copy mode · the mouse selects text in your terminal · alt+c to leave")]
        else:
            left = [(s.fg("gold"), " ▪ "), (s.fg("dim"), widgets.fit(self.cwd, 60))]
        if self.view and self.view.scroll:
            left.append((s.fg("warn"), f"  ↑ {self.view.scroll} lines up · end returns"))
        right = [(s.fg("meta"), now.strftime("%a %b %d").upper()), (s.fg("meta"), " · "),
                 (s.fg("dim"), now.strftime("%I:%M %p").lstrip("0")), ("", " ")]
        return self.spread(left, right, self.width)

    def question_state(self, view, request):
        states = view.__dict__.setdefault("question_states", {})
        return states.setdefault(request["id"], {"index": 0, "answers": {}, "toggles": set()})

    def modal_box(self, view, request):
        note = view.__dict__.get("modal_note", "")
        if request.get("kind") == "question":
            return render.question_box(request, self.palette, self.width - SIDEBAR - 2,
                                       self.question_state(view, request), note)
        return render.permission_box(request, self.palette, self.width - SIDEBAR - 2, note)

    async def respond_question(self, index=None, text=None, skip=False):
        view = self.view
        request = view.__dict__.get("modal") if view else None
        if not request or request.get("kind") != "question" or request["id"] in self.answered:
            return
        state = self.question_state(view, request)
        if not skip:
            question = request["questions"][state["index"]]
            options = question.get("options", [])
            if index is not None:
                if not 0 <= index < len(options):
                    return
                if question.get("multiSelect"):
                    toggles = state["toggles"]
                    toggles.symmetric_difference_update({index})
                    self.invalidate()
                    return
                value = options[index]["label"]
            elif question.get("multiSelect"):
                value = [o["label"] for i, o in enumerate(options) if i in state["toggles"]]
                if text:
                    value.append(text)
                value = list(dict.fromkeys(value))
            else:
                value = text
            if not value:
                return
            state["answers"][question["question"]] = value
            if state["index"] + 1 < len(request["questions"]):
                state["index"] += 1
                state["toggles"] = set()
                self.invalidate()
                return
        self.answered.add(request["id"])
        try:
            result = await chat.answer_question(self.conn, request["id"], state["answers"], skip=skip)
        except KairosError as error:
            self.answered.discard(request["id"])
            self.set_modal(view, request, str(error))
            self.invalidate()
            return
        note = "Answered in the app." if result == "gone" else "Skipped the question." if skip else "Answered."
        if view.reply is not None:
            view.reply.__dict__.setdefault("notes", []).append(note)
            view.touch()
        else:
            view.add(NoteItem(note))
        if view.__dict__.get("modal") is request:
            self.set_modal(view, None)
        self.invalidate()

    def permission_window(self):
        view = self.view
        request = view.__dict__.get("modal") if view else None
        if not request:
            return []
        out = []
        for line in rich_lines(self.modal_box(view, request),
                               self.palette, self.width - SIDEBAR - 2):
            out += line + [("", "\n")]
        return out[:-1]

    def permission_height(self):
        view = self.view
        request = view.__dict__.get("modal") if view else None
        if not request:
            return 0
        return len(rich_lines(self.modal_box(view, request), self.palette,
                              self.width - SIDEBAR - 2))

    # -- actions -----------------------------------------------------------------------------

    def copy(self, text: str) -> None:
        """OSC 52 to the terminal's clipboard, and Windows' clip as well."""
        data = clean(text)
        try:
            if self.app:
                self.app.output.write_raw("\x1b]52;c;" + base64.b64encode(data.encode("utf-8")).decode() + "\x07")
                self.app.output.flush()
            if sys.platform == "win32":
                subprocess.run(["clip"], input=data.encode("utf-16-le"), timeout=3, check=False)
        except (OSError, subprocess.SubprocessError):
            pass
        self.say("Copied the reply.", "success")

    async def fork(self, item: ReplyItem | None = None) -> None:
        if not self.view:
            return
        await self.reload_active()
        messages = self.view.session.get("messages") or []
        if not messages:
            self.say("Nothing to fork yet.")
            return
        through = len(messages) - 1
        if item and item.ended:
            stamps = [i for i, m in enumerate(messages) if m.get("role") == "assistant" and (m.get("ts") or 0) <= item.ended + 1]
            through = stamps[-1] if stamps else through
        try:
            copy = await self.conn.post(f"/api/sessions/{self.view.id}/fork", {"through_index": through})
        except KairosError as error:
            self.say(str(error), "danger")
            return
        await self.open_session(copy["id"])
        await self.refresh_sidebar()
        self.say("Forked. This tab is the copy.", "success")

    async def answer(self, index: int | None) -> None:
        view = self.view
        request = view.__dict__.get("modal") if view else None
        if not request:
            return
        if request.get("kind") == "question":
            await self.respond_question(index=index, skip=index is None)
            return
        choices = request.get("choices") or []
        choice = chat.reject_choice(request) if index is None else (choices[index] if 0 <= index < len(choices) else None)
        if not choice:
            return
        self.answered.add(request["id"])
        self.set_modal(view, request, "Sending your answer…")
        self.invalidate()
        try:
            result = await chat.answer_permission(self.conn, request["id"], choice["id"])
        except KairosError as error:
            self.answered.discard(request["id"])
            self.set_modal(view, request, str(error))
            self.invalidate()
            return
        verb = "Rejected" if choice.get("behavior") == "deny" else "Allowed"
        text = f"{verb}: {one_line(choice.get('label'), 60)}" if result == "answered" else "Answered in the app."
        reply = view.reply
        if reply is not None:
            reply.__dict__.setdefault("notes", []).append(text)
            view.touch()
        else:
            view.add(NoteItem(text))
        if view.__dict__.get("modal") is request:
            self.set_modal(view, None)
        self.invalidate()

    async def stop(self) -> None:
        if self.view and self.view.working:
            try:
                await chat.stop_turn(self.conn, self.view.id)
                self.say("Stopping…")
            except KairosError as error:
                self.say(str(error), "danger")

    async def send(self, text: str, view: SessionView | None = None) -> None:
        view = view or self.view
        if not view:
            return
        if view.working:
            view.queued.append(text)
            view.touch()
            self.say("Queued: it goes when this reply ends. (Kairos cannot take text into a running reply.)")
            return
        if not view.session.get("model_endpoint_id"):
            self.say("Choose a model first: /model", "warn")
            return
        refs = [ref for label, ref in self.references.items() if f"@{label}" in text][:5]
        view.items.append(UserItem(text, time.time()))
        view.__dict__["own_pending"] = True
        view.scroll = 0
        view.touch()
        try:
            await chat.start_turn(self.conn, view.id, text, refs)
        except KairosError as error:
            view.__dict__.pop("own_pending", None)
            view.add(NoteItem(str(error), "danger"))
        self.invalidate()

    def find(self, needle: str) -> None:
        """Search up from the current view for the next line containing the
        text, and scroll it into view."""
        if not needle or not self.view:
            return
        lines, _ = self.main_lines(max(20, self.width - SIDEBAR - 1), 10)
        plain = ["".join(text for _, text, *_ in line).casefold() for line in lines]
        top, total, height = self.scroll_info
        start = (self.search_hit if self.search_hit is not None else top + height) - 1
        for index in list(range(start, -1, -1)) + list(range(len(plain) - 1, start, -1)):
            if needle.casefold() in plain[index]:
                self.search_hit = index
                self.view.scroll = max(0, len(plain) - index - height // 2)
                self.say(f"line {index + 1} of {len(plain)}")
                self.invalidate()
                return
        self.say("No match.", "warn")

    # -- commands ------------------------------------------------------------------------------

    async def submit(self) -> None:
        text = self.buffer.text.strip()
        request = self.view.__dict__.get("modal") if self.view else None
        if request and request.get("kind") == "question":
            self.buffer.reset()
            await self.respond_question(text=text)
            return
        if self.screen == "picker":
            rows = self.screen_data.get("filtered") or []
            index = self.screen_data.get("index", 0)
            callback = self.screen_data.get("on_pick")
            self.close_screen()
            if rows and callback:
                await callback(rows[index][2])
            return
        if self.mode == "search":
            self.find(text)
            return
        if not text:
            return
        self.buffer.reset(append_to_history=True)
        parsed = commands.parse(text)
        if parsed:
            try:
                await self.command(*parsed)
            except KairosError as error:
                self.say(str(error), "danger")
        else:
            await self.send(text)

    async def command(self, name: str, rest: str) -> None:
        view = self.view
        sid = view.id if view else None
        if name in ("quit", "exit"):
            self.quit = True
            self.app.exit()
        elif name == "help":
            self.open_screen("help")
        elif name in commands.APP_ONLY:
            if self.open_app and launch_app(self.instance or None, background=False):
                self.say(f"{commands.APP_ONLY[name]} lives in the Kairos app. Opening it now.")
            else:
                self.say(f"{commands.APP_ONLY[name]} lives in the Kairos app. Open it from the tray.")
        elif name == "new":
            await self.new_chat()
        elif name == "resume":
            if rest:
                found = await chat.find_session(self.conn, rest)
                if found:
                    await self.open_session(found["id"])
                else:
                    self.say(f"No chat matches {one_line(rest, 60)}.", "warn")
            else:
                rows = sorted(await chat.list_sessions(self.conn), key=lambda r: r.get("updated_at") or 0, reverse=True)
                self.open_screen("picker", title="resume a chat",
                                 rows=[(one_line(r.get("title") or "Chat", 60),
                                        f"{models.label(r, self.choices, self.catalogs)} · {r.get('message_count', 0)} messages · {chat.age(r.get('updated_at'))}",
                                        r["id"]) for r in rows[:200]],
                                 on_pick=self.open_session)
        elif name == "rename":
            if not rest:
                self.say("Usage: /rename <title>", "warn")
                return
            await self.conn.call("PATCH", f"/api/sessions/{sid}", json={"title": rest[:120]})
            await self.reload_active()
            await self.refresh_sidebar()
        elif name == "model":
            await self.choose_model(rest)
        elif name == "effort":
            await self.choose_effort(rest)
        elif name == "models":
            await self.models_screen()
        elif name == "usage":
            await self.usage_screen()
        elif name == "mode":
            if self.is_forge:
                mode = rest or ("plan" if self.session["forge"].get("mode") == "build" else "build")
                if mode not in ("build", "plan"):
                    self.say("Forge modes are build and plan.", "warn")
                    return
                await self.conn.post(f"/api/forge/sessions/{sid}/mode", {"mode": mode})
            else:
                mode = rest or ("auto" if self.session.get("permission_mode", "base") == "base" else "base")
                if mode not in ("base", "auto"):
                    self.say("Chat modes are base and auto.", "warn")
                    return
                await self.conn.post(f"/api/sessions/{sid}/permission-mode", {"mode": mode})
            await self.reload_active()
            self.say(f"Mode: {mode}", "success")
        elif name == "compact":
            self.say("Compacting…")
            await self.conn.post("/api/chat/compact", {"session_id": sid})
            self.say("Compacted.", "success")
        elif name == "rewind":
            await self.reload_active()
            messages = self.view.session.get("messages") or []
            last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=None)
            if last_user is None:
                self.say("Nothing to rewind.")
                return
            await self.conn.post(f"/api/sessions/{sid}/rewind", {"keep": last_user})
            await self.reload_active()
            runs = await self.fetch_runs(sid)
            self.view.load_history(self.view.session.get("messages") or [], runs)
            self.say(f"Removed the last exchange, {len(messages) - last_user} message(s).")
        elif name == "fork":
            await self.fork()
        elif name == "stop":
            await self.stop()
        elif name == "forge":
            worktree = "--worktree" in rest.split()
            task = " ".join(w for w in rest.split() if w != "--worktree").strip()
            if not task:
                self.say("Usage: /forge <task> [--worktree]", "warn")
                return
            created = await forge.start(self.conn, task, folder=self.cwd, worktree=worktree,
                                        model_endpoint_id=self.session.get("model_endpoint_id"))
            await self.open_session(created["id"], history=False)
            await self.refresh_sidebar()
            await self.send(task)
        elif name in ("diff", "undo", "revert"):
            if not self.is_forge:
                self.say("That works in a Forge session. Start one with /forge <task>.", "warn")
                return
            if name == "diff":
                result = await forge.changes(self.conn, sid)
                self.view.add(RichItem(render.render_diff(result.get("files") or [], self.palette,
                                                          max(40, self.width - SIDEBAR - GUTTER - 2))))
                self.view.scroll = 0
            elif name == "undo":
                done = await forge.undo_last(self.conn, sid)
                self.note(f"Undone: {len(done['result'].get('restored') or [])} file(s) restored.", "success")
            else:
                if not rest:
                    self.say("Usage: /revert <file>", "warn")
                    return
                await forge.revert_file(self.conn, sid, rest)
                self.note(f"Reverted {one_line(rest, 80)}.", "success")
        elif name == "agents":
            await self.agents(rest)
        elif name == "permissions":
            data = await self.conn.get("/api/permissions")
            rows = [[r["tool"], r.get("content") or "everything", "allow" if r.get("behavior") == "allow" else "deny",
                     "this chat" if r.get("scope") == "session" else "always"] for r in data.get("rules", [])]
            self.view.add(RichItem(render.table_of(rows, ["tool", "covers", "decision", "scope"], self.palette)))
            self.note(f"This chat's mode: {self.session.get('permission_mode', 'base')}. Revoke grants in the app: Settings > Permissions.")
        elif name == "tools":
            reply = self.view.reply if self.view else None
            if reply:
                reply.expanded = True
                self.view.touch()
        elif name == "copy":
            reply = self.view.reply if self.view else None
            if reply:
                self.copy(reply.text)
        elif name == "clear":
            if self.view:
                self.view.items = []
                self.view.touch()
        else:
            self.say(f"No command /{one_line(name, 30)}. Try /help.", "warn")
        self.invalidate()

    def model_options(self) -> list:
        return models.options(self.choices, self.catalogs)

    def current_option(self):
        session = self.session
        for option in self.model_options():
            if option.endpoint_id == session.get("model_endpoint_id") and option.model_id == (session.get("model_override") or None):
                return option
        return None

    async def set_option(self, option, effort=None) -> None:
        await models.apply(self.conn, self.view.id, option, effort)
        await self.reload_active()
        self.say(f"Model: {option.name}" + (f" · effort {effort}" if effort else ""), "success")

    async def choose_model(self, rest: str) -> None:
        """/model: every model the app's picker offers, inside each
        connection (kairos_cli/models.py); then the effort, where offered."""
        self.choices, self.catalogs = await models.load(self.conn)
        opts = self.model_options()
        if rest:
            option, effort, problem = models.match(opts, rest)
            if option is None:
                self.say(problem, "warn")
                return
            await self.set_option(option, effort)
            return

        async def picked(option):
            if option.efforts:
                rows = [("provider default" + (f" ({option.default_effort})" if option.default_effort else ""), "", None)]
                rows += [(e["effort"], one_line(e.get("description") or "", 80), e["effort"]) for e in option.efforts]

                async def with_effort(effort):
                    await self.set_option(option, effort)
                self.open_screen("picker", title=f"effort for {option.name}", rows=rows, on_pick=with_effort)
            else:
                await self.set_option(option)
        current = self.current_option()
        rows = []
        for option in opts:
            detail = " · ".join(x for x in (option.connection if option.model_id else "the connection's own setting",
                                            option.model_id or "", option.description,
                                            "effort " + "/".join(e["effort"] for e in option.efforts) if option.efforts else "")
                                if x)
            same = current is not None and (option.endpoint_id, option.model_id) == (current.endpoint_id, current.model_id)
            rows.append((("● " if same else "  ") + option.label, detail, option))
        index = next((i for i, row in enumerate(rows) if row[0].startswith("● ")), 0)
        self.open_screen("picker", title="choose a model", rows=rows, on_pick=picked, index=index)

    async def choose_effort(self, rest: str) -> None:
        self.choices, self.catalogs = await models.load(self.conn)
        option = self.current_option()
        if option is None or not option.efforts:
            self.say("This chat's model offers no effort levels.", "warn")
            return
        if rest:
            effort = None if rest.strip().lower() in ("default", "none") else rest.strip().lower()
            await self.set_option(option, effort)
            return
        rows = [("provider default", "", None)] + [(e["effort"], one_line(e.get("description") or "", 80), e["effort"])
                                                  for e in option.efforts]

        async def chosen(effort):
            await self.set_option(option, effort)
        self.open_screen("picker", title=f"effort for {option.name}", rows=rows, on_pick=chosen)

    async def agents(self, rest: str) -> None:
        words = rest.split(maxsplit=2)
        inbox = await self.conn.get("/api/agents/inbox")
        items = inbox.get("items") or []
        if words and words[0] in ("reply", "dismiss"):
            if len(words) < 2 or not words[1].isdigit() or not 1 <= int(words[1]) <= len(items):
                self.say("Usage: /agents reply <n> <text>, or /agents dismiss <n>", "warn")
                return
            item = items[int(words[1]) - 1]
            result = await self.conn.post(f"/api/agents/inbox/{item['id']}/answer",
                                          {"choice": words[0], "text": words[2] if len(words) > 2 else ""})
            self.note(one_line(result.get("next") or "Answered.", 200), "success")
            return
        agents = await self.conn.get("/api/agents")
        names = {a["id"]: a.get("name") for a in agents}
        rows = [[a.get("name") or "", a.get("status") or "", one_line(a.get("status_detail") or "", 50),
                 str(a.get("needs_you") or 0)] for a in agents]
        self.view.add(RichItem(render.table_of(rows, ["agent", "state", "doing", "needs you"], self.palette)))
        if items:
            for number, item in enumerate(items, start=1):
                self.note(f"{number}. {one_line(names.get(item.get('agent_id'), 'agent'), 24)}: {one_line(item.get('title'), 90)}")
            self.note("Answer with /agents reply <n> <text>, or /agents dismiss <n>.")
        else:
            self.note("Nothing in the inbox.")

    # -- the application ------------------------------------------------------------------------

    def bindings(self) -> KeyBindings:
        keys = KeyBindings()
        modal = Condition(lambda: bool(self.view and self.view.__dict__.get("modal")) and not self.screen)
        # Other answers need digits to reach the buffer once typing has started.
        option_shortcuts = modal & Condition(lambda: self.modal.get("kind") != "question" or not self.buffer.text)
        working = Condition(lambda: bool(self.view and self.view.working))
        picker = Condition(lambda: self.screen == "picker")
        sidebar = Condition(lambda: self.sidebar_mode)
        screen = Condition(lambda: self.screen is not None)
        search = Condition(lambda: self.mode == "search")
        files = Condition(lambda: self.file_mode)
        run = self.spawn

        for digit in "123456789":
            @keys.add(digit, filter=option_shortcuts, eager=True)
            def _(event, digit=digit):
                run(self.answer(int(digit) - 1))

        # Not eager: alt+key arrives as escape then the key, so a lone
        # escape must wait the short ttimeoutlen to be told apart.
        @keys.add("escape")
        def _(event):
            if self.file_mode:
                self.file_mode = False
                self.notice = ""
            elif self.sidebar_mode:
                self.sidebar_mode = False
            elif self.screen:
                self.close_screen()
            elif self.mode == "search":
                self.mode, self.search_hit = "chat", None
                self.buffer.reset()
            elif modal():
                run(self.answer(None))           # esc never means allow
            elif working():
                run(self.stop())
            self.invalidate()

        @keys.add("enter", filter=~sidebar & ~files)
        def _(event):
            run(self.submit())

        @keys.add("escape", "enter")
        @keys.add("c-j")
        def _(event):
            self.buffer.insert_text("\n")

        @keys.add("escape", "q")
        def _(event):
            text = self.buffer.text.strip()
            if text and self.view:
                self.buffer.reset()
                run(self.send(text))

        @keys.add("pageup")
        def _(event):
            self.scroll(max(1, self.scroll_info[2] - 2))

        @keys.add("pagedown")
        def _(event):
            self.scroll(-max(1, self.scroll_info[2] - 2))

        @keys.add("c-home")
        def _(event):
            self.scroll(10**6)

        @keys.add("c-end")
        @keys.add("end", filter=Condition(lambda: not self.buffer.text))
        def _(event):
            if self.view:
                self.view.scroll = 0
                self.search_hit = None
            self.invalidate()

        @keys.add("up", filter=picker)
        def _(event):
            self.screen_data["index"] = max(0, self.screen_data.get("index", 0) - 1)
            self.invalidate()

        @keys.add("down", filter=picker)
        def _(event):
            self.screen_data["index"] = self.screen_data.get("index", 0) + 1
            self.invalidate()

        @keys.add("escape", "p")
        def _(event):
            self.sidebar_mode = not self.sidebar_mode
            self.invalidate()

        @keys.add("up", filter=sidebar)
        def _(event):
            self.sidebar_index = max(0, self.sidebar_index - 1)
            self.invalidate()

        @keys.add("down", filter=sidebar)
        def _(event):
            self.sidebar_index = min(len(self.tree()) - 1, self.sidebar_index + 1)
            self.invalidate()

        @keys.add("enter", filter=sidebar)
        def _(event):
            nodes = self.tree()
            if 0 <= self.sidebar_index < len(nodes):
                self.activate_node(nodes[self.sidebar_index])
            if nodes and nodes[self.sidebar_index].kind == "session":
                self.sidebar_mode = False

        @keys.add("escape", "right")
        def _(event):
            self.cycle(1)

        @keys.add("escape", "left")
        def _(event):
            self.cycle(-1)

        @keys.add("escape", "t")
        def _(event):
            run(self.new_chat())

        @keys.add("escape", "w")
        def _(event):
            if self.active:
                self.close_tab(self.active)

        @keys.add("escape", "c")
        def _(event):
            self.copy_mode = not self.copy_mode
            self.invalidate()

        @keys.add("escape", "f")
        def _(event):
            chips = self.chips()
            if not chips:
                self.say("No files in this chat's replies yet.")
                return
            self.file_mode = True
            self.file_index = len(chips) - 1
            self.say(f"{chips[-1][1]['name']} · ←→ choose · enter shows it · esc ends", "meta", 3600)

        @keys.add("left", filter=files)
        @keys.add("s-tab", filter=files)
        def _(event):
            self.file_index = max(0, self.file_index - 1)
            self.invalidate()

        @keys.add("right", filter=files)
        @keys.add("tab", filter=files)
        def _(event):
            self.file_index = min(len(self.chips()) - 1, self.file_index + 1)
            self.invalidate()

        @keys.add("enter", filter=files, eager=True)
        def _(event):
            chips = self.chips()
            if 0 <= self.file_index < len(chips):
                run(self.reveal_chip(self.view, chips[self.file_index][1]))
            self.file_mode = False

        @keys.add("c-f")
        def _(event):
            self.mode, self.search_hit = "search", None
            self.buffer.reset()
            self.invalidate()

        @keys.add("c-o")
        def _(event):
            reply = self.view.reply if self.view else None
            if reply:
                self.toggle(reply)

        @keys.add("f1")
        def _(event):
            self.open_screen("help")

        @keys.add("c-c")
        def _(event):
            if self.buffer.text:
                self.buffer.reset()
            elif working():
                run(self.stop())
            else:
                self.quit = True
                event.app.exit()

        @keys.add("c-d", filter=Condition(lambda: not self.buffer.text))
        def _(event):
            self.quit = True
            event.app.exit()
        return keys

    def cycle(self, step: int) -> None:
        if self.tabs and self.active in self.tabs:
            self.active = self.tabs[(self.tabs.index(self.active) + step) % len(self.tabs)]
            self.invalidate()

    def layout(self) -> Layout:
        ft = FormattedTextControl
        composer = HSplit([
            Window(ft(self.composer_top), height=1),
            VSplit([
                Window(ft(self.composer_prefix), width=4, dont_extend_width=True),
                FloatContainer(
                    Window(BufferControl(self.buffer, input_processors=[Placeholder(self)]), height=Dimension(min=1, max=6),
                           wrap_lines=True, get_line_prefix=None, dont_extend_height=True),
                    floats=[]),
                Window(ft(lambda: [(self.s.fg("gold"), "│")]), width=1),
            ]),
            Window(ft(self.composer_bottom), height=1),
        ])
        main = HSplit([
            Window(ft(self.tabs_bar), height=1),
            Window(self.lines, wrap_lines=False),
            ConditionalContainer(Window(ft(self.permission_window), height=lambda: Dimension.exact(self.permission_height())),
                                 filter=Condition(lambda: bool(self.view and self.view.__dict__.get("modal")) and not self.screen)),
            composer,
            Window(ft(self.status_line), height=1),
        ])
        body = VSplit([
            Window(ft(self.sidebar_text), width=SIDEBAR - 1),
            Window(ft(self.divider), width=1),
            main,
        ])
        root = FloatContainer(
            HSplit([Window(ft(self.top_bar), height=1), body, Window(ft(self.bottom_bar), height=1)]),
            floats=[Float(xcursor=True, ycursor=True, content=CompletionsMenu(max_height=10, scroll_offset=1))])
        return Layout(root, focused_element=self.buffer)

    def style(self) -> PtStyle:
        s = self.s
        return PtStyle.from_dict({
            "completion-menu": f"{s.bg('band')} {s.fg('text')}".strip() or "",
            "completion-menu.completion.current": f"{s.fg('accent')} reverse",
            "completion-menu.meta.completion": s.fg("meta"),
            "completion-menu.meta.completion.current": f"{s.fg('accent')} reverse",
        })

    async def ticker(self) -> None:
        last = 0.0
        while not self.quit:
            await asyncio.sleep(0.125)
            moving = any(v.working or v.__dict__.get("modal") for v in self.views.values())
            now = time.monotonic()
            if (moving and self.motion) or now - last > 15 or (self.notice and now > self.notice_until and self.notice):
                if self.notice and now > self.notice_until:
                    self.notice = ""
                last = now
                self.invalidate()

    async def run(self, first_session: dict, choices: list[dict], first_prompt: str | None = None) -> int:
        self.choices = choices
        try:
            self.choices, self.catalogs = await models.load(self.conn)
        except KairosError:
            self.catalogs = {}
        self.feed.start()
        await asyncio.wait_for(self.feed.connected.wait(), timeout=20)
        await asyncio.gather(self.refresh_sidebar(), self.refresh_quotas())
        await self.open_session(first_session["id"])
        self.app = Application(layout=self.layout(), key_bindings=self.bindings(), full_screen=True,
                               mouse_support=Condition(lambda: not self.copy_mode), style=self.style(),
                               color_depth=PT_DEPTH[self.palette.depth], refresh_interval=None)
        self.app.ttimeoutlen = 0.12
        self.app.timeoutlen = 0.6
        tick = asyncio.create_task(self.ticker())
        if first_prompt:
            asyncio.get_running_loop().call_later(0.3, lambda: self.spawn(self.send(first_prompt)))
        try:
            await self.app.run_async()
        finally:
            self.quit = True
            tick.cancel()
            await self.feed.stop()
        return 0


KEYS = [
    ("enter", "send (queues while a reply runs)"), ("alt+enter, ctrl+j", "new line"),
    ("esc", "stop the reply, reject a prompt, or close"), ("1-9", "answer a permission prompt"),
    ("pgup / pgdn, wheel", "scroll the chat"), ("ctrl+home / end", "top / newest"),
    ("ctrl+f", "find in this chat"), ("ctrl+o", "show or hide the last reply's actions"),
    ("alt+c", "copy mode: the mouse selects text in your terminal"), ("alt+p", "projects tree"),
    ("alt+left / right", "switch tabs"), ("alt+t / alt+w", "new tab / close tab"),
    ("f1", "this help"), ("ctrl+d", "leave (chats stay in Kairos)"),
]

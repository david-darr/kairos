"""The interactive terminal: Rich for drawing, prompt_toolkit for input.

Layout (spec section 4.5). Finished history goes to the terminal's own
scrollback, so native scroll, search and copy keep working. Only the live
area at the bottom is redrawn: the working line with Kip's slot, the
uncommitted tail, a permission prompt when one is open, the composer, and a
two-line footer (status, then key hints separated by ·).

Why not Textual: the spec's Phase 1 spike. Textual's inline mode does not
run on Windows; App._create_driver falls back to the full-screen
WindowsDriver, which takes the alternate screen and loses scrollback. This is
the spec's fallback, in the aider style, with the same palette.
"""
from __future__ import annotations

import asyncio
import io
import os
import shutil
import sys
import time

from prompt_toolkit import PromptSession
from prompt_toolkit.application import get_app_or_none
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.output.color_depth import ColorDepth
from prompt_toolkit.shortcuts import print_formatted_text
from prompt_toolkit.styles import Style as PtStyle
from rich.console import Console, Group
from rich.table import Table
from rich.text import Text

from . import chat, commands, forge, render
from .connection import Connection, KairosError, launch_app
from .live import LiveFeed, TurnEvent
from .mascot import Kip
from .palette import Palette
from .sanitize import clean, one_line

COLOR_SYSTEMS = {"truecolor": "truecolor", "256": "256", "16": "standard", "none": None}
PT_DEPTH = {"truecolor": ColorDepth.TRUE_COLOR, "256": ColorDepth.DEPTH_8_BIT, "16": ColorDepth.DEPTH_4_BIT,
            "none": ColorDepth.DEPTH_1_BIT}


def make_console(palette: Palette, width: int, file=None) -> Console:
    return Console(file=file or io.StringIO(), force_terminal=palette.depth != "none",
                   color_system=COLOR_SYSTEMS[palette.depth], width=width, theme=palette.theme(),
                   no_color=palette.depth == "none", legacy_windows=False, emoji=False, highlight=False,
                   markup=False, soft_wrap=False)


class Composer(Completer):
    """Slash commands, then @ references: files in a Forge session's folder,
    vault notes, documents and agents in a chat."""

    def __init__(self, repl: "Repl"):
        self.repl = repl

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if text.startswith("/") and " " not in text:
            typed = text[1:].lower()
            for name, args, about in commands.COMMANDS:
                if name.startswith(typed):
                    yield Completion("/" + name, start_position=-len(text), display=f"/{name} {args}".strip(),
                                     display_meta=about)
            return
        word = document.get_word_before_cursor(pattern=__import__("re").compile(r"@[^\s]*$"))
        if not word.startswith("@"):
            return
        needle = word[1:].casefold()
        shown = 0
        if self.repl.is_forge:
            for path in self.repl.files:
                if needle in path.casefold():
                    yield Completion("@" + path, start_position=-len(word), display_meta="file")
                    shown += 1
                    if shown >= 40:
                        return
        for label, ref in self.repl.references.items():
            if needle in label.casefold():
                yield Completion("@" + label, start_position=-len(word), display_meta=ref["kind"])
                shown += 1
                if shown >= 60:
                    return


class Repl:
    def __init__(self, conn: Connection, palette: Palette, kip: Kip, *, motion: bool = True, instance: str = ""):
        self.conn = conn
        self.palette = palette
        self.kip = kip
        self.motion = motion
        self.instance = instance
        self.session: dict = {}
        self.choices: list[dict] = []
        self.committer = render.StreamCommitter()
        self.turn = None
        self.turn_t0 = 0.0
        self.spoke = False
        self.own_prompt_pending = False
        self.modal: dict | None = None
        self.modal_note = ""
        self.answered_here: set[str] = set()
        self.running_tools: dict[str, dict] = {}
        self.last_tools: list[dict] = []
        self.kip_state = "idle"
        self.kip_until = 0.0
        self.pending: list[str] = []
        self.references: dict[str, dict] = {}
        self.files: list[str] = []
        self.feed_state = "connecting"
        self.t0 = time.monotonic()
        self.prompt: PromptSession | None = None
        self.feed = LiveFeed(conn, self.on_event, self.on_feed_state)
        self.quit = False

    # -- drawing ------------------------------------------------------------

    @property
    def width(self) -> int:
        return max(40, shutil.get_terminal_size((100, 30)).columns)

    def ansi(self, *renderables, end: str = "\n") -> str:
        console = make_console(self.palette, self.width)
        for item in renderables:
            console.print(item, end=end)
        return console.file.getvalue()

    def out(self, *renderables) -> None:
        self.pending.append(self.ansi(*renderables))

    def flush(self) -> None:
        if not self.pending:
            return
        text, self.pending = "".join(self.pending), []
        print_formatted_text(ANSI(text), end="", color_depth=PT_DEPTH[self.palette.depth])

    def invalidate(self) -> None:
        app = get_app_or_none()
        if app and app.is_running:
            app.invalidate()

    @property
    def working(self) -> bool:
        return self.turn is not None and self.turn.status == "processing"

    @property
    def is_forge(self) -> bool:
        return bool(self.session.get("forge"))

    def mascot_state(self) -> str:
        if self.modal:
            return "needs"
        if self.working:
            return "thinking"
        if time.monotonic() < self.kip_until:
            return self.kip_state
        return "idle"

    def live_area(self):
        now = time.monotonic()
        seconds = now - self.t0 if self.motion else 0.0
        parts = []
        if self.working or time.monotonic() < self.kip_until:
            state = self.mascot_state()
            if self.working:
                elapsed = now - self.turn_t0
                label = ("Waiting for you" if self.modal else "Stopping" if getattr(self.turn, "stopping", False)
                         else "Writing" if self.spoke else "Thinking")
                line = Text()
                line.append_text(self.kip.mark(state, seconds))
                line.append(" ")
                line.append_text(render.shimmer(label, seconds if self.motion else 2.0, self.palette))
                line.append("  ")
                line.append_text(render.braille_bar(seconds if self.motion else 0.4, self.palette))
                line.append(f"  {elapsed:4.0f}s", self.palette.style("meta"))
                rows = [line]
                for tool in list(self.running_tools.values())[-2:]:
                    rows.append(render.tool_cell(tool, self.palette))
                tail = self.committer.tail()
                if tail:
                    rows.append(Text("  " + one_line(tail, self.width - 18), self.palette.style("dim")))
            else:
                words = {"success": "Done", "error": "That did not finish"}.get(state, "")
                rows = [Text(words, self.palette.style("success" if state == "success" else "danger"))]
            slot = self.kip.slot(state, seconds)
            if slot:
                grid = Table.grid(padding=(0, 1))
                grid.add_column(width=12, no_wrap=True)
                grid.add_column()
                grid.add_row(Text("\n").join(slot), Group(*rows))
                parts.append(grid)
            else:
                parts.extend(rows)
        if self.modal:
            parts.append(render.permission_box(self.modal, self.palette, self.width, self.modal_note))
        mark = Text("  ❯ ", self.palette.style("gold", bold=True))
        parts.append(mark)
        return ANSI(self.ansi(Group(*parts), end=""))

    def toolbar(self):
        place = (forge.describe(self.session) if self.is_forge
                 else one_line(self.session.get("title") or "New chat", 50))
        mode = self.session.get("permission_mode", "base") if not self.is_forge else ""
        status = render.status_line(chat.model_label(self.session, self.choices), mode, place,
                                    self.working, self.palette)
        if self.feed_state != "connected":
            status.append("  · reconnecting", self.palette.style("warn"))
        if self.modal:
            count = len(self.modal.get("choices") or [])
            hints = [(f"1-{count}", "choose"), ("esc", "reject")]
        elif self.working:
            hints = [("esc", "stop"), ("ctrl+o", "tool details"), ("enter", "queue nothing: wait or stop")]
        else:
            hints = [("enter", "send"), ("alt+enter", "newline"), ("/", "commands"), ("@", "files" if self.is_forge else "notes"),
                     ("ctrl+d", "quit")]
        return ANSI(self.ansi(Group(status, render.footer(hints, self.palette)), end=""))

    # -- the feed -----------------------------------------------------------------

    def on_feed_state(self, state: str) -> None:
        self.feed_state = state
        if state == "unauthorized":
            self.out(Text("  Kairos no longer accepts this terminal (revoked or expired). Run kairos again to pair.",
                          self.palette.style("danger")))
        self.invalidate()

    def on_event(self, event: TurnEvent) -> None:
        if event.session_id != self.session.get("id"):
            return
        turn = event.turn
        if event.kind == "started":
            self.begin_turn(turn)
        elif self.turn is None or turn.turn_id != self.turn.turn_id:
            if turn.status == "processing":
                self.begin_turn(turn)
            else:
                return
        if event.kind == "text":
            self.write_blocks(self.committer.feed(event.text))
        elif event.kind == "tool_step":
            step = event.value or {}
            if step.get("phase") == "started":
                self.running_tools[str(step.get("id"))] = step
            else:
                self.running_tools.pop(str(step.get("id")), None)
                self.last_tools.append(step)
                self.out(render.tool_cell(step, self.palette))
        elif event.kind == "tool_event":
            value = event.value or {}
            self.last_tools.append(value)
            self.out(render.tool_cell(value, self.palette))
        elif event.kind == "permission":
            self.modal, self.modal_note = event.value, ""
        elif event.kind == "permission_closed":
            request = event.value or {}
            if self.modal and self.modal.get("id") == request.get("id"):
                if request.get("id") not in self.answered_here:
                    self.out(Text("  Answered in the app.", self.palette.style("meta")))
                self.modal = None
        elif event.kind == "finished":
            self.end_turn(turn)
        self.invalidate()

    def begin_turn(self, turn) -> None:
        if self.turn and self.turn.turn_id == turn.turn_id:
            return
        self.turn = turn
        self.turn_t0 = time.monotonic()
        self.committer = render.StreamCommitter()
        self.spoke = False
        self.running_tools.clear()
        self.last_tools = []
        if self.own_prompt_pending:
            self.own_prompt_pending = False
        else:
            # Started in the app window: show what was asked there.
            line = render.user_turn(turn.prompt, self.palette, self.width)
            self.out(line, Text("    (sent from the Kairos app)", self.palette.style("meta")))

    def write_blocks(self, blocks) -> None:
        if blocks and not self.spoke:
            self.spoke = True
            self.out(render.speaker(self.palette))
        for block in blocks:
            self.out(render.render_block(block, self.palette))

    def end_turn(self, turn) -> None:
        self.write_blocks(self.committer.finish())
        self.out(render.finished_line(turn.status, time.monotonic() - self.turn_t0, self.palette, turn.error))
        self.kip_state = "success" if turn.status == "done" else "error"
        self.kip_until = time.monotonic() + 2.0
        self.turn = None
        self.modal = None
        self.running_tools.clear()

    # -- answering ------------------------------------------------------------------

    async def answer(self, index: int | None) -> None:
        request = self.modal
        if not request:
            return
        choices = request.get("choices") or []
        if index is None:
            choice = chat.reject_choice(request)   # esc never means allow
        elif 0 <= index < len(choices):
            choice = choices[index]
        else:
            return
        if not choice:
            return
        self.answered_here.add(request["id"])
        self.modal_note = "Sending your answer…"
        self.invalidate()
        try:
            result = await chat.answer_permission(self.conn, request["id"], choice["id"])
        except KairosError as error:
            self.answered_here.discard(request["id"])
            self.modal_note = str(error)
            self.invalidate()
            return
        verb = "Rejected" if choice.get("behavior") == "deny" else "Allowed"
        note = f"  {verb}: {one_line(choice.get('label'), 60)}" if result == "answered" else "  Answered in the app."
        # Ahead of anything the reply has already queued, so the answer reads
        # before what follows from it.
        self.pending.insert(0, self.ansi(Text(note, self.palette.style("meta"))))
        if self.modal is request:
            self.modal = None
        self.invalidate()

    async def stop(self) -> None:
        if self.working:
            self.turn.stopping = True
            try:
                await chat.stop_turn(self.conn, self.session["id"])
            except KairosError as error:
                self.out(Text("  " + str(error), self.palette.style("danger")))

    # -- the loop -----------------------------------------------------------------------

    def bindings(self) -> KeyBindings:
        keys = KeyBindings()
        modal = Condition(lambda: self.modal is not None)
        working = Condition(lambda: self.working)

        for digit in "123456789":
            @keys.add(digit, filter=modal, eager=True)
            def _(event, digit=digit):
                asyncio.ensure_future(self.answer(int(digit) - 1))

        @keys.add("escape", filter=modal, eager=True)
        def _(event):
            asyncio.ensure_future(self.answer(None))

        @keys.add("escape", filter=working & ~modal, eager=True)
        def _(event):
            asyncio.ensure_future(self.stop())

        @keys.add("escape", "enter")
        @keys.add("c-j")
        def _(event):
            event.current_buffer.insert_text("\n")

        @keys.add("c-o")
        def _(event):
            self.show_tools()

        @keys.add("c-c")
        def _(event):
            if event.current_buffer.text:
                event.current_buffer.reset()
            elif self.working:
                asyncio.ensure_future(self.stop())
            else:
                event.app.exit(exception=EOFError)
        return keys

    async def ticker(self) -> None:
        """8 frames a second while something moves; the output tick drains
        committed text at a steady pace, as Codex's commit tick does."""
        frame = 0
        while not self.quit:
            await asyncio.sleep(0.04)
            self.flush()
            frame += 1
            if frame % 3 == 0 and (self.working or self.modal or time.monotonic() < self.kip_until + 0.2):
                if self.motion or frame % 30 == 0:
                    self.invalidate()

    async def run(self, session: dict, choices: list[dict], first_prompt: str | None = None) -> int:
        self.choices = choices
        await self.switch_to(session, show_history=bool(session.get("messages")))
        self.feed.start()
        self.prompt = PromptSession(
            message=self.live_area, bottom_toolbar=self.toolbar, key_bindings=self.bindings(),
            completer=Composer(self), complete_while_typing=True, color_depth=PT_DEPTH[self.palette.depth],
            style=PtStyle.from_dict({"bottom-toolbar": "noreverse", "bottom-toolbar.text": "noreverse"}),
            refresh_interval=None, erase_when_done=True)
        tick = asyncio.create_task(self.ticker())
        try:
            if first_prompt:
                await self.send(first_prompt)
            while not self.quit:
                try:
                    text = await self.prompt.prompt_async()
                except EOFError:
                    break
                except KeyboardInterrupt:
                    continue
                text = text.strip()
                if not text:
                    continue
                parsed = commands.parse(text)
                if parsed:
                    await self.command(*parsed)
                else:
                    await self.send(text)
                self.flush()
        finally:
            self.quit = True
            tick.cancel()
            await self.feed.stop()
            self.flush()
        return 0

    async def send(self, text: str) -> None:
        if self.working:
            self.out(Text("  A reply is still running. Press esc to stop it, or wait.", self.palette.style("warn")))
            return
        if not self.session.get("model_endpoint_id"):
            self.out(Text("  Choose a model first: /model", self.palette.style("warn")))
            return
        refs = [ref for label, ref in self.references.items() if f"@{label}" in text][:5]
        self.out(render.user_turn(text, self.palette, self.width))
        self.own_prompt_pending = True
        try:
            await chat.start_turn(self.conn, self.session["id"], text, refs)
        except KairosError as error:
            self.own_prompt_pending = False
            self.out(Text("  " + str(error), self.palette.style("danger")))

    async def switch_to(self, session: dict, show_history: bool = False) -> None:
        self.session = await chat.open_session(self.conn, session["id"])
        self.turn = None
        self.modal = None
        self.committer = render.StreamCommitter()
        title = one_line(self.session.get("title") or "New chat", 80)
        self.out(render.dotted_rule(self.width, self.palette),
                 Text(f"  {title}", self.palette.style("accent", bold=True)))
        if self.is_forge:
            self.out(Text("  " + forge.describe(self.session), self.palette.style("meta")))
            self.files = forge.files_here(self.session["forge"]["worktree"])
        if show_history:
            for message in (self.session.get("messages") or [])[-6:]:
                if message.get("role") == "user":
                    self.out(render.user_turn(message.get("content") or "", self.palette, self.width))
                elif message.get("role") == "assistant" and isinstance(message.get("content"), str):
                    committer = render.StreamCommitter()
                    blocks = committer.feed(message["content"]) + committer.finish()
                    self.out(render.speaker(self.palette), *[render.render_block(b, self.palette) for b in blocks])
        try:
            found = await self.conn.get("/api/chat/references", params={"q": "", "session_id": self.session["id"]})
            self.references = {one_line(r.get("label"), 60).replace(" ", "_"): r for r in found
                               if r.get("kind") in ("note", "document", "agent", "skill")}
        except KairosError:
            self.references = {}
        # Catch up if a turn is already running in this chat (started in the app).
        try:
            await self.feed._resync()
        except Exception:
            pass

    # -- commands ------------------------------------------------------------------------

    def note(self, text: str, role: str = "meta") -> None:
        self.out(Text("  " + text, self.palette.style(role)))

    async def pick(self, title: str, rows: list[tuple[str, str]]) -> int | None:
        """An inline numbered picker: type a number, or part of a name."""
        if not rows:
            self.note("Nothing to choose from.")
            return None
        self.out(Text("  " + title, self.palette.style("accent", bold=True)))
        for number, (label, detail_text) in enumerate(rows[:30], start=1):
            line = Text(f"  {number:>3}  ", self.palette.style("gold"))
            line.append(one_line(label, 60), self.palette.style("text"))
            if detail_text:
                line.append("  " + one_line(detail_text, 70), self.palette.style("meta"))
            self.out(line)
        self.flush()
        answer = await PromptSession().prompt_async(ANSI(self.ansi(Text("  choose ❯ ", self.palette.style("gold")), end="")))
        answer = answer.strip()
        if answer.isdigit() and 1 <= int(answer) <= min(len(rows), 30):
            return int(answer) - 1
        if answer:
            hits = [i for i, (label, _) in enumerate(rows) if answer.casefold() in label.casefold()]
            if len(hits) == 1:
                return hits[0]
        self.note("Nothing chosen.")
        return None

    async def command(self, name: str, rest: str) -> None:
        try:
            await self._command(name, rest)
        except KairosError as error:
            self.note(str(error), "danger")

    async def _command(self, name: str, rest: str) -> None:
        sid = self.session.get("id")
        if name in ("quit", "exit"):
            self.quit = True
            self.prompt.app.exit(exception=EOFError) if self.prompt and self.prompt.app.is_running else None
        elif name == "help":
            for cmd, args, about in commands.COMMANDS:
                line = Text(f"  /{cmd} {args}".ljust(34), self.palette.style("accent"))
                line.append(about, self.palette.style("dim"))
                self.out(line)
            self.out(render.footer([("enter", "send"), ("alt+enter", "newline"), ("esc", "stop or reject"),
                                    ("1-4", "answer a prompt"), ("ctrl+o", "tool details"), ("ctrl+d", "quit")], self.palette))
        elif name in commands.APP_ONLY:
            self.note(f"{commands.APP_ONLY[name]} lives in the Kairos app. Opening it now.")
            if not launch_app(self.instance or None, background=False):
                self.note("Open Kairos from the tray.")
        elif name == "new":
            await self.switch_to(await chat.new_session(self.conn))
            if self.choices and not self.session.get("model_endpoint_id"):
                self.note("Choose a model with /model.", "warn")
        elif name == "resume":
            target = await chat.find_session(self.conn, rest) if rest else await self.pick_session()
            if target:
                await self.switch_to(target, show_history=True)
            elif rest:
                self.note(f"No chat matches {one_line(rest, 60)}.", "warn")
        elif name == "rename":
            if not rest:
                self.note("Usage: /rename <title>", "warn")
                return
            await self.conn.call("PATCH", f"/api/sessions/{sid}", json={"title": rest[:120]})
            self.session["title"] = rest[:120]
            self.note("Renamed.")
        elif name == "model":
            await self.choose_model(rest)
        elif name == "mode":
            await self.set_mode(rest)
        elif name == "compact":
            self.note("Compacting…")
            await self.conn.post("/api/chat/compact", {"session_id": sid})
            self.note("Compacted.", "success")
        elif name == "rewind":
            messages = self.session.get("messages") or []
            last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=None)
            if last_user is None:
                self.note("Nothing to rewind.")
                return
            await self.conn.post(f"/api/sessions/{sid}/rewind", {"keep": last_user})
            self.session = await chat.open_session(self.conn, sid)
            self.note(f"Removed the last exchange, {len(messages) - last_user} message(s).")
        elif name == "fork":
            messages = self.session.get("messages") or []
            if not messages:
                self.note("Nothing to fork yet.")
                return
            fork = await self.conn.post(f"/api/sessions/{sid}/fork", {"through_index": len(messages) - 1})
            await self.switch_to(fork)
            self.note("Forked. This is the copy.")
        elif name == "stop":
            await self.stop()
        elif name == "forge":
            worktree = "--worktree" in rest.split()
            task = " ".join(w for w in rest.split() if w != "--worktree").strip()
            if not task:
                self.note("Usage: /forge <task> [--worktree]", "warn")
                return
            created = await forge.start(self.conn, task, worktree=worktree,
                                        model_endpoint_id=self.session.get("model_endpoint_id"))
            await self.switch_to(created)
            await self.send(task)
        elif name in ("diff", "undo", "revert"):
            if not self.is_forge:
                self.note("That works in a Forge session. Start one with /forge <task>.", "warn")
                return
            if name == "diff":
                result = await forge.changes(self.conn, sid)
                self.out(render.render_diff(result.get("files") or [], self.palette, self.width))
            elif name == "undo":
                done = await forge.undo_last(self.conn, sid)
                self.note(f"Undone: {len(done['result'].get('restored') or [])} file(s) restored.", "success")
            else:
                if not rest:
                    self.note("Usage: /revert <file>", "warn")
                    return
                await forge.revert_file(self.conn, sid, rest)
                self.note(f"Reverted {one_line(rest, 80)}.", "success")
        elif name == "agents":
            await self.agents(rest)
        elif name == "permissions":
            data = await self.conn.get("/api/permissions")
            rows = [[r["tool"], r.get("content") or "everything", "allow" if r.get("behavior") == "allow" else "deny",
                     "this chat" if r.get("scope") == "session" else "always"] for r in data.get("rules", [])]
            self.out(render.table_of(rows, ["tool", "covers", "decision", "scope"], self.palette))
            self.note(f"This chat's mode: {self.session.get('permission_mode', 'base')}. Revoke grants in the app: Settings > Permissions.")
        elif name == "tools":
            self.show_tools()
        elif name == "clear":
            print_formatted_text(ANSI("\x1b[2J\x1b[H"), end="")
        else:
            self.note(f"No command /{one_line(name, 30)}. Try /help.", "warn")

    def show_tools(self) -> None:
        if not self.last_tools:
            self.note("No tool steps in the last reply.")
            return
        for step in self.last_tools:
            self.out(render.tool_cell(step, self.palette, expanded=True))
        self.invalidate()

    async def pick_session(self) -> dict | None:
        rows = await chat.list_sessions(self.conn)
        rows.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        busy = set(self.feed.book.turns)
        labels = [(r.get("title") or "Chat",
                   " · ".join(x for x in (chat.model_label(r, self.choices),
                                          f"{r.get('message_count', 0)} messages", chat.age(r.get("updated_at")),
                                          "busy" if r["id"] in busy and self.feed.book.turns[r["id"]].status == "processing" else "")
                              if x)) for r in rows[:30]]
        index = await self.pick("Resume a chat", labels)
        return rows[index] if index is not None else None

    async def choose_model(self, wanted: str) -> None:
        self.choices = await chat.model_choices(self.conn)
        if wanted:
            choice = chat.match_model(self.choices, wanted)
            if not choice:
                self.note(f"No single model matches {one_line(wanted, 40)}.", "warn")
                return
        else:
            index = await self.pick("Choose a model", [(c.get("name") or c["id"], f"{c.get('model') or ''} {c.get('kind') or ''}")
                                                     for c in self.choices])
            if index is None:
                return
            choice = self.choices[index]
        await chat.set_model(self.conn, self.session["id"], choice)
        self.session = await chat.open_session(self.conn, self.session["id"])
        self.note(f"Model: {one_line(choice.get('name'), 60)}", "success")

    async def set_mode(self, wanted: str) -> None:
        sid = self.session["id"]
        if self.is_forge:
            mode = wanted or ("plan" if self.session["forge"].get("mode") == "build" else "build")
            if mode not in ("build", "plan"):
                self.note("Forge modes are build and plan.", "warn")
                return
            await self.conn.post(f"/api/forge/sessions/{sid}/mode", {"mode": mode})
        else:
            mode = wanted or ("auto" if self.session.get("permission_mode", "base") == "base" else "base")
            if mode not in ("base", "auto"):
                self.note("Chat modes are base and auto.", "warn")
                return
            await self.conn.post(f"/api/sessions/{sid}/permission-mode", {"mode": mode})
        self.session = await chat.open_session(self.conn, sid)
        self.note(f"Mode: {mode}", "success")

    async def agents(self, rest: str) -> None:
        words = rest.split(maxsplit=2)
        inbox = await self.conn.get("/api/agents/inbox")
        items = inbox.get("items") or []
        if words and words[0] in ("reply", "dismiss"):
            if len(words) < 2 or not words[1].isdigit() or not 1 <= int(words[1]) <= len(items):
                self.note("Usage: /agents reply <n> <text>, or /agents dismiss <n>", "warn")
                return
            item = items[int(words[1]) - 1]
            body = {"choice": words[0], "text": words[2] if len(words) > 2 else ""}
            result = await self.conn.post(f"/api/agents/inbox/{item['id']}/answer", body)
            self.note(one_line(result.get("next") or "Answered.", 200), "success")
            return
        agents = await self.conn.get("/api/agents")
        names = {a["id"]: a.get("name") for a in agents}
        rows = [[a.get("name") or "", a.get("status") or "", one_line(a.get("status_detail") or "", 50),
                 str(a.get("needs_you") or 0)] for a in agents]
        self.out(render.table_of(rows, ["agent", "state", "doing", "needs you"], self.palette))
        if items:
            self.out(Text("  Inbox", self.palette.style("accent", bold=True)))
            for number, item in enumerate(items, start=1):
                line = Text(f"  {number:>3}  ", self.palette.style("gold"))
                line.append(one_line(names.get(item.get("agent_id"), "agent"), 24) + "  ", self.palette.style("dim"))
                line.append(one_line(item.get("title"), 90), self.palette.style("text"))
                self.out(line)
            self.note("Answer with /agents reply <n> <text>, or /agents dismiss <n>.")
        else:
            self.note("Nothing in the inbox.")

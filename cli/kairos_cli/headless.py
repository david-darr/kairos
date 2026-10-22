"""kairos -p: one prompt, one reply, no interface (spec section 4.4).

Rich only, no prompt_toolkit, so it starts fast and pipes cleanly.

- --output-format text: the reply on stdout; tool steps and notes on stderr.
- --output-format json: one JSON object when the turn ends.
- --output-format stream-json: one JSON object per line as things happen.

Permissions: --permissions deny (the default) refuses every prompt the moment
it arrives, so an unattended run can never hang or silently approve.
--permissions ask prompts on the terminal, and only when there is one.

Exit codes: 0 done; 1 failed; 2 stopped, or a permission was refused.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time

from . import chat
from .connection import Connection, KairosError
from .live import LiveFeed, TurnEvent
from .sanitize import clean, one_line

EXIT_DONE, EXIT_FAILED, EXIT_STOPPED = 0, 1, 2


class Headless:
    def __init__(self, conn: Connection, fmt: str, permissions: str, out=None, err=None, stdin=None):
        self.conn = conn
        self.fmt = fmt
        self.permissions = permissions
        self.out = out or sys.stdout
        self.err = err or sys.stderr
        self.stdin = stdin or sys.stdin
        self.events: asyncio.Queue[TurnEvent] = asyncio.Queue()
        self.denied: list[dict] = []
        self.answered: list[dict] = []

    def emit(self, kind: str, **fields) -> None:
        if self.fmt == "stream-json":
            self.out.write(json.dumps({"type": kind, **fields}, ensure_ascii=False) + "\n")
            self.out.flush()

    def note(self, text: str) -> None:
        if self.fmt == "text":
            self.err.write(text + "\n")
            self.err.flush()

    async def run(self, session_id: str, prompt: str) -> int:
        feed = LiveFeed(self.conn, self.events.put_nowait)
        feed.start()
        try:
            try:
                await asyncio.wait_for(feed.connected.wait(), timeout=20)
            except asyncio.TimeoutError:
                raise KairosError("Could not reach Kairos's live feed.")
            started = time.monotonic()
            turn_id = await chat.start_turn(self.conn, session_id, prompt)
            self.emit("started", session_id=session_id, turn_id=turn_id)
            text_parts: list[str] = []
            steps: list[dict] = []
            while True:
                event = await self.events.get()
                if event.session_id != session_id or event.turn.turn_id != turn_id:
                    continue
                if event.kind == "text":
                    piece = clean(event.text)
                    text_parts.append(piece)
                    if self.fmt == "text":
                        self.out.write(piece)
                        self.out.flush()
                    self.emit("text", text=piece)
                elif event.kind in ("tool_step", "tool_event"):
                    value = event.value or {}
                    steps.append(value)
                    self.emit(event.kind, value=value)
                    if value.get("phase") != "started":
                        self.note(f"  > {one_line(value.get('name') or value.get('action') or 'tool', 30)} "
                                  f"{one_line(value.get('summary') or '', 80)}")
                elif event.kind == "permission":
                    await self.permission(event.value or {})
                elif event.kind == "finished":
                    status, error = event.turn.status, event.turn.error
                    if self.fmt == "text" and text_parts and not "".join(text_parts).endswith("\n"):
                        self.out.write("\n")
                    if error:
                        self.note(f"kairos: {one_line(error, 300)}")
                    self.emit("finished", status=status, error=error, denied=len(self.denied),
                              seconds=round(time.monotonic() - started, 2))
                    if self.fmt == "json":
                        self.out.write(json.dumps({
                            "session_id": session_id, "turn_id": turn_id, "status": status, "error": error,
                            "text": "".join(text_parts), "tool_steps": steps,
                            "permissions": {"denied": self.denied, "answered": self.answered},
                        }, ensure_ascii=False) + "\n")
                    self.out.flush()
                    if status == "failed":
                        return EXIT_FAILED
                    if status == "stopped" or self.denied:
                        return EXIT_STOPPED
                    return EXIT_DONE
        finally:
            await feed.stop()

    async def permission(self, request: dict) -> None:
        summary = {"id": request.get("id"), "tool": one_line(request.get("tool"), 60),
                   "title": one_line(request.get("title"), 200)}
        choice = None
        if self.permissions == "ask" and self.stdin.isatty() and self.err.isatty():
            choice = await asyncio.to_thread(self._ask, request)
        if choice is None:
            choice = chat.reject_choice(request)
        if choice is None:
            return
        result = await chat.answer_permission(self.conn, request["id"], choice["id"])
        entry = {**summary, "choice": choice["id"], "result": result}
        (self.denied if choice.get("behavior") == "deny" else self.answered).append(entry)
        self.emit("permission", **entry)
        self.note(f"kairos: {'refused' if choice.get('behavior') == 'deny' else 'allowed'} "
                  f"{summary['tool']} ({summary['title']})")

    def _ask(self, request: dict):
        choices = request.get("choices") or []
        self.err.write(f"\nKairos wants to use {one_line(request.get('tool'), 40)}: "
                       f"{one_line(request.get('title'), 200)}\n")
        if request.get("target"):
            self.err.write(f"  {one_line(request['target'], 200)}\n")
        for number, choice in enumerate(choices, start=1):
            self.err.write(f"  {number} {one_line(choice.get('label'), 80)}\n")
        self.err.write("Choose (anything else rejects): ")
        self.err.flush()
        answer = self.stdin.readline().strip()
        if answer.isdigit() and 1 <= int(answer) <= len(choices):
            return choices[int(answer) - 1]
        return None

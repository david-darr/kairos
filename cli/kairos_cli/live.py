"""The live feed: every chat turn the backend runs, as one more viewer.

Chat turns belong to the server and are broadcast to every viewer
(services/chat_live.py), so a turn started here shows in the app window and
the reverse. This module keeps the connection open, reconnects with the
snapshot route after a drop, and reduces packets into per-session turn state
the same way static/js/chatStream.js does: `started` opens a turn, `chunk`,
`tool_event` and `tool_step` append in revision order, `update` changes
status, permission and errors, and a `snapshot` replaces what it covers.

Consumers get TurnEvent objects on a queue; they never see raw packets.
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field

import httpx

from .sse import SSEParser


@dataclass
class Turn:
    session_id: str
    turn_id: str
    status: str = "processing"
    text: str = ""
    revision: int = 0
    permission: dict | None = None
    error: str | None = None
    tool_events: list = field(default_factory=list)
    tool_steps: list = field(default_factory=list)
    started_at: float = 0.0
    prompt: str = ""
    title: str = ""


@dataclass
class TurnEvent:
    kind: str              # started | text | tool_event | tool_step | permission | permission_closed | finished | resync
    session_id: str
    turn: Turn
    text: str = ""
    value: dict | None = None


class TurnBook:
    """Packet reducer. Pure, so it can be tested against recorded packets."""

    def __init__(self):
        self.turns: dict[str, Turn] = {}

    def _from_run(self, session_id: str, run: dict) -> Turn:
        return Turn(session_id=session_id, turn_id=run.get("turnId", ""), status=run.get("status", "processing"),
                    text=run.get("text", ""), revision=run.get("revision", 0), permission=run.get("permission"),
                    error=run.get("error"), tool_events=list(run.get("toolEvents") or []),
                    tool_steps=list(run.get("toolSteps") or []), started_at=run.get("startedAt") or 0.0,
                    prompt=run.get("prompt") or "", title=run.get("sessionTitle") or "")

    def apply(self, packet: dict) -> list[TurnEvent]:
        kind = packet.get("type")
        if kind == "snapshot":
            return self._snapshot(packet)
        if kind == "started":
            turn = self._from_run(packet["sessionId"], packet.get("run") or {})
            previous = self.turns.get(turn.session_id)
            self.turns[turn.session_id] = turn
            if previous and previous.turn_id == turn.turn_id:
                return []
            return [TurnEvent("started", turn.session_id, turn)]
        session_id = packet.get("sessionId")
        turn = self.turns.get(session_id) if session_id else None
        if turn is None or turn.turn_id != packet.get("turnId"):
            return [TurnEvent("resync", session_id or "", turn or Turn(session_id or "", ""))]
        revision = packet.get("revision") or 0
        if revision and revision <= turn.revision:
            return []
        if revision:
            turn.revision = revision
        if kind == "chunk":
            turn.text += packet.get("chunk", "")
            return [TurnEvent("text", session_id, turn, text=packet.get("chunk", ""))]
        if kind == "tool_event":
            turn.tool_events.append(packet.get("value"))
            return [TurnEvent("tool_event", session_id, turn, value=packet.get("value"))]
        if kind == "tool_step":
            turn.tool_steps.append(packet.get("value"))
            return [TurnEvent("tool_step", session_id, turn, value=packet.get("value"))]
        if kind == "update":
            return self._update(turn, packet.get("changes") or {})
        return []

    def _update(self, turn: Turn, changes: dict) -> list[TurnEvent]:
        out = []
        if "permission" in changes:
            before = turn.permission
            turn.permission = changes["permission"]
            if turn.permission and (not before or before.get("id") != turn.permission.get("id")):
                out.append(TurnEvent("permission", turn.session_id, turn, value=turn.permission))
            elif before and not turn.permission:
                out.append(TurnEvent("permission_closed", turn.session_id, turn, value=before))
        if "error" in changes and changes["error"]:
            turn.error = changes["error"]
        if "status" in changes and changes["status"] != "processing" and turn.status == "processing":
            turn.status = changes["status"]
            if turn.permission:
                out.append(TurnEvent("permission_closed", turn.session_id, turn, value=turn.permission))
                turn.permission = None
            out.append(TurnEvent("finished", turn.session_id, turn))
        return out

    def _snapshot(self, packet: dict) -> list[TurnEvent]:
        out = []
        runs = packet.get("runs") or {}
        for session_id, run in runs.items():
            fresh = self._from_run(session_id, run)
            known = self.turns.get(session_id)
            if known is None or known.turn_id != fresh.turn_id:
                self.turns[session_id] = fresh
                if fresh.status == "processing":
                    out.append(TurnEvent("started", session_id, fresh))
                    if fresh.text:
                        out.append(TurnEvent("text", session_id, fresh, text=fresh.text))
                    if fresh.permission:
                        out.append(TurnEvent("permission", session_id, fresh, value=fresh.permission))
                continue
            # Same turn: catch up on what a dropped connection missed.
            if len(fresh.text) > len(known.text) and fresh.text.startswith(known.text):
                missing = fresh.text[len(known.text):]
                known.text = fresh.text
                out.append(TurnEvent("text", session_id, known, text=missing))
            for step in fresh.tool_steps[len(known.tool_steps):]:
                known.tool_steps.append(step)
                out.append(TurnEvent("tool_step", session_id, known, value=step))
            for item in fresh.tool_events[len(known.tool_events):]:
                known.tool_events.append(item)
                out.append(TurnEvent("tool_event", session_id, known, value=item))
            known.revision = max(known.revision, fresh.revision)
            changes = {"permission": fresh.permission}
            if fresh.status != "processing":
                changes.update(status=fresh.status, error=fresh.error)
            out.extend(self._update(known, changes))
        for session_id, known in self.turns.items():
            if session_id not in runs and known.status == "processing":
                # Finished and pruned while we were away.
                out.extend(self._update(known, {"status": "done"}))
        return out


class LiveFeed:
    """Keeps /api/chat/live/events open and feeds a TurnBook."""

    def __init__(self, connection, on_event, on_state=None):
        self.connection = connection
        self.book = TurnBook()
        self.on_event = on_event
        self.on_state = on_state or (lambda state: None)
        self.connected = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._stopped = False
        self.down_since: float | None = None  # monotonic time the feed last lost its connection

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def _emit(self, packet: dict) -> None:
        for event in self.book.apply(packet):
            if event.kind == "resync":
                await self._resync()
                return
            result = self.on_event(event)
            if asyncio.iscoroutine(result):
                await result

    async def _resync(self) -> None:
        try:
            snapshot = await self.connection.get("/api/chat/live/snapshot")
        except Exception:
            return
        for event in self.book.apply(snapshot):
            result = self.on_event(event)
            if asyncio.iscoroutine(result):
                await result

    async def _run(self) -> None:
        delay = 0.5
        while not self._stopped:
            try:
                async with self.connection.client.stream(
                        "GET", "/api/chat/live/events",
                        timeout=httpx.Timeout(10.0, read=45.0)) as response:
                    if response.status_code == 401:
                        self.on_state("unauthorized")
                        return
                    response.raise_for_status()
                    parser = SSEParser()
                    self.connected.set()
                    self.down_since = None
                    self.on_state("connected")
                    delay = 0.5
                    async for chunk in response.aiter_text():
                        for item in parser.feed(chunk):
                            if item["event"] == "keepalive" or not isinstance(item.get("data"), dict):
                                continue
                            await self._emit(item["data"])
            except asyncio.CancelledError:
                raise
            except (httpx.HTTPError, json.JSONDecodeError):
                pass
            self.connected.clear()
            if self.down_since is None:
                self.down_since = time.monotonic()
            self.on_state("reconnecting")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5.0)

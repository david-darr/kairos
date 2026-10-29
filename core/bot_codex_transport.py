"""Codex's native approvals, answered by Kairos's broker (Bots redesign, Phase 3 unit U1, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, section 5.1.

Codex's own shell and file tools run inside Codex, so Kairos can only judge them if Codex asks first.
`codex app-server` speaks JSON-RPC over stdio and, when run with an approval policy that asks, sends
the client a request before each command or file change (item/commandExecution/requestApproval,
item/fileChange/requestApproval) and waits for {"decision": ...}. This module is the Kairos side of that
conversation: it turns each request into one core/permissions.py decide() call for the bot, so the
approval level, the grant ceiling, exact command rules, cards and the decision history all apply, and it
answers Codex with the person's decision.

What is here and tested: the request translator (ApprovalBridge), the JSON-RPC framing (Peer) and the
stale-answer rules. What is NOT here: the process driver that replaces `codex exec` for bot turns
(starting `codex app-server`, thread and turn requests, streaming items into Kairos's transcript).
Until that driver is written and its native mutation tests pass, available() is False and a bot at
anything below Full is refused on Codex before dispatch (core/bot_policy.py provider_refusal); it is never
run as Full.

Rules this file keeps:
- A request from a turn that is no longer current, or from a bridge that was closed, is declined without
  asking anyone. An old answer is never delivered to a new provider process.
- If the bot's policy changes while a request waits (a downgrade bumps the generation), an Allow does not
  go through: Codex gets a cancel.
- An error in this module declines. It never accepts by default.
"""
import asyncio
import json
import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

COMMAND = "item/commandExecution/requestApproval"
FILE_CHANGE = "item/fileChange/requestApproval"
ACCEPT, DECLINE, CANCEL = "accept", "decline", "cancel"
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


# Flip only when the process driver exists and its native mutation tests pass. While False, Codex bot turns
# below Full are refused before dispatch, so nothing ever runs `codex exec` at a level it cannot ask at.
DRIVER_READY = False


def available() -> bool:
    """Is the interactive Codex driver ready for bot turns?"""
    return DRIVER_READY


class ApprovalBridge:
    """Answers one bot turn's native approval requests through the broker.

    `generation` is read before each request and again after the person answers; a downgrade or a stop
    changes it (core/bot_policy.py enforce_downgrade), which voids waiting answers."""

    def __init__(self, *, bot_id: str, session_id: str, turn_id: str, cwd: Optional[str] = None,
                 generation: Optional[Callable[[], int]] = None, decide: Optional[Callable[..., Awaitable]] = None,
                 is_admin: bool = True, provider: str = "codex"):
        from core import bot_policy, permissions
        self.bot_id, self.session_id, self.turn_id, self.cwd = bot_id, session_id, turn_id, cwd
        self._generation = generation or (lambda: bot_policy.generation(session_id))
        self._decide = decide or permissions.decide
        self.is_admin = is_admin
        self.provider = provider
        self.closed = False
        self.asked = 0

    def close(self) -> None:
        self.closed = True

    def _stale(self, params: dict) -> bool:
        return self.closed or params.get("turnId") != self.turn_id

    async def handle(self, method: str, params: dict) -> dict:
        """The JSON-RPC result for one server request. Raises LookupError for a method it does not own."""
        if method not in (COMMAND, FILE_CHANGE):
            raise LookupError(method)
        params = params if isinstance(params, dict) else {}
        if self._stale(params):
            return {"decision": CANCEL if self.closed else DECLINE}
        started = self._generation()
        try:
            if method == COMMAND:
                command = params.get("command") or ""
                cwd = params.get("cwd") if isinstance(params.get("cwd"), str) else self.cwd
                arguments = {"command": command, **({"cwd": cwd} if cwd else {})}
                tool, title = "Bash", "Let Codex run a command"
                description = params.get("reason") or command[:300]
            else:
                root = params.get("grantRoot") if isinstance(params.get("grantRoot"), str) else None
                arguments = {"file_path": root} if root else {}
                tool, title = "Edit", "Let Codex change files"
                description = params.get("reason") or (f"Change files under {root}" if root else "Change files")
            self.asked += 1
            decision = await self._decide(
                surface=f"chat:{self.session_id}", tool=tool, arguments=arguments, title=title,
                description=description, is_admin=self.is_admin, agent_id=self.bot_id,
                bot_context={"provider": self.provider, "invocation_id": params.get("itemId"),
                             "cwd": (arguments.get("cwd") or self.cwd)})
        except Exception:
            logger.exception("codex approval failed; declining")
            return {"decision": DECLINE}
        if self._stale(params) or self._generation() != started:
            return {"decision": CANCEL}
        return {"decision": ACCEPT if decision.behavior == "allow" else DECLINE}


class Peer:
    """Newline-delimited JSON-RPC, server requests only: reads frames from `lines`, answers each request
    that has a handler, passes notifications on, and writes responses with `write`."""

    def __init__(self, bridge: ApprovalBridge, write: Callable[[str], Awaitable],
                 on_notification: Optional[Callable[[dict], None]] = None):
        self.bridge, self.write, self.on_notification = bridge, write, on_notification
        self._tasks: set = set()

    async def feed(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            message = json.loads(line)
        except ValueError:
            return
        if not isinstance(message, dict):
            return
        if "method" in message and "id" in message:
            task = asyncio.ensure_future(self._answer(message))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        elif "method" in message and self.on_notification:
            self.on_notification(message)

    async def _answer(self, message: dict) -> None:
        try:
            result = await self.bridge.handle(message["method"], message.get("params"))
            frame = {"jsonrpc": "2.0", "id": message["id"], "result": result}
        except LookupError:
            frame = {"jsonrpc": "2.0", "id": message["id"],
                     "error": {"code": METHOD_NOT_FOUND, "message": f"{message['method']} is not handled here"}}
        except Exception as error:
            logger.exception("codex request failed")
            frame = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": INTERNAL_ERROR, "message": str(error)}}
        await self.write(json.dumps(frame) + "\n")

    async def drain(self) -> None:
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    def cancel_all(self) -> None:
        self.bridge.close()
        for task in list(self._tasks):
            task.cancel()

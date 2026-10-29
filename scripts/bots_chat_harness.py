"""A fake provider and a small world for Bots conversation tests (Phase 1, U1).

Real session transactions and real turn handling, a scripted model. Import it
AFTER setting JARVIS_DATA_DIR to a throwaway folder.

    h = Harness(self)            # inside IsolatedAsyncioTestCase.asyncSetUp
    bot = h.bot("Scout", thread_limit=2)
    sid = h.thread(bot)
    result = await h.send(sid, "hello")
    await h.idle()

A user message containing [hold] makes its turn wait until h.release(); [fail]
makes it raise; [reply:text] sets the reply text. Every prompt the model was
sent is kept in h.prompts. Domain events are kept in h.events (never written).
"""
import asyncio
import contextlib
import re
import time
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from core import bot_message_tree as tree, runs
from core.session_manager import session_manager
from services import bot_chat_service, bot_goal_runs, bot_threads, chat_live, chat_service
from services.agent_service import agent_service

OWNER = "david"
CLAUDE = {"id": "claude", "name": "Fake model", "kind": "claude_cli"}


@contextlib.asynccontextmanager
async def _no_checkpoint(*args, **kwargs):
    yield


class ScriptedBrain:
    model = "fake"
    last_usage = None

    def __init__(self, harness):
        self.h = harness

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def cancel(self):
        return SimpleNamespace(confirmed=True, how="scripted")

    async def events(self, prompt, stream=True):
        h = self.h
        h.prompts.append(prompt)
        if "[hold]" in prompt:
            gate = asyncio.Event()
            if h.open:
                gate.set()
            h.gates.append(gate)
            await gate.wait()
        if "[fail]" in prompt:
            raise RuntimeError("scripted failure")
        match = re.search(r"\[reply:(.*?)\]", prompt, re.DOTALL)
        if h.replies:
            reply = h.replies.pop(0)
        elif match:
            reply = match.group(1)
        else:
            reply = "ok " + " ".join(prompt.split())[:20]
        for start in range(0, len(reply), 7):
            yield runs.text(reply[start:start + 7])
            await asyncio.sleep(0)
        yield runs.result(True)


class Harness:
    def __init__(self, testcase):
        self.prompts, self.gates, self.events, self.replies = [], [], [], []
        self.open = False  # once released, later holds pass straight through
        self.brain = ScriptedBrain(self)
        self.threads = []
        self.test = testcase
        self._patch(patch.dict(agent_service._agents, {}, clear=True))
        self._patch(patch("core.model_endpoints.list_endpoints", return_value=[CLAUDE]))
        self._patch(patch("core.model_endpoints.get_endpoint", side_effect=lambda i: CLAUDE if i == "claude" else None))
        self._patch(patch.object(chat_service, "_get_brain", AsyncMock(return_value=(self.brain, False))))
        self._patch(patch.object(chat_service, "_resolve_endpoint", return_value=CLAUDE))
        self._patch(patch.object(chat_service, "_compact_if_nearly_full", AsyncMock(return_value=False)))
        self._patch(patch.object(chat_service, "_reply_hook"))
        self._patch(patch.object(chat_service.file_checkpoints, "around_turn", _no_checkpoint))
        self._patch(patch.object(chat_service, "_record_turn_telemetry"))
        self._patch(patch("core.events.emit", side_effect=lambda kind, message="", level="info", **extra:
                          self.events.append({"type": kind, "message": message, **extra})))
        testcase.addCleanup(self.close)

    def _patch(self, patcher):
        patcher.start()
        self.test.addCleanup(patcher.stop)

    def close(self):
        for gate in self.gates:
            gate.set()
        chat_live._runs.clear()
        chat_live._tasks.clear()
        chat_service._busy.clear()
        bot_chat_service._HOLDS.clear()
        bot_goal_runs._RUNS.clear()
        for sid in self.threads:
            if session_manager.get_session(sid):
                session_manager.delete_session(sid)

    # -- world --------------------------------------------------------------------

    def bot(self, name="Scout", thread_limit=3):
        bot = agent_service.create(name, role="Tests")
        agent_service._agents[bot["id"]]["thread_limit"] = thread_limit
        return agent_service.get(bot["id"])

    def thread(self, bot, title="Chat"):
        time.sleep(0.01)
        session = bot_threads.create_thread(bot, OWNER, title)
        self.threads.append(session["id"])
        tree.ensure(session["id"])
        return session["id"]

    def session(self, sid):
        return session_manager.get_session(sid)

    def leaf(self, sid):
        return self.session(sid)["thread"]["active_leaf_id"]

    def path(self, sid):
        return tree.ancestry(self.session(sid))

    def texts(self, sid):
        return [(m["role"], m["content"]) for m in self.path(sid) if not m.get("display_only")]

    def queue(self, sid):
        return bot_chat_service.queue_view(OWNER, sid)

    # -- acting -------------------------------------------------------------------

    async def send(self, sid, text, send_id=None, leaf="current", **extra):
        body = {"send_id": send_id or uuid.uuid4().hex, "text": text,
                "expected_leaf_id": self.leaf(sid) if leaf == "current" else leaf, **extra}
        return await bot_chat_service.send(OWNER, sid, body)

    def release(self, index=None):
        """Let held turns finish: one (by order of arrival), or all (now and any that start later)."""
        if index is None:
            self.open = True
        for gate in (self.gates if index is None else [self.gates[index]]):
            gate.set()

    async def held(self, count=1, timeout=3.0):
        """Wait until `count` turns are waiting on their gate."""
        deadline = time.monotonic() + timeout
        while len([g for g in self.gates if not g.is_set()]) < count:
            if time.monotonic() > deadline:
                raise AssertionError(f"only {len([g for g in self.gates if not g.is_set()])} turn(s) held")
            await asyncio.sleep(0.005)

    async def idle(self, timeout=5.0):
        """Wait until no turn runs, no drain is pending and no goal is working."""
        deadline = time.monotonic() + timeout
        while True:
            busy = (any(r["status"] == "processing" or not r.get("_settled") for r in chat_live._runs.values())
                    or chat_service._busy or bot_chat_service._TASKS or bot_goal_runs._TASKS
                    or any(g["status"] == "working" for g in bot_goal_runs._RUNS.values()))
            if not busy:
                await asyncio.sleep(0.01)
                if not (bot_chat_service._TASKS or chat_service._busy):
                    return
            if time.monotonic() > deadline:
                raise AssertionError("conversation did not settle")
            await asyncio.sleep(0.005)

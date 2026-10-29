"""Shared setup for the Bots Phase 3 approval tests (unit U1): a temp data folder, bots with sessions,
and an isolated copy of every store the approval layer writes. Import it before any app module."""
import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-approvals-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = DATA.name
os.environ.pop("JARVIS_DESKTOP_SECRET", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import bot_outbound, bot_policy, permissions, settings, tool_registry  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from core.turn_taint import TurnTaint  # noqa: E402
from services import bot_grants  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

_counter = [0]


def make_bot(name, **extra):
    _counter[0] += 1
    bot = agent_service.create(f"{name} {_counter[0]}", **extra)["id"]
    bot_grants.reset_cache()
    return bot


def make_thread(bot, owner=None, **thread):
    session = session_manager.create_session()
    session_manager.set_agent(session["id"], bot, "")
    if thread:
        session_manager.set_thread(session["id"], **thread)
    return session["id"]


def ctx_for(bot, session=None, **extra):
    return tool_registry.ToolContext(session_id=session, is_admin=True, turn_taint=TurnTaint(), agent_id=bot,
                                     owner_user="local", **extra)


def set_mode(bot, mode):
    """Write a level straight into the record, as the tests' stand-in for 'the bot is at this level'."""
    agent_service._agents[bot]["approval_mode"] = mode


class FakeCards:
    """A stand-in for services/bot_cards.py's store: records what the broker tells it."""

    def __init__(self):
        self.opened, self.settled, self.generations, self.closed = [], [], [], []

    def open_from_payload(self, payload, **kw):
        self.opened.append((payload, kw))
        return {"id": "card" + str(len(self.opened))}

    def settle_for_request(self, request_id, status="unavailable", *, reason=""):
        self.settled.append((request_id, status, reason))

    def set_generation(self, thread_id, generation):
        self.generations.append((thread_id, generation))
        return []

    def close_thread(self, thread_id, **kw):
        self.closed.append((thread_id, kw))
        return []


class ApprovalCase(unittest.IsolatedAsyncioTestCase):
    """One isolated set of approval stores per test."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=DATA.name)
        root = self.dir.name
        self.patches = [
            patch.object(permissions, "PERMISSIONS_FILE", os.path.join(root, "permissions.json")),
            patch.object(bot_policy, "STATE_FILE", os.path.join(root, "bot_approval_state.json")),
            patch.object(bot_policy, "DECISIONS_DIR", os.path.join(root, "bot_decisions")),
            patch.object(bot_outbound, "DB_FILE", os.path.join(root, "bot_outbound.sqlite3")),
        ]
        for item in self.patches:
            item.start()
        bot_outbound.reset_for_test()
        bot_policy._state_cache.update(path=None, mtime=None, data=None, corrupt=False)
        bot_policy._started.clear()
        bot_policy._migrated_for.clear()
        bot_policy._inflight.clear()
        bot_policy._generation.clear()
        bot_policy.set_reviewer(None)
        permissions._session_rules.clear()
        permissions._channels.clear()
        permissions._pending.clear()
        settings.update_settings(disabled_tools=[])
        bot_grants.reset_cache()
        self.cards = None

    def tearDown(self):
        for item in self.patches:
            item.stop()
        bot_policy.set_reviewer(None)
        self.dir.cleanup()

    def fake_cards(self):
        self.cards = FakeCards()
        patcher = patch.object(bot_policy, "cards", lambda: self.cards)
        patcher.start()
        self.addCleanup(patcher.stop)
        return self.cards

    def with_run(self, run):
        """Pretend the code is inside an unattended routine run."""
        patcher = patch.object(bot_policy, "run_context", lambda bot_id=None: dict(run) if run else None)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def asked(self, surface, **kw):
        """Start a decide() on a surface with a window open, and return (task, the request it showed)."""
        queue = permissions.open_channel(surface)
        task = asyncio.create_task(permissions.decide(surface=surface, **kw))
        payload = await asyncio.wait_for(queue.get(), timeout=5)
        return task, payload

    async def decide(self, bot, session, tool, arguments=None, **kw):
        kw.setdefault("is_admin", True)
        return await permissions.decide(surface=f"chat:{session}", tool=tool, arguments=arguments or {},
                                        agent_id=bot, **kw)


__all__ = ["ApprovalCase", "FakeCards", "make_bot", "make_thread", "ctx_for", "set_mode", "asyncio", "patch",
           "types", "unittest", "os", "DATA", "bot_policy", "bot_outbound", "permissions", "agent_service",
           "session_manager", "tool_registry", "bot_grants", "settings", "tempfile"]

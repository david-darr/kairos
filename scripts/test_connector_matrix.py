"""Every registered connector kind goes through the same hub contract.

test_connectors.py proves each platform's own protocol (parsing, signatures,
posting format). This file proves the shared promises hold for EVERY kind in
core.connectors.KINDS, so a new platform is covered the moment it registers:
direction is honest (send-only kinds cannot receive, two-way kinds can),
senders are admitted by the allow list or the open switch, agents are reached
only by allowed senders on a closed connector, deliveries are split at the
platform's limit and a failure returns False with an event, a crashing
receiver reports why and retries by itself, secrets are encrypted at rest and
never shown, required fields are enforced, and every kind has a platform test.

Fixtures only: no account, token or network. Real platform proof is MANUAL
per connector (sign in with a real bot/app, receive a message, see a delivery
land); the list is in the report.

    .venv\\Scripts\\python.exe scripts\\test_connector_matrix.py
"""
import asyncio
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

_DATA = tempfile.TemporaryDirectory(prefix="g7-matrix-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import httpx
from fastapi.testclient import TestClient

from app import app
from core.auth import SESSION_COOKIE_NAME, auth_manager
from core.connectors import KINDS, store
from core.connectors.base import Connector, Inbound
from core.connectors.hub import Hub, chunk
from routes import connector_routes
from services.agent_service import agent_service

logging.disable(logging.CRITICAL)
OWNER, STRANGER = "owner-1", "stranger-9"


def sample(cls, with_target=True):
    values = {}
    for f in cls.fields:
        if f.kind == "number":
            values[f.key] = "5"
        elif f.kind == "bool":
            values[f.key] = "false"
        elif f.required or (with_target and f.key == cls.target_field):
            values[f.key] = f"https://x.test/{f.key}" if "url" in f.key or f.key in ("server", "homeserver", "reply_url") else f"v-{f.key}"
    return values


class Matrix(unittest.TestCase):
    def make(self, kind, **options):
        cls = KINDS[kind]
        hub = Hub(KINDS, transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
        record = store.create(kind, kind, sample(cls), cls.fields, options.get("allowed", [OWNER]), options.get("open", False), None)
        self.addCleanup(store.delete, record["id"])
        return hub, record, hub.build(record)

    def each(self, check):
        for kind in KINDS:
            with self.subTest(kind=kind):
                check(kind, KINDS[kind])

    # -- the registry itself ---------------------------------------------------

    def test_each_kind_declares_its_direction_honestly(self):
        def check(kind, cls):
            self.assertTrue(cls.label and cls.description and cls.fields, "shown in Settings, so it needs a name, text and fields")
            self.assertGreater(cls.message_limit, 100)
            self.assertTrue(any(f.required for f in cls.fields), "a connector with nothing required could be created empty")
            if cls.webhook:
                self.assertTrue(cls.two_way, "only a two-way platform receives webhooks")
                self.assertIsNot(cls.handle_webhook, Connector.handle_webhook, "a webhook kind must verify and parse its own webhook")
            elif cls.two_way:
                self.assertIsNot(cls.run, Connector.run, "a two-way kind without a webhook must run a receive loop")
            else:
                self.assertIs(cls.run, Connector.run, "a send-only kind must not receive")
                self.assertIsNot(cls.send, Connector.send)
            if cls.two_way:
                self.assertTrue(cls.target_field, "a two-way kind needs a named place for deliveries")
                self.assertIn(cls.target_field, {f.key for f in cls.fields})
        self.each(check)

    def test_every_kind_has_a_platform_test_naming_it(self):
        text = (ROOT / "scripts" / "test_connectors.py").read_text(encoding="utf-8")
        for kind in KINDS:
            with self.subTest(kind=kind):
                self.assertTrue(f'"{kind}"' in text or f"'{kind}'" in text, f"{kind} has no fixture test in test_connectors.py")

    # -- admission and routing ------------------------------------------------------

    def run_receive(self, kind, sender, text="hello", **options):
        hub, record, adapter = self.make(kind, **options)
        adapter.record.update(options.get("record_changes", {}))
        turn = AsyncMock(return_value="reply")
        sent = []
        adapter.send = AsyncMock(side_effect=lambda conversation, piece: sent.append((conversation, piece)))
        with patch("services.chat_service.send_message", turn), patch("core.tab_hooks.emit_message"):
            asyncio.run(hub.receive(adapter, Inbound(conversation="room-1", sender=sender, text=text)))
        return turn, sent, hub, record

    def test_the_allow_list_and_open_switch_admit_the_same_way_everywhere(self):
        def check(kind, cls):
            if not cls.two_way:
                return
            turn, sent, hub, record = self.run_receive(kind, OWNER)
            self.assertEqual(turn.call_count, 1, "an allowed sender is answered")
            self.assertEqual(sent, [("room-1", "reply")], "the reply goes back to the conversation it came from")
            self.assertIn("last_message_at", hub.status[record["id"]], "delivery status records when a message last arrived")
            turn, sent, *_ = self.run_receive(kind, STRANGER)
            self.assertEqual((turn.call_count, sent), (0, []), "a stranger on a closed connector is ignored")
            turn, sent, *_ = self.run_receive(kind, STRANGER, open=True)
            self.assertEqual(turn.call_count, 1, "an open connector answers anyone")
            self.assertFalse(turn.call_args.kwargs.get("is_admin", False), "a connector chat is never an admin chat")
        self.each(check)

    def test_agents_answer_only_to_allowed_senders_on_a_closed_connector(self):
        agent = agent_service.create("Scout")
        self.addCleanup(agent_service.delete, agent["id"])

        def check(kind, cls):
            if not cls.two_way:
                return
            with patch.object(agent_service, "chat_endpoint", return_value="claude"):
                turn, *_ = self.run_receive(kind, OWNER, "Scout, status?")
                self.assertEqual((turn.call_args.args[1], turn.call_args.kwargs.get("is_admin")), ("status?", True))
                turn, *_ = self.run_receive(kind, STRANGER, "Scout, status?", open=True)
                self.assertFalse(turn.call_args.kwargs.get("is_admin", False), "an open connector never reaches an agent")
        self.each(check)

    def test_a_blank_message_and_a_failing_turn_are_handled(self):
        def check(kind, cls):
            if not cls.two_way:
                return
            turn, sent, *_ = self.run_receive(kind, OWNER, "   ")
            self.assertEqual((turn.call_count, sent), (0, []))
            hub, record, adapter = self.make(kind)
            adapter.send = AsyncMock()
            with patch("services.chat_service.send_message", AsyncMock(side_effect=RuntimeError("boom"))), patch("core.tab_hooks.emit_message"):
                asyncio.run(hub.receive(adapter, Inbound(conversation="c", sender=OWNER, text="hi")))
            self.assertIn("Something went wrong", adapter.send.call_args.args[1], "the person is told, not left in silence")
        self.each(check)

    # -- delivery ----------------------------------------------------------------------

    def test_deliveries_are_split_at_the_platform_limit_and_a_failure_is_false(self):
        def check(kind, cls):
            hub, record, adapter = self.make(kind)
            hub.adapters[record["id"]] = adapter
            sent = []
            adapter.send = AsyncMock(side_effect=lambda conversation, piece: sent.append((conversation, piece)))
            long_text = ("word " * (cls.message_limit // 5 * 2 + 40)).strip()
            self.assertTrue(asyncio.run(hub.deliver(record["id"], long_text)))
            self.assertGreaterEqual(len(sent), 2)
            self.assertTrue(all(len(piece) <= cls.message_limit for _, piece in sent), "no piece exceeds the platform's limit")
            self.assertEqual({conversation for conversation, _ in sent}, {adapter.default_target}, "one destination per delivery")
            # The split is paragraph, line, then a hard cut (hub.chunk), so a long run of words may be cut mid-word:
            # nothing may be lost, but spacing at the cut is not asserted.
            self.assertEqual("".join(p for _, p in sent).replace(" ", "").replace(chr(10), ""), long_text.replace(" ", ""), "nothing is lost in the split")
            adapter.send = AsyncMock(side_effect=RuntimeError("platform said no"))
            with patch("core.connectors.hub.events.emit") as emit:
                self.assertFalse(asyncio.run(hub.deliver(record["id"], "x")), "a failed delivery is False, never an exception")
                self.assertEqual(emit.call_args.args[0], "connector.delivery_failed")
            self.assertFalse(asyncio.run(hub.deliver("no-such-connector", "x")))
        self.each(check)

    def test_a_connector_with_no_destination_returns_false(self):
        for kind, cls in KINDS.items():
            if not cls.two_way:
                continue
            with self.subTest(kind=kind):
                hub = Hub(KINDS)
                record = store.create(kind, kind, sample(cls, with_target=False), cls.fields, [OWNER], False, None)
                self.addCleanup(store.delete, record["id"])
                hub.adapters[record["id"]] = hub.build(record)
                self.assertEqual(hub.adapters[record["id"]].default_target, "")
                self.assertFalse(asyncio.run(hub.deliver(record["id"], "x")))

    def test_the_channel_list_offers_each_enabled_kind_as_a_delivery_target(self):
        from core.channels import registry
        ids = {}
        for kind, cls in KINDS.items():
            record = store.create(kind, kind, sample(cls), cls.fields, [OWNER], False, None)
            self.addCleanup(store.delete, record["id"])
            ids[kind] = f"conn:{record['id']}"
        listed = {c["id"] for c in registry.list_channels()}
        for kind, ident in ids.items():
            with self.subTest(kind=kind):
                self.assertIn(ident, listed)
        record = store.get_record(ids["wecom"].removeprefix("conn:"))
        store.update(record["id"], KINDS["wecom"].fields, enabled=False)
        self.assertNotIn(ids["wecom"], {c["id"] for c in registry.list_channels()}, "a disabled connector is not a target")

    # -- reconnect and status ---------------------------------------------------------

    def test_a_crashing_receiver_reports_why_and_reconnects_by_itself(self):
        async def scenario(kind, cls):
            hub, record, adapter = self.make(kind)
            runs = []

            async def run(self_):
                runs.append(1)
                if len(runs) == 1:
                    raise RuntimeError(f"{kind} token rejected")
                await asyncio.Event().wait()
            with patch("core.connectors.hub.RESTART_BACKOFF", (0.15,)), patch.object(cls, "run", run):
                await hub.start(record["id"])
                await asyncio.sleep(0.04)
                during = dict(hub.status[record["id"]])
                await asyncio.sleep(0.3)
                after = dict(hub.status[record["id"]])
                await hub.stop(record["id"])
            return during, after, len(runs), dict(hub.status[record["id"]])

        for kind, cls in KINDS.items():
            if not cls.two_way or cls.webhook:
                continue
            with self.subTest(kind=kind):
                during, after, runs, stopped = asyncio.run(scenario(kind, cls))
                self.assertEqual(during["state"], "error")
                self.assertIn(f"{kind} token rejected", during["detail"])
                self.assertEqual((after["state"], runs), ("listening", 2))
                self.assertEqual(stopped["state"], "off")

    def test_status_names_the_listening_mode_for_each_direction(self):
        async def status(kind):
            hub, record, adapter = self.make(kind)

            async def idle(self_): await asyncio.Event().wait()
            with patch.object(KINDS[kind], "run", idle):
                await hub.start(record["id"])
                await asyncio.sleep(0.02)
                state = hub.status[record["id"]]["state"]
                await hub.stop(record["id"])
            return state
        for kind, cls in KINDS.items():
            with self.subTest(kind=kind):
                expected = "connected" if (not cls.two_way or cls.webhook) else "listening"
                self.assertEqual(asyncio.run(status(kind)), expected)

    def test_a_disabled_or_deleted_connector_starts_nothing(self):
        async def scenario():
            hub, record, _ = self.make("webhook")
            store.update(record["id"], KINDS["webhook"].fields, enabled=False)
            await hub.start(record["id"])
            off = hub.status[record["id"]]["state"], record["id"] in hub.tasks
            store.delete(record["id"])
            await hub.start(record["id"])
            return off, hub.status[record["id"]]["state"]
        off, gone = asyncio.run(scenario())
        self.assertEqual(off, ("off", False))
        self.assertEqual(gone, "off")

    # -- secrets and validation ---------------------------------------------------------

    def test_secrets_are_encrypted_at_rest_and_never_shown(self):
        for kind, cls in KINDS.items():
            with self.subTest(kind=kind):
                values = {k: f"SECRET-{kind}-{k}" if f.secret else v for (k, v), f in zip(sample(cls).items(), [next(x for x in cls.fields if x.key == k) for k in sample(cls)])}
                record = store.create(kind, kind, values, cls.fields, [], False, None)
                self.addCleanup(store.delete, record["id"])
                raw = Path(store.CONNECTORS_FILE).read_text(encoding="utf-8")
                shown = repr(store.public(store.get_record(record["id"]), cls.fields))
                for f in cls.fields:
                    if f.secret and f.key in values:
                        self.assertNotIn(values[f.key], raw, f"{f.key} is stored in plain text")
                        self.assertNotIn(values[f.key], shown, f"{f.key} is shown")
                        self.assertTrue(store.public(store.get_record(record["id"]), cls.fields)["secrets_set"][f.key])
                        self.assertEqual(store.secrets_of(store.get_record(record["id"]))[f.key], values[f.key])

    def test_required_fields_and_unknown_settings_are_refused(self):
        def check(kind, cls):
            for f in cls.fields:
                if f.required:
                    partial = {k: v for k, v in sample(cls).items() if k != f.key}
                    with self.assertRaises(ValueError, msg=f"{kind} created without {f.key}"):
                        store.create(kind, kind, partial, cls.fields, [], False, None)
            with self.assertRaises(ValueError):
                store.create(kind, kind, {**sample(cls), "nope": "x"}, cls.fields, [], False, None)
            with self.assertRaises(ValueError):
                store.create(kind, "  ", sample(cls), cls.fields, [], False, None)
        self.each(check)


class Routes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}; auth_manager._sessions = {}
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)
        auth_manager.create_user("member", "member-password-1")
        cls.admin, cls.member, cls.anon = TestClient(app), TestClient(app), TestClient(app)
        cls.admin.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("boss"))
        cls.member.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("member"))

    def test_managing_connectors_is_admin_only_for_every_kind_and_secrets_stay_hidden(self):
        for method, path, body in (("get", "", None), ("get", "/kinds", None), ("post", "", {"kind": "webhook"}),
                                   ("patch", "/x", {"name": "y"}), ("delete", "/x", None), ("post", "/x/test", {})):
            for who, c in (("member", self.member), ("anonymous", self.anon)):
                got = getattr(c, method)("/api/connectors" + path, **({} if body is None else {"json": body}))
                self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")
        with patch.object(connector_routes.hub, "start", new=AsyncMock()), patch.object(connector_routes.hub, "stop", new=AsyncMock()):
            for kind, cls in KINDS.items():
                with self.subTest(kind=kind):
                    values = {k: (f"S3CRET-{kind}" if next(x for x in cls.fields if x.key == k).secret else v) for k, v in sample(cls).items()}
                    made = self.admin.post("/api/connectors", json={"kind": kind, "name": f"{kind} test", "values": values, "allowed_senders": [OWNER]})
                    self.assertEqual(made.status_code, 200, made.text)
                    self.assertNotIn(f"S3CRET-{kind}", made.text)
                    shown = made.json()
                    self.assertEqual((shown["two_way"], shown["webhook"]), (KINDS[kind].two_way, KINDS[kind].webhook))
                    self.assertEqual(bool(shown["webhook_path"]), KINDS[kind].webhook)
                    self.assertNotIn(f"S3CRET-{kind}", self.admin.get("/api/connectors").text)
                    self.assertEqual(self.admin.delete(f"/api/connectors/{shown['id']}").status_code, 200)

    def test_a_connector_test_message_needs_a_destination_and_reports_a_failed_send(self):
        record = store.create("telegram", "tg", {"bot_token": "t"}, KINDS["telegram"].fields, [OWNER], False, None)
        self.addCleanup(store.delete, record["id"])
        self.assertEqual(self.admin.post(f"/api/connectors/{record['id']}/test", json={}).status_code, 400, "no destination set")
        store.update(record["id"], KINDS["telegram"].fields, values={"default_chat_id": "1"})
        with patch.object(connector_routes.hub, "send_reply", new=AsyncMock(side_effect=RuntimeError("down"))):
            self.assertEqual(self.admin.post(f"/api/connectors/{record['id']}/test", json={}).status_code, 502)
        with patch.object(connector_routes.hub, "send_reply", new=AsyncMock()):
            self.assertEqual(self.admin.post(f"/api/connectors/{record['id']}/test", json={}).status_code, 200)

    def test_the_public_webhook_endpoint_trusts_nothing_it_cannot_verify(self):
        self.assertEqual(self.anon.post("/api/connectors/nope/webhook", content=b"{}").status_code, 404)
        record = store.create("webhook", "wh", {"secret": "s"}, KINDS["webhook"].fields, [OWNER], False, None)
        self.addCleanup(store.delete, record["id"])
        self.assertEqual(self.anon.post(f"/api/connectors/{record['id']}/webhook", content=b"{}").status_code, 404,
                         "a connector that is not running does not accept webhooks")
        self.assertEqual(self.anon.post(f"/api/connectors/{record['id']}/webhook", content=b"x" * 2_000_001).status_code, 413)


if __name__ == "__main__":
    unittest.main()

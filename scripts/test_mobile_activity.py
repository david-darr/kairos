"""Isolated notification/run regression tests; no live app, model or push provider.
Run with the project's Python: python scripts/test_mobile_activity.py
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

native_mkdir = os.mkdir
# Python 3.12's Windows 0700 directory ACL excludes the restricted test
# process token. Keep the workspace's inherited ACL for synthetic fixtures.
with patch("tempfile._os.mkdir", side_effect=lambda path, mode=0o777: native_mkdir(path, 0o777)):
    fixture = tempfile.TemporaryDirectory(prefix="kairos-mobile-test-", dir=Path(__file__).resolve().parents[1])
os.environ["JARVIS_DATA_DIR"] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import FastAPI, HTTPException
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from core import mobile_activity as store, permissions, runs, web_push
from core.auth import auth_manager
from core.middleware import require_user
from core.session_manager import session_manager
from core import session_manager_store
from routes import chat_routes, notification_routes, permission_routes
from services import chat_live, chat_service, mobile_notifications


def subscription(endpoint="https://web.push.apple.com/Qtest"):
    key = ec.generate_private_key(ec.SECP256R1())
    return {"endpoint": endpoint, "keys": {"p256dh": web_push.b64(web_push.public_key(key)),
                                           "auth": web_push.b64(os.urandom(16))}}


class ProtocolTests(unittest.TestCase):
    def test_rfc8291_published_encryption_vector(self):
        # RFC 8291 section 5; compares against an independent standard vector.
        sender = ec.derive_private_key(int.from_bytes(web_push.unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"), ec.SECP256R1())
        sub = {"keys": {"p256dh": "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "auth": "BTBZMqHH6r4Tts7J_aSIgg"}}
        expected = ("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
                    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
                    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
        salt = web_push.unb64(expected)[:16]
        encrypted = web_push.encrypt(sub, b"When I grow up, I want to be a watermelon", sender=sender, salt=salt)
        self.assertEqual(web_push.b64(encrypted), expected)

    def test_vapid_signature_and_audience(self):
        key = ec.generate_private_key(ec.SECP256R1())
        private = web_push.b64(key.private_numbers().private_value.to_bytes(32, "big"))
        header = web_push.authorization(private, "https://web.push.apple.com/a", "mailto:owner@example.com")
        token = header.split("t=", 1)[1].split(",", 1)[0]
        head, claims, signature = token.split(".")
        payload = json.loads(web_push.unb64(claims))
        self.assertEqual(payload["aud"], "https://web.push.apple.com")
        self.assertLessEqual(payload["exp"] - time.time(), 3600)
        raw = web_push.unb64(signature)
        key.public_key().verify(utils.encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                                (head + "." + claims).encode(), ec.ECDSA(hashes.SHA256()))

    def test_endpoint_and_key_validation(self):
        good = subscription()
        self.assertEqual(web_push.validate(good), good)
        for url in ("http://web.push.apple.com/a", "https://127.0.0.1/a", "https://web.push.apple.com.evil/a",
                    "https://web.push.apple.com:999/a", "https://x@web.push.apple.com/a", "https://web.push.apple.com/a#fragment"):
            with self.assertRaises(ValueError, msg=url):
                web_push.validate({**good, "endpoint": url})
        with self.assertRaises(ValueError):
            web_push.validate({**good, "keys": {"auth": "bad", "p256dh": good["keys"]["p256dh"]}})


class FakeBrain:
    last_usage = None
    last_tool_rounds = []

    def __init__(self, gate, *, approval=False, fail=False):
        self.gate, self.approval, self.fail = gate, approval, fail
        self.cancel = AsyncMock(return_value=runs.StopResult(True, "fixture"))
        self.disconnect = AsyncMock()

    async def events(self, prompt):
        yield runs.text("first ")
        await self.gate.wait()
        if self.approval:
            decision = await permissions.decide(surface=f"chat:{self.session_id}", tool="fixture-tool",
                                                arguments={"path": "example"}, force_prompt=True, timeout=0.5)
            yield runs.text(decision.behavior)
        if self.fail:
            raise RuntimeError("fixture failure")
        yield runs.text("finished")
        yield runs.result(True)


@asynccontextmanager
async def no_checkpoint(*args, **kwargs):
    # This fixture tests live activity and delivery; filesystem checkpoints
    # have their own suite and must not delay the gated fake model.
    yield


class MobileTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        store.DB_FILE = str(Path(fixture.name) / (os.urandom(8).hex() + ".db"))
        self.session = session_manager.create_session(owner_user="local")
        self.sid = self.session["id"]
        workspace = Path(fixture.name) / self.sid
        workspace.mkdir()
        session_manager.set_workspace(self.sid, str(workspace))
        self.gate = asyncio.Event()
        self.brain = FakeBrain(self.gate)
        self.brain.session_id = self.sid
        self.patches = [
            patch.object(auth_manager, "is_admin", side_effect=lambda user: user in ("local", "admin")),
            patch.object(chat_service, "_resolve_endpoint", return_value={"id": "fixture", "name": "Fixture", "kind": "api", "model": "fixture"}),
            patch.object(chat_service, "_get_brain", AsyncMock(return_value=(self.brain, False))),
            patch.object(chat_service, "_compact_if_nearly_full", AsyncMock()),
            patch.object(chat_service, "_record_turn_telemetry", Mock()),
            patch.object(chat_service, "_remember_claude_session", Mock()),
            patch.object(chat_service, "_reply_hook", Mock()),
            patch.object(chat_service.file_checkpoints, "around_turn", no_checkpoint),
            patch.object(mobile_notifications, "auth_enabled", return_value=False),
        ]
        for p in self.patches:
            p.start()
        self.user = "local"
        app = FastAPI()
        app.include_router(chat_routes.router)
        app.include_router(notification_routes.router)
        app.include_router(permission_routes.router)
        app.dependency_overrides[require_user] = lambda: self.user
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://kairos.example")
        store.config(create=True, subject="https://kairos.example")

    async def asyncTearDown(self):
        await chat_live.shutdown()
        chat_live._runs.clear()
        chat_live._subscribers.clear()
        await self.client.aclose()
        for p in reversed(self.patches):
            p.stop()

    async def wait_for(self, predicate):
        for _ in range(200):
            if predicate():
                return
            await asyncio.sleep(0.01)
        self.fail("Expected state was not reached")

    async def start_run(self, request_id="fixture-request"):
        response = await self.client.post("/api/chat/live", json={"session_id": self.sid, "message": "work", "request_id": request_id})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["turn_id"]

    async def enroll(self):
        response = await self.client.post("/api/notifications/devices", json={"subscription": subscription()})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["id"]

    async def test_detach_resume_and_single_persisted_reply(self):
        await self.enroll()
        rid = await self.start_run()
        await self.wait_for(lambda: store.read_run(rid)["snapshot"]["text"] == "first ")
        stream = (await chat_routes.live_chat_events(user="local")).body_iterator
        first = await anext(stream)
        self.assertIn('"snapshot"', first)
        await stream.aclose()  # Equivalent to browser stream disconnect.
        self.assertTrue(chat_service.is_busy(self.sid))
        self.assertFalse(self.brain.cancel.called)
        self.gate.set()
        await self.wait_for(lambda: store.read_run(rid)["state"] == "completed")
        restored = await self.client.get('/api/chat/live/snapshot')
        self.assertEqual(restored.json()['runs'][self.sid]['text'], 'first finished')
        self.assertFalse(chat_service.is_busy(self.sid))
        messages = session_manager.get_session(self.sid)["messages"]
        self.assertEqual([m["role"] for m in messages], ["user", "assistant"])
        canonical_id = chat_live.snapshot()["runs"][self.sid]["runId"]
        self.assertEqual(messages[-1]["run_id"], canonical_id)
        self.assertEqual(session_manager_store.get_run(canonical_id)["outcome"], "finished")
        queued = store.due()
        self.assertEqual([item["kind"] for item in queued], ["completed"])
        self.assertNotIn("work", queued[0]["payload"])
        self.assertIn(self.sid, queued[0]["payload"])

    async def test_idempotent_start_and_busy_reservation(self):
        rid = await self.start_run()
        self.assertEqual(await self.start_run(), rid)
        duplicate = await self.client.post("/api/chat/live", json={"session_id": self.sid, "message": "different", "request_id": "fixture-request"})
        self.assertEqual(duplicate.status_code, 409)
        competing = await self.client.post("/api/chat/live", json={"session_id": self.sid, "message": "work", "request_id": "another"})
        self.assertEqual(competing.status_code, 409)
        self.gate.set()
        await self.wait_for(lambda: store.read_run(rid)["state"] == "completed")
        self.assertEqual(len(session_manager.get_session(self.sid)["messages"]), 2)

    async def test_explicit_stop_preserves_partial_and_suppresses_alert(self):
        await self.enroll()
        rid = await self.start_run()
        await self.wait_for(lambda: bool(store.read_run(rid)["snapshot"]["text"]))
        response = await self.client.post("/api/chat/live/stop", json={"session_id": self.sid})
        self.assertTrue(response.json()["stopping"])
        await self.wait_for(lambda: store.read_run(rid)["state"] == "stopped")
        self.brain.cancel.assert_awaited_once()
        message = session_manager.get_session(self.sid)["messages"][-1]
        self.assertEqual(message["content"], "first ")
        self.assertEqual(message["status"], "interrupted")
        self.assertFalse(store.due())

    async def test_permission_reconnect_answer_and_no_stale_approval(self):
        await self.enroll()
        self.brain.approval = True
        rid = await self.start_run()
        self.gate.set()
        await self.wait_for(lambda: store.read_run(rid)["state"] == "awaiting_permission")
        request = store.read_run(rid)["snapshot"]["permissions"][0]
        self.assertGreater(request["expires_at"], time.time())
        self.assertEqual(store.due()[0]["kind"], "permission")
        response = await self.client.get("/api/chat/live/snapshot")
        self.assertEqual(response.json()["runs"][self.sid]["permission"]["id"], request["id"])
        self.user = "stranger"
        rejected = await self.client.post(f"/api/permissions/{request['id']}/answer", json={"choice": "once"})
        self.assertEqual(rejected.status_code, 404)
        self.user = "local"
        response = await self.client.post(f"/api/permissions/{request['id']}/answer", json={"choice": "once"})
        self.assertEqual(response.status_code, 200)
        await self.wait_for(lambda: store.read_run(rid)["state"] == "completed")
        late = await self.client.post(f"/api/permissions/{request['id']}/answer", json={"choice": "once"})
        self.assertEqual(late.status_code, 409)
        self.assertEqual([item["kind"] for item in store.due()], ["completed"])
        self.assertIsNone((await self.client.get("/api/chat/live/snapshot")).json()["runs"][self.sid]["permission"])

    async def test_permission_expiry_denies_and_is_not_replayed(self):
        self.brain.approval = True
        rid = await self.start_run()
        self.gate.set()
        await self.wait_for(lambda: store.read_run(rid)["state"] == "awaiting_permission")
        request_id = store.read_run(rid)["snapshot"]["permissions"][0]["id"]
        await self.wait_for(lambda: store.read_run(rid)["state"] == "completed")
        self.assertIn("deny", store.read_run(rid)["snapshot"]["text"])
        self.assertIsNone(permissions.pending_request(request_id))
        self.assertFalse(permissions.answer(request_id, "once", "local"))

    async def test_failed_run_alert_and_account_isolation(self):
        device = await self.enroll()
        self.brain.fail = True
        rid = await self.start_run()
        self.gate.set()
        await self.wait_for(lambda: store.read_run(rid)["state"] == "failed")
        self.assertEqual(store.due()[0]["kind"], "failed")
        self.user = "stranger"
        self.assertEqual((await self.client.get("/api/chat/live/snapshot")).json()["runs"], {})
        stream = (await chat_routes.live_chat_events(user="stranger")).body_iterator
        self.assertIn('"runs": {}', await anext(stream))
        await stream.aclose()
        self.assertEqual((await self.client.post("/api/chat/live/stop", json={"session_id": self.sid})).status_code, 404)
        self.assertEqual((await self.client.post("/api/chat/live", json={"session_id": self.sid, "message": "work"})).status_code, 404)
        self.assertEqual((await self.client.delete(f"/api/notifications/devices/{device}")).status_code, 404)

    async def test_preferences_deduplication_retry_and_gone_device(self):
        device = await self.enroll()
        rid = await self.start_run()
        self.gate.set()
        await self.wait_for(lambda: store.read_run(rid)["state"] == "completed")
        store.enqueue(rid, "completed")
        self.assertEqual(len(store.due()), 1)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(429, headers={"Retry-After": "60"}))) as client:
            await mobile_notifications.deliver_due(client)
        self.assertFalse(store.due())
        with store.database() as db:
            row = db.execute("SELECT * FROM outbox").fetchone()
            self.assertEqual(row["attempts"], 1)
            self.assertEqual(row["status"], "pending")
            self.assertGreater(row["next_attempt"], time.time() + 50)
            db.execute("UPDATE outbox SET next_attempt=0")
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(410))) as client:
            await mobile_notifications.deliver_due(client)
        self.assertEqual(store.devices("local"), [])
        self.assertFalse(store.due())

    async def test_revocation_removes_queued_alert_and_cross_origin_enrollment(self):
        device = await self.enroll()
        rid = await self.start_run()
        self.gate.set()
        await self.wait_for(lambda: store.read_run(rid)["state"] == "completed")
        store.revoke(session_binding="local")
        self.assertFalse(store.due())
        self.assertEqual(store.devices("local"), [])
        response = await self.client.post("/api/notifications/devices", headers={"Origin": "https://evil.example"}, json={"subscription": subscription()})
        self.assertEqual(response.status_code, 403)

    async def test_disabling_a_category_cancels_pending_delivery_and_test_is_device_scoped(self):
        device = await self.enroll()
        rid = await self.start_run()
        self.gate.set()
        await self.wait_for(lambda: store.read_run(rid)["state"] == "completed")
        response = await self.client.put(f"/api/notifications/devices/{device}", json={"completed": False, "failed": True, "permission": True})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(store.due())
        self.user = "stranger"
        response = await self.client.post(f"/api/notifications/devices/{device}/test")
        self.assertEqual(response.status_code, 404)
        self.user = "local"
        self.assertEqual((await self.client.post(f"/api/notifications/devices/{device}/test")).status_code, 200)
        self.assertEqual([item["kind"] for item in store.due()], ["test"])
        requests = []
        def accept(request):
            requests.append(request)
            return httpx.Response(201)
        async with httpx.AsyncClient(transport=httpx.MockTransport(accept)) as client:
            await mobile_notifications.deliver_due(client)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].headers["content-encoding"], "aes128gcm")
        self.assertFalse(store.due())

    async def test_restart_marks_interrupted_without_repeating_work(self):
        rid = os.urandom(6).hex()
        store.create_run(rid, self.session, "local", "restart", "fixture")
        store.publish(rid, {"chunk": "partial"})
        store.recover()
        snap = store.read_run(rid)["snapshot"]
        self.assertEqual(snap["state"], "interrupted")
        self.assertEqual(snap["text"], "partial")
        self.assertNotIn(self.sid, chat_live._tasks)

    # -- bot pushes (Agents 2.0, 2026-10-14) ---------------------------------
    def bot_rows(self):
        with store.database() as db:
            return [dict(r) for r in db.execute("SELECT * FROM outbox WHERE kind LIKE 'bot_%'").fetchall()]

    async def test_a_burst_of_bot_results_is_one_push_per_bot(self):
        from services import bot_push
        await self.enroll()
        for _ in range(6):
            bot_push.on_event({"type": "agent.review", "agent_id": "a1"})
        bot_push.on_event({"type": "agent.review", "agent_id": "a2"})
        rows = self.bot_rows()
        self.assertEqual(sorted(json.loads(r["payload"])["url"] for r in rows), ["/?agent=a1", "/?agent=a2"])
        self.assertTrue(all(r["next_attempt"] > time.time() + 5 for r in rows), "held for the burst to settle")

    async def test_questions_and_results_map_to_their_own_kinds(self):
        from services import bot_push
        self.assertEqual(bot_push.kind_for({"type": "agent.inbox", "item_kind": "question"}), "bot_needs_you")
        self.assertEqual(bot_push.kind_for({"type": "agent.inbox", "item_kind": "report"}), "bot_results")
        self.assertEqual(bot_push.kind_for({"type": "agent.review"}), "bot_results")
        self.assertIsNone(bot_push.kind_for({"type": "task.run"}))

    async def test_bot_pushes_only_reach_admins(self):
        from services import bot_push
        self.user = "bob"  # not an admin under this fixture
        await self.enroll()
        bot_push.on_event({"type": "agent.inbox", "item_kind": "question", "agent_id": "a1"})
        self.assertEqual(self.bot_rows(), [])

    async def test_a_turned_off_bot_kind_is_respected(self):
        from services import bot_push
        device = await self.enroll()
        response = await self.client.put(f"/api/notifications/devices/{device}", json={
            "completed": True, "failed": True, "permission": True, "bot_needs_you": False, "bot_results": True})
        self.assertEqual(response.status_code, 200, response.text)
        bot_push.on_event({"type": "agent.inbox", "item_kind": "question", "agent_id": "a1"})
        self.assertEqual(self.bot_rows(), [])
        bot_push.on_event({"type": "agent.inbox", "item_kind": "report", "agent_id": "a1"})
        self.assertEqual([r["kind"] for r in self.bot_rows()], ["bot_results"])

    async def test_a_bot_push_delivers_without_a_chat_and_says_nothing_private(self):
        from services import bot_push
        await self.enroll()
        bot_push.on_event({"type": "agent.inbox", "item_kind": "question", "agent_id": "a1"})
        with store.database() as db:
            db.execute("UPDATE outbox SET next_attempt=0")
        sent = []
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: sent.append(req) or httpx.Response(201))) as client:
            await mobile_notifications.deliver_due(client)
        self.assertEqual(len(sent), 1, "no chat session is needed for a bot push")
        payload = json.loads(self.bot_rows()[0]["payload"])
        self.assertEqual(set(payload), {"kind", "url", "tag", "expires_at"}, "no title or body leaves the server")
    async def test_a_bot_push_is_dropped_if_its_owner_stops_being_an_admin(self):
        from services import bot_push
        await self.enroll()
        bot_push.on_event({"type": "agent.review", "agent_id": "a1"})
        with store.database() as db:
            db.execute("UPDATE outbox SET next_attempt=0")
        sent = []
        with patch.object(auth_manager, "is_admin", return_value=False):
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: sent.append(req) or httpx.Response(201))) as client:
                await mobile_notifications.deliver_due(client)
        self.assertEqual(sent, [], "queued while an admin, refused once they are not")

if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        if session_manager_store._conn:
            session_manager_store._conn.close()
            session_manager_store._conn = None
        fixture.cleanup()

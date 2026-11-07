"""A bot phones someone else for the person (build spec step 9), with fakes only: no network, no provider account, no
real call. The approval gate itself is tested in scripts/test_bots_approvals.py. Run: python scripts/test_outbound_calls.py
"""
import asyncio
import base64
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_phone_calls as base  # noqa: E402  (sets the temporary data folder before Kairos is imported)

import httpx  # noqa: E402
import numpy as np  # noqa: E402

from core import accounts, bot_outbound, phone_audio, phone_connection as connection  # noqa: E402
from services import outbound_calls as oc, phone_calls, phone_tools  # noqa: E402

RESTAURANT = "+12125550123"
CLIENT = "+13105550199"


class ScriptedConversation:
    """Stands in for the conversation model: replies are taken in order; a summary request gets call notes."""
    replies: list = []
    seen: list = []

    def __init__(self, *args):
        pass

    async def close(self):
        pass

    async def stream(self, messages, max_tokens=320):
        ScriptedConversation.seen.append(messages)
        if max_tokens == 500:
            yield "Booked a table for two on Friday at 8:30 under David."
            return
        text = ScriptedConversation.replies.pop(0) if ScriptedConversation.replies else "Okay."
        for at in range(0, len(text), 7):          # small chunks, so control tags are split across them
            yield text[at:at + 7]


class TestPipeline(oc.OtherPipeline):
    """The real call-to-someone-else pipeline with fake hearing and voice."""
    heard_texts: list = []

    async def _hear(self, pcm16):
        return TestPipeline.heard_texts.pop(0) if TestPipeline.heard_texts else "Hello?"

    async def speak(self, text):
        pcm = phone_audio.float_to_pcm16(0.3 * np.sin(2 * np.pi * 220 * np.arange(4800) / 24000))
        yield 24000, pcm

    async def end_of_turn(self, pcm16):
        return None

    async def filler(self, user_text, last):
        return None


class LineSocket:
    """A media stream the test feeds by hand; the call ends when the bridge stops or the test closes it."""

    def __init__(self, start):
        self.queue = asyncio.Queue()
        self.queue.put_nowait(start)
        self.headers, self.query, self.sent, self.closed = {}, {}, [], None

    async def recv(self):
        return await self.queue.get()

    async def send(self, text):
        self.sent.append(json.loads(text))

    async def close(self, code=1000):
        self.closed = code

    async def say(self, ms=600):
        for frame in base.silence(300) + base.frames_of(base.tone(ms)) + base.silence(900):
            await self.queue.put(base.twilio_media(frame))
            await asyncio.sleep(0)


class OutboundCase(base.PhoneTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        connection.save({"others_enabled": True, "caller_name": "David Darr"}, account="acct1")
        for account in ("acct1", "acct2"):
            path = oc._file(account)
            if os.path.exists(path):
                os.remove(path)
        oc._last_call.clear()
        oc._live.clear()
        self.posted, self.notes = [], []

        async def ready(account, record, bot):
            return ""
        for patcher in (patch.object(oc, "voice_problem", ready), patch.object(oc, "_hour", lambda now: 12),
                        patch.object(oc, "_post", lambda account, call, text: self.posted.append((call["id"], text))),
                        patch.object(oc, "_notify", lambda account, call, title, kind, body="": self.notes.append((kind, title))),
                        patch.object(oc, "Conversation", ScriptedConversation)):
            patcher.start()
            self.stack.append(patcher)
        ScriptedConversation.replies, ScriptedConversation.seen = [], []
        TestPipeline.heard_texts = []

    async def place(self, to=RESTAURANT, account="acct1", bot="bot-kip", invocation=None, **extra):
        args = {"who": "Luigi's", "topic": "A dinner reservation", "goal": "Table for two on Friday at 7pm, name David.", **extra}
        return await oc.place(account, bot, to, args["who"], args["topic"], args["goal"],
                              invocation or "inv-" + os.urandom(4).hex(), thread_id="thread-1")

    def end_all(self, account="acct1"):
        with oc._lock:
            data = oc._load(account)
            for call in data["calls"]:
                call["status"] = oc.ENDED
            oc._save(account, data)
        oc._last_call.clear()

    def answered_webhook(self, query, to=RESTAURANT):
        params = {"CallSid": "CAfake", "From": base.NUMBER_1, "To": to, "Direction": "outbound-api"}
        return self.signed_voice(params, query=query)


class SetupTests(OutboundCase):
    async def test_off_until_turned_on_and_it_needs_the_name_calls_are_for(self):
        connection.save({"others_enabled": False}, account="acct1")
        with self.assertRaises(oc.CallRefused) as caught:
            await self.place()
        self.assertIn("off", str(caught.exception))
        with self.assertRaises(connection.PhoneError):
            connection.save({"others_enabled": True, "caller_name": " "}, account="acct1")
        fresh = connection.get("acct2")
        self.assertFalse(fresh["others_enabled"])                  # off by default
        self.assertEqual(self.api.requests, [])

    async def test_nothing_is_dialled_when_the_call_could_not_be_held(self):
        async def no_voice(account, record, bot):
            return "Calls need a local voice for this bot."
        with patch.object(oc, "voice_problem", no_voice):
            with self.assertRaises(oc.CallRefused):
                await self.place()
        self.assertEqual(self.api.requests, [])

    async def test_the_tool_is_registered_as_an_outbound_send_with_per_call_review(self):
        from core import bot_policy, permissions, tool_registry
        self.assertIn("dial_someone", tool_registry._REGISTRY)
        self.assertIn("dial_someone", permissions.EXPLICIT_REVIEW_TOOLS)
        self.assertIn("dial_someone", permissions.PER_CALL_REVIEW)
        self.assertEqual(bot_policy.classify("dial_someone", {"to": RESTAURANT}).kind, bot_policy.OUTBOUND)
        spec = next(t for t in phone_tools.TOOLS if t["name"] == "dial_someone")
        self.assertEqual(spec["schema"]["required"], ["to", "who", "topic", "goal"])
        with accounts.as_account("acct1"):
            ctx = tool_registry.ToolContext(agent_id="bot-kip", owner_user="local", invocation_id="inv-t", session_id=None)
            result = await phone_tools.tool_dial({"to": RESTAURANT, "who": "Luigi's", "topic": "a table", "goal": "Book it."}, ctx)
        self.assertTrue(result.startswith("Calling Luigi's"), result)
        connection.delete("acct2")
        with accounts.as_account("acct2"):
            ctx = tool_registry.ToolContext(agent_id="bot-kip", owner_user="local", invocation_id="inv-u")
            result = await phone_tools.tool_dial({"to": CLIENT, "who": "x", "topic": "y", "goal": "z"}, ctx)
        self.assertTrue(result.startswith("Not called:"), result)


class PlacingTests(OutboundCase):
    async def test_twilio_dials_the_number_and_an_answer_gets_a_one_use_stream(self):
        line = await self.place()
        self.assertIn("an AI assistant calling on behalf of David Darr", line)
        form = self.api.form()
        self.assertEqual((form["To"], form["From"]), (RESTAURANT, base.NUMBER_1))
        self.assertTrue(form["Url"].startswith(base.BASE + "/api/phone/twilio/voice?other="))
        call = oc._load("acct1")["calls"][-1]
        self.assertEqual((call["status"], call["provider_call_id"], call["thread_id"]), (oc.DIALING, "CAfake", "thread-1"))
        query = "other=" + form["Url"].split("other=")[1]
        status, content, _ = await phone_calls.twilio_voice(*self.answered_webhook(query))
        self.assertEqual(status, 200)
        token = content.decode().split('name="t" value="')[1].split('"')[0]
        session = phone_calls.redeem(token, "stream")
        self.assertEqual((session["mode"], session["call_id"]), ("other", call["id"]))
        # the same intent cannot be used twice, and an answer from another number is refused
        _, content, _ = await phone_calls.twilio_voice(*self.answered_webhook(query))
        self.assertNotIn("<Stream", content.decode())

    async def test_an_answer_from_a_different_number_is_refused(self):
        await self.place()
        query = "other=" + self.api.form()["Url"].split("other=")[1]
        _, content, _ = await phone_calls.twilio_voice(*self.answered_webhook(query, to=CLIENT))
        self.assertNotIn("<Stream", content.decode())

    async def test_refusals(self):
        cases = [(base.MOBILE_1, "own mobile"), (base.NUMBER_1, "Kairos number"), ("+11235550123", "valid"),
                 ("+19005550123", "Premium"), ("12125550123", "country code"), ("+12121150123", "valid")]
        for number, words in cases:
            with self.assertRaises(oc.CallRefused, msg=number) as caught:
                await self.place(number)
            self.assertIn(words, str(caught.exception))
        oc.set_blocked("acct1", RESTAURANT, True)
        with self.assertRaises(oc.CallRefused) as caught:
            await self.place()
        self.assertIn("do-not-call", str(caught.exception))
        oc.set_blocked("acct1", RESTAURANT, False)
        with patch.object(oc, "_hour", lambda now: 22):
            with self.assertRaises(oc.CallRefused) as caught:
                await self.place()
            self.assertIn("8 am and 9 pm", str(caught.exception))
        with patch.object(oc, "_hour", lambda now: 7):
            with self.assertRaises(oc.CallRefused):
                await self.place()
        await self.place()
        with self.assertRaises(oc.CallRefused) as caught:
            await self.place(CLIENT)
        self.assertIn("in progress", str(caught.exception))
        self.end_all()
        oc._last_call["acct1"] = time.time()
        with self.assertRaises(oc.CallRefused) as caught:
            await self.place(CLIENT)
        self.assertIn("moment ago", str(caught.exception))
        self.assertEqual(len([r for r in self.api.requests if r["url"].endswith("Calls.json")]), 1)

    async def test_daily_limits_per_number_per_bot_and_per_account(self):
        numbers = ["+12125550101", "+12125550102", "+12125550103", "+12125550104", "+12125550105", "+12125550106"]
        await self.place(numbers[0])
        self.end_all()
        await self.place(numbers[0])
        self.end_all()
        with self.assertRaises(oc.CallRefused) as caught:
            await self.place(numbers[0])                          # a third call to one number in a day
        self.assertIn("already been called", str(caught.exception))
        await self.place(numbers[1])
        self.end_all()
        with self.assertRaises(oc.CallRefused) as caught:         # the bot's 3 are used
            await self.place(numbers[2])
        self.assertIn("this bot", str(caught.exception))
        await self.place(numbers[2], bot="bot-two")
        self.end_all()
        await self.place(numbers[3], bot="bot-two")
        self.end_all()
        with self.assertRaises(oc.CallRefused) as caught:         # the account's 5 are used
            await self.place(numbers[4], bot="bot-three")
        self.assertIn("this account", str(caught.exception))
        self.assertEqual(len([r for r in self.api.requests if r["url"].endswith("Calls.json")]), 5)

    async def test_another_account_has_its_own_allowance_and_its_own_calls(self):
        connection.save({"others_enabled": True, "caller_name": "Sam"}, account="acct2")
        for n in range(5):
            await self.place(f"+1212555020{n}", bot=f"bot-{n % 2}")
            self.end_all()
        await self.place("+12125550300", account="acct2")
        self.assertEqual(self.api.form()["From"], base.NUMBER_2)
        self.assertEqual(len(oc.listing("acct2")["calls"]), 1)
        self.assertEqual(len(oc.listing("acct1")["calls"]), 5)

    async def test_a_provider_refusal_releases_every_unit(self):
        phone_calls.TRANSPORT = httpx.MockTransport(lambda request: httpx.Response(401, json={"message": "no"}))
        with self.assertRaises(oc.CallRefused):
            await self.place()
        for who in ("phone:other:account", "phone:other:bot-kip", f"phone:other-number:{RESTAURANT}"):
            self.assertEqual(bot_outbound.usage("acct1", who, 5)["used"], 0, who)
        self.assertNotIn("acct1", oc._last_call)
        self.assertEqual(oc._load("acct1")["calls"][-1]["status"], oc.ENDED)

    async def test_telnyx_dials_and_streams_when_answered(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        key = Ed25519PrivateKey.generate()
        public = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
        connection.save({"provider": "telnyx", "api_key": "KEYsecret", "public_key": public, "connection_id": "conn-1",
                         "number": "+15550004444", "user_number": base.MOBILE_1, "public_url": base.BASE,
                         "conversation_endpoint_id": "fast", "conversation_model": "small", "require_pin": False,
                         "others_enabled": True, "caller_name": "David Darr"}, account="acct1")
        await self.place()
        sent = self.api.json()
        self.assertEqual((sent["to"], sent["from"]), (RESTAURANT, "+15550004444"))
        body = json.dumps({"data": {"event_type": "call.answered", "payload": {
            "call_control_id": "cc9", "direction": "outgoing", "from": "+15550004444", "to": RESTAURANT,
            "client_state": sent["client_state"]}}}).encode()
        stamp = str(int(time.time()))
        headers = {"telnyx-timestamp": stamp, "telnyx-signature-ed25519": base64.b64encode(key.sign(stamp.encode() + b"|" + body)).decode()}
        self.assertEqual((await phone_calls.telnyx_event(headers, body))[0], 200)
        self.assertTrue(self.api.requests[-1]["url"].endswith("/v2/calls/cc9/actions/streaming_start"))
        session = phone_calls.redeem(self.api.json()["stream_url"].split("t=")[1], "stream")
        self.assertEqual(session["mode"], "other")

    async def test_a_call_nobody_answers_is_closed_and_reported(self):
        await self.place()
        with oc._lock:
            data = oc._load("acct1")
            data["calls"][-1]["created_at"] -= oc.RING_TIMEOUT_SECONDS + 5
            oc._save("acct1", data)
        self.assertEqual([c["status"] for c in oc.active("acct1")], [oc.ENDED])
        call = oc._load("acct1")["calls"][-1]
        self.assertEqual(call["end_reason"], "Nobody answered.")
        self.assertIn("Nobody answered", self.posted[-1][1])


class LiveCallTests(OutboundCase):
    async def start_call(self):
        await self.place()
        call = oc._load("acct1")["calls"][-1]
        token = phone_calls.mint("stream", "acct1", 60, mode="other", message="", bot_id="bot-kip", call_id=call["id"])
        socket = LineSocket(base.twilio_start(token))
        socket.headers = {"x-twilio-signature": base.sign_twilio(base.TOKEN_1, base.BASE.replace("https", "wss") + "/api/phone/twilio/stream", {})}

        async def factory(account, record, bot, session):
            return TestPipeline(account, "local", record, bot, session["call_id"])
        task = asyncio.create_task(phone_calls.serve_stream("twilio", socket, factory, {"pace": False}))
        return call["id"], socket, task

    async def until(self, predicate, timeout=5):
        self.assertTrue(await base.Settled.until(predicate, timeout))

    def call(self, call_id):
        return oc.get("acct1", call_id)

    async def test_a_whole_call_disclosure_question_answer_goodbye_and_summary(self):
        ScriptedConversation.replies = [
            "Hi! I'd like a table for two on Friday at seven. Let me check one thing with David, please hold a moment. "
            "<kairos-ask>They only have 8:30 on Friday. Is that okay?</kairos-ask>",
            "Thanks for holding. 8:30 on Friday works for David. Thank you, goodbye! <kairos-end>",
        ]
        TestPipeline.heard_texts = ["Luigi's, how can I help?"]
        call_id, socket, task = await self.start_call()
        await self.until(lambda: (self.call(call_id) or {}).get("status") == oc.LIVE and self.call(call_id)["transcript"])
        opening = self.call(call_id)["transcript"][0]
        self.assertEqual(opening["who"], "bot")
        self.assertEqual(opening["text"], "Hi, this is Kip, an AI assistant calling on behalf of David Darr. "
                                          "This call is transcribed. I'm calling about a dinner reservation.")
        await socket.say()
        await self.until(lambda: self.call(call_id)["questions"])
        question = self.call(call_id)["questions"][0]
        self.assertEqual((question["text"], question["status"]), ("They only have 8:30 on Friday. Is that okay?", "waiting"))
        self.assertIn(("call-question", "Kip asks: They only have 8:30 on Friday. Is that okay?"), self.notes)
        spoken = [line["text"] for line in self.call(call_id)["transcript"] if line["who"] == "bot"]
        self.assertFalse(any("kairos" in text for text in spoken), spoken)          # control lines are never said
        self.assertIn("Luigi's, how can I help?", [line["text"] for line in self.call(call_id)["transcript"]])
        oc.answer("acct1", call_id, question["id"], "Yes, 8:30 is fine.")
        with self.assertRaises(oc.CallRefused):
            oc.answer("acct1", call_id, question["id"], "again")                     # answered once
        await asyncio.wait_for(task, 8)                                              # the bot said goodbye and hung up
        call = self.call(call_id)
        self.assertEqual(call["status"], oc.ENDED)
        self.assertEqual(call["questions"][0]["answer"], "Yes, 8:30 is fine.")
        relayed = ScriptedConversation.seen[1][-1]["content"]
        self.assertIn("Yes, 8:30 is fine.", relayed)
        self.assertTrue(any(r["url"].endswith("/Calls/CA1.json") for r in self.api.requests))   # hung up the line
        await asyncio.gather(*list(oc._tasks), return_exceptions=True)
        self.assertEqual(self.call(call_id)["summary_state"], "saved")
        posted = self.posted[-1][1]
        self.assertIn("Booked a table for two on Friday at 8:30", posted)
        self.assertIn("They only have 8:30 on Friday. Is that okay?: Yes, 8:30 is fine.", posted)
        self.assertNotIn(call_id, oc._live)
        self.assertGreater(len(socket.sent), 10)

    async def test_the_disclosure_cannot_be_talked_over(self):
        call_id, socket, task = await self.start_call()
        for frame in base.silence(300) + base.frames_of(base.tone(900)):   # "Hello? Hello?" over the opening
            await socket.queue.put(base.twilio_media(frame))
        await asyncio.sleep(0.3)
        self.assertEqual([m for m in socket.sent if m.get("event") == "clear"], [])
        self.assertEqual(self.call(call_id)["transcript"][0]["text"].split(".")[0], "Hi, this is Kip, an AI assistant calling on behalf of David Darr")
        await oc.hang_up("acct1", call_id)
        await asyncio.wait_for(task, 5)

    async def test_the_person_can_hang_up_and_a_do_not_call_request_blocks_the_number(self):
        ScriptedConversation.replies = ["I'm sorry, I won't call again. Goodbye."]
        TestPipeline.heard_texts = ["Please do not call this number again."]
        call_id, socket, task = await self.start_call()
        await self.until(lambda: self.call(call_id)["transcript"])
        await socket.say()
        await self.until(lambda: RESTAURANT in oc.listing("acct1")["blocked"])
        await self.until(lambda: any(line["who"] == "bot" and "won't call" in line["text"] for line in self.call(call_id)["transcript"]))
        view = await oc.hang_up("acct1", call_id)
        await asyncio.wait_for(task, 5)
        self.assertEqual(self.call(call_id)["status"], oc.ENDED)
        self.assertEqual(self.call(call_id)["end_reason"], "You hung up.")
        self.assertIn(view["status"], (oc.LIVE, oc.ENDED))
        self.end_all()
        with self.assertRaises(oc.CallRefused):
            await self.place()

    async def test_an_unanswered_question_is_closed_and_the_bot_is_told(self):
        ScriptedConversation.replies = ["One moment please. <kairos-ask>Is a booth okay?</kairos-ask>",
                                        "Sorry, David will follow up himself. Thank you, goodbye. <kairos-end>"]
        call_id, socket, task = await self.start_call()
        await self.until(lambda: self.call(call_id)["transcript"])
        with patch.object(oc, "ANSWER_WAIT_SECONDS", 0.2):
            await socket.say()
            await asyncio.wait_for(task, 8)
        call = self.call(call_id)
        self.assertEqual(call["questions"][0]["status"], "expired")
        self.assertIn("not answered your question", ScriptedConversation.seen[1][-1]["content"])
        with self.assertRaises(oc.CallRefused):
            oc.answer("acct1", call_id, call["questions"][0]["id"], "too late")

    async def test_interrupting_the_bot_keeps_only_what_was_heard(self):
        pipeline = TestPipeline("acct1", "local", connection.get("acct1"), dict(base.BOT), "nope")
        turn = {"parts": ["First sentence. ", "Second sentence."], "saved": False, "heard": None}
        pipeline._turn = turn
        pipeline.note_heard(["First sentence."])
        pipeline.interrupt(True)
        self.assertEqual(pipeline.messages[-1]["content"], "First sentence. [interrupted]")


class ControlFilterTests(unittest.TestCase):
    def test_tags_are_removed_even_when_split(self):
        text = "Please hold. <kairos-ask>Is 8:30 okay?</kairos-ask> Bye <now> <kairos-end>"
        for size in (1, 3, 7, 100):
            control = oc.ControlFilter()
            out = "".join(control.feed(text[i:i + size]) for i in range(0, len(text), size)) + control.finish()
            self.assertEqual(out.split(), ["Please", "hold.", "Bye", "<now>"])
            self.assertEqual(control.asks, ["Is 8:30 okay?"])
            self.assertTrue(control.end)

    def test_an_unfinished_tag_is_never_spoken(self):
        control = oc.ControlFilter()
        out = control.feed("Okay <kairos-ask>half a question") + control.finish()
        self.assertEqual(out.strip(), "Okay")
        self.assertEqual(control.asks, [])


class RouteTests(OutboundCase):
    def client(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from core.middleware import require_user
        from routes.phone_routes import router
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_user] = lambda: "local"
        return TestClient(app)

    async def test_list_active_answer_hangup_and_block_are_per_account(self):
        await self.place()
        call_id = oc._load("acct1")["calls"][-1]["id"]
        with patch.object(accounts, "effective_account", lambda: "acct1"):
            client = self.client()
            self.assertEqual(client.get("/api/phone/outbound").json()["calls"][0]["who"], "Luigi's")
            self.assertEqual(client.get("/api/phone/outbound/active").json()["calls"][0]["status"], oc.DIALING)
            self.assertEqual(client.get(f"/api/phone/outbound/{call_id}").json()["to"], RESTAURANT)
            self.assertEqual(client.post(f"/api/phone/outbound/{call_id}/answer", json={"question_id": "x", "answer": "y"}).status_code, 409)
            self.assertEqual(client.post("/api/phone/blocked", json={"number": CLIENT}).json()["blocked"], [CLIENT])
            self.assertEqual(client.post("/api/phone/blocked", json={"number": "nope"}).status_code, 422)
            ended = client.post(f"/api/phone/outbound/{call_id}/hangup").json()
            self.assertEqual(ended["status"], oc.ENDED)
            self.assertTrue(any(r["url"].endswith("/Calls/CAfake.json") for r in self.api.requests))
        with patch.object(accounts, "effective_account", lambda: "acct2"):
            client = self.client()
            self.assertEqual(client.get("/api/phone/outbound").json()["calls"], [])
            self.assertEqual(client.get(f"/api/phone/outbound/{call_id}").status_code, 404)
            self.assertEqual(client.post(f"/api/phone/outbound/{call_id}/hangup").status_code, 404)

    async def test_settings_save_the_calls_to_others_switch_and_name(self):
        with patch.object(accounts, "effective_account", lambda: "acct1"):
            client = self.client()
            shown = client.put("/api/phone", json={"others_enabled": True, "caller_name": "  David   Darr "}).json()["connection"]
            self.assertEqual((shown["others_enabled"], shown["caller_name"]), (True, "David Darr"))
            self.assertEqual(client.put("/api/phone", json={"caller_name": ""}).status_code, 422)


class SummaryPostTests(OutboundCase):
    async def test_the_summary_lands_in_the_conversation_the_call_was_asked_from(self):
        from core.session_manager import session_manager
        for patcher in [p for p in self.stack if getattr(p, "attribute", "") == "_post"]:
            patcher.stop()
            self.stack.remove(patcher)
        session = session_manager.create_session(owner_user="local")["id"]
        call = {"id": "c" * 32, "bot_id": "bot-kip", "thread_id": session, "owner": "local", "who": "Luigi's"}
        oc._post("acct1", call, "**Call to Luigi's**\n\nBooked.")
        oc._post("acct1", call, "**Call to Luigi's**\n\nBooked for 8:30.")       # one note per call, updated in place
        messages = [m for m in session_manager.get_session(session)["messages"] if m.get("call_summary_id") == "other:" + "c" * 32]
        self.assertEqual(len(messages), 1)
        self.assertIn("8:30", messages[0]["content"])


if __name__ == "__main__":
    unittest.main()

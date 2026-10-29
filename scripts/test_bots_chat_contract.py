"""Bots conversation renderer contract (Phase 1, unit U3).

What these prove, without starting the app or a browser: the renderer talks only to the routes of
phase-1-design.md section 5.1, its send payload carries exactly the fields that contract names (IDs
for replies, bounded citations, attachment IDs only), a draft's payload is stable across a retry,
and the in-memory fixture the Electron checks run on enforces the same acceptance rules (one message
per send ID, 409 on a different fingerprint or a stale leaf, no double append). U1's fake-provider
harness is not in this branch; once it is, point the same payloads at it.

Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_chat_contract.py
"""
import json
import re
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
JS = REPO / "static" / "js"

# Section 5.1, with {sid}/{mid}/{qid} for the IDs. Anything else under /api/bot-chat is not in the contract.
ROUTES = [
    ("GET", "/api/bot-chat/{sid}/state"), ("GET", "/api/bot-chat/{sid}/messages"), ("POST", "/api/bot-chat/{sid}/send"),
    ("GET", "/api/bot-chat/{sid}/queue"), ("DELETE", "/api/bot-chat/{sid}/queue/{qid}"), ("POST", "/api/bot-chat/{sid}/queue/{qid}/edit"),
    ("POST", "/api/bot-chat/{sid}/queue/{qid}/steer"), ("POST", "/api/bot-chat/{sid}/queue/resume"), ("POST", "/api/bot-chat/{sid}/interrupt"),
    ("POST", "/api/bot-chat/{sid}/messages/{mid}/edit"), ("POST", "/api/bot-chat/{sid}/regenerate"), ("POST", "/api/bot-chat/{sid}/active-branch"),
    ("POST", "/api/bot-chat/{sid}/messages/{mid}/reaction"), ("PATCH", "/api/bot-chat/{sid}/pin"), ("POST", "/api/bot-chat/{sid}/read"),
    ("POST", "/api/bot-chat/{sid}/compact"), ("GET", "/api/bot-chat/{sid}/export"), ("GET", "/api/bot-chat/search"), ("POST", "/api/bot-chat/presence"),
]
SEND_FIELDS = {"send_id", "text", "expected_leaf_id", "attachment_ids", "reply_to_id", "citations", "mode"}


def node(script: str):
    result = subprocess.run(["node", "-e", script], cwd=REPO, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout.strip().splitlines()[-1])


class RoutesInUse(unittest.TestCase):
    def test_every_bot_chat_url_is_in_the_contract(self):
        allowed = set()
        for _, route in ROUTES:
            allowed.add(re.sub(r"\{\w+\}", "X", route))
        found = set()
        for name in ("botsChat.js", "botsChatSearch.js", "chatStream.js"):
            source = (JS / name).read_text(encoding="utf-8")
            for match in re.finditer(r"/api/bot-chat[^'\"`\s?]*", source):
                url = re.sub(r"\$\{[^}]*\}", "X", match.group(0))
                url = re.sub(r"\{\w+\}", "X", url)
                found.add(url.rstrip("/);,"))
        self.assertTrue(found, "the renderer names no bot-chat route")
        for url in found:
            self.assertIn(url, allowed | {"/api/bot-chat"}, f"{url} is not a section 5.1 route")

    def test_guarded_stop_uses_the_interrupt_route(self):
        source = (JS / "chatStream.js").read_text(encoding="utf-8")
        self.assertIn("/interrupt", source)
        self.assertIn("turn_id: turnId", source)

    def test_bots_shell_no_longer_mounts_the_legacy_chat(self):
        shell = (JS / "views" / "botsShell.js").read_text(encoding="utf-8")
        self.assertIn("mountBotsChat", shell)
        self.assertNotIn("mountAgentChat", shell)


class SendPayload(unittest.TestCase):
    SCRIPT = r"""
const path = require('node:path'); const { pathToFileURL } = require('node:url');
(async () => {
  const D = await import(pathToFileURL(path.resolve('static/js/botsDrafts.js')).href);
  const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) }; };
  let n = 0;
  const draft = D.createBotDraft({ person: 'p', bot: 'b', thread: 't' }, { storage: mem(), uuid: () => `send-id-${++n}-padding`, setTimer: () => 0, clearTimer: () => {} });
  draft.update({ text: 'hello', attachment_ids: ['att-1', 'blob:x'], reply_to_id: 'm-9', citations: [{ message_id: 'm-9', quote: 'q', comment: 'c' }], mode: 'goal' });
  const first = draft.prepare('leaf-1').payload;
  draft.update({ text: 'typed later' });
  const retry = draft.prepare('leaf-2').payload;
  console.log(JSON.stringify({ first, retry }));
})();
"""

    def test_payload_is_the_contract_and_stable_across_retry(self):
        out = node(self.SCRIPT)
        first = out["first"]
        self.assertEqual(set(first), SEND_FIELDS)
        self.assertEqual(first["attachment_ids"], ["att-1"], "a blob URL never goes to the server")
        self.assertEqual(first["reply_to_id"], "m-9", "a reply is an ID, never copied text")
        self.assertEqual(first["mode"], "goal")
        self.assertEqual(first["expected_leaf_id"], "leaf-1")
        self.assertEqual(out["retry"], first, "a retry is byte-identical, so the server's receipt matches")


class FixtureAcceptance(unittest.TestCase):
    SCRIPT = r"""
const factory = require('./scripts/fixtures/bots-chat-backend.cjs');
const state = { botsLive: true, botsCore: { threads: [{ id: 't1' }, { id: 't2' }] } };
const backend = factory({ state, now: 1000 });
const post = (route, body) => backend.mutate(route, 'POST', body);
const out = {};
const a = post('/api/bot-chat/t1/send', { send_id: 'send-id-0001', text: 'hi', expected_leaf_id: null });
const again = post('/api/bot-chat/t1/send', { send_id: 'send-id-0001', text: 'hi', expected_leaf_id: null });
out.same = a.turn_id === again.turn_id && a.message.id === again.message.id;
out.count = backend.read('/api/bot-chat/t1/messages', {}).messages.length;
out.conflict = post('/api/bot-chat/t1/send', { send_id: 'send-id-0001', text: 'different', expected_leaf_id: null })._status;
out.stale = post('/api/bot-chat/t1/send', { send_id: 'send-id-0002', text: 'x', expected_leaf_id: 'nope' })._status;
out.queued = post('/api/bot-chat/t1/send', { send_id: 'send-id-0003', text: 'next', expected_leaf_id: a.message.id }).queued;
out.foreign = backend.read('/api/bot-chat/zzz/state', {})._status;
out.staleStop = post('/api/bot-chat/t1/interrupt', { turn_id: 'old' }).outcome;
out.otherSession = backend.read('/api/bot-chat/t2/messages', {}).messages.length;
out.unowned = backend.mutate('/api/agents', 'POST', {});
console.log(JSON.stringify(out));
"""

    def test_fixture_follows_the_acceptance_rules(self):
        out = node(self.SCRIPT)
        self.assertTrue(out["same"], "a repeated send ID returns the first result")
        self.assertEqual(out["count"], 1, "and appends once")
        self.assertEqual(out["conflict"], 409, "a different message under the same ID is a conflict")
        self.assertEqual(out["stale"], 409, "a stale leaf is a conflict")
        self.assertTrue(out["queued"], "a send during a turn is queued")
        self.assertEqual(out["foreign"], 404, "an unknown conversation is 404")
        self.assertEqual(out["staleStop"], "already-stopped")
        self.assertEqual(out["otherSession"], 0, "conversations do not share messages")
        self.assertNotIn("unowned", out, "routes that are not its own are left to others (undefined)")


if __name__ == "__main__":
    unittest.main()

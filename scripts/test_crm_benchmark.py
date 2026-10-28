"""CRM extraction efficiency and duplicate prevention (A17 benchmark).
A scripted extractor captures the exact prompt each model call receives, so we
report bytes/estimated tokens per call and per VALID task (real-model token
counts are MANUAL/paid; here tokens ~= UTF-8 bytes / 4, a stated estimate).
Run: python scripts/test_crm_benchmark.py
test_bug_* assert behaviour the code does not have yet (see report).
"""
import asyncio
import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import test_crm as C  # isolated data dir + helpers
from kairos_tabs.crm import scanner
from kairos_tabs.crm.service import CRMService
from core import settings as app_settings


def est_tokens(text):
    return round(len(text.encode("utf-8")) / 4)


def reply_for(msg_body, title="Send revised proposal"):
    """Scripted 'model': one valid task quoting the first sentence of the body."""
    quote = msg_body.split(".")[0] + "."
    return json.dumps({"tasks": [C.item(title=title, evidence=quote, due_date=None, deadline_text="", deadline_kind="unknown")]})


class Bench(unittest.IsolatedAsyncioTestCase):
    def make(self, n_sources=1, **cfg):
        app_settings.update_settings(enabled_tab_templates=["crm"])
        store = CRMService("bench-" + self.id().split(".")[-1] + ".json")
        store.configure("local", {"endpoint_id": "test", "max_messages": 100, **cfg})
        return store, [store.add_source("local", "connector", f"mail{i}", f"Inbox {i}") for i in range(n_sources)]

    async def scan(self, store, replies):
        prompts, calls = [], {"n": 0}

        async def fake(endpoint, prompt, model=None):
            prompts.append(prompt)
            r = replies(prompt, calls["n"])
            calls["n"] += 1
            return r
        with patch.object(scanner, "crm_service", store), patch.object(scanner, "extract", fake), \
                patch.object(scanner.tab_api, "is_admin", return_value=True), \
                patch.object(scanner.tab_api, "model_context_size", return_value=None):
            t = time.perf_counter()
            out = await scanner.scan("local")
            return out, prompts, (time.perf_counter() - t) * 1000

    async def test_tokens_per_valid_task_and_idle_rescan_costs_nothing(self):
        store, (src,) = self.make()
        bodies = []
        for i in range(10):  # 4 actionable, 6 noise (newsletters/FYI)
            body = (f"Please send report number {i} by Friday. " + "Thanks for your help with the project. " * 8) if i < 4 \
                else "Weekly newsletter. " + "Latest product news and offers. " * 12
            bodies.append(body)
            store.capture(src, C.message(external_id=f"1:{i}", thread_id=f"<t{i}@x>", body=body, subject=f"S{i}"))

        def replies(prompt, n):
            return reply_for(bodies[n], f"Send report {n}") if n < 4 else '{"tasks": []}'
        # prompts arrive in capture order; make the scripted model decide from prompt text
        def by_prompt(prompt, n):
            for i, b in enumerate(bodies[:4]):
                if f"report number {i} " in prompt:
                    return reply_for(b, f"Send report {i}")
            return '{"tasks": []}'
        out, prompts, ms = await self.scan(store, by_prompt)
        created = out["created"]
        self.assertEqual((len(prompts), created), (10, 4))
        sys_tokens = est_tokens(scanner.SYSTEM)
        user = [est_tokens(p) for p in prompts]
        total = sum(user) + sys_tokens * len(prompts)
        print(f"[bench] crm scan 10 msgs/4 valid tasks: {len(prompts)} model calls, SYSTEM~{sys_tokens} tok resent each call, "
              f"user prompt {min(user)}-{max(user)} tok (avg {sum(user)//len(user)}), total in~{total} tok "
              f"=> {total // created} tok per valid task, {len(prompts) / created:.1f} calls per valid task, "
              f"{sys_tokens * len(prompts) * 100 // total}% of input is the repeated system prompt, scan {ms:.0f} ms (scripted)")
        # duplicate prevention + idle: a rescan and a duplicate capture cost no model calls
        out2, prompts2, _ = await self.scan(store, by_prompt)
        self.assertEqual((len(prompts2), out2["created"]), (0, 0))
        store.capture(src, C.message(external_id="1:0", thread_id="<t0@x>", body=bodies[0], subject="S0"))
        out3, prompts3, _ = await self.scan(store, by_prompt)
        self.assertEqual(len(prompts3), 0)
        self.assertEqual(len(store.tasks("local")), 4)

    async def test_same_action_in_a_thread_reply_updates_instead_of_duplicating(self):
        store, (src,) = self.make()
        first = C.BODY
        store.capture(src, C.message(external_id="1:1", body=first))
        out, _, _ = await self.scan(store, lambda p, n: json.dumps({"tasks": [C.item()]}))
        self.assertEqual(out["created"], 1)
        tid = store.tasks("local")[0]["id"]
        store.capture(src, C.message(external_id="1:2", body=first + " Reminder, thanks."))
        # model repeats the same task without a match id: title-key match must still prevent a duplicate
        out, prompts, _ = await self.scan(store, lambda p, n: json.dumps({"tasks": [C.item(match_task_id=None)]}))
        self.assertEqual(len(store.tasks("local")), 1)
        self.assertEqual(len(store.tasks("local")[0]["evidence"]), 2)
        self.assertIn(tid, prompts[0])  # the existing task id is offered to the model
        # Title drift from the model ("Send the proposal again") with no match id -> creates a duplicate (counted, not asserted)
        store.capture(src, C.message(external_id="1:3", body=first + " Any update?"))
        await self.scan(store, lambda p, n: json.dumps({"tasks": [C.item(title="Proposal still needed", match_task_id=None)]}))
        print(f"[bench] crm title-drift duplicate: {len(store.tasks('local'))} tasks after a reworded same-thread repeat (1 would be ideal)")

    async def test_prompt_is_bounded_for_huge_and_local_context(self):
        store, (src,) = self.make()
        huge = "Please review the contract by Friday. " + "x" * 400_000
        msg = store.capture(src, C.message(external_id="1:9", body=huge[:60000]))
        prompt, context, bounded, _ = scanner.extraction_input(msg, [], store.settings("local"))
        with patch.object(scanner.tab_api, "model_context_size", return_value=None):
            prompt, *_ = scanner.extraction_input(msg, [], store.settings("local"))
        self.assertLessEqual(len(prompt.encode()), 30000 + 2500)  # 30 KB cap on the body plus wrapper/metadata
        self.assertTrue(bounded["truncated"])
        print(f"[bench] crm 60 KB body -> prompt {est_tokens(prompt)} tok (~{len(prompt.encode())} B), capped at 30 KB of source text")

    async def test_bug_same_message_in_two_selected_mailboxes_creates_one_task(self):
        """A forwarded/cc'd message with the same Message-ID in two connected inboxes."""
        store, (a, b) = self.make(n_sources=2)
        for s in (a, b):
            store.capture(s, C.message(external_id="1:1", thread_id="<same@test>", body=C.BODY))
        await self.scan(store, lambda p, n: json.dumps({"tasks": [C.item()]}))
        self.assertEqual(len(store.tasks("local")), 1)


if __name__ == "__main__":
    unittest.main()

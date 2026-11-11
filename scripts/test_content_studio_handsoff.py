"""Hands-off posting (David, 2026-11-11: "yes fully hands off posting"): services/content_studio/handsoff.py.

Off: the Producer cannot approve and nothing posts on its own. On (the person's click): the Producer approves with a
reason, approved YouTube and Instagram posts go out on schedule within the niche's slots, TikTok never does, Pause team
stops everything at once, a platform warning pauses the channel, the spend cap stops the work, and the Producer's
updates come batched. No network: the publishers are stand-ins. Run: python scripts/test_content_studio_handsoff.py
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

DATA = tempfile.TemporaryDirectory(prefix="kairos-handsoff-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import bot_policy  # noqa: E402
from core import bot_content_studio_tools  # noqa: E402,F401
from services.content_studio import handsoff, report  # noqa: E402
from services.content_studio.store import Store, StudioError  # noqa: E402
from services import studio_team_package as template  # noqa: E402

from types import SimpleNamespace  # noqa: E402
CTX = SimpleNamespace(turn_taint=None)
NOT_CAPPED = lambda: {"capped": False, "near_cap": False}  # noqa: E731
CAPPED = lambda: {"capped": True, "near_cap": True}  # noqa: E731


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(dir=DATA.name)
        self.store = Store(os.path.join(self.dir, "studio.db"))
        self.addCleanup(self.store.close)
        self.store.update_settings(team_roles={"p1": "producer", "pub1": "publisher"})
        niche = self.store.create_niche("Space")
        self.yt = self.store.create_channel(niche["id"], "youtube", "@space")
        self.ig = self.store.create_channel(niche["id"], "instagram", "@space.ig")
        self.tt = self.store.create_channel(niche["id"], "tiktok", "@space.tt")
        self.sent, self.posted = [], []

    def queued(self, channel, title):
        post = self.store.create_post(channel["id"], title)
        self.store._update("posts", post["id"], state="awaiting_approval", render_status="ok", render_ref="r.mp4",
                           script_ref="script")
        return post["id"]

    def publishers(self, fail=False):
        async def publish(store, post_id, by, guard=None):
            problem = guard() if guard else None   # what the real publishers do before the irreversible call
            if problem:
                raise StudioError(f"Not posted: {problem}")
            if fail:
                raise StudioError("the upload was refused")
            self.posted.append((post_id, by))
            store.mark_posted(post_id, f"https://example.com/{post_id}")
            return {"note": "YouTube kept it private."}
        return {"youtube": publish, "instagram": publish}

    def deliver(self, bot_id, title, body):
        self.sent.append((bot_id, title, body))
        return True

    def tick(self, **kw):
        return asyncio.run(handsoff.tick(self.store, publishers=kw.pop("publishers", self.publishers()), spend=kw.pop("spend", NOT_CAPPED),
                                         deliver=self.deliver, **kw))


class Off(Case):
    def test_off_the_producer_cannot_approve_and_nothing_posts(self):
        post = self.queued(self.yt, "Moon")
        with self.assertRaises(StudioError):
            handsoff.producer_approve(self.store, post, "Producer", "Ready")
        self.store.approve(post, by="david")
        self.assertEqual(self.tick(), {"posted": [], "sent": []})
        self.assertEqual(self.posted, [])


class On(Case):
    def setUp(self):
        super().setUp()
        handsoff.set_hands_off(self.store, True, "david")

    def test_the_producer_approves_with_its_reason_and_youtube_and_instagram_post(self):
        a, b = self.queued(self.yt, "Moon"), self.queued(self.ig, "Mars")
        for post in (a, b):
            approved = handsoff.producer_approve(self.store, post, "Producer", "Sourced, checks passed", )
            self.assertEqual(approved["approved_by"], "Producer (Producer)")
        evidence = self.store.evidence(a, "producer_approval")
        self.assertEqual(evidence[0]["body"]["reason"], "Sourced, checks passed")
        with self.assertRaises(StudioError):
            handsoff.producer_approve(self.store, self.queued(self.yt, "No reason"), "Producer", "")
        result = self.tick()
        self.assertEqual(sorted(p for p, _ in self.posted), sorted([a, b]))
        self.assertTrue(all(r["ok"] for r in result["posted"]))
        self.assertTrue(all(by == "Publisher" for _, by in self.posted))

    def test_tiktok_never_posts_on_its_own_and_waits_for_a_tap(self):
        post = self.queued(self.tt, "Comets")
        handsoff.producer_approve(self.store, post, "Producer", "Ready")
        result = self.tick()
        self.assertEqual(self.posted, [])
        self.assertEqual([p["id"] for p in handsoff.tiktok_taps(self.store)], [post])
        self.assertEqual(len(self.sent), 1)
        self.assertIn("TikTok", self.sent[0][2])
        self.assertEqual([f["kind"] for f in result["sent"]], ["taps"])

    def test_one_post_a_day_per_channel_by_the_niche_slots_and_the_schedule(self):
        posts = [self.queued(self.yt, f"Post {n}") for n in range(3)]
        for post in posts:
            self.store.approve(post, by="david")
        self.tick()
        self.assertEqual(len(self.posted), 1)
        self.tick()
        self.assertEqual(len(self.posted), 1, "a second post the same day went out")
        later = time.time() + 2 * 86400
        self.tick(now=later)
        self.assertEqual(len(self.posted), 2)

    def test_pause_team_stops_posting_and_approving_at_once_and_holds_the_bots(self):
        post = self.queued(self.yt, "Moon")
        self.store.approve(post, by="david")
        handsoff.set_paused(self.store, True)
        self.assertEqual(self.tick()["posted"], [])
        with self.assertRaises(StudioError):
            handsoff.producer_approve(self.store, self.queued(self.yt, "Other"), "Producer", "Ready")
        handsoff.set_paused(self.store, False)
        self.tick()
        self.assertEqual([p for p, _ in self.posted], [post])

    def test_the_kill_switch_is_read_again_between_posts(self):
        a, b = self.queued(self.yt, "A"), self.queued(self.ig, "B")
        self.store.approve(a, by="david")
        self.store.approve(b, by="david")

        async def pause_after_first(store, post_id, by, guard=None):
            self.posted.append((post_id, by))
            store.mark_posted(post_id, f"https://example.com/{post_id}")
            handsoff.set_paused(store, True)
            return {}
        self.tick(publishers={"youtube": pause_after_first, "instagram": pause_after_first})
        self.assertEqual(len(self.posted), 1)

    def test_a_platform_warning_pauses_the_channel_and_is_said_at_once(self):
        post = self.queued(self.yt, "Moon")
        self.store.approve(post, by="david")
        self.store.record_warning(self.yt["id"], "Community guidelines strike")
        result = self.tick()
        self.assertEqual(self.posted, [])
        self.assertIn("platform_warning", [f["kind"] for f in result["sent"]])
        self.assertIn("strike", self.sent[0][2])

    def test_the_spend_cap_stops_the_work(self):
        post = self.queued(self.yt, "Moon")
        self.store.approve(post, by="david")
        result = self.tick(spend=CAPPED)
        self.assertEqual(self.posted, [])
        self.assertIn("spend_capped", [f["kind"] for f in result["sent"]])
        with self.assertRaises(StudioError):
            from unittest.mock import patch
            with patch.object(handsoff, "spend_problem", return_value="The monthly spend cap is reached."):
                handsoff.producer_approve(self.store, self.queued(self.yt, "Two"), "Producer", "Ready")

    def test_repeated_failures_are_raised_once_and_updates_are_batched(self):
        post = self.queued(self.yt, "Moon")
        self.store.approve(post, by="david")
        tiktok = self.queued(self.tt, "Comets")
        self.store.approve(tiktok, by="david")
        for _ in range(handsoff.FAILS_BEFORE_ALERT):
            self.tick(publishers=self.publishers(fail=True))
        texts = "\n".join(body for _, _, body in self.sent)
        self.assertIn("failed 3 times", texts)
        self.assertEqual(len(self.sent), 2, "one batch for the TikTok tap, one for the failure, never one per attempt")
        self.assertIn("- ", self.sent[0][2])
        before = len(self.sent)
        self.tick(publishers=self.publishers(fail=True))
        self.assertEqual(len(self.sent), before, "nothing new, nothing sent")

    def test_a_retirement_proposal_is_raised_and_still_needs_the_person(self):
        self.store.add_decision("retire", "niche", 1, "Space", "awaiting_user", "executor", reason="Behind for two reviews")
        result = self.tick()
        self.assertIn("retirement", [f["kind"] for f in result["sent"]])
        self.assertIn("needs your OK", self.sent[0][2])

    def test_the_weekly_report_lists_what_posted(self):
        post = self.queued(self.yt, "Moon dust")
        self.store.approve(post, by="Producer (Producer)")
        self.tick()
        text = report.render_text(report.build_report(self.store, spend=lambda: {"available": False}))
        self.assertIn("Moon dust on @space (youtube)", text)
        self.assertIn("Waiting for your tap on TikTok", text)


class ReviewFindings(Case):
    """The independent review of 2026-11-11, kept fixed: every bot-made post passes one gate, read again just before
    the irreversible call, whether the scheduler or the Publisher's own tool sends it."""

    def setUp(self):
        super().setUp()
        handsoff.set_hands_off(self.store, True, "david")

    def test_a_pause_during_the_upload_stops_the_publish_call(self):
        post = self.queued(self.yt, "Moon")
        self.store.approve(post, by="david")
        published = []

        async def slow_upload(store, post_id, by, guard=None):
            handsoff.set_paused(store, True)          # David presses Pause team while the upload runs
            problem = guard()
            if problem:
                raise StudioError(f"Not posted: {problem}")
            published.append(post_id)
            return {}
        result = self.tick(publishers={"youtube": slow_upload, "instagram": slow_upload})
        self.assertEqual(published, [])
        self.assertIn("paused", result["posted"][0]["error"])
        self.assertEqual(self.store.get_post(post)["state"], "approved")

    def test_the_gate_reads_pause_hands_off_warnings_cap_and_slots(self):
        a = self.queued(self.yt, "A")
        self.store.approve(a, by="david")
        self.assertIsNone(handsoff.gate(self.store, a, spend=NOT_CAPPED))
        self.assertIn("cap", handsoff.gate(self.store, a, spend=CAPPED))
        handsoff.set_hands_off(self.store, False, "david")
        self.assertIn("off", handsoff.gate(self.store, a, spend=NOT_CAPPED))
        self.assertIsNone(handsoff.gate(self.store, a, spend=NOT_CAPPED, require_hands_off=False))
        handsoff.set_hands_off(self.store, True, "david")
        self.store.record_warning(self.yt["id"], "Limit")
        self.assertIsNotNone(handsoff.gate(self.store, a, spend=NOT_CAPPED))
        self.store.resume_channel(self.yt["id"])
        b = self.queued(self.yt, "B")
        self.store.approve(b, by="david")
        self.store.mark_posted(a, "https://example.com/a")
        self.assertIn("for today", handsoff.gate(self.store, b, spend=NOT_CAPPED))
        t = self.queued(self.tt, "C")
        self.store.approve(t, by="david")
        self.assertIn("tap", handsoff.gate(self.store, t, spend=NOT_CAPPED))

    def test_the_publishers_own_tool_passes_the_same_gate_and_hands_on_its_guard(self):
        from unittest.mock import patch
        from core import bot_content_studio_tools as tools
        from services.content_studio import youtube_publish
        a, b = self.queued(self.yt, "A"), self.queued(self.yt, "B")
        for post in (a, b):
            self.store.approve(post, by="david")
        seen = []

        async def fake_publish(store, post_id, by, now=None, guard=None):
            seen.append((post_id, guard))
            self.assertIsNone(guard())
            store.mark_posted(post_id, f"https://youtube.com/watch?v={post_id}")
            return {"video_id": "v", "url": "u", "privacy": "private", "asked_privacy": "private", "note": ""}
        with patch.object(tools, "studio", self.store), patch.object(handsoff.pipeline, "_default_spend", NOT_CAPPED),                 patch.object(youtube_publish, "publish", fake_publish):
            asyncio.run(tools._publish({"post_id": a}, CTX, {"name": "Publisher"}, "publisher"))
            with self.assertRaises(StudioError):   # the channel's slot for today is used
                asyncio.run(tools._publish({"post_id": b}, CTX, {"name": "Publisher"}, "publisher"))
            handsoff.set_paused(self.store, True)
            with self.assertRaises(StudioError):
                asyncio.run(tools._publish({"post_id": b}, CTX, {"name": "Publisher"}, "publisher"))
        self.assertEqual([p for p, _ in seen], [a])
        self.assertIsNotNone(seen[0][1])


class SecondReview(Case):
    """Codex's re-review of 2026-11-11, kept fixed."""

    def setUp(self):
        super().setUp()
        handsoff.set_hands_off(self.store, True, "david")

    def approved(self, channel, title):
        post = self.queued(channel, title)
        self.store.approve(post, by="david")
        return post

    def test_a_call_let_through_by_hands_off_needs_it_still_on(self):
        from unittest.mock import patch
        from core import bot_content_studio_tools as tools, bot_policy
        post = self.approved(self.yt, "A")
        with patch.object(tools, "studio", self.store), patch.object(handsoff.pipeline, "_default_spend", NOT_CAPPED):
            with patch.object(bot_policy, "admission", return_value="team"):
                guard = tools._gated(post, "pub1", "content_studio_publish_youtube")
                handsoff.set_hands_off(self.store, False, "david")
                self.assertIn("off", guard())
                with self.assertRaises(StudioError):
                    tools._gated(post, "pub1", "content_studio_publish_youtube")
            with patch.object(bot_policy, "admission", return_value="person"):
                self.assertIsNone(tools._gated(post, "pub1", "content_studio_publish_youtube")())

    def test_every_attempt_of_an_irreversible_call_checks_first_retries_included(self):
        import httpx
        from unittest.mock import AsyncMock, patch
        from core import google_workspace as google
        from services.content_studio import social_auth
        calls = []

        def before():
            calls.append(len(calls))
            if len(calls) == 2:
                raise StudioError("Not posted: the team is paused")
        limited = httpx.Response(429, headers={"retry-after": "0"}, request=httpx.Request("POST", "https://graph.example"))
        with patch.object(social_auth, "_sleep", AsyncMock()), \
                patch.object(httpx.AsyncClient, "request", AsyncMock(side_effect=[limited, AssertionError("sent after pause")])):
            with self.assertRaises(StudioError):
                asyncio.run(social_auth.send("instagram", "POST", "https://graph.example/x", before=before))
        self.assertEqual(calls, [0, 1])
        calls.clear()
        expired = httpx.Response(401, request=httpx.Request("POST", "https://www.googleapis.com/upload"))
        with patch.object(google, "_token", AsyncMock(return_value="t")), \
                patch.object(httpx.AsyncClient, "request", AsyncMock(side_effect=[expired, AssertionError("sent after pause")])):
            with self.assertRaises(StudioError):
                asyncio.run(google.request("youtube_upload", "POST", "/videos", content=b"x", content_type="video/mp4",
                                           account="a", before=before))
        self.assertEqual(calls, [0, 1])

    def test_a_post_instagram_took_is_never_sent_again_and_counts_for_the_day(self):
        from services.content_studio import instagram_api, social_auth
        a, b = self.approved(self.ig, "A"), self.approved(self.ig, "B")
        social_auth.remember_publish(a, platform="instagram", media_id="M1", channel_id=self.ig["id"], at=time.time())
        self.addCleanup(social_auth.forget_publish, a)
        with self.assertRaises(StudioError) as caught:
            asyncio.run(instagram_api.publish(self.store, a, "Publisher"))
        self.assertIn("already has this post", caught.exception.detail)
        self.store.mark_published(a)
        self.assertEqual(self.store.get_post(a)["state"], "posted")
        self.assertIn("for today", handsoff.gate(self.store, b, spend=NOT_CAPPED))
        self.assertEqual(self.store.set_posted_link(a, "https://www.instagram.com/reel/abc/")["posted_url"],
                         "https://www.instagram.com/reel/abc/")

    def test_unknown_spend_stops_approving_and_posting_and_says_so(self):
        from unittest.mock import patch
        post = self.approved(self.yt, "A")
        for unknown in (lambda: None, lambda: (_ for _ in ()).throw(RuntimeError("usage store unreadable"))):
            self.assertIn("could not be checked", handsoff.gate(self.store, post, spend=unknown))
        result = self.tick(spend=lambda: None)
        self.assertEqual(self.posted, [])
        self.assertIn("spend_unknown", [f["kind"] for f in result["sent"]])
        with patch.object(handsoff.pipeline, "_default_spend", lambda: None):
            with self.assertRaises(StudioError):
                handsoff.producer_approve(self.store, self.queued(self.yt, "B"), "Producer", "Ready")


class ThirdReview(Case):
    """Codex's third review of 2026-11-11, kept fixed."""

    def setUp(self):
        super().setUp()
        handsoff.set_hands_off(self.store, True, "david")

    def approved(self, channel, title):
        post = self.queued(channel, title)
        self.store.approve(post, by="david")
        return post

    def test_a_publish_whose_answer_was_lost_is_held_and_counted(self):
        from services.content_studio import social_auth, youtube_publish
        ig, other = self.approved(self.ig, "Reel"), self.approved(self.ig, "Second reel")
        social_auth.remember_publish(ig, platform="instagram", state="publishing", container_id="C1",
                                     channel_id=self.ig["id"], caption="cap", at=time.time())
        self.addCleanup(social_auth.forget_publish, ig)
        self.assertIn("could not be confirmed", handsoff.gate(self.store, ig, spend=NOT_CAPPED))
        self.assertIsNone(handsoff.gate(self.store, ig, spend=NOT_CAPPED, publishing=True), "the publish going out passes its own guard")
        self.assertIn("for today", handsoff.gate(self.store, other, spend=NOT_CAPPED))
        yt = self.approved(self.yt, "Video")
        youtube_publish._set_pending(yt, {"at": time.time(), "title": "Video", "channel_id": self.yt["id"]})
        self.addCleanup(youtube_publish._set_pending, yt, None)
        self.assertIn("could not be confirmed", handsoff.gate(self.store, yt, spend=NOT_CAPPED))
        self.tick()
        self.assertEqual(self.posted, [])

    def test_instagram_settles_a_lost_publish_by_asking_before_any_retry(self):
        from unittest.mock import patch
        from services.content_studio import instagram_api
        pending = {"container_id": "C1", "caption": "Our caption"}

        def fake(answers):
            async def call(channel_id, method, path, **kw):
                return answers[path]
            return call
        cases = [({"/C1": {"status_code": "PUBLISHED"}, "/ig/media": {"data": [{"id": "M9", "caption": "Our caption"}]}}, ("published", "M9")),
                 ({"/C1": {"status_code": "FINISHED"}}, ("not_published", None)),
                 ({"/C1": {"status_code": "SOMETHING"}}, ("unknown", None))]
        for answers, expected in cases:
            with patch.object(instagram_api, "_call", fake(answers)):
                self.assertEqual(asyncio.run(instagram_api.reconcile(1, "ig", pending)), expected)

    def test_youtube_settles_a_lost_upload_by_asking_before_any_retry(self):
        from unittest.mock import AsyncMock, patch
        from services.content_studio import youtube, youtube_publish
        item = {"title": "Moon dust"}
        found = {"items": [{"id": {"videoId": "V1"}, "snippet": {"title": "Moon dust"}}]}
        with patch.object(youtube, "_call", AsyncMock(return_value=found)):
            self.assertEqual(asyncio.run(youtube_publish.reconcile("acct", item)), ("published", "V1"))
        with patch.object(youtube, "_call", AsyncMock(return_value={"items": []})):
            self.assertEqual(asyncio.run(youtube_publish.reconcile("acct", item)), ("not_published", None))
        with patch.object(youtube, "_call", AsyncMock(side_effect=RuntimeError("offline"))):
            self.assertEqual(asyncio.run(youtube_publish.reconcile("acct", item)), ("unknown", None))

    def test_runs_with_unknown_cost_make_spend_unknown(self):
        post = self.approved(self.yt, "A")
        state = {"capped": False, "near_cap": False, "spent_usd": 3.0, "monthly_usd": 50, "unknown_cost_runs": 2}
        self.assertIn("no known cost", handsoff.gate(self.store, post, spend=lambda: state))
        self.assertIsNone(handsoff.gate(self.store, post, spend=lambda: {**state, "unknown_cost_runs": 0}))
        from services.content_studio import pipeline
        from unittest.mock import patch
        from services import bot_spend
        with patch.object(bot_spend, "budget", return_value={"capped": False, "near_cap": False, "spent_usd": 1.0,
                                                             "monthly_usd": 50, "unknown_cost_runs": 1}):
            self.assertEqual(pipeline._default_spend()["unknown_cost_runs"], 1)


class Policy(unittest.TestCase):
    def test_publish_tools_still_ask_and_approving_is_internal_but_self_guarded(self):
        self.assertIn("content_studio_approve_post", bot_policy.CONTENT_STUDIO_INTERNAL_TOOLS)
        self.assertTrue(bot_policy.HANDS_OFF_PUBLISH_TOOLS <= bot_policy.CONTENT_STUDIO_ASKS)
        self.assertIsNotNone(bot_policy.internal_tool_problem("content_studio_publish_youtube"))

    def test_the_template_says_both_rules(self):
        soul = next(b["soul"] for b in template.BOTS if b["name"] == "Producer")
        self.assertIn("Hands-off posting off, the default: every post waits for the person's OK", soul)
        self.assertIn("content_studio_approve_post", soul)
        self.assertIn("TikTok still waits for the person's own tap", soul)
        self.assertNotIn("—", soul)


if __name__ == "__main__":
    unittest.main()

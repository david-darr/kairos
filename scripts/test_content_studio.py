"""Content Studio team: scoring record, selection rules, pipeline view, approval queue, watch and weekly report
(build spec "Content Studio Team", steps 2 and 4). Service tests run on throwaway stores with a moved clock;
API tests use two real accounts on a throwaway data folder."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-studio-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
os.environ["AUTH_ENABLED"] = "true"
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

from fastapi.testclient import TestClient  # noqa: E402

import app as kairos  # noqa: E402
from core import accounts  # noqa: E402
from core.auth import auth_manager  # noqa: E402
from services.content_studio import StudioError, Store, close_all, delivery, pipeline, report, review, scoring  # noqa: E402
import atexit  # noqa: E402

_STORES = []


def _close_everything():
    for store in _STORES:
        store.close()
    close_all()


atexit.register(_close_everything)  # runs before the data folder is removed: SQLite files stay locked on Windows while open

DAY = 86400.0
T0 = 1_700_000_000.0
NOW1 = T0 + 31 * DAY      # first weekly review: every post is 7+ days old, the first is 31 days old
NOW2 = NOW1 + 7 * DAY


def posted(store, channel_id, title, at, views, avd=5.0, length=10.0, likes=0, comments=0, shares=0, follows=0,
           script=None, evaluator=None, format=None):
    """A post taken all the way to posted, with a 7 day snapshot."""
    post = store.create_post(channel_id, title, script_strategy_id=script, evaluator_strategy_id=evaluator, format=format,
                             script_ref=f"The script of {title}", now=at - 7200)
    # Each post is its own video: the policy checks refuse one video on two of the team's channels.
    store.edit_post(post["id"], now=at - 3600, render_ref=f"render-{post['id']}.mp4", render_status="ok")
    store.submit_for_approval(post["id"], now=at - 1800)
    store.approve(post["id"], "david", now=at - 900)
    store.mark_posted(post["id"], f"https://example.test/{post['id']}", posted_at=at, now=at)
    store.add_snapshot(post["id"], views=views, avg_view_duration_s=avd, video_length_s=length, likes=likes, comments=comments,
                       shares=shares, follows_gained=follows, taken_at=at + 7 * DAY, now=at + 7 * DAY)
    return store.get_post(post["id"])


def make_store():
    folder = tempfile.mkdtemp(prefix="studio-", dir=_DATA.name)
    _STORES.append(Store(os.path.join(folder, "studio.db")))
    return _STORES[-1]


def three_niches(store, posts=10):
    """A strong, a middling and a weak niche, one YouTube channel each, `posts` posts each."""
    out = {}
    for key, name, base, avd, likes, follows in (("a", "Space", 1000, 9, 100, 5), ("b", "Cooking", 500, 5, 20, 1),
                                                 ("c", "Chess", 10, 1, 0, 0)):
        niche = store.create_niche(name, now=T0 - DAY)
        channel = store.create_channel(niche["id"], "youtube", f"@{name.lower()}", now=T0 - DAY)
        for i in range(posts):
            posted(store, channel["id"], f"{name} {i}", T0 + i * DAY, base + i, avd=avd, likes=likes, follows=follows)
        out[key] = (niche, channel)
    return out


class Scoring(unittest.TestCase):
    def test_rank_pct_and_ties(self):
        self.assertEqual(scoring.rank_pct([5]), [0.5])
        self.assertEqual(scoring.rank_pct([10, 30, 20]), [0.0, 1.0, 0.5])
        self.assertEqual(scoring.rank_pct([1, 1, 3]), [0.25, 0.25, 1.0])

    def test_score_is_the_weighted_mix_of_ranks(self):
        items = [{"id": 1, "platform": "youtube", "views": 100, "watch": .2, "engagement": .1},
                 {"id": 2, "platform": "youtube", "views": 200, "watch": .8, "engagement": .05},
                 {"id": 3, "platform": "youtube", "views": 300, "watch": .5, "engagement": .2}]
        got = scoring.score_posts(items, {"views": .4, "watch": .4, "engagement": .2})
        self.assertEqual({k: round(v["score"], 6) for k, v in got.items()}, {1: 10.0, 2: 60.0, 3: 80.0})
        views_only = scoring.score_posts(items, {"views": 1, "watch": 0, "engagement": 0})
        self.assertEqual([views_only[i]["score"] for i in (1, 2, 3)], [0.0, 50.0, 100.0])
        scaled = scoring.score_posts(items, {"views": 40, "watch": 40, "engagement": 20})
        self.assertEqual(scaled[3]["score"], got[3]["score"], "weights are normalised")

    def test_parts_are_ranked_within_each_platform(self):
        items = [{"id": "y1", "platform": "youtube", "views": 1_000, "watch": .5, "engagement": .1},
                 {"id": "y2", "platform": "youtube", "views": 2_000, "watch": .6, "engagement": .2},
                 {"id": "t1", "platform": "tiktok", "views": 900_000, "watch": .5, "engagement": .1},
                 {"id": "t2", "platform": "tiktok", "views": 5, "watch": .6, "engagement": .2}]
        got = scoring.score_posts(items, {"views": .4, "watch": .4, "engagement": .2})
        self.assertEqual((got["y2"]["score"], got["t1"]["score"]), (100.0, 40.0), "a huge TikTok count does not beat YouTube")
        self.assertEqual((got["y1"]["score"], got["t2"]["score"]), (0.0, 60.0))

    def test_post_parts(self):
        snap = {"views": 200, "avg_view_duration_s": 15, "video_length_s": 10, "likes": 10, "comments": 4, "shares": 6, "follows_gained": 2}
        parts = scoring.post_parts(snap, follow_weight=5)
        self.assertEqual(parts, {"views": 200.0, "watch": 1.0, "engagement": 0.15}, "watch share is capped at 1")

    def test_seven_day_snapshot_must_be_close_to_the_mark(self):
        snaps = [{"taken_at": T0 + 1 * DAY}, {"taken_at": T0 + 6.5 * DAY}, {"taken_at": T0 + 30 * DAY}]
        self.assertEqual(scoring.seven_day_snapshot(T0, snaps)["taken_at"], T0 + 6.5 * DAY)
        self.assertIsNone(scoring.seven_day_snapshot(T0, [{"taken_at": T0 + 30 * DAY}]))


class MinimumData(unittest.TestCase):
    def test_a_niche_is_not_judged_before_ten_posts_and_three_weeks(self):
        store = make_store()
        nine = store.create_niche("Nine", now=T0)
        ch = store.create_channel(nine["id"], "youtube", "@nine", now=T0)
        for i in range(9):
            posted(store, ch["id"], f"n{i}", T0 + i * DAY, 100 + i)
        row = next(n for n in review.scoreboard(store, NOW1)["niches"] if n["id"] == nine["id"])
        self.assertFalse(row["eligible"])
        self.assertIn("9 of 10", row["not_yet"])
        posted(store, ch["id"], "n9", T0 + 9 * DAY, 109)
        self.assertTrue(next(n for n in review.scoreboard(store, NOW1)["niches"] if n["id"] == nine["id"])["eligible"])
        young = review.scoreboard(store, T0 + 20 * DAY)  # ten posts but the first is only 20 days old
        row = next(n for n in young["niches"] if n["id"] == nine["id"])
        self.assertFalse(row["eligible"])
        self.assertIn("of 21 days", row["not_yet"])

    def test_nothing_is_proposed_without_minimum_data(self):
        store = make_store()
        three_niches(store, posts=9)
        result = review.run_review(store, NOW1, dry_run=True)
        self.assertEqual(result["proposals"], [])
        self.assertTrue(any("not judged yet" in note for note in result["notes"]))


class Selection(unittest.TestCase):
    def test_retire_needs_two_reviews_running_then_the_user(self):
        store = make_store()
        n = three_niches(store)
        chess = n["c"][0]
        # First review: Chess is behind, but not yet for two reviews running.
        first = review.run_review(store, NOW1, dry_run=False)
        self.assertEqual(first["proposals"], [])
        self.assertTrue(any("running" in note for note in first["notes"]))
        board = {r["name"]: r for r in first["board"]["niches"]}
        self.assertGreater(board["Space"]["score"], board["Cooking"]["score"])
        self.assertGreater(board["Cooking"]["score"], board["Chess"]["score"])
        # A real review twice in one week is refused; a dry run is not recorded.
        with self.assertRaises(StudioError) as early:
            review.run_review(store, NOW1 + 2 * DAY, dry_run=False)
        self.assertEqual(early.exception.status, 409)
        # A week later a dry run shows the proposal and files nothing.
        dry = review.run_review(store, NOW2, dry_run=True)
        self.assertEqual([(p["kind"], p["subject_name"], p["status"]) for p in dry["proposals"]], [("retire", "Chess", "preview")])
        self.assertEqual(store.list_decisions(), [])
        real = review.run_review(store, NOW2, dry_run=False)
        [proposal] = real["proposals"]
        self.assertEqual((proposal["kind"], proposal["status"], proposal["proposed_by"]), ("retire", "proposed", "executor"))
        numbers = proposal["numbers"]
        self.assertLess(numbers["score"], numbers["threshold"])
        self.assertAlmostEqual(numbers["threshold"], 0.5 * numbers["team_median"])
        self.assertEqual(numbers["winner"]["name"], "Space")
        self.assertEqual(numbers["live_channels"], 1)
        self.assertEqual(store.get_niche(chess["id"])["status"], "live", "a proposal changes nothing")
        # No second proposal for the same niche while one waits.
        again = review.run_review(store, NOW2 + 7 * DAY, dry_run=False)
        self.assertEqual(again["proposals"], [])
        self.assertTrue(any("already has a retirement waiting" in note for note in again["notes"]))

        # The Producer confirms; the channel retirement then waits for the user.
        waiting = review.confirm(store, proposal["id"], "producer", "producer-bot", now=NOW2 + 1)
        self.assertEqual((waiting["status"], waiting["confirmed_by"], waiting["user_ok_by"]), ("awaiting_user", "producer-bot", None))
        self.assertEqual(store.get_niche(chess["id"])["status"], "live")
        self.assertEqual(len(store.list_channels(niche_id=chess["id"], status="live")), 1)
        with self.assertRaises(StudioError) as stuck:
            review.confirm(store, proposal["id"], "producer", "producer-bot")
        self.assertEqual(stuck.exception.status, 409)
        done = review.confirm(store, proposal["id"], "user", "david", now=NOW2 + 2)
        self.assertEqual((done["status"], done["confirmed_by"], done["user_ok_by"]), ("confirmed", "producer-bot", "david"))

        # Retired, not deleted: niche and channel are archived with their history; slots go to the winner.
        niche = store.get_niche(chess["id"])
        self.assertEqual(niche["status"], "retired")
        self.assertEqual(niche["retired_at"], NOW2 + 2)
        self.assertIn("Below 50%", niche["retire_reason"])
        [channel] = store.list_channels(niche_id=chess["id"])
        self.assertEqual(channel["status"], "archived")
        self.assertEqual(len(store.list_posts(niche_id=chess["id"])), 10, "history kept")
        self.assertEqual(store.get_niche(n["a"][0]["id"])["slots"], 2)
        kinds = {(d["kind"], d["subject_name"], d["status"]) for d in store.list_decisions()}
        self.assertEqual(kinds, {("retire", "Chess", "confirmed"), ("promote", "Space", "confirmed"), ("replace", "Chess", "open")})
        promote = store.list_decisions(kind="promote")[0]
        self.assertEqual((promote["numbers"]["freed_slots"], promote["numbers"]["slots_after"]), (1, 2))

        # A new niche answers the open replacement request.
        fresh = store.create_niche("Gardening", now=NOW2 + DAY)
        ask = store.list_decisions(kind="replace")[0]
        self.assertEqual((ask["status"], ask["payload"]["replaced_by"]), ("confirmed", fresh["id"]))

    def test_the_users_confirm_covers_the_producers_and_a_channelless_niche_needs_no_user(self):
        store = make_store()
        three_niches(store)
        review.run_review(store, NOW1, dry_run=False)
        [proposal] = review.run_review(store, NOW2, dry_run=False)["proposals"]
        done = review.confirm(store, proposal["id"], "user", "david", now=NOW2 + 1)
        self.assertEqual((done["status"], done["user_ok_by"]), ("confirmed", "david"))
        # A niche with no live channel needs only the Producer.
        store2 = make_store()
        n = three_niches(store2)
        for _, channel in n.values():
            if channel["handle"] == "@chess":
                store2.archive_channel(channel["id"], now=NOW1 - 1)
        review.run_review(store2, NOW1, dry_run=False)
        [p2] = review.run_review(store2, NOW2, dry_run=False)["proposals"]
        self.assertEqual(p2["numbers"]["live_channels"], 0)
        self.assertEqual(review.confirm(store2, p2["id"], "producer", "producer-bot")["status"], "confirmed")

    def test_rejected_proposal_changes_nothing(self):
        store = make_store()
        n = three_niches(store)
        review.run_review(store, NOW1, dry_run=False)
        [proposal] = review.run_review(store, NOW2, dry_run=False)["proposals"]
        rejected = review.reject(store, proposal["id"], "david", "give it a month", now=NOW2 + 1)
        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(store.get_niche(n["c"][0]["id"])["status"], "live")
        with self.assertRaises(StudioError):
            review.confirm(store, proposal["id"], "user", "david")

    def test_a_streak_needs_consecutive_reviews(self):
        store = make_store()
        n = three_niches(store)
        review.run_review(store, NOW1, dry_run=False)
        # Chess recovers before the second review (strong new posts lift its average above the threshold).
        ch = n["c"][1]
        for i in range(30):
            posted(store, ch["id"], f"boost {i}", T0 + 10 * DAY + i * 3600, 5000 + i, avd=10, likes=500, follows=50)
        result = review.run_review(store, NOW2, dry_run=False)
        self.assertEqual(result["proposals"], [])

    def test_five_niche_cap(self):
        store = make_store()
        for i in range(5):
            store.create_niche(f"Niche {i}", now=T0)
        with self.assertRaises(StudioError) as over:
            store.create_niche("Niche 5", now=T0)
        self.assertEqual(over.exception.status, 409)
        with self.assertRaises(StudioError):
            store.update_settings(max_niches=6)
        store.update_settings(max_niches=4)
        with self.assertRaises(StudioError):
            store.create_niche("again", now=T0)
        store.retire_niche(store.list_niches()[0]["id"], "test", now=T0)
        self.assertEqual(len(store.list_niches("live")), 4)
        store.update_settings(max_niches=5)
        store.create_niche("Back to five", now=T0)
        with self.assertRaises(StudioError):
            store.create_niche("Niche 5", now=T0)

    def test_strategy_replacement_keeps_lineage(self):
        store = make_store()
        niche = store.create_niche("Space", now=T0 - DAY)
        channel = store.create_channel(niche["id"], "youtube", "@space", now=T0 - DAY)
        hook = store.create_strategy("script_writer", "hook-first", now=T0 - DAY)
        story = store.create_strategy("script_writer", "story-first", now=T0 - DAY)
        self.assertTrue(hook["is_default"], "the first strategy of a role starts as the default")
        self.assertFalse(story["is_default"])
        for i in range(10):
            posted(store, channel["id"], f"h{i}", T0 + i * DAY, 2000 + i, avd=8, likes=80, script=hook["id"])
            posted(store, channel["id"], f"s{i}", T0 + i * DAY + 3600, 100 + i, avd=2, likes=5, script=story["id"])
        result = review.run_review(store, NOW1, dry_run=False)
        [proposal] = [p for p in result["proposals"] if p["kind"] == "replace"]
        self.assertEqual((proposal["subject_name"], proposal["numbers"]["winner"]["name"]), ("story-first", "hook-first"))
        done = review.confirm(store, proposal["id"], "producer", "producer-bot", now=NOW1 + 1)
        self.assertEqual(done["status"], "confirmed", "strategy swaps need only the Producer")
        self.assertEqual(done["payload"]["variation_name"], "hook-first v2")
        self.assertEqual(store.get_strategy(story["id"])["status"], "dropped")
        variation = store.get_strategy(done["payload"]["variation_id"])
        self.assertEqual((variation["parent_id"], variation["status"], variation["owner_role"]), (hook["id"], "active", "script_writer"))
        self.assertTrue(store.get_strategy(hook["id"])["is_default"])
        with self.assertRaises(StudioError):
            store.create_post(channel["id"], "late", script_strategy_id=story["id"], now=NOW1)
        # Next time the winner is varied again under a fresh name.
        third = store.create_strategy("script_writer", "hook-first v3", parent_id=hook["id"], now=NOW1)
        self.assertEqual(third["parent_id"], hook["id"])

    def test_close_strategies_both_stay(self):
        store = make_store()
        niche = store.create_niche("Space", now=T0 - DAY)
        channel = store.create_channel(niche["id"], "youtube", "@space", now=T0 - DAY)
        a = store.create_strategy("evaluator", "trend-weighted", now=T0)
        b = store.create_strategy("evaluator", "record-weighted", now=T0)
        for i in range(10):
            posted(store, channel["id"], f"a{i}", T0 + i * DAY, 500 + 2 * i, avd=5, evaluator=a["id"])
            posted(store, channel["id"], f"b{i}", T0 + i * DAY + 3600, 501 + 2 * i, avd=5, evaluator=b["id"])
        result = review.run_review(store, NOW1, dry_run=True)
        self.assertEqual(result["proposals"], [])
        self.assertTrue(any("both stay" in note for note in result["notes"]))

    def test_formats_are_scored_on_the_board(self):
        store = make_store()
        niche = store.create_niche("Space", now=T0 - DAY)
        channel = store.create_channel(niche["id"], "youtube", "@space", now=T0 - DAY)
        for i in range(10):
            posted(store, channel["id"], f"x{i}", T0 + i * DAY, 100 + i, format="explainer")
        board = review.scoreboard(store, NOW1)
        [fmt] = board["formats"]
        self.assertEqual((fmt["name"], fmt["posts_scored"], fmt["eligible"]), ("explainer", 10, True))

    def test_user_archiving_a_channel_is_recorded_and_reversible(self):
        store = make_store()
        niche = store.create_niche("Space", now=T0)
        channel = store.create_channel(niche["id"], "tiktok", "@space", now=T0)
        review.user_archives_channel(store, channel["id"], "david", "not worth it", now=T0 + DAY)
        [decision] = store.list_decisions()
        self.assertEqual((decision["kind"], decision["subject_type"], decision["status"], decision["user_ok_by"]),
                         ("retire", "channel", "confirmed", "david"))
        self.assertEqual(store.get_channel(channel["id"])["status"], "archived")
        self.assertEqual(store.restore_channel(channel["id"])["status"], "live")

    def test_channels_are_registered_only_for_known_platforms_once(self):
        store = make_store()
        niche = store.create_niche("Space", now=T0)
        store.create_channel(niche["id"], "youtube", "@space", now=T0)
        with self.assertRaises(StudioError):
            store.create_channel(niche["id"], "myspace", "@space", now=T0)
        with self.assertRaises(StudioError) as dup:
            store.create_channel(niche["id"], "youtube", "@SPACE", now=T0)
        self.assertEqual(dup.exception.status, 409)


class ApprovalQueueAndWatch(unittest.TestCase):
    def setUp(self):
        self.store = make_store()
        self.niche = self.store.create_niche("Space", now=T0)
        self.channel = self.store.create_channel(self.niche["id"], "youtube", "@space", now=T0)

    def draft(self, title="Black holes", now=T0):
        return self.store.create_post(self.channel["id"], title, script_ref="s", now=now)

    def test_post_states(self):
        s = self.store
        post = self.draft()
        with self.assertRaises(StudioError):
            s.submit_for_approval(post["id"], T0)  # not rendered
        with self.assertRaises(StudioError):
            s.approve(post["id"], "david", T0)  # not awaiting
        s.edit_post(post["id"], now=T0, render_ref="r.mp4", render_status="ok")
        self.assertEqual(s.submit_for_approval(post["id"], T0)["state"], "awaiting_approval")
        self.assertEqual([p["id"] for p in pipeline.approval_queue(s)], [post["id"]])
        edited = s.edit_post(post["id"], now=T0, title="Black holes, explained")
        self.assertEqual((edited["state"], edited["title"]), ("awaiting_approval", "Black holes, explained"))
        approved = s.approve(post["id"], "david", T0 + 1)
        self.assertEqual((approved["state"], approved["approved_by"]), ("approved", "david"))
        self.assertEqual(pipeline.approval_queue(s), [])
        with self.assertRaises(StudioError):
            s.edit_post(post["id"], now=T0, title="too late")
        with self.assertRaises(StudioError):
            s.add_snapshot(post["id"], 1, 1, 10)  # not posted yet
        posted_post = s.mark_posted(post["id"], "https://example.test/v", T0 + 2, now=T0 + 2)
        self.assertEqual(posted_post["state"], "posted")
        with self.assertRaises(StudioError):
            s.reject(post["id"], "no")

    def test_reject_redraft_cycle_counts_rejections(self):
        s = self.store
        post = self.draft()
        s.edit_post(post["id"], now=T0, render_ref="r.mp4", render_status="ok")
        s.submit_for_approval(post["id"], T0)
        rejected = s.reject(post["id"], "weak hook", T0 + 1)
        self.assertEqual((rejected["state"], rejected["rejection_count"], rejected["reject_reason"]), ("rejected", 1, "weak hook"))
        self.assertEqual(s.redraft(post["id"], T0 + 2)["render_status"], "pending")
        s.edit_post(post["id"], now=T0 + 3, render_ref="r2.mp4", render_status="ok")
        s.submit_for_approval(post["id"], T0 + 3)
        self.assertEqual(s.reject(post["id"], "still weak", T0 + 4)["rejection_count"], 2)
        kinds = [f["kind"] for f in pipeline.watch(s, T0 + 5, spend=lambda: None)]
        self.assertIn("rejected_twice", kinds)

    def test_pipeline_steps_owners_and_age(self):
        s = self.store
        topic = s.add_topic(self.niche["id"], "Why stars die", "https://trends.example.test/x", T0, "rising", now=T0)
        [idea] = pipeline.pipeline(s, T0 + 3600)
        self.assertEqual((idea["kind"], idea["step"], idea["owner"], idea["status"], idea["age_h"]), ("topic", "pick", "evaluator", "candidate", 1.0))
        post = s.create_post(self.channel["id"], "Why stars die", topic_id=topic["id"], now=T0)
        [item] = pipeline.pipeline(s, T0 + 7200)
        self.assertEqual((item["kind"], item["step"], item["owner"]), ("post", "script", "script_writer"))
        s.edit_post(post["id"], now=T0, script_ref="beats")
        self.assertEqual(pipeline.pipeline(s, T0)[0]["step"], "render")
        s.edit_post(post["id"], now=T0, render_ref="r.mp4", render_status="ok")
        self.assertEqual((pipeline.pipeline(s, T0)[0]["step"], pipeline.pipeline(s, T0)[0]["owner"]), ("queue", "producer"))
        s.submit_for_approval(post["id"], T0)
        self.assertEqual((pipeline.pipeline(s, T0)[0]["step"], pipeline.pipeline(s, T0)[0]["owner"]), ("approval", "user"))
        with self.assertRaises(StudioError):
            s.add_topic(self.niche["id"], "No evidence", "", T0)

    def test_watch_findings(self):
        s = self.store
        failed = self.draft("Broken render", now=T0)
        s.edit_post(failed["id"], now=T0, render_status="failed")
        self.assertEqual(pipeline.watch(s, T0 + 3600, spend=lambda: None)[0]["kind"], "render_failed")
        late = {(f["kind"], f.get("post_id")) for f in pipeline.watch(s, T0 + 13 * 3600, spend=lambda: None)}
        self.assertIn(("render_failed", failed["id"]), late)
        waiting = self.draft("Waiting for you", now=T0)
        s.edit_post(waiting["id"], now=T0, render_ref="r.mp4", render_status="ok")
        s.submit_for_approval(waiting["id"], T0)
        found = {(f["kind"], f.get("post_id")): f for f in pipeline.watch(s, T0 + 50 * 3600, spend=lambda: None)}
        self.assertEqual(found[("step_overdue", waiting["id"])]["severity"], "info", "waiting on the user is only an info")
        self.assertNotIn(("step_overdue", waiting["id"]), {(f["kind"], f.get("post_id")) for f in pipeline.watch(s, T0 + 3600, spend=lambda: None)})
        near = pipeline.watch(s, T0, spend=lambda: {"near_cap": True, "capped": False, "spent_usd": 41, "monthly_usd": 50})
        self.assertIn("spend_near_cap", [f["kind"] for f in near])
        capped = pipeline.watch(s, T0, spend=lambda: {"near_cap": True, "capped": True, "spent_usd": 50, "monthly_usd": 50})
        self.assertIn("spend_capped", [f["kind"] for f in capped])
        self.assertNotIn("spend_near_cap", [f["kind"] for f in capped])

    def test_platform_warning_pauses_the_channel(self):
        s = self.store
        post = self.draft()
        s.edit_post(post["id"], now=T0, render_ref="r.mp4", render_status="ok")
        s.submit_for_approval(post["id"], T0)
        s.record_warning(self.channel["id"], "Community guidelines strike.", now=T0 + 1)
        findings = pipeline.watch(s, T0 + 2, spend=lambda: None)
        [warning] = [f for f in findings if f["kind"] == "platform_warning"]
        self.assertEqual((warning["severity"], warning["notify_user"], warning["channel_id"]), ("urgent", True, self.channel["id"]))
        with self.assertRaises(StudioError):
            s.create_post(self.channel["id"], "More", now=T0 + 3)
        with self.assertRaises(StudioError):
            s.approve(post["id"], "david", T0 + 3)
        s.resume_channel(self.channel["id"], T0 + 4)
        self.assertEqual([f for f in pipeline.watch(s, T0 + 5, spend=lambda: None) if f["kind"] == "platform_warning"], [])
        self.assertEqual(s.approve(post["id"], "david", T0 + 5)["state"], "approved")


class Report(unittest.TestCase):
    def test_weekly_report(self):
        store = make_store()
        three_niches(store)
        review.run_review(store, NOW1, dry_run=False)
        [proposal] = review.run_review(store, NOW2, dry_run=False)["proposals"]
        data = report.build_report(store, NOW2, spend=lambda: {"available": True, "team_spent_usd": 12.5, "all_bots_spent_usd": 20.0,
                                                               "cap_usd": 50, "near_cap": False, "capped": False})
        self.assertEqual(data["won"]["niches"][0]["name"], "Space")
        self.assertEqual([d["subject_name"] for d in data["retiring"]["waiting"]], ["Chess"])
        review.confirm(store, proposal["id"], "user", "david", now=NOW2 + 5)
        data = report.build_report(store, NOW2 + DAY, spend=lambda: {"available": True, "team_spent_usd": 12.5,
                                                                      "all_bots_spent_usd": 20.0, "cap_usd": 50})
        self.assertEqual([d["subject_name"] for d in data["retiring"]["retired_this_week"]], ["Chess"])
        self.assertEqual([d["subject_name"] for d in data["replacing"]["promotions"]], ["Space"])
        self.assertEqual([d["subject_name"] for d in data["replacing"]["niches_wanted"]], ["Chess"])
        proposed = review.propose_niche(store, "Deep sea", "https://trends.example.test", now=NOW2 + 6)
        review.confirm(store, proposed["id"], "producer", "Producer", now=NOW2 + 7)
        data = report.build_report(store, NOW2 + DAY, spend=lambda: {"available": True, "team_spent_usd": 12.5,
                                                                      "all_bots_spent_usd": 20.0, "cap_usd": 50})
        self.assertEqual([d["subject_name"] for d in data["replacing"]["niches_proposed"]], ["Deep sea"])
        self.assertIn("Deep sea is proposed as a new niche (waiting for you)", report.render_text(data))
        text = report.render_text(data)
        for needle in ("What won: Space", "Retired this week: Chess", "Space takes freed slots", "replacement for Chess", "$12.50", "cap $50"):
            self.assertIn(needle, text)

    def test_spend_hook_degrades_clearly(self):
        store = make_store()
        spend = report.team_spend(store, NOW1)
        self.assertIn("available", spend)
        self.assertIsInstance(report.render_text(report.build_report(store, NOW1)), str)


class Settings(unittest.TestCase):
    def test_weights_are_a_team_setting(self):
        store = make_store()
        self.assertEqual(store.settings()["weights"], {"views": .4, "watch": .4, "engagement": .2})
        store.update_settings(weights={"views": 1, "watch": 1, "engagement": 0})
        self.assertEqual(store.settings()["weights"]["engagement"], 0)
        with self.assertRaises(StudioError):
            store.update_settings(weights={"views": 0, "watch": 0, "engagement": 0})
        with self.assertRaises(StudioError):
            store.update_settings(nonsense=1)


class ChannelProfileBatchAndStrategies(unittest.TestCase):
    def setUp(self):
        self.store = make_store()
        niche = self.store.create_niche("Space")
        self.channel = self.store.create_channel(niche["id"], "youtube", "@space")

    def rendered(self, title):
        post = self.store.create_post(self.channel["id"], title, script_ref="beats")
        self.store.edit_post(post["id"], render_ref="r.mp4", render_status="ok")
        return self.store.submit_for_approval(post["id"])

    def test_channel_look_aspect_and_notes(self):
        s = self.store
        got = s.edit_channel(self.channel["id"], look="neon-grid", aspect="16:9", notes="Dry humour.")
        self.assertEqual((got["look"], got["aspect"], got["notes"]), ("neon-grid", "16:9", "Dry humour."))
        self.assertEqual(s.edit_channel(self.channel["id"], notes="Warmer.")["look"], "neon-grid", "None leaves a field alone")
        self.assertIsNone(s.edit_channel(self.channel["id"], look="", aspect="")["look"])
        for bad in ({"aspect": "4:3"}, {"look": "bad look!"}, {"notes": "x" * 1001}):
            with self.assertRaises(StudioError):
                s.edit_channel(self.channel["id"], **bad)

    def test_batch_approval_is_off_until_turned_on_and_skips_what_cannot_be_approved(self):
        s = self.store
        a, b, c = self.rendered("A"), self.rendered("B"), self.rendered("C")
        with self.assertRaises(StudioError) as off:
            s.approve_batch([a["id"], b["id"]], "david")
        self.assertEqual(off.exception.status, 409)
        self.assertEqual(s.get_post(a["id"])["state"], "awaiting_approval")
        s.update_settings(batch_approval=True)
        with self.assertRaises(StudioError):
            s.update_settings(batch_approval="yes")
        s.reject(c["id"], "no")
        result = s.approve_batch([a["id"], b["id"], c["id"], a["id"], 999], "david")
        self.assertEqual([p["id"] for p in result["approved"]], [a["id"], b["id"]])
        self.assertEqual([x["post_id"] for x in result["skipped"]], [c["id"], 999])
        self.assertEqual({s.get_post(i)["approved_by"] for i in (a["id"], b["id"])}, {"david"})
        with self.assertRaises(StudioError):
            s.approve_batch([], "david")

    def test_strategies_are_recorded_while_drafting_and_scripts_can_be_long(self):
        s = self.store
        hook = s.create_strategy("script_writer", "hook-first")
        pick = s.create_strategy("evaluator", "trend-weighted")
        post = s.create_post(self.channel["id"], "Long one", pick_reason="Rising.")
        script = "beat\n" * 3000
        post = s.edit_post(post["id"], script_ref=script, script_strategy_id=hook["id"], evaluator_strategy_id=pick["id"], tags="a, b")
        self.assertEqual((post["script_strategy_id"], post["evaluator_strategy_id"], post["pick_reason"], post["tags"]),
                         (hook["id"], pick["id"], "Rising.", "a, b"))
        self.assertEqual(len(post["script_ref"]), len(script.strip()))
        with self.assertRaises(StudioError):
            s.edit_post(post["id"], script_strategy_id=pick["id"])  # an evaluator strategy is not a script strategy
        with self.assertRaises(StudioError):
            s.edit_post(post["id"], script_ref="x" * 20001)

    def test_a_niche_proposal_needs_the_producer_and_then_the_person(self):
        s = self.store
        with self.assertRaises(StudioError):
            review.propose_niche(s, "Deep sea", "")
        decision = review.propose_niche(s, "Deep sea", "https://trends.example.test", "up 40%")
        self.assertTrue(review.needs_user(s, decision))
        waiting = review.confirm(s, decision["id"], "producer", "Producer")
        self.assertEqual(waiting["status"], "awaiting_user")
        self.assertEqual(len(s.list_niches()), 1)
        done = review.confirm(s, decision["id"], "user", "david")
        self.assertEqual((done["status"], s.get_niche(done["subject_id"])["name"]), ("confirmed", "Deep sea"))
        other = review.propose_niche(s, "Bees", "https://trends.example.test/bees")
        self.assertEqual(review.reject(s, other["id"], "Producer", "thin")["status"], "rejected")
        self.assertEqual(len(s.list_niches()), 2, "a rejected proposal creates nothing")

    def test_a_niche_proposal_answers_an_open_replacement_request(self):
        s = self.store
        s.add_decision("replace", "niche", self.channel["niche_id"], "Old niche", "open", "executor")
        decision = review.propose_niche(s, "Deep sea", "https://trends.example.test")
        self.assertIn("replacement for Old niche", decision["reason"])
        review.confirm(s, decision["id"], "user", "david")
        ask = s.list_decisions(kind="replace")[0]
        self.assertEqual((ask["status"], ask["payload"]["replaced_by_name"]), ("confirmed", "Deep sea"))

    def test_older_stores_gain_the_new_columns(self):
        import sqlite3
        folder = tempfile.mkdtemp(prefix="studio-old-", dir=_DATA.name)
        path = os.path.join(folder, "studio.db")
        old = sqlite3.connect(path)
        old.executescript(
            "CREATE TABLE niches (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live', slots INTEGER NOT NULL DEFAULT 1, "
            "created_at REAL NOT NULL, retired_at REAL, retire_reason TEXT);"
            "CREATE TABLE channels (id INTEGER PRIMARY KEY, niche_id INTEGER NOT NULL, platform TEXT NOT NULL, handle TEXT NOT NULL, "
            "status TEXT NOT NULL DEFAULT 'live', paused INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, archived_at REAL, archive_reason TEXT);"
            "INSERT INTO niches (id, name, created_at) VALUES (1, 'Old', 1); INSERT INTO channels (id, niche_id, platform, handle, created_at) VALUES (1, 1, 'youtube', '@old', 1);")
        old.commit(); old.close()
        store = Store(path)
        _STORES.append(store)
        channel = store.get_channel(1)
        self.assertEqual((channel["look"], channel["aspect"], channel["notes"]), (None, None, ""))
        post = store.create_post(1, "New", pick_reason="why")
        self.assertEqual((post["pick_reason"], post["tags"]), ("why", ""))


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("david", "first-password-1", is_admin=True)
        auth_manager.create_user("bea", "second-password-2")
        auth_manager.create_user("cy", "third-password-3")
        cls.david_id, cls.bea_id = auth_manager.account_id("david"), auth_manager.account_id("bea")
        cls.clients = {}
        for name, password in (("david", "first-password-1"), ("bea", "second-password-2"), ("cy", "third-password-3")):
            client = TestClient(kairos.app)
            r = client.post("/api/auth/login", json={"username": name, "password": password})
            assert r.status_code == 200, r.text
            cls.clients[name] = client
        cls.anon = TestClient(kairos.app)

    def test_every_route_needs_a_user(self):
        routes = [(m.upper(), path) for path, ops in kairos.app.openapi()["paths"].items()
                  if path.startswith("/api/content-studio") for m in ops]
        self.assertGreater(len(routes), 25)
        for method, path in routes:
            url = path.replace("{post_id}", "1").replace("{channel_id}", "1").replace("{decision_id}", "1")
            r = self.anon.request(method, url, json={} if method != "GET" else None)
            self.assertEqual(r.status_code, 401, f"{method} {path}")

    def test_pipeline_flow_and_two_accounts_stay_apart(self):
        d, b = self.clients["david"], self.clients["bea"]
        P = "/api/content-studio"
        niche = d.post(f"{P}/niches", json={"name": "Space"}).json()
        self.assertEqual(d.post(f"{P}/channels", json={"niche_id": niche["id"], "platform": "myspace", "handle": "@s"}).status_code, 400)
        channel = d.post(f"{P}/channels", json={"niche_id": niche["id"], "platform": "youtube", "handle": "@space"}).json()
        topic = d.post(f"{P}/topics", json={"niche_id": niche["id"], "title": "Black holes", "source": "https://t.example.test",
                                            "signal": "rising"}).json()
        strategy = d.post(f"{P}/strategies", json={"owner_role": "script_writer", "name": "hook-first"}).json()
        post = d.post(f"{P}/posts", json={"channel_id": channel["id"], "title": "Black holes", "topic_id": topic["id"],
                                          "script_strategy_id": strategy["id"], "script_ref": "beats"}).json()
        self.assertEqual(d.post(f"{P}/posts/{post['id']}/submit").status_code, 409)
        self.assertEqual(d.post(f"{P}/posts/{post['id']}/edit", json={"render_ref": "r.mp4", "render_status": "ok"}).status_code, 200)
        self.assertEqual(d.post(f"{P}/posts/{post['id']}/submit").json()["state"], "awaiting_approval")
        self.assertEqual([p["id"] for p in d.get(f"{P}/approvals").json()["posts"]], [post["id"]])
        item = next(i for i in d.get(f"{P}/pipeline").json()["items"] if i["kind"] == "post")
        self.assertEqual((item["step"], item["owner"]), ("approval", "user"))

        # Bea has her own empty store: she sees none of it and cannot reach it by id.
        self.assertEqual(b.get(f"{P}/niches").json()["niches"], [])
        self.assertEqual(b.get(f"{P}/approvals").json()["posts"], [])
        self.assertEqual(b.get(f"{P}/pipeline").json()["items"], [])
        self.assertEqual(b.get(f"{P}/posts/{post['id']}").status_code, 404)
        self.assertEqual(b.post(f"{P}/posts/{post['id']}/approve").status_code, 404)
        self.assertEqual(b.post(f"{P}/channels/{channel['id']}/archive", json={}).status_code, 404)
        self.assertEqual(b.get(f"{P}/decisions").json()["decisions"], [])
        self.assertEqual(b.post(f"{P}/niches", json={"name": "Space"}).status_code, 200, "same name is fine in another account")
        david_db = Path(accounts.account_dir(self.david_id, create=False)) / "content_studio" / "studio.db"
        bea_db = Path(accounts.account_dir(self.bea_id, create=False)) / "content_studio" / "studio.db"
        self.assertTrue(david_db.is_file() and bea_db.is_file() and david_db != bea_db)

        # Approve, mark posted, add numbers by hand and by import.
        self.assertEqual(d.post(f"{P}/posts/{post['id']}/approve").json()["state"], "approved")
        self.assertEqual(d.post(f"{P}/posts/{post['id']}/metrics", json={"views": 5, "avg_view_duration_s": 3, "video_length_s": 10}).status_code, 409)
        self.assertEqual(d.post(f"{P}/posts/{post['id']}/posted", json={"url": "https://youtu.be/x"}).json()["state"], "posted")
        self.assertEqual(d.post(f"{P}/posts/{post['id']}/metrics", json={"views": -5, "avg_view_duration_s": 3, "video_length_s": 10}).status_code, 422)
        ok = d.post(f"{P}/posts/{post['id']}/metrics", json={"views": 120, "avg_view_duration_s": 6, "video_length_s": 10, "likes": 9})
        self.assertEqual(ok.status_code, 200, ok.text)
        bad = d.post(f"{P}/metrics/import", json={"rows": [{"post_id": post["id"], "views": 1, "avg_view_duration_s": 1, "video_length_s": 2},
                                                           {"post_id": 999, "views": 1, "avg_view_duration_s": 1, "video_length_s": 2}]})
        self.assertEqual(bad.status_code, 404)
        self.assertEqual(len(d.get(f"{P}/posts/{post['id']}").json()["metrics"]), 1, "a bad row stores nothing")
        good = d.post(f"{P}/metrics/import", json={"rows": [{"post_id": post["id"], "views": 130, "avg_view_duration_s": 6, "video_length_s": 10}]})
        self.assertEqual(good.json(), {"stored": 1})

        # Selection, report, watch, settings.
        board = d.get(f"{P}/scoreboard").json()
        self.assertEqual([n["name"] for n in board["niches"]], ["Space"])
        run = d.post(f"{P}/review/run").json()
        self.assertTrue(run["dry_run"])
        self.assertEqual(run["proposals"], [])
        self.assertEqual(d.post(f"{P}/review/run", json={"dry_run": False}).status_code, 200)
        self.assertEqual(d.post(f"{P}/review/run", json={"dry_run": False}).status_code, 409)
        self.assertEqual(d.post(f"{P}/decisions/1/confirm").status_code, 404)
        # The API is the person's: nobody confirms "as the Producer" through it.
        self.assertEqual(d.post(f"{P}/decisions/1/confirm", json={"actor": "producer"}).status_code, 403)
        self.assertIn("Content Studio weekly report", d.get(f"{P}/report").json()["text"])
        self.assertIn("findings", d.get(f"{P}/watch").json())
        self.assertEqual(d.put(f"{P}/settings", json={"max_niches": 9}).status_code, 400)
        self.assertEqual(d.put(f"{P}/settings", json={"weights": {"views": 1, "watch": 1, "engagement": 1}}).status_code, 200)
        self.assertEqual(b.get(f"{P}/settings").json()["weights"], {"views": .4, "watch": .4, "engagement": .2}, "settings are per account")

        # A platform warning pauses the channel; the archive route records a decision; bea sees neither.
        self.assertTrue(d.post(f"{P}/channels/{channel['id']}/warning", json={"text": "strike"}).json()["paused"])
        self.assertTrue(any(f["kind"] == "platform_warning" for f in d.get(f"{P}/watch").json()["findings"]))
        self.assertFalse(d.post(f"{P}/channels/{channel['id']}/resume").json()["paused"])
        self.assertEqual(d.post(f"{P}/channels/{channel['id']}/archive", json={"reason": "done"}).json()["status"], "archived")
        self.assertEqual([x["kind"] for x in d.get(f"{P}/decisions").json()["decisions"]], ["retire"])
        self.assertEqual(d.post(f"{P}/channels/{channel['id']}/restore").json()["status"], "live")
        self.assertEqual(b.get(f"{P}/decisions").json()["decisions"], [])

        # The channel's look, and one-tap batch approval once it is turned on.
        edited = d.post(f"{P}/channels/{channel['id']}/edit", json={"look": "neon-grid", "aspect": "9:16", "notes": "Calm."}).json()
        self.assertEqual((edited["look"], edited["aspect"], edited["notes"]), ("neon-grid", "9:16", "Calm."))
        self.assertEqual(d.post(f"{P}/channels/{channel['id']}/edit", json={"aspect": "4:3"}).status_code, 400)
        self.assertEqual(b.post(f"{P}/channels/{channel['id']}/edit", json={"look": "x"}).status_code, 404)
        batch = d.post(f"{P}/posts", json={"channel_id": channel["id"], "title": "Batch one", "script_ref": "beats", "pick_reason": "why"}).json()
        d.post(f"{P}/posts/{batch['id']}/edit", json={"render_ref": "r.mp4", "render_status": "ok", "tags": "a, b"})
        d.post(f"{P}/posts/{batch['id']}/submit")
        self.assertEqual(d.post(f"{P}/approvals/approve-batch", json={"post_ids": [batch["id"]]}).status_code, 409)
        self.assertTrue(d.put(f"{P}/settings", json={"batch_approval": True}).json()["batch_approval"])
        out = d.post(f"{P}/approvals/approve-batch", json={"post_ids": [batch["id"]]}).json()
        self.assertEqual(([p["id"] for p in out["approved"]], out["skipped"]), ([batch["id"]], []))
        self.assertEqual(b.post(f"{P}/approvals/approve-batch", json={"post_ids": [batch["id"]]}).status_code, 409, "bea's own setting is off")
        got = d.get(f"{P}/posts/{batch['id']}").json()
        self.assertEqual((got["pick_reason"], got["tags"], got["direct_post_blocker"]), ("why", "a, b", "Connect YouTube posting first."))

    def test_delivery_routes_reach_the_inbox_only_for_the_accounts_own_producer(self):
        d, b = self.clients["cy"], self.clients["bea"]
        P = "/api/content-studio"
        sent = []

        def fake(bot_id, title, body, urgent=False):
            sent.append((bot_id, title, body, urgent))
            return True
        niche = d.post(f"{P}/niches", json={"name": "Delivery"}).json()
        channel = d.post(f"{P}/channels", json={"niche_id": niche["id"], "platform": "tiktok", "handle": "@deliver"}).json()
        self.assertEqual(d.put(f"{P}/settings", json={"team_roles": {"p1": "boss"}}).status_code, 400)
        self.assertEqual(d.put(f"{P}/settings", json={"team_roles": {"p1": "producer"}}).json()["team_roles"], {"p1": "producer"})
        with patch.object(delivery, "inbox_notifier", fake):
            warned = d.post(f"{P}/channels/{channel['id']}/warning", json={"text": "limited"}).json()
            self.assertTrue(warned["paused"] and warned["notified"])
            self.assertEqual([(x[0], x[3]) for x in sent], [("p1", True)])
            self.assertIn("@deliver", sent[0][2])
            again = d.post(f"{P}/watch/notify").json()
            self.assertEqual(again["notified"], [], "already told")
            self.assertTrue(any(f["kind"] == "platform_warning" for f in again["findings"]))
            report_out = d.post(f"{P}/report/send").json()
            self.assertTrue(report_out["delivered"])
            self.assertEqual(sent[-1][:2], ("p1", "Content Studio weekly report"))
            before = len(sent)
            # Bea's account has no Producer recorded: nothing is sent for her, and Cy's roles are not hers.
            self.assertFalse(b.post(f"{P}/report/send").json()["delivered"])
            self.assertEqual(b.post(f"{P}/watch/notify").json()["notified"], [])
            self.assertEqual(b.get(f"{P}/settings").json()["team_roles"], {})
            self.assertEqual(len(sent), before)


if __name__ == "__main__":
    unittest.main()

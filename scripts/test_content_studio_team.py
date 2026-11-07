"""Content Studio Team package template (services/studio_team_package.py) against real stores and isolated data."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest.mock import patch

from test_data_support import TestDataDirectory
ENV = TestDataDirectory("kairos-studio-team-")
os.environ["JARVIS_DATA_DIR"] = ENV.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(ENV.name) / "vault")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import accounts, bot_rooms_store
from core import tool_registry
from core.tool_registry import ToolContext
from services.content_studio import delivery, pipeline, report, review, studio, team as studio_roles, close_all
from services import bot_package as pkg, bot_departments, bot_rooms, bot_usage, studio_team_package as team
from services.agent_service import agent_service
from services.task_service import task_service

ROOT = Path(__file__).resolve().parents[1]
NAMES = ["Producer", "Researcher", "Evaluator", "Script Writer", "Editor", "Publisher", "Executor"]
RULE_PHRASES = ("Never create an account", "archived from the rotation with its history kept", "Never delete",
                "waits for the person's OK", "AI-generated where the platform requires it (YouTube, TikTok)",
                "never like, comment on, follow", "keeps its source and its date", "pause that channel at once")


def clean():
    owner = None
    for bot in agent_service.list_agents():
        owner = bot_departments.owner(bot)
        break
    for room in bot_rooms.list_rooms(owner, include_archived=True) if owner is not None else []:
        bot_rooms.delete(owner, room["id"])
    for t in bot_departments.list(owner) if owner is not None else []:
        bot_departments.delete(t["id"], owner)
    for task in list(task_service.list_tasks()):
        task_service.delete_task(task["id"])
    for ident in list(agent_service._agents):
        agent_service.delete(ident)


class StudioTeamTests(unittest.TestCase):
    def setUp(self):
        clean()
        self.value = team.build()

    def tearDown(self):
        clean()
        bot_usage.update_settings(budget={"monthly_usd": None, "warn_percent": 80})

    def install(self):
        # A chief needs a model with tools; a fresh account has none, so give the lead one for the check.
        with patch.object(agent_service, "chat_endpoint", return_value={"id": "x"}, create=True):
            token = pkg.inspect(pkg.canonical(self.value))["token"]
            return pkg.import_(token)

    def bots(self):
        return {a["name"]: a for a in agent_service.list_agents()}

    def test_template_parses_and_is_shipped_in_the_templates_file(self):
        pkg.normalize(self.value)
        self.assertEqual([b["name"] for b in self.value["bots"]], NAMES)
        for path in ("static/data/bots-teams.json", "docs/demo/static/data/bots-teams.json"):
            rows = json.loads((ROOT / path).read_text(encoding="utf-8"))
            row = next(r for r in rows if r["id"] == team.TEAM_ID)
            self.assertEqual(row, team.template_entry(), f"{path} is stale: regenerate it from services/studio_team_package.py")
            pkg.normalize(row["package"])

    def test_import_makes_seven_bots_team_room_routines_cap_and_ask(self):
        result = self.install()
        self.assertEqual(sorted(r["name"] for r in result["created"]), sorted(NAMES))
        bots = self.bots()
        self.assertEqual(set(bots), set(NAMES))
        for name, bot in bots.items():
            self.assertEqual(bot["approval_mode"], "ask", name)
        owner = bot_departments.owner(bots["Producer"])
        teams = bot_departments.list(owner)
        self.assertEqual([t["name"] for t in teams], ["Content Studio"])
        self.assertEqual(len(bot_departments.members(teams[0]["id"])), 7)
        self.assertEqual(teams[0]["chief_bot_id"], bots["Producer"]["id"], "the Producer leads, not Kip")
        rooms = bot_rooms.list_rooms(owner, include_archived=True)
        self.assertEqual([r["name"] for r in rooms], ["Content Studio"])
        self.assertEqual(len(bot_rooms_store.members(rooms[0]["id"])), 7)
        tasks = task_service.list_tasks()
        self.assertEqual(sorted(t["name"] for t in tasks), ["Daily content cycle", "Daily metrics snapshot", "Weekly review and report"])
        self.assertTrue(all(not t.get("enabled") for t in tasks), "routines start paused")
        by_name = {t["name"]: t for t in tasks}
        self.assertEqual(by_name["Daily content cycle"]["agent_id"], bots["Producer"]["id"])
        self.assertEqual(by_name["Daily metrics snapshot"]["agent_id"], bots["Executor"]["id"])
        for t in tasks:
            self.assertTrue("content_studio_" in t["prompt"] or "/api/content-studio/" in t["prompt"], t["name"])
        budget = bot_usage.settings()["budget"]
        self.assertEqual((budget["monthly_usd"], budget["warn_percent"]), (50, 80))

    def test_importing_twice_does_not_duplicate_or_overwrite(self):
        self.install()
        self.install()
        names = [a["name"] for a in agent_service.list_agents()]
        self.assertEqual(len(names), 14)
        self.assertEqual(len({n.casefold() for n in names}), 14, "the second set gets free names")
        self.assertEqual(bot_usage.settings()["budget"]["monthly_usd"], 50, "the cap is set once, not stacked")

    def test_an_existing_lower_cap_stays_and_a_higher_one_comes_down(self):
        bot_usage.update_settings(budget={"monthly_usd": 20, "warn_percent": 80})
        self.install()
        self.assertEqual(bot_usage.settings()["budget"]["monthly_usd"], 20)
        clean()
        bot_usage.update_settings(budget={"monthly_usd": 500, "warn_percent": 80})
        self.install()
        self.assertEqual(bot_usage.settings()["budget"]["monthly_usd"], 50)

    def test_a_failed_import_leaves_no_bots_routines_or_cap(self):
        original = pkg._sections["rooms"]

        def boom(data, mapping):
            raise ValueError("boom")
        pkg._sections["rooms"] = (original[0], boom)
        try:
            with self.assertRaises(ValueError):
                self.install()
        finally:
            pkg._sections["rooms"] = original
        self.assertEqual(agent_service.list_agents(), [])
        self.assertEqual(task_service.list_tasks(), [])

    def test_policy_never_raises_a_level_or_accepts_bad_data(self):
        from services import bot_package_policy as policy
        bot = agent_service.create("Solo", endpoint_id=None, approval_mode="ask")
        policy.import_policy({"approval": {"bot-1": "edits"}}, {"bot-1": bot["id"]})
        self.assertEqual(agent_service.get(bot["id"])["approval_mode"], "ask")
        for bad in ({"approval": {"bot-1": "full"}}, {"approval": {"x": "ask"}}, {"monthly_cap_usd": -1},
                    {"warn_percent": 0}, {"other": 1}, []):
            with self.assertRaises(ValueError):
                policy.import_policy(bad, {})

    def test_instructions_carry_the_roles_strategies_and_safety_rules(self):
        souls = {b["name"]: b["soul"] for b in self.value["bots"]}
        for name, soul in souls.items():
            for phrase in RULE_PHRASES:
                self.assertIn(phrase, soul, f"{name} is missing: {phrase}")
        self.assertIn("hook-first", souls["Script Writer"])
        self.assertIn("story-first", souls["Script Writer"])
        self.assertIn("trend-weighted", souls["Evaluator"])
        self.assertIn("track-record-weighted", souls["Evaluator"])
        self.assertIn("web search", souls["Researcher"])
        self.assertIn("motion video", souls["Editor"])
        self.assertIn("content_studio_confirm_decision", souls["Producer"])
        self.assertIn("content_studio_add_topic", souls["Researcher"])
        self.assertIn("content_studio_submit_post", souls["Editor"])
        self.assertIn("content_studio_run_review", souls["Executor"])
        self.assertIn("content_studio_record_metrics", souls["Executor"])
        self.assertIn("$50", souls["Producer"])
        self.assertIn("Inbox", souls["Producer"])
        self.assertIn("Never post anything the person has not approved", souls["Publisher"])
        self.assertIn("never retire anything yourself", souls["Executor"])
        self.assertIn("3 weeks and 10 posts", souls["Executor"])


DAY = 86400.0


def wipe_studio():
    close_all()
    shutil.rmtree(Path(accounts.account_dir(create=False)) / "content_studio", ignore_errors=True)


def call(tool, bot_id, /, **args):
    spec = tool_registry._REGISTRY[tool]
    return asyncio.run(spec.handler(args, ToolContext(agent_id=bot_id)))


class Fake:
    """A notifier that records what would reach the Inbox."""
    def __init__(self, result=True):
        self.sent, self.result = [], result

    def __call__(self, bot_id, title, body, urgent=False):
        self.sent.append({"bot": bot_id, "title": title, "body": body, "urgent": urgent})
        return self.result


class StudioToolTests(unittest.TestCase):
    """The team's Kairos tools, gated by the role the import records, in the calling bot's own account."""

    def setUp(self):
        clean()
        wipe_studio()
        with patch.object(agent_service, "chat_endpoint", return_value={"id": "x"}, create=True):
            pkg.import_(pkg.inspect(pkg.canonical(team.build()))["token"])
        self.bots = {a["name"]: a["id"] for a in agent_service.list_agents()}
        self.fake = Fake()
        self.patch = patch.object(delivery, "inbox_notifier", self.fake)
        self.patch.start()
        self.niche = studio.create_niche("Space")
        self.channel = studio.create_channel(self.niche["id"], "youtube", "@space")

    def tearDown(self):
        self.patch.stop()
        clean()
        wipe_studio()
        bot_usage.update_settings(budget={"monthly_usd": None, "warn_percent": 80})

    def rendered_post(self, title="Black holes"):
        post = studio.create_post(self.channel["id"], title, script_ref="beats")
        studio.edit_post(post["id"], render_ref="r.mp4", render_status="ok")
        return post

    def test_import_records_roles_and_team_bot_ids(self):
        settings = studio.settings()
        self.assertEqual(settings["team_roles"], {self.bots["Producer"]: "producer", self.bots["Researcher"]: "researcher",
                                                  self.bots["Evaluator"]: "evaluator", self.bots["Script Writer"]: "script_writer",
                                                  self.bots["Editor"]: "editor", self.bots["Publisher"]: "publisher",
                                                  self.bots["Executor"]: "executor"})
        self.assertEqual(sorted(settings["team_bot_ids"]), sorted(self.bots.values()))
        self.assertEqual(studio_roles.KEYS, team.ROLES_BY_KEY)
        for bad in ({"roles": {"bot-1": "boss"}}, {"roles": {"x": "producer"}}, {"other": 1}, {"roles": []}):
            with self.assertRaises(ValueError):
                studio_roles.import_roles(studio, bad, {})

    def test_tools_are_registered_agent_only_and_none_approves_or_posts(self):
        names = sorted(n for n in tool_registry._REGISTRY if n.startswith("content_studio_"))
        self.assertEqual(names, ["content_studio_add_topic", "content_studio_confirm_decision", "content_studio_mark_posted",
                                 "content_studio_pick_topic", "content_studio_pipeline", "content_studio_propose_niche",
                                 "content_studio_publish_youtube", "content_studio_record_metrics", "content_studio_record_render",
                                 "content_studio_record_warning", "content_studio_reject_decision", "content_studio_run_review",
                                 "content_studio_save_script", "content_studio_send_report", "content_studio_submit_post",
                                 "content_studio_watch", "content_studio_youtube_trending"])
        for name in names:
            self.assertTrue(tool_registry._REGISTRY[name].agent_only)
        self.assertFalse(any("approve" in n for n in names), "no tool approves a post")

    def test_import_seeds_the_starting_strategies_once(self):
        active = {(s["owner_role"], s["name"]): bool(s["is_default"]) for s in studio.list_strategies()}
        self.assertEqual(active, {("script_writer", "hook-first"): True, ("script_writer", "story-first"): False,
                                  ("evaluator", "trend-weighted"): True, ("evaluator", "track-record-weighted"): False})
        self.assertEqual(studio_roles.seed_strategies(studio), [], "a second import adds none")
        studio.drop_strategy(next(s["id"] for s in studio.list_strategies() if s["name"] == "story-first"))
        self.assertEqual(studio_roles.seed_strategies(studio), [], "a dropped strategy is never brought back")

    def test_the_daily_cycle_runs_step_by_step_through_the_tools(self):
        bots = self.bots
        studio.edit_channel(self.channel["id"], look="neon-grid", aspect="9:16", notes="Calm, curious, no hype.")
        board = call("content_studio_pipeline", bots["Editor"])
        for text in ('"look": "neon-grid"', '"aspect": "9:16"', "Calm, curious", '"hook-first"', '"you_are": "editor"'):
            self.assertIn(text, board)
        topic = studio.add_topic(self.niche["id"], "Black holes", "https://t.example.test")
        pick = dict(channel_id=self.channel["id"], topic_id=topic["id"], reason="Rising this week.", strategy="track-record-weighted")
        self.assertIn("Only the Evaluator", call("content_studio_pick_topic", bots["Researcher"], **pick))
        self.assertIn("no active evaluator strategy", call("content_studio_pick_topic", bots["Evaluator"], **{**pick, "strategy": "vibes"}))
        self.assertIn("Script Writer writes it next", call("content_studio_pick_topic", bots["Evaluator"], **pick))
        self.assertIn("already picked", call("content_studio_pick_topic", bots["Evaluator"], **pick))
        post = studio.list_posts()[0]
        strategy = {s["name"]: s["id"] for s in studio.list_strategies()}
        self.assertEqual((post["title"], post["pick_reason"], post["evaluator_strategy_id"]),
                         ("Black holes", "Rising this week.", strategy["track-record-weighted"]))
        self.assertIn("has no script yet", call("content_studio_record_render", bots["Editor"], post_id=post["id"], status="ok", render_ref="/x.mp4"))
        long_script = "Beat 1: open on the event horizon.\n" * 400
        self.assertIn("Only the Script Writer", call("content_studio_save_script", bots["Editor"], post_id=post["id"], script="x"))
        self.assertIn("Editor renders it next", call("content_studio_save_script", bots["Script Writer"], post_id=post["id"], script=long_script,
                                                     caption="Light cannot escape.", title="What a black hole hides"))
        post = studio.get_post(post["id"])
        self.assertEqual((post["script_ref"], post["script_strategy_id"], post["title"]), (long_script.strip(), strategy["hook-first"], "What a black hole hides"),
                         "no strategy named: the default is recorded")
        self.assertIn("needs its render_ref", call("content_studio_record_render", bots["Editor"], post_id=post["id"], status="ok"))
        self.assertIn("watch sees the failure", call("content_studio_record_render", bots["Editor"], post_id=post["id"], status="failed"))
        self.assertEqual(pipeline.pipeline(studio)[0]["status"], "failed")
        out = call("content_studio_record_render", bots["Editor"], post_id=post["id"], status="ok", render_ref="/generated-files/a_b.mp4", tags="space, physics")
        self.assertIn("content_studio_submit_post", out)
        call("content_studio_submit_post", bots["Editor"], post_id=post["id"])
        self.assertIn("not drafted", call("content_studio_save_script", bots["Script Writer"], post_id=post["id"], script="late"))
        self.assertIn("cannot become posted", call("content_studio_mark_posted", bots["Publisher"], post_id=post["id"], url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
        studio.approve(post["id"], "david")
        for bad in ("http://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.tiktok.com/@space/video/1", "https://youtube.com.evil.test/x"):
            self.assertIn("https link of the live post", call("content_studio_mark_posted", bots["Publisher"], post_id=post["id"], url=bad), bad)
        self.assertIn("Only the Publisher", call("content_studio_mark_posted", bots["Producer"], post_id=post["id"], url="https://youtu.be/dQw4w9WgXcQ"))
        self.assertIn("can be recorded now", call("content_studio_mark_posted", bots["Publisher"], post_id=post["id"], url="https://youtu.be/dQw4w9WgXcQ"))
        post = studio.get_post(post["id"])
        self.assertEqual((post["state"], post["tags"], post["render_ref"]), ("posted", "space, physics", "/generated-files/a_b.mp4"))

    def test_publisher_uploads_only_through_the_posting_connection(self):
        bots = self.bots
        post = self.rendered_post()
        studio.submit_for_approval(post["id"])
        self.assertIn("Only the Publisher", call("content_studio_publish_youtube", bots["Editor"], post_id=post["id"]))
        self.assertIn("Only a post you approved", call("content_studio_publish_youtube", bots["Publisher"], post_id=post["id"]))
        studio.approve(post["id"], "david")
        self.assertIn("Connect YouTube posting first", call("content_studio_publish_youtube", bots["Publisher"], post_id=post["id"]))
        from services.content_studio import youtube_publish

        async def fake_publish(store, post_id, by, now=None):
            return {"video_id": "NEWvideo_01", "url": "https://www.youtube.com/watch?v=NEWvideo_01", "privacy": "private",
                    "asked_privacy": "public", "note": "YouTube kept it private."}
        with patch.object(youtube_publish, "publish", fake_publish):
            out = call("content_studio_publish_youtube", bots["Publisher"], post_id=post["id"])
        self.assertIn("NEWvideo_01", out)
        self.assertIn("kept it private", out)
        self.assertIn("Only the Researcher", call("content_studio_youtube_trending", bots["Publisher"]))
        self.assertIn("Connect YouTube analytics first", call("content_studio_youtube_trending", bots["Researcher"]))

    def test_a_new_niche_is_proposed_confirmed_then_the_persons_call(self):
        bots = self.bots
        ask = dict(name="Deep sea", source="https://trends.example.test/deep-sea", signal="up 40% in 30 days")
        self.assertIn("Only the Researcher", call("content_studio_propose_niche", bots["Producer"], **ask))
        self.assertIn("already has that name", call("content_studio_propose_niche", bots["Researcher"], **{**ask, "name": "space"}))
        self.assertIn("The Producer confirms it", call("content_studio_propose_niche", bots["Researcher"], **ask))
        self.assertIn("already proposed", call("content_studio_propose_niche", bots["Researcher"], **ask))
        decision = studio.list_decisions(kind="add")[0]
        self.assertEqual((decision["status"], decision["payload"]["source"]), ("proposed", ask["source"]))
        self.assertIn("waits for the person's OK", call("content_studio_confirm_decision", bots["Producer"], decision_id=decision["id"]))
        self.assertEqual([n["name"] for n in studio.list_niches()], ["Space"], "nothing created by a bot")
        done = review.confirm(studio, decision["id"], "user", "david")
        self.assertEqual(done["status"], "confirmed")
        created = studio.get_niche(done["payload"]["created_niche"])
        self.assertEqual((created["name"], done["subject_id"]), ("Deep sea", created["id"]))

    def test_role_gating(self):
        bots = self.bots
        topic = dict(niche_id=self.niche["id"], title="Black holes", source="https://t.example.test")
        self.assertIn("Only the Researcher", call("content_studio_add_topic", bots["Producer"], **topic))
        self.assertEqual(studio.list_topics(), [])
        self.assertIn("Black holes", call("content_studio_add_topic", bots["Researcher"], **topic))
        self.assertEqual(len(studio.list_topics()), 1)
        self.assertIn("Only the Executor", call("content_studio_run_review", bots["Producer"]))
        self.assertIn("Only the Producer", call("content_studio_confirm_decision", bots["Executor"], decision_id=1))
        self.assertIn("Only the Producer", call("content_studio_send_report", bots["Editor"]))
        self.assertIn("Only the Producer", call("content_studio_watch", bots["Researcher"]))
        post = self.rendered_post()
        self.assertIn("Only the Editor or Producer", call("content_studio_submit_post", bots["Researcher"], post_id=post["id"]))
        self.assertEqual(studio.get_post(post["id"])["state"], "drafted")
        self.assertIn("waits for the person's approval", call("content_studio_submit_post", bots["Editor"], post_id=post["id"]))
        self.assertEqual(studio.get_post(post["id"])["state"], "awaiting_approval", "submitted, never approved by a bot")
        self.assertIn("approvals_waiting", call("content_studio_pipeline", bots["Publisher"]))
        stranger = agent_service.create("Stranger", endpoint_id=None, approval_mode="ask")
        self.assertIn("not on the Content Studio team", call("content_studio_pipeline", stranger["id"]))
        self.assertIn("must call", call("content_studio_pipeline", "no-such-bot"))

    def test_producer_confirm_of_a_channel_retirement_waits_for_the_person(self):
        bots = self.bots
        decision = studio.add_decision("retire", "channel", self.channel["id"], "@space", "proposed", "executor", reason="behind")["id"]
        out = call("content_studio_confirm_decision", bots["Producer"], decision_id=decision)
        self.assertIn("waits for the person's OK", out)
        self.assertEqual(studio.get_decision(decision)["status"], "awaiting_user")
        self.assertEqual(studio.get_channel(self.channel["id"])["status"], "live", "nothing was retired by the bot")
        again = call("content_studio_confirm_decision", bots["Producer"], decision_id=decision)
        self.assertIn("waits for the user's OK", again)
        self.assertEqual(studio.get_channel(self.channel["id"])["status"], "live")
        review.confirm(studio, decision, "user", "david")
        self.assertEqual(studio.get_channel(self.channel["id"])["status"], "archived")
        self.assertIn("Not run", call("content_studio_reject_decision", bots["Producer"], decision_id=decision))
        other = studio.add_decision("retire", "channel", self.channel["id"], "x", "proposed", "executor")["id"]
        call("content_studio_reject_decision", bots["Producer"], decision_id=other, reason="not yet")
        self.assertEqual(studio.get_decision(other)["status"], "rejected")

    def posted_post(self):
        post = self.rendered_post("Posted one")
        studio.submit_for_approval(post["id"])
        studio.approve(post["id"], "david")
        return studio.mark_posted(post["id"], "https://example.test/p")

    def test_executor_records_metrics_all_or_nothing(self):
        bots = self.bots
        post = self.posted_post()
        good = dict(post_id=post["id"], views=100, avg_view_duration_s=6, video_length_s=10, likes=3)
        self.assertIn("Only the Executor", call("content_studio_record_metrics", bots["Producer"], rows=[good]))
        self.assertEqual(studio.snapshots(), [])
        self.assertIn("Stored 2", call("content_studio_record_metrics", bots["Executor"], rows=[good, {**good, "views": 120}]))
        self.assertEqual([s["views"] for s in studio.snapshots(post["id"])], [100, 120])
        unposted = self.rendered_post("Not posted")
        for bad in ({**good, "views": -1}, {**good, "post_id": unposted["id"]}, {**good, "post_id": 999},
                    {**good, "taken_at": 1.0}, {**good, "bogus": 1}, {"post_id": post["id"]}):
            out = call("content_studio_record_metrics", bots["Executor"], rows=[good, bad])
            self.assertIn("Not run", out, bad)
            self.assertEqual(len(studio.snapshots()), 2, f"a bad row stored nothing: {bad}")
        self.assertIn("Not run", call("content_studio_record_metrics", bots["Executor"], rows=[]))

    def test_executor_review_dry_run_then_record(self):
        out = call("content_studio_run_review", self.bots["Executor"])
        self.assertIn('"dry_run": true', out)
        self.assertEqual(studio.list_decisions(), [])
        self.assertIn('"dry_run": false', call("content_studio_run_review", self.bots["Executor"], dry_run=False))

    def test_watch_sends_urgent_findings_to_the_inbox_once(self):
        bots = self.bots
        out = call("content_studio_record_warning", bots["Executor"], channel_id=self.channel["id"], text="Community strike")
        self.assertIn("paused", out)
        self.assertTrue(studio.get_channel(self.channel["id"])["paused"])
        self.assertEqual(len(self.fake.sent), 1, "a platform warning is sent at once")
        first = self.fake.sent[0]
        self.assertEqual((first["bot"], first["urgent"]), (bots["Producer"], True))
        self.assertIn("@space", first["body"])
        out = call("content_studio_watch", bots["Producer"])
        self.assertEqual(len(self.fake.sent), 1, "already told: the watch does not repeat it")
        self.assertIn("platform_warning", out)
        studio.resume_channel(self.channel["id"])
        call("content_studio_record_warning", bots["Producer"], channel_id=self.channel["id"], text="Second strike")
        self.assertEqual(len(self.fake.sent), 2, "a new warning is a new message")
        self.assertIn("Not run", call("content_studio_record_warning", bots["Producer"], channel_id=999, text="x"))

    def test_spend_near_cap_is_urgent_and_sent_once_a_month(self):
        state = {"near_cap": True, "capped": False, "spent_usd": 41, "monthly_usd": 50}
        findings = pipeline.watch(studio, 1_700_000_000.0, spend=lambda: state)
        self.assertEqual([f["severity"] for f in findings if f["kind"] == "spend_near_cap"], ["urgent"])
        self.assertEqual(len(delivery.deliver_findings(studio, findings, self.fake, 1_700_000_000.0)), 1)
        self.assertEqual(delivery.deliver_findings(studio, findings, self.fake, 1_700_000_100.0), [])
        self.assertEqual(len(delivery.deliver_findings(studio, findings, self.fake, 1_700_000_000.0 + 40 * DAY)), 1, "next month")
        warn_only = [{"kind": "render_failed", "notify_user": False, "message": "x"}]
        self.assertEqual(delivery.deliver_findings(studio, warn_only, self.fake), [])

    def test_report_lands_in_the_inbox_as_the_producer(self):
        out = call("content_studio_send_report", self.bots["Producer"])
        self.assertIn("in the person's Inbox", out)
        [sent] = self.fake.sent
        self.assertEqual((sent["bot"], sent["urgent"], sent["title"]), (self.bots["Producer"], False, "Content Studio weekly report"))
        self.assertIn("Content Studio weekly report", sent["body"])
        self.fake.result = False
        self.assertFalse(delivery.deliver_report(studio, self.fake)["delivered"])

    def test_nothing_is_sent_when_no_producer_is_recorded(self):
        studio.update_settings(team_roles={})
        self.assertFalse(delivery.deliver_report(studio, self.fake)["delivered"])
        self.assertEqual(self.fake.sent, [])

    def test_real_inbox_item_is_a_report_for_the_producer(self):
        self.patch.stop()
        try:
            with patch.object(agent_service, "notify") as notify:
                self.assertTrue(delivery.deliver_report(studio)["delivered"])
            item = [i for i in agent_service._inbox if i["agent_id"] == self.bots["Producer"]][-1]
            self.assertEqual((item["kind"], item["title"]), ("report", "Content Studio weekly report"))
            self.assertEqual(notify.call_count, 1)
            self.assertFalse(delivery.inbox_notifier("no-such-bot", "t", "b"))
        finally:
            self.patch.start()

    def test_team_spend_sums_only_the_teams_bots(self):
        team_ids = list(studio.settings()["team_bot_ids"])
        rows = [{"bot_id": team_ids[0], "cost_usd": 1.25}, {"bot_id": team_ids[1], "cost_usd": 2.5},
                {"bot_id": team_ids[1], "cost_usd": None}, {"bot_id": "some-other-bot", "cost_usd": 40.0}]

        def fake_rows(start=None, end=None, bot_id=None, user=None):
            return [r for r in rows if bot_id is None or r["bot_id"] == bot_id]
        budget = {"month": "2026-11", "monthly_usd": 50, "capped": False, "near_cap": False, "spent_usd": 43.75, "cost_note": "List-price"}
        from services import bot_spend
        with patch.object(bot_usage, "rows", fake_rows), patch.object(bot_spend, "budget", return_value=budget):
            spend = report.team_spend(studio, 1_700_000_000.0)
            self.assertEqual((spend["available"], spend["team_spent_usd"], spend["all_bots_spent_usd"]), (True, 3.75, 43.75))
            self.assertIn("$3.75", report.render_text(report.build_report(studio, 1_700_000_000.0)))
            studio.update_settings(team_bot_ids=[])
            self.assertIsNone(report.team_spend(studio, 1_700_000_000.0)["team_spent_usd"])

    def test_accounts_stay_apart(self):
        bots = self.bots
        topic = dict(niche_id=self.niche["id"], title="Black holes", source="https://t.example.test")
        self.assertIn("Black holes", call("content_studio_add_topic", bots["Researcher"], **topic))
        try:
            with accounts.as_account("otheraccount"):
                # Another account has its own store: this bot holds no role there and its tools refuse.
                self.assertEqual(studio.settings()["team_roles"], {})
                self.assertIn("Not run", call("content_studio_add_topic", bots["Researcher"], **topic))
                self.assertIn("Not run", call("content_studio_confirm_decision", bots["Producer"], decision_id=1))
                self.assertEqual(studio.list_topics(), [])
                self.assertFalse(delivery.deliver_report(studio, self.fake)["delivered"])
            self.assertEqual(len(studio.list_topics()), 1)
        finally:
            close_all()


if __name__ == "__main__":
    unittest.main()

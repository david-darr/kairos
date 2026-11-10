"""Content Studio: Prepare post, the publishing dashboard and page-read TikTok/Instagram analytics.

- Prepare post assembles an approved post per platform: the editor's export in the platform's aspect, length checks,
  the title, the description with chapters, hashtags within each platform's count, the AI label, the cover, the
  schedule and the checklist; refuses what is not approved, posted, or stopped by the posting-time policy checks.
- The desktop fill plan (local file path) is only for the desktop app (its secret, from this computer), never a model.
- The stop-before-Post guarantee, read from the code: the fill and the page reader can click nothing but a checked
  toggle, submit nothing and send no input events (the behaviour is proven on mock pages by scripts/browser-smoke.cjs).
- Dashboard states, next actions and calendar weeks; a rejected post loses its package; failures are shown.
- Page reads: parsing mock pages, the owner checks, the switch, the rate limits, the pauses and the scheduler.
No network, no real site, no sign-in: a throwaway data folder and stand-ins for the desktop app.
"""
import asyncio
import html.parser
import json
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-studio-pub-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
os.environ["AUTH_ENABLED"] = "true"
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

import atexit  # noqa: E402

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as kairos  # noqa: E402
from core import accounts, video_store  # noqa: E402
from core.auth import auth_manager  # noqa: E402
from routes import bot_approval_routes  # noqa: E402
from services.content_studio import (close_all, page_reads, platforms, prepare, publishing, store as store_mod, studio,  # noqa: E402
                                     youtube_publish)
from services.content_studio.store import StudioError  # noqa: E402

atexit.register(close_all)
P = "/api/content-studio"
DAY = 86400.0
SECRET = "desktop-secret-for-tests"
VIDEO = "a1b2c3d4e5f6"
MOCK = ROOT / "scripts" / "fixtures" / "studio-mock"


def page_text(path):
    """Roughly what a browser's innerText gives for a mock page: block elements on their own lines, scripts left out."""
    class Text(html.parser.HTMLParser):
        BLOCK = {"div", "p", "h1", "h2", "h3", "header", "section", "article", "nav", "li", "br"}

        def __init__(self):
            super().__init__()
            self.out, self.skip = [], 0

        def handle_starttag(self, tag, attrs):
            self.skip += tag in ("script", "style")
            if tag in self.BLOCK:
                self.out.append("\n")

        def handle_endtag(self, tag):
            self.skip -= tag in ("script", "style")
            if tag in self.BLOCK:
                self.out.append("\n")

        def handle_data(self, data):
            if not self.skip:
                self.out.append(data)
    parser = Text()
    parser.feed(Path(path).read_text(encoding="utf-8"))
    return re.sub(r"\n\s*\n+", "\n", "".join(parser.out))


TIKTOK_PAGE = ("TikTok Studio\nspace.kairos\nVideo analytics\nWhy the sky is blue. My friends gave 3 likes and 2 comments.\n"
               "Video views\n1.2K\nTotal play time\n2h 3m 4s\nAverage watch time\n7.3s\nWatched full video\n18.5%\n"
               "New followers\n12\nLikes\n210\nComments\n14\nShares\n9\n")


def probe_short(path):
    return {"seconds": 31.0, "width": 1080, "height": 1920} if "9-16" in path else {"seconds": 31.0, "width": 1920, "height": 1080}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("david", "first-password-1", is_admin=True)
        auth_manager.create_user("bea", "second-password-2")
        cls.david_id, cls.bea_id = auth_manager.account_id("david"), auth_manager.account_id("bea")
        cls.clients = {}
        for name, password in (("david", "first-password-1"), ("bea", "second-password-2")):
            client = TestClient(kairos.app)
            assert client.post("/api/auth/login", json={"username": name, "password": password}).status_code == 200
            cls.clients[name] = client

    def setUp(self):
        self.d, self.b = self.clients["david"], self.clients["bea"]
        self.scope = accounts.as_account(self.david_id)
        self.scope.__enter__()
        self.addCleanup(self.scope.__exit__, None, None, None)
        for table in ("page_reads", "preparations", "snapshots", "post_evidence", "posts", "channel_warnings", "channels", "topics", "niches"):
            studio._write(f"DELETE FROM {table}")
        studio.update_settings(page_reads={"tiktok": False, "instagram": False}, notified={}, page_reads_reset={"tiktok": 0, "instagram": 0})
        youtube_publish.disconnect()
        self.niche = studio.create_niche("Sky science")
        self.yt = studio.create_channel(self.niche["id"], "youtube", "@space.kairos")
        self.tt = studio.create_channel(self.niche["id"], "tiktok", "@space.kairos")
        self.ig = studio.create_channel(self.niche["id"], "instagram", "space.kairos")
        self.renders = video_store._folder(VIDEO) / "renders"
        self.renders.mkdir(parents=True, exist_ok=True)
        for name in os.listdir(self.renders):
            os.remove(self.renders / name)
        for name in ("16-9-v2.mp4", "9-16-v2.mp4", "9-16-v2.mov", "16-9-v1.mp4", "9-16-v1.mp4"):
            (self.renders / name).write_bytes(b"stand-in video " + name.encode())
        from PIL import Image
        Image.new("RGB", (1080, 1920), (40, 90, 200)).save(self.renders / "thumb-9-16.png")
        Image.new("RGB", (1920, 1080), (40, 90, 200)).save(self.renders / "thumb-16-9.png")
        self.probe = patch.object(prepare, "probe", probe_short)
        self.probe.start()
        self.addCleanup(self.probe.stop)

    def approved(self, channel, title="Why the sky is blue", ref=f"/api/videos/{VIDEO}/renders/16-9-v2.mp4", tags="sky, science, light",
                 caption="Sunlight scatters off the air.", long_form=False, now=None):
        now = time.time() if now is None else now
        post = studio.create_post(channel["id"], title, script_ref=f"Beat 1: {title}. Beat 2: the air.", caption=caption,
                                  long_form=long_form, now=now - 600)
        studio.edit_post(post["id"], render_ref=ref, render_status="ok", tags=tags, now=now - 500)
        studio._update("posts", post["id"], state="awaiting_approval")
        studio.approve(post["id"], "david", now=now - 400)
        return studio.get_post(post["id"])

    def posted(self, channel, url, days_ago=1.0, title="Why the sky is blue", now=None):
        now = time.time() if now is None else now
        post = self.approved(channel, title=title, now=now - days_ago * DAY)
        studio.mark_posted(post["id"], url, posted_at=now - days_ago * DAY, now=now - days_ago * DAY)
        return studio.get_post(post["id"])


class PrepareAssembly(Base):
    def test_tiktok_uses_the_editors_9_16_export_with_caption_hashtags_label_and_checklist(self):
        post = self.approved(self.tt, tags="sky, science, light, physics, weather, clouds, air")
        prep = prepare.prepare(studio, post["id"], "david")
        pkg = prep["package"]
        self.assertEqual((prep["state"], prep["route"], pkg["platform"], pkg["aspect"]), ("prepared", "browser", "tiktok", "9:16"))
        self.assertEqual((pkg["file"]["name"], pkg["file"]["approved_file"], pkg["file"]["seconds"]), ("9-16-v2.mp4", False, 31.0),
                         "the 9:16 export of the approved version, never the older v1")
        self.assertEqual(pkg["text"], {"caption": "Sunlight scatters off the air.\n\n#sky #science #light #physics #weather"})
        self.assertEqual(pkg["hashtags_left_out"], ["#clouds", "#air"], "TikTok's count of 5")
        self.assertTrue(pkg["ai_label"]["on"])
        self.assertEqual(pkg["upload_url"], "https://www.tiktok.com/tiktokstudio/upload")
        by = {c["key"]: c["by"] for c in pkg["checklist"]}
        self.assertEqual(by["file"], "kairos")
        self.assertEqual(by["caption"], "kairos")
        self.assertEqual(by["ai_label"], "kairos")
        self.assertEqual((by["cover"], by["post"], by["link"], by["hashtags"]), ("you", "you", "you", "you"))
        self.assertIn("Press Post yourself. Kairos never presses it.", [c["text"] for c in pkg["checklist"]])
        self.assertEqual(pkg["problems"], [])
        self.assertEqual(pkg["cover"]["file"], f"post-{post['id']}.jpg")
        self.assertTrue(os.path.getsize(os.path.join(accounts.account_dir(), "content_studio", "covers", pkg["cover"]["file"])) < 2 * 1024 * 1024)
        self.assertNotIn(":\\", json.dumps(pkg), "the package names files, never local paths")
        self.assertNotIn(str(self.renders), json.dumps(pkg))

    def test_youtube_short_title_description_tags_audience_and_no_thumbnail_upload(self):
        post = self.approved(self.yt, caption="Sunlight scatters. #sky")
        pkg = prepare.prepare(studio, post["id"], "david")["package"]
        self.assertEqual((pkg["kind"], pkg["aspect"], pkg["file"]["name"]), ("short", "9:16", "9-16-v2.mp4"))
        self.assertEqual(pkg["text"]["title"], "Why the sky is blue")
        self.assertEqual(pkg["text"]["description"], "Sunlight scatters. #sky\n\n#science #light", "a hashtag already in the caption is not repeated")
        self.assertEqual(pkg["text"]["tags"], "sky, science, light")
        keys = [c["key"] for c in pkg["checklist"]]
        for key in ("file", "title", "description", "tags", "made_for_kids", "ai_label", "cover", "check", "post", "link"):
            self.assertIn(key, keys)
        self.assertNotIn("thumbnail", keys, "Shorts take a frame picked in the app, not an uploaded thumbnail")
        self.assertEqual(pkg["upload_url"], "https://www.youtube.com/upload")
        self.assertEqual(pkg["routes"], ["browser"], "no API route until posting is connected")
        with patch.object(prepare, "_api_ready", lambda store, post_id: True):
            self.assertEqual(prepare.prepare(studio, post["id"], "david")["route"], "api")

    def test_long_youtube_video_is_16_9_with_chapters_and_a_thumbnail(self):
        post = self.approved(self.yt, title="The moon, start to finish", long_form=True)
        with patch.object(store_mod, "youtube_chapters", lambda p: "0:00 Intro\n1:10 Phases" if p.get("long_form") else ""):
            pkg = prepare.prepare(studio, post["id"], "david")["package"]
        self.assertEqual((pkg["kind"], pkg["aspect"], pkg["file"]["name"], pkg["file"]["approved_file"]), ("video", "16:9", "16-9-v2.mp4", True))
        self.assertIn("Chapters\n0:00 Intro\n1:10 Phases", pkg["text"]["description"])
        self.assertTrue(pkg["text"]["description"].endswith("#sky #science #light"))
        self.assertIn("thumbnail", [c["key"] for c in pkg["checklist"]])

    def test_instagram_cannot_schedule_on_the_web_and_says_so(self):
        post = self.approved(self.ig)
        at = time.time() + 3 * DAY
        prep = prepare.prepare(studio, post["id"], "david", scheduled_at=at)
        pkg = prep["package"]
        self.assertEqual(prep["scheduled_at"], at)
        self.assertEqual(pkg["schedule"]["supported"], False)
        schedule = next(c for c in pkg["checklist"] if c["key"] == "schedule")
        self.assertEqual(schedule["by"], "you")
        self.assertIn("Meta Business Suite", schedule["text"])
        self.assertEqual(pkg["upload_url"], "https://www.instagram.com/")
        self.assertIn("Press Share yourself", " ".join(c["text"] for c in pkg["checklist"]))

    def test_problems_wrong_aspect_too_long_and_text_over_the_limit(self):
        (Path(_DATA.name) / "gen").mkdir(exist_ok=True)
        with patch("core.image_gen.generated_files_dir", lambda: str(Path(_DATA.name) / "gen")):
            (Path(_DATA.name) / "gen" / "wide.mp4").write_bytes(b"x")
            post = self.approved(self.tt, ref="/generated-files/wide.mp4", title="Wide one")
            with patch.object(prepare, "probe", lambda p: {"seconds": 700.0, "width": 1920, "height": 1080}):
                pkg = prepare.prepare(studio, post["id"], "david")["package"]
        text = " ".join(pkg["problems"])
        self.assertIn("TikTok needs a 9:16 video", text)
        self.assertIn("11:40", text)
        long_caption = self.approved(self.ig, caption="word " * 500, title="Long caption")
        self.assertIn("takes 2200", " ".join(prepare.prepare(studio, long_caption["id"], "david")["package"]["problems"]))

    def test_no_length_known_goes_on_the_checklist(self):
        post = self.approved(self.tt)
        with patch.object(prepare, "probe", lambda p: None):
            pkg = prepare.prepare(studio, post["id"], "david")["package"]
        self.assertEqual(next(c for c in pkg["checklist"] if c["key"] == "length")["by"], "you")
        self.assertEqual(pkg["problems"], [])

    def test_only_an_approved_post_on_a_live_channel_with_its_file_is_prepared(self):
        draft = studio.create_post(self.tt["id"], "Draft", script_ref="x")
        with self.assertRaisesRegex(StudioError, "Only a post you approved"):
            prepare.prepare(studio, draft["id"], "david")
        post = self.approved(self.tt)
        os.remove(self.renders / "16-9-v2.mp4")
        with self.assertRaisesRegex(StudioError, "file is missing"):
            prepare.prepare(studio, post["id"], "david")
        (self.renders / "16-9-v2.mp4").write_bytes(b"back")
        studio.record_warning(self.tt["id"], "Community guidelines strike")
        with self.assertRaisesRegex(StudioError, "archived or paused"):
            prepare.prepare(studio, post["id"], "david")
        studio.resume_channel(self.tt["id"])
        studio.mark_posted(post["id"], "https://www.tiktok.com/@space.kairos/video/1234567")
        with self.assertRaisesRegex(StudioError, "already posted"):
            prepare.prepare(studio, post["id"], "david")

    def test_the_posting_time_policy_checks_still_apply(self):
        other_niche = studio.create_niche("Weather")
        other = studio.create_channel(other_niche["id"], "tiktok", "@weather.kairos")
        first = self.approved(self.tt)
        second = self.approved(other, title="A different title")   # the same render on another niche's TikTok
        with self.assertRaisesRegex(StudioError, "never posts one video on two of its own channels"):
            prepare.prepare(studio, second["id"], "david")
        self.assertTrue(any(e["body"].get("step") == "prepare" for e in studio.evidence(second["id"], "policy_check")))
        studio._update("posts", first["id"], ai_label=0)
        with self.assertRaisesRegex(StudioError, "AI label is off"):
            prepare.prepare(studio, first["id"], "david")

    def test_a_ready_post_tells_the_person_once(self):
        sent = []
        post = self.approved(self.tt)
        with patch("services.content_studio.team.producer_id", lambda store: "bot-producer"):
            notifier = lambda bot, title, body, urgent: sent.append((title, body)) or True
            prepare.prepare(studio, post["id"], "david", notifier=notifier)
            prepare.prepare(studio, post["id"], "david", notifier=notifier)
        self.assertEqual(len(sent), 1)
        self.assertIn("stops before Post, which you press yourself", sent[0][1])


class Dashboard(Base):
    def test_every_state_with_its_next_action(self):
        drafted = studio.create_post(self.yt["id"], "Drafted one", script_ref="x")
        waiting_ok = studio.create_post(self.yt["id"], "Needs your OK", script_ref="y")
        studio._update("posts", waiting_ok["id"], state="awaiting_approval")
        approved = self.approved(self.tt, title="Approved only")
        prepared = self.approved(self.yt, title="Prepared one")
        prepare.prepare(studio, prepared["id"], "david")
        filled = self.approved(self.ig, title="Filled one")
        prep = prepare.prepare(studio, filled["id"], "david")
        prepare.report_fill(studio, prep["id"], "done", ["file", "caption", "ai_label"], [])
        failed = self.approved(self.tt, title="Failed one", ref=f"/api/videos/{VIDEO}/renders/9-16-v1.mp4")
        prepare.prepare(studio, failed["id"], "david")
        prepare.record_failure(studio, failed["id"], "YouTube did not take the upload: quota")
        live = self.posted(self.tt, "https://www.tiktok.com/@space.kairos/video/1111111")
        rejected = self.approved(self.yt, title="Rejected one")
        prepare.prepare(studio, rejected["id"], "david")
        studio.reject(rejected["id"], "not this one")
        self.assertIsNone(studio.preparation_for(rejected["id"]), "a rejected post loses its package")
        board = publishing.dashboard(studio)
        state = {i["post_id"]: i for i in board["items"]}
        self.assertEqual({k: state[p["id"]]["state"] for k, p in (("d", drafted), ("w", waiting_ok), ("a", approved), ("p", prepared),
                                                                     ("f", filled), ("x", failed), ("l", live), ("r", rejected))},
                         {"d": "drafted", "w": "awaiting_approval", "a": "approved", "p": "prepared", "f": "waiting_for_you",
                          "x": "failed", "l": "posted", "r": "rejected"})
        self.assertEqual(board["counts"], {"drafted": 1, "awaiting_approval": 1, "approved": 1, "prepared": 1, "waiting_for_you": 1,
                                           "posted": 1, "failed": 1, "rejected": 1})
        self.assertEqual(state[filled["id"]]["state_label"], "Waiting for you to press Post")
        self.assertIn("press Share yourself", state[filled["id"]]["next"]["what"])
        self.assertEqual(state[filled["id"]]["fill"]["filled"], ["ai_label", "caption", "file"])
        self.assertIn("Open upload page", state[prepared["id"]]["next"]["what"])
        self.assertIn("quota", state[failed["id"]]["next"]["what"])
        self.assertEqual(state[live["id"]]["posted_url"], "https://www.tiktok.com/@space.kairos/video/1111111")
        self.assertEqual(state[waiting_ok["id"]]["next"]["who"], "you")
        self.assertEqual(state[drafted["id"]]["next"]["who"], "team")
        for item in board["items"]:
            self.assertEqual(item["week"], publishing.week_start(item["when"]))
            self.assertEqual(time.localtime(item["week"]).tm_wday, 0)
        self.assertEqual(time.localtime(board["this_week"]).tm_hour, 0)

    def test_posting_marks_the_package_posted_and_the_calendar_uses_the_schedule(self):
        post = self.approved(self.tt)
        prepare.prepare(studio, post["id"], "david")
        with self.assertRaisesRegex(StudioError, "in the past"):
            prepare.schedule(studio, post["id"], time.time() - 3600)
        at = time.time() + 9 * DAY
        prep = prepare.schedule(studio, post["id"], at)
        self.assertEqual(prep["scheduled_at"], at)
        self.assertIn("schedule", [c["key"] for c in prep["package"]["checklist"]])
        item = next(i for i in publishing.dashboard(studio)["items"] if i["post_id"] == post["id"])
        self.assertEqual((item["when"], item["when_kind"], item["week"]), (at, "scheduled", publishing.week_start(at)))
        cleared = prepare.schedule(studio, post["id"], None)
        self.assertIsNone(cleared["scheduled_at"])
        self.assertNotIn("schedule", [c["key"] for c in cleared["package"]["checklist"]])
        studio.mark_posted(post["id"], "https://www.tiktok.com/@space.kairos/video/2222222")
        self.assertEqual(studio.preparation_for(post["id"])["state"], "posted")
        with self.assertRaisesRegex(StudioError, "already posted"):
            prepare.report_fill(studio, studio.preparation_for(post["id"])["id"], "failed") and studio.update_preparation(
                studio.preparation_for(post["id"])["id"], state="failed")
        unprepared = self.approved(self.ig, title="Not prepared")
        with self.assertRaisesRegex(StudioError, "prepare the post first"):
            prepare.schedule(studio, unprepared["id"], at)

    def test_youtube_route_schedule_becomes_publish_at_and_a_refusal_shows_as_failed(self):
        post = self.approved(self.yt)
        meta = youtube_publish.metadata(post, "public", publish_at=1_900_000_000)
        self.assertEqual(meta["status"]["privacyStatus"], "private")
        self.assertEqual(meta["status"]["publishAt"], "2030-03-17T17:46:40Z")
        self.assertTrue(meta["status"]["containsSyntheticMedia"])
        self.assertNotIn("publishAt", youtube_publish.metadata(post, "public")["status"])
        prepare.prepare(studio, post["id"], "david")

        def refuse(store, post_id):
            raise youtube_publish.PostingError("YouTube did not take the upload: backend error", 502)
        with patch.object(youtube_publish, "_ready", refuse):
            with self.assertRaises(youtube_publish.PostingError):
                asyncio.run(youtube_publish.publish(studio, post["id"], "david"))
        item = next(i for i in publishing.dashboard(studio)["items"] if i["post_id"] == post["id"])
        self.assertEqual(item["state"], "failed")
        self.assertIn("backend error", item["error"])


class Routes(Base):
    def desktop(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=kairos.app, client=("127.0.0.1", 5000)), base_url="http://local",
                                 cookies=dict(self.d.cookies.items()))

    def test_the_person_prepares_schedules_and_sees_the_dashboard(self):
        post = self.approved(self.tt)
        r = self.d.post(f"{P}/posts/{post['id']}/prepare", json={})
        self.assertEqual(r.status_code, 200, r.text)
        prep_id = r.json()["id"]
        self.assertEqual(self.d.get(f"{P}/preparations/{prep_id}").json()["package"]["platform"], "tiktok")
        at = time.time() + DAY
        self.assertEqual(self.d.post(f"{P}/posts/{post['id']}/schedule", json={"at": at}).json()["scheduled_at"], at)
        board = self.d.get(f"{P}/publishing").json()
        self.assertEqual(board["items"][0]["state"], "prepared")
        self.assertIn("tiktok", board["page_reads"]["platforms"])
        self.assertEqual(self.b.get(f"{P}/preparations/{prep_id}").status_code, 404, "another account never sees it")
        self.assertEqual(self.b.get(f"{P}/publishing").json()["items"], [])
        self.assertEqual(self.d.post(f"{P}/posts/{post['id']}/prepare", json={"schedule_at": "soon"}).status_code, 422)

    def test_the_fill_plan_and_report_are_for_the_desktop_app_only(self):
        post = self.approved(self.yt, long_form=True)
        prep_id = prepare.prepare(studio, post["id"], "david")["id"]

        async def go():
            async with self.desktop() as client:
                url = f"{P}/desktop/prepared/{prep_id}"
                with patch.object(bot_approval_routes, "DESKTOP_SECRET", SECRET):
                    self.assertEqual((await client.post(url)).status_code, 404, "no secret")
                    self.assertEqual((await client.post(url, headers={"X-Kairos-Desktop": "nope"})).status_code, 404)
                    self.assertEqual((await client.post(url, headers={"X-Kairos-Desktop": SECRET, "X-JARVIS-Tool-Token": "t"})).status_code, 403)
                    plan = (await client.post(url, headers={"X-Kairos-Desktop": SECRET})).json()
                    reported = await client.post(url + "/report", headers={"X-Kairos-Desktop": SECRET},
                                                 json={"stage": "filling", "filled": ["file", "title", "evil"], "missing": ["ai_label"]})
                    self.assertEqual(reported.status_code, 200, reported.text)
                with patch.object(bot_approval_routes, "DESKTOP_SECRET", None):
                    self.assertEqual((await client.post(url, headers={"X-Kairos-Desktop": SECRET})).status_code, 404, "no desktop app")
                return plan, reported.json()
        plan, reported = asyncio.run(go())
        self.assertEqual(plan["upload_url"], "https://www.youtube.com/upload")
        files = {f["key"]: f for f in plan["fields"] if f["kind"] == "file"}
        self.assertTrue(os.path.samefile(files["file"]["path"], self.renders / "16-9-v2.mp4"))
        self.assertTrue(files["thumbnail"]["path"].endswith(f"post-{post['id']}.jpg"))
        self.assertEqual(next(f for f in plan["fields"] if f["key"] == "tags")["value"], "sky, science, light,")
        self.assertEqual({t["key"] for t in plan["toggles"]}, {"ai_label", "made_for_kids"})
        self.assertEqual(plan["post_button"], "Publish")
        self.assertEqual((reported["state"], reported["fill"]["filled"], reported["fill"]["missing"]), ("waiting_for_you", ["file", "title"], ["ai_label"]))
        self.assertIsNotNone(reported["opened_at"])
        # A cookie alone (the app page, a script in it) never gets the path.
        self.assertEqual(self.d.post(f"{P}/desktop/prepared/{prep_id}").status_code, 403)

    def test_a_problem_keeps_the_page_closed(self):
        post = self.approved(self.tt)
        with patch.object(prepare, "probe", lambda p: {"seconds": 900.0, "width": 1080, "height": 1920}):
            prep_id = prepare.prepare(studio, post["id"], "david")["id"]
        with self.assertRaisesRegex(StudioError, "problem to fix"):
            prepare.fill_plan(studio, prep_id)


class StopBeforePost(unittest.TestCase):
    """What the fill and the page reader can do, read from their code (browser-smoke proves the behaviour)."""

    def test_the_fill_never_submits_presses_keys_or_clicks_anything_but_a_checked_toggle(self):
        src = (ROOT / "electron" / "studio-prepare.js").read_text(encoding="utf-8")
        code = re.sub(r"//[^\n]*", "", src)
        for banned in ("requestSubmit", ".submit(", "dispatchMouseEvent", "dispatchKeyEvent", "dispatchTouchEvent", "sendInputEvent",
                       "Input.", "insertText', false, value) && el.click", "KeyboardEvent", "MouseEvent", "PointerEvent", "'Enter'", '"Enter"'):
            self.assertNotIn(banned, code, banned)
        clicks = [m.start() for m in re.finditer(r"\.click\(\)", code)]
        self.assertEqual(len(clicks), 1, "one click call in the whole fill")
        choose = code[code.index("choose(spec) {"):code.index("safeToggle, isFinal,")]
        self.assertIn(".click()", choose)
        self.assertLess(choose.index("if (!safeToggle(el)) return 'refused';"), choose.index(".click()"), "the toggle is checked before the click")
        self.assertIn("isFinal(el)", code[code.index("const safeToggle"):code.index("const isOn")])
        for word in ("post", "publish", "share", "submit", "upload", "schedule", "next"):
            self.assertRegex(code, r"const FINAL = /[^/]*\b" + word + r"\b", word)
        # The only DevTools commands it sends.
        self.assertEqual(sorted(set(re.findall(r"send\('([A-Za-z.]+)'", code))),
                         ["DOM.setFileInputFiles", "Page.createIsolatedWorld", "Page.getFrameTree", "Runtime.evaluate"])
        self.assertIn("isSecret(el)", code[code.index("if (spec.kind === 'text' && editable(el)"):][:80])

    def test_the_page_reader_only_reads(self):
        code = re.sub(r"//[^\n]*", "", (ROOT / "electron" / "studio-pages.js").read_text(encoding="utf-8"))
        for banned in (".click(", "sendInputEvent", "debugger", "executeJavaScript(", "insertText", "preload", "submit"):
            self.assertNotIn(banned, code, banned)
        self.assertEqual(re.findall(r"executeJavaScriptInIsolatedWorld\(\d+, \[\{ code: '([^']+)' \}\]\)", code),
                         ['document.body ? document.body.innerText : ""'])
        self.assertIn("setWindowOpenHandler(() => ({ action: 'deny' }))", code)

    def test_main_opens_only_the_platforms_own_page_and_never_for_a_model(self):
        main = (ROOT / "electron" / "main.js").read_text(encoding="utf-8")
        start = main.index("async function preparePost(")
        body = main[start:main.index("\n}\n", start)]
        self.assertIn("studioPrepare.hostAllowed(plan.platform, plan.upload_url)", body)
        self.assertNotIn("extraHosts", body, "the test-only local hosts never reach the app")
        ipc = (ROOT / "electron" / "browser-ipc.js").read_text(encoding="utf-8")
        self.assertIn('handle("browse:prepare-post", (b, prepId) => (isId(prepId) ? preparePost(b, prepId) : undefined)', ipc)
        tools = (ROOT / "core" / "bot_content_studio_tools.py").read_text(encoding="utf-8")
        self.assertNotIn("fill_plan", tools, "no bot tool reaches the fill plan")
        self.assertNotIn("browse:prepare-post", tools)

    def test_host_rules(self):
        for platform, good, bad in (("tiktok", "https://www.tiktok.com/tiktokstudio/upload", "https://tiktok.com.evil.test/"),
                                    ("instagram", "https://www.instagram.com/", "http://www.instagram.com/"),
                                    ("youtube", "https://studio.youtube.com/channel/x", "https://youtube.example/")):
            self.assertTrue(platforms.host_ok(platform, good))
            self.assertFalse(platforms.host_ok(platform, bad))


class PageReads(Base):
    def setUp(self):
        super().setUp()
        self.sleeps = []
        self.pages = {}
        self.asked = []

        async def sleep(seconds):
            self.sleeps.append(seconds)
        self.sleep = sleep

    async def reader(self, profile, platform, url):
        self.asked.append((profile, platform, url))
        page = self.pages.get(url, self.pages.get("*"))
        if isinstance(page, Exception):
            raise page
        return {"url": url, "title": "", "text": TIKTOK_PAGE} if page is None else page

    def read(self, platform="tiktok", now=None, **kw):
        return asyncio.run(page_reads.read_due(studio, platform, now=now, reader=self.reader, sleep=self.sleep, **kw))

    def test_parsing_the_mock_pages(self):
        tiktok = page_reads.parse("tiktok", page_text(MOCK / "tiktok-analytics.html").replace("Loading...", TIKTOK_PAGE))
        self.assertEqual(tiktok, {"views": 1200, "total_play_s": 7384.0, "avg_view_duration_s": 7.3, "follows_gained": 12,
                                  "likes": 210, "comments": 14, "shares": 9})
        insta = page_reads.parse("instagram", page_text(MOCK / "instagram-reel.html"))
        self.assertEqual(insta, {"views": 3456, "total_play_s": 3720.0, "avg_view_duration_s": 5.0, "likes": 120, "comments": 8,
                                 "shares": 5, "follows_gained": 3})
        self.assertEqual(page_reads.parse("tiktok", "Video views\n2.5M\nTotal play time\n10h"),
                         {"views": 2_500_000, "total_play_s": 36000.0, "avg_view_duration_s": 0.01})
        self.assertEqual(page_reads.parse("tiktok", "Comments: 1,234\nViews 1,2K"), {"comments": 1234, "views": 1200})
        self.assertEqual(page_reads.parse("tiktok", "I got 5 likes today\nlikes and comments are nice"), {}, "only label lines count")
        for text, want in (("7.3s", 7.3), ("1m 5s", 65), ("2h 3m", 7380), ("0:07", 7), ("1:02:03", 3723), ("fast", None)):
            self.assertEqual(page_reads.duration(text), want, text)

    def test_only_the_persons_own_post_pages(self):
        self.assertEqual(platforms.analytics_url("tiktok", "https://www.tiktok.com/@space.kairos/video/7350000000000000001", "@Space.Kairos"),
                         "https://www.tiktok.com/tiktokstudio/analytics/7350000000000000001")
        self.assertEqual(platforms.analytics_url("instagram", "https://www.instagram.com/reel/C9xYzAbCdEf/", "space.kairos"),
                         "https://www.instagram.com/reel/C9xYzAbCdEf/")
        for platform, url, handle, why in (
                ("tiktok", "https://www.tiktok.com/@someone.else/video/7350000000000000001", "@space.kairos", "not on this channel"),
                ("tiktok", "https://www.tiktok.com/@space.kairos", "@space.kairos", "not a video link"),
                ("tiktok", "https://www.tiktok.com.evil.test/@space.kairos/video/7350000000000000001", "@space.kairos", "https link on TikTok"),
                ("instagram", "https://www.instagram.com/space.kairos/", "space.kairos", "not a post or reel"),
                ("youtube", "https://www.youtube.com/watch?v=abc", "@x", "analytics API")):
            with self.assertRaisesRegex(ValueError, why):
                platforms.analytics_url(platform, url, handle)

    def test_off_until_the_person_turns_it_on_then_reads_and_stores_page_read_numbers(self):
        post = self.posted(self.tt, "https://www.tiktok.com/@space.kairos/video/7350000000000000001")
        self.assertEqual(self.read()["stopped"], "off")
        self.assertEqual(self.asked, [])
        studio.update_settings(page_reads={"tiktok": True})
        prepare_seconds = 31.0
        summary = self.read()
        self.assertEqual((summary["read"], summary["stored"], summary["stopped"]), (1, 1, ""))
        self.assertEqual(self.asked, [("default", "tiktok", "https://www.tiktok.com/tiktokstudio/analytics/7350000000000000001")],
                         "the first admin's Browse profile")
        snap = studio.snapshots(post["id"])[-1]
        self.assertEqual((snap["source"], snap["views"], snap["avg_view_duration_s"], snap["video_length_s"], snap["likes"],
                          snap["comments"], snap["shares"], snap["follows_gained"]),
                         ("page-read", 1200, 7.3, prepare_seconds, 210, 14, 9, 12))
        self.assertEqual(studio.page_reads("tiktok")[0]["status"], "ok")
        self.assertEqual(self.read()["read"], 0, "each post at most once in 20 hours")

    def test_rate_limits_gap_daily_cap_and_age(self):
        studio.update_settings(page_reads={"tiktok": True})
        now = time.time()
        for n in range(4):
            self.posted(self.tt, f"https://www.tiktok.com/@space.kairos/video/73500000000000000{n:02d}", days_ago=1 + n * 0.01, title=f"Post {n}", now=now)
        self.posted(self.tt, "https://www.tiktok.com/@space.kairos/video/7350000000000000099", days_ago=61, title="Old one", now=now)
        summary = self.read(now=now)
        self.assertEqual(summary["read"], 4, "the 61-day-old post is not read")
        self.assertEqual(self.sleeps, [page_reads.MIN_GAP_S] * 3, "pages 20 seconds apart")
        self.assertEqual(self.read(now=now + 21 * 3600, limit=2)["read"], 2, "a pass takes at most its limit")
        for i in range(page_reads.MAX_PER_DAY):
            studio.record_page_read("tiktok", "ok", None, "https://www.tiktok.com/x", now=now + 21 * 3600)
        self.assertEqual(self.read(now=now + 22 * 3600)["stopped"], "daily_limit")
        self.assertEqual(page_reads.status(studio, now + 22 * 3600)["platforms"]["tiktok"]["reads_today"], page_reads.MAX_PER_DAY + 6)

    def test_signed_out_pauses_not_yours_stores_nothing_and_page_changes_pause_until_try_again(self):
        studio.update_settings(page_reads={"tiktok": True})
        now = time.time()
        post = self.posted(self.tt, "https://www.tiktok.com/@space.kairos/video/7350000000000000001", now=now)
        url = "https://www.tiktok.com/tiktokstudio/analytics/7350000000000000001"
        self.pages[url] = {"url": "https://www.tiktok.com/login?redirect=x", "title": "", "text": "Log in to TikTok"}
        self.assertEqual(self.read(now=now)["stopped"], "signed_out")
        self.assertEqual(self.read(now=now + 3600)["stopped"], "signed_out", "paused for six hours")
        self.assertEqual(page_reads.status(studio, now + 3600)["platforms"]["tiktok"]["paused"], "signed_out")
        self.pages[url] = {"url": url, "title": "", "text": TIKTOK_PAGE.replace("space.kairos", "someone.else")}
        later = now + page_reads.SIGNED_OUT_PAUSE_S + 60
        self.assertEqual(self.read(now=later)["statuses"], {"not_yours": 1})
        self.assertEqual(studio.snapshots(post["id"]), [], "nothing stored from a page that is not the channel's")
        for n in range(page_reads.PARSE_FAILS_TO_PAUSE):
            self.pages[url] = {"url": url, "title": "", "text": "space.kairos\nSomething new\nNo numbers here"}
            self.read(now=later + (n + 1) * 21 * 3600)
        when = later + 5 * 21 * 3600
        self.assertEqual(self.read(now=when)["stopped"], "page_changed")
        self.assertEqual(page_reads.status(studio, when)["platforms"]["tiktok"]["paused"], "page_changed")
        page_reads.try_again(studio, "tiktok", now=when)
        self.pages[url] = {"url": url, "title": "", "text": TIKTOK_PAGE}
        self.assertEqual(self.read(now=when + 1)["stored"], 1)

    def test_desktop_app_closed_is_not_counted_and_unknown_length_is_not_stored(self):
        studio.update_settings(page_reads={"instagram": True})
        post = self.posted(self.ig, "https://www.instagram.com/reel/C9xYzAbCdEf/")
        self.pages["*"] = page_reads.Unavailable("Page reads need the Kairos desktop app open.")
        self.assertEqual(self.read("instagram")["stopped"], "unavailable")
        self.assertEqual(page_reads.status(studio)["platforms"]["instagram"]["reads_today"], 0)
        self.pages["*"] = {"url": "https://www.instagram.com/reel/C9xYzAbCdEf/", "title": "", "text": page_text(MOCK / "instagram-reel.html")}
        with patch.object(page_reads, "_length", lambda store, p: None):
            self.assertEqual(self.read("instagram")["statuses"], {"parse_failed": 1})
        self.assertEqual(studio.snapshots(post["id"]), [])

    def test_routes_switch_read_now_and_the_worker_token(self):
        self.assertEqual(self.d.put(f"{P}/analytics/pages", json={"tiktok": True}).json()["platforms"]["tiktok"]["on"], True)
        self.assertEqual(self.b.get(f"{P}/analytics/pages").json()["platforms"]["tiktok"]["on"], False, "per account")
        self.assertEqual(self.d.post(f"{P}/analytics/pages/read", json={"platform": "instagram"}).status_code, 409, "off for Instagram")
        self.assertEqual(self.d.post(f"{P}/analytics/pages/read", json={"platform": "youtube"}).status_code, 422)
        self.assertEqual(self.d.post(f"{P}/analytics/pages/read", json={"platform": "tiktok"}).status_code, 409, "no desktop app")
        self.assertEqual(self.d.post(f"{P}/analytics/pages/try-again", json={"platform": "tiktok"}).status_code, 200)
        anon = TestClient(kairos.app)
        self.assertEqual(anon.get("/api/content-studio/page-reads/jobs").status_code, 404)
        self.assertEqual(anon.post("/api/content-studio/page-reads/result/abc", content=b"{}").status_code, 404)
        self.assertEqual(self.d.get("/api/content-studio/page-reads/jobs", headers={"X-Kairos-Render-Token": "guess"}).status_code, 404)

    def test_the_bridge_hands_the_page_back_and_refuses_junk(self):
        async def go():
            page_reads._workers += 1
            try:
                task = asyncio.ensure_future(page_reads.read_page("default", "tiktok", "https://www.tiktok.com/tiktokstudio/analytics/1"))
                await asyncio.sleep(0.01)
                job = await page_reads._q().get()
                self.assertEqual((job["profile"], job["platform"]), ("default", "tiktok"))
                self.assertTrue(page_reads.complete(job["id"], json.dumps({"url": job["url"], "text": "x" * 300000}).encode()))
                page = await task
                self.assertEqual(len(page["text"]), page_reads.MAX_TEXT)
                task = asyncio.ensure_future(page_reads.read_page("default", "tiktok", "https://www.tiktok.com/tiktokstudio/analytics/2"))
                await asyncio.sleep(0.01)
                job = await page_reads._q().get()
                page_reads.complete(job["id"], b"[1,2]")
                with self.assertRaises(page_reads.Unavailable):
                    await task
                self.assertFalse(page_reads.complete("nope", b"{}"))
            finally:
                page_reads._workers -= 1
        asyncio.run(go())
        with self.assertRaisesRegex(page_reads.Unavailable, "desktop app"):
            asyncio.run(page_reads.read_page("default", "tiktok", "https://www.tiktok.com/x"))

    def test_the_schedule_pass_covers_each_account_that_turned_it_on(self):
        studio.update_settings(page_reads={"tiktok": True})
        self.posted(self.tt, "https://www.tiktok.com/@space.kairos/video/7350000000000000001")
        with accounts.as_account(self.bea_id):
            studio.update_settings(page_reads={"tiktok": False, "instagram": False})
        done = asyncio.run(page_reads.read_all_due(reader=self.reader, sleep=self.sleep))
        self.assertEqual(done[f"{self.david_id}:tiktok"]["stored"], 1)
        self.assertFalse(any(k.startswith(self.bea_id) for k in done))
        from core import task_scheduler

        class Loop:
            def __init__(self):
                self.made = []

            def create_task(self, coro):
                self.made.append(coro)
                coro.close()
        loop = Loop()
        task_scheduler._page_reads.update(task=None, last=0.0)
        task_scheduler._page_reads_due(loop)
        self.assertEqual(loop.made, [], "nothing starts without the desktop app")
        with patch.object(page_reads, "available", lambda: True):
            task_scheduler._page_reads.update(task=None, last=0.0)
            task_scheduler._page_reads_due(loop)
            task_scheduler._page_reads_due(loop)
        self.assertEqual(len(loop.made), 1, "once per half hour")


def tearDownModule():
    close_all()
    import logging  # let the throwaway folder go: the app's log handlers keep their files open
    for logger in [logging.getLogger()] + [logging.getLogger(n) for n in logging.root.manager.loggerDict]:
        for handler in list(getattr(logger, "handlers", [])):
            if isinstance(handler, logging.FileHandler):
                handler.close()
                logger.removeHandler(handler)


if __name__ == "__main__":
    unittest.main()

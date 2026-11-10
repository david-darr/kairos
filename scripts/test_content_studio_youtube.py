"""Content Studio YouTube analytics (read-only): the optional scope grant, channel ownership, video-to-post mapping,
metrics into snapshots, quota backoff, token refresh reuse, account isolation and disconnect.

Google is a mock transport: no network, no sign-in, no real project. Two real accounts on a throwaway data folder."""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-studio-yt-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
os.environ["AUTH_ENABLED"] = "true"
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

import atexit  # noqa: E402

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as kairos  # noqa: E402
from core import accounts  # noqa: E402
from core import google_workspace as google  # noqa: E402
from core.auth import auth_manager  # noqa: E402
from core.secret_storage import encrypt  # noqa: E402
from services.content_studio import close_all, studio, youtube, youtube_publish  # noqa: E402

atexit.register(close_all)

REAL = httpx.AsyncClient
P = "/api/content-studio"
G = "/api/google"
DAY = 86400.0
CLIENT = "fixture.apps.googleusercontent.com"
BASE_SCOPES = " ".join(google.SCOPES)


class FakeGoogle:
    """Just enough of Google's OAuth, userinfo, YouTube Data and YouTube Analytics endpoints."""

    def __init__(self):
        self.log = []
        self.email = "owner@example.com"
        self.scope = BASE_SCOPES
        self.scope_for = {}              # refresh token -> scope Google reports on refresh
        self.channels = [{"id": "UCalpha0000000000000000", "snippet": {"customUrl": "@alpha", "title": "Alpha Channel"}}]
        self.videos = {}                 # video id -> (ISO duration, channel id)
        self.analytics = {}              # video id -> dict of metrics
        self.quota_failures = []         # statuses/reasons to answer the next analytics calls with before succeeding
        self.reject_bearer = None        # one bearer token answered with 401, once
        self.refreshes = 0
        self.uploads = []                # (metadata, video bytes) of each upload
        self.upload_privacy = None       # what YouTube says it set; None echoes the request
        self.upload_channel = "UCalpha0000000000000000"
        self.popular = []                # the most-popular chart

    def handle(self, req):
        self.log.append(req)
        host, path = req.url.host, req.url.path
        if host == "oauth2.googleapis.com":
            form = parse_qs(req.content.decode())
            if form["grant_type"] == ["refresh_token"]:
                self.refreshes += 1
                token = form["refresh_token"][0]
                return httpx.Response(200, json={"access_token": f"fresh-{self.refreshes}", "expires_in": 3600,
                                                 "scope": self.scope_for.get(token, self.scope)})
            return httpx.Response(200, json={"refresh_token": f"refresh-{self.email}", "access_token": f"access-{self.email}",
                                             "expires_in": 3600, "scope": self.scope})
        if host == "openidconnect.googleapis.com":
            return httpx.Response(200, json={"email": self.email})
        bearer = req.headers.get("authorization", "")
        if self.reject_bearer and bearer == f"Bearer {self.reject_bearer}":
            self.reject_bearer = None
            return httpx.Response(401, json={"error": {"message": "Invalid Credentials"}})
        q = dict(req.url.params)
        if host == "www.googleapis.com" and path == "/youtube/v3/channels":
            assert q.get("mine") == "true"
            return httpx.Response(200, json={"items": self.channels})
        if host == "www.googleapis.com" and path == "/youtube/v3/videos" and q.get("chart"):
            assert q["chart"] == "mostPopular" and len(q["regionCode"]) == 2 and int(q["maxResults"]) <= 50
            return httpx.Response(200, json={"items": self.popular[:int(q["maxResults"])]})
        if host == "www.googleapis.com" and path == "/upload/youtube/v3/videos":
            assert req.method == "POST" and q == {"part": "snippet,status", "uploadType": "multipart"}
            boundary = req.headers["content-type"].split("boundary=")[1]
            parts = req.content.split(f"--{boundary}".encode())
            meta = json.loads(parts[1].split(b"\r\n\r\n", 1)[1].strip())
            video = parts[2].split(b"\r\n\r\n", 1)[1][:-2]
            self.uploads.append((meta, video))
            return httpx.Response(200, json={"id": "NEWvideo_01", "snippet": {"channelId": self.upload_channel, **meta["snippet"]},
                                             "status": {**meta["status"], "privacyStatus": self.upload_privacy or meta["status"]["privacyStatus"]}})
        if host == "www.googleapis.com" and path == "/youtube/v3/videos":
            items = [{"id": v, "contentDetails": {"duration": self.videos[v][0]}, "snippet": {"channelId": self.videos[v][1]}}
                     for v in q["id"].split(",") if v in self.videos]
            assert len(q["id"].split(",")) <= 50
            return httpx.Response(200, json={"items": items})
        if host == "youtubeanalytics.googleapis.com" and path == "/v2/reports":
            if self.quota_failures:
                status, reason, headers = self.quota_failures.pop(0)
                return httpx.Response(status, headers=headers, json={"error": {"message": "limit " + reason, "errors": [{"reason": reason}]}})
            assert q["ids"].startswith("channel==UC") and q["dimensions"] == "video" and q["sort"] and int(q["maxResults"]) <= 200
            assert q["metrics"] == "views,averageViewDuration,likes,comments,shares,subscribersGained"
            wanted = q["filters"].removeprefix("video==").split(",")
            rows = [[v, *[self.analytics[v][m] for m in youtube.METRICS]] for v in wanted if v in self.analytics]
            return httpx.Response(200, json={"columnHeaders": [{"name": "video"}, *({"name": m} for m in youtube.METRICS)],
                                             "rows": rows})
        raise AssertionError(f"Unexpected request (no network allowed): {req.method} {req.url}")

    def hit(self, host, path_part=""):
        return [r for r in self.log if r.url.host == host and path_part in r.url.path]


def metrics(views, avd, likes=0, comments=0, shares=0, subs=0):
    return {"views": views, "averageViewDuration": avd, "likes": likes, "comments": comments, "shares": shares,
            "subscribersGained": subs}


def make_posted(store, channel_id, title, url, posted_at):
    post = store.create_post(channel_id, title, script_ref=f"The script of {title}", now=posted_at - 7200)
    store.edit_post(post["id"], now=posted_at - 3600, render_ref=f"r-{post['id']}.mp4", render_status="ok")
    store.submit_for_approval(post["id"], now=posted_at - 1800)
    store.approve(post["id"], "david", now=posted_at - 900)
    store.mark_posted(post["id"], url, posted_at=posted_at, now=posted_at)
    return post["id"]


class YouTubeAnalytics(unittest.TestCase):
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
        cls.anon = TestClient(kairos.app)
        google.configure(CLIENT, "", "david")

    def setUp(self):
        self.fake = FakeGoogle()
        self.sleeps = []

        async def no_sleep(seconds):
            self.sleeps.append(seconds)

        for mock in (patch.object(google.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(self.fake.handle), **kw)),
                     patch.object(youtube, "_sleep", no_sleep)):
            mock.start()
            self.addCleanup(mock.stop)
        google._pending.clear()
        self.d, self.b = self.clients["david"], self.clients["bea"]
        # a clean slate for each test: no Google sign-ins, no link, no posts
        for acct, client in ((self.david_id, self.d), (self.bea_id, self.b)):
            with accounts.as_account(acct):
                google._save({**google._load(), "accounts": {}, "default_account": None})
                youtube.disconnect()
                youtube_publish.disconnect()
                for snap in studio.snapshots():
                    studio._write("DELETE FROM snapshots WHERE id = ?", (snap["id"],))
                studio._write("DELETE FROM post_evidence")
                studio._write("DELETE FROM posts")
                studio._write("DELETE FROM channel_warnings")
                studio._write("DELETE FROM channels")
                studio._write("DELETE FROM niches")

    # -- helpers ------------------------------------------------------------------------------------

    def finish_sign_in(self, client, url, email=None):
        query = parse_qs(urlsplit(url).query)
        self.fake.scope = query["scope"][0]
        if email:
            self.fake.email = email
        r = self.anon.get(f"{G}/oauth/callback", params={"state": query["state"][0], "code": "code"})
        self.assertEqual(r.status_code, 200, r.text)
        return query

    def sign_in_google(self, client, email="owner@example.com"):
        url = client.post(f"{G}/oauth/start", json={}).json()["url"]
        return self.finish_sign_in(client, url, email)

    def connect(self, client, email="owner@example.com"):
        self.sign_in_google(client, email)
        r = client.post(f"{P}/analytics/youtube/connect", json={})
        self.assertEqual(r.status_code, 200, r.text)
        return self.finish_sign_in(client, r.json()["url"])

    def studio_setup(self, acct, handles=("@alpha",)):
        now = time.time()
        with accounts.as_account(acct):
            niche = studio.create_niche("Space")
            ids = {}
            for handle in handles:
                channel = studio.create_channel(niche["id"], "youtube", handle)
                ids[handle] = channel["id"]
        return ids, now

    def snapshots(self, acct):
        with accounts.as_account(acct):
            return studio.snapshots()

    # -- the optional grant ---------------------------------------------------------------------------

    def test_youtube_scopes_are_requested_only_when_asked(self):
        plain = parse_qs(urlsplit(self.d.post(f"{G}/oauth/start", json={}).json()["url"]).query)
        self.assertFalse(any("youtube" in s or "yt-analytics" in s for s in plain["scope"][0].split()))
        self.assertNotIn("include_granted_scopes", plain)
        self.assertFalse(any("youtube" in s for s in google.SCOPES))
        self.assertFalse(self.d.get(f"{P}/analytics/youtube/status").json()["connected"])
        # A YouTube connect with no Google sign-in refuses plainly instead of asking for Drive and Gmail alone.
        r = self.d.post(f"{P}/analytics/youtube/connect", json={})
        self.assertEqual(r.status_code, 409, r.text)
        self.sign_in_google(self.d)
        status = self.d.get(f"{P}/analytics/youtube/status").json()
        self.assertFalse(status["connected"], "a normal Google sign-in does not connect YouTube")
        query = self.connect(self.d)
        scopes = query["scope"][0].split()
        self.assertTrue(set(youtube.SCOPES) <= set(scopes) and set(google.SCOPES) <= set(scopes))
        self.assertEqual(query["include_granted_scopes"], ["true"])
        status = self.d.get(f"{P}/analytics/youtube/status").json()
        self.assertTrue(status["connected"])
        self.assertEqual(status["google_account"]["email"], "owner@example.com")
        self.assertIn("never posts", status["notice"])
        self.assertIn("private-only", status["notice"])
        self.assertNotIn("refresh", str(status).lower().replace("needs_reconnect", ""))
        # Only the YouTube read-only pair and the posting pair can be added this way; never full YouTube management.
        with self.assertRaises(google.GoogleError):
            google.start_sign_in("http://127.0.0.1:8420/api/google/oauth/callback", "david",
                                 extra_scopes=("https://www.googleapis.com/auth/youtube",))
        self.assertNotIn("https://www.googleapis.com/auth/youtube.upload", scopes, "analytics never asks to post")

    def test_declining_the_extra_grant_leaves_it_unconnected(self):
        self.sign_in_google(self.d)
        url = self.d.post(f"{P}/analytics/youtube/connect", json={}).json()["url"]
        query = parse_qs(urlsplit(url).query)
        self.fake.scope = BASE_SCOPES  # the person unticked YouTube on Google's consent page
        r = self.anon.get(f"{G}/oauth/callback", params={"state": query["state"][0], "code": "code"})
        self.assertEqual(r.status_code, 200)
        status = self.d.get(f"{P}/analytics/youtube/status").json()
        self.assertFalse(status["connected"])
        self.assertTrue(status["pending"])
        self.assertEqual(self.d.post(f"{P}/analytics/youtube/sync").status_code, 409)

    # -- ownership, mapping, metrics --------------------------------------------------------------

    def test_channel_ownership_and_video_to_post_mapping(self):
        ids, now = self.studio_setup(self.david_id, ("@alpha", "@other"))
        with accounts.as_account(self.david_id):
            a1 = make_posted(studio, ids["@alpha"], "watch", "https://www.youtube.com/watch?v=aaaaaaaaaaa&t=3", now - 3 * DAY)
            a2 = make_posted(studio, ids["@alpha"], "short", "https://youtube.com/shorts/bbbbbbbbbbb?feature=share", now - 2 * DAY)
            a3 = make_posted(studio, ids["@alpha"], "short link", "https://youtu.be/ccccccccccc", now - 2 * DAY)
            a4 = make_posted(studio, ids["@alpha"], "not youtube", "https://example.test/video/1", now - 2 * DAY)
            a5 = make_posted(studio, ids["@alpha"], "someone else's", "https://youtu.be/ddddddddddd", now - 2 * DAY)
            a6 = make_posted(studio, ids["@alpha"], "no numbers yet", "https://youtu.be/eeeeeeeeeee", now - 1 * DAY)
            o1 = make_posted(studio, ids["@other"], "other channel", "https://youtu.be/fffffffffff", now - 2 * DAY)
        owner = "UCalpha0000000000000000"
        self.fake.videos = {"aaaaaaaaaaa": ("PT1M5S", owner), "bbbbbbbbbbb": ("PT30S", owner), "ccccccccccc": ("PT1H2M3S", owner),
                            "ddddddddddd": ("PT10S", "UCsomeoneelse000000000"), "eeeeeeeeeee": ("PT9S", owner),
                            "fffffffffff": ("PT9S", owner)}
        self.fake.analytics = {"aaaaaaaaaaa": metrics(1200, 41.5, 90, 12, 7, 3), "bbbbbbbbbbb": metrics(80, 12.0),
                               "ccccccccccc": metrics(5, 100.4, 1, 0, 0, 0), "ddddddddddd": metrics(999, 1)}
        self.connect(self.d)
        r = self.d.post(f"{P}/analytics/youtube/sync")
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json()["result"]
        self.assertEqual(result["stored"], 3)
        self.assertEqual(result["channels_not_owned"], ["@other"])
        self.assertEqual(result["skipped"], {"not_owned": 1, "not_on_channel": 1, "no_data_yet": 1})
        snaps = {s["post_id"]: s for s in self.snapshots(self.david_id)}
        self.assertEqual(set(snaps), {a1, a2, a3}, "not-YouTube, other owner's, no-data and un-owned channel posts get nothing")
        s = snaps[a1]
        self.assertEqual((s["views"], s["avg_view_duration_s"], s["video_length_s"], s["likes"], s["comments"], s["shares"],
                          s["follows_gained"], s["source"]), (1200, 41.5, 65.0, 90, 12, 7, 3, "youtube_api"))
        self.assertEqual(snaps[a3]["video_length_s"], 3723.0)
        self.assertEqual(snaps[a3]["avg_view_duration_s"], 100.4)
        # The Analytics call asked the signed-in channel only, in one batch, with the lifetime window.
        report = self.fake.hit("youtubeanalytics.googleapis.com")[0].url.params
        self.assertEqual(report["ids"], f"channel=={owner}")
        self.assertEqual(report["filters"].count(","), 3)
        # Snapshots are added, never edited: a sync more than an hour later adds a second row.
        with accounts.as_account(self.david_id):
            again = asyncio.run(youtube.sync(studio, now=now + 3 * 3600))
        self.assertEqual(again["stored"], 3)
        self.assertEqual(len(self.snapshots(self.david_id)), 6)
        del a4, a5, a6, o1

    def test_a_second_sync_inside_an_hour_adds_nothing(self):
        ids, now = self.studio_setup(self.david_id)
        with accounts.as_account(self.david_id):
            make_posted(studio, ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        self.fake.videos = {"aaaaaaaaaaa": ("PT20S", "UCalpha0000000000000000")}
        self.fake.analytics = {"aaaaaaaaaaa": metrics(10, 5)}
        self.connect(self.d)
        self.assertEqual(self.d.post(f"{P}/analytics/youtube/sync").json()["result"]["stored"], 1)
        again = self.d.post(f"{P}/analytics/youtube/sync").json()["result"]
        self.assertEqual((again["stored"], again["skipped"]), (0, {"already_fresh": 1}))
        self.assertEqual(len(self.snapshots(self.david_id)), 1)

    def test_posts_beyond_the_batch_size_are_batched(self):
        ids, now = self.studio_setup(self.david_id)
        owner = "UCalpha0000000000000000"
        with accounts.as_account(self.david_id):
            for i in range(120):
                vid = f"v{i:010d}"
                make_posted(studio, ids["@alpha"], f"v{i}", f"https://youtu.be/{vid}", now - 2 * DAY)
                self.fake.videos[vid] = ("PT20S", owner)
                self.fake.analytics[vid] = metrics(i + 1, 3)
        self.connect(self.d)
        self.assertEqual(self.d.post(f"{P}/analytics/youtube/sync").json()["result"]["stored"], 120)
        self.assertEqual(len(self.fake.hit("www.googleapis.com", "/youtube/v3/videos")), 3)
        self.assertEqual(len(self.fake.hit("youtubeanalytics.googleapis.com")), 3)

    # -- quota ------------------------------------------------------------------------------------

    def test_quota_errors_back_off_then_succeed(self):
        ids, now = self.studio_setup(self.david_id)
        with accounts.as_account(self.david_id):
            make_posted(studio, ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        self.fake.videos = {"aaaaaaaaaaa": ("PT20S", "UCalpha0000000000000000")}
        self.fake.analytics = {"aaaaaaaaaaa": metrics(10, 5)}
        self.fake.quota_failures = [(403, "quotaExceeded", {}), (429, "rateLimitExceeded", {"retry-after": "7"})]
        self.connect(self.d)
        result = self.d.post(f"{P}/analytics/youtube/sync").json()["result"]
        self.assertEqual((result["stored"], result["stopped"]), (1, None))
        self.assertEqual(self.sleeps, [1.0, 7.0], "exponential backoff, and Retry-After when Google sends it")

    def test_quota_that_never_clears_stops_the_sync_and_keeps_what_it_has(self):
        ids, now = self.studio_setup(self.david_id)
        with accounts.as_account(self.david_id):
            make_posted(studio, ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        self.fake.videos = {"aaaaaaaaaaa": ("PT20S", "UCalpha0000000000000000")}
        self.fake.quota_failures = [(403, "quotaExceeded", {})] * 10
        self.connect(self.d)
        result = self.d.post(f"{P}/analytics/youtube/sync").json()["result"]
        self.assertEqual((result["stored"], result["stopped"]), (0, "quota"))
        self.assertEqual(self.sleeps, [1.0, 2.0, 4.0])
        status = self.d.get(f"{P}/analytics/youtube/status").json()
        self.assertIn("quota", status["last_error"])
        self.assertIsNone(status["last_sync"], "a stopped sync is not a finished one")
        with accounts.as_account(self.david_id):
            self.assertFalse(youtube.due(time.time() + 3600))
            self.assertTrue(youtube.due(time.time() + 4 * 3600), "a failed sync is retried sooner than a day")

    def test_other_google_errors_do_not_loop(self):
        ids, now = self.studio_setup(self.david_id)
        with accounts.as_account(self.david_id):
            make_posted(studio, ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        self.fake.videos = {"aaaaaaaaaaa": ("PT20S", "UCalpha0000000000000000")}
        self.fake.quota_failures = [(403, "accessNotConfigured", {})]
        self.connect(self.d)
        result = self.d.post(f"{P}/analytics/youtube/sync").json()["result"]
        self.assertEqual(result["stopped"], "error")
        self.assertEqual(self.sleeps, [])
        self.assertIn("Turn on the YouTube", self.d.get(f"{P}/analytics/youtube/status").json()["last_error"])

    # -- token refresh ----------------------------------------------------------------------------

    def test_an_expired_token_is_refreshed_by_the_shared_google_path(self):
        ids, now = self.studio_setup(self.david_id)
        with accounts.as_account(self.david_id):
            make_posted(studio, ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        self.fake.videos = {"aaaaaaaaaaa": ("PT20S", "UCalpha0000000000000000")}
        self.fake.analytics = {"aaaaaaaaaaa": metrics(10, 5)}
        self.connect(self.d)
        with accounts.as_account(self.david_id):
            data = google._load()
            for account in data["accounts"].values():
                account["expires_at"] = time.time() - 10
            google._save(data)
        self.assertEqual(self.d.post(f"{P}/analytics/youtube/sync").json()["result"]["stored"], 1)
        self.assertEqual(self.fake.refreshes, 1)
        bearers = {r.headers["authorization"] for r in self.fake.hit("www.googleapis.com", "/youtube/v3/channels")}
        self.assertEqual(bearers, {"Bearer fresh-1"})
        # A 401 mid-sync forces one more refresh and the call is retried once.
        self.fake.reject_bearer = "fresh-1"
        self.fake.log.clear()
        with accounts.as_account(self.david_id):
            result = asyncio.run(youtube.sync(studio, now=now + 3 * 3600))
        self.assertEqual(result["stored"], 1)
        self.assertEqual(self.fake.refreshes, 2)

    def test_a_revoked_google_sign_in_is_reported_not_crashed(self):
        ids, now = self.studio_setup(self.david_id)
        with accounts.as_account(self.david_id):
            make_posted(studio, ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        self.connect(self.d)
        with accounts.as_account(self.david_id):
            data = google._load()
            for account in data["accounts"].values():
                account["expires_at"] = 0
            google._save(data)
        with patch.object(google.httpx, "AsyncClient", lambda **kw: REAL(
                transport=httpx.MockTransport(lambda req: httpx.Response(400, json={"error": "invalid_grant"})), **kw)):
            result = self.d.post(f"{P}/analytics/youtube/sync").json()["result"]
        self.assertEqual(result["stopped"], "error")
        status = self.d.get(f"{P}/analytics/youtube/status").json()
        self.assertTrue(status["needs_reconnect"])

    # -- accounts apart, daily pass, disconnect ----------------------------------------------------

    def test_accounts_stay_apart_and_the_daily_pass_runs_only_for_the_connected(self):
        d_ids, now = self.studio_setup(self.david_id)
        b_ids, _ = self.studio_setup(self.bea_id)
        owner = "UCalpha0000000000000000"
        with accounts.as_account(self.david_id):
            make_posted(studio, d_ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        with accounts.as_account(self.bea_id):
            make_posted(studio, b_ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        self.fake.videos = {"aaaaaaaaaaa": ("PT20S", owner)}
        self.fake.analytics = {"aaaaaaaaaaa": metrics(10, 5)}
        self.connect(self.d)
        # Bea signed in to Google (a plain sign-in) but never asked for YouTube analytics.
        self.sign_in_google(self.b, "bea@example.com")
        self.assertFalse(self.b.get(f"{P}/analytics/youtube/status").json()["connected"])
        self.assertEqual(self.b.post(f"{P}/analytics/youtube/sync").status_code, 409)
        # Bea cannot attach David's Google sign-in either.
        d_google = self.d.get(f"{G}/status").json()["accounts"][0]["id"]
        self.assertEqual(self.b.post(f"{P}/analytics/youtube/connect", json={"account": d_google}).status_code, 404)
        self.assertFalse(self.b.get(f"{P}/analytics/youtube/status").json()["pending"])

        done = asyncio.run(youtube.sync_all_due())
        self.assertEqual(list(done), [self.david_id])
        self.assertEqual(done[self.david_id]["stored"], 1)
        self.assertEqual(len(self.snapshots(self.david_id)), 1)
        self.assertEqual(self.snapshots(self.bea_id), [])
        # Done for the day; due again after ~22 hours.
        self.assertEqual(asyncio.run(youtube.sync_all_due()), {})
        self.assertEqual(asyncio.run(youtube.sync_all_due(now=time.time() + 23 * 3600)).keys(), {self.david_id})

    def test_disconnect_stops_everything_and_keeps_stored_numbers(self):
        ids, now = self.studio_setup(self.david_id)
        with accounts.as_account(self.david_id):
            make_posted(studio, ids["@alpha"], "v", "https://youtu.be/aaaaaaaaaaa", now - 2 * DAY)
        self.fake.videos = {"aaaaaaaaaaa": ("PT20S", "UCalpha0000000000000000")}
        self.fake.analytics = {"aaaaaaaaaaa": metrics(10, 5)}
        self.connect(self.d)
        self.d.post(f"{P}/analytics/youtube/sync")
        status = self.d.delete(f"{P}/analytics/youtube").json()
        self.assertFalse(status["connected"] or status["pending"])
        self.assertEqual(self.d.post(f"{P}/analytics/youtube/sync").status_code, 409)
        self.assertEqual(asyncio.run(youtube.sync_all_due(now=time.time() + 5 * DAY)), {})
        self.assertEqual(len(self.snapshots(self.david_id)), 1)
        # Disconnecting twice is harmless, and the Google sign-in itself is untouched.
        self.assertEqual(self.d.delete(f"{P}/analytics/youtube").status_code, 200)
        self.assertEqual(len(self.d.get(f"{G}/status").json()["accounts"]), 1)

    def test_every_route_needs_a_user(self):
        for method, path in (("GET", "/analytics/youtube/status"), ("POST", "/analytics/youtube/connect"),
                             ("POST", "/analytics/youtube/sync"), ("DELETE", "/analytics/youtube")):
            self.assertEqual(self.anon.request(method, P + path).status_code, 401, f"{method} {path}")

    def test_older_stores_gain_the_source_column(self):
        import sqlite3
        from services.content_studio import Store
        path = os.path.join(_DATA.name, "old", "studio.db")
        os.makedirs(os.path.dirname(path))
        old = sqlite3.connect(path)
        old.executescript("CREATE TABLE snapshots (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, taken_at REAL NOT NULL, "
                          "views INTEGER NOT NULL, avg_view_duration_s REAL NOT NULL, video_length_s REAL NOT NULL, "
                          "likes INTEGER NOT NULL, comments INTEGER NOT NULL, shares INTEGER NOT NULL, follows_gained INTEGER NOT NULL);"
                          "INSERT INTO snapshots VALUES (1, 1, 1, 1, 1, 1, 0, 0, 0, 0);")
        old.commit(); old.close()
        store = Store(path)
        self.assertEqual(store.snapshots()[0]["source"], "manual")
        store.close()


class YouTubePostingAndTrends(YouTubeAnalytics):
    """Direct posting through the person's own Google project (D1) and the most-popular list for the Researcher.
    Runs on the same mock Google and accounts; the analytics tests are not repeated here."""

    def connect_posting(self, client, email="owner@example.com"):
        self.sign_in_google(client, email)
        r = client.post(f"{P}/posting/youtube/connect", json={})
        self.assertEqual(r.status_code, 200, r.text)
        return self.finish_sign_in(client, r.json()["url"])

    def approved_post(self, acct, channel_id, video=b"\x00\x00\x00\x18ftypmp42 fake video", tags="space, Black holes, #space"):
        from core import image_gen
        with accounts.as_account(acct):
            folder = image_gen.generated_files_dir()
            os.makedirs(folder, exist_ok=True)
            # One file per channel: the policy checks refuse one video on two of the team's channels.
            with open(os.path.join(folder, f"abc123_black-holes-{channel_id}.mp4"), "wb") as f:
                f.write(video)
            post = studio.create_post(channel_id, "Black <holes> explained", script_ref="beats", caption="Why light cannot escape.")
            studio.edit_post(post["id"], render_ref=f"/generated-files/abc123_black-holes-{channel_id}.mp4", render_status="ok", tags=tags)
            studio.submit_for_approval(post["id"])
            return post["id"]

    def test_posting_grant_is_its_own_and_asked_only_when_connecting_posting(self):
        self.sign_in_google(self.d)
        self.assertFalse(self.d.get(f"{P}/posting/youtube/status").json()["connected"])
        query = self.connect_posting(self.d)
        scopes = query["scope"][0].split()
        self.assertTrue(set(youtube_publish.SCOPES) <= set(scopes))
        self.assertNotIn("https://www.googleapis.com/auth/yt-analytics.readonly", scopes)
        status = self.d.get(f"{P}/posting/youtube/status").json()
        self.assertTrue(status["connected"])
        self.assertEqual(status["privacy"], "private", "private until the person chooses otherwise")
        self.assertIn("API audit", status["notice"])
        self.assertIn("Prepare post", status["notice"])
        self.assertFalse(self.d.get(f"{P}/analytics/youtube/status").json()["connected"], "posting does not turn on analytics")
        self.assertEqual(self.d.put(f"{P}/posting/youtube/privacy", json={"privacy": "everyone"}).status_code, 400)
        self.assertEqual(self.d.put(f"{P}/posting/youtube/privacy", json={"privacy": "unlisted"}).json()["privacy"], "unlisted")
        self.assertFalse(self.d.delete(f"{P}/posting/youtube").json()["connected"])

    def test_publish_sends_only_an_approved_post_exactly_as_approved_with_the_ai_label(self):
        ids, _ = self.studio_setup(self.david_id)
        post_id = self.approved_post(self.david_id, ids["@alpha"])
        r = self.d.post(f"{P}/posts/{post_id}/publish-youtube")
        self.assertEqual(r.status_code, 409, "not approved yet")
        self.assertIn("approved", r.json()["detail"])
        self.d.post(f"{P}/posts/{post_id}/approve")
        r = self.d.post(f"{P}/posts/{post_id}/publish-youtube")
        self.assertEqual(r.status_code, 409, "posting not connected")
        self.assertIn("Connect YouTube posting", r.json()["detail"])
        self.assertEqual(self.d.get(f"{P}/posts/{post_id}").json()["direct_post_blocker"], "Connect YouTube posting first.")
        self.connect_posting(self.d)
        self.assertIsNone(self.d.get(f"{P}/posts/{post_id}").json()["direct_post_blocker"])
        r = self.d.post(f"{P}/posts/{post_id}/publish-youtube")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["video_id"], body["privacy"], body["kept_private"]), ("NEWvideo_01", "private", False))
        self.assertEqual(len(self.fake.uploads), 1)
        meta, video = self.fake.uploads[0]
        self.assertEqual(meta["snippet"]["title"], "Black holes explained", "YouTube refuses < and >")
        self.assertEqual(meta["snippet"]["description"], "Why light cannot escape.")
        self.assertEqual(meta["snippet"]["tags"], ["space", "Black holes"])
        self.assertEqual(meta["status"], {"privacyStatus": "private", "selfDeclaredMadeForKids": False, "containsSyntheticMedia": True})
        self.assertEqual(video, b"\x00\x00\x00\x18ftypmp42 fake video")
        post = self.d.get(f"{P}/posts/{post_id}").json()
        self.assertEqual((post["state"], post["posted_url"]), ("posted", "https://www.youtube.com/watch?v=NEWvideo_01"))
        self.assertEqual(youtube.video_id(post["posted_url"]), "NEWvideo_01", "the analytics sync can read it")
        again = self.d.post(f"{P}/posts/{post_id}/publish-youtube")
        self.assertEqual(again.status_code, 409)
        self.assertEqual(len(self.fake.uploads), 1, "never uploaded twice")
        self.assertEqual(self.d.get(f"{P}/posting/youtube/status").json()["last_upload"]["video_id"], "NEWvideo_01")

    def test_youtube_keeping_an_upload_private_is_said_plainly(self):
        ids, _ = self.studio_setup(self.david_id)
        post_id = self.approved_post(self.david_id, ids["@alpha"])
        self.d.post(f"{P}/posts/{post_id}/approve")
        self.connect_posting(self.d)
        self.d.put(f"{P}/posting/youtube/privacy", json={"privacy": "public"})
        self.fake.upload_privacy = "private"
        body = self.d.post(f"{P}/posts/{post_id}/publish-youtube").json()
        self.assertEqual((body["asked_privacy"], body["privacy"], body["kept_private"]), ("public", "private", True))
        self.assertIn("API audit", body["note"])
        self.assertEqual(self.fake.uploads[0][0]["status"]["privacyStatus"], "public")

    def test_publish_refuses_what_it_cannot_send_safely(self):
        ids, _ = self.studio_setup(self.david_id, handles=("@alpha", "@stranger"))
        self.connect_posting(self.d)
        # A channel the connected Google account does not own.
        post_id = self.approved_post(self.david_id, ids["@stranger"])
        self.d.post(f"{P}/posts/{post_id}/approve")
        r = self.d.post(f"{P}/posts/{post_id}/publish-youtube")
        self.assertEqual(r.status_code, 409)
        self.assertIn("does not own", r.json()["detail"])
        # A paused channel, a missing file, and a render that is not an uploadable MP4.
        mine = self.approved_post(self.david_id, ids["@alpha"])
        self.d.post(f"{P}/posts/{mine}/approve")
        with accounts.as_account(self.david_id):
            studio.record_warning(ids["@alpha"], "Strike")
        self.assertIn("paused", self.d.post(f"{P}/posts/{mine}/publish-youtube").json()["detail"])
        with accounts.as_account(self.david_id):
            studio.resume_channel(ids["@alpha"])
            from core import image_gen
            os.remove(os.path.join(image_gen.generated_files_dir(), f"abc123_black-holes-{ids['@alpha']}.mp4"))
        self.assertIn("missing", self.d.post(f"{P}/posts/{mine}/publish-youtube").json()["detail"])
        for ref in ("r.mp4", "/generated-files/..%2F..%2Fsecret.mp4", "/generated-files/notes.txt", "https://cdn.example.test/v.mp4"):
            with self.subTest(ref=ref):
                with self.assertRaises(youtube_publish.PostingError):
                    with accounts.as_account(self.david_id):
                        youtube_publish.render_file(ref)
        self.assertEqual(self.fake.uploads, [], "nothing was uploaded")
        # Another account's post is out of reach.
        self.assertEqual(self.b.post(f"{P}/posts/{mine}/publish-youtube").status_code, 404)

    def test_most_popular_needs_the_read_grant_and_keeps_source_and_date(self):
        with accounts.as_account(self.david_id):
            with self.assertRaises(youtube.YouTubeError):
                asyncio.run(youtube.trending("US"))
        self.connect(self.d)
        self.fake.popular = [{"id": "dQw4w9WgXcQ", "snippet": {"title": "Big video", "channelTitle": "Someone", "publishedAt": "2026-11-01T00:00:00Z"},
                              "statistics": {"viewCount": "1200", "likeCount": "30"}, "contentDetails": {"duration": "PT45S"}}]
        with accounts.as_account(self.david_id):
            found = asyncio.run(youtube.trending("gb", "28", 5, now=1_790_000_000.0))
            for bad in (("USA", None), ("U1", None), ("US", "film")):
                with self.assertRaises(youtube.YouTubeError):
                    asyncio.run(youtube.trending(*bad))
        self.assertEqual(found["region"], "GB")
        video = found["videos"][0]
        self.assertEqual((video["views"], video["length_s"], video["source"]), (1200, 45.0, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
        self.assertEqual(video["read_on"], found["read_on"])
        self.assertIn("most-popular", found["source"])
        chart = [r for r in self.fake.log if dict(r.url.params).get("chart")]
        self.assertEqual(dict(chart[0].url.params)["videoCategoryId"], "28")

    # The analytics tests run once, in YouTubeAnalytics.
    for _name in [n for n in dir(YouTubeAnalytics) if n.startswith("test_")]:
        locals()[_name] = None
    del _name


class Helpers(unittest.TestCase):
    def test_video_ids(self):
        v = youtube.video_id
        for url in ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://m.youtube.com/watch?feature=x&v=dQw4w9WgXcQ",
                    "https://youtu.be/dQw4w9WgXcQ?t=4", "https://www.youtube.com/shorts/dQw4w9WgXcQ",
                    "https://www.youtube.com/live/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"):
            self.assertEqual(v(url), "dQw4w9WgXcQ", url)
        for url in ("", None, "https://evil.test/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=short",
                    "https://www.youtube.com/@channel", "https://notyoutube.com/shorts/dQw4w9WgXcQ"):
            self.assertIsNone(v(url), url)

    def test_durations(self):
        self.assertEqual(youtube.iso_seconds("PT1M5S"), 65)
        self.assertEqual(youtube.iso_seconds("PT1H"), 3600)
        self.assertEqual(youtube.iso_seconds("PT0S"), 0)
        self.assertEqual(youtube.iso_seconds("P0D"), 0)
        self.assertEqual(youtube.iso_seconds("nonsense"), 0)


if __name__ == "__main__":
    unittest.main()

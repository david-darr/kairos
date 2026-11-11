"""Content Studio: official TikTok and Instagram through the person's own registered apps (section 12, 2026-11-10).

Everything runs against a local mock server built from the platforms' docs (read 2026-11-10): TikTok's OAuth v2 token
and revoke, user info, Direct Post creator info, init, chunked upload, status fetch, and the Display API video query;
Meta's code exchange, long-lived token, /me/accounts, content_publishing_limit, Reels containers, rupload, container
status, media_publish, media list and insights. Nothing real is called: no sign-in, no post.

Covers: app keys sealed per account and never returned; the redirect URIs; the sign-in (PKCE with TikTok's hex
challenge, single-use state, the channel's own handle only); token refresh (TikTok rotates its refresh token); posting
with the audit rules (unaudited means Only you on a private account, said plainly), consent and no defaults; chunking;
errors and rate limits; the API chosen when connected, the upload page otherwise; official numbers into the scoring
record, page reads only as the fallback; disconnect; tokens never in logs, errors or responses; one account never
sees another's.
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-studio-social-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
os.environ["AUTH_ENABLED"] = "true"
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

import atexit  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

import app as kairos  # noqa: E402
from core import accounts, video_store  # noqa: E402
from core.auth import auth_manager  # noqa: E402
from services.content_studio import (close_all, instagram_api, page_reads, prepare, review, scoring, social, social_auth,  # noqa: E402
                                     studio, tiktok_api)
from services.content_studio.store import StudioError  # noqa: E402

atexit.register(close_all)
P = "/api/content-studio"
DAY = 86400.0
VIDEO = "c0ffee123456"
TT_SECRET = "tt-client-secret-VALUE-1"
FB_SECRET = "fb-app-secret-VALUE-2"


def run(coro):
    return asyncio.run(coro)


async def no_sleep(_seconds):
    return None


# -- the mock platforms -------------------------------------------------------------------------------------------

class Mock:
    """State and a request log for the mock TikTok and Meta servers. Tests set the knobs; the handler follows the docs."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.log = []
        self.challenge = None
        self.tt_username = "space.kairos"
        self.tt_access = "tt-access-1"
        self.tt_refresh = "tt-refresh-1"
        self.tt_rotations = 0
        self.tt_refresh_fails = False
        self.revoked = []
        self.options = ["FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]     # a private account
        self.max_duration = 600
        self.init_error = None
        self.init_bodies = []
        self.upload = bytearray()
        self.upload_ranges = []
        self.statuses = [{"status": "PROCESSING_UPLOAD"}, {"status": "PUBLISH_COMPLETE"}]
        self.later_status = None
        self.videos = {}
        self.query_429 = 0
        self.fb_pages = [{"id": "page1", "name": "Space Kairos", "access_token": "fb-page-token",
                          "instagram_business_account": {"id": "ig1", "username": "space.kairos"}}]
        self.quota = {"quota_usage": 2, "config": {"quota_total": 100, "quota_duration": 86400}}
        self.refuse_ai_field = False
        self.containers = []
        self.container_states = ["IN_PROGRESS", "FINISHED"]
        self.rupload = []
        self.published = []
        self.media_list = []
        self.insights = {}


MOCK = Mock()


def _json(handler, code, data, headers=None):
    raw = json.dumps(data).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    for k, v in (headers or {}).items():
        handler.send_header(k, v)
    handler.end_headers()
    handler.wfile.write(raw)


def _ok(data):
    return {"data": data, "error": {"code": "ok", "message": "", "log_id": "x"}}


def _tt_err(code, message=""):
    return {"data": {}, "error": {"code": code, "message": message, "log_id": "x"}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _body(self):
        size = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(size) if size else b""

    def _record(self, raw):
        url = urlsplit(self.path)
        entry = {"method": self.command, "path": url.path, "query": parse_qs(url.query), "headers": dict(self.headers),
                 "raw": raw}
        ctype = self.headers.get("Content-Type") or ""
        if "application/x-www-form-urlencoded" in ctype:
            entry["form"] = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
        elif "application/json" in ctype and raw:
            entry["json"] = json.loads(raw)
        MOCK.log.append(entry)
        return entry

    def do_GET(self):
        self._route(self._record(b""))

    def do_POST(self):
        self._route(self._record(self._body()))

    def do_PUT(self):
        self._route(self._record(self._body()))

    def _route(self, e):
        p, q, m = e["path"], e["query"], MOCK
        auth = e["headers"].get("Authorization") or ""
        one = lambda k: (q.get(k) or [None])[0]
        # ---- TikTok ----
        if p == "/tt/v2/oauth/token/":
            form = e["form"]
            if form["client_secret"] != TT_SECRET:
                return _json(self, 401, {"error": "invalid_client", "error_description": "bad"})
            if form["grant_type"] == "authorization_code":
                if form["code"] != "good-code" or hashlib.sha256(form["code_verifier"].encode()).hexdigest() != m.challenge:
                    return _json(self, 400, {"error": "invalid_grant", "error_description": "bad code"})
                return _json(self, 200, {"access_token": m.tt_access, "refresh_token": m.tt_refresh, "expires_in": 86400,
                                         "refresh_expires_in": 15552000, "open_id": "open-1", "token_type": "Bearer",
                                         "scope": "user.info.basic,user.info.profile,video.publish,video.list"})
            if form["grant_type"] == "refresh_token":
                if m.tt_refresh_fails or form["refresh_token"] != m.tt_refresh:
                    return _json(self, 400, {"error": "invalid_grant", "error_description": "refresh token is invalid"})
                m.tt_rotations += 1
                m.tt_access, m.tt_refresh = f"tt-access-{m.tt_rotations + 1}", f"tt-refresh-{m.tt_rotations + 1}"
                return _json(self, 200, {"access_token": m.tt_access, "refresh_token": m.tt_refresh, "expires_in": 7200,
                                         "refresh_expires_in": 15552000, "open_id": "open-1", "scope": "video.publish"})
        if p == "/tt/v2/oauth/revoke/":
            m.revoked.append(e["form"]["token"])
            return _json(self, 200, {})
        if p.startswith("/tt/v2/") and auth != f"Bearer {m.tt_access}":
            return _json(self, 401, _tt_err("access_token_invalid", "The access token is invalid or not found in the request."))
        if p == "/tt/v2/user/info/":
            return _json(self, 200, _ok({"user": {"open_id": "open-1", "display_name": "Space", "username": m.tt_username}}))
        if p == "/tt/v2/post/publish/creator_info/query/":
            return _json(self, 200, _ok({"creator_username": m.tt_username, "creator_nickname": "Space Kairos",
                                         "creator_avatar_url": "https://p16.tiktokcdn.test/a.jpg",
                                         "privacy_level_options": m.options, "comment_disabled": False,
                                         "duet_disabled": True, "stitch_disabled": True,
                                         "max_video_post_duration_sec": m.max_duration}))
        if p == "/tt/v2/post/publish/video/init/":
            m.init_bodies.append(e["json"])
            if m.init_error:
                status, code = m.init_error
                return _json(self, status, _tt_err(code))
            if e["json"]["post_info"]["privacy_level"] not in m.options:
                return _json(self, 403, _tt_err("privacy_level_option_mismatch"))
            m.upload = bytearray()
            m.upload_ranges = []
            port = self.server.server_address[1]
            return _json(self, 200, _ok({"publish_id": "v_pub_file~v2-1.123", "upload_url": f"http://127.0.0.1:{port}/tt/upload/abc"}))
        if p == "/tt/upload/abc":
            info = m.init_bodies[-1]["source_info"]
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", e["headers"]["Content-Range"])
            first, last, total = map(int, match.groups())
            if first != len(m.upload) or total != info["video_size"] or last - first + 1 != len(e["raw"]):
                return _json(self, 416, {})
            m.upload.extend(e["raw"])
            m.upload_ranges.append((first, last))
            done = len(m.upload) == total
            self.send_response(201 if done else 206)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if p == "/tt/v2/post/publish/status/fetch/":
            state = m.statuses.pop(0) if m.statuses else (m.later_status or {"status": "PUBLISH_COMPLETE"})
            return _json(self, 200, _ok(state))
        if p == "/tt/v2/video/query/":
            if m.query_429:
                m.query_429 -= 1
                return _json(self, 429, _tt_err("rate_limit_exceeded"), {"Retry-After": "1"})
            ids = e["json"]["filters"]["video_ids"]
            assert len(ids) <= 20 and one("fields")
            return _json(self, 200, _ok({"videos": [m.videos[i] for i in ids if i in m.videos], "has_more": False}))
        # ---- Meta ----
        if p == "/fb/oauth/access_token":
            if one("client_secret") != FB_SECRET:
                return _json(self, 400, {"error": {"message": "Error validating client secret.", "code": 1}})
            if one("grant_type") == "fb_exchange_token":
                return _json(self, 200, {"access_token": "fb-long-user", "token_type": "bearer", "expires_in": 5183944})
            if one("code") != "fb-code" or not one("redirect_uri"):
                return _json(self, 400, {"error": {"message": "Invalid verification code format.", "code": 100}})
            return _json(self, 200, {"access_token": "fb-short-user", "token_type": "bearer", "expires_in": 3600})
        if p == "/fb/me/accounts":
            if auth != "Bearer fb-long-user":
                return _json(self, 400, {"error": {"message": "Invalid OAuth access token.", "code": 190}})
            return _json(self, 200, {"data": m.fb_pages})
        if p.startswith("/rup/"):
            m.rupload.append({"container": p.split("/")[-1], "headers": e["headers"], "size": len(e["raw"])})
            if auth != "OAuth fb-page-token" or e["headers"].get("offset") != "0" or int(e["headers"]["file_size"]) != len(e["raw"]):
                return _json(self, 400, {"debug_info": {"message": "bad upload"}})
            return _json(self, 200, {"success": True, "message": "Upload successful."})
        if p.startswith("/fb/") and auth != "Bearer fb-page-token":
            return _json(self, 400, {"error": {"message": "Invalid OAuth access token.", "code": 190}})
        if p == "/fb/ig1/content_publishing_limit":
            return _json(self, 200, {"data": [m.quota]})
        if p == "/fb/ig1/media" and e["method"] == "POST":
            form = e["form"]
            if m.refuse_ai_field and "is_ai_generated" in form:
                return _json(self, 400, {"error": {"message": "(#100) Param is_ai_generated is not supported for REELS", "code": 100}})
            m.containers.append(form)
            return _json(self, 200, {"id": f"cont{len(m.containers)}", "uri": f"https://rupload.facebook.com/ig-api-upload/cont{len(m.containers)}"})
        if p == "/fb/ig1/media":
            return _json(self, 200, {"data": m.media_list, "paging": {}})
        if re.fullmatch(r"/fb/cont\d+", p):
            state = m.container_states.pop(0) if m.container_states else "FINISHED"
            return _json(self, 200, {"status_code": state, "status": state, "id": p.split("/")[-1]})
        if p == "/fb/ig1/media_publish":
            m.published.append(e["form"]["creation_id"])
            return _json(self, 200, {"id": "17900000000000001"})
        if re.fullmatch(r"/fb/\d+/insights", p):
            media = p.split("/")[2]
            values = m.insights.get(media)
            if values is None:
                return _json(self, 200, {"data": []})
            return _json(self, 200, {"data": [{"name": k, "period": "lifetime", "values": [{"value": v}]} for k, v in values.items()]})
        if re.fullmatch(r"/fb/\d+", p):
            return _json(self, 200, {"id": p.split("/")[-1], "permalink": "https://www.instagram.com/reel/DAbCdEfGhIj/",
                                     "shortcode": "DAbCdEfGhIj"})
        return _json(self, 404, {"error": {"message": f"mock has no {self.command} {p}"}})


SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{SERVER.server_address[1]}"
social_auth.HOSTS.update({"tiktok_auth": BASE + "/tt/auth", "tiktok_api": BASE + "/tt", "meta_dialog": BASE + "/fb/dialog",
                          "graph": BASE + "/fb", "rupload": BASE + "/rup"})


def probe_short(path):
    return {"seconds": 31.0, "width": 1080, "height": 1920}


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
        cls.anon = TestClient(kairos.app)

    def setUp(self):
        MOCK.reset()
        self.d, self.b = self.clients["david"], self.clients["bea"]
        for account in (self.bea_id, self.david_id):
            with accounts.as_account(account):
                try:
                    os.remove(social_auth._path())
                except FileNotFoundError:
                    pass
        self.scope = accounts.as_account(self.david_id)
        self.scope.__enter__()
        self.addCleanup(self.scope.__exit__, None, None, None)
        for table in ("page_reads", "preparations", "snapshots", "post_evidence", "posts", "channel_warnings", "channels", "topics", "niches"):
            studio._write(f"DELETE FROM {table}")
        studio.update_settings(page_reads={"tiktok": False, "instagram": False}, notified={})
        self.niche = studio.create_niche("Sky science")
        self.tt = studio.create_channel(self.niche["id"], "tiktok", "@space.kairos")
        self.ig = studio.create_channel(self.niche["id"], "instagram", "space.kairos")
        self.renders = video_store._folder(VIDEO) / "renders"
        self.renders.mkdir(parents=True, exist_ok=True)
        for name in os.listdir(self.renders):
            os.remove(self.renders / name)
        self.video_bytes = b"stand-in vertical video " * 50
        (self.renders / "9-16-v1.mp4").write_bytes(self.video_bytes)
        for p in (patch.object(prepare, "probe", probe_short), patch.object(social_auth, "_sleep", no_sleep)):
            p.start()
            self.addCleanup(p.stop)
        self.logs = []
        handler = logging.Handler()
        handler.emit = lambda record: self.logs.append(record.getMessage())
        logging.getLogger().addHandler(handler)
        self.addCleanup(logging.getLogger().removeHandler, handler)

    # helpers ---------------------------------------------------------------------------------------------------

    def approved(self, channel, title="Why the sky is blue", caption="Sunlight scatters off the air.", tags="sky, science"):
        post = studio.create_post(channel["id"], title, script_ref=f"Beat 1: {title}.", caption=caption)
        studio.edit_post(post["id"], render_ref=f"/api/videos/{VIDEO}/renders/9-16-v1.mp4", render_status="ok", tags=tags)
        studio._update("posts", post["id"], state="awaiting_approval")
        studio.approve(post["id"], "david")
        return studio.get_post(post["id"])

    def tiktok_app(self, client=None, audited=None):
        body = {"key": "awtiktokkey123", "secret": TT_SECRET}
        if audited is not None:
            body["audited"] = audited
        r = (client or self.d).put(f"{P}/social/apps/tiktok", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def meta_app(self, client=None, redirect=None):
        body = {"key": "1234567890123", "secret": FB_SECRET}
        if redirect:
            body["redirect"] = redirect
        r = (client or self.d).put(f"{P}/social/apps/instagram", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def connect_tiktok(self, channel=None):
        self.tiktok_app()
        r = self.d.post(f"{P}/social/tiktok/connect", json={"channel_id": (channel or self.tt)["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        query = parse_qs(urlsplit(r.json()["url"]).query)
        MOCK.challenge = query["code_challenge"][0]
        page = self.anon.get(f"/api/content-studio/social/callback/tiktok", params={"state": query["state"][0], "code": "good-code"})
        return r.json(), query, page

    def connect_instagram(self):
        self.meta_app()
        r = self.d.post(f"{P}/social/instagram/connect", json={"channel_id": self.ig["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        query = parse_qs(urlsplit(r.json()["url"]).query)
        page = self.anon.get(f"/api/content-studio/social/callback/instagram", params={"state": query["state"][0], "code": "fb-code"})
        return r.json(), query, page

    def secrets_absent(self, text):
        for secret in (TT_SECRET, FB_SECRET, "tt-access-", "tt-refresh-", "fb-page-token", "fb-long-user", "fb-short-user"):
            self.assertNotIn(secret, text)


class AppsAndSignIn(Base):
    def test_app_keys_are_sealed_and_never_returned(self):
        status = self.tiktok_app()
        self.assertTrue(status["apps"]["tiktok"]["configured"])
        self.assertTrue(status["apps"]["tiktok"]["has_secret"])
        self.assertFalse(status["apps"]["tiktok"]["audited"])
        self.assertIn("private", status["apps"]["tiktok"]["note"])
        raw = Path(social_auth._path()).read_text(encoding="utf-8")
        self.assertNotIn(TT_SECRET, raw)
        self.secrets_absent(self.d.get(f"{P}/social/status").text)
        # A key that cannot be one, and a Meta app id that is not a number, are refused.
        self.assertEqual(self.d.put(f"{P}/social/apps/tiktok", json={"key": "no spaces allowed!", "secret": "x"}).status_code, 400)
        self.assertEqual(self.d.put(f"{P}/social/apps/instagram", json={"key": "abc", "secret": FB_SECRET}).status_code, 400)
        self.assertEqual(self.d.put(f"{P}/social/apps/youtube", json={"key": "x"}).status_code, 404)

    def test_redirect_uris_to_register(self):
        self.tiktok_app()
        self.meta_app()
        apps = self.d.get(f"{P}/social/status").json()["apps"]
        self.assertRegex(apps["tiktok"]["redirect_uri"], r"^http://127\.0\.0\.1:\*/api/content-studio/social/callback/tiktok$")
        self.assertRegex(apps["instagram"]["redirect_uri"], r"^http://localhost:\d+/api/content-studio/social/callback/instagram$")
        self.meta_app(redirect="paste")
        apps = self.d.get(f"{P}/social/status").json()["apps"]
        self.assertEqual(apps["instagram"]["redirect_uri"], "https://www.facebook.com/connect/login_success.html")

    def test_tiktok_sign_in_with_pkce_keeps_only_the_channels_own_account(self):
        started, query, page = self.connect_tiktok()
        self.assertEqual(page.status_code, 200, page.text)
        self.assertIn("Connected @space.kairos", page.text)
        self.assertEqual(query["client_key"], ["awtiktokkey123"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertRegex(query["code_challenge"][0], r"^[0-9a-f]{64}$", "TikTok's desktop PKCE uses a hex SHA-256")
        self.assertEqual(query["scope"], ["user.info.basic,user.info.profile,video.publish,video.list"])
        self.assertRegex(query["redirect_uri"][0], r"^http://127\.0\.0\.1:\d+/api/content-studio/social/callback/tiktok$")
        token_call = next(e for e in MOCK.log if e["path"] == "/tt/v2/oauth/token/")
        self.assertEqual(token_call["form"]["redirect_uri"], query["redirect_uri"][0])
        conn = social_auth.connection(self.tt["id"])
        self.assertTrue(conn["connected"])
        self.assertEqual(conn["account"], "@space.kairos")
        raw = Path(social_auth._path()).read_text(encoding="utf-8")
        self.assertNotIn("tt-access-1", raw)
        self.assertNotIn("tt-refresh-1", raw)
        # The state is single use.
        again = self.anon.get("/api/content-studio/social/callback/tiktok", params={"state": query["state"][0], "code": "good-code"})
        self.assertEqual(again.status_code, 400)
        self.secrets_absent(page.text + again.text + "\n".join(self.logs))

    def test_tiktok_sign_in_as_another_account_is_refused_and_revoked(self):
        MOCK.tt_username = "someone.else"
        _, _, page = self.connect_tiktok()
        self.assertEqual(page.status_code, 409)
        self.assertIn("@someone.else", page.text)
        self.assertIsNone(social_auth.connection(self.tt["id"]))
        self.assertEqual(MOCK.revoked, ["tt-access-1"])

    def test_a_cancelled_or_unknown_sign_in_stores_nothing(self):
        self.tiktok_app()
        r = self.d.post(f"{P}/social/tiktok/connect", json={"channel_id": self.tt["id"]})
        state = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
        self.assertEqual(self.anon.get("/api/content-studio/social/callback/tiktok", params={"state": "made-up", "code": "x"}).status_code, 400)
        page = self.anon.get("/api/content-studio/social/callback/tiktok", params={"state": state, "error": "access_denied"})
        self.assertEqual(page.status_code, 400)
        self.assertIsNone(social_auth.connection(self.tt["id"]))
        # A channel on another platform cannot be connected to TikTok.
        self.assertEqual(self.d.post(f"{P}/social/tiktok/connect", json={"channel_id": self.ig["id"]}).status_code, 409)

    def test_tiktok_token_refresh_rotates_the_refresh_token(self):
        self.connect_tiktok()
        social_auth._mark(self.tt["id"], expires_at=time.time() - 10)
        self.assertEqual(run(social_auth.token(self.tt["id"], "tiktok")), "tt-access-2")
        self.assertEqual(MOCK.tt_rotations, 1)
        conn = social_auth._load()["connections"][str(self.tt["id"])]
        self.assertEqual(social_auth._open(conn["refresh_token"]), "tt-refresh-2", "the rotated refresh token is kept")
        # A refused refresh asks the person to connect again and marks the channel.
        social_auth._mark(self.tt["id"], expires_at=time.time() - 10)
        MOCK.tt_refresh_fails = True
        with self.assertRaises(StudioError) as caught:
            run(social_auth.token(self.tt["id"], "tiktok"))
        self.assertIn("Connect it again", caught.exception.detail)
        self.assertFalse(social_auth.connected(self.tt["id"], "tiktok"))

    def test_an_invalid_access_token_is_refreshed_once(self):
        self.connect_tiktok()
        MOCK.tt_access = "tt-access-server-side-changed"   # TikTok no longer takes the stored one
        MOCK.tt_refresh, MOCK.tt_rotations = "tt-refresh-1", 0
        info = run(tiktok_api.creator_info(self.tt["id"]))
        self.assertEqual(info["username"], "space.kairos")
        self.assertEqual(MOCK.tt_rotations, 1)

    def test_instagram_sign_in_finds_the_linked_professional_account(self):
        started, query, page = self.connect_instagram()
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(query["client_id"], ["1234567890123"])
        self.assertIn("instagram_content_publish", query["scope"][0])
        self.assertIn("instagram_manage_insights", query["scope"][0])
        conn = social_auth.record(self.ig["id"])
        self.assertEqual((conn["ig_user_id"], conn["page_id"], conn["account_name"]), ("ig1", "page1", "@space.kairos"))
        self.assertGreater(conn["user_expires_at"], time.time() + 50 * DAY, "the long-lived user token was asked for")
        self.secrets_absent(Path(social_auth._path()).read_text(encoding="utf-8") + page.text + "\n".join(self.logs))

    def test_instagram_without_the_channels_account_stores_nothing(self):
        MOCK.fb_pages = [{"id": "page2", "name": "Other", "access_token": "fb-page-token",
                          "instagram_business_account": {"id": "ig9", "username": "other.account"}}]
        _, _, page = self.connect_instagram()
        self.assertEqual(page.status_code, 409)
        self.assertIn("Business or Creator", page.text)
        self.assertIn("@other.account", page.text)
        self.assertIsNone(social_auth.connection(self.ig["id"]))

    def test_instagram_paste_route(self):
        self.meta_app(redirect="paste")
        r = self.d.post(f"{P}/social/instagram/connect", json={"channel_id": self.ig["id"]})
        query = parse_qs(urlsplit(r.json()["url"]).query)
        self.assertEqual(query["redirect_uri"], ["https://www.facebook.com/connect/login_success.html"])
        bad = self.d.post(f"{P}/social/instagram/paste", json={"address": "https://evil.test/connect/login_success.html?code=fb-code"})
        self.assertEqual(bad.status_code, 400)
        address = f"https://www.facebook.com/connect/login_success.html?code=fb-code&state={query['state'][0]}#_=_"
        ok = self.d.post(f"{P}/social/instagram/paste", json={"address": address})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["account"], "@space.kairos")
        exchange = next(e for e in MOCK.log if e["path"] == "/fb/oauth/access_token" and e["query"].get("code"))
        self.assertEqual(exchange["query"]["redirect_uri"], ["https://www.facebook.com/connect/login_success.html"])

    def test_disconnect_revokes_tiktok_and_forgets_tokens(self):
        self.connect_tiktok()
        r = self.d.delete(f"{P}/social/channels/{self.tt['id']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(MOCK.revoked, ["tt-access-1"])
        self.assertIsNone(social_auth.connection(self.tt["id"]))
        # A changed app key forgets the old app's connections.
        self.connect_tiktok()
        self.d.put(f"{P}/social/apps/tiktok", json={"key": "anotherkey999", "secret": TT_SECRET})
        self.assertIsNone(social_auth.connection(self.tt["id"]))

    def test_one_account_never_sees_or_uses_anothers(self):
        self.connect_tiktok()
        hers = self.b.get(f"{P}/social/status").json()
        self.assertEqual(hers["connections"], [])
        self.assertFalse(hers["apps"]["tiktok"]["configured"])
        # Her callback cannot finish his sign-in: the state belongs to his account and channel.
        self.tiktok_app(self.b)
        r = self.d.post(f"{P}/social/tiktok/connect", json={"channel_id": self.tt["id"]})
        state = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
        with accounts.as_account(self.bea_id):
            with self.assertRaises(StudioError) as caught:
                run(social_auth.finish("tiktok", state, "good-code"))
            self.assertEqual(caught.exception.status, 403)
        # Her attempt did not use up his sign-in: it still finishes for him.
        MOCK.challenge = parse_qs(urlsplit(r.json()["url"]).query)["code_challenge"][0]
        self.assertEqual(self.anon.get("/api/content-studio/social/callback/tiktok",
                                       params={"state": state, "code": "good-code"}).status_code, 200)
        self.assertEqual(self.b.delete(f"{P}/social/channels/{self.tt['id']}").status_code, 404)
        self.assertTrue(social_auth.connected(self.tt["id"], "tiktok"))


class TikTokPosting(Base):
    def setUp(self):
        super().setUp()
        self.connect_tiktok()
        self.post = self.approved(self.tt)

    def test_prepare_chooses_the_api_when_connected(self):
        prep = self.d.post(f"{P}/posts/{self.post['id']}/prepare").json()
        self.assertEqual(prep["route"], "api")
        self.assertEqual(prep["package"]["routes"], ["api", "browser"])
        self.assertIn("audit", prep["package"]["api_note"])
        # Disconnected, the upload page is the route again.
        social_auth.disconnect_local(self.tt["id"])
        prep = self.d.post(f"{P}/posts/{self.post['id']}/prepare").json()
        self.assertEqual(prep["package"]["routes"], ["browser"])

    def test_the_post_form_offers_only_you_while_unaudited_and_chooses_nothing(self):
        form = self.d.get(f"{P}/posts/{self.post['id']}/tiktok-post-form").json()
        self.assertEqual([o["value"] for o in form["privacy_options"]], ["SELF_ONLY"])
        self.assertIsNone(form["privacy_default"])
        self.assertEqual(form["creator"]["nickname"], "Space Kairos")
        self.assertTrue(form["interactions"]["duet"]["disabled"])
        self.assertFalse(any(i["on"] for i in form["interactions"].values()))
        self.assertIn("Music Usage Confirmation", form["consent"])
        self.assertEqual(form["blockers"], [])
        MOCK.options = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]
        form = self.d.get(f"{P}/posts/{self.post['id']}/tiktok-post-form").json()
        self.assertIn("private", form["blockers"][0])

    def test_unaudited_rules_are_kept_before_tiktok_is_called(self):
        url = f"{P}/posts/{self.post['id']}/publish-tiktok"
        self.assertIn("Music Usage", self.d.post(url, json={"privacy_level": "SELF_ONLY"}).json()["detail"])
        self.assertIn("Choose who can see it", self.d.post(url, json={"consent": True}).json()["detail"])
        r = self.d.post(url, json={"privacy_level": "FOLLOWER_OF_CREATOR", "consent": True})
        self.assertEqual(r.status_code, 409)
        self.assertIn("only allows Only you", r.json()["detail"])
        MOCK.options = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]
        r = self.d.post(url, json={"privacy_level": "SELF_ONLY", "consent": True})
        self.assertIn("account is public", r.json()["detail"])
        self.assertEqual(MOCK.init_bodies, [], "nothing was sent to TikTok")

    def test_a_private_post_waits_for_its_link_and_the_sync_finishes_it(self):
        r = self.d.post(f"{P}/posts/{self.post['id']}/publish-tiktok",
                        json={"privacy_level": "SELF_ONLY", "allow_comment": True, "consent": True})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["state"], "waiting")
        self.assertIn("Only you", out["note"])
        sent = MOCK.init_bodies[0]
        self.assertEqual(sent["post_info"]["privacy_level"], "SELF_ONLY")
        self.assertTrue(sent["post_info"]["is_aigc"], "TikTok's AI-generated label is always on")
        self.assertFalse(sent["post_info"]["brand_content_toggle"])
        self.assertFalse(sent["post_info"]["disable_comment"], "the person turned comments on")
        self.assertTrue(sent["post_info"]["disable_duet"] and sent["post_info"]["disable_stitch"])
        self.assertIn("Sunlight scatters off the air.", sent["post_info"]["title"])
        self.assertIn("#sky", sent["post_info"]["title"])
        self.assertEqual(bytes(MOCK.upload), self.video_bytes)
        self.assertEqual(sent["source_info"], {"source": "FILE_UPLOAD", "video_size": len(self.video_bytes),
                                               "chunk_size": len(self.video_bytes), "total_chunk_count": 1})
        board = self.d.get(f"{P}/publishing").json()
        item = next(i for i in board["items"] if i["post_id"] == self.post["id"])
        self.assertEqual(item["state"], "waiting_for_you")
        self.assertEqual(item["next"]["who"], "you")
        self.assertIn("Only you", item["next"]["what"])
        # The upload page is refused now: the post was sent through the API.
        prep = studio.preparation_for(self.post["id"])
        with self.assertRaises(StudioError):
            prepare.fill_plan(studio, prep["id"])
        evidence = studio.evidence(self.post["id"], "api_post")
        self.assertEqual(evidence[0]["body"]["privacy_level"], "SELF_ONLY")
        # The person makes it public in TikTok; the next sync gets the id and records the link.
        MOCK.later_status = {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": [7311111111111111111]}
        result = run(tiktok_api.sync(studio))
        self.assertEqual(result["posted_now"], 1)
        self.assertEqual(studio.get_post(self.post["id"])["posted_url"],
                         "https://www.tiktok.com/@space.kairos/video/7311111111111111111")
        self.assertIsNone(social_auth.published(self.post["id"]))

    def test_an_audited_public_post_is_posted_with_its_link(self):
        self.tiktok_app(audited=True)
        MOCK.options = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]
        MOCK.statuses = [{"status": "PROCESSING_UPLOAD"}, {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": [7300000000000000001]}]
        out = run(tiktok_api.publish(studio, self.post["id"], "david", "PUBLIC_TO_EVERYONE", consent=True))
        self.assertEqual(out["state"], "posted")
        self.assertEqual(out["url"], "https://www.tiktok.com/@space.kairos/video/7300000000000000001")
        self.assertEqual(studio.get_post(self.post["id"])["state"], "posted")

    def test_tiktoks_own_audit_refusal_turns_the_switch_off(self):
        self.tiktok_app(audited=True)
        MOCK.options = ["PUBLIC_TO_EVERYONE", "SELF_ONLY"]
        MOCK.init_error = (403, "unaudited_client_can_only_post_to_private_accounts")
        r = self.d.post(f"{P}/posts/{self.post['id']}/publish-tiktok", json={"privacy_level": "PUBLIC_TO_EVERYONE", "consent": True})
        self.assertEqual(r.status_code, 409)
        self.assertIn("not passed TikTok's audit", r.json()["detail"])
        self.assertFalse(social_auth.audited())
        self.assertEqual(studio.preparation_for(self.post["id"])["state"], "failed")

    def test_tiktok_limits_are_plain(self):
        MOCK.init_error = (403, "spam_risk_too_many_posts")
        r = self.d.post(f"{P}/posts/{self.post['id']}/publish-tiktok", json={"privacy_level": "SELF_ONLY", "consent": True})
        self.assertEqual(r.status_code, 429)
        self.assertIn("daily post limit", r.json()["detail"])

    def test_a_failed_post_says_tiktoks_reason(self):
        MOCK.statuses = [{"status": "FAILED", "fail_reason": "duration_check_failed"}]
        r = self.d.post(f"{P}/posts/{self.post['id']}/publish-tiktok", json={"privacy_level": "SELF_ONLY", "consent": True})
        self.assertEqual(r.status_code, 502)
        self.assertIn("duration_check_failed", r.json()["detail"])
        self.assertEqual(studio.preparation_for(self.post["id"])["state"], "failed")
        self.assertIsNone(social_auth.published(self.post["id"]))

    def test_chunks_follow_the_media_transfer_rules(self):
        self.assertEqual(tiktok_api.chunk_plan(1000), (1000, 1))
        mb = 1024 * 1024
        self.assertEqual(tiktok_api.chunk_plan(25 * mb + 7), (10 * mb, 2), "the last chunk takes the remainder")
        self.assertEqual(tiktok_api.chunk_plan(5 * mb), (5 * mb, 1))
        with patch.object(tiktok_api, "MIN_CHUNK", 100), patch.object(tiktok_api, "CHUNK", 256):
            big = bytes(range(256)) * 4 + b"tail-bytes"
            (self.renders / "9-16-v1.mp4").write_bytes(big)
            out = run(tiktok_api.publish(studio, self.post["id"], "david", "SELF_ONLY", consent=True))
        self.assertEqual(out["state"], "waiting")
        self.assertEqual(bytes(MOCK.upload), big)
        self.assertEqual(MOCK.upload_ranges, [(0, 255), (256, 511), (512, 767), (768, len(big) - 1)])

    def test_bots_cannot_post_to_tiktok(self):
        import core.bot_content_studio_tools  # noqa: F401 - registers the tools
        from core import tool_registry
        names = [n for n in tool_registry._REGISTRY if n.startswith("content_studio_")]
        self.assertIn("content_studio_publish_instagram", names)
        self.assertFalse([n for n in names if "tiktok" in n], "TikTok posting is the person's own press")
        self.assertEqual(tool_registry._REGISTRY["content_studio_publish_instagram"].agent_only, True)

    def test_scheduled_posts_wait_for_their_time(self):
        prepare.prepare(studio, self.post["id"], "david")
        prepare.schedule(studio, self.post["id"], time.time() + 3 * DAY)
        r = self.d.post(f"{P}/posts/{self.post['id']}/publish-tiktok", json={"privacy_level": "SELF_ONLY", "consent": True})
        self.assertEqual(r.status_code, 409)
        self.assertIn("no schedule", r.json()["detail"])


class InstagramPosting(Base):
    def setUp(self):
        super().setUp()
        self.connect_instagram()
        self.post = self.approved(self.ig)

    def test_a_reel_goes_through_container_upload_status_and_publish(self):
        r = self.d.post(f"{P}/posts/{self.post['id']}/publish-instagram")
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["state"], "posted")
        self.assertEqual(out["url"], "https://www.instagram.com/reel/DAbCdEfGhIj/")
        container = MOCK.containers[0]
        self.assertEqual((container["media_type"], container["upload_type"], container["share_to_feed"], container["is_ai_generated"]),
                         ("REELS", "resumable", "true", "true"))
        self.assertIn("#sky", container["caption"])
        self.assertEqual(MOCK.rupload[0]["size"], len(self.video_bytes))
        self.assertEqual(MOCK.published, ["cont1"])
        self.assertEqual(studio.get_post(self.post["id"])["posted_url"], "https://www.instagram.com/reel/DAbCdEfGhIj/")
        # The Page token travels in the Authorization header, never in an address.
        for e in MOCK.log:
            self.assertNotIn("access_token", e["query"])
        self.secrets_absent(r.text + "\n".join(self.logs))

    def test_the_ai_label_falls_back_honestly_when_meta_refuses_the_field(self):
        MOCK.refuse_ai_field = True
        out = run(instagram_api.publish(studio, self.post["id"], "david"))
        self.assertEqual(out["state"], "posted")
        self.assertFalse(out["ai_label_by_api"])
        self.assertIn("turn on the AI label", out["note"])

    def test_the_daily_limit_is_checked_first(self):
        MOCK.quota = {"quota_usage": 100, "config": {"quota_total": 100, "quota_duration": 86400}}
        r = self.d.post(f"{P}/posts/{self.post['id']}/publish-instagram")
        self.assertEqual(r.status_code, 429)
        self.assertEqual(MOCK.containers, [])
        self.assertEqual(studio.preparation_for(self.post["id"])["state"], "failed")

    def test_a_container_error_is_reported(self):
        MOCK.container_states = ["IN_PROGRESS", "ERROR"]
        r = self.d.post(f"{P}/posts/{self.post['id']}/publish-instagram")
        self.assertEqual(r.status_code, 502)
        self.assertIn("could not process", r.json()["detail"])
        self.assertEqual(MOCK.published, [])

    def test_meta_rate_limits_back_off_then_stop(self):
        calls = {"n": 0}
        original = instagram_api._limited

        def limited(response):
            calls["n"] += 1
            return True
        with patch.object(instagram_api, "_limited", limited):
            r = self.d.post(f"{P}/posts/{self.post['id']}/publish-instagram")
        self.assertEqual(r.status_code, 429)
        self.assertEqual(calls["n"], social_auth.ATTEMPTS)
        self.assertIs(instagram_api._limited, original)

    def test_the_publisher_bots_tool_posts_an_approved_reel(self):
        import core.bot_content_studio_tools as tools
        ctx = type("Ctx", (), {})()
        with patch.object(tools, "_data", lambda ctx, label, value: json.dumps(value)):
            out = run(tools._publish_instagram({"post_id": self.post["id"]}, ctx, {"name": "Publisher"}, "publisher"))
        self.assertIn("https://www.instagram.com/reel/DAbCdEfGhIj/", out)
        self.assertEqual(studio.evidence(self.post["id"], "api_post")[0]["body"]["by"], "Publisher")

    def test_an_unapproved_post_is_never_sent(self):
        draft = studio.create_post(self.ig["id"], "Not approved yet", script_ref="x")
        r = self.d.post(f"{P}/posts/{draft['id']}/publish-instagram")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(MOCK.containers, [])


class OfficialNumbers(Base):
    def posted(self, channel, url, days_ago=7):
        post = self.approved(channel, title=f"Post {url[-6:]}")
        studio.mark_posted(post["id"], url, posted_at=time.time() - days_ago * DAY)
        return studio.get_post(post["id"])

    def test_tiktok_numbers_are_official_snapshots(self):
        self.connect_tiktok()
        post = self.posted(self.tt, "https://www.tiktok.com/@space.kairos/video/7322222222222222222")
        MOCK.videos["7322222222222222222"] = {"id": "7322222222222222222", "view_count": 1500, "like_count": 120,
                                              "comment_count": 9, "share_count": 4, "duration": 31}
        MOCK.query_429 = 2
        result = run(social.sync(studio, "tiktok"))
        self.assertEqual(result["tiktok"]["stored"], 1, result)
        snap = studio.snapshots(post["id"])[-1]
        self.assertEqual((snap["source"], snap["views"], snap["likes"], snap["video_length_s"]), ("tiktok_api", 1500, 120, 31.0))
        self.assertTrue(scoring.official(snap))
        # Within the hour, a second sync adds nothing.
        self.assertEqual(run(social.sync(studio, "tiktok"))["tiktok"]["stored"], 0)

    def test_tiktok_rate_limit_spent_stops_the_sync(self):
        self.connect_tiktok()
        self.posted(self.tt, "https://www.tiktok.com/@space.kairos/video/7333333333333333333")
        MOCK.query_429 = 10
        result = run(tiktok_api.sync(studio))
        self.assertEqual(result["stopped"], "rate_limited")
        self.assertIn("rate limit", social_auth.connection(self.tt["id"])["last_error"])

    def test_instagram_insights_are_official_snapshots(self):
        self.connect_instagram()
        post = self.posted(self.ig, "https://www.instagram.com/reel/DXyZ123abcd/")
        MOCK.media_list = [{"id": "17955555555555555", "shortcode": "DXyZ123abcd", "media_product_type": "REELS"}]
        MOCK.insights["17955555555555555"] = {"views": 900, "likes": 80, "comments": 5, "shares": 7, "saved": 3,
                                              "ig_reels_avg_watch_time": 6400}
        result = run(instagram_api.sync(studio, length_of=lambda p: 31.0))
        self.assertEqual(result["stored"], 1, result)
        snap = studio.snapshots(post["id"])[-1]
        self.assertEqual((snap["source"], snap["views"], snap["avg_view_duration_s"], snap["shares"]), ("instagram_api", 900, 6.4, 7))

    def test_page_reads_are_only_the_fallback(self):
        self.connect_tiktok()
        studio.update_settings(page_reads={"tiktok": True, "instagram": True})
        self.posted(self.tt, "https://www.tiktok.com/@space.kairos/video/7344444444444444444")
        self.assertEqual(page_reads._due(studio, "tiktok", time.time()), [], "a connected channel is not page-read")
        social_auth.disconnect_local(self.tt["id"])
        self.assertEqual(len(page_reads._due(studio, "tiktok", time.time())), 1)

    def test_scoring_prefers_official_numbers(self):
        posted_at = 1_700_000_000.0
        mark = posted_at + 7 * DAY
        read = {"source": "page-read", "taken_at": mark, "views": 999, "avg_view_duration_s": 9.0, "video_length_s": 30}
        api = {"source": "tiktok_api", "taken_at": mark + 3600, "views": 1200, "avg_view_duration_s": 0.0, "video_length_s": 30}
        chosen = scoring.best_snapshot(posted_at, [read, api])
        self.assertEqual(chosen["views"], 1200, "official views win")
        self.assertEqual(chosen["avg_view_duration_s"], 9.0, "TikTok's API has no watch time; the page read's is kept")
        ig = {"source": "instagram_api", "taken_at": mark, "views": 50, "avg_view_duration_s": 4.0, "video_length_s": 30}
        self.assertEqual(scoring.best_snapshot(posted_at, [read, ig])["views"], 50)
        self.assertEqual(scoring.best_snapshot(posted_at, [read])["views"], 999, "page reads still count when nothing official")

    def test_the_daily_pass_runs_each_connected_account(self):
        self.connect_tiktok()
        social._passes.clear()
        self.assertTrue(social.due(studio))
        done = run(social.sync_all_due())
        self.assertIn(self.david_id, done)
        self.assertFalse(social.due(studio))
        with accounts.as_account(self.bea_id):
            self.assertFalse(social.due(studio), "bea connected nothing")


class RoutesAreGuarded(Base):
    def test_every_social_route_needs_a_session_except_the_callback(self):
        for method, path in (("GET", f"{P}/social/status"), ("PUT", f"{P}/social/apps/tiktok"),
                             ("POST", f"{P}/social/tiktok/connect"), ("POST", f"{P}/social/instagram/paste"),
                             ("DELETE", f"{P}/social/channels/1"), ("GET", f"{P}/posts/1/tiktok-post-form"),
                             ("POST", f"{P}/posts/1/publish-tiktok"), ("POST", f"{P}/posts/1/publish-instagram"),
                             ("POST", f"{P}/analytics/social/sync")):
            r = self.anon.request(method, path, json={} if method != "GET" else None)
            self.assertIn(r.status_code, (401, 403), f"{method} {path}")
        r = self.anon.get("/api/content-studio/social/callback/tiktok")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.anon.get("/api/content-studio/social/callback/youtube").status_code, 404)


def tearDownModule():
    SERVER.shutdown()
    SERVER.server_close()
    close_all()
    # Let the throwaway folder go: the app's own log handlers keep its log files open.
    for logger in [logging.getLogger()] + [logging.getLogger(n) for n in logging.root.manager.loggerDict]:
        for handler in list(getattr(logger, "handlers", [])):
            if isinstance(handler, logging.FileHandler):
                handler.close()
                logger.removeHandler(handler)


if __name__ == "__main__":
    unittest.main()

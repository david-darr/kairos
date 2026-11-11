"""Official TikTok and Instagram connections for Content Studio, through the person's own registered apps (build spec
"Content Studio Team", section 12; David 2026-11-10: official APIs first, Prepare post's fill-the-page and page reads
kept as fallbacks). The same own-project model as YouTube (youtube_publish.py): the person registers an app with each
platform, enters its keys in Kairos, and connects each channel by signing in to that platform in their own browser.

Per account, in data/accounts/<id>/content_studio/social.json:
- `apps`: one per platform. TikTok: the client key, the client secret (sealed), and whether TikTok has audited the app
  (the person says so; until then TikTok keeps every API post private, SELF_ONLY). Instagram (Meta): the app id, the app
  secret (sealed), the sign-in return (loopback on this computer, or paste the address from Meta's own success page) and
  an optional Facebook Login for Business configuration id.
- `connections`: one per Content Studio channel (channel id -> the platform account it signed in as, sealed tokens,
  expiry, scopes). A sign-in is only kept when the platform account is the channel's own handle.
- `published`: what the APIs were asked to post (post id -> publish or media id), so a later sync can finish a post
  TikTok was still processing and find each Instagram post's numbers.

Sealed with the account's own key (core/secret_storage.py, like core/voice_keys.py). No route returns a secret or a
token: callers see `has_secret`, `connected`, and the platform account's name. Nothing here writes a token to a log,
a note or an error message.

Sign-in: PKCE and a single-use, expiring state bound to the Kairos account and channel that started it. TikTok returns
to http://127.0.0.1:<port>/api/content-studio/social/callback/tiktok (TikTok's desktop rule: loopback, any port).
Meta returns to http://localhost:<port>/api/content-studio/social/callback/instagram, or, when the person chose
"paste", to https://www.facebook.com/connect/login_success.html, whose address they paste into Kairos.

The platform hosts are in HOSTS so a test can point every call at a local mock server; nothing real is called in tests.
"""
import asyncio
import hashlib
import logging
import os
import re
import secrets
import threading
import time
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from core import accounts
from core.atomic_io import read_json, write_json_atomic
from core.secret_storage import decrypt_for, encrypt_for

from .store import StudioError

PLATFORMS = ("tiktok", "instagram")
GRAPH_VERSION = "v27.0"     # Meta's examples on 2026-11-10 use v27.0
HOSTS = {
    "tiktok_auth": "https://www.tiktok.com/v2/auth/authorize/",
    "tiktok_api": "https://open.tiktokapis.com",
    "meta_dialog": f"https://www.facebook.com/{GRAPH_VERSION}/dialog/oauth",
    "graph": f"https://graph.facebook.com/{GRAPH_VERSION}",
    "rupload": f"https://rupload.facebook.com/ig-api-upload/{GRAPH_VERSION}",
}
# TikTok: Login Kit (desktop), Content Posting API (Direct Post), Display API (video.list).
TIKTOK_SCOPES = ("user.info.basic", "user.info.profile", "video.publish", "video.list")
# Instagram API with Facebook Login: the Reels publish (resumable upload from this computer needs this path), the
# insights, and the Pages the Instagram account is linked to.
INSTAGRAM_SCOPES = ("instagram_basic", "instagram_content_publish", "instagram_manage_insights", "pages_show_list",
                    "pages_read_engagement", "business_management")
CALLBACK = "/content-studio/social/callback/"     # under local_api_base(), which ends in /api
META_PASTE_REDIRECT = "https://www.facebook.com/connect/login_success.html"
PENDING_S = 600
REFRESH_EARLY_S = 300          # a TikTok access token (2 hours) is refreshed when this close to expiry
META_WARN_DAYS = 10            # a Meta user token (about 60 days) is renewed, or the person asked to reconnect, this close
ATTEMPTS = 4
BACKOFF_S = 1.0
TIMEOUT_S = 45

TIKTOK_AUDIT_NOTE = ("TikTok keeps every post from an app it has not audited private (only you can see it), and only lets "
                     "it post to a private account. Until your app passes TikTok's audit, use Open upload page for public "
                     "posts. When it passes, turn on \"My app passed TikTok's audit\".")
INSTAGRAM_NOTE = ("Instagram posts go out through your own Meta app with the Instagram API with Facebook Login: an "
                  "Instagram professional account (Business or Creator) linked to a Facebook Page you manage. While the "
                  "app is only used by people with a role on it, Meta's App Review is not needed.")

class _RedactQuery(logging.Filter):
    """httpx logs every request's address at INFO. Meta's documented code exchange is a GET with the app secret and the
    code in the address, so the values of secret-bearing query parameters are blanked in httpx's log lines (for every
    caller, which only ever removes secrets)."""
    PATTERN = re.compile(r"((?:client_secret|access_token|fb_exchange_token|code|refresh_token|code_verifier|token)=)[^&\s\"']+", re.I)

    def filter(self, record):
        try:
            text = record.getMessage()
        except Exception:  # noqa: BLE001 - a record that cannot be formatted is left alone
            return True
        clean = self.PATTERN.sub(r"\1***", text)
        if clean != text:
            record.msg, record.args = clean, ()
        return True


if not any(isinstance(f, _RedactQuery) for f in logging.getLogger("httpx").filters):
    logging.getLogger("httpx").addFilter(_RedactQuery())

_lock = threading.RLock()
_pending = {}            # state -> sign-in begun here
_refresh_locks = {}      # (account, channel id) -> asyncio.Lock
_sleep = asyncio.sleep   # a test replaces this so backoff costs no time


class SocialError(StudioError):
    pass


class Limited(SocialError):
    """The platform's rate or quota limit, after the backoff was spent."""


# -- the account's file -------------------------------------------------------------------------------------------

def _path():
    return os.path.join(accounts.account_dir(), "content_studio", "social.json")


def _load():
    data = read_json(_path(), {})
    if not isinstance(data, dict):
        data = {}
    for key in ("apps", "connections", "published"):
        if not isinstance(data.get(key), dict):
            data[key] = {}
    return data


def _save(data):
    os.makedirs(os.path.dirname(_path()), exist_ok=True)
    write_json_atomic(_path(), data)
    try:
        os.chmod(_path(), 0o600)
    except OSError:
        pass


def _seal(value):
    return encrypt_for(accounts.effective_account(), value) if value else None


def _open(value):
    if not value:
        return ""
    try:
        return decrypt_for(accounts.effective_account(), value)
    except Exception:  # noqa: BLE001 - a value sealed by another account or a broken file reads as none
        return ""


def _platform(platform):
    if platform not in PLATFORMS:
        raise SocialError("platform is tiktok or instagram")
    return platform


# -- the person's apps --------------------------------------------------------------------------------------------

_KEY = re.compile(r"^[A-Za-z0-9_.-]{4,128}$")
_SECRET = re.compile(r"^[\x21-\x7e]{8,256}$")


def _clean(value, what, pattern):
    text = "".join(str(value or "").split())
    if not pattern.match(text):
        raise SocialError(f"That does not look like {what}. Copy it again from the platform's developer site.")
    return text


def save_app(platform, key=None, secret=None, audited=None, redirect=None, config_id=None):
    """Saves (or updates) the person's own app for one platform. A changed key forgets the old app's connections, since
    their tokens belong to the old app."""
    _platform(platform)
    with _lock:
        data = _load()
        app = dict(data["apps"].get(platform) or {})
        if key is not None:
            key = _clean(key, "a TikTok client key" if platform == "tiktok" else "a Meta app ID", _KEY)
            if platform == "instagram" and not key.isdigit():
                raise SocialError("A Meta app ID is a number. Copy it from the app's Basic settings.")
            if app.get("key") and app["key"] != key:
                data["connections"] = {c: v for c, v in data["connections"].items() if v.get("platform") != platform}
                app.pop("secret", None)
            app["key"] = key
        if secret is not None:
            app["secret"] = _seal(_clean(secret, "an app secret", _SECRET))
        if audited is not None:
            if platform != "tiktok":
                raise SocialError("Only TikTok has an audit state.")
            app["audited"] = bool(audited)
        if redirect is not None:
            if platform != "instagram" or redirect not in ("loopback", "paste"):
                raise SocialError("Instagram's sign-in return is loopback or paste.")
            app["redirect"] = redirect
        if config_id is not None:
            if platform != "instagram":
                raise SocialError("Only Meta apps have a Facebook Login for Business configuration.")
            config_id = "".join(str(config_id).split())
            if config_id and not config_id.isdigit():
                raise SocialError("A Facebook Login for Business configuration ID is a number.")
            app["config_id"] = config_id
        if not app.get("key"):
            raise SocialError("Enter the app's key first." if platform == "tiktok" else "Enter the Meta app ID first.")
        app["saved_at"] = time.time()
        data["apps"][platform] = app
        _save(data)
    return status()


def remove_app(platform):
    """Forgets the app and every connection made with it. The grants themselves stay the person's to revoke on the
    platform (TikTok: Settings > Security > Apps; Facebook: Settings > Business integrations)."""
    _platform(platform)
    with _lock:
        data = _load()
        data["apps"].pop(platform, None)
        data["connections"] = {c: v for c, v in data["connections"].items() if v.get("platform") != platform}
        _save(data)
    return status()


def _app(platform):
    app = _load()["apps"].get(platform) or {}
    secret = _open(app.get("secret"))
    if not app.get("key") or not secret:
        name = "TikTok" if platform == "tiktok" else "Meta"
        raise SocialError(f"Enter your {name} app's key and secret in Kairos first.", 409)
    return app, secret


def audited():
    return bool((_load()["apps"].get("tiktok") or {}).get("audited"))


def mark_unaudited(reason=""):
    """TikTok said the app is not audited (unaudited_client_can_only_post_to_private_accounts): the switch goes off."""
    with _lock:
        data = _load()
        if data["apps"].get("tiktok"):
            data["apps"]["tiktok"]["audited"] = False
            data["apps"]["tiktok"]["audit_seen"] = {"at": time.time(), "reason": str(reason)[:200]}
            _save(data)


def redirect_uri(platform, api_base):
    """The address the platform sends the person back to after they sign in (what they register with the platform)."""
    if platform == "tiktok":
        return api_base + CALLBACK + "tiktok"
    if ((_load()["apps"].get("instagram") or {}).get("redirect") or "loopback") == "paste":
        return META_PASTE_REDIRECT
    return api_base.replace("http://127.0.0.1:", "http://localhost:", 1) + CALLBACK + "instagram"


def to_register(platform, api_base):
    """What the guide tells the person to enter as the app's redirect URI."""
    if platform == "tiktok":
        return re.sub(r":\d+/", ":*/", api_base, count=1) + CALLBACK + "tiktok"
    return redirect_uri(platform, api_base)


# -- status -------------------------------------------------------------------------------------------------------

def _public_connection(channel_id, conn, now):
    expires = conn.get("expires_at")
    renew_by = conn.get("refresh_expires_at") if conn.get("platform") == "tiktok" else conn.get("user_expires_at")
    return {"channel_id": int(channel_id), "platform": conn.get("platform"), "account": conn.get("account_name"),
            "connected": not conn.get("error"), "error": conn.get("error") or "", "scopes": conn.get("scopes") or [],
            "connected_at": conn.get("connected_at"), "expires_at": expires, "reconnect_by": renew_by,
            "reconnect_soon": bool(renew_by and renew_by - now < META_WARN_DAYS * 86400),
            "last_sync": conn.get("last_sync"), "last_result": conn.get("last_result"), "last_error": conn.get("last_error")}


def status(api_base=None):
    """The person's apps (never a secret), each channel's connection, and what to register with each platform."""
    now = time.time()
    data = _load()
    apps = {}
    for platform in PLATFORMS:
        app = data["apps"].get(platform) or {}
        row = {"configured": bool(app.get("key") and app.get("secret")), "key": app.get("key") or "",
               "has_secret": bool(app.get("secret")), "saved_at": app.get("saved_at"),
               "scopes": list(TIKTOK_SCOPES if platform == "tiktok" else INSTAGRAM_SCOPES)}
        if platform == "tiktok":
            row.update(audited=bool(app.get("audited")), audit_seen=app.get("audit_seen"), note=TIKTOK_AUDIT_NOTE)
        else:
            row.update(redirect=app.get("redirect") or "loopback", config_id=app.get("config_id") or "", note=INSTAGRAM_NOTE)
        if api_base:
            row["redirect_uri"] = to_register(platform, api_base)
        apps[platform] = row
    return {"apps": apps, "connections": [_public_connection(c, v, now) for c, v in sorted(data["connections"].items())]}


def connection(channel_id):
    """The public view of one channel's connection, or None."""
    conn = _load()["connections"].get(str(int(channel_id)))
    return _public_connection(channel_id, conn, time.time()) if conn else None


def connected(channel_id, platform=None):
    """True when the channel has a working connection (no error recorded), on `platform` when given."""
    conn = _load()["connections"].get(str(int(channel_id)))
    return bool(conn and not conn.get("error") and (platform is None or conn.get("platform") == platform)
                and conn.get("access_token"))


def disconnect_local(channel_id):
    with _lock:
        data = _load()
        gone = data["connections"].pop(str(int(channel_id)), None)
        _save(data)
    return gone


# -- HTTP, with backoff -------------------------------------------------------------------------------------------

def _transport_error(platform):
    name = "TikTok" if platform == "tiktok" else "Meta"
    return SocialError(f"{name} can't be reached right now. Try again when the connection is back.", 503)


async def send(platform, method, url, *, limited=None, attempts=ATTEMPTS, **kwargs):
    """One request with backoff: a 429 (or what `limited(response)` says is a rate limit) waits (Retry-After when sent,
    else 1, 2, 4 seconds) and tries again; when the attempts are spent it raises Limited. Never puts a URL, a token or a
    body in an error message."""
    timeout = kwargs.pop("timeout", TIMEOUT_S)
    for attempt in range(attempts):
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
                response = await client.request(method, url, **kwargs)
        except httpx.TransportError as exc:
            raise _transport_error(platform) from exc
        if response.status_code == 429 or (limited and limited(response)):
            if attempt == attempts - 1:
                raise Limited(("TikTok" if platform == "tiktok" else "Instagram") + "'s rate limit was reached. Try again later.", 429)
            try:
                wait = float(response.headers.get("retry-after") or 0)
            except ValueError:
                wait = 0
            await _sleep(min(wait, 60) if wait else BACKOFF_S * 2 ** attempt)
            continue
        return response
    raise Limited("rate limited", 429)  # not reached


def body(response):
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


# -- sign-in ------------------------------------------------------------------------------------------------------

def start(platform, channel, api_base, user):
    """The sign-in page for one channel: the platform's consent page for the person's own app. Open it in the browser."""
    _platform(platform)
    if channel["platform"] != platform:
        raise SocialError(f"That channel is on {channel['platform']}, not {platform}.", 409)
    if channel["status"] != "live":
        raise SocialError("That channel is archived.", 409)
    app, _ = _app(platform)
    redirect = redirect_uri(platform, api_base)
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)[:96]          # 43 to 128 characters, both platforms' rule
    with _lock:
        for stale, item in list(_pending.items()):
            if item["expires"] < time.time():
                _pending.pop(stale, None)
        _pending[state] = {"platform": platform, "channel_id": channel["id"], "handle": channel["handle"],
                           "verifier": verifier, "redirect": redirect, "expires": time.time() + PENDING_S,
                           "kairos_account": accounts.effective_account(), "user": user, "key": app["key"]}
    if platform == "tiktok":
        # TikTok's desktop PKCE: the challenge is the hex SHA-256 of the verifier (not base64url), method S256.
        challenge = hashlib.sha256(verifier.encode("ascii")).hexdigest()
        params = {"client_key": app["key"], "response_type": "code", "scope": ",".join(TIKTOK_SCOPES),
                  "redirect_uri": redirect, "state": state, "code_challenge": challenge, "code_challenge_method": "S256"}
        return HOSTS["tiktok_auth"] + "?" + urlencode(params)
    params = {"client_id": app["key"], "redirect_uri": redirect, "state": state, "response_type": "code"}
    if app.get("config_id"):
        params["config_id"] = app["config_id"]      # Facebook Login for Business: the configuration holds the permissions
    else:
        params["scope"] = ",".join(INSTAGRAM_SCOPES)
    return HOSTS["meta_dialog"] + "?" + urlencode(params)


def pending_account(state):
    """The Kairos account that started a sign-in, for the callback, which nobody is signed in to."""
    return (_pending.get(state or "") or {}).get("kairos_account")


def from_pasted(address):
    """(state, code, error) from the address Meta's success page showed (the paste route)."""
    try:
        parts = urlsplit((address or "").strip())
    except ValueError:
        parts = None
    if not parts or parts.scheme != "https" or (parts.hostname or "").lower() not in ("www.facebook.com", "facebook.com", "m.facebook.com") \
            or not parts.path.startswith("/connect/login_success.html"):
        raise SocialError("Paste the whole address of Facebook's \"Success\" page (it starts with "
                          "https://www.facebook.com/connect/login_success.html).")
    query = parse_qs(parts.query) or parse_qs(parts.fragment)
    first = lambda k: (query.get(k) or [None])[0]
    return first("state") or "", first("code"), first("error") or first("error_reason")


def _handle(value):
    return (value or "").strip().lstrip("@").lower()


async def finish(platform, state, code, error=None, now=None):
    """Completes a sign-in begun here: trades the code for tokens, checks the platform account is the channel's own,
    and keeps the connection sealed. Returns the platform account's name."""
    now = time.time() if now is None else now
    with _lock:
        pending = _pending.get(state or "")
        if pending and pending["kairos_account"] != accounts.effective_account():
            # Another account's attempt never uses up (or finishes) this account's sign-in.
            raise SocialError("This sign-in was started by another Kairos account.", 403)
        _pending.pop(state or "", None)
    if not pending or pending["expires"] < time.time() or pending["platform"] != platform:
        raise SocialError("This sign-in expired or was not started here. Connect again from Kairos.")
    if error or not code:
        raise SocialError("The sign-in was cancelled or permission was refused.")
    app, secret = _app(platform)
    if app["key"] != pending["key"]:
        raise SocialError("The app's key changed during sign-in. Connect again.", 409)
    if platform == "tiktok":
        record = await _finish_tiktok(app, secret, pending, code, now)
    else:
        record = await _finish_instagram(app, secret, pending, code, now)
    with _lock:
        data = _load()
        data["connections"][str(pending["channel_id"])] = {**record, "platform": platform, "connected_at": now}
        _save(data)
    return record["account_name"]


async def _finish_tiktok(app, secret, pending, code, now):
    from . import tiktok_api
    response = await send("tiktok", "POST", HOSTS["tiktok_api"] + "/v2/oauth/token/",
                          data={"client_key": app["key"], "client_secret": secret, "code": code,
                                "grant_type": "authorization_code", "redirect_uri": pending["redirect"],
                                "code_verifier": pending["verifier"]},
                          headers={"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"})
    tokens = body(response)
    if response.status_code >= 400 or not tokens.get("access_token") or tokens.get("error"):
        raise SocialError("TikTok refused the sign-in code. Check the app's key, secret and redirect URI, then connect again.", 502)
    scopes = [s for s in re.split(r"[,\s]+", str(tokens.get("scope") or "")) if s]
    missing = [s for s in ("video.publish", "video.list") if s not in scopes]
    record = {"access_token": _seal(tokens["access_token"]), "refresh_token": _seal(tokens.get("refresh_token") or ""),
              "expires_at": now + int(tokens.get("expires_in") or 7200),
              "refresh_expires_at": now + int(tokens.get("refresh_expires_in") or 180 * 86400),
              "open_id": tokens.get("open_id") or "", "scopes": scopes}
    access = tokens["access_token"]
    name = await tiktok_api.username(access)
    if not name:
        raise SocialError("TikTok did not say which account signed in (allow the profile permission), so Kairos cannot "
                          "check it is this channel. Connect again.", 409)
    if _handle(name) != _handle(pending["handle"]):
        await tiktok_api.revoke(app, secret, access)
        raise SocialError(f"You signed in to TikTok as @{name}, but this channel is {pending['handle']}. Sign in with the "
                          "channel's own account. Nothing was kept.", 409)
    record["account_name"] = "@" + _handle(name)
    if missing:
        record["missing_scopes"] = missing
    return record


async def _finish_instagram(app, secret, pending, code, now):
    # The code for a short token, then the long-lived user token (about 60 days), then the Page token of the Page the
    # channel's Instagram account is linked to (a Page token from a long-lived user token has no fixed expiry).
    response = await send("instagram", "GET", HOSTS["graph"] + "/oauth/access_token",
                          params={"client_id": app["key"], "redirect_uri": pending["redirect"], "client_secret": secret,
                                  "code": code})
    short = body(response).get("access_token")
    if response.status_code >= 400 or not short:
        raise SocialError("Meta refused the sign-in code. Check the app ID, secret and redirect URI, then connect again.", 502)
    response = await send("instagram", "GET", HOSTS["graph"] + "/oauth/access_token",
                          params={"grant_type": "fb_exchange_token", "client_id": app["key"], "client_secret": secret,
                                  "fb_exchange_token": short})
    long_lived = body(response)
    user_token = long_lived.get("access_token") or short
    user_expires = now + int(long_lived.get("expires_in") or 60 * 86400)
    response = await send("instagram", "GET", HOSTS["graph"] + "/me/accounts",
                          params={"fields": "id,name,access_token,instagram_business_account{id,username}", "limit": 100},
                          headers={"Authorization": f"Bearer {user_token}"})
    pages = body(response).get("data") or []
    if response.status_code >= 400:
        raise SocialError("Meta would not list the Facebook Pages for this sign-in. Allow Pages access and connect again.", 502)
    linked = [(p, p.get("instagram_business_account") or {}) for p in pages if (p.get("instagram_business_account") or {}).get("id")]
    match = next(((p, ig) for p, ig in linked if _handle(ig.get("username")) == _handle(pending["handle"])), None)
    if match is None:
        found = ", ".join("@" + _handle(ig.get("username")) for _, ig in linked if ig.get("username")) or "none"
        raise SocialError(f"None of the Instagram accounts linked to your Facebook Pages is {pending['handle']} (found: {found}). "
                          "Switch the Instagram account to Business or Creator, link it to a Facebook Page you manage, and "
                          "choose that Page when you sign in. Nothing was kept.", 409)
    page, ig = match
    if not page.get("access_token"):
        raise SocialError("Meta did not give a Page token for the linked Page; you need a task on that Page.", 409)
    return {"access_token": _seal(page["access_token"]), "user_token": _seal(user_token), "user_expires_at": user_expires,
            "expires_at": None, "page_id": page.get("id"), "ig_user_id": ig["id"], "account_name": "@" + _handle(ig.get("username")),
            "scopes": list(INSTAGRAM_SCOPES if not app.get("config_id") else ())}


# -- tokens -------------------------------------------------------------------------------------------------------

def _conn(channel_id, platform):
    conn = _load()["connections"].get(str(int(channel_id)))
    if not conn or conn.get("platform") != platform or not conn.get("access_token"):
        name = "TikTok" if platform == "tiktok" else "Instagram"
        raise SocialError(f"Connect this channel to {name} first.", 409)
    if conn.get("error"):
        raise SocialError(conn["error"], 409)
    return conn


def _mark(channel_id, **fields):
    with _lock:
        data = _load()
        conn = data["connections"].get(str(int(channel_id)))
        if conn is None:
            return
        for key, value in fields.items():
            if value is None:
                conn.pop(key, None)
            else:
                conn[key] = value
        _save(data)


def mark_error(channel_id, text):
    _mark(channel_id, error=text)


def record(channel_id):
    """The stored connection with ids (open_id, ig_user_id, page_id) but no unsealed token."""
    conn = _load()["connections"].get(str(int(channel_id))) or {}
    return {k: v for k, v in conn.items() if k not in ("access_token", "refresh_token", "user_token")}


async def token(channel_id, platform, force=False):
    """A working access token for the channel, refreshed when it is about to expire (TikTok rotates the refresh token
    each time: the new one is kept). Raises SocialError when the person must connect again."""
    key = (accounts.effective_account(), int(channel_id))
    async with _refresh_locks.setdefault(key, asyncio.Lock()):
        conn = _conn(channel_id, platform)
        if platform == "instagram":
            return await _meta_token(channel_id, conn)
        if not force and (conn.get("expires_at") or 0) > time.time() + REFRESH_EARLY_S:
            return _open(conn["access_token"])
        app, secret = _app("tiktok")
        refresh = _open(conn.get("refresh_token"))
        if not refresh or (conn.get("refresh_expires_at") or 0) < time.time():
            mark_error(channel_id, "TikTok's sign-in for this channel expired. Connect it again.")
            raise SocialError("TikTok's sign-in for this channel expired. Connect it again.", 409)
        response = await send("tiktok", "POST", HOSTS["tiktok_api"] + "/v2/oauth/token/",
                              data={"client_key": app["key"], "client_secret": secret, "grant_type": "refresh_token",
                                    "refresh_token": refresh},
                              headers={"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"})
        tokens = body(response)
        if response.status_code >= 400 or not tokens.get("access_token") or tokens.get("error"):
            mark_error(channel_id, "TikTok refused to renew this channel's sign-in (revoked or expired). Connect it again.")
            raise SocialError("TikTok refused to renew this channel's sign-in. Connect it again.", 409)
        now = time.time()
        _mark(channel_id, access_token=_seal(tokens["access_token"]),
              refresh_token=_seal(tokens.get("refresh_token") or refresh),
              expires_at=now + int(tokens.get("expires_in") or 7200),
              refresh_expires_at=now + int(tokens.get("refresh_expires_in") or 180 * 86400), error=None)
        return tokens["access_token"]


async def _meta_token(channel_id, conn):
    """The Page token. When the long-lived user token is near its 60 days, it is exchanged again while it still works
    (Meta does not document a refresh for it; if the exchange gives nothing new, the person is asked to reconnect)."""
    left = (conn.get("user_expires_at") or 0) - time.time()
    if left < META_WARN_DAYS * 86400 and conn.get("user_token"):
        try:
            app, secret = _app("instagram")
            response = await send("instagram", "GET", HOSTS["graph"] + "/oauth/access_token",
                                  params={"grant_type": "fb_exchange_token", "client_id": app["key"], "client_secret": secret,
                                          "fb_exchange_token": _open(conn["user_token"])}, attempts=1)
            fresh = body(response)
            if response.status_code < 400 and fresh.get("access_token") and fresh.get("expires_in"):
                _mark(channel_id, user_token=_seal(fresh["access_token"]), user_expires_at=time.time() + int(fresh["expires_in"]))
        except SocialError:
            pass          # the Page token still works; the status shows "reconnect soon"
    return _open(conn["access_token"])


async def disconnect(channel_id):
    """Stops Kairos using the channel's connection and forgets its tokens. TikTok's grant is also revoked (best effort);
    Meta's stays the person's to remove in Facebook's Business integrations settings."""
    conn = _load()["connections"].get(str(int(channel_id)))
    if conn and conn.get("platform") == "tiktok":
        try:
            app, secret = _app("tiktok")
            from . import tiktok_api
            await tiktok_api.revoke(app, secret, _open(conn.get("access_token")))
        except SocialError:
            pass
    disconnect_local(channel_id)
    return status()


# -- what the APIs were asked to post -----------------------------------------------------------------------------

def remember_publish(post_id, **fields):
    with _lock:
        data = _load()
        data["published"][str(int(post_id))] = {**(data["published"].get(str(int(post_id))) or {}), **fields}
        _save(data)


def published(post_id=None):
    items = _load()["published"]
    return items.get(str(int(post_id))) if post_id is not None else items


def forget_publish(post_id):
    with _lock:
        data = _load()
        data["published"].pop(str(int(post_id)), None)
        _save(data)


def update_sync(channel_id, **fields):
    _mark(channel_id, **fields)

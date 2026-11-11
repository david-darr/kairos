"""TikTok through the person's own registered app: Direct Post (Content Posting API) and the numbers of their own videos
(Display API, video.list). Docs read 2026-11-10 (developers.tiktok.com: Direct Post reference and creator info, updated
2026-10-27; media transfer guide, content sharing guidelines, status fetch, video query, rate limits, updated 2026-08;
token management, updated 2026-11-05).

Posting follows TikTok's own rules for apps that post for a creator:
- The person posts, never a bot: TikTok asks that the creator picks who can see the post from the options its creator
  info gives (no default), turns comments, Duet and Stitch on themselves (off by default), sees the creator's name, and
  agrees to TikTok's Music Usage Confirmation before anything is sent. The routes take those choices from the person's
  own press in Studio; the Publisher bot has no TikTok posting tool.
- An app TikTok has not audited can only post SELF_ONLY (only the creator sees it), and only to an account set to
  private. Kairos refuses anything else before calling TikTok and says why; the person's switch "My app passed TikTok's
  audit" lifts Kairos's own check, and TikTok's own refusal turns it back off.
- Every post carries TikTok's AI-generated label (is_aigc), the approved caption, and is marked as neither branded nor
  promoting the creator's business (the team's posts are neither). TikTok's API has no schedule: a scheduled post waits.
- The file goes up in chunks (5 to 64 MB each, the last up to 128 MB; under 5 MB in one piece), then Kairos asks for
  the status. A public post that passes moderation gets its id and link; a private one never has a link from TikTok, so
  the post waits for the person to make it public (Kairos checks again at each sync) or paste the link.

Numbers: /v2/video/query/ with the post's video id (20 a call): views, likes, comments, shares and the length. TikTok's
Display API has no watch time and no follows, so those stay 0 on these official snapshots (source "tiktok_api"); the
scoring keeps a page-read watch time next to them when there is one.
"""
import asyncio
import os
import re
import time
from urllib.parse import urlsplit

from core import accounts

from . import platforms, social_auth
from .social_auth import SocialError, body, send

SOURCE = "tiktok_api"
PRIVACY = ("PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY")
PRIVACY_NAMES = {"PUBLIC_TO_EVERYONE": "Everyone", "MUTUAL_FOLLOW_FRIENDS": "Friends", "FOLLOWER_OF_CREATOR": "Followers",
                 "SELF_ONLY": "Only you"}
CONSENT = "By posting, you agree to TikTok's Music Usage Confirmation."
MIN_CHUNK = 5 * 1024 * 1024
CHUNK = 10 * 1024 * 1024
MAX_BYTES = 4 * 1024 * 1024 * 1024
POLL_S = 5
POLL_TRIES = 36                 # three minutes; a post still processing then is checked again at each sync
QUERY_BATCH = 20
MAX_POST_AGE_DAYS = 60
MIN_GAP_S = 3600
TYPES = {"mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm"}

_sending = set()
_locks = {}


class TikTokError(SocialError):
    def __init__(self, detail, status=400, code=""):
        super().__init__(detail, status)
        self.code = code


def _host():
    return social_auth.HOSTS["tiktok_api"]


def _error(data):
    err = data.get("error") if isinstance(data.get("error"), dict) else {}
    return str(err.get("code") or ""), str(err.get("message") or "")[:200]


async def username(access):
    """The signed-in account's username (user.info.profile), or '' when TikTok does not say."""
    response = await send("tiktok", "GET", _host() + "/v2/user/info/", params={"fields": "open_id,display_name,username"},
                          headers={"Authorization": f"Bearer {access}"})
    data = body(response)
    code, _ = _error(data)
    if response.status_code >= 400 or (code and code != "ok"):
        return ""
    return str(((data.get("data") or {}).get("user") or {}).get("username") or "")


async def revoke(app, secret, access):
    if not access:
        return
    try:
        await send("tiktok", "POST", _host() + "/v2/oauth/revoke/", attempts=1,
                   data={"client_key": app["key"], "client_secret": secret, "token": access},
                   headers={"Content-Type": "application/x-www-form-urlencoded"})
    except SocialError:
        pass


PLAIN = {
    "spam_risk_too_many_posts": ("TikTok's daily post limit for this account is reached. Try again tomorrow.", 429),
    "spam_risk_user_banned_from_posting": ("TikTok has stopped this account from posting. Check the account in the TikTok app.", 409),
    "reached_active_user_cap": ("Your TikTok app reached its daily limit of accounts that can post. Try again tomorrow.", 429),
    "unaudited_client_can_only_post_to_private_accounts": (
        "TikTok refused: your app has not passed TikTok's audit, so it can only post to a private account, and only "
        "privately. Set the TikTok account to private, post as Only you, or use Open upload page.", 409),
    "privacy_level_option_mismatch": ("TikTok does not offer that choice of who can see it for this account now. Choose again.", 409),
    "scope_not_authorized": ("This channel's TikTok sign-in does not allow posting. Connect it again and allow posting.", 409),
    "url_ownership_unverified": ("TikTok refused the video source.", 409),
    "rate_limit_exceeded": ("TikTok's rate limit was reached. Try again in a minute.", 429),
}


async def _api(channel_id, method, path, *, json=None, params=None):
    """One call with the channel's token. An invalid token is refreshed once; TikTok's error codes become plain words."""
    for attempt in range(2):
        access = await social_auth.token(channel_id, "tiktok", force=bool(attempt))
        response = await send("tiktok", method, _host() + path, json=json, params=params,
                              headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json; charset=UTF-8"})
        data = body(response)
        code, message = _error(data)
        if response.status_code == 401 and code == "access_token_invalid" and attempt == 0:
            continue
        if response.status_code < 400 and code in ("", "ok"):
            return data.get("data") or {}
        if code == "unaudited_client_can_only_post_to_private_accounts":
            social_auth.mark_unaudited(code)
        if code == "access_token_invalid":
            social_auth.mark_error(channel_id, "TikTok no longer accepts this channel's sign-in. Connect it again.")
            raise TikTokError("TikTok no longer accepts this channel's sign-in. Connect it again.", 409, code)
        text, status = PLAIN.get(code, (f"TikTok refused: {message or code or response.status_code}.", 502 if response.status_code >= 500 else 409))
        raise TikTokError(text, status, code)
    raise TikTokError("TikTok no longer accepts this channel's sign-in. Connect it again.", 409, "access_token_invalid")


async def creator_info(channel_id):
    data = await _api(channel_id, "POST", "/v2/post/publish/creator_info/query/", json={})
    return {"nickname": str(data.get("creator_nickname") or ""), "username": str(data.get("creator_username") or ""),
            "avatar_url": str(data.get("creator_avatar_url") or ""),
            "privacy_level_options": [p for p in (data.get("privacy_level_options") or []) if p in PRIVACY],
            "comment_disabled": bool(data.get("comment_disabled")), "duet_disabled": bool(data.get("duet_disabled")),
            "stitch_disabled": bool(data.get("stitch_disabled")),
            "max_video_post_duration_sec": int(data.get("max_video_post_duration_sec") or 0)}


def chunk_plan(size):
    """(chunk size, chunk count) by TikTok's media transfer rules: under 5 MB one chunk of the whole file; else 10 MB
    chunks, the count rounded down, the last chunk taking the remainder (under 128 MB)."""
    if size <= 0:
        raise SocialError("The video file is empty.", 409)
    if size > MAX_BYTES:
        raise SocialError("TikTok takes videos up to 4 GB.", 413)
    if size < MIN_CHUNK:
        return size, 1
    chunk = min(CHUNK, size)
    return chunk, max(1, size // chunk)


def _ranges(size, chunk, count):
    for index in range(count):
        first = index * chunk
        last = size - 1 if index == count - 1 else first + chunk - 1
        yield first, last


def _upload_url_ok(url):
    parts = urlsplit(url or "")
    host = (parts.hostname or "").lower()
    own = urlsplit(_host())
    if (parts.scheme, host, parts.port) == (own.scheme, (own.hostname or "").lower(), own.port):
        return True    # the API host itself (a test's mock server)
    return parts.scheme == "https" and any(host == h or host.endswith("." + h) for h in ("tiktokapis.com", "tiktok.com", "tiktokcdn.com"))


async def _upload(url, path, size, chunk, count, kind):
    if not _upload_url_ok(url):
        raise TikTokError("TikTok answered with an upload address that is not TikTok's; nothing was sent.", 502)
    with open(path, "rb") as handle:
        for index, (first, last) in enumerate(_ranges(size, chunk, count)):
            handle.seek(first)
            piece = handle.read(last - first + 1)
            response = await send("tiktok", "PUT", url, content=piece, timeout=600,
                                  headers={"Content-Type": kind, "Content-Length": str(len(piece)),
                                           "Content-Range": f"bytes {first}-{last}/{size}"})
            final = index == count - 1
            if response.status_code not in ((201, 200) if final else (206,)):
                raise TikTokError(f"TikTok stopped the upload (part {index + 1} of {count}, answer {response.status_code}). "
                                  "Try again.", 502)


async def fetch_status(channel_id, publish_id):
    data = await _api(channel_id, "POST", "/v2/post/publish/status/fetch/", json={"publish_id": publish_id})
    ids = [str(i) for i in (data.get("publicaly_available_post_id") or data.get("publicly_available_post_id") or []) if i]
    return {"status": str(data.get("status") or ""), "fail_reason": str(data.get("fail_reason") or ""), "post_ids": ids}


async def _poll(channel_id, publish_id, tries=POLL_TRIES):
    last = {"status": "", "fail_reason": "", "post_ids": []}
    for attempt in range(tries):
        if attempt:
            await social_auth._sleep(POLL_S)
        last = await fetch_status(channel_id, publish_id)
        if last["status"] == "FAILED" or (last["status"] == "PUBLISH_COMPLETE" and last["post_ids"]):
            break
        if last["status"] == "PUBLISH_COMPLETE" and attempt >= 2:
            break   # complete without an id: private, or still in moderation; the sync checks again
    return last


def video_url(handle, post_id):
    return f"https://www.tiktok.com/@{platforms.plain_handle(handle)}/video/{post_id}"


async def post_form(store, post_id):
    """What the person sees before posting to TikTok: the creator's name, the choices TikTok offers (narrowed to Only
    you while the app is unaudited), which interactions the account has turned off, the length limit and the consent
    line. Nothing is chosen for them."""
    from . import social
    post, channel, prep, path, package = social.package_for(store, post_id, "", "tiktok", allow_schedule=True)
    info = await creator_info(channel["id"])
    is_audited = social_auth.audited()
    options = info["privacy_level_options"] if is_audited else [p for p in info["privacy_level_options"] if p == "SELF_ONLY"]
    seconds = (package.get("file") or {}).get("seconds")
    blockers = []
    if not is_audited and "PUBLIC_TO_EVERYONE" in info["privacy_level_options"]:
        blockers.append("This TikTok account is public. TikTok lets an unaudited app post only to a private account: set "
                        "the account to private in TikTok first, or use Open upload page.")
    if info["max_video_post_duration_sec"] and seconds and seconds > info["max_video_post_duration_sec"]:
        blockers.append(f"TikTok lets this account post videos up to {info['max_video_post_duration_sec']} seconds; this one "
                        f"is {round(seconds)}.")
    if prep.get("scheduled_at") and prep["scheduled_at"] > time.time() + 60:
        blockers.append("TikTok's API posts at once and has no schedule. Post it at the planned time, or clear the schedule.")
    return {"post_id": post["id"], "channel": channel["handle"], "creator": {k: info[k] for k in ("nickname", "username", "avatar_url")},
            "privacy_options": [{"value": p, "name": PRIVACY_NAMES[p]} for p in options],
            "privacy_default": None, "interactions": {"comment": {"disabled": info["comment_disabled"], "on": False},
                                                      "duet": {"disabled": info["duet_disabled"], "on": False},
                                                      "stitch": {"disabled": info["stitch_disabled"], "on": False}},
            "caption": package["text"].get("caption") or "", "file": package["file"], "ai_label": True,
            "max_video_post_duration_sec": info["max_video_post_duration_sec"], "audited": is_audited,
            "audit_note": "" if is_audited else social_auth.TIKTOK_AUDIT_NOTE, "consent": CONSENT,
            "processing_note": "TikTok takes a few minutes to process a post before it shows on the profile.",
            "blockers": blockers}


async def publish(store, post_id, by, privacy_level=None, allow_comment=False, allow_duet=False, allow_stitch=False,
                  consent=False, now=None):
    """Posts one approved post to its TikTok channel with the person's own choices. Returns what TikTok did."""
    from . import prepare, social
    if not consent:
        raise SocialError("Agree to TikTok's Music Usage Confirmation first (it is shown next to Post).", 409)
    if privacy_level not in PRIVACY:
        raise SocialError("Choose who can see it. TikTok asks that you pick it yourself each time.", 409)
    account = accounts.effective_account()
    key = (account, int(post_id))
    if key in _sending:
        raise SocialError("That post is already being sent to TikTok.", 409)
    _sending.add(key)
    try:
        async with _locks.setdefault(account, asyncio.Lock()):
            post, channel, prep, path, package = social.package_for(store, post_id, by, "tiktok")
            if social_auth.published(post_id):
                raise SocialError("This post was already sent to TikTok. Check TikTok before trying again.", 409)
            info = await creator_info(channel["id"])
            if privacy_level not in info["privacy_level_options"]:
                raise SocialError("TikTok does not offer that choice of who can see it for this account now. Choose again.", 409)
            if not social_auth.audited():
                if privacy_level != "SELF_ONLY":
                    raise SocialError("Your TikTok app has not passed TikTok's audit, so TikTok only allows Only you. Post "
                                      "it as Only you, or use Open upload page to post it publicly.", 409)
                if "PUBLIC_TO_EVERYONE" in info["privacy_level_options"]:
                    raise SocialError("This TikTok account is public, and TikTok lets an unaudited app post only to a private "
                                      "account. Set the account to private in TikTok, or use Open upload page.", 409)
            seconds = (package.get("file") or {}).get("seconds")
            if info["max_video_post_duration_sec"] and seconds and seconds > info["max_video_post_duration_sec"]:
                raise SocialError(f"TikTok lets this account post up to {info['max_video_post_duration_sec']} seconds.", 409)
            size = os.path.getsize(path)
            chunk, count = chunk_plan(size)
            choices = {"privacy_level": privacy_level,
                       "disable_comment": info["comment_disabled"] or not allow_comment,
                       "disable_duet": info["duet_disabled"] or not allow_duet,
                       "disable_stitch": info["stitch_disabled"] or not allow_stitch}
            request = {"post_info": {"title": package["text"].get("caption") or "", **choices,
                                     "brand_content_toggle": False, "brand_organic_toggle": False, "is_aigc": True},
                       "source_info": {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk,
                                       "total_chunk_count": count}}
            try:
                started = await _api(channel["id"], "POST", "/v2/post/publish/video/init/", json=request)
                publish_id = str(started.get("publish_id") or "")
                if not publish_id or not started.get("upload_url"):
                    raise TikTokError("TikTok answered without an upload address. Try again.", 502)
                await _upload(started["upload_url"], path, size, chunk, count,
                              TYPES.get(path.rsplit(".", 1)[-1].lower(), "video/mp4"))
            except SocialError as exc:
                prepare.record_failure(store, post_id, exc.detail, now=now)
                raise
            at = time.time() if now is None else now
            social_auth.remember_publish(post_id, platform="tiktok", publish_id=publish_id, at=at, privacy=privacy_level,
                                         channel_id=channel["id"])
            store.add_evidence(post_id, "api_post", {"platform": "tiktok", "by": by, "publish_id": publish_id, "consent": CONSENT,
                                                     "ai_label": True, "audited": social_auth.audited(), **choices})
            state = await _poll(channel["id"], publish_id)
            return settle(store, post_id, channel, state, privacy_level, now=now)
    finally:
        _sending.discard(key)


def settle(store, post_id, channel, state, privacy_level=None, now=None):
    """Records what TikTok did with a sent post: posted with its link, failed with TikTok's reason, or waiting (still
    processing, or private, which TikTok gives no link for)."""
    from . import prepare
    privacy_level = privacy_level or (social_auth.published(post_id) or {}).get("privacy")
    if state["status"] == "PUBLISH_COMPLETE" and state["post_ids"]:
        url = video_url(channel["handle"], state["post_ids"][0])
        posted = store.mark_posted(post_id, url, now=now)
        social_auth.forget_publish(post_id)
        return {"state": "posted", "post": posted, "url": url, "privacy": privacy_level, "note": ""}
    if state["status"] == "FAILED":
        reason = state["fail_reason"] or "no reason given"
        social_auth.forget_publish(post_id)
        prepare.record_failure(store, post_id, f"TikTok could not post it: {reason}.", now=now)
        raise TikTokError(f"TikTok could not post it: {reason}. Fix it and try again, or use Open upload page.", 502, reason)
    private = privacy_level == "SELF_ONLY"
    note = ("TikTok posted it as Only you. TikTok gives no link for a private post: when you make it public in the TikTok "
            "app, Kairos finds the link at its next sync, or paste the link with Mark posted."
            if private and state["status"] == "PUBLISH_COMPLETE" else
            "TikTok is still processing it (moderation can take a few hours). Kairos checks again at each sync and records "
            "the link when TikTok gives one.")
    prep = store.preparation_for(post_id)
    if prep:
        store.update_preparation(prep["id"], state="waiting_for_you", route="api", error="",
                                 fill={"stage": "api_pending", "filled": [], "missing": [], "note": note[:300],
                                       "at": time.time() if now is None else now}, now=now)
    return {"state": "waiting", "post": store.get_post(post_id), "url": None, "privacy": privacy_level, "note": note,
            "status": state["status"]}


# -- numbers ------------------------------------------------------------------------------------------------------

_VIDEO = re.compile(r"/video/(\d{5,25})/?$")


def video_id(url):
    match = _VIDEO.search(urlsplit(url or "").path) if platforms.host_ok("tiktok", url or "") else None
    return match.group(1) if match else None


async def sync(store, now=None):
    """Numbers for this account's posted TikTok posts on connected channels, and a second look at any post TikTok was
    still processing. Returns what happened."""
    now = time.time() if now is None else now
    result = {"stored": 0, "posted_now": 0, "skipped": {}, "stopped": None, "channels": 0}
    taken = {}
    for snap in store.snapshots():
        if snap.get("source") == SOURCE:
            taken[snap["post_id"]] = max(taken.get(snap["post_id"], 0), snap["taken_at"])
    channels = [c for c in store.list_channels(status="live") if c["platform"] == "tiktok" and social_auth.connected(c["id"], "tiktok")]
    by_id = {c["id"]: c for c in channels}
    skip = lambda why: result["skipped"].__setitem__(why, result["skipped"].get(why, 0) + 1)
    rows = []
    try:
        for post_key, item in list(social_auth.published().items()):
            if item.get("platform") != "tiktok" or int(item.get("channel_id") or 0) not in by_id:
                continue
            try:
                post = store.get_post(int(post_key))
            except Exception:  # noqa: BLE001 - the post is gone: nothing to finish
                social_auth.forget_publish(post_key)
                continue
            if post["state"] != "approved":
                social_auth.forget_publish(post_key)
                continue
            try:
                done = settle(store, post["id"], by_id[int(item["channel_id"])],
                              await fetch_status(item["channel_id"], item["publish_id"]), now=now)
                result["posted_now"] += done["state"] == "posted"
            except TikTokError as exc:
                if exc.code == "rate_limit_exceeded":
                    raise
        for channel in channels:
            result["channels"] += 1
            wanted = []
            for post in store.list_posts(state="posted", channel_id=channel["id"]):
                vid = video_id(post.get("posted_url"))
                if not vid:
                    skip("no_video_id")
                elif post.get("posted_at") and now - post["posted_at"] > MAX_POST_AGE_DAYS * 86400:
                    skip("too_old")
                elif now - taken.get(post["id"], 0) < MIN_GAP_S:
                    skip("already_fresh")
                else:
                    wanted.append((post, vid))
            for i in range(0, len(wanted), QUERY_BATCH):
                batch = wanted[i:i + QUERY_BATCH]
                data = await _api(channel["id"], "POST", "/v2/video/query/",
                                  params={"fields": "id,view_count,like_count,comment_count,share_count,duration"},
                                  json={"filters": {"video_ids": [vid for _, vid in batch]}})
                found = {str(v.get("id")): v for v in (data.get("videos") or []) if v.get("id")}
                for post, vid in batch:
                    video = found.get(vid)
                    if video is None:
                        skip("not_returned")
                        continue
                    rows.append({"post_id": post["id"], "views": _count(video.get("view_count")),
                                 "avg_view_duration_s": 0.0, "video_length_s": float(video.get("duration") or 0),
                                 "likes": _count(video.get("like_count")), "comments": _count(video.get("comment_count")),
                                 "shares": _count(video.get("share_count")), "follows_gained": 0, "taken_at": now})
            social_auth.update_sync(channel["id"], last_sync=now, last_error=None)
    except social_auth.Limited:
        result["stopped"] = "rate_limited"
    except SocialError as exc:
        result["stopped"] = "error"
        result["error"] = exc.detail
    result["stored"] = _store_rows(store, rows, now)   # rows gathered before a stop are real numbers: kept
    if result["stopped"]:
        for channel in channels:
            social_auth.update_sync(channel["id"], last_error=result.get("error") or "TikTok's rate limit was reached.")
    return result


def _store_rows(store, rows, now):
    """Rows with a length are stored (a snapshot needs the video's length to score watch share; TikTok always gives it)."""
    rows = [r for r in rows if r["video_length_s"] > 0]
    for i in range(0, len(rows), 500):
        store.add_snapshots(rows[i:i + 500], now=now, source=SOURCE)
    return len(rows)


def _count(value):
    try:
        return max(0, int(round(float(value))))
    except (TypeError, ValueError):
        return 0

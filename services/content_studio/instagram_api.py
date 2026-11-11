"""Instagram Reels through the person's own Meta app: the Instagram API with Facebook Login (an Instagram professional
account linked to a Facebook Page). Docs read 2026-11-10 (developers.facebook.com: content publishing, IG User media
reference, media insights, Facebook Login manual flow and long-lived tokens; examples on Graph API v27.0).

Why this path and not "Instagram API with Instagram Login": Kairos's videos are on this computer, not on a public web
server. Meta's resumable upload (rupload.facebook.com), which takes the file itself, is documented only for apps that
use Facebook Login; Instagram Login needs a public video_url.

Posting an approved post (the person's press, or the Publisher bot's tool: the person's approval of the post is the OK,
as for YouTube):
1. Check the account's 24-hour publishing count (content_publishing_limit; Meta's page says 100 API posts a day in one
   place and 50 in another, so Kairos reads the real numbers before each post).
2. Create a Reels container for a resumable upload with the approved caption (and its hashtags), shared to the feed,
   with Meta's AI label (is_ai_generated). If Meta refuses that field for Reels, the container is made again without
   it and the result tells the person to turn the AI label on in the Instagram app.
3. Send the file to rupload.facebook.com, then check the container's status (first after 10 s, then once a minute, at
   most 5 minutes, Meta's advice), then media_publish. The post's permalink is recorded as its live link.
Meta's API has no schedule; a scheduled post waits until its time (the person or the Publisher posts it then). The cover
is the frame Meta picks (cover_url needs a public image address).

Numbers: /<media>/insights with views, likes, comments, shares, saved and ig_reels_avg_watch_time (milliseconds, as
Meta's examples show; the page itself does not state the unit), stored as official snapshots (source "instagram_api").
Meta says the numbers can be up to 48 hours late. Posts posted by hand are matched to their media id by the shortcode in
their link, from the account's own media list.
"""
import asyncio
import os
import time
from urllib.parse import urlsplit

from core import accounts

from . import platforms, social_auth
from .social_auth import Limited, SocialError, body, send

SOURCE = "instagram_api"
FIRST_CHECK_S = 10
CHECK_EVERY_S = 60
CHECKS = 6
MAX_BYTES = 300 * 1024 * 1024
MAX_POST_AGE_DAYS = 60
MIN_GAP_S = 3600
METRICS = ("views", "likes", "comments", "shares", "saved", "ig_reels_avg_watch_time")
RATE_CODES = {4, 17, 32, 613, 80001, 80002}
AI_LABEL_APP_NOTE = ("Meta did not take the AI label through the API for this Reel. Open it in the Instagram app and turn on "
                     "the AI label (Edit > Advanced settings).")

_sending = set()
_locks = {}


class InstagramError(SocialError):
    def __init__(self, detail, status=400, code=None):
        super().__init__(detail, status)
        self.code = code


def _graph():
    return social_auth.HOSTS["graph"]


def _limited(response):
    err = body(response).get("error") or {}
    return isinstance(err, dict) and err.get("code") in RATE_CODES


async def _call(channel_id, method, path, *, params=None, data=None, url=None, headers=None, content=None, timeout=None,
                before=None):
    """One Graph call with the channel's Page token in the Authorization header (never in the address)."""
    access = await social_auth.token(channel_id, "instagram")
    kwargs = {"params": params, "data": data, "headers": {"Authorization": f"Bearer {access}", **(headers or {})}}
    if content is not None:
        kwargs["content"] = content
    if timeout:
        kwargs["timeout"] = timeout
    response = await send("instagram", method, url or (_graph() + path), limited=_limited, before=before, **kwargs)
    data_out = body(response)
    if response.status_code < 400 and not data_out.get("error"):
        return data_out
    err = data_out.get("error") if isinstance(data_out.get("error"), dict) else {}
    code, message = err.get("code"), str(err.get("error_user_msg") or err.get("message") or "")[:200]
    if code == 190 or response.status_code == 401:
        social_auth.mark_error(channel_id, "Meta no longer accepts this channel's sign-in. Connect it again.")
        raise InstagramError("Meta no longer accepts this channel's sign-in. Connect it again.", 409, code)
    if code == 10 or code == 200:
        raise InstagramError("Meta refused: this sign-in lacks a permission Kairos needs. Connect again and allow every "
                             "permission asked for.", 409, code)
    if code == 9 or err.get("error_subcode") == 2207042:
        raise InstagramError("Instagram's daily limit of posts through the API is reached for this account. Try again "
                             "tomorrow, or use Open upload page.", 429, code)
    raise InstagramError(f"Meta refused: {message or response.status_code}.", 502 if response.status_code >= 500 else 409, code)


async def publishing_limit(channel_id, ig_user):
    data = await _call(channel_id, "GET", f"/{ig_user}/content_publishing_limit", params={"fields": "quota_usage,config"})
    row = (data.get("data") or [{}])[0] if isinstance(data.get("data"), list) else {}
    config = row.get("config") or {}
    return {"used": int(row.get("quota_usage") or 0), "total": int(config.get("quota_total") or 0),
            "window_s": int(config.get("quota_duration") or 86400)}


async def _container(channel_id, ig_user, caption, ai_label=True):
    params = {"media_type": "REELS", "upload_type": "resumable", "caption": caption, "share_to_feed": "true"}
    if ai_label:
        params["is_ai_generated"] = "true"
    return await _call(channel_id, "POST", f"/{ig_user}/media", data=params)


async def _upload(channel_id, container_id, path):
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        content = handle.read()
    url = social_auth.HOSTS["rupload"] + f"/{container_id}"
    access = await social_auth.token(channel_id, "instagram")
    response = await send("instagram", "POST", url, content=content, timeout=900, limited=_limited,
                          headers={"Authorization": f"OAuth {access}", "offset": "0", "file_size": str(size)})
    answer = body(response)
    if response.status_code >= 400 or answer.get("success") is False or answer.get("error") or answer.get("debug_info"):
        raise InstagramError("Meta did not take the video file. Try again, or use Open upload page.", 502)


async def _wait(channel_id, container_id):
    status = {}
    for attempt in range(CHECKS):
        await social_auth._sleep(FIRST_CHECK_S if attempt == 0 else CHECK_EVERY_S)
        status = await _call(channel_id, "GET", f"/{container_id}", params={"fields": "status_code,status"})
        code = status.get("status_code")
        if code in ("FINISHED", "PUBLISHED"):
            return code
        if code in ("ERROR", "EXPIRED"):
            raise InstagramError(f"Instagram could not process the video ({status.get('status') or code}). Check the "
                                 "file (MP4 or MOV, H.264, up to 15 minutes, 300 MB) and try again.", 502)
    raise InstagramError("Instagram was still processing the video after five minutes. Try again in a while; nothing was "
                         "posted.", 504)


def _caption(package):
    return package["text"].get("caption") or ""


UNSETTLED = ("Kairos could not confirm whether Instagram posted this, so it is not sent again until that is settled. "
             "Check the account on Instagram: if it is there, record its link with Mark posted.")


async def reconcile(channel_id, ig_user, pending):
    """A media_publish whose answer was lost (third review, 2026-11-11): did Instagram post it? Asks the container
    first (PUBLISHED, or not), then the account's recent media for the same caption. Returns ("published", media_id or
    ""), ("not_published", None) or ("unknown", None)."""
    try:
        status = await _call(channel_id, "GET", f"/{pending['container_id']}", params={"fields": "status_code"})
    except SocialError:
        return "unknown", None
    code = status.get("status_code")
    if code != "PUBLISHED":
        return ("not_published", None) if code in ("FINISHED", "IN_PROGRESS", "ERROR", "EXPIRED") else ("unknown", None)
    try:
        recent = await _call(channel_id, "GET", f"/{ig_user}/media", params={"fields": "id,caption,timestamp", "limit": "10"})
    except SocialError:
        return "published", ""
    for row in recent.get("data") or []:
        if isinstance(row, dict) and (row.get("caption") or "") == pending.get("caption", ""):
            return "published", str(row.get("id") or "")
    return "published", ""


async def publish(store, post_id, by, now=None, guard=None):
    """Posts one approved post to its Instagram channel as a Reel. Returns what Instagram did. `guard` (a bot-made post,
    services/content_studio/handsoff.py gate) is read again just before media_publish, the irreversible step: a pause,
    a switched-off hands-off, a warning or the spend cap that arrived during the upload stops it there."""
    from . import prepare, social
    account = accounts.effective_account()
    key = (account, int(post_id))
    if key in _sending:
        raise SocialError("That post is already being sent to Instagram.", 409)
    _sending.add(key)
    try:
        async with _locks.setdefault(account, asyncio.Lock()):
            already = social_auth.published(post_id) or {}
            if already.get("platform") == "instagram" and already.get("media_id"):
                raise SocialError(f"Instagram already has this post (media {already['media_id']}), so it is not sent again. "
                                  "Record its link with Mark posted if it is missing.", 409)
            post, channel, prep, path, package = social.package_for(store, post_id, by, "instagram")
            if already.get("platform") == "instagram" and already.get("state") == "publishing":
                settled, found = await reconcile(channel["id"], social_auth.record(channel["id"]).get("ig_user_id"), already)
                if settled == "unknown":
                    raise SocialError(UNSETTLED, 409)
                if settled == "published":
                    social_auth.remember_publish(post_id, state="published", media_id=found or "unknown")
                    store.mark_published(post_id, now=now)
                    return {"state": "posted", "post": store.get_post(post_id), "url": None, "media_id": found or None,
                            "note": "Instagram had already posted it; record its link with Mark posted if it is missing.",
                            "ai_label_by_api": None}
                social_auth.forget_publish(post_id)   # Instagram never posted it: it may go now
            if os.path.getsize(path) > MAX_BYTES:
                raise SocialError("Instagram's API takes Reels up to 300 MB. Make a smaller export, or use Open upload page.", 413)
            conn = social_auth.record(channel["id"])
            ig_user = conn.get("ig_user_id")
            try:
                limit = await publishing_limit(channel["id"], ig_user)
                if limit["total"] and limit["used"] >= limit["total"]:
                    raise InstagramError(f"Instagram's limit of {limit['total']} API posts a day is used up for this account. "
                                         "Try again later, or use Open upload page.", 429)
                ai_by_api = True
                try:
                    made = await _container(channel["id"], ig_user, _caption(package))
                except InstagramError as exc:
                    if exc.code != 100 or "is_ai_generated" not in exc.detail:
                        raise
                    ai_by_api = False
                    made = await _container(channel["id"], ig_user, _caption(package), ai_label=False)
                container_id = str(made.get("id") or "")
                if not container_id:
                    raise InstagramError("Meta answered without a container id. Try again.", 502)
                await _upload(channel["id"], container_id, path)
                await _wait(channel["id"], container_id)
            except SocialError as exc:
                prepare.record_failure(store, post_id, exc.detail, now=now)
                raise

            def check():
                problem = guard() if guard else None
                if problem:
                    raise SocialError(f"Not posted: {problem}", 409)
            # The post is "publishing" from here: not eligible again and counted for the day, until settled (third review).
            social_auth.remember_publish(post_id, platform="instagram", state="publishing", container_id=container_id,
                                         channel_id=channel["id"], caption=_caption(package), at=time.time() if now is None else now)
            try:
                done = await _call(channel["id"], "POST", f"/{ig_user}/media_publish", data={"creation_id": container_id},
                                   before=check)
            except SocialError as exc:
                if exc.detail.startswith("Not posted:") or isinstance(exc, (InstagramError, Limited)):
                    social_auth.forget_publish(post_id)   # refused before it was sent, or Meta answered no: not posted
                    prepare.record_failure(store, post_id, exc.detail, now=now)
                    raise
                raise SocialError(UNSETTLED, 502) from exc
            except Exception as exc:  # noqa: BLE001 - the answer was lost: whether it posted is unknown
                raise SocialError(UNSETTLED, 502) from exc
            media_id = str(done.get("id") or "")
            if not media_id:
                raise SocialError(UNSETTLED, 502)
            # Instagram has it now: record that at once, before anything else can fail, so it is never sent again and
            # counts toward the channel's posts for the day (review finding, 2026-11-11).
            social_auth.remember_publish(post_id, platform="instagram", state="published", media_id=media_id,
                                         channel_id=channel["id"], at=time.time() if now is None else now)
            store.mark_published(post_id, now=now)
            try:
                info = await _call(channel["id"], "GET", f"/{media_id}", params={"fields": "permalink,shortcode"})
            except SocialError:
                info = {}
            link = info.get("permalink") or (f"https://www.instagram.com/reel/{info['shortcode']}/" if info.get("shortcode") else "")
            store.add_evidence(post_id, "api_post", {"platform": "instagram", "by": by, "media_id": media_id,
                                                     "ai_label": ai_by_api, "share_to_feed": True})
            if not platforms.host_ok("instagram", link):
                note = "Instagram posted it but gave no link; paste the link with Mark posted."
                return {"state": "posted", "post": store.get_post(post_id), "url": None, "media_id": media_id, "note": note,
                        "ai_label_by_api": ai_by_api}
            posted = store.set_posted_link(post_id, link)
            return {"state": "posted", "post": posted, "url": link, "media_id": media_id,
                    "note": "" if ai_by_api else AI_LABEL_APP_NOTE, "ai_label_by_api": ai_by_api}
    finally:
        _sending.discard(key)


# -- numbers ------------------------------------------------------------------------------------------------------

def shortcode(url):
    if not platforms.host_ok("instagram", url or ""):
        return None
    match = platforms._INSTAGRAM_POST.match(urlsplit(url).path)
    return match.group(2) if match else None


async def _media_ids(channel_id, ig_user, wanted_codes):
    """shortcode -> media id from the account's own media list (newest first, at most 3 pages of 50)."""
    found, after = {}, None
    for _ in range(3):
        params = {"fields": "id,shortcode,permalink,media_product_type", "limit": 50}
        if after:
            params["after"] = after
        data = await _call(channel_id, "GET", f"/{ig_user}/media", params=params)
        for item in data.get("data") or []:
            code = item.get("shortcode") or shortcode(item.get("permalink"))
            if code and item.get("id"):
                found[code] = str(item["id"])
        after = ((data.get("paging") or {}).get("cursors") or {}).get("after")
        if not after or wanted_codes <= set(found):
            break
    return found


def _metric(data, name):
    for row in data.get("data") or []:
        if row.get("name") != name:
            continue
        if isinstance(row.get("total_value"), dict):
            return row["total_value"].get("value")
        values = row.get("values") or []
        return values[-1].get("value") if values else None
    return None


async def sync(store, now=None, length_of=None):
    """Numbers for this account's posted Instagram posts on connected channels. Returns what happened."""
    from . import page_reads
    now = time.time() if now is None else now
    length_of = length_of or (lambda post: page_reads._length(store, post))
    result = {"stored": 0, "skipped": {}, "stopped": None, "channels": 0}
    skip = lambda why: result["skipped"].__setitem__(why, result["skipped"].get(why, 0) + 1)
    taken = {}
    for snap in store.snapshots():
        if snap.get("source") == SOURCE:
            taken[snap["post_id"]] = max(taken.get(snap["post_id"], 0), snap["taken_at"])
    channels = [c for c in store.list_channels(status="live") if c["platform"] == "instagram"
                and social_auth.connected(c["id"], "instagram")]
    rows = []
    try:
        for channel in channels:
            result["channels"] += 1
            ig_user = social_auth.record(channel["id"]).get("ig_user_id")
            wanted = []
            for post in store.list_posts(state="posted", channel_id=channel["id"]):
                code = shortcode(post.get("posted_url"))
                if not code:
                    skip("no_link")
                elif post.get("posted_at") and now - post["posted_at"] > MAX_POST_AGE_DAYS * 86400:
                    skip("too_old")
                elif now - taken.get(post["id"], 0) < MIN_GAP_S:
                    skip("already_fresh")
                else:
                    wanted.append((post, code))
            if not wanted:
                social_auth.update_sync(channel["id"], last_sync=now, last_error=None)
                continue
            known = {code: str((social_auth.published(p["id"]) or {}).get("media_id") or "") for p, code in wanted}
            missing = {code for code, mid in known.items() if not mid}
            if missing:
                listed = await _media_ids(channel["id"], ig_user, missing)
                known.update({c: listed[c] for c in missing if c in listed})
            for post, code in wanted:
                media_id = known.get(code)
                if not media_id:
                    skip("not_on_account")
                    continue
                data = await _call(channel["id"], "GET", f"/{media_id}/insights", params={"metric": ",".join(METRICS)})
                views = _metric(data, "views")
                if views is None:
                    skip("no_data_yet")
                    continue
                length = length_of(post)
                if not length:
                    skip("length_unknown")
                    continue
                avg_ms = _metric(data, "ig_reels_avg_watch_time") or 0
                rows.append({"post_id": post["id"], "views": _count(views), "avg_view_duration_s": round(float(avg_ms) / 1000.0, 3),
                             "video_length_s": float(length), "likes": _count(_metric(data, "likes")),
                             "comments": _count(_metric(data, "comments")), "shares": _count(_metric(data, "shares")),
                             "follows_gained": 0, "taken_at": now})
            social_auth.update_sync(channel["id"], last_sync=now, last_error=None)
    except social_auth.Limited:
        result["stopped"] = "rate_limited"
    except SocialError as exc:
        result["stopped"] = "error"
        result["error"] = exc.detail
    for i in range(0, len(rows), 500):
        store.add_snapshots(rows[i:i + 500], now=now, source=SOURCE)
    result["stored"] = len(rows)
    if result["stopped"]:
        for channel in channels:
            social_auth.update_sync(channel["id"], last_error=result.get("error") or "Instagram's rate limit was reached.")
    return result


def _count(value):
    try:
        return max(0, int(round(float(value))))
    except (TypeError, ValueError):
        return 0

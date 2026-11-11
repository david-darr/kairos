"""YouTube analytics for Content Studio: read-only (build spec "Content Studio Team", sections 6, 7, 9 D1/D2).

The user asks for it ("Connect YouTube analytics"): that is an extra, optional Google grant (youtube.readonly and
yt-analytics.readonly) added to a Google sign-in the account already has, through the same sign-in flow and
token refresh as every other Google feature (core/google_workspace.py). Nothing here posts, edits or deletes.

A sync maps the account's posted YouTube posts to videos by the video id in posted_url, checks the signed-in
Google account owns the studio channel (channels.list mine=true), then stores one snapshot per post per sync
(source "youtube_api"): views, average view duration, likes, comments, shares and subscribers gained from the
YouTube Analytics API, and the video's length from the Data API. Snapshots are only ever added. A daily pass runs
for each account that connected; the quota-sensitive calls are batched and backed off.

Per channel (David's bug, 2026-11-11: his channel's Google account was a different Gmail from his Library one, and
Connect could only ever reconnect the Library default): each YouTube channel in Content Studio has its own link, the
Google account it reads its numbers with. Connect lets the person choose one of their connected Google accounts or
"Use another Google account", a fresh Google sign-in (Google's chooser always shows) that asks for the YouTube
permissions and the basic identity only and adds that Google account to this Kairos account, marked YouTube-only, so
it never becomes the default for Drive, Gmail or Calendar and never gets their permissions. A link is only made
when that Google account owns the channel (channels.list mine=true); a Brand Account has to be picked as itself in
Google's chooser, and the refusal says so. Posting (youtube_publish.py) keeps its own links the same way.

Per account: the links live in data/accounts/<id>/content_studio/youtube.json as {"channels": {channel id:
{"google_account", "linked_at", "last_sync", "last_error"}}, "last_sync", ...}. The single link of the first version
({"google_account": id}) moves onto every YouTube channel the account has, the first time it is read with channels.
Whether a channel is connected also needs its Google account to still hold the scopes. A YouTube-only Google account
that no channel uses any more (analytics or posting) is forgotten.
"""
import asyncio
import re
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

from core import accounts
from core import google_workspace as google
from core.atomic_io import read_json, write_json_atomic

from .store import StudioError

SOURCE = "youtube_api"
SCOPES = google.YOUTUBE_SCOPES
DAY = 86400.0
MAX_POST_AGE_DAYS = 60       # older posts have stopped moving; syncing them only spends quota
MIN_GAP_S = 3600             # a second sync inside an hour adds no duplicate snapshot for a post
DAILY_EVERY_S = 22 * 3600    # the daily pass
RETRY_AFTER_FAILURE_S = 3 * 3600
BATCH = 50                   # videos.list takes 50 ids; reports.query with the video dimension takes 200 rows at most
ATTEMPTS = 4
BACKOFF_S = 1.0
METRICS = ("views", "averageViewDuration", "likes", "comments", "shares", "subscribersGained")
QUOTA_REASONS = {"quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"}
NOTICE = ("This reads your YouTube numbers only. It never posts, edits or deletes anything. If you later post "
          "through your own Google project, uploads from a project that has not passed YouTube's API audit may be "
          "private-only; that does not affect these numbers.")

_sleep = asyncio.sleep       # a test replaces this so backoff costs no time
_locks = {}                  # account id -> asyncio.Lock: one sync at a time per account


class YouTubeError(StudioError):
    pass


class _Quota(Exception):
    pass


def _store(store):
    if store is not None:
        return store
    from . import studio
    return studio


# -- per-channel links, shared with posting (youtube_publish.py) ---------------------------------------

KINDS = {"analytics": ("youtube.json", google.YOUTUBE_SCOPES),
         "posting": ("youtube_posting.json", google.YOUTUBE_UPLOAD_SCOPES)}
NAMES = {"analytics": "YouTube analytics", "posting": "YouTube posting"}


def _state_path(kind="analytics"):
    import os
    return os.path.join(accounts.account_dir(create=False), "content_studio", KINDS[kind][0])


def _load(kind="analytics"):
    state = read_json(_state_path(kind), {})
    return state if isinstance(state, dict) else {}


def _save(state, kind="analytics"):
    import os
    os.makedirs(os.path.dirname(_state_path(kind)), exist_ok=True)
    write_json_atomic(_state_path(kind), state)


def _youtube_channels(store):
    return [c for c in store.list_channels() if c["platform"] == "youtube"]


def links(kind="analytics", store=None):
    """This account's link state for analytics or posting, with the first version's single link moved onto every
    YouTube channel the account has (once there is at least one; until then it waits, so none is lost)."""
    state = _load(kind)
    legacy = state.get("google_account")
    if legacy:
        channels = _youtube_channels(_store(store))
        if channels:
            linked = state.setdefault("channels", {})
            for channel in channels:
                linked.setdefault(str(channel["id"]), {"google_account": legacy,
                                                       "linked_at": state.get("requested_at") or time.time()})
            state.pop("google_account", None)
            state.pop("requested_at", None)
            _save(state, kind)
    return state


def _granted(kind, info):
    return bool(info and info["connected"] and set(KINDS[kind][1]) <= set(info["granted_scopes"]))


def connected_links(kind="analytics", store=None):
    """channel id (int) -> Google account id, for every channel whose Google account still holds the scopes."""
    out = {}
    for key, link in (links(kind, store).get("channels") or {}).items():
        if _granted(kind, google.account_info(link.get("google_account"))):
            out[int(key)] = link["google_account"]
    return out


def _channel_view(kind, channel, link):
    info = google.account_info(link.get("google_account")) if link else None
    granted = _granted(kind, info)
    return {"channel_id": channel["id"], "handle": channel["handle"], "status": channel["status"],
            "google_account": {"id": info["id"], "email": info["email"], "youtube_only": info["youtube_only"]} if info else None,
            "connected": bool(link) and granted,
            "pending": bool(link) and not granted, "needs_reconnect": bool(info and info.get("error")),
            "missing": bool(link) and info is None,
            "last_sync": (link or {}).get("last_sync"), "last_error": (link or {}).get("last_error")}


def link_status(kind, user=None, store=None):
    """The fields analytics and posting share: each YouTube channel's link, the Google accounts to choose from."""
    store = _store(store)
    state = links(kind, store)
    linked = state.get("channels") or {}
    channels = [_channel_view(kind, c, linked.get(str(c["id"]))) for c in _youtube_channels(store)]
    live = [c for c in channels if c["status"] == "live"]
    first = next((c["google_account"] for c in channels if c["connected"]), None)
    return state, {"configured": google.configured(), "connected": any(c["connected"] for c in live),
                   "pending": any(c["pending"] for c in live) and not any(c["connected"] for c in live),
                   "needs_reconnect": any(c["needs_reconnect"] for c in live),
                   "google_account": first, "channels": channels,
                   "google_accounts": [{k: a[k] for k in ("id", "email", "youtube_only", "error")}
                                       for a in google.accounts_for(user)],
                   "scopes": list(KINDS[kind][1])}


def status(user=None, store=None):
    state, out = link_status("analytics", user, store)
    out.update(last_sync=state.get("last_sync"), last_result=state.get("last_result"),
               last_error=state.get("last_error"), notice=NOTICE)
    return out


def not_owned_text(email, handle, owned):
    """Why a Google account cannot be used for a channel, with the Brand Account case said plainly."""
    has = (f" It has {', '.join(o['title'] for o in owned if o.get('title'))}." if any(o.get("title") for o in owned)
           else " It has no YouTube channel of its own.")
    return (f"{email or 'That Google account'} does not own {handle} on YouTube.{has} If {handle} is a Brand Account, "
            f"choose the Brand Account itself (it shows the channel's name) in Google's account chooser, not your "
            f"personal Google account, then connect again.")


async def _verify(channel, ident):
    """Checks this Google account owns the channel. Raises YouTubeError when Google says it does not; returns a
    note (or None) when Google could not be asked, so the link is made and the next sync checks again."""
    try:
        owned = await _owned_channels(ident)
    except _Quota:
        return "YouTube's quota ran out, so Kairos could not check the channel yet. The next sync checks it."
    except YouTubeError as exc:
        return exc.detail
    if _owner_of(channel, owned) is None:
        raise YouTubeError(not_owned_text((google.account_info(ident) or {}).get("email"), channel["handle"], owned), 409)
    return None


def _forget_if_unused(ident, user):
    """A Google account added only for YouTube goes when no channel uses it any more, for analytics or posting."""
    info = google.account_info(ident)
    if not info or not info["youtube_only"]:
        return
    for kind in KINDS:
        state = _load(kind)
        if state.get("google_account") == ident or any(
                link.get("google_account") == ident for link in (state.get("channels") or {}).values()):
            return
    try:
        google.disconnect(ident, user)
    except google.GoogleError:
        pass


async def link_channel(kind, channel, ident, user):
    """Makes `ident` the Google account of this channel for analytics or posting, once it owns the channel."""
    note = await _verify(channel, ident)
    state = _load(kind)
    linked = state.setdefault("channels", {})
    old = (linked.get(str(channel["id"])) or {}).get("google_account")
    linked[str(channel["id"])] = {"google_account": ident, "linked_at": time.time(), **({"last_error": note} if note else {})}
    _save(state, kind)
    if old and old != ident:
        _forget_if_unused(old, user)


def _after_sign_in(kind, channel_id, user):
    """What runs once Google sends the person back: the account must hold the scopes and own the channel."""
    async def done(ident, email):
        info = google.account_info(ident)
        try:
            if not _granted(kind, info):
                raise YouTubeError("Google did not grant the YouTube permission Kairos asked for. Connect again and leave "
                                   "the YouTube boxes ticked on Google's consent page.", 409)
            await link_channel(kind, _store(None).get_channel(channel_id), ident, user)
        except StudioError as exc:
            _forget_if_unused(ident, user)
            raise google.GoogleError(exc.detail, exc.status) from exc
    return done


async def connect_channel(kind, redirect_uri, user, channel_id, google_account=None, new_account=False, store=None):
    """Connect one YouTube channel for analytics or posting. `new_account` starts Google's chooser for a Google
    account to add (YouTube permissions and identity only). Otherwise `google_account` (default: the usual Library
    one): linked at once when it already holds the permissions and owns the channel, else Google's consent page
    adds the permissions to it. Returns {"url"} to open, or {"linked": True}."""
    store = _store(store)
    channel = store.get_channel(channel_id)
    if channel["platform"] != "youtube":
        raise YouTubeError("Only a YouTube channel connects to YouTube.")
    scopes = KINDS[kind][1]
    try:
        if new_account:
            return {"url": google.start_sign_in(redirect_uri, user, add=True, extra_scopes=scopes, only_extra=True,
                                                then=_after_sign_in(kind, channel_id, user))}
        ident = google.resolve_account(user, google_account)
        info = google.account_info(ident)
        if _granted(kind, info) and not info.get("error"):
            await link_channel(kind, channel, ident, user)
            return {"linked": True}
        return {"url": google.start_sign_in(redirect_uri, user, add=True, account_id=ident, extra_scopes=scopes,
                                            then=_after_sign_in(kind, channel_id, user))}
    except google.GoogleError as exc:
        if exc.status == 401:
            raise YouTubeError("Connect a Google account first: choose Use another Google account, or sign in to "
                               "Google in Library.", 409) from exc
        raise YouTubeError(str(exc), exc.status) from exc


def unlink(kind, user=None, channel_id=None, store=None):
    """Forgets one channel's link (or every link, with no channel), then any YouTube-only Google account no
    channel uses any more. What is already stored stays."""
    import os
    state = _load(kind) if channel_id is None else links(kind, store)
    gone = {link.get("google_account") for link in (state.get("channels") or {}).values()} | {state.get("google_account")}
    if channel_id is None:
        try:
            os.remove(_state_path(kind))
        except FileNotFoundError:
            pass
    else:
        _store(store).get_channel(channel_id)
        link = (state.get("channels") or {}).pop(str(channel_id), None)
        gone = {(link or {}).get("google_account")}
        _save(state, kind)
    for ident in gone - {None}:
        _forget_if_unused(ident, user)


def connect(redirect_uri, user, channel_id, google_account=None, new_account=False, store=None):
    return connect_channel("analytics", redirect_uri, user, channel_id, google_account, new_account, store)


def disconnect(user=None, channel_id=None, store=None):
    """Stops syncing for one channel, or all of them, and forgets the link. Numbers already stored stay. The
    permission itself is Google's to revoke (myaccount.google.com, Third-party access); this only stops Kairos
    using it."""
    unlink("analytics", user, channel_id, store)
    return status(user, store)


# -- reading ids and durations ------------------------------------------------------------------------

_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def video_id(url):
    """The 11 character video id in a YouTube watch, youtu.be, shorts, live or embed link, else None."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    segments = [s for s in parts.path.split("/") if s]
    found = None
    if host == "youtu.be" and segments:
        found = segments[0]
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        if segments and segments[0] in ("shorts", "live", "embed", "v") and len(segments) > 1:
            found = segments[1]
        elif segments and segments[0] == "watch":
            found = (parse_qs(parts.query).get("v") or [None])[0]
    return found if found and _ID.match(found) else None


def iso_seconds(text):
    """Seconds in an ISO 8601 duration (PT1M5S, PT1H, P0D), 0 when it cannot be read."""
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?", text or "")
    if not m:
        return 0.0
    days, hours, minutes, seconds = (float(g) if g else 0.0 for g in m.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def _handle(value):
    return (value or "").strip().lstrip("@").lower()


# -- calling Google, with backoff ---------------------------------------------------------------------

async def _call(ident, api, path, params):
    """One GET with backoff: a 429, or a 403 that Google says is a quota or rate limit, waits (Retry-After when
    sent, else 1, 2, 4 seconds) and tries again; when the attempts are spent the sync stops as a quota stop."""
    for attempt in range(ATTEMPTS):
        try:
            return await google.request(api, "GET", path, params=params, account=ident)
        except google.GoogleError as exc:
            limited = exc.status == 429 or (exc.status == 403 and (exc.reason in QUOTA_REASONS or "quota" in str(exc).lower()))
            if not limited:
                if exc.reason == "accessNotConfigured":
                    raise YouTubeError("Turn on the YouTube Data API and the YouTube Analytics API in your Google "
                                       "Cloud project, then sync again.", 409) from exc
                if exc.status in (401, 403):
                    raise YouTubeError("Google would not share YouTube numbers with this sign-in. Connect YouTube "
                                       "analytics again.", 409) from exc
                raise YouTubeError(f"YouTube did not answer: {exc}", 502) from exc
            if attempt == ATTEMPTS - 1:
                raise _Quota() from exc
            await _sleep(min(exc.retry_after, 60) if exc.retry_after else BACKOFF_S * 2 ** attempt)


def _batches(items, size=BATCH):
    for i in range(0, len(items), size):
        yield items[i:i + size]


# -- the sync -----------------------------------------------------------------------------------------

def _candidates(store, now):
    """Live YouTube channels and, per channel, the posted posts that have a video id and are recent enough."""
    channels = [c for c in store.list_channels(status="live") if c["platform"] == "youtube"]
    by_channel = {c["id"]: [] for c in channels}
    for post in store.list_posts(state="posted"):
        if post["channel_id"] not in by_channel:
            continue
        vid = video_id(post["posted_url"])
        if vid and (post["posted_at"] is None or now - post["posted_at"] <= MAX_POST_AGE_DAYS * DAY):
            by_channel[post["channel_id"]].append((post, vid))
    return channels, by_channel


async def _owned_channels(ident):
    data = await _call(ident, "youtube", "/channels", {"part": "id,snippet", "mine": "true", "maxResults": 50})
    return [{"id": item.get("id"), "title": str((item.get("snippet") or {}).get("title") or "")[:100],
             "keys": {_handle(item.get("id")), _handle((item.get("snippet") or {}).get("customUrl")),
                      _handle((item.get("snippet") or {}).get("title"))} - {""}}
            for item in (data.get("items") or []) if item.get("id")]


def _owner_of(channel, owned):
    handle = _handle(channel["handle"])
    return next((o["id"] for o in owned if handle in o["keys"]), None)


async def _details(ident, ids):
    """video id -> (length in seconds, owning channel id), from the Data API in batches of 50."""
    out = {}
    for batch in _batches(sorted(set(ids))):
        data = await _call(ident, "youtube", "/videos", {"part": "contentDetails,snippet", "id": ",".join(batch),
                                                         "maxResults": len(batch)})
        for item in data.get("items") or []:
            out[item.get("id")] = (iso_seconds((item.get("contentDetails") or {}).get("duration")),
                                   (item.get("snippet") or {}).get("channelId"))
    return out


def _day(ts):
    return datetime.fromtimestamp(max(ts, 1.2e9), timezone.utc).strftime("%Y-%m-%d")


async def _metrics(ident, owner_id, items, now):
    """video id -> {metric: value}, from the Analytics API: lifetime totals since the oldest post in the batch."""
    out = {}
    for batch in _batches(items):
        start = min((p["posted_at"] if p["posted_at"] is not None else now) for p, _ in batch)
        data = await _call(ident, "youtube_analytics", "/reports", {
            "ids": f"channel=={owner_id}", "startDate": _day(start), "endDate": _day(now),
            "metrics": ",".join(METRICS), "dimensions": "video", "sort": "-views", "maxResults": len(batch),
            "filters": "video==" + ",".join(vid for _, vid in batch)})
        names = [h.get("name") for h in data.get("columnHeaders") or []]
        for row in data.get("rows") or []:
            record = dict(zip(names, row))
            if record.get("video"):
                out[record["video"]] = record
    return out


def _count(value):
    try:
        return max(0, int(round(float(value))))
    except (TypeError, ValueError):
        return 0


def _lock():
    return _locks.setdefault(accounts.effective_account(), asyncio.Lock())


async def sync(store=None, now=None):
    """Pulls numbers for this account's posted YouTube posts, each channel through its own Google account. Returns
    what happened; stores snapshots even if the quota ran out part way (rows already gathered are real). One
    channel's trouble is recorded on that channel and the others still sync. Raises YouTubeError when no channel
    is connected."""
    store = _store(store)
    now = time.time() if now is None else now
    async with _lock():
        linked = connected_links("analytics", store)
        if not linked:
            raise YouTubeError("Connect YouTube analytics for a channel first.", 409)
        result = {"stored": 0, "posts": 0, "skipped": {}, "channels_not_owned": [], "channels_not_connected": [],
                  "errors": {}, "stopped": None}
        skip = lambda why, n=1: result["skipped"].__setitem__(why, result["skipped"].get(why, 0) + n)
        rows, taken = [], {s["post_id"]: s["taken_at"] for s in store.snapshots() if s.get("source") == SOURCE}
        outcome = {}   # channel id -> None (synced) or the reason it did not
        owned_by = {}  # Google account id -> the channels it owns, asked once per sync
        failure = None
        try:
            channels, by_channel = _candidates(store, now)
            for channel in channels:
                items = by_channel[channel["id"]]
                if not items:
                    continue
                ident = linked.get(channel["id"])
                if ident is None:
                    result["channels_not_connected"].append(channel["handle"])
                    skip("not_connected", len(items))
                    continue
                try:
                    if ident not in owned_by:
                        owned_by[ident] = await _owned_channels(ident)
                    owner_id = _owner_of(channel, owned_by[ident])
                    if owner_id is None:
                        result["channels_not_owned"].append(channel["handle"])
                        skip("not_owned", len(items))
                        outcome[channel["id"]] = not_owned_text((google.account_info(ident) or {}).get("email"),
                                                                channel["handle"], owned_by[ident])
                        continue
                    details = await _details(ident, [vid for _, vid in items])
                    mine = []
                    for post, vid in items:
                        if vid not in details or details[vid][1] != owner_id:
                            skip("not_on_channel")
                        elif now - taken.get(post["id"], 0) < MIN_GAP_S:
                            skip("already_fresh")
                        elif post["posted_at"] is not None and now < post["posted_at"]:
                            skip("not_posted_yet")
                        else:
                            mine.append((post, vid))
                    numbers = await _metrics(ident, owner_id, mine, now)
                    for post, vid in mine:
                        record = numbers.get(vid)
                        if record is None:
                            skip("no_data_yet")
                            continue
                        rows.append({"post_id": post["id"], "views": _count(record.get("views")),
                                     "avg_view_duration_s": max(0.0, float(record.get("averageViewDuration") or 0)),
                                     "video_length_s": details[vid][0], "likes": _count(record.get("likes")),
                                     "comments": _count(record.get("comments")), "shares": _count(record.get("shares")),
                                     "follows_gained": _count(record.get("subscribersGained")), "taken_at": now})
                    outcome[channel["id"]] = None
                except YouTubeError as exc:
                    result["errors"][channel["handle"]] = exc.detail
                    outcome[channel["id"]] = exc.detail
        except _Quota:
            result["stopped"] = "quota"
            failure = "YouTube's quota ran out. The numbers gathered so far were saved; the rest comes at the next sync."
        if result["errors"] and not failure:
            result["stopped"] = "error"
            failure = " ".join(f"{handle}: {text}" for handle, text in result["errors"].items())
        for chunk in _batches(rows, 500):
            store.add_snapshots(chunk, now=now, source=SOURCE)
        result["stored"], result["posts"] = len(rows), len(rows)
        state = links("analytics", store)   # read again: a connect made during the sync is kept
        for channel_id, problem in outcome.items():
            link = (state.get("channels") or {}).get(str(channel_id))
            if link is None or link.get("google_account") != linked.get(channel_id):
                continue
            if problem is None:
                link["last_sync"] = now
                link.pop("last_error", None)
            else:
                link["last_error"] = problem
        state.update(last_attempt=now, last_error=failure, last_result=result)
        if not failure:
            state["last_sync"] = now
        _save(state)
        return result


# -- the daily pass -----------------------------------------------------------------------------------

def due(now=None):
    """Whether this account has connected YouTube analytics for a channel and a daily sync is owed."""
    now = time.time() if now is None else now
    if not connected_links("analytics"):
        return False
    state = _load()
    last = state.get("last_attempt")
    if last is None:
        return True
    return now - last >= (RETRY_AFTER_FAILURE_S if state.get("last_error") else DAILY_EVERY_S)


async def sync_all_due(now=None, store_for=None):
    """The daily pass: each account that connected YouTube analytics and is due, run as that account. One
    account's trouble never stops the others. Returns {account id: result or error text}."""
    done = {}
    for account_id in accounts.all_accounts():
        with accounts.as_account(account_id):
            try:
                if due(now):
                    done[account_id] = await sync(store_for() if store_for else None, now)
            except Exception as exc:  # noqa: BLE001 - recorded, never raised into the scheduler
                done[account_id] = f"failed: {exc}"
    return done


# -- trends: YouTube's most-popular list (spec section 7) ---------------------------------------------

_REGION = re.compile(r"^[A-Z]{2}$")


async def trending(region="US", category_id=None, count=20, now=None):
    """YouTube's most-popular chart for a region (and optionally a video category), through the same
    read-only grant as the analytics. One quota unit per call. Each row keeps its source link and the date it
    was read, so a trend claim made from it carries both. Raises YouTubeError when not connected."""
    now = time.time() if now is None else now
    region = (region or "US").strip().upper()
    if not _REGION.match(region):
        raise YouTubeError("region is a two-letter country code, such as US or GB")
    if category_id is not None and not re.fullmatch(r"\d{1,4}", str(category_id)):
        raise YouTubeError("category_id is a YouTube video category number")
    count = max(1, min(int(count or 20), 50))
    linked = connected_links("analytics")
    if not linked:
        raise YouTubeError("Connect YouTube analytics for a channel first; the most-popular list uses the same read-only "
                           "permission.", 409)
    params = {"part": "snippet,statistics,contentDetails", "chart": "mostPopular", "regionCode": region, "maxResults": count}
    if category_id is not None:
        params["videoCategoryId"] = str(category_id)
    try:
        data = await _call(linked[min(linked)], "youtube", "/videos", params)
    except _Quota as exc:
        raise YouTubeError("YouTube's quota ran out; try the most-popular list again later.", 429) from exc
    read_on = _day(now)
    rows = []
    for item in data.get("items") or []:
        snippet, stats = item.get("snippet") or {}, item.get("statistics") or {}
        if not item.get("id"):
            continue
        rows.append({"title": str(snippet.get("title") or "")[:200], "channel": str(snippet.get("channelTitle") or "")[:100],
                     "published_at": snippet.get("publishedAt"), "views": _count(stats.get("viewCount")),
                     "likes": _count(stats.get("likeCount")), "comments": _count(stats.get("commentCount")),
                     "length_s": iso_seconds((item.get("contentDetails") or {}).get("duration")),
                     "source": f"https://www.youtube.com/watch?v={item['id']}", "read_on": read_on})
    return {"region": region, "category_id": category_id, "read_on": read_on,
            "source": f"YouTube Data API most-popular chart, {region}, read {read_on}", "videos": rows}

"""YouTube analytics for Content Studio: read-only (build spec "Content Studio Team", sections 6, 7, 9 D1/D2).

The user asks for it ("Connect YouTube analytics"): that is an extra, optional Google grant (youtube.readonly and
yt-analytics.readonly) added to a Google sign-in the account already has, through the same sign-in flow and
token refresh as every other Google feature (core/google_workspace.py). Nothing here posts, edits or deletes.

A sync maps the account's posted YouTube posts to videos by the video id in posted_url, checks the signed-in
Google account owns the studio channel (channels.list mine=true), then stores one snapshot per post per sync
(source "youtube_api"): views, average view duration, likes, comments, shares and subscribers gained from the
YouTube Analytics API, and the video's length from the Data API. Snapshots are only ever added. A daily pass runs
for each account that connected; the quota-sensitive calls are batched and backed off.

Per account: the link lives in data/accounts/<id>/content_studio/youtube.json (which Google account, when it last
ran). Whether it is connected also needs the Google account to still hold both scopes.
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


def _state_path():
    import os
    return os.path.join(accounts.account_dir(create=False), "content_studio", "youtube.json")


def _load():
    state = read_json(_state_path(), {})
    return state if isinstance(state, dict) else {}


def _save(state):
    import os
    os.makedirs(os.path.dirname(_state_path()), exist_ok=True)
    write_json_atomic(_state_path(), state)


# -- status, connect, disconnect ----------------------------------------------------------------------

def _link():
    """(state, google account info or None, whether both scopes are granted)."""
    state = _load()
    info = google.account_info(state.get("google_account")) if state.get("google_account") else None
    granted = bool(info and info["connected"] and set(SCOPES) <= set(info["granted_scopes"]))
    return state, info, granted


def status():
    state, info, granted = _link()
    connected = bool(state.get("google_account") and granted)
    return {"configured": google.configured(), "connected": connected,
            "pending": bool(state.get("google_account")) and not connected,
            "google_account": {"id": info["id"], "email": info["email"]} if info else None,
            "needs_reconnect": bool(info and info.get("error")),
            "scopes": list(SCOPES), "last_sync": state.get("last_sync"), "last_result": state.get("last_result"),
            "last_error": state.get("last_error"), "notice": NOTICE}


def connect_url(redirect_uri, user, google_account=None):
    """The consent page that adds the two read-only YouTube scopes to one of this user's Google sign-ins.
    Needs a Google sign-in first (Library); the extra grant is never part of any other Google sign-in."""
    try:
        ident = google.resolve_account(user, google_account)
        url = google.start_sign_in(redirect_uri, user, account_id=ident, extra_scopes=SCOPES)
    except google.GoogleError as exc:
        raise YouTubeError(str(exc), 409 if exc.status == 401 else exc.status) from exc
    state = _load()
    if state.get("google_account") != ident:
        state = {"google_account": ident}
    state["requested_at"] = time.time()
    _save(state)
    return url


def disconnect():
    """Stops syncing and forgets the link. Numbers already stored stay. The permission itself is Google's to
    revoke (myaccount.google.com, Third-party access); this only stops Kairos using it."""
    import os
    try:
        os.remove(_state_path())
    except FileNotFoundError:
        pass
    return status()


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
    return [{"id": item.get("id"), "keys": {_handle(item.get("id")), _handle((item.get("snippet") or {}).get("customUrl")),
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
    """Pulls numbers for this account's posted YouTube posts. Returns what happened; stores snapshots even if
    the quota ran out part way (rows already gathered are real). Raises YouTubeError when not connected."""
    store = _store(store)
    now = time.time() if now is None else now
    async with _lock():
        state, info, granted = _link()
        if not state.get("google_account") or not granted:
            raise YouTubeError("Connect YouTube analytics first.", 409)
        ident = state["google_account"]
        result = {"stored": 0, "posts": 0, "skipped": {}, "channels_not_owned": [], "stopped": None}
        rows, taken = [], {s["post_id"]: s["taken_at"] for s in store.snapshots() if s.get("source") == SOURCE}
        failure = None
        try:
            channels, by_channel = _candidates(store, now)
            if any(by_channel.values()):
                owned = await _owned_channels(ident)
                wanted = [(c, _owner_of(c, owned)) for c in channels if by_channel[c["id"]]]
                result["channels_not_owned"] = [c["handle"] for c, owner in wanted if owner is None]
                for channel, owner_id in wanted:
                    if owner_id is None:
                        result["skipped"]["not_owned"] = result["skipped"].get("not_owned", 0) + len(by_channel[channel["id"]])
                        continue
                    items = by_channel[channel["id"]]
                    details = await _details(ident, [vid for _, vid in items])
                    mine = []
                    for post, vid in items:
                        if vid not in details or details[vid][1] != owner_id:
                            result["skipped"]["not_on_channel"] = result["skipped"].get("not_on_channel", 0) + 1
                        elif now - taken.get(post["id"], 0) < MIN_GAP_S:
                            result["skipped"]["already_fresh"] = result["skipped"].get("already_fresh", 0) + 1
                        elif post["posted_at"] is not None and now < post["posted_at"]:
                            result["skipped"]["not_posted_yet"] = result["skipped"].get("not_posted_yet", 0) + 1
                        else:
                            mine.append((post, vid))
                    numbers = await _metrics(ident, owner_id, mine, now)
                    for post, vid in mine:
                        record = numbers.get(vid)
                        if record is None:
                            result["skipped"]["no_data_yet"] = result["skipped"].get("no_data_yet", 0) + 1
                            continue
                        rows.append({"post_id": post["id"], "views": _count(record.get("views")),
                                     "avg_view_duration_s": max(0.0, float(record.get("averageViewDuration") or 0)),
                                     "video_length_s": details[vid][0], "likes": _count(record.get("likes")),
                                     "comments": _count(record.get("comments")), "shares": _count(record.get("shares")),
                                     "follows_gained": _count(record.get("subscribersGained")), "taken_at": now})
        except _Quota:
            result["stopped"] = "quota"
            failure = "YouTube's quota ran out. The numbers gathered so far were saved; the rest comes at the next sync."
        except YouTubeError as exc:
            failure = exc.detail
            result["stopped"] = "error"
        for chunk in _batches(rows, 500):
            store.add_snapshots(chunk, now=now, source=SOURCE)
        result["stored"], result["posts"] = len(rows), len(rows)
        state.update(last_attempt=now, last_error=failure, last_result=result)
        if not failure:
            state["last_sync"] = now
        _save(state)
        return result


# -- the daily pass -----------------------------------------------------------------------------------

def due(now=None):
    """Whether this account has connected YouTube analytics and a daily sync is owed."""
    now = time.time() if now is None else now
    state, info, granted = _link()
    if not state.get("google_account") or not granted:
        return False
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

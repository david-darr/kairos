"""Page-read analytics for TikTok and Instagram (Content Studio Team build spec, section 7: "a bot reads the numbers
from the signed-in pages in the Kairos Browser, read-only").

Until the person registers TikTok and Instagram apps for their APIs, Kairos reads each posted post's numbers (views,
watch time, likes, comments, shares, follows) from the page that shows them to its owner, with the person's own
sign-in in the Kairos Browser, and adds them to the scoring record as page-read snapshots (source "page-read").

The rules:
- Off until the person turns each platform on (Studio > Content > Channels). YouTube stays on its own API.
- Only the person's own posts: the page address is built from a post's recorded link on a channel they registered
  (a TikTok link must name that channel's handle, platforms.analytics_url), the page must still be on the platform
  after loading (a sign-in page means signed out), and it must show the channel's handle, or nothing is stored.
  Never a search, a listing, a profile or anyone else's page.
- Read-only: the desktop app loads the page in a hidden window on the account's Browse profile, waits, and returns
  the page's visible text (electron/studio-pages.js). It clicks nothing, types nothing and fills nothing.
- Rate-limited: one page at a time, at least MIN_GAP_S between pages, at most MAX_PER_DAY pages a day per platform,
  each post at most once every POST_EVERY_S, and only posts from the last MAX_AGE_DAYS days.
- It may break when a platform changes its page. A signed-out page pauses that platform for SIGNED_OUT_PAUSE_S;
  PARSE_FAILS_TO_PAUSE failed reads in a row pause it until the person presses Try again. Every read is logged.

The page layouts and labels below are from general knowledge (2026-11), not checked against the real pages.
"""
import asyncio
import json
import re
import secrets
import time
from typing import Optional

from core import accounts

from . import platforms

MIN_GAP_S = 20
MAX_PER_DAY = 40
POST_EVERY_S = 20 * 3600
MAX_AGE_DAYS = 60
MAX_PER_PASS = 10
SIGNED_OUT_PAUSE_S = 6 * 3600
PARSE_FAILS_TO_PAUSE = 3
JOB_SECONDS = 60
MAX_TEXT = 200_000
DAY = 86400.0
LOOK_EVERY_S = 1800      # the scheduler looks every half hour; each post is still read at most once in 20 hours

SOURCE = "page-read"
NOTE = ("Read from your signed-in pages in the Kairos Browser, read-only. It may stop working when "
        "TikTok or Instagram change their pages; the numbers are only as good as what the page showed.")

LOGIN_PATH = re.compile(r"/(login|accounts/login|signup|challenge|checkpoint)\b", re.I)


class Unavailable(RuntimeError):
    pass


# -- the bridge to the desktop app (same per-launch token as the design render worker) --------------------------

_queue: Optional[asyncio.Queue] = None
_pending: dict = {}
_workers = 0
_one_at_a_time: Optional[asyncio.Lock] = None


def token_ok(value):
    from core import design_render_bridge
    return design_render_bridge.token_ok(value)


def available():
    return _workers > 0


def _q():
    global _queue
    if _queue is None:
        _queue = asyncio.Queue()
    return _queue


async def worker_stream():
    """The SSE body the desktop app reads: one `data:` line per page to read."""
    global _workers
    queue = _q()
    _workers += 1
    try:
        yield ": connected\n\n"
        while True:
            try:
                job = await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            future = _pending.get(job["id"])
            if future is None or future.done():
                continue
            yield f"data: {json.dumps(job)}\n\n"
    finally:
        _workers -= 1


def complete(job_id, body, error=None):
    future = _pending.get(job_id)
    if future is None or future.done():
        return False
    if error:
        future.set_exception(Unavailable(str(error)[:300]))
        return True
    try:
        data = json.loads(body or b"{}")
        if not isinstance(data, dict):
            raise ValueError
        page = {"url": str(data.get("url") or "")[:2000], "title": str(data.get("title") or "")[:500],
                "text": str(data.get("text") or "")[:MAX_TEXT]}
    except ValueError:
        future.set_exception(Unavailable("the desktop app sent something that is not a page read"))
        return True
    future.set_result(page)
    return True


def browse_profile():
    """The Browse profile of the current account (the same rule as GET /api/browse/profile)."""
    account_id = accounts.effective_account()
    return "default" if account_id == accounts.local_account() else account_id


async def read_page(profile, platform, url):
    """One page's visible text, read by the desktop app with that profile's sign-in. Raises Unavailable."""
    global _one_at_a_time
    if not available():
        raise Unavailable("Page reads need the Kairos desktop app open.")
    if _one_at_a_time is None:
        _one_at_a_time = asyncio.Lock()
    async with _one_at_a_time:
        job_id = secrets.token_hex(8)
        future = asyncio.get_running_loop().create_future()
        _pending[job_id] = future
        await _q().put({"id": job_id, "profile": profile, "platform": platform, "url": url})
        try:
            return await asyncio.wait_for(future, timeout=JOB_SECONDS)
        except asyncio.TimeoutError:
            raise Unavailable("The desktop app did not finish reading the page in time.") from None
        finally:
            _pending.pop(job_id, None)


# -- reading numbers off the page ---------------------------------------------------------------------------------

# Label variants per number, as the creator pages show them (English UI). The value is on the same line after the
# label, or on the next line that has one.
LABELS = {
    "tiktok": {
        "views": ("video views", "views", "total views"),
        "total_play_s": ("total play time", "total watch time"),
        "avg_view_duration_s": ("average watch time", "avg. watch time", "average time watched"),
        "likes": ("likes",), "comments": ("comments",), "shares": ("shares",),
        "follows_gained": ("new followers", "followers gained", "follows"),
        "video_length_s": ("video length", "duration"),
    },
    "instagram": {
        "views": ("views", "plays", "reel plays"),
        "total_play_s": ("watch time", "total watch time"),
        "avg_view_duration_s": ("average watch time", "avg. watch time"),
        "likes": ("likes",), "comments": ("comments",), "shares": ("shares",),
        "follows_gained": ("follows", "new followers"),
        "video_length_s": ("video length", "duration"),
    },
}
DURATIONS = {"total_play_s", "avg_view_duration_s", "video_length_s"}
_NUMBER = re.compile(r"^\s*([0-9][0-9.,]*)\s*([kmb])?\b", re.I)
_DURATION_PARTS = re.compile(r"(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b", re.I)
_CLOCK = re.compile(r"^\s*(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)\b")


def number(text):
    """'1.2K' -> 1200, '12,345' -> 12345, '3.4M' -> 3400000. None when the text does not start with a number."""
    match = _NUMBER.match(text or "")
    if not match:
        return None
    raw, suffix = match.group(1), (match.group(2) or "").lower()
    try:
        # '1,2K' is a decimal comma; '12,345' is a thousands separator.
        value = float(raw.replace(",", ".")) if suffix and "," in raw and "." not in raw else float(raw.replace(",", ""))
    except ValueError:
        return None
    return int(round(value * {"": 1, "k": 1e3, "m": 1e6, "b": 1e9}[suffix]))


def duration(text):
    """'7.3s' -> 7.3, '1m 5s' -> 65, '2h 3m' -> 7380, '0:07' -> 7. None when it is not a duration."""
    text = (text or "").strip()
    clock = _CLOCK.match(text)
    if clock:
        return (int(clock.group(1) or 0) * 3600) + int(clock.group(2)) * 60 + float(clock.group(3))
    parts = _DURATION_PARTS.findall(text)
    if not parts or not re.match(r"^\s*\d", text):
        return None
    total = 0.0
    for value, unit in parts:
        unit = unit.lower()
        total += float(value) * (3600 if unit.startswith("h") else 60 if unit.startswith("m") else 1)
    return round(total, 2)


def _value(key, text):
    return duration(text) if key in DURATIONS else number(text)


def parse(platform, text):
    """The numbers a creator page shows, {key: value} for each label found. Exact label lines only, so a caption that
    happens to say 'likes' is not read as a number."""
    lines = [line.strip() for line in (text or "").splitlines()]
    lines = [line for line in lines if line]
    found = {}
    for key, labels in LABELS[platform].items():
        for i, line in enumerate(lines):
            low = line.lower().rstrip(":")
            hit = next((l for l in labels if low == l or low.startswith(l + " ") or low.startswith(l + ":")), None)
            if hit is None:
                continue
            rest = line[len(hit):].lstrip(" :\t")
            value = _value(key, rest) if rest else None
            if value is None:
                for nxt in lines[i + 1:i + 3]:
                    value = _value(key, nxt)
                    if value is not None:
                        break
            if value is not None:
                found[key] = value
                break
    if "avg_view_duration_s" not in found and found.get("total_play_s") and found.get("views"):
        found["avg_view_duration_s"] = round(found["total_play_s"] / found["views"], 2)
    return found


def signed_out(platform, page):
    """True when the read landed on a sign-in page (or left the platform)."""
    from urllib.parse import urlsplit
    url = page.get("url") or ""
    if not platforms.host_ok(platform, url):
        return True
    return bool(LOGIN_PATH.search(urlsplit(url).path))


def shows_handle(page, handle):
    """The page must name the channel the post belongs to (the creator pages show the signed-in account's name)."""
    plain = platforms.plain_handle(handle)
    return bool(plain) and re.search(r"(?<![\w.])@?" + re.escape(plain) + r"(?![\w])", (page.get("text") or "").lower()) is not None


# -- the pass -------------------------------------------------------------------------------------------------------

def _length(store, post):
    prep = store.preparation_for(post["id"])
    seconds = ((prep or {}).get("package") or {}).get("file", {}).get("seconds")
    if seconds:
        return float(seconds)
    try:
        from . import prepare
        found, _ = prepare.candidates(post["render_ref"])
        measured = prepare.probe(found[0]["path"]) or {}
        return measured.get("seconds")
    except Exception:  # noqa: BLE001 - no render on disk: the page's own length is used if it shows one
        return None


def status(store, now=None):
    """Per platform: on or off, reads today, the last read, and whether reading is paused and why."""
    now = time.time() if now is None else now
    on = store.settings()["page_reads"]
    resets = store.settings()["page_reads_reset"]
    out = {}
    for platform in platforms.PAGE_READ_PLATFORMS:
        rows = store.page_reads(platform, limit=50)
        today = [r for r in store.page_reads(platform, since=now - DAY, limit=MAX_PER_DAY + 10) if r["status"] != "unavailable"]
        paused, why = _paused(rows, resets.get(platform, 0), now)
        last = rows[0] if rows else None
        out[platform] = {"on": bool(on.get(platform)), "name": platforms.rules(platform)["name"], "reads_today": len(today),
                         "max_per_day": MAX_PER_DAY, "last": last, "paused_until": paused, "paused": why,
                         "posts": len(_due(store, platform, now, ignore_spacing=True))}
    return {"platforms": out, "note": NOTE, "rules_note": platforms.RULES_NOTE, "desktop": available()}


def _paused(rows, reset_at, now):
    """(until, reason): signed out recently, or several failed reads in a row since the last Try again."""
    recent = [r for r in rows if r["at"] > reset_at and r["status"] != "unavailable"]
    if recent and recent[0]["status"] == "signed_out" and now - recent[0]["at"] < SIGNED_OUT_PAUSE_S:
        return recent[0]["at"] + SIGNED_OUT_PAUSE_S, "signed_out"
    streak = 0
    for row in recent:
        if row["status"] != "parse_failed":
            break
        streak += 1
    if streak >= PARSE_FAILS_TO_PAUSE:
        return None, "page_changed"
    return None, ""


def _due(store, platform, now, ignore_spacing=False):
    posts = [p for p in store.list_posts(state="posted") if p["platform"] == platform and p.get("posted_url")
             and (p.get("posted_at") or 0) > now - MAX_AGE_DAYS * DAY]
    if ignore_spacing:
        return posts
    out = []
    for post in posts:
        # A signed-out or desktop-closed attempt read nothing: the pause rules handle those, not the spacing.
        last = next((r for r in store.page_reads(platform, post_id=post["id"], limit=10)
                     if r["status"] not in ("unavailable", "signed_out")), None)
        if last is None or now - last["at"] >= POST_EVERY_S:
            out.append(post)
    return sorted(out, key=lambda p: p.get("posted_at") or 0, reverse=True)


async def read_due(store, platform, now=None, reader=None, sleep=None, force=False, limit=MAX_PER_PASS):
    """Reads the platform's due posts within the limits and stores what the pages show. Returns a summary
    {read, stored, skipped, statuses, stopped}. `force` is the person's Read now: it skips the off switch's
    schedule check only, never the limits, the pauses or the ownership checks."""
    clock = (lambda: now) if now is not None else time.time
    if platform not in platforms.PAGE_READ_PLATFORMS:
        raise ValueError("page reads are for TikTok and Instagram; YouTube's numbers come from its API")
    settings = store.settings()
    summary = {"platform": platform, "read": 0, "stored": 0, "statuses": {}, "stopped": ""}
    if not settings["page_reads"].get(platform):
        summary["stopped"] = "off"
        return summary
    until, why = _paused(store.page_reads(platform, limit=50), settings["page_reads_reset"].get(platform, 0), clock())
    if why:
        summary["stopped"] = why
        return summary
    today = [r for r in store.page_reads(platform, since=clock() - DAY, limit=MAX_PER_DAY + 10) if r["status"] != "unavailable"]
    room = min(limit, MAX_PER_DAY - len(today))
    if room <= 0:
        summary["stopped"] = "daily_limit"
        return summary
    reader = reader or read_page
    sleep = sleep or asyncio.sleep
    profile = browse_profile()
    for index, post in enumerate(_due(store, platform, clock())[:room]):
        if index:
            await sleep(MIN_GAP_S)
        result = await _read_one(store, platform, post, profile, reader, clock())
        summary["read"] += result != "unavailable"
        summary["stored"] += result == "ok"
        summary["statuses"][result] = summary["statuses"].get(result, 0) + 1
        if result in ("unavailable", "signed_out"):
            summary["stopped"] = result
            break
        _, why = _paused(store.page_reads(platform, limit=50), settings["page_reads_reset"].get(platform, 0), clock())
        if why:
            summary["stopped"] = why
            break
    return summary


async def _read_one(store, platform, post, profile, reader, now):
    try:
        url = platforms.analytics_url(platform, post["posted_url"], post["handle"])
    except ValueError as exc:
        store.record_page_read(platform, "failed", post["id"], post.get("posted_url") or "", str(exc), now=now)
        return "failed"
    try:
        page = await reader(profile, platform, url)
    except Unavailable as exc:
        store.record_page_read(platform, "unavailable", post["id"], url, str(exc), now=now)
        return "unavailable"
    if signed_out(platform, page):
        store.record_page_read(platform, "signed_out", post["id"], url, f"Sign in to {platforms.rules(platform)['name']} in the Kairos Browser.", now=now)
        return "signed_out"
    if not shows_handle(page, post["handle"]):
        store.record_page_read(platform, "not_yours", post["id"], url,
                               f"The page did not show {post['handle']}; nothing was stored.", now=now)
        return "not_yours"
    numbers = parse(platform, page.get("text"))
    if "views" not in numbers:
        signin = re.search(r"\b(log in|sign in)\b", (page.get("text") or "")[:3000], re.I) and len(numbers) == 0
        status = "signed_out" if signin else "parse_failed"
        store.record_page_read(platform, status, post["id"], url,
                               "The page showed no view count; the page may have changed." if status == "parse_failed"
                               else f"Sign in to {platforms.rules(platform)['name']} in the Kairos Browser.", now=now)
        return status
    length = _length(store, post) or numbers.get("video_length_s")
    if not length:
        store.record_page_read(platform, "parse_failed", post["id"], url, "The video's length is unknown, so watch time cannot be scored.", now=now)
        return "parse_failed"
    try:
        snap = store.add_snapshot(post["id"], numbers["views"], float(numbers.get("avg_view_duration_s") or 0.0), float(length),
                                  likes=numbers.get("likes", 0), comments=numbers.get("comments", 0), shares=numbers.get("shares", 0),
                                  follows_gained=numbers.get("follows_gained", 0), taken_at=now, source=SOURCE, now=now)
    except Exception as exc:  # noqa: BLE001 - a number the record refuses is logged, never half-stored
        store.record_page_read(platform, "failed", post["id"], url, f"Not stored: {getattr(exc, 'detail', exc)}", now=now)
        return "failed"
    found = ", ".join(k for k in ("views", "avg_view_duration_s", "likes", "comments", "shares", "follows_gained") if k in numbers)
    store.record_page_read(platform, "ok", post["id"], url, f"Read {found}.", snapshot_id=snap["id"], now=now)
    return "ok"


def try_again(store, platform, now=None):
    """The person's Try again after a pause: reads resume from now."""
    if platform not in platforms.PAGE_READ_PLATFORMS:
        raise ValueError("page reads are for TikTok and Instagram")
    store.update_settings(page_reads_reset={platform: time.time() if now is None else now})
    return status(store, now)


_last_pass = {"at": 0.0}


async def read_all_due(now=None, store_for=None, reader=None, sleep=None):
    """The scheduled pass: every account, every platform it turned on. One account's trouble never stops the others."""
    from . import studio
    done = {}
    if not available() and reader is None:
        return done
    for account_id in accounts.all_accounts():
        with accounts.as_account(account_id):
            store = store_for() if store_for else studio
            try:
                for platform in platforms.PAGE_READ_PLATFORMS:
                    if store.settings()["page_reads"].get(platform):
                        done[f"{account_id}:{platform}"] = await read_due(store, platform, now, reader, sleep)
            except Exception as exc:  # noqa: BLE001 - recorded, never raised into the scheduler
                done[account_id] = f"failed: {exc}"
    _last_pass["at"] = time.time()
    return done

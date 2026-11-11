"""Hands-off posting (David, 2026-11-11: "yes fully hands off posting"; this changes the locked "every post waits for
David's OK" rule, for a team he switched it on for).

Off by default, and on only by the person's own click (Studio > Content > Settings, the team's menu in Bots, or the
choice in the team import). While on:
- The Producer approves its own team's posts (content_studio_approve_post), each recorded as approved by the
  Producer with its reason; the policy checks already ran when the post was queued.
- Approved YouTube and Instagram posts go out on their own, on schedule, through the person's connected app
  (publish_due, from the scheduler every few minutes), at most the niche's slots a day per channel (about one).
  YouTube may keep an upload private on an unaudited Google project; that message is kept and reported.
- TikTok never posts on its own: TikTok's Direct Post rules need the creator's own choice of who can see each post
  and their consent, so an approved TikTok post waits in "Needs your tap" and the Producer mentions it.
- Prepare post (the upload page) stays a manual step.

Safeguards that hold either way: the AI label (each publisher sets it), the monthly spend cap (warn at 80 percent,
stop at 100: bots stop and nothing is posted), a platform warning pauses that channel at once and alerts the person,
a channel retirement still asks the person, the honesty rules in policy.py, and Pause team: one switch that stops
posting and approving at once (and, for the team's bots, every step that is not a read, core/bot_policy.py).

The Producer's updates are batched (send_updates): one Inbox note and one Reach me message per pass that carries
everything new (platform warnings, spend thresholds, a step failing again and again, a retirement proposal, TikTok taps
waiting, an Instagram post that needs its AI label turned on in the app). Never one message per post; the weekly
report carries what posted.
"""
from __future__ import annotations

import time
import uuid

from . import pipeline, team
from .store import StudioError, conflict

DAY = 86400.0
AUTO_PLATFORMS = ("youtube", "instagram")
FAILS_BEFORE_ALERT = 3
LOOK_EVERY_S = 300


def state(store) -> dict:
    s = store.settings()
    return {"on": bool(s["hands_off"]), "paused": bool(s["team_paused"]), "since": s["hands_off_since"],
            "by": s["hands_off_by"], "taps": len(tiktok_taps(store)) if s["hands_off"] else 0}


def set_hands_off(store, on: bool, by: str, now=None) -> dict:
    """Only the person's click calls this (a route with their sign-in); no bot tool does."""
    if not isinstance(on, bool):
        raise StudioError("hands_off is true or false")
    now = time.time() if now is None else now
    store.update_settings(hands_off=on, hands_off_since=now if on else None, hands_off_by=by if on else None)
    _sync_team(store, hands_off=on)
    return state(store)


def set_paused(store, paused: bool, by: str = "", now=None) -> dict:
    """Pause team: posting and approving stop at once, and the team's bots may only read until resumed."""
    if not isinstance(paused, bool):
        raise StudioError("paused is true or false")
    store.update_settings(team_paused=paused)
    _sync_team(store, paused=paused)
    return state(store)


def _sync_team(store, **fields):
    """Mirror the switch onto the bots' team record (services/bot_departments.py), so Bots shows it and bot_policy
    holds the team's bots while paused."""
    try:
        from services import bot_departments
        producer = team.producer_id(store)
        found = bot_departments.team_of(producer) if producer else None
        if found:
            bot_departments.set_flags(found["id"], found.get("owner_user"), **fields)
    except Exception:
        pass


def tiktok_taps(store) -> list:
    """Approved TikTok posts: each waits for the person's own tap (TikTok's rules), never posted for them."""
    return [p for p in store.list_posts(state="approved") if p["platform"] == "tiktok"]


def _check_on(store):
    s = store.settings()
    if not s["hands_off"]:
        raise conflict("hands-off posting is off, so the person approves each post")
    if s["team_paused"]:
        raise conflict("the team is paused")


def producer_approve(store, post_id, producer_name: str, reason: str, now=None) -> dict:
    """The Producer's approval while hands-off is on. Refused when it is off or the team is paused; the store refuses
    a paused or archived channel."""
    _check_on(store)
    reason = (reason or "").strip()
    if not reason:
        raise StudioError("say why the post is ready, in a sentence")
    if _capped():
        raise conflict("the monthly spend cap is reached, so the team has stopped")
    approved = store.approve(post_id, by=f"Producer ({producer_name})", now=now)
    store.add_evidence(post_id, "producer_approval", {"by": producer_name, "reason": reason[:500], "hands_off": True}, now=now)
    return approved


def _capped(spend=None) -> bool:
    state_ = spend() if spend else pipeline._default_spend()
    return bool(state_ and state_.get("capped"))


def _posted_today(store, channel_id, now) -> int:
    return sum(1 for p in store.list_posts(state="posted", channel_id=channel_id) if (p.get("posted_at") or 0) > now - DAY)


def gate(store, post_id, now=None, spend=None, require_hands_off=True):
    """Why this post may not go out now, or None. The one gate every bot-made post passes, from the scheduler or from
    the Publisher's own tool, and again just before the irreversible call (review finding, 2026-11-11): the team is
    running (and hands-off on, for an automatic post), the post is approved for an automatic platform, its channel is
    live, unpaused and has no open warning, the spend cap is not reached, its schedule has come, and the channel has
    a slot left today (the niche's slots, about one a day)."""
    now = time.time() if now is None else now
    s = store.settings()
    if s["team_paused"]:
        return "The team is paused, so nothing is posted until the person resumes it."
    if require_hands_off and not s["hands_off"]:
        return "Hands-off posting is off, so the person posts."
    post = store.get_post(post_id)
    if post["state"] != "approved":
        return "Only an approved post goes out."
    if post["platform"] not in AUTO_PLATFORMS:
        return "TikTok waits for the person's own tap."
    channel = store.get_channel(post["channel_id"])
    if channel["status"] != "live" or channel["paused"]:
        return "That channel is archived or paused."
    if any(w["channel_id"] == channel["id"] for w in store.open_warnings()):
        return "That channel has an open platform warning."
    if _capped(spend):
        return "The monthly spend cap is reached, so the team has stopped."
    prep = store.preparation_for(post_id)
    if prep and prep.get("scheduled_at") and prep["scheduled_at"] > now:
        return "Its scheduled time has not come yet."
    slots = max(1, int((store.get_niche(channel["niche_id"]) or {}).get("slots") or 1))
    if _posted_today(store, channel["id"], now) >= slots:
        return f"{channel['handle']} already posted its {slots} for today."
    return None


def due(store, now=None, spend=None) -> list:
    """Approved posts that pass the gate now, at most one per channel per pass (the gate counts posted ones)."""
    now = time.time() if now is None else now
    s = store.settings()
    if not s["hands_off"] or s["team_paused"]:
        return []
    out, seen = [], set()
    for post in sorted(store.list_posts(state="approved"), key=lambda p: (p.get("approved_at") or 0, p["id"])):
        if post["channel_id"] in seen or gate(store, post["id"], now, spend) is not None:
            continue
        seen.add(post["channel_id"])
        out.append(post)
    return out


def guard_for(store, post_id, spend=None, require_hands_off=True, now=None):
    """The check a publisher runs immediately before its irreversible call: the gate, read fresh (at the pass's own
    time when the scheduler gave one, else the clock)."""
    return lambda: gate(store, post_id, now=now, spend=spend, require_hands_off=require_hands_off)


async def _publish_youtube(store, post_id, by, guard=None):
    from . import youtube_publish
    return await youtube_publish.publish(store, post_id, by, guard=guard)


async def _publish_instagram(store, post_id, by, guard=None):
    from . import instagram_api
    return await instagram_api.publish(store, post_id, by, guard=guard)


PUBLISHERS = {"youtube": _publish_youtube, "instagram": _publish_instagram}


def _publisher_name(store) -> str:
    try:
        from services.agent_service import agent_service
        ident = next(iter(team.bots_with(store, "publisher")), None)
        return (agent_service.get(ident) or {}).get("name") or "Publisher"
    except Exception:
        return "Publisher"


async def publish_due(store, now=None, publishers=None, spend=None) -> list:
    """Post what is due, one at a time. Each post's outcome is kept; a post that fails again and again is raised once
    in the Producer's next update. The kill switch is read again before every post."""
    now = time.time() if now is None else now
    publishers = publishers or PUBLISHERS
    results = []
    by = _publisher_name(store)
    for post in due(store, now, spend):
        s = store.settings()
        if gate(store, post["id"], now, spend) is not None:
            continue  # paused, switched off, warned or capped since the list was made: read again for every post
        failures = dict(s["hands_off_failures"])
        try:
            outcome = await publishers[post["platform"]](store, post["id"], by, guard=guard_for(store, post["id"], spend, now=now))
            failures.pop(str(post["id"]), None)
            note = (outcome or {}).get("note") or ""
            results.append({"post_id": post["id"], "ok": True, "platform": post["platform"], "note": note})
            if post["platform"] == "instagram" and outcome and outcome.get("ai_label_by_api") is False:
                _remember_alert(store, f"ai_label:{post['id']}", "label",
                                f"Instagram did not take the AI label for \"{post['title']}\" through its API. "
                                "Turn it on for that Reel in the Instagram app.")
            if note and post["platform"] == "youtube":
                _remember_alert(store, f"yt_note:{post['id']}", "note", f"YouTube: \"{post['title']}\". {note}", urgent=False)
        except Exception as error:  # noqa: BLE001 - kept and reported, never raised into the scheduler
            detail = getattr(error, "detail", None) or str(error) or type(error).__name__
            failures[str(post["id"])] = failures.get(str(post["id"]), 0) + 1
            results.append({"post_id": post["id"], "ok": False, "platform": post["platform"], "error": detail})
            if failures[str(post["id"])] >= FAILS_BEFORE_ALERT:
                _remember_alert(store, f"publish_failed:{post['id']}", "failing",
                                f"Posting \"{post['title']}\" to {post['platform']} failed {failures[str(post['id'])]} times: {detail}")
        store.update_settings(hands_off_failures=failures)
    return results


# -- the Producer's updates ------------------------------------------------------------------------------------

def _remember_alert(store, key, kind, text, urgent=True):
    pending = dict(store.settings()["hands_off_alerts"])
    pending.setdefault(key, {"kind": kind, "text": text[:600], "urgent": urgent, "at": time.time()})
    store.update_settings(hands_off_alerts=pending)


def collect(store, now=None, spend=None) -> list:
    """Everything the person should hear about now, each with a key so it is said once."""
    now = time.time() if now is None else now
    found = []
    month = time.strftime("%Y-%m", time.gmtime(now))
    for finding in pipeline.watch(store, now, spend):
        kind = finding["kind"]
        if kind == "platform_warning":
            found.append({"key": f"platform_warning:{finding.get('warning_id')}", "kind": kind, "text": finding["message"]})
        elif kind in ("spend_near_cap", "spend_capped"):
            found.append({"key": f"{kind}:{month}", "kind": kind, "text": finding["message"]})
        elif kind in ("render_failed", "rejected_twice"):
            found.append({"key": f"{kind}:{finding.get('post_id')}", "kind": "failing", "text": finding["message"]})
    for decision in store.list_decisions():
        if decision["kind"] == "retire" and decision["status"] in ("open", "awaiting_user"):
            found.append({"key": f"retire:{decision['id']}", "kind": "retirement",
                          "text": f"A retirement is proposed for {decision['subject_name']}: {decision['reason'] or 'see the numbers'}. "
                                  "It needs your OK in Studio > Content."})
    taps = tiktok_taps(store)
    if taps:
        ids = ",".join(str(p["id"]) for p in taps)
        found.append({"key": f"tiktok_taps:{ids}", "kind": "taps",
                      "text": f"{len(taps)} TikTok post{'s' if len(taps) != 1 else ''} need{'' if len(taps) != 1 else 's'} your tap "
                              "(TikTok asks you to choose who can see each one): Studio > Content > Publishing."})
    for key, row in store.settings()["hands_off_alerts"].items():
        found.append({"key": key, "kind": row["kind"], "text": row["text"]})
    return found


def inbox_and_message(bot_id, title, body, urgent=False):
    """The default delivery: one Inbox note, and one message through Reach me (the person's own order and limits)."""
    from services.content_studio import delivery
    delivered = delivery.inbox_notifier(bot_id, title, body, urgent)
    try:
        import asyncio
        from core import accounts
        from services import reach_me
        coro = reach_me.message_me(accounts.effective_account(), bot_id, f"{title}: {body}"[:1000], "cs-" + uuid.uuid4().hex[:16])
        try:
            asyncio.get_running_loop().create_task(coro)
        except RuntimeError:
            asyncio.run(coro)
    except Exception:
        pass  # Reach me off or not set up: the Inbox note stands
    return delivered


def send_updates(store, now=None, spend=None, deliver=None) -> list:
    """One batched update with everything new since the last one. Returns what was sent (empty: nothing new)."""
    now = time.time() if now is None else now
    with store.lock:
        seen = dict(store.settings()["notified"])
        fresh = [f for f in collect(store, now, spend) if f["key"] not in seen]
        if not fresh:
            return []
        producer = team.producer_id(store)
        if not producer:
            return []
        lines = "\n".join(f"- {f['text']}" for f in fresh)
        title = "Content Studio: " + ("1 thing for you" if len(fresh) == 1 else f"{len(fresh)} things for you")
        if (deliver or inbox_and_message)(producer, title, lines):
            for f in fresh:
                seen[f["key"]] = now
            store.update_settings(notified=seen, hands_off_alerts={})
            return fresh
    return []


async def tick(store, now=None, publishers=None, spend=None, deliver=None) -> dict:
    """One pass for one account: post what is due, then send the batched update."""
    if not store.settings()["hands_off"]:
        return {"posted": [], "sent": []}
    posted = await publish_due(store, now, publishers, spend)
    return {"posted": posted, "sent": send_updates(store, now, spend, deliver)}


async def tick_all_due(store_for=None):
    from core import accounts
    from . import studio
    done = {}
    for account_id in accounts.all_accounts():
        with accounts.as_account(account_id):
            store = store_for() if store_for else studio
            try:
                done[account_id] = await tick(store)
            except Exception as exc:  # noqa: BLE001 - recorded, never raised into the scheduler
                done[account_id] = f"failed: {exc}"
    return done

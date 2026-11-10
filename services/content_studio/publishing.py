"""The publishing dashboard (Content Studio Team build spec, section 4 "the publishing dashboard"; Studio > Content >
Publishing): every post across channels and platforms, its state, schedule, live link and the next action, plus the
week each post falls in for the calendar.

States, derived from the post and its prepared package so the view cannot drift from the record:
- drafted: the team is still making it (its step and owner say where);
- awaiting_approval: it waits for the person's OK;
- approved: approved, not prepared yet (the Publisher prepares it, or the person presses Prepare post);
- prepared: everything is assembled for its platform; the person opens the upload page (or posts to YouTube);
- waiting_for_you: the upload page is open and filled; the person checks it and presses Post;
- posted: live, with its link; its numbers are tracked;
- failed: a route failed (YouTube refused the upload, the page could not be filled), with the reason;
- rejected: the person turned it down (it goes back to drafting with Redraft).
"""
import time

from . import pipeline, platforms

STATES = ("drafted", "awaiting_approval", "approved", "prepared", "waiting_for_you", "posted", "failed", "rejected")
LABELS = {"drafted": "Drafted", "awaiting_approval": "Waiting for your approval", "approved": "Approved",
          "prepared": "Prepared", "waiting_for_you": "Waiting for you to press Post", "posted": "Posted",
          "failed": "Failed", "rejected": "Rejected"}
DAY = 86400.0


def state_of(post, prep):
    if post["state"] in ("drafted", "awaiting_approval", "rejected", "posted"):
        return post["state"]
    if not prep:
        return "approved"
    return {"prepared": "prepared", "waiting_for_you": "waiting_for_you", "failed": "failed", "posted": "posted"}[prep["state"]]


def next_action(state, post, prep, step=None):
    """(who, what): the next thing that has to happen, said plainly."""
    name = platforms.rules(post["platform"])["name"]
    button = platforms.rules(post["platform"])["post_button"]
    if state == "drafted":
        where = {"script": "Script Writer writes the script", "render": "Editor renders the video",
                 "queue": "Producer puts it in the approval queue"}.get(step or "", "the team finishes it")
        return "team", f"The {where}."
    if state == "awaiting_approval":
        return "you", "Approve, edit or reject it in Approvals."
    if state == "approved":
        return "team", f"The Publisher prepares it for {name}, or press Prepare post."
    if state == "prepared":
        problems = (prep.get("package") or {}).get("problems") or []
        if problems:
            return "you", problems[0]
        if prep.get("route") == "api":
            return "you", "Press Post to YouTube, or Open upload page to post it yourself."
        return "you", f"Press Open upload page: Kairos fills the {name} page and stops before {button}."
    if state == "waiting_for_you":
        return "you", f"Check the {name} page and press {button} yourself, then paste the live link (Mark posted)."
    if state == "failed":
        return "you", f"Fix it and try again: {prep.get('error') or 'the route failed'}"
    if state == "posted":
        return "team", "Its numbers are tracked."
    return "you", "Redraft it or leave it."


def week_start(at):
    """Monday 00:00 local time of the week `at` falls in."""
    t = time.localtime(at)
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday - t.tm_wday, 0, 0, 0, 0, 0, -1))  # mktime rolls the day back over months


def dashboard(store, now=None):
    """Every post with its state and next action, newest first, and the counts per state."""
    now = time.time() if now is None else now
    preps = {p["post_id"]: p for p in store.list_preparations()}
    steps = {i["id"]: i for i in pipeline.pipeline(store, now) if i["kind"] == "post"}
    items, counts = [], {s: 0 for s in STATES}
    for post in reversed(store.list_posts()):
        prep = preps.get(post["id"])
        state = state_of(post, prep)
        counts[state] += 1
        who, what = next_action(state, post, prep or {}, (steps.get(post["id"]) or {}).get("step"))
        package = (prep or {}).get("package") or {}
        scheduled = (prep or {}).get("scheduled_at")
        # The day the post sits on in the calendar: when it went up, when it is scheduled, else when it was approved
        # or made. A post with no date of its own yet sits on its creation day.
        when = post.get("posted_at") or scheduled or post.get("approved_at") or post["created_at"]
        items.append({
            "post_id": post["id"], "title": post["title"], "platform": post["platform"],
            "platform_name": platforms.rules(post["platform"])["name"], "handle": post["handle"], "channel_id": post["channel_id"],
            "niche": post["niche_name"], "long_form": bool(post.get("long_form")), "state": state, "state_label": LABELS[state],
            "next": {"who": who, "what": what}, "scheduled_at": scheduled, "posted_at": post.get("posted_at"),
            "posted_url": post.get("posted_url"), "approved_at": post.get("approved_at"), "created_at": post["created_at"],
            "when": when, "when_kind": "posted" if post.get("posted_at") else "scheduled" if scheduled else "approved" if post.get("approved_at") else "made",
            "week": week_start(when),
            "prep_id": (prep or {}).get("id"), "route": (prep or {}).get("route"), "routes": package.get("routes", []),
            "problems": package.get("problems", []), "error": (prep or {}).get("error") or "",
            "fill": (prep or {}).get("fill") or {}, "checklist": package.get("checklist", []),
            "rejection_count": post["rejection_count"]})
    return {"items": items, "counts": counts, "labels": LABELS, "now": now, "this_week": week_start(now)}

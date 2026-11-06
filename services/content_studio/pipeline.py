"""The pipeline view: each idea's step, owner bot, age and status (spec section 8), and the Producer's watch (section 4).

The step is derived from the post's own fields, so the view cannot drift from the record. Owners are team roles,
or "user" for the approval step. The watch is one plain function the team's routine can call; it returns
findings and does nothing else (no loop is wired here).
"""
import time

HOUR = 3600.0
TERMINAL_STEPS = ("tracking", "rejected")


def _step(post):
    state = post["state"]
    if state == "drafted":
        if not post["script_ref"]:
            return "script", "script_writer", "working"
        if post["render_status"] == "failed":
            return "render", "editor", "failed"
        if post["render_status"] != "ok":
            return "render", "editor", "working"
        return "queue", "producer", "ready"
    return {"awaiting_approval": ("approval", "user", "waiting"), "approved": ("publish", "publisher", "waiting"),
            "rejected": ("rejected", "producer", "rejected"), "posted": ("tracking", "executor", "posted")}[state]


def pipeline(store, now=None):
    """Every live idea: topics not yet made into a post (step pick, with the Evaluator) and every post."""
    now = time.time() if now is None else now
    windows = store.settings()["step_windows_h"]
    items = []
    posts = store.list_posts()
    used = {p["topic_id"] for p in posts if p["topic_id"] is not None}
    live = {n["id"]: n for n in store.list_niches("live")}
    for topic in store.list_topics():
        if topic["id"] in used or topic["niche_id"] not in live:
            continue
        items.append({"kind": "topic", "id": topic["id"], "title": topic["title"], "niche_id": topic["niche_id"],
                      "niche_name": live[topic["niche_id"]]["name"], "channel_id": None, "platform": None, "step": "pick",
                      "owner": "evaluator", "status": "candidate", "age_h": round((now - topic["created_at"]) / HOUR, 2),
                      "in_step_h": round((now - topic["created_at"]) / HOUR, 2), "window_h": windows.get("pick"),
                      "source": topic["source"]})
    for post in posts:
        step, owner, status = _step(post)
        in_step = (now - post["step_since"]) / HOUR
        window = windows.get(step)
        items.append({"kind": "post", "id": post["id"], "title": post["title"], "niche_id": post["niche_id"],
                      "niche_name": post["niche_name"], "channel_id": post["channel_id"], "platform": post["platform"],
                      "step": step, "owner": owner, "status": status, "state": post["state"],
                      "age_h": round((now - post["created_at"]) / HOUR, 2), "in_step_h": round(in_step, 2), "window_h": window,
                      "rejection_count": post["rejection_count"], "posted_url": post["posted_url"],
                      "overdue": bool(window and step not in TERMINAL_STEPS and status != "failed" and in_step > window)})
    return items


def approval_queue(store):
    return store.list_posts(state="awaiting_approval")


def watch(store, now=None, spend=None):
    """The Producer's watch. Findings only; `spend` is an optional callable returning the spend state
    ({capped, near_cap, spent_usd, monthly_usd}), defaulting to the bots spend cap for this account."""
    now = time.time() if now is None else now
    findings = []

    def add(kind, severity, message, **ref):
        findings.append({"kind": kind, "severity": severity, "message": message, "notify_user": severity == "urgent", **ref})

    for warning in store.open_warnings():
        add("platform_warning", "urgent", f"{warning['platform']} warned {warning['handle']}: {warning['text']} The channel is paused.",
            channel_id=warning["channel_id"])
    for item in pipeline(store, now):
        if item["kind"] != "post":
            continue
        ref = {"post_id": item["id"], "channel_id": item["channel_id"]}
        if item["status"] == "failed":
            add("render_failed", "warn", f"The render for \"{item['title']}\" failed.", owner=item["owner"], **ref)
        elif item["overdue"]:
            add("step_overdue", "info" if item["owner"] == "user" else "warn",
                f"\"{item['title']}\" has been at {item['step']} for {item['in_step_h']:.0f}h (window {item['window_h']:g}h).",
                owner=item["owner"], **ref)
        if item["rejection_count"] >= 2 and item["state"] != "posted":
            add("rejected_twice", "warn", f"\"{item['title']}\" has been rejected {item['rejection_count']} times.", **ref)
    state = spend() if spend else _default_spend()
    if state and state.get("capped"):
        add("spend_capped", "urgent", "The team's spend cap is reached; the bots have stopped.", spend=state)
    elif state and state.get("near_cap"):
        add("spend_near_cap", "warn", "Spend is near the monthly cap.", spend=state)
    return findings


def _default_spend():
    try:
        from services import bot_spend
        budget = bot_spend.budget()
        return {"capped": budget["capped"], "near_cap": budget["near_cap"], "spent_usd": budget["spent_usd"],
                "monthly_usd": budget["monthly_usd"]}
    except Exception:
        return None

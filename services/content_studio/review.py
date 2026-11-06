"""Natural selection (spec section 5): the scoreboard, the weekly review, and what confirming a proposal does.

The Executor's review only PROPOSES. A proposal is a row in `decisions` with its numbers; the Producer confirms
it, and a retirement that archives channels waits for the user's OK too (status awaiting_user). Nothing here
ever creates an account or deletes anything: retired means out of the rotation, history kept.
"""
import time

from . import scoring
from .store import DAY, StudioError, conflict

OPEN = ("proposed", "awaiting_user")


# -- the scoreboard ------------------------------------------------------------------------------

def post_scores(store, now):
    """(posted posts, {post_id: score row}) for every post that has a 7 day snapshot."""
    s = store.settings()
    posted = [p for p in store.list_posts(state="posted") if p["posted_at"] is not None and p["posted_at"] <= now]
    by_post = {}
    for snap in store.snapshots():
        if snap["taken_at"] <= now:
            by_post.setdefault(snap["post_id"], []).append(snap)
    items = []
    for post in posted:
        snap = scoring.seven_day_snapshot(post["posted_at"], by_post.get(post["id"], []), s["score_after_days"])
        if snap:
            items.append({"id": post["id"], "platform": post["platform"], **scoring.post_parts(snap, s["follow_weight"])})
    return posted, scoring.score_posts(items, s["weights"])


def _table(store, posted, scored, now, key_of):
    s = store.settings()
    return scoring.group_table(posted, scored, key_of, now, s["min_weeks"], s["min_posts"])


def _blank(posted_min_posts, min_weeks):
    return {"posts_posted": 0, "posts_scored": 0, "first_posted_at": None, "score": None, "age_days": 0, "eligible": False,
            "not_yet": f"0 of {posted_min_posts} posts with 7 day numbers; 0 of {min_weeks * 7} days"}


def scoreboard(store, now=None):
    now = time.time() if now is None else now
    s = store.settings()
    posted, scored = post_scores(store, now)
    blank = _blank(s["min_posts"], s["min_weeks"])

    niche_rows = _table(store, posted, scored, now, lambda p: p["niche_id"])
    niches = [{**blank, **niche_rows.get(n["id"], {}), "id": n["id"], "name": n["name"], "status": n["status"], "slots": n["slots"]}
              for n in store.list_niches()]
    strategies = {}
    for role, column in (("script_writer", "script_strategy_id"), ("evaluator", "evaluator_strategy_id")):
        rows = _table(store, posted, scored, now, lambda p, c=column: p[c])
        strategies[role] = [{**blank, **rows.get(st["id"], {}), "id": st["id"], "name": st["name"], "status": st["status"],
                             "is_default": bool(st["is_default"]), "parent_id": st["parent_id"]}
                            for st in store.list_strategies(role)]
    format_rows = _table(store, posted, scored, now, lambda p: p["format"])
    formats = sorted(({**{k: v for k, v in r.items() if k != "key"}, "name": r["key"]} for r in format_rows.values()),
                     key=lambda r: r["name"])
    for row in niches:
        row.pop("key", None)
    for rows in strategies.values():
        for row in rows:
            row.pop("key", None)
    titles = {p["id"]: p for p in posted}
    best = sorted(scored.items(), key=lambda kv: -kv[1]["score"])[:10]
    return {"at": now, "weights": s["weights"], "minimum": {"weeks": s["min_weeks"], "posts": s["min_posts"]},
            "niches": niches, "strategies": strategies, "formats": formats,
            "top_posts": [{"post_id": pid, "title": titles[pid]["title"], "platform": titles[pid]["platform"],
                           "niche": titles[pid]["niche_name"], "posted_url": titles[pid]["posted_url"], **row} for pid, row in best],
            "posts_scored": len(scored), "posts_posted": len(posted)}


# -- the weekly review ---------------------------------------------------------------------------

def _behind_before(store, subject_type, subject_id, reviews_needed):
    """True when the subject was marked behind in each of the last `reviews_needed` real reviews."""
    if reviews_needed <= 0:
        return True
    recent = store.recent_reviews(reviews_needed)
    if len(recent) < reviews_needed:
        return False
    for review in recent:
        mark = next((m for m in store.marks_for(review["id"]) if m["subject_type"] == subject_type and m["subject_id"] == subject_id), None)
        if not mark or not mark["behind"]:
            return False
    return True


def _has_open(store, kind, subject_type, subject_id):
    return any(d["subject_type"] == subject_type and d["subject_id"] == subject_id
               for d in store.list_decisions(kind=kind) if d["status"] in OPEN)


def run_review(store, now=None, dry_run=True, proposed_by="executor"):
    """The Executor's weekly review. dry_run returns what it would propose and records nothing; a real run
    records the review (so "two reviews running" can be counted) and files the proposals as decisions."""
    now = time.time() if now is None else now
    s = store.settings()
    if not dry_run:
        last = store.recent_reviews(1)
        if last and now - last[0]["at"] < s["review_gap_days"] * DAY:
            raise conflict(f"a review already ran {(now - last[0]['at']) / DAY:.1f} days ago; reviews are weekly")
    board = scoreboard(store, now)
    proposals, marks, notes = [], [], []

    # Content layer: niches.
    live = [n for n in board["niches"] if n["status"] == "live"]
    eligible = sorted((n for n in live if n["eligible"]), key=lambda n: (n["score"], n["id"]))
    median = scoring.median([n["score"] for n in eligible])
    threshold = None if median is None else s["behind_ratio"] * median
    for n in eligible:
        n["behind"] = len(eligible) >= 2 and n["score"] < threshold
        marks.append({"subject_type": "niche", "subject_id": n["id"], "score": n["score"], "median": median, "behind": n["behind"]})
    for n in live:
        if not n["eligible"]:
            notes.append(f"{n['name']}: not judged yet ({n['not_yet']})")
    if len(live) < 2 and eligible:
        notes.append("only one niche is live; nothing to retire it in favour of")
    elif eligible and eligible[0]["behind"]:
        loser = eligible[0]
        if not _behind_before(store, "niche", loser["id"], s["behind_reviews"] - 1):
            notes.append(f"{loser['name']} is behind the team median but has not been for {s['behind_reviews']} reviews running")
        elif _has_open(store, "retire", "niche", loser["id"]):
            notes.append(f"{loser['name']} already has a retirement waiting")
        else:
            winner = max((n for n in eligible if n["id"] != loser["id"]), key=lambda n: n["score"])
            channels = store.list_channels(niche_id=loser["id"], status="live")
            proposals.append({
                "kind": "retire", "subject_type": "niche", "subject_id": loser["id"], "subject_name": loser["name"],
                "reason": f"Below {s['behind_ratio']:.0%} of the team median for {s['behind_reviews']} reviews running.",
                "numbers": {"score": loser["score"], "team_median": median, "threshold": threshold, "ratio": s["behind_ratio"],
                            "posts_scored": loser["posts_scored"], "age_days": loser["age_days"], "reviews_running": s["behind_reviews"],
                            "freed_slots": loser["slots"], "live_channels": len(channels),
                            "winner": {"id": winner["id"], "name": winner["name"], "score": winner["score"]}}})

    # Bot layer: strategies, per role.
    for role, rows in board["strategies"].items():
        pool = sorted((r for r in rows if r["status"] == "active" and r["eligible"]), key=lambda r: (r["score"], r["id"]))
        if len(pool) < 2:
            continue
        loser, winner = pool[0], pool[-1]
        if winner["score"] - loser["score"] < s["strategy_margin"]:
            notes.append(f"{role}: {loser['name']} and {winner['name']} are within {s['strategy_margin']} points; both stay")
        elif _has_open(store, "replace", "strategy", loser["id"]):
            notes.append(f"{loser['name']} already has a replacement waiting")
        else:
            proposals.append({
                "kind": "replace", "subject_type": "strategy", "subject_id": loser["id"], "subject_name": loser["name"],
                "reason": f"Lost to {winner['name']} ({role}); drop it and try a variation of the winner.",
                "numbers": {"role": role, "score": loser["score"], "posts_scored": loser["posts_scored"], "margin": s["strategy_margin"],
                            "winner": {"id": winner["id"], "name": winner["name"], "score": winner["score"],
                                       "posts_scored": winner["posts_scored"]}},
                "payload": {"role": role, "winner_id": winner["id"]}})

    result = {"at": now, "dry_run": dry_run, "notes": notes, "board": board}
    if dry_run:
        result["proposals"] = [{"id": None, "status": "preview", "proposed_by": proposed_by, "at": now, **p} for p in proposals]
        return result
    with store.lock:
        result["review_id"] = store.record_review(now, marks)
        result["proposals"] = [store.add_decision(status="proposed", proposed_by=proposed_by, now=now, **p) for p in proposals]
    return result


# -- confirming a proposal -----------------------------------------------------------------------

def needs_user(store, decision):
    """A retirement that archives channels needs the user's OK as well as the Producer's."""
    if decision["kind"] != "retire":
        return False
    if decision["subject_type"] == "channel":
        return True
    return bool(store.list_channels(niche_id=decision["subject_id"], status="live"))


def confirm(store, decision_id, actor, name, now=None):
    """actor 'producer' (the lead bot) or 'user'. The user's confirm covers the Producer's step too."""
    now = time.time() if now is None else now
    if actor not in ("producer", "user"):
        raise StudioError("actor must be producer or user")
    name = (name or actor).strip()[:80] or actor
    with store.lock:
        decision = store.get_decision(decision_id)
        if decision["status"] not in OPEN:
            raise conflict(f"that decision is already {decision['status']}")
        need = needs_user(store, decision)
        if decision["status"] == "awaiting_user" and actor != "user":
            raise conflict("this retirement waits for the user's OK")
        if actor == "producer" and need:
            return store.update_decision(decision_id, status="awaiting_user", confirmed_by=name)
        applied = _apply(store, decision, name, now)
        fields = {"status": "confirmed", "resolved_at": now, "confirmed_by": decision["confirmed_by"] or name,
                  "payload": {**decision["payload"], **applied}}
        if actor == "user":
            fields["user_ok_by"] = name
        return store.update_decision(decision_id, **fields)


def reject(store, decision_id, name, reason="", now=None):
    now = time.time() if now is None else now
    with store.lock:
        decision = store.get_decision(decision_id)
        if decision["status"] not in OPEN:
            raise conflict(f"that decision is already {decision['status']}")
        payload = {**decision["payload"], "rejected_by": (name or "")[:80], "rejected_reason": (reason or "")[:300]}
        return store.update_decision(decision_id, status="rejected", resolved_at=now, payload=payload)


def _apply(store, decision, name, now):
    if decision["kind"] == "retire" and decision["subject_type"] == "niche":
        return _apply_retire_niche(store, decision, name, now)
    if decision["kind"] == "retire" and decision["subject_type"] == "channel":
        store.archive_channel(decision["subject_id"], decision["reason"] or "retired", now)
        return {"archived_channel": decision["subject_id"]}
    if decision["kind"] == "replace" and decision["subject_type"] == "strategy":
        return _apply_replace_strategy(store, decision, name, now)
    raise StudioError("this decision cannot be confirmed")


def _apply_retire_niche(store, decision, name, now):
    niche = store.get_niche(decision["subject_id"])
    if niche["status"] != "live":
        raise conflict("that niche is already retired")
    channels = [c["id"] for c in store.list_channels(niche_id=niche["id"], status="live")]
    store.retire_niche(niche["id"], decision["reason"] or "underperformed", now)
    applied = {"archived_channels": channels}
    # The freed posting slots go first to the current winner.
    wanted = decision["numbers"].get("winner", {}).get("id")
    winner = None
    if wanted is not None and store.get_niche(wanted)["status"] == "live":
        winner = store.get_niche(wanted)
    else:
        ranked = [n for n in scoreboard(store, now)["niches"] if n["status"] == "live" and n["score"] is not None]
        if ranked:
            winner = store.get_niche(max(ranked, key=lambda n: n["score"])["id"])
    freed = niche["slots"]
    if winner and freed:
        store.add_slots(winner["id"], freed)
        promo = store.add_decision(
            "promote", "niche", winner["id"], winner["name"], "confirmed", decision["proposed_by"], confirmed_by=name, now=now,
            reason=f"Takes the {freed} posting slot(s) freed by retiring {niche['name']}.",
            numbers={**decision["numbers"].get("winner", {}), "freed_slots": freed, "slots_after": winner["slots"] + freed},
            payload={"from_decision": decision["id"], "retired_niche": niche["id"]})
        applied["promote_decision"] = promo["id"]
    ask = store.add_decision("replace", "niche", niche["id"], niche["name"], "open", decision["proposed_by"], now=now,
                             reason="The Researcher proposes a replacement niche.", payload={"from_decision": decision["id"]})
    applied["replace_request"] = ask["id"]
    return applied


def _apply_replace_strategy(store, decision, name, now):
    loser = store.get_strategy(decision["subject_id"])
    winner = store.get_strategy(decision["payload"]["winner_id"])
    if loser["status"] != "active" or winner["status"] != "active":
        raise conflict("one of those strategies is no longer active")
    store.drop_strategy(loser["id"], now)
    n = 2
    while True:
        variation_name = f"{winner['name']} v{n}"
        try:
            variation = store.create_strategy(winner["owner_role"], variation_name, parent_id=winner["id"], now=now)
            break
        except StudioError as exc:
            if exc.status != 409:
                raise
            n += 1
    store.set_default_strategy(winner["id"])
    return {"dropped": loser["id"], "variation_id": variation["id"], "variation_name": variation["name"], "default": winner["id"]}


def user_archives_channel(store, channel_id, name, reason="", now=None):
    """The user retires a channel themselves; recorded like any retirement so the history explains itself."""
    now = time.time() if now is None else now
    with store.lock:
        channel = store.archive_channel(channel_id, reason or "archived by the user", now)
        store.add_decision("retire", "channel", channel_id, f"{channel['platform']}:{channel['handle']}", "confirmed", "user",
                           reason=reason or "archived by the user", confirmed_by=name, user_ok_by=name, now=now,
                           numbers={"niche": channel["niche_name"]})
    return channel

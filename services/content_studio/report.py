"""The weekly report (spec section 4): what won, what is retiring, what replaces it, and spend.

build_report returns plain data; render_text turns it into the short message the Producer sends to the
user's Inbox. Delivery to the Inbox is the team routine's job (hook), not done here.
"""
import time
from datetime import datetime, timezone

from . import pipeline, review
from .store import DAY


def team_spend(store, now=None):
    """Spend this month. The cap and total are the bots spend cap for this account; the team's own share is summed
    from the bots listed in the `team_bot_ids` setting (hook: the team template fills it in)."""
    now = time.time() if now is None else now
    try:
        from services import bot_spend, bot_usage
        budget = bot_spend.budget(now)
        start = datetime.fromtimestamp(now, timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
        ids = store.settings()["team_bot_ids"]
        team = None
        if ids:
            team = sum((bot_usage.totals(bot_usage.rows(start, now + .001, bot_id=bot))["cost_usd"] or 0) for bot in ids)
        return {"available": True, "month": budget["month"], "cap_usd": budget["monthly_usd"], "capped": budget["capped"],
                "near_cap": budget["near_cap"], "all_bots_spent_usd": budget["spent_usd"], "team_spent_usd": team,
                "note": budget["cost_note"] if team is not None else "Set team_bot_ids to see the team's own share."}
    except Exception as exc:  # the report must never fail because accounting is unavailable
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


def build_report(store, now=None, days=7, spend=None):
    now = time.time() if now is None else now
    since = now - days * DAY
    board = review.scoreboard(store, now)
    judged = sorted((n for n in board["niches"] if n["status"] == "live" and n["score"] is not None), key=lambda n: -n["score"])
    decisions = store.list_decisions()
    recent = [d for d in decisions if d["at"] >= since or (d["resolved_at"] or 0) >= since]
    strategies = {role: sorted((r for r in rows if r["status"] == "active" and r["score"] is not None), key=lambda r: -r["score"])
                  for role, rows in board["strategies"].items()}
    posted_week = [p for p in store.list_posts(state="posted") if (p["posted_at"] or 0) >= since]
    return {
        "from": since, "to": now,
        "won": {"niches": judged[:3], "strategies": {role: rows[:1] for role, rows in strategies.items()},
                "top_posts": board["top_posts"][:3]},
        "retiring": {"waiting": [d for d in decisions if d["kind"] == "retire" and d["status"] in review.OPEN],
                     "retired_this_week": [d for d in recent if d["kind"] == "retire" and d["status"] == "confirmed"]},
        "replacing": {"promotions": [d for d in recent if d["kind"] == "promote"],
                      "strategy_swaps": [d for d in recent if d["kind"] == "replace" and d["subject_type"] == "strategy"
                                         and d["status"] in review.OPEN + ("confirmed",)],
                      "niches_wanted": [d for d in decisions if d["kind"] == "replace" and d["subject_type"] == "niche"
                                        and d["status"] == "open"],
                      "niches_proposed": [d for d in decisions if d["kind"] == "add" and d["status"] in review.OPEN]},
        "activity": {"posted_this_week": len(posted_week), "awaiting_approval": len(pipeline.approval_queue(store)),
                     "findings": len(pipeline.watch(store, now, spend=lambda: None))},
        "spend": team_spend(store, now) if spend is None else spend(),
    }


def render_text(report):
    def niche(n):
        return f"{n['name']} ({n['score']:.1f})"
    lines = ["Content Studio weekly report", ""]
    won = report["won"]
    lines.append("What won: " + (", ".join(niche(n) for n in won["niches"]) or "nothing has enough data yet") + ".")
    for role, rows in won["strategies"].items():
        if rows:
            lines.append(f"  Best {role.replace('_', ' ')} strategy: {rows[0]['name']} ({rows[0]['score']:.1f}).")
    waiting = report["retiring"]["waiting"]
    lines.append("Retiring: " + ("; ".join(f"{d['subject_name']} ({d['status'].replace('_', ' ')})" for d in waiting) or "nothing waiting") + ".")
    done = report["retiring"]["retired_this_week"]
    if done:
        lines.append("  Retired this week: " + ", ".join(d["subject_name"] for d in done) + ".")
    rep = report["replacing"]
    bits = [f"{d['subject_name']} takes freed slots" for d in rep["promotions"]]
    bits += [f"{d['subject_name']} swapped for a variation of {d['numbers'].get('winner', {}).get('name', 'the winner')}" for d in rep["strategy_swaps"]]
    bits += [f"a replacement for {d['subject_name']} is wanted" for d in rep["niches_wanted"]]
    bits += [f"{d['subject_name']} is proposed as a new niche ({'waiting for you' if d['status'] == 'awaiting_user' else 'with the Producer'})"
             for d in rep.get("niches_proposed", [])]
    lines.append("Replacing: " + ("; ".join(bits) or "nothing") + ".")
    spend = report["spend"]
    if spend.get("available"):
        team = spend["team_spent_usd"]
        cap = spend["cap_usd"]
        lines.append(f"Spend this month: {'$%.2f' % team if team is not None else 'team share not set'}"
                     f" (all bots ${spend['all_bots_spent_usd'] or 0:.2f}{', cap $%.0f' % cap if cap else ', no cap set'}).")
    else:
        lines.append("Spend: not available right now.")
    act = report["activity"]
    lines.append(f"Posted this week: {act['posted_this_week']}. Waiting for your OK: {act['awaiting_approval']}. Open watch findings: {act['findings']}.")
    return "\n".join(lines)

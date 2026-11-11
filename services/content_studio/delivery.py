"""Delivery to the person: the weekly report and urgent watch findings land in the Inbox (spec sections 4 and 9, D6).

Both go out through the Producer's Inbox report (agent_service.add_item + notify), which is also the app's
notify path: the activity feed, the bot's own channel when the person set one, and their notification
hooks. Nothing here knows about a particular chat service. `notifier(bot_id, title, body, urgent)` is
injectable so tests can watch what would be sent; it returns True when something was delivered.
"""
import time

from . import report as report_mod, team


def inbox_notifier(bot_id, title, body, urgent=False):
    from services.agent_service import agent_service
    if agent_service.get(bot_id) is None:
        return False
    item = agent_service.add_item(bot_id, "report", ("Urgent: " if urgent else "") + title, body)
    agent_service.notify(item)
    return True


def _send(store, title, body, urgent, notifier):
    bot_id = team.producer_id(store)
    if not bot_id:
        return False  # no Producer recorded for this account: nothing to speak as
    return bool((notifier or inbox_notifier)(bot_id, title, body, urgent))


def _key(finding, now):
    month = time.strftime("%Y-%m", time.gmtime(now))
    if finding["kind"] == "platform_warning":
        return f"platform_warning:{finding.get('warning_id') or finding.get('channel_id')}"
    if finding["kind"] in ("spend_near_cap", "spend_capped"):
        return f"{finding['kind']}:{month}"
    return f"{finding['kind']}:{finding.get('post_id') or finding.get('channel_id') or ''}"


def deliver_findings(store, findings, notifier=None, now=None):
    """Sends each urgent finding (`notify_user`) once: platform warnings and spend near or at the cap.
    Returns the findings that were sent now. A finding already sent stays quiet until it clears and returns."""
    now = time.time() if now is None else now
    sent = []
    with store.lock:
        seen = dict(store.settings()["notified"])
        urgent = [f for f in findings if f.get("notify_user")]
        for finding in urgent:
            key = _key(finding, now)
            if key in seen:
                continue
            if _send(store, "Content Studio needs you", finding["message"], True, notifier):
                seen[key] = now
                sent.append(finding)
        store.update_settings(notified=seen)
    return sent


def deliver_warning(store, channel_id, notifier=None, now=None):
    """A platform warning was just recorded (the channel is already paused): tell the person at once."""
    now = time.time() if now is None else now
    warning = next((w for w in reversed(store.open_warnings()) if w["channel_id"] == channel_id), None)
    if warning is None:
        return False
    finding = {"kind": "platform_warning", "notify_user": True, "channel_id": channel_id, "warning_id": warning["id"],
               "message": f"{warning['platform']} warned {warning['handle']}: {warning['text']} The channel is paused."}
    return bool(deliver_findings(store, [finding], notifier or urgent_notifier, now))


def urgent_notifier(bot_id, title, body, urgent=True):
    """The Inbox note and, at once, a Reach me message (2026-11-11: a platform warning reaches the person right away)."""
    from . import handsoff
    return handsoff.inbox_and_message(bot_id, title, body, urgent)


def deliver_report(store, notifier=None, now=None, spend=None):
    """Builds the weekly report and puts it in the person's Inbox. Returns {"delivered", "text"}."""
    now = time.time() if now is None else now
    data = report_mod.build_report(store, now, spend=spend)
    text = report_mod.render_text(data)
    if notifier is None and data.get("hands_off"):
        # Hands-off: the weekly report is the person's main view, so it also reaches them through Reach me.
        from . import handsoff
        notifier = lambda bot_id, title, body, urgent=False: handsoff.inbox_and_message(bot_id, title, body)  # noqa: E731
    delivered = _send(store, "Content Studio weekly report", text, False, notifier)
    return {"delivered": delivered, "text": text}

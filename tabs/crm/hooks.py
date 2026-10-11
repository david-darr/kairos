"""Passive capture, background scans and owned calendar/Home summaries."""
from datetime import datetime
from zoneinfo import ZoneInfo
from core import tab_api
from . import scanner
from .service import crm_service

api = tab_api.for_tab(__package__)


async def start():
    scanner.start()


async def stop():
    await scanner.stop()


def on_message(source, message):
    scanner.capture_connector(source["kind"], source["connection_id"], message)


def calendar_items(user, start, end):
    return crm_service.calendar_events(user, start, end)


def home_cards(user):
    zone = ZoneInfo(crm_service.settings(user)["timezone"])
    now = datetime.now(zone)
    tasks = [t for t in crm_service.tasks(user) if t["status"] not in ("done", "dismissed")]

    def deadline(task):
        due = task.get("due_date")
        if not due:
            return None
        return datetime.fromisoformat(due).replace(tzinfo=zone) if len(due) == 10 else datetime.fromisoformat(due.replace("Z", "+00:00")).astimezone(zone)

    def overdue(task):
        due = deadline(task)
        return bool(due and (due.date() < now.date() if len(task["due_date"]) == 10 else due < now))

    tasks.sort(key=lambda t: (not overdue(t), deadline(t) or datetime.max.replace(tzinfo=zone), t["id"]))
    rows = []
    for task in tasks[:5]:
        due = deadline(task)
        late, today = overdue(task), bool(due and due.date() == now.date())
        review = task["status"] == "needs_review" or bool(task.get("proposal"))
        when = ("Today" if today else due.strftime("%b %d, %Y")) if due else "No due date"
        source = task.get("contact") or next((e.get("label") for e in task.get("evidence", []) if e.get("label")), "")
        badge = "Overdue" if late else "Today" if today else "Review" if review else ""
        rows.append({"title": task["title"][:80], "meta": " · ".join(filter(None, (when, source)))[:80],
                     "badge": badge, "tone": "danger" if late else "warn" if today or review else "default"})
    return [{"id": "follow-ups", "title": "Follow-ups", "kind": "list", "rows": rows,
             "empty_text": "No open follow-ups."},
            {"id": "open-count", "title": "Open follow-ups", "kind": "stat", "value": len(tasks),
             "label": "open", "detail": f"{sum(overdue(t) for t in tasks)} overdue"}]

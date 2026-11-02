"""Server-built brief, presence and once-per-local-day morning delivery."""
import asyncio
import re
import time
from datetime import datetime
from email.utils import parseaddr
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from core import front_desk_watch_adapter as adapter
from services import front_desk_watch as store, front_desk_ledger as ledger

SECTIONS = (("needs", "Needs you", "Nothing needs you right now."),
            ("day", "Your day", "No more meetings today."),
            ("mail", "Important emails", "No important emails right now."),
            ("routines", "Routines", "No routine results yet."),
            ("ideas", "Ideas", "No new ideas right now."))


def safe_url(value):
    try:
        url = urlsplit(value or "")
        return value if url.scheme == "https" and url.hostname and not url.username and not url.password and not re.search(r"[\x00-\x20\\]", value) else None
    except ValueError:
        return None


def email_row(reference):
    from services.email_service import email_service
    account = email_service.get_account(reference["account"])
    if not account or account.get("owner") not in (None, store.owner()):
        raise KeyError("Email not found")
    return email_service.read_message(reference["account"], reference["uid"],
                                      uidvalidity=reference.get("uidvalidity"), headers_only=True)


def _source_rows(value, messages, calendar, *, runs=(), questions=(), ideas=(), now=None):
    now = time.time() if now is None else now
    zone = ZoneInfo(store.settings().get("zone", "UTC"))
    today = datetime.fromtimestamp(now, zone).date()
    sections = {key: [] for key, _, _ in SECTIONS}
    dismissed = {d["id"] for d in value.get("dismissed", []) if now - d["at"] < 14 * 86400}
    for ref in value.get("important", []):
        if ref["id"] in dismissed or now - ref.get("at", 0) > 7 * 86400:
            continue
        msg = messages.get(ref["id"])
        if not msg:
            continue
        row = {"id": ref["id"], "text": f"{msg.get('from', '')}: {msg.get('subject', '')}"[:1200],
               "note": ref.get("reason", ""), "actions": [
                   {"kind": "draft", "label": "Draft a reply", "arg": ref["id"]},
                   {"kind": "dismiss", "label": "Dismiss", "arg": ref["id"]}]}
        sections["needs" if ref.get("needs_reply") else "mail"].append(row)
    for run in runs:
        status = run.get("automation_status", run.get("status"))
        row = {"id": "run:" + run["id"], "text": str(run.get("name") or run.get("title") or "Routine")[:300],
               "note": "Could not finish" if status == "failed" else "Missed a run" if status == "missed" else "Finished", "actions": []}
        if run.get("session_id"):
            row["actions"].append({"kind": "open_thread", "label": "Open run", "arg": run["session_id"]})
        sections["needs" if status in ("failed", "missed") else "routines"].append(row)
    from core.front_desk_checks import calendar_plan
    sections["needs"].extend(calendar_plan(calendar, now)["clashes"])
    for source, check in store.read("checks").items():
        if not isinstance(check, dict) or not check.get("failure_streak"):
            continue
        label = {"mail": "mail", "calendar": "calendar", "runs": "routines"}.get(source)
        if label:
            sections["needs"].append({"id": "read:" + source, "text": "Could not read " + label,
                                     "note": "Reconnect in Settings" if check.get("signed_out") else "I will try again shortly", "actions": []})
    sections["needs"].extend(questions)
    for row in calendar:
        if datetime.fromtimestamp(row["start_at"], zone).date() != today or row["end_at"] <= now:
            continue
        actions = []
        link = safe_url(row.get("meeting_url"))
        if link:
            actions.append({"kind": "open_url", "label": "Join", "arg": link})
        sections["day"].append({"id": "event:" + row["key"], "text": datetime.fromtimestamp(row["start_at"], zone).strftime("%H:%M") + ", " + str(row.get("title") or "Meeting")[:300],
                                "note": str(row.get("location") or "")[:300], "actions": actions})
    for idea in ideas:
        sections["ideas"].append({"id": "idea:" + idea["id"], "text": str(idea.get("title", ""))[:300],
                                  "note": f"Noticed across {max(1, int(idea.get('chat_count', 1)))} chats", "actions": []})
    return [{"id": key, "label": label, "rows": sections[key][:6], "more": max(0, len(sections[key]) - 6),
             "empty": empty} for key, label, empty in SECTIONS]


def _questions():
    from services import bot_attention
    return [{"id": r["id"], "text": r["subject"], "note": "Waiting for you", "actions": [
        {"kind": "open_thread", "label": "Open", "arg": r["target"]["sessionId"]}]}
        for r in bot_attention.needs_you(store.owner())["rows"] if r.get("target", {}).get("sessionId")
        and r.get("sender", {}).get("id") == store.bot_id()]


async def refresh(reason, *, records=None, post=True):
    """The brief's sections from mail, calendar, routine runs and questions. post=False only reads them
    (the desktop Today panel): no card is posted or updated."""
    from core import front_desk_checks as checks
    records, now = records or {}, time.time()
    value = store.read("brief")
    messages = {r["id"]: r for r in records.get("mail", [])}
    for ref in value.get("important", []):
        if ref["id"] in messages:
            continue
        try:
            messages[ref["id"]] = await asyncio.to_thread(email_row, ref)
        except KeyError:
            continue  # message/account removed, or UIDVALIDITY changed
        except Exception as error:
            checks.failure("mail", error, now)
    calendar = records.get("calendar")
    if calendar is None:
        try:
            calendar = await checks.calendar_rows(now)
        except Exception as error:
            checks.failure("calendar", error, now)
            calendar = []
    runs = records.get("runs")
    if runs is None:
        runs = adapter.runs(now - 7 * 86400)
    runs = [r for r in runs if r.get("routine_id") != store.read("watch").get("routine_id") and
            r.get("automation_status", r.get("status")) in ("finished", "completed", "failed", "missed")]
    sections = _source_rows(value, messages, calendar, runs=runs, questions=_questions(), now=now)
    settings = store.settings()
    local = datetime.fromtimestamp(now, ZoneInfo(settings.get("zone", "UTC")))
    result = {"date_label": local.strftime("%A, %B %d"), "greeting": "Your brief", "sections": sections,
              "morning_line": value.get("morning_line", ""), "has_content": any(s["rows"] or s["more"] for s in sections)}
    key = "brief:" + local.date().isoformat()
    # If the last row was dismissed, update the existing card to its empty
    # state; never create an empty card on a first check.
    if post and (result["has_content"] or value.get("card_key") == key):
        adapter.post_card("brief", result, key=key)
        with store.LOCK:
            current = store.read("brief")
            current.update(date=local.date().isoformat(), card_key=key)
            store.write("brief", current)
    return result


def _reference(ident):
    return next((r for r in store.read("brief").get("important", []) if r["id"] == ident), None)


async def dismiss(ident):
    ref = _reference(ident)
    if not ref:
        raise KeyError("Brief row not found")
    msg = await asyncio.to_thread(email_row, ref)
    now = time.time()
    with store.LOCK:
        value = store.read("brief")
        dismissed = [r for r in value.get("dismissed", []) if now - r["at"] < 14 * 86400 and r["id"] != ident]
        dismissed.append({"id": ident, "sender": parseaddr(msg.get("from", ""))[1].lower()[:320], "at": now})
        value["dismissed"] = dismissed[-1000:]
        value["important"] = [r for r in value.get("important", []) if r["id"] != ident]
        store.write("brief", value)
    return await refresh("dismiss")


async def draft(ident):
    from services.email_service import email_service
    ref = _reference(ident)
    if not ref:
        raise KeyError("Brief row not found")
    # email_row verifies that the current session owner owns this account.
    await asyncio.to_thread(email_row, ref)
    from core.turn_taint import TurnTaint
    taint = TurnTaint()
    msg = await asyncio.to_thread(email_service.read_message, ref["account"], ref["uid"],
                                  uidvalidity=ref.get("uidvalidity"), turn_taint=taint)
    text = ("Draft a reply to this email and save it with fd_save_draft. Never send it. "
            f"Use source_row {ident}, account {ref['account']}.\n" + msg["records"])
    return await adapter.send_draft_turn(store.main_thread_id(), text, send_id="fd-draft:" + ident)


def remove_replied(ident):
    with store.LOCK:
        value = store.read("brief")
        value["important"] = [r for r in value.get("important", []) if r["id"] != ident]
        store.write("brief", value)


def post_meeting(due):
    row, kind, signature = due["meeting"], due["kind"], due["signature"]
    key = "meeting:" + kind + ":" + signature
    with store.LOCK:
        value = store.read("brief")
        field = "preps" if kind == "prep" else "reminders"
        if signature in value.get(field, []):
            return
        zone = ZoneInfo(store.settings().get("zone", "UTC"))
        lines = ["Short prep" if due.get("short") else "Meeting prep", f"{row['guests']} other guests"]
        # Plain text only. Invite content never goes into an instruction frame.
        lines += str(row.get("description") or "").splitlines()[:58]
        adapter.post_card(kind, {"title": str(row.get("title") or "Meeting")[:300],
            "when_label": datetime.fromtimestamp(row["start_at"], zone).strftime("%H:%M"),
            "location": str(row.get("location") or "")[:300], "lines": [s[:400] for s in lines][:60],
            "join_url": safe_url(row.get("meeting_url"))}, key=key)
        adapter.notify(key, "Meeting prep is ready" if kind == "prep" else "Your meeting starts soon")
        value[field] = (value.get(field, []) + [signature])[-200:]
        store.write("brief", value)
    if kind == "prep":
        ledger.record("prepped", key=key)


async def presence(zone, language, *, now=None):
    # Only server time is accepted. Client timestamp fields are forbidden.
    now = time.time() if now is None else now
    store.settings(zone=zone, language=language)
    local_day = datetime.fromtimestamp(now, ZoneInfo(zone)).date().isoformat()
    with store.LOCK:
        value = store.read("presence")
        last = value.get("last_presence_at", 0)
        skewed = last > now + 300
        should_open = not skewed and (value.get("last_open_day") != local_day or now - last >= 10800)
        value.update(last_presence_at=now, last_open_day=local_day)
        store.write("presence", value)
    if not should_open:
        return {}
    from services.chat_live import is_processing
    if is_processing(store.main_thread_id()):
        return {}
    result = await refresh("presence")
    return {"open_thread_id": store.main_thread_id()} if result["has_content"] else {}


async def morning_due(*, now=None):
    now = time.time() if now is None else now
    settings = store.settings()
    if not settings.get("on", True):
        return False
    local = datetime.fromtimestamp(now, ZoneInfo(settings.get("zone", "UTC")))
    day = local.date().isoformat()
    if local.strftime("%H:%M") < settings.get("time", "08:00"):
        return False
    with store.LOCK:
        value = store.read("morning")
        if value.get("posted_day") == day:
            return False
        started = value.get("waiting_since", now) if value.get("waiting_day") == day else now
        value.update(waiting_since=started, waiting_day=day)
        store.write("morning", value)
    from services.chat_live import is_processing
    if is_processing(store.main_thread_id()):
        return False
    pending = store.read("checks").get("mail", {}).get("pending", {})
    if pending and now - started < 1200:
        return False
    with store.LOCK:
        brief = store.read("brief")
        brief["morning_line"] = ledger.line(now=now)
        store.write("brief", brief)
    data = await refresh("morning")
    if not data["has_content"]:
        return False
    adapter.notify("morning:" + day, "Your morning brief is ready", data["morning_line"])
    with store.LOCK:
        value = store.read("morning")
        value["posted_day"] = day
        store.write("morning", value)
    return True


async def recap_due(*, now=None):
    now = time.time() if now is None else now
    created = store.read("state").get("seeded_at", 0)
    if not created or now - created < 20 * 3600 or store.read("morning").get("recap_posted"):
        return False
    zone = ZoneInfo(store.settings().get("zone", "UTC"))
    local = datetime.fromtimestamp(now, zone)
    if local.date() <= datetime.fromtimestamp(created, zone).date() or local.hour < 8:
        return False
    from services.chat_live import is_processing
    if is_processing(store.main_thread_id()):
        return False
    text = ledger.line(now=now, recap=True)
    if not text:
        return False
    adapter.post_card("checkin", {"at": now, "summary": text}, key="day-two-recap")
    with store.LOCK:
        value = store.read("morning")
        value["recap_posted"] = now
        store.write("morning", value)
    return True

"""Local reply drafts. Sending is exposed only by the signed-in person route."""
import time
import uuid
from email.utils import parseaddr

from services import front_desk_watch as store, front_desk_ledger as ledger

_SENDING = set()


def _text(value, limit, label):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"Invalid {label}")
    return value.strip()


def save(to, subject, body, *, in_reply_to=None, account, source_row=None):
    from services.email_service import email_service
    from services import front_desk_brief as brief
    from core.front_desk_watch_adapter import is_watch
    to, subject, body = _text(to, 320, "recipient"), _text(subject, 300, "subject"), _text(body, 50000, "draft")
    if any(c in to + subject + (in_reply_to or "") for c in "\r\n\x00"):
        raise ValueError("Invalid email header")
    chosen = next((a for a in email_service.list_accounts() if account in (a["id"], a["email"]) and a.get("owner") in (None, store.owner())), None)
    if not chosen:
        raise ValueError("Choose a connected email account")
    if is_watch() and not source_row:
        raise ValueError("A watch draft must reply to a supplied email")
    if source_row:
        ref = brief._reference(source_row)
        if not ref or ref["account"] != chosen["id"]:
            raise ValueError("The source email is no longer available")
        msg = brief.email_row(ref)
        sender = parseaddr(msg.get("from", ""))[1]
        if not sender or to.lower() != sender.lower():
            raise ValueError("A reply draft must be addressed only to the sender")
        in_reply_to = msg.get("message_id") or None
    now = time.time()
    with store.LOCK:
        rows = store.read("drafts", [])
        existing = next((r for r in rows if source_row and r.get("source_row") == source_row and r["status"] != "discarded"), None)
        if existing:
            return existing
        row = {"id": uuid.uuid4().hex, "to": to, "subject": subject, "body": body,
               "in_reply_to": in_reply_to, "account": chosen["id"], "source_row": source_row,
               "status": "draft", "created_at": now}
        # Never evict an unsent draft to make room for another one.
        if len(rows) >= 200:
            evict = next((r for r in rows if r["status"] in ("sent", "discarded")), None)
            if not evict:
                raise ValueError("You have 200 saved drafts. Discard one first.")
            rows.remove(evict)
        rows.append(row)
        store.write("drafts", rows)
    ledger.record("drafted", key="draft:" + row["id"])
    return row


def list_drafts():
    return [r for r in reversed(store.read("drafts", [])) if r["status"] != "discarded"]


def discard(ident):
    with store.LOCK:
        rows = store.read("drafts", [])
        row = next((r for r in rows if r["id"] == ident), None)
        if not row:
            raise KeyError("Draft not found")
        if ident in _SENDING or row.get("send_started_at"):
            raise ValueError("This draft is being sent")
        if row["status"] == "sent":
            raise ValueError("This reply was already sent")
        row["status"] = "discarded"
        store.write("drafts", rows)
    return {"ok": True}


async def send(ident, user):
    from core import email_send, permissions
    from services.email_service import email_service
    store.require_owner(user)
    with store.LOCK:
        rows = store.read("drafts", [])
        row = next((r for r in rows if r["id"] == ident and r["status"] != "discarded"), None)
        if not row:
            raise KeyError("Draft not found")
        if row["status"] == "sent":
            return row
        if ident in _SENDING:
            raise ValueError("This draft is being sent")
        if row.get("send_started_at"):
            raise ValueError("Delivery could not be confirmed. Check Sent mail before trying again.")
        account = email_service.get_account(row["account"])
        if not account or account.get("owner") not in (None, user):
            raise KeyError("Email account not found")
        message = email_send.validate({"from_account": account["email"], "to": row["to"], "subject": row["subject"],
                                       "body": row["body"], "in_reply_to": row.get("in_reply_to")}, user)
        # The signed-in person's Send button is the authorization, like the
        # existing Email tab. It is not a model tool or an unattended grant.
        _SENDING.add(ident)
        row["send_started_at"] = time.time()
        store.write("drafts", rows)
    try:
        await email_send.send(message, user)
    except Exception:
        permissions.record_tool_use("send uncertain", "send_email", "external", {"draft_id": ident}, user)
        raise ValueError("Delivery could not be confirmed. Check Sent mail before trying again.") from None
    else:
        with store.LOCK:
            rows = store.read("drafts", [])
            row = next(r for r in rows if r["id"] == ident)
            row.update(status="sent", sent_at=time.time())
            store.write("drafts", rows)
        permissions.record_tool_use("tool used", "send_email", "external", {"draft_id": ident}, user)
        from services import front_desk_brief as brief
        if row.get("source_row"):
            brief.remove_replied(row["source_row"])
        return row
    finally:
        with store.LOCK:
            _SENDING.discard(ident)

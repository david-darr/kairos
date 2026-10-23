"""One way for models to send email from any connected account.

Google accounts connected in Library send through the Gmail API; Email tab
accounts send over SMTP. The caller names the sending address, so a person
with several accounts decides which one each message comes from.
"""
from __future__ import annotations

import asyncio
import re
from email.utils import parseaddr

from core import google_workspace as google

_HEADER_UNSAFE = re.compile(r"[\r\n\x00]")
MAX_RECIPIENTS = 20


def accounts() -> list[dict]:
    from services.email_service import email_service
    rows = []
    for account in google.status()["accounts"]:
        rows.append({"email": account["email"], "via": "Google", "id": account["id"],
                     "can_send": account["can_send_email"],
                     "note": "" if account["can_send_email"] else "reconnect it in Library to allow sending"})
    seen = {r["email"].lower() for r in rows if r["can_send"]}
    for account in email_service.list_accounts():
        if account["email"].lower() not in seen:
            rows.append({"email": account["email"], "via": "Email tab", "id": account["id"], "can_send": True, "note": ""})
    return rows


def _addresses(value, label: str) -> list[str]:
    if value in (None, ""):
        return []
    if not isinstance(value, str) or _HEADER_UNSAFE.search(value):
        raise ValueError(f"Invalid {label} addresses")
    found = []
    for part in value.split(","):
        address = parseaddr(part.strip())[1]
        if "@" not in address or not re.fullmatch(r"[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+", address):
            raise ValueError(f"'{part.strip()}' is not a valid {label} address")
        found.append(address)
    return found


def validate(args: dict) -> dict:
    sender = args.get("from_account")
    subject, body = args.get("subject"), args.get("body")
    if not isinstance(sender, str) or not sender.strip():
        raise ValueError("Choose from_account from list_email_accounts")
    to, cc = _addresses(args.get("to"), "recipient"), _addresses(args.get("cc"), "CC")
    if not to:
        raise ValueError("Enter at least one recipient")
    if len(to) + len(cc) > MAX_RECIPIENTS:
        raise ValueError(f"Send to at most {MAX_RECIPIENTS} addresses at once")
    reply = args.get("in_reply_to") or None
    for value in (subject, reply or ""):
        if not isinstance(value, str) or _HEADER_UNSAFE.search(value):
            raise ValueError("Invalid subject or reply header")
    if not isinstance(body, str) or not body.strip() or len(body) > 50_000:
        raise ValueError("The message must be 1 to 50,000 characters")
    wanted = sender.strip().lower()
    match = next((a for a in accounts() if a["email"].lower() == wanted), None)
    if match is None:
        raise ValueError(f"{sender} is not a connected account. Use list_email_accounts")
    if not match["can_send"]:
        raise ValueError(f"{match['email']} cannot send yet: {match['note']}")
    return {"from": match["email"], "via": match["via"], "account_id": match["id"], "to": to, "cc": cc,
            "subject": subject[:300], "body": body, "in_reply_to": reply}


async def send(message: dict) -> dict:
    if message["via"] == "Google":
        return await google.send_gmail(message["account_id"], message["to"], message["subject"], message["body"],
                                       cc=message["cc"], in_reply_to=message["in_reply_to"])
    from services.email_service import email_service
    await asyncio.to_thread(email_service.send_message, message["account_id"], ", ".join(message["to"]),
                            message["subject"], message["body"], in_reply_to=message["in_reply_to"],
                            cc=", ".join(message["cc"]) or None)
    return {"from": message["from"]}

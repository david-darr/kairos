"""Email: IMAP/SMTP account config + inbox/compose, the Email tab. Password
encrypted at rest via core/secret_storage, never returned in API responses
(masked instead, matching Odysseus's own account-config policy).

Google OAuth (XOAUTH2) for Gmail/Workspace accounts, scheduled send, and
AI summary/reply-draft/urgency extraction (all real Odysseus features) are
out of this pass — this is the plain IMAP/SMTP account + manual compose/send
foundation those would build on top of. Manual compose/send here is
direct-send (a real person clicking Send in a real email client), distinct
from agent-initiated sending, which should stay confirmation-first/draft-only
per the resolved harness principle — no agent email tool exists yet to need
that gate.
"""
import email
import imaplib
import smtplib
import time
import uuid
from datetime import date, datetime, timezone
from email.mime.text import MIMEText
from email.header import decode_header
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from core.secret_storage import encrypt, decrypt
import os

ACCOUNTS_FILE = os.path.join(DATA_DIR, "email_accounts.json")


class EmailService:
    def __init__(self) -> None:
        self._accounts: dict = read_json(ACCOUNTS_FILE, {})

    def _save(self) -> None:
        write_json_atomic(ACCOUNTS_FILE, self._accounts)

    def _masked(self, account: dict) -> dict:
        return {k: v for k, v in account.items() if k != "password_encrypted"}

    def list_accounts(self) -> list[dict]:
        return [self._masked(a) for a in self._accounts.values()]

    def get_account(self, account_id: str, decrypted: bool = False) -> Optional[dict]:
        account = self._accounts.get(account_id)
        if account is None:
            return None
        return account if decrypted else self._masked(account)

    def create_account(
        self, email_address: str, password: str,
        imap_host: str, imap_port: int,
        smtp_host: str, smtp_port: int,
        smtp_security: str = "ssl",
        owner: Optional[str] = None,
    ) -> dict:
        account_id = uuid.uuid4().hex[:12]
        account = {
            "id": account_id,
            "email": email_address,
            "password_encrypted": encrypt(password),
            "imap_host": imap_host,
            "imap_port": imap_port,
            "smtp_host": smtp_host,
            "smtp_port": smtp_port,
            "smtp_security": smtp_security,  # "ssl" | "starttls" | "none"
            "created_at": time.time(),
            "owner": owner,  # the Email tab shows an account only to its owner and admins
        }
        self._accounts[account_id] = account
        self._save()
        return self._masked(account)

    def delete_account(self, account_id: str) -> None:
        if account_id in self._accounts:
            del self._accounts[account_id]
            self._save()

    # -- IMAP/SMTP operations ------------------------------------------

    def test_connection(self, account_id: str) -> dict:
        account = self.get_account(account_id, decrypted=True)
        if account is None:
            raise KeyError(f"no such account: {account_id}")
        password = decrypt(account["password_encrypted"])

        result = {"imap": False, "smtp": False, "imap_error": None, "smtp_error": None}

        try:
            with imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"], timeout=10) as imap:
                imap.login(account["email"], password)
            result["imap"] = True
        except Exception as e:
            result["imap_error"] = str(e)

        try:
            if account["smtp_security"] == "ssl":
                smtp = smtplib.SMTP_SSL(account["smtp_host"], account["smtp_port"], timeout=10)
            else:
                smtp = smtplib.SMTP(account["smtp_host"], account["smtp_port"], timeout=10)
                if account["smtp_security"] == "starttls":
                    smtp.starttls()
            smtp.login(account["email"], password)
            smtp.quit()
            result["smtp"] = True
        except Exception as e:
            result["smtp_error"] = str(e)

        return result

    def list_messages(
        self, account_id: str, folder: str = "INBOX", limit: int = 20,
        unseen_only: bool = False, since: Optional[date] = None,
    ) -> list[dict]:
        account = self.get_account(account_id, decrypted=True)
        if account is None:
            raise KeyError(f"no such account: {account_id}")
        password = decrypt(account["password_encrypted"])

        criteria = []
        if unseen_only:
            criteria.append("UNSEEN")
        if since is not None:
            criteria.append(f'SINCE "{since.strftime("%d-%b-%Y")}"')

        messages = []
        with imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"], timeout=10) as imap:
            imap.login(account["email"], password)
            imap.select(folder, readonly=True)
            status, data = imap.search(None, *(criteria or ["ALL"]))
            if status != "OK":
                return []
            ids = data[0].split()[-max(1, min(int(limit), 200)):]  # [-0:] would be the whole mailbox
            for msg_id in reversed(ids):
                status, msg_data = imap.fetch(msg_id, "(FLAGS RFC822.HEADER)")
                if status != "OK" or not msg_data or not msg_data[0]:
                    continue
                seen = b"\\Seen" in (msg_data[0][0] or b"")
                msg = email.message_from_bytes(msg_data[0][1])
                messages.append({
                    "uid": msg_id.decode(),
                    "from": _decode_header(msg.get("From", "")),
                    "subject": _decode_header(msg.get("Subject", "")),
                    "date": msg.get("Date", ""),
                    "seen": seen,
                })
        return messages

    def list_watch_messages(self, account_id: str, *, since: float, limit: int = 100) -> list[dict]:
        """Stable UID headers for the watch. Keep the Email tab's API intact.

        IMAP SINCE has day precision; the caller also filters the parsed date.
        UIDVALIDITY is part of every saved reference, so mailbox renumbering
        can never make a saved brief row refer to a different message.
        """
        account = self.get_account(account_id, decrypted=True)
        if account is None:
            raise KeyError("Email account not found")
        day = datetime.fromtimestamp(since, timezone.utc).strftime("%d-%b-%Y")
        rows = []
        with imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"], timeout=10) as imap:
            imap.login(account["email"], decrypt(account["password_encrypted"]))
            status, _ = imap.select("INBOX", readonly=True)
            if status != "OK":
                raise ValueError("Could not open the inbox")
            validity = _uidvalidity(imap)
            status, data = imap.uid("search", None, "SINCE", day)
            if status != "OK":
                raise ValueError("Could not read mail headers")
            for uid in reversed(data[0].split()[-max(1, min(int(limit), 100)):]):
                status, parts = imap.uid("fetch", uid, "(BODY.PEEK[HEADER])")
                if status != "OK":
                    raise ValueError("Could not read a mail header")
                payload = next((p[1] for p in parts if isinstance(p, tuple) and isinstance(p[1], bytes)), None)
                if payload is not None:
                    rows.append(_watch_header(email.message_from_bytes(payload), uid.decode(), validity))
        return rows

    def read_message(self, account_id: str, uid: str, *, uidvalidity: str | None = None,
                     headers_only: bool = False, turn_taint=None) -> dict:
        """Read one UID without marking it seen. Model text is always fenced.

        Headers are returned separately for server-built cards. A caller that
        passes the result to a model must use `records`, never interpolate the
        header fields. Body output is plain text and bounded to 8,000 chars.
        """
        if not str(uid).isdigit() or int(uid) < 1:
            raise ValueError("Invalid message reference")
        account = self.get_account(account_id, decrypted=True)
        if account is None:
            raise KeyError("Email account not found")
        with imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"], timeout=10) as imap:
            imap.login(account["email"], decrypt(account["password_encrypted"]))
            status, _ = imap.select("INBOX", readonly=True)
            if status != "OK":
                raise ValueError("Could not open the inbox")
            validity = _uidvalidity(imap)
            if uidvalidity is not None and str(uidvalidity) != validity:
                raise KeyError("This mailbox changed. Check for new mail again.")
            # Fetch at most 256 KiB, even for a very large MIME message.
            query = "(BODY.PEEK[HEADER])" if headers_only else "(BODY.PEEK[]<0.262144>)"
            status, data = imap.uid("fetch", str(uid), query)
            payload = next((p[1] for p in (data or []) if isinstance(p, tuple) and isinstance(p[1], bytes)), None)
            if status != "OK" or payload is None:
                raise KeyError("Email not found")
            msg = email.message_from_bytes(payload)
        from core.untrusted import wrap_untrusted
        from core.turn_taint import TurnTaint
        import json
        taint = turn_taint if turn_taint is not None else TurnTaint()
        taint.mark("email message")
        fields = _watch_header(msg, str(uid), validity)
        body = "" if headers_only else _plain_body(msg)
        return {**fields, "records": wrap_untrusted("email message", json.dumps({**fields, "body": body}, ensure_ascii=False)),
                "tainted": True}

    def send_message(self, account_id: str, to: str, subject: str, body: str,
                     in_reply_to: str | None = None, cc: str | None = None) -> None:
        account = self.get_account(account_id, decrypted=True)
        if account is None:
            raise KeyError(f"no such account: {account_id}")
        password = decrypt(account["password_encrypted"])

        msg = MIMEText(body)
        msg["From"] = account["email"]
        msg["To"] = to
        msg["Subject"] = subject
        if cc:
            msg["Cc"] = cc
        if in_reply_to:
            # Threads the reply under the original in the recipient's client.
            msg["In-Reply-To"] = in_reply_to
            msg["References"] = in_reply_to

        if account["smtp_security"] == "ssl":
            smtp = smtplib.SMTP_SSL(account["smtp_host"], account["smtp_port"], timeout=10)
        else:
            smtp = smtplib.SMTP(account["smtp_host"], account["smtp_port"], timeout=10)
            if account["smtp_security"] == "starttls":
                smtp.starttls()
        try:
            smtp.login(account["email"], password)
            recipients = [a.strip() for a in f"{to},{cc or ''}".split(",") if a.strip()]
            smtp.sendmail(account["email"], recipients, msg.as_string())
        finally:
            smtp.quit()


def _uidvalidity(imap) -> str:
    _, values = imap.response("UIDVALIDITY")
    if not values or not values[0] or not values[0].strip().isdigit():
        raise ValueError("The mailbox did not provide a stable message reference")
    return values[0].decode().strip()


def _watch_header(msg, uid, validity):
    return {"uid": uid, "uidvalidity": validity, "from": _decode_header(msg.get("From", ""))[:1000],
            "subject": _decode_header(msg.get("Subject", ""))[:1000], "date": msg.get("Date", "")[:200],
            "message_id": msg.get("Message-ID", "")[:1000], "list_unsubscribe": bool(msg.get("List-Unsubscribe")),
            "precedence": msg.get("Precedence", "")[:100], "auto_submitted": msg.get("Auto-Submitted", "")[:100]}


def _plain_body(msg):
    texts = []
    for part in msg.walk():
        if part.get_content_type() != "text/plain" or part.get_content_disposition() == "attachment":
            continue
        payload = part.get_payload(decode=True) or b""
        try:
            text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except LookupError:
            text = payload.decode("utf-8", errors="replace")
        texts.append(text[:8000])
        if sum(len(t) for t in texts) >= 8000:
            break
    return "\n".join(texts)[:8000]


def _decode_header(raw: str) -> str:
    if not raw:
        return ""
    parts = decode_header(raw)
    decoded = ""
    for text, enc in parts:
        if isinstance(text, bytes):
            decoded += text.decode(enc or "utf-8", errors="replace")
        else:
            decoded += text
    return decoded


email_service = EmailService()

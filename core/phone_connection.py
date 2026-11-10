"""The "Phone" connection (build spec step 8): one per account, through the person's OWN Twilio or Telnyx account.

Kairos never buys a number or creates a provider account. The person brings: the provider, its keys, a number they
already own, their own mobile number, and (for calls) an address the provider can reach. Everything here is per
account: the record lives in that account's folder, secrets are sealed with that account's key, and nothing runs for
an account without a saved, enabled connection.

Twilio:  account SID (setting) + auth token (secret; it is also what signs Twilio's webhooks).
Telnyx:  API key (secret) + the account's webhook public key (setting, ed25519) + a call-control connection ID.
"""
import os
import re
import threading
from typing import Optional
from urllib.parse import urlsplit

from core import accounts
from core.atomic_io import read_json, write_json_atomic
from core.secret_storage import decrypt_for, encrypt_for

FILE = "phone_connection.json"
PROVIDERS = ("twilio", "telnyx")
_NUMBER = re.compile(r"\+[1-9]\d{6,14}")
_LOCK = threading.RLock()

# Which settings each provider needs: (key, label, secret)
FIELDS = {
    "twilio": (("account_sid", "Account SID", False), ("auth_token", "Auth token", True)),
    "telnyx": (("api_key", "API key", True), ("public_key", "Webhook public key", False),
               ("connection_id", "Call control application ID", False)),
}


class PhoneError(ValueError):
    """Message is meant to be shown to the person as-is."""


def normalize_number(value) -> str:
    """+15551234567 form, or '' when it is not a phone number. Formatting characters are ignored; a number
    without a leading + is not guessed at."""
    text = re.sub(r"[\s().\-]", "", str(value or ""))
    return text if _NUMBER.fullmatch(text) else ""


def same_number(a, b) -> bool:
    a, b = normalize_number(a), normalize_number(b)
    return bool(a) and a == b


def _check_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise PhoneError("The public address must be an https address with no password or query, such as https://my-pc.tailnet.ts.net:8422.")
    return value.rstrip("/")


def _file(account: Optional[str] = None, create: bool = True) -> str:
    return os.path.join(accounts.account_dir(account, create=create), FILE)


def get(account: Optional[str] = None) -> Optional[dict]:
    """The raw record (secrets sealed), or None."""
    record = read_json(_file(account, create=False), None)
    return record if isinstance(record, dict) and record.get("provider") in PROVIDERS else None


def secret(record: dict, key: str, account: Optional[str] = None) -> str:
    sealed = (record.get("secrets") or {}).get(key)
    return decrypt_for(account or accounts.effective_account(), sealed) if sealed else ""


def public(record: Optional[dict]) -> dict:
    """What the API shows: everything but secret values."""
    if not record:
        return {"configured": False}
    secrets = {key: bool((record.get("secrets") or {}).get(key)) for key in ("auth_token", "api_key")}
    shown = {k: v for k, v in record.items() if k not in ("secrets", "pin_hash")}
    return {**shown, "configured": True, "pin_set": bool(record.get("pin_hash")), "require_pin": pin_required(record), "secrets_set": secrets, "calls_ready": calls_ready(record),
            "webhook_paths": webhook_paths(record)}


def pin_required(record: dict) -> bool:
    """Caller ID can be spoofed, so a call from the verified mobile also needs the PIN unless it was turned off."""
    return record.get("require_pin") is not False


def check_pin(record: dict, digits) -> bool:
    import bcrypt
    digits = re.sub(r"\D", "", str(digits or ""))
    stored = record.get("pin_hash") or ""
    if not stored or not 4 <= len(digits) <= 8:
        return False
    try:
        return bcrypt.checkpw(digits.encode(), stored.encode())
    except ValueError:
        return False


def calls_ready(record: dict) -> bool:
    return bool(record.get("enabled") and record.get("public_url") and record.get("number") and record.get("user_number"))


def webhook_paths(record: dict) -> dict:
    """The addresses to paste into the provider, built from the person's public address."""
    base = record.get("public_url") or ""
    if record["provider"] == "twilio":
        return {"voice": base + "/api/phone/twilio/voice", "sms": base + "/api/phone/twilio/sms"}
    return {"voice": base + "/api/phone/telnyx/events", "sms": base + "/api/phone/telnyx/events"}


def accounts_to_scan() -> list[str]:
    return accounts.all_accounts()


def find_by_number(number) -> Optional[tuple[str, dict]]:
    """Which account's enabled Phone connection owns this number (the number a caller dialled)."""
    wanted = normalize_number(number)
    if not wanted:
        return None
    for account in accounts_to_scan():
        try:
            record = get(account)
        except (ValueError, OSError):
            continue
        if record and record.get("enabled") and same_number(record.get("number"), wanted):
            return account, record
    return None


def save(values: dict, account: Optional[str] = None) -> dict:
    """Create or update this account's Phone connection. An empty secret field keeps the saved secret."""
    account = account or accounts.effective_account()
    with _LOCK:
        existing = get(account) or {}
        provider = str(values.get("provider") or existing.get("provider") or "").lower()
        if provider not in PROVIDERS:
            raise PhoneError("Choose Twilio or Telnyx.")
        if existing and existing.get("provider") != provider:
            existing = {}   # a different provider starts clean; the old keys do not carry over
        settings, sealed = {}, dict(existing.get("secrets") or {})
        for key, label, is_secret in FIELDS[provider]:
            given = str(values.get(key) or "").strip()
            if is_secret:
                if given:
                    sealed[key] = encrypt_for(account, given)
                if not sealed.get(key):
                    raise PhoneError(f"{label} is needed.")
            else:
                settings[key] = given or str(existing.get(key) or "")
                if not settings[key]:
                    raise PhoneError(f"{label} is needed.")
        sealed = {k: v for k, v in sealed.items() if k in {f[0] for f in FIELDS[provider] if f[2]}}
        number = normalize_number(values.get("number", existing.get("number")))
        mobile = normalize_number(values.get("user_number", existing.get("user_number")))
        if not number:
            raise PhoneError("Enter the number you bought, with its country code, such as +15551234567.")
        if not mobile:
            raise PhoneError("Enter your own mobile number, with its country code, such as +15557654321.")
        if number == mobile:
            raise PhoneError("Your mobile number must be different from the number Kairos answers on.")
        taken = find_by_number(number)
        if taken and taken[0] != account:
            raise PhoneError("Another account already uses that number.")
        record = {
            "provider": provider, **settings, "secrets": sealed, "number": number, "user_number": mobile,
            "public_url": _check_url(values["public_url"] if "public_url" in values else existing.get("public_url", "")),
            "bot_id": str(values["bot_id"] if "bot_id" in values else existing.get("bot_id") or "").strip() or None,
            "conversation_endpoint_id": str((values["conversation_endpoint_id"] if "conversation_endpoint_id" in values
                                             else existing.get("conversation_endpoint_id")) or "").strip() or None,
            "conversation_model": str((values["conversation_model"] if "conversation_model" in values
                                       else existing.get("conversation_model")) or "").strip() or None,
            "enabled": bool(values["enabled"]) if "enabled" in values else bool(existing.get("enabled", True)),
            "require_pin": bool(values["require_pin"]) if "require_pin" in values else existing.get("require_pin", True) is not False,
            "pin_hash": existing.get("pin_hash"),
            # Calls to other people (step 9): off until the person turns them on, and they need the name a call is for.
            "others_enabled": bool(values["others_enabled"]) if "others_enabled" in values else bool(existing.get("others_enabled", False)),
            "caller_name": " ".join(str(values["caller_name"] if "caller_name" in values else existing.get("caller_name") or "").split())[:60],
        }
        pin = str(values.get("pin") or "").strip()
        if record["others_enabled"] and not record["caller_name"]:
            raise PhoneError("Enter your name for calls to other people, so a call can say who it is for.")
        if pin:
            if not re.fullmatch(r"\d{4,8}", pin):
                raise PhoneError("The PIN must be 4 to 8 digits.")
            import bcrypt
            record["pin_hash"] = bcrypt.hashpw(pin.encode(), bcrypt.gensalt()).decode()
        write_json_atomic(_file(account), record)
        return record


def delete(account: Optional[str] = None) -> bool:
    with _LOCK:
        path = _file(account, create=False)
        if os.path.exists(path):
            os.remove(path)
            return True
        return False

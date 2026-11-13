"""Native push for the Kairos iPhone app, through the Kairos push relay (specs/phone-api.md).

Apple's push service only takes pushes from the app's developer, with a key that must never sit on
people's computers. So this desktop never talks to Apple and holds no Apple key: it posts a short
request to the relay (a small web service that does hold it), and the relay passes the push on.

What this module is: the relay's wire format and nothing else. Which address, how a request is signed,
and how one queued notification (core/mobile_activity.py's outbox, the same one Web Push uses) becomes
one relay request. Sending and storing are services/mobile_notifications.py and core/mobile_activity.py.

What the relay is told, and no more: the phone's push tokens (once, when it registers), and per push a
kind, who it is from (a bot's or model's name), the chat's title, and opaque ids and a kairos-agents:// link so a
tap opens the right chat or approval. Never a message, a file name or the reason for a call. The relay builds
the sentence itself from a fixed list ("Kip wants your approval"); the name is the title and the chat's title the
subtitle. The phone's Private level does not reach this desktop (specs/phone-api.md), so the title is always sent.

With no relay address in settings (phone_push_relay_url), nothing is queued for phones and nothing is sent.
"""
import hashlib
import hmac
import ipaddress
import json
import re
import time
from typing import Optional
from urllib.parse import urlsplit

RELAY_SETTING = "phone_push_relay_url"
MAX_URL = 300
HEX_TOKEN = re.compile(r"[0-9a-fA-F]{64,200}")          # an APNs or VoIP device token, as the relay accepts it
ACTIVITY_TOKEN = re.compile(r"[0-9a-fA-F]{32,512}")     # a Live Activity's own push token
ENVIRONMENTS = ("sandbox", "production")
# What the phone lets a notification say (its NoticeDetail). "hideTitles" is Private: no chat title in any push.
# A phone that sends no level, or one this desktop does not know, is treated as generic.
NOTICE_DETAILS = ("generic", "hideTitles")
INSTALL_ID = re.compile(r"[A-Za-z0-9_-]{16,64}")
WHO_LIMIT = 40
DEFAULT_WHO = "Kairos"

# The desktop's notification kinds (core/mobile_activity.py) in the relay's four words. The relay has no
# word for "could not finish" or "test", so a failed chat is "needs you" (it wants a look) and a test is
# "a message". A question asked in a chat is "needs you"; a permission request is "approval".
ALERT_WHAT = {"completed": "message", "test": "message", "failed": "needs_you", "permission": "approval",
              "bot_needs_you": "needs_you", "bot_results": "done"}
RING_MIN_SECONDS_LEFT = 3       # the relay refuses a ring with less left than this, or further ahead than the max
RING_MAX_SECONDS_AHEAD = 300
ACTIVITY_STALE_SECONDS = 15 * 60    # the phone's own Live Activities go stale after fifteen minutes too
ACTIVITY_DISMISS_SECONDS = 15 * 60

# What the phone's native layer reads from a push (kairos-ios docs/coverage/native.md, "Push payload"), and
# what the relay carries of it. message_for() builds each push in full, to the phone's contract, and then keeps
# only the fields the relay accepts (relay/README.md in kairos-ios): the relay writes the Apple payload itself.
# An alert carries its kind as `notice` (the relay sets the category, so the right buttons show, and the
# thread), who, the chat title, the link, the request an Approve or Reply answers, and the run a Retry restarts.
# Still missing (specs/phone-api.md): a call screen shows the relay's "caller" and no bot id, and the end of a
# ring cannot be pushed at all, so the phone asks GET /api/rings/{id}.
RELAY_KINDS = frozenset({"alert", "ring", "activity"})          # no "ring_end" (a background push) yet
RELAY_FIELDS = {
    "alert": frozenset({"kind", "what", "who", "collapse_id", "notice", "title", "link", "request_id", "thread_id",
                        "activity_id", "activity_kind"}),
    "ring": frozenset({"kind", "ring_id", "expires_at", "who"}),
    "ring_end": frozenset({"kind", "ring_id", "outcome"}),
    "activity": frozenset({"kind", "event", "push_token", "content_state", "stale_date", "dismissal_date"}),
}
LINK = "kairos-agents://"
# The desktop's kinds as the phone's notification kinds (its category is "kairos.<kind>").
NATIVE_KIND = {"completed": "replyReady", "failed": "workFailed", "permission": "approval",
               "bot_needs_you": "question", "bot_results": "workDone"}
TITLE_LIMIT = 80             # the relay cuts a chat title to this too
# A chat run's state as the phone's Live Activity phase (KairosActivityAttributes.ContentState.phase), and the
# few fixed words shown as its step. Never words from the chat.
ACTIVITY_PHASE = {"running": "running", "awaiting_permission": "waiting", "completed": "done", "failed": "failed",
                  "stopped": "stopped", "interrupted": "stopped"}
ACTIVITY_STEP = {"running": "Working", "waiting": "Waiting for you", "done": "Done", "failed": "Couldn't finish",
                 "stopped": "Stopped"}
APPLE_EPOCH = 978307200     # ActivityKit reads a Date as seconds since 2001-01-01, not since 1970


def check_relay_url(url) -> str:
    """The relay address as it may be saved: https, a host, nothing else (no path, sign-in, query or
    fragment). Plain http is allowed only for this computer itself, for a relay run locally. Raises
    ValueError in words the settings page can show."""
    text = str(url or "").strip()
    if not text:
        return ""
    if len(text) > MAX_URL or any(ord(c) < 33 for c in text):
        raise ValueError("That is not a web address.")
    parts = urlsplit(text)
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("https", "http") or not host:
        raise ValueError("The relay address must start with https://")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("Give only the relay's address, for example https://relay.example.com")
    try:
        parts.port
    except ValueError:
        raise ValueError("That is not a web address.")
    if parts.scheme == "http":
        try:
            local = ipaddress.ip_address(host).is_loopback
        except ValueError:
            local = host == "localhost"
        if not local:
            raise ValueError("The relay address must start with https://")
    return f"{parts.scheme}://{parts.netloc}"


def relay_url() -> Optional[str]:
    """The saved relay address, or None when there is none (or what is saved would not pass the check)."""
    try:
        from core import settings as settings_store
        return check_relay_url(settings_store.get_setting(RELAY_SETTING)) or None
    except Exception:
        return None


def sign(secret: str, method: str, path: str, body: bytes, timestamp: Optional[int] = None) -> dict:
    """The two headers of a signed relay request. The relay keeps only SHA-256(secret) as hex; that hex text
    is the HMAC key on both sides. Signed: "<unix seconds>\\n<METHOD>\\n<path>\\n<sha256 hex of the body>"."""
    timestamp = int(time.time()) if timestamp is None else int(timestamp)
    verifier = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    text = f"{timestamp}\n{method.upper()}\n{path}\n{hashlib.sha256(body).hexdigest()}"
    signature = hmac.new(verifier.encode("utf-8"), text.encode("utf-8"), hashlib.sha256).hexdigest()
    return {"X-Kairos-Timestamp": str(timestamp), "X-Kairos-Signature": signature}


def encode(body: Optional[dict]) -> bytes:
    """The exact bytes sent and signed (ASCII, so no proxy can re-encode them)."""
    return b"" if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def clean_who(value) -> str:
    text = " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f  ]", " ", str(value or "")).split())[:WHO_LIMIT]
    return text or DEFAULT_WHO


def install_body(registration: dict) -> Optional[dict]:
    """What the relay stores for a phone, or None when the phone has not sent a device token yet."""
    apns = registration.get("apns_token")
    if not apns:
        return None
    return {"apns_token": apns, "voip_token": registration.get("voip_token") or None,
            "environment": registration.get("environment") if registration.get("environment") in ENVIRONMENTS else "production"}


def notice_detail(value) -> str:
    return value if value in NOTICE_DETAILS else "generic"


def hides_titles(registration: dict) -> bool:
    """Is this phone set to Private? Then the chat's title is left out of the relay call."""
    return notice_detail((registration or {}).get("detail")) == "hideTitles"


def clean_title(value) -> str:
    return " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]", " ", str(value or "")).split())[:TITLE_LIMIT]


def native_alert(kind: str, payload: dict) -> dict:
    """The fields the phone reads from an alert so a tap opens the exact chat or approval and the right buttons
    show: its kind (the relay makes the category from it), where the tap goes, the thread it groups in, the
    request an Approve or Reply answers, the run a Retry restarts, and the chat's title. Opaque ids only.

    A bot's approval or question opens that bot's inbox (approval/<request>?bot=<id>); a model chat's opens the
    chat itself, where the request is shown."""
    native = NATIVE_KIND.get(kind)
    if kind == "permission" and payload.get("ask") == "question":
        native = "question"
    if native is None:
        return {}
    bot, session, request = payload.get("agent_id"), payload.get("session_id"), payload.get("request_id")
    if native in ("approval", "question") and request and bot:
        link = f"{LINK}approval/{request}?bot={bot}"
    elif session:
        link = f"{LINK}chat/{session}"
    elif bot:
        link = f"{LINK}bot/{bot}"
    else:
        link = f"{LINK}home"
    fields = {"notice": native, "link": link}
    if bot:
        fields["thread_id"] = "bot-" + str(bot)
    elif session:
        fields["thread_id"] = "chat-" + str(session)
    title = clean_title(payload.get("title"))
    if title:
        fields["title"] = title
    if request and native in ("approval", "question"):
        fields["request_id"] = str(request)
    if payload.get("run_id"):
        fields["activity_id"], fields["activity_kind"] = str(payload["run_id"]), "reply"
    return fields


def activity_state(payload: dict, now: float) -> dict:
    """A chat run's state as the phone's ContentState, every key it decodes: the phase, fixed words for the
    step, and when the run began. No detail, no progress and no helper chips: those would be the chat's own words."""
    phase = ACTIVITY_PHASE.get(str(payload.get("state") or ""), "running")
    return {"phase": phase, "step": ACTIVITY_STEP[phase], "detail": "", "stage": 0, "helpers": [],
            "startedAt": float(payload.get("started_at") or now) - APPLE_EPOCH, "muted": False}


def message_for(kind: str, payload: dict, registration: dict, now: Optional[float] = None) -> Optional[dict]:
    """One queued notification as a relay push body, or None when there is nothing to send for it (or nothing
    the relay can carry yet).

    A ring goes out as a call (the phone's call screen) when the phone gave a call token, else as a "needs you"
    alert. The end of a ring is a background push, never a call push: every call push must show an incoming call."""
    now = time.time() if now is None else now
    who = clean_who(payload.get("who"))
    if hides_titles(registration):
        payload = {key: value for key, value in payload.items() if key != "title"}
    body = None
    if kind == "bot_call":
        expires_at = int(float(payload.get("expires_at") or 0))
        if expires_at - now < RING_MIN_SECONDS_LEFT or not payload.get("ring_id"):
            return None
        ring_id, bot = str(payload["ring_id"]), payload.get("agent_id")
        if registration.get("voip_token"):
            body = {"kind": "ring", "ring_id": ring_id, "who": who, "expires_at": min(expires_at, int(now) + RING_MAX_SECONDS_AHEAD),
                    "agent_id": bot, "bot_name": who}
        else:
            body = {"kind": "alert", "what": "needs_you", "who": who, "collapse_id": _collapse("ring-" + ring_id),
                    "link": f"{LINK}ring/{ring_id}" + (f"?bot={bot}" if bot else "")}
    elif kind == "bot_call_end":
        if not payload.get("ring_id"):
            return None
        body = {"kind": "ring_end", "ring_id": str(payload["ring_id"]), "outcome": str(payload.get("outcome") or "")}
    elif kind == "activity":
        token = str(payload.get("push_token") or "")
        if payload.get("event") not in ("update", "end") or not ACTIVITY_TOKEN.fullmatch(token):
            return None
        body = {"kind": "activity", "event": payload["event"], "push_token": token, "content_state": activity_state(payload, now)}
        if payload["event"] == "end":
            body["dismissal_date"] = int(now) + ACTIVITY_DISMISS_SECONDS
        else:
            body["stale_date"] = int(now) + ACTIVITY_STALE_SECONDS
    elif kind in ALERT_WHAT:
        what = "needs_you" if kind == "permission" and payload.get("ask") == "question" else ALERT_WHAT[kind]
        body = {"kind": "alert", "what": what, "who": who, "collapse_id": _collapse(payload.get("collapse_id")),
                **native_alert(kind, payload)}
    if body is None or body["kind"] not in RELAY_KINDS:
        return None
    out = {key: value for key, value in body.items() if key in RELAY_FIELDS[body["kind"]] and value is not None}
    if out.get("thread_id") and not _collapse(out["thread_id"]):
        out.pop("thread_id")        # the relay takes up to 64 plain characters; it groups by chat link without one
    return out


def _collapse(value) -> Optional[str]:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", text) else None

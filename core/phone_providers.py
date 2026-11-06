"""Twilio and Telnyx for the Phone connection (build spec step 8): who signed a webhook, how to place a call or a text,
and the shape of each provider's media-stream messages.

Nothing here talks to a network unless a method is awaited with the person's own saved keys, and every HTTP client takes
an injected transport so tests never leave the machine. A webhook is trusted only after `verify()` has checked the
provider's signature with the key of the account the number belongs to; anything else is refused.

Written from the providers' public documentation and NOT yet exercised against a real account: the Telnyx call-control
actions and the Telnyx stream message shapes in particular must be checked once against a real number (see the build
note), which is why each is a small, isolated function.
"""
import base64
import binascii
import hashlib
import hmac
import json
import time
from collections import OrderedDict
from typing import Optional
from urllib.parse import parse_qsl
from xml.sax.saxutils import escape, quoteattr

import httpx

TELNYX_TOLERANCE_SECONDS = 300


class SignatureError(Exception):
    """A webhook that is unsigned, forged, stale or replayed."""


class ProviderError(Exception):
    """A provider call that failed. Never carries the request (it holds keys)."""


def _header(headers: dict, name: str) -> str:
    return next((v for k, v in headers.items() if k.lower() == name.lower()), "")


class ReplayCache:
    """Signatures already accepted, so a captured request cannot be sent again. Bounded; entries expire."""

    def __init__(self, ttl: float = 900.0, limit: int = 4096):
        self.ttl, self.limit, self.items = ttl, limit, OrderedDict()

    def seen(self, key: str, now: Optional[float] = None) -> bool:
        """True when `key` was already used (a replay); otherwise remembers it and returns False."""
        now = time.time() if now is None else now
        while self.items and (len(self.items) > self.limit or next(iter(self.items.values())) < now - self.ttl):
            self.items.popitem(last=False)
        if key in self.items and self.items[key] >= now - self.ttl:
            return True
        self.items[key] = now
        return False


# -- Twilio -------------------------------------------------------------------------------------

def twilio_signature(auth_token: str, url: str, params: dict) -> str:
    payload = url + "".join(k + v for k, v in sorted(params.items()))
    return base64.b64encode(hmac.new(auth_token.encode(), payload.encode(), hashlib.sha1).digest()).decode()


def verify_twilio(auth_token: str, url: str, params: dict, headers: dict) -> None:
    given = _header(headers, "X-Twilio-Signature")
    if not auth_token or not given or not hmac.compare_digest(twilio_signature(auth_token, url, params), given):
        raise SignatureError("bad signature")


def parse_form(body: bytes) -> dict:
    return dict(parse_qsl(body.decode("utf-8", errors="replace"), keep_blank_values=True))


def twiml_stream(stream_url: str, token: str) -> bytes:
    return (f'<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url={quoteattr(stream_url)}>'
            f'<Parameter name="t" value={quoteattr(token)}/></Stream></Connect></Response>').encode()


def twiml_gather(action_url: str, prompt: str, goodbye: str) -> bytes:
    """Ask for the PIN on the keypad (ends on #); if nothing is entered, say goodbye and hang up."""
    return (f'<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf" finishOnKey="#" timeout="8" '
            f'action={quoteattr(action_url)} method="POST"><Say>{escape(prompt)}</Say></Gather>'
            f'<Say>{escape(goodbye)}</Say><Hangup/></Response>').encode()


def twiml_say(text: str) -> bytes:
    return (f'<?xml version="1.0" encoding="UTF-8"?><Response><Say>{escape(text)}</Say><Hangup/></Response>').encode()


# -- Telnyx -------------------------------------------------------------------------------------

def verify_telnyx(public_key_b64: str, body: bytes, headers: dict, now: Optional[float] = None) -> None:
    """ed25519 over "<timestamp>|<raw body>", with a five minute tolerance on the timestamp."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    signature = _header(headers, "telnyx-signature-ed25519")
    stamp = _header(headers, "telnyx-timestamp")
    if not signature or not stamp or not public_key_b64:
        raise SignatureError("bad signature")
    try:
        age = abs((time.time() if now is None else now) - int(stamp))
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64, validate=True))
        key.verify(base64.b64decode(signature, validate=True), stamp.encode() + b"|" + body)
    except (ValueError, binascii.Error, InvalidSignature):
        raise SignatureError("bad signature") from None
    if age > TELNYX_TOLERANCE_SECONDS:
        raise SignatureError("stale")


# -- the provider objects -----------------------------------------------------------------------

class Provider:
    name = ""

    def __init__(self, record: dict, secrets: dict, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.record, self._secrets, self.transport = record, secrets, transport

    def client(self, **kwargs) -> httpx.AsyncClient:
        kwargs.setdefault("timeout", httpx.Timeout(20.0, connect=10.0))
        return httpx.AsyncClient(transport=self.transport, trust_env=False, follow_redirects=False, **kwargs)

    def _checked(self, response: httpx.Response, what: str) -> dict:
        if response.status_code >= 400:
            raise ProviderError(f"{what} failed ({response.status_code})")
        try:
            return response.json() if response.content else {}
        except ValueError:
            return {}

    @property
    def base(self) -> str:
        return self.record.get("public_url") or ""

    def stream_url(self) -> str:
        return self.base.replace("https://", "wss://", 1) + f"/api/phone/{self.name}/stream"

    # codec of the media stream
    def parse_stream(self, text: str) -> tuple:
        raise NotImplementedError

    def media_frame(self, stream_id: str, payload: bytes) -> str:
        raise NotImplementedError

    def clear_frame(self, stream_id: str) -> str:
        raise NotImplementedError


class Twilio(Provider):
    name = "twilio"

    @property
    def _sid(self) -> str:
        return self.record.get("account_sid", "")

    def auth(self) -> tuple:
        return (self._sid, self._secrets.get("auth_token", ""))

    def voice_url(self, query: str = "") -> str:
        return self.base + "/api/phone/twilio/voice" + (("?" + query) if query else "")

    def verify_voice(self, url: str, body: bytes, headers: dict) -> dict:
        params = parse_form(body)
        verify_twilio(self._secrets.get("auth_token", ""), url, params, headers)
        return params

    def verify_stream_handshake(self, headers: dict) -> None:
        # Twilio signs the stream address; the scheme it signs (wss or https) is not settled in its docs, and both are
        # the same address with the same secret, so either form is accepted.
        for url in (self.stream_url(), self.base + "/api/phone/twilio/stream"):
            try:
                return verify_twilio(self._secrets.get("auth_token", ""), url, {}, headers)
            except SignatureError:
                continue
        raise SignatureError("bad signature")

    async def place_call(self, to: str, from_: str, url: str) -> str:
        async with self.client(auth=self.auth()) as api:
            data = self._checked(await api.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{self._sid}/Calls.json",
                data={"To": to, "From": from_, "Url": url, "Method": "POST"}), "Placing the call")
        return str(data.get("sid") or "")

    async def send_sms(self, to: str, from_: str, text: str) -> str:
        async with self.client(auth=self.auth()) as api:
            data = self._checked(await api.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{self._sid}/Messages.json",
                data={"From": from_, "To": to, "Body": text}), "Sending the text")
        return str(data.get("sid") or "")

    def parse_stream(self, text: str) -> tuple:
        """-> ('start', {stream_id, call_id, token}) | ('media', bytes) | ('stop', None) | ('other', None)"""
        try:
            message = json.loads(text)
        except ValueError:
            return ("other", None)
        event = message.get("event")
        if event == "start":
            start = message.get("start") or {}
            return ("start", {"stream_id": str(start.get("streamSid") or message.get("streamSid") or ""),
                              "call_id": str(start.get("callSid") or ""),
                              "token": str((start.get("customParameters") or {}).get("t") or "")})
        if event == "media":
            media = message.get("media") or {}
            if media.get("track", "inbound") != "inbound":
                return ("other", None)
            try:
                return ("media", base64.b64decode(media.get("payload") or "", validate=True))
            except (ValueError, binascii.Error):
                return ("other", None)
        if event == "stop":
            return ("stop", None)
        return ("other", None)

    def media_frame(self, stream_id: str, payload: bytes) -> str:
        return json.dumps({"event": "media", "streamSid": stream_id, "media": {"payload": base64.b64encode(payload).decode()}})

    def clear_frame(self, stream_id: str) -> str:
        return json.dumps({"event": "clear", "streamSid": stream_id})

    async def hangup(self, call_id: str) -> None:
        if not call_id:
            return
        async with self.client(auth=self.auth()) as api:
            self._checked(await api.post(f"https://api.twilio.com/2010-04-01/Accounts/{self._sid}/Calls/{call_id}.json",
                                         data={"Status": "completed"}), "Ending the call")


class Telnyx(Provider):
    name = "telnyx"

    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self._secrets.get('api_key', '')}"}

    def verify_event(self, body: bytes, headers: dict) -> dict:
        verify_telnyx(self.record.get("public_key", ""), body, headers)
        try:
            return json.loads(body or b"{}")
        except ValueError:
            raise SignatureError("bad body") from None

    async def place_call(self, to: str, from_: str, client_state: str) -> str:
        async with self.client(headers=self.headers()) as api:
            data = self._checked(await api.post("https://api.telnyx.com/v2/calls", json={
                "connection_id": self.record.get("connection_id", ""), "to": to, "from": from_,
                "webhook_url": self.base + "/api/phone/telnyx/events",
                "client_state": base64.b64encode(client_state.encode()).decode()}), "Placing the call")
        return str((data.get("data") or {}).get("call_control_id") or "")

    async def send_sms(self, to: str, from_: str, text: str) -> str:
        async with self.client(headers=self.headers()) as api:
            data = self._checked(await api.post("https://api.telnyx.com/v2/messages",
                                                json={"from": from_, "to": to, "text": text, "type": "SMS"}), "Sending the text")
        return str((data.get("data") or {}).get("id") or "")

    async def action(self, call_control_id: str, action: str, body: Optional[dict] = None) -> None:
        async with self.client(headers=self.headers()) as api:
            self._checked(await api.post(f"https://api.telnyx.com/v2/calls/{call_control_id}/actions/{action}",
                                         json=body or {}), f"Telnyx {action}")

    async def answer_with_stream(self, call_control_id: str, token: str) -> None:
        await self.action(call_control_id, "answer", self.stream_body(token))

    async def start_stream(self, call_control_id: str, token: str) -> None:
        await self.action(call_control_id, "streaming_start", self.stream_body(token))

    def stream_body(self, token: str) -> dict:
        return {"stream_url": f"{self.stream_url()}?t={token}", "stream_track": "inbound_track",
                "stream_bidirectional_mode": "rtp", "stream_bidirectional_codec": "PCMU"}

    async def hangup(self, call_control_id: str) -> None:
        if call_control_id:
            await self.action(call_control_id, "hangup")

    def parse_stream(self, text: str) -> tuple:
        try:
            message = json.loads(text)
        except ValueError:
            return ("other", None)
        event = message.get("event")
        if event == "start":
            start = message.get("start") or {}
            return ("start", {"stream_id": str(message.get("stream_id") or ""), "call_id": str(start.get("call_control_id") or ""),
                              "token": ""})
        if event == "media":
            media = message.get("media") or {}
            if media.get("track", "inbound") != "inbound":
                return ("other", None)
            try:
                return ("media", base64.b64decode(media.get("payload") or "", validate=True))
            except (ValueError, binascii.Error):
                return ("other", None)
        if event == "stop":
            return ("stop", None)
        return ("other", None)

    def media_frame(self, stream_id: str, payload: bytes) -> str:
        return json.dumps({"event": "media", "media": {"payload": base64.b64encode(payload).decode()}})

    def clear_frame(self, stream_id: str) -> str:
        return json.dumps({"event": "clear"})


KINDS = {"twilio": Twilio, "telnyx": Telnyx}


def build(record: dict, secrets: dict, transport: Optional[httpx.AsyncBaseTransport] = None) -> Provider:
    return KINDS[record["provider"]](record, secrets, transport)

"""Platforms that deliver messages to a URL: SMS through Twilio, WhatsApp
Cloud API, LINE, and a generic signed webhook. Each verifies the platform's
signature before reading anything, answers the webhook at once, and handles
the message in the background (Hub.spawn). They receive only once Kairos's
webhook URL is reachable from the internet; sending works regardless.

References: Hermes plugins/platforms/sms, plugins/platforms/line and
gateway/platforms/whatsapp_cloud.py, gateway/platforms/webhook.py (MIT)."""
import base64
import hashlib
import hmac
import json
import os
import re
import time
from collections import OrderedDict
from urllib.parse import parse_qsl

from core.connectors import register
from core.connectors.base import Connector, ConnectorError, Field, Inbound, require

WINDOW_SECONDS = 24 * 3600
OUTSIDE_WINDOW_CODE = "131047"   # Meta: "Re-engagement message", more than 24 hours since the person last wrote
TEMPLATE_PARAM_LIMIT = 900       # kept under Meta's per-variable limit; unverified against a live account
NO_TEMPLATE = ("WhatsApp allows free text only within 24 hours of your last message to this number, and no approved "
               "message template is set (Settings > Channels > WhatsApp).")


def _digits(number) -> str:
    return "".join(ch for ch in str(number or "") if ch.isdigit())


def _template_text(text, limit: int) -> str:
    """Meta refuses template variables with new lines, tabs or more than four spaces in a row."""
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip()
    return cleaned if len(cleaned) <= limit else cleaned[:limit - 1].rstrip() + "\u2026"


# Settings copy for texting in the US (Calls and Texts to Users research, section 4.5). No prices: they change and
# belong to the provider.
SMS_US_HELP = ("Texting US numbers: carriers block texts from numbers that are not registered. Before bots text you, "
               "register this number for A2P 10DLC in your provider account (Sole Proprietor if you have no business "
               "tax ID) or use a verified toll-free number. Approval can take days to weeks, and the provider charges "
               "its own fees.")

URL_HELP = "The address that reaches this connector's webhook from the internet, exactly as the platform will call it."


def _header(headers: dict, name: str) -> str:
    return next((v for k, v in headers.items() if k.lower() == name.lower()), "")


class _Sent:
    """Platforms that tell us which message was replied to by its ID: the
    text of what we sent recently, so a reply to a notification can find
    its code. Bounded; a reply to something older is an ordinary message."""

    def __init__(self, limit: int = 500):
        self.limit, self.items = limit, OrderedDict()

    def remember(self, message_id, text: str) -> None:
        if message_id:
            self.items[str(message_id)] = text
            while len(self.items) > self.limit:
                self.items.popitem(last=False)

    def text(self, message_id) -> str:
        return self.items.get(str(message_id or ""), "")


@register
class TwilioSMS(Connector):
    kind = "sms"
    label = "SMS (Twilio)"
    webhook = True
    description = "Text Kairos from your phone through a Twilio number."
    docs_url = "https://www.twilio.com/docs/messaging/guides/webhook-request"
    message_limit = 1500
    target_field = "default_to"
    sender_help = "Phone numbers allowed to text Kairos, in +15551234567 form, one per line."
    fields = (
        Field("account_sid", "Account SID", placeholder="AC..."),
        Field("auth_token", "Auth token", secret=True),
        Field("from_number", "Twilio number", placeholder="+15551234567", help=SMS_US_HELP),
        Field("public_url", "Public webhook URL", help=URL_HELP + " Set it as the number's incoming-message webhook."),
        Field("default_to", "Notify (number)", required=False),
    )

    def signature_ok(self, headers: dict, params: dict) -> bool:
        payload = self.setting("public_url") + "".join(k + v for k, v in sorted(params.items()))
        expected = base64.b64encode(hmac.new(self.setting("auth_token").encode(), payload.encode(), hashlib.sha1).digest())
        return hmac.compare_digest(expected.decode(), _header(headers, "X-Twilio-Signature"))

    async def handle_webhook(self, method, headers, query, body):
        params = dict(parse_qsl(body.decode("utf-8", errors="replace"), keep_blank_values=True))
        if method != "POST" or not self.signature_ok(headers, params):
            return 403, b"bad signature", "text/plain"
        self.hub.spawn(self, Inbound(conversation=params.get("From", ""), sender=params.get("From", ""),
                                     text=params.get("Body", "")))
        return 200, b"<Response/>", "application/xml"

    async def send(self, conversation: str, text: str) -> None:
        sid = self.setting("account_sid")
        async with self.http(auth=(sid, self.setting("auth_token"))) as api:
            require(await api.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                                   data={"From": self.setting("from_number"), "To": conversation, "Body": text}),
                    "Sending an SMS")


@register
class WhatsAppCloud(Connector):
    kind = "whatsapp"
    label = "WhatsApp (Cloud API)"
    webhook = True
    description = "A WhatsApp Business number through Meta's Cloud API."
    docs_url = "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
    message_limit = 4096
    target_field = "default_to"
    sender_help = "WhatsApp numbers allowed to message Kairos, digits with country code (15551234567), one per line."
    fields = (
        Field("phone_number_id", "Phone number ID"),
        Field("access_token", "Access token", secret=True),
        Field("app_secret", "App secret", secret=True, help="Signs every webhook; requests without a valid signature are refused."),
        Field("verify_token", "Verify token", secret=True, help="Any string; enter the same one in Meta's webhook setup."),
        Field("default_to", "Notify (number)", required=False),
        Field("template_name", "Message template", required=False, placeholder="kairos_update",
              help=("WhatsApp lets a business send free text only within 24 hours of your last message to it. After that "
                    "it needs a message template you registered and Meta approved in your WhatsApp Business account. "
                    "Enter its name, and Kairos sends that template instead. With none, a bot's message goes to the "
                    "next way in Settings > Reach me.")),
        Field("template_language", "Template language", required=False, default="en_US", placeholder="en_US",
              help="The language code the template was approved in."),
        Field("template_params", "Template variables", required=False, default="bot,message", placeholder="bot,message",
              help=("What fills the template's body variables, in order: bot (the bot's name) and message (its text, "
                    "shortened to fit). Use none for a template without variables.")),
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.sent = _Sent()

    # -- the 24-hour customer service window ------------------------------------------------------------

    def _window_file(self) -> str:
        from core import accounts
        from core.connectors import store
        return os.path.join(accounts.account_dir(store.account_of(self.record)), "whatsapp_windows.json")

    def opened(self, number: str):
        """When this number last wrote to us (the 24-hour window opens then), or None when not known."""
        from core.atomic_io import read_json
        value = (read_json(self._window_file(), {}).get(self.record.get("id", ""), {}) or {}).get(_digits(number))
        return float(value) if isinstance(value, (int, float)) else None

    def note_inbound(self, number: str, at=None) -> None:
        from core.atomic_io import read_json, write_json_atomic
        path = self._window_file()
        data = read_json(path, {})
        mine = data.setdefault(self.record.get("id", ""), {})
        mine[_digits(number)] = time.time() if at is None else at
        if len(mine) > 200:
            for key in sorted(mine, key=mine.get)[:-200]:
                mine.pop(key, None)
        write_json_atomic(path, data)

    def window_open(self, number: str, now=None):
        """True inside the 24 hours (with five minutes to spare), False after, None when never seen."""
        opened = self.opened(number)
        if opened is None:
            return None
        return (time.time() if now is None else now) - opened < WINDOW_SECONDS - 300

    def template(self) -> dict:
        name = self.setting("template_name").strip()
        params = [p.strip().lower() for p in (self.setting("template_params", "bot,message") or "").split(",") if p.strip()]
        return {"name": name, "language": self.setting("template_language", "en_US").strip() or "en_US",
                "params": [] if params in (["none"], []) else [p for p in params if p in ("bot", "message")]}

    async def handle_webhook(self, method, headers, query, body):
        if method == "GET":
            if query.get("hub.mode") == "subscribe" and hmac.compare_digest(query.get("hub.verify_token", ""),
                                                                            self.setting("verify_token")):
                return 200, query.get("hub.challenge", "").encode(), "text/plain"
            return 403, b"bad verify token", "text/plain"
        expected = "sha256=" + hmac.new(self.setting("app_secret").encode(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, _header(headers, "X-Hub-Signature-256")):
            return 403, b"bad signature", "text/plain"
        payload = json.loads(body or b"{}")
        for entry in payload.get("entry") or []:
            for change in entry.get("changes") or []:
                for message in (change.get("value") or {}).get("messages") or []:
                    if message.get("from"):
                        try:
                            self.note_inbound(message["from"])     # any message opens the 24-hour window
                        except Exception:
                            pass
                    if message.get("type") != "text":
                        continue
                    replied = (message.get("context") or {}).get("id")
                    self.hub.spawn(self, Inbound(conversation=message["from"], sender=message["from"],
                                                 text=(message.get("text") or {}).get("body", ""),
                                                 replying_to=self.sent.text(replied)))
        return 200, b"ok", "text/plain"

    async def send(self, conversation: str, text: str, bot_name: str = "Kairos") -> str:
        """Free text inside the 24-hour window; the approved template outside it. 'text' or 'template': what went.
        Outside the window with no template set, a ConnectorError says so plainly (Meta would refuse the text)."""
        template = self.template()
        window = self.window_open(conversation)
        if window is False:
            if not template["name"]:
                raise ConnectorError(NO_TEMPLATE)
            await self.send_template(conversation, text, bot_name, template)
            return "template"
        try:
            await self._post(conversation, {"type": "text", "text": {"body": text}}, text)
            return "text"
        except ConnectorError as error:
            if OUTSIDE_WINDOW_CODE not in str(error):
                raise
            if not template["name"]:
                raise ConnectorError(NO_TEMPLATE) from None
        await self.send_template(conversation, text, bot_name, template)
        return "template"

    async def send_template(self, conversation: str, text: str, bot_name: str, template: dict) -> None:
        values = {"bot": _template_text(bot_name, 60), "message": _template_text(text, TEMPLATE_PARAM_LIMIT)}
        body = {"name": template["name"], "language": {"code": template["language"]}}
        if template["params"]:
            body["components"] = [{"type": "body", "parameters": [{"type": "text", "text": values[p] or "-"}
                                                                  for p in template["params"]]}]
        await self._post(conversation, {"type": "template", "template": body}, text)

    async def _post(self, conversation: str, payload: dict, text: str) -> None:
        async with self.http(headers={"Authorization": f"Bearer {self.setting('access_token')}"}) as api:
            data = require(await api.post(f"https://graph.facebook.com/v21.0/{self.setting('phone_number_id')}/messages",
                                          json={"messaging_product": "whatsapp", "to": conversation, **payload}),
                           "Sending to WhatsApp")
            for message in data.get("messages") or []:
                self.sent.remember(message.get("id"), text)


@register
class Line(Connector):
    kind = "line"
    label = "LINE"
    webhook = True
    description = "A LINE Official Account through the Messaging API."
    docs_url = "https://developers.line.biz/en/docs/messaging-api/getting-started/"
    message_limit = 5000
    target_field = "default_to"
    sender_help = "LINE user IDs (U followed by 32 characters), one per line."
    fields = (
        Field("channel_secret", "Channel secret", secret=True),
        Field("access_token", "Channel access token", secret=True),
        Field("default_to", "Notify (user ID)", required=False),
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.sent = _Sent()

    async def handle_webhook(self, method, headers, query, body):
        expected = base64.b64encode(hmac.new(self.setting("channel_secret").encode(), body, hashlib.sha256).digest()).decode()
        if method != "POST" or not hmac.compare_digest(expected, _header(headers, "X-Line-Signature")):
            return 403, b"bad signature", "text/plain"
        for event in json.loads(body or b"{}").get("events") or []:
            message, source = event.get("message") or {}, event.get("source") or {}
            if event.get("type") != "message" or message.get("type") != "text":
                continue
            conversation = source.get("groupId") or source.get("roomId") or source.get("userId", "")
            self.hub.spawn(self, Inbound(conversation=conversation, sender=source.get("userId", ""),
                                         text=message.get("text", ""),
                                         replying_to=self.sent.text(message.get("quotedMessageId"))))
        return 200, b"ok", "text/plain"

    async def send(self, conversation: str, text: str) -> None:
        async with self.http(headers={"Authorization": f"Bearer {self.setting('access_token')}"}) as api:
            data = require(await api.post("https://api.line.me/v2/bot/message/push",
                                          json={"to": conversation, "messages": [{"type": "text", "text": text}]}),
                           "Sending to LINE")
            for sent in data.get("sentMessages") or []:
                self.sent.remember(sent.get("id"), text)


@register
class GenericWebhook(Connector):
    kind = "webhook"
    label = "Webhook"
    webhook = True
    description = ("Any service or script: POST signed JSON to Kairos; replies are POSTed to your URL. "
                   'Body: {"text": "...", "sender": "...", "conversation": "..."}; header '
                   "X-JARVIS-Signature: sha256=<HMAC-SHA256 of the body with the secret>.")
    docs_url = ""
    message_limit = 20000
    target_field = "reply_url"
    sender_help = "Sender names your service will put in \"sender\", one per line."
    fields = (
        Field("secret", "Signing secret", secret=True, help="Shared with the sending service; unsigned requests are refused."),
        Field("reply_url", "Reply URL", required=False, help="Where Kairos POSTs replies and notifications as JSON."),
    )

    async def handle_webhook(self, method, headers, query, body):
        expected = "sha256=" + hmac.new(self.setting("secret").encode(), body, hashlib.sha256).hexdigest()
        if method != "POST" or not hmac.compare_digest(expected, _header(headers, "X-JARVIS-Signature")):
            return 403, b"bad signature", "text/plain"
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            return 400, b"body must be JSON", "text/plain"
        sender = str(payload.get("sender") or "")
        self.hub.spawn(self, Inbound(conversation=str(payload.get("conversation") or sender), sender=sender,
                                     text=str(payload.get("text") or ""), replying_to=str(payload.get("replying_to") or "")))
        return 202, b'{"accepted": true}', "application/json"

    async def send(self, conversation: str, text: str) -> None:
        url = self.setting("reply_url")
        if not url:
            return
        body = json.dumps({"conversation": conversation, "text": text}).encode()
        signature = "sha256=" + hmac.new(self.setting("secret").encode(), body, hashlib.sha256).hexdigest()
        async with self.http() as api:
            require(await api.post(url, content=body, headers={"Content-Type": "application/json",
                                                               "X-JARVIS-Signature": signature}), "Posting the reply")

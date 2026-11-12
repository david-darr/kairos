"""One supervised outbox sender per host, independent of browser connections."""
import asyncio
import contextlib
import json
import logging
import time

import httpx
from core import mobile_activity as store, permissions, web_push
from core.auth import auth_manager, auth_enabled
from core.session_manager import session_manager

logger = logging.getLogger(__name__)
_worker = None


def _authorized_device(item):
    if item["binding"] == "local":
        return not auth_enabled()
    if item["binding"].startswith("phone:"):
        # A paired phone's native push: good exactly while that phone is still paired to this account.
        from core import phone_devices
        return any(device["id"] == item["binding"][6:] for device in phone_devices.devices_for(item["owner"]))
    return auth_manager.notification_session_valid(item["owner"], item["binding"])


async def deliver_due(client):
    """One pass over what is due. Browsers get Web Push (it needs this install's push keys, made the first time
    a browser enrolls); a paired phone gets the same notification through the push relay (core/phone_push.py).
    Every check below runs for both, before either is sent."""
    config = store.config()
    await _forget_at_relay(client)
    for item in store.due():
        phone = store.is_phone(item)
        if not phone and not config:
            continue
        if not _authorized_device(item):
            store.revoke(session_binding=item["binding"])
            continue
        # A bot push has no chat behind it; bots are admin-only (2026-10-14).
        if item["kind"] in store.BOT_KINDS:
            if not auth_manager.is_admin(item["owner"]):
                store.delivery_result(item, 403)
                continue
            session = None
        else:
            run = store.read_run(item["run_id"])
            session = _owners_session(item["owner"], run["session_id"]) if run else None
        if item["kind"] not in ("test", *store.BOT_KINDS) and (not session or (session.get("owner_user") not in (None, item["owner"])
                            and not auth_manager.is_admin(item["owner"]))):
            store.delivery_result(item, 403)
            continue
        if item["kind"] == "bot_call" and not _still_ringing(item):
            store.delivery_result(item, 409)
            continue
        if item["kind"] == "permission" and not permissions.pending_request(item["permission_id"]):
            store.delivery_result(item, 409)
            continue
        if phone:
            try:
                await _deliver_phone(client, item, session)
            except Exception:
                # Tokens, the relay secret and the payload must never reach logs: say only that it failed.
                logger.error("A phone push could not be sent; it will be retried")
                store.phone_result(item, "retry")
            continue
        try:
            subscription = web_push.validate(json.loads(item["subscription"]))
            response = await client.post(subscription["endpoint"], content=web_push.encrypt(subscription, item["payload"].encode()), headers={
                "Authorization": web_push.authorization(config["private"], subscription["endpoint"], config["subject"]),
                "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
                "TTL": str(max(0, int(item["expires"] - time.time()))),
                "Urgency": "high" if item["kind"] in ("permission", "bot_call", "bot_call_end") else "normal",
                "Topic": web_push.b64(bytes.fromhex(item["id"])[:24]),
            })
            try:
                retry_after = int(response.headers.get("Retry-After", "0"))
            except ValueError:
                retry_after = 0
            store.delivery_result(item, response.status_code, retry_after)
        except (httpx.HTTPError, ValueError):
            # Endpoint/token/authorization and payload must never reach logs.
            store.delivery_result(item, 0)


# -- a paired phone, through the push relay (core/phone_push.py; specs/phone-api.md) --------------------------
# The relay knows a phone as an "install": this desktop registers the phone's Apple tokens there once and keeps
# the install id and the secret the relay answers (the secret encrypted with the install key, never logged,
# never sent to the phone or shown in the app). Every later request is signed with it. Nothing below runs
# without a relay address in settings.

def _relay_secret(relay) -> str:
    from core import secret_storage
    return secret_storage.decrypt_install(relay["secret"])


async def _relay(client, base, method, path, body=None, secret=None):
    """One request to the relay. Answers (status, Retry-After seconds, parsed JSON or {}); status 0 when the
    relay could not be reached. Redirects are never followed and no proxy settings are used (the client's own)."""
    from core import phone_push
    raw = phone_push.encode(body)
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers.update(phone_push.sign(secret, method, path, raw))
    try:
        response = await client.request(method, base + path, content=raw, headers=headers)
    except httpx.HTTPError:
        return 0, 0, {}
    try:
        retry_after = int(response.headers.get("Retry-After", "0"))
    except ValueError:
        retry_after = 0
    try:
        data = response.json()
    except ValueError:
        data = {}
    return response.status_code, retry_after, data if isinstance(data, dict) else {}


async def _relay_install(client, base, item, registration):
    """This phone's registration at the relay, made or brought up to date. Answers (relay record or None,
    outcome when there is none: "retry" or "failed", Retry-After)."""
    from core import phone_push, secret_storage
    tokens = phone_push.install_body(registration)
    if tokens is None:
        return None, "failed", 0     # a Live Activity token alone: the relay needs the phone's device token first
    relay = registration.get("relay") or {}
    if relay.get("url") != base:
        relay = {}                   # another relay (or none yet): register afresh; the old one was queued for removal
    if relay.get("refused"):
        return None, "failed", 0     # the relay refused these exact tokens; ask again only when they change
    if relay.get("install_id") and not relay.get("synced"):
        status, retry_after, _ = await _relay(client, base, "PUT", f"/v1/installs/{relay['install_id']}", tokens, _relay_secret(relay))
        if status == 204:
            relay = {**relay, "synced": True}
            store.phone_set_relay(item["device_id"], relay)
        elif status == 401:
            relay = {}               # the relay no longer knows this install: register again below
            store.phone_set_relay(item["device_id"], None)
        elif status == 400:
            store.phone_set_relay(item["device_id"], {"url": base, "refused": True})
            return None, "failed", 0
        else:
            return None, "retry", retry_after
    if not relay.get("install_id"):
        status, retry_after, data = await _relay(client, base, "POST", "/v1/installs", tokens)
        install_id, secret = data.get("install_id"), data.get("secret")
        if status == 201 and isinstance(install_id, str) and phone_push.INSTALL_ID.fullmatch(install_id) \
                and isinstance(secret, str) and 16 <= len(secret) <= 200:
            relay = {"url": base, "install_id": install_id, "secret": secret_storage.encrypt_install(secret), "synced": True}
            store.phone_set_relay(item["device_id"], relay)
        elif status == 400:
            store.phone_set_relay(item["device_id"], {"url": base, "refused": True})
            return None, "failed", 0
        else:
            return None, "retry", retry_after
    return relay, "", 0


def _who(item, payload, session):
    """The name a phone push may carry: the bot's, else Kairos. Looked up in the owner's own account."""
    if payload.get("who"):
        return payload["who"]
    agent_id = payload.get("agent_id") or (session or {}).get("agent_id")
    if not agent_id:
        return ""
    try:
        from core import accounts
        from services.agent_service import agent_service
        account_id = accounts.account_for_user(item["owner"])
        if account_id is None:
            return ""
        with accounts.as_account(account_id):
            return str((agent_service.get(agent_id) or {}).get("name") or "")
    except Exception:
        return ""


async def _deliver_phone(client, item, session):
    from core import phone_push
    base = phone_push.relay_url()
    if not base:
        store.phone_result(item, "skipped")     # the relay address was taken out after this was queued
        return
    registration = json.loads(item["subscription"])
    payload = json.loads(item["payload"])
    message = phone_push.message_for(item["kind"], {**payload, "who": _who(item, payload, session)}, registration)
    if message is None:
        store.phone_result(item, "skipped")
        return
    relay, outcome, retry_after = await _relay_install(client, base, item, registration)
    if relay is None:
        store.phone_result(item, outcome, retry_after)
        return
    status, retry_after, _ = await _relay(client, base, "POST", f"/v1/installs/{relay['install_id']}/push", message, _relay_secret(relay))
    if status == 200:
        store.phone_result(item, "sent")
    elif status == 410 and item["kind"] == "activity":
        store.phone_drop_activity(item["device_id"], message["push_token"])     # that Live Activity is over
        store.phone_result(item, "failed")
    elif status == 410:
        store.phone_result(item, "gone")        # Apple no longer knows this phone: drop its push registration
    elif status == 401:
        store.phone_set_relay(item["device_id"], None)     # unknown install or secret: register again next time
        store.phone_result(item, "retry")
    elif status in (0, 408, 429) or status >= 500:
        store.phone_result(item, "retry", retry_after)
    else:
        store.phone_result(item, "failed")      # 409 (the ring ran out, no call token), 422 (Apple refused it), 4xx


async def _forget_at_relay(client):
    """Ask the relay to delete the registrations of phones that were unpaired or turned push off. Only at the
    relay address in settings now: with none set, nothing is sent."""
    from core import phone_push, secret_storage
    base = phone_push.relay_url()
    if not base:
        return
    for removal in store.relay_removals_due(base):
        try:
            secret = secret_storage.decrypt_install(removal["secret"])
            status, _, _ = await _relay(client, base, "DELETE", f"/v1/installs/{removal['install_id']}", None, secret)
        except Exception:
            status = 0
        # 204: gone. 401 and 404: the relay does not know it (already gone, or it will never accept this secret).
        store.relay_removal_result(removal["install_id"], status in (204, 401, 404))


def _still_ringing(item):
    from core import accounts
    from services import rings
    account_id = accounts.account_for_user(item["owner"])
    if account_id is None:
        return False
    return rings.outcome(account_id, item["run_id"]) == rings.RINGING


def _owners_session(owner, session_id):
    """The chat as its owner's account has it (Multi-Account group 3: each account has its own chats)."""
    from core import accounts
    account_id = accounts.account_for_user(owner)
    if account_id is None:
        return None
    with accounts.as_account(account_id):
        return session_manager.get_session(session_id)


async def _send_loop():
    async with httpx.AsyncClient(timeout=15, follow_redirects=False, trust_env=False) as client:
        while True:
            try:
                await deliver_due(client)
            except Exception:
                logger.error("Mobile notification delivery pass failed; retrying")
            await asyncio.sleep(2)


def start():
    global _worker
    if _worker is None or _worker.done():
        _worker = asyncio.create_task(_send_loop(), name="mobile-notifications")


async def shutdown():
    global _worker
    if _worker:
        _worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _worker
        _worker = None

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
    return auth_manager.notification_session_valid(item["owner"], item["binding"])


async def deliver_due(client):
    config = store.config()
    if not config:
        return
    for item in store.due():
        if not _authorized_device(item):
            store.revoke(session_binding=item["binding"])
            continue
        run = store.read_run(item["run_id"])
        session = session_manager.get_session(run["session_id"]) if run else None
        if item["kind"] != "test" and (not session or (session.get("owner_user") not in (None, item["owner"])
                            and not auth_manager.is_admin(item["owner"]))):
            store.delivery_result(item, 403)
            continue
        if item["kind"] == "permission" and not permissions.pending_request(item["permission_id"]):
            store.delivery_result(item, 409)
            continue
        try:
            subscription = web_push.validate(json.loads(item["subscription"]))
            response = await client.post(subscription["endpoint"], content=web_push.encrypt(subscription, item["payload"].encode()), headers={
                "Authorization": web_push.authorization(config["private"], subscription["endpoint"], config["subject"]),
                "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
                "TTL": str(max(0, int(item["expires"] - time.time()))),
                "Urgency": "high" if item["kind"] == "permission" else "normal",
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

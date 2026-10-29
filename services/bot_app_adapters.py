"""Account adapters for connected apps (Phase 2, unit U5).

One small interface per kind of app, so the inventory (bot_connections.py) never knows how Google,
a mailbox or an MCP server signs in:

    accounts(owner)                      -> [{"id", "label", "status", "error", "default"}]
    authorize(owner, redirect_base, ...) -> {"url", "expires_in"}   (a bounded sign-in link)
    disconnect(owner, account_id)

Kairos has no cloud connection broker, so an account is one of: a Google account (the native
Workspace sign-in), a mailbox set up in the Email tab (listed here so a bot can be granted it,
managed there), or an MCP server's sign-in. The adapters take the upstream module as an argument
so tests can stand in for it.

A sign-in link is only ever https, or http to this computer, at most 2,048 characters, and lives
five minutes; anything else the upstream returns is refused.
"""
from typing import Optional
from urllib.parse import urlparse

LINK_SECONDS = 300
MAX_LINK = 2048


class AdapterError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def bounded_link(url) -> str:
    from core.mcp_oauth import secure_url
    if not isinstance(url, str) or not url or len(url) > MAX_LINK:
        raise AdapterError("The sign-in link was not usable. Try again.", 502)
    try:
        secure_url(url, "The sign-in link")
    except ValueError as error:
        raise AdapterError(str(error), 502) from error
    if urlparse(url).username or urlparse(url).password:
        raise AdapterError("The sign-in link carried credentials, so Kairos refused it.", 502)
    return url


class GoogleAdapter:
    id, label, multi_account = "google", "Google Workspace", True

    def __init__(self, google=None):
        self._google = google

    @property
    def google(self):
        if self._google is None:
            from core import google_workspace
            self._google = google_workspace
        return self._google

    def accounts(self, owner: str) -> list[dict]:
        status = self.google.status(owner)
        return [{"id": a["id"], "label": a.get("email") or a["id"], "status": "error" if a.get("error") else "connected",
                 "error": a.get("error"), "default": bool(a.get("default"))} for a in status.get("accounts", [])]

    def configured(self) -> bool:
        return bool(self.google.status(None).get("configured"))

    def authorize(self, owner: str, redirect_base: str, alias: Optional[str] = None, account_id: Optional[str] = None) -> dict:
        if not self.configured():
            raise AdapterError("Add your Google OAuth client ID in Settings > Integrations first.", 409)
        try:
            url = self.google.start_sign_in(redirect_base + "/google/oauth/callback", owner, bool(self.accounts(owner)) and account_id is None, account_id)
        except self.google.GoogleError as error:
            raise AdapterError(str(error), getattr(error, "status", 400)) from error
        return {"url": bounded_link(url), "expires_in": LINK_SECONDS}

    def disconnect(self, owner: str, account_id: str) -> None:
        try:
            self.google.disconnect(account_id, owner)
        except self.google.GoogleError as error:
            raise AdapterError(str(error), getattr(error, "status", 404)) from error


class EmailAdapter:
    id, label, multi_account = "email", "Email (IMAP and SMTP)", True

    def __init__(self, service=None):
        self._service = service

    @property
    def service(self):
        if self._service is None:
            from services.email_service import email_service
            self._service = email_service
        return self._service

    def accounts(self, owner: str) -> list[dict]:
        return [{"id": a["id"], "label": a.get("email") or a["id"], "status": "connected", "error": None, "default": False}
                for a in self.service.list_accounts() if a.get("owner") in (None, owner)]

    def authorize(self, owner, redirect_base, alias=None, account_id=None):
        raise AdapterError("Mailboxes are added in the Email tab. Once added they appear here.", 409)

    def disconnect(self, owner: str, account_id: str) -> None:
        raise AdapterError("Remove a mailbox in the Email tab.", 409)


class McpAdapter:
    """One MCP server's sign-in is its one account."""
    multi_account = False

    def __init__(self, integrations=None, oauth=None):
        self._integrations, self._oauth = integrations, oauth

    @property
    def integrations(self):
        if self._integrations is None:
            from core import integrations
            self._integrations = integrations
        return self._integrations

    @property
    def oauth(self):
        if self._oauth is None:
            from core import mcp_oauth
            self._oauth = mcp_oauth
        return self._oauth

    def accounts(self, item_id: str) -> list[dict]:
        item = self.integrations.get_integration_masked(item_id)
        if not item or item["kind"] != "mcp_server":
            return []
        if item.get("auth") != "oauth":
            ok = (item.get("status") or {}).get("state") == "working"
            return [{"id": "server", "label": item["name"], "status": "connected" if ok else "error" if item.get("status") else "pending",
                     "error": (item.get("status") or {}).get("error"), "default": True}]
        state = (item.get("status") or {}).get("state")
        status = "needs_reconnect" if not item.get("signed_in") and self.oauth.status(item_id).get("error") else \
            "connected" if item.get("signed_in") and state != "down" else "error" if item.get("signed_in") else "pending"
        return [{"id": "server", "label": item["name"], "status": status, "error": self.oauth.status(item_id).get("error"), "default": True}]

    async def authorize(self, item_id: str, redirect_uri: str) -> dict:
        try:
            result = await self.oauth.start_sign_in(item_id, redirect_uri)
        except KeyError as error:
            raise AdapterError("That app was not found.", 404) from error
        except ValueError as error:
            raise AdapterError(str(error), 400) from error
        if result.get("signed_in"):
            return {"signed_in": True}
        return {"url": bounded_link(result["url"]), "expires_in": LINK_SECONDS}

    def disconnect(self, item_id: str) -> None:
        try:
            self.oauth.sign_out(item_id)
        except KeyError as error:
            raise AdapterError("That app was not found.", 404) from error

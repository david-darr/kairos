"""Stable tab contract, v1.

Tabs import Kairos through this module and bind a handle with
``api = tab_api.for_tab(__package__)``. v1 offers auth dependencies, confined
atomic JSON storage and migration, encryption of the tab's own values,
untrusted-text wrapping, tool-free models, read-only mail, Library and
connection metadata, backlog cards, persistent chats and daily sync.
It grants no access to Kairos's stored credentials. This is an interface,
not a Python sandbox: approved source still runs with the app's privileges.
Encryption authenticates a kairos-tab:<slug>: prefix inside each token;
only core's adoption of a tab-owned legacy JSON file converts old app-key
tokens, including stores moved by earlier development builds.

API_VERSION 1 keeps working across updates. New capabilities are additions,
or a v2 offered alongside v1; existing v1 signatures and behavior stay valid.
"""
import asyncio
import imaplib
import os
import re
import tempfile
from urllib.parse import quote
from contextlib import contextmanager

from core import atomic_io, model_endpoints, secret_storage, tab_folders, token_usage
from core.constants import DATA_DIR
from core.middleware import require_user, require_admin
from core.mail_utils import message_time
from core.untrusted import wrap_untrusted as _wrap_untrusted

API_VERSION = 1


def __getattr__(name):
    # Optional native bridge retained as an additive part of the v1 contract.
    if name in {'roblox_workspace', 'roblox_style', 'roblox_assets'}:
        from core import addons
        return addons.module(name)
    raise AttributeError(name)
# A tab with a name colliding with an app store must not adopt credentials.
_APP_STORES = {"auth.json", "sessions.json", "password_resets.json", "settings.json",
    "model_endpoints.json", "email_accounts.json", "connectors.json", "discord_bots.json",
    "integrations.json", "google_workspace.json"}


def wrap_untrusted(label, text):
    return _wrap_untrusted(label, text)


def is_admin(username):
    from core.auth import auth_manager
    return auth_manager.is_admin(username)


def list_models():
    return [{k: e.get(k) for k in ("id", "name", "kind", "model")}
            for e in model_endpoints.list_endpoints()]


def model_context_size(endpoint_id):
    """Configured input window, used to bound source text before completion."""
    endpoint = model_endpoints.get_endpoint(endpoint_id) or {}
    return (endpoint.get("num_ctx") or 16384) if endpoint.get("kind") == "local" else None


_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}")


async def model_choices(endpoint_id):
    """Connection-scoped picker metadata, never credentials or provider URLs."""
    from core import model_discovery
    endpoint = model_endpoints.get_endpoint(endpoint_id)
    if endpoint is None:
        raise ValueError("Choose a completion model")
    return [{"id": row["id"], "name": row.get("display_name") or row["id"]}
            for row in await model_discovery.list_for_endpoint(endpoint)]


async def complete(endpoint_id, system, prompt, timeout=180, model=None):
    async def run():
        endpoint = model_endpoints.get_endpoint(endpoint_id)
        if endpoint is None:
            raise ValueError("Choose a completion model")
        if endpoint["kind"] in ("codex_cli", "antigravity_cli"):
            raise ValueError("Select Claude CLI, a local model or an API model for tool-free completion")
        if endpoint["kind"] == "claude_cli":
            # Callers check membership against model_choices() when the choice
            # is saved; re-listing here would fail every call while the live
            # catalog is unreachable. Only the id's shape is checked per call.
            if model is not None and not _MODEL_ID.fullmatch(model):
                raise ValueError("Choose a model this connection offers")
            from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query
            from core import claude_cli
            directory = tempfile.TemporaryDirectory(prefix="kairos-tab-reader-", ignore_cleanup_errors=True)
            try:
                options = ClaudeAgentOptions(tools=[], mcp_servers={}, strict_mcp_config=True,
                    setting_sources=[], skills=[], plugins=[], cwd=directory.name, max_turns=1,
                    cli_path=claude_cli.preferred_cli_path(),
                    model=model if model is not None else endpoint.get("model") or None, system_prompt=system,
                    extra_args={"no-session-persistence": None, "disable-slash-commands": None})
                result = None
                async for message in query(prompt=prompt, options=options):
                    if isinstance(message, ResultMessage):
                        result = message
                        if message.usage:
                            token_usage.record_usage(endpoint_id, message.usage)
                # Drain the stream so the CLI releases its Windows working directory.
                if result is None:
                    raise ValueError("The completion model did not return a result")
                if result.is_error:
                    raise ValueError("The completion model failed")
                return result.result or ""
            finally:
                try:
                    directory.cleanup()
                except OSError:
                    # A transient filesystem lock must not discard the model result.
                    pass
        if model is not None and model != endpoint.get("model"):
            raise ValueError("Choose a model this connection offers")
        from core.providers.openai_compatible import run_turn
        base, configured_model, api_key, num_ctx = model_endpoints.resolve_runtime(endpoint_id)
        def usage(value):
            token_usage.record_usage(endpoint_id, value)
        return await run_turn(base, configured_model, api_key,
            [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            tools=None, tool_executor=None, num_ctx=num_ctx, on_usage=usage)
    return await asyncio.wait_for(run(), timeout)


_HEADER_UNSAFE = re.compile(r"[\r\n\x00]")


def send_email(user, account_id, to, subject, body, in_reply_to=None):
    """Send one plain-text email from a connected account, for an admin's
    explicit action only (a button the person pressed, after confirming the
    recipient). Never call it from background work or on a model's say."""
    from email.utils import parseaddr
    from services.email_service import email_service
    if not is_admin(user):
        raise PermissionError("Only an admin can send email")
    if not any(a.get("id") == account_id for a in email_accounts()):
        raise ValueError("The email account is not connected")
    for value in (to, subject, in_reply_to or ""):
        if not isinstance(value, str) or _HEADER_UNSAFE.search(value):
            raise ValueError("Invalid email header")
    address = parseaddr(to)[1]
    if "@" not in address or address != to.strip():
        raise ValueError("Enter one recipient address")
    if not body.strip() or len(body) > 50_000:
        raise ValueError("The message must be 1 to 50,000 characters")
    email_service.send_message(account_id, address, subject[:300], body, in_reply_to=in_reply_to or None)


def email_accounts():
    from services.email_service import email_service
    return [{k: a.get(k) for k in ("id", "email", "name")} for a in email_service.list_accounts()]


def email_sent_folder(account_id):
    """Discover the actual Sent folder through read-only IMAP LIST metadata."""
    from services.email_service import email_service
    account = email_service.get_account(account_id, decrypted=True)
    if not account:
        raise ValueError("The connected email account was removed")
    with imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"], timeout=20) as box:
        box.login(account["email"], secret_storage.decrypt(account["password_encrypted"]))
        status, rows = box.list()
        if status != "OK":
            raise ValueError("The Sent folder could not be discovered")
        fallback = []
        for row in rows or []:
            if not isinstance(row, bytes):
                continue
            match = re.fullmatch(rb'\(([^)]*)\)\s+(?:"(?:[^"\\]|\\.)*"|NIL)\s+(.+)', row)
            if not match or b"\\noselect" in match[1].lower().split():
                continue
            name = match[2].decode("ascii")
            if name.startswith('"') and name.endswith('"'):
                name = re.sub(r'\\(.)', r'\1', name[1:-1])
            if b"\\sent" in match[1].lower().split():
                return name
            if name.casefold() in ("sent", "sent items", "sent messages", "[gmail]/sent mail", "[google mail]/sent mail"):
                fallback.append(name)
        if len(fallback) == 1:
            return fallback[0]
    raise ValueError("No Sent folder was identified for this account")


class _ReadOnlyMailbox:
    __slots__ = ("__box", "__gmail_account")

    def __init__(self, box, gmail_account=None):
        self.__box = box
        self.__gmail_account = gmail_account

    def message_link(self, uid):
        """Provider-assigned provenance only; this fetch cannot mark mail read."""
        if not self.__gmail_account:
            return None
        identity = uid.decode("ascii") if isinstance(uid, bytes) else str(uid)
        if not re.fullmatch(r"[1-9][0-9]{0,19}", identity):
            raise ValueError("Invalid message UID")
        status, rows = self.__box.uid("fetch", identity, "(X-GM-MSGID)")
        data = b" ".join(row for row in rows or [] if isinstance(row, bytes))
        found = re.search(rb"\bX-GM-MSGID\s+([0-9]+)\b", data)
        if status != "OK" or not found or not 0 < int(found[1]) < 2 ** 64:
            return None
        return f"https://mail.google.com/mail/u/?authuser={quote(self.__gmail_account, safe='')}#all/{int(found[1]):x}"

    def uid(self, command, *args):
        command = command.lower()
        for arg in args:
            if isinstance(arg, (str, bytes)):
                controls = ("\r", "\n", "\x00") if isinstance(arg, str) else (b"\r", b"\n", b"\x00")
                if any(c in arg for c in controls):
                    raise ValueError("Invalid IMAP argument")
        if command == "fetch":
            if len(args) != 2 or not isinstance(args[1], str):
                raise ValueError("Only read-only message fetches are allowed")
            items = args[1].upper().strip()
            if items.startswith("(") and items.endswith(")"):
                items = items[1:-1].strip()
            def readable(item):
                if item in ("RFC822.SIZE", "BODY.PEEK[]"):
                    return True
                partial = re.fullmatch(r"BODY\.PEEK\[\]<0\.([1-9]\d{0,6})>", item)
                return bool(partial and int(partial[1]) <= 1_000_000)
            if not items.split() or not all(readable(i) for i in items.split()):
                raise ValueError("Only RFC822.SIZE and read-only BODY.PEEK[] fetches up to 1 MB are allowed")
        elif command != "search":
            raise ValueError("Only UID search and read-only fetch are allowed")
        return self.__box.uid(command, *args)

    def response(self, name):
        if name.upper() != "UIDVALIDITY":
            raise ValueError("Only UIDVALIDITY is exposed")
        return self.__box.response("UIDVALIDITY")


@contextmanager
def open_mailbox(account_id, folder):
    from services.email_service import email_service
    if not isinstance(folder, str) or any(c in folder for c in "\r\n\x00") or len(folder) > 200:
        raise ValueError("Invalid mailbox folder")
    account = email_service.get_account(account_id, decrypted=True)
    if account is None:
        raise ValueError("The connected email account was removed")
    with imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"], timeout=20) as box:
        box.login(account["email"], secret_storage.decrypt(account["password_encrypted"]))
        quoted = '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'
        status, _ = box.select(quoted, readonly=True)
        if status != "OK":
            raise ValueError("The mailbox folder could not be opened")
        gmail = account["email"] if account["imap_host"].lower().rstrip(".") in ("imap.gmail.com", "imap.googlemail.com") else None
        yield _ReadOnlyMailbox(box, gmail_account=gmail)


def email_message_link(account_id, folder, external_id, message_id=None, lookup=True):
    """Resolve a Gmail message from stored provenance, with an exact-ID search fallback.

    No hostname or target URL comes from an email body or the caller. Other
    IMAP providers do not have a portable message URL; return None honestly.
    """
    from services.email_service import email_service
    account = email_service.get_account(account_id)
    if not account or account["imap_host"].lower().rstrip(".") not in ("imap.gmail.com", "imap.googlemail.com"):
        return None
    identity = re.fullmatch(r"([0-9]+):([1-9][0-9]{0,19})", str(external_id))
    mid = (message_id or "").strip().strip("<>")
    valid_mid = len(mid) <= 998 and bool(re.fullmatch(r"[^\s<>\x00-\x1f]+@[^\s<>\x00-\x1f]+", mid))
    if lookup:
        try:
            with open_mailbox(account_id, folder) as mailbox:
                _, values = mailbox.response("UIDVALIDITY")
                validity = next((v.decode("ascii") for v in values or [] if isinstance(v, bytes)), "")
                if identity and validity == identity[1]:
                    url = mailbox.message_link(identity[2])
                    if url:
                        return {"url": url, "direct": True, "provider": "Gmail"}
                # The folder may have been rebuilt since capture. Match the
                # RFC Message-ID instead of trusting a reused numeric UID.
                if valid_mid:
                    term = '"<' + mid.replace("\\", "\\\\").replace('"', '\\"') + '>"'
                    status, rows = mailbox.uid("search", None, "HEADER", "Message-ID", term)
                    if status == "OK":
                        found = (rows[0] or b"").split() if rows else []
                        if len(found) == 1:
                            url = mailbox.message_link(found[0])
                            if url:
                                return {"url": url, "direct": True, "provider": "Gmail"}
        except (OSError, imaplib.IMAP4.error, ValueError, UnicodeError):
            pass  # A moved/archived message can still be found in webmail.
    if valid_mid:
        query = quote("in:anywhere rfc822msgid:" + mid, safe="")
        return {"url": f"https://mail.google.com/mail/u/?authuser={quote(account['email'], safe='')}#search/{query}",
                "direct": False, "provider": "Gmail"}
    return None


def message_connections():
    from core.connectors import store
    from core import discord_bots_store
    choices = [{"kind": "connector", "id": c["id"], "label": c["name"] + " · " + c["kind"]}
               for c in store.list_records() if c["kind"] in ("slack", "telegram", "email")]
    return choices + [{"kind": "discord", "id": b["id"], "label": b["name"] + " · Discord"}
                      for b in discord_bots_store.list_bots()]


def documents():
    from services.documents_service import list_documents
    return [{k: d[k] for k in ("id", "title")} for d in list_documents()]


def document(document_id):
    from services.documents_service import get_document
    return get_document(document_id)


def backlog_card(card_id):
    from services.task_service import task_service
    return task_service.get_task(card_id)


def backlog_result(card_id):
    """Latest successful assignment output and its actual recorded actions."""
    from services.task_service import task_service
    from core import session_manager_store
    latest = next(iter(task_service.list_runs(card_id)), None)
    if not latest or latest.get("outcome") != "succeeded":
        return None
    run_id = latest.get("run_id")
    return {"id": latest["id"], "at": latest.get("ran_at"), "output": latest.get("output") or "",
            "actions": [step for step in session_manager_store.run_events(run_id)
                        if step.get("kind") == "tool_finished"] if run_id else []}


def create_backlog_card(title, description, agent_id, owner_user=None):
    from services.task_service import task_service
    return task_service.create_task(title, description, "card", status="backlog", agent_id=agent_id, owner_user=owner_user)


def delete_backlog_card(card_id):
    from services.task_service import task_service
    task_service.delete_task(card_id)


class TabAPI:
    def __init__(self, slug, entry):
        self.slug, self._entry = slug, entry

    @property
    def is_on(self):
        from core.custom_tabs import _folder_allowed
        return _folder_allowed(self._entry)

    @property
    def data_dir(self):
        parent = os.path.join(DATA_DIR, "tab-data")
        directory = os.path.join(parent, self.slug)
        if tab_folders.is_link(parent) or tab_folders.is_link(directory):
            raise ValueError("Tab data directories cannot be links")
        os.makedirs(directory, exist_ok=True)
        return directory

    def _file(self, name):
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", name)
                or name.endswith((".", " "))
                or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", name, re.I)):
            raise ValueError("Use a plain data filename")
        path = os.path.join(self.data_dir, name)
        if tab_folders.is_link(path):
            raise ValueError("Tab data files cannot be links")
        return path

    def read_json(self, name, default):
        return atomic_io.read_json(self._file(name), default)

    def write_json(self, name, value):
        atomic_io.write_json_atomic(self._file(name), value)

    def adopt_data_file(self, old_name):
        # Migration is restricted to the tab's former store, never app secrets.
        if old_name != self.slug + ".json" or old_name in _APP_STORES:
            raise ValueError("Only the tab's own legacy data file may be adopted")
        target = self._file(old_name)
        source = os.path.join(DATA_DIR, old_name)
        if tab_folders.is_link(source):
            raise ValueError("Legacy data files cannot be links")
        if os.path.isfile(source) and not os.path.exists(target):
            value = atomic_io.read_json(source, None)
            atomic_io.write_json_atomic(target, self._namespace_legacy_values(value))
            os.remove(source)
        elif os.path.isfile(target):
            # A2 dev copies may already have adopted app-key tokens. Walk the
            # owned store again: conversion is idempotent and never lenient
            # through the public decrypt interface.
            value = atomic_io.read_json(target, None)
            converted = self._namespace_legacy_values(value)
            if converted != value:
                atomic_io.write_json_atomic(target, converted)

    def _namespace_legacy_values(self, value):
        if isinstance(value, dict):
            return {k: self._namespace_legacy_values(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._namespace_legacy_values(v) for v in value]
        if isinstance(value, str):
            from cryptography.fernet import InvalidToken
            try:
                plain = secret_storage.decrypt(value)
            except (InvalidToken, ValueError, UnicodeError):
                return value
            # Already namespaced tokens (including other tabs) stay untouched.
            if not plain.startswith("kairos-tab:"):
                return self.encrypt(plain)
        return value

    def encrypt(self, text):
        # The authenticated ciphertext includes its owner; app-key tokens and
        # other tabs' ciphertext can never pass this handle's decrypt check.
        return secret_storage.encrypt(f"kairos-tab:{self.slug}:" + text)

    def decrypt(self, token):
        plain = secret_storage.decrypt(token)
        prefix = f"kairos-tab:{self.slug}:"
        if not plain.startswith(prefix):
            raise ValueError("Encrypted value does not belong to this tab")
        return plain[len(prefix):]

    def chat_session(self, key, title, untrusted=None, model_endpoint_id=None, owner_user=None):
        """Get/create this tab's persistent chat for ``key``.

        ``untrusted``: a short label for outside text the tab places in the
        chat (e.g. "CRM source messages"). The chat is then marked so every
        turn treats its history as untrusted and shell commands ask first.
        ``model_endpoint_id`` picks the model for a newly created chat only.
        """
        from core.session_manager import session_manager
        if model_endpoint_id is not None and model_endpoints.get_endpoint(model_endpoint_id) is None:
            model_endpoint_id = None
        # Preserve the original slug:key identity of existing tab chats.
        ownership = {"owner_user": owner_user} if owner_user is not None else {}
        session_id = session_manager.get_or_create_channel_session(f"{self.slug}:{key}", title, model_endpoint_id, **ownership)
        if untrusted:
            session_manager.set_untrusted_context(session_id, f"{self.slug} tab: {str(untrusted)[:80]}")
        return session_id

    def append_chat_message(self, session_id, role, text):
        from core.session_manager import session_manager
        session_manager.append_message(session_id, role, text)

    def register_sync(self, name, fn):
        from core import sync_engine
        async def sync():
            if self.is_on:
                return await fn()
        sync_engine.register_provider(name, sync)
        _sync_names.setdefault(self.slug, set()).add(name)


_sync_names = {}


def unregister_sync(slug):
    from core import sync_engine
    for name in _sync_names.pop(slug, set()):
        sync_engine.unregister_provider(name)


def for_tab(package):
    parts = package.split(".") if isinstance(package, str) else []
    if len(parts) < 2 or parts[0] != "kairos_tabs" or parts[1] not in tab_folders._registered:
        raise ValueError("A registered tab package is required")
    entry = tab_folders._registered[parts[1]]
    if not tab_folders._allowed(entry):
        raise ValueError("The tab is not approved or enabled")
    return TabAPI(parts[1], entry)


# Video workspace capabilities. Callers pass the authenticated user, never
# model-supplied ownership. Video CRUD remains on the shared HTTP API.
def video_looks(user):
    from core import design_systems
    looks = design_systems.list_systems(user, is_admin(user))
    default = design_systems.default_id() or design_systems.BUILTIN_ID
    if default not in {row["id"] for row in looks}:
        default = design_systems.BUILTIN_ID
    return {"looks": looks, "default": default}


def video_look_tokens(look, user):
    from core import design_systems
    system = design_systems.get(look)
    if not system or not design_systems.visible(system, user, is_admin(user)):
        raise LookupError("No such look.")
    return {"variables": design_systems.variables(system["tokens"]),
            "font_css": design_systems.font_faces(system["id"], "/api/design-fonts")}


def video_design_source(design_id, user):
    from core import design_store, video_store
    data = design_store.require_user_access(design_id, user, is_admin(user))
    return {"title": data["title"], "look": data["design_system"],
            "boards": [{"title": board["title"], "html": design_store.board_html(design_id, slug)}
                       for slug, board in design_store.ordered_boards(data)],
            "assets": sorted("assets/" + p.name for p in (design_store._folder(design_id) / "assets").iterdir()
                             if p.is_file() and video_store.ASSET.fullmatch("assets/" + p.name))}


def video_resources(video_id, user):
    from core import video_render, video_store
    video_store.require_user_access(video_id, user, is_admin(user))
    folder = video_store._folder(video_id)
    pattern = re.compile(r"(?:(?:16-9|9-16|1-1)-v[1-9][0-9]*\.mp4|(?:sheet|thumb)-(?:16-9|9-16|1-1)\.png|soundtrack\.wav)")
    files = sorted((p for p in (folder / "renders").iterdir() if p.is_file() and pattern.fullmatch(p.name)),
                   key=lambda p: (p.stat().st_mtime_ns, p.name))
    thumbs = [p.name for p in files if p.name.startswith("thumb-")]
    return {"assets": sorted("assets/" + p.name for p in (folder / "assets").iterdir()
                             if p.is_file() and video_store.ASSET.fullmatch("assets/" + p.name)),
            "renders": [p.name for p in files], "thumbnail": thumbs[-1] if thumbs else None,
            "jobs": [{k: v for k, v in job.items() if k != "path"} for job in list(video_render._jobs.values())
                     if job["video_id"] == video_id]}


def video_create_project(user, project):
    from core import video_store
    video_look_tokens(project.get("look"), user)
    fields = {k: v for k, v in project.items() if k in video_store.FIELDS and k != "id"}
    return video_store.create(owner=user, **fields)


def video_save_project(video_id, project, user):
    from core import video_store
    video_store.require_user_access(video_id, user, is_admin(user))
    video_look_tokens(project.get("look"), user)
    return video_store.save(video_id, project)


def video_delete_project(video_id, user):
    from core import video_store
    video_store.require_user_access(video_id, user, is_admin(user))
    video_store.delete(video_id)


def video_copy_design_asset(video_id, design_id, asset, user):
    from core import video_store
    video_store.require_user_access(video_id, user, is_admin(user))
    return video_store.add_asset(video_id, design_id=design_id, asset=asset, user=user, is_admin=is_admin(user))


def video_link_session(video_id, session_id, user):
    from core import design_store, video_store
    from core.session_manager import session_manager
    session = session_manager.get_session(session_id)
    if not session or session.get("owner_user") != user:
        raise LookupError("No such chat.")
    if video_id:
        video_store.require_user_access(video_id, user, is_admin(user))
        video_store.link_chat(video_id, session_id)
    design_store.set_design_mode(session_id, True)


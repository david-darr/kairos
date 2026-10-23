"""Google Workspace account connections and bounded Drive, Sheets, Forms,
Calendar and Gmail-send API client.

Each installation supplies its own Desktop OAuth client ID. Several Google
accounts can sign in through it; each keeps its own encrypted tokens. Library
works on the active account, Calendar on the calendar account, and a caller
can pick another with use_account(). Tokens stay in the
existing encrypted secret store. Only the fixed Google API hosts below are
ever contacted with those tokens; callers cannot provide an arbitrary URL.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import time
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from email.message import EmailMessage
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

import httpx

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from core.secret_storage import decrypt, encrypt
from core import calendar_recurrence as repeats


FILE = os.path.join(DATA_DIR, "google_workspace.json")
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
HOSTS = {
    "drive": "https://www.googleapis.com/drive/v3",
    "upload": "https://www.googleapis.com/upload/drive/v3",
    "sheets": "https://sheets.googleapis.com/v4",
    "forms": "https://forms.googleapis.com/v1",
    "thumbnail": "https://lh3.googleusercontent.com",
    "calendar": "https://www.googleapis.com/calendar/v3",
    "gmail": "https://gmail.googleapis.com/gmail/v1",
}
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar"
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
SCOPES = (
    "openid", "email",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.responses.readonly",
    CALENDAR_SCOPE,
    GMAIL_SEND_SCOPE,
)
# Per-account token fields; before multi-account support they sat at top level.
ACCOUNT_KEYS = ("refresh_token", "access_token", "expires_at", "email", "granted_scopes", "calendar_ids")
_account: ContextVar[str | None] = ContextVar("google_account", default=None)
FILE_FIELDS = "nextPageToken,incompleteSearch,files(id,name,mimeType,size,parents,modifiedTime,webViewLink,description,starred,trashed,driveId,capabilities,owners,shared,thumbnailLink)"
MAX_DOWNLOAD = 25 * 1024 * 1024
_pending: dict[str, tuple[str, float]] = {}
_refresh_lock = asyncio.Lock()
_calendar_cache: dict[tuple, tuple[float, list[dict]]] = {}
_calendar_generation = 0


class GoogleError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _load() -> dict:
    return read_json(FILE, {})


def _state() -> dict:
    return _migrate(_load())


def _migrate(data: dict) -> dict:
    if data.get("refresh_token") and not data.get("accounts"):
        # The one pre-existing account becomes the first of several.
        ident = _account_key(data.get("email"))
        data["accounts"] = {ident: {k: data[k] for k in ACCOUNT_KEYS if k in data}}
        data.setdefault("active_account", ident)
        data.setdefault("calendar_account", ident)
    for key in ACCOUNT_KEYS:
        data.pop(key, None)
    data.setdefault("accounts", {})
    return data


def _account_key(email: str | None) -> str:
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:12] if email else "primary"


def _resolve(data: dict, account: str | None = None, purpose: str = "library") -> str:
    """An explicit account (id or address) must exist; otherwise the default."""
    accounts = data["accounts"]
    wanted = account or _account.get()
    if wanted:
        if wanted in accounts:
            return wanted
        match = next((i for i, a in accounts.items() if (a.get("email") or "").lower() == str(wanted).strip().lower()), None)
        if match:
            return match
        raise GoogleError("That Google account is not connected in Library", 404)
    default = data.get("calendar_account" if purpose == "calendar" else "active_account")
    if default in accounts:
        return default
    if not accounts:
        raise GoogleError("Connect Google Workspace in Library first", 401)
    return next(iter(accounts))


@contextmanager
def use_account(account: str | None):
    """Run Google calls in this block against one connected account."""
    token = _account.set(account or None)
    try:
        yield
    finally:
        _account.reset(token)


def _save(data: dict) -> None:
    write_json_atomic(FILE, data)


def _id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value):
        raise GoogleError("Invalid Google file ID")
    return value


def status() -> dict:
    data = _state()
    accounts = data["accounts"]
    active = _resolve(data) if accounts else None
    calendar = _resolve(data, purpose="calendar") if accounts else None
    def scopes(ident):
        return (accounts.get(ident) or {}).get("granted_scopes") or []
    return {"configured": bool(data.get("client_id")),
            "connected": bool(accounts),
            "email": (accounts.get(active) or {}).get("email"),
            "client_id": data.get("client_id") or "",
            "granted_scopes": scopes(active),
            "calendar_connected": bool(calendar and CALENDAR_SCOPE in scopes(calendar)),
            "calendar_ids": (accounts.get(calendar) or {}).get("calendar_ids"),
            "active_account": active, "calendar_account": calendar,
            "accounts": [{"id": ident, "email": a.get("email") or "Google account",
                          "calendar_connected": CALENDAR_SCOPE in scopes(ident),
                          "can_send_email": GMAIL_SEND_SCOPE in scopes(ident),
                          "active": ident == active, "calendar": ident == calendar}
                         for ident, a in accounts.items()]}


def configure(client_id: str, client_secret: str = "") -> dict:
    client_id = client_id.strip()
    if len(client_id) > 256 or not client_id.endswith(".apps.googleusercontent.com"):
        raise GoogleError("Enter a Google OAuth Desktop client ID")
    data = _state()
    if data.get("client_id") != client_id:
        invalidate_calendar()
        # Tokens belong to the old client; every account must sign in again.
        data["accounts"] = {}
        data.pop("active_account", None)
        data.pop("calendar_account", None)
        data.pop("client_secret", None)
    data["client_id"] = client_id
    if client_secret:
        data["client_secret"] = encrypt(client_secret.strip())
    _save(data)
    return status()


def disconnect(account: str | None = None) -> dict:
    """Forget one account: the given one, or the active Library account."""
    data = _state()
    if data["accounts"]:
        ident = _resolve(data, account)
        data["accounts"].pop(ident, None)
        for key in ("active_account", "calendar_account"):
            if data.get(key) == ident:
                data.pop(key)
        _save(data)
    invalidate_calendar()
    return status()


def set_default(account: str, purpose: str = "library") -> dict:
    data = _state()
    ident = _resolve(data, account)
    data["calendar_account" if purpose == "calendar" else "active_account"] = ident
    _save(data)
    if purpose == "calendar":
        invalidate_calendar()
    return status()


def start_sign_in(redirect_uri: str) -> str:
    client_id = _state().get("client_id")
    if not client_id:
        raise GoogleError("Set a Google OAuth Desktop client ID first")
    if not re.fullmatch(r"http://127\.0\.0\.1:\d+/api/google/oauth/callback", redirect_uri):
        raise GoogleError("Google sign-in must start on this computer")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    _pending[state] = (verifier, time.time() + 600)
    for stale, (_, expires) in list(_pending.items()):
        if expires < time.time():
            _pending.pop(stale, None)
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
              "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent select_account",
              "state": state, "code_challenge": challenge, "code_challenge_method": "S256"}
    return AUTH_URL + "?" + urlencode(params)


async def finish_sign_in(state: str, code: str | None, redirect_uri: str, error: str | None = None) -> str:
    pending = _pending.pop(state, None)
    if not pending or pending[1] < time.time():
        raise GoogleError("This sign-in request expired or was not started here")
    if error or not code:
        raise GoogleError("Google sign-in was cancelled or denied")
    data = _state()
    body = {"client_id": data["client_id"], "code": code, "code_verifier": pending[0],
            "redirect_uri": redirect_uri, "grant_type": "authorization_code"}
    if data.get("client_secret"):
        body["client_secret"] = decrypt(data["client_secret"])
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(TOKEN_URL, data=body)
        if response.status_code >= 400:
            raise GoogleError("Google rejected the sign-in code", response.status_code)
        tokens = response.json()
        refresh = tokens.get("refresh_token")
        if not refresh:
            raise GoogleError("Google did not return an offline access token; reconnect and approve offline access")
        access = tokens.get("access_token")
        email = None
        if access:
            profile = await client.get("https://openidconnect.googleapis.com/v1/userinfo",
                                       headers={"Authorization": f"Bearer {access}"})
            if profile.is_success:
                email = profile.json().get("email")
    data = _state()  # another account may have finished signing in meanwhile
    ident = _account_key(email)
    record = data["accounts"].setdefault(ident, {})
    record["refresh_token"] = encrypt(refresh)
    record["access_token"] = encrypt(access) if access else None
    record["expires_at"] = time.time() + int(tokens.get("expires_in") or 3600)
    record["email"] = email
    record["granted_scopes"] = str(tokens.get("scope") or "").split()
    for key in ("active_account", "calendar_account"):
        if data.get(key) not in data["accounts"]:
            data[key] = ident
    _save(data)
    invalidate_calendar()
    return email or "Google account"


async def _token(ident: str, force: bool = False) -> str:
    async with _refresh_lock:
        data = _state()
        record = data["accounts"].get(ident)
        if not record or not record.get("refresh_token"):
            raise GoogleError("Connect Google Workspace in Library first", 401)
        if not force and record.get("access_token") and (record.get("expires_at") or 0) > time.time() + 90:
            return decrypt(record["access_token"])
        body = {"client_id": data["client_id"], "refresh_token": decrypt(record["refresh_token"]),
                "grant_type": "refresh_token"}
        if data.get("client_secret"):
            body["client_secret"] = decrypt(data["client_secret"])
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(TOKEN_URL, data=body)
        if response.status_code >= 400:
            raise GoogleError(f"Google authorization expired for {record.get('email') or 'this account'}; reconnect it in Library", 401)
        tokens = response.json()
        access = tokens.get("access_token")
        if not access:
            raise GoogleError("Google did not return an access token", 502)
        data = _state()
        record = data["accounts"].get(ident)
        if record is None:
            raise GoogleError("That Google account was disconnected", 401)
        record["access_token"] = encrypt(access)
        record["expires_at"] = time.time() + int(tokens.get("expires_in") or 3600)
        if "scope" in tokens:
            record["granted_scopes"] = tokens["scope"].split()
        _save(data)
        return access


async def request(api: str, method: str, path: str, *, params: dict | None = None,
                  body: dict | None = None, content: bytes | None = None,
                  content_type: str | None = None, raw: bool = False, account: str | None = None) -> dict | bytes:
    ident = _resolve(_state(), account, "calendar" if api == "calendar" else "library")
    decoded = path
    for _ in range(3):
        decoded = unquote(decoded)
    if (api not in HOSTS or not path.startswith("/") or "//" in decoded or ".." in decoded
            or re.search(r"%[0-9a-fA-F]{2}", decoded)
            or "\\" in decoded or any(ord(c) < 32 for c in decoded)):
        raise GoogleError("Invalid Google API request")
    url = HOSTS[api] + path
    for retry in range(2):
        token = await _token(ident, force=bool(retry))
        headers = {"Authorization": f"Bearer {token}"}
        if content_type:
            headers["Content-Type"] = content_type
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.request(method, url, params=params, json=body if content is None else None,
                                            content=content, headers=headers)
        if response.status_code == 401 and retry == 0:
            continue
        if response.is_redirect:
            raise GoogleError("Google API redirects are not allowed", 502)
        if response.status_code >= 400:
            try:
                detail = response.json().get("error", {}).get("message") or response.text[:250]
            except (ValueError, AttributeError):
                detail = response.text[:250]
            raise GoogleError(f"Google API: {detail}", response.status_code)
        if not raw and response.headers.get("content-type", "").startswith("application/json"):
            return response.json()
        return response.content
    raise GoogleError("Google authorization expired; reconnect the account", 401)


async def list_files(*, query: str = "", parent: str | None = None, kind: str = "all",
                     trashed: bool = False, page_token: str | None = None, section: str = "all") -> dict:
    if section not in ("all", "my_drive", "shared", "starred", "recent", "trash"):
        raise GoogleError("Unknown Drive section")
    trashed = trashed or section == "trash"
    terms = [f"trashed = {'true' if trashed else 'false'}"]
    if section == "shared" and not parent:
        terms.append("sharedWithMe = true")
    elif section == "starred" and not parent:
        terms.append("starred = true")
    elif section == "my_drive" and not parent and not query:
        terms.append("'root' in parents")
    if parent:
        terms.append(f"'{_id(parent)}' in parents")
    if kind in ("sheet", "form", "folder"):
        mime = {"sheet": "spreadsheet", "form": "form", "folder": "folder"}[kind]
        terms.append(f"mimeType = 'application/vnd.google-apps.{mime}'")
    elif kind != "all":
        raise GoogleError("Unknown file type")
    if query:
        safe = query[:100].replace("\\", "\\\\").replace("'", "\\'")
        terms.append(f"name contains '{safe}'")
    params = {"q": " and ".join(terms), "pageSize": 100, "fields": FILE_FIELDS,
              "orderBy": "viewedByMeTime desc" if section == "recent" else "folder,name",
              "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}
    if page_token:
        params["pageToken"] = page_token
    return await request("drive", "GET", "/files", params=params)


async def file_info(file_id: str) -> dict:
    return await request("drive", "GET", f"/files/{_id(file_id)}",
                         params={"fields": FILE_FIELDS.split("files(", 1)[1].rstrip(")"),
                                 "supportsAllDrives": "true"})


async def file_content(file_id: str, export_mime: str | None = None) -> bytes:
    path = f"/files/{_id(file_id)}"
    params = {"mimeType": export_mime} if export_mime else {"alt": "media", "supportsAllDrives": "true"}
    if export_mime:
        path += "/export"
    content = await request("drive", "GET", path, params=params, raw=True)
    if not isinstance(content, bytes):
        raise GoogleError("Google returned no file content", 502)
    if len(content) > MAX_DOWNLOAD:
        raise GoogleError("This file is larger than Kairos's 25 MB download limit", 413)
    return content


async def drive_storage() -> dict:
    return await request("drive", "GET", "/about", params={"fields": "storageQuota"})


def image_mime(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    raise GoogleError("This image format cannot be previewed safely", 415)


async def file_thumbnail(file_id: str) -> tuple[bytes, str]:
    info = await file_info(file_id)
    url = urlsplit(info.get("thumbnailLink") or "")
    if (url.scheme != "https" or url.netloc != "lh3.googleusercontent.com"
            or url.username or url.password or url.fragment):
        raise GoogleError("No supported Google thumbnail for this file", 404)
    content = await request("thumbnail", "GET", url.path, params=dict(parse_qsl(url.query)), raw=True)
    if not isinstance(content, bytes) or len(content) > MAX_DOWNLOAD:
        raise GoogleError("Thumbnail exceeds the 25 MB download limit", 413)
    return content, image_mime(content)


async def file_preview(file_id: str) -> tuple[bytes, str]:
    info = await file_info(file_id)
    mime = info.get("mimeType") or ""
    if int(info.get("size") or 0) > MAX_DOWNLOAD:
        raise GoogleError("This file is larger than Kairos's 25 MB download limit", 413)
    if mime == "application/vnd.google-apps.document":
        from core.google_preview import sanitize_html
        content = await file_content(file_id, "text/html")
        return sanitize_html(content.decode("utf-8", errors="replace")).encode("utf-8"), "text/html"
    if mime == "application/vnd.google-apps.presentation":
        return await file_content(file_id, "application/pdf"), "application/pdf"
    if mime == "application/pdf":
        return await file_content(file_id), mime
    if mime.startswith("image/"):
        content = await file_content(file_id)
        return content, image_mime(content)
    extension = os.path.splitext(info.get("name") or "")[1].lower()
    if (mime.startswith("text/") or mime in ("application/json", "application/javascript", "application/xml")
            or extension in (".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".css", ".html", ".xml", ".csv", ".sql", ".sh", ".c", ".cpp", ".java", ".rs")):
        return await file_content(file_id), "text/plain"
    raise GoogleError("Preview unavailable for this type; download or open in Google", 415)


async def drive_action(action: str, *, file_id: str | None = None, name: str | None = None,
                       parent: str | None = None, permission_id: str | None = None,
                       email: str | None = None, role: str | None = None,
                       permission_type: str | None = None, domain: str | None = None) -> dict:
    if action == "create_folder":
        return await request("drive", "POST", "/files", params={"fields": "id,name,mimeType,webViewLink"},
                             body={"name": (name or "New folder")[:200], "mimeType": "application/vnd.google-apps.folder",
                                   **({"parents": [_id(parent)]} if parent else {})})
    ident = _id(file_id or "")
    path = f"/files/{ident}"
    common = {"supportsAllDrives": "true", "fields": "id,name,mimeType,parents,trashed,starred,webViewLink"}
    if action == "rename":
        if not name or len(name) > 255:
            raise GoogleError("Enter a file name under 256 characters")
        return await request("drive", "PATCH", path, params=common, body={"name": name})
    if action == "move":
        if not parent:
            raise GoogleError("Choose a destination folder")
        info = await file_info(ident)
        return await request("drive", "PATCH", path,
                             params={**common, "addParents": _id(parent),
                                     "removeParents": ",".join(info.get("parents") or [])}, body={})
    if action == "copy":
        return await request("drive", "POST", path + "/copy", params=common,
                             body={**({"name": name[:255]} if name else {}),
                                   **({"parents": [_id(parent)]} if parent else {})})
    if action in ("trash", "restore"):
        return await request("drive", "PATCH", path, params=common, body={"trashed": action == "trash"})
    if action == "star":
        return await request("drive", "PATCH", path, params=common, body={"starred": True})
    if action == "unstar":
        return await request("drive", "PATCH", path, params=common, body={"starred": False})
    if action == "delete":
        await request("drive", "DELETE", path, params={"supportsAllDrives": "true"})
        return {"deleted": True}
    if action == "permissions":
        return await request("drive", "GET", path + "/permissions",
                             params={"supportsAllDrives": "true", "fields": "permissions(id,type,role,emailAddress,displayName,domain),nextPageToken"})
    if action == "share":
        kind = permission_type or "user"
        if kind not in ("user", "group", "domain", "anyone") or role not in ("reader", "commenter", "writer"):
            raise GoogleError("Choose a sharing type and reader, commenter, or writer access")
        if kind in ("user", "group") and (not email or "@" not in email or len(email) > 254):
            raise GoogleError("Enter a valid email address")
        if kind == "domain" and (not domain or len(domain) > 253 or not re.fullmatch(r"[A-Za-z0-9.-]+", domain)):
            raise GoogleError("Enter a valid domain")
        permission = {"type": kind, "role": role}
        if kind in ("user", "group"):
            permission["emailAddress"] = email
        elif kind == "domain":
            permission["domain"] = domain
        return await request("drive", "POST", path + "/permissions",
                             params={"supportsAllDrives": "true", "sendNotificationEmail": "true" if kind in ("user", "group") else "false",
                                     "fields": "id,type,role,emailAddress,domain"}, body=permission)
    if action == "update_permission":
        if role not in ("reader", "commenter", "writer"):
            raise GoogleError("Choose reader, commenter, or writer access")
        return await request("drive", "PATCH", path + f"/permissions/{_id(permission_id or '')}",
                             params={"supportsAllDrives": "true", "fields": "id,type,role,emailAddress,domain"},
                             body={"role": role})
    if action == "revoke":
        await request("drive", "DELETE", path + f"/permissions/{_id(permission_id or '')}",
                      params={"supportsAllDrives": "true"})
        return {"revoked": True}
    if action == "revisions":
        return await request("drive", "GET", path + "/revisions",
                             params={"fields": "revisions(id,modifiedTime,keepForever,lastModifyingUser,originalFilename),nextPageToken"})
    raise GoogleError("Unknown Drive action")


async def upload_file(name: str, data: bytes, mime_type: str, parent: str | None = None) -> dict:
    if not name or len(data) > MAX_DOWNLOAD:
        raise GoogleError("Choose a file under 25 MB", 413)
    boundary = "jarvis_" + secrets.token_hex(16)
    metadata = {"name": name[:255], **({"parents": [_id(parent)]} if parent else {})}
    payload = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
               + json.dumps(metadata) + f"\r\n--{boundary}\r\nContent-Type: {mime_type or 'application/octet-stream'}\r\n\r\n").encode("utf-8")
    payload += data + f"\r\n--{boundary}--\r\n".encode("ascii")
    return await request("upload", "POST", "/files", params={"uploadType": "multipart", "fields": "id,name,mimeType,webViewLink"},
                         content=payload, content_type=f"multipart/related; boundary={boundary}")


async def sheet_get(file_id: str, cell_range: str | None = None) -> dict:
    ident = _id(file_id)
    if cell_range:
        return await request("sheets", "GET", f"/spreadsheets/{ident}/values/{quote(cell_range, safe='!:$')}" ,
                             params={"valueRenderOption": "FORMATTED_VALUE"})
    return await request("sheets", "GET", f"/spreadsheets/{ident}",
                         params={"fields": "spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title,index,gridProperties))"})


async def sheet_action(action: str, *, file_id: str | None = None, title: str | None = None,
                       cell_range: str | None = None, values: list | None = None,
                       requests: list | None = None) -> dict:
    if action == "create":
        return await request("sheets", "POST", "/spreadsheets", body={"properties": {"title": title or "Untitled spreadsheet"}})
    ident = _id(file_id or "")
    if action == "batch":
        if not isinstance(requests, list) or len(requests) > 50:
            raise GoogleError("Provide at most 50 spreadsheet changes")
        return await request("sheets", "POST", f"/spreadsheets/{ident}:batchUpdate", body={"requests": requests})
    if not cell_range or len(cell_range) > 300:
        raise GoogleError("Choose a cell range")
    path = f"/spreadsheets/{ident}/values/{quote(cell_range, safe='!:$')}"
    if action == "clear":
        return await request("sheets", "POST", path + ":clear", body={})
    if not isinstance(values, list) or len(values) > 1000:
        raise GoogleError("Provide at most 1,000 rows")
    if action == "update":
        return await request("sheets", "PUT", path, params={"valueInputOption": "USER_ENTERED"},
                             body={"range": cell_range, "majorDimension": "ROWS", "values": values})
    if action == "append":
        return await request("sheets", "POST", path + ":append",
                             params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
                             body={"values": values})
    raise GoogleError("Unknown Sheets action")


async def form_get(file_id: str, responses: bool = False, page_token: str | None = None) -> dict:
    path = f"/forms/{_id(file_id)}" + ("/responses" if responses else "")
    return await request("forms", "GET", path, params={"pageSize": 100, **({"pageToken": page_token} if page_token else {})} if responses else None)


async def form_action(action: str, *, file_id: str | None = None, title: str | None = None,
                      requests: list | None = None, published: bool | None = None) -> dict:
    if action == "create":
        if not title:
            raise GoogleError("Enter a form title")
        return await request("forms", "POST", "/forms", body={"info": {"title": title[:200]}})
    ident = _id(file_id or "")
    if action == "batch":
        if not isinstance(requests, list) or len(requests) > 50:
            raise GoogleError("Provide at most 50 form changes")
        return await request("forms", "POST", f"/forms/{ident}:batchUpdate", body={"requests": requests})
    if action == "publish":
        if published is None:
            raise GoogleError("Choose a published state")
        return await request("forms", "POST", f"/forms/{ident}:setPublishSettings",
                             body={"publishSettings": {"publishState": {
                                 "isPublished": published, "isAcceptingResponses": published}},
                                   "updateMask": "publishState"})
    raise GoogleError("Unknown Forms action")


def invalidate_calendar() -> None:
    global _calendar_generation
    _calendar_generation += 1
    _calendar_cache.clear()


def _calendar_access() -> None:
    data = _state()
    if not data["accounts"] or CALENDAR_SCOPE not in (data["accounts"][_resolve(data, purpose="calendar")].get("granted_scopes") or []):
        raise GoogleError("Reconnect to add Calendar", 409)


def _calendar_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.@+-]{1,256}", value) or ".." in value:
        raise GoogleError("Invalid Google calendar ID")
    return quote(value, safe="")


def calendar_settings(calendar_ids: list[str]) -> dict:
    _calendar_access()
    for ident in calendar_ids:
        _calendar_id(ident)
    data = _state()
    record = data["accounts"][_resolve(data, purpose="calendar")]
    record["calendar_ids"] = list(dict.fromkeys(calendar_ids))
    _save(data)
    invalidate_calendar()
    return {"calendar_ids": record["calendar_ids"]}


async def calendar_list() -> list[dict]:
    _calendar_access()
    calendars, page = [], None
    while True:
        result = await request("calendar", "GET", "/users/me/calendarList",
                               params={"maxResults": 250, **({"pageToken": page} if page else {})})
        for item in result.get("items", []):
            if item.get("deleted"):
                continue
            calendars.append({"id": item["id"], "name": item.get("summaryOverride") or item.get("summary") or item["id"],
                              "color": item.get("backgroundColor"), "primary": bool(item.get("primary")),
                              "time_zone": item.get("timeZone") or "UTC", "access_role": item.get("accessRole"),
                              "selected": not item.get("hidden", False) and item.get("selected", True)})
        page = result.get("nextPageToken")
        if not page:
            return calendars


def _timed(value: str, zone: str = "UTC") -> str:
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=ZoneInfo(zone))
        return stamp.isoformat()
    except (ValueError, ZoneInfoNotFoundError) as problem:
        raise GoogleError("Enter an ISO date/time and a valid time zone") from problem


def _map_calendar_event(item: dict, calendar: dict) -> dict:
    start, end = item.get("start", {}), item.get("end", {})
    all_day = "date" in start
    zone = start.get("timeZone") or calendar.get("time_zone") or "UTC"
    repeat = repeats.parse_google_rule(item.get("recurrence"), start.get("date") if all_day else start.get("dateTime"), zone, all_day)
    return {"id": item["id"], "title": item.get("summary") or "Untitled event",
            "start": start.get("date") if all_day else _timed(start.get("dateTime") or "", zone),
            "end": end.get("date") if all_day else _timed(end.get("dateTime") or start.get("dateTime") or "", end.get("timeZone") or zone),
            "all_day": all_day, "time_zone": zone, "location": item.get("location") or "",
            "description": item.get("description") or "", "source": "google",
            "calendar_id": calendar["id"], "calendar_color": calendar.get("color"),
            "calendar_name": calendar.get("name"), "editable": calendar.get("access_role") in ("owner", "writer"),
            "web_link": item.get("htmlLink"), "series_id": item.get("recurringEventId"),
            "original_start": item.get("originalStartTime"), "recurrence": repeat if repeat is not False else None,
            "recurrence_supported": repeat is not False, "recurrence_raw": item.get("recurrence") or []}


async def calendar_event(calendar_id: str, event_id: str) -> dict:
    """Read the actual series master for the all-events editor."""
    _calendar_access()
    path = f"/calendars/{_calendar_id(calendar_id)}/events/{_id(event_id)}"
    calendars = await calendar_list()
    calendar = next((c for c in calendars if c["id"] == calendar_id or (calendar_id == "primary" and c["primary"])), None)
    if calendar is None:
        raise GoogleError("Google calendar no longer available", 404)
    return _map_calendar_event(await request("calendar", "GET", path), calendar)


def calendar_event_time(item: dict) -> float:
    return datetime.fromisoformat(_timed(item["start"], item.get("time_zone") or "UTC")).timestamp()


async def calendar_events(calendar_ids: list[str], start: str, end: str) -> list[dict]:
    _calendar_access()
    start, end = _timed(start), _timed(end)
    if datetime.fromisoformat(start) >= datetime.fromisoformat(end):
        raise GoogleError("The range must end after it starts")
    ids = tuple(sorted(set(calendar_ids)))
    for ident in ids:
        _calendar_id(ident)
    try:
        owner = _resolve(_state(), purpose="calendar")
    except GoogleError:
        owner = None  # the request below reports the missing account
    key = (owner, ids, start, end)
    cached = _calendar_cache.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        return deepcopy(cached[1])
    if not ids:
        return []
    generation = _calendar_generation
    calendars = {c["id"]: c for c in await calendar_list()}
    events = []
    for ident in ids:
        calendar = calendars.get(ident)
        if ident == "primary":
            calendar = next((c for c in calendars.values() if c["primary"]), None)
        if not calendar:
            raise GoogleError("Google calendar no longer available", 404)
        page = None
        while True:
            result = await request("calendar", "GET", f"/calendars/{_calendar_id(ident)}/events",
                                   params={"timeMin": start, "timeMax": end, "singleEvents": "true",
                                           "orderBy": "startTime", "maxResults": 2500,
                                           **({"pageToken": page} if page else {})})
            events.extend(_map_calendar_event(item, calendar) for item in result.get("items", [])
                          if item.get("status") != "cancelled" and item.get("start"))
            if len(events) > repeats.MAX_OCCURRENCES:
                raise GoogleError("Too many Google Calendar events in this range. Choose a shorter range.")
            page = result.get("nextPageToken")
            if not page:
                break
    events.sort(key=calendar_event_time)
    # A response started before a write must not refill the cache afterwards.
    if generation == _calendar_generation:
        if len(_calendar_cache) >= 64:
            _calendar_cache.clear()
        _calendar_cache[key] = (time.monotonic(), deepcopy(events))
    return events


async def selected_calendar_events(start: str, end: str) -> list[dict]:
    if not status()["calendar_connected"]:
        return []
    data = _state()
    ids = data["accounts"][_resolve(data, purpose="calendar")].get("calendar_ids")
    if ids is None:
        ids = [c["id"] for c in await calendar_list() if c["selected"]]
    return await calendar_events(ids, start, end)


async def calendar_action(action: str, *, calendar_id: str = "primary", event_id: str | None = None,
                          event: dict | None = None, text: str | None = None) -> dict:
    _calendar_access()
    path = f"/calendars/{_calendar_id(calendar_id)}/events"
    if action not in ("create", "update", "delete", "quick_add"):
        raise GoogleError("Unknown Google Calendar action")
    if action in ("update", "delete"):
        path += "/" + _id(event_id or "")
    body = None
    params = None
    if action == "quick_add":
        if not text or not text.strip() or len(text) > 2000:
            raise GoogleError("Enter an event description under 2001 characters")
        path += "/quickAdd"
        params = {"text": text}
    elif action != "delete":
        fields = event or {}
        body = {k: v for k, v in fields.items() if k in ("summary", "description", "location", "start", "end")}
        if action == "create" and not all(body.get(k) for k in ("summary", "start", "end")):
            raise GoogleError("An event needs a title, start and end")
        for key in ("start", "end"):
            if key not in body:
                continue
            value = body[key]
            if not isinstance(value, dict) or ("date" in value) == ("dateTime" in value):
                raise GoogleError("Use either date or dateTime for an event boundary")
            if "date" in value:
                try:
                    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value["date"]):
                        raise ValueError()
                    datetime.strptime(value["date"], "%Y-%m-%d")
                except (ValueError, TypeError) as problem:
                    raise GoogleError("Enter an all-day date as YYYY-MM-DD") from problem
                body[key] = {"date": value["date"]}
            else:
                body[key] = {"dateTime": _timed(value.get("dateTime") or "", value.get("timeZone") or "UTC")}
                if value.get("timeZone"):
                    body[key]["timeZone"] = value["timeZone"]
        if "start" in body and "end" in body:
            date_only = "date" in body["start"]
            if date_only != ("date" in body["end"]):
                raise GoogleError("Start and end must both be all-day or timed")
            key = "date" if date_only else "dateTime"
            if datetime.fromisoformat(body["start"][key]) >= datetime.fromisoformat(body["end"][key]):
                raise GoogleError("The event must end after it starts; all-day end dates are exclusive")
        if "repeat" in fields:
            try:
                if not all(body.get(k) for k in ("start", "end")):
                    raise ValueError("Changing a repeat rule needs start and end")
                all_day = "date" in body["start"]
                time_zone = body["start"].get("timeZone") or "UTC"
                repeats.zone(time_zone)
                if fields["repeat"] and not all_day and not body["start"].get("timeZone"):
                    raise ValueError("A timed repeat needs an IANA time zone")
                body["recurrence"] = repeats.google_rule(fields["repeat"],
                    body["start"].get("date") if all_day else body["start"]["dateTime"], time_zone, all_day)
            except (ValueError, TypeError) as exc:
                raise GoogleError(str(exc)) from exc
    method = {"create": "POST", "update": "PATCH", "delete": "DELETE", "quick_add": "POST"}[action]
    result = await request("calendar", method, path, body=body, params=params)
    invalidate_calendar()
    return result if isinstance(result, dict) else {"deleted": True}


async def send_gmail(account: str, to: list[str], subject: str, body: str,
                     cc: list[str] | None = None, in_reply_to: str | None = None) -> dict:
    """Send one plain-text message as the given connected Google account."""
    data = _state()
    ident = _resolve(data, account)
    record = data["accounts"][ident]
    if GMAIL_SEND_SCOPE not in (record.get("granted_scopes") or []):
        raise GoogleError(f"Reconnect {record.get('email') or 'this account'} in Library to allow sending email", 409)
    message = EmailMessage()
    message["From"] = record.get("email") or ""
    message["To"] = ", ".join(to)
    if cc:
        message["Cc"] = ", ".join(cc)
    message["Subject"] = subject
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
        message["References"] = in_reply_to
    message.set_content(body)
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
    result = await request("gmail", "POST", "/users/me/messages/send", body={"raw": raw}, account=ident)
    return {"id": result.get("id"), "thread_id": result.get("threadId"), "from": record.get("email")}

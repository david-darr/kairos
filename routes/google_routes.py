"""Admin-owned Google Workspace connection and Library actions.

Drive, Sheets and Forms routes take an optional `account` query parameter:
an opaque id from /status, checked against the signed-in user's own
connected accounts before any token is used. Without it, the user's default
account is used. Calendar resolves its separate selection for the same user."""
from __future__ import annotations

import html
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, Request
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from core import google_workspace as google
from core.middleware import local_api_base, require_admin


router = APIRouter(prefix="/api/google", tags=["google-workspace"])
CALLBACK = "/google/oauth/callback"


class ClientRequest(BaseModel):
    client_id: str
    client_secret: str = ""


class SignInRequest(BaseModel):
    add: bool = False
    account: str | None = None  # reconnect this account


class DriveActionRequest(BaseModel):
    action: Literal["create_folder", "rename", "move", "copy", "trash", "restore", "star", "unstar", "delete", "permissions", "share", "update_permission", "revoke", "revisions"]
    file_id: str | None = None
    name: str | None = None
    parent: str | None = None
    permission_id: str | None = None
    email: str | None = None
    role: str | None = None
    permission_type: str | None = None
    domain: str | None = None


class SheetActionRequest(BaseModel):
    action: Literal["create", "update", "append", "clear", "batch"]
    file_id: str | None = None
    title: str | None = None
    cell_range: str | None = None
    values: list | None = None
    requests: list | None = None


class FormActionRequest(BaseModel):
    action: Literal["create", "batch", "publish"]
    file_id: str | None = None
    title: str | None = None
    requests: list | None = None
    published: bool | None = None


class DefaultAccountRequest(BaseModel):
    account: str
    purpose: Literal["library", "calendar"] = "library"


class CalendarSettingsRequest(BaseModel):
    calendar_ids: list[str]


class CalendarActionRequest(BaseModel):
    action: Literal["create", "update", "delete", "quick_add"]
    calendar_id: str = "primary"
    event_id: str | None = None
    event: dict | None = None
    text: str | None = None


async def _run(coroutine):
    try:
        return await coroutine
    except google.GoogleError as problem:
        raise HTTPException(problem.status, str(problem)) from problem


def _account(user: str, account: str | None) -> str:
    try:
        return google.resolve_account(user, account)
    except google.GoogleError as problem:
        raise HTTPException(problem.status, str(problem)) from problem


@router.get("/status")
async def status(user: str = Depends(require_admin)) -> dict:
    return google.status(user)


@router.post("/client")
async def configure(body: ClientRequest, user: str = Depends(require_admin)) -> dict:
    try:
        return google.configure(body.client_id, body.client_secret, user)
    except google.GoogleError as problem:
        raise HTTPException(problem.status, str(problem)) from problem


@router.delete("/connection")
async def disconnect(user: str = Depends(require_admin)) -> dict:
    return google.disconnect(None, user)


@router.delete("/accounts/{account_id}")
async def disconnect_account(account_id: str, user: str = Depends(require_admin)) -> dict:
    try:
        return google.disconnect(account_id, user)
    except google.GoogleError as problem:
        raise HTTPException(problem.status, str(problem)) from problem


@router.post("/accounts/default")
async def default_account(body: DefaultAccountRequest, user: str = Depends(require_admin)) -> dict:
    try:
        return google.set_default(body.account, body.purpose, user)
    except google.GoogleError as problem:
        raise HTTPException(problem.status, str(problem)) from problem


async def _calendar_scope(account: str | None = None, user: str = Depends(require_admin)):
    try:
        ident = google.resolve_calendar_account(user, account)
        with google.use_account(ident, user):
            yield
    except google.GoogleError as problem:
        raise HTTPException(problem.status, str(problem)) from problem


@router.post("/oauth/start")
async def start(body: SignInRequest | None = None, user: str = Depends(require_admin)) -> dict:
    try:
        return {"url": google.start_sign_in(local_api_base() + CALLBACK, user, bool(body and body.add),
                                            body.account if body else None)}
    except google.GoogleError as problem:
        raise HTTPException(problem.status, str(problem)) from problem


@router.get("/oauth/callback", response_class=HTMLResponse)
async def callback(state: str = "", code: str | None = None, error: str | None = None) -> HTMLResponse:
    # No Kairos session check here, deliberately: Google sends the user back
    # to this loopback address in the system browser, which has no Kairos
    # cookie. The defence is the state: unguessable, single use, expiring in
    # ten minutes and bound to the Kairos user who started the sign-in, plus
    # PKCE (the code is useless without that sign-in's verifier) and a
    # redirect that only reaches 127.0.0.1.
    from core import accounts
    started_by = google.pending_account(state)
    try:
        # The account that started this sign-in (Multi-Account group 6); an unknown state fails as before.
        with accounts.as_account(started_by or accounts.local_account()):
            account = await google.finish_sign_in(state, code, local_api_base() + CALLBACK, error)
        message, status_code = f"Connected {html.escape(account)}. Return to Kairos.", 200
    except google.GoogleError as problem:
        message, status_code = html.escape(str(problem)), problem.status
    return HTMLResponse(f"<!doctype html><meta charset=utf-8><title>Kairos Google connection</title>"
                        f"<body style='font-family:system-ui;max-width:34rem;margin:4rem auto;padding:1rem'>"
                        f"<h1>Google Workspace</h1><p>{message}</p></body>", status_code=status_code)


@router.get("/drive/files")
async def files(q: str = "", parent: str | None = None, kind: str = "all", trashed: bool = False,
                page_token: str | None = None, section: str = "all", account: str | None = None,
                user: str = Depends(require_admin)) -> dict:
    return await _run(google.list_files(query=q, parent=parent, kind=kind, trashed=trashed, page_token=page_token,
                                        section=section, account=_account(user, account)))


@router.get("/drive/storage")
async def storage(account: str | None = None, user: str = Depends(require_admin)) -> dict:
    return await _run(google.drive_storage(_account(user, account)))


@router.get("/drive/files/{file_id}/thumbnail")
async def thumbnail(file_id: str, account: str | None = None, user: str = Depends(require_admin)) -> Response:
    content, mime = await _run(google.file_thumbnail(file_id, _account(user, account)))
    return Response(content, media_type=mime, headers={"Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff"})


@router.get("/drive/files/{file_id}/preview")
async def preview(file_id: str, account: str | None = None, user: str = Depends(require_admin)) -> Response:
    content, mime = await _run(google.file_preview(file_id, _account(user, account)))
    return Response(content, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.get("/drive/files/{file_id}")
async def file_info(file_id: str, account: str | None = None, user: str = Depends(require_admin)) -> dict:
    return await _run(google.file_info(file_id, _account(user, account)))


_EXPORTS = {
    "application/vnd.google-apps.document": ("application/pdf", ".pdf"),
    "application/vnd.google-apps.spreadsheet": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    "application/vnd.google-apps.presentation": ("application/pdf", ".pdf"),
    "application/vnd.google-apps.drawing": ("image/png", ".png"),
}


@router.get("/drive/files/{file_id}/download")
async def download(file_id: str, account: str | None = None, user: str = Depends(require_admin)) -> Response:
    account = _account(user, account)
    info = await _run(google.file_info(file_id, account))
    mime = info.get("mimeType") or "application/octet-stream"
    if mime.startswith("application/vnd.google-apps.") and mime not in _EXPORTS:
        raise HTTPException(400, "This Google file cannot be exported; open it in Google instead")
    export_mime, suffix = _EXPORTS.get(mime, (None, ""))
    data = await _run(google.file_content(file_id, export_mime, account))
    filename = (info.get("name") or "download") + suffix
    return Response(content=data, media_type=export_mime or mime,
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"})


@router.post("/drive/upload")
async def upload(file: UploadFile = File(...), parent: str | None = Form(None), account: str | None = None,
                 user: str = Depends(require_admin)) -> dict:
    account = _account(user, account)
    data = await file.read(google.MAX_DOWNLOAD + 1)
    return await _run(google.upload_file(file.filename or "upload", data,
                                          file.content_type or "application/octet-stream", parent, account))


@router.post("/drive/action")
async def drive_action(body: DriveActionRequest, account: str | None = None, user: str = Depends(require_admin)) -> dict:
    return await _run(google.drive_action(**body.model_dump(), account=_account(user, account)))


@router.get("/sheets/{file_id}")
async def sheet(file_id: str, cell_range: str | None = None, account: str | None = None,
                user: str = Depends(require_admin)) -> dict:
    return await _run(google.sheet_get(file_id, cell_range, _account(user, account)))


@router.post("/sheets/action")
async def sheet_action(body: SheetActionRequest, account: str | None = None, user: str = Depends(require_admin)) -> dict:
    return await _run(google.sheet_action(**body.model_dump(), account=_account(user, account)))


@router.get("/forms/{file_id}")
async def form(file_id: str, responses: bool = False, page_token: str | None = None, account: str | None = None,
               user: str = Depends(require_admin)) -> dict:
    return await _run(google.form_get(file_id, responses, page_token, _account(user, account)))


@router.post("/forms/action")
async def form_action(body: FormActionRequest, account: str | None = None, user: str = Depends(require_admin)) -> dict:
    return await _run(google.form_action(**body.model_dump(), account=_account(user, account)))


@router.get("/calendar/calendars")
async def calendars(user: str = Depends(require_admin), scope=Depends(_calendar_scope)) -> list[dict]:
    return await _run(google.calendar_list())


@router.patch("/calendar/settings")
async def calendar_settings(body: CalendarSettingsRequest, user: str = Depends(require_admin), scope=Depends(_calendar_scope)) -> dict:
    try:
        return google.calendar_settings(body.calendar_ids)
    except google.GoogleError as problem:
        raise HTTPException(problem.status, str(problem)) from problem


@router.get("/calendar/events")
async def calendar_events(start: str, end: str, calendar_ids: str = "primary", user: str = Depends(require_admin), scope=Depends(_calendar_scope)) -> list[dict]:
    return await _run(google.calendar_events([ident for ident in calendar_ids.split(",") if ident], start, end))


@router.post("/calendar/action")
async def calendar_action(body: CalendarActionRequest, user: str = Depends(require_admin), scope=Depends(_calendar_scope)) -> dict:
    return await _run(google.calendar_action(**body.model_dump()))


@router.get("/calendar/events/{event_id}")
async def calendar_event(event_id: str, calendar_id: str = "primary", user: str = Depends(require_admin), scope=Depends(_calendar_scope)) -> dict:
    return await _run(google.calendar_event(calendar_id, event_id))

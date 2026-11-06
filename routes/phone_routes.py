"""Phone calls and texts through the person's own Twilio or Telnyx number (build spec step 8).

Settings (GET/PUT/DELETE /api/phone) belong to the signed-in account. The provider endpoints (voice webhook, Telnyx
events, the media-stream WebSocket) are public by necessity and trust nothing until the provider's signature or a
one-use stream token has been checked (services/phone_calls.py); they find the account from the number that was called.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket
from pydantic import BaseModel, Field

from core import phone_connection as connection
from core.middleware import require_user
from services import phone_calls

router = APIRouter(prefix="/api/phone", tags=["phone"])


class PhoneBody(BaseModel):
    provider: Optional[str] = Field(default=None, max_length=20)
    account_sid: Optional[str] = Field(default=None, max_length=80)
    auth_token: Optional[str] = Field(default=None, max_length=200)
    api_key: Optional[str] = Field(default=None, max_length=300)
    public_key: Optional[str] = Field(default=None, max_length=200)
    connection_id: Optional[str] = Field(default=None, max_length=80)
    number: Optional[str] = Field(default=None, max_length=40)
    user_number: Optional[str] = Field(default=None, max_length=40)
    public_url: Optional[str] = Field(default=None, max_length=300)
    bot_id: Optional[str] = Field(default=None, max_length=80)
    conversation_endpoint_id: Optional[str] = Field(default=None, max_length=80)
    conversation_model: Optional[str] = Field(default=None, max_length=160)
    enabled: Optional[bool] = None
    pin: Optional[str] = Field(default=None, max_length=12)
    require_pin: Optional[bool] = None


@router.get("")
async def get_connection(user: str = Depends(require_user)) -> dict:
    return {"connection": connection.public(connection.get()), "fields": {k: [f[0] for f in v] for k, v in connection.FIELDS.items()}}


@router.put("")
async def save_connection(body: PhoneBody, user: str = Depends(require_user)) -> dict:
    try:
        record = connection.save(body.model_dump(exclude_unset=True))
    except connection.PhoneError as error:
        raise HTTPException(status_code=422, detail=str(error))
    return {"connection": connection.public(record)}


@router.delete("")
async def delete_connection(user: str = Depends(require_user)) -> dict:
    return {"removed": connection.delete()}


def _response(result) -> Response:
    status, content, media_type = result
    return Response(content=content, status_code=status, media_type=media_type)


@router.post("/twilio/voice", include_in_schema=False)
async def twilio_voice(request: Request) -> Response:
    body = await request.body()
    if len(body) > 100_000:
        return Response(status_code=413)
    return _response(await phone_calls.twilio_voice(dict(request.headers), request.url.query, body))


@router.post("/telnyx/events", include_in_schema=False)
async def telnyx_events(request: Request) -> Response:
    body = await request.body()
    if len(body) > 200_000:
        return Response(status_code=413)
    return _response(await phone_calls.telnyx_event(dict(request.headers), body))


class _Socket:
    """The few things a media stream needs from a WebSocket."""

    def __init__(self, socket: WebSocket):
        self.socket, self.headers, self.query = socket, dict(socket.headers), dict(socket.query_params)

    async def recv(self) -> Optional[str]:
        message = await self.socket.receive()
        if message.get("type") == "websocket.disconnect":
            return None
        return message.get("text") or ""

    async def send(self, text: str) -> None:
        await self.socket.send_text(text)

    async def close(self, code: int = 1000) -> None:
        try:
            await self.socket.close(code)
        except RuntimeError:
            pass


@router.websocket("/{provider}/stream")
async def media_stream(socket: WebSocket, provider: str) -> None:
    if provider not in ("twilio", "telnyx"):
        await socket.close(1008)
        return
    await socket.accept()
    wrapped = _Socket(socket)
    try:
        await phone_calls.serve_stream(provider, wrapped)
    finally:
        await wrapped.close()

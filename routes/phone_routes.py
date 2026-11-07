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
    others_enabled: Optional[bool] = None
    caller_name: Optional[str] = Field(default=None, max_length=60)


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


# -- calls to other people (build spec step 9, services/outbound_calls.py) --------------------------------------

class AnswerBody(BaseModel):
    question_id: str = Field(min_length=1, max_length=40)
    answer: str = Field(min_length=1, max_length=500)


class BlockBody(BaseModel):
    number: str = Field(min_length=1, max_length=40)
    blocked: bool = True


def _refused(error: Exception) -> HTTPException:
    return HTTPException(status_code=409, detail=str(error))


@router.get("/outbound")
async def outbound_list(user: str = Depends(require_user)) -> dict:
    from core import accounts
    from services import outbound_calls
    return outbound_calls.listing(accounts.effective_account())


@router.get("/outbound/active")
async def outbound_active(user: str = Depends(require_user)) -> dict:
    from core import accounts
    from services import outbound_calls
    return {"calls": outbound_calls.active(accounts.effective_account())}


@router.get("/outbound/{call_id}")
async def outbound_get(call_id: str, user: str = Depends(require_user)) -> dict:
    from core import accounts
    from services import outbound_calls
    call = outbound_calls.get(accounts.effective_account(), call_id)
    if call is None:
        raise HTTPException(status_code=404, detail="Call not found")
    return outbound_calls.view(call)


@router.post("/outbound/{call_id}/answer")
async def outbound_answer(call_id: str, body: AnswerBody, user: str = Depends(require_user)) -> dict:
    from core import accounts
    from services import outbound_calls
    try:
        return outbound_calls.answer(accounts.effective_account(), call_id, body.question_id, body.answer)
    except outbound_calls.CallRefused as error:
        raise _refused(error)


@router.post("/outbound/{call_id}/hangup")
async def outbound_hangup(call_id: str, user: str = Depends(require_user)) -> dict:
    from core import accounts
    from services import outbound_calls
    try:
        return await outbound_calls.hang_up(accounts.effective_account(), call_id)
    except outbound_calls.CallRefused as error:
        raise HTTPException(status_code=404, detail=str(error))


@router.post("/blocked")
async def set_blocked(body: BlockBody, user: str = Depends(require_user)) -> dict:
    from core import accounts
    from services import outbound_calls
    try:
        return {"blocked": outbound_calls.set_blocked(accounts.effective_account(), body.number, body.blocked)}
    except outbound_calls.CallRefused as error:
        raise HTTPException(status_code=422, detail=str(error))


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

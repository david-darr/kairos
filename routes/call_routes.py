"""Native calls use their own transcript; after the call its summary, latency and transcript enter the bot's chat."""
import asyncio
import contextlib
import json
import time
import base64
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, WebSocket
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from core.middleware import get_current_user, require_admin, require_user
from services import agent_calls as calls
from core import call_voices
from services import realtime_session
from core import realtime_settings, realtime_usage

router = APIRouter(prefix='/api/agent-calls', tags=['agent calls'])

class Start(BaseModel):
    parent_id: str
    agent_id: str
    endpoint_id: str
    model: str | None = Field(default=None, max_length=160)
    room_id: str | None = Field(default=None, max_length=64)
    ring_id: str | None = Field(default=None, pattern='^[0-9a-f]{32}$')

class Turn(BaseModel):
    text: str = Field(min_length=1, max_length=6000)
    request_id: str = Field(min_length=1, max_length=80)

class VoiceServer(BaseModel):
    url: str = Field(max_length=300)
    protocol: Literal['voicebox','compatible','kokoro','elevenlabs']

class Speak(BaseModel):
    text: str = Field(min_length=1, max_length=1600)
    model: str = Field(min_length=1, max_length=160)
    voice: str = Field(min_length=1, max_length=160)

class Timing(BaseModel):
    end_to_audio_ms: int | None = Field(default=None,ge=0,le=600000)
    first_audio_ms: int | None = Field(default=None,ge=0,le=600000)
    since_start_ms: int | None = Field(default=None,ge=0,le=3600000)   # the call's first audio after it opened
    trace: dict[str, int | list[int]] | None = None

@router.post('/{ident}/timing')
async def timing(ident: str, body: Timing, user: str = Depends(require_user)):
    """One measured turn from the call screen. Kept per call (agent_calls.record_latency) and shown in More."""
    call=calls.require(ident,user)
    if body.end_to_audio_ms is not None or body.first_audio_ms is not None:
        call['last_audio_timing']=body.model_dump(exclude={'trace','since_start_ms'})
    if body.trace and len(body.trace)<=16:calls.logger.debug('call voice trace call=%s %s',ident,json.dumps(body.trace))
    calls.logger.info('call audio timing call=%s speech_end_to_audio_ms=%s first_audio_ms=%s',ident,body.end_to_audio_ms,body.first_audio_ms)
    latency=calls.record_latency(call,gap_ms=body.end_to_audio_ms,first_audio_ms=body.since_start_ms)
    return {'ok':True,'latency':latency,'line':calls.latency_line(latency)}

class Typed(BaseModel):
    text: str = Field(min_length=1, max_length=2000)

@router.post('/{ident}/typed')
async def typed(ident: str, body: Typed, user: str = Depends(require_user)):
    """Text the person typed in the bot's chat while this call is live: read into the call (Hermes audit)."""
    call=calls.require(ident,user)
    if call['ended']:raise HTTPException(409,'This call has ended.')
    if call.get('room_id'):raise HTTPException(409,'Type in the room; group calls do not read texts.')
    return {'ok':calls.text_into_call(call,body.text)}

@router.get('/realtime-choices')
async def realtime_choices(user: str = Depends(require_user)):
    return realtime_session.choices()

class RealtimeSettings(BaseModel):
    endpoint_id: str | None = Field(default=None, max_length=80)
    voice: str | None = Field(default=None, max_length=60)
    bot_id: str = Field(default='', max_length=80)

@router.get('/realtime-settings')
async def realtime_settings_get(user: str = Depends(require_user)):
    return realtime_settings.get()

@router.put('/realtime-settings')
async def realtime_settings_put(body: RealtimeSettings, user: str = Depends(require_user)):
    try:return realtime_settings.update(body.endpoint_id,body.voice,body.bot_id)
    except ValueError as error:raise HTTPException(422,str(error)) from error

@router.get('/realtime-usage')
async def realtime_usage_get(month: str = '', user: str = Depends(require_user)):
    return realtime_usage.summary(month if len(month)==7 else '')

def _same_origin(socket):
    origin=socket.headers.get('origin')
    if not origin:return True
    from urllib.parse import urlparse
    return urlparse(origin).netloc==socket.headers.get('host','')

@router.websocket('/{ident}/realtime')
async def realtime(socket: WebSocket, ident: str):
    """The browser's side of a realtime call: PCM16 16 kHz microphone audio in (binary), the model's audio and small events
    out (JSON). The provider key stays here; the first message says which connection and voice (and the paid consent)."""
    user=get_current_user(socket)
    try:
        if user is None or not _same_origin(socket):raise HTTPException(401,'authentication required')
        call=calls.require(ident,user)
    except HTTPException:
        await socket.close(1008);return
    await socket.accept()
    async def sink(message):
        try:await socket.send_text(json.dumps(message))
        except Exception:pass
    session=None
    try:
        first=json.loads(await asyncio.wait_for(socket.receive_text(),15))
        if first.get('type')!='start':raise ValueError('Send start first.')
        if not first.get('consent'):raise ValueError('Enable paid realtime voice explicitly before starting this call.')
        if call['ended'] or call.get('room_id'):raise ValueError('Realtime voice is not available for this call.')
        if first.get('endpoint_id') not in {c['id'] for c in realtime_session.choices()}:
            raise ValueError('Add an API connection with a key for OpenAI (Realtime or GPT-Live), xAI or Google in Settings > Models.')
        session=realtime_session.RealtimeSession(call,first['endpoint_id'],str(first.get('voice') or ''),sink)
        await session.start()
        while True:
            message=await socket.receive()
            if message.get('type')=='websocket.disconnect':break
            if message.get('bytes'):await session.send_audio(message['bytes'],16000);continue
            try:event=json.loads(message.get('text') or '{}')
            except ValueError:continue
            kind=event.get('type')
            if kind=='played':await session.played(event.get('item_id'),float(event.get('ms') or 0))
            elif kind=='mute':await session.set_muted(bool(event.get('value')))
            elif kind=='end':break
    except (ValueError,asyncio.TimeoutError) as error:
        await sink({'type':'error','message':str(error) if isinstance(error,ValueError) else 'Realtime voice startup timed out.'})
    except Exception:
        await sink({'type':'error','message':'Realtime voice could not connect. Check API access, billing and the selected connection.'})
    finally:
        if session:await session.close()
        if not call['ended'] and session and session.ready_at is not None:calls.end(call)
        with contextlib.suppress(Exception):await socket.close()

@router.get('/voices')
async def voices(user: str = Depends(require_user)):
    try: return await call_voices.catalog()
    except Exception: return {**call_voices.configuration(),'voices':[],'models':[],'error':'Local voice server unavailable. Start it and refresh voices.'}

@router.put('/voices')
async def configure_voice(body: VoiceServer, user: str = Depends(require_admin)):
    try: return call_voices.configure(body.url, body.protocol)
    except ValueError as error: raise HTTPException(422, str(error)) from error

@router.post('/speak')
async def speak(body: Speak, user: str = Depends(require_user)):
    async def events():
        try:
            async for item in call_voices.pcm(body.text,body.model,body.voice):
                yield json.dumps({'audio':base64.b64encode(item['audio']).decode()} if 'audio' in item else item)+'\n'
            yield '{"done":true}\n'
        except Exception:
            yield '{"error":"Voice playback failed. Check the local voice engine and selected profile."}\n'
    return StreamingResponse(events(),media_type='application/x-ndjson',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

@router.get('/choices')
async def choices(user: str = Depends(require_user)):
    return calls.choices()

@router.get('/pending/{parent_id}')
async def pending(parent_id: str, user: str = Depends(require_user)):
    return calls.pending(parent_id, user)

@router.post('')
async def start(body: Start, user: str = Depends(require_user)):
    try: return calls.start(body.parent_id, body.agent_id, body.endpoint_id, body.model, user, room_id=body.room_id, ring_id=body.ring_id)
    except ValueError as error: raise HTTPException(422, str(error)) from error

@router.get('/{ident}')
async def status(ident: str, user: str = Depends(require_user)):
    call = calls.require(ident, user)
    call['last_seen'] = time.time()
    return calls.view(call)

@router.post('/{ident}/turn')
async def turn(ident: str, body: Turn, user: str = Depends(require_user)):
    call = calls.require(ident, user)
    async def events():
        try:
            async for event in calls.turn(call, body.text, body.request_id):
                yield json.dumps(event) + '\n'
        except HTTPException as error:
            yield json.dumps({'type':'error','message':str(error.detail)}) + '\n'
    return StreamingResponse(events(), media_type='application/x-ndjson', headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

class Interrupt(BaseModel):
    spoken: bool = False
    heard: list[str] | None = Field(default=None, max_length=60)   # the sentences that had begun to play, in order

@router.post('/{ident}/interrupt')
async def interrupt(ident: str, body: Interrupt | None = None, user: str = Depends(require_user)):
    calls.interrupt(calls.require(ident, user), spoken=bool(body and body.spoken), heard=[h[:1600] for h in body.heard] if body and body.heard is not None else None)
    return {'ok':True}

@router.post('/{ident}/prepare')
async def prepare(ident: str, user: str = Depends(require_user)):
    call=calls.require(ident,user)
    if call['ended']:raise HTTPException(409,'Call ended.')
    try:
        started=time.perf_counter();await calls._conversation(call).prepare()
        return {'prepare_ms':round((time.perf_counter()-started)*1000)}
    except Exception:raise HTTPException(422,'The conversation model could not load. Choose an installed model version or check its connection.')

@router.post('/{ident}/end')
async def end(ident: str, user: str = Depends(require_user)):
    return calls.end(calls.require(ident, user))

@router.post('/{ident}/summary')
async def summary(ident: str, user: str = Depends(require_user)):
    call = calls.require(ident, user)
    if not call['ended']: raise HTTPException(409, 'End the call first.')
    calls.schedule_summary(call)
    return calls.view(call)

@router.post('/{ident}/watch')
async def watch(ident: str, user: str = Depends(require_user)):
    call=calls.require(ident,user)
    if call['ended']:raise HTTPException(409,'Call ended.')
    async def events():
        async for event in calls.watch_events(call):yield json.dumps(event)+'\n'
    return StreamingResponse(events(),media_type='application/x-ndjson',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

@router.post('/{ident}/opening')
async def opening(ident: str, user: str = Depends(require_user)):
    call=calls.require(ident,user)
    async def events():
        try:
            async for event in calls.open_with_reason(call):yield json.dumps(event)+'\n'
        except HTTPException as error:yield json.dumps({'type':'error','message':str(error.detail)})+'\n'
    return StreamingResponse(events(),media_type='application/x-ndjson',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

@router.post('/{ident}/work/{task_id}/stop')
async def stop_work(ident: str, task_id: str, user: str = Depends(require_user)):
    return calls.stop_work(calls.require(ident, user), task_id)

@router.post('/{ident}/work/{task_id}/update')
async def work_update(ident: str, task_id: str, user: str = Depends(require_user)):
    call=calls.require(ident,user)
    job=next((job for job in calls.view(call)['jobs'] if job['task_id']==task_id),None)
    if not job:raise HTTPException(404,'Call work not found')
    if call['ended'] or job['status'] in ('ready','running'):raise HTTPException(409,'No completed work update is available.')
    line=calls.work_line(job)
    async def events():
        try:
            source=calls.announce(call,line,'work:'+task_id) if line else calls.turn(call,'Verified work record (data): '+json.dumps(job),'work:'+task_id,work_update=True)
            async for event in source:yield json.dumps(event)+'\n'
        except HTTPException as error:yield json.dumps({'type':'error','message':str(error.detail)})+'\n'
    return StreamingResponse(events(),media_type='application/x-ndjson',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

"""Native calls use their own transcript; only their summary enters chat."""
import json
import time
import base64
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from core.middleware import require_admin, require_user
from services import agent_calls as calls
from core import call_voices
from services import call_live

router = APIRouter(prefix='/api/agent-calls', tags=['agent calls'])

class Start(BaseModel):
    parent_id: str
    agent_id: str
    endpoint_id: str
    model: str | None = Field(default=None, max_length=160)
    room_id: str | None = Field(default=None, max_length=64)

class Turn(BaseModel):
    text: str = Field(min_length=1, max_length=6000)
    request_id: str = Field(min_length=1, max_length=80)

class VoiceServer(BaseModel):
    url: str = Field(max_length=300)
    protocol: Literal['voicestudio','compatible']

class Speak(BaseModel):
    text: str = Field(min_length=1, max_length=1600)
    model: str = Field(min_length=1, max_length=160)
    voice: str = Field(min_length=1, max_length=160)

class Timing(BaseModel):
    end_to_audio_ms: int = Field(ge=0,le=600000)
    first_audio_ms: int = Field(ge=0,le=600000)

@router.post('/{ident}/timing')
async def timing(ident: str, body: Timing, user: str = Depends(require_user)):
    call=calls.require(ident,user)
    call['last_audio_timing']=body.model_dump();calls._save(call)
    calls.logger.info('call audio timing call=%s speech_end_to_audio_ms=%s first_audio_ms=%s',ident,body.end_to_audio_ms,body.first_audio_ms)
    return {'ok':True}

class Live(BaseModel):
    endpoint_id: str
    sdp: str = Field(min_length=1,max_length=60000)
    voice: Literal['marin','cedar','coral','sage','ash'] = 'marin'
    paid_consent: bool = False

@router.get('/live-choices')
async def live_choices(user: str = Depends(require_user)):
    return call_live.choices()

@router.post('/{ident}/live')
async def live(ident: str, body: Live, user: str = Depends(require_user)):
    call=calls.require(ident,user)
    if call['ended']:raise HTTPException(409,'Call ended.')
    try:return await call_live.start(call,body.endpoint_id,body.sdp,body.voice,body.paid_consent)
    except ValueError as error:raise HTTPException(422,str(error)) from error
    except Exception:raise HTTPException(502,'Cloud voice could not connect. Check API access, billing and the selected connection.')

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
    try: return calls.start(body.parent_id, body.agent_id, body.endpoint_id, body.model, user, room_id=body.room_id)
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

@router.post('/{ident}/interrupt')
async def interrupt(ident: str, user: str = Depends(require_user)):
    calls.interrupt(calls.require(ident, user))
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

@router.post('/{ident}/work/{task_id}/stop')
async def stop_work(ident: str, task_id: str, user: str = Depends(require_user)):
    return calls.stop_work(calls.require(ident, user), task_id)

@router.post('/{ident}/work/{task_id}/update')
async def work_update(ident: str, task_id: str, user: str = Depends(require_user)):
    call=calls.require(ident,user)
    job=next((job for job in calls.view(call)['jobs'] if job['task_id']==task_id),None)
    if not job:raise HTTPException(404,'Call work not found')
    if call['ended'] or job['status'] in ('ready','running'):raise HTTPException(409,'No completed work update is available.')
    async def events():
        try:
            async for event in calls.turn(call,'Verified work record (data): '+json.dumps(job),'work:'+task_id,work_update=True):yield json.dumps(event)+'\n'
        except HTTPException as error:yield json.dumps({'type':'error','message':str(error.detail)})+'\n'
    return StreamingResponse(events(),media_type='application/x-ndjson',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

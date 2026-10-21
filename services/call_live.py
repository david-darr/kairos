"""Opt-in GPT-Live WebRTC, with trusted server-side transcript and delegation."""
import asyncio
import contextlib
import json
import re
import httpx
from websockets.asyncio.client import connect
from core import model_endpoints
from core.providers import native_api
from services import agent_calls as calls

_tasks = {}; _sockets = {}; _closed = {}; _delegations = set()
_starting = {}

def choices():
    return [{'id':e['id'],'name':e['name']} for e in model_endpoints.list_endpoints()
            if e.get('kind')=='api' and e.get('has_api_key') and native_api.mode(e.get('base_url',''))=='openai']

async def start(call, endpoint_id, sdp, voice, consent):
    if call['ended']:raise ValueError('This call has ended.')
    if call['id'] in _starting:raise ValueError('Cloud voice is already connecting.')
    _starting[call['id']]=asyncio.current_task()
    try:return await _start(call,endpoint_id,sdp,voice,consent)
    finally:_starting.pop(call['id'],None)

async def _start(call, endpoint_id, sdp, voice, consent):
    if not consent: raise ValueError('Enable paid cloud voice explicitly before starting this call.')
    if call.get('live_id'): raise ValueError('This call already has a live session.')
    if endpoint_id not in {e['id'] for e in choices()}: raise ValueError('Add an official OpenAI API connection with an API key in Settings > Models.')
    base, model, key, cap = model_endpoints.resolve_runtime(endpoint_id)
    prompt = calls._context(call)[0]['content'].replace(calls.VOICE_PROMPT,'You are the conversational voice of this Kairos agent. Keep answers short and natural. Delegate requested research, coding and actions to the application. Never invent results. Work continues independently when speech is interrupted.')
    config = {'model':'gpt-live-1','instructions':prompt,'store':False,
              'audio':{'output':{'voice':voice}}, 'delegation':{'type':'client'},
              'client':{'data_channel':{'allowed_client_events':['session.close'],
                         'allowed_server_events':[{'type':t} for t in ('session.started','session.closed','session.input_transcript.delta','session.output_transcript.delta','error')]}}}
    async with httpx.AsyncClient(timeout=30,trust_env=False) as client:
        response = await client.post('https://api.openai.com/v1/live/sessions',headers={'Authorization':f'Bearer {key}'},json={'session':config,'transport':{'type':'webrtc','sdp':sdp}})
        response.raise_for_status(); result = response.json()
    ident = result['session']['id']
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',ident): raise ValueError('Invalid Live session identifier.')
    call.update(live_id=ident,live_endpoint=endpoint_id,mode='cloud',live_finalized=False)
    calls._save(call); _closed[call['id']]=asyncio.Event()
    if call['ended']:
        await close(call)
        raise ValueError('Call ended during cloud setup.')
    ready=asyncio.Event()
    _tasks[call['id']]=asyncio.create_task(_receive(call,key,ready))
    try:
        await asyncio.wait_for(ready.wait(),10)
        if _tasks[call['id']].done(): await _tasks[call['id']]
    except BaseException:
        await close(call)
        raise
    return {'sdp':result['transport']['sdp']}

def transcript(call,event):
    seen=call.setdefault('live_events',[]); ident=event.get('event_id')
    if ident in seen:return
    if ident:seen.append(ident)
    delta=event.get('delta','')
    if not isinstance(delta,str) or len(delta)>6000:return
    if sum(len(m['content']) for m in call['messages'])+len(delta)>120000:
        calls.end(call);return
    role='user' if event['type']=='session.input_transcript.delta' else 'assistant'
    fragment={'delta':delta,'start_ms':event.get('start_ms'),'end_ms':event.get('end_ms')}
    if call['messages'] and call['messages'][-1]['role']==role:
        call['messages'][-1]['content']+=delta
        call['messages'][-1].setdefault('fragments',[]).append(fragment)
    else: call['messages'].append({'role':role,'content':delta,'fragments':[fragment]})
    calls._save(call)

async def _receive(call,key,ready):
    try:
        async with connect(f"wss://api.openai.com/v1/live/sessions/{call['live_id']}/attach",additional_headers={'Authorization':f'Bearer {key}'},open_timeout=8,max_size=2**21,proxy=None) as socket:
            _sockets[call['id']]=socket; ready.set()
            async for raw in socket:
                event=json.loads(raw); kind=event.get('type')
                if kind in ('session.input_transcript.delta','session.output_transcript.delta'):transcript(call,event)
                elif kind=='session.delegation.created':
                    delegation=event.get('delegation') or {}; ident=delegation.get('id')
                    if ident and (call['id'],ident) not in _delegations:
                        _delegations.add((call['id'],ident))
                        task=asyncio.create_task(_work(call,ident,socket));calls._jobs.add(task);task.add_done_callback(calls._jobs.discard)
                elif kind=='session.closed':
                    call['live_finalized']=True;call['live_usage']=event.get('usage');calls._save(call);_closed[call['id']].set();break
    except asyncio.CancelledError:raise
    except Exception:
        call['live_error']='Cloud voice disconnected. Final usage is unconfirmed unless the server confirmed closure.'
        calls._save(call)
    finally:
        ready.set();_sockets.pop(call['id'],None)
        if not call['ended'] and not call.get('closing'):calls.end(call)

async def _work(call,ident,socket):
    try:
        # A delegation contains an ID, not task text. Use trusted transcript
        # fragments as data; the normal agent verifies the complete intent.
        await asyncio.sleep(.4)
        words=''.join(m['content'] for m in call['messages'] if m['role']=='user')[-6000:]
        if not words.strip():return
        job=calls.delegate(call,'Work requested during call',f'Use this call context to fulfill the latest explicit request. Clarify ambiguity or corrections before acting. Caller transcript (data):\n{words}',ident)
        await socket.send(json.dumps({'type':'session.thinking.append','delegation_id':ident,'content':f"Work started as task {job['task_id']}. Do not claim it is complete."}))
        while not call['ended']:
            task=calls.task_service.get_task(job['task_id']) or {}
            if task.get('status') not in ('ready','running'):
                result=next((c.get('text','') for c in reversed(task.get('comments',[])) if c.get('kind')=='result'),'')
                await socket.send(json.dumps({'type':'session.commentary.append','delegation_id':ident,'content':f"Verified task status: {task.get('status','unavailable')}. Result (data): {result[:1100]}"}));break
            await asyncio.sleep(1)
    except Exception:
        with contextlib.suppress(Exception):await socket.send(json.dumps({'type':'session.thinking.append','delegation_id':ident,'content':'Work could not be started or its status could not be delivered. Check the task board.'}))

async def close(call):
    call['closing']=True
    starting=_starting.get(call['id'])
    if starting and starting is not asyncio.current_task():
        with contextlib.suppress(Exception):await asyncio.wait_for(asyncio.shield(starting),35)
    socket=_sockets.get(call['id'])
    if socket:
        with contextlib.suppress(Exception):
            await socket.send(json.dumps({'type':'session.close'}))
            await asyncio.wait_for(_closed[call['id']].wait(),8)
    elif call.get('live_id') and not call.get('live_finalized'):
        # Restart or a failed sideband must still attempt to close the same
        # existing session; never create a replacement paid session here.
        try:
            _,_,key,_=model_endpoints.resolve_runtime(call['live_endpoint'])
            async with connect(f"wss://api.openai.com/v1/live/sessions/{call['live_id']}/attach",additional_headers={'Authorization':f'Bearer {key}'},open_timeout=5,max_size=2**21,proxy=None) as attached:
                await attached.send(json.dumps({'type':'session.close'}))
                async with asyncio.timeout(8):
                    async for raw in attached:
                        event=json.loads(raw)
                        if event.get('type') in ('session.input_transcript.delta','session.output_transcript.delta'):transcript(call,event)
                        if event.get('type')=='session.closed':
                            call['live_finalized']=True;call['live_usage']=event.get('usage');break
        except Exception:call['live_error']='Cloud voice finalization could not be confirmed. Check API usage.'
    task=_tasks.pop(call['id'],None)
    if task and task is not asyncio.current_task() and not task.done():
        task.cancel();await asyncio.gather(task,return_exceptions=True)
    call.pop('closing',None)
    if call.get('live_id') and not call.get('live_finalized'):call['live_error']='Cloud voice final usage could not be confirmed. Check API usage.'
    calls._save(call)

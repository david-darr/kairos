"""Call isolation, streaming, recovery, delegation and opt-in provider contracts."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch, AsyncMock

DATA=tempfile.TemporaryDirectory(prefix='kairos-dialogue-',ignore_cleanup_errors=True)
os.environ['JARVIS_DATA_DIR']=DATA.name
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException
import httpx
from core.session_manager import session_manager
from core.voice_dialogue import SpeechFilter, Conversation
from core import call_voices
from core.middleware import require_admin
from services import agent_calls as calls, call_live
from services.agent_service import agent_service
from routes.call_routes import router

class FakeConversation:
    instances=[]
    def __init__(self,*args):self.closed=False;self.fail=False;self.gate=None;self.instances.append(self)
    async def close(self):self.closed=True
    async def stream(self,messages,max_tokens=320):
        if self.fail:raise ValueError('engine unavailable')
        if max_tokens!=320:yield 'Decided to build a parkour course. Work is still pending.';return
        yield 'I can help. '
        if self.gate:await self.gate.wait()
        yield 'Tell me more.'

class Calls(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        calls._calls.clear();calls._locks.clear();calls._turns.clear();calls._summaries.clear();calls._conversations.clear()
        self.temp=tempfile.TemporaryDirectory();self.root=patch.object(calls,'ROOT',Path(self.temp.name));self.root.start()
        self.model=patch.object(calls,'Conversation',FakeConversation);self.model.start()
        self.agent=agent_service.create('Call '+uuid.uuid4().hex[:12],endpoint_id=None)
        self.parent=session_manager.create_session(owner_user='david')['id']
        # Agent chats use their agent identity in the ordinary session record.
        from core import session_manager_store as store
        value=session_manager.get_session(self.parent);value['agent_id']=self.agent['id'];value['model_endpoint_id']='strong';store.save_session(value)
        session_manager.append_message(self.parent,'user','A typed message stays.')
        self.call=calls._calls.get('') or None
        self.call=calls.start(self.parent,self.agent['id'],'fast','small','david')
        self.record=calls.require(self.call['id'],'david')

    async def asyncTearDown(self):
        for task in list(calls._summaries.values())+list(calls._turns.values()):
            if task is not asyncio.current_task() and not task.done():task.cancel()
        await asyncio.gather(*calls._summaries.values(),return_exceptions=True)
        for c in calls._conversations.values():await c.close()
        self.root.stop();self.model.stop();self.temp.cleanup()

    async def test_stream_starts_before_completion_and_keeps_dialogue_out_of_chat(self):
        engine=calls._conversations[self.record['id']];engine.gate=asyncio.Event()
        stream=calls.turn(self.record,'Hello there','one')
        first=await anext(stream)
        self.assertEqual(first['delta'],'I can help. ')
        self.assertEqual([m['content'] for m in session_manager.get_session(self.parent)['messages']],['A typed message stays.'])
        engine.gate.set();events=[item async for item in stream]
        self.assertEqual(events[-1]['type'],'done')
        self.assertEqual(len(self.record['messages']),2)

    async def test_short_call_summary_is_one_card_preserves_typed_messages(self):
        _=[e async for e in calls.turn(self.record,'Build a parkour course','one')]
        session_manager.append_message(self.parent,'user','Another typed message.')
        self.record['ended']=True
        await calls.finalize(self.record)
        self.assertEqual(self.record['summary_state'],'saved')
        self.assertEqual(self.record['messages'],[])
        calls.end(self.record);await asyncio.sleep(0)
        notes=session_manager.get_session(self.parent)['messages']
        self.assertEqual(len(notes),3)
        self.assertEqual(notes[0]['content'],'A typed message stays.')
        self.assertEqual(notes[1]['content'],'Another typed message.')
        self.assertEqual(notes[2]['call_summary_id'],self.record['id'])

    async def test_summary_failure_can_retry_without_raw_chat_leak(self):
        _=[e async for e in calls.turn(self.record,'Build a course','one')]
        calls._conversations[self.record['id']].fail=True;self.record['ended']=True
        await calls.finalize(self.record)
        self.assertEqual(self.record['summary_state'],'failed');self.assertTrue(self.record['messages'])
        self.assertEqual(len(session_manager.get_session(self.parent)['messages']),1)
        self.assertEqual(calls.pending(self.parent,'david')[0]['id'],self.record['id'])
        await calls.finalize(self.record)
        self.assertEqual(self.record['summary_state'],'saved')

    async def test_summary_upsert_updates_only_its_card(self):
        session_manager.upsert_call_summary(self.parent,self.record['id'],'First')
        session_manager.append_message(self.parent,'assistant','Typed answer')
        session_manager.upsert_call_summary(self.parent,self.record['id'],'Updated')
        notes=session_manager.get_session(self.parent)['messages']
        self.assertEqual([m['content'] for m in notes],['A typed message stays.','Updated','Typed answer'])

    async def test_duplicate_turn_is_replayed_without_model_or_duplicate_messages(self):
        first=[e async for e in calls.turn(self.record,'Hello','id')]
        second=[e async for e in calls.turn(self.record,'Hello','id')]
        self.assertTrue(second[0]['replayed']);self.assertEqual(len(self.record['messages']),2)
        with self.assertRaises(HTTPException):_=[e async for e in calls.turn(self.record,'Different','id')]

    async def test_owner_and_path_checks(self):
        with self.assertRaises(HTTPException):calls.require(self.record['id'],'other')
        with self.assertRaises(HTTPException):calls.require('../../outside','david')
        with self.assertRaises(HTTPException):calls.stop_work(self.record,'someone-elses-task')

    async def test_delegation_reuses_strong_agent_and_existing_task_scheduler(self):
        future=asyncio.create_task(asyncio.sleep(0))
        with patch.object(calls.task_service,'create_task',return_value={'id':'task-one'}) as create,patch.object(calls.task_scheduler,'start_in_background',return_value=future) as run:
            job=calls.delegate(self.record,'Build course','Build the requested course','turn-one')
            self.assertEqual(calls.delegate(self.record,'Build again','duplicate','turn-one'),job)
            self.assertEqual(create.call_count,1);self.assertEqual(run.call_count,1)
            self.assertEqual(create.call_args.kwargs['endpoint_id'],'strong')
            self.assertEqual(create.call_args.kwargs['agent_id'],self.agent['id'])
            self.assertNotIn('deliver_to_channel',create.call_args.kwargs)
            calls.interrupt(self.record);self.assertFalse(future.cancelled(),'Speech interruption leaves work alone')
        await future

    async def test_interrupted_reply_is_recorded_as_interrupted(self):
        engine=calls._conversations[self.record['id']];engine.gate=asyncio.Event()
        first=asyncio.Event()
        async def consume():
            async for event in calls.turn(self.record,'Hello','one'):first.set()
        task=asyncio.create_task(consume());await first.wait();calls.interrupt(self.record)
        await asyncio.gather(task,return_exceptions=True)
        self.assertTrue(self.record['messages'][-1]['interrupted'])

    async def test_stop_work_cancels_a_starter_before_worker_admission(self):
        future=asyncio.create_task(asyncio.Event().wait())
        with patch.object(calls.task_service,'create_task',return_value={'id':'queued'}),patch.object(calls.task_scheduler,'start_in_background',return_value=future),patch.object(calls.task_scheduler,'stop_run',return_value=False),patch.object(calls.task_service,'get_task',return_value={'status':'ready'}),patch.object(calls.task_service,'set_card_status') as status:
            calls.delegate(self.record,'Queued work','Do requested work','queued')
            calls.stop_work(self.record,'queued');await asyncio.gather(future,return_exceptions=True)
            self.assertTrue(future.cancelled());status.assert_called_once_with('queued','backlog',note='Stopped from voice call')

    async def test_live_requires_explicit_paid_consent_and_official_key(self):
        with self.assertRaisesRegex(ValueError,'explicitly'):await call_live.start(self.record,'x','sdp','marin',False)
        with patch.object(call_live,'choices',return_value=[]),self.assertRaisesRegex(ValueError,'API key'):await call_live.start(self.record,'x','sdp','marin',True)
        self.assertNotIn('live_id',self.record)

    async def test_live_transcript_preserves_fragments_times_and_deduplicates(self):
        event={'type':'session.input_transcript.delta','event_id':'a','delta':'Build a','start_ms':10,'end_ms':30}
        call_live.transcript(self.record,event);call_live.transcript(self.record,event)
        call_live.transcript(self.record,{**event,'event_id':'b','delta':' course.','start_ms':31,'end_ms':70})
        self.assertEqual(''.join(m['content'] for m in self.record['messages']),'Build a course.')
        self.assertEqual(self.record['messages'][0]['fragments'][1]['start_ms'],31)
        self.assertEqual(len(session_manager.get_session(self.parent)['messages']),1)

    async def test_live_webrtc_key_stays_server_side_and_close_drains_final_events(self):
        sent=[];requests=[];events=asyncio.Queue()
        class Socket:
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            def __aiter__(self):return self
            async def __anext__(self):return await events.get()
            async def send(self,value):
                sent.append(json.loads(value))
                if sent[-1]['type']=='session.close':await events.put(json.dumps({'type':'session.closed','usage':{'seconds':4}}))
        def request(value):requests.append(value);return httpx.Response(201,json={'session':{'id':'live_fake'},'transport':{'type':'webrtc','sdp':'answer'}})
        client=httpx.AsyncClient(transport=httpx.MockTransport(request))
        with patch.object(call_live,'choices',return_value=[{'id':'official'}]),patch.object(call_live.model_endpoints,'resolve_runtime',return_value=('https://api.openai.com/v1','summary','fake-secret',4096)),patch.object(call_live.httpx,'AsyncClient',return_value=client),patch.object(call_live,'connect',return_value=Socket()):
            answer=await call_live.start(self.record,'official','offer','marin',True)
            self.assertEqual(answer,{'sdp':'answer'});self.assertNotIn('fake-secret',json.dumps(answer))
            config=json.loads(requests[0].content)['session'];self.assertEqual(config['delegation'],{'type':'client'})
            self.assertEqual(config['client']['data_channel']['allowed_client_events'],['session.close']);self.assertFalse(config['store'])
            self.record['ended']=True;await call_live.close(self.record)
        self.assertTrue(self.record['live_finalized']);self.assertEqual(self.record['live_usage'],{'seconds':4})

    async def test_finished_work_update_does_not_fabricate_a_user_message(self):
        _=[event async for event in calls.turn(self.record,'Verified work result: task is done.','work-one',work_update=True)]
        self.assertEqual([m['role'] for m in self.record['messages']],['assistant'])
        self.assertEqual(len(session_manager.get_session(self.parent)['messages']),1)

    async def test_restart_recovers_active_call_as_summary(self):
        _=[event async for event in calls.turn(self.record,'Build a course','one')]
        calls._calls.clear();await calls.recover()
        recovered=calls._calls[self.record['id']]
        await calls._summaries[self.record['id']]
        self.assertTrue(recovered['ended']);self.assertEqual(recovered['summary_state'],'saved')
        calls._watchdog.cancel();await asyncio.gather(calls._watchdog,return_exceptions=True)

    async def test_long_summary_reduces_all_chunks_without_truncating_middle(self):
        class Summary(FakeConversation):
            async def stream(self,messages,max_tokens=320):
                text=messages[-1]['content']
                yield '|'.join(word for word in ['FIRST','MIDDLE','LAST'] if word in text)
        self.record['messages']=[{'role':'user','content':'FIRST '+'a'*6500+' MIDDLE '+'b'*6500+' LAST'}];self.record['ended']=True
        calls._conversations[self.record['id']]=Summary()
        await calls.finalize(self.record)
        self.assertEqual(self.record['summary_state'],'saved')
        for fact in ('FIRST','MIDDLE','LAST'):self.assertIn(fact,self.record['summary'])

    async def test_http_access_admin_bounds_and_summary_rules(self):
        app=FastAPI();app.include_router(router);app.dependency_overrides[require_admin]=lambda:'david'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            base=f"/api/agent-calls/{self.record['id']}"
            self.assertEqual((await client.post(base+'/summary')).status_code,409)
            self.assertEqual((await client.post(base+'/turn',json={'text':'x'*6001,'request_id':'one'})).status_code,422)
            response=await client.post(base+'/turn',json={'text':'Hi','request_id':'one'})
            self.assertEqual(response.status_code,200);self.assertIn('"type": "text"',response.text)
            app.dependency_overrides[require_admin]=lambda:'other'
            self.assertEqual((await client.get(base)).status_code,404)
            def denied():raise HTTPException(403,'Admin required')
            app.dependency_overrides[require_admin]=denied
            self.assertEqual((await client.post('/api/agent-calls/speak',json={'text':'Hi','model':'pockettts','voice':'default'})).status_code,403)

class Contracts(unittest.TestCase):
    def test_work_marker_never_reaches_speech_at_any_chunk_boundary(self):
        source='I will check. <kairos-work>{"title":"Research","request":"Find the documentation"}</kairos-work>'
        for split in range(len(source)+1):
            f=SpeechFilter();spoken=f.feed(source[:split])+f.feed(source[split:])+f.finish()
            self.assertEqual(spoken,'I will check. ');self.assertEqual(f.work()['title'],'Research')
        f=SpeechFilter();self.assertEqual(f.feed('Hello <kairos-')+f.finish(),'Hello ');self.assertIsNone(f.work())

    def test_voice_server_rejects_remote_hosts_credentials_paths_and_missing_port(self):
        for url in ['https://evil.example:8000','http://127.0.0.1:8000/admin','http://user:password@localhost:80','http://localhost','file:///tmp/voice']:
            with self.subTest(url=url),self.assertRaises(ValueError):call_voices.validate_url(url)
        self.assertEqual(call_voices.validate_url('http://127.0.0.1:8880/'),'http://127.0.0.1:8880')

class ProviderContracts(unittest.IsolatedAsyncioTestCase):
    async def test_ollama_streams_without_thinking_and_keeps_context_capped(self):
        from core import model_endpoints
        release=asyncio.Event();requests=[]
        class Bytes(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"message":{"content":"Hello. "}}\n'
                await release.wait()
                yield b'{"message":{"content":"More."},"done":true,"prompt_eval_count":8,"eval_count":3}\n'
        def handler(request):requests.append(json.loads(request.content));return httpx.Response(200,stream=Bytes())
        with patch.object(model_endpoints,'get_endpoint',return_value={'kind':'local'}),patch.object(model_endpoints,'resolve_runtime',return_value=('http://localhost:11434/v1','llama3.2',None,16384)):
            conversation=Conversation('test');await conversation.client.aclose();conversation.client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
            try:
                stream=conversation.stream([{'role':'user','content':'Hi'}]);self.assertEqual(await anext(stream),'Hello. ')
                self.assertFalse(release.is_set());release.set();self.assertEqual([s async for s in stream],['More.'])
                self.assertFalse(requests[0]['think']);self.assertEqual(requests[0]['options']['num_ctx'],4096)
            finally:await conversation.close()

    async def test_local_prepare_loads_only_selected_model_without_dialogue_or_downloads(self):
        from core import model_endpoints
        requests=[]
        def handler(request):requests.append(request);return httpx.Response(200,json={'done':True,'done_reason':'load'})
        with patch.object(model_endpoints,'get_endpoint',return_value={'kind':'local'}),patch.object(model_endpoints,'resolve_runtime',return_value=('http://localhost:11434/v1','llama3.2',None,16384)):
            conversation=Conversation('test');await conversation.client.aclose();conversation.client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
            try:
                await conversation.prepare();body=json.loads(requests[0].content)
                self.assertEqual(body['messages'],[]);self.assertEqual(body['model'],'llama3.2');self.assertEqual(body['options']['num_ctx'],4096)
                self.assertTrue(str(requests[0].url).endswith('/api/chat'));self.assertNotIn('pull',str(requests[0].url))
                conversation.local=False;await conversation.prepare();self.assertEqual(len(requests),1,'No paid provider warm-up request')
            finally:await conversation.close()

    async def test_official_openai_uses_native_stream_and_does_not_store(self):
        from core import model_endpoints
        requests=[]
        def handler(request):
            requests.append(request)
            return httpx.Response(200,text='data: {"type":"response.output_text.delta","delta":"Hi."}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}\n\n')
        with patch.object(model_endpoints,'get_endpoint',return_value={'kind':'api'}),patch.object(model_endpoints,'resolve_runtime',return_value=('https://api.openai.com/v1','gpt-test','fake-secret',4096)):
            conversation=Conversation('test');await conversation.client.aclose();conversation.client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
            try:
                self.assertEqual(''.join([s async for s in conversation.stream([{'role':'user','content':'Hi'}])]),'Hi.')
                body=json.loads(requests[0].content);self.assertFalse(body['store']);self.assertTrue(body['stream']);self.assertNotIn('tools',body)
                self.assertEqual(str(requests[0].url),'https://api.openai.com/v1/responses')
            finally:await conversation.close()

    async def test_voicestudio_stream_uses_real_sample_rate_and_default_not_alias(self):
        sent=[]
        class Socket:
            values=iter([json.dumps({'type':'start','sample_rate':48000,'channels':1,'format':'pcm16'}),b'\x00\x00\x01\x00',json.dumps({'type':'done'})])
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def send(self,data):sent.append(json.loads(data))
            async def recv(self):return next(self.values)
        with patch.object(call_voices,'configuration',return_value={'url':'http://127.0.0.1:8000','protocol':'voicestudio'}),patch.object(call_voices,'connect',return_value=Socket()):
            events=[s async for s in call_voices.pcm('Hello','pockettts','default')]
        self.assertEqual(events,[{'sample_rate':48000},{'audio':b'\x00\x00\x01\x00'}]);self.assertIsNone(sent[0]['voice']);self.assertEqual(sent[0]['engine'],'pockettts')

    async def test_voicestudio_rejects_invalid_audio_metadata(self):
        class Socket:
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def send(self,data):pass
            async def recv(self):return json.dumps({'type':'start','sample_rate':999999,'channels':2,'format':'pcm16'})
        with patch.object(call_voices,'configuration',return_value={'url':'http://127.0.0.1:8000','protocol':'voicestudio'}),patch.object(call_voices,'connect',return_value=Socket()),self.assertRaises(ValueError):
            _=[s async for s in call_voices.pcm('Hello','pockettts','default')]

    async def test_catalog_filters_unavailable_engines_and_fake_alias_voices(self):
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'data':[{'id':'tts-1'}]} if request.url.path.endswith('/models') else {'voices':[{'id':'alloy','type':'openai_alias'},{'id':'profile','name':'My voice','type':'profile'}],'engines':[{'id':'pockettts','available':True},{'id':'omnivoice','available':False}]})))
        with patch.object(call_voices,'configuration',return_value={'url':'http://127.0.0.1:8000','protocol':'voicestudio'}),patch.object(call_voices.httpx,'AsyncClient',return_value=client):result=await call_voices.catalog()
        self.assertEqual(result['models'],['pockettts']);self.assertEqual([v['id'] for v in result['voices']],['default','profile'])

if __name__=='__main__':unittest.main()

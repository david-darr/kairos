// Calls through Bots (migrated from the Agents call check, Phase 1; flag --agents-call-only). The call dialog,
// microphone, recognition, voices and summaries are the existing call behaviour, now reached from the Bots conversation
// composer. Paid-call consent and the summary-only transcript assertions are kept: raw call dialogue never enters the
// bot's conversation transport (/api/bot-chat), only the saved summary appears in the conversation. The "first chat
// creation" race of the old check became the same race on the call record's creation, because a Bots conversation
// already exists when a call starts. The check makes its own bot and conversation and restores everything in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
module.exports = async ({js,waitFor,delay,navigate,win,capture,writes,demoState,liveChange,base}) => {
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined });
  const callApi = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.json())`);
  let BOT = '', SID = '';
  const openBot = () => navigate('agents',{agentId:BOT,sessionId:SID});
  try {
  demoState.botsLive = true;
  await win.loadURL(base);
  await waitFor("!!document.querySelector('.dashboard-core')");
  await js("fetch('/api/agents').then(r => r.json()).then(() => true)");
  BOT = (await callApi('/api/agents', 'POST', { name: `Call Probe ${Date.now() % 100000}` })).id;
  SID = (await callApi(`/api/agents/${BOT}/threads`, 'POST', { title: 'Main' })).id;
  require('./fixtures/bots-chat-backend.cjs').latest.root();
  await openBot();
  await waitFor("!!document.querySelector('.agent-call-open') && !!document.querySelector('.bots-composer-input')");
  await js(`window.__callBot = ${JSON.stringify(BOT)}; window.__callSid = ${JSON.stringify(SID)}; true`);
  await js(String.raw`(async()=>{
    window.__callTest={level:0,opened:0,closed:0,played:0,calls:{},callTurns:[],workUpdates:[],callEnds:[],callStops:[],callStopBodies:[],partialRequests:[],callCounter:0,paused:0,urls:[],transcripts:0,wavBodies:[],fetch:window.fetch,utterance:window.SpeechSynthesisUtterance,synthesis:Object.getOwnPropertyDescriptor(window,'speechSynthesis'),getUserMedia:navigator.mediaDevices.getUserMedia};
    const ctx=window.__callTest.inputContext=new AudioContext({sampleRate:16000});
    const source=ctx.createOscillator();source.frequency.value=180;
    const gain=window.__callTest.gain=ctx.createGain();gain.gain.value=0;
    const destination=window.__callTest.destination=ctx.createMediaStreamDestination();source.connect(gain);gain.connect(destination);source.start();await ctx.resume();
    Object.defineProperty(window.__callTest,'level',{configurable:true,get:()=>window.__callTest._level||0,set:value=>{window.__callTest._level=value;gain.gain.setValueAtTime(value*.08,ctx.currentTime)}});
    navigator.mediaDevices.getUserMedia=async()=>{window.__callTest.opened++;const stream=destination.stream.clone();for(const track of stream.getTracks()){const stop=track.stop.bind(track);let stopped=false;track.stop=()=>{if(!stopped){stopped=true;window.__callTest.closed++;stop()}}}return stream;};
    window.SpeechSynthesisUtterance=class extends EventTarget {constructor(text){super();this.text=text}};
    Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{pending:false,speaking:false,getVoices:()=>[{name:'Kairos Device Voice',lang:'en-GB',localService:true},{name:'Remote Voice',lang:'en-US',localService:false}],addEventListener(){},
      speak(utterance){window.__callTest.played++;this.pending=true;this.speaking=true;window.__callTest.current=utterance;queueMicrotask(()=>utterance.dispatchEvent(new Event('start')))},
      cancel(){window.__callTest.paused++;this.pending=false;this.speaking=false;window.__callTest.current?.dispatchEvent(new Event('error'))}}});
    window.fetch=async (url,options)=>{
      window.__callTest.urls.push(String(url));
      const t=window.__callTest, path=String(url), json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
      if(path==='/api/agent-calls/choices')return json([{id:'fast',name:'Fast conversation',kind:'local',model:'llama3.2'}]);
      if(path==='/api/agent-calls/realtime-choices')return json([]);
      if(path==='/api/agent-calls/voices')return json({url:'',protocol:'voicestudio',models:[],voices:[]});
      if(path.startsWith('/api/agent-calls/pending/'))return json([]);
      if(path==='/api/agent-calls') {
        const make=()=>{const id=String(++t.callCounter).padStart(32,'0');const value={id,parent_id:JSON.parse(options.body).parent_id,ended:false,summary_state:'open',jobs:[]};t.calls[id]=value;return json(value);};
        if(t.holdCreation){t.creationPending=true;return new Promise(resolve=>t.releaseCreation=()=>resolve(make()));}
        return make();
      }
      const match=path.match(/^\/api\/agent-calls\/([0-9]+)(?:\/(.*))?$/);
      if(match){const call=t.calls[match[1]], action=match[2];
        if(!action)return json(call);
        if(action==='prepare'||action==='timing')return json({ok:true,prepare_ms:12});
        if(action==='end'){t.callEnds.push(call.id);call.ended=true;call.summary_state='saved';call.summary='**Call summary**\n\nDiscussed the new layout.';return json(call);}
        if(action==='interrupt'){t.callStops.push(call.id);t.callStopBodies.push(options&&options.body||'');t.releaseReply?.();return json({ok:true});}
        if(action==='watch')return new Response(new ReadableStream({start(c){t.pushEvent=e=>c.enqueue(new TextEncoder().encode(JSON.stringify(e)+'\n'));options.signal?.addEventListener('abort',()=>{try{c.close()}catch{}});}}),{headers:{'Content-Type':'application/x-ndjson'}});
        if(action&&action.startsWith('work/')&&action.endsWith('/update')){t.workUpdates.push(action);return new Response(new TextEncoder().encode(JSON.stringify({type:'text',delta:"That's done: Parkour course. Built the course.",templated:true})+'\n'+JSON.stringify({type:'done',reply_ms:0})+'\n'),{headers:{'Content-Type':'application/x-ndjson'}});}
        if(action==='turn'){
          t.turnAt=performance.now();t.callTurns.push(JSON.parse(options.body));
          return new Response(new ReadableStream({start(c){
            const emit=e=>c.enqueue(new TextEncoder().encode(JSON.stringify(e)+'\n'));
            emit({type:'text',delta:'First useful sentence. ',first_output_ms:22});
            const finish=()=>{if(options.signal?.aborted){c.close();return;}emit({type:'text',delta:'The rest of the reply.'});emit({type:'done',reply_ms:150,first_output_ms:22});c.close();};
            if(t.holdReply)t.releaseReply=finish;else setTimeout(finish,100);
          }}),{headers:{'Content-Type':'application/x-ndjson'}});
        }
      }

      if(String(url)==='/api/speech/status') return new Response(JSON.stringify({engine_available:true,active_model:window.__callTest.missingModel?null:'base.en',call_model:'small.en',acceleration:{supported:true,configured:false},models:[{name:'base.en',label:'Base',size_mb:142,downloaded:!window.__callTest.missingModel},{name:'small.en',label:'Small',size_mb:466,downloaded:!window.__callTest.missingModel}]}),{headers:{'Content-Type':'application/json'}});
      if(String(url)==='/api/speech/prepare') {window.__callTest.prepared=JSON.parse(options.body).model;return new Response(JSON.stringify({model:window.__callTest.prepared,engine:window.__callTest.engine||'cpu',prepare_ms:12}),{headers:{'Content-Type':'application/json'}});}
      if(String(url)==='/api/speech/partial') {
        // Rolling transcription: 'busy' (the default, a recognizer that skips) leaves every older flow exactly as it was.
        const t=window.__callTest, mode=t.partialMode||'busy', bytes=new Uint8Array(await options.body.get('audio').arrayBuffer());
        t.partialRequests.push({ms:Math.round((bytes.length-44)/32),model:options.body.get('model'),backend:options.body.get('backend')});
        if(mode==='fail')return new Response('{}',{status:500});
        if(mode==='busy')return json({busy:true,text:''});
        return json({text:t.partialText,segments:[{text:t.partialText,end_ms:Math.round((bytes.length-44)/32)}],engine:'cuda',timings:{recognition_ms:20,queue_ms:0}});
      }
      if(String(url).endsWith('/progress')&&String(url).startsWith('/api/speech/models/')) {window.__callTest.missingModel=false;return new Response(JSON.stringify({done:true}),{headers:{'Content-Type':'application/json'}});}
      if(String(url)==='/api/speech/transcribe') {
        const bytes=new Uint8Array(await options.body.get('audio').arrayBuffer());window.__callTest.wavHeader=String.fromCharCode(...bytes.slice(0,4));window.__callTest.wavRate=new DataView(bytes.buffer).getUint32(24,true);window.__callTest.transcribedModel=options.body.get('model');window.__callTest.wavBodies.push(Array.from(bytes));window.__callTest.transcripts++;
        const recognized=window.__callTest.nextText||'Please explain the new layout.';
        if(window.__callTest.holdTranscription)await new Promise(resolve=>window.__callTest.releaseTranscription=resolve);
        window.__callTest.transcriptAt=performance.now();
        return new Response(JSON.stringify({text:recognized,timings:{recognition_ms:14,queue_ms:0}}),{headers:{'Content-Type':'application/json'}});
      }
      if(path.startsWith('/api/bot-chat/')&&path.includes('/messages')&&(!options||!options.method||options.method==='GET')&&!/[?&](before|around)=/.test(path)){
        const response=await t.fetch.call(window,url,options), data=await response.json();
        if(Array.isArray(data.messages))for(const call of Object.values(t.calls))if(call.ended&&path.startsWith('/api/bot-chat/'+call.parent_id+'/messages'))data.messages.push({id:'call-summary-'+call.id,role:'assistant',content:call.summary,call_summary_id:call.id,ts:Date.now()/1000,attachments:[],citations:[]});
        return json(data);
      }
      return window.__callTest.fetch.call(window,url,options);
    };
    localStorage.setItem('kairos:call-conversation:'+window.__callBot,JSON.stringify({endpoint:'fast',model:'llama3.2'}));
    const input=document.querySelector('.bots-composer-input');input.value='My typed draft stays';input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await click('.agent-call-open'); await waitFor("document.querySelector('.agent-call').open");
  await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");
  assert.equal(await js("document.querySelector('[aria-label=\"Speech recognition model\"]').value"),'small.en','Calls start with the Voice-line accuracy model');
  // Dropdowns in the modal call dialog open above it, inside the viewport, and can be picked.
  for (const label of ['Call mode','Conversation model connection','Speech recognition model','Call input mode','Speech acceleration']) {
    const opened = await js(`(()=>{const s=document.querySelector('.agent-call [aria-label="${label}"]');s.scrollIntoView({block:'center'});s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));const m=document.querySelector('.custom-select-menu');if(!m)return 'no menu';const r=m.getBoundingClientRect(),i=m.querySelector('.custom-select-item');if(!i)return 'no items';const q=i.getBoundingClientRect(),h=document.elementFromPoint(q.left+q.width/2,q.top+q.height/2);return [m.closest('dialog')===document.querySelector('.agent-call'),i.contains(h),r.top>=0&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth].join()})()`);
    assert.equal(opened,'true,true,true',`${label} menu opens above the call dialog, inside the viewport (${opened})`);
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    assert.ok(await js("!document.querySelector('.custom-select-menu') && document.querySelector('.agent-call').open"),`${label} menu closes on Escape and leaves the call dialog open`);
  }
  await js(`(()=>{const s=document.querySelector('.agent-call [aria-label="Call input mode"]');s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));[...document.querySelectorAll('.custom-select-item')].find(b=>b.textContent.startsWith('Hold')).click()})()`);
  assert.equal(await js("document.querySelector('.agent-call [aria-label=\"Call input mode\"]').value"),'hold','Picking from a call dropdown changes the select');
  await js("(()=>{const s=document.querySelector('.agent-call [aria-label=\"Call input mode\"]');s.value='automatic';s.dispatchEvent(new Event('change'))})()");
  await js("document.querySelector('[aria-label=\"Speech recognition model\"]').value='small.en';document.querySelector('[aria-label=\"Speech recognition model\"]').dispatchEvent(new Event('change'))");
  await capture('agents-call-setup');
  await js("document.querySelector('[aria-label=\"Call mode\"]').value='realtime';document.querySelector('[aria-label=\"Call mode\"]').dispatchEvent(new Event('change'))");
  assert.ok(await js("document.querySelector('.agent-call-setup button[type=submit]').disabled&&!document.querySelector('[aria-label=\"Use paid cloud voice for this call\"]').checked"),'Realtime mode stays off without credentials and per-call consent');
  assert.ok(await js("document.querySelector('.agent-call-privacy').textContent.includes('provider you chose')"),'Realtime privacy disclosure matches the actual mode');
  await capture('agents-call-cloud-setup');
  await js("document.querySelector('[aria-label=\"Call mode\"]').value='local';document.querySelector('[aria-label=\"Call mode\"]').dispatchEvent(new Event('change'))");
  await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'").catch(async error=>{ console.log(await js("({error:document.querySelector('.agent-call-error').textContent,state:document.querySelector('.agent-call').dataset.state,opened:window.__callTest.opened,values:[...document.querySelectorAll('.agent-call input')].map(n=>n.value)})")); throw error; });
  // The bot's Ajar replaces the orb (mascot, 2026-10-22): it listens, reading the orb's level.
  assert.equal(await js("document.querySelector('.agent-call-orb kairos-mascot').getAttribute('state')"),'listening','The call mascot listens');
  assert.ok(await js("getComputedStyle(document.querySelector('.agent-call-orb kairos-mascot')).display!=='none'&&getComputedStyle(document.querySelector('.agent-call-orb-core')).display==='none'"),'Ajar replaces the orb');
  await js("window.__eyeQuiet=document.querySelector('.agent-call-orb .aj-eye').getBoundingClientRect().height;document.querySelector('.agent-call-orb kairos-mascot').style.setProperty('--level','1')");await delay(300);
  assert.ok(await js("document.querySelector('.agent-call-orb .aj-eye').getBoundingClientRect().height>window.__eyeQuiet*1.08"),'Eyes widen with the listening level');
  await js("document.querySelector('.agent-call-orb kairos-mascot').style.removeProperty('--level')");
  await capture('agents-call-active');
  await js("window.__callAppearance=import('/static/js/appearance.js').then(m=>({mode:m.getAppearance().mode,color:m.getAppearance().color}))");
  await js("import('/static/js/appearance.js').then(m=>m.updateAppearance({mode:'color',color:'#192331'}))");
  await capture('agents-call-dark');
  assert.ok(await js("(() => { const probe = document.createElement('i'); probe.style.background = document.documentElement.classList.contains('kairos-redesign') ? 'var(--rd-surface-solid)' : 'var(--ui-wash)'; document.body.append(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove(); return getComputedStyle(document.querySelector('.agent-call')).backgroundColor === expected && expected !== 'rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('.agent-call')).backgroundColor !== getComputedStyle(document.documentElement).backgroundColor; })()"),'Call surfaces follow the active Kairos theme');
  await js("window.__callAppearance.then(a=>import('/static/js/appearance.js').then(m=>m.updateAppearance(a)))");
  win.setContentSize(812,375);await delay(150);await capture('agents-call-landscape');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call .is-end').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),'Hangup stays visible in landscape');
  win.setContentSize(1440,900);await delay(100);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.ok(await js("getComputedStyle(document.querySelector('.agent-call-orb-core')).animationName==='none'&&getComputedStyle(document.querySelector('.agent-call-orb')).transform==='none'"),'Reduced motion disables orb movement');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  await js('window.__callTest.holdTranscription=true;window.__callTest.level=.02');await delay(160);
  await js('window.__callTest.level=.5'); await delay(300); await js('window.__callTest.level=0');
  await waitFor('window.__callTest.transcripts===1');
  await js("window.__callTest.nextText='And keep the rest of my sentence.';window.__callTest.level=.5");await delay(300);await js('window.__callTest.level=0');await delay(850);
  assert.equal(writes.filter(w=>w.path==='/api/chat/live').length,0,'An unfinished transcription does not submit a partial sentence');
  await js('window.__callTest.holdTranscription=false;window.__callTest.releaseTranscription();true;');
  await waitFor("document.querySelector('.agent-call').dataset.state==='speaking'",12000);
  await js("window.__callTest.nextText='';true;");
  assert.equal(await js('window.__callTest.transcripts'),2,'Continued speech is retained during transcription');
  assert.ok(await js("window.__callTest.callTurns.some(t=>t.text==='Please explain the new layout. And keep the rest of my sentence.')"),'Sentence continuations become one call-owned turn');
  assert.ok(await js("(()=>{const bytes=Uint8Array.from(window.__callTest.wavBodies[0]);const v=new DataView(bytes.buffer);let quiet=0;for(let at=44;at<bytes.length;at+=2){const s=Math.abs(v.getInt16(at,true))/32768;if(s>.01)break;if(s>.0005&&s<.003)quiet++;}return quiet>1000})()"),'Actual browser capture retains the quiet word beginning');
  assert.equal(writes.filter(w=>w.path==='/api/chat/live'||w.path==='/api/bot-chat/'+SID+'/send').length,0,'Call dialogue never enters the ordinary bot chat transport');
  assert.ok(await js("!document.querySelector('.bots-log').textContent.includes('Please explain the new layout.')"),'Raw call dialogue is absent from the conversation');
  assert.ok(await js("JSON.parse(document.querySelector('.agent-call').dataset.callTimings).end_to_audio_ms>=0"),'Speech end to first playback is measured');
  // Voice latency trace (build order step 1): every stage of the turn is stamped, shown in the timing line, kept in memory.
  const traced=await js("JSON.parse(document.querySelector('.agent-call').dataset.callTimings).trace");
  for(const stage of ['speech_end','endpoint','upload_sent','transcript_back','turn_started','first_token','first_sentence','first_audio'])assert.ok(Number.isFinite(traced[stage]),`The latency trace records ${stage}`);
  assert.ok(traced.speech_end===0&&traced.endpoint<=traced.upload_sent&&traced.upload_sent<=traced.transcript_back&&traced.transcript_back<=traced.turn_started&&traced.turn_started<=traced.first_token&&traced.first_token<=traced.first_sentence&&traced.first_sentence<=traced.first_audio,'Trace stages are in turn order');
  assert.ok(await js("document.querySelector('.agent-call-timing').textContent.includes('first audio')"),'The call timing line shows the per-stage trace');
  // The flush poll is gone (was 180 ms): the turn goes out as soon as the transcript lands.
  const dispatchGap=await js('window.__callTest.turnAt-window.__callTest.transcriptAt');
  assert.ok(dispatchGap>=0&&dispatchGap<100,`The turn is sent on the transcript event, not a poll (gap ${dispatchGap} ms)`);
  assert.equal(await js("document.querySelector('.bots-composer-input').value"),'My typed draft stays','Voice leaves typed drafts intact');
  await waitFor('window.__callTest.played>=1');
  assert.equal(await js('window.__callTest.wavHeader'),'RIFF','Native recognition receives WAV rather than browser WebM');
  assert.equal(await js('window.__callTest.wavRate'),16000,'The actual AudioWorklet captures directly at 16 kHz');
  assert.equal(await js('window.__callTest.prepared'),'small.en','Selected model warms before listening');
  assert.equal(await js('window.__callTest.transcribedModel'),'small.en','Selected model reaches every transcription');
  assert.equal(await js("document.querySelectorAll('.agent-call select[aria-label=\"Call voice\"] option').length"),1,'Only local device voices are offered');
  await js("window.__callTest.current.dispatchEvent(new Event('boundary'));true;");
  assert.equal(await js("document.querySelector('.agent-call-orb').style.getPropertyValue('--word')"),'1','Real word events drive the speaking orb');
  assert.equal(await js("document.querySelector('.agent-call-orb kairos-mascot').getAttribute('state')"),'speaking','The call mascot speaks');
  await js("window.__eyeLoud=document.querySelector('.agent-call-orb .aj-eye').getBoundingClientRect().height;document.querySelector('.agent-call-orb kairos-mascot').style.setProperty('--word','1')");await delay(300);
  assert.ok(await js("parseFloat(getComputedStyle(document.querySelector('.agent-call-orb .aj-voice')).opacity)>.4"),'The halo swells with the voice');
  assert.ok(await js("document.querySelector('.agent-call-orb .aj-eye').getBoundingClientRect().height<window.__eyeLoud*.9"),'Eyes squash while speaking');
  await capture('agents-call-speaking');
  await js("document.querySelector('.agent-call-orb kairos-mascot').style.removeProperty('--word')");
  const before=writes.filter(w=>w.path==='/api/chat/live').length;
  // Keep listening while speaking (build order step 3). The microphone stays open, echo-cancelled; Kairos's own voice leaking back
  // (quiet, level .1 here) is the echo and never interrupts, a short "mm-hm" never interrupts, ~250 ms of real voice does.
  assert.equal(await js("document.querySelector('.agent-call').dataset.state"),'speaking');
  const echoPaused=await js('window.__callTest.paused'), echoStops=await js('window.__callTest.callStops.length'), echoTurns=await js('window.__callTest.callTurns.length'), echoTranscripts=await js('window.__callTest.transcripts');
  await js('window.__callTest.level=.1'); await delay(1600); await js('window.__callTest.level=0');
  assert.equal(await js("document.querySelector('.agent-call').dataset.state"),'speaking','Kairos\'s own voice leaking back does not interrupt it');
  assert.equal(await js('window.__callTest.paused'),echoPaused,'Echo never cancels the speech');
  await js('window.__callTest.level=.5'); await delay(110); await js('window.__callTest.level=0'); await delay(500);
  assert.equal(await js("document.querySelector('.agent-call').dataset.state"),'speaking','A short "mm-hm" does not interrupt');
  assert.equal(await js('window.__callTest.callStops.length'),echoStops,'A backchannel sends no interrupt to the server');
  assert.equal(await js("document.querySelector('.agent-call').dataset.bargeIns||'0'"),'0');
  assert.equal(await js('window.__callTest.transcripts'),echoTranscripts,'and is not transcribed as a turn');
  const bargeAt=await js('performance.now()');
  await js('window.__callTest.level=.5');
  await waitFor("document.querySelector('.agent-call').dataset.bargeIns==='1'",3000);
  const bargeMs=await js(`performance.now()-${bargeAt}`);
  assert.ok(bargeMs<1200,`Sustained voice interrupts within about a second of starting (${Math.round(bargeMs)} ms including test scheduling; the detector itself needs 320 ms)`);
  assert.ok(await js('window.__callTest.paused>'+echoPaused),'Barge-in stops the speech');
  const stopMs=Number(await js("document.querySelector('.agent-call').dataset.bargeStopMs"));
  console.log("barge stop ms", stopMs, "detect ms", Math.round(bargeMs));
  assert.ok(stopMs>=0&&stopMs<200,`Stopping playback takes well under 200 ms once the voice is recognised (${stopMs} ms)`);
  await waitFor('window.__callTest.callStops.length>'+echoStops,1500);
  const stopBody=JSON.parse(await js('window.__callTest.callStopBodies.at(-1)'));
  assert.equal(stopBody.spoken,true,'The server is told the reply was cut off by voice');
  assert.ok(Array.isArray(stopBody.heard)&&stopBody.heard[0]==='First useful sentence.','and which sentences had begun to play, so the history keeps only those');
  assert.ok(await js("['listening','transcribing'].includes(document.querySelector('.agent-call').dataset.state)"),'The call is listening to the interruption, not paused');
  await delay(500); await js('window.__callTest.level=0');
  await waitFor('window.__callTest.callTurns.length>'+echoTurns,6000);
  assert.equal(await js('window.__callTest.transcripts'),echoTranscripts+1,'The interrupting sentence is transcribed as a normal turn');
  assert.ok(await js("window.__callTest.wavBodies.at(-1).length>16000*2*.55"),'and holds the start of what was said, from before the interrupt fired');
  await waitFor("document.querySelector('.agent-call').dataset.state==='speaking'",8000);
  assert.equal(writes.filter(w=>w.path==='/api/chat/live').length,before,'Call dialogue still never enters the ordinary chat transport');
  await click('.agent-call-controls button:first-child');
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  assert.ok(await js('window.__callTest.paused>0'),'Assistant mute stops playback');
  // Finished work is pushed over the call's watch channel and spoken at once (the 2 s poll is only the fallback).
  await waitFor('typeof window.__callTest.pushEvent==="function"');
  await js("Object.values(window.__callTest.calls)[0].jobs=[{task_id:'t1',title:'Parkour course',status:'done',result:'Built the course.'}];window.__callTest.pushEvent({type:'work',task_id:'t1',status:'done'});true;");
  await waitFor('window.__callTest.workUpdates.length===1',900);
  assert.deepEqual(await js('window.__callTest.workUpdates'),['work/t1/update'],'A pushed finish requests its spoken update without waiting for the poll');
  await click('.agent-call-controls button:nth-child(2)');
  assert.equal(await js('window.__callTest.closed'),1,'Microphone mute releases the device');
  await click('.agent-call-controls button:nth-child(2)'); await waitFor('window.__callTest.opened===2');
  await capture('agents-call-muted-assistant');
  win.setContentSize(375,812); await delay(150); await capture('agents-call-phone');
  assert.ok(await js("(()=>{const n=document.querySelector('.agent-call');return n.scrollWidth<=n.clientWidth+1})()"),'Call fits phone');
  win.setContentSize(812,375);await delay(150);await capture('agents-call-landscape-transcript');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call .is-end').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),'Hangup stays visible with recognition and timings in landscape');
  assert.ok(await js("document.querySelector('.agent-call-heard').getBoundingClientRect().height>=20"),'Recognition caption stays readable in landscape');
  win.setContentSize(375,812);await delay(100);
  await click('.agent-call .is-end');
  assert.ok(await js("!document.querySelector('.agent-call').open && window.__callTest.closed===2"),'End call releases the microphone');
  const summaries="[...document.querySelectorAll('.bots-log .bots-msg.bot')].filter(n=>n.textContent.includes('Call summary'))";
  await waitFor(`${summaries}.length===1`);
  assert.ok(await js(`${summaries}[0].textContent.includes('Discussed the new layout.')`),'Only the final summary appears in the conversation');
  await js("Object.values(window.__callTest.calls)[0].summary='**Call summary** Updated verified work result.';true;");
  // The saved card is updated through the same callback used by the live
  // work watcher, without repainting the chat or replacing typed drafts.
  await js("document.querySelector('.agent-call-open').click();true;");
  await click('.agent-call .agent-call-header button:last-child');
  assert.equal(await js(`${summaries}.length`),1,'Reopening setup does not duplicate a summary card');
  await js('window.__callTest.holdReply=true');
  await click('.agent-call-open');await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  const playedBefore=await js('window.__callTest.played');
  await js('window.__callTest.level=.5');await delay(300);await js('window.__callTest.level=0');
  await waitFor(`window.__callTest.played>${playedBefore}`);
  assert.ok(await js('window.__callTest.holdReply'),'First useful sentence plays before model completion');
  await click('.agent-call-controls button:nth-child(4)');
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  assert.ok(await js('window.__callTest.callStops.length>0'),'Interrupt targets the call-owned reply');
  assert.equal(writes.filter(w=>w.path==='/api/chat/live/stop'||w.path==='/api/bot-chat/'+SID+'/interrupt').length,0,'Interrupt leaves ordinary typed bot work alone');
  await js('window.__callTest.holdReply=false');
  await click('.agent-call .is-end');
  await click('.agent-call-open'); await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  await navigate('home');
  assert.ok(await js("!document.querySelector('.agent-call') && window.__callTest.opened===window.__callTest.closed"),'Leaving the bot tears down dialog and every microphone track');
  await openBot();await waitFor("!!document.querySelector('.agent-call-open')");
  await js("window.__callTest.holdCreation=false;window.__callTest.holdTranscription=true;window.__callTest.nextText='Discard this interrupted sentence.';true;");
  await click('.agent-call-open');await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  const interruptedCount=await js('window.__callTest.transcripts');
  const interruptedTurns=await js('window.__callTest.callTurns.length');
  await js('window.__callTest.level=.5');await delay(300);await js('window.__callTest.level=0');
  await waitFor(`window.__callTest.transcripts>${interruptedCount}`);
  await click('.agent-call-controls button:nth-child(4)');
  await js('window.__callTest.holdTranscription=false;window.__callTest.releaseTranscription();true;');await delay(350);
  assert.equal(await js('window.__callTest.callTurns.length'),interruptedTurns,'An interrupted transcription cannot submit late text');
  assert.equal(await js("document.querySelector('.agent-call').dataset.state"),'listening','Interrupt resumes microphone capture');
  await navigate('home');
  await openBot();await waitFor("!!document.querySelector('.agent-call-open')");
  // Transcribe while the user talks (build order step 4): a call on the GPU server rolls partials. The caption follows the
  // speaker, and when the first pause arrives the last partial already covers every voiced sample, so the final transcript is
  // that text with NO upload at the end of the turn. A failing partial endpoint falls back to the whole clip.
  await js("window.__callTest.engine='cuda';window.__callTest.partialMode='ok';window.__callTest.partialText='Rolling words arrived before the endpoint.';window.__callTest.nextText='THE WHOLE CLIP WAS SENT';true;");
  await click('.agent-call-open');await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  assert.equal(await js("document.querySelector('.agent-call').dataset.partials"),'on','Rolling transcription is on for a GPU call');
  const rollTranscripts=await js('window.__callTest.transcripts'), rollTurns=await js('window.__callTest.callTurns.length'), rollRequests=await js('window.__callTest.partialRequests.length');
  await js('window.__callTest.level=.5');
  await waitFor("document.querySelector('.agent-call-heard').textContent.startsWith('Hearing: Rolling words')",3000);
  assert.ok(await js('window.__callTest.partialRequests.length>'+rollRequests),'Audio is sent for a partial while the user is still talking');
  assert.equal(await js("document.querySelector('.agent-call').dataset.state"),'listening','and the call keeps listening');
  assert.equal(await js('window.__callTest.partialRequests.at(-1).model+"/"+window.__callTest.partialRequests.at(-1).backend'),'small.en/auto','Partials use the call\'s model and processor');
  await delay(300); await js('window.__callTest.level=0');
  await waitFor('window.__callTest.callTurns.length>'+rollTurns,6000);
  assert.equal(await js('window.__callTest.callTurns.at(-1).text'),'Rolling words arrived before the endpoint.','The turn is the rolling transcript');
  assert.equal(await js('window.__callTest.transcripts'),rollTranscripts,'Nothing was uploaded at the end of the turn (the partial covered the voiced audio)');
  assert.equal(await js("JSON.parse(document.querySelector('.agent-call').dataset.callTimings).partial"),'reuse');
  assert.ok(await js("document.querySelector('.agent-call-timing').textContent.includes('rolling: reuse')"),'The timing line says the transcript was rolling');
  await waitFor("document.querySelector('.agent-call').dataset.state==='speaking'",8000);
  await js("window.__callTest.partialMode='fail';true;");
  await click('.agent-call-controls button:first-child');   // mute the assistant so the next turn is quiet
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  const failTurns=await js('window.__callTest.callTurns.length');
  await js('window.__callTest.level=.5'); await delay(1500); await js('window.__callTest.level=0');
  await waitFor('window.__callTest.callTurns.length>'+failTurns,6000);
  assert.equal(await js('window.__callTest.callTurns.at(-1).text'),'THE WHOLE CLIP WAS SENT','A failing partial endpoint falls back to sending the whole clip');
  assert.equal(await js('window.__callTest.transcripts'),rollTranscripts+1);
  assert.equal(await js("document.querySelector('.agent-call-error').textContent"),'','and says nothing alarming about it');
  await js("window.__callTest.engine='';window.__callTest.partialMode='busy';window.__callTest.nextText='';true;");
  await click('.agent-call .is-end');
  await click('.agent-call-open');await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");
  await js("document.querySelector('[aria-label=\"Call input mode\"]').value='hold';window.__callTest.nextText='Keep my complete sentence with its pause.';document.querySelector('.agent-call-setup').requestSubmit();true;");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  const heldBefore=await js('window.__callTest.transcripts');
  await js("document.querySelector('.agent-call').dispatchEvent(new KeyboardEvent('keydown',{code:'F9',bubbles:true}));window.__callTest.level=.02;true;");await delay(300);
  await js('window.__callTest.level=0');await delay(1100);
  assert.equal(await js('window.__callTest.transcripts'),heldBefore,'Hold-to-talk never splits at a long pause');
  await js('window.__callTest.level=.5');await delay(300);
  await js("window.__callTest.level=0;document.querySelector('.agent-call').dispatchEvent(new KeyboardEvent('keyup',{code:'F9',bubbles:true}));true;");
  await waitFor("document.querySelector('.agent-call').dataset.state==='speaking'");
  assert.equal(await js('window.__callTest.transcripts'),heldBefore+1,'One full held sentence reaches recognition');
  assert.ok(await js("window.__callTest.callTurns.some(t=>t.text==='Keep my complete sentence with its pause.')"),'The held utterance stays in its call conversation');
  assert.ok(await js('window.__callTest.wavBodies.at(-1).length>16000*2*1.7'),'The actual worklet preserves pause and release tail in PCM');
  await click('.agent-call-controls button:first-child');
  await js("const h=document.querySelector('.agent-call-hold');h.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));window.__callTest.level=.5;true;");await delay(200);
  await js("window.dispatchEvent(new Event('blur'));window.__callTest.level=0;true;");await delay(400);
  assert.equal(await js('window.__callTest.transcripts'),heldBefore+1,'Losing focus discards the unfinished hold');
  assert.equal(await js("document.querySelector('.agent-call-hold').getAttribute('aria-pressed')"),'false','Hold feedback resets after cancellation');
  win.setContentSize(375,812);await delay(150);await capture('agents-call-hold-phone');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call .is-end').getBoundingClientRect();return r.bottom<=innerHeight})()"),'Hold mode keeps hangup visible on phone');
  win.setContentSize(812,375);await delay(150);await capture('agents-call-hold-landscape');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call-hold').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),'Hold button stays visible in landscape');
  await navigate('home');
  await js("window.localStorage.removeItem('kairos:call-input:'+window.__callBot);true;");
  await js('window.__callTest.missingModel=true');await openBot();await waitFor("!!document.querySelector('.agent-call-open')");
  await click('.agent-call-open');await waitFor("document.querySelector('.agent-call-readiness').textContent.includes('Download the selected')");
  assert.ok(await js("document.querySelector('.agent-call-setup button[type=submit]').disabled"),'Missing model has an honest setup state');
  const downloadsBefore=writes.filter(w=>w.path.includes('/speech/models/')&&w.path.endsWith('/download')).length;
  assert.equal(downloadsBefore,0,'Opening calls never downloads a model automatically');
  await js("[...document.querySelectorAll('.agent-call-setup button')].find(b=>b.textContent==='Download speech model').click()");
  await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");
  assert.equal(writes.filter(w=>w.path.includes('/speech/models/')&&w.path.endsWith('/download')).length,downloadsBefore+1,'User can set up native speech inside the call screen');
  await navigate('home');
  await openBot();await waitFor("!!document.querySelector('.agent-call-open')");
  await js('window.__callTest.holdCreation=true;window.__callTest.creationPending=false;true;');
  const lateTurns=await js('window.__callTest.callTurns.length');
  const lateOpened=await js('window.__callTest.opened');
  await click('.agent-call-open');await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor('window.__callTest.creationPending');
  await click('.agent-call .agent-call-header button:last-child');
  await js('window.__callTest.releaseCreation();window.__callTest.holdCreation=false;true;');await delay(350);
  assert.equal(await js('window.__callTest.callTurns.length'),lateTurns,'Hangup during call creation cannot submit a late voice turn');
  assert.equal(await js('window.__callTest.opened'),lateOpened,'Late call creation cannot reopen the microphone');
  assert.ok(await js('Object.values(window.__callTest.calls).every(c=>c.ended)'),'Every call record is finalized after cancellation or navigation');
  await navigate('home');
  await js(String.raw`(async()=>{
    const {neuralSpeaker}=await import('/static/js/callVoice.js');
    const original=window.fetch;window.__neural={started:0,ended:0,errors:[],requests:[]};
    window.fetch=async(path,options)=>{
      if(path!=='/api/agent-calls/speak')return original(path,options);
      window.__neural.requests.push(JSON.parse(options.body));
      return new Response(new ReadableStream({start(c){const emit=value=>c.enqueue(new TextEncoder().encode(JSON.stringify(value)+'\n'));emit({sample_rate:24000});emit({audio:btoa('\0\0\0')});window.__neural.release=()=>{emit({audio:btoa('\0'.repeat(4797))});emit({done:true});c.close();};}}));
    };
    const speaker=window.__neural.speaker=neuralSpeaker({onStart:()=>window.__neural.started++,onEnd:()=>window.__neural.ended++,onError:e=>window.__neural.errors.push(e)},()=>({model:'pockettts',voice:'default'}));
    await speaker.prepare();speaker.reset();speaker.feed('First neural sentence.');speaker.flushSentence();
    window.__neural.restore=()=>{speaker.dispose();window.fetch=original;};
  })()`);
  await waitFor('window.__neural.started===1');
  await js('window.__neural.speaker.cancel();window.__neural.release();true;');await delay(180);
  assert.equal(await js('window.__neural.started'),1,'Late neural PCM cannot restart interrupted playback');
  assert.equal(await js('window.__neural.ended'),0,'Cancelled PCM cannot settle a newer turn');
  await js("window.__neural.speaker.reset();window.__neural.speaker.feed('Second neural sentence.');window.__neural.speaker.finish();true;");
  await waitFor('window.__neural.requests.length===2');await js('window.__neural.release();true;');
  await waitFor('window.__neural.ended===1');
  assert.equal(await js('window.__neural.started'),2,'The next neural reply plays after interruption');
  assert.deepEqual(await js('window.__neural.errors'),[],'Odd network chunk boundaries decode to complete PCM samples');
  await js('window.__neural.restore();true;');
  await js(`(async()=>{
    const {createSpeaker}=await import('/static/js/voiceOutput.js');
    let ended=0;const speaker=createSpeaker({onEnd:()=>ended++});
    speaker.feed('First reply.');speaker.finish();await Promise.resolve();
    const previous=window.__callTest.current;speaker.cancel();speaker.reset();
    speaker.feed('New reply.');speaker.finish();await Promise.resolve();
    window.speechSynthesis.pending=false;window.speechSynthesis.speaking=false;
    window.__callTest.current.dispatchEvent(new Event('end'));
    const before=ended;previous.dispatchEvent(new Event('end'));previous.dispatchEvent(new Event('error'));
    window.__lateSpeechEventsSafe=ended===before;speaker.cancel();
  })()`);
  assert.ok(await js('window.__lateSpeechEventsSafe'),'Late native speech events cannot settle a newer reply');
  await js(`navigator.mediaDevices.getUserMedia=window.__callTest.getUserMedia;window.__callTest.destination.stream.getTracks().forEach(t=>t.stop());window.__callTest.inputContext.close();window.SpeechSynthesisUtterance=window.__callTest.utterance;if(window.__callTest.synthesis)Object.defineProperty(window,'speechSynthesis',window.__callTest.synthesis);else delete window.speechSynthesis;window.fetch=window.__callTest.fetch;true;`);
  win.setContentSize(1440,900);
  console.log('PASS Agent calls: actual AudioWorklet/PCM, quiet pre-roll, transcription/thinking continuations, selected model/warmup, call-owned streaming/draft controls, echo gate, phone/themes/reduced motion and cancellation (synthetic microphone; mocked recognition/voice).');
  } finally {
    win.setContentSize(1440,900);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]}).catch(()=>{});
    await restore();
  }
};

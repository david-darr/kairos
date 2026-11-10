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
  // A live call now survives leaving the bot (its pill, 2026-11-10); a check that wants a fresh call hangs up first.
  const hangUpIfLive = async () => { if (await js("!!document.querySelector('.agent-call[data-live]')")) { await js("document.querySelector('.agent-call[data-live] [data-call=hangup]').click();true"); await waitFor("!document.querySelector('.agent-call[data-live]')"); } };
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
      if(path==='/api/agent-calls/realtime-choices')return json(t.realtime||[]);
      if(path==='/api/voice-engines')return json({choice:t.voiceChoice||'kairos'});
      if(path==='/api/agent-calls/voices')return json({url:'',protocol:'kokoro',models:[],voices:[],error:'Kokoro is not downloaded. The device voice is used instead.'});
      if(path.startsWith('/api/agent-calls/pending/'))return json([]);
      if(path==='/api/agent-calls') {
        const make=()=>{const id=String(++t.callCounter).padStart(32,'0');const body=JSON.parse(options.body);(t.callBodies||=[]).push(body);const value={id,parent_id:body.parent_id,ended:false,summary_state:'open',jobs:[]};t.calls[id]=value;return json(value);};
        if(t.holdCreation){t.creationPending=true;return new Promise(resolve=>t.releaseCreation=()=>resolve(make()));}
        return make();
      }
      const match=path.match(/^\/api\/agent-calls\/([0-9]+)(?:\/(.*))?$/);
      if(match){const call=t.calls[match[1]], action=match[2];
        if(!action)return json(call);
        if(action==='prepare'||action==='timing')return json({ok:true,prepare_ms:12});
        if(action==='opening'){t.openings=(t.openings||0)+1;return new Response(new TextEncoder().encode(JSON.stringify({type:'text',delta:'Hi, your build finished.'})+'\n'+JSON.stringify({type:'done',reply_ms:0})+'\n'),{headers:{'Content-Type':'application/x-ndjson'}});}
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
  // One-tap calls (2026-11-10): one click on Call reaches the live call with the defaults. No form, no Start call.
  await js("(()=>{window.__callStatuses=[];window.__statusWatch?.disconnect();const s=document.querySelector('.agent-call-status');window.__statusWatch=new MutationObserver(()=>window.__callStatuses.push(s.textContent));window.__statusWatch.observe(s,{childList:true,characterData:true,subtree:true});return true})()");
  await js("(()=>{window.__mascotStates=[];window.__mascotWatch?.disconnect();const m=document.querySelector('.agent-call-orb kairos-mascot');window.__mascotWatch=new MutationObserver(()=>window.__mascotStates.push(m.getAttribute('state')));window.__mascotWatch.observe(m,{attributes:true,attributeFilter:['state']});return true})()");
  await click('.agent-call-open'); await waitFor("document.querySelector('.agent-call').open");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'").catch(async error=>{ console.log(await js("({state:document.querySelector('.agent-call').dataset.state,blocker:document.querySelector('.agent-call-blocker').textContent,error:document.querySelector('.agent-call-error').textContent})")); throw error; });
  assert.equal(await js("document.querySelector('.agent-call-setup').hidden"),true,'The settings stay out of the way');
  assert.deepEqual(await js("(({endpoint_id,model})=>({endpoint_id,model}))(window.__callTest.callBodies.at(-1))"),{endpoint_id:'fast',model:'llama3.2'},'The call uses the conversation model this bot used last');
  assert.equal(await js('window.__callTest.prepared'),'small.en','and the speech model already on this device');
  assert.equal(await js("document.querySelector('.agent-call').dataset.inputMode"),'automatic','Input is automatic');
  assert.equal(await js("window.__callStatuses.some(s=>/one time only/.test(s))"),false,'Nothing downloads when a speech model is here');
  assert.equal(await js("document.querySelector('.agent-call-blocker').hidden&&document.querySelector('.agent-call-notice').hidden"),true,'and nothing needs saying');
  await capture('agents-call-one-tap');
  // The call screen (2026-11-10, like a phone's audio call): the call kind, the bot's mascot in a round avatar, its name,
  // a running timer, level bars and three round keys. Nothing else is on the main view.
  const screen = await js(`(()=>{const d=document.querySelector('.agent-call'),keys=[...d.querySelectorAll('.agent-call-controls > button')],clock=d.querySelector('.agent-call-clock');
    return {kind:d.querySelector('.agent-call-kind').textContent,name:d.querySelector('.agent-call-scene h1').textContent,clock:/^\\d\\d:\\d\\d$/.test(clock.textContent)&&getComputedStyle(clock).display!=='none',
      avatar:!!d.querySelector('.agent-call-avatar .agent-call-orb kairos-mascot'),round:getComputedStyle(d.querySelector('.agent-call-avatar')).borderRadius,bars:d.querySelectorAll('.agent-call-meter i').length,who:d.querySelector('.agent-call-meter').dataset.who,
      keys:keys.map(k=>k.dataset.call),labels:keys.map(k=>k.getAttribute('aria-label')),discs:keys.map(k=>Math.round(k.querySelector('.agent-call-key-disc').getBoundingClientRect().width)),
      speakerOn:keys[0].getAttribute('aria-pressed'),sheet:d.querySelector('.agent-call-sheet').hidden,
      main:[...d.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.closest('.agent-call-sheet')).map(b=>b.dataset.call||b.className)}})()`);
  assert.equal(screen.kind,'Kairos call','The label says the kind of call');
  assert.equal(screen.name,await js("document.querySelector('.agent-call').getAttribute('aria-label').replace('Voice call with ','')"),'The bot\'s name is the title');
  assert.ok(screen.clock,'A running timer shows under the name');
  assert.ok(screen.avatar&&screen.round==='50%','The bot\'s mascot sits in a round avatar');
  assert.equal(screen.bars,5,'Level bars show who is speaking');
  assert.equal(screen.who,'you','and while the call listens they follow you');
  assert.deepEqual(screen.keys,['speaker','mute','hangup'],'Three round keys: speaker, mute, hang up');
  assert.deepEqual(screen.labels,['Speaker','Mute','End call']);
  assert.ok(screen.discs.every(w=>w>=44),`The keys are at least 44 px (${screen.discs})`);
  assert.equal(screen.speakerOn,'true','The speaker starts on');
  assert.equal(screen.sheet,true,'More starts closed');
  assert.deepEqual(screen.main,['agent-call-minimize','agent-call-more-toggle','speaker','mute','hangup'],'Only minimize, More and the three keys are on the main view');
  // The mascot follows the call: it thinks while the call connects, then listens.
  const seen=await js('window.__mascotStates');
  assert.ok(seen.includes('thinking')&&seen.lastIndexOf('thinking')<seen.lastIndexOf('listening'),`The mascot thinks while connecting, then listens (${seen})`);
  // More holds every secondary action: back to chat, interrupt, hold to talk, call settings, the live transcript,
  // the work list, the summary line and the privacy note.
  await click('.agent-call-more-toggle');
  await waitFor("!document.querySelector('.agent-call-sheet').hidden");
  assert.equal(await js("document.querySelector('.agent-call-more-toggle').getAttribute('aria-expanded')"),'true');
  assert.deepEqual(await js("['chat','interrupt','hold','settings'].filter(n=>!document.querySelector('.agent-call-sheet [data-call='+n+']'))"),[],'Every secondary action is in the More sheet');
  assert.deepEqual(await js("['.agent-call-heard','.agent-call-timing','.agent-call-engine','.agent-call-work','.agent-call-summary','.agent-call-privacy','.agent-call-setup','.agent-call-members'].filter(c=>!document.querySelector('.agent-call-sheet '+c))"),[],'and so are the transcript, work, summary, privacy and settings');
  assert.deepEqual(await js("[...document.querySelectorAll('.agent-call-sheet-actions button')].filter(b=>b.getClientRects().length).map(b=>b.dataset.call)"),['chat','interrupt','settings'],'Hold to talk shows only in that input mode');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call-controls [data-call=hangup]').getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0})()"),'Hang up stays on screen with More open');
  await capture('agents-call-more');
  await click('.agent-call-more-toggle');
  await waitFor("document.querySelector('.agent-call-sheet').hidden");
  // Call settings are still one click away: in a live call the button ends it and opens them in place.
  assert.equal(await js("document.querySelector('.agent-call-settings-toggle').textContent"),'End call and change settings');
  await click('.agent-call-settings-toggle');
  await waitFor("document.querySelector('.agent-call').open && !document.querySelector('.agent-call-setup').hidden && document.querySelector('.agent-call').dataset.state==='setup'");
  assert.equal(await js("document.querySelector('.agent-call-notice').textContent"),'Call ended. Change what you need, then press Start call.');
  assert.equal(await js("Object.values(window.__callTest.calls).at(-1).ended"),true,'The live call ended');
  const micBase=await js('window.__callTest.closed');
  assert.equal(await js('window.__callTest.opened'),micBase,'and let go of the microphone');
  await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");
  assert.equal(await js("document.querySelector('[aria-label=\"Speech recognition model\"]').value"),'small.en','Calls start with the Voice-line accuracy model');
  assert.equal(await js("document.querySelector('[aria-label=\"Conversation model version\"]').value"),'llama3.2','The exact model ID lives only in Call settings');
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
  const night = "(() => { const probe = document.createElement('i'); probe.style.background = 'var(--call-ground-bottom)'; probe.style.color = 'var(--call-ink)'; document.body.append(probe); const ground = getComputedStyle(probe).backgroundColor, ink = getComputedStyle(probe).color; probe.remove(); const d = getComputedStyle(document.querySelector('.agent-call')); return d.backgroundColor === ground && d.color === ink && d.backgroundImage.includes('gradient') && ground !== 'rgba(0, 0, 0, 0)'; })()";
  await capture('agents-call-active');
  assert.ok(await js(night),'and in the light theme, from the call tokens');
  await js("window.__callAppearance=import('/static/js/appearance.js').then(m=>({mode:m.getAppearance().mode,color:m.getAppearance().color}))");
  await js("import('/static/js/appearance.js').then(m=>m.updateAppearance({mode:'color',color:'#192331'}))");
  await capture('agents-call-dark');
  assert.ok(await js(night),'The call keeps its night ground and light ink in a dark theme');
  await js("window.__callAppearance.then(a=>import('/static/js/appearance.js').then(m=>m.updateAppearance(a)))");
  win.setContentSize(812,375);await delay(150);await capture('agents-call-landscape');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call .is-end').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),'Hangup stays visible in landscape');
  win.setContentSize(1440,900);await delay(100);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.ok(await js("getComputedStyle(document.querySelector('.agent-call-orb-core')).animationName==='none'&&getComputedStyle(document.querySelector('.agent-call-orb')).transform==='none'"),'Reduced motion disables orb movement');
  assert.ok(await js("(()=>{const bar=getComputedStyle(document.querySelector('.agent-call-meter i')),ring=getComputedStyle(document.querySelector('.agent-call-avatar'));return bar.transitionDuration==='0s'&&bar.height==='10px'&&ring.transitionDuration==='0s'&&getComputedStyle(document.querySelector('.agent-call-orb kairos-mascot svg *')).animationName==='none'})()"),'Reduced motion stills the level bars, the avatar ring and the mascot');
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
  // Measure the resting eye first: the word event above is still easing the eye when it is read straight away.
  await js("document.querySelector('.agent-call-orb kairos-mascot').style.setProperty('--word','0')");await delay(300);
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
  await click('.agent-call [data-call=speaker]');
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  assert.ok(await js('window.__callTest.paused>0'),'Assistant mute stops playback');
  assert.deepEqual(await js("(()=>{const k=document.querySelector('.agent-call [data-call=speaker]');return [k.getAttribute('aria-pressed'),k.textContent]})()"),['false','Speaker off'],'The speaker key shows the bot\'s voice is off');
  // Finished work is pushed over the call's watch channel and spoken at once (the 2 s poll is only the fallback).
  await waitFor('typeof window.__callTest.pushEvent==="function"');
  await js("Object.values(window.__callTest.calls)[0].jobs=[{task_id:'t1',title:'Parkour course',status:'done',result:'Built the course.'}];window.__callTest.pushEvent({type:'work',task_id:'t1',status:'done'});true;");
  await waitFor('window.__callTest.workUpdates.length===1',900);
  assert.deepEqual(await js('window.__callTest.workUpdates'),['work/t1/update'],'A pushed finish requests its spoken update without waiting for the poll');
  await click('.agent-call [data-call=mute]');
  assert.equal(await js('window.__callTest.closed'),micBase+1,'Microphone mute releases the device');
  await click('.agent-call [data-call=mute]'); await waitFor(`window.__callTest.opened===${micBase+2}`);
  await capture('agents-call-muted-assistant');
  win.setContentSize(375,812); await delay(150); await capture('agents-call-phone');
  assert.ok(await js("(()=>{const n=document.querySelector('.agent-call');return n.scrollWidth<=n.clientWidth+1})()"),'Call fits phone');
  await js("document.documentElement.style.setProperty('--native-safe-top','47px');document.documentElement.style.setProperty('--native-safe-bottom','34px');true");await delay(100);
  const phoneScreen=await js("(()=>{const d=document.querySelector('.agent-call'),r=d.getBoundingClientRect(),c=getComputedStyle(d),keys=[...d.querySelectorAll('.agent-call-controls > button')].map(k=>k.getBoundingClientRect());return {full:[r.left,r.top,r.width,r.height].map(Math.round).join(),inner:innerWidth+','+innerHeight,top:parseFloat(c.paddingTop),bottom:parseFloat(c.paddingBottom),radius:c.borderRadius,keys:keys.every(k=>k.height>=44&&k.width>=44&&k.bottom<=innerHeight-34&&k.top>=47)}})()");
  assert.equal(phoneScreen.full,'0,0,'+phoneScreen.inner,'The call is full screen on a phone');
  assert.ok(phoneScreen.top>=47&&phoneScreen.bottom>=34&&phoneScreen.radius==='0px',`and keeps clear of the safe areas (${JSON.stringify(phoneScreen)})`);
  assert.ok(phoneScreen.keys,'with every key 44 px and inside them');
  await capture('agents-call-phone-safe-areas');
  await js("document.documentElement.style.removeProperty('--native-safe-top');document.documentElement.style.removeProperty('--native-safe-bottom');true");
  win.setContentSize(812,375);await delay(150);await capture('agents-call-landscape-transcript');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call .is-end').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),'Hangup stays visible with recognition and timings in landscape');
  await click('.agent-call-more-toggle'); await waitFor("!document.querySelector('.agent-call-sheet').hidden");
  assert.ok(await js("document.querySelector('.agent-call-heard').getBoundingClientRect().height>=20"),'The live transcript stays readable in landscape, in More');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call .is-end').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),'and hang up stays visible with More open');
  await click('.agent-call-more-toggle'); await waitFor("document.querySelector('.agent-call-sheet').hidden");
  win.setContentSize(375,812);await delay(100);
  await click('.agent-call .is-end');
  assert.ok(await js(`!document.querySelector('.agent-call').open && window.__callTest.closed===${micBase+2}`),'End call releases the microphone');
  const summaries="[...document.querySelectorAll('.bots-log .bots-msg.bot')].filter(n=>n.textContent.includes('Call summary'))";
  const endedCalls="Object.values(window.__callTest.calls).filter(c=>c.ended).length";
  // Two calls so far: the one-tap call that Call settings ended, and this one. Each leaves exactly one summary.
  await waitFor(`${summaries}.length===2`);
  assert.ok(await js(`${summaries}.some(n=>n.textContent.includes('Discussed the new layout.'))`),'Only the final summary appears in the conversation');
  await js("Object.values(window.__callTest.calls)[0].summary='**Call summary** Updated verified work result.';true;");
  // The saved card is updated through the same callback used by the live
  // work watcher, without repainting the chat or replacing typed drafts.
  await js("document.querySelector('.agent-call-open').click();true;");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  await click('.agent-call [data-call=hangup]');
  await waitFor(`${summaries}.length===${endedCalls}`);
  assert.equal(await js(`${summaries}.length`),await js(endedCalls),'Calling again adds one summary per call and never duplicates one');
  // A call ended while it was still being created leaves no stray record behind.
  await js('window.__callTest.holdReply=true');
  const callNow=async()=>{await click('.agent-call-open');await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");};
  await callNow();
  const playedBefore=await js('window.__callTest.played');
  await js('window.__callTest.level=.5');await delay(300);await js('window.__callTest.level=0');
  await waitFor(`window.__callTest.played>${playedBefore}`);
  assert.ok(await js('window.__callTest.holdReply'),'First useful sentence plays before model completion');
  await click('.agent-call [data-call=interrupt]');
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  assert.ok(await js('window.__callTest.callStops.length>0'),'Interrupt targets the call-owned reply');
  assert.equal(writes.filter(w=>w.path==='/api/chat/live/stop'||w.path==='/api/bot-chat/'+SID+'/interrupt').length,0,'Interrupt leaves ordinary typed bot work alone');
  await js('window.__callTest.holdReply=false');
  await click('.agent-call .is-end');
  await callNow();
  await navigate('home');
  await waitFor("!!document.querySelector('.call-pill:not([hidden])') && !document.querySelector('.agent-call').open");
  assert.ok(await js("window.__callTest.opened>window.__callTest.closed"),'Leaving the bot keeps the call going in its pill');
  await js("document.querySelector('.call-pill [data-call=hangup]').click();true");
  await waitFor("!document.querySelector('.call-pill')");
  assert.ok(await js("!document.querySelector('.agent-call') && window.__callTest.opened===window.__callTest.closed"),'Hanging up from the pill tears down the dialog and every microphone track');
  await openBot();await waitFor("!!document.querySelector('.agent-call-open')");
  await js("window.__callTest.holdCreation=false;window.__callTest.holdTranscription=true;window.__callTest.nextText='Discard this interrupted sentence.';true;");
  await callNow();
  const interruptedCount=await js('window.__callTest.transcripts');
  const interruptedTurns=await js('window.__callTest.callTurns.length');
  await js('window.__callTest.level=.5');await delay(300);await js('window.__callTest.level=0');
  await waitFor(`window.__callTest.transcripts>${interruptedCount}`);
  await click('.agent-call [data-call=interrupt]');
  await js('window.__callTest.holdTranscription=false;window.__callTest.releaseTranscription();true;');await delay(350);
  assert.equal(await js('window.__callTest.callTurns.length'),interruptedTurns,'An interrupted transcription cannot submit late text');
  assert.equal(await js("document.querySelector('.agent-call').dataset.state"),'listening','Interrupt resumes microphone capture');
  await hangUpIfLive(); await navigate('home');
  await openBot();await waitFor("!!document.querySelector('.agent-call-open')");
  // Transcribe while the user talks (build order step 4): a call on the GPU server rolls partials. The caption follows the
  // speaker, and when the first pause arrives the last partial already covers every voiced sample, so the final transcript is
  // that text with NO upload at the end of the turn. A failing partial endpoint falls back to the whole clip.
  await js("window.__callTest.engine='cuda';window.__callTest.partialMode='ok';window.__callTest.partialText='Rolling words arrived before the endpoint.';window.__callTest.nextText='THE WHOLE CLIP WAS SENT';true;");
  await callNow();
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
  await click('.agent-call [data-call=speaker]');   // mute the assistant so the next turn is quiet
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  const failTurns=await js('window.__callTest.callTurns.length');
  await js('window.__callTest.level=.5'); await delay(1500); await js('window.__callTest.level=0');
  await waitFor('window.__callTest.callTurns.length>'+failTurns,6000);
  assert.equal(await js('window.__callTest.callTurns.at(-1).text'),'THE WHOLE CLIP WAS SENT','A failing partial endpoint falls back to sending the whole clip');
  assert.equal(await js('window.__callTest.transcripts'),rollTranscripts+1);
  assert.equal(await js("document.querySelector('.agent-call-error').textContent"),'','and says nothing alarming about it');
  await js("window.__callTest.engine='';window.__callTest.partialMode='busy';window.__callTest.nextText='';true;");
  await click('.agent-call .is-end');
  // Hold to talk, chosen earlier in Call settings, is remembered for this bot and used by the next one-tap call.
  await js("localStorage.setItem('kairos:call-input:'+window.__callBot,'hold');window.__callTest.nextText='Keep my complete sentence with its pause.';true;");
  await callNow();
  assert.equal(await js("document.querySelector('.agent-call').dataset.inputMode"),'hold');
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
  await click('.agent-call [data-call=speaker]');
  await js("const h=document.querySelector('.agent-call-hold');h.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));window.__callTest.level=.5;true;");await delay(200);
  await js("window.dispatchEvent(new Event('blur'));window.__callTest.level=0;true;");await delay(400);
  assert.equal(await js('window.__callTest.transcripts'),heldBefore+1,'Losing focus discards the unfinished hold');
  assert.equal(await js("document.querySelector('.agent-call-hold').getAttribute('aria-pressed')"),'false','Hold feedback resets after cancellation');
  win.setContentSize(375,812);await delay(150);await capture('agents-call-hold-phone');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call .is-end').getBoundingClientRect();return r.bottom<=innerHeight})()"),'Hold mode keeps hangup visible on phone');
  win.setContentSize(812,375);await delay(150);await capture('agents-call-hold-landscape');
  await click('.agent-call-more-toggle'); await waitFor("!document.querySelector('.agent-call-sheet').hidden");
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call-hold').getBoundingClientRect();return r.height>=44&&r.top>=0&&r.bottom<=innerHeight})()"),'Hold to talk is in More and fits in landscape');
  assert.ok(await js("(()=>{const r=document.querySelector('.agent-call .is-end').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),'beside a visible hang up');
  await capture('agents-call-hold-more-landscape');
  await click('.agent-call-more-toggle');
  await hangUpIfLive(); await navigate('home');
  await js("window.localStorage.removeItem('kairos:call-input:'+window.__callBot);true;");
  await js('window.__callTest.missingModel=true');await openBot();await waitFor("!!document.querySelector('.agent-call-open')");
  // No speech model on the device: the call says so in one line, downloads the default small model once, then connects.
  const downloadsBefore=writes.filter(w=>w.path.includes('/speech/models/')&&w.path.endsWith('/download')).length;
  await js("(()=>{window.__callStatuses=[];window.__statusWatch?.disconnect();const s=document.querySelector('.agent-call-status');window.__statusWatch=new MutationObserver(()=>window.__callStatuses.push(s.textContent));window.__statusWatch.observe(s,{childList:true,characterData:true,subtree:true});return true})()");
  await callNow();
  assert.ok(await js("window.__callStatuses.includes('Getting voice ready, one time only')"),'The call says it is getting the voice ready, once');
  assert.deepEqual(writes.filter(w=>w.path.includes('/speech/models/')&&w.path.endsWith('/download')).slice(downloadsBefore).map(w=>w.path),['/api/speech/models/small.en/download'],'and downloads the default small model itself');
  assert.equal(await js('window.__callTest.prepared'),'small.en','then connects with it');
  await click('.agent-call .is-end');
  // Answering a ring goes straight into the call too, and the bot opens with the reason it rang.
  const ringId='a'.repeat(32);
  await js(`import('/static/js/ringHost.js').then(m=>{m.setPendingRing({id:'${ringId}',agentId:window.__callBot,reason:'Your build finished.'});document.dispatchEvent(new CustomEvent('kairos:ring-answered'));return true;})`);
  await waitFor("document.querySelector('.agent-call').open && document.querySelector('.agent-call').dataset.state!=='setup' && !!window.__callTest.openings",8000);
  assert.equal(await js('window.__callTest.callBodies.at(-1).ring_id'),ringId,'The answered ring starts the call without a click');
  assert.equal(await js("document.querySelector('.agent-call-setup').hidden"),true,'and without the settings');
  await click('.agent-call .is-end');
  await hangUpIfLive(); await navigate('home');
  await openBot();await waitFor("!!document.querySelector('.agent-call-open')");
  await js('window.__callTest.holdCreation=true;window.__callTest.creationPending=false;true;');
  const lateTurns=await js('window.__callTest.callTurns.length');
  const lateOpened=await js('window.__callTest.opened');
  await click('.agent-call-open');
  await waitFor('window.__callTest.creationPending');
  await click('.agent-call [data-call=hangup]');
  await js('window.__callTest.releaseCreation();window.__callTest.holdCreation=false;true;');await delay(350);
  assert.equal(await js('window.__callTest.callTurns.length'),lateTurns,'Hangup during call creation cannot submit a late voice turn');
  assert.equal(await js('window.__callTest.opened'),lateOpened,'Late call creation cannot reopen the microphone');
  assert.ok(await js('Object.values(window.__callTest.calls).every(c=>c.ended)'),'Every call record is finalized after cancellation or navigation');
  // The Voice in Settings > Speech comes before "Local if unset": GPT-Live there makes one tap a GPT-Live call, with the
  // choice in Settings as the paid consent (no Continue step), on the GPT-Live connection.
  if (await js("!!document.querySelector('.agent-call')?.open")) { await js("document.querySelector('.agent-call [data-call=hangup]')?.click();true"); await waitFor("!document.querySelector('.agent-call').open"); }
  await js(`(()=>{const t=window.__callTest;t.voiceChoice='gpt_live';t.realtime=[{id:'rt:fast',name:'OpenAI',provider:'openai',label:'OpenAI Realtime',voices:['cedar'],default_voice:'cedar',price_per_minute:0.06,model:'gpt-realtime',free_tier:false},{id:'live:fast',name:'OpenAI',provider:'openai_live',label:'GPT-Live',voices:['marin'],default_voice:'marin',price_per_minute:0.05,model:'gpt-live-1',free_tier:false}];
    window.__sockets=[];window.__RealWebSocket=window.WebSocket;window.WebSocket=class{constructor(url){this.url=url;this.readyState=0;this.sent=[];window.__sockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.()},0)}send(d){this.sent.push(d)}close(){this.readyState=3}};return true})()`);
  await delay(1100);  // shared reads last 1 s (api.js)
  await click('.agent-call-open'); await waitFor("document.querySelector('.agent-call').open");
  await waitFor("window.__sockets.some(s=>s.sent.some(d=>typeof d==='string'&&d.includes('\"start\"')))").catch(async error=>{ console.log(await js("({blocker:document.querySelector('.agent-call-blocker').textContent,notice:document.querySelector('.agent-call-notice').textContent,error:document.querySelector('.agent-call-error').textContent,mode:document.querySelector('[aria-label=\"Call mode\"]').value})")); throw error; });
  const liveStart = await js("JSON.parse(window.__sockets.at(-1).sent.find(d=>typeof d==='string'&&d.includes('\"start\"')))");
  assert.deepEqual([liveStart.endpoint_id, liveStart.voice, liveStart.consent], ['live:fast', 'marin', true], 'GPT-Live as the Voice: the call is a GPT-Live call at once, on GPT-Live, consented in Settings');
  assert.equal(await js("document.querySelector('.agent-call-blocker').hidden"), true, 'with no Continue step');
  await js("document.querySelector('.agent-call [data-call=hangup]')?.click();window.WebSocket=window.__RealWebSocket;const t=window.__callTest;t.voiceChoice='';t.realtime=[];true");
  await waitFor("!document.querySelector('.agent-call').open");
  await hangUpIfLive(); await navigate('home');
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
  await js(`window.__statusWatch?.disconnect();window.__mascotWatch?.disconnect();navigator.mediaDevices.getUserMedia=window.__callTest.getUserMedia;window.__callTest.destination.stream.getTracks().forEach(t=>t.stop());window.__callTest.inputContext.close();window.SpeechSynthesisUtterance=window.__callTest.utterance;if(window.__callTest.synthesis)Object.defineProperty(window,'speechSynthesis',window.__callTest.synthesis);else delete window.speechSynthesis;window.fetch=window.__callTest.fetch;true;`);
  win.setContentSize(1440,900);
  console.log('PASS Agent calls: actual AudioWorklet/PCM, quiet pre-roll, transcription/thinking continuations, selected model/warmup, call-owned streaming/draft controls, echo gate, phone/themes/reduced motion and cancellation (synthetic microphone; mocked recognition/voice).');
  } finally {
    win.setContentSize(1440,900);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]}).catch(()=>{});
    await restore();
  }
};

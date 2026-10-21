const assert = require('node:assert/strict');
module.exports = async ({js,waitFor,delay,navigate,win,capture,writes,demoState,liveChange}) => {
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await navigate('agents',{agentId:'a1'});
  await waitFor("!!document.querySelector('.agent-call-open') && !!document.querySelector('.side-chat-input')");
  await js(String.raw`(async()=>{
    window.__callTest={level:0,opened:0,closed:0,played:0,calls:{},callTurns:[],callEnds:[],callStops:[],callCounter:0,paused:0,urls:[],transcripts:0,wavBodies:[],fetch:window.fetch,utterance:window.SpeechSynthesisUtterance,synthesis:Object.getOwnPropertyDescriptor(window,'speechSynthesis'),getUserMedia:navigator.mediaDevices.getUserMedia};
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
      if(path==='/api/agent-calls/live-choices')return json([]);
      if(path==='/api/agent-calls/voices')return json({url:'',protocol:'voicestudio',models:[],voices:[]});
      if(path.startsWith('/api/agent-calls/pending/'))return json([]);
      if(path==='/api/agent-calls') {const id=String(++t.callCounter).padStart(32,'0');const value={id,parent_id:JSON.parse(options.body).parent_id,ended:false,summary_state:'open',jobs:[]};t.calls[id]=value;return json(value);}
      const match=path.match(/^\/api\/agent-calls\/([0-9]+)(?:\/(.*))?$/);
      if(match){const call=t.calls[match[1]], action=match[2];
        if(!action)return json(call);
        if(action==='prepare'||action==='timing')return json({ok:true,prepare_ms:12});
        if(action==='end'){t.callEnds.push(call.id);call.ended=true;call.summary_state='saved';call.summary='**Call summary**\n\nDiscussed the new layout.';return json(call);}
        if(action==='interrupt'){t.callStops.push(call.id);t.releaseReply?.();return json({ok:true});}
        if(action==='turn'){
          t.callTurns.push(JSON.parse(options.body));
          return new Response(new ReadableStream({start(c){
            const emit=e=>c.enqueue(new TextEncoder().encode(JSON.stringify(e)+'\n'));
            emit({type:'text',delta:'First useful sentence. ',first_output_ms:22});
            const finish=()=>{if(options.signal?.aborted){c.close();return;}emit({type:'text',delta:'The rest of the reply.'});emit({type:'done',reply_ms:150,first_output_ms:22});c.close();};
            if(t.holdReply)t.releaseReply=finish;else setTimeout(finish,100);
          }}),{headers:{'Content-Type':'application/x-ndjson'}});
        }
      }

      if(String(url)==='/api/speech/status') return new Response(JSON.stringify({engine_available:true,active_model:window.__callTest.missingModel?null:'base.en',call_model:'small.en',acceleration:{supported:true,configured:false},models:[{name:'base.en',label:'Base',size_mb:142,downloaded:!window.__callTest.missingModel},{name:'small.en',label:'Small',size_mb:466,downloaded:!window.__callTest.missingModel}]}),{headers:{'Content-Type':'application/json'}});
      if(String(url)==='/api/speech/prepare') {window.__callTest.prepared=JSON.parse(options.body).model;return new Response(JSON.stringify({model:window.__callTest.prepared,engine:'cpu',prepare_ms:12}),{headers:{'Content-Type':'application/json'}});}
      if(String(url).endsWith('/progress')&&String(url).startsWith('/api/speech/models/')) {window.__callTest.missingModel=false;return new Response(JSON.stringify({done:true}),{headers:{'Content-Type':'application/json'}});}
      if(String(url).endsWith('/api/agents/a1/chat') && window.__callTest.holdCreation) {
        window.__callTest.creationPending=true;
        return new Promise(resolve=>window.__callTest.releaseCreation=()=>resolve(window.__callTest.fetch.call(window,url,options)));
      }
      if(String(url)==='/api/speech/transcribe') {
        const bytes=new Uint8Array(await options.body.get('audio').arrayBuffer());window.__callTest.wavHeader=String.fromCharCode(...bytes.slice(0,4));window.__callTest.wavRate=new DataView(bytes.buffer).getUint32(24,true);window.__callTest.transcribedModel=options.body.get('model');window.__callTest.wavBodies.push(Array.from(bytes));window.__callTest.transcripts++;
        const recognized=window.__callTest.nextText||'Please explain the new layout.';
        if(window.__callTest.holdTranscription)await new Promise(resolve=>window.__callTest.releaseTranscription=resolve);
        return new Response(JSON.stringify({text:recognized,timings:{recognition_ms:14,queue_ms:0}}),{headers:{'Content-Type':'application/json'}});
      }
      if(path.startsWith('/api/sessions/')&&(!options||!options.method||options.method==='GET')){
        const response=await t.fetch.call(window,url,options), data=await response.json();
        if(Array.isArray(data.messages))for(const call of Object.values(t.calls))if(call.ended&&path==='/api/sessions/'+call.parent_id)data.messages.push({role:'assistant',content:call.summary,call_summary_id:call.id,ts:Date.now()/1000});
        return json(data);
      }
      return window.__callTest.fetch.call(window,url,options);
    };
    localStorage.setItem('kairos:call-conversation:a1',JSON.stringify({endpoint:'fast',model:'llama3.2'}));
    document.querySelector('.side-chat-input').value='My typed draft stays';
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
  await js("document.querySelector('[aria-label=\"Call mode\"]').value='cloud';document.querySelector('[aria-label=\"Call mode\"]').dispatchEvent(new Event('change'))");
  assert.ok(await js("document.querySelector('.agent-call-setup button[type=submit]').disabled&&!document.querySelector('[aria-label=\"Use paid cloud voice for this call\"]').checked"),'Cloud mode stays off without credentials and per-call consent');
  assert.ok(await js("document.querySelector('.agent-call-privacy').textContent.includes('OpenAI')"),'Cloud privacy disclosure matches the actual mode');
  await capture('agents-call-cloud-setup');
  await js("document.querySelector('[aria-label=\"Call mode\"]').value='local';document.querySelector('[aria-label=\"Call mode\"]').dispatchEvent(new Event('change'))");
  await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'").catch(async error=>{ console.log(await js("({error:document.querySelector('.agent-call-error').textContent,state:document.querySelector('.agent-call').dataset.state,opened:window.__callTest.opened,values:[...document.querySelectorAll('.agent-call input')].map(n=>n.value)})")); throw error; });
  await capture('agents-call-active');
  await js("window.__callAppearance=import('/static/js/appearance.js').then(m=>({mode:m.getAppearance().mode,color:m.getAppearance().color}))");
  await js("import('/static/js/appearance.js').then(m=>m.updateAppearance({mode:'color',color:'#192331'}))");
  await capture('agents-call-dark');
  assert.ok(await js("getComputedStyle(document.querySelector('.agent-call')).backgroundColor===getComputedStyle(document.querySelector('.agents-chat-rail')).backgroundColor"),'Call surfaces follow the active Kairos theme');
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
  assert.equal(writes.filter(w=>w.path==='/api/chat/live').length,0,'Call dialogue never enters the ordinary agent chat transport');
  assert.ok(await js("!document.querySelector('.session-chat-messages').textContent.includes('Please explain the new layout.')"),'Raw call dialogue is absent from the main DM');
  assert.ok(await js("JSON.parse(document.querySelector('.agent-call').dataset.callTimings).end_to_audio_ms>=0"),'Speech end to first playback is measured');
  assert.equal(await js("document.querySelector('.side-chat-input').value"),'My typed draft stays','Voice leaves typed drafts intact');
  await waitFor('window.__callTest.played>=1');
  assert.equal(await js('window.__callTest.wavHeader'),'RIFF','Native recognition receives WAV rather than browser WebM');
  assert.equal(await js('window.__callTest.wavRate'),16000,'The actual AudioWorklet captures directly at 16 kHz');
  assert.equal(await js('window.__callTest.prepared'),'small.en','Selected model warms before listening');
  assert.equal(await js('window.__callTest.transcribedModel'),'small.en','Selected model reaches every transcription');
  assert.equal(await js("document.querySelectorAll('.agent-call select[aria-label=\"Call voice\"] option').length"),1,'Only local device voices are offered');
  await js("window.__callTest.current.dispatchEvent(new Event('boundary'));true;");
  assert.equal(await js("document.querySelector('.agent-call-orb').style.getPropertyValue('--word')"),'1','Real word events drive the speaking orb');
  const before=writes.filter(w=>w.path==='/api/chat/live').length;
  await js('window.__callTest.level=.7'); await delay(1600); await js('window.__callTest.level=0');
  assert.equal(writes.filter(w=>w.path==='/api/chat/live').length,before,'Assistant playback cannot record another utterance');
  await click('.agent-call-controls button:first-child');
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  assert.ok(await js('window.__callTest.paused>0'),'Assistant mute stops playback');
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
  await waitFor("document.querySelectorAll('[data-call-summary]').length===1");
  assert.ok(await js("document.querySelector('[data-call-summary]').textContent.includes('Discussed the new layout.')"),'Only the final summary appears in the main DM');
  await js("Object.values(window.__callTest.calls)[0].summary='**Call summary** Updated verified work result.';true;");
  // The saved card is updated through the same callback used by the live
  // work watcher, without repainting the chat or replacing typed drafts.
  await js("document.querySelector('.agent-call-open').click();true;");
  await click('.agent-call .agent-call-header button:last-child');
  assert.equal(await js("document.querySelectorAll('[data-call-summary]').length"),1,'Reopening setup does not duplicate a summary card');
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
  assert.equal(writes.filter(w=>w.path==='/api/chat/live/stop').length,0,'Interrupt leaves ordinary typed agent work alone');
  await js('window.__callTest.holdReply=false');
  await click('.agent-call .is-end');
  await click('.agent-call-open'); await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor("document.querySelector('.agent-call').dataset.state==='listening'");
  await navigate('home');
  assert.ok(await js("!document.querySelector('.agent-call') && window.__callTest.opened===window.__callTest.closed"),'Leaving agents tears down dialog and every microphone track');
  await navigate('agents',{agentId:'a1'});await waitFor("!!document.querySelector('.agent-call-open')");
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
  await navigate('agents',{agentId:'a1'});await waitFor("!!document.querySelector('.agent-call-open')");
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
  await js("window.localStorage.removeItem('kairos:call-input:a1');true;");
  await js('window.__callTest.missingModel=true');await navigate('agents',{agentId:'a1'});await waitFor("!!document.querySelector('.agent-call-open')");
  await click('.agent-call-open');await waitFor("document.querySelector('.agent-call-readiness').textContent.includes('Download the selected')");
  assert.ok(await js("document.querySelector('.agent-call-setup button[type=submit]').disabled"),'Missing model has an honest setup state');
  const downloadsBefore=writes.filter(w=>w.path.includes('/speech/models/')&&w.path.endsWith('/download')).length;
  assert.equal(downloadsBefore,0,'Opening calls never downloads a model automatically');
  await js("[...document.querySelectorAll('.agent-call-setup button')].find(b=>b.textContent==='Download speech model').click()");
  await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");
  assert.equal(writes.filter(w=>w.path.includes('/speech/models/')&&w.path.endsWith('/download')).length,downloadsBefore+1,'User can set up native speech inside the call screen');
  await navigate('home');
  demoState.sidebarBotSessions={a1:[]};
  await navigate('agents',{agentId:'a1'});await waitFor("!!document.querySelector('.agent-call-open')");
  await js('window.__callTest.holdCreation=true;window.__callTest.creationPending=false;true;');
  const lateTurns=await js('window.__callTest.callTurns.length');
  const lateOpened=await js('window.__callTest.opened');
  await click('.agent-call-open');await waitFor("!document.querySelector('.agent-call-setup button[type=submit]').disabled");await js("document.querySelector('.agent-call-setup').requestSubmit()");
  await waitFor('window.__callTest.creationPending');
  await click('.agent-call .agent-call-header button:last-child');
  await js('window.__callTest.releaseCreation();window.__callTest.holdCreation=false;true;');await delay(350);
  assert.equal(await js('window.__callTest.callTurns.length'),lateTurns,'Hangup during first-chat creation cannot submit a late voice turn');
  assert.equal(await js('window.__callTest.opened'),lateOpened,'Late session creation cannot reopen the microphone');
  assert.ok(await js('Object.values(window.__callTest.calls).every(c=>c.ended)'),'Every call record is finalized after cancellation or navigation');
  await navigate('home');delete demoState.sidebarBotSessions;
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
};

import { api, el } from './api.js';
import { createChunker, createSpeaker, _forSpeech } from './voiceOutput.js';
import { readEvents } from './callTransport.js';

// PCM is played as it arrives, with one cancellable generation for network,
// queued sentences and scheduled audio. Stale chunks cannot resume playback.
//
// Sentences are fetched up to AHEAD at a time, so sentence N+1 is already
// rendering (or rendered) while sentence N plays. Audio is scheduled strictly
// in order: a later sentence buffers its decoded chunks until every earlier
// one has finished arriving, then drops straight onto the end of the timeline.
export const PREFETCH_AHEAD = 3;
export function neuralSpeaker(options, getSelection) {
  let context=null, analyser=null, frame=null, generation=0, cancelled=false, sources=new Set(), controllers=new Set();
  let next=0, speaking=false, finished=false, chunker, jobs=[], head=0, count=0, paused=false, lastHeard=[];
  const samples=new Float32Array(256);
  const poke=method=>{try{context?.[method]?.()?.catch?.(()=>{});}catch{}};
  const measure=()=>{if(cancelled||!analyser||!speaking)return;analyser.getFloatTimeDomainData(samples);const level=Math.sqrt(samples.reduce((sum,n)=>sum+n*n,0)/samples.length);options.onLevel?.(Math.min(1,level*7));frame=requestAnimationFrame(measure);};
  const settle=()=>{if(head>=jobs.length&&!sources.size&&finished&&!cancelled){speaking=false;cancelAnimationFrame(frame);options.onLevel?.(0);options.onEnd?.();}};
  // Plays one decoded chunk at the end of the timeline. Only the head sentence ever calls this.
  const schedule=(job,buffer)=> {
    const node=context.createBufferSource();node.buffer=buffer;node.connect(analyser);
    const at=Math.max(context.currentTime+.025,next);next=at+buffer.duration;sources.add(node);
    node.onended=()=>{sources.delete(node);if(job.mine===generation)settle();};node.start(at);
    const wait=Math.max(0,(at-context.currentTime)*1000);
    if(!job.began){job.began=true;job.startAt=at;setTimeout(()=>{if(!cancelled&&job.mine===generation)options.onSentenceStart?.(job.index);},wait);}
    if(!speaking){speaking=true;setTimeout(()=>{if(!cancelled&&job.mine===generation){options.onStart?.();measure();}},wait);}
  };
  const pump=()=> {
    while(head<jobs.length&&!cancelled){
      const job=jobs[head];if(job.mine!==generation)return;
      while(job.chunks.length)schedule(job,job.chunks.shift());
      if(!job.done)return;
      head++;
    }
    settle();
  };
  const launch=()=> {
    for(let i=head;i<Math.min(jobs.length,head+PREFETCH_AHEAD);i++)if(!jobs[i].started){jobs[i].started=true;fetchJob(jobs[i]);}
  };
  async function fetchJob(job) {
    const mine=job.mine, abort=new AbortController();controllers.add(abort);let rate=null, carry=null;
    try {
      await readEvents('/api/agent-calls/speak',{text:job.text,model:job.selection.model,voice:job.selection.voice},abort.signal,event=>{
        if(cancelled||mine!==generation)return;
        if(event.error)throw new Error(event.error);
        if(event.sample_rate)rate=event.sample_rate;
        if(!event.audio)return;
        if(!rate)throw new Error('Voice engine did not specify its audio format.');
        const raw=Uint8Array.from(atob(event.audio),c=>c.charCodeAt(0));
        const bytes=new Uint8Array(raw.length+(carry==null?0:1));if(carry!=null)bytes[0]=carry;bytes.set(raw,carry==null?0:1);
        carry=bytes.length%2?bytes[bytes.length-1]:null;
        const size=Math.floor(bytes.length/2);if(!size)return;
        const buffer=context.createBuffer(1,size,rate), channel=buffer.getChannelData(0), view=new DataView(bytes.buffer);
        for(let i=0;i<size;i++)channel[i]=view.getInt16(i*2,true)/32768;
        job.chunks.push(buffer);pump();
      });
      if(carry!=null)throw new Error('Voice engine returned incomplete audio.');
    } catch(error) {if(!cancelled&&mine===generation&&error.name!=='AbortError')options.onError?.(error.message);}
    finally {
      controllers.delete(abort);
      if(mine===generation&&!cancelled){job.done=true;pump();launch();}
    }
  }
  const enqueue=text=> {
    if(!_forSpeech(text)||cancelled)return;
    const job={raw:text,text:_forSpeech(text),selection:getSelection(),mine:generation,chunks:[],done:false,started:false,began:false,index:count++};
    jobs.push(job);options.onSentenceReady?.(job.index);launch();
  };
  chunker=createChunker(enqueue);
  // Sentences whose audio has reached the output clock. The clock stops while paused, so this is what was really heard.
  const playedNow=()=>context?jobs.filter(job=>job.startAt!=null&&job.startAt<=context.currentTime+.001).map(job=>job.raw):[];
  // An acknowledgement clip ({rate, samples}) goes onto the timeline ahead of the answer, which queues behind it.
  const playClip=clip=>{
    if(cancelled||!context||!clip?.samples?.length||!clip.rate)return;
    const mine=generation, buffer=context.createBuffer(1,clip.samples.length,clip.rate);buffer.copyToChannel(clip.samples,0);
    const node=context.createBufferSource();node.buffer=buffer;node.connect(analyser);
    const at=Math.max(context.currentTime+.025,next);next=at+buffer.duration;sources.add(node);
    node.onended=()=>{sources.delete(node);if(mine!==generation||cancelled)return;if(head>=jobs.length&&!sources.size&&!finished){speaking=false;cancelAnimationFrame(frame);options.onLevel?.(0);options.onEnd?.();}else settle();};
    node.start(at);
    if(!speaking){speaking=true;setTimeout(()=>{if(!cancelled&&mine===generation){options.onStart?.();measure();}},Math.max(0,(at-context.currentTime)*1000));}
  };
  return {
    get speaking(){return speaking;},
    get paused(){return paused;},
    heard(){return jobs.length?playedNow():lastHeard.slice();},
    pause(){if(context&&speaking&&!paused&&!cancelled){paused=true;poke('suspend');}},
    resume(){if(paused){paused=false;poke('resume');}},
    filler:playClip,
    async prepare(){if(!context){context=new AudioContext();analyser=context.createAnalyser();analyser.fftSize=256;analyser.connect(context.destination);}await context.resume();},
    feed(text){if(!cancelled)chunker.feed(text);},
    flushSentence(){if(!cancelled)chunker.flushSentence();},
    finish(){chunker.finish();finished=true;pump();},
    reset(){this.cancel();cancelled=false;finished=false;lastHeard=[];next=context?.currentTime||0;},
    cancel(){lastHeard=jobs.length?playedNow():lastHeard;const wasPaused=paused;paused=false;if(wasPaused)poke('resume');generation++;cancelled=true;jobs=[];head=0;count=0;finished=false;chunker.reset();cancelAnimationFrame(frame);options.onLevel?.(0);controllers.forEach(c=>c.abort());controllers.clear();sources.forEach(s=>{try{s.stop();}catch{}});sources.clear();speaking=false;},
    dispose(){this.cancel();context?.close();context=null;},
  };
}

// The call's two voices behind one speaker, for a caller with no call dialog (Open Mic): the prefetching neural voice
// when the selection says so, otherwise the OS voice. The voice is chosen at reset(), once per reply, so a setting
// changed mid-reply cannot split it between two voices. The 100 ms timer after each delta releases a sentence that
// already ends in punctuation without waiting for the next capital letter, exactly as the call does.
export function createVoiceSpeaker(options, getSelection = () => ({ provider: 'device' }), makeDevice = createSpeaker) {
  const device = makeDevice(options), neural = neuralSpeaker(options, getSelection);
  let current = device, timer = null;
  const pick = () => getSelection()?.provider === 'neural' ? neural : device;
  return {
    get speaking() { return current.speaking; },
    get kind() { return current === neural ? 'neural' : 'device'; },
    heard() { return current.heard(); },
    pause() { current.pause(); },
    resume() { current.resume(); },
    filler(clip) { current.filler(clip); },
    // Creates (and resumes) the audio context a neural voice plays through; the OS voice needs nothing.
    async prepare() { if (pick() === neural) await neural.prepare(); },
    reset() { clearTimeout(timer); current = pick(); current.reset(); },
    feed(text) { current.feed(text); clearTimeout(timer); timer = setTimeout(() => current.flushSentence(), 100); },
    finish() { clearTimeout(timer); current.finish(); },
    cancel() { clearTimeout(timer); device.cancel(); neural.cancel(); },
    dispose() { this.cancel(); neural.dispose(); },
  };
}

export function voiceSettings(agent, deviceSelect, callbacks) {
  const key=`kairos:neural-voice:${agent.id}`;let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}');}catch{}
  const provider=el('select',{'aria-label':'Voice provider'},[el('option',{value:'device',text:'Device voice'}),el('option',{value:'neural',text:'Local neural voice'})]);provider.value=saved.provider||'device';
  const model=el('select',{'aria-label':'Neural voice engine'}), voice=el('select',{'aria-label':'Neural voice profile'});
  const details=el('p',{class:'agent-call-voice-status',role:'status'});
  const url=el('input',{type:'url','aria-label':'Local voice server URL',placeholder:'http://127.0.0.1:8000'});
  const protocol=el('select',{'aria-label':'Local voice server protocol'},[el('option',{value:'voicestudio',text:'VoiceStudio'}),el('option',{value:'compatible',text:'Kokoro / compatible'}),el('option',{value:'kokoro',text:'Kokoro (built in, download in Settings > Speech)'})]);
  const persist=()=>{saved={provider:provider.value,model:model.value,voice:voice.value};try{localStorage.setItem(key,JSON.stringify(saved));}catch{}sync();};
  const refresh=async()=>{details.textContent='Checking local voices…';try{const data=await api('/api/agent-calls/voices');url.value=data.protocol==='kokoro'?'':data.url;protocol.value=data.protocol;model.replaceChildren(...data.models.map(id=>el('option',{value:id,text:id})));voice.replaceChildren(...data.voices.map(v=>el('option',{value:v.id,text:v.name})));if(data.models.includes(saved.model))model.value=saved.model;if(data.voices.some(v=>v.id===saved.voice))voice.value=saved.voice;if(data.protocol==='kokoro'&&data.error&&provider.value==='neural'){provider.value='device';persist();}details.textContent=data.error|| (data.url?'Installed engines only. PocketTTS favors speed; OmniVoice favors voice design.':'Connect an installed local voice server. No models download automatically.');}catch(e){details.textContent=e.message;}sync();};
  const connect=el('button',{type:'button',class:'btn quiet',text:'Connect voices',onclick:async()=>{connect.disabled=true;try{await api('/api/agent-calls/voices',{method:'PUT',body:JSON.stringify({url:url.value,protocol:protocol.value})});await refresh();}catch(e){details.textContent=e.message;}finally{connect.disabled=false;}}});
  const local=el('div',{},[el('label',{},[el('span',{text:'Engine'}),model]),el('label',{},[el('span',{text:'Voice profile'}),voice]),el('details',{},[el('summary',{text:'Connect local voices'}),url,protocol,connect,el('button',{type:'button',class:'btn quiet',text:'Refresh voices',onclick:refresh})]),details]);
  const device=deviceSelect.closest('label');
  const sync=()=>{local.hidden=provider.value!=='neural';if(device)device.hidden=provider.value!=='device';callbacks.changed?.();};
  provider.onchange=model.onchange=voice.onchange=persist;
  return { node:el('div',{class:'agent-call-voice-settings'},[el('label',{},[el('span',{text:'Voice provider'}),provider]),local]),load:refresh,
    selection:()=>({provider:provider.value,model:model.value,voice:voice.value}),ready:()=>provider.value==='device'||!!(model.value&&voice.value),sync,
  };
}

import { api, el } from './api.js';
import { createChunker, _forSpeech } from './voiceOutput.js';
import { readEvents } from './callTransport.js';

// PCM is played as it arrives, with one cancellable generation for network,
// queued sentences and scheduled audio. Stale chunks cannot resume playback.
export function neuralSpeaker(options, getSelection) {
  let context=null, analyser=null, frame=null, generation=0, cancelled=false, queue=Promise.resolve(), sources=new Set(), controllers=new Set();
  let next=0, speaking=false, pending=0, finished=false, chunker;
  const samples=new Float32Array(256);
  const measure=()=>{if(cancelled||!analyser||!speaking)return;analyser.getFloatTimeDomainData(samples);const level=Math.sqrt(samples.reduce((sum,n)=>sum+n*n,0)/samples.length);options.onLevel?.(Math.min(1,level*7));frame=requestAnimationFrame(measure);};
  const settle=()=>{if(!pending&&!sources.size&&finished&&!cancelled){speaking=false;cancelAnimationFrame(frame);options.onLevel?.(0);options.onEnd?.();}};
  const enqueue=text=> {
    text=_forSpeech(text);if(!text||cancelled)return;
    const mine=generation, selection=getSelection(); pending++;
    queue=queue.then(async()=> {
      if(cancelled||mine!==generation)return;
      const abort=new AbortController();controllers.add(abort);let rate=null, carry=null;
      try {
        await readEvents('/api/agent-calls/speak',{text,model:selection.model,voice:selection.voice},abort.signal,event=>{
          if(cancelled||mine!==generation)return;
          if(event.error)throw new Error(event.error);
          if(event.sample_rate)rate=event.sample_rate;
          if(!event.audio)return;
          if(!rate)throw new Error('Voice engine did not specify its audio format.');
          const raw=Uint8Array.from(atob(event.audio),c=>c.charCodeAt(0));
          const bytes=new Uint8Array(raw.length+(carry==null?0:1));if(carry!=null)bytes[0]=carry;bytes.set(raw,carry==null?0:1);
          carry=bytes.length%2?bytes[bytes.length-1]:null;
          const count=Math.floor(bytes.length/2);if(!count)return;
          const buffer=context.createBuffer(1,count,rate), samples=buffer.getChannelData(0), view=new DataView(bytes.buffer);
          for(let i=0;i<count;i++)samples[i]=view.getInt16(i*2,true)/32768;
          const node=context.createBufferSource();node.buffer=buffer;node.connect(analyser);
          const at=Math.max(context.currentTime+.025,next);next=at+buffer.duration;sources.add(node);
          node.onended=()=>{sources.delete(node);if(mine===generation)settle();};node.start(at);
          if(!speaking){speaking=true;setTimeout(()=>{if(!cancelled&&mine===generation){options.onStart?.();measure();}},Math.max(0,(at-context.currentTime)*1000));}
        });
        if(carry!=null)throw new Error('Voice engine returned incomplete audio.');
      } catch(error) {if(!cancelled&&mine===generation&&error.name!=='AbortError')options.onError?.(error.message);}
      finally {controllers.delete(abort);}
    }).finally(()=>{if(mine===generation){pending--;settle();}});
  };
  chunker=createChunker(enqueue);
  return {
    get speaking(){return speaking;},
    async prepare(){if(!context){context=new AudioContext();analyser=context.createAnalyser();analyser.fftSize=256;analyser.connect(context.destination);}await context.resume();},
    feed(text){if(!cancelled)chunker.feed(text);},
    flushSentence(){if(!cancelled)chunker.flushSentence();},
    finish(){chunker.finish();finished=true;settle();},
    reset(){this.cancel();cancelled=false;finished=false;next=context?.currentTime||0;queue=Promise.resolve();},
    cancel(){generation++;cancelled=true;pending=0;finished=false;chunker.reset();cancelAnimationFrame(frame);options.onLevel?.(0);controllers.forEach(c=>c.abort());controllers.clear();sources.forEach(s=>{try{s.stop();}catch{}});sources.clear();speaking=false;},
    dispose(){this.cancel();context?.close();context=null;},
  };
}

export function voiceSettings(agent, deviceSelect, callbacks) {
  const key=`kairos:neural-voice:${agent.id}`;let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}');}catch{}
  const provider=el('select',{'aria-label':'Voice provider'},[el('option',{value:'device',text:'Device voice'}),el('option',{value:'neural',text:'Local neural voice'})]);provider.value=saved.provider||'device';
  const model=el('select',{'aria-label':'Neural voice engine'}), voice=el('select',{'aria-label':'Neural voice profile'});
  const details=el('p',{class:'agent-call-voice-status',role:'status'});
  const url=el('input',{type:'url','aria-label':'Local voice server URL',placeholder:'http://127.0.0.1:8000'});
  const protocol=el('select',{'aria-label':'Local voice server protocol'},[el('option',{value:'voicestudio',text:'VoiceStudio'}),el('option',{value:'compatible',text:'Kokoro / compatible'})]);
  const persist=()=>{saved={provider:provider.value,model:model.value,voice:voice.value};try{localStorage.setItem(key,JSON.stringify(saved));}catch{}sync();};
  const refresh=async()=>{details.textContent='Checking local voices…';try{const data=await api('/api/agent-calls/voices');url.value=data.url;protocol.value=data.protocol;model.replaceChildren(...data.models.map(id=>el('option',{value:id,text:id})));voice.replaceChildren(...data.voices.map(v=>el('option',{value:v.id,text:v.name})));if(data.models.includes(saved.model))model.value=saved.model;if(data.voices.some(v=>v.id===saved.voice))voice.value=saved.voice;details.textContent=data.error|| (data.url?'Installed engines only. PocketTTS favors speed; OmniVoice favors voice design.':'Connect an installed local voice server. No models download automatically.');}catch(e){details.textContent=e.message;}sync();};
  const connect=el('button',{type:'button',class:'btn quiet',text:'Connect voices',onclick:async()=>{connect.disabled=true;try{await api('/api/agent-calls/voices',{method:'PUT',body:JSON.stringify({url:url.value,protocol:protocol.value})});await refresh();}catch(e){details.textContent=e.message;}finally{connect.disabled=false;}}});
  const local=el('div',{},[el('label',{},[el('span',{text:'Engine'}),model]),el('label',{},[el('span',{text:'Voice profile'}),voice]),el('details',{},[el('summary',{text:'Connect local voices'}),url,protocol,connect,el('button',{type:'button',class:'btn quiet',text:'Refresh voices',onclick:refresh})]),details]);
  const device=deviceSelect.closest('label');
  const sync=()=>{local.hidden=provider.value!=='neural';if(device)device.hidden=provider.value!=='device';callbacks.changed?.();};
  provider.onchange=model.onchange=voice.onchange=persist;
  return { node:el('div',{class:'agent-call-voice-settings'},[el('label',{},[el('span',{text:'Voice provider'}),provider]),local]),load:refresh,
    selection:()=>({provider:provider.value,model:model.value,voice:voice.value}),ready:()=>provider.value==='device'||!!(model.value&&voice.value),sync,
  };
}

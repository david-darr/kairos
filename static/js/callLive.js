import { api } from './api.js';

export function liveVoice(onState,onCaption,onLevel,onError) {
  let peer=null, stream=null, audio=null, context=null, frame=null, channel=null;
  let generation=0, muted=false, timeout=null, rejectStartup=null;
  const cleanup=()=>{generation++;clearTimeout(timeout);rejectStartup?.(new Error('Cloud call ended.'));rejectStartup=null;cancelAnimationFrame(frame);stream?.getTracks().forEach(t=>t.stop());peer?.close();context?.close();if(audio){audio.pause();audio.srcObject=null;audio.remove();}peer=stream=audio=context=channel=null;};
  return {
    async start(id,endpoint,voice,paidConsent) {
      cleanup();const mine=generation;
      try {
        const captured=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
        if(mine!==generation){captured.getTracks().forEach(t=>t.stop());return;}
        stream=captured;
        peer=new RTCPeerConnection();stream.getTracks().forEach(track=>peer.addTrack(track,stream));
        audio=document.createElement('audio');audio.autoplay=true;document.body.append(audio);
        context=new AudioContext();await context.resume();let analyser=null;
        let lastState='';const samples=new Float32Array(256);
        peer.ontrack=event=>{if(mine!==generation)return;const incoming=event.streams[0]||new MediaStream([event.track]);audio.srcObject=incoming;audio.play().catch(()=>onError('Allow voice audio playback on this device.'));const source=context.createMediaStreamSource(incoming);analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);};
        const measure=()=>{if(mine!==generation)return;if(analyser){analyser.getFloatTimeDomainData(samples);const level=muted?0:Math.sqrt(samples.reduce((sum,n)=>sum+n*n,0)/samples.length);onLevel(Math.min(1,level*7));const next=level>.008?'speaking':'listening';if(next!==lastState){lastState=next;onState(next);}}frame=requestAnimationFrame(measure);};measure();
        channel=peer.createDataChannel('oai-events');
        let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;rejectStartup=reject;});ready.catch(()=>{});
        timeout=setTimeout(()=>rejectReady(new Error('Cloud voice startup timed out.')),20000);
        channel.onmessage=event=>{if(mine!==generation)return;try{const item=JSON.parse(event.data);if(item.type==='session.started'){clearTimeout(timeout);resolveReady();onState('listening');}if(item.type==='session.closed'){clearTimeout(timeout);rejectReady(new Error('Cloud call ended.'));cleanup();onState('ended');}if(item.type?.endsWith('transcript.delta'))onCaption(item.type.includes('input')?'You':'Agent',item.delta);if(item.type==='error')onError('Cloud voice reported an error. Check the connection.');}catch{}};
        peer.onconnectionstatechange=()=>{if(mine===generation&&['failed','disconnected'].includes(peer?.connectionState)){clearTimeout(timeout);rejectReady(new Error('Cloud voice connection lost.'));onError('Cloud voice connection lost. End the call and reconnect.');}};
        const offer=await peer.createOffer();await peer.setLocalDescription(offer);
        const answer=await api(`/api/agent-calls/${id}/live`,{method:'POST',body:JSON.stringify({endpoint_id:endpoint,sdp:offer.sdp,voice,paid_consent:paidConsent})});
        if(mine!==generation)return;
        await peer.setRemoteDescription({type:'answer',sdp:answer.sdp});await ready;
      } catch(error){cleanup();throw error;}
    },
    muteMicrophone(value){stream?.getAudioTracks().forEach(t=>{t.enabled=!value;});},
    muteAssistant(value){muted=value;if(audio)audio.muted=muted;},
    // Server-side close drains final transcripts before summary. Local tracks
    // stop immediately on hangup; no key or trusted tool events reach the UI.
    stop:cleanup,
  };
}

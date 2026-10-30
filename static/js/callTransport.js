import { api } from './api.js';

export async function readEvents(path, body, signal, onEvent, keepalive = false) {
  const response = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal, keepalive });
  if (!response.ok) { let error; try { error=(await response.json()).detail; } catch {} throw new Error(error || `Call request failed (${response.status})`); }
  const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='';
  try {
    while (true) {
      const {done,value}=await reader.read(); buffer+=decoder.decode(value,{stream:!done});
      let at; while ((at=buffer.indexOf('\n'))>=0) { const line=buffer.slice(0,at); buffer=buffer.slice(at+1); if (line.trim()) onEvent(JSON.parse(line)); }
      if (buffer.length>3000000) throw new Error('Call stream exceeded its limit.');
      if (done) { if(buffer.trim()) onEvent(JSON.parse(buffer)); break; }
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

export function callTransport(controller, onStatus) {
  let record=null, abort=null, poll=null, disposed=false, epoch=0, savedSummary='';
  async function check() {
    if (!record || disposed) return;
    const ident=record.id, mine=epoch;
    try { const next=await api(`/api/agent-calls/${ident}`);if(mine!==epoch||disposed)return;record=next; onStatus?.(record); if(record.summary_state==='saved'&&savedSummary!==record.summary){await controller.summarySaved?.(record);savedSummary=record.summary;} }
    catch {}
    if (!disposed && record && (!record.ended || record.summary_state==='pending' || record.summary_state==='saved'&&savedSummary!==record.summary || record.jobs.some(j=>['running','ready'].includes(j.status)))) poll=setTimeout(check,2000);
  }
  const finish=async()=> {
    if (!record || record.ended) return;
    abort?.abort(); clearTimeout(poll);
    const ident=record.id,mine=epoch; record={...record,ended:true};
    try { const next=await api(`/api/agent-calls/${ident}/end`,{method:'POST',keepalive:true,toast:false});if(mine!==epoch||disposed)return;record=next;onStatus?.(record); }
    catch { /* The heartbeat timeout recovers a disconnected call. */ }
    if(!disposed) check();
  };
  const unload=()=>{if(record&&!record.ended) navigator.sendBeacon(`/api/agent-calls/${record.id}/end`,new Blob(['{}'],{type:'application/json'}));};
  window.addEventListener('pagehide',unload);
  return {
    get record(){return record;},
    async start(agent,endpoint,model) { clearTimeout(poll);const mine=++epoch; const parent_id=await controller.ensureSession(); const room_id=controller.roomId?.()||null; const next=await api('/api/agent-calls',{method:'POST',body:JSON.stringify({parent_id,agent_id:controller.agentId?.()||agent.id,endpoint_id:endpoint,model:model||null,...(room_id?{room_id}:{})})});if(disposed||mine!==epoch){api(`/api/agent-calls/${next.id}/end`,{method:'POST',keepalive:true,toast:false}).catch(()=>{});throw new Error('Call ended during setup.');}record=next;savedSummary='';check(); return record; },
    async turn(text,onEvent) { abort=new AbortController(); const current=abort; try {await readEvents(`/api/agent-calls/${record.id}/turn`,{text,request_id:crypto.randomUUID()},current.signal,onEvent);}finally{if(abort===current)abort=null;} },
    async update(taskId,onEvent) {abort=new AbortController();const current=abort;try{await readEvents(`/api/agent-calls/${record.id}/work/${taskId}/update`,{},current.signal,onEvent);}finally{if(abort===current)abort=null;}},
    interrupt(){abort?.abort();if(record&&!record.ended)api(`/api/agent-calls/${record.id}/interrupt`,{method:'POST',toast:false}).catch(()=>{});},
    stopWork(id){return api(`/api/agent-calls/${record.id}/work/${id}/stop`,{method:'POST'}).then(check);},
    end:finish,
    dispose(){finish();disposed=true;epoch++;clearTimeout(poll);window.removeEventListener('pagehide',unload);},
  };
}

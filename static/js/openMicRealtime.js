// Open Mic in realtime mode (build spec 6b): when the chat's bot is set to Realtime and has a realtime connection, Open Mic
// is a realtime native call held on this chat instead of the local listen / transcribe / answer loop. Same hand-off as a
// call: real work goes to the bot's own model and tools and is spoken when done; the call summary lands in this chat.
// Returns null (use the local Open Mic) whenever any of that is not in place.
import { api } from './api.js';
import { realtimeVoice } from './realtimeVoice.js';

export async function createRealtimeOpenMic(sessionId, { onState, onError } = {}) {
  let session, agent, choices, prefs;
  try { session = await api(`/api/sessions/${sessionId}`, { toast: false }); } catch { return null; }
  if (!session?.agent_id) return null;
  try {
    [agent, choices, prefs] = await Promise.all([
      api(`/api/agents/${session.agent_id}`, { toast: false }),
      api('/api/agent-calls/realtime-choices', { toast: false }),
      api('/api/agent-calls/realtime-settings', { toast: false }).catch(() => null)]);
  } catch { return null; }
  if (agent?.call_mode !== 'realtime') return null;
  const own = prefs?.bots?.[agent.id] || {};
  const choice = (choices || []).find(item => item.id === (own.endpoint_id || prefs?.endpoint_id));
  // The call's summary is written by the chat's own model, as for any call.
  const summaryEndpoint = session.model_endpoint_id || agent.endpoint_id;
  if (!choice || !summaryEndpoint) return null;
  let callId = null, ended = false;
  const voice = realtimeVoice(
    next => { if (next === 'ended') { ended = true; onState?.('idle'); } else onState?.(next === 'speaking' ? 'speaking' : 'listening'); },
    () => {}, () => {}, message => onError?.(message), () => {});
  const finish = () => { if (callId && !ended) { ended = true; api(`/api/agent-calls/${callId}/end`, { method: 'POST', toast: false, keepalive: true }).catch(() => {}); } };
  return {
    realtime: true,
    // Choosing Realtime for this bot and a connection is the person's paid consent for its calls and Open Mic.
    async start() {
      try {
        const call = await api('/api/agent-calls', { method: 'POST', body: JSON.stringify({ parent_id: sessionId, agent_id: agent.id, endpoint_id: summaryEndpoint, model: session.model || null }) });
        callId = call.id;
        await voice.start(call.id, choice.id, own.voice || prefs?.voice || choice.default_voice, true);
        onState?.('listening');
        return true;
      } catch (error) { onError?.(error.message || 'Realtime Open Mic could not start.'); finish(); voice.stop(); return false; }
    },
    stop() { voice.stop(); finish(); },
  };
}

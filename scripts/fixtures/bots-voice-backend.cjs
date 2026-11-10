// Voice lane. Never claims a route unless botsVoice was explicitly seeded.
const wav = () => {
  const bytes = Buffer.alloc(44 + 4800); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4800, 40); return bytes;
};
module.exports = ({ state }) => {
  const lane = () => state.botsLive && state.botsVoice;
  const settings = s => s.settings ||= { voice: 'marin', read_typed: false, idle_minutes: 5 };
  return {
    read(route) {
      const s = lane(); if (!s) return undefined;
      if (route === '/api/bot-voice/voices') return s.catalog || { voices: [], models: [] };
      if (route === '/api/bot-voice/live-settings') return settings(s);
      if (s.callsEnabled) {
        if (route === '/api/agent-calls/choices') return [{ id: 'voice-check-model', name: 'Voice check model', model: 'fixture', kind: 'local' }];
        if (route === '/api/agent-calls/voices') return { url: '', protocol: 'compatible', voices: [], models: [] };
        if (route.startsWith('/api/agent-calls/pending/')) return [];
        if (route === '/api/speech/status') return { engine_available: true, call_model: 'small.en', acceleration: { supported: false }, models: [{ name: 'small.en', label: 'Small', size_mb: 1, downloaded: true }] };
        const call = /^\/api\/agent-calls\/([a-f0-9]{32})$/.exec(route);
        if (call) return s.calls?.[call[1]] || { _status: 404, detail: 'Call not found' };
      }
      const note = /^\/api\/bot-voice\/notes\/([a-f0-9]{32})\/(audio|transcript)$/.exec(route);
      if (!note) return undefined;
      if (!s.notes?.[note[1]]) return { _status: 404, detail: 'Voice note not found' };
      return note[2] === 'audio' ? { _audioWav: wav().toString('base64') } : { transcript: s.notes[note[1]].transcript };
    },
    mutate(route, method, body = {}) {
      const s = lane(); if (!s) return undefined;
      if (s.callsEnabled) {
        if (route === '/api/speech/prepare' && method === 'POST') return { prepare_ms: 1, engine: 'cpu' };
        if (route === '/api/agent-calls' && method === 'POST') {
          const id = ((s.callCounter = (s.callCounter || 0) + 1)).toString(16).padStart(32, '0');
          s.calls ||= {}; return s.calls[id] = { id, parent_id: body.parent_id, agent_id: body.agent_id, room_id: body.room_id || null, ended: false, summary_state: 'open', jobs: [] };
        }
        const match = /^\/api\/agent-calls\/([a-f0-9]{32})\/(prepare|end|interrupt)$/.exec(route);
        if (match && method === 'POST') {
          const call = s.calls?.[match[1]];
          if (!call) return { _status: 404, detail: 'Call not found' };
          if (match[2] === 'end') { call.ended = true; call.summary_state = 'saved'; call.summary = 'Call ended.'; }
          (s.log ||= []).push({ route, method }); return match[2] === 'prepare' ? { prepare_ms: 1 } : call;
        }
      }
      if (route === '/api/bot-voice/live-settings' && method === 'PUT') {
        if (!Number.isInteger(body.idle_minutes) || body.idle_minutes < 1 || body.idle_minutes > 60 || !['marin', 'cedar', 'coral', 'sage', 'ash'].includes(body.voice) || typeof body.read_typed !== 'boolean') return { _status: 422, detail: 'Invalid call settings' };
        (s.log ||= []).push({ route, body }); return s.settings = { ...body };
      }
      if (route === '/api/bot-voice/speak/prepare' && method === 'POST') {
        (s.log ||= []).push({ route, body });
        if (/private key|password\s*[:=]|\bsk-[a-z0-9_-]{12,}/i.test(body.text)) return { blocks: [], withheld: true };
        const sentences = String(body.text || '').split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).map(t => t.trim()).filter(Boolean);
        return { blocks: sentences.slice(0, 1).concat(Array.from({ length: Math.ceil((sentences.length - 1) / 2) }, (_, i) => sentences.slice(1 + i * 2, 3 + i * 2).join(' '))), withheld: false };
      }
      const match = /^\/api\/bot-voice\/([^/]+)\/notes$/.exec(route);
      if (!match || method !== 'POST') return undefined;
      if (!state.botsCore?.agents?.some?.(bot => bot.id === match[1]) && !s.botIds?.includes(match[1])) return { _status: 404, detail: 'Bot not found' };
      if (!body.text?.trim() || body.text.length > 1000) return { _status: 422, detail: 'A voice note needs 1 to 1,000 characters.' };
      if (!s.catalog?.models?.length) return { _status: 409, detail: 'A voice note needs a local voice engine' };
      const id = (++s.counter || (s.counter = 1)).toString(16).padStart(32, '0');
      s.notes ||= {}; s.notes[id] = { transcript: body.text };
      return { url: `/api/bot-voice/notes/${id}/audio`, seconds: .1, transcript: body.text, transcript_url: `/api/bot-voice/notes/${id}/transcript` };
    },
  };
};

import { api } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';

export function renderVoiceNoteRow(message, ctx = {}) {
  loadBotsCss('/static/css/bots-voice.css');
  const note = message.voice_note || {};
  const safe = value => typeof value === 'string' && /^\/api\/bot-voice\/notes\/[a-f0-9]{32}\/(audio|transcript)$/.test(value);
  const root = h('section', { class: 'bots-voice-note', 'data-section': 'voice-note', 'aria-label': 'Voice note' });
  if (!safe(note.url)) { root.append(h('p', { text: 'This voice note is unavailable.' })); return root; }
  const audio = h('audio', { controls: true, preload: 'metadata', src: note.url, 'aria-label': 'Play voice note' });
  const transcript = h('p', { hidden: true, class: 'bots-voice-transcript' });
  let dead = false, loaded = false;
  const abort = new AbortController();
  const toggle = Button({ label: 'Show transcript', onClick: async () => {
    const open = transcript.hidden; transcript.hidden = !open;
    toggle.textContent = open ? 'Hide transcript' : 'Show transcript'; toggle.setAttribute('aria-expanded', String(open));
    if (!open || loaded) return;
    transcript.textContent = 'Loading transcript...';
    try {
      if (!safe(note.transcript_url)) throw new Error('Unavailable');
      const data = await api(note.transcript_url, { signal: abort.signal, toast: false });
      if (!dead) { transcript.textContent = data.transcript; loaded = true; }
    } catch { if (!dead) transcript.textContent = 'Transcript could not load. Close and try again.'; }
  } });
  toggle.setAttribute('aria-expanded', 'false');
  root.append(audio, toggle, transcript);
  root.destroy = () => { if (dead) return; dead = true; abort.abort(); audio.pause(); audio.removeAttribute('src'); audio.load(); };
  ctx.signal?.addEventListener('abort', root.destroy, { once: true });
  return root;
}

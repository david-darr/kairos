import { api } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';

export function mountCallBar({ agent, members = null, snapshot, mute, hangup, restore, onSettings }) {
  loadBotsCss('/static/css/bots-voice.css');
  const root = h('section', { class: 'bots-call-bar', 'data-section': 'call', 'data-floating': '', 'data-app-mode': 'bots', 'aria-label': 'Current call' });
  const clock = h('span', { 'data-call-clock': '', role: 'status' });
  const muteButton = Button({ label: 'Mute', onClick: () => mute() });
  const back = Button({ label: 'Return to call', onClick: restore });
  const settings = Button({ label: 'Call settings', onClick: () => { restore(); onSettings?.(); } });
  const people = members?.length ? h('span', { class: 'bots-call-members', text: `With ${members.join(', ')}` }) : null;
  root.append(h('span', { class: 'bots-call-dot', 'aria-hidden': 'true' }), clock, people, muteButton,
    Button({ label: 'Hang up', onClick: hangup }), settings, back);
  document.body.append(root);
  function refresh() {
    const state = snapshot();
    const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    clock.textContent = `${members ? 'Group call in' : 'Call with'} ${agent.name} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    root.hidden = !state.active || !state.minimized;
    muteButton.textContent = state.muted ? 'Unmute' : 'Mute'; muteButton.setAttribute('aria-pressed', String(state.muted));
    // The current conversation gets the bar above its composer. Else it is a return pill.
    const composer = document.querySelector(agent.roomId ? `.bots-room[data-room-id="${CSS.escape(agent.roomId)}"] .bots-composer` : `[data-agent-id="${CSS.escape(agent.id)}"] .bots-composer`);
    if (composer && state.minimized) { composer.before(root); delete root.dataset.floating; }
    else if (!root.dataset.floating && !composer) { document.body.append(root); root.dataset.floating = ''; }
  }
  const key = event => {
    if (event.repeat || !snapshot().active || !snapshot().minimized || !(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
    if (event.key.toLowerCase() === 'm') { event.preventDefault(); mute(); }
    if (event.key.toLowerCase() === 'h') { event.preventDefault(); hangup(); }
  };
  document.addEventListener('keydown', key);
  const timer = setInterval(refresh, 1000); refresh();
  return { refresh, destroy() { clearInterval(timer); document.removeEventListener('keydown', key); root.remove(); } };
}

export async function mountLiveSettings(host, ctx = {}) {
  loadBotsCss('/static/css/bots-voice.css');
  const abort = new AbortController(); let dead = false;
  const root = h('section', { class: 'bots-live-settings', 'data-section': 'bot-voice' }); host.replaceChildren(root);
  async function refresh() {
    root.replaceChildren(h('p', { text: 'Loading call settings...' }));
    try {
      const data = await api('/api/bot-voice/live-settings', { signal: abort.signal, toast: false }); if (dead) return;
      const voice = h('select', { 'aria-label': 'Live voice' }, ['marin', 'cedar', 'coral', 'sage', 'ash'].map(value => h('option', { value, text: value })));
      voice.value = data.voice;
      const typed = h('input', { type: 'checkbox', 'aria-label': 'Read typed replies' }); typed.checked = data.read_typed;
      const idle = h('input', { type: 'number', min: 1, max: 60, value: data.idle_minutes, 'aria-label': 'Idle minutes' });
      const status = h('p', { role: 'status' });
      const save = Button({ label: 'Save', onClick: async () => {
        if (!idle.checkValidity()) { idle.reportValidity(); return; }
        save.disabled = true;
        try { const settings = await api('/api/bot-voice/live-settings', { method: 'PUT', signal: abort.signal, toast: false, body: JSON.stringify({ voice: voice.value, read_typed: typed.checked, idle_minutes: Number(idle.value) }) });
          if (!dead) { status.textContent = 'Saved'; document.dispatchEvent(new CustomEvent('kairos:bots-live-settings', { detail: settings })); }
        } catch { if (!dead) status.textContent = 'Call settings could not save. Try again.'; } finally { save.disabled = false; }
      } });
      root.replaceChildren(h('h2', { text: 'Voice' }), h('p', { text: 'Voice changes apply to your next call.' }), h('label', {}, [h('span', { text: 'Live voice' }), voice]),
        h('label', {}, [h('span', { text: 'Read typed replies' }), typed]), h('label', {}, [h('span', { text: 'End an idle call after minutes' }), idle]), save, status);
    } catch { if (!dead) root.replaceChildren(h('p', { text: 'Call settings could not load.' }), Button({ label: 'Retry', onClick: refresh })); }
  }
  const destroy = () => { dead = true; abort.abort(); root.remove(); };
  ctx.signal?.addEventListener('abort', destroy, { once: true }); refresh();
  return { destroy, refresh, flush: async () => ({ ok: true }) };
}

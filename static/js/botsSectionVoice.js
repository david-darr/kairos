import { api } from './api.js';
import { h, Card, SwitchRow, Button, loadBotsCss } from './botsUi.js';

export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-voice.css');
  let dead = false, version = 0;
  const abort = new AbortController();
  const root = h('section', { class: 'bots-section-voice', 'data-section': 'voice', 'aria-label': 'Voice and alerts' });
  host.replaceChildren(root);
  const change = patch => ctx.update?.(patch);
  async function refresh() {
    const mine = ++version;
    root.replaceChildren(h('p', { role: 'status', text: 'Loading voices...' }));
    try {
      const [catalog, live] = await Promise.all([api('/api/bot-voice/voices', { signal: abort.signal, toast: false }), api('/api/agent-calls/live-choices', { signal: abort.signal, toast: false })]);
      if (dead || mine !== version) return;
      const bot = ctx.state?.agent || {};
      const voices = h('select', { 'aria-label': 'Bot voice' }, [h('option', { value: '', text: 'Device voice' }),
        ...(catalog.voices || []).map(v => h('option', { value: v.id, text: v.name || v.id }))]);
      if (bot.voice_id && !catalog.voices.some(v => v.id === bot.voice_id)) voices.append(h('option', { value: bot.voice_id, text: 'Saved voice (unavailable)' }));
      voices.value = bot.voice_id || ''; voices.onchange = () => change({ voice_id: voices.value || null });
      const mode = h('select', { 'aria-label': 'Call mode' }, [h('option', { value: 'turns', text: 'Turns' }), ...(live.length ? [h('option', { value: 'live', text: 'Live' })] : [])]);
      mode.value = bot.call_mode === 'live' && live.length ? 'live' : 'turns'; mode.onchange = () => change({ call_mode: mode.value });
      root.replaceChildren(Card({ label: 'Voice and alerts', children: [
        h('label', { class: 'bots-row' }, [h('span', { text: 'Voice' }), voices]),
        SwitchRow({ title: 'Speak replies', hint: 'Read replies aloud on this device.', checked: !!bot.speak_replies, onChange: value => change({ speak_replies: value }) }),
        h('label', { class: 'bots-row' }, [h('span', { text: 'Call mode' }), mode]),
        SwitchRow({ title: 'Alerts', checked: bot.notifications !== false, onChange: value => change({ notifications: value }) }),
      ] }), h('p', { role: 'status', text: catalog.error || (!catalog.voices.length ? 'Connect a local engine in Settings > Speech for voice notes.' : 'Voice notes use the local voice engine.') }));
    } catch { if (!dead) root.replaceChildren(h('p', { text: 'Voice settings could not load.' }), Button({ label: 'Retry', onClick: refresh })); }
  }
  const destroy = () => { dead = true; version++; abort.abort(); root.remove(); };
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  refresh();
  return { destroy, refresh, flush: async () => ctx.flush?.() };
}

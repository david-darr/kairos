import { api } from './api.js';
import { h, Card, SwitchRow, Button, NavRow, loadBotsCss } from './botsUi.js';
import { applyBotsPrefs, getPref, setPref } from './botsPrefs.js';

export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-prefs.css'); applyBotsPrefs();
  const abort = new AbortController(); let dead = false;
  const root = h('section', { 'data-bots-settings': '', 'data-section': 'bots', 'aria-label': 'Bots preferences' });
  const status = h('p', { role: 'status' });
  const choose = (name, title, options) => {
    const select = h('select', { 'aria-label': title }, options.map(([value, text]) => h('option', { value, text })));
    select.value = getPref(name); select.onchange = () => { setPref(name, select.value); status.textContent = 'Saved on this device.'; };
    return h('label', { class: 'bots-row' }, [h('span', { class: 'bots-row-title', text: title }), select]);
  };
  const toggle = (name, title) => SwitchRow({ title, checked: getPref(name) === 'true', onChange: value => { setPref(name, String(value)); status.textContent = 'Saved on this device.'; } });
  const replay = async (path, name) => {
    try {
      const module = await import(path);
      if (dead) return;
      if (name === 'welcome') await module.openWelcome({ force: true, signal: abort.signal });
      else {
        // Close Settings before looking for anchors in the conversation behind it.
        ctx.close?.();
        await module.openTour();
      }
    } catch { if (!dead) status.textContent = `${name === 'welcome' ? 'Welcome' : 'Tour'} could not load. Try again.`; }
  };
  const defaults = NavRow({ title: 'New bot defaults', onClick: async () => {
    try { const { openBotDefaults } = await import('./botsCreate.js'); if (!dead) await openBotDefaults(); }
    catch { if (!dead) status.textContent = 'New bot defaults could not load. Try again.'; }
  } });
  const concurrency = h('select', { 'aria-label': 'Thread concurrency', disabled: true }, Array.from({ length: 16 }, (_, i) => h('option', { value: i + 1, text: String(i + 1) })));
  concurrency.onchange = async () => {
    concurrency.disabled = true;
    try { await api('/api/agents/defaults', { method: 'PUT', signal: abort.signal, toast: false, body: JSON.stringify({ thread_limit: Number(concurrency.value) }) }); if (!dead) status.textContent = 'New bot default saved.'; }
    catch { if (!dead) status.textContent = 'Thread limit could not save. Try again.'; } finally { if (!dead) concurrency.disabled = false; }
  };
  root.append(h('h2', { text: 'Bots' }), h('p', { text: 'Preferences for this device.' }), Card({ label: 'Interface', children: [
    choose('interface', 'Interface', [['simple', 'Simple'], ['advanced', 'Advanced']]),
    choose('sendKey', 'Send key', [['enter', 'Enter'], ['shift-enter', 'Shift + Enter'], ['mod-enter', 'Ctrl or Cmd + Enter']]),
    choose('width', 'Chat width', [['default', 'Default'], ['wide', 'Wide'], ['full', 'Full']]),
    choose('font', 'Chat font', [['inter', 'Inter'], ['system', 'System'], ['serif', 'Serif']]),
    toggle('bubbles', 'Colour user bubbles'), toggle('threads', 'Show threads'), toggle('pins', 'Pinned circles'), toggle('runCard', 'Run card'), toggle('tools', 'Show tool calls'),
  ] }), Card({ label: 'New bots', children: [defaults, h('label', { class: 'bots-row' }, [h('span', { text: 'Thread concurrency' }), concurrency])] }),
  Card({ label: 'Get started', children: [Button({ label: 'Replay tour', onClick: () => replay('./botsTour.js', 'tour') }),
    Button({ label: 'Replay welcome', onClick: () => replay('./botsWelcome.js', 'welcome') }),
    Button({ label: 'Check setup', onClick: async () => {
      try { const module = await import('./botsSetupChecklist.js'); if (!dead) { setupHandle?.destroy(); setupHandle = await module.mount(setupHost, { signal: abort.signal }); } }
      catch { if (!dead) status.textContent = 'Setup checklist could not load. Try again.'; }
    } })] }), status);
  const setupHost = h('div'); let setupHandle = null; root.append(setupHost); host.replaceChildren(root);
  api('/api/agents/defaults', { signal: abort.signal, toast: false }).then(data => { if (!dead) { concurrency.value = String((data.defaults || data).thread_limit || 3); concurrency.disabled = false; } })
    .catch(() => { if (!dead) status.textContent = 'New bot defaults could not load. Reopen this page to try again.'; });
  const destroy = () => { dead = true; abort.abort(); setupHandle?.destroy(); root.remove(); };
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  return { destroy, refresh: applyBotsPrefs, flush: async () => ({ ok: true }) };
}

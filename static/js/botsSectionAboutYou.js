// About you (Bots Phase 2, unit U2): the text every bot reads about the person, saved as you type, and the facts
// bots have learned, each with Remove. Settings mounts this beside the bot pages; the bot panel may too.
// Contract: mount(host, ctx) -> {destroy, refresh, flush}. ctx is optional here (agentId is not used), and
// nothing waits on a pending request after destroy. Everything the server sends is drawn as plain text.
import { api, el } from './api.js';
import { Card, Button, loadBotsCss } from './botsUi.js';
import { MEMORY_ACTIVITY_CSS } from './botsSectionMemoryActivity.js';
import { aboutCounter, createAutosave, learnedRows, messageOf } from './botsMemoryActivityModel.js';

export function mount(host, ctx = {}) {
  loadBotsCss(MEMORY_ACTIVITY_CSS);
  const root = el('div', { class: 'bots-mact bots-about', 'data-section': 'about-you' });
  host.append(root);

  let destroyed = false, loading = true, loadError = '', hash = null, learned = [], busy = '', notice = '';
  let area = null, counter = null, statusNode = null, retryNode = null;
  const saver = createAutosave({
    save: async text => {
      const saved = await api('/api/bots/profile', { method: 'PUT', toast: false, body: JSON.stringify({ text, expected_hash: hash }) });
      hash = saved.hash;
    },
    onState: paintState,
  });

  function paintState({ state, error }) {
    if (!statusNode) return;
    const words = { idle: '', dirty: 'Unsaved', saving: 'Saving', saved: 'Saved', error: `Could not save: ${error}`,
      conflict: 'This changed somewhere else. Reload to see the newest text.' }[state] || '';
    statusNode.textContent = words;
    statusNode.dataset.state = state;
    if (retryNode) retryNode.hidden = !(state === 'error' || state === 'conflict');
    if (retryNode) retryNode.textContent = state === 'conflict' ? 'Reload' : 'Retry';
  }

  async function load() {
    try {
      const next = await api('/api/bots/profile', { toast: false });
      if (destroyed) return;
      learned = learnedRows(next.learned);
      loadError = '';
      const first = hash === null;
      // A draft keeps the hash it was started from, so a change made elsewhere shows as a conflict on save.
      if (first) { hash = next.hash; saver.start(next.text); }
      else if (!saver.dirty) { hash = next.hash; saver.adopt(next.text); }
      draw(saver.dirty ? undefined : next.text);
    } catch (failure) {
      if (destroyed) return;
      loadError = messageOf(failure);
      draw(null);
    }
    loading = false;
  }

  async function reloadAfterConflict() {
    try {
      const next = await api('/api/bots/profile', { toast: false });
      if (destroyed) return;
      hash = next.hash;
      saver.resolveConflict(next.text);
      learned = learnedRows(next.learned);
      draw(next.text);
    } catch (failure) { notice = messageOf(failure); draw(null); }
  }

  async function remove(fact) {
    if (busy) return;
    busy = fact.id; notice = '';
    draw(undefined);
    try {
      await api(`/api/bots/profile/learned/${encodeURIComponent(fact.id)}/remove`, { method: 'POST', toast: false });
      learned = learned.filter(r => r.id !== fact.id);
      notice = 'Removed. Bots will not learn that again.';
    } catch (failure) { notice = messageOf(failure); }
    finally { busy = ''; if (!destroyed) draw(undefined); }
  }

  // text: the editor's starting text; undefined keeps what is typed; null shows an error state.
  function draw(text) {
    if (destroyed) return;
    if (loading && text === undefined) { root.replaceChildren(el('p', { class: 'bots-mact-empty', role: 'status', text: 'Loading About you.' })); return; }
    if (loadError && text === null) {
      root.replaceChildren(el('div', { class: 'bots-mact-error', role: 'alert' }, [
        el('span', { text: loadError }), Button({ label: 'Retry', onClick: () => { loadError = ''; load(); } })]));
      return;
    }
    const typed = area ? area.value : '';
    area = el('textarea', { class: 'bots-mact-about', rows: '10', 'aria-label': 'About you', placeholder: 'Anything every bot should know about you: your name, your work, how you like things done.' });
    area.value = text === undefined ? typed : text;
    counter = el('span', { class: 'bots-mact-counter' });
    statusNode = el('span', { class: 'bots-mact-status', role: 'status' });
    retryNode = Button({ label: 'Retry', onClick: () => (saver.state === 'conflict' ? reloadAfterConflict() : saver.retry()) });
    retryNode.hidden = true;
    const paint = () => { const c = aboutCounter(area.value); counter.textContent = c.text; counter.dataset.over = c.over ? 'true' : 'false'; };
    area.addEventListener('input', () => { paint(); if (!aboutCounter(area.value).over) saver.edit(area.value); });
    area.addEventListener('blur', () => { saver.flush(); });
    paint();
    paintState({ state: saver.state, error: saver.error });
    const facts = learned.length
      ? learned.map(fact => el('div', { class: 'bots-mact-fact', 'data-fact': fact.id }, [
        el('div', { class: 'bots-mact-fact-text' }, [el('div', { text: fact.text }), el('div', { class: 'bots-mact-when', text: `Learned by ${fact.by}${fact.when ? `, ${fact.when}` : ''}` })]),
        Button({ label: 'Remove', iconName: 'trash-2', disabled: !!busy, onClick: () => remove(fact) }),
      ]))
      : [el('p', { class: 'bots-mact-empty', text: 'Nothing learned yet. Facts your bots pick up from chats appear here, and you can remove any of them.' })];
    root.replaceChildren(
      Card({ label: 'About you', children: [area, el('div', { class: 'bots-mact-foot' }, [counter, statusNode, retryNode])] }),
      Card({ label: 'Learned by your bots', children: [notice ? el('p', { class: 'bots-mact-notice', role: 'status', text: notice }) : null, ...facts] }));
  }

  draw(undefined);
  load();
  return {
    destroy() { destroyed = true; saver.stop(); root.remove(); },
    refresh() { return load(); },
    async flush() { await saver.flush(); },
  };
}

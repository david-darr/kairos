// Keys and helper settings (Phase 2, unit U5). Phase 1 and Settings mount it as the "Keys" page.
// mount(host, ctx) -> {destroy, refresh, flush}. ctx.focusKey (optional) scrolls to and highlights one row.
//
// Keys are write-only: a saved key shows as "Saved, ends 1234" and never comes back. Typing a new value replaces it.
// Test sends the key (the typed one, or the saved one) to its provider and shows only a status word and a fixed sentence.
// AI and Helper rows are the model connections set up under Settings > Models: listed and tested here, changed there.
// Below the keys, the helper model and the quiet-time settings for the memory work (resource settings, per owner).
import { api, el } from './api.js';
import { Card, Button, PageHeader, loadBotsCss } from './botsUi.js';
import { CONNECTIONS_CSS, field, secretInput, statusBox, textInput } from './botsSectionConnections.js';
import { groupKeys, keyState, messageOf, testText, testTone } from './botsConnectionsModel.js';

export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots.css');
  loadBotsCss(CONNECTIONS_CSS);
  const root = el('div', { class: 'bots-conn', 'data-section': 'keys' });
  host.append(root);

  let destroyed = false, loading = true, loadError = '', generation = 0, busy = '', notice = '', formError = '';
  let keys = [], groups = [], settings = null, endpoints = [], focusTimer = 0;
  const typed = new Map(), results = new Map();   // typed values live only in this page's memory, and only until saved
  const draft = {};                                // resource settings being edited

  async function load(quiet = false) {
    const mine = ++generation;
    loading = !keys.length && !quiet; loadError = '';
    if (loading) draw();
    try {
      const [list, resource, models] = await Promise.all([api('/api/bots/keys', { toast: false }), api('/api/bots/resource-settings', { toast: false }),
        api('/api/models', { toast: false }).catch(() => [])]);
      if (destroyed || mine !== generation) return;
      keys = list.keys || []; groups = list.groups || []; settings = resource; endpoints = (Array.isArray(models) ? models : models.endpoints || []).filter(e => ['local', 'api'].includes(e.kind));
      Object.assign(draft, { tidy_time: resource.tidy_time, capture_quiet_minutes: resource.capture_quiet_minutes, room_capture: resource.room_capture, helper_model: resource.helper_model || '' });
    } catch (error) {
      if (destroyed || mine !== generation) return;
      loadError = messageOf(error);
    }
    loading = false;
    draw();
    focusRow();
  }

  function focusRow() {
    if (!ctx.focusKey) return;
    const row = root.querySelector(`[data-key="${CSS.escape(ctx.focusKey)}"]`);
    if (!row) return;
    ctx.focusKey = '';
    row.scrollIntoView?.({ block: 'center' });
    row.classList.add('focused');
    row.querySelector('input')?.focus({ preventScroll: true });
    focusTimer = setTimeout(() => row.classList.remove('focused'), 1600);
  }

  async function run(label, call, done = '') {
    if (busy || destroyed) return false;
    busy = label; formError = ''; notice = '';
    draw();
    try { await ctx.flush?.(); await call(); if (!destroyed && done) notice = done; return true; }
    catch (error) { if (!destroyed) formError = messageOf(error); return false; }
    finally { busy = ''; if (!destroyed) draw(); }
  }

  const save = row => run('save', async () => {
    const value = typed.get(row.id);
    const saved = await api(`/api/bots/keys/${encodeURIComponent(row.id)}`, { method: 'PUT', toast: false, body: JSON.stringify({ value }) });
    typed.delete(row.id);
    results.set(row.id, saved.warning ? { ok: false, message: saved.warning, tone: 'warn' } : { ok: true, message: 'Saved.' });
    await load(true);
  });
  const clear = row => run('clear', async () => { await api(`/api/bots/keys/${encodeURIComponent(row.id)}`, { method: 'DELETE', toast: false }); results.delete(row.id); await load(true); });
  async function test(row) {
    results.set(row.id, { ok: false, message: 'Testing...', tone: 'quiet' });
    draw();
    await run('test', async () => {
      const value = typed.get(row.id);
      results.set(row.id, await api(`/api/bots/keys/${encodeURIComponent(row.id)}/test`, { method: 'POST', toast: false, body: JSON.stringify(value ? { value } : {}) }));
    });
  }
  const saveSettings = () => run('settings', async () => {
    const body = { expected_revision: settings.revision, tidy_time: draft.tidy_time, capture_quiet_minutes: Number(draft.capture_quiet_minutes), room_capture: draft.room_capture };
    if ((draft.helper_model || '') !== (settings.helper_model || '')) body.helper_model = draft.helper_model || null;
    settings = await api('/api/bots/resource-settings', { method: 'PATCH', toast: false, body: JSON.stringify(body) });
  }, 'Saved.');

  function keyRow(row) {
    const result = results.get(row.id);
    const managed = row.managed_in === 'models';
    const node = el('div', { class: 'bots-conn-key', 'data-key': row.id }, [
      el('div', { class: 'bots-conn-main static' }, [el('span', { class: 'bots-row-title', text: row.label }), el('span', { class: 'bots-row-hint', text: `${keyState(row)}${row.hint ? ' · ' + row.hint : ''}` })]),
    ]);
    if (managed) node.append(el('span', { class: 'bots-row-hint', text: 'Change it in Settings > Models.' }));
    else {
      const input = row.secret === false ? textInput('', { 'aria-label': row.label, placeholder: row.has_value ? 'Type to replace' : 'Value' }) : secretInput({ 'aria-label': row.label, placeholder: row.has_value ? 'Saved. Type to replace.' : 'Paste the key' });
      input.value = typed.get(row.id) || '';
      input.addEventListener('input', () => { input.value ? typed.set(row.id, input.value) : typed.delete(row.id); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && input.value) { event.preventDefault(); save(row); } });
      node.append(input);
    }
    const actions = el('div', { class: 'bots-conn-actions' }, [
      !managed ? Button({ label: 'Save', variant: 'primary', disabled: !!busy, onClick: () => typed.get(row.id) ? save(row) : (formError = 'Type the key first.', draw()) }) : null,
      row.testable ? Button({ label: 'Test', disabled: !!busy, onClick: () => test(row) }) : null,
      !managed && row.has_value ? Button({ label: 'Clear', variant: 'danger', disabled: !!busy, onClick: () => clear(row) }) : null,
    ]);
    const labels = [!managed ? 'save' : null, row.testable ? 'test' : null, !managed && row.has_value ? 'clear' : null].filter(Boolean);
    actions.querySelectorAll('.bots-btn').forEach((b, i) => b.setAttribute('data-act', labels[i]));
    node.append(actions);
    if (result) node.append(el('div', { class: `bots-conn-key-result ${result.tone || testTone(result)}`, role: 'status', 'data-result': 'true', text: testText(result) }));
    return node;
  }

  function settingsCard() {
    const children = [];
    if (!settings) return null;
    const helper = el('select', { 'aria-label': 'Helper model', 'data-field': 'helper-model' }, [el('option', { value: '', text: 'The first local model' }), el('option', { value: 'off', text: 'Off' }),
      ...endpoints.map(e => el('option', { value: e.id, text: e.name || e.id }))]);
    helper.value = draft.helper_model; helper.addEventListener('change', () => { draft.helper_model = helper.value; });
    const tidy = textInput(draft.tidy_time, { inputmode: 'numeric', 'data-field': 'tidy-time', placeholder: '03:00' }); tidy.addEventListener('input', () => { draft.tidy_time = tidy.value; });
    const quiet = textInput(String(draft.capture_quiet_minutes), { inputmode: 'numeric', 'data-field': 'quiet' }); quiet.addEventListener('input', () => { draft.capture_quiet_minutes = quiet.value === '' ? '' : Number(quiet.value); });
    const room = el('select', { 'aria-label': 'Room memory', 'data-field': 'room-capture' }, [['off', 'Never'], ['ask', 'Ask me first'], ['on', 'Always']].map(([value, text]) => el('option', { value, text })));
    room.value = draft.room_capture; room.addEventListener('change', () => { draft.room_capture = room.value; });
    children.push(el('div', { class: 'bots-conn-editor' }, [
      field('Helper model', helper, 'Quiet jobs such as tidying memory use a bot\'s own model first, then this one when a bot allows it. Claude and Codex cannot be helpers.'),
      field('Daily tidy time', tidy, 'Your local time, as 24-hour hours and minutes.'),
      field('Wait before saving memories (minutes)', quiet, 'After a chat goes quiet for this long. From 1 to 60.'),
      field('Remember what is said in rooms', room, 'Rooms arrive with teams. Your choice is kept for then.'),
      el('div', { class: 'bots-conn-buttons' }, [Button({ label: 'Save', variant: 'primary', disabled: !!busy, onClick: saveSettings })])]));
    children[0].querySelector('.bots-btn').setAttribute('data-act', 'save-settings');
    return Card({ label: 'Helpers and quiet-time work', children });
  }

  function draw() {
    if (destroyed) return;
    if (loading) { root.replaceChildren(statusBox('Loading your keys...')); return; }
    if (loadError) { root.replaceChildren(statusBox(loadError, 'error'), Button({ label: 'Retry', iconName: 'refresh-cw', onClick: () => load() })); return; }
    const parts = ctx.embedded ? [] : [PageHeader({ title: 'Keys', intro: 'Keys are saved encrypted and never shown again. Testing a key shows only whether the provider accepted it.' })];
    if (notice) parts.push(statusBox(notice, 'good'));
    if (formError) parts.push(statusBox(formError, 'error'));
    for (const { group, rows } of groupKeys(keys, groups)) parts.push(Card({ label: group, children: rows.map(keyRow) }));
    const card = settingsCard(); if (card) parts.push(card);
    root.replaceChildren(...parts);
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
  }

  load();
  return {
    destroy() { destroyed = true; generation++; clearTimeout(focusTimer); typed.clear(); root.remove(); },
    refresh: () => load(true),
    flush: () => Promise.resolve(true),
  };
}

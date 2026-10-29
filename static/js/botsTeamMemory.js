import { h, Button } from './botsUi.js';
import { memoryGroups } from './botsTeamDialogs.js';
import { departmentPath, teamRequest, teamError, teamChanged, openTeamSurface, confirmTeamAction } from './botsTeamHost.js';
export { memoryGroups } from './botsTeamDialogs.js';

export function mount(host, ctx = {}) {
  const abort = new AbortController(), request = (p, init = {}) => (ctx.api || teamRequest)(p, { ...init, signal: abort.signal });
  const path = `${departmentPath(ctx.departmentId)}/memory`;
  let disposed = false, busy = false, drafts = new Map(), loaded = false;
  const body = h('div'), error = h('p', { class: 'bots-team-error', role: 'alert' });
  host.append(error, body);
  const dirty = () => [...drafts.values()].some(d => d.current !== d.before);
  async function act(entry, suffix, method = 'POST', extra = {}) {
    if (busy) return;
    if (suffix === '' && method === 'DELETE' && !await confirmTeamAction(host, { title: `Delete ${entry.name}?`, confirmLabel: 'Delete' })) return;
    busy = true; body.inert = true; error.textContent = '';
    try { await request(`${path}/${encodeURIComponent(entry.id)}${suffix}`, { method, body: { expected_revision: entry.revision, ...extra } }); drafts.delete(entry.id); teamChanged(); ctx.onChanged?.(); }
    catch (problem) { if (!disposed) error.textContent = problem?.status === 409 || /^409\b/.test(String(problem?.message)) ? 'This entry changed. Your draft is kept. Reload before trying again.' : teamError(problem); }
    finally { busy = false; if (!disposed) { body.inert = false; if (!dirty()) refresh(); } }
  }
  function entryNode(entry, proposed = false) {
    const node = h('article', { class: 'bots-team-memory-entry', 'data-entry-id': entry.id });
    node.append(h('strong', { text: entry.name }), h('p', { class: 'bots-hint', text: `${entry.kind}${entry.aliases?.length ? `, ${entry.aliases.join(', ')}` : ''}` }));
    if (proposed) node.append(h('p', { text: entry.detail }), h('p', { class: 'bots-hint', text: `${entry.source_bot_name || entry.source_bot_id || 'Bot'}${entry.source_quote ? `: ${entry.source_quote}` : ''}` }),
      h('div', { class: 'bots-team-actions' }, [Button({ label: 'Remember', variant: 'primary', onClick: () => act(entry, '/accept') }), Button({ label: 'Skip', onClick: () => act(entry, '/skip') })]));
    else {
      const draft = { before: entry.detail || '', current: entry.detail || '' }; drafts.set(entry.id, draft);
      const text = h('textarea', { 'aria-label': `Detail for ${entry.name}`, rows: '2', maxlength: '600' }); text.value = draft.current;
      text.addEventListener('input', () => { draft.current = text.value; save.disabled = draft.current === draft.before; });
      const save = Button({ label: 'Save detail', disabled: true, onClick: () => act(entry, '', 'PATCH', { detail: text.value }) });
      node.append(text, h('p', { class: 'bots-hint', text: `${entry.source_bot_name || entry.source_bot_id || 'You'}${entry.created_at ? `, ${new Date(Number(entry.created_at) * 1000 || entry.created_at).toLocaleDateString()}` : ''}${entry.loaded ? ', Loaded' : ', Searchable'}` }),
        h('div', { class: 'bots-team-actions' }, [save, Button({ label: entry.pinned ? 'Unpin' : 'Pin', iconName: 'pin', onClick: () => act(entry, '', 'PATCH', { pinned: !entry.pinned }) }),
          Button({ label: 'Delete', variant: 'danger', onClick: () => act(entry, '', 'DELETE') }), ...(entry.can_undo ? [Button({ label: 'Undo', iconName: 'undo-2', onClick: () => act(entry, '/undo') })] : [])]));
      const history = h('details', {}, [h('summary', { text: 'History' }), ...(entry.history || []).map(version => h('div', { class: 'bots-team-memory-entry' }, [h('p', { text: version.detail || '' }), Button({ label: 'Restore', onClick: () => act(entry, '/restore', 'POST', { revision: version.revision }) })]))]);
      node.append(history);
    }
    return node;
  }
  async function refresh(force = false) {
    if (busy || (!force && dirty())) return;
    busy = true;
    try {
      const data = await request(path); if (disposed) return;
      const entries = Array.isArray(data) ? data : data.entries || []; drafts.clear(); loaded = true;
      const waiting = entries.filter(e => e.status === 'proposed'), groups = memoryGroups(entries);
      body.replaceChildren(h('p', { role: 'status', text: `${data.loaded_count ?? data.loaded ?? entries.filter(e => e.loaded).length} loaded of ${data.total ?? entries.length}` }),
        ...(waiting.length ? [h('section', { class: 'bots-team-waiting', 'aria-label': 'Waiting for you' }, [h('h3', { text: 'Waiting for you' }), ...waiting.map(e => entryNode(e, true))])] : []),
        ...groups.filter(g => g.entries.length).map(g => h('section', {}, [h('h3', { text: g.label }), ...g.entries.map(e => entryNode(e))])),
        ...(!entries.length ? [h('p', { text: 'No team memories yet.' })] : []),
        Button({ label: 'Add entry', iconName: 'plus', onClick: addEntry }));
    } catch (problem) { if (!disposed) error.textContent = `Team memory could not load. ${teamError(problem)}`; }
    finally { busy = false; }
  }
  function addEntry() {
    const kind = h('select', { 'aria-label': 'Memory kind' }, ['person', 'place', 'decision', 'term'].map(k => h('option', { value: k, text: k })));
    const name = h('input', { 'aria-label': 'Memory name', maxlength: '120', required: true });
    const detail = h('textarea', { 'aria-label': 'Memory detail', maxlength: '600', rows: '3' });
    const aliases = h('input', { 'aria-label': 'Aliases', placeholder: 'Aliases, separated by commas' });
    const key = h('input', { 'aria-label': 'Memory key', maxlength: '240' });
    const draftId = Symbol('new'); drafts.set(draftId, { before: '', current: '' });
    const box = h('div', { class: 'bots-team-confirm' }, [kind, h('label', { class: 'bots-team-field' }, ['Name', name]), h('label', { class: 'bots-team-field' }, ['Detail', detail]), aliases, key]);
    box.addEventListener('input', () => { drafts.get(draftId).current = JSON.stringify([name.value, detail.value, aliases.value, key.value]); });
    const cancel = Button({ label: 'Cancel', onClick: () => { drafts.delete(draftId); box.remove(); } });
    const save = Button({ label: 'Add memory', variant: 'primary', onClick: async () => {
      if (busy) return; if (!name.value.trim()) { error.textContent = 'Add a name.'; return; }
      const values = aliases.value.split(',').map(v => v.trim()).filter(Boolean); if (values.length > 8) { error.textContent = 'Use at most eight aliases.'; return; }
      busy = true; box.inert = true;
      try { await request(path, { method: 'POST', body: { kind: kind.value, name: name.value.trim(), detail: detail.value, aliases: values, key: key.value } }); drafts.delete(draftId); teamChanged(); box.remove(); }
      catch (problem) { if (!disposed) error.textContent = teamError(problem); }
      finally { busy = false; if (!disposed) { box.inert = false; if (!dirty()) refresh(); } }
    } });
    box.append(h('div', { class: 'bots-team-actions' }, [cancel, save])); body.append(box); name.focus();
  }
  const reload = Button({ label: 'Reload memory', onClick: async () => { if (dirty() && !await confirmTeamAction(host, { title: 'Discard your memory changes?', confirmLabel: 'Reload' })) return; drafts.clear(); await refresh(true); } });
  host.append(reload); refresh();
  return { refresh, dirty, flush: async () => ({ ok: loaded && !busy && !dirty() }), get busy() { return busy; }, destroy() { disposed = true; abort.abort(); drafts.clear(); host.replaceChildren(); } };
}
export function open(options = {}) {
  let handle;
  const dialog = openTeamSurface({ title: 'Team memory', width: 720, beforeClose: async () => !handle?.busy && (!handle?.dirty() || await confirmTeamAction(dialog.body, { title: 'Discard your memory changes?', confirmLabel: 'Discard' })), onClose: () => handle?.destroy() });
  handle = mount(dialog.body, options); return { ...dialog, refresh: handle.refresh, flush: handle.flush };
}

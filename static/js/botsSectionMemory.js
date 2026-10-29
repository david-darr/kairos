// A bot's Memory section (Bots Phase 2, unit U1; phase-2-design.md sections 5 and 6).
//
// mount(host, ctx) -> { destroy, refresh, flush }. The panel (botsPanel.js, botsPanelSections.js) mounts this
// when the server lists it (GET /api/agents/section-modules) and keeps it mounted while hidden, so a draft
// survives polling and tab changes.
//
//   Simple    the bot's notes as a list: add one, remove one, and the memory on/off switch.
//   Advanced  adds the capacity meter, the main page editor, topics (create, edit, delete), the archive and the
//             daily logs (read only), tidy-up controls, opening the folder, and the change history with
//             diffs and guarded Undo.
//
// The section fetches its own data from /api/bots/<id>/memory (services/bot_memory.py) and never touches the
// panel's ctx.ensure() table or its patch queue. Every change carries the hash the editor read, so an edit
// made elsewhere is a 409 that offers Reload, or an explicit, checked Overwrite. Text from notes, logs and
// diffs is always drawn with textContent, never as markup. The logic with no DOM is in botsMemoryModel.js.
import { Card, SwitchRow, Button, IconButton, h, loadBotsCss, onBotsInterface } from './botsUi.js';
import { icon } from './botsIcons.js';
import {
  INDEX_PATH, ARCHIVE_PATH, ABSENT, parseFailure, capacityReport, topicNameError, noteHint, liveNotes, formatBytes,
  createEditor, actorLabel, undoState, diffRows, whenLabel, createGate,
} from './botsMemoryModel.js';

const CSS = '/static/css/bots-memory.css';
const JOURNAL_ROWS = 30;
const POLL_MS = 15000;
const enc = encodeURIComponent;
const line = (text, tone = '') => h('div', { class: `bots-row bots-note-line ${tone}`.trim(), role: tone === 'error' ? 'alert' : undefined }, [
  icon(tone === 'error' ? 'triangle-alert' : 'info', { size: 16 }), h('span', { class: 'bots-row-hint', text })]);
const caps = text => h('div', { class: 'bots-caps bots-card-label', text });

export function mount(host, ctx) {
  loadBotsCss(CSS);
  let gate = createGate();
  const root = h('div', { class: 'bots-mem', 'data-memory-root': '' });
  host.append(root);
  const S = { overview: null, journal: [], loading: true, failure: '', advanced: !!ctx.advanced, doc: null, expanded: new Set(), tidying: false };
  const pending = new Set();
  const track = promise => { pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  const api = (tail, options = {}) => ctx.ui.api(`/api/bots/${enc(ctx.agentId)}/memory${tail}`, { toast: false, ...options });
  const send = (tail, method, data) => api(tail, { method, body: data === undefined ? undefined : JSON.stringify(data) });
  const say = (message, type = 'error') => { if (gate.alive()) ctx.ui.toast(message, type); };
  const index = () => S.overview?.index || null;
  const settings = () => S.overview?.settings || { enabled: true, upkeep: false, room_capture: false };

  // -- the stable parts: built once, repainted in place -------------------------------------------------
  const banner = h('div', { class: 'bots-mem-banner' });
  const holders = Object.fromEntries(['master', 'notes', 'capacity', 'main', 'topics', 'doc', 'maintenance', 'journal', 'location']
    .map(name => [name, h('div', { class: 'bots-mem-part', 'data-part': name })]));
  const state = h('div', { class: 'bots-lazy bots-mem-state', 'aria-busy': 'true' });
  const addInput = h('input', { type: 'text', class: 'bots-mem-add-input', placeholder: 'Add something to remember', maxlength: '1000', 'aria-label': 'New note', autocomplete: 'off' });
  const addButton = Button({ label: 'Add note', iconName: 'plus', onClick: () => addNote() });
  addInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addNote(); } });
  const notesList = h('div', { class: 'bots-mem-notes', role: 'list', 'aria-label': 'Notes' });
  const add = h('div', { class: 'bots-row bots-mem-add' }, [addInput, addButton]);
  let main = null;   // the main page's editor, kept for the life of the section so its draft survives
  let signatures = {};
  const paintIf = (key, signature, build) => {
    const text = JSON.stringify(signature);
    if (signatures[key] === text) return;
    signatures[key] = text;
    build();
  };

  // -- the editor (main page, topics, archive, logs) ----------------------------------------------------
  function makeEditor({ path, label, readOnly = false, canDelete = false, onChange, onClose }) {
    const editor = createEditor({ text: '', hash: ABSENT });
    let ready = false, busy = false, info = null;
    const area = h('textarea', { class: 'bots-mem-area', rows: '14', spellcheck: 'false', 'aria-label': label, 'data-memory-editor': path, readonly: readOnly || undefined });
    const meta = h('small', { class: 'bots-count', role: 'status' });
    const status = h('div', { class: 'bots-mem-status', role: 'status', 'aria-live': 'polite' });
    const conflict = h('div', { class: 'bots-mem-conflict', role: 'alert', hidden: true });
    const save = Button({ label: 'Save', variant: 'primary', disabled: true, onClick: () => doSave() });
    const discard = Button({ label: 'Discard changes', disabled: true, onClick: () => { editor.discard(); paint(); } });
    const remove = canDelete ? Button({ label: 'Delete topic', iconName: 'trash-2', variant: 'danger', onClick: () => doDelete() }) : null;
    const close = onClose ? Button({ label: 'Close', onClick: () => onClose() }) : null;
    const reload = Button({ label: 'Reload (drop my changes)', iconName: 'refresh-cw', onClick: () => { editor.reload(); paint(); } });
    const checkId = `bots-mem-over-${Math.random().toString(36).slice(2, 8)}`;
    const check = h('input', { type: 'checkbox', id: checkId });
    const overwrite = Button({ label: 'Overwrite', variant: 'danger', disabled: true, onClick: () => doSave() });
    check.addEventListener('change', () => { editor.setOverwrite(check.checked); paint(); });
    conflict.append(h('span', { class: 'bots-mem-conflict-text', text: 'This changed somewhere else. Your changes are still here.' }),
      h('div', { class: 'bots-actions' }, [reload, h('label', { class: 'bots-mem-check', for: checkId }, [check, ' Replace the newer version with mine']), overwrite]));
    const node = h('div', { class: 'bots-mem-editor', 'data-editor-path': path }, [
      area, h('div', { class: 'bots-mem-editor-foot' }, [meta]), conflict, status,
      h('div', { class: 'bots-actions' }, readOnly ? [close] : [save, discard, remove, close])]);
    area.addEventListener('input', () => { editor.edit(area.value); paint(); });
    function paint() {
      if (area.value !== editor.draft) area.value = editor.draft;
      const bytes = new TextEncoder().encode(editor.draft).length;
      const limit = info?.limit || 0;
      const over = !!limit && bytes > limit;
      meta.textContent = readOnly ? `Read only · ${formatBytes(bytes)}` : `${formatBytes(bytes)}${limit ? ` of ${formatBytes(limit)}` : ''}${editor.dirty ? ' · not saved' : ''}`;
      meta.classList.toggle('over', over);
      save.disabled = busy || readOnly || over || !ready || (!editor.dirty && !editor.canOverwrite) || (!!editor.conflict && !editor.canOverwrite);
      discard.disabled = busy || !editor.dirty;
      conflict.hidden = !editor.conflict;
      check.checked = editor.state.overwrite;
      overwrite.disabled = busy || !editor.canOverwrite;
      node.dataset.dirty = editor.dirty ? 'true' : 'false';
      node.dataset.conflict = editor.conflict ? 'true' : 'false';
    }
    function feed(next) {
      info = next;
      if (!ready) { ready = true; editor.state.base = { text: next.text, hash: next.hash }; editor.state.draft = next.text; }
      else editor.incoming({ text: next.text, hash: next.hash });
      paint();
    }
    async function latest() {
      try { feed(await api(`/file?path=${enc(path)}`)); }
      catch (error) { if (parseFailure(error).status === 404) { editor.incoming({ text: '', hash: ABSENT }); paint(); } else throw error; }
    }
    async function doSave() {
      const request = editor.saveRequest();
      if (!request || busy) return;
      busy = true; status.textContent = 'Saving...'; paint();
      try {
        await ctx.flush?.();
        const result = await track(send(`/file?path=${enc(path)}`, 'PUT', request));
        if (!gate.alive()) return;
        info = result.file;
        editor.saved({ text: result.file.text, hash: result.file.hash }, request.text);
        status.textContent = 'Saved';
        onChange?.(result);
      } catch (error) {
        if (!gate.alive()) return;
        const failure = parseFailure(error);
        if (failure.status === 409) { status.textContent = ''; try { await latest(); } catch { status.textContent = failure.message; } }
        else status.textContent = failure.status === 413 ? 'That is too big to save here. Shorten it and try again.' : failure.message;
      } finally { busy = false; if (gate.alive()) paint(); }
    }
    async function doDelete() {
      if (!(await ctx.ui.confirmDialog({ title: 'Delete this topic?', message: 'Its notes are removed from the bot. You can undo this from the change history.', confirmLabel: 'Delete topic' }))) return;
      if (!gate.alive()) return;
      busy = true; paint();
      try {
        const result = await track(send(`/file?path=${enc(path)}&expected_hash=${enc(editor.state.base.hash)}`, 'DELETE'));
        if (!gate.alive()) return;
        onChange?.(result, { deleted: true });
      } catch (error) { status.textContent = parseFailure(error).message; busy = false; if (gate.alive()) paint(); }
    }
    return { node, editor, area, feed, latest, paint, path, get dirty() { return editor.dirty; } };
  }

  // -- notes ------------------------------------------------------------------------------------------
  async function addNote() {
    const text = addInput.value.trim();
    if (!text || !index()) return;
    if (text.length > 1000) { say('A note can be up to 1,000 characters.'); return; }
    addButton.disabled = true;
    try {
      await ctx.flush?.();
      await track(send('/entries', 'POST', { action: 'append', path: INDEX_PATH, expected_hash: index().hash, section: 'Notes', text }));
      if (!gate.alive()) return;
      addInput.value = '';
      await reload();
    } catch (error) { await refuse(error, 'The notes changed somewhere else. They were reloaded, so add it again.'); }
    finally { if (gate.alive()) addButton.disabled = false; }
  }
  async function removeNote(note) {
    try {
      await ctx.flush?.();
      await track(send('/entries', 'POST', { action: 'remove', path: INDEX_PATH, expected_hash: index().hash, target: note.id }));
      if (!gate.alive()) return;
      await reload();
    } catch (error) { await refuse(error, 'The notes changed somewhere else. They were reloaded, so try again.'); }
  }
  async function refuse(error, staleMessage) {
    if (!gate.alive()) return;
    const failure = parseFailure(error);
    say(failure.status === 409 && /changed since/.test(failure.message) ? staleMessage : failure.message);
    if (failure.status === 409) await reload().catch(() => {});
  }

  function paintNotes() {
    const notes = liveNotes(index()?.notes);
    paintIf('notes', notes.map(n => [n.id, n.text, n.section, n.learned, n.until, n.source]), () => {
      notesList.replaceChildren(...(notes.length ? notes.map(note => h('div', { class: 'bots-row bots-mem-note', role: 'listitem', 'data-note-id': note.id }, [
        h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title bots-mem-note-text', text: note.text }), h('span', { class: 'bots-row-hint', text: noteHint(note) })]),
        IconButton({ iconName: 'trash-2', label: `Remove note: ${note.text.replace(/\s+/g, ' ').slice(0, 50)}`, onClick: () => removeNote(note) })]))
        : [line('No notes yet. Add one below, or the bot adds its own as it learns.')]));
    });
  }
  const notesCard = Card({ label: 'What it remembers', children: [notesList, add] });
  holders.notes.append(notesCard);

  // -- master switch, banner ---------------------------------------------------------------------------
  let masterRow = null;
  function paintMaster() {
    const enabled = settings().enabled;
    root.dataset.memoryEnabled = enabled ? 'true' : 'false';
    banner.replaceChildren(...(enabled ? [] : [line('Memory is off for this bot. It does not read or save notes. Your notes are kept, and you can still edit them here.', 'warn')]));
    banner.hidden = enabled;
    if (!masterRow) {
      masterRow = SwitchRow({ title: 'Use memory', hint: 'When off, the bot neither reads nor saves notes.', checked: enabled, onChange: value => setSetting({ enabled: value }, 'Memory') });
      holders.master.append(Card({ children: [masterRow] }));
    } else masterRow.setChecked(enabled);
  }
  async function setSetting(patch, what) {
    try {
      await ctx.flush?.();
      const result = await track(send('/settings', 'PATCH', patch));
      if (!gate.alive()) return;
      if (S.overview) { S.overview.settings = result; S.overview.enabled = result.enabled; }
      paintAll();
    } catch (error) { say(`${what} could not be changed. ${parseFailure(error).message}`); await reload().catch(() => {}); }
  }

  // -- Advanced: capacity, main page ---------------------------------------------------------------------
  function paintCapacity() {
    const report = capacityReport(index());
    paintIf('capacity', report, () => {
      holders.capacity.replaceChildren(Card({ label: 'How much it reads each turn', children: [
        h('div', { class: 'bots-row bots-mem-capacity', 'data-level': report.level }, [
          h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: report.label }),
            h('div', { class: 'bots-mem-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(report.percent), 'aria-label': 'Main page capacity' },
              [h('span', { class: 'bots-mem-meter-fill', style: `width:${report.percent}%` })]),
            report.warning ? h('span', { class: 'bots-row-hint bots-mem-warning', role: 'status', text: report.warning }) : null])])] }));
    });
  }
  function paintMain() {
    if (!index()) return;
    if (!main) {
      main = makeEditor({ path: INDEX_PATH, label: 'Main page', onChange: () => { reload(); } });
      holders.main.replaceChildren(Card({ label: 'Main page', children: [h('div', { class: 'bots-row bots-stack-row' }, [main.node])] }));
    }
    main.feed({ ...index(), limit: 512 * 1024 });
  }

  // -- Advanced: topics, archive, logs ----------------------------------------------------------------
  const topicName = h('input', { type: 'text', class: 'bots-mem-topic-name', placeholder: 'Topic name', maxlength: '64', 'aria-label': 'New topic name', autocomplete: 'off' });
  const topicDesc = h('input', { type: 'text', class: 'bots-mem-topic-desc', placeholder: 'What it covers', maxlength: '200', 'aria-label': 'New topic description', autocomplete: 'off' });
  const topicError = h('div', { class: 'bots-mem-status', role: 'status', 'aria-live': 'polite' });
  const topicList = h('div', { class: 'bots-mem-topic-list', role: 'list' });
  const newTopic = h('div', { class: 'bots-row bots-mem-new-topic' }, [topicName, topicDesc, Button({ label: 'Create topic', iconName: 'folder-plus', onClick: () => createTopic() })]);
  const docRows = h('div', { class: 'bots-mem-doc-list', role: 'list' });
  holders.topics.append(Card({ label: 'Topics', children: [topicList, newTopic, topicError] }), Card({ label: 'Archive and daily logs', children: [docRows] }));
  const files = kind => (S.overview?.files || []).filter(f => f.kind === kind);
  function docRow(file, title, hint) {
    const button = h('button', { type: 'button', class: 'bots-row bots-nav-row bots-mem-doc-row', role: 'listitem', 'data-doc-path': file.path, onclick: () => openDocument(file, title, button) }, [
      icon(file.kind === 'topic' ? 'book-open' : file.kind === 'log' ? 'clock' : 'archive', { size: 18 }),
      h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: title }), hint ? h('span', { class: 'bots-row-hint', text: hint }) : null]),
      h('span', { class: 'bots-row-value', text: formatBytes(file.bytes) }), h('span', { class: 'bots-chevron' }, [icon('chevron-right', { size: 16 })])]);
    return button;
  }
  function paintTopics() {
    const topics = files('topic'), archive = files('archive'), logs = files('log').sort((a, b) => b.path.localeCompare(a.path)).slice(0, 30);
    paintIf('topics', topics.map(t => [t.path, t.title, t.description, t.bytes]), () => {
      topicList.replaceChildren(...(topics.length ? topics.map(t => docRow(t, t.title || t.name, t.description)) : [line('No topics yet. A topic holds the detail on one subject, so the main page stays short.')]));
    });
    paintIf('docs', [archive.map(f => [f.path, f.bytes]), logs.map(f => [f.path, f.bytes])], () => {
      docRows.replaceChildren(...[...archive.map(f => docRow(f, 'Archive', 'Older and replaced notes')),
        ...logs.map(f => docRow(f, `Daily log, ${f.path.slice('memory/log/'.length, -3)}`, 'Read only')),
        ...(archive.length || logs.length ? [] : [line('Nothing archived or logged yet.')])]);
    });
  }
  async function createTopic() {
    const name = topicName.value.trim();
    const problem = topicNameError(name, files('topic').map(t => t.name));
    if (problem) { topicError.textContent = problem; topicName.focus(); return; }
    topicError.textContent = '';
    const description = topicDesc.value.replace(/\s+/g, ' ').trim().slice(0, 200);
    const text = `---\ntitle: ${name}\ndescription: ${description}\n---\n`;
    try {
      await ctx.flush?.();
      const result = await track(send(`/file?path=${enc(`memory/${name}.md`)}`, 'PUT', { text, expected_hash: ABSENT }));
      if (!gate.alive()) return;
      topicName.value = ''; topicDesc.value = '';
      await reload();
      const file = files('topic').find(f => f.path === result.file.path);
      if (file) openDocument(file, file.title || file.name, topicName);
    } catch (error) { topicError.textContent = parseFailure(error).message; }
  }
  function closeDocument({ force = false } = {}) {
    const doc = S.doc;
    if (!doc) return true;
    const done = () => {
      S.doc = null; holders.doc.replaceChildren();
      const opener = doc.opener;
      (opener?.isConnected ? opener : holders.topics.querySelector('button, input'))?.focus?.();
    };
    if (doc.view.dirty && !force) {
      ctx.ui.confirmDialog({ title: 'Discard your changes?', message: 'This note has changes that are not saved.', confirmLabel: 'Discard' }).then(yes => { if (yes && gate.alive()) done(); });
      return false;
    }
    done();
    return true;
  }
  async function openDocument(file, title, opener) {
    if (S.doc && S.doc.path !== file.path && !closeDocument()) return;
    if (S.doc && S.doc.path === file.path) { S.doc.view.area.focus(); return; }
    const readOnly = file.read_only === true || file.kind === 'log';
    const view = makeEditor({ path: file.path, label: title, readOnly, canDelete: file.kind === 'topic',
      onClose: () => closeDocument(),
      onChange: (result, extra) => { if (extra?.deleted) closeDocument({ force: true }); reload(); } });
    S.doc = { path: file.path, view, opener };
    holders.doc.replaceChildren(Card({ label: title, children: [h('div', { class: 'bots-row bots-stack-row' }, [view.node])] }));
    try { view.feed(await track(api(`/file?path=${enc(file.path)}`))); if (gate.alive()) view.area.focus(); }
    catch (error) { if (gate.alive()) { holders.doc.replaceChildren(Card({ children: [line(`This could not open. ${parseFailure(error).message}`, 'error'),
      h('div', { class: 'bots-actions' }, [Button({ label: 'Close', onClick: () => { S.doc = null; holders.doc.replaceChildren(); opener?.focus?.(); } })])] })); } }
  }

  // -- Advanced: tidy-up and the folder ----------------------------------------------------------------
  const tidyStatus = h('div', { class: 'bots-mem-status', role: 'status', 'aria-live': 'polite' });
  let upkeepRow = null, roomRow = null, tidyButton = null;
  function paintMaintenance() {
    const s = settings(), last = S.overview?.maintenance?.last;
    if (!upkeepRow) {
      upkeepRow = SwitchRow({ title: 'Keep its notes tidy', hint: 'When it has been quiet, it archives expired and repeated notes. You can undo each pass.', checked: !!s.upkeep,
        onChange: value => { ctx.update?.({ memory_upkeep: value }); if (S.overview) S.overview.settings.upkeep = value; paintMaintenance(); } });
      roomRow = SwitchRow({ title: 'Learn from rooms', hint: 'Used when rooms arrive in a later update. Saved now.', checked: !!s.room_capture,
        onChange: value => setSetting({ room_capture: value }, 'That setting') });
      tidyButton = Button({ label: 'Tidy now', iconName: 'sparkles', onClick: () => tidyNow() });
      holders.maintenance.append(Card({ label: 'Keeping it tidy', children: [upkeepRow, roomRow,
        h('div', { class: 'bots-row bots-mem-tidy' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: 'Tidy now' }),
          h('span', { class: 'bots-row-hint bots-mem-last', 'data-last': '' })]), tidyButton]), tidyStatus] }));
    }
    upkeepRow.setChecked(!!s.upkeep); roomRow.setChecked(!!s.room_capture);
    tidyButton.disabled = !s.upkeep || S.tidying;
    holders.maintenance.querySelector('[data-last]').textContent = s.upkeep
      ? (last ? `Last change: ${last.summary || 'tidied'} (${whenLabel(last.time)})` : 'Nothing tidied yet.') : 'Turn on tidying first.';
  }
  async function tidyNow() {
    S.tidying = true; tidyStatus.textContent = 'Tidying...'; paintMaintenance();
    try {
      await ctx.flush?.();
      const result = await track(send('/tidy', 'POST'));
      if (!gate.alive()) return;
      tidyStatus.textContent = (result.passes || []).length ? `Tidied ${result.passes.length} ${result.passes.length === 1 ? 'page' : 'pages'}.` : 'Nothing needed tidying.';
      await reload();
    } catch (error) { if (gate.alive()) tidyStatus.textContent = parseFailure(error).message; }
    finally { S.tidying = false; if (gate.alive()) paintMaintenance(); }
  }
  const folderStatus = h('div', { class: 'bots-mem-status', role: 'status', 'aria-live': 'polite' });
  holders.location.append(Card({ label: 'Where the notes live', children: [
    h('div', { class: 'bots-row bots-note-line' }, [icon('folder', { size: 16 }), h('span', { class: 'bots-row-hint', text: 'Plain Markdown files in a folder on this computer. Edit them in any editor; changes made outside are noticed and can be undone.' })]),
    h('div', { class: 'bots-actions bots-mem-open' }, [Button({ label: 'Open folder', iconName: 'folder', onClick: () => openFolder('folder') }),
      Button({ label: 'Open in Obsidian', iconName: 'external-link', onClick: () => openFolder('obsidian') })]), folderStatus] }));
  async function openFolder(target) {
    folderStatus.textContent = '';
    try { await track(send('/open', 'POST', { target })); if (gate.alive()) folderStatus.textContent = target === 'obsidian' ? 'Asked Obsidian to open it.' : 'Opened the folder.'; }
    catch (error) { if (gate.alive()) folderStatus.textContent = parseFailure(error).status === 403 ? 'This only works on the computer where the notes are stored.' : parseFailure(error).message; }
  }

  // -- Advanced: the change history ---------------------------------------------------------------------
  function paintJournal() {
    const rows = S.journal.slice(0, JOURNAL_ROWS);
    paintIf('journal', [rows.map(r => [r.id, r.reverted_by, r.revertible, r.summary, r.time]), [...S.expanded]], () => {
      holders.journal.replaceChildren(Card({ label: 'Change history', children: rows.length ? rows.map(changeRow)
        : [line('No changes yet. Every edit, by you or the bot, is listed here.')] }));
    });
  }
  function changeRow(row) {
    const open = S.expanded.has(row.id);
    const undo = undoState(row);
    const toggle = Button({ label: open ? 'Hide changes' : 'Show changes', iconName: open ? 'chevron-down' : 'chevron-right', onClick: () => {
      if (S.expanded.has(row.id)) S.expanded.delete(row.id); else S.expanded.add(row.id);
      paintJournal(); holders.journal.querySelector(`[data-change-id="${CSS_ESCAPE(row.id)}"] [data-toggle]`)?.focus();
    } });
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false'); toggle.dataset.toggle = '';
    const undoButton = Button({ label: row.reverted_by ? 'Undone' : 'Undo', iconName: 'undo-2', disabled: !undo.enabled, onClick: () => undoChange(row, undoButton) });
    if (!undo.enabled && undo.reason) undoButton.title = undo.reason;
    undoButton.dataset.undo = '';
    const diff = open ? h('pre', { class: 'bots-mem-diff', tabindex: '0', 'aria-label': 'Changes', 'data-diff': '' },
      (diffRows(row.diff).length ? diffRows(row.diff) : [{ kind: 'ctx', text: 'No text changes to show.' }]).map(r => h('span', { class: `bots-mem-diff-${r.kind}`, text: `${r.text}\n` }))) : null;
    return h('div', { class: 'bots-mem-change', 'data-change-id': row.id, 'data-reverted': row.reverted_by ? 'true' : 'false' }, [
      h('div', { class: 'bots-row' }, [h('span', { class: 'bots-row-main' }, [h('span', { class: 'bots-row-title', text: row.summary || 'Changed notes' }),
        h('span', { class: 'bots-row-hint', text: `${actorLabel(row.actor)} · ${whenLabel(row.time)}${row.reverted_by ? ' · undone' : ''}` })]), toggle, undoButton]), diff]);
  }
  async function undoChange(row, button) {
    button.disabled = true;
    try {
      await ctx.flush?.();
      await track(send(`/journal/${enc(row.id)}/revert`, 'POST'));
      if (!gate.alive()) return;
      say('Change undone', 'success');
      await reload();
    } catch (error) {
      if (!gate.alive()) return;
      const failure = parseFailure(error);
      say(failure.status === 409 ? `This cannot be undone now. ${failure.message}` : failure.message);
      await reload().catch(() => {});
    }
    holders.journal.querySelector(`[data-change-id="${CSS_ESCAPE(row.id)}"] [data-toggle]`)?.focus();
  }
  const CSS_ESCAPE = value => String(value).replace(/[^A-Za-z0-9_-]/g, '');

  // -- layout and loading -----------------------------------------------------------------------------
  function layout() {
    const simple = [banner, holders.master, holders.notes];
    const advanced = [banner, holders.master, holders.capacity, holders.notes, holders.main, holders.topics, holders.doc, holders.maintenance, holders.location, holders.journal];
    root.dataset.mode = S.advanced ? 'advanced' : 'simple';
    root.replaceChildren(state, ...(S.advanced ? advanced : simple));
  }
  function paintAll() {
    if (!gate.alive()) return;
    state.hidden = !S.loading && !S.failure;
    state.setAttribute('aria-busy', S.loading ? 'true' : 'false');
    state.replaceChildren(...(S.loading ? [line('Loading memory...')] : S.failure ? [line(S.failure, 'error'), Button({ label: 'Try again', iconName: 'refresh-cw', onClick: () => reload() })] : []));
    for (const key of Object.keys(holders)) holders[key].hidden = !S.overview;
    if (!S.overview) { banner.hidden = true; return; }
    paintMaster(); paintNotes();
    if (S.advanced) { paintCapacity(); paintMain(); paintTopics(); paintMaintenance(); paintJournal(); }
  }
  async function reload({ quiet = false } = {}) {
    const token = gate.next();
    if (!quiet && !S.overview) { S.loading = true; S.failure = ''; paintAll(); }
    try {
      const [overview, journal] = await Promise.all([api(''), S.advanced ? api(`/journal?limit=${JOURNAL_ROWS}`).catch(() => ({ rows: S.journal })) : Promise.resolve({ rows: S.journal })]);
      if (!gate.ok(token)) return;
      S.overview = overview; S.journal = journal.rows || []; S.loading = false; S.failure = '';
      if (S.doc && S.advanced) S.doc.view.latest().catch(() => {});
    } catch (error) {
      if (!gate.ok(token)) return;
      S.loading = false;
      if (!S.overview) S.failure = `Memory could not load. ${parseFailure(error).message}`;
      else if (!quiet) say(`Memory could not refresh. ${parseFailure(error).message}`);
    }
    paintAll();
  }

  let poll = null, unsubscribe = () => {};
  // The panel keeps this section mounted but never asks it to look again, so it polls on its own, quietly.
  // A poll never replaces a draft: the editor raises a conflict instead (botsMemoryModel.js createEditor).
  const start = () => {
    if (poll) return;
    unsubscribe = onBotsInterface(advanced => { S.advanced = !!advanced; signatures = {}; layout(); paintAll(); if (advanced) reload({ quiet: true }); });
    poll = setInterval(() => { if (typeof document === 'undefined' || (!document.hidden && host.isConnected)) reload({ quiet: true }); }, POLL_MS);
  };
  const stop = () => { clearInterval(poll); poll = null; unsubscribe(); unsubscribe = () => {}; };
  // The panel calls destroy() both when it closes and when it redraws around a section it keeps mounted (the
  // node is kept and put straight back, only the handle is released). One tick later the page says which:
  // still in the document means a redraw, so polling resumes and nothing is lost; gone means closed, so
  // pending replies are dropped. A page that was set aside wakes on its first touch.
  const revive = () => { if (gate.alive()) return; gate = createGate(); start(); reload({ quiet: true }); };
  for (const type of ['pointerdown', 'click', 'focusin', 'keydown']) root.addEventListener(type, revive, true);
  layout();
  paintAll();
  reload();
  start();

  return {
    destroy() {
      stop();
      setTimeout(() => { if (host.isConnected) start(); else gate.destroy(); }, 0);
    },
    refresh: () => { revive(); return gate.alive() ? reload({ quiet: true }) : Promise.resolve(); },
    flush: () => Promise.allSettled([...pending]).then(() => undefined),
  };
}

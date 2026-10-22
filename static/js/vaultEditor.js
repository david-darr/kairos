import { api, el, toast, confirmDialog, openPanelDialog } from './api.js';
import { copyText } from './chatContent.js';
import { forgeVendor } from './forgeEditor.js';
import { renderVaultBody } from './vaultReader.js';
import { phone } from './mobileShared.js';

// The Vault editor (Library Vault Polish, locked 2026-10-22): CodeMirror 6
// with Markdown, a coloured properties block, `[[` note completion and
// Ctrl/Cmd+S, beside a live preview (a Write / Preview switch on a phone).
// It edits raw text only; the server checks the version it opened and
// refuses a save over an outside edit (409).

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)|^---[ \t]*\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
export const hasFrontmatter = text => FRONTMATTER.test(text.replace(/^﻿/, ''));

// The properties block as Markdown syntax: `---` marks, keys and values get
// their own highlight tags. (A nested YAML parser would need the vendored
// CodeMirror bundle rebuilt; its sources are not installed.)
function frontmatterExtension(cm) {
  return {
    defineNodes: [
      { name: 'Frontmatter', block: true, style: cm.tags.meta },
      { name: 'FrontmatterMark', style: cm.tags.processingInstruction },
      { name: 'FrontmatterKey', style: cm.tags.propertyName },
      { name: 'FrontmatterValue', style: cm.tags.string },
    ],
    parseBlock: [{
      name: 'Frontmatter', before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
        const head = cx.input.read(0, Math.min(cx.input.length, 40000));
        if (!/^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.test(head) && !/^---[ \t]*\n(?:---|\.\.\.)/.test(head)) return false;
        const start = cx.lineStart, children = [cx.elt('FrontmatterMark', start, start + 3)];
        while (cx.nextLine()) {
          const from = cx.lineStart, text = line.text;
          if (/^(---|\.\.\.)\s*$/.test(text)) {
            children.push(cx.elt('FrontmatterMark', from, from + 3));
            const end = from + text.length;
            cx.nextLine();
            cx.addElement(cx.elt('Frontmatter', start, end, children));
            return true;
          }
          const pair = /^(\s*(?:-\s+)?)([A-Za-z0-9_][\w .-]*)(:)/.exec(text);
          if (pair) {
            const keyFrom = from + pair[1].length, keyTo = keyFrom + pair[2].length;
            children.push(cx.elt('FrontmatterKey', keyFrom, keyTo));
            if (from + text.length > keyTo + 1) children.push(cx.elt('FrontmatterValue', keyTo + 1, from + text.length));
          } else if (/^\s*-\s+\S/.test(text)) children.push(cx.elt('FrontmatterValue', from + text.indexOf('-') + 1, from + text.length));
        }
        cx.addElement(cx.elt('Frontmatter', start, cx.lineStart, children));
        return true;
      },
    }],
  };
}

function noteCompletion(store) {
  return context => {
    const match = context.matchBefore(/\[\[[^\]\n|#]*$/);
    if (!match) return null;
    const query = match.text.slice(2).toLowerCase();
    const options = store.notes
      .filter(note => !query || note.name.toLowerCase().includes(query) || note.id.toLowerCase().includes(query))
      .sort((a, b) => (a.name.toLowerCase().startsWith(query) ? 0 : 1) - (b.name.toLowerCase().startsWith(query) ? 0 : 1) || a.name.localeCompare(b.name))
      .slice(0, 60)
      .map(note => ({ label: note.name, detail: note.folder || 'Vault root', type: 'text',
        apply(view, completion, from, to) {
          const closed = view.state.sliceDoc(to, to + 2) === ']]';
          const insert = closed ? note.name : note.name + ']]';
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closed ? 2 : 0) } });
        } }));
    return { from: match.from + 2, options, validFor: /^[^\]\n|#]*$/ };
  };
}

export function mountVaultEditor(host, { store, node, note, onSaved, onCancel, onDirty, split = true }) {
  let disposed = false, saving = false, view = null, conflict = null;
  let version = note.version, original = note.content;
  const status = el('span', { class: 'vault-editor-status', role: 'status' });
  const save = el('button', { type: 'button', class: 'btn primary', text: 'Save', disabled: true });
  const cancel = el('button', { type: 'button', class: 'btn quiet', text: 'Done' });
  const modes = el('div', { class: 'segmented-tabs vault-editor-modes', role: 'group', 'aria-label': 'Editor view' });
  const editorHost = el('div', { class: 'vault-editor-code', 'aria-label': `Edit ${node.name}` });
  const preview = el('div', { class: 'vault-editor-preview library-vault-reading artifact-document', 'aria-label': 'Preview' });
  const panes = el('div', { class: 'vault-editor-panes' }, [editorHost, el('div', { class: 'vault-editor-preview-wrap' }, [el('div', { class: 'vault-editor-preview-label', text: 'Preview' }), preview])]);
  const root = el('div', { class: 'vault-editor' }, [
    el('div', { class: 'vault-editor-bar' }, [modes, status, el('span', { class: 'vault-editor-spacer' }), cancel, save]),
    panes,
  ]);
  root.dataset.split = String(split);
  host.replaceChildren(root);
  status.textContent = 'Loading editor...';
  let mode = 'write';
  const drawModes = () => {
    modes.replaceChildren(...[['write', 'Write'], ['preview', 'Preview']].map(([id, label]) => el('button', {
      type: 'button', class: 'segmented-tab' + (mode === id ? ' active' : ''), 'aria-pressed': String(mode === id), text: label,
      onclick: () => { mode = id; drawModes(); root.dataset.mode = mode; if (mode === 'preview') paint(); else view?.focus(); } })));
    root.dataset.mode = mode;
  };
  drawModes();

  const text = () => view ? view.state.doc.toString() : original;
  const dirty = () => !!view && text() !== original;
  let previewTimer = null;
  const paint = () => renderVaultBody(preview, text(), { name: node.name, links: note.links, store, onOpen: () => {} });
  const changed = () => {
    const isDirty = dirty();
    save.disabled = saving || !isDirty;
    status.textContent = isDirty ? 'Unsaved changes' : 'Saved';
    root.classList.toggle('dirty', isDirty);
    onDirty?.(isDirty);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { if (!disposed && (mode === 'preview' || (split && !phone.matches))) paint(); }, 180);
  };
  cancel.addEventListener('click', async () => { if (await canLeave()) onCancel?.(); });
  const completionData = [{ autocomplete: noteCompletion(store) }];
  const ready = forgeVendor().then(cm => {
    if (disposed) return;
    view = new cm.EditorView({
      parent: editorHost,
      state: cm.EditorState.create({
        doc: original,
        extensions: [
          cm.basicSetup,
          cm.markdown({ extensions: [frontmatterExtension(cm)] }),
          // One source object: CodeMirror tracks a running completion by its source's identity.
          cm.EditorState.languageData.of(() => completionData),
          cm.EditorView.lineWrapping,
          // Ctrl/Cmd+S saves and keeps editing; the Save button saves and returns to reading.
        cm.keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { store_(false); return true; } }]),
          cm.EditorView.theme({
            '&': { height: '100%', color: 'var(--text)', backgroundColor: 'transparent' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--rd-font-ui, var(--font-sans, sans-serif))', fontSize: '14px', lineHeight: '1.7' },
            '.cm-content': { caretColor: 'var(--text)', padding: '14px 0' },
            '.cm-cursor': { borderLeftColor: 'var(--text)' },
            '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-faint)', border: 'none' },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(var(--ink-rgb), .04)' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-dim)' },
            '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--bg-panel-solid)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '10px' },
            '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-dim)', color: 'var(--text)' },
            '.cm-completionDetail': { color: 'var(--text-dim)', fontStyle: 'normal', marginLeft: '8px' },
          '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--rd-font-ui, var(--font-sans, sans-serif))', fontSize: '13px', maxHeight: '14em' },
          '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px' },
          '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
          '.cm-completionIcon': { display: 'none' },
          }),
          cm.syntaxHighlighting(cm.HighlightStyle.define([
            { tag: cm.tags.heading, fontWeight: '600', color: 'var(--text)' },
            { tag: cm.tags.heading1, fontSize: '1.2em' },
            { tag: [cm.tags.emphasis], fontStyle: 'italic' },
            { tag: [cm.tags.strong], fontWeight: '600' },
            { tag: [cm.tags.link, cm.tags.url], color: 'var(--accent)' },
            { tag: [cm.tags.processingInstruction, cm.tags.meta], color: 'var(--text-faint)' },
            { tag: cm.tags.propertyName, color: 'var(--accent)' },
            { tag: cm.tags.string, color: 'var(--text)' },
            { tag: [cm.tags.monospace], color: 'var(--text-dim)', fontFamily: 'var(--font-mono, monospace)' },
            { tag: [cm.tags.quote], color: 'var(--text-dim)', fontStyle: 'italic' },
            { tag: [cm.tags.list], color: 'var(--text-dim)' },
          ])),
          cm.EditorView.updateListener.of(update => { if (update.docChanged) changed(); }),
        ],
      }),
    });
    status.textContent = 'Saved';
    paint();
    save.addEventListener('click', () => store_(true));
    if (!phone.matches) view.focus();
  }).catch(error => { if (!disposed) { status.textContent = `The editor could not load: ${error.message}`; } });

  async function store_(close) {
    if (disposed || saving || !dirty()) return;
    const content = text();
    let allow = false;
    if (hasFrontmatter(original) && !hasFrontmatter(content)) {
      allow = await confirmDialog({ title: 'Remove the properties block?', message: 'This note had a properties block (the --- lines with status, project and type) at the top. Saving now removes it.', confirmLabel: 'Remove and save' });
      if (!allow || disposed) return;
    }
    saving = true; save.disabled = true; status.textContent = 'Saving...';
    try {
      const saved = await api('/api/vault/note', { method: 'POST', toast: false, body: JSON.stringify({ path: node.id, content, version, allow_remove_properties: allow }) });
      if (disposed) return;
      version = saved.version; original = content; note = { ...note, ...saved };
      changed(); status.textContent = 'Saved';
      toast('Vault note saved', 'success');
      await onSaved?.(saved);
      if (close && !disposed) onCancel?.();
    } catch (error) {
      if (disposed) return;
      const message = error.message.replace(/^\d+: /, '');
      status.textContent = message;
      if (/^409:/.test(error.message) && /changed since/i.test(message)) showConflict(content);
      else toast(message, 'error');
    } finally { saving = false; if (!disposed) save.disabled = !dirty(); }
  }

  function showConflict(mine) {
    conflict?.close();
    const reload = el('button', { class: 'btn', text: 'Reload their version' });
    const copy = el('button', { class: 'btn primary', text: 'Copy my version' });
    conflict = openPanelDialog({ title: 'This note changed since you opened it', className: 'vault-conflict-dialog', opener: save,
      body: el('div', {}, [
        el('p', { text: 'Someone or something (Obsidian, a chat, a sync) saved this note after you opened it. Nothing was overwritten.' }),
        el('p', { class: 'meta', text: 'Copy your version first if you want to keep your edits, then reload to see theirs.' }),
      ]),
      footer: el('div', { class: 'vault-conflict-actions' }, [copy, reload]) });
    copy.addEventListener('click', () => copyText(mine));
    reload.addEventListener('click', async () => {
      try {
        const latest = await api(`/api/vault/note?path=${encodeURIComponent(node.id)}`);
        if (disposed) return;
        version = latest.version; original = latest.content; note = latest;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: latest.content } });
        changed(); conflict.close(); conflict = null;
        toast('Loaded the latest version', 'success');
      } catch (problem) { toast(problem.message.replace(/^\d+: /, ''), 'error'); }
    });
  }

  async function canLeave() {
    if (!dirty()) return true;
    return confirmDialog({ title: 'Discard note edits?', message: 'Your unsaved changes to this Vault note will be lost.', confirmLabel: 'Discard changes' });
  }

  return {
    canLeave, dirty, ready, get view() { return view; },
    get version() { return version; },
    destroy() { disposed = true; clearTimeout(previewTimer); conflict?.close(); view?.destroy(); },
  };
}

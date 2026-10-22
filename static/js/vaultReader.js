import { api, el, toast, confirmDialog, openPanelDialog, openOptionMenu } from './api.js';
import { renderMessageBody, copyText } from './chatContent.js';
import { relativeTime, REQUIRED_PROPERTIES } from './vaultStore.js';
import { mountLocalGraph } from './vaultLocalGraph.js';

// The one Vault reader (Library Vault Polish, 2026-10-22): header,
// properties, body, wikilinks and the context rail, shared by Browse, Map
// and the phone page. Links come resolved from the server (note.links), so
// the reader never guesses a target.

export const VAULT_ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  folderOpen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17.5V7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2h7.5A1.5 1.5 0 0 1 19.5 9.5V11"/><path d="M3 17.5l2.4-5.7A1.5 1.5 0 0 1 6.8 11H21l-2.6 6.9a1.5 1.5 0 0 1-1.4 1.1H4.5A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8 8l2.8 7.2M16.4 7.6l-3 7.4M8.2 7h7.6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/></svg>',
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M12 13v5M9.5 15.5h5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
  rail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M15 5v14"/></svg>',
};

export function icon(name, className = 'vault-icon') {
  const node = el('span', { class: className, 'aria-hidden': 'true' });
  node.innerHTML = VAULT_ICONS[name];
  return node;
}

const STATUS_TONE = { active: 'ok', live: 'ok', shipped: 'ok', done: 'quiet', complete: 'quiet', completed: 'quiet', archived: 'quiet',
  draft: 'warn', plan: 'warn', planned: 'warn', 'in-progress': 'warn', 'in progress': 'warn', review: 'warn', paused: 'warn', blocked: 'danger' };
export const statusTone = value => STATUS_TONE[String(value || '').toLowerCase()] || 'plain';

export function propertyPills(node, { compact = false } = {}) {
  const front = node?.frontmatter || {};
  const wrap = el('div', { class: 'vault-properties', role: 'list', 'aria-label': 'Properties' });
  for (const key of REQUIRED_PROPERTIES) {
    const value = front[key];
    if (value) wrap.append(el('span', { role: 'listitem', class: `vault-pill vault-pill-${key}` + (key === 'status' ? ` tone-${statusTone(value)}` : ''),
      title: `${key}: ${value}`, text: compact ? String(value) : String(value) }));
    else if (!compact) wrap.append(el('span', { role: 'listitem', class: 'vault-pill vault-pill-missing', title: `This note has no ${key} property`, text: `No ${key}` }));
  }
  if (!compact) {
    for (const [key, value] of Object.entries(front)) {
      if (REQUIRED_PROPERTIES.includes(key)) continue;
      const text = Array.isArray(value) ? value.join(', ') : String(value);
      wrap.append(el('span', { role: 'listitem', class: 'vault-pill vault-pill-extra', title: `${key}: ${text}` }, [
        el('span', { class: 'vault-pill-key', text: key }), el('span', { text }),
      ]));
    }
  }
  return wrap;
}

// -- the body -----------------------------------------------------------------

function remoteImage(url, alt) {
  let host = url;
  try { host = new URL(url).host; } catch { /* Shown as given. */ }
  // The app never loads a remote image on its own (the CSP allows only its
  // own images, and opening a note must not call out to a server). The
  // person chooses to open it; it opens in the side browser or a new tab.
  return el('span', { class: 'vault-remote-image' }, [
    el('span', { class: 'vault-remote-image-copy' }, [
      el('strong', { text: alt || 'Remote image' }),
      el('small', { text: `Not loaded. From ${host}` }),
    ]),
    el('a', { class: 'btn quiet', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Open image' }),
  ]);
}

function calloutBlocks(body) {
  for (const quote of body.querySelectorAll('blockquote')) {
    const first = quote.firstElementChild;
    const match = first?.tagName === 'P' && /^\[!([a-z-]+)\]([+-]?)\s*([^\n]*)/i.exec(first.textContent);
    if (!match) continue;
    const kind = match[1].toLowerCase();
    // Rebuild the first paragraph without the marker line; keep the rest of its nodes.
    const titleText = match[3].trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
    const markerLine = first.firstChild;
    if (markerLine?.nodeType === Node.TEXT_NODE) {
      const rest = markerLine.textContent.split('\n').slice(1).join('\n');
      markerLine.textContent = rest;
    }
    if (!first.textContent.trim()) first.remove();
    const callout = el('div', { class: `vault-callout vault-callout-${kind}`, role: 'note' }, [el('div', { class: 'vault-callout-title', text: titleText })]);
    callout.append(...quote.childNodes);
    quote.replaceWith(callout);
  }
}

function linkWikilinks(body, links, store, onOpen) {
  const byRaw = new Map((links || []).map(link => [link.raw, link]));
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const found = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('pre, code') && /\[\[.+?\]\]/.test(node.textContent)) found.push(node);
  }
  for (const textNode of found) {
    const source = textNode.textContent;
    const fragment = document.createDocumentFragment();
    const pattern = /(!?)\[\[([^[\]\n]+?)\]\]/g;
    let last = 0, match;
    while ((match = pattern.exec(source))) {
      fragment.append(document.createTextNode(source.slice(last, match.index)));
      const raw = match[2];
      const link = byRaw.get(raw) || { kind: 'missing', target: raw.split('|')[0].split('#')[0], alias: raw.split('|')[1] || '' };
      const target = link.id ? store.note(link.id) : null;
      const label = link.alias || (link.heading ? `${(link.target || '').split('/').pop() || target?.name || ''} > ${link.heading}` : (link.target || raw).split('/').pop());
      if (match[1] && target) {
        fragment.append(el('button', { type: 'button', class: 'vault-embed-card', title: `Open ${target.name}`, onclick: () => onOpen(target.id) }, [
          icon('note'), el('span', { class: 'vault-embed-copy' }, [el('strong', { text: target.name }), el('small', { text: target.folder || 'Vault root' })]),
        ]));
      } else if (match[1] && link.kind === 'attachment') {
        fragment.append(el('span', { class: 'vault-embed-card vault-embed-file', title: 'Attachment (open it in Obsidian)' }, [
          el('span', { class: 'vault-embed-copy' }, [el('strong', { text: link.target.split('/').pop() }), el('small', { text: 'Attachment' })]),
        ]));
      } else if (target) {
        fragment.append(el('button', { type: 'button', class: 'vault-note-link', title: target.id, text: label, onclick: () => onOpen(target.id) }));
      } else if (link.kind === 'self') {
        fragment.append(el('span', { class: 'vault-note-link vault-link-self', text: link.heading || label }));
      } else {
        fragment.append(el('span', { class: 'vault-link-missing', title: 'Not in vault', text: label }));
      }
      last = pattern.lastIndex;
    }
    fragment.append(document.createTextNode(source.slice(last)));
    textNode.replaceWith(fragment);
  }
}

export function stripFrontmatter(text) {
  return text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '').replace(/^---[ \t]*\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
}

// Renders a note's Markdown into `body`: frontmatter hidden, a leading H1
// that repeats the note's name hidden (the header shows it once), callouts
// and embeds as blocks, wikilinks resolved, remote images click-to-open.
export function renderVaultBody(body, content, { name, links, store, onOpen }) {
  renderMessageBody(body, stripFrontmatter(content), null, true, { remoteImage });
  const first = body.firstElementChild;
  if (first?.tagName === 'H1' && name && first.textContent.trim().toLowerCase() === name.trim().toLowerCase()) {
    first.hidden = true; first.classList.add('vault-title-echo');
  }
  calloutBlocks(body);
  linkWikilinks(body, links, store, onOpen);
  return body;
}

// -- the note view ------------------------------------------------------------

export function noteMeta(node, note) {
  const parts = [];
  const change = note?.last_change;
  const when = relativeTime(change?.when || node?.mtime);
  if (when) {
    let by = '';
    if (change?.kairos) by = /^You, in Library$/.test(change.label) ? ' by you' : change.label === 'Restored in Kairos' ? ' (restored)' : ' by Kairos';
    parts.push(`Edited ${when}${by}`);
  }
  if (node?.words != null) parts.push(`${node.words.toLocaleString()} words`);
  return parts.join(' · ');
}

export function breadcrumb(node, store, { onOpen, onFolder }) {
  const nav = el('nav', { class: 'vault-crumbs', 'aria-label': 'Folder' });
  const parts = (node.folder || '').split('/').filter(Boolean);
  const crumbs = [{ id: '', label: 'Vault' }, ...parts.map((part, i) => ({ id: parts.slice(0, i + 1).join('/'), label: part }))];
  crumbs.forEach((crumb, i) => {
    const index = store.folderIndex(crumb.id);
    nav.append(el('button', { type: 'button', class: 'vault-crumb', text: crumb.label,
      title: index ? `Open ${index.name}` : `Show ${crumb.label}`,
      onclick: () => (index && index.id !== node.id ? onOpen(index.id) : onFolder?.(crumb.id)) }));
    if (i < crumbs.length - 1) nav.append(el('span', { class: 'vault-crumb-sep', 'aria-hidden': 'true', text: '/' }));
  });
  return nav;
}

// One menu for a note's secondary actions.
export function moreMenu(anchor, node, { onHistory, onMap, admin }) {
  const items = [
    { value: 'path', text: 'Copy path' },
    { value: 'link', text: 'Copy wikilink' },
  ];
  if (admin && window.jarvis?.vault?.openInObsidian) items.push({ value: 'obsidian', text: 'Open in Obsidian' });
  if (admin && onHistory) items.push({ value: 'history', text: 'History' });
  if (onMap) items.push({ value: 'map', text: 'Show on map' });
  openOptionMenu(anchor, items, async value => {
    if (value === 'path') copyText(node.id);
    else if (value === 'link') copyText(`[[${node.name}]]`);
    else if (value === 'history') onHistory();
    else if (value === 'map') onMap(node.id);
    else if (value === 'obsidian') {
      try {
        const { url } = await api(`/api/vault/obsidian-url?path=${encodeURIComponent(node.id)}`);
        const result = await window.jarvis.vault.openInObsidian(url);
        if (!result?.ok) toast('Obsidian did not open. Is it installed?', 'error');
      } catch (error) { toast(error.message.replace(/^\d+: /, ''), 'error'); }
    }
  });
}

export async function askKairos(node) {
  const { switchTab } = await import('./app.js');
  await switchTab('chat', { mobileConversation: true, references: [{ kind: 'note', id: node.id, label: node.name }] });
}

// -- the context rail -----------------------------------------------------------

function railSection(key, title, count, body, { open = true } = {}) {
  const details = el('details', { class: `vault-rail-section vault-rail-${key}`, open }, [
    el('summary', {}, [el('span', { text: title }), count != null ? el('span', { class: 'vault-rail-count', text: String(count) }) : null]),
    body,
  ]);
  return details;
}

// "See [[Folder/Note|the note]]" reads as "See the note" in a one-line snippet.
export const plainLinks = text => text.replace(/!?\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]+))?\]\]/g, (_, target, heading, alias) => alias || (target ? target.split('/').pop() : heading || ''));

function noteRow(store, id, { snippet = '', onOpen, missing = false } = {}) {
  if (missing) return el('div', { class: 'vault-rail-row vault-rail-missing', title: 'Not in vault' }, [
    el('span', { class: 'vault-rail-name', text: id }), el('small', { text: 'Not in vault' }),
  ]);
  const node = store.note(id);
  return el('button', { type: 'button', class: 'vault-rail-row', title: id, onclick: () => onOpen(id) }, [
    el('span', { class: 'vault-rail-name', text: node?.name || id.split('/').pop().replace(/\.md$/i, '') }),
    snippet ? el('small', { class: 'vault-rail-snippet', text: plainLinks(snippet) }) : el('small', { text: node?.folder || 'Vault root' }),
  ]);
}

export function renderRail({ store, node, note, onOpen, onFocusMap, admin, onHistoryChanged }) {
  const rail = el('div', { class: 'vault-rail-body' });
  const disposers = [];
  // 1. Properties
  rail.append(railSection('properties', 'Properties', null, propertyPills(node)));
  // 2. Linked from
  const backlinks = note?.backlinks || (store.backlinks.get(node.id) || []).map(id => ({ id, snippet: '' }));
  const from = el('div', { class: 'vault-rail-list' });
  if (!backlinks.length) from.append(el('p', { class: 'vault-rail-empty', text: 'No notes link here yet.' }));
  for (const item of backlinks) from.append(noteRow(store, item.id, { snippet: item.snippet, onOpen }));
  rail.append(railSection('backlinks', 'Linked from', backlinks.length, from));
  // 3. Links out: resolved, then missing
  const out = el('div', { class: 'vault-rail-list' });
  const outIds = store.outlinks.get(node.id) || [];
  const missing = store.missing.get(node.id) || [];
  if (!outIds.length && !missing.length) out.append(el('p', { class: 'vault-rail-empty', text: 'This note links to nothing.' }));
  for (const id of outIds) out.append(noteRow(store, id, { onOpen }));
  for (const target of missing) out.append(noteRow(store, target, { missing: true }));
  rail.append(railSection('links', 'Links out', outIds.length + missing.length, out));
  // 4. Related (keywords, not meaning: there is no semantic search yet)
  const related = el('div', { class: 'vault-rail-list' }, [el('p', { class: 'vault-rail-empty', text: 'Looking for related notes...' })]);
  const relatedSection = railSection('related', 'Related by keywords', null, related, { open: false });
  let relatedLoaded = false;
  const loadRelated = async () => {
    if (relatedLoaded) return; relatedLoaded = true;
    try {
      const { results } = await api(`/api/vault/related?path=${encodeURIComponent(node.id)}`);
      related.replaceChildren(...(results.length ? results.map(r => noteRow(store, r.path, { onOpen })) : [el('p', { class: 'vault-rail-empty', text: 'No notes share enough words with this one.' })]));
    } catch { related.replaceChildren(el('p', { class: 'vault-rail-empty', text: 'Related notes are unavailable.' })); }
  };
  relatedSection.addEventListener('toggle', () => { if (relatedSection.open) loadRelated(); });
  rail.append(relatedSection);
  // 5. Local graph
  const graphHost = el('div', { class: 'vault-local-graph' });
  const depth = el('div', { class: 'vault-depth', role: 'group', 'aria-label': 'Link depth' });
  let graph = null, currentDepth = 1;
  const drawDepth = () => {
    depth.replaceChildren(...[1, 2].map(d => el('button', { type: 'button', class: 'vault-depth-btn' + (d === currentDepth ? ' active' : ''), 'aria-pressed': String(d === currentDepth), text: d === 1 ? 'Direct' : '2 steps',
      onclick: () => { currentDepth = d; drawDepth(); graph?.setDepth(d); } })));
  };
  drawDepth();
  const openMap = el('button', { type: 'button', class: 'btn quiet vault-open-map', text: 'Open in Map', onclick: () => onFocusMap?.(node.id, currentDepth) });
  const graphSection = railSection('graph', 'Local graph', null, el('div', {}, [graphHost, el('div', { class: 'vault-graph-foot' }, [depth, onFocusMap ? openMap : null])]));
  rail.append(graphSection);
  const startGraph = () => { if (!graph && graphSection.open && graphHost.isConnected) { graph = mountLocalGraph(graphHost, store, node.id, { depth: currentDepth, onOpen }); disposers.push(() => graph.destroy()); } };
  graphSection.addEventListener('toggle', startGraph);
  // 6. History (admin data)
  if (admin) {
    const history = el('div', { class: 'vault-rail-list' }, [el('p', { class: 'vault-rail-empty', text: 'Loading history...' })]);
    const historySection = railSection('history', 'History', null, history, { open: false });
    const loadHistory = async () => {
      try {
        const data = await api(`/api/vault/activity?path=${encodeURIComponent(node.id)}`);
        history.replaceChildren(...historyRows(data, node, { onChanged: onHistoryChanged }));
        historySection.querySelector('.vault-rail-count')?.remove();
        historySection.querySelector('summary').append(el('span', { class: 'vault-rail-count', text: String(data.entries.length) }));
      } catch { history.replaceChildren(el('p', { class: 'vault-rail-empty', text: 'History is unavailable.' })); }
    };
    historySection.addEventListener('toggle', () => { if (historySection.open) loadHistory(); });
    rail.append(historySection);
    rail.openHistory = () => { historySection.open = true; historySection.scrollIntoView({ block: 'nearest' }); };
  }
  rail.start = startGraph;
  rail.destroy = () => disposers.forEach(fn => fn());
  return rail;
}

function historyRows(data, node, { onChanged }) {
  const rows = [];
  if (data.outside) rows.push(el('div', { class: 'vault-history-row vault-history-outside' }, [
    el('span', { class: 'vault-history-label', text: data.outside.label }), el('small', { text: relativeTime(data.outside.when) }),
  ]));
  for (const entry of data.entries) {
    const stats = entry.created ? 'Created' : entry.added != null ? `+${entry.added} −${entry.removed}` : '';
    rows.push(el('button', { type: 'button', class: 'vault-history-row', onclick: () => openChange(entry, node, onChanged) }, [
      el('span', { class: 'vault-history-label', text: entry.label }),
      el('small', { text: [relativeTime(entry.when), stats, entry.restore_state === 'restored' ? 'Restored' : ''].filter(Boolean).join(' · ') }),
    ]));
  }
  if (!rows.length) rows.push(el('p', { class: 'vault-rail-empty', text: 'No recorded changes. Edits made outside Kairos before today are not tracked.' }));
  return rows;
}

export function diffView(text) {
  const pre = el('pre', { class: 'vault-diff', tabindex: '0', 'aria-label': 'Changes' });
  for (const line of (text || 'No text diff.').split('\n')) {
    const kind = line.startsWith('+++') || line.startsWith('---') ? 'file' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    pre.append(el('span', { class: `vault-diff-${kind}`, text: line + '\n' }));
  }
  return pre;
}

async function openChange(entry, node, onChanged) {
  let full;
  try { full = await api(`/api/file-checkpoints/${encodeURIComponent(entry.event_id)}`); }
  catch (error) { toast(error.message.replace(/^\d+: /, ''), 'error'); return; }
  const root = full.roots.find(r => r.path === entry.root);
  const change = root?.changes.find(c => c.path === node.id);
  if (!change) { toast('This change is no longer recorded.', 'error'); return; }
  const state = { available: 'Restoring puts the note back to how it was before this change.',
    changed_since: 'The note changed again after this, so it can no longer be restored from here.',
    at_before: 'The note is already back to how it was before this change.', restored: 'This change was already restored.' }[change.restore_state] || '';
  const restore = el('button', { class: 'btn danger', text: 'Restore before this change', disabled: change.restore_state !== 'available' });
  const dialog = openPanelDialog({ title: `${entry.label} · ${relativeTime(entry.when)}`, wide: true, className: 'vault-change-dialog',
    body: el('div', { class: 'vault-change' }, [el('p', { class: 'meta', text: state }), diffView(change.diff)]),
    footer: el('div', { class: 'vault-change-actions' }, [restore]) });
  restore.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Restore this note?', message: `"${node.name}" goes back to how it was before this change. The restore is checked first: it is refused if the note changed since.`, confirmLabel: 'Restore note' });
    if (!ok) return;
    try {
      await api(`/api/file-checkpoints/${encodeURIComponent(entry.event_id)}/restore`, { method: 'POST', toast: false, body: JSON.stringify({ files: [{ root: entry.root, path: node.id }] }) });
      toast('Note restored', 'success'); dialog.close(); onChanged?.();
    } catch (error) { toast(error.message.replace(/^\d+: /, ''), 'error'); }
  });
}

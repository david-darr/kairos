import { api, el, toast } from './api.js';
import { mobileOn, phone, edgeBlur, haptic } from './mobileShared.js';
import { openMobileSheet } from './mobileSheet.js';
import { createVaultStore, railOpen, setRailOpen, relativeTime } from './vaultStore.js';
import { icon, renderVaultBody, renderRail, breadcrumb, noteMeta, moreMenu, askKairos, propertyPills } from './vaultReader.js';
import { renderVaultHome, createTodaysNote, indexPrompt } from './vaultHome.js';
import { mountVaultEditor } from './vaultEditor.js';

// Library > Vault > Browse (Library Vault Polish, locked 2026-10-22): one
// working surface of sidebar, reader and context rail on desktop; on a phone
// the shell's list and detail pattern, with the rail as a bottom sheet.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function createVaultExplorer(container, { store = createVaultStore(), open: initial = null, onMap } = {}) {
  let disposed = false, selected = null, note = null, editor = null, rail = null, sheet = null, requestVersion = 0, searchVersion = 0;
  let pendingIndex = null, searchTimer = null, home = null, admin = false, titleObserver = null;
  const openFolders = new Set();

  const search = el('input', { type: 'search', class: 'library-vault-search', placeholder: 'Search vault', 'aria-label': 'Search vault notes', autocomplete: 'off' });
  search.dataset.mobileDock = 'search';
  const homeBtn = el('button', { type: 'button', class: 'vault-mode-pill active', 'aria-pressed': 'true', title: 'Vault Home' }, [icon('home'), el('span', { text: 'Home' })]);
  const mapBtn = el('button', { type: 'button', class: 'vault-mode-pill', 'aria-pressed': 'false', title: 'Map of links' }, [icon('map'), el('span', { text: 'Map' })]);
  const todayBtn = el('button', { type: 'button', class: 'vault-today-btn', title: "Today's note", 'aria-label': "Today's note", hidden: true }, [icon('today')]);
  const refreshBtn = el('button', { type: 'button', class: 'vault-refresh-btn', title: 'Reload the vault from disk', 'aria-label': 'Refresh vault' }, [icon('refresh')]);
  todayBtn.dataset.mobileDock = 'create'; todayBtn.dataset.mobileCreateLabel = "Today's note";
  const count = el('div', { class: 'vault-count', 'aria-live': 'polite', text: 'Loading vault...' });
  const tree = el('div', { class: 'library-vault-tree', role: 'navigation', 'aria-label': 'Vault notes' });
  const sidebar = el('aside', { class: 'library-vault-sidebar' }, [
    el('div', { class: 'library-vault-sidebar-head' }, [search, el('div', { class: 'vault-mode-row' }, [homeBtn, mapBtn, refreshBtn, todayBtn])]),
    count, tree,
  ]);
  const homeHost = el('div', { class: 'vault-home-host' });
  const reader = el('section', { class: 'library-vault-reader', 'aria-label': 'Note' });
  const railHost = el('aside', { class: 'vault-rail', 'aria-label': 'About this note' });
  const browser = el('div', { class: 'library-vault-browser' }, [sidebar, reader, railHost]);
  container.replaceChildren(browser);

  homeBtn.addEventListener('click', () => goHome());
  // The Map pill opens the whole map, with the open note highlighted; the
  // rail's "Open in Map" opens it focused on the note instead.
  mapBtn.addEventListener('click', async () => { if (await canLeave()) onMap?.(null, 1, selected); });
  todayBtn.addEventListener('click', () => openToday());
  refreshBtn.addEventListener('click', async () => {
    if (!await canLeave()) return;
    editor?.destroy(); editor = null; browser.classList.remove('vault-editing');
    refreshBtn.disabled = true; count.textContent = 'Loading vault...';
    try { await store.load(); if (!disposed) { drawCount(); showHome(); } }
    catch (error) { if (!disposed) count.textContent = 'Vault unavailable'; toast(error.message.replace(/^\d+: /, ''), 'error'); }
    finally { refreshBtn.disabled = false; }
  });
  search.addEventListener('input', () => { drawTree(); scheduleSearch(); });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { search.value = ''; drawTree(); }
    if (event.key === 'Enter') tree.querySelector('button.library-vault-note')?.click();
  });

  const unsubscribe = store.on(kind => { if (!disposed && (kind === 'pins' || kind === 'recent')) drawTree(); });
  load();

  async function load() {
    const version = ++requestVersion;
    try {
      if (!store.graph) await store.load();
      if (disposed || version !== requestVersion) return;
      admin = !!store.daily?.can_create;
      todayBtn.hidden = !(admin && store.daily?.template_exists);
      drawCount(); drawTree();
      if (initial && store.note(initial)) await openNote(initial);
      else showHome();
    } catch (error) {
      if (disposed || version !== requestVersion) return;
      count.textContent = 'Vault unavailable';
      tree.replaceChildren(el('div', { class: 'library-empty', text: error.message.replace(/^\d+: /, '') }));
    }
  }

  function drawCount() {
    const folders = store.graph.nodes.filter(n => n.type === 'folder').length - 1;
    count.textContent = `${store.notes.length} notes · ${folders} folders`;
  }

  // -- the sidebar -------------------------------------------------------------
  function noteRow(node, { showPath = false, label = null } = {}) {
    const row = el('button', { type: 'button', class: 'library-vault-note' + (selected === node.id ? ' active' : ''), title: node.id,
      onclick: () => openNote(node.id) }, [
      icon('note', 'library-vault-mark'), el('span', { class: 'vault-row-name', text: showPath ? node.id.replace(/\.md$/i, '') : node.name }),
      label ? el('span', { class: 'vault-row-tag', text: label }) : null,
    ]);
    if (selected === node.id) row.setAttribute('aria-current', 'page');
    return row;
  }

  function folderRow(node) {
    const body = el('div', { class: 'library-vault-children' });
    const total = store.countNotes(node.id);
    const mark = icon(openFolders.has(node.id) ? 'folderOpen' : 'folder', 'library-vault-mark');
    const details = el('details', { class: 'library-vault-folder', open: openFolders.has(node.id) }, [
      el('summary', { class: 'library-vault-folder-summary' }, [mark, el('span', { class: 'vault-row-name', text: node.name }),
        el('span', { class: 'vault-soft-count', text: String(total) })]),
      body,
    ]);
    const fill = () => {
      if (body.childElementCount) return;
      const dated = store.isDatedFolder(node.id);
      let month = null;
      for (const child of store.sortedChildren(node.id)) {
        if (child.type === 'folder') { body.append(folderRow(child)); continue; }
        if (dated && child.daily) {
          const key = child.name.slice(0, 7);
          if (key !== month) {
            month = key;
            body.append(el('div', { class: 'vault-month-head', 'aria-hidden': 'true', text: `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` }));
          }
        }
        body.append(noteRow(child, { label: store.isIndex(child) ? 'Index' : null }));
      }
      if (!body.childElementCount) body.append(el('div', { class: 'vault-rail-empty', text: 'Empty folder' }));
    };
    if (details.open) fill();
    details.addEventListener('toggle', () => {
      if (details.open) { openFolders.add(node.id); fill(); } else openFolders.delete(node.id);
      mark.innerHTML = icon(details.open ? 'folderOpen' : 'folder').innerHTML;
    });
    return details;
  }

  function group(title, rows, { open = true, key } = {}) {
    if (!rows.length) return null;
    return el('details', { class: `vault-group vault-group-${key}`, open }, [
      el('summary', { class: 'vault-group-summary' }, [el('span', { text: title }), el('span', { class: 'vault-soft-count', text: String(rows.length) })]),
      el('div', { class: 'vault-group-body' }, rows),
    ]);
  }

  function drawTree() {
    if (!store.graph) return;
    const q = search.value.trim().toLowerCase();
    if (q) { drawSearch(q); return; }
    const pins = store.pins.map(id => store.note(id)).filter(Boolean).map(node => noteRow(node));
    const recent = store.recent.map(id => store.note(id)).filter(Boolean).map(node => noteRow(node));
    const roots = store.sortedChildren('').map(node => node.type === 'folder' ? folderRow(node) : noteRow(node, { label: node.id === 'Vault Index.md' ? 'Index' : null }));
    tree.replaceChildren(...[group('Pinned', pins, { key: 'pinned' }), group('Recent', recent, { key: 'recent', open: !pins.length || recent.length <= 4 }),
      group('Folders', roots, { key: 'folders' })].filter(Boolean));
    if (!roots.length) tree.append(el('div', { class: 'library-empty', text: 'No Markdown notes in this vault.' }));
  }

  let ftsResults = null, ftsQuery = '';
  function drawSearch(q) {
    const names = store.graph.nodes.filter(node => node.id && `${node.name} ${node.id}`.toLowerCase().includes(q)).slice(0, 30);
    const rows = names.map(node => node.type === 'folder'
      ? el('button', { type: 'button', class: 'library-vault-note vault-folder-hit', onclick: () => revealFolder(node.id) }, [icon('folder', 'library-vault-mark'), el('span', { class: 'vault-row-name', text: node.id })])
      : noteRow(node, { showPath: true }));
    const parts = [];
    parts.push(rows.length ? group('Names', rows, { key: 'names' }) : el('div', { class: 'library-empty', text: 'No note or folder names match.' }));
    if (ftsQuery === q && ftsResults) {
      const hits = ftsResults.results.filter(hit => store.note(hit.path)).map(hit => searchHit(hit, ftsResults.mark));
      parts.push(hits.length ? group('In note text', hits, { key: 'text' }) : el('div', { class: 'library-empty', text: 'No note text matches.' }));
    } else parts.push(el('div', { class: 'vault-searching meta', text: 'Searching note text...' }));
    tree.replaceChildren(...parts);
  }

  function highlighted(snippet, [open, close]) {
    const out = el('small', { class: 'vault-snippet' });
    let rest = snippet.replace(/\s+/g, ' ');
    while (rest) {
      const at = rest.indexOf(open);
      if (at < 0) { out.append(rest); break; }
      out.append(rest.slice(0, at));
      const end = rest.indexOf(close, at);
      out.append(el('mark', { text: rest.slice(at + 1, end < 0 ? undefined : end) }));
      rest = end < 0 ? '' : rest.slice(end + 1);
    }
    return out;
  }

  function searchHit(hit, marks) {
    const node = store.note(hit.path);
    return el('button', { type: 'button', class: 'library-vault-note vault-search-hit' + (selected === node.id ? ' active' : ''), title: node.id, onclick: () => openNote(node.id) }, [
      icon('note', 'library-vault-mark'),
      el('span', { class: 'vault-hit-copy' }, [el('span', { class: 'vault-row-name', text: node.name }), highlighted(hit.snippet || '', marks)]),
    ]);
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (!q) return;
    const version = ++searchVersion;
    searchTimer = setTimeout(async () => {
      try {
        const results = await api(`/api/vault/search?q=${encodeURIComponent(q)}`);
        if (disposed || version !== searchVersion) return;
        ftsResults = results; ftsQuery = q.toLowerCase();
        if (search.value.trim().toLowerCase() === ftsQuery) drawSearch(ftsQuery);
      } catch { if (!disposed && version === searchVersion) { ftsResults = { results: [], mark: ['', ''] }; ftsQuery = q.toLowerCase(); drawSearch(ftsQuery); } }
    }, 220);
  }

  function revealFolder(folderId) {
    search.value = '';
    const parts = folderId.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) openFolders.add(parts.slice(0, i + 1).join('/'));
    drawTree();
    if (mobileOn() && selected) setDetail(false);
    requestAnimationFrame(() => [...tree.querySelectorAll('.library-vault-folder-summary')].find(s => s.textContent.startsWith(parts.at(-1) || ''))?.scrollIntoView({ block: 'nearest' }));
  }

  // -- the reader -----------------------------------------------------------------
  function setMode(home) {
    homeBtn.classList.toggle('active', home); homeBtn.setAttribute('aria-pressed', String(home));
    browser.classList.toggle('vault-at-home', home);
  }

  function showHome() {
    selected = null; note = null; disposeRail();
    setMode(true);
    home = renderVaultHome(homeHost, { store, admin, onOpen: id => openNote(id), onCreated: result => afterCreate(result) });
    placeHome();
    drawTree();
    if (mobileOn()) setDetail(false);
  }

  async function goHome() {
    if (!await canLeave()) return;
    editor?.destroy(); editor = null; browser.classList.remove('vault-editing');
    showHome();
  }

  function placeHome() {
    // On a phone, Home sits on the list page above the folders; on desktop it fills the reader.
    if (mobileOn()) { if (homeHost.parentElement !== sidebar) tree.before(homeHost); if (!selected) reader.replaceChildren(); }
    else if (!selected) reader.replaceChildren(homeHost);
    else homeHost.remove();
  }

  async function openNote(id, { force = false } = {}) {
    if (!force && selected === id && !editor && note) { if (mobileOn()) setDetail(true); return; }
    if (!await canLeave()) return;
    editor?.destroy(); editor = null; browser.classList.remove('vault-editing');
    selected = id; store.remember(id); setMode(false);
    const node = store.note(id);
    const folderParts = (node?.folder || '').split('/').filter(Boolean);
    for (let i = 0; i < folderParts.length; i++) openFolders.add(folderParts.slice(0, i + 1).join('/'));
    const version = ++requestVersion;
    if (!search.value) drawTree();
    homeHost.remove();
    reader.replaceChildren(el('div', { class: 'library-vault-empty', text: 'Opening note...' }));
    if (mobileOn()) setDetail(true);
    try {
      const loaded = await api(`/api/vault/note?path=${encodeURIComponent(id)}`);
      if (disposed || version !== requestVersion) return;
      note = loaded;
      showNote();
    } catch (error) {
      if (disposed || version !== requestVersion) return;
      reader.replaceChildren(el('div', { class: 'library-vault-empty', text: `Couldn't open this note: ${error.message.replace(/^\d+: /, '')}` }));
    }
  }

  function header(node, actions) {
    const title = el('h2', { class: 'vault-note-title' }, [el('span', { text: node.name }), el('span', { class: 'vault-dirty-dot', title: 'Unsaved changes', 'aria-hidden': 'true' })]);
    // On a phone the rail is a sheet, opened from a pill under the title.
    const links = (store.backlinks.get(node.id)?.length || 0) + (store.outlinks.get(node.id)?.length || 0) + (store.missing.get(node.id)?.length || 0);
    const linksPill = el('button', { type: 'button', class: 'vault-links-pill', text: `Links · ${links}` });
    linksPill.addEventListener('click', () => openRailSheet(node, linksPill));
    return el('header', { class: 'library-vault-reader-head' }, [
      breadcrumb(node, store, { onOpen: id => openNote(id), onFolder: id => revealFolder(id) }),
      title,
      el('div', { class: 'vault-note-meta meta', text: noteMeta(node, note) }),
      el('div', { class: 'workspace-phone-only vault-phone-properties' }, [propertyPills(node, { compact: true })]),
      linksPill,
      actions,
    ]);
  }

  function showNote() {
    const node = store.note(note.path) || { id: note.path, name: note.path.split('/').pop().replace(/\.md$/i, ''), folder: note.path.split('/').slice(0, -1).join('/') };
    const actions = el('div', { class: 'library-vault-reader-actions' });
    if (note.can_edit) actions.append(el('button', { type: 'button', class: 'btn', text: 'Edit', onclick: () => editNote(node) }));
    actions.append(el('button', { type: 'button', class: 'btn quiet vault-ask', text: 'Ask Kairos', title: 'Open a new chat with this note attached. Nothing is sent.', onclick: () => askKairos(node) }));
    const pinned = store.isPinned(node.id);
    const pin = el('button', { type: 'button', class: 'btn quiet vault-pin' + (pinned ? ' active' : ''), 'aria-pressed': String(pinned), text: pinned ? 'Pinned' : 'Pin' });
    pin.addEventListener('click', async () => {
      pin.disabled = true;
      try { await store.togglePin(node.id); const on = store.isPinned(node.id); pin.textContent = on ? 'Pinned' : 'Pin'; pin.classList.toggle('active', on); pin.setAttribute('aria-pressed', String(on)); }
      catch (error) { toast(error.message.replace(/^\d+: /, ''), 'error'); }
      finally { pin.disabled = false; }
    });
    actions.append(pin);
    const railToggle = el('button', { type: 'button', class: 'btn quiet vault-rail-toggle', 'aria-pressed': String(railOpen()), title: 'Show or hide the details rail', 'aria-label': 'Details rail' }, [icon('rail')]);
    railToggle.addEventListener('click', () => { setRailOpen(!railOpen()); railToggle.setAttribute('aria-pressed', String(railOpen())); browser.classList.toggle('vault-rail-closed', !railOpen()); });
    actions.append(railToggle);
    const more = el('button', { type: 'button', class: 'btn quiet vault-more', 'aria-label': 'More actions', title: 'More' }, [icon('more')]);
    const openMore = anchor => moreMenu(anchor, node, { admin, onHistory: admin ? () => { if (mobileOn()) openRailSheet(node, anchor, true); else { setRailOpen(true); browser.classList.remove('vault-rail-closed'); rail?.openHistory?.(); } } : null, onMap: id => onMap?.(id, 1) });
    more.addEventListener('click', () => openMore(more));
    actions.append(more);

    const body = el('div', { class: 'library-vault-reading artifact-document vault-note-body' });
    renderVaultBody(body, note.content, { name: node.name, links: note.links, store, onOpen: id => openNote(id) });
    const phoneHead = phoneHeader(node, openMore);
    const article = el('article', { class: 'vault-note' }, [phoneHead, header(node, actions)]);
    titleObserver?.disconnect();
    titleObserver = new IntersectionObserver(([entry]) => phoneHead.classList.toggle('show-title', !entry.isIntersecting));
    if (pendingIndex) {
      const proposal = pendingIndex; pendingIndex = null;
      article.append(indexPrompt(proposal, { onDone: added => { if (added) store.load().then(() => { if (!disposed) drawTree(); }); } }));
    }
    article.append(body);
    reader.replaceChildren(article);
    placeNoteChrome();
    titleObserver.observe(article.querySelector('.vault-note-title'));
    reader.scrollTop = 0;
    browser.classList.toggle('vault-rail-closed', !railOpen());
    drawRail(node);
  }

  function phoneHeader(node, openMore) {
    const back = el('button', { type: 'button', class: 'vault-phone-back ms-glass', 'aria-label': 'Back to Vault', text: '‹', onclick: () => back_() });
    const more = el('button', { type: 'button', class: 'btn workspace-phone-only workspace-round vault-phone-options', 'aria-label': 'Note options', text: '…', onclick: event => openMore(event.currentTarget) });
    return el('div', { class: 'vault-phone-header' }, [edgeBlur('top'), back, el('div', { class: 'vault-phone-heading' }, [el('strong', { text: node.name })]), more]);
  }

  function placeNoteChrome() {
    const head = reader.querySelector('.library-vault-reader-head');
    const crumbs = reader.querySelector('.vault-crumbs');
    const heading = reader.querySelector('.vault-phone-heading');
    // Reuse one breadcrumb, including its folder navigation, at either size.
    if (crumbs && head && heading) {
      if (mobileOn()) heading.append(crumbs);
      else head.prepend(crumbs);
    }
    const links = head?.querySelector('.vault-links-pill');
    const actions = head?.querySelector('.library-vault-reader-actions');
    if (!links || !actions) return;
    if (mobileOn()) actions.append(links);
    else head.insertBefore(links, actions);
  }

  async function back_() {
    if (!await canLeave()) return;
    haptic();
    editor?.destroy(); editor = null; browser.classList.remove('vault-editing');
    setDetail(false);
    if (note) showNote();
  }

  function railOptions(node) {
    return { store, node, note, admin, onOpen: id => { sheet?.close(); openNote(id); },
      onFocusMap: onMap ? (id, depth) => { sheet?.close(); canLeave().then(ok => ok && onMap(id, depth)); } : null,
      onHistoryChanged: () => reloadNote() };
  }

  function drawRail(node) {
    disposeRail();
    if (mobileOn()) { railHost.replaceChildren(); return; }
    rail = renderRail(railOptions(node));
    railHost.replaceChildren(el('div', { class: 'vault-rail-head' }, [el('span', { text: 'About this note' })]), rail);
    requestAnimationFrame(() => rail?.start?.());
  }
  function disposeRail() { rail?.destroy?.(); rail = null; railHost.replaceChildren(); }

  function openRailSheet(node, opener, history = false) {
    const content = renderRail(railOptions(node));
    sheet = openMobileSheet({ title: node.name, content, opener, fullHeight: true, onClose: () => { content.destroy(); sheet = null; } });
    if (!sheet) { setRailOpen(true); browser.classList.remove('vault-rail-closed'); return; }
    requestAnimationFrame(() => { content.start(); if (history) content.openHistory?.(); });
  }

  async function reloadNote() {
    await store.load();
    if (!disposed && selected) { drawTree(); await openNote(selected, { force: true }); }
  }

  function editNote(node) {
    const head = reader.querySelector('.library-vault-reader-head');
    head.querySelector('.library-vault-reader-actions')?.remove();
    const body = el('div', { class: 'vault-editor-host' });
    reader.querySelector('.vault-index-prompt')?.remove();
    reader.querySelector('.vault-note-body')?.replaceWith(body);
    browser.classList.add('vault-editing');
    editor = mountVaultEditor(body, { store, node, note,
      onDirty: dirty => reader.querySelector('.vault-note-title')?.classList.toggle('dirty', dirty),
      onSaved: async saved => {
        note = { ...note, ...saved };
        await store.load();
        if (!disposed) { drawTree(); const meta = reader.querySelector('.vault-note-meta'); if (meta) meta.textContent = noteMeta(store.note(node.id) || node, { last_change: { when: saved.mtime, label: 'You, in Library', kairos: true } }); }
      },
      onCancel: async () => { editor?.destroy(); editor = null; browser.classList.remove('vault-editing'); await openNote(node.id, { force: true }); },
    });
  }

  async function openToday() {
    if (!await canLeave()) return;
    await store.refreshDaily();
    if (store.daily?.exists && store.note(store.daily.path)) { openNote(store.daily.path); return; }
    try { afterCreate(await createTodaysNote(store)); }
    catch (error) { toast(error.message.replace(/^\d+: /, ''), 'error'); }
  }

  async function afterCreate(result) {
    await store.refreshDaily();
    drawCount();
    toast(result.created ? "Today's note created" : "Today's note already exists", 'success');
    pendingIndex = result.index || null;
    await openNote(result.path, { force: true });
  }

  // -- phone: list and detail ----------------------------------------------------
  function setDetail(on) {
    const detail = on && mobileOn();
    browser.classList.toggle('vault-phone-detail', detail);
    // The dock's search and "+" leave with the list page and come back with it.
    search.hidden = detail;
    todayBtn.hidden = detail || !(admin && store.daily?.template_exists);
    sidebar.hidden = detail;
    if (detail) window.scrollTo?.(0, 0);
    container.closest('#view-content')?.scrollTo?.(0, 0);
  }

  const syncPhone = () => {
    if (disposed) return;
    if (!mobileOn()) { browser.classList.remove('vault-phone-detail'); sidebar.hidden = false; search.hidden = false; sheet?.close(); }
    else setDetail(!!selected);
    placeHome();
    placeNoteChrome();
    if (note && !editor) { const node = store.note(note.path); if (node) drawRail(node); }
  };
  phone.addEventListener('change', syncPhone); document.addEventListener('kairos:appearance', syncPhone);

  let edge = null;
  const touchStart = event => { if (mobileOn() && browser.classList.contains('vault-phone-detail') && event.touches.length === 1 && event.touches[0].clientX < 24 && !document.querySelector('dialog[open]')) edge = { x: event.touches[0].clientX, y: event.touches[0].clientY }; };
  const touchEnd = event => { if (edge && event.changedTouches[0].clientX - edge.x > 70 && Math.abs(event.changedTouches[0].clientY - edge.y) < 60) back_(); edge = null; };
  const touchCancel = () => { edge = null; };
  reader.addEventListener('touchstart', touchStart, { passive: true });
  reader.addEventListener('touchend', touchEnd);
  reader.addEventListener('touchcancel', touchCancel);

  async function canLeave() {
    return editor ? editor.canLeave() : true;
  }

  return {
    canLeave, store,
    open: id => openNote(id),
    destroy() {
      disposed = true; ++requestVersion; ++searchVersion; clearTimeout(searchTimer);
      editor?.destroy(); disposeRail(); sheet?.close(); unsubscribe(); titleObserver?.disconnect();
      phone.removeEventListener('change', syncPhone); document.removeEventListener('kairos:appearance', syncPhone);
    },
  };
}

export { relativeTime, propertyPills };

import { renderPDF } from './pdfViewer.js';
import { api, el, toast, confirmDialog } from './api.js';
import { ICONS } from './icons.js';
import { phoneDetails } from './phoneRowDetails.js';
import { openMobileSheet } from './mobileSheet.js';

const BASE = '/api/google';
const MIME = {
  folder: 'application/vnd.google-apps.folder',
  sheet: 'application/vnd.google-apps.spreadsheet',
  form: 'application/vnd.google-apps.form',
  doc: 'application/vnd.google-apps.document',
  slides: 'application/vnd.google-apps.presentation',
};
const kindOf = file => Object.entries(MIME).find(([, mime]) => mime === file.mimeType)?.[0] || 'file';
const KIND_LABEL = { folder: 'Folder', sheet: 'Google Sheet', form: 'Google Form', doc: 'Google Doc', slides: 'Google Slides' };
const extensionOf = file => {
  const type = kindOf(file);
  if (type === 'folder') return 'DIR';
  if (type !== 'file') return type.toUpperCase();
  return file.name.split('.').length > 1 ? file.name.split('.').pop().toUpperCase() : 'FILE';
};
const formatBytes = value => {
  let size = Number(value || 0), unit = 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${unit ? size.toFixed(size < 10 ? 1 : 0) : size} ${units[unit]}`;
};
const shortDate = value => {
  if (!value) return '';
  const date = new Date(value), now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
};
// Phone rows: size for stored files, the Google kind for native ones.
const kindLabel = file => KIND_LABEL[kindOf(file)] || `${extensionOf(file)} file`;
const phoneMeta = file => [file.size != null ? formatBytes(file.size) : kindLabel(file), shortDate(file.modifiedTime)].filter(Boolean).join(' · ');
const phoneDrive = () => document.documentElement.classList.contains('kairos-redesign') && matchMedia('(max-width: 768px)').matches;
// The Drive being browsed: an opaque account id from /status. Every Drive,
// Sheets and Forms request names it; the server checks it is this user's.
let driveAccount = null;
const ACCOUNT_KEY = 'kairos.google.driveAccount';
const scoped = path => driveAccount ? `${path}${path.includes('?') ? '&' : '?'}account=${encodeURIComponent(driveAccount)}` : path;
const post = (path, body) => api(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) });
const action = (path, body) => api(scoped(`${BASE}${path}`), { method: 'POST', body: JSON.stringify(body) });
const onHost = () => Boolean(window.jarvis?.openGoogleSignIn) || ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname);
const button = (label, onClick, cls = 'btn') => el('button', { type: 'button', class: cls, text: label,
  onclick: async event => { try { await onClick(event); } catch (error) { toast(error.message || 'Google action failed', 'error'); } },
});

export async function renderGoogleWorkspace(container, header, tabs) {
  container.replaceChildren();
  const body = el('div', { class: 'google-workspace' });
  container.append(el('div', { class: 'view-constrained library-view' }, [header, tabs, body]));
  let status;
  try { status = await api(`${BASE}/status`); }
  catch (error) {
    body.append(el('div', { class: 'library-empty', text: error.message.startsWith('403:')
      ? 'Only an admin can connect and manage a Google account.' : 'Google Workspace is unavailable right now.' }));
    return;
  }
  if (!body.isConnected) return;
  let saved = null;
  try { saved = localStorage.getItem(ACCOUNT_KEY); } catch { /* storage unavailable */ }
  driveAccount = (status.accounts || []).some(item => item.id === saved) ? saved : status.default_account || null;
  if (!status.configured || !status.connected) { renderConnection(body, status, () => renderGoogleWorkspace(container, header, tabs)); return; }
  renderDrive(body, status, () => renderGoogleWorkspace(container, header, tabs), header);
}

// Opens Google's consent page and waits until /status shows the change.
function signInButton(label, request, changed, done) {
  const control = button(label, async () => {
    const result = await post('/oauth/start', request);
    if (window.jarvis?.openGoogleSignIn) {
      if (!await window.jarvis.openGoogleSignIn(result.url)) throw new Error('Could not open Google sign-in');
    } else window.open(result.url, '_blank', 'noopener');
    control.disabled = true;
    control.textContent = 'Waiting for Google…';
    const started = Date.now();
    const poll = async () => {
      if (!control.isConnected || Date.now() - started > 10 * 60 * 1000) { control.disabled = false; control.textContent = label; return; }
      try { if (changed(await api(`${BASE}/status`))) { done(); return; } } catch { /* retry */ }
      setTimeout(poll, 1800);
    };
    poll();
  }, 'btn primary');
  control.disabled = !onHost();
  return control;
}

function renderConnection(host, status, refresh) {
  host.replaceChildren();
  const client = el('input', { type: 'text', value: status.client_id || '',
    placeholder: 'Google OAuth Desktop client ID', 'aria-label': 'Google OAuth Desktop client ID' });
  const secret = el('input', { type: 'password', placeholder: 'Client secret, if provided',
    'aria-label': 'Google OAuth client secret' });
  const note = el('p', { class: 'meta', text: 'Create a Desktop OAuth client in Google Cloud with Drive, Sheets, Forms, and Calendar APIs enabled. Add your Google account as a test user if the consent app is in Testing. Sign in on the computer running Kairos; connected files are then available from other devices.' });
  const save = button('Save client ID', async () => {
    await post('/client', { client_id: client.value.trim(), client_secret: secret.value });
    toast('Google client saved', 'success');
    refresh();
  }, 'btn primary');
  const connect = signInButton('Connect Google account', {}, next => next.connected, refresh);
  host.append(el('div', { class: 'glass card google-connect' }, [
    el('div', { class: 'title', text: status.configured ? 'Connect Google Workspace' : 'Set up Google Workspace' }),
    note,
    el('div', { class: 'google-field-row' }, [client, secret, save]),
    el('div', { class: 'google-field-row' }, [
      status.configured ? connect : el('span', { class: 'meta', text: 'Save a client ID to continue.' }),
      !onHost() ? el('span', { class: 'meta', text: 'Open Library on the Kairos host computer to connect.' }) : null,
      el('a', { href: 'https://console.cloud.google.com/apis/credentials', target: '_blank', rel: 'noopener noreferrer', text: 'Google Cloud credentials ↗' }),
    ]),
  ]));
}

function renderDrive(host, status, refreshAll, header) {
  host.replaceChildren();
  const state = { parent: null, trail: [], kind: 'all', query: '', section: 'my_drive', page: null,
    selected: null, files: [], selection: new Set(), layout: 'grid', selectionAnchor: null };
  const sections = [['my_drive', 'My Drive'], ['shared', 'Shared with me'], ['starred', 'Starred'], ['recent', 'Recent'], ['trash', 'Trash']];
  const rail = el('nav', { class: 'google-rail', 'aria-label': 'Drive sections' });
  const storage = el('div', { class: 'meta google-storage', text: 'Loading storage…' });
  const search = el('input', { type: 'search', placeholder: 'Search in Drive', 'aria-label': 'Search in Drive' });
  const kind = el('select', { 'aria-label': 'File type' }, [
    ...[['all', 'All files'], ['folder', 'Folders'], ['sheet', 'Sheets'], ['form', 'Forms']]
      .map(([value, label]) => el('option', { value, text: label })),
  ]);
  const list = el('div', { class: 'google-file-list google-grid', role: 'group', 'aria-label': 'Drive files' });
  const detail = el('aside', { class: 'google-detail', 'aria-label': 'File details', hidden: true });
  const breadcrumbs = el('div', { class: 'google-breadcrumbs', 'aria-label': 'Drive breadcrumbs' });
  const statusLine = el('div', { class: 'meta', role: 'status' });
  const selectionBar = el('div', { class: 'google-selection-toolbar', hidden: true });
  const main = el('div', { class: 'google-main' });
  let listGeneration = 0, detailGeneration = 0, previewController = null;
  // Detached views release PDF workers and pending previews too.
  const observer = new MutationObserver(() => {
    if (!host.isConnected) { previewController?.abort(); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const more = button('Load more', () => load(true)); more.hidden = true;
  const uploadInput = el('input', { type: 'file', multiple: true, hidden: true });
  const newMenu = el('details', { class: 'google-new-menu' }, [el('summary', { class: 'btn primary', text: '+ New' })]);
  let newSheet;
  header.querySelector('.library-drive-create')?.remove();
  const create = el('button', { type: 'button', class: 'btn workspace-phone-only workspace-round library-drive-create', 'aria-label': 'Create or upload in Drive', onclick: () => {
    newMenu.open = true;
    newSheet = phoneDetails('New in Drive', [newMenu], create);
  } });
  create.innerHTML = ICONS.plus; header.append(create);

  newMenu.append(el('div', { class: 'google-new-actions' }, [
    button('New folder', async () => {
      detail.hidden = false;
      const name = await inlinePrompt(detail, 'New folder name');
      if (name) await driveAction({ action: 'create_folder', name, parent: state.parent });
    }),
    button('Upload files', () => uploadInput.click()),
    ...[['Sheet', '/sheets/action', 'spreadsheetId'], ['Form', '/forms/action', 'formId']].map(([label, path, key]) =>
      button(`New ${label.toLowerCase()}`, async () => {
        detail.hidden = false;
        const title = await inlinePrompt(detail, `${label} title`);
        if (!title) return;
        const created = await action(path, { action: 'create', title });
        if (state.parent && created[key]) await action('/drive/action', { action: 'move', file_id: created[key], parent: state.parent });
        await load();
      })),
  ]));
  // Creation prompts live in the existing details pane, outside the sheet.
  newMenu.addEventListener('click', event => { if (event.target.closest('button')) newSheet?.close(); }, true);
  rail.append(newMenu, uploadInput);
  const openSection = id => { state.section = id; state.parent = null; state.trail = []; state.query = ''; search.value = ''; load(); };
  for (const [id, label] of sections) rail.append(button(label, () => openSection(id), 'btn quiet google-section'));
  rail.append(storage);
  // Phone: the same sections as chips under the account card, plus a
  // Quick access row of recently viewed files on the My Drive home.
  const chips = el('div', { class: 'workspace-phone-only drive-section-chips', role: 'group', 'aria-label': 'Drive views' },
    sections.map(([id, label]) => button(label, () => openSection(id), 'drive-section-chip')));
  const quickRow = el('div', { class: 'drive-quick-row' });
  const quick = el('section', { class: 'workspace-phone-only drive-quick', 'aria-label': 'Quick access', hidden: true }, [
    el('h3', { class: 'drive-group-title', text: 'Quick access' }), quickRow]);
  const gridButton = button('Grid', () => setLayout('grid'));
  const listButton = button('List', () => setLayout('list'));
  function setLayout(layout) {
    state.layout = layout; list.classList.toggle('google-grid', layout === 'grid');
    gridButton.setAttribute('aria-pressed', String(layout === 'grid'));
    listButton.setAttribute('aria-pressed', String(layout === 'list'));
  }
  setLayout('grid');
  const accounts = status.accounts || [];
  const current = accounts.find(item => item.id === driveAccount) || accounts[0] || {};
  const label = item => item.email || 'Google account';
  const choose = id => {
    try { localStorage.setItem(ACCOUNT_KEY, id); } catch { /* storage unavailable */ }
    driveAccount = id; refreshAll();
  };
  const disconnect = button('Disconnect', async () => {
    if (await confirmDialog({ title: 'Disconnect Google?', message: `Kairos will forget the tokens for ${label(current)}. Its files stay in Google Drive${accounts.length > 1 ? ', and your other accounts stay connected' : ''}.`, confirmLabel: 'Disconnect' })) {
      await api(`${BASE}/accounts/${encodeURIComponent(current.id)}`, { method: 'DELETE' }); refreshAll();
    }
  }, 'btn quiet');
  const known = new Set(accounts.map(item => `${item.id}:${item.error || ''}`));
  const accountsChanged = next => (next.accounts || []).some(item => !known.has(`${item.id}:${item.error || ''}`));
  const addAccount = (before = () => {}) => signInButton('Add another Google account', { add: true }, accountsChanged, () => { before(); refreshAll(); });
  const picker = accounts.length > 1 ? el('select', { class: 'google-account-select', 'aria-label': 'Google account' },
    accounts.map(item => el('option', { value: item.id, text: label(item) + (item.error ? ' (reconnect needed)' : ''), selected: item.id === current.id }))) : null;
  picker?.addEventListener('change', () => choose(picker.value));
  const desktopAdd = addAccount(); desktopAdd.className = 'btn quiet';
  const desktopReconnect = current.error ? signInButton('Reconnect', { add: true, account: current.id }, accountsChanged, refreshAll) : null;
  main.append(el('div', { class: 'google-toolbar' }, [search, kind, gridButton, listButton, button('Refresh', () => load())]),
    quick, breadcrumbs, selectionBar, statusLine,
    el('div', { class: 'google-content' }, [el('div', { class: 'google-files' }, [list, more]), detail]));
  host.append(el('div', { class: 'google-account-line' }, [picker || el('strong', { text: label(current) }), desktopReconnect, desktopAdd, disconnect]),
    chips, el('div', { class: 'google-browser' }, [rail, main]));
  header.querySelectorAll('.library-drive-search, .library-drive-options').forEach(node => node.remove());
  const find = button('Search Drive', () => { search.scrollIntoView({ block: 'center' }); search.focus(); }, 'btn workspace-phone-only workspace-round library-drive-search');
  find.setAttribute('aria-label', 'Search Drive'); find.innerHTML = ICONS.search;
  header.insertBefore(find, create);
  const options = button('…', () => phoneDetails('Drive options', [rail, main.querySelector('.google-toolbar'), disconnect], options), 'btn workspace-phone-only workspace-round library-drive-options');
  options.setAttribute('aria-label', 'Drive options');
  host.querySelector('.google-account-line').append(options);
  const usage = el('div', { class: 'drive-storage-meter', hidden: true });
  const avatar = item => el('span', { class: 'drive-account-avatar', text: label(item).charAt(0).toUpperCase(), 'aria-hidden': 'true' });
  // Phone: the account card opens the account switcher.
  const account = el('button', { type: 'button', class: 'workspace-phone-only drive-account-copy', 'aria-haspopup': 'dialog',
    'aria-label': `Google Drive, ${label(current)}${current.error ? ', reconnect needed' : ''}. Switch or add an account`,
    onclick: () => { const sheet = openMobileSheet({ title: 'Google accounts', content: accountSheet(() => sheet?.close()), opener: account }); } }, [
    avatar(current),
    el('div', {}, [el('strong', { text: 'Google Drive' }), el('small', { text: current.error || label(current) }), usage]),
    el('span', { class: `drive-connected-dot${current.error ? ' drive-account-error' : ''}`, role: 'img', 'aria-label': current.error ? 'Reconnect needed' : 'Connected' }),
  ]);
  host.querySelector('.google-account-line').prepend(account);
  // Close the sheet before re-rendering or opening a confirmation over it.
  function accountSheet(close) {
    const choices = accounts.flatMap(item => {
      const row = button('', () => { close(); if (item.id !== current.id) choose(item.id); }, 'drive-account-choice');
      row.setAttribute('aria-pressed', String(item.id === current.id));
      row.append(avatar(item), el('span', {}, [el('strong', { text: label(item) }),
        el('small', { text: item.error ? 'Sign-in expired or revoked' : item.id === current.id ? 'Browsing now' : 'Switch to this Drive' })]));
      if (!item.error) return [row];
      // Reconnecting names the account, so the same email refreshes it in place.
      const reconnect = signInButton(`Reconnect ${label(item)}`, { add: true, account: item.id }, accountsChanged, () => { close(); refreshAll(); });
      reconnect.className = 'btn quiet drive-account-reconnect';
      return [row, reconnect];
    });
    const sheetDisconnect = button(`Disconnect ${label(current)}`, () => { close(); disconnect.click(); }, 'btn quiet danger');
    return el('div', { class: 'drive-account-sheet' }, [el('div', { class: 'drive-account-list', role: 'group', 'aria-label': 'Connected Google accounts' }, choices),
      addAccount(close), onHost() ? null : el('p', { class: 'meta', text: 'Add accounts on the computer running Kairos.' }), sheetDisconnect]);
  }
  api(scoped(`${BASE}/drive/storage`)).then(result => {
    const quota = result.storageQuota || {};
    const gb = value => `${(Number(value || 0) / 1024 ** 3).toFixed(1)} GB`;
    storage.textContent = `${gb(quota.usage)} used${quota.limit ? ` of ${gb(quota.limit)}` : ''}`;
    // Unlimited plans report no limit, so they get the text without a bar.
    const share = quota.limit ? Math.min(100, Number(quota.usage || 0) / Number(quota.limit) * 100) : null;
    usage.replaceChildren(...(share == null ? [] : [el('span', { class: 'drive-storage-bar', 'aria-hidden': 'true' }, [
      el('i', { style: `width:${share.toFixed(1)}%` })])]), el('small', { text: storage.textContent }));
    usage.hidden = false;
  }).catch(() => { storage.textContent = 'Storage unavailable'; });
  search.dataset.pageSearch = 'true';
  search.addEventListener('input', () => { state.query = search.value.trim(); state.parent = null; state.trail = []; schedule(); });
  kind.addEventListener('change', () => { state.kind = kind.value; load(); });
  uploadInput.addEventListener('change', async () => {
    const files = [...uploadInput.files]; uploadInput.value = ''; await uploadFiles(files);
  });
  host.addEventListener('dragover', event => { event.preventDefault(); host.classList.add('google-drop-active'); });
  host.addEventListener('dragleave', event => { if (!host.contains(event.relatedTarget)) host.classList.remove('google-drop-active'); });
  host.addEventListener('drop', async event => {
    event.preventDefault(); host.classList.remove('google-drop-active');
    try { await uploadFiles([...event.dataTransfer.files]); } catch (error) { toast(error.message, 'error'); }
  });
  async function uploadFiles(files) {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error('Choose files under 25 MB');
      const data = new FormData(); data.append('file', file); if (state.parent) data.append('parent', state.parent);
      const response = await fetch(scoped(`${BASE}/drive/upload`), { method: 'POST', body: data });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'Upload failed');
      toast(`${file.name} uploaded`, 'success');
    }
    await load();
  }
  let timer;
  function schedule() { clearTimeout(timer); timer = setTimeout(() => load(), 250); }
  async function driveAction(body) { const result = await action('/drive/action', body); await load(); return result; }
  function openFolder(file) {
    state.trail.push({ id: file.id, name: file.name }); state.parent = file.id; state.query = ''; search.value = ''; load();
  }
  function drawBreadcrumbs() {
    breadcrumbs.replaceChildren(button(sections.find(([id]) => id === state.section)[1], () => {
      state.parent = null; state.trail = []; load();
    }, 'btn quiet'));
    state.trail.forEach((item, index) => breadcrumbs.append(el('span', { class: 'meta google-crumb-sep', text: '›' }),
      button(item.name, () => { state.trail = state.trail.slice(0, index + 1); state.parent = item.id; load(); }, 'btn quiet')));
    rail.querySelectorAll('.google-section').forEach((node, index) => node.setAttribute('aria-current', String(sections[index][0] === state.section)));
    chips.querySelectorAll('.drive-section-chip').forEach((node, index) => node.setAttribute('aria-pressed', String(sections[index][0] === state.section)));
  }
  const quickHome = () => state.section === 'my_drive' && !state.parent && !state.query && state.kind === 'all';
  async function loadQuick(generation) {
    if (!quickHome() || !phoneDrive()) { quick.hidden = true; return; }
    try {
      const result = await api(scoped(`${BASE}/drive/files?${new URLSearchParams({ section: 'recent', kind: 'all' })}`));
      if (generation !== listGeneration || !host.isConnected) return;
      const recent = (result.files || []).filter(file => kindOf(file) !== 'folder').slice(0, 10);
      quickRow.replaceChildren(...recent.map(file => {
        const tile = button('', () => openFile(file), 'drive-quick-tile');
        tile.append(el('span', { class: 'drive-quick-type', text: extensionOf(file), 'aria-hidden': 'true' }),
          el('strong', { text: file.name }), el('small', { text: shortDate(file.modifiedTime) || kindLabel(file) }));
        return tile;
      }));
      quick.hidden = !recent.length;
    } catch { quick.hidden = true; }
  }
  async function batch(operation) {
    const files = state.files.filter(file => state.selection.has(file.id));
    let parent;
    if (operation === 'move') { detail.hidden = false; parent = await folderPicker(detail); if (!parent) return; }
    if (operation === 'trash' && !await confirmDialog({ title: 'Move selected files to trash?', message: `${files.length} files`, confirmLabel: 'Move to trash' })) return;
    for (const file of files) await action('/drive/action', { action: operation, file_id: file.id, ...(parent ? { parent } : {}) });
    await load();
  }
  function drawSelection() {
    selectionBar.hidden = !state.selection.size;
    selectionBar.replaceChildren(el('strong', { text: `${state.selection.size} selected` }),
      button('Clear selection', () => { state.selection.clear(); drawSelection(); }),
      ...['move', 'copy', 'star', state.section === 'trash' ? 'restore' : 'trash'].map(op => button(op[0].toUpperCase() + op.slice(1), () => batch(op))));
    list.querySelectorAll('.google-file-row').forEach(row => {
      const selected = state.selection.has(row.dataset.fileId);
      row.classList.toggle('selected', selected); row.querySelector('input').checked = selected;
    });
  }
  function selectFile(file, checked, range = false) {
    const current = state.files.findIndex(item => item.id === file.id);
    const anchor = state.files.findIndex(item => item.id === state.selectionAnchor);
    const files = range && anchor >= 0 ? state.files.slice(Math.min(current, anchor), Math.max(current, anchor) + 1) : [file];
    for (const item of files) checked ? state.selection.add(item.id) : state.selection.delete(item.id);
    state.selectionAnchor = file.id; drawSelection();
  }
  async function openFile(file) {
    if (kindOf(file) === 'folder') return openFolder(file);
    await showDetail(file, true);
  }
  function contextMenu(event, file) {
    event.preventDefault();
    list.querySelector('.google-context-menu')?.remove();
    const menu = el('div', { class: 'google-context-menu', role: 'menu', 'aria-label': `${file.name} actions` });
    const run = fn => async () => { menu.remove(); await fn(); };
    menu.append(button('Open', run(() => openFile(file))),
      ...['Rename', 'Move', 'Copy', file.starred ? 'Unstar' : 'Star', 'Share'].map(label => button(label, run(async () => {
        await showDetail(file);
        if (label === 'Share') { const panel = detail.querySelector('details'); panel.open = true; }
        else [...detail.querySelectorAll('.google-actions button')].find(node => node.textContent === label)?.click();
      }))),
      el('a', { class: 'btn', href: scoped(`${BASE}/drive/files/${encodeURIComponent(file.id)}/download`), text: 'Download' }),
      button(file.trashed ? 'Restore' : 'Move to trash', run(async () => {
        if (file.trashed || await confirmDialog({ title: 'Move to trash?', message: file.name, confirmLabel: 'Move to trash' }))
          await driveAction({ file_id: file.id, action: file.trashed ? 'restore' : 'trash' });
      })), button('Close menu', () => menu.remove(), 'btn quiet'));
    list.append(menu); menu.querySelector('button').focus();
    const bounds = list.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX - bounds.left, list.clientWidth - 200))}px`;
    menu.style.top = `${Math.max(0, event.clientY - bounds.top + list.scrollTop)}px`; menu.style.right = 'auto';
    menu.addEventListener('keydown', e => { if (e.key === 'Escape') menu.remove(); });
  }
  function drawFiles() {
    list.replaceChildren();
    // Folders and files in their own groups: tiles and a card on a phone,
    // `display: contents` (the one desktop grid) everywhere else.
    const folders = el('div', { class: 'drive-group drive-folders' });
    const files = el('div', { class: 'drive-group drive-files' });
    for (const file of state.files) {
      const type = kindOf(file);
      const checkbox = el('input', { type: 'checkbox', 'aria-label': `Select ${file.name}` });
      const row = el('div', { class: 'google-file-row', 'data-file-id': file.id });
      const open = button(file.name, event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          selectFile(file, event.shiftKey || !state.selection.has(file.id), event.shiftKey);
        } else if (matchMedia('(pointer: coarse)').matches) return openFile(file);
        else return showDetail(file);
      }, 'google-file-open');
      const thumbnail = el('div', { class: 'google-thumbnail' }, [el('span', { class: 'google-type', text: type.toUpperCase() }),
        el('span', { class: 'workspace-phone-only drive-file-extension', text: extensionOf(file) })]);
      if (file.thumbnailLink && type !== 'folder') {
        const img = el('img', { src: scoped(`${BASE}/drive/files/${encodeURIComponent(file.id)}/thumbnail`), alt: '', loading: 'lazy' });
        img.onerror = () => img.remove(); thumbnail.append(img);
      }
      const date = file.modifiedTime && new Date(file.modifiedTime).toLocaleDateString();
      open.replaceChildren(thumbnail, el('span', { class: 'google-file-copy' }, [el('strong', { text: file.name }),
        el('small', { class: 'drive-desktop-meta', text: [type, date].filter(Boolean).join(' · ') }),
        el('small', { class: 'workspace-phone-only drive-phone-meta', text: phoneMeta(file) })]));
      open.addEventListener('dblclick', () => openFile(file).catch(error => toast(error.message, 'error')));
      open.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); openFile(file).catch(error => toast(error.message, 'error')); }
      });
      checkbox.addEventListener('click', event => selectFile(file, checkbox.checked, event.shiftKey));
      row.addEventListener('contextmenu', event => contextMenu(event, file));
      row.append(checkbox, open); (type === 'folder' ? folders : files).append(row);
    }
    for (const [group, title] of [[folders, 'Folders'], [files, 'Files']]) {
      if (group.childElementCount) list.append(el('h3', { class: 'workspace-phone-only drive-group-title', text: title }), group);
    }
    if (!state.files.length) list.append(el('div', { class: 'library-empty', text: 'No matching Google files.' }));
    drawSelection();
  }
  async function load(append = false) {
    const generation = ++listGeneration;
    const params = new URLSearchParams({ q: state.query, kind: state.kind, section: state.section });
    if (state.parent) params.set('parent', state.parent);
    if (append && state.page) params.set('page_token', state.page);
    statusLine.textContent = 'Loading Drive…';
    try {
      const result = await api(scoped(`${BASE}/drive/files?${params}`));
      if (generation !== listGeneration || !host.isConnected) return;
      state.files = append ? [...state.files, ...(result.files || [])] : (result.files || []);
      state.selection.clear(); state.selectionAnchor = null; state.page = result.nextPageToken || null; more.hidden = !state.page;
      drawFiles(); drawBreadcrumbs();
      if (!append) loadQuick(generation);
      statusLine.textContent = result.incompleteSearch ? 'Google returned a partial result. Narrow the search.' : '';
    } catch (error) {
      statusLine.textContent = `Could not load Drive: ${error.message}`;
      // An expired or revoked sign-in marks this account's card, not the others.
      if (error.message.startsWith('401:')) {
        account.querySelector('small').textContent = error.message.replace(/^401: /, '');
        account.querySelector('.drive-connected-dot').classList.add('drive-account-error');
        account.querySelector('.drive-connected-dot').setAttribute('aria-label', 'Reconnect needed');
      }
    }
  }
  async function showDetail(file, preview = false) {
    const generation = ++detailGeneration;
    previewController?.abort(); previewController = new AbortController();
    const controller = previewController;
    detail.hidden = false; state.selected = file;
    detail.replaceChildren();
    if (preview && matchMedia('(pointer: coarse)').matches) detail.scrollIntoView({ block: 'start' });
    const type = kindOf(file);
    const head = el('div', { class: 'google-detail-head' }, [
      el('div', {}, [el('div', { class: 'meta', text: type.toUpperCase() }), el('h3', { text: file.name })]),
      button('Close details', () => { detail.hidden = true; controller.abort(); }, 'btn quiet'),
      file.webViewLink ? el('a', { class: 'btn', href: file.webViewLink, target: '_blank', rel: 'noopener noreferrer', text: 'Open in Google ↗' }) : null,
    ]);
    const actions = el('div', { class: 'google-actions' });
    const apply = async (body) => {
      await driveAction({ file_id: file.id, ...body }); controller.abort(); detail.replaceChildren(); detail.hidden = true;
    };
    // filter(Boolean): append() would write a skipped (null) button as the text "null".
    actions.append(...[
      button('Open', () => openFile(file)),
      button('Rename', async () => { const name = await inlinePrompt(detail, 'New name', file.name); if (name) await apply({ action: 'rename', name }); }),
      button('Move', async () => { const parent = await folderPicker(detail); if (parent) await apply({ action: 'move', parent }); }),
      button('Copy', async () => apply({ action: 'copy', name: `${file.name} copy` })),
      button(file.starred ? 'Unstar' : 'Star', async () => apply({ action: file.starred ? 'unstar' : 'star' })),
      button(file.trashed ? 'Restore' : 'Move to trash', async () => {
        if (file.trashed || await confirmDialog({ title: 'Move to trash?', message: file.name, confirmLabel: 'Move to trash' }))
          await apply({ action: file.trashed ? 'restore' : 'trash' });
      }),
      file.trashed ? button('Delete forever', async () => {
        if (await confirmDialog({ title: 'Delete permanently?', message: `${file.name} cannot be restored.`, confirmLabel: 'Delete forever' })) await apply({ action: 'delete' });
      }, 'btn danger') : null,
    ].filter(Boolean));
    if (['file', 'sheet', 'doc', 'slides'].includes(type)) actions.append(el('a', { class: 'btn', href: scoped(`${BASE}/drive/files/${encodeURIComponent(file.id)}/download`), text: 'Download' }));
    const extras = el('div', { class: 'google-detail-extra' });
    detail.append(head, actions, extras);
    if (type === 'sheet') await sheetEditor(extras, file);
    if (type === 'form') await formEditor(extras, file);
    if (preview && !['sheet', 'form', 'folder'].includes(type)) await fileViewer(extras, actions, file, controller);
    if (generation !== detailGeneration || controller.signal.aborted) return;
    const permissions = el('details', { class: 'disclosure-panel' }, [el('summary', { text: 'Sharing and permissions' })]);
    permissions.addEventListener('toggle', () => { if (permissions.open && permissions.childElementCount === 1) sharing(permissions, file); });
    const revisions = el('details', { class: 'disclosure-panel' }, [el('summary', { text: 'Revisions' })]);
    revisions.addEventListener('toggle', async () => {
      if (!revisions.open || revisions.childElementCount > 1) return;
      try { const r = await action('/drive/action', { action: 'revisions', file_id: file.id });
        revisions.append(...(r.revisions || []).map(v => el('div', { class: 'meta', text: new Date(v.modifiedTime).toLocaleString() }))); }
      catch { revisions.append(el('div', { class: 'meta', text: 'Revisions unavailable for this file.' })); }
    });
    detail.append(permissions, revisions);
  }
  load();
}

async function fileViewer(host, actions, file, controller) {
  const url = scoped(`${BASE}/drive/files/${encodeURIComponent(file.id)}/preview`);
  host.classList.add('google-viewer');
  host.textContent = 'Loading preview…';
  try {
    if (file.mimeType === MIME.slides || file.mimeType === 'application/pdf') {
      await renderPDF(host, actions, url, file.name, controller);
      return;
    }
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'Preview unavailable');
    if (!host.isConnected || controller.signal.aborted) return;
    const mime = response.headers.get('content-type') || '';
    if (mime.startsWith('image/')) {
      host.replaceChildren(el('img', { src: url, alt: file.name }));
    } else if (mime.startsWith('text/html')) {
      const text = await response.text();
      if (controller.signal.aborted) return;
      const frame = el('iframe', { sandbox: '', title: file.name, class: 'google-reader', referrerpolicy: 'no-referrer' });
      const theme = getComputedStyle(document.documentElement);
      const ink = theme.getPropertyValue('--text').trim(), paper = theme.getPropertyValue('--bg-panel-solid').trim();
      frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:24px;font-family:system-ui;line-height:1.6;color:${ink};background:${paper}}table{border-collapse:collapse}td,th{border:1px solid currentColor;padding:8px}pre{white-space:pre-wrap}</style>${text}`;
      host.replaceChildren(el('div', { class: 'meta', text: 'Read-only preview. Open in Google to edit.' }), frame);
    } else {
      const text = await response.text();
      if (!controller.signal.aborted) host.replaceChildren(el('pre', { class: 'google-text-preview', text }));
    }
  } catch (error) {
    if (error.name !== 'AbortError' && host.isConnected) host.textContent = error.message;
  }
}

function inlinePrompt(host, label, initial = '') {
  return new Promise(resolve => {
    const input = el('input', { value: initial, 'aria-label': label });
    const panel = el('div', { class: 'google-inline-prompt' }, [
      el('label', { text: label }), input,
      button('Save', () => done(input.value.trim()), 'btn primary'),
      button('Cancel', () => done(null), 'btn quiet'),
    ]);
    const done = value => { panel.remove(); resolve(value); };
    host.prepend(panel); input.focus(); input.select();
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); });
  });
}

function folderPicker(host) {
  return new Promise(resolve => {
    const query = el('input', { type: 'search', placeholder: 'Find a destination folder', 'aria-label': 'Find a destination folder' });
    const results = el('div', { class: 'google-folder-results' });
    const next = button('More folders', () => load(true)); next.hidden = true;
    const panel = el('div', { class: 'google-inline-prompt' }, [
      el('strong', { text: 'Move to folder' }), query,
      button('My Drive root', () => done('root'), 'btn quiet'), results, next,
      button('Cancel', () => done(null), 'btn quiet'),
    ]);
    let page = null;
    let generation = 0;
    const done = value => { panel.remove(); resolve(value); };
    async function load(append = false) {
      const own = ++generation;
      const params = new URLSearchParams({ q: query.value.trim(), kind: 'folder' });
      if (append && page) params.set('page_token', page);
      if (!append) results.textContent = 'Loading folders…';
      try {
        const data = await api(scoped(`${BASE}/drive/files?${params}`));
        if (own !== generation || !panel.isConnected) return;
        if (!append) results.replaceChildren();
        page = data.nextPageToken || null; next.hidden = !page;
        results.append(...(data.files || []).map(folder => button(folder.name, () => done(folder.id), 'google-file-row')));
        if (!results.childElementCount) results.textContent = 'No matching folders.';
      } catch (error) { results.textContent = `Could not load folders: ${error.message}`; }
    }
    host.prepend(panel); query.focus();
    let timer;
    query.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(), 250); });
    load();
  });
}

async function sharing(host, file) {
  const members = el('div', { class: 'google-members' });
  const audience = el('select', { 'aria-label': 'Share with' }, [
    ...[['user', 'Person'], ['group', 'Group'], ['domain', 'Domain'], ['anyone', 'Anyone with the link']]
      .map(([value, label]) => el('option', { value, text: label })),
  ]);
  const email = el('input', { type: 'text', placeholder: 'Email address', 'aria-label': 'Email address or domain' });
  audience.addEventListener('change', () => {
    email.hidden = audience.value === 'anyone';
    email.placeholder = audience.value === 'domain' ? 'example.com' : 'Email address';
    email.value = '';
  });
  const role = el('select', { 'aria-label': 'Access level' }, [
    ...['reader', 'commenter', 'writer'].map(value => el('option', { value, text: value })),
  ]);
  const load = async () => {
    const result = await action('/drive/action', { action: 'permissions', file_id: file.id });
    members.replaceChildren(...(result.permissions || []).map(p => el('div', { class: 'google-member' }, [
      el('span', { text: p.emailAddress || p.domain || p.displayName || p.type }),
      p.role === 'owner' ? el('span', { class: 'meta', text: 'Owner' }) : el('select', { 'aria-label': `Access for ${p.emailAddress || p.domain || p.type}` }, [
        ...['reader', 'commenter', 'writer'].map(value => el('option', { value, text: value, selected: value === p.role })),
      ]),
      p.role === 'owner' ? null : button('Update', async e => {
        const value = e.currentTarget.previousElementSibling.value;
        await action('/drive/action', { action: 'update_permission', file_id: file.id, permission_id: p.id, role: value }); await load();
      }, 'btn quiet'),
      p.role === 'owner' ? null : button('Remove', async () => {
        if (!await confirmDialog({ title: 'Remove access?', message: p.emailAddress || p.displayName || 'This person', confirmLabel: 'Remove' })) return;
        await action('/drive/action', { action: 'revoke', file_id: file.id, permission_id: p.id }); await load();
      }, 'btn quiet'),
    ])));
  };
  host.append(el('div', { class: 'google-share-form' }, [audience, email, role, button('Share', async () => {
    await action('/drive/action', { action: 'share', file_id: file.id,
      permission_type: audience.value, email: audience.value === 'domain' ? null : email.value.trim(),
      domain: audience.value === 'domain' ? email.value.trim() : null, role: role.value });
    email.value = ''; await load();
  }, 'btn primary')]), members);
  try { await load(); } catch (error) { members.textContent = `Could not load sharing: ${error.message}`; }
}

async function sheetEditor(host, file) {
  let meta;
  try { meta = await api(scoped(`${BASE}/sheets/${encodeURIComponent(file.id)}`)); }
  catch (error) { host.textContent = `Could not open spreadsheet: ${error.message}`; return; }
  const sheets = meta.sheets || [];
  const tabs = el('div', { class: 'segmented-tabs' });
  const grid = el('div', { class: 'google-sheet-grid' });
  const range = el('input', { value: 'A1:L20', 'aria-label': 'Cell range' });
  const status = el('span', { class: 'meta' });
  let sheet = sheets[0];
  let cells = [];
  let loadedRange = '';
  const dimensions = () => {
    const match = /^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)$/i.exec(range.value.trim());
    if (!match) throw new Error('Use a range such as A1:L20');
    const column = letters => [...letters.toUpperCase()].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
    const rows = Number(match[4]) - Number(match[2]) + 1;
    const cols = column(match[3]) - column(match[1]) + 1;
    if (rows < 1 || rows > 20 || cols < 1 || cols > 12) throw new Error('Choose up to 20 rows and 12 columns');
    return { rows, cols, startRow: Number(match[2]), startCol: column(match[1]) };
  };
  const drawTabs = () => { tabs.replaceChildren(...sheets.map(item => button(item.properties.title, () => {
    sheet = item; drawTabs(); load();
  }, item === sheet ? 'segmented-tab active' : 'segmented-tab'))); };
  const load = async () => {
    if (!sheet) return;
    status.textContent = 'Loading cells…';
    cells = []; loadedRange = '';
    try {
    const shape = dimensions();
    const data = await api(scoped(`${BASE}/sheets/${encodeURIComponent(file.id)}?cell_range=${encodeURIComponent(`'${sheet.properties.title.replaceAll("'", "''")}'!${range.value}`)}`));
    grid.style.setProperty('--google-sheet-columns', String(shape.cols));
    grid.replaceChildren(); cells = [];
    for (let r = 0; r < shape.rows; r++) {
      const row = [];
      for (let c = 0; c < shape.cols; c++) {
        const input = el('input', { value: data.values?.[r]?.[c] ?? '', 'aria-label': `Row ${shape.startRow + r} column ${shape.startCol + c}` });
        row.push(input); grid.append(input);
      }
      cells.push(row);
    }
    loadedRange = range.value.trim();
    status.textContent = '';
    } catch (error) { status.textContent = error.message; }
  };
  host.append(el('div', { class: 'google-editor-head' }, [el('strong', { text: 'Spreadsheet' }), tabs]),
    el('div', { class: 'google-field-row' }, [range, button('Load range', load), button('Save cells', async () => {
      try { dimensions(); } catch (error) { status.textContent = error.message; return; }
      if (!cells.length) { status.textContent = 'Load a range first'; return; }
      if (range.value.trim() !== loadedRange) { status.textContent = 'Load the new range before saving'; return; }
      const cellRange = `'${sheet.properties.title.replaceAll("'", "''")}'!${range.value}`;
      await action('/sheets/action', { action: 'update', file_id: file.id, cell_range: cellRange,
        values: cells.map(row => row.map(input => input.value)) });
      toast('Sheet saved', 'success');
    }, 'btn primary'), status]), grid);
  drawTabs(); await load();
}

async function formEditor(host, file) {
  const form = await api(scoped(`${BASE}/forms/${encodeURIComponent(file.id)}`));
  const list = el('div', { class: 'google-form-items' });
  const responses = el('div', { class: 'google-form-responses' });
  const title = el('input', { value: form.info?.title || file.name, 'aria-label': 'Form title' });
  const question = el('input', { placeholder: 'Question text', 'aria-label': 'New question' });
  const type = el('select', { 'aria-label': 'Question type' }, [
    el('option', { value: 'TEXT', text: 'Short answer' }),
    el('option', { value: 'PARAGRAPH_TEXT', text: 'Paragraph' }),
    el('option', { value: 'RADIO', text: 'Multiple choice' }),
    el('option', { value: 'CHECKBOX', text: 'Checkboxes' }),
  ]);
  const options = el('input', { placeholder: 'Choices, comma separated', 'aria-label': 'Choices' });
  const drawItems = items => {
    list.replaceChildren(...(items || []).map((item, index) => el('div', { class: 'google-form-item' }, [
      el('span', { text: item.title || `Question ${index + 1}` }),
      button('Remove', async () => {
        if (!await confirmDialog({ title: 'Remove question?', message: item.title || 'This question', confirmLabel: 'Remove' })) return;
        await action('/forms/action', { action: 'batch', file_id: file.id,
          requests: [{ deleteItem: { location: { index } } }] });
        form.items = (await api(scoped(`${BASE}/forms/${encodeURIComponent(file.id)}`))).items;
        drawItems(form.items);
      }, 'btn quiet'),
    ])));
  };
  drawItems(form.items);
  let isPublished = Boolean(form.publishSettings?.publishState?.isPublished);
  host.append(
    el('div', { class: 'google-editor-head' }, [el('strong', { text: 'Form' }),
      button(isPublished ? 'Unpublish' : 'Publish', async e => {
        await action('/forms/action', { action: 'publish', file_id: file.id, published: !isPublished });
        isPublished = !isPublished;
        e.currentTarget.textContent = isPublished ? 'Unpublish' : 'Publish'; toast('Publish state updated', 'success');
      })]),
    el('div', { class: 'google-field-row' }, [title, button('Save title', async () => {
      await action('/forms/action', { action: 'batch', file_id: file.id,
        requests: [{ updateFormInfo: { info: { title: title.value }, updateMask: 'title' } }] });
      toast('Form title saved', 'success');
    })]), list,
    el('div', { class: 'google-field-row' }, [question, type, options, button('Add question', async () => {
      const text = question.value.trim(); if (!text) return;
      const choiceQuestion = ['RADIO', 'CHECKBOX'].includes(type.value);
      if (choiceQuestion && !options.value.split(',').some(value => value.trim())) {
        toast('Add at least one choice', 'error'); return;
      }
      const q = choiceQuestion
        ? { choiceQuestion: { type: type.value, options: options.value.split(',').map(v => v.trim()).filter(Boolean).map(value => ({ value })) } }
        : { textQuestion: { paragraph: type.value === 'PARAGRAPH_TEXT' } };
      await action('/forms/action', { action: 'batch', file_id: file.id,
        requests: [{ createItem: { item: { title: text, questionItem: { question: { required: false, ...q } } }, location: { index: (form.items || []).length } } }] });
      question.value = ''; options.value = '';
      const updated = await api(scoped(`${BASE}/forms/${encodeURIComponent(file.id)}`));
      form.items = updated.items; drawItems(updated.items);
    }, 'btn primary')]),
    button('Load responses', async () => {
      const result = await api(scoped(`${BASE}/forms/${encodeURIComponent(file.id)}?responses=true`));
      responses.replaceChildren(...(result.responses || []).map(item => el('pre', { text: JSON.stringify(item.answers || {}, null, 2) })));
      if (!responses.childElementCount) responses.textContent = 'No responses yet.';
    }), responses,
  );
}

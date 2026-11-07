// A stand-in for the desktop app's window.jarvis.browse (electron/preload.js),
// for scripts/browse-ui-checks.cjs. The real bridge drives native tab views
// in the main process; this one keeps tabs in memory and records every call,
// so the Browse screen can be checked in ui-smoke's fixture app. Test only:
// it is loaded as a preload in that check's own window, never in the app.
const { contextBridge } = require('electron');

const calls = [];
const handlers = { state: [], event: [], permission: [], shortcut: [], download: [], openRequest: [], passwordOffer: [], passwordSuggest: [] };
let audioLabel = 'Desk Speakers (not here)';
let tabs = [], activeId = null, nextId = 1;
let pinned = [{ id: 1, url: 'https://github.com/', title: 'GitHub', position: 0, thumb: null },
  { id: 2, url: 'https://mail.example.com/', title: 'Mail', position: 1, thumb: null }];
let nextPin = 3;
let homeSettings = { background: 'kairos', color: '#1b1f24', image: null, dim: 0.35, tileSize: 'medium', search: true, suggestions: true };
const settings = {};
const record = (name, args) => { calls.push({ name, args: JSON.parse(JSON.stringify(args)) }); };
const list = () => ({ tabs: tabs.map(t => ({ ...t, active: t.id === activeId })), activeId });
const emit = (kind, payload) => { for (const fn of handlers[kind]) fn(payload); };
const push = () => emit('state', list());
const titleFor = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') + ' page'; } catch { return ''; } };
const addressFor = (input) => (/^https?:\/\//.test(input) ? input : /\./.test(input) ? `https://${input}/` : `https://www.google.com/search?q=${encodeURIComponent(input)}`);
const tab = (url) => ({ id: nextId++, url, title: url ? titleFor(url) : '', favicon: null, pinned: false, muted: false, audible: false,
  loading: false, discarded: false, canGoBack: false, canGoForward: false, zoom: 1, blocked: url ? 3 : 0 });
const on = (kind) => (fn) => { handlers[kind].push(fn); return () => { handlers[kind] = handlers[kind].filter(f => f !== fn); }; };
const call = (name, fn) => (...args) => { record(name, args); return Promise.resolve(fn(...args)); };

// The app treats a window with window.jarvis.browser as the desktop app
// (electron-shell: the title bar and its modes). These parts only need to
// exist; the side pane is not exercised here.
const noop = () => {};
const unsubscribe = () => noop;
const desktop = {
  browser: { open: async (url) => { record('pane.open', [url]); return { ok: false }; }, navigate: async () => ({ ok: false }), state: async () => ({ open: false }),
    openExternal: async (url) => { record('pane.openExternal', [url]); return { ok: true }; },
    back: noop, forward: noop, reload: noop, close: noop, setBounds: noop, setVisible: noop,
    onState: unsubscribe, onError: unsubscribe, onOpenRequest: (fn) => on('openRequest')(fn), onHostResized: unsubscribe },
  setTitleBar: noop, setSeeThrough: noop,
};

contextBridge.exposeInMainWorld('jarvis', { ...desktop, browse: {
  list: call('list', () => list()),
  open: call('open', (url) => {
    if (url && /^(file|javascript):/i.test(url)) return { ok: false, reason: "That address can't be opened here." };
    const t = tab(url ? addressFor(url) : ''); tabs.push(t); activeId = t.id; push(); return { ok: true, id: t.id };
  }),
  navigate: call('navigate', (id, input) => { const t = tabs.find(x => x.id === id); if (!t) return { ok: false }; t.url = addressFor(input); t.title = titleFor(t.url); t.canGoBack = true; t.blocked = 3; push(); return { ok: true, url: t.url }; }),
  find: call('find', () => ({ requestId: 1 })), zoom: call('zoom', () => ({ zoom: 1 })),
  sharePage: call('sharePage', (id) => { const t = tabs.find(x => x.id === id); return t && { url: t.url, title: t.title, text: 'Fixture page text.' }; }),
  activate: call('activate', (id) => { activeId = id; push(); }),
  close: call('close', (id) => { tabs = tabs.filter(t => t.id !== id); if (activeId === id) activeId = tabs.length ? tabs[0].id : null; push(); }),
  reopenClosed: call('reopenClosed', () => {}),
  back: call('back', () => {}), forward: call('forward', () => {}), reload: call('reload', () => {}), stop: call('stop', () => {}),
  pin: call('pin', () => {}), mute: call('mute', () => {}), reorder: call('reorder', () => {}),
  setBounds: (rect) => record('setBounds', [rect]), setVisible: (visible) => record('setVisible', [!!visible]),
  shortcut: call('shortcut', () => {}),
  suggest: call('suggest', (q) => (q ? [{ url: 'https://github.com/pulls', title: 'Pull requests', kind: 'history' }] : [])),
  history: call('history', () => [{ id: 7, url: 'https://example.com/a', title: 'A visited page', visited_at: Date.UTC(2026, 10, 3, 12) }]),
  deleteHistory: call('deleteHistory', () => ({ ok: true })), clearHistory: call('clearHistory', () => ({ deleted: 0 })),
  pinned: call('pinned', () => pinned),
  pinSite: call('pinSite', (url, title) => { pinned.push({ id: nextPin++, url, title, position: pinned.length, thumb: null }); return { ok: true }; }),
  unpinSite: call('unpinSite', (id) => { pinned = pinned.filter(p => p.id !== id); return { ok: true }; }),
  orderPinned: call('orderPinned', (ids) => { pinned = ids.map(id => pinned.find(p => p.id === id)); return { ok: true }; }),
  editPin: call('editPin', (id, url, title) => { const p = pinned.find(x => x.id === id); if (!p || !/^https?:/.test(url)) return { ok: false }; Object.assign(p, { url, title }); return { ok: true }; }),
  clearPinThumb: call('clearPinThumb', () => ({ ok: true })),
  duplicate: call('duplicate', (id) => { const t = tabs.find(x => x.id === id); const d = tab(t.url); tabs.push(d); activeId = d.id; push(); return { ok: true, id: d.id }; }),
  home: call('home', () => ({ settings: { ...homeSettings }, pinned: JSON.parse(JSON.stringify(pinned)),
    suggestions: [{ url: 'https://news.example/', title: 'News', visits: 9 }] })),
  setHome: call('setHome', (value) => { homeSettings = { ...homeSettings, ...value }; return { settings: { ...homeSettings } }; }),
  site: call('site', () => ({ settings: { ...settings }, blocked: 3 })),
  setSite: call('setSite', (url, key, value) => { if (value === null) delete settings[key]; else settings[key] = value; return { ok: true }; }),
  clearSite: call('clearSite', () => ({ cleared: 0 })),
  searchEngines: call('searchEngines', () => ({ current: 'duckduckgo', options: ['duckduckgo', 'google', 'bing', 'brave'] })),
  setSearchEngine: call('setSearchEngine', () => ({ ok: true })),
  adblockStats: call('adblockStats', () => ({ lists: 3, network: 106000, cosmetic: 26000, skipped: 7600, skippedBy: {} })),
  answerPermission: (...args) => record('answerPermission', args),
  downloads: call('downloads', () => [{ id: 'd1', url: 'https://example.com/report.pdf', filename: 'report.pdf', state: 'completed', received: 10, total: 10 }]),
  download: call('download', () => ({ ok: true })),
  onState: on('state'), onEvent: on('event'), onDownload: on('download'), onPermission: on('permission'), onShortcut: on('shortcut'),
  // Password keeper and audio output (Kairos Browser feedback, 2026-11-06).
  answerPassword: call('answerPassword', () => ({ ok: true })), fillPassword: call('fillPassword', () => ({ ok: true, filled: 2 })),
  useStrongPassword: call('useStrongPassword', () => ({ ok: true, filled: 2 })), importPasswords: call('importPasswords', () => ({ ok: false, canceled: true })),
  onPasswordOffer: on('passwordOffer'), onPasswordSuggest: on('passwordSuggest'),
  audioOutput: call('audioOutput', () => ({ label: audioLabel })), setAudioOutput: call('setAudioOutput', (label) => { audioLabel = label; return { ok: true, label }; }),
} });

// The check's own handle: what was called, and a way to send main's events.
contextBridge.exposeInMainWorld('__browseStub', {
  calls: () => JSON.parse(JSON.stringify(calls)),
  emit: (kind, payload) => emit(kind, payload),
});

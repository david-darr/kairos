import { api } from './api.js';

// The Vault page's shared data (Library Vault Polish, 2026-10-22): one graph
// load, indexed once, read by Browse, Map, the reader, the rail and Home.
// The server resolves every link (core/vault_graph.py); nothing here guesses.

const RECENT_KEY = 'kairos:vault-recent';
const RAIL_KEY = 'kairos:vault-rail';
const RECENT_MAX = 8;
export const REQUIRED_PROPERTIES = ['status', 'project', 'type'];

export const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function relativeTime(seconds) {
  if (!seconds) return '';
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const readLocal = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } };
const writeLocal = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* A private window keeps it for this view only. */ } };

export const railOpen = () => readLocal(RAIL_KEY, true) !== false;
export const setRailOpen = value => writeLocal(RAIL_KEY, !!value);

export function createVaultStore() {
  const listeners = new Set();
  const store = {
    graph: null, byId: new Map(), children: new Map(), backlinks: new Map(), outlinks: new Map(), missing: new Map(),
    pins: [], recent: readLocal(RECENT_KEY, []).filter(p => typeof p === 'string'),
    notes: [], dailies: [], daily: null,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(kind) { for (const fn of listeners) fn(kind); },
    async load() {
      const [graph, pins, daily] = await Promise.all([
        api('/api/vault/graph'),
        api('/api/vault/pins').catch(() => ({ pins: [] })),
        api('/api/vault/daily').catch(() => null),
      ]);
      index(graph);
      store.pins = (pins.pins || []).filter(p => store.byId.has(p));
      store.daily = daily;
      store.emit('load');
      return store;
    },
    async refreshDaily() { store.daily = await api('/api/vault/daily').catch(() => store.daily); return store.daily; },
    note: id => store.byId.get(id),
    isPinned: id => store.pins.includes(id),
    async togglePin(id) {
      const next = store.isPinned(id) ? store.pins.filter(p => p !== id) : [...store.pins, id];
      const saved = await api('/api/vault/pins', { method: 'PUT', body: JSON.stringify({ pins: next }) });
      store.pins = saved.pins; store.emit('pins');
    },
    remember(id) {
      store.recent = [id, ...store.recent.filter(p => p !== id)].slice(0, RECENT_MAX);
      writeLocal(RECENT_KEY, store.recent); store.emit('recent');
    },
    // The note a folder opens on its crumb: its own `<Folder Name>.md` index.
    folderIndex(folderId) {
      if (!folderId) return store.byId.get('Vault Index.md') || null;
      const name = folderId.split('/').pop();
      return store.byId.get(`${folderId}/${name}.md`) || null;
    },
    isIndex: node => node?.type === 'note' && !!node.folder && node.name === node.folder.split('/').pop(),
    missingProperties: node => node?.type === 'note' ? REQUIRED_PROPERTIES.filter(key => !node.frontmatter?.[key]) : [],
    orphans: () => store.notes.filter(n => !(store.backlinks.get(n.id)?.length) && !(store.outlinks.get(n.id)?.length) && !(store.missing.get(n.id)?.length)),
    lackingProperties: () => store.notes.filter(n => store.missingProperties(n).length),
    // Folders whose children are mostly dated notes read newest first.
    isDatedFolder(folderId) {
      const kids = (store.children.get(folderId) || []).filter(n => n.type === 'note');
      return kids.length >= 3 && kids.filter(n => n.daily).length / kids.length >= .6;
    },
    sortedChildren(folderId) {
      const kids = [...(store.children.get(folderId) || [])];
      const dated = store.isDatedFolder(folderId);
      return kids.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        if (store.isIndex(a) !== store.isIndex(b)) return store.isIndex(a) ? -1 : 1;
        if (dated && a.daily && b.daily) return b.name.localeCompare(a.name);
        if (dated && a.daily !== b.daily) return a.daily ? 1 : -1;
        return naturalCompare(a.name, b.name);
      });
    },
    countNotes(folderId) {
      let total = 0;
      for (const child of store.children.get(folderId) || []) total += child.type === 'folder' ? store.countNotes(child.id) : 1;
      return total;
    },
    // Notes within `depth` link hops of `id` (both directions).
    neighbourhood(id, depth = 1) {
      const seen = new Map([[id, 0]]);
      let frontier = [id];
      for (let d = 1; d <= depth; d++) {
        const next = [];
        for (const current of frontier) {
          for (const other of [...(store.outlinks.get(current) || []), ...(store.backlinks.get(current) || [])]) {
            if (!seen.has(other)) { seen.set(other, d); next.push(other); }
          }
        }
        frontier = next;
      }
      return seen;
    },
  };

  function index(graph) {
    store.graph = graph;
    store.byId.clear(); store.children.clear(); store.backlinks.clear(); store.outlinks.clear(); store.missing.clear();
    for (const node of graph.nodes) store.byId.set(node.id, node);
    for (const edge of graph.edges) {
      if (edge.kind === 'contains') {
        const node = store.byId.get(edge.target);
        if (!node) continue;
        if (!store.children.has(edge.source)) store.children.set(edge.source, []);
        store.children.get(edge.source).push(node);
      } else if (edge.kind === 'link') {
        if (!store.outlinks.has(edge.source)) store.outlinks.set(edge.source, []);
        store.outlinks.get(edge.source).push(edge.target);
        if (!store.backlinks.has(edge.target)) store.backlinks.set(edge.target, []);
        store.backlinks.get(edge.target).push(edge.source);
      }
    }
    for (const item of graph.missing || []) {
      if (!store.missing.has(item.source)) store.missing.set(item.source, []);
      store.missing.get(item.source).push(item.target);
    }
    store.notes = graph.nodes.filter(n => n.type === 'note');
    store.dailies = store.notes.filter(n => n.daily);
    store.recent = store.recent.filter(p => store.byId.has(p));
  }
  return store;
}

// The sidebar's menus for a conversation, a folder and a bot (Bots Phase 1, unit U4),
// and the calls behind them. Both halves have no DOM of their own: the item lists are
// plain data for botsUi.openMenu(), and the calls take a `request(path, init)` function
// (api.js in the app, a fake in scripts/test_bots_rail.cjs), so Node can test every
// rule. The server stays the authority: each call returns what the server says, and the
// caller redraws from a fresh read.
import { threadLink } from './botsNavigation.js';

export const SNOOZE_CHOICES = [
  ['activity', 'Until something new'],
  ['tonight', 'Tonight'],
  ['tomorrow', 'Tomorrow morning'],
];
const json = body => ({ method: 'POST', body: JSON.stringify(body) });
const send = (method, body) => ({ method, body: JSON.stringify(body) });
const base = agentId => `/api/agents/${encodeURIComponent(agentId)}`;

// What a person can do to one conversation. `row` is a thread row from
// GET /api/agents/{id}/threads; `folders` the bot's folders; `main` whether it is the
// bot's main conversation. `handlers` supplies one function per verb.
export function threadMenuItems({ row, folders = [], main = false, handlers = {} }) {
  const thread = row.thread || {};
  const snoozed = thread.snoozed_until === 0 || Number(thread.snoozed_until) > 0;
  const call = name => () => handlers[name]?.(row);
  const items = [
    { label: 'Open', iconName: 'messages-square', onSelect: call('open') },
    { label: 'Rename', iconName: 'pencil', onSelect: call('rename') },
    { label: thread.pinned ? 'Unpin' : 'Pin', iconName: 'pin', onSelect: call('pin') },
    { label: thread.unread ? 'Mark as read' : 'Mark as unread', iconName: 'check', onSelect: call('unread') },
    { separator: true },
    { heading: 'Move to folder' },
    { label: 'No folder', checked: !thread.folder_id, onSelect: () => handlers.move?.(row, null) },
    ...folders.map(folder => ({ label: `${folder.emoji ? folder.emoji + ' ' : ''}${folder.name}`, checked: thread.folder_id === folder.id,
      onSelect: () => handlers.move?.(row, folder.id) })),
    { label: 'New folder...', iconName: 'folder-plus', onSelect: call('moveToNewFolder') },
    { separator: true },
    { heading: 'Snooze' },
    ...SNOOZE_CHOICES.map(([kind, label]) => ({ label, iconName: 'clock', onSelect: () => handlers.snooze?.(row, kind) })),
  ];
  if (snoozed) items.push({ label: 'Stop snoozing', iconName: 'x', onSelect: () => handlers.snooze?.(row, 'stop') });
  items.push({ separator: true },
    { label: 'Copy link', iconName: 'copy', onSelect: call('copyLink') },
    { label: 'Select', iconName: 'check', onSelect: call('select') });
  if (!main) items.push({ label: 'Make main conversation', iconName: 'zap', onSelect: call('makeMain') });
  items.push(main
    ? { note: 'The main conversation cannot be archived or deleted. Make another one main first.' }
    : { label: 'Archive', iconName: 'archive', onSelect: call('archive') },
  { separator: true },
  { label: 'Delete', iconName: 'trash-2', danger: true, disabled: main, onSelect: call('remove') });
  return items;
}

// What a person can do to a folder; `index` and `count` say which moves exist.
export function folderMenuItems({ folder, index = 0, count = 1, handlers = {} }) {
  return [
    { label: 'Rename', iconName: 'pencil', onSelect: () => handlers.rename?.(folder) },
    { label: 'Move up', disabled: index <= 0, onSelect: () => handlers.move?.(folder, -1) },
    { label: 'Move down', disabled: index >= count - 1, onSelect: () => handlers.move?.(folder, 1) },
    { separator: true },
    { label: 'Delete folder', iconName: 'trash-2', danger: true, onSelect: () => handlers.remove?.(folder) },
    { note: 'Its conversations stay, outside any folder.' },
  ];
}

// What a person can do to a bot in the sidebar.
export function botMenuItems({ bot, pinned = false, handlers = {} }) {
  const call = name => () => handlers[name]?.(bot);
  return [
    { label: 'Open', iconName: 'messages-square', onSelect: call('open') },
    { label: pinned ? 'Unpin' : 'Pin', iconName: 'pin', onSelect: call('pin') },
    { label: 'New conversation', iconName: 'plus', onSelect: call('newThread') },
    { label: 'New folder', iconName: 'folder-plus', onSelect: call('newFolder') },
    { separator: true },
    { label: 'Settings', iconName: 'settings', onSelect: call('settings') },
  ];
}

// The calls. `request(path, init)` resolves with the parsed body or rejects with
// an Error whose message the person can read.
export function botsThreadApi(request) {
  return {
    list: (agentId, { archived = false } = {}) => request(`${base(agentId)}/threads${archived ? '?include_archived=1' : ''}`),
    create: (agentId, { title, folderId } = {}) => request(`${base(agentId)}/threads`, json({ ...(title ? { title } : {}), ...(folderId ? { folder_id: folderId } : {}) })),
    patch: (agentId, sessionId, fields) => request(`${base(agentId)}/threads/${encodeURIComponent(sessionId)}`, send('PATCH', fields)),
    rename: (agentId, sessionId, title) => request(`${base(agentId)}/threads/${encodeURIComponent(sessionId)}`, send('PATCH', { title })),
    pin: (agentId, row) => request(`${base(agentId)}/threads/${encodeURIComponent(row.id)}`, send('PATCH', { pinned: !row.thread?.pinned })),
    unread: (agentId, row) => request(`${base(agentId)}/threads/${encodeURIComponent(row.id)}`, send('PATCH', { unread: !row.thread?.unread })),
    move: (agentId, sessionId, folderId) => request(`${base(agentId)}/threads/${encodeURIComponent(sessionId)}`, send('PATCH', { folder_id: folderId || null })),
    // The person's timezone reaches the server through the presence call (U1, /api/bot-chat/presence), not here.
    snooze: (agentId, sessionId, kind) => request(`${base(agentId)}/threads/${encodeURIComponent(sessionId)}`, send('PATCH', { snooze: kind })),
    archive: (agentId, sessionId, archived = true) => request(`${base(agentId)}/threads/${encodeURIComponent(sessionId)}`, send('PATCH', { archived })),
    makeMain: (agentId, sessionId) => request(`${base(agentId)}/threads/${encodeURIComponent(sessionId)}`, send('PATCH', { main: true })),
    remove: (agentId, ids) => request(`${base(agentId)}/threads/delete`, json({ thread_ids: [].concat(ids) })),
    addFolder: (agentId, name, emoji) => request(`${base(agentId)}/folders`, json({ name, ...(emoji ? { emoji } : {}) })),
    renameFolder: (agentId, folderId, name) => request(`${base(agentId)}/folders/${encodeURIComponent(folderId)}`, send('PATCH', { name })),
    removeFolder: (agentId, folderId) => request(`${base(agentId)}/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' }),
    orderFolders: (agentId, ids) => request(`${base(agentId)}/folders/order`, send('PUT', { ids })),
    pinBot: (agentId, pinned) => request(`/api/agents/conversations/agent/${encodeURIComponent(agentId)}`, json({ action: pinned ? 'pin' : 'unpin' })),
  };
}

// Folder ids after moving one by `offset`; the ids unchanged when it cannot move.
export function movedFolderIds(folders, folderId, offset) {
  const ids = (Array.isArray(folders) ? folders : []).map(folder => folder.id);
  const from = ids.indexOf(folderId), to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  return ids;
}

// A copied link names the bot and the conversation and nothing else (no title, no text).
export function copyableLink(origin, agentId, sessionId) { return threadLink(origin, agentId, sessionId); }

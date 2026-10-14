// The floating bot window (Agents 2.0, 2026-10-14): a small always-on-top
// list of the bots that matter right now, needing you first, then working,
// then waiting on a teammate. It shares its status rules with the Agents tab
// (botStatus.js) and its faces with everything else (agentAvatar.js), and it
// is the at-a-glance bot surface now that the sidebar no longer lists bots.
// Monocode's floating window is macOS-only; this one is built for Windows.
import { botStatus, botStatusLine, compareStatus } from './botStatus.js';
import { agentAvatar } from './agentAvatar.js';

const POLL_MS = 15000;
const SHOWN = new Set(['needs_you', 'working', 'teammate']);

// The bots worth showing, highest need first. Exported for ui-smoke.
export function rank(agents) {
  return agents
    .filter(agent => agent.enabled !== false)
    .map(agent => ({ agent, state: botStatus(agent), line: botStatusLine(agent) }))
    .filter(row => SHOWN.has(row.state))
    .sort((a, b) => compareStatus(a.state, b.state) || a.agent.name.localeCompare(b.agent.name));
}

// Rows are kept by id so a poll never restarts a face or steals focus.
export function render(host, agents, { openAgent = () => {} } = {}) {
  const rows = rank(agents);
  let list = host.querySelector('.bot-window-list');
  if (!list) {
    list = document.createElement('ul');
    list.className = 'bot-window-list';
    list.setAttribute('aria-label', 'Bots that need attention');
    host.append(list);
  }
  let empty = host.querySelector('.bot-window-empty');
  if (!empty) {
    empty = document.createElement('p');
    empty.className = 'bot-window-empty';
    empty.textContent = 'Nothing needs you. Your bots are quiet.';
    host.append(empty);
  }
  // A quiet line rather than hiding the window: the person opened it and
  // expects it to stay where they put it.
  empty.hidden = rows.length > 0;
  const existing = new Map([...list.children].map(node => [node.dataset.agentId, node]));
  for (const { agent, state, line } of rows) {
    let item = existing.get(agent.id);
    if (!item) {
      item = document.createElement('li');
      item.dataset.agentId = agent.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bot-window-row';
      const face = agentAvatar(agent, 36);
      const copy = document.createElement('span');
      copy.className = 'bot-window-copy';
      copy.append(Object.assign(document.createElement('span'), { className: 'bot-window-name' }),
        Object.assign(document.createElement('span'), { className: 'bot-window-line' }));
      button.append(face, copy);
      button.addEventListener('click', () => openAgent(item.dataset.agentId));
      item.append(button);
    }
    item.dataset.state = state;
    item.querySelector('.bot-window-name').textContent = agent.name;
    item.querySelector('.bot-window-line').textContent = line.text;
    item.querySelector('button').setAttribute('aria-label', `${agent.name}: ${line.text}`);
    list.append(item);  // re-append in rank order; existing nodes move, not rebuild
    existing.delete(agent.id);
  }
  for (const node of existing.values()) node.remove();
  return rows;
}

async function boot() {
  const host = document.getElementById('bots');
  const bridge = window.botWindow;
  let timer = 0;
  const refresh = async () => {
    clearTimeout(timer);
    try {
      const response = await fetch('/api/agents', { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        render(host, Array.isArray(data) ? data : data.items || [], { openAgent: id => bridge?.openAgent(id) });
        document.body.classList.remove('is-offline');
      } else document.body.classList.add('is-offline');
    } catch { document.body.classList.add('is-offline'); }
    timer = setTimeout(refresh, document.hidden ? POLL_MS * 4 : POLL_MS);
  };
  document.getElementById('bot-window-close')?.addEventListener('click', () => bridge?.hide());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();
}

if (document.getElementById('bots')) boot();

// Agents 2.0, 2026-10-14: the persistent sidebar follows the same bot and
// session records as the Agents and Chats views. Keep keyed rows in place so
// a poll cannot restart a halftone portrait or discard an expanded thread.
import { api } from './api.js';
import { portrait, profileColor } from './agentProfile.js';
import * as chatStream from './chatStream.js';

const THREAD_LIMIT = 5;
const STORAGE = 'kairos:sidebar-section:';
const go = detail => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail }));
const button = (className, label, action) => {
  const node = document.createElement('button');
  node.type = 'button'; node.className = className; node.setAttribute('aria-label', label);
  node.addEventListener('click', action);
  return node;
};
const newest = (a, b) => b.updated_at - a.updated_at;
const readOpen = key => { try { return localStorage.getItem(STORAGE + key) !== 'false'; } catch { return true; } };
const saveOpen = (key, value) => { try { localStorage.setItem(STORAGE + key, String(value)); } catch { /* Storage is optional. */ } };

function section(nav, key, title) {
  const host = document.createElement('section'); host.className = 'sidebar-people-section';
  host.dataset.section = key; host.setAttribute('aria-label', title);
  const heading = button('sidebar-section-toggle', title, () => {
    host.dataset.open = String(host.dataset.open !== 'true');
    heading.setAttribute('aria-expanded', host.dataset.open);
    saveOpen(key, host.dataset.open === 'true');
  });
  heading.textContent = title;
  const body = document.createElement('div'); body.className = 'sidebar-section-body';
  host.dataset.open = String(readOpen(key)); heading.setAttribute('aria-expanded', host.dataset.open);
  host.append(heading, body); nav.append(host);
  return body;
}

// A transcript is fetched only when its header changes. The list endpoint
// intentionally carries metadata only (session_manager_store.py, 2026-10-14).
function readable(messages) {
  const last = [...messages].reverse().find(message => ['user', 'assistant'].includes(message.role) &&
    message.type !== 'handoff' && message.status !== 'failed' &&
    typeof message.content === 'string' && message.content.trim());
  if (!last) return '';
  return last.content.replace(/```[\s\S]*?```/g, ' code ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/(^|\s)[#>*_~`-]+(?=\S)/g, '$1').replace(/[*_~`]/g, '')
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function status(agent, threads, details) {
  const messages = threads.flatMap(thread => details.get(thread.id)?.messages || []);
  const handoffs = messages.filter(message => message.type === 'handoff');
  const live = threads.some(thread => chatStream.getInFlight(thread.id)?.status === 'processing');
  // 2026-10-14: the summary's needs_you count aggregates cards and inbox
  // items even while its status says working. Thread handoffs add chat work.
  if (agent.needs_you > 0 || agent.status === 'needs_you' || handoffs.some(m => m.handoff_status === 'needs_you') ||
      messages.some(m => m.inbox_item_id && m.question_status === 'open')) return 'needs_you';
  if (agent.status === 'working' || live) return 'working';
  if (handoffs.some(m => m.handoff_status === 'working')) return 'teammate';
  if (handoffs.some(m => m.handoff_status === 'queued')) return 'queued';
  return 'idle';
}

function threadRow(thread, agentId) {
  const row = button('sidebar-thread', thread.title || 'Untitled', () => go({ tab: 'agents', agentId, sessionId: thread.id }));
  row.dataset.sessionId = thread.id; row.textContent = thread.title || 'Untitled';
  return row;
}

export function mountSidebarBots(nav) {
  const botsBody = section(nav, 'bots', 'Bots');
  const teamsBody = section(nav, 'teams', 'Teams');
  const pinnedBody = section(nav, 'pinned', 'Pinned');
  const rows = new Map(), details = new Map(), allThreadIds = new Set();
  let disposed = false, running = false, again = false;
  const refresh = async () => {
    if (disposed || document.hidden) return;
    if (running) { again = true; return; }
    running = true;
    try {
      const [agents, teams, ordinary] = await Promise.all([
        api('/api/agents'), api('/api/swarm/systems').catch(() => null), api('/api/sessions'),
      ]);
      const lists = await Promise.all(agents.map(agent => api(`/api/sessions?agent_id=${encodeURIComponent(agent.id)}`)));
      const threadsByBot = new Map(agents.map((agent, index) => [agent.id, [...lists[index]].sort(newest)]));
      const allThreads = lists.flat();
      allThreadIds.clear(); for (const thread of allThreads) allThreadIds.add(thread.id);
      await Promise.all(allThreads.map(async thread => {
        const cached = details.get(thread.id);
        // Handoff state and answers can update a message in place without
        // changing the session header's updated_at (2026-10-14).
        if (cached?.updated_at === thread.updated_at && !cached.pending) return;
        const detail = await api(`/api/sessions/${encodeURIComponent(thread.id)}`);
        const messages = detail.messages || [];
        const pending = messages.some(message => (message.type === 'handoff' &&
          ['queued', 'working', 'needs_you'].includes(message.handoff_status)) ||
          (message.inbox_item_id && message.question_status === 'open'));
        details.set(thread.id, { updated_at: thread.updated_at, agent_id: thread.agent_id, messages, pending });
      }));
      if (disposed || !nav.isConnected) return;
      const active = new Set(agents.map(agent => agent.id));
      for (const [id, row] of rows) if (!active.has(id)) { row.node.querySelector('.agent-portrait')?.stopPortrait?.(); row.node.remove(); rows.delete(id); }
      for (const agent of agents) {
        const threads = threadsByBot.get(agent.id);
        let row = rows.get(agent.id);
        if (!row) {
          const node = document.createElement('div'); node.className = 'sidebar-bot'; node.dataset.agentId = agent.id;
          const main = button('sidebar-bot-main', agent.name, () => go({ tab: 'agents', agentId: agent.id, profile: true }));
          const face = document.createElement('span'); face.className = 'sidebar-bot-face'; face.append(portrait(agent, 30));
          const copy = document.createElement('span'); copy.className = 'sidebar-bot-copy';
          const name = document.createElement('span'); name.className = 'sidebar-bot-name';
          const preview = document.createElement('span'); preview.className = 'sidebar-bot-preview';
          const dots = document.createElement('span'); dots.className = 'sidebar-bot-dots'; dots.setAttribute('aria-label', 'Working');
          dots.innerHTML = '<i></i><i></i><i></i>';
          copy.append(name, preview, dots); main.append(face, copy);
          const expand = button('sidebar-bot-expand', `Show ${agent.name} threads`, () => {
            node.classList.toggle('is-expanded'); expand.setAttribute('aria-expanded', String(node.classList.contains('is-expanded')));
          });
          expand.textContent = '⌄'; expand.setAttribute('aria-expanded', 'false');
          const add = button('sidebar-bot-add', `New thread with ${agent.name}`, async () => {
            try { const created = await api(`/api/agents/${encodeURIComponent(agent.id)}/chat`, { method: 'POST' });
              go({ tab: 'agents', agentId: agent.id, sessionId: created.id }); refresh(); }
            catch (error) { console.error('Could not start bot thread', error); }
          }); add.textContent = '+';
          const threadHost = document.createElement('div'); threadHost.className = 'sidebar-bot-threads';
          node.append(main, expand, add, threadHost); row = { node, main, face, name, preview, dots, expand, add, threadHost, threads: new Map() };
          rows.set(agent.id, row);
        }
        botsBody.append(row.node); row.main.setAttribute('aria-label', agent.name); row.name.textContent = agent.name;
        row.expand.setAttribute('aria-label', `Show ${agent.name} threads`);
        row.add.setAttribute('aria-label', `New thread with ${agent.name}`);
        if (row.face.firstElementChild?.dataset.color !== profileColor(agent)) {
          row.face.firstElementChild?.stopPortrait?.(); row.face.replaceChildren(portrait(agent, 30));
        }
        const tone = status(agent, threads, details);
        row.node.dataset.status = tone;
        row.preview.textContent = threads.map(thread => readable(details.get(thread.id)?.messages || []))
          .find(Boolean) || (threads.length ? 'No messages yet' : 'Start a conversation');
        row.node.classList.toggle('is-working', agent.status === 'working' ||
          threads.some(thread => chatStream.getInFlight(thread.id)?.status === 'processing'));
        const shown = threads.slice(0, THREAD_LIMIT), visible = new Set(shown.map(thread => thread.id));
        for (const [id, node] of row.threads) if (!visible.has(id)) { node.remove(); row.threads.delete(id); }
        for (const thread of shown) {
          let node = row.threads.get(thread.id);
          if (!node) { node = threadRow(thread, agent.id); row.threads.set(thread.id, node); }
          node.textContent = thread.title || 'Untitled'; row.threadHost.append(node);
        }
        let all = row.threadHost.querySelector('.sidebar-thread-all');
        if (threads.length > THREAD_LIMIT) {
          if (!all) { all = button('sidebar-thread-all', `Show all ${agent.name} threads`, () => go({ tab: 'agents', agentId: agent.id })); all.textContent = 'Show all'; }
          row.threadHost.append(all);
        } else all?.remove();
      }
      // Teams and pinned chats are existing concepts. These small lists are
      // reconciled by ID as well, preserving button focus during a refresh.
      reconcileSimple(teamsBody, teams?.items || [], item => item.id, item => item.name,
        item => go({ tab: 'agents', team: item.id }), 'team');
      teamsBody.parentElement.hidden = !teams?.items?.length;
      const pinned = [...ordinary, ...allThreads].filter(thread => thread.starred).sort(newest);
      reconcileSimple(pinnedBody, pinned, item => item.id, item => item.title || 'Untitled',
        item => go(item.agent_id ? { tab: 'agents', agentId: item.agent_id, sessionId: item.id } : { tab: 'chat', sessionId: item.id }), 'pinned');
      pinnedBody.parentElement.hidden = !pinned.length;
    } catch (error) {
      // Navigating to the website or reloading can abort a pending fetch.
      // The next mounted rail gets a fresh read (2026-10-14).
      if (!disposed && nav.isConnected && error?.message !== 'Failed to fetch')
        console.error('Could not refresh sidebar bots', error);
    }
    finally { running = false; if (again) { again = false; refresh(); } }
  };
  const unsubscribe = chatStream.subscribeAll((id, entry) => {
    if (allThreadIds.has(id)) {
      if (entry?.status === 'processing') {
        const row = [...rows.values()].find(row => row.node.dataset.agentId &&
          (row.threads.has(id) || details.get(id)?.agent_id === row.node.dataset.agentId));
        if (row) { if (row.node.dataset.status !== 'needs_you') row.node.dataset.status = 'working'; row.node.classList.add('is-working'); }
      } else refresh();
    }
  });
  refresh();
  return { refresh, dispose: () => { disposed = true; unsubscribe(); for (const row of rows.values()) row.face.firstElementChild?.stopPortrait?.(); } };
}

function reconcileSimple(host, items, key, label, navigate, kind) {
  const existing = new Map([...host.children].map(node => [node.dataset.id, node]));
  for (const item of items) {
    const id = key(item); let node = existing.get(id);
    if (!node) { node = button(`sidebar-${kind}-row`, label(item), () => navigate(item)); node.dataset.id = id; }
    node.textContent = label(item); node.setAttribute('aria-label', label(item)); host.append(node); existing.delete(id);
  }
  for (const node of existing.values()) node.remove();
}

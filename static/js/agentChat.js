// Chatting with an agent inside the Agents tab (David's ask 2026-10-05):
// the agent's own conversations, kept out of the Chats list. A list of its
// chats beside one open conversation. The conversation itself is
// sessionChat.js (shared with tabs' chats since 2026-10-08), which streams
// through the chatStream.js registry, so a reply keeps running if you leave
// the tab and is there when you come back.
import { api, el, toast, confirmDialog } from './api.js';
import { mountSessionChat } from './sessionChat.js';

const LAST_KEY = 'jarvis:agent-chat:';

function remembered(agentId) {
  try { return localStorage.getItem(LAST_KEY + agentId); } catch { return null; }
}
function remember(agentId, sessionId) {
  try { sessionId ? localStorage.setItem(LAST_KEY + agentId, sessionId) : localStorage.removeItem(LAST_KEY + agentId); } catch { /* private mode */ }
}

export async function mountAgentChat(host, agent, requestedSessionId = null, options = {}) {
  let sessionId = null;
  let closePane = () => {};
  const media = matchMedia('(max-width: 768px)');
  const activityHome = options.activity?.parentNode;
  const placeActivity = () => {
    const target = media.matches ? main.querySelector('.agent-conversation-stream') : activityHome;
    if (target && options.activity && options.activity.parentNode !== target) target.append(options.activity);
  };
  media.addEventListener('change', placeActivity);
  const filter = () => {
    const query = (options.search?.value || '').trim().toLocaleLowerCase();
    list.querySelectorAll('.agent-chat-item').forEach(item => { item.hidden = !item.querySelector('.agent-chat-title').textContent.toLocaleLowerCase().includes(query); });
    scope.textContent = query ? 'Matching loaded titles only' : 'Search covers loaded conversation titles';
    side.open = !!query;
  };
  options.search?.addEventListener('input', filter);
  const dispose = () => { closePane(); media.removeEventListener('change', placeActivity); options.search?.removeEventListener('input', filter); };

  const list = el('div', { class: 'agent-chat-list', role: 'list', 'aria-label': `Chats with ${agent.name}` });
  const main = el('section', { class: 'agent-chat-main' });
  const newChat = el('button', { type: 'button', class: 'btn agent-chat-new', text: '+ New chat' });
  // Decision 2026-10-13: off and capped bots still answer direct chats.
  const scheduled = agent.enabled === false || agent.status === 'off' || agent.status === 'capped' ||
    (Number.isFinite(agent.daily_run_cap) && agent.runs_today >= agent.daily_run_cap);
  const honesty = scheduled ? el('p', { class: 'agent-chat-honesty', text: `${agent.name} will answer here, but will not pick up scheduled work while turned off or capped.` }) : null;
  const scope = el('p', { class: 'agent-search-scope', text: 'Search covers loaded conversation titles' });
  const side = el('details', { class: 'agent-chat-side' }, [el('summary', { text: 'Conversations' }), newChat, scope, list]);
  host.replaceChildren(el('div', { class: 'agent-chat' }, [
    side,
    ...(honesty ? [honesty] : []), main,
  ]));

  const pane = async (id) => {
    closePane();
    sessionId = id;
    remember(agent.id, id);
    closePane = await mountSessionChat(main, {
      sessionId: id,
      createSession: async () => {
        const created = await api(`/api/agents/${agent.id}/chat`, { method: 'POST' });
        sessionId = created.id;
        remember(agent.id, created.id);
        refreshList();
        return created.id;
      },
      title: `Chat with ${agent.name}`,
      agent,
      placeholder: `Message ${agent.name}`,
      emptyTitle: `Talk with ${agent.name}`,
      emptyText: 'It knows its role, its notes and its tools. Anything it learns here it can keep in its memory.',
      onTurnEnd: () => refreshList(),
    });
    placeActivity();
    markActive();
  };

  const open = async (id) => {
    try { await api(`/api/sessions/${id}`); }
    catch { remember(agent.id, null); await pane(null); refreshList(); return; }
    if (host.isConnected) await pane(id);
  };

  const markActive = () => list.querySelectorAll('.agent-chat-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.session === sessionId);
    item.setAttribute('aria-current', String(item.dataset.session === sessionId));
  });

  const refreshList = async () => {
    const chats = await api(`/api/sessions?agent_id=${encodeURIComponent(agent.id)}`).catch(() => []);
    if (!host.isConnected) return chats;
    list.replaceChildren(...chats.map((chat) => el('div', { class: 'agent-chat-item', role: 'listitem', 'data-session': chat.id }, [
      el('button', { type: 'button', class: 'agent-chat-open', onclick: () => open(chat.id) }, [
        el('span', { class: 'agent-chat-title', text: chat.title || 'Untitled' }),
        el('span', { class: 'meta', text: new Date(chat.updated_at * 1000).toLocaleDateString() }),
      ]),
      el('button', { type: 'button', class: 'input-icon-btn agent-chat-delete', 'aria-label': `Delete ${chat.title}`, title: 'Delete chat', text: '×',
        onclick: async () => {
          if (!await confirmDialog({ title: 'Delete this chat?', message: `"${chat.title}" will be deleted.`, confirmLabel: 'Delete chat' })) return;
          await api(`/api/sessions/${chat.id}`, { method: 'DELETE' }).catch((problem) => toast(problem.message, 'error'));
          if (chat.id === sessionId) { remember(agent.id, null); await pane(null); }
          refreshList();
        } }),
    ])));
    if (!chats.length) list.append(el('div', { class: 'meta agent-chat-none', text: 'No chats yet.' }));
    markActive();
    filter();
    return chats;
  };

  newChat.addEventListener('click', async () => {
    try {
      const created = await api(`/api/agents/${agent.id}/chat`, { method: 'POST' });
      await refreshList();
      await pane(created.id);
      main.querySelector('textarea')?.focus();
    } catch (problem) { toast(problem.message, 'error'); }
  });

  const chats = await refreshList();
  // 2026-10-14: sidebar threads address the same session, including a new
  // empty one, instead of falling back to this agent's remembered chat.
  if (requestedSessionId && chats.some(c => c.id === requestedSessionId)) { await open(requestedSessionId); return dispose; }
  const last = remembered(agent.id);
  if (last && chats.some((c) => c.id === last)) await open(last);
  else if (chats.length) await open(chats[0].id);
  else await pane(null);
  return dispose;
}

import { api as sharedApi, el as h } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { rowText } from './botsWorkModel.js';

export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-work.css');
  const api = ctx.api || sharedApi, controller = new AbortController(), opener = document.activeElement;
  let disposed = false, generation = 0, chat = null, chatLoading = false, task = null, poll;
  const dialog = h('dialog', { class: 'bots-work-sheet bots-task-page', 'aria-label': 'Task' });
  const title = h('h2', { text: 'Task' });
  const content = h('div', { class: 'bots-task-report' });
  const notice = h('p', { class: 'bots-work-notice', role: 'status' });
  const chatHost = h('div', { class: 'bots-task-conversation', hidden: true });
  const toggle = h('button', { type: 'button', class: 'bots-btn', text: 'Show conversation', onclick: () => conversation() });
  function dispose() {
    if (disposed) return;
    disposed = true; generation++; controller.abort(); clearTimeout(poll); chat?.dispose?.();
    dialog.close(); dialog.remove(); if (opener?.isConnected) opener.focus(); ctx.onClose?.();
  }
  const request = (path, options = {}) => api(path, { signal: controller.signal, ...options });
  async function action(name) {
    if (!task) return;
    const buttons = [...content.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
    try {
      await request(`/api/front-desk/tasks/${encodeURIComponent(task.id)}/${name}`, {
        method: 'POST', body: JSON.stringify(name === 'again' ? { turn_count: task.turn_count } : {}),
      });
      if (!disposed) { await refresh(); ctx.onChanged?.(); }
    } catch (error) { if (!disposed) notice.textContent = error.message || 'Could not update. Try again.'; }
    finally { if (!disposed) buttons.forEach(b => { b.disabled = false; }); }
  }
  async function conversation(force = false) {
    if (!task || chatLoading) return;
    const show = force || chatHost.hidden;
    chatHost.hidden = !show; toggle.textContent = show ? 'Hide conversation' : 'Show conversation';
    if (!show || chat) return;
    chatLoading = true;
    try {
      const mod = await (ctx.loadChat ? ctx.loadChat() : import('./botsChat.js'));
      if (disposed) return;
      const mounted = await mod.mountBotsChat(chatHost, { agent: ctx.agent || ctx.getAgent?.(), sessionId: task.thread_id, api });
      if (disposed) mounted?.dispose?.(); else chat = mounted;
    } catch { if (!disposed) { notice.textContent = 'Could not open the conversation. Try again.'; chatHost.hidden = true; toggle.textContent = 'Show conversation'; } }
    finally { chatLoading = false; }
  }
  async function refresh() {
    const current = ++generation;
    try {
      const data = await request(`/api/front-desk/tasks/${encodeURIComponent(ctx.taskId)}/report`);
      if (disposed || current !== generation) return;
      task = data.task; title.textContent = task.title; notice.textContent = '';
      const actions = h('div', { class: 'bots-work-actions' }, [h('button', { type: 'button', class: 'bots-btn primary',
        text: task.state === 'resolved' ? 'Reopen' : 'Mark done', onclick: () => action(task.state === 'resolved' ? 'reopen' : 'resolve') })]);
      if (task.state === 'failed') actions.append(h('button', { type: 'button', class: 'bots-btn', text: 'Try again', onclick: () => action('again') }));
      const timeline = h('ol', { class: 'bots-task-timeline' });
      for (const update of data.updates || []) timeline.append(h('li', {}, [
        h('span', { text: `${update.kind === 'reply' ? 'You: ' : update.kind === 'decision' ? `${update.status || 'Decision'}: ` : ''}${update.text}` }),
        h('time', { text: update.at ? new Date(update.at * 1000).toLocaleString() : '' }),
      ]));
      const resources = h('ul', { class: 'bots-task-resources' });
      for (const item of data.resources || []) {
        let safe = false;
        try { const url = new URL(item.url); safe = url.protocol === 'https:' && !url.username && !url.password; } catch { /* inert */ }
        resources.append(h('li', {}, [safe ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', text: item.title }) : h('span', { text: item.title })]));
      }
      content.replaceChildren(h('p', { text: `${task.origin === 'asked' || task.origin === 'make' ? 'You asked' : 'Noticed'} ${new Date(task.created_at * 1000).toLocaleString()}` }),
        h('p', { class: `bots-work-state ${task.state}`, text: rowText(task) }),
        h('p', { text: task.ask }), task.why ? h('p', { text: task.why }) : '',
        task.channel_tag ? h('p', { text: task.channel_tag }) : '', actions,
        h('h3', { text: 'Decisions and updates' }), timeline.children.length ? timeline : h('p', { text: 'No updates yet.' }),
        h('h3', { text: 'Resources' }), resources.children.length ? resources : h('p', { text: 'No resources recorded yet.' }));
    } catch (error) { if (!disposed && current === generation) notice.textContent = error.message || 'Could not load this task. Try again.'; }
  }
  dialog.append(h('header', {}, [title, h('button', { type: 'button', class: 'bots-btn', text: 'Close', onclick: dispose })]),
    content, notice, h('button', { type: 'button', class: 'bots-btn', text: 'Refresh', onclick: refresh }), toggle, chatHost);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dispose(); });
  host.append(dialog); dialog.showModal(); refresh();
  function tick() { poll = setTimeout(async () => { if (disposed) return; await refresh(); if (!disposed) tick(); }, 3000); }
  tick();
  return { dispose, refresh, showConversation: () => conversation(true) };
}

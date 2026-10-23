import { api } from './api.js';
import { openMobileSheet } from './mobileSheet.js';
import { mountChatPane } from './chatPaneLayout.js';
import { desktopPanes } from './chatPaneStack.js';

const kinds = { subagent: 'Subagent', command: 'Command', agent: 'Agent', helper: 'Helper', computer: 'Computer', app_server: 'App server', scheduled: 'Scheduled', task: 'Task' };
const statuses = { running: 'Running', queued: 'Queued', waiting: 'Waiting on you', scheduled: 'Scheduled', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const active = item => ['running', 'queued', 'waiting'].includes(item.status);
let sequence = 0;
function node(tag, cls, text) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text != null) element.textContent = String(text);
  return element;
}
function button(text, action, cls = '') {
  const element = node('button', cls, text); element.type = 'button';
  element.addEventListener('click', action); return element;
}
function elapsed(item) {
  if (item.startedAt == null) return '';
  const end = item.endedAt ?? (active(item) ? Date.now() / 1000 : null);
  if (end == null) return '';
  const seconds = Math.max(0, Math.floor(end - item.startedAt));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function mountBackgroundTasks({ host, messages, getSessionId, onOpenComputer }) {
  let sessionId = null, items = [], opened = false, selected = null, disposed = false;
  let sheet = null, revision = 0, detailTimer = null, detailAt = 0, request = 0, dock = null;
  const canDock = () => typeof window !== 'undefined' && desktopPanes(host.closest('.chat-layout'));
  const notify = () => { if (typeof document.dispatchEvent === 'function') document.dispatchEvent(new CustomEvent('kairos:background-ui')); };
  const seen = new Set();
  const pill = button('', () => opened ? close() : open(), 'bg-tasks-pill');
  const dot = node('span', 'bg-tasks-dot'); dot.setAttribute('aria-hidden', 'true');
  const caption = node('span', 'bg-tasks-caption'); pill.append(dot, caption);
  const panel = node('section', 'bg-tasks-panel'); panel.id = `bg-tasks-${++sequence}`;
  panel.setAttribute('aria-label', 'Background tasks'); panel.hidden = true;
  pill.setAttribute('aria-controls', panel.id); pill.setAttribute('aria-expanded', 'false');
  host.append(pill, panel);

  function close() {
    opened = false; selected = null; request++;
    clearTimeout(detailTimer); detailTimer = null;
    const current = sheet; sheet = null; current?.close();
    if (dock) { const old = dock; dock = null; old.layout.dispose(); old.root.remove(); }
    if (!host.contains(panel)) host.append(panel);
    panel.hidden = true; pill.setAttribute('aria-expanded', 'false');
    notify();
    if (pill.isConnected && !host.hidden) pill.focus({ preventScroll: true });
  }
  function open(id = null) {
    if (disposed || !sessionId) return;
    opened = true; panel.hidden = false; pill.setAttribute('aria-expanded', 'true');
    if (!dock && canDock()) {
      const root = node('section', 'chat-background-pane'); root.setAttribute('aria-label', 'Background tasks');
      const header = node('header', 'chat-side-pane-header');
      const title = node('span', 'chat-pane-heading', 'Background tasks');
      const count = node('small', 'chat-background-count'); title.append(count);
      const expand = button('⛶', () => dock.layout.setMaximized(!dock.layout.isMaximized()), 'chat-pane-icon');
      expand.setAttribute('aria-label', 'Expand background tasks'); expand.title = 'Expand background tasks';
      const dismiss = button('×', close, 'chat-pane-icon'); dismiss.setAttribute('aria-label', 'Close background tasks'); dismiss.title = 'Close background tasks';
      header.append(title, expand, dismiss); root.append(header, panel);
      dock = { root, count, layout: mountChatPane(host.closest('.chat-layout'), root, close, { kind: 'background' }) };
      root.addEventListener('pane-maximize', e => { expand.title = e.detail ? 'Restore background tasks' : 'Expand background tasks'; expand.setAttribute('aria-label', expand.title); });
    }
    if (!sheet && matchMedia('(max-width: 768px)').matches && document.querySelector('.kairos-redesign')) {
      sheet = openMobileSheet({ title: 'Background tasks', content: panel, opener: pill, onClose: () => {
        sheet = null; opened = false; panel.hidden = true; host.append(panel); pill.setAttribute('aria-expanded', 'false');
      } });
    }
    selected = id;
    if (id) loadDetail(); else renderList();
    if (dock) dock.count.textContent = `${items.filter(active).length} running`;
    notify();
    panel.querySelector('button')?.focus();
  }
  function renderPill() {
    host.hidden = !items.length;
    const count = items.filter(active).length, waiting = items.filter(i => i.status === 'waiting').length;
    const finished = items.filter(i => ['done', 'failed', 'stopped'].includes(i.status)).length;
    caption.textContent = count ? `${count} running in background${waiting ? ` · ${waiting} waiting on you` : ''}`
      : finished ? `${finished} finished in background` : `${items.length} scheduled in background`;
    host.dataset.state = count ? 'running' : items.some(i => i.status === 'failed') ? 'failed' : items.every(i => i.status === 'done') ? 'done' : 'idle';
    if (dock) dock.count.textContent = `${count} running`;
    notify();
    if (opened && !selected) renderList();
  }
  function renderList() {
    const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.itemId : null;
    panel.replaceChildren();
    if (!dock && !panel.closest('.ms-sheet')) panel.append(node('h3', 'bg-tasks-heading', 'Background tasks'));
    const list = node('div', 'bg-tasks-list');
    const ordered = dock ? [...items.filter(active), ...items.filter(i => !active(i))] : items;
    let group = null;
    for (const item of ordered) {
      if (dock) { const next = active(item) ? 'Running' : 'Finished'; if (group !== next) { group = next; list.append(node('h4', 'bg-task-group', group)); } }
      const row = button('', () => { selected = item.id; loadDetail(); }, 'bg-task-row');
      row.dataset.itemId = item.id;
      const top = node('span', 'bg-task-top');
      top.append(node('span', 'bg-task-kind', kinds[item.kind] || 'Task'), node('span', `bg-task-status bg-task-status-${item.status}`, statuses[item.status] || item.status));
      const label = node('span', 'bg-task-label', item.label);
      const age = node('span', 'bg-task-elapsed', elapsed(item)); age.dataset.elapsed = item.id;
      row.append(top, label, age);
      if (item.activity) row.append(node('span', 'bg-task-activity', item.activity));
      list.append(row);
    }
    panel.append(list);
    if (focused) [...list.children].find(row => row.dataset.itemId === focused)?.focus({ preventScroll: true });
  }
  function showDetail(data) {
    const focused = panel.contains(document.activeElement);
    const back = button('Back', () => { selected = null; request++; renderList(); panel.querySelector('button')?.focus(); }, 'bg-task-back');
    panel.replaceChildren(back, node('h3', 'bg-task-detail-title', data.item.label));
    const body = node('div', 'bg-task-detail');
    function text(value, cls = '', heading = '', code = false) {
      if (value == null || value === '') return;
      if (heading) body.append(node('h4', 'bg-task-section-heading', heading));
      body.append(node(code ? 'pre' : 'div', cls || 'bg-task-prose', value));
    }
    text(data.prompt, 'bg-task-prompt', 'Prompt');
    if (data.steps?.length) {
      body.append(node('h4', 'bg-task-section-heading', 'Steps'));
      const list = node('ol', 'bg-task-steps');
      for (const step of data.steps) {
        const label = typeof step === 'string' ? step : `${step.name ? step.name + ': ' : ''}${step.text || ''}`;
        list.append(node('li', step.kind === 'tool' ? 'bg-task-tool' : '', label));
      }
      body.append(list);
    }
    text([data.summary, data.text, data.message].filter(Boolean).join('\n\n'), 'bg-task-prose', 'Result');
    text(data.command, 'bg-task-command', 'Command', true);
    text(data.output, 'bg-task-output', 'Output', true);
    text(data.outputTruncated ? 'Showing the last 16 KB' : data.output == null ? data.outputNote : '', 'bg-task-output-note');
    if (data.timeline?.length) {
      body.append(node('h4', 'bg-task-section-heading', 'Timeline'));
      const timeline = node('ol', 'bg-task-timeline');
      for (const step of data.timeline) {
        const time = step.at == null ? '' : new Date(step.at * 1000).toLocaleTimeString();
        timeline.append(node('li', '', [time, step.name || step.kind, step.ok === true ? 'OK' : step.ok === false ? 'Failed' : '', step.detail, step.seconds == null ? '' : `${step.seconds}s`].filter(Boolean).join(' · ')));
      }
      body.append(timeline);
    }
    if (data.usage) {
      const usage = data.usage;
      text([usage.total_tokens == null ? '' : `${usage.total_tokens.toLocaleString()} tokens`,
        usage.tool_uses == null ? '' : `${usage.tool_uses.toLocaleString()} tool use${usage.tool_uses === 1 ? "" : "s"}`,
        usage.duration_ms == null ? '' : `${Math.round(usage.duration_ms / 1000)}s`].filter(Boolean).join(' · '), 'bg-task-usage');
    }
    if (data.lines?.length) text(data.lines.join('\n'), 'bg-task-logs', 'Log', true);
    if (data.item.kind === 'computer') body.append(button('Open computer', () => onOpenComputer?.(sessionId), 'bg-task-open-computer'));
    panel.append(body);
    for (const box of body.querySelectorAll('pre')) box.scrollTop = box.scrollHeight;
    if (focused) back.focus({ preventScroll: true });
  }
  async function loadDetail() {
    clearTimeout(detailTimer); detailTimer = null;
    const sid = sessionId, id = selected, version = ++request;
    if (!id || !opened) return;
    detailAt = Date.now();
    try {
      const data = await api(`/api/chat/background/${encodeURIComponent(sid)}/${encodeURIComponent(id)}`);
      if (!disposed && sid === sessionId && id === selected && version === request && opened) showDetail(data);
    } catch {
      if (sid === sessionId && id === selected && opened && version === request) {
        panel.replaceChildren(button('Back', () => { selected = null; renderList(); }), node('p', '', 'Details are not available'));
      }
    }
  }
  function insertNotes(notes, historical) {
    const scroll = messages.closest('.forge-transcript') || messages;
    const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    for (const note of notes || []) {
      const key = `${note.id}:${Math.round(note.at)}`;
      if (seen.has(key) && messages.querySelector(`[data-bg-note="${CSS.escape(key)}"]`)) continue;
      seen.add(key);
      const verb = note.status === 'done' ? 'finished' : note.status === 'failed' ? 'failed' : 'stopped';
      const label = note.kind === 'agent' ? `${note.label} ${verb}` : `Background ${(kinds[note.kind] || 'task').toLowerCase()} ${verb}: ${note.label}`;
      const available = items.some(i => i.id === note.id);
      const element = available ? button(label, () => open(note.id), 'bg-task-note') : node('div', 'bg-task-note', label);
      if (!available) element.setAttribute('role', 'note'); element.dataset.bgNote = key; element.dataset.ts = String(note.at);
      const entries = [...messages.children].flatMap(child => child.matches('.bg-task-notes') ? [...child.children] : [child]);
      const after = historical ? entries.find(card => Number(card.dataset.ts) > note.at) : null;
      if (after?.parentElement.matches('.bg-task-notes')) {
        after.parentElement.insertBefore(element, after);
      } else {
        const blocks = [...messages.children];
        const previous = blocks[after ? blocks.indexOf(after) - 1 : blocks.length - 1];
        let run = previous?.matches('.bg-task-notes') ? previous : null;
        if (!run) {
          run = node('div', 'bg-task-notes');
          run.setAttribute('role', 'note');
          messages.insertBefore(run, after || null);
        }
        run.append(element);
      }
    }
    if (pinned) scroll.scrollTop = scroll.scrollHeight;
  }
  async function refetch() {
    const sid = sessionId, version = ++revision;
    if (!sid) return;
    try {
      const data = await api(`/api/chat/background/${encodeURIComponent(sid)}`);
      if (disposed || sid !== sessionId || version !== revision) return;
      items = data.items || []; renderPill(); insertNotes(data.notes, true);
    } catch { if (sid === sessionId && version === revision) { items = []; renderPill(); } }
  }
  const packet = event => {
    const data = event.detail;
    if (!sessionId || data.sessionId !== sessionId || sessionId !== getSessionId()) return;
    revision++;
    const before = items.find(i => i.id === selected);
    items = data.items || []; renderPill(); insertNotes(data.notes, false);
    if (opened && selected && JSON.stringify(before) !== JSON.stringify(items.find(i => i.id === selected)) && !detailTimer) {
      detailTimer = setTimeout(loadDetail, Math.max(0, 1000 - (Date.now() - detailAt)));
    }
  };
  const outside = event => { if (opened && !sheet && !dock && !event.composedPath().includes(host) && !host.contains(event.target) && !event.target.closest?.('.bg-task-note')) close(); };
  const escape = event => { if (event.key === 'Escape' && opened && !event.defaultPrevented && (!dock || dock.root.contains(event.target))) { event.preventDefault(); close(); } };
  const tick = setInterval(() => {
    if (!opened || selected) return;
    for (const age of panel.querySelectorAll('[data-elapsed]')) {
      const item = items.find(i => i.id === age.dataset.elapsed); if (item) age.textContent = elapsed(item);
    }
  }, 1000);
  document.addEventListener('kairos:bg-tasks', packet); document.addEventListener('kairos:live-snapshot', refetch);
  document.addEventListener('click', outside); document.addEventListener('keydown', escape);
  return {
    toggle() { opened ? close() : open(); },
    getState: () => ({ opened, count: items.filter(active).length, available: items.length > 0 }),
    setSession(sid) { close(); sessionId = sid; items = []; seen.clear(); renderPill(); refetch(); },
    dispose() {
      disposed = true; close(); clearInterval(tick); revision++;
      document.removeEventListener('kairos:bg-tasks', packet); document.removeEventListener('kairos:live-snapshot', refetch);
      document.removeEventListener('click', outside); document.removeEventListener('keydown', escape); host.replaceChildren();
    },
  };
}

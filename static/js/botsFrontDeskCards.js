import { h, loadBotsCss } from './botsUi.js';
import { safeHttps, swipeMove, entranceDelay } from './botsFrontDeskModel.js';

const enc = encodeURIComponent;
const sharedApi = async (...args) => (await import('./api.js')).api(...args);
const text = (tag, value, className = '') => h(tag, { text: String(value ?? ''), class: className });
const KINDS = new Set(['brief', 'prep', 'reminder', 'task_link', 'suggestion', 'route', 'forge', 'make', 'chips', 'checkin', 'welcome', 'reach']);
const STATUS = { working: 'Working', needs_input: 'Needs input', ready_for_review: 'Ready for review', failed: 'Failed', resolved: 'Resolved' };

// Returns a DOM row or null. The transcript owns row.dispose() and row.release().
// api uses the shared api(path, options) contract, including JSON-encoded bodies.
export function renderFrontDeskCard(message, ctx = {}) {
  if (message?.type !== 'fd_card' || !KINDS.has(message.fd_kind)) return null;
  loadBotsCss('/static/css/bots-frontdesk.css');
  const kind = message.fd_kind, data = message.fd_data || {}, api = ctx.api || sharedApi;
  const navigate = ctx.navigate || (target => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: target })));
  const call = (path, body) => api(path, { cache: 'no-store', toast: false, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const row = h('article', { class: `fd-card fd-card-${kind}`, 'data-fd-kind': kind, 'data-fd-key': message.fd_key || message.id || '' });
  const error = h('p', { class: 'fd-card-error', role: 'alert', hidden: true });
  const cleanups = []; let disposed = false, busy = false;
  function button(label, action, primary = false) {
    return h('button', { type: 'button', class: `bots-btn${primary ? ' primary' : ''}`, text: label, onclick: () => perform(action) });
  }
  async function perform(action) {
    if (busy || disposed) return;
    busy = true; error.hidden = true;
    const buttons = [...row.querySelectorAll('button')], before = buttons.map(b => b.disabled);
    buttons.forEach(b => { b.disabled = true; }); row.setAttribute('aria-busy', 'true');
    try { await action(); }
    catch (problem) { if (!disposed) { error.textContent = problem?.message || 'Could not finish. Try again.'; error.hidden = false; } }
    finally { busy = false; if (!disposed) { buttons.forEach((b, i) => { b.disabled = row.dataset.answered === 'true' || before[i]; }); row.removeAttribute('aria-busy'); } }
  }
  function link(label, url) {
    const href = safeHttps(url);
    return href ? h('a', { class: 'bots-btn', text: label, href, target: '_blank', rel: 'noopener noreferrer' }) : null;
  }
  function openThread(arg) {
    const sid = typeof arg === 'string' ? arg : arg?.thread_id || arg?.session_id;
    if (!sid) return;
    return navigate({ tab: 'botsShell', agentId: arg?.bot_id || ctx.agent?.id || ctx.agentId, sessionId: sid });
  }
  async function openTask(id) {
    if (ctx.openTask) return ctx.openTask(id);
    // U2 owns the task sheet. Until merged, the actual task conversation still opens.
    const task = await call(`/api/front-desk/tasks/${enc(id)}`);
    const record = task.task || task;
    return openThread(record.thread_id);
  }
  function title(value) { row.append(text('h3', value)); }
  function actions(children) { const node = h('div', { class: 'fd-card-actions' }, children); row.append(node); return node; }
  const changed = () => { ctx.onWorkChanged?.(); document.dispatchEvent(new CustomEvent('kairos:frontdesk-work')); };

  if (kind === 'brief') {
    row.append(text('p', data.date_label, 'fd-caption'), text('h2', data.greeting || 'Your brief'));
    if (data.morning_line) row.append(text('p', data.morning_line));
    const empty = { needs: 'Nothing needs you right now.', day: 'No more meetings today.', mail: 'No important emails.', routines: 'No routine updates.', ideas: 'No new ideas.' };
    const order = ['needs', 'day', 'mail', 'routines', 'ideas'];
    const sections = [...(Array.isArray(data.sections) ? data.sections : [])].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    for (const section of sections) {
      const group = h('section', { class: 'fd-brief-section', 'data-section': section.id }, [text('h3', section.label || section.id)]);
      const rows = Array.isArray(section.rows) ? section.rows.slice(0, 6) : [];
      if (!rows.length) group.append(text('p', empty[section.id] || 'Nothing new.', 'fd-caption'));
      for (const item of rows) {
        const line = h('div', { class: 'fd-brief-row' }, [text('p', item.text), ...(item.note ? [text('p', item.note, 'fd-caption')] : [])]);
        const controls = h('div', { class: 'fd-card-actions' });
        for (const action of (Array.isArray(item.actions) ? item.actions : []).slice(0, 6)) {
          let control;
          const label = action.label || { dismiss: 'Dismiss', draft: 'Draft a reply', start: 'Start', open_thread: 'Open conversation', open_url: 'Open' }[action.kind];
          if (action.kind === 'open_url') control = link(label, action.arg);
          else if (action.kind === 'open_thread') control = button(label, () => openThread(action.arg));
          else if (action.kind === 'dismiss' || action.kind === 'draft') control = button(label, async () => {
            const result = await call(`/api/front-desk/brief/rows/${enc(item.id)}/${action.kind}`, {});
            if (disposed) return;
            if (action.kind === 'dismiss') { line.remove(); if (!group.querySelector('.fd-brief-row')) group.append(text('p', empty[section.id] || 'Nothing new.', 'fd-caption')); }
            else { controls.replaceChildren(text('span', 'Started', 'fd-answer')); if (result?.thread_id || result?.open_thread_id) openThread(result.thread_id || result.open_thread_id); }
            changed();
          });
          else if (action.kind === 'start' && action.arg) control = button(label, async () => { await call(`/api/front-desk/suggestions/${enc(action.arg)}/start`, {}); if (!disposed) controls.replaceChildren(text('span', 'Started', 'fd-answer')); changed(); }, true);
          if (control) controls.append(control);
        }
        line.append(controls); group.append(line);
      }
      if (Number(section.more) > 0) group.append(text('p', `${Math.floor(section.more)} more`, 'fd-caption'));
      row.append(group);
    }
    if (!sections.length) row.append(text('p', 'Nothing new needs you right now.', 'fd-caption'));
  } else if (kind === 'prep' || kind === 'reminder') {
    title(kind === 'prep' ? `Prep: ${data.title || 'Meeting'}` : data.title || 'Meeting soon');
    row.append(text('p', [data.when_label, data.location].filter(Boolean).join(' · '), 'fd-caption'));
    for (const line of (Array.isArray(data.lines) ? data.lines : []).slice(0, 60)) row.append(text('p', line));
    actions([link('Join', data.join_url)]);
  } else if (kind === 'suggestion') {
    row.dataset.status = message.fd_status || 'open';
    row.append(text('p', `${ctx.agent?.name || 'Kip'} could help`, 'fd-caption'), text('h3', data.title), text('p', data.detail));
    if (data.source_label) row.append(text('p', data.source_label, 'fd-caption'));
    const controls = actions([]);
    const answer = async action => {
      if (row.dataset.status !== 'open') return;
      await call(`/api/front-desk/suggestions/${enc(data.suggestion_id)}/${action}`, {});
      if (disposed) return;
      row.dataset.status = action === 'start' ? 'started' : 'hidden';
      controls.replaceChildren(text('span', action === 'start' ? 'Started' : 'Hidden', 'fd-answer'));
      row.style.removeProperty('--fd-drag'); row.style.removeProperty('--fd-tilt');
      changed();
    };
    if (row.dataset.status === 'open') {
      controls.append(button('Hide', () => answer('hide')), button('Start', () => answer('start'), true));
      cleanups.push(attachSuggestionSwipe(row, action => perform(() => answer(action))));
    } else controls.append(text('span', row.dataset.status === 'started' ? 'Started' : 'Hidden', 'fd-answer'));
  } else if (kind === 'task_link' || kind === 'make') {
    const status = text('span', 'Just started', 'fd-caption');
    const open = button(kind === 'make' ? `Making ${data.kind || 'something for you'}` : 'Open task', () => openTask(data.task_id));
    row.append(open, status);
    // Status is a read model, never a saved card field. The parent can supply one shared snapshot.
    let timer, revision = 0;
    const refresh = async work => {
      const request = ++revision; clearTimeout(timer);
      try {
        work ||= await call('/api/front-desk/work');
        if (disposed || request !== revision) return;
        for (const [state, tasks] of Object.entries(work.groups || {})) {
          const task = tasks.find(t => t.id === data.task_id);
          if (task) { open.textContent = task.title || open.textContent; status.textContent = STATUS[state] || state; row.dataset.status = state; break; }
        }
        if (row.dataset.status === 'working') timer = setTimeout(() => refresh(), 3000);
      } catch { if (!disposed) status.textContent = 'Open task for an update'; }
    };
    row.refresh = refresh; refresh(ctx.work); cleanups.push(() => clearTimeout(timer));
  } else if (kind === 'route') {
    row.append(button(`Passed to ${data.bot_name || 'bot'}`, () => navigate({ tab: 'botsShell', agentId: data.bot_id, cardId: data.card_id })));
  } else if (kind === 'forge') {
    title(data.project_name || 'Forge'); row.append(text('p', data.task));
    let created;
    actions([button('Start', async () => {
      // Retain a successful creation if navigation fails, so retry cannot create a second session.
      created ||= await call('/api/forge/sessions', { project_id: data.project_id, task: data.task });
      const sid = created?.id || created?.session?.id;
      if (!sid) throw new Error('Could not open the new session.');
      if (!disposed) await navigate({ tab: 'forge', sessionId: sid });
    }, true)]);
  } else if (kind === 'chips') {
    let sent = false;
    const current = ctx.isLatestTurn === true && !ctx.pending && !ctx.firstDay;
    for (const option of (Array.isArray(data.options) ? data.options : []).slice(0, 4)) {
      const words = String(option).slice(0, 400);
      const chip = button(words, async () => {
        if (sent || !current) return;
        if (ctx.send) await ctx.send(words);
        else {
          if (!ctx.sessionId) throw new Error('Open this conversation to reply.');
          const state = await call(`/api/bot-chat/${enc(ctx.sessionId)}/state`);
          await call(`/api/bot-chat/${enc(ctx.sessionId)}/send`, { text: words, send_id: crypto.randomUUID(), expected_leaf_id: state.active_leaf_id ?? null, expected_revision: state.branch_revision ?? 0 });
        }
        sent = true; row.dataset.answered = 'true'; chip.setAttribute('aria-pressed', 'true');
      });
      chip.disabled = !current; row.append(chip);
    }
  } else if (kind === 'checkin') {
    const at = typeof data.at === 'number' ? new Date(data.at < 1e12 ? data.at * 1000 : data.at) : new Date(data.at);
    row.append(text('p', [data.summary || 'Checked for you', Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · '), 'fd-caption'));
  } else if (kind === 'welcome') {
    title(data.title || `Hi, I am ${ctx.agent?.name || 'Kip'}.`);
    row.append(text('p', data.text || data.greeting || 'Tell me what you need a hand with.'));
    const lines = data.lines || ['I can help with your day.', 'I can take on a task.', 'I can pass work to another bot.'];
    for (const line of (Array.isArray(lines) ? lines : []).slice(0, 3)) row.append(text('p', line));
  } else if (kind === 'reach') {
    title('What I can reach');
    const connected = data.connected || data;
    for (const [key, label] of [['mail', 'Mail'], ['calendar', 'Calendar'], ['forge_projects', 'Forge projects']]) {
      const value = connected[key], ready = Array.isArray(value) ? value.length > 0 : !!value;
      row.append(text('p', `${label}: ${ready ? 'Connected' : 'Not connected'}`, 'fd-caption'));
    }
    actions([button('Connections', () => navigate({ tab: 'settings', section: 'connections' }))]);
  }
  row.append(error);
  const delay = entranceDelay(ctx.index || 0, ctx.count || 1, { history: ctx.history !== false, firstDay: !!ctx.firstDay });
  if (delay !== null) { row.classList.add('fd-build'); row.style.setProperty('--fd-delay', `${delay}ms`); }
  // Cards offered during a live answer wait behind a quiet line until the transcript releases them.
  if (ctx.streaming && ctx.history === false && ['make', 'task_link', 'forge', 'suggestion'].includes(kind)) {
    row.hidden = true;
    row.placeholder = text('p', 'Getting this ready', 'fd-caption');
  }
  row.release = () => { row.hidden = false; row.placeholder?.remove(); };
  row.dispose = () => { disposed = true; for (const off of cleanups) off(); row.placeholder?.remove(); };
  return row;
}

export function attachSuggestionSwipe(row, answer) {
  let start = null, axis = '';
  const clear = () => { start = null; axis = ''; row.style.removeProperty('--fd-drag'); row.style.removeProperty('--fd-tilt'); delete row.dataset.swipe; };
  const down = event => {
    if (event.pointerType === 'mouse' || event.isPrimary === false || row.dataset.status !== 'open' || event.target.closest('button, a, input, textarea')) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId }; axis = '';
  };
  const move = event => {
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    const state = swipeMove({ dx, dy, width: row.getBoundingClientRect().width, locked: axis }); axis = state.axis;
    if (axis !== 'horizontal') return;
    event.preventDefault();
    if (!row.hasPointerCapture?.(event.pointerId)) { try { row.setPointerCapture?.(event.pointerId); } catch {} }
    row.style.setProperty('--fd-drag', `${dx}px`); row.style.setProperty('--fd-tilt', `${Math.max(-4, Math.min(4, dx / 80))}deg`);
    row.dataset.swipe = dx > 0 ? 'start' : 'hide';
  };
  const up = event => {
    if (!start || start.id !== event.pointerId) return;
    const state = swipeMove({ dx: event.clientX - start.x, dy: event.clientY - start.y, width: row.getBoundingClientRect().width, locked: axis });
    clear(); if (state.action) answer(state.action);
  };
  row.addEventListener('pointerdown', down); row.addEventListener('pointermove', move); row.addEventListener('pointerup', up); row.addEventListener('pointercancel', clear);
  return () => { clear(); row.removeEventListener('pointerdown', down); row.removeEventListener('pointermove', move); row.removeEventListener('pointerup', up); row.removeEventListener('pointercancel', clear); };
}

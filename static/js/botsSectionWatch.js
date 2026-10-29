// Front-desk watch card. All writes are person actions through the shared API.
import { h, loadBotsCss } from './botsUi.js';

export const stateLabel = value => ({ working: 'Watching your day', paused: 'Paused', off: 'Off',
  not_connected: 'Connect mail or calendar' }[value] || 'Could not read the watch');
export const validMorningTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value));
export const showMeOutcome = (value, elapsed = 0) => value === 'error' ? 'Could not check just now. Try again.' :
  value === 'NOTHING NEW' || elapsed >= 180000 ? 'Nothing new right now. I will keep checking.' :
    value === 'Updated your brief' ? 'Your brief is up to date.' : 'Checking your day';

export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-watch.css');
  const controller = new AbortController();
  let disposed = false, generation = 0, data = null, busy = false, poll = null, checkingSince = null;
  const root = h('section', { class: 'bots-watch', 'aria-label': 'Keep an eye on my day' });
  const heading = h('h3', { text: 'Keep an eye on my day' });
  const label = h('p', { class: 'bots-watch-state', text: 'Loading watch' });
  const detail = h('p', { class: 'bots-watch-detail' });
  const feedback = h('p', { class: 'bots-watch-feedback', role: 'status', 'aria-live': 'polite' });
  const toggle = h('button', { type: 'button', 'data-action': 'toggle' });
  const show = h('button', { type: 'button', 'data-action': 'show', text: 'Show me' });
  const routines = h('button', { type: 'button', text: 'Routines', onclick: () => ctx.navigate?.('botsShell', {
    agentId: ctx.agentId || ctx.agent?.id, section: 'routines' }) });
  const on = h('input', { type: 'checkbox', 'aria-label': 'Morning brief' });
  const at = h('input', { type: 'time', 'aria-label': 'Morning time', required: true });
  const save = h('button', { type: 'submit', text: 'Save time' });
  const form = h('form', { class: 'bots-watch-morning' }, [h('label', {}, [on, h('span', { text: 'Morning brief' })]), at, save]);
  const controls = h('div', { class: 'bots-watch-actions' }, [toggle, show, routines]);
  root.append(heading, label, detail, controls, form, feedback);
  host.append(root);
  const request = async (path, options = {}) => {
    const client = ctx.api || (await import('./api.js')).api;
    return client(path, { ...options, signal: controller.signal, toast: false });
  };
  const write = (path, method, body) => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  function paint() {
    if (disposed || !data) return;
    label.textContent = stateLabel(data.state);
    const last = data.last_check_at ? new Date(data.last_check_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not checked yet';
    detail.textContent = [last, data.last_result === 'NOTHING NEW' ? 'Nothing new' : data.last_result,
      data.edited ? 'You edited this routine' : '', data.available === false ? 'Routines are not available yet' : ''].filter(Boolean).join(' · ');
    toggle.textContent = data.enabled ? 'Pause' : 'Resume';
    toggle.hidden = !data.routine_id;
    toggle.disabled = busy || data.available === false;
    show.disabled = busy || !data.routine_id || data.available === false;
    routines.hidden = !ctx.navigate;
    // Do not reset the person's time input during a background poll.
    if (!form.contains(document.activeElement)) {
      on.checked = data.morning?.on !== false;
      at.value = data.morning?.time || '08:00';
    }
    at.disabled = save.disabled = on.disabled = busy;
  }

  async function refresh() {
    const own = ++generation;
    try {
      const result = await request('/api/front-desk/watch');
      if (disposed || own !== generation) return;
      data = result;
      paint();
      if (checkingSince !== null) {
        const elapsed = Date.now() - checkingSince;
        // A previous occurrence's result cannot finish this poll.
        const fresh = data.last_check_at && data.last_check_at * 1000 >= checkingSince - 1000;
        feedback.textContent = showMeOutcome(fresh ? data.last_result : null, elapsed);
        if ((fresh && data.last_result) || elapsed >= 180000) {
          checkingSince = null;
          clearTimeout(poll);
          ctx.refresh?.();
        } else {
          clearTimeout(poll);
          poll = setTimeout(refresh, 3000);
        }
      }
    } catch (error) {
      if (disposed || own !== generation) return;
      label.textContent = data ? stateLabel(data.state) : 'Could not read the watch';
      feedback.textContent = checkingSince !== null ? showMeOutcome('error') : 'Could not load the watch. Try again.';
      checkingSince = null;
    }
  }

  async function action(fn) {
    if (busy || disposed) return;
    busy = true;
    paint();
    try {
      await fn();
      if (!disposed) await refresh();
    } catch (error) {
      if (!disposed) feedback.textContent = error.message || 'Could not save. Try again.';
    } finally {
      busy = false;
      paint();
    }
  }
  toggle.addEventListener('click', () => action(() => write(`/api/bot-routines/${encodeURIComponent(data.routine_id)}`, 'PATCH', {
    enabled: !data.enabled, expected_revision: data.revision,
  })));
  show.addEventListener('click', () => action(async () => {
    checkingSince = Date.now();
    feedback.textContent = showMeOutcome(null);
    try { await write('/api/front-desk/watch/run-now', 'POST'); }
    catch (error) { checkingSince = null; throw error; }
  }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    at.setAttribute('aria-invalid', String(!validMorningTime(at.value)));
    if (!validMorningTime(at.value)) { feedback.textContent = 'Choose a valid morning time.'; at.focus(); return; }
    action(async () => {
      await write('/api/front-desk/watch/settings', 'PATCH', { morning_on: on.checked, morning_time: at.value });
      feedback.textContent = 'Morning time saved';
    });
  });
  ctx.signal?.addEventListener('abort', dispose, { once: true });
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    clearTimeout(poll);
    controller.abort();
    root.remove();
  }
  if (ctx.signal?.aborted) dispose(); else refresh();
  return { dispose, refresh };
}

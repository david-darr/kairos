import { h, loadBotsCss } from './botsUi.js';
import { MAKE_KINDS, makeKind, makeItems, makeEmpty, starterSelection, safeMakeThumb, makeTarget } from './botsMakeModel.js';

const sharedApi = async (...args) => (await import('./api.js')).api(...args);

export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-frontdesk.css');
  const api = ctx.api || sharedApi;
  const call = (path, body) => api(path, { cache: 'no-store', toast: false, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const navigate = ctx.navigate || (target => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: target })));
  let kind = 'all', disposed = false, version = 0, poll, fanOpen = false, sheet = null, viewer = null;
  const viewers = new Map();
  const filters = h('div', { class: 'fd-make-filters', role: 'group', 'aria-label': 'What to show' });
  const grid = h('div', { class: 'fd-make-grid', 'aria-label': 'Made for you' });
  const notice = h('p', { class: 'fd-caption', role: 'status' });
  const plus = h('button', { type: 'button', class: 'bots-btn primary fd-make-plus', text: '+', 'aria-label': 'Choose what to make', 'aria-expanded': 'false', 'aria-haspopup': 'menu', onclick: () => setFan(!fanOpen) });
  const scrim = h('button', { type: 'button', class: 'fd-make-veil', 'aria-label': 'Close choices', tabindex: '-1', hidden: true, onclick: () => setFan(false) });
  const fan = h('div', { class: 'fd-make-fan', role: 'menu', 'aria-label': 'Make something', hidden: true });
  for (const [index, item] of MAKE_KINDS.filter(k => k.id !== 'all').entries()) {
    const button = h('button', { type: 'button', class: 'bots-btn', role: 'menuitem', text: item.label, onclick: () => { setFan(false, false); openNewTask(item); } });
    button.style.setProperty('--fd-delay', `calc(var(--bots-dur-tap) * ${index} / 3)`); fan.append(button);
  }
  const root = h('div', { class: 'fd-make' }, [h('h2', { text: 'Make' }), h('p', { class: 'fd-caption', text: `What ${ctx.agent?.name || 'Kip'} made for you.` }), filters, notice, grid, scrim, fan, plus]);
  host.replaceChildren(root);
  for (const item of MAKE_KINDS) filters.append(h('button', { type: 'button', class: 'bots-btn', text: item.label, 'data-make-filter': item.id,
    'aria-pressed': String(item.id === kind), onclick: () => { kind = makeKind(item.id); filters.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.makeFilter === kind))); refresh(); } }));

  function setFan(open, restoreFocus = true) {
    fanOpen = open; fan.hidden = !open; scrim.hidden = !open;
    plus.setAttribute('aria-expanded', String(open)); plus.textContent = open ? '×' : '+';
    if (open) fan.querySelector('button')?.focus(); else if (restoreFocus) plus.focus();
  }
  const onKey = event => {
    if (!fanOpen || sheet || viewer) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFan(false); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) {
      event.preventDefault(); const items = [...fan.querySelectorAll('button'), plus], index = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' || event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    }
  };
  root.addEventListener('keydown', onKey);

  async function openItem(item, opener) {
    const target = makeTarget(item); if (!target) return;
    if (ctx.openItem) return ctx.openItem(target, opener);
    if (target.tab === 'design') return navigate(target);
    return openFile(target, opener);
  }
  function closeViewer() {
    if (!viewer) return;
    const current = viewer; viewer = null;
    for (const entry of viewers.values()) entry.controller.abort(); viewers.clear();
    current.node.close(); current.node.remove(); if (current.opener?.isConnected) current.opener.focus();
  }
  async function openFile(target, opener) {
    if (!viewer) {
      const node = h('dialog', { class: 'fd-viewer', 'aria-label': 'Files' });
      const tabs = h('div', { class: 'fd-file-tabs', role: 'tablist', 'aria-label': 'Open files' });
      const content = h('div', { class: 'fd-file-panes' });
      node.append(h('button', { type: 'button', class: 'bots-btn', text: 'Close files', onclick: closeViewer }), tabs, content);
      node.addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
      root.append(node); node.showModal(); viewer = { node, tabs, content, opener };
    }
    const key = `${target.sessionId}:${target.url}`;
    const activate = () => {
      for (const [id, entry] of viewers) { entry.pane.hidden = id !== key; entry.button.setAttribute('aria-selected', String(id === key)); entry.button.tabIndex = id === key ? 0 : -1; }
    };
    if (viewers.has(key)) { activate(); return; }
    const paneId = `fd-file-${viewers.size + 1}`;
    const button = h('button', { type: 'button', role: 'tab', class: 'bots-btn', text: target.title, 'aria-controls': paneId, onclick: activate });
    const detail = h('span', { class: 'fd-caption' }), actions = h('div', { class: 'fd-card-actions' }), content = h('div', { class: 'artifact-preview' });
    const pane = h('section', { role: 'tabpanel', id: paneId }, [detail, actions, content]);
    const entry = { button, pane, controller: new AbortController() }; viewers.set(key, entry);
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const entries = [...viewers.values()], i = entries.indexOf(entry);
      entries[event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + entries.length) % entries.length].button.click();
      [...viewers.values()].find(v => v.button.getAttribute('aria-selected') === 'true')?.button.focus();
    });
    viewer.tabs.append(button); viewer.content.append(pane); activate(); button.focus();
    try {
      const { renderArtifact } = await import('./artifactViewer.js');
      if (entry.controller.signal.aborted) return;
      await renderArtifact({ sessionId: target.sessionId, url: target.url, controller: entry.controller, content, actions, detail,
        onError: () => { if (!entry.controller.signal.aborted) content.replaceChildren(h('p', { text: 'Could not open this file.' })); } });
    } catch { if (!entry.controller.signal.aborted) content.replaceChildren(h('p', { role: 'alert', text: 'Could not open this file.' })); }
  }

  function openNewTask(item) {
    if (ctx.openNewTask) { ctx.openNewTask({ kind: 'make', make_kind: item.id, starter: item.starter, opener: plus }); return; }
    // U2 can supply its sheet through openNewTask. This local form speaks the
    // frozen POST /tasks contract and remains usable before that unit merges.
    if (sheet) return;
    const dialog = h('dialog', { class: 'fd-newtask', 'aria-label': `What should ${ctx.agent?.name || 'Kip'} make?` });
    const input = h('textarea', { maxlength: '4000', rows: '5', 'aria-label': 'Describe what to make' }); input.value = item.starter;
    const feedback = h('p', { class: 'fd-card-error', role: 'alert', hidden: true });
    const save = h('button', { type: 'button', class: 'bots-btn', text: 'Save for Up next', disabled: true });
    const start = h('button', { type: 'button', class: 'bots-btn primary', text: 'Start now', disabled: true });
    const close = () => { if (sheet === dialog) sheet = null; dialog.close(); dialog.remove(); if (!disposed) plus.focus(); };
    const closeButton = h('button', { type: 'button', class: 'bots-btn', text: 'Close', onclick: close });
    let sending = false, sendId = crypto.randomUUID();
    const valid = () => input.value.trim().length > 0 && input.value.trim() !== item.starter && !input.value.includes('...') && input.value.length <= 4000;
    const update = () => { save.disabled = start.disabled = sending || !valid(); };
    input.addEventListener('input', update);
    const submit = async later => {
      if (sending || !valid()) return;
      sending = true; update(); closeButton.disabled = true; feedback.hidden = true;
      try {
        await call('/api/front-desk/tasks', { text: input.value.trim(), kind: 'make', make_kind: item.id, save_for_later: later, send_id: sendId });
        sendId = crypto.randomUUID();
        if (!disposed && sheet === dialog) { close(); refresh(); document.dispatchEvent(new CustomEvent('kairos:frontdesk-work')); }
      } catch (error) { if (!disposed && sheet === dialog) { feedback.textContent = error.message || 'Could not start. Try again.'; feedback.hidden = false; } }
      finally { sending = false; closeButton.disabled = false; update(); }
    };
    save.addEventListener('click', () => submit(true)); start.addEventListener('click', () => submit(false));
    dialog.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(false); } });
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!sending) close(); });
    dialog.append(h('h2', { text: `What should ${ctx.agent?.name || 'Kip'} make?` }), closeButton, input, feedback, h('div', { class: 'fd-card-actions' }, [save, start]));
    root.append(dialog); sheet = dialog; dialog.showModal(); input.focus(); input.setSelectionRange(...starterSelection(item.starter));
  }

  async function refresh() {
    const request = ++version; clearTimeout(poll); notice.textContent = grid.children.length ? '' : 'Loading';
    try {
      const result = await call(`/api/front-desk/make?kind=${encodeURIComponent(kind)}`);
      if (disposed || request !== version) return;
      const children = [];
      for (const task of result.making || []) {
        if (kind !== 'all' && task.make_kind !== kind) continue;
        children.push(h('div', { class: 'fd-making', 'data-task-id': task.id }, [h('div', { class: 'fd-make-thumb', 'aria-hidden': 'true' }),
          h('h3', { text: task.title || 'Making something for you' }), h('p', { class: 'fd-caption', text: task.state === 'needs_input' ? 'Needs input' : 'Working' })]));
      }
      for (const item of makeItems(result.items || [], kind)) {
        const target = makeTarget(item), thumb = safeMakeThumb(item.thumb_url);
        const button = h('button', { type: 'button', class: 'fd-made', 'data-make-id': item.id, disabled: !target, onclick: () => openItem(item, button).catch(error => { notice.textContent = error.message || 'Could not open this item.'; }) }, [
          thumb ? h('img', { class: 'fd-make-thumb', src: thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'fd-make-thumb', 'aria-hidden': 'true', text: MAKE_KINDS.find(k => k.id === item.kind)?.label || 'File' }),
          h('h3', { text: String(item.title || 'Untitled') }), h('span', { class: 'fd-caption', text: MAKE_KINDS.find(k => k.id === item.kind)?.label || 'File' })]);
        if (thumb) button.querySelector('img').addEventListener('error', event => { event.target.replaceWith(h('div', { class: 'fd-make-thumb', text: 'Preview unavailable' })); }, { once: true });
        children.push(button);
      }
      grid.replaceChildren(...children); notice.textContent = children.length ? '' : makeEmpty(kind);
      if (result.making?.length) poll = setTimeout(refresh, 3000);
    } catch { if (!disposed && request === version) { notice.textContent = 'Could not load Make.'; const retry = h('button', { type: 'button', class: 'bots-btn', text: 'Try again', onclick: refresh }); grid.replaceChildren(retry); } }
  }
  const onChange = () => refresh(); document.addEventListener('kairos:design-changed', onChange); document.addEventListener('kairos:frontdesk-work', onChange);
  refresh();
  return { refresh, dispose() { disposed = true; ++version; clearTimeout(poll); document.removeEventListener('kairos:design-changed', onChange); document.removeEventListener('kairos:frontdesk-work', onChange); sheet?.close(); sheet?.remove(); sheet = null; closeViewer(); root.remove(); } };
}

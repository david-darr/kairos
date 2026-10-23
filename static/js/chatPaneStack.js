import { el } from './api.js';
import { createPaneState } from './chatPaneState.js';
import { holdReadingPositions } from './chatScrollAnchor.js';

let user = 'local';
export function setPaneUser(value) {
  user = String(value || 'local');
  // Carry forward this device's pre-account artifact width on first use.
  try {
    const key = paneStorageKey('kairos:chat-pane-width'), legacy = localStorage.getItem('kairos:chat-pane-width');
    if (localStorage.getItem(key) == null && Number(legacy) >= 380) localStorage.setItem(key, legacy);
  } catch { /* Optional storage. */ }
}
export const paneStorageKey = base => user === 'local' ? base : `${base}:${user}`;
export const desktopPanes = host => !!host && window.innerWidth > 1100 && !!host.closest('.kairos-redesign') && !host.classList.contains('forge-conversation');
const stacks = new WeakMap();
const changed = () => document.dispatchEvent(new CustomEvent('kairos:chat-panes'));
export function paneIsOpen(host, kind) { return !!stacks.get(host)?.entries.some(e => e.kind === kind); }
export function closePaneKind(host, kind) { stacks.get(host)?.entries.find(e => e.kind === kind)?.close(); }
export function disposeChatPanes(host) { for (const e of [...(stacks.get(host)?.entries || [])]) e.close(); }
const move = (parent, node) => parent.moveBefore && node.isConnected ? parent.moveBefore(node, null) : parent.append(node);

export function mountStackedPane(host, panel, close, options, mount) {
  let stack = stacks.get(host);
  if (!stack) {
    const root = el('aside', { class: 'artifact-panel chat-pane-stack', 'aria-label': 'Side panes' });
    const entries = [], state = createPaneState(localStorage, paneStorageKey('kairos:chat-pane-split'));
    stack = { root, entries, state, expanded: null };
    stacks.set(host, stack);
    stack.layout = mount(host, root, () => { for (const e of [...entries]) e.close(); }, {
      sharedRoot: true, onDrag: value => entries.forEach(e => e.onDrag?.(value)),
    });
    root.addEventListener('pane-maximize', event => {
      if (event.detail || !stack.expanded) return;
      const previous = stack.expanded; stack.expanded = null; paintStack(stack);
      previous.panel.dispatchEvent(new CustomEvent('pane-maximize', { detail: false }));
    });
    stack.escape = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (stack.expanded) { event.preventDefault(); event.stopImmediatePropagation(); stack.expanded.layout.setMaximized(false); }
    };
    document.addEventListener('keydown', stack.escape, true);
    stack.breakpoint = () => {
      if (window.innerWidth > 1100) return;
      stack.expanded = null;
      // Existing documents/computer become their usual overlay at narrow
      // widths. New Design/task openings use the phone's original UI.
      for (const e of [...entries]) if (['design', 'background'].includes(e.kind)) e.close();
      if (entries.length) paintStack(stack);
    };
    window.addEventListener('resize', stack.breakpoint);
  }
  // Documents, files, native browser and computer retain their exclusivity.
  const kind = options.kind || 'documents';
  const exclusive = value => !['design', 'background'].includes(value);
  for (const entry of [...stack.entries]) if (entry.kind === kind || (exclusive(entry.kind) && exclusive(kind))) entry.close();
  // Replacing the final exclusive entry may have disposed this root.
  if (!stacks.has(host)) return mountStackedPane(host, panel, close, options, mount);
  holdReadingPositions();
  const artifactClass = panel.classList.contains('artifact-panel');
  panel.classList.remove('artifact-panel');
  panel.dataset.paneKind = kind;
  panel.classList.add('chat-stacked-pane');
  const entry = { panel, close, kind, onDrag: options.onDrag };
  stack.entries.push(entry); stack.state.show(kind); move(stack.root, panel);
  const paint = () => paintStack(stack);
  const layout = entry.layout = {
    isMaximized: () => stack.expanded === entry,
    setMaximized(value) {
      stack.expanded = value ? entry : null;
      stack.layout.setMaximized(!!value);
      paint(); panel.dispatchEvent(new CustomEvent('pane-maximize', { detail: !!value }));
    },
    dispose() {
      if (!stack.entries.includes(entry)) return;
      holdReadingPositions();
      if (stack.expanded === entry) layout.setMaximized(false);
      stack.entries.splice(stack.entries.indexOf(entry), 1); stack.state.close(kind);
      panel.classList.remove('chat-stacked-pane'); panel.style.removeProperty('flex'); panel.hidden = false; panel.inert = false;
      if (artifactClass) panel.classList.add('artifact-panel');
      if (!stack.entries.length) {
        stack.dividers?.forEach(node => node.remove()); stack.layout.dispose(); stack.root.remove(); stacks.delete(host);
        document.removeEventListener('keydown', stack.escape, true); window.removeEventListener('resize', stack.breakpoint);
      } else paint();
      changed();
    },
  };
  paint(); changed();
  return layout;
}

function paintStack(stack) {
  stack.dividers?.forEach(node => node.remove()); stack.dividers = [];
  const visible = stack.entries.filter(e => !stack.expanded || stack.expanded === e);
  stack.entries.forEach(e => { e.panel.hidden = !visible.includes(e); e.panel.inert = e.panel.hidden; });
  const weights = visible.map((e, i) => e.weight ?? (i === 0 ? stack.state.split : (100 - stack.state.split) / (visible.length - 1)));
  if (visible.length === 2) { weights[0] = stack.state.split; weights[1] = 100 - stack.state.split; }
  const apply = () => visible.forEach((e, i) => { e.panel.style.flex = `${visible.length === 1 ? 1 : weights[i]} 1 0`; e.weight = weights[i]; });
  apply();
  if (visible.length < 2) return;
  const pairs = [];
  const syncHandles = () => pairs.forEach(({ handle, index }) => {
    const ratio = 100 * weights[index] / (weights[index] + weights[index + 1]);
    handle.setAttribute('aria-valuenow', String(Math.round(ratio)));
  });
  for (let index = 0; index < visible.length - 1; index++) {
    const pair = visible.slice(index, index + 2);
    const pairState = visible.length === 2 ? stack.state : createPaneState(localStorage, paneStorageKey(`kairos:chat-pane-split:${pair.map(e => e.kind).join(':')}`));
    const total = weights[index] + weights[index + 1];
    if (visible.length > 2) { weights[index] = total * pairState.split / 100; weights[index + 1] = total - weights[index]; apply(); }
    const handle = el('div', { class: 'chat-pane-stack-resizer', role: 'separator', tabindex: '0',
      'aria-orientation': 'horizontal', 'aria-label': 'Resize between panes', 'aria-valuemin': visible.length === 2 ? '20' : '0', 'aria-valuemax': visible.length === 2 ? '80' : '100', 'aria-valuenow': String(pairState.split) });
    stack.dividers.push(handle);
    pairs.push({ handle, index });
    visible[index].panel.after(handle);
    const resize = value => {
      pairState.resize(value); handle.setAttribute('aria-valuenow', String(pairState.split));
      const sum = weights[index] + weights[index + 1];
      weights[index] = sum * pairState.split / 100; weights[index + 1] = sum - weights[index]; apply();
      syncHandles();
    };
    let pointer = null;
    const stop = () => { pointer = null; stack.root.classList.remove('stack-dragging'); stack.entries.forEach(e => e.onDrag?.(false)); };
    handle.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); handle.focus(); pointer = e.pointerId; handle.setPointerCapture(pointer); stack.root.classList.add('stack-dragging'); stack.entries.forEach(e => e.onDrag?.(true)); });
    handle.addEventListener('pointermove', e => { if (pointer !== e.pointerId) return; const first = pair[0].panel.getBoundingClientRect(), last = pair[1].panel.getBoundingClientRect(); resize(100 * (e.clientY - first.top) / (last.bottom - first.top)); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, stop);
    handle.addEventListener('keydown', e => { if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const ratio = 100 * weights[index] / (weights[index] + weights[index + 1]); resize(e.key === 'Home' ? 20 : e.key === 'End' ? 80 : ratio + (e.key === 'ArrowDown' ? 3 : -3)); });
  }
  syncHandles();
}

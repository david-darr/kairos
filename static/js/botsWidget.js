// Draws a bot's widget card in the conversation (Phase 6 unit U2, 2026-10-29). Spec: phase-6-design.md section 5.3.
//
// DOM nodes only. Nothing a bot wrote ever reaches innerHTML: titles, text, labels, table cells and the markdown
// are all set as text nodes, a link is a real anchor only after its address is checked (https), and an image
// loads only after the person clicks it. A press goes to POST /api/bot-widgets/{sid}/press with the card's
// revision; if the card changed since, the person gets one plain line and nothing is sent. A card the person
// answered folds to one line with a Details toggle.
import { h, Button } from './botsUi.js';
import { icon } from './botsIcons.js';
import { loadBotsCss } from './botsUi.js';
import { drawChart, chartFromSeries } from './botsDataChart.js';
import { buildPress, compactLayout, foldedLine, initialValues, pressMessage, pressSummary, OTHER, ICONS, checkWidget } from './botsWidgetModel.js';

const CSS = '/static/css/bots-widgets.css';
let counter = 0;
const uid = () => `bots-w-${++counter}`;
const newSendId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `send-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// -- markdown, inertly: paragraphs, lists, bold, italic, code and http(s) links ---------------------------------------------
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]{1,2000}\)|(?<![*\w])\*[^*\n]+\*(?!\w)|(?<![_\w])_[^_\n]+_(?![_\w]))/g;
function inlineNodes(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('**')) out.push(h('strong', { text: token.slice(2, -2) }));
    else if (token.startsWith('`')) out.push(h('code', { text: token.slice(1, -1) }));
    else if (token.startsWith('[')) {
      const split = token.lastIndexOf('](');
      out.push(h('a', { href: token.slice(split + 2, -1), target: '_blank', rel: 'noopener noreferrer nofollow', text: token.slice(1, split) }));
    } else out.push(h('em', { text: token.slice(1, -1) }));
    last = match.index + token.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}
export function markdownNodes(source) {
  const frag = document.createDocumentFragment();
  const blocks = String(source ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) continue;
    if (lines.every(l => /^\s*[-*]\s+/.test(l))) frag.append(h('ul', {}, lines.map(l => h('li', {}, inlineNodes(l.replace(/^\s*[-*]\s+/, ''))))));
    else if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) frag.append(h('ol', {}, lines.map(l => h('li', {}, inlineNodes(l.replace(/^\s*\d+[.)]\s+/, ''))))));
    else if (/^#{1,6}\s/.test(lines[0])) frag.append(h('p', { class: 'bots-w-md-head' }, inlineNodes(lines[0].replace(/^#{1,6}\s+/, ''))), ...(lines.length > 1 ? [h('p', {}, lines.slice(1).flatMap((l, i) => [...(i ? [h('br')] : []), ...inlineNodes(l)]))] : []));
    else frag.append(h('p', {}, lines.flatMap((l, i) => [...(i ? [h('br')] : []), ...inlineNodes(l)])));
  }
  return frag;
}

// -- the card ----------------------------------------------------------------------------------------------------------
// message: a Bots message row ({id, widget:{rev, doc, settled}}). ctx: {agentId, sessionId, refresh?}.
export function renderWidget(message, ctx = {}) {
  loadBotsCss(CSS);
  let widget = message.widget;
  const root = h('div', { class: 'bots-widget', 'data-message-id': message.id || '' });
  const state = { values: {}, others: {}, busy: false, line: '', sendId: '', details: false };

  const checked = checkWidget(widget?.doc);
  if (!widget || !widget.doc || !checked.ok) {
    root.classList.add('is-broken');
    root.append(h('p', { class: 'bots-w-note', role: 'status', text: 'This card could not be shown.' }));
    return root;
  }
  const doc = checked.doc;
  state.values = initialValues(doc);

  let frameId = 0;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(frameId); frameId = requestAnimationFrame(() => root.classList.toggle('compact', compactLayout(root.clientWidth))); }) : null;
  observer?.observe(root);

  function draw() {
    root.dataset.state = widget.settled ? 'settled' : 'open';
    root.className = `bots-widget${widget.settled ? ' settled' : ''}${compactLayout(root.clientWidth) ? ' compact' : ''}`;
    if (widget.settled) { root.replaceChildren(folded()); return; }
    const size = doc.type === 'card' ? doc.size || 'md' : 'md';
    root.classList.add(`size-${size}`);
    const head = [];
    if (doc.title) head.push(h('h4', { class: 'bots-w-title', text: doc.title }));
    if (doc.caption) head.push(h('p', { class: 'bots-w-caption', text: doc.caption }));
    if (doc.meta) head.push(h('p', { class: 'bots-w-meta', text: doc.meta }));
    const body = doc.type === 'list' ? listBody() : (doc.children || []).map(n => node(n));
    const footer = [];
    if (doc.cancel) footer.push(Button({ label: doc.cancel.label, onClick: () => press(doc.cancel.ref), disabled: state.busy }));
    if (doc.confirm) footer.push(Button({ label: doc.confirm.label, variant: 'primary', onClick: () => press(doc.confirm.ref), disabled: state.busy }));
    root.replaceChildren(
      ...(head.length ? [h('div', { class: 'bots-w-head' }, head)] : []),
      h('div', { class: 'bots-w-body' }, body),
      doc.status ? h('p', { class: 'bots-w-status', role: 'status', text: doc.status }) : null,
      state.line ? h('p', { class: 'bots-w-line', role: 'alert', text: state.line }) : null,
      footer.length ? h('div', { class: 'bots-w-actions' }, footer) : null);
  }

  function folded() {
    const toggle = h('button', { type: 'button', class: 'bots-w-details', 'aria-expanded': state.details ? 'true' : 'false', text: 'Details' });
    toggle.addEventListener('click', () => { state.details = !state.details; draw(); });
    return h('div', { class: 'bots-w-folded' }, [
      h('div', { class: 'bots-w-folded-line' }, [icon('check', { size: 14 }), h('span', { text: foldedLine(widget) }), toggle]),
      state.details ? h('div', { class: 'bots-w-folded-details' }, [h('p', { class: 'bots-w-summary', text: widget.settled.summary || '' })]) : null]);
  }

  function listBody() {
    return [h('div', { class: 'bots-w-list', role: 'list' }, (doc.items || []).map(item => {
      const inner = [h('span', { class: 'bots-w-item-main' }, [h('span', { class: 'bots-w-item-title', text: item.title }), item.caption ? h('span', { class: 'bots-w-item-caption', text: item.caption }) : null]),
        item.meta ? h('span', { class: 'bots-w-item-meta', text: item.meta }) : null];
      const extra = (item.children || []).map(n => node(n));
      if (item.ref) {
        const row = h('button', { type: 'button', class: 'bots-w-item pressable', role: 'listitem', disabled: state.busy || undefined }, [...inner, icon('chevron-right', { size: 14 })]);
        row.addEventListener('click', () => press(item.ref));
        return h('div', { class: 'bots-w-item-wrap' }, [row, ...extra]);
      }
      return h('div', { class: 'bots-w-item-wrap' }, [h('div', { class: 'bots-w-item', role: 'listitem' }, inner), ...extra]);
    }))];
  }

  // -- parts ---------------------------------------------------------------------------------------------------------
  function node(n) {
    switch (n.type) {
      case 'Box': case 'Row': case 'Col': case 'Form':
        return h('div', { class: `bots-w-${n.type.toLowerCase()}`, 'data-gap': n.gap || 'md' }, (n.children || []).map(c => node(c)));
      case 'Text': return h('p', { class: `bots-w-text${n.tone ? ' tone-' + n.tone : ''}`, text: n.text });
      case 'Title': return h('h5', { class: 'bots-w-h5', text: n.text });
      case 'Caption': return h('p', { class: 'bots-w-caption', text: n.text });
      case 'Label': return h('span', { class: 'bots-w-label', text: n.text });
      case 'Markdown': return h('div', { class: 'bots-w-md' }, [markdownNodes(n.text)]);
      case 'Table': return table(n);
      case 'Image': return image(n);
      case 'Icon': return iconNode(n);
      case 'Chart': { const box = h('div', { class: 'bots-w-chart' }); if (n.title) box.append(h('p', { class: 'bots-w-caption', text: n.title })); drawChart(box, chartFromSeries(n), { width: 360, height: n.height || 160, mini: true, label: n.title || 'Chart' }); return box; }
      case 'Badge': return h('span', { class: `bots-w-badge tone-${n.tone || 'quiet'}`, text: n.text });
      case 'Progress': return progress(n);
      case 'Button': return buttonNode(n);
      case 'Spacer': return h('div', { class: 'bots-w-spacer', 'aria-hidden': 'true' });
      case 'Divider': return h('hr', { class: 'bots-w-divider' });
      default: return field(n);
    }
  }
  function table(n) {
    return h('div', { class: 'bots-w-table-wrap' }, [h('table', { class: 'bots-w-table' }, [
      h('thead', {}, [h('tr', {}, n.columns.map(c => h('th', { scope: 'col', text: c })))]),
      h('tbody', {}, n.rows.map(r => h('tr', {}, n.columns.map((_, i) => h('td', { text: r[i] ?? '' })))))])]);
  }
  function image(n) {
    let host = '';
    try { host = new URL(n.url).hostname; } catch { /* checked by the model */ }
    const slot = h('div', { class: 'bots-w-image' });
    const load = h('button', { type: 'button', class: 'bots-w-image-load' }, [icon('image', { size: 16 }), h('span', { text: `Show image from ${host}` })]);
    load.addEventListener('click', () => {
      const img = h('img', { alt: n.alt || '', referrerpolicy: 'no-referrer', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => slot.replaceChildren(h('span', { class: 'bots-w-note', text: 'The image could not load.' })));
      img.src = n.url;
      slot.replaceChildren(img);
    });
    slot.append(load);
    return slot;
  }
  function iconNode(n) {
    if (!ICONS.includes(n.name)) return h('span', { class: 'bots-w-icon' });
    try { return h('span', { class: 'bots-w-icon' }, [icon(n.name, { size: 16 })]); } catch { return h('span', { class: 'bots-w-icon' }); }
  }
  function progress(n) {
    const bar = h('div', { class: 'bots-w-progress-fill' });
    bar.style.width = `${Math.max(0, Math.min(100, n.value))}%`;
    const track = h('div', { class: 'bots-w-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(n.value), 'aria-label': n.label || 'Progress' }, [bar]);
    return h('div', { class: 'bots-w-progress-wrap' }, [n.label ? h('span', { class: 'bots-w-label', text: n.label }) : null, track]);
  }
  function buttonNode(n) {
    const b = h('button', { type: 'button', class: `bots-btn bots-w-button${n.tone === 'primary' ? ' primary' : n.tone === 'danger' ? ' danger' : ''}`, disabled: state.busy || undefined }, [
      n.action?.type === 'open_url' ? icon('external-link', { size: 14 }) : null, n.label]);
    b.addEventListener('click', () => {
      if (n.action?.type === 'open_url') { if (/^https:\/\//i.test(n.action.url)) window.open(n.action.url, '_blank', 'noopener,noreferrer'); return; }
      if (n.action?.type === 'open_thread') { document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'botsShell', agentId: ctx.agentId, sessionId: n.action.thread_id } })); return; }
      press(n.ref);
    });
    return b;
  }

  // -- fields ---------------------------------------------------------------------------------------------------------
  function field(n) {
    const id = uid();
    const label = h('label', { class: 'bots-w-field-label', for: id, text: n.label });
    const set = value => { state.values[n.id] = value; };
    let control;
    if (n.type === 'Checkbox') {
      control = h('input', { type: 'checkbox', id });
      control.checked = !!state.values[n.id];
      control.addEventListener('change', () => set(control.checked));
      return h('div', { class: 'bots-w-field check' }, [control, label]);
    }
    if (n.type === 'Input' || n.type === 'Textarea') {
      control = h(n.type === 'Input' ? 'input' : 'textarea', { id, placeholder: n.placeholder || '', ...(n.type === 'Input' ? { type: n.input_type || 'text', autocomplete: 'off' } : { rows: String(n.rows || 3) }) });
      control.value = state.values[n.id] ?? '';
      control.addEventListener('input', () => set(control.value));
    } else if (n.type === 'Date' || n.type === 'Time') {
      control = h('input', { id, type: n.type === 'Date' ? 'date' : 'time' });
      control.value = state.values[n.id] ?? '';
      control.addEventListener('input', () => set(control.value));
    } else if (n.type === 'Weekday') {
      const days = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
      control = h('select', { id }, [h('option', { value: '', text: 'Choose a day' }), ...days.map(([v, t]) => h('option', { value: v, text: t }))]);
      control.value = state.values[n.id] ?? '';
      control.addEventListener('change', () => set(control.value));
    } else if (n.type === 'Select') {
      control = h('select', { id }, [h('option', { value: '', text: 'Choose one' }), ...n.options.map(o => h('option', { value: o.value, text: o.label })), ...(n.other ? [h('option', { value: OTHER, text: 'Other' })] : [])]);
      control.value = state.values[n.id] ?? '';
      const other = h('input', { type: 'text', class: 'bots-w-other', placeholder: 'Write your answer', 'aria-label': `${n.label}, other`, hidden: true });
      other.value = state.others[n.id] || '';
      other.hidden = state.values[n.id] !== OTHER;
      control.addEventListener('change', () => { set(control.value); other.hidden = control.value !== OTHER; if (!other.hidden) other.focus(); });
      other.addEventListener('input', () => { state.others[n.id] = other.value; });
      return h('div', { class: 'bots-w-field' }, [label, control, other]);
    } else if (n.type === 'Radio') {
      const name = uid();
      const options = [...n.options, ...(n.other ? [{ value: OTHER, label: 'Other' }] : [])];
      const other = h('input', { type: 'text', class: 'bots-w-other', placeholder: 'Write your answer', 'aria-label': `${n.label}, other` });
      other.value = state.others[n.id] || '';
      other.hidden = state.values[n.id] !== OTHER;
      other.addEventListener('input', () => { state.others[n.id] = other.value; });
      const group = h('div', { class: 'bots-w-radios', role: 'radiogroup', 'aria-label': n.label }, options.map(o => {
        const input = h('input', { type: 'radio', name, value: o.value });
        input.checked = state.values[n.id] === o.value;
        input.addEventListener('change', () => { set(o.value); other.hidden = o.value !== OTHER; if (!other.hidden) other.focus(); });
        return h('label', { class: 'bots-w-radio' }, [input, h('span', { text: o.label })]);
      }));
      return h('div', { class: 'bots-w-field' }, [h('span', { class: 'bots-w-field-label', text: n.label }), group, other]);
    }
    return h('div', { class: 'bots-w-field' }, [label, control]);
  }

  // -- pressing ---------------------------------------------------------------------------------------------------------
  async function press(ref) {
    if (state.busy || widget.settled) return;
    const built = buildPress(widget, message.id, ref, state.values, state.others, state.sendId || (state.sendId = newSendId()));
    if (built.error) { state.line = built.error; state.sendId = ''; draw(); return; }
    state.busy = true; state.line = ''; draw();
    try {
      const res = await (ctx.fetcher || fetch)(`/api/bot-widgets/${encodeURIComponent(ctx.sessionId)}/press`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.body) });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).detail; } catch { /* no body */ }
        state.line = pressMessage(res.status, detail);
        state.sendId = '';
        if (res.status === 409 || res.status === 404) ctx.refresh?.();
      } else {
        state.sendId = '';
        const kept = findKeepOpen(doc, ref);
        if (!kept) widget = { ...widget, settled: { at: Date.now() / 1000, ref, label: labelOf(ref), summary: pressSummary(widget, ref, built.body.values, state.others) } };
        ctx.refresh?.();
      }
    } catch {
      state.line = 'That did not go through. Try again.';   // the same send id is kept, so a retry cannot double-send
    }
    state.busy = false;
    draw();
  }
  function labelOf(ref) {
    if (doc.confirm?.ref === ref) return doc.confirm.label;
    if (doc.cancel?.ref === ref) return doc.cancel.label;
    let found = ref;
    const walk = n => { if (n?.type === 'Button' && n.ref === ref) found = n.label; (n?.children || []).forEach(walk); (n?.items || []).forEach(i => { if (i.ref === ref) found = i.title; walk(i); }); };
    walk(doc);
    return found;
  }

  draw();
  root.destroy = () => { cancelAnimationFrame(frameId); observer?.disconnect(); };
  return root;
}
function findKeepOpen(doc, ref) {
  let keep = false;
  const walk = n => { if (n?.type === 'Button' && n.ref === ref && n.keep_open) keep = true; (n?.children || []).forEach(walk); (n?.items || []).forEach(walk); };
  walk(doc);
  return keep;
}

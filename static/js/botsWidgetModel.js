// Widgets without a DOM (Phase 6 unit U2, 2026-10-29): the same limits and checks as services/bot_widgets.py,
// so a card is refused the same way in the browser as on the server (scripts/test_bots_widget_schema.cjs holds
// the two together). Also: the compact-layout rule, the starting values of a form, and the answer a press sends.

export const LIMITS = { bytes: 32_000, nodes: 250, depth: 10, fields: 20, listItems: 40, images: 6, options: 40, chartSeries: 4, chartPoints: 100,
  tableRows: 100, tableCols: 12, title: 120, caption: 240, meta: 80, values: 8000 };
export const COMPACT_BELOW = 400;
export const SIZES = ['sm', 'md', 'lg', 'full'];
export const TONES = ['quiet', 'good', 'warn', 'bad'];
export const INPUT_KINDS = ['text', 'number', 'email', 'url', 'tel', 'search'];
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const FIELD_TYPES = ['Select', 'Date', 'Time', 'Weekday', 'Checkbox', 'Radio', 'Input', 'Textarea'];
export const LAYOUT = ['Box', 'Row', 'Col', 'Form'];
export const TEXT_NODES = { Text: 2000, Title: 200, Caption: 400, Label: 200, Markdown: 8000 };
export const ICONS = ['plus', 'x', 'search', 'settings', 'pencil', 'trash-2', 'copy', 'archive', 'pin', 'folder', 'message-square', 'zap', 'check',
  'circle-alert', 'triangle-alert', 'info', 'eye', 'sliders-horizontal', 'brain', 'wrench', 'plug', 'calendar-clock', 'shield', 'history', 'gauge',
  'bell', 'sparkles', 'upload', 'image', 'refresh-cw', 'arrow-left', 'arrow-down', 'chevron-down', 'chevron-right', 'chevron-left', 'external-link',
  'lock', 'clock', 'send', 'mic', 'paperclip', 'undo-2', 'share-2', 'download', 'user', 'users', 'book-open', 'phone', 'repeat', 'monitor',
  'rotate-ccw', 'play', 'pause', 'panel-right', 'messages-square', 'archive-restore', 'folder-plus', 'ellipsis', 'square'];
const NODE_TYPES = new Set([...LAYOUT, ...Object.keys(TEXT_NODES), ...FIELD_TYPES, 'Table', 'Image', 'Icon', 'Chart', 'Badge', 'Progress', 'Button', 'Spacer', 'Divider']);
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const REF = /^[A-Za-z][A-Za-z0-9_.-]{0,59}$/;
const SECRETISH = /pass(word|code|phrase)|\bsecret\b|api[ _-]?key|\bpin\b|\bcvv\b|card number|\bssn\b|private key|recovery (code|phrase)|one[- ]time code|\botp\b/i;
const HTTPS = /^https:\/\/[^\s/$.?#][^\s]*$/i;

export class WidgetError extends Error {}
const fail = message => { throw new WidgetError(message); };

const text = (value, label, limit, required = false) => {
  if (value === undefined || value === null || value === '') { if (required) fail(`${label} is needed.`); return null; }
  if (typeof value !== 'string') fail(`${label} must be text.`);
  const clean = value.replace(/\u0000/g, '');
  if ([...clean].length > limit) fail(`${label} is limited to ${limit} characters.`);
  return clean;
};
const https = (url, label) => { if (typeof url !== 'string' || url.length > 2048 || !HTTPS.test(url)) fail(`${label} must be an https link.`); return url; };
const oneOf = (value, list, message) => { if (!list.includes(value)) fail(message); return value; };
const isInt = v => Number.isInteger(v) && typeof v === 'number';

class Check {
  constructor() { this.nodes = 0; this.fields = new Map(); this.images = 0; this.refs = new Map(); this.client = new Set(); }
  count() { if (++this.nodes > LIMITS.nodes) fail(`A widget can have at most ${LIMITS.nodes} parts.`); }
  ref(value, label, { client = false } = {}) {
    if (typeof value !== 'string' || !REF.test(value)) fail(`${label} needs a short ref made of letters, digits, dots, dashes or underscores.`);
    if (this.refs.has(value)) fail(`The ref '${value}' is used twice.`);
    this.refs.set(value, true);
    if (client) this.client.add(value);
    return value;
  }
}

function options(raw, label) {
  if (!Array.isArray(raw) || !raw.length || raw.length > LIMITS.options) fail(`${label} needs 1 to ${LIMITS.options} options.`);
  const seen = new Set();
  return raw.map(item => {
    if (typeof item === 'string') item = { value: item, label: item };
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label} options are text or {value, label}.`);
    const value = text(item.value, `${label} option value`, 120, true);
    if (seen.has(value)) fail(`${label} has the option '${value}' twice.`);
    seen.add(value);
    return { value, label: text(item.label, `${label} option label`, 120) || value };
  });
}

function field(node, check) {
  const kind = node.type, id = node.id;
  if (typeof id !== 'string' || !ID.test(id)) fail(`A ${kind} field needs an id of lowercase letters, digits and underscores.`);
  if (check.fields.has(id)) fail(`The field id '${id}' is used twice.`);
  if (check.fields.size >= LIMITS.fields) fail(`A widget can have at most ${LIMITS.fields} fields.`);
  const out = { type: kind, id, label: text(node.label, 'A field label', 120, true) };
  if (SECRETISH.test(out.label) || SECRETISH.test(id)) fail('Widgets cannot ask for passwords or other secrets.');
  if (kind === 'Input' || kind === 'Textarea') {
    const placeholder = text(node.placeholder, 'A placeholder', 120);
    if (placeholder) { if (SECRETISH.test(placeholder)) fail('Widgets cannot ask for passwords or other secrets.'); out.placeholder = placeholder; }
    const given = node.input_type ?? node.kind;
    if (kind === 'Input') {
      if (given !== undefined && given !== null) { if (!INPUT_KINDS.includes(given)) fail('An Input is text, number, email, url, tel or search. It is never a password.'); out.input_type = given; }
      else out.input_type = 'text';
    }
    if (node.value !== undefined && node.value !== null) out.value = text(node.value, 'A field value', 2000);
    if (kind === 'Textarea' && node.rows !== undefined && node.rows !== null) { if (!isInt(node.rows) || node.rows < 2 || node.rows > 12) fail('rows is a whole number from 2 to 12.'); out.rows = node.rows; }
  } else if (kind === 'Select' || kind === 'Radio') {
    out.options = options(node.options, `The ${kind} '${id}'`);
    out.other = !!node.other;
    if (node.value !== undefined && node.value !== null) { if (!out.options.some(o => o.value === node.value)) fail(`The starting value of '${id}' is not one of its options.`); out.value = node.value; }
  } else if (kind === 'Checkbox') {
    const value = node.value === undefined ? false : node.value;
    if (typeof value !== 'boolean') fail('A checkbox starts true or false.');
    out.value = value;
  } else if (kind === 'Date') {
    if (node.value !== undefined && node.value !== null && !(typeof node.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(node.value))) fail('A date starts as YYYY-MM-DD.');
    out.value = node.value ?? null;
  } else if (kind === 'Time') {
    if (node.value !== undefined && node.value !== null && !(typeof node.value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(node.value))) fail('A time starts as HH:MM.');
    out.value = node.value ?? null;
  } else if (kind === 'Weekday') {
    if (node.value !== undefined && node.value !== null && !WEEKDAYS.includes(node.value)) fail('A weekday is mon, tue, wed, thu, fri, sat or sun.');
    out.value = node.value ?? null;
  }
  if (node.required !== undefined && node.required !== null) out.required = !!node.required;
  check.fields.set(id, out);
  return out;
}

function chart(node) {
  const kind = node.kind ?? 'bar';
  oneOf(kind, ['bar', 'line', 'area'], 'A chart is bar, line or area.');
  const series = node.series;
  if (!Array.isArray(series) || series.length < 1 || series.length > LIMITS.chartSeries) fail(`A chart has 1 to ${LIMITS.chartSeries} series.`);
  return { type: 'Chart', kind, title: text(node.title, 'A chart title', 120), height: 160, series: series.map(item => {
    if (!item || typeof item !== 'object') fail('A chart series is {name, points}.');
    const points = item.points;
    if (!Array.isArray(points) || !points.length || points.length > LIMITS.chartPoints) fail(`A chart series has 1 to ${LIMITS.chartPoints} points.`);
    return { name: text(item.name, 'A series name', 60) || '', points: points.map(p => {
      if (!p || typeof p !== 'object' || typeof p.y !== 'number' || !Number.isFinite(p.y)) fail('A chart point is {x, y} with a number for y.');
      return { x: text(String(p.x ?? ''), 'A chart label', 60) || '', y: p.y };
    }) };
  }) };
}

function button(raw, check) {
  const label = text(raw.label, 'A button label', 60, true);
  const action = raw.action;
  const out = { type: 'Button', label };
  if (action && typeof action === 'object') {
    if (action.type === 'open_url') { out.action = { type: 'open_url', url: https(action.url, 'A button link') }; return out; }
    if (action.type === 'open_thread') { out.action = { type: 'open_thread', thread_id: text(action.thread_id, 'A thread id', 80, true) }; return out; }
    if (action.type !== undefined && action.type !== null && action.type !== 'press') fail('A button action is press, open_url or open_thread.');
  }
  out.ref = check.ref(raw.ref, `The button '${label}'`);
  out.keep_open = !!raw.keep_open;
  if (raw.tone !== undefined && raw.tone !== null) out.tone = oneOf(raw.tone, ['primary', 'quiet', 'danger'], 'A button tone is primary, quiet or danger.');
  return out;
}

function node(raw, check, depth) {
  if (depth > LIMITS.depth) fail(`Parts are nested too deeply (at most ${LIMITS.depth} levels).`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Every part is an object with a type.');
  const kind = raw.type;
  if (!NODE_TYPES.has(kind)) fail(`Unknown part type: ${String(kind).slice(0, 40)}.`);
  check.count();
  if (LAYOUT.includes(kind)) {
    const children = raw.children ?? [];
    if (!Array.isArray(children)) fail(`${kind} holds a list of parts.`);
    if (children.length > LIMITS.nodes) fail(`A widget can have at most ${LIMITS.nodes} parts.`);
    const out = { type: kind, children: children.map(c => node(c, check, depth + 1)) };
    if (raw.gap !== undefined && raw.gap !== null) out.gap = oneOf(raw.gap, ['sm', 'md', 'lg'], 'gap is sm, md or lg.');
    return out;
  }
  if (kind in TEXT_NODES) {
    const out = { type: kind, text: text(raw.text, `${kind} text`, TEXT_NODES[kind], true) };
    if (raw.tone !== undefined && raw.tone !== null) out.tone = oneOf(raw.tone, TONES, 'tone is quiet, good, warn or bad.');
    return out;
  }
  if (FIELD_TYPES.includes(kind)) return field(raw, check);
  if (kind === 'Table') {
    const { columns, rows } = raw;
    if (!Array.isArray(columns) || columns.length < 1 || columns.length > LIMITS.tableCols || !Array.isArray(rows) || rows.length > LIMITS.tableRows) fail(`A table has 1 to ${LIMITS.tableCols} columns and at most ${LIMITS.tableRows} rows.`);
    return { type: 'Table', columns: columns.map(c => text(String(c), 'A column title', 80) || ''), rows: rows.map(r => {
      if (!Array.isArray(r) || r.length > columns.length) fail('Each table row is a list no longer than the columns.');
      return r.map(c => text(c === null || c === undefined ? '' : String(c), 'A table cell', 300) || '');
    }) };
  }
  if (kind === 'Image') {
    if (++check.images > LIMITS.images) fail(`A widget can show at most ${LIMITS.images} images.`);
    return { type: 'Image', url: https(raw.url, 'An image'), alt: text(raw.alt, 'Image text', 200) || '' };
  }
  if (kind === 'Icon') { if (!ICONS.includes(raw.name)) fail(`'${String(raw.name).slice(0, 30)}' is not an icon a widget can use.`); return { type: 'Icon', name: raw.name }; }
  if (kind === 'Chart') return chart(raw);
  if (kind === 'Badge') return { type: 'Badge', text: text(raw.text, 'A badge', 60, true), tone: oneOf(raw.tone ?? 'quiet', TONES, 'tone is quiet, good, warn or bad.') };
  if (kind === 'Progress') {
    if (typeof raw.value !== 'number' || !Number.isFinite(raw.value) || raw.value < 0 || raw.value > 100) fail('Progress is a number from 0 to 100.');
    return { type: 'Progress', value: raw.value, label: text(raw.label, 'A progress label', 120) };
  }
  if (kind === 'Button') return button(raw, check);
  return { type: kind };
}

function action(raw, check, fallback, name) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} is {label, ref}.`);
  return { label: text(raw.label, `The ${name} label`, 60) || fallback, ref: check.ref(raw.ref ?? name, `The ${name} button`) };
}

// The clean document, or throws a WidgetError (same wording as the server). Use checkWidget for {ok, doc, error}.
export function validateWidget(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('A widget is an object.');
  let size;
  try { size = new TextEncoder().encode(JSON.stringify(doc)).length; } catch { fail('A widget must be plain JSON.'); }
  if (size > LIMITS.bytes) fail(`A widget is limited to ${LIMITS.bytes.toLocaleString('en-US')} bytes (this one is ${size.toLocaleString('en-US')}).`);
  const kind = doc.type ?? 'card';
  if (kind !== 'card' && kind !== 'list') fail('A widget is a card or a list.');
  const check = new Check();
  const out = { type: kind, title: text(doc.title, 'The title', LIMITS.title), caption: text(doc.caption, 'The caption', LIMITS.caption),
    meta: text(doc.meta, 'The meta line', LIMITS.meta), status: text(doc.status, 'The status line', 160) };
  if (kind === 'card') {
    out.size = oneOf(doc.size ?? 'md', SIZES, 'size is sm, md, lg or full.');
    const body = doc.children ?? [];
    if (!Array.isArray(body)) fail('A card holds a list of parts.');
    if (body.length > LIMITS.nodes) fail(`A widget can have at most ${LIMITS.nodes} parts.`);
    out.children = body.map(c => node(c, check, 1));
  } else {
    const items = doc.items;
    if (!Array.isArray(items) || !items.length || items.length > LIMITS.listItems) fail(`A list has 1 to ${LIMITS.listItems} items.`);
    out.items = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('A list item is an object.');
      check.count();
      const entry = { title: text(item.title, 'An item title', 200, true), caption: text(item.caption, 'An item caption', 400), meta: text(item.meta, 'An item meta line', 80) };
      if (item.ref !== undefined && item.ref !== null) entry.ref = check.ref(item.ref, `The item '${entry.title.slice(0, 30)}'`);
      if (item.children && (!Array.isArray(item.children) || item.children.length > 20)) fail('An item holds up to 20 parts.');
      if (item.children?.length) entry.children = item.children.map(c => node(c, check, 2));
      return entry;
    });
  }
  out.confirm = action(doc.confirm, check, 'Confirm', 'confirm');
  out.cancel = action(doc.cancel, check, 'Cancel', 'cancel');
  if (!out.title && !out.children?.length && !out.items?.length) fail('A widget needs a title or some content.');
  out._refs = [...check.refs.keys()].filter(r => !check.client.has(r)).sort();
  for (const key of Object.keys(out)) if (out[key] === null || out[key] === undefined) delete out[key];
  return out;
}
export function checkWidget(doc) {
  try { return { ok: true, doc: validateWidget(doc) }; } catch (error) { if (error instanceof WidgetError) return { ok: false, error: error.message }; throw error; }
}

// -- using a card ------------------------------------------------------------------------------------------
export function compactLayout(width) { return Number(width) > 0 && Number(width) < COMPACT_BELOW; }
export function fieldsOf(doc) {
  const found = new Map();
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (FIELD_TYPES.includes(n.type) && n.id) found.set(n.id, n);
    (n.children || []).forEach(walk); (n.items || []).forEach(walk);
  };
  walk(doc);
  return found;
}
export function initialValues(doc) {
  const values = {};
  for (const [id, f] of fieldsOf(doc)) {
    if (f.type === 'Checkbox') values[id] = !!f.value;
    else if (f.value !== undefined && f.value !== null) values[id] = f.value;
    else if (f.type === 'Select' || f.type === 'Radio') values[id] = '';
    else values[id] = '';
  }
  return values;
}
export const OTHER = '__other__';
// The body of POST /api/bot-widgets/{sid}/press, or {error} when a needed field is empty.
export function buildPress(widget, messageId, ref, values, others, sendId) {
  const doc = widget.doc;
  const fields = fieldsOf(doc);
  const clean = {}, other = {};
  for (const [id, f] of fields) {
    let v = values[id];
    if (f.type === 'Checkbox') { clean[id] = !!v; continue; }
    if (f.required && (v === undefined || v === '' || v === null)) return { error: `${f.label} is needed.` };
    if (v === undefined || v === '' || v === null) continue;
    if ((f.type === 'Select' || f.type === 'Radio') && v === OTHER) { if (!(others[id] || '').trim()) return { error: `Write your answer for ${f.label}.` }; other[id] = others[id].trim(); }
    clean[id] = v;
  }
  return { body: { message_id: messageId, ref, rev: widget.rev, values: clean, ...(Object.keys(other).length ? { other } : {}), send_id: sendId } };
}
// The sentence a press leaves in the thread (the same words the server writes), for the folded card's Details.
const NL = String.fromCharCode(10);
export function pressSummary(widget, ref, values, others = {}) {
  const doc = widget.doc;
  let label = ref;
  if (doc.confirm?.ref === ref) label = doc.confirm.label;
  else if (doc.cancel?.ref === ref) label = doc.cancel.label;
  const walk = n => { if (!n || typeof n !== 'object') return; if (n.type === 'Button' && n.ref === ref) label = n.label; (n.children || []).forEach(walk); (n.items || []).forEach(i => { if (i.ref === ref) label = i.title; walk(i); }); };
  walk(doc);
  const fields = fieldsOf(doc);
  const lines = Object.entries(values || {}).map(([id, v]) => {
    const f = fields.get(id);
    const shown = typeof v === 'boolean' ? (v ? 'yes' : 'no') : (v === OTHER ? (others[id] || '') : v);
    return `${f ? f.label : id}: ${shown}`;
  });
  return `I answered the card "${doc.title || 'card'}": ${label}.` + (lines.length ? NL + lines.join(NL) : '');
}
// A settled card folds to one line.
export function foldedLine(widget) {
  const s = widget?.settled;
  if (!s) return '';
  return s.label ? `${widget.doc?.title ? widget.doc.title + ': ' : ''}${s.label}` : (widget.doc?.title || 'Answered');
}
export function pressMessage(status, detail) {
  if (status === 409) return /changed/i.test(detail || '') ? 'This card changed. Look at the new one.' : (detail || 'This card was already answered.');
  if (status === 404) return 'That card is gone.';
  return detail || 'That did not go through. Try again.';
}

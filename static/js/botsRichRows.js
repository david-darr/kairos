// The one door the transcript uses for rich rows (Phase 6 unit U2, 2026-10-29): renderRichRow(message, ctx) returns an
// element for a widget, an app or a data result, or null when the message is an ordinary one. Other kinds belong to
// other units (a voice note, a help request, a quota switch): their modules are loaded when a row of that kind is
// first drawn, and the row shows a quiet placeholder meanwhile. A module that is missing or fails leaves one plain
// line, never a broken transcript. registerRichRow(kind, fn) lets a unit plug a renderer in directly.
//
// message: a Bots message row ({id, kind, widget | app | data_result | ...}). ctx: {agentId, sessionId, botName, refresh?}.
import { h } from './botsUi.js';
import { renderWidget } from './botsWidget.js';
import { renderAppRow } from './botsAppFrame.js';
import { renderDataResultRow } from './botsDataChip.js';

const registry = new Map([
  ['widget', renderWidget],
  ['app', renderAppRow],
  ['data_result', renderDataResultRow],
]);
// Kinds drawn by another unit's module: the file, and the export that draws the row.
const LAZY = {
  voice_note: ['./botsVoiceNote.js', ['renderVoiceNoteRow', 'renderRichRow', 'default']],
  help: ['./botsHelpCard.js', ['renderHelpRow', 'renderRichRow', 'default']],
  quota_switch: ['./botsQuotaCard.js', ['renderQuotaRow', 'renderRichRow', 'default']],
};

export const RICH_KINDS = ['widget', 'app', 'data_result', ...Object.keys(LAZY)];
export function registerRichRow(kind, render) { registry.set(kind, render); }

export function richKind(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.kind && RICH_KINDS.includes(message.kind)) return message.kind;
  if (message.widget && typeof message.widget === 'object') return 'widget';
  if (message.app && typeof message.app === 'object') return 'app';
  if (message.data_result && typeof message.data_result === 'object') return 'data_result';
  return '';
}

export function renderRichRow(message, ctx = {}) {
  const kind = richKind(message);
  if (!kind) return null;
  const direct = registry.get(kind);
  const label = kind.replace(/_/g, ' ');
  try {
    if (direct) return wrap(kind, direct(message, ctx));
  } catch (error) {
    console.warn(`Bots: a ${label} row could not be drawn`, error);
    return wrap(kind, h('p', { class: 'bots-rich-note', role: 'status', text: 'This part of the conversation could not be shown.' }));
  }
  const lazy = LAZY[kind];
  if (!lazy) return null;
  const slot = wrap(kind, h('p', { class: 'bots-rich-note', role: 'status', text: 'Loading' }));
  import(/* @vite-ignore */ lazy[0]).then(mod => {
    const render = lazy[1].map(name => mod?.[name]).find(fn => typeof fn === 'function');
    if (!render) throw new Error(`${lazy[0]} has no ${lazy[1][0]}`);
    registry.set(kind, render);
    const node = render(message, ctx);
    if (node) slot.replaceChildren(node); else slot.remove();
  }).catch(error => {
    console.warn(`Bots: ${lazy[0]} could not load`, error);
    slot.replaceChildren(h('p', { class: 'bots-rich-note', role: 'status', text: 'This part of the conversation could not be shown.' }));
  });
  return slot;
}

function wrap(kind, node) {
  const box = h('div', { class: `bots-rich-row kind-${kind}`, 'data-rich-kind': kind }, [node]);
  box.destroy = () => node?.destroy?.();
  return box;
}

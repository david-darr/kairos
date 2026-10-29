import { h, loadBotsCss } from './botsUi.js';
import { botKip } from './botsKip.js';
import { handoffModel, repeatLabel } from './botsDelegationModel.js';

const CSS = '/static/css/bots-delegation.css';
export function renderHandoffChip(row, ctx = {}) {
  loadBotsCss(CSS);
  const model = handoffModel(row);
  const root = h('section', { class: 'bots-handoff', 'data-state': model.state, 'data-tone': model.failed ? 'danger' : 'normal' });
  const title = h('button', { type: 'button', class: 'bots-handoff-partner', onclick: () => {
    if (ctx.open) ctx.open(model.target);
    else document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: model.target }));
  } }, [botKip(model.partner, { size: 16 }), h('span', { text: `${model.verb} ${model.partner.name || 'Bot'}` })]);
  root.append(h('div', { class: 'bots-handoff-heading' }, [title, h('span', { class: 'bots-handoff-status', text: model.label, role: 'status' })]));
  if (row.reason) root.append(h('p', { class: 'bots-handoff-reason', text: row.reason }));
  if (row.note) root.append(h('p', { text: row.note }));
  if (model.preview) {
    const details = h('details', { class: 'bots-handoff-reply' }, [
      h('summary', { text: model.preview.split('\n')[0].slice(0, 160) }),
      h('div', { class: 'bots-handoff-result', text: model.preview }),
    ]);
    root.append(details);
  }
  if (model.doneWhen) root.append(h('p', { class: 'bots-handoff-done', text: `Done when: ${model.doneWhen}` }));
  if (model.question) {
    root.append(h('p', { text: model.question }));
    if (ctx.answer && row.inbox_item_id) {
      const input = h('textarea', { 'aria-label': 'Answer the question', maxlength: '2000', rows: '2' });
      const error = h('span', { role: 'alert' });
      const submit = h('button', { type: 'submit', text: 'Reply' });
      const form = h('form', { class: 'bots-handoff-answer', onsubmit: async event => {
        event.preventDefault();
        if (!input.value.trim() || submit.disabled) return;
        submit.disabled = true;
        try { await ctx.answer(row.inbox_item_id, input.value.trim()); form.replaceChildren(h('span', { text: 'Answer sent' })); }
        catch (cause) { error.textContent = cause.message || String(cause); submit.disabled = false; }
      } }, [input, submit, error]);
      root.append(form);
    }
  }
  return root;
}

export function renderRepeatChip(row) {
  loadBotsCss(CSS);
  return h('div', { class: 'bots-repeat-chip', role: 'status' }, [
    h('span', { text: repeatLabel(row) }), h('span', { class: 'bots-repeat-detail', text: [row.tool, row.preview].filter(Boolean).join(': ') }),
  ]);
}

export function mount(host, ctx = {}) {
  let current = ctx.row || ctx.message || {}, destroyed = false;
  const refresh = row => { if (!destroyed) { if (row) current = row; host.replaceChildren(current.type === 'repeat' ? renderRepeatChip(current) : renderHandoffChip(current, ctx)); } };
  refresh();
  return { refresh, flush: async () => true, destroy() { destroyed = true; host.replaceChildren(); } };
}

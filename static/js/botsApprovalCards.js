// Bots mode: approval and question cards (Agents 3.0 Phase 3, unit U5).
// Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 3, 5.3 and 7.
// Styled by static/css/bots-cards.css. Data: GET /api/bot-cards, POST /api/bot-cards/{id}/respond|resume
// (routes/bot_card_routes.py). The card is the durable record of a request; the live request itself stays in the
// backend, so a reload shows the same card and an answer settles it once.
//
// Mount contract (phase-3-design.md section 3): `mount(host, ctx)` resolves to { dispose, refresh }.
// ctx is { agentId, threadId, mode, getAgent, refresh, navigate, signal, slot? }. `slot` is 'transcript'
// (compact rows for every card, plus the applied-change cards) or 'composer' (the pending action, which takes the
// composer's place). The module owns only children of `host` and never changes global panel state.
//
// The first half is plain functions with no DOM, so scripts/test_bots_cards.cjs can load this file in Node.
import { icon } from './botsIcons.js';
import { loadBotsCss } from './botsUi.js';

export const LIMITS = { questions: 6, options: 12, label: 120, description: 400, custom: 2000 };
export const POLL_MS = 3000;

// -- Rows and titles ----------------------------------------------------------------

const SCOPE_TEXT = { once: 'Allowed once', session: 'Allowed for this chat', forever: 'Always allowed' };

// One plain line for a settled card. An action that did not run says so.
export function settledText(card) {
  const outcome = card.outcome || {};
  switch (card.status) {
    case 'allowed': {
      const base = SCOPE_TEXT[outcome.scope] || 'Allowed';
      return outcome.scope === 'forever' && card.details?.target ? `${base}: ${card.details.target}` : base;
    }
    case 'denied': return 'Denied. The action did not run.';
    case 'answered': return outcome.as_new_turn ? 'Answered. It will use this in a new turn.' : 'Answered';
    case 'skipped': return card.kind === 'question' ? 'Skipped' : 'Not now';
    case 'expired': return outcome.reason || 'Nobody answered in time.';
    case 'unavailable': return outcome.reason || 'No longer waiting, so the action did not run.';
    case 'cancelled': return outcome.reason || 'Cancelled, so the action did not run.';
    default: return '';
  }
}

export function isWaiting(card) { return card.status === 'pending' || card.status === 'settling'; }

// Oldest first; the pending cards, in the same order.
export function splitCards(cards) {
  const sorted = [...(cards || [])].sort((a, b) => a.created_at - b.created_at);
  return { pending: sorted.filter(isWaiting), settled: sorted.filter(card => !isWaiting(card)), all: sorted };
}

// For a settled question: "Which day?: Tue".
export function answerLines(card) {
  if (card.kind !== 'question' || !card.outcome?.answers) return [];
  return (card.questions || []).filter(q => card.outcome.answers[q.id] !== undefined).map(q => {
    const value = card.outcome.answers[q.id];
    return { question: q.question, answer: Array.isArray(value) ? value.join(', ') : String(value) };
  });
}

// -- Approval answers -----------------------------------------------------------------

// The "Always allow" choices the card really offers, never more.
export function rememberChoices(card) {
  if (card.kind !== 'approval') return [];
  return (card.choices || []).filter(c => c.behavior === 'allow' && c.scope !== 'once')
    .map(c => ({ id: c.id, label: c.label, remember: c.scope === 'forever' ? 'always' : 'session' }));
}

export function approvalBody(card, action, remember = 'once') {
  const body = action === 'deny' ? { action: 'deny' } : { action: 'allow', remember };
  if (card.revision) body.reviewed_revision = card.revision;
  return body;
}

// -- Questions ------------------------------------------------------------------------
// State is plain data so it can be tested: { index, picked: {id: [labels]}, custom: {id: text} }.

export function newQuestionState(questions) {
  return { index: 0, picked: Object.fromEntries(questions.map(q => [q.id, []])), custom: Object.fromEntries(questions.map(q => [q.id, ''])) };
}

const find = (questions, id) => questions.find(q => q.id === id);

export function pickOption(state, questions, id, label) {
  const q = find(questions, id);
  if (!q || !q.options.some(o => o.label === label)) return state;
  const now = state.picked[id];
  if (q.multi_select) {
    state.picked[id] = now.includes(label) ? now.filter(l => l !== label) : [...now, label];
  } else {
    state.picked[id] = [label];
    state.custom[id] = '';           // a chosen option replaces typed text
  }
  return state;
}

// Typed text is clipped to the limit; the result says whether it was.
export function typeCustom(state, questions, id, text) {
  const q = find(questions, id);
  if (!q || !q.allow_custom) return { state, clipped: false };
  const clipped = text.length > LIMITS.custom;
  state.custom[id] = clipped ? text.slice(0, LIMITS.custom) : text;
  if (!q.multi_select && state.custom[id].trim()) state.picked[id] = [];   // typed text replaces the option
  return { state, clipped };
}

export function questionAnswer(state, questions, id) {
  const q = find(questions, id);
  const typed = (state.custom[id] || '').trim();
  const picked = state.picked[id] || [];
  if (q.multi_select) return [...picked, ...(typed ? [typed] : [])];
  return typed || picked[0] || '';
}

export function isAnswered(state, questions, id) {
  const value = questionAnswer(state, questions, id);
  return Array.isArray(value) ? value.length > 0 : value !== '';
}

export function canSubmit(state, questions) { return questions.every(q => isAnswered(state, questions, q.id)); }

export function goTo(state, questions, index) {
  state.index = Math.max(0, Math.min(questions.length - 1, index));
  return state;
}
export const nextQuestion = (state, questions) => goTo(state, questions, state.index + 1);
export const previousQuestion = (state, questions) => goTo(state, questions, state.index - 1);
export const isLast = (state, questions) => state.index === questions.length - 1;

// Where Next lands: the first question after this one that is still unanswered, else the next one.
export function advanceTarget(state, questions) {
  for (let i = state.index + 1; i < questions.length; i++) if (!isAnswered(state, questions, questions[i].id)) return i;
  return Math.min(state.index + 1, questions.length - 1);
}

export function questionBody(card, state) {
  const answers = {};
  for (const q of card.questions) answers[q.id] = questionAnswer(state, card.questions, q.id);
  const body = { action: 'answer', answers };
  if (card.revision) body.reviewed_revision = card.revision;
  return body;
}

// -- DOM kit (a copy of the row builder; this file must load without the shell) --------

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, { method, signal, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await response.json(); } catch { /* an empty body */ }
  return { status: response.status, body: data };
}

let uid = 0;
const nextId = prefix => `${prefix}-${++uid}`;

function statusIcon(card) {
  if (card.status === 'allowed' || card.status === 'answered') return icon('check', { size: 14 });
  if (card.status === 'denied') return icon('x', { size: 14 });
  if (card.status === 'skipped') return icon('chevron-right', { size: 14 });
  return icon('clock', { size: 14 });
}

// The compact row every card becomes (waiting or settled).
export function cardRow(card) {
  const waiting = isWaiting(card);
  const text = waiting ? 'Waiting for you' : settledText(card);
  const lines = answerLines(card);
  const row = h('div', { class: 'bots-card-row', 'data-status': card.status, 'data-kind': card.kind, 'data-card-id': card.id }, [
    h('span', { class: 'bots-card-row-icon' }, waiting ? icon('shield', { size: 14 }) : statusIcon(card)),
    h('span', { class: 'bots-card-row-main' }, [
      h('span', { class: 'bots-card-row-title', text: card.title }),
      h('span', { class: 'bots-card-row-text', text }),
    ]),
  ]);
  if (lines.length) {
    row.append(h('details', { class: 'bots-card-row-answers' }, [
      h('summary', { text: `${lines.length} ${lines.length === 1 ? 'answer' : 'answers'}` }),
      h('ul', {}, lines.map(l => h('li', {}, [h('span', { class: 'bots-card-q', text: l.question }), h('span', { text: ` ${l.answer}` })]))),
    ]));
  }
  return row;
}

function detailList(card) {
  const rows = card.details?.lines || [];
  if (!rows.length) return null;
  return h('dl', { class: 'bots-card-details' }, rows.flatMap(r => [h('dt', { text: r.label }), h('dd', { text: r.value })]));
}

// -- The mount ---------------------------------------------------------------------------

export async function mount(host, ctx = {}) {
  await loadBotsCss('/static/css/bots-cards.css');
  const slot = ctx.slot === 'composer' ? 'composer' : 'transcript';
  const root = h('div', { class: 'bots-cards', 'data-slot': slot });
  host.append(root);
  const control = new AbortController();
  const onAbort = () => control.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  const view = { cards: [], busy: new Set(), errors: {}, qstate: {}, timer: 0, disposed: false, change: null };

  const threadId = () => ctx.threadId || '';
  async function load() {
    const id = threadId();
    if (!id) { view.cards = []; return; }
    try {
      const { status, body } = await request(`/api/bot-cards?thread_id=${encodeURIComponent(id)}`, { signal: control.signal });
      if (status === 200) view.cards = body.cards || [];
    } catch (error) {
      if (error.name !== 'AbortError') view.errors._load = 'Could not load requests.';
    }
  }

  function schedule() {
    clearTimeout(view.timer);
    if (view.disposed || !splitCards(view.cards).pending.length || document.hidden) return;
    view.timer = setTimeout(() => refresh(), POLL_MS);
  }

  // The poll redraws only when a card changed: a rebuild every few seconds would pull focus out of a half-typed answer.
  let drawn = null;
  async function refresh() {
    if (view.disposed) return;
    await load();
    if (view.disposed) return;
    const now = JSON.stringify(view.cards);
    if (now !== drawn) render();
    schedule();
  }

  function applyCard(card) {
    const at = view.cards.findIndex(c => c.id === card.id);
    if (at >= 0) view.cards[at] = card; else view.cards.push(card);
  }

  async function send(card, path, body) {
    if (view.busy.has(card.id)) return;
    view.busy.add(card.id);
    delete view.errors[card.id];
    render();
    try {
      const { status, body: data } = await request(`/api/bot-cards/${card.id}/${path}`, { method: 'POST', body, signal: control.signal });
      if (data.card) applyCard(data.card);
      if (status === 200 && data.ok !== false) {
        document.dispatchEvent(new CustomEvent('kairos:bots-card-settled', { detail: { card: data.card, resume: data.resume || null } }));
        ctx.refresh?.();
      } else if (status === 200) {
        view.errors[card.id] = data.message || 'This is no longer waiting, so the action did not run.';
      } else {
        view.errors[card.id] = data.detail || 'That did not go through. Try again.';
      }
    } catch (error) {
      if (error.name !== 'AbortError') view.errors[card.id] = 'That did not go through. Try again.';
    } finally {
      view.busy.delete(card.id);
      if (!view.disposed) render();
    }
  }

  function actions(card, buttons) {
    const busy = view.busy.has(card.id);
    return h('div', { class: 'bots-cards-actions' }, buttons.map(([label, variant, onClick, extra = {}]) =>
      h('button', { type: 'button', class: `bots-btn ${variant}`.trim(), disabled: busy, onclick: onClick, ...extra, text: label })));
  }

  function approvalPanel(card) {
    const titleId = nextId('bots-card-title');
    const buttons = [
      ['Deny', '', () => send(card, 'respond', approvalBody(card, 'deny')), { 'data-action': 'deny' }],
      ['Allow once', 'primary', () => send(card, 'respond', approvalBody(card, 'allow', 'once')), { 'data-action': 'allow-once' }],
      ...rememberChoices(card).map(choice => [choice.label, '', () => send(card, 'respond', approvalBody(card, 'allow', choice.remember)),
        { 'data-action': `remember-${choice.remember}` }]),
    ];
    return h('section', { class: 'bots-cards-panel approval', role: 'group', 'aria-labelledby': titleId, 'data-card-id': card.id,
      'aria-busy': view.busy.has(card.id) ? 'true' : 'false' }, [
      h('div', { class: 'bots-caps', text: 'Needs your OK' }),
      h('h3', { class: 'bots-cards-title', id: titleId }, [icon('shield', { size: 16 }), h('span', { text: card.title })]),
      card.details?.summary ? h('p', { class: 'bots-cards-summary', text: card.details.summary }) : null,
      card.details?.target ? h('p', { class: 'bots-cards-target' }, [h('span', { class: 'bots-caps', text: 'Covers ' }), h('code', { text: card.details.target })]) : null,
      detailList(card),
      view.errors[card.id] ? h('p', { class: 'bots-cards-error', role: 'alert', text: view.errors[card.id] }) : null,
      actions(card, buttons),
    ]);
  }

  function questionPanel(card) {
    const questions = card.questions || [];
    const state = (view.qstate[card.id] ||= newQuestionState(questions));
    const q = questions[state.index];
    const titleId = nextId('bots-card-title');
    const rerender = () => render();
    const tabs = h('div', { class: 'bots-cards-tabs', role: 'tablist', 'aria-label': 'Questions' },
      questions.map((item, i) => h('button', { type: 'button', role: 'tab', id: `${titleId}-tab-${i}`, class: 'bots-cards-tab',
        'aria-selected': i === state.index ? 'true' : 'false', 'aria-controls': `${titleId}-panel`, tabindex: i === state.index ? '0' : '-1',
        'data-answered': isAnswered(state, questions, item.id) ? 'true' : 'false',
        onclick: () => { goTo(state, questions, i); rerender(); },
        onkeydown: event => {
          const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
          if (!move) return;
          event.preventDefault(); goTo(state, questions, state.index + move); rerender();
          document.getElementById(`${titleId}-tab-${state.index}`)?.focus();
        },
      }, [h('span', { text: item.header || `Question ${i + 1}` })])));
    const name = `${titleId}-q${state.index}`;
    const options = q.options.map(option => {
      const checked = state.picked[q.id].includes(option.label);
      return h('label', { class: 'bots-cards-option', 'data-checked': checked ? 'true' : 'false' }, [
        h('input', { type: q.multi_select ? 'checkbox' : 'radio', name, value: option.label, checked,
          onchange: () => { pickOption(state, questions, q.id, option.label); rerender(); } }),
        h('span', { class: 'bots-cards-option-main' }, [
          h('span', { class: 'bots-cards-option-label', text: option.label }),
          option.description ? h('span', { class: 'bots-cards-option-hint', text: option.description }) : null,
        ]),
      ]);
    });
    let counter = null;
    const custom = q.allow_custom ? h('input', { type: 'text', class: 'bots-cards-custom', maxlength: String(LIMITS.custom),
      'aria-label': q.options.length ? 'Something else' : 'Your answer', placeholder: q.options.length ? 'Something else' : 'Type your answer',
      value: state.custom[q.id] || '',
      oninput: event => {
        const { clipped } = typeCustom(state, questions, q.id, event.target.value);
        if (clipped) event.target.value = state.custom[q.id];
        // Keep focus while the options and Submit refresh around the field.
        const start = event.target.selectionStart;
        rerender();
        const again = root.querySelector(`[data-card-id="${card.id}"] .bots-cards-custom`);
        if (again) { again.focus(); again.setSelectionRange(start, start); }
      } }) : null;
    if (custom) counter = h('span', { class: 'bots-cards-count', 'aria-live': 'polite', text: (state.custom[q.id] || '').length > LIMITS.custom - 200 ? `${(state.custom[q.id] || '').length} of ${LIMITS.custom}` : '' });
    const last = isLast(state, questions);
    const ready = canSubmit(state, questions);
    const buttons = [
      ['Skip', '', () => send(card, 'respond', { action: 'skip', ...(card.revision ? { reviewed_revision: card.revision } : {}) }), { 'data-action': 'skip' }],
      ...(state.index > 0 ? [['Back', '', () => { previousQuestion(state, questions); rerender(); }, { 'data-action': 'back' }]] : []),
      ...(last ? [['Submit', 'primary', () => send(card, 'respond', questionBody(card, state)), { 'data-action': 'submit', ...(ready ? {} : { 'aria-disabled': 'true' }) }]]
        : [['Next', 'primary', () => { goTo(state, questions, advanceTarget(state, questions)); rerender(); }, { 'data-action': 'next' }]]),
    ];
    const panel = h('section', { class: 'bots-cards-panel question', role: 'group', 'aria-labelledby': titleId, 'data-card-id': card.id,
      'aria-busy': view.busy.has(card.id) ? 'true' : 'false' }, [
      h('div', { class: 'bots-caps', text: 'Needs your answer' }),
      h('h3', { class: 'bots-cards-title', id: titleId }, [icon('circle-alert', { size: 16 }), h('span', { text: card.title })]),
      questions.length > 1 ? tabs : null,
      h('div', { class: 'bots-cards-question', id: `${titleId}-panel`, role: questions.length > 1 ? 'tabpanel' : undefined,
        'aria-labelledby': questions.length > 1 ? `${titleId}-tab-${state.index}` : undefined }, [
        h('p', { class: 'bots-cards-prompt', text: q.question }),
        q.multi_select ? h('p', { class: 'bots-cards-hint', text: 'Pick all that apply.' }) : null,
        options.length ? h('div', { class: 'bots-cards-options', role: q.multi_select ? 'group' : 'radiogroup', 'aria-label': q.question }, options) : null,
        custom ? h('div', { class: 'bots-cards-custom-row' }, [custom, counter]) : null,
      ]),
      view.errors[card.id] ? h('p', { class: 'bots-cards-error', role: 'alert', text: view.errors[card.id] }) : null,
      actions(card, buttons),
    ]);
    // A Submit that is not ready stays focusable but does nothing, so a keyboard user hears why.
    const submit = panel.querySelector('[data-action="submit"]');
    if (submit && !ready) submit.addEventListener('click', event => { event.stopImmediatePropagation(); view.errors[card.id] = 'Answer every question first.'; rerender(); }, true);
    return panel;
  }

  function typedPanel(card) {
    const titleId = nextId('bots-card-title');
    const note = card.kind === 'credential' ? 'The value goes straight into Settings. Never paste it in a chat.' : '';
    return h('section', { class: `bots-cards-panel ${card.kind}`, role: 'group', 'aria-labelledby': titleId, 'data-card-id': card.id,
      'aria-busy': view.busy.has(card.id) ? 'true' : 'false' }, [
      h('div', { class: 'bots-caps', text: 'Needs you' }),
      h('h3', { class: 'bots-cards-title', id: titleId }, [icon('info', { size: 16 }), h('span', { text: card.title })]),
      card.details?.summary ? h('p', { class: 'bots-cards-summary', text: card.details.summary }) : null,
      detailList(card),
      note ? h('p', { class: 'bots-cards-hint', text: note }) : null,
      view.errors[card.id] ? h('p', { class: 'bots-cards-error', role: 'alert', text: view.errors[card.id] }) : null,
      actions(card, [['Not now', '', () => send(card, 'resume', { outcome: 'skipped' }), { 'data-action': 'not-now' }],
        ['Done', 'primary', () => send(card, 'resume', { outcome: 'done' }), { 'data-action': 'done' }]]),
    ]);
  }

  function panelFor(card) {
    return card.kind === 'approval' ? approvalPanel(card) : card.kind === 'question' ? questionPanel(card) : typedPanel(card);
  }

  function render() {
    if (view.disposed) return;
    // Keep keyboard focus where it was when the panel rebuilds.
    const active = document.activeElement;
    const typing = active?.matches?.('input[type=text], input:not([type]), textarea') ? active : null;
    const hadFocus = active && root.contains(active) ? { id: active.closest('[data-card-id]')?.dataset.cardId, action: active.dataset.action || '',
      tab: active.getAttribute('role') === 'tab', option: active.matches('.bots-cards-option input') ? active.value : null,
      field: typing ? { label: typing.getAttribute('aria-label') || typing.placeholder || '', start: typing.selectionStart, end: typing.selectionEnd } : null } : null;
    const { pending, settled } = splitCards(view.cards);
    ctx.onPending?.(pending.length > 0);
    const nodes = [];
    if (slot === 'composer') {
      if (pending[0]) nodes.push(panelFor(pending[0]));
      if (pending.length > 1) nodes.push(h('p', { class: 'bots-cards-more', text: `${pending.length - 1} more waiting after this one.` }));
    } else {
      for (const card of [...settled, ...pending]) nodes.push(cardRow(card));
    }
    root.replaceChildren(...nodes);
    drawn = JSON.stringify(view.cards);
    root.dataset.pending = String(pending.length);
    if (hadFocus && hadFocus.id) {
      const scope = root.querySelector(`[data-card-id="${hadFocus.id}"]`);
      const target = !scope ? null : hadFocus.action ? scope.querySelector(`[data-action="${hadFocus.action}"]`)
        : hadFocus.tab ? scope.querySelector('[role="tab"][aria-selected="true"]')
        : hadFocus.option !== null ? [...scope.querySelectorAll('.bots-cards-option input')].find(input => input.value === hadFocus.option)
        : hadFocus.field ? [...scope.querySelectorAll('input, textarea')].find(input => (input.getAttribute('aria-label') || input.placeholder || '') === hadFocus.field.label) : null;
      target?.focus();
      if (target && hadFocus.field && typeof target.setSelectionRange === 'function') { try { target.setSelectionRange(hadFocus.field.start, hadFocus.field.end); } catch { /* not a text field */ } }
    }
    if (slot === 'transcript' && !view.change) mountChanges();
  }

  // The applied-change cards share the transcript slot (static/js/botsAutomationChangeCard.js).
  function mountChanges() {
    view.change = import('./botsAutomationChangeCard.js').then(async module => {
      if (view.disposed) return null;
      const place = h('div', { class: 'bots-cards-changes' });
      root.after(place);
      return module.mount(place, { ...ctx, signal: control.signal });
    }).catch(() => null);
  }

  const onEvent = () => refresh();
  document.addEventListener('kairos:bot-card', onEvent);
  document.addEventListener('kairos:bots-card-settled', onEvent);
  document.addEventListener('visibilitychange', onEvent);
  await refresh();

  return {
    refresh,
    dispose() {
      view.disposed = true;
      clearTimeout(view.timer);
      control.abort();
      ctx.signal?.removeEventListener('abort', onAbort);
      document.removeEventListener('kairos:bot-card', onEvent);
      document.removeEventListener('kairos:bots-card-settled', onEvent);
      document.removeEventListener('visibilitychange', onEvent);
      view.change?.then(handle => handle?.dispose?.());
      root.nextElementSibling?.classList.contains('bots-cards-changes') && root.nextElementSibling.remove();
      root.remove();
    },
  };
}


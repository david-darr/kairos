// The Bots Inbox (Agents 3.0 Phase 1, unit U5): everything waiting on the person,
// in Needs you / News / Done. A list, and a reading view for one item with the
// actions the server says are valid. Mounted by botsAttentionHost.js.
//
// Read and Done are personal filing: they never answer or approve anything. A
// reply, an approval or a permission answer goes to the real question, review or
// permission service; when that is stale or fails, the item stays open and the
// reason shows here.
import { icon } from './botsIcons.js';
import { Segmented } from './botsUi.js';
import {
  BASE, BUCKETS, ACTION_LABELS, bucketCounts, rowsFor, formatAge, kindLabel, hasAction, buildAnswers, h, errorText,
} from './botsAttentionHost.js';

export async function mount(root, ctx) {
  const view = { rows: [], counts: { 'needs-you': 0, news: 0, done: 0 }, bucket: 'needs-you', query: '', botId: ctx.args?.agentId || '',
    openId: '', busy: false, error: '', loaded: false, failed: false };
  let disposed = false;
  const list = h('div', { class: 'bots-attn-scroll' });
  root.replaceChildren(list);

  async function load() {
    try {
      const data = await ctx.get(`${BASE}/inbox`);
      if (disposed) return;
      const before = current()?.revision;
      view.rows = data.rows || []; view.counts = bucketCounts(view.rows); view.loaded = true; view.failed = false;
      ctx.setCounts({ inbox: data.count || 0 });
      // A poll that finds the open item unchanged must not rebuild it under a half-typed reply.
      if (view.openId && before && current()?.revision === before) return;
    } catch (error) {
      if (disposed) return;
      view.failed = true; view.error = errorText(error);
    }
    draw();
  }

  const current = () => view.rows.find(row => row.id === view.openId) || null;

  function draw() {
    if (disposed) return;
    const reading = view.openId ? current() : null;
    // The item left the inbox (answered elsewhere, expired): say so on the list.
    if (view.openId && !reading) { view.openId = ''; view.error = 'That item is no longer in your inbox.'; }
    list.replaceChildren(reading ? readingView(reading) : listView());
  }

  // -- list --------------------------------------------------------------------
  function listView() {
    const tabs = Segmented({
      label: 'Inbox sections', value: view.bucket,
      options: BUCKETS.map(bucket => ({ value: bucket.value, label: view.counts[bucket.value] ? `${bucket.label} ${view.counts[bucket.value]}` : bucket.label })),
      onChange: value => { view.bucket = value; draw(); },
    });
    tabs.classList.add('bots-attn-tabs');
    const search = h('input', { type: 'search', class: 'bots-attn-search', placeholder: 'Search the inbox', 'aria-label': 'Search the inbox', value: view.query });
    const results = h('div', { class: 'bots-attn-rows', role: 'list' });
    const fill = () => {
      const rows = rowsFor(view.rows, { bucket: view.bucket, query: view.query, botId: view.botId });
      results.replaceChildren(...(rows.length ? rows.map(rowButton) : [h('p', { class: 'bots-attn-note', text: emptyText() })]));
    };
    search.addEventListener('input', () => { view.query = search.value; fill(); });
    fill();
    return h('div', {}, [
      view.error ? h('p', { class: 'bots-attn-note error', role: 'alert', text: view.error }) : null,
      h('div', { class: 'bots-attn-tools' }, [tabs, search]),
      view.failed ? h('p', { class: 'bots-attn-note error', role: 'alert', text: 'The inbox could not load.' }) : results,
    ]);
  }
  const emptyText = () => view.query ? 'Nothing matches that search.' : !view.loaded ? 'Loading...' : {
    'needs-you': 'Nothing is waiting on you.', news: 'No news right now.', done: 'Nothing is done yet.',
  }[view.bucket];

  function rowButton(row) {
    const button = h('button', { type: 'button', class: `bots-attn-row${row.read ? '' : ' unread'}`, role: 'listitem', 'data-id': row.id, 'data-kind': row.kind }, [
      h('span', { class: 'bots-attn-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'bots-attn-row-main' }, [
        h('span', { class: 'bots-attn-row-top' }, [
          h('span', { class: 'bots-attn-sender', text: row.sender?.name || 'A bot' }),
          h('span', { class: 'bots-attn-age', text: formatAge(row.at) }),
        ]),
        h('span', { class: 'bots-attn-subject', text: row.subject }),
        row.snippet ? h('span', { class: 'bots-attn-snippet', text: row.snippet }) : null,
      ]),
      h('span', { class: 'bots-attn-kind', text: kindLabel(row.kind) }),
    ]);
    button.setAttribute('aria-label', `${row.read ? '' : 'Unread. '}${row.sender?.name || 'A bot'}: ${row.subject}`);
    button.addEventListener('click', () => openItem(row));
    return button;
  }

  async function openItem(row) {
    view.openId = row.id; view.error = '';
    draw();
    if (!row.read) {
      row.read = true;
      try { await ctx.post(`${BASE}/inbox/${encodeURIComponent(row.id)}/read`); } catch { row.read = false; }
    }
  }

  // -- reading -----------------------------------------------------------------
  function readingView(row) {
    const reply = h('textarea', { class: 'bots-attn-reply', rows: '3', 'aria-label': 'Your reply', placeholder: row.kind === 'review' ? 'What should change?' : 'Write a reply' });
    const status = h('p', { class: `bots-attn-note${view.error ? ' error' : ''}`, role: view.error ? 'alert' : 'status', text: view.error });
    const buttons = [];
    const act = async (action, extra = {}) => {
      if (view.busy) return;
      view.busy = true; view.error = '';
      buttons.forEach(button => { button.disabled = true; });
      try {
        await ctx.post(`${BASE}/inbox/${encodeURIComponent(row.id)}/respond`, { action, expected_revision: row.revision, ...extra });
        view.busy = false;
        await load();
        // Answered: the item moves to Done; go back to the list it left.
        view.openId = ''; view.error = ''; draw();
      } catch (error) {
        view.busy = false; view.error = errorText(error);
        status.textContent = view.error; status.className = 'bots-attn-note error'; status.setAttribute('role', 'alert');
        buttons.forEach(button => { button.disabled = false; });
        // The source may have changed under us: reread, and keep the item open if it still is.
        await load();
      }
    };
    const button = (label, onClick, variant = '') => {
      const node = h('button', { type: 'button', class: `bots-btn ${variant}`.trim(), text: label });
      node.addEventListener('click', onClick); buttons.push(node); return node;
    };

    const questions = hasAction(row, 'respond') ? questionForm(row, act, status, buttons) : null;
    const actions = [];
    if (hasAction(row, 'approve')) actions.push(button(ACTION_LABELS.approve, () => act('approve'), 'primary'));
    if (hasAction(row, 'allow')) actions.push(button('Allow once', () => act('allow'), 'primary'));
    if (hasAction(row, 'deny')) actions.push(button(ACTION_LABELS.deny, () => act('deny')));
    if (hasAction(row, 'skip')) actions.push(button(ACTION_LABELS.skip, () => act('skip')));
    if (hasAction(row, 'close')) actions.push(button('Close question', () => act('close')));

    const replyBlock = hasAction(row, 'reply') ? h('div', { class: 'bots-attn-replybox' }, [reply,
      button(row.kind === 'review' ? 'Request changes' : 'Send reply', () => {
        if (!reply.value.trim()) { view.error = 'Write a reply first.'; status.textContent = view.error; status.className = 'bots-attn-note error'; status.setAttribute('role', 'alert'); return; }
        act('reply', { text: reply.value });
      }, 'primary')]) : null;

    const back = h('button', { type: 'button', class: 'bots-back', 'data-action': 'back' }, [icon('arrow-left', { size: 14 }), 'Inbox']);
    back.addEventListener('click', () => { view.openId = ''; view.error = ''; draw(); });
    // An open question or approval is settled by its own buttons; Mark done would only hide it while the bot still waits.
    const asks = row.status === 'open' && (row.kind === 'question' || row.kind === 'approval');
    const filing = h('button', { type: 'button', class: 'bots-btn', text: row.done ? 'Move back to inbox' : 'Mark done', hidden: asks && !row.done });
    filing.addEventListener('click', async () => {
      try { await ctx.post(`${BASE}/inbox/${encodeURIComponent(row.id)}/${row.done ? 'reopen' : 'done'}`); view.openId = ''; await load(); }
      catch (error) { view.error = errorText(error); draw(); }
    });
    if (!filing.hidden) buttons.push(filing);
    const openChat = row.target ? h('button', { type: 'button', class: 'bots-btn', 'data-action': 'open-chat' }, [icon('message-square', { size: 16 }), 'Open in chat']) : null;
    openChat?.addEventListener('click', () => ctx.openTarget(row.target));

    const node = h('article', { class: 'bots-attn-read', 'data-id': row.id, tabindex: '-1' }, [
      back,
      h('header', { class: 'bots-attn-read-head' }, [
        h('span', { class: 'bots-caps', text: `${kindLabel(row.kind)} from ${row.sender?.name || 'a bot'}` }),
        h('h3', { class: 'bots-attn-read-title', text: row.subject }),
        h('span', { class: 'bots-attn-age', text: row.status === 'open' ? formatAge(row.at) : `${formatAge(row.at)}, answered` }),
      ]),
      row.body ? h('p', { class: 'bots-attn-body-text', text: row.body }) : null,
      row.answer ? h('p', { class: 'bots-attn-answer', text: `Your answer: ${row.answer}` }) : null,
      questions,
      actions.length ? h('div', { class: 'bots-attn-actions' }, actions) : null,
      replyBlock,
      status,
      h('div', { class: 'bots-attn-actions secondary' }, [openChat, filing]),
    ]);
    node.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); back.click(); }
    });
    queueMicrotask(() => node.focus());
    return node;
  }

  // A live question: each one is a set of options (or a typed answer).
  function questionForm(row, act, status, buttons) {
    const values = {};
    const form = h('div', { class: 'bots-attn-questions' });
    for (const [index, question] of (row.questions || []).entries()) {
      const name = `q${index}`;
      const group = h('fieldset', { class: 'bots-attn-question' }, [h('legend', { text: question.header ? `${question.header}: ${question.question}` : question.question })]);
      const typed = h('input', { type: 'text', class: 'bots-attn-search', placeholder: question.options?.length ? 'Or write your own' : 'Your answer', 'aria-label': `Answer for ${question.question}`, maxlength: '4000' });
      const chosen = new Set();
      for (const option of question.options || []) {
        const input = h('input', { type: question.multiSelect ? 'checkbox' : 'radio', name, value: option.label });
        input.addEventListener('change', () => {
          if (question.multiSelect) { input.checked ? chosen.add(option.label) : chosen.delete(option.label); }
          else { chosen.clear(); chosen.add(option.label); typed.value = ''; }
          values[question.question] = question.multiSelect ? [...chosen, ...(typed.value.trim() ? [typed.value.trim()] : [])] : [...chosen][0];
        });
        group.append(h('label', { class: 'bots-attn-option' }, [input, h('span', {}, [h('span', { text: option.label }), option.description ? h('small', { text: option.description }) : null])]));
      }
      typed.addEventListener('input', () => {
        if (!question.multiSelect) { group.querySelectorAll('input[type=radio]').forEach(r => { r.checked = false; }); chosen.clear(); values[question.question] = typed.value; }
        else values[question.question] = [...chosen, ...(typed.value.trim() ? [typed.value.trim()] : [])];
      });
      group.append(typed);
      form.append(group);
    }
    const send = h('button', { type: 'button', class: 'bots-btn primary', text: 'Send answers' });
    send.addEventListener('click', () => {
      const built = buildAnswers(row.questions, values);
      if (built.error) { view.error = built.error; status.textContent = built.error; status.className = 'bots-attn-note error'; status.setAttribute('role', 'alert'); return; }
      act('respond', { answers: built.answers });
    });
    buttons.push(send);
    form.append(send);
    return form;
  }

  await load();
  const timer = setInterval(() => { if (!view.busy && !document.hidden && !root.querySelector('textarea:focus, input:focus')) load(); }, 15000);
  return { dispose() { disposed = true; clearInterval(timer); }, refresh: load };
}

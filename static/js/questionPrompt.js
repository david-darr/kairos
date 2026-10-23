// Model output must stay text: questions, headers, labels and descriptions can contain markup.
import { api, el } from './api.js';

let current = null;
export function dismissQuestionPrompt(requestId = null) {
  if (!current || (requestId && current.id !== requestId)) return;
  current.dismiss();
  current = null;
}
document.addEventListener('kairos:permission-closed', event => dismissQuestionPrompt(event.detail.id));

export function showQuestionPrompt(request, onAnswered, { dock = null, mount = document.body } = {}) {
  dismissQuestionPrompt();
  const phoneSheet = document.documentElement?.classList.contains('kairos-redesign') && matchMedia('(max-width: 768px)').matches;
  const previous = document.activeElement;
  let sending = false, expired = false, removed = false, timer;
  const error = el('p', { role: 'alert', class: 'question-error' });
  const submit = el('button', { type: 'button', class: 'btn primary', text: 'Submit', disabled: true });
  const skip = el('button', { type: 'button', class: 'btn', text: 'Skip' });
  const body = el('div', { class: 'question-body' });
  const readers = [];
  const headingId = `question-title-${request.id}`;
  const head = el('div', { class: 'question-head' }, [el('span', { class: 'question-pulse', 'aria-hidden': 'true' }), el('h2', { id: headingId, text: 'Waiting for your response' })]);
  const chip = text => el('span', { class: 'question-chip', text });
  if (request.questions.length === 1 && request.questions[0].header) head.append(chip(request.questions[0].header));
  function answers() {
    const values = readers.map(read => read());
    return values.some(value => value === null) ? null : Object.fromEntries(request.questions.map((q, i) => [q.question, values[i]]));
  }
  function update() { submit.disabled = sending || expired || !answers(); }
  request.questions.forEach((q, i) => {
    const legend = el('legend', { text: q.question });
    if (request.questions.length > 1 && q.header) legend.append(chip(q.header));
    const item = el('fieldset', { class: 'question-item' }, [legend]);
    const options = [];
    function choice(label, description = '') {
      const input = el('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `question-${request.id}-${i}`, 'aria-label': label });
      input.addEventListener('change', update);
      const row = el('label', { class: 'question-option' }, [input, el('span', {}, [el('span', { text: label }), description ? el('span', { class: 'question-description', text: description }) : null])]);
      item.append(row);
      return input;
    }
    for (const option of q.options) options.push({ input: choice(option.label, option.description), label: option.label });
    const other = q.options.length ? choice('Other') : null;
    const text = el('input', { type: 'text', 'aria-label': other ? 'Other answer' : 'Your answer', placeholder: other ? 'Type your own answer' : 'Your answer', maxlength: '4000' });
    item.append(other ? text : el('label', { class: 'question-free' }, [el('span', { text: 'Your answer' }), text]));
    text.addEventListener('input', () => { if (other) other.checked = true; update(); });
    text.addEventListener('keydown', event => { if (event.key === 'Enter' && !submit.disabled) { event.preventDefault(); send(false); } });
    readers.push(() => {
      const value = text.value.trim();
      if (!other) return value || null;
      if (other.checked && !value) return null;
      const selected = options.filter(o => o.input.checked).map(o => o.label);
      if (other.checked) selected.push(value);
      const unique = [...new Set(selected)];
      return unique.length ? (q.multiSelect ? unique : unique[0]) : null;
    });
    body.append(item);
  });
  const footer = el('footer', { class: 'question-footer' }, [error,
    el('p', { class: 'muted', text: request.expires_at ? `Waiting until ${new Date(request.expires_at * 1000).toLocaleTimeString()}` : '' }),
    dock && !phoneSheet ? null : el('p', { class: 'muted', text: 'Closing skips the question.' }),
    el('div', { class: 'question-actions' }, [skip, submit])]);
  const card = el('section', { class: 'question-card', role: 'region', 'aria-labelledby': headingId }, [head, body, footer]);
  const dialog = dock && !phoneSheet ? null : el('dialog', { class: 'question-dialog' }, [card]);
  let disposeSurface = () => {};
  if (dialog && phoneSheet) {
    // The docked/desktop question has no phone gesture dependency.
    import('./mobileSheet.js').then(({ mountSheetSurface }) => {
      if (!removed) disposeSurface = mountSheetSurface(dialog, closePhoneSheet);
    });
    head.append(el('button', { type: 'button', class: 'ms-sheet-close', text: 'Close', onclick: closePhoneSheet }));
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientY < r.top || event.clientX < r.left || event.clientX > r.right || event.clientY > r.bottom) closePhoneSheet();
    });
  }
  function closePhoneSheet() {
    if (expired) dismissQuestionPrompt(request.id); else send(true);
  }
  function dismiss() {
    const hadFocus = (dialog || card).contains(document.activeElement);
    removed = true;
    clearTimeout(timer);
    disposeSurface();
    if (dialog) { dialog.close(); dialog.remove(); } else { card.remove(); dock.hidden = true; dock.replaceChildren(); }
    if (dialog && dock) dock.hidden = true;
    if (hadFocus && previous?.isConnected) previous.focus();
  }
  async function send(isSkip) {
    if (sending || expired || removed) return;
    const value = answers();
    if (!isSkip && !value) return;
    sending = true; skip.disabled = true; update(); error.textContent = '';
    try {
      await api(`/api/permissions/${encodeURIComponent(request.id)}/respond`, { method: 'POST', body: JSON.stringify(isSkip ? { skip: true } : { answers: value }) });
      onAnswered?.(); dismissQuestionPrompt(request.id);
    } catch (problem) {
      sending = false; skip.disabled = expired; update(); error.textContent = problem.message;
      if (dialog && !dialog.open && !removed) dialog.showModal();
    }
  }
  submit.addEventListener('click', () => send(false));
  skip.addEventListener('click', () => send(true));
  if (dialog) {
    dialog.addEventListener('cancel', event => { event.preventDefault(); send(true); });
    dialog.addEventListener('close', () => { if (!removed) send(true); });
    // Keep the chat's live region and composer ownership on phones too. The
    // native dialog supplies the top layer without moving the card out of its host.
    if (dock) { dock.replaceChildren(dialog); dock.hidden = false; } else mount.append(dialog);
    dialog.showModal();
  } else { dock.replaceChildren(card); dock.hidden = false; }
  current = { id: request.id, dismiss };
  if (request.expires_at) timer = setTimeout(() => {
    expired = true;
    for (const input of card.querySelectorAll('input, button')) if (input.className !== 'ms-sheet-close') input.disabled = true;
    error.textContent = 'This question has expired.';
  }, Math.max(0, request.expires_at * 1000 - Date.now()));
  if (!previous?.isContentEditable && !previous?.matches('input, textarea')) card.querySelector('input')?.focus();
  return card;
}

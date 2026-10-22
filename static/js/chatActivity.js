import { el } from './api.js';
import { stepRow } from './runTimeline.js';
import { createMascot } from './mascot.js';

// The marker is Kairos's mascot while the switch is on (Kairos Mascot build
// spec, 2026-10-22): thinking while the reply streams, success once when it
// completes (it settles to idle by itself), error on a failed turn. The glyph
// beside it is the marker as before; mascot.css shows one or the other.
const MASCOT_STATE = { sending: 'thinking', waiting: 'thinking', responding: 'thinking', done: 'success', failed: 'error', stopped: 'idle' };

// This is transport progress, not a model's private reasoning. Each state
// comes from the real stream and survives view remounts through chatStream.
export function createChatActivity() {
  const label = el('span', { class: 'chat-activity-label', role: 'status', 'aria-live': 'polite' });
  const glyph = el('span', { class: 'chat-activity-glyph' });
  const mascot = createMascot({ state: 'thinking', size: 22 });
  const marker = el('span', { class: 'chat-activity-marker', 'aria-hidden': 'true' }, [glyph, mascot]);
  const summary = el('summary', {}, [marker, label, el('span', { class: 'chat-activity-chevron', text: '⌄', 'aria-hidden': 'true' })]);
  const list = el('ol', { class: 'chat-activity-steps' });
  const rows = ['Request sent', 'Response started', 'Response complete'].map(text => {
    const row = el('li', {}, [el('span', { class: 'chat-step-marker', 'aria-hidden': 'true' }), el('span', { text })]);
    list.append(row); return row;
  });
  const node = el('details', { class: 'chat-activity' }, [summary, list]);
  let previous = '';
  let computerCount = 0;
  function update(entry) {
    for (const step of (entry.toolEvents || []).slice(computerCount)) {
      list.append(el('li', { class: 'chat-computer-step' }, [stepRow(step)]));
      node.open = true;
    }
    computerCount = (entry.toolEvents || []).length;
    const state = entry.status === 'failed' ? 'failed' : entry.status === 'stopped' ? 'stopped' : entry.status === 'done' ? 'done' : entry.text ? 'responding' : entry.connected ? 'waiting' : 'sending';
    if (state === previous) return;
    previous = state; node.dataset.state = state;
    label.textContent = { sending: 'Sending request', waiting: 'Waiting for response', responding: 'Receiving response', done: 'Response complete', failed: 'Response interrupted' }[state];
    glyph.textContent = state === 'done' ? '✓' : state === 'failed' ? '!' : state === 'stopped' ? '■' : '';
    mascot.setAttribute('state', MASCOT_STATE[state]);
    const complete = [!!entry.connected, !!entry.text, state === 'done'];
    rows.forEach((row, index) => {
      row.dataset.state = complete[index] ? 'done' : state === 'failed' ? 'stopped' : index === complete.findIndex(value => !value) ? 'active' : 'pending';
      row.firstChild.textContent = complete[index] ? '✓' : '·';
    });
    rows[2].lastChild.textContent = state === 'failed' ? 'Response interrupted' : 'Response complete';
    rows[0].lastChild.textContent = entry.connected ? 'Request sent' : 'Sending request';
    rows[1].lastChild.textContent = entry.text ? 'Response started' : state === 'done' ? 'No response text' : 'Waiting for response';
    if (entry.status === 'processing') rows[2].lastChild.textContent = entry.text ? 'Receiving response' : 'Finish response';
  }
  return { node, update };
}

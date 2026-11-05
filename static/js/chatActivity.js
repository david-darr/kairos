import { el } from './api.js';
import { stepRow } from './runTimeline.js';
import { createMascot } from './mascot.js';
import { lastContact } from './chatStream.js';
import { waitNotice } from './waitNotice.js';

// The marker is Kairos's mascot while the switch is on (Kairos Mascot build
// spec, 2026-10-22): thinking while the reply streams, success once when it
// completes (it settles to idle by itself), error on a failed turn. The glyph
// beside it is the marker as before; mascot.css shows one or the other.
const MASCOT_STATE = { sending: 'thinking', waiting: 'thinking', responding: 'thinking', done: 'success', failed: 'error', stopped: 'idle', disconnected: 'idle' };

// This is transport progress, not a model's private reasoning. Each state
// comes from the real stream and survives view remounts through chatStream.
export function createChatActivity() {
  const label = el('span', { class: 'chat-activity-label', role: 'status', 'aria-live': 'polite' });
  const glyph = el('span', { class: 'chat-activity-glyph' });
  const mascot = createMascot({ state: 'thinking', size: 22 });
  const marker = el('span', { class: 'chat-activity-marker', 'aria-hidden': 'true' }, [glyph, mascot]);
  const summary = el('summary', {}, [marker, label, el('span', { class: 'chat-activity-chevron', text: '⌄', 'aria-hidden': 'true' })]);
  const detail = el('span', { class: 'chat-activity-detail' });
  detail.hidden = true;
  label.after(detail);
  const list = el('ol', { class: 'chat-activity-steps' });
  const rows = ['Request sent', 'Response started', 'Response complete'].map(text => {
    const row = el('li', {}, [el('span', { class: 'chat-step-marker', 'aria-hidden': 'true' }), el('span', { text })]);
    list.append(row); return row;
  });
  const node = el('details', { class: 'chat-activity' }, [summary, list]);
  let previous = '';
  let computerCount = 0;
  // One 1 s timer per live chip, no network: it lets the "still waiting" clock
  // tick and notices the feed going quiet (no packet arrives to trigger update).
  let latest = null;
  let timer = null;
  let noticeOn = false;
  const stop = () => { clearInterval(timer); timer = null; };
  function update(entry) {
    latest = entry;
    render();
    if (entry.status === 'processing' && !timer) {
      timer = setInterval(() => { if (node.isConnected === false) stop(); else render(); }, 1000);
    } else if (entry.status !== 'processing') stop();
  }
  function render() {
    const entry = latest;
    const notice = waitNotice(entry, Date.now(), lastContact());
    if (notice) label.textContent = notice.label;
    const shown = notice?.detail || '';
    if (detail.textContent !== shown) detail.textContent = shown;
    detail.hidden = !shown;
    if (noticeOn && !notice) previous = '';  // back to the plain label for whatever state it is now
    noticeOn = !!notice;
    // Computer steps join the list but never open it: the card stays collapsed until the person opens it.
    for (const step of (entry.toolEvents || []).slice(computerCount)) {
      list.append(el('li', { class: 'chat-computer-step' }, [stepRow(step)]));
    }
    computerCount = (entry.toolEvents || []).length;
    const state = notice?.state === 'disconnected' ? 'disconnected' : entry.status === 'failed' ? 'failed' : entry.status === 'stopped' ? 'stopped' : entry.status === 'done' ? 'done' : entry.text ? 'responding' : entry.connected ? 'waiting' : 'sending';
    rows[1].lastChild.textContent = entry.text ? 'Response started' : state === 'done' ? 'No response text' : notice?.detail ? `Waiting for response · ${notice.detail}` : 'Waiting for response';
    if (state === previous) return;
    previous = state; node.dataset.state = state;
    label.textContent = notice?.label || { sending: 'Sending request', waiting: 'Waiting for response', responding: 'Receiving response', done: 'Response complete', failed: 'Response interrupted', stopped: 'Stopped' }[state];
    glyph.textContent = state === 'done' ? '✓' : state === 'failed' || state === 'disconnected' ? '!' : state === 'stopped' ? '■' : '';
    mascot.setAttribute('state', MASCOT_STATE[state]);
    const complete = [!!entry.connected, !!entry.text, state === 'done'];
    rows.forEach((row, index) => {
      row.dataset.state = complete[index] ? 'done' : state === 'failed' ? 'stopped' : index === complete.findIndex(value => !value) ? 'active' : 'pending';
      row.firstChild.textContent = complete[index] ? '✓' : '·';
    });
    rows[2].lastChild.textContent = state === 'failed' ? 'Response interrupted' : 'Response complete';
    rows[0].lastChild.textContent = entry.connected ? 'Request sent' : 'Sending request';
    if (entry.status === 'processing') rows[2].lastChild.textContent = entry.text ? 'Receiving response' : 'Finish response';
  }
  return { node, update, dispose: stop };
}

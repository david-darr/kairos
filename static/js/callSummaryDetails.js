// One message per call (2026-11-11, David: "too many end-of-call summary messages"). The bot's chat gets a short summary;
// the call's transcript, latency and work open from that one message (services/agent_calls.call_details), folded.
// Used by the Bots chat (botsTranscript.js), the classic agent chat (sessionChat.js) and a room's call chip.

const TRANSCRIPT_MARK = '\n\n**Transcript**\n\n';

// The summary text and its details. A summary saved before 2026-11-11 carried the transcript in its text: that part is
// folded the same way, so old calls stop reading as a run of messages too.
export function callSummaryParts(message) {
  const content = String(message?.content ?? message?.text ?? '');
  const details = message?.call_details || message?.meta?.details;
  if (details && typeof details === 'object') return { summary: content, details };
  const at = content.indexOf(TRANSCRIPT_MARK);
  if (at < 0) return { summary: content, details: null };
  return { summary: content.slice(0, at), details: { transcript: content.slice(at + TRANSCRIPT_MARK.length) } };
}

export function callLength(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const minutes = Math.floor(seconds / 60), rest = Math.round(seconds % 60);
  return minutes ? `${minutes} min${rest ? ` ${rest} s` : ''}` : `${rest} s`;
}

// The fold under the summary, or null when there is nothing to open. `render(node, markdown)` draws the transcript with
// the chat's own markdown renderer.
export function callDetailsNode(details, render, doc = document) {
  if (!details || typeof details !== 'object') return null;
  const make = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const lines = [];
  const length = callLength(details.seconds);
  if (length) lines.push(make('p', 'call-summary-line', `Length: ${length}.`));
  if (details.latency) lines.push(make('p', 'call-summary-line', String(details.latency)));
  if (details.note) lines.push(make('p', 'call-summary-line', String(details.note)));
  const work = Array.isArray(details.work) ? details.work.filter(job => job && job.title) : [];
  if (work.length) {
    const list = make('ul', 'call-summary-work');
    for (const job of work) list.append(make('li', '', `${job.title}: ${job.status || 'unknown'}`));
    lines.push(make('p', 'call-summary-label', 'Work'), list);
  }
  const transcript = typeof details.transcript === 'string' ? details.transcript.trim() : '';
  if (transcript) {
    const body = make('div', 'call-summary-transcript');
    try { render(body, transcript); } catch { body.textContent = transcript; }
    lines.push(make('p', 'call-summary-label', 'Transcript'), body);
  }
  if (!lines.length) return null;
  const box = make('details', 'call-summary-details');
  box.append(make('summary', '', transcript ? 'Transcript and details' : 'Details'), ...lines);
  return box;
}

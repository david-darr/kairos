// What the chat activity chip says when a reply is slow or the feed goes quiet.
// Pure so it can be tested without a DOM. `now` and `lastContact` are
// millisecond timestamps; entry.waitingSince is the server's seconds clock.
export const WAIT_NOTICE_SECONDS = 60;
export const LOST_CONTACT_SECONDS = 30;

export function formatWait(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

// null while nothing is unusual, else { state, label, detail }.
export function waitNotice(entry, now, lastContact) {
  if (!entry || entry.status !== 'processing') return null;
  if (entry.turnId && lastContact && now - lastContact > LOST_CONTACT_SECONDS * 1000) {
    return { state: 'disconnected', label: 'Lost contact with Kairos', detail: '' };
  }
  if (entry.text || entry.permission || !entry.connected || !entry.waitingSince) return null;
  const waited = now / 1000 - entry.waitingSince;
  if (waited < WAIT_NOTICE_SECONDS) return null;
  return { state: 'waiting', label: `Still waiting on ${entry.provider || 'the model'} · ${formatWait(waited)}`, detail: entry.providerDetail || '' };
}

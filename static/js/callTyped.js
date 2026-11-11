// Texts typed during a live call (2026-11-10, from the Hermes call repos audit: texts that arrive during a call are read
// into the call). The call screen (agentCall.js) registers its conversation while a call is live; the bot chat's
// composer (botsChat.js) asks here first, so a plain message typed in that conversation goes into the call and is
// answered aloud, and lands in the call transcript that is saved to the chat afterwards. Tiny on purpose: the composer
// must not load the call screen to ask.
const live = new Map();   // conversation id -> send(text) => Promise<boolean>

export function registerTyped(sessionId, send) {
  if (!sessionId || typeof send !== 'function') return () => {};
  live.set(String(sessionId), send);
  return () => { if (live.get(String(sessionId)) === send) live.delete(String(sessionId)); };
}

export function callTakesTyped(sessionId) { return live.has(String(sessionId || '')); }

// True when the call took it; false (no live call here, or it could not) and the composer sends it as usual.
export async function routeTyped(sessionId, text) {
  const send = live.get(String(sessionId || ''));
  if (!send || !String(text || '').trim()) return false;
  try { return (await send(String(text))) === true; } catch { return false; }
}

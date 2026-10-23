// The design pane opens beside its chat as soon as there is a design (David,
// 2026-10-22: "currently it waits until the chat is done to display it").
//
// Why it waited: nothing opened the pane on its own. The only way in was the
// design card, which appears where the model writes the design's link, and
// models write that link at the end of their reply. The design itself exists
// as soon as design_create runs, and its design_changed event reaches the page
// then, but (a) design_create's event carried no chat id (design_store.create
// never passed one), and (b) no one listened for it to open the pane.
//
// Now: the first design_changed for a design made in the chat on screen opens
// it in the Documents pane (no focus taken from the composer), and each board
// the model adds after that redraws live. A chat in Design mode shows a
// placeholder in the pane as its turn starts, before the first board exists.
// A phone keeps the conversation full screen; the card opens the design there.
import { api } from './api.js';
import { getInFlight, subscribeAll } from './chatStream.js';
import { mobileOn } from './mobileShared.js';

export function installDesignAutoOpen({ currentSession, openDesign, isOpen, showPlaceholder, clearPlaceholder }) {
  const opened = new Set();  // Designs opened for you this visit: closing one is respected.
  document.addEventListener('kairos:design-changed', event => {
    const packet = event.detail || {};
    if (packet.quiet || !packet.designId || !packet.sessionId || mobileOn()) return;
    if (packet.sessionId !== currentSession() || opened.has(packet.designId)) return;
    opened.add(packet.designId);
    if (!isOpen(packet.sessionId, packet.designId)) openDesign(packet.sessionId, packet.designId);
  });
  const seen = new WeakSet();
  subscribeAll(async (sessionId, entry) => {
    if (!entry) return;
    if (entry.status !== 'processing') { clearPlaceholder(sessionId); return; }
    if (seen.has(entry) || sessionId !== currentSession() || mobileOn()) return;
    seen.add(entry);
    const mode = await api(`/api/designs/mode/${encodeURIComponent(sessionId)}`).catch(() => null);
    if (!mode?.design_mode) return;
    const linked = await api(`/api/designs?chat=${encodeURIComponent(sessionId)}`).catch(() => null);
    if (!Array.isArray(linked)) return;
    if (sessionId !== currentSession() || getInFlight(sessionId)?.status !== 'processing') return;
    // A Design-mode chat with its design already made: that design, open at once.
    if (linked.length) {
      if (!opened.has(linked[0].id) && !isOpen(sessionId, linked[0].id)) { opened.add(linked[0].id); openDesign(sessionId, linked[0].id); }
      return;
    }
    showPlaceholder(sessionId);
  });
}

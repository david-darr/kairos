// What the notch may ask the main window to do. The notch page is Kairos's own
// but it shows calendar titles, so everything it sends is checked again here:
// a known target, and for a chat only a session id or a draft to review (the
// draft is placed in the composer and never sent).
const TARGETS = ["home", "chat", "settings", "notes", "talk", "attach"];
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DRAFT_MAX = 600;

function navigation(target, detail) {
  if (!TARGETS.includes(target)) return null;
  const clean = {};
  if (target === "chat" && detail && typeof detail === "object") {
    if (typeof detail.sessionId === "string" && SESSION_ID.test(detail.sessionId)) clean.sessionId = detail.sessionId;
    else if (typeof detail.draft === "string" && detail.draft.trim()) clean.draft = detail.draft.slice(0, DRAFT_MAX);
  }
  return { target, detail: clean };
}
module.exports = { TARGETS, navigation };

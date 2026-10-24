// Pure layout state; the existing artifact resizer owns the column width.
export const clampSplit = value => Math.max(20, Math.min(80, value == null || value === '' || !Number.isFinite(Number(value)) ? 62 : Number(value)));
export const maximumChatWidth = hostWidth => Math.max(380, Math.min(Math.floor(hostWidth * 0.7), hostWidth - 332));
export const clampChatWidth = (hostWidth, value) => Math.max(380, Math.min(maximumChatWidth(hostWidth), value));
export function createPaneState(storage, key = 'kairos:chat-pane-split') {
  let split = 62;
  try { split = clampSplit(storage.getItem(key)); } catch { /* Optional storage. */ }
  const open = [];
  return {
    open,
    get split() { return split; },
    show(kind) { if (!open.includes(kind)) open.push(kind); },
    close(kind) { const i = open.indexOf(kind); if (i >= 0) open.splice(i, 1); },
    resize(value) { split = clampSplit(value); try { storage.setItem(key, String(split)); } catch { /* Optional storage. */ } return split; },
  };
}

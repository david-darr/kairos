// Keep the reader's place when document panes reflow the chat column.
const live = new Set();
export function holdReadingPositions() {
  for (const helper of live) helper.hold();
}

export function keepReadingPosition(scroller, { pinned } = {}) {
  let lastWidth = null, atBottom = true, anchor = null, frame = 0;
  let held = false, heldUntil = 0, releaseTimer = 0;
  const candidates = '.msg, .forge-prompt, .forge-turn, .msg-body > *, .chat-prose > *, .forge-prose > *, .artifact-card, li, tr, pre';
  function lineTop(node, offset) {
    const range = document.createRange();
    range.setStart(node, offset); range.setEnd(node, Math.min(offset + 1, node.length));
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect.top : null;
  }
  function capture() {
    // Keep the pre-resize anchor until the observer has restored it.
    if (!scroller.clientHeight || scroller.clientWidth !== lastWidth) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
    const rect = scroller.getBoundingClientRect(), top = rect.top;
    const x = rect.left + scroller.clientWidth / 2, y = top + scroller.clientHeight / 2;
    for (const fraction of [0.5, 0.25, 0.75]) {
      const hitX = rect.left + scroller.clientWidth * fraction;
      const caret = document.caretRangeFromPoint?.(hitX, y) ?? document.caretPositionFromPoint?.(hitX, y);
      const node = caret?.startContainer ?? caret?.offsetNode, offset = caret?.startOffset ?? caret?.offset;
      if (node?.nodeType !== Node.TEXT_NODE || !scroller.contains(node)) continue;
      const line = lineTop(node, offset);
      if (line !== null) { anchor = { node, offset, top: line - top }; return; }
    }
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== scroller && scroller.contains(hit)) {
      const el = hit.closest(candidates) || hit;
      if (scroller.contains(el)) { anchor = { el, top: el.getBoundingClientRect().top - top }; return; }
    }
    // Empty space can still use the innermost block crossing the top edge.
    let crossing = null, below = null;
    for (const node of scroller.querySelectorAll(candidates)) {
      const rect = node.getBoundingClientRect();
      if (rect.top > top + scroller.clientHeight) break;
      if (rect.bottom <= top + 1) continue;
      const candidate = { el: node, top: rect.top - top };
      if (rect.top <= top + 1) crossing = candidate;
      else if (!below) below = candidate;
    }
    anchor = crossing || below;
  }
  const release = () => { clearTimeout(releaseTimer); held = false; capture(); };
  const helper = { hold() {
    if (!scroller.clientHeight || !scroller.isConnected) return;
    // One pane change can hold several times (mount, then setMaximized after
    // the split's first layout); keep the first, pre-change position.
    if (held && performance.now() <= heldUntil) return;
    // Native anchoring in the split's first layout can move scrollTop before
    // any observable width change, so capture synchronously before mounting.
    cancelAnimationFrame(frame); frame = 0;
    clearTimeout(releaseTimer);
    lastWidth = scroller.clientWidth;
    capture();
    held = true; heldUntil = performance.now() + 1000;
  } };
  live.add(helper);
  const scheduleCapture = () => {
    if (held && performance.now() > heldUntil) release();
    if (!held && !frame) frame = requestAnimationFrame(() => { frame = 0; if (!held) capture(); });
  };
  scroller.addEventListener('scroll', scheduleCapture, { passive: true });
  scheduleCapture();
  const observer = new ResizeObserver(() => {
    const width = scroller.clientWidth;
    if (lastWidth === null) { lastWidth = width; return; }
    if (width === lastWidth) return;
    if (held) {
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(release, 400); // Release after the latest width change settles.
    }
    if (width > 0) {
      if (held ? atBottom : (pinned?.() ?? atBottom)) scroller.scrollTop = scroller.scrollHeight;
      else if (anchor && (anchor.node || anchor.el).isConnected && scroller.contains(anchor.node || anchor.el)) {
        const top = anchor.node ? lineTop(anchor.node, anchor.offset) : anchor.el.getBoundingClientRect().top;
        if (top !== null) scroller.scrollTop += top - scroller.getBoundingClientRect().top - anchor.top;
      }
    }
    lastWidth = width;
    if (width > 0 && !held) capture();
  });
  observer.observe(scroller);
  return () => {
    live.delete(helper);
    clearTimeout(releaseTimer);
    cancelAnimationFrame(frame);
    observer.disconnect();
    scroller.removeEventListener('scroll', scheduleCapture);
  };
}

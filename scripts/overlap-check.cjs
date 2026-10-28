// No overlapping controls or spilling text in a chat and its side windows (David, 2026-10-28:
// "no matter the size they get shrunken to, there is no overlapping text or buttons").
// `OVERLAP` is a page expression returning { overlaps, spills } for the chat, its header, the
// side-pane stack and the history popout. Message bodies, design boards and document previews
// are content, not chrome, and are left out; so is anything scrolled out of its container.
const OVERLAP = `(() => {
  const roots = [...document.querySelectorAll('#chat-main, .chat-pane-stack, #rd-history, .chat-mobile-header, .artifact-panel')].filter(r => r.getClientRects().length);
  const visible = n => { const s = getComputedStyle(n); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false; const r = n.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  // The part of an element actually on screen: its box cut to every scrolling or clipping ancestor.
  const shown = n => { let r = n.getBoundingClientRect(); let box = { l: r.left, t: r.top, r: r.right, b: r.bottom }; for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(hidden|auto|scroll|clip)/.test(s.overflow + s.overflowX + s.overflowY)) { const q = p.getBoundingClientRect(); box = { l: Math.max(box.l, q.left), t: Math.max(box.t, q.top), r: Math.min(box.r, q.right), b: Math.min(box.b, q.bottom) }; } } return box.r - box.l > 1 && box.b - box.t > 1 ? box : null; };
  const clipped = n => !shown(n);
  const label = n => (n.id ? '#' + n.id : '') + '.' + String(n.className || n.tagName).trim().split(/\\s+/).slice(0, 2).join('.') + ' "' + (n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 24) + '"';
  const out = { overlaps: [], spills: [] };
  for (const root of roots) {
    const items = [...root.querySelectorAll('button, input, select, textarea, [role=tab], a, .model-mark, .rd-forge-tag, .context-pill, .chat-prompt-chip, .rd-chat-title, .artifact-tab-label, .chat-pane-heading, .bg-task-row strong, h1, h2, h3, .workspace-pill')]
      .filter(n => visible(n) && !n.closest('.hidden, [hidden], .overflow-menu, .model-picker-menu, .chat-permission-menu, .msg, .design-board, .design-viewport, iframe, .artifact-preview'));
    const boxes = items.map(n => [n, shown(n)]).filter(([, r]) => r);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [a, ra] = boxes[i], [b, rb] = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const w = Math.min(ra.r, rb.r) - Math.max(ra.l, rb.l), h = Math.min(ra.b, rb.b) - Math.max(ra.t, rb.t);
      if (w > 3 && h > 3) out.overlaps.push(label(a) + ' x ' + label(b));
    }
    for (const n of root.querySelectorAll('*')) {
      if (!visible(n) || n.closest('.msg, .design-board, .design-viewport, iframe, .chat-code-block pre, .artifact-preview, .overflow-menu, .model-picker-menu, [hidden], .hidden')) continue;
      if (n.children.length && ![...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) continue;
      const s = getComputedStyle(n);
      if (n.scrollWidth > n.clientWidth + 2 && s.overflowX === 'visible' && s.textOverflow !== 'ellipsis' && !['TEXTAREA', 'INPUT'].includes(n.tagName)) {
        if (!clipped(n)) out.spills.push(label(n) + ' ' + n.scrollWidth + '>' + n.clientWidth);
      }
    }
  }
  return { overlaps: [...new Set(out.overlaps)], spills: [...new Set(out.spills)] };
})()`;

// Walk window sizes and both dividers to their limits, with and without the history popout,
// and fail on the first layout with overlapping chrome.
async function sweepChatFit({ js, win, delay, assert, sizes = [[1920, 1080], [1440, 900], [1280, 800], [1120, 760]] }) {
  const key = (selector, name, times) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}); if (!r) return false; r.focus(); for (let i = 0; i < ${times}; i++) r.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true })); return true; })()`);
  for (const [width, height] of sizes) {
    win.setContentSize(width, height); await delay(400);
    const steps = [['default', null], ['pane widest', ['.chat-pane-resizer', 'ArrowLeft', 60]], ['pane narrowest', ['.chat-pane-resizer', 'ArrowRight', 120]],
      ['top pane smallest', ['.chat-pane-stack-resizer', 'Home', 1]], ['bottom pane smallest', ['.chat-pane-stack-resizer', 'End', 1]]];
    for (const [name, step] of steps) {
      if (step) await key(...step);
      await delay(350);
      const found = await js(OVERLAP);
      assert.deepEqual(found, { overlaps: [], spills: [] }, `No overlapping or spilling chrome at ${width}x${height}, ${name}`);
    }
    await js("document.querySelector('.rd-history-trigger, #chat-history-toggle')?.click(); true"); await delay(450);
    assert.deepEqual(await js(OVERLAP), { overlaps: [], spills: [] }, `No overlap at ${width}x${height} with chat history docked`);
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true"); await delay(300);
  }
}

module.exports = { OVERLAP, sweepChatFit };

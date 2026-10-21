// Keeps a popup menu inside the window. The menu is clamped to the room on
// the side it opens toward, and flips to the side with more room when its
// content would not fit on the preferred one. Menu content scrolls inside
// the clamp (see .model-picker-unified in chat.css). Open menus are re-fitted
// when the window is resized.
const open = new Map(); // menu -> refit()

addEventListener("resize", () => {
  for (const [menu, refit] of open) {
    if (!menu.isConnected || menu.classList.contains("hidden")) open.delete(menu);
    else refit();
  }
});

export function fitMenu(menu, anchor, { prefer = "below", fixed = false, gap = 10, margin = 12, cap = 480, keepSide = false } = {}) {
  const run = () => {
    if (!menu.isConnected || menu.classList.contains("hidden") || !anchor.isConnected) return;
    const a = anchor.getBoundingClientRect();
    const vh = document.documentElement.clientHeight || innerHeight;
    const vw = document.documentElement.clientWidth || innerWidth;
    const room = { above: a.top - gap - margin, below: vh - a.bottom - gap - margin };
    menu.style.maxHeight = "none";
    menu.style.maxWidth = `${vw - margin * 2}px`;
    menu.style.transform = "";
    const frame = menu.offsetHeight - menu.clientHeight;
    const want = Math.min(cap, menu.scrollHeight + frame);
    const other = prefer === "below" ? "above" : "below";
    const side = room[prefer] >= want || room[prefer] >= room[other] ? prefer : other;
    menu.style.maxHeight = `${Math.max(96, Math.floor(Math.min(cap, room[side])))}px`;
    if (fixed) {
      menu.style.position = "fixed";
      menu.style.top = side === "below" ? `${a.bottom + gap}px` : "auto";
      menu.style.bottom = side === "below" ? "auto" : `${vh - a.top + gap}px`;
      menu.style.right = "auto";
      const w = menu.getBoundingClientRect().width;
      menu.style.left = `${Math.max(margin, Math.min(a.right - w, vw - w - margin))}px`;
    } else {
      menu.style.position = "absolute";
      menu.style.top = side === "below" ? `calc(100% + ${gap}px)` : "auto";
      menu.style.bottom = side === "below" ? "auto" : `calc(100% + ${gap}px)`;
      if (!keepSide) { menu.style.left = "auto"; menu.style.right = "0"; }
      const r = menu.getBoundingClientRect();
      const shift = r.left < margin ? margin - r.left : Math.min(0, vw - margin - r.right);
      if (shift) menu.style.transform = `translateX(${shift}px)`;
    }
    menu.dataset.opens = side;
  };
  open.set(menu, run);
  run();
  // Content rebuilt or filtered while open: fit again, once per frame.
  if (menu._fitWatch) menu._fitWatch.disconnect();
  let queued = false;
  menu._fitWatch = new MutationObserver(() => {
    if (queued || menu.classList.contains("hidden")) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; if (open.get(menu) === run) run(); });
  });
  menu._fitWatch.observe(menu, { childList: true, subtree: true });
}

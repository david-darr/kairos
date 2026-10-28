// Keeps a popup menu inside the window, and sideways inside the chat (or page) it belongs to, so
// the sidebar, the chat history popout and the side panes never cover it (desktop redesign). The menu is clamped to the room on
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

// `clear`: an element the menu must not cover (the prompt card a pill sits in), so the menu
// opens beyond that element's edge rather than just beyond the anchor's.
export function fitMenu(menu, anchor, { prefer = "below", fixed = false, gap = 10, margin = 12, cap = 480, keepSide = false, clear = null } = {}) {
  const run = () => {
    if (!menu.isConnected || menu.classList.contains("hidden") || !anchor.isConnected) return;
    const a = anchor.getBoundingClientRect();
    const c = clear?.isConnected ? clear.getBoundingClientRect() : a;
    // An absolute menu's 100% is its positioned ancestor's box, which may be the anchor or the card itself.
    const box = (!fixed && menu.offsetParent ? menu.offsetParent : anchor).getBoundingClientRect();
    const reachAbove = gap + Math.max(0, box.top - c.top), reachBelow = gap + Math.max(0, c.bottom - box.bottom);
    const vh = document.documentElement.clientHeight || innerHeight;
    const vw = document.documentElement.clientWidth || innerWidth;
    const room = { above: c.top - gap - margin, below: vh - c.bottom - gap - margin };
    const host = menu.closest("#chat-main, #content")?.getBoundingClientRect();
    const minX = Math.max(0, host ? host.left : 0) + margin, maxX = Math.min(vw, host ? host.right : vw) - margin;
    menu.style.maxHeight = "none";
    menu.style.maxWidth = `${Math.max(160, maxX - minX)}px`;
    menu.style.transform = "";
    const frame = menu.offsetHeight - menu.clientHeight;
    const want = Math.min(cap, menu.scrollHeight + frame);
    const other = prefer === "below" ? "above" : "below";
    const side = room[prefer] >= want || room[prefer] >= room[other] ? prefer : other;
    menu.style.maxHeight = `${Math.max(96, Math.floor(Math.min(cap, room[side])))}px`;
    if (fixed) {
      menu.style.position = "fixed";
      menu.style.top = side === "below" ? `${c.bottom + gap}px` : "auto";
      menu.style.bottom = side === "below" ? "auto" : `${vh - c.top + gap}px`;
      menu.style.right = "auto";
      const w = menu.getBoundingClientRect().width;
      menu.style.left = `${Math.max(minX, Math.min(a.right - w, maxX - w))}px`;
    } else {
      menu.style.position = "absolute";
      menu.style.top = side === "below" ? `calc(100% + ${reachBelow}px)` : "auto";
      menu.style.bottom = side === "below" ? "auto" : `calc(100% + ${reachAbove}px)`;
      if (!keepSide) { menu.style.left = "auto"; menu.style.right = "0"; }
      const r = menu.getBoundingClientRect();
      const shift = r.left < minX ? minX - r.left : Math.min(0, maxX - r.right);
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

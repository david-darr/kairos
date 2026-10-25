import { el } from "./api.js";
import { attachSheetDrag } from "./mobileSheet.js";
import { ICONS } from "./icons.js";

// Phone Tool Store (redesign only). The cards that tool-store.js already builds
// are shown as dense app rows; tapping a row lifts that same card, handlers and
// all, into a bottom sheet. Nothing is rebuilt, so every action keeps its
// existing handler. All decoration is hidden by CSS outside phone + redesign.

const PHONE = "(max-width: 768px)";
const KIND_LABEL = { skill: "Skill", tool: "Tool", tab: "Tab", community: "Community", addon: "Add-on", build: "Your tab" };
const CHEVRON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>';
const PLUS = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';

const markup = html => { const span = document.createElement("span"); span.innerHTML = html; return span.firstElementChild; };


function sectionKind(heading) {
  const text = heading.textContent.toLowerCase();
  if (text.startsWith("skills")) return "skill";
  if (text.startsWith("tools")) return "tool";
  if (text.startsWith("community")) return "community";
  if (/^(prebuilt|yours|turned off)/.test(text)) return "tab";
  return null;
}

const PILL_TEXT = { "update available": "Update", "turned off": "Off", "optional add-on": "Add-on", "enabled add-on": "On",
  "disabled add-on": "Off", "built into kairos": "Built in", "tool server": "Not added", "creative tool": "Not added",
  "connected privately": "Connected", "needs a newer kairos": "Needs update", community: "Community" };
function pillTone(text) {
  const t = text.toLowerCase();
  if (/not responding|invalid|failed|can.t be read|revoked/.test(t)) return "bad";
  if (/needs|update|approval|sign-in/.test(t)) return "warn";
  if (/connected|added|installed|^on$|enabled|available|built in/.test(t)) return "ok";
  return "muted";
}

export function initToolStoreMobile({ view, results, toolbar, filters, installed, menu, header }) {
  // Wrappers that vanish on desktop (display: contents) so its layout is untouched.
  const top = el("div", { class: "tool-store-top" });
  view.insertBefore(top, header);
  const chips = el("div", { class: "ts-chips" }, [filters, installed]);
  toolbar.append(chips);
  top.append(header, toolbar);

  const search = toolbar.querySelector('.tool-store-search');
  const searchPill = el('label', { class: 'ts-search-pill' });
  search.before(searchPill);
  const searchIcon = el('span', { 'aria-hidden': 'true' }); searchIcon.innerHTML = ICONS.search;
  const filterButton = el('button', { type: 'button', class: 'ts-search-filter', 'aria-label': 'Show added items only', 'aria-pressed': 'false' });
  filterButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 5h16l-6 7v7l-4-2v-5z"/></svg>';
  filterButton.addEventListener('click', () => {
    const checkbox = installed.querySelector('input'); checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  });
  installed.querySelector('input').addEventListener('change', () => filterButton.setAttribute('aria-pressed', String(installed.querySelector('input').checked)));
  searchPill.append(searchIcon, search, filterButton);

  const plus = el("button", { type: "button", class: "ts-plus", "aria-label": "Add or manage", "aria-haspopup": "true", "aria-expanded": "false" }, [markup(PLUS)]);
  header.append(plus);
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "Add or manage");

  const phone = window.matchMedia(PHONE);
  const placeHeader = () => {
    if (phone.matches) {
      if (header.parentElement === top) view.insertBefore(header, top);
    } else if (header.parentElement !== top) top.prepend(header);
  };
  placeHeader();
  let focusWatch = null;
  const setMenu = open => {
    if (open) {
      const box = plus.getBoundingClientRect();
      menu.style.top = `${Math.round(box.bottom + 6)}px`;
    }
    view.toggleAttribute("data-ts-menu", open);
    menu.classList.toggle('rd-menu-in', open);
    plus.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("button:not([hidden]):not(:disabled)")?.focus();
  };
  const menuOpen = () => view.hasAttribute("data-ts-menu");
  plus.addEventListener("click", () => setMenu(!menuOpen()));
  // A menu action's opener sits in the closed menu, so focus returns to "+" instead.
  menu.addEventListener("click", event => {
    if (!event.target.closest("button")) return;
    setMenu(false);
    focusWatch?.disconnect();
    const giveBack = () => { if (view.isConnected && !document.querySelector(".panel-dialog") && (!document.activeElement || document.activeElement === document.body)) plus.focus(); };
    focusWatch = new MutationObserver(() => {
      if (!view.isConnected) { focusWatch.disconnect(); return; }
      if (document.querySelector(".panel-dialog")) return;
      giveBack(); focusWatch.disconnect();
    });
    focusWatch.observe(document.body, { childList: true });
    setTimeout(() => { if (!document.querySelector(".panel-dialog")) { giveBack(); focusWatch?.disconnect(); } }, 400);
  });
  document.addEventListener("pointerdown", event => {
    if (menuOpen() && !menu.contains(event.target) && !plus.contains(event.target)) setMenu(false);
  });
  view.addEventListener("keydown", event => {
    if (event.key === "Escape" && menuOpen()) { event.stopPropagation(); setMenu(false); plus.focus(); }
  });

  // ---- Rows ----------------------------------------------------------------
  function decorate(card, kind) {
    const heading = card.querySelector('h4');
    const original = heading?.textContent.trim() || 'Item';
    const name = heading?.getAttribute('data-display-name') || (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(original)
      ? original.replace(/[-_]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase()) : original);
    if (heading) heading.replaceChildren(el('span', { class: 'ts-desktop-name', text: original }), el('span', { class: 'ts-phone-name', text: name }));
    const badge = card.querySelector(":scope > .tool-store-card-top > :is(.tool-store-badge, .pill)") || card.querySelector(":scope > .tool-store-badge");
    const raw = badge?.textContent.trim() || "";
    const label = kind === 'skill' && raw === 'Available' ? 'On' : PILL_TEXT[raw.toLowerCase()] || raw;
    card.dataset.tsKind = kind;
    card.dataset.tsKey = `${kind}:${name}`;
    const tile = el("span", { class: "ts-row-tile", "aria-hidden": "true" });
    const icon = kind === "skill" ? ICONS.brain : kind === "community" ? ICONS.store : kind === "build" ? ICONS.plus : null;
    if (icon) tile.append(markup(icon)); else tile.textContent = name.charAt(0).toUpperCase();
    const hit = el("button", { type: "button", class: "ts-row-hit", "aria-haspopup": "dialog",
      "aria-label": `${name}${label ? `, ${label}` : ""}. Open details` });
    hit.addEventListener("click", () => openSheet(card, hit));
    card.prepend(tile);
    if (label) card.append(el("span", { class: `ts-row-pill ts-${pillTone(label)}`, text: label }));
    card.append(el("span", { class: "ts-row-chev", "aria-hidden": "true" }, [markup(CHEVRON)]), hit);
  }

  // Keep the active chip in view and fade the right edge while more chips scroll.
  function syncChips() {
    filterButton.setAttribute('aria-pressed', String(installed.querySelector('input').checked));
    const target = installed.querySelector("input")?.checked ? installed : filters.querySelector(".active");
    if (target && chips.scrollWidth > chips.clientWidth) {
      const box = chips.getBoundingClientRect(), at = target.getBoundingClientRect();
      if (at.right > box.right - 12) chips.scrollLeft += at.right - box.right + 24;
      else if (at.left < box.left + 12) chips.scrollLeft -= box.left - at.left + 24;
    }
    chips.toggleAttribute("data-more", chips.scrollLeft + chips.clientWidth < chips.scrollWidth - 4);
  }
  chips.addEventListener("scroll", () => chips.toggleAttribute("data-more", chips.scrollLeft + chips.clientWidth < chips.scrollWidth - 4), { passive: true });

  // The sticky header bleeds out over the page's own padding, whatever it is here.
  function measurePad() {
    const scroller = view.parentElement;
    if (!scroller) return;
    const css = getComputedStyle(scroller);
    view.style.setProperty("--ts-pad-top", css.paddingTop);
    view.style.setProperty("--ts-pad-x", css.paddingLeft);
  }

  function sync() {
    if (!view.isConnected) { closeSheet(false); return; }
    placeHeader();

    measurePad();
    syncChips();
    let section = null;
    for (const node of results.children) {
      if (node.matches(".tool-store-heading")) {
        section = sectionKind(node);
        if (section === "tab") node.dataset.tsGroup = "Tabs";
        continue;
      }
      if (!node.matches(".tool-store-grid")) continue;
      for (const card of node.children) {
        if (!card.matches(".tool-store-card") || card.dataset.tsKey) continue;
        decorate(card, card.dataset.addon ? "addon" : card.classList.contains("tool-store-build-card") ? "build" : section || "tool");
      }
    }
    if (open) {
      const next = [...results.querySelectorAll("[data-ts-key]")].find(card => card.dataset.tsKey === open.key);
      if (!next) { closeSheet(false); return; }
      if (next !== open.card) {
        const keep = open.sheet.contains(document.activeElement);
        next.replaceWith(open.placeholder = document.createComment("ts-row"));
        open.card = next;
        mountCard(next);
        if (keep || document.activeElement === document.body) open.close.focus();
      }
    }
  }

  // ---- Sheet ----------------------------------------------------------------
  let open = null;
  const dialogUp = () => document.documentElement.classList.contains("panel-dialog-open");
  function mountCard(card) {
    card.classList.add("ts-in-sheet");
    const heading = card.querySelector("h4");
    if (heading) { heading.id = "ts-sheet-title"; open.sheet.setAttribute("aria-labelledby", "ts-sheet-title"); }
    // An odd last button takes the full row.
    for (const foot of card.querySelectorAll(".tool-store-card-foot")) {
      const buttons = [...foot.children].filter(node => node.matches(".btn") && !node.hidden);
      foot.querySelectorAll(".ts-wide").forEach(node => node.classList.remove("ts-wide"));
      if (buttons.length % 2) buttons.at(-1).classList.add("ts-wide");
    }
    open.body.replaceChildren(card);
    open.body.scrollTop = 0;
  }

  function openSheet(card, opener) {
    if (open || !phone.matches) return;
    const close = el("button", { type: "button", class: "ts-sheet-close", "aria-label": "Close details" }, [markup(ICONS.close || PLUS)]);
    const bar = el("div", { class: "ts-sheet-bar" }, [el("span", { class: "ts-sheet-kind", text: KIND_LABEL[card.dataset.tsKind] || "Details" }), close]);
    const body = el("div", { class: "ts-sheet-body" });
    const sheet = el("div", { class: "ts-sheet rd-sheet-in", 'data-view': 'tool-store', role: "dialog", "aria-modal": "true", tabindex: "-1" }, [el("div", { class: "ts-sheet-grip", "aria-hidden": "true" }), bar, body]);
    const backdrop = el("div", { class: "ts-sheet-backdrop rd-scrim-in" }, [sheet]);
    sheet.addEventListener('animationend', () => sheet.classList.remove('rd-sheet-in'), { once: true });
    open = { key: card.dataset.tsKey, card, opener, sheet, body, close, backdrop, placeholder: document.createComment("ts-row") };
    card.replaceWith(open.placeholder);
    mountCard(card);
    document.body.append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("open"));
    close.addEventListener("click", () => closeSheet(true));
    backdrop.addEventListener("click", event => { if (event.target === backdrop) closeSheet(true); });
    sheet.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSheet(true); return; }
      if (event.key !== "Tab") return;
      const list = [...sheet.querySelectorAll("button, a[href], input, select, textarea, summary")].filter(n => !n.disabled && n.getClientRects().length);
      if (!list.length) { event.preventDefault(); return; }
      const first = list[0], last = list.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    open.dragOff = attachSheetDrag(sheet, () => closeSheet(true));
    open.focusin = event => {
      if (!open || dialogUp() || sheet.contains(event.target) || event.target.closest?.(".toast")) return;
      open.close.focus();
    };
    document.addEventListener("focusin", open.focusin);
    open.gone = new MutationObserver(() => { if (!view.isConnected) closeSheet(false); });
    open.gone.observe(view.parentNode || document.body, { childList: true });
    close.focus();
  }

  function closeSheet(restoreFocus) {
    if (!open) return;
    const { card, placeholder, backdrop, sheet, key } = open;
    document.removeEventListener("focusin", open.focusin);
    open.gone?.disconnect();
    open.dragOff();
    open = null;
    card.classList.remove("ts-in-sheet");
    if (placeholder.parentNode) placeholder.replaceWith(card);
    sheet.classList.remove('rd-sheet-in');
    backdrop.classList.remove('rd-scrim-in');
    backdrop.classList.remove("open");
    setTimeout(() => backdrop.remove(), 200);
    if (restoreFocus && view.isConnected) {
      const row = [...results.querySelectorAll("[data-ts-key]")].find(c => c.dataset.tsKey === key);
      (row?.querySelector(".ts-row-hit") || plus).focus();
    }
  }
  phone.addEventListener("change", () => { placeHeader(); measurePad(); if (!phone.matches) { closeSheet(false); setMenu(false); } });
  window.addEventListener("resize", measurePad);

  return { sync };
}

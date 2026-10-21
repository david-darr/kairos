// Redesign preview, Chats (step 5). views/chat.js calls mountRedesignChat()
// once, after the chat DOM exists, and calls dispose() on unmount. While the
// preview switch is on and the window is desktop width, this moves existing
// nodes (nothing is rebuilt, so every listener, id and state survives):
//  - the model picker goes from the header into the composer's right-hand
//    controls, next to the mic and send buttons (where it lived before the
//    header move in 5f22fd6);
//  - the conversations button gets an icon, a "Conversations" label and a count,
//    and the chat title it used to carry sits beside it as its own heading.
// Switching the preview off, or narrowing to a phone, puts everything back.
import { fitMenu } from "./menuFit.js";
const on = () => document.documentElement.classList.contains("kairos-redesign");
const ICON_LIST = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.3A8 8 0 1 1 21 12z"/><path d="M8.5 10h7M8.5 13.5h4.5"/></svg>';

export function mountRedesignChat(container) {
  const desktop = matchMedia("(min-width: 769px)");
  const header = container.querySelector(".chat-mobile-header");
  const toggle = container.querySelector("#chat-history-toggle");
  const pill = container.querySelector(".chat-header-model");
  const right = container.querySelector(".chat-input-right");
  const menu = container.querySelector("#model-picker-menu");
  const list = container.querySelector("#sessions-list");
  const title = toggle?.querySelector(".chat-title");
  if (!header || !toggle || !pill || !right || !menu) return { dispose() {} };

  let applied = false;
  let pillNext = null;
  let extras = [];
  let observers = [];

  // The menu opens upward from the composer, or downward when that side has
  // more room. fitMenu() clamps it to the window and re-fits on resize.
  // Absolute, against the picker wrapper, so the composer's own backdrop
  // filter cannot become the fixed-position container.
  const place = () => {
    if (!applied || menu.classList.contains("hidden")) return;
    fitMenu(menu, pill, { prefer: "above", fixed: false });
  };

  const syncCount = () => {
    const count = list ? list.querySelectorAll(".session-item").length : 0;
    const badge = extras.find((n) => n.classList?.contains("rd-conv-count"));
    if (badge) { badge.textContent = String(count); badge.hidden = !count; }
  };
  const syncTitle = () => {
    const mirror = extras.find((n) => n.classList?.contains("rd-chat-title"));
    if (mirror && title) { mirror.textContent = title.textContent; mirror.title = title.title || title.textContent; }
  };

  function apply() {
    if (applied) return;
    header.dispatchEvent(new Event('kairos:desktop-chat-layout'));
    applied = true;
    pillNext = pill.nextSibling;
    right.insertBefore(pill, right.firstChild);
    pill.classList.add("rd-in-composer");

    const icon = document.createElement("span");
    icon.className = "rd-conv-icon"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = ICON_LIST;
    const label = document.createElement("span");
    label.className = "rd-conv-label"; label.textContent = "Conversations";
    const count = document.createElement("span");
    count.className = "rd-conv-count"; count.hidden = true;
    toggle.prepend(icon, label, count);
    const heading = document.createElement("span");
    heading.className = "rd-chat-title";
    toggle.after(heading);
    extras = [icon, label, count, heading];
    syncCount(); syncTitle();

    const watch = (target, options, fn) => { if (!target) return; const o = new MutationObserver(fn); o.observe(target, options); observers.push(o); };
    watch(list, { childList: true, subtree: true }, syncCount);
    watch(title, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["title"] }, syncTitle);
    watch(menu, { attributes: true, attributeFilter: ["class"] }, place);
    header.classList.add("rd-chat-header");
  }

  function revert() {
    if (!applied) return;
    applied = false;
    observers.forEach((o) => o.disconnect()); observers = [];
    extras.forEach((n) => n.remove()); extras = [];
    pill.classList.remove("rd-in-composer");
    header.insertBefore(pill, pillNext && pillNext.parentNode === header ? pillNext : null);
    header.classList.remove("rd-chat-header");
    menu.removeAttribute("style");
    menu.classList.add("hidden");
  }

  const sync = () => (on() && desktop.matches ? apply() : revert());
  desktop.addEventListener("change", sync);
  document.addEventListener("kairos:appearance", sync);
  sync();

  return {
    dispose() {
      desktop.removeEventListener("change", sync);
      document.removeEventListener("kairos:appearance", sync);
      revert();
    },
  };
}

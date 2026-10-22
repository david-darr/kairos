import { mobileOn, phone, edgeBlur, pageBleed } from './mobileShared.js';
import { refreshActivity } from './mobileActivity.js';

// iOS Safari in a browser tab (2026-10-21, David on device). Safari 26 only
// draws page pixels under its status bar and floating toolbar while the
// document itself is scrolled; a locked page gets flat tinted bands instead.
// So, there only: the document scrolls with 1px of slack and sits at 1px, the
// app is in flow and one dynamic viewport tall, and the page backgrounds live in
// an in-flow layer one large viewport tall (.ms-page-bleed) that runs under
// both bars. The same condition gates the CSS (html.ms-safari-bleed). The
// home-screen app, Android and desktop never take this path.
export const safariTab = () => !!globalThis.CSS?.supports?.('-webkit-touch-callout', 'none') &&
  navigator.standalone !== true && !matchMedia('(display-mode: standalone)').matches;
const settleScroll = () => { if (pageBleed() && !document.hidden && scrollY < 1) scrollTo(0, 1); };
let scrollTimer = 0;
const afterScroll = () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(settleScroll, 150); };
export function setPageBleed(on) {
  const root = document.documentElement, frost = document.querySelector('.ms-global-frost');
  let layer = pageBleed();
  if (on && !layer) {
    layer = document.createElement('div'); layer.className = 'ms-page-bleed'; layer.setAttribute('aria-hidden', 'true');
    document.body.prepend(layer);
    if (frost) document.body.prepend(frost);
    const sky = document.querySelector('.kairos-redesign-backdrop'); if (sky) layer.prepend(sky);
    // The appearance's colour, picture or shader canvases are full-screen fixed layers: they go underneath, in flow.
    layer.prepend(...document.querySelectorAll('body > .app-background'));
    // A launch view already on screen hands over its picture too.
    const picture = document.querySelector('.ms-shell > .ms-background'); if (picture) layer.append(picture);
  } else if (!on && layer) {
    const sky = layer.querySelector('.kairos-redesign-backdrop'); if (sky) document.getElementById('content')?.prepend(sky);
    document.body.prepend(...layer.querySelectorAll(':scope > .app-background'));
    const shell = document.querySelector('.ms-shell');
    for (const node of [...layer.children]) (shell || document.body).prepend(node);
    layer.remove(); if (frost) document.body.append(frost);
    if (scrollY) scrollTo(0, 0);
  }
  root.classList.toggle('ms-safari-bleed', !!on);
  if (on) { settleScroll(); requestAnimationFrame(settleScroll); }
}

// One persistent entry control covers built-in views, Settings and custom tabs.
export function mountMobileChrome(avatar) {
  // iOS home-screen app only (navigator.standalone exists only there): the
  // status bar is translucent, so theme-color has nothing to tint, and iOS 26
  // may mix it into its own top edge haze (2026-10-21, David on device). The
  // browser and Android keep it; Android's installed app also has the
  // manifest theme_color.
  const theme = document.querySelector('meta[name=theme-color]');
  if (navigator.standalone === true && theme) theme.remove();
  const frost = edgeBlur('top'); frost.classList.add('ms-global-frost');
  document.body.append(frost);
  const bleed = () => setPageBleed(phone.matches && safariTab());
  bleed(); phone.addEventListener('change', bleed);
  for (const [target, type] of [[window, 'resize'], [window, 'pageshow'], [document, 'visibilitychange']]) target.addEventListener(type, settleScroll);
  window.addEventListener('scroll', afterScroll, { passive: true });
  const sync = () => {
    const on = mobileOn();
    avatar.classList.toggle('ms-avatar', on); avatar.classList.toggle('ms-glass', on);
    avatar.textContent = on ? document.querySelector('.sidebar-avatar')?.textContent || 'K' : '';
    // The launch header keeps its own avatar; its initial follows the account too.
    const initial = document.querySelector('.sidebar-avatar')?.textContent;
    for (const own of document.querySelectorAll('.ms-header .ms-avatar')) {
      const text = [...own.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
      if (initial && text && text.data !== initial) text.data = initial;
    }
    avatar.setAttribute('aria-label', 'Open workspace tabs');
    avatar.setAttribute('aria-haspopup', 'dialog'); avatar.removeAttribute('aria-expanded');
    avatar.setAttribute('aria-controls', 'ms-workspace-sheet'); frost.hidden = !on;
    refreshActivity();
  };
  // Identity and mode can rebuild the sidebar independently of navigation.
  phone.addEventListener('change', () => {
    if (mobileOn() && document.getElementById('sidebar').contains(document.activeElement)) {
      requestAnimationFrame(() => {
        const target = [...document.querySelectorAll('.ms-avatar, .ms-chat-back')].find(n => getComputedStyle(n).visibility !== 'hidden' && n.getClientRects().length);
        target?.focus({ preventScroll: true });
      });
    }
  });
  const observer = new MutationObserver(sync);
  observer.observe(document.getElementById('sidebar'), { childList: true, subtree: true });
  phone.addEventListener('change', sync); document.addEventListener('kairos:appearance', sync); sync();
}

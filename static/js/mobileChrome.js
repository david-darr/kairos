import { mobileOn, phone, edgeBlur } from './mobileShared.js';
import { mountPhoneMotion } from './mobilePhoneMotion.js';
import { refreshActivity } from './mobileActivity.js';
import { mountSidebar, menuButton } from './mobileSidebar.js';

// Phone chrome shared by every page: the status-bar frost and the sliding
// sidebar (mobileSidebar.js), which replaced the bottom tab bar on 2026-11-02.
export function mountMobileChrome() {
  // iOS home-screen app only (navigator.standalone exists only there): the
  // status bar is translucent, so theme-color has nothing to tint, and iOS 26
  // may mix it into its own top edge haze (2026-10-21, David on device). The
  // browser and Android keep it; Android's installed app also has the
  // manifest theme_color.
  const theme = document.querySelector('meta[name=theme-color]');
  if (navigator.standalone === true && theme) theme.remove();
  const frost = edgeBlur('top'); frost.classList.add('ms-global-frost');
  document.body.append(frost);
  mountSidebar();
  mountPhoneMotion();
  fitScreen();
  lockZoom();
  const sync = () => { frost.hidden = !mobileOn(); refreshActivity(); };
  // Identity and mode can rebuild the desktop sidebar independently of
  // navigation; focus that was inside it lands on the menu button.
  phone.addEventListener('change', () => {
    if (mobileOn() && document.getElementById('sidebar').contains(document.activeElement)) {
      requestAnimationFrame(() => {
        const target = menuButton() || [...document.querySelectorAll('.ms-chat-back')].find(n => getComputedStyle(n).visibility !== 'hidden' && n.getClientRects().length);
        target?.focus({ preventScroll: true });
      });
    }
  });
  phone.addEventListener('change', sync); document.addEventListener('kairos:appearance', sync); sync();
}

// The iOS home-screen app's page is exactly the screen (2026-11-06, David on
// device: the sidebar's New chat, the dock and the composer were cut off at
// the bottom). style.css sizes it max(100dvh, 100lvh) for iOS 26's short
// layout viewport, and on his iPhone that came out taller than the screen.
// There, the screen's own height is the truth (iOS reports it in portrait).
function fitScreen() {
  if (navigator.standalone !== true) return;
  const root = document.documentElement, landscape = matchMedia('(orientation: landscape)');
  const apply = () => {
    if (!mobileOn()) { root.style.removeProperty('--ms-page-height'); return; }
    const long = Math.max(screen.width, screen.height), short = Math.min(screen.width, screen.height);
    root.style.setProperty('--ms-page-height', `${landscape.matches ? short : long}px`);
  };
  apply();
  landscape.addEventListener('change', apply); phone.addEventListener('change', apply); addEventListener('resize', apply);
}

// No pinch or double-tap zoom, as in a native app (2026-11-06, David). The
// viewport tag stops it on Android and on iOS input focus, and touch-action
// (style.css) stops double-tap; iOS ignores user-scalable for pinch, so its
// gesture events are cancelled.
function lockZoom() {
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, event => { if (mobileOn()) event.preventDefault(); }, { passive: false });
  }
}

import { mobileOn, phone, edgeBlur } from './mobileShared.js';
import { mountPhoneMotion } from './mobilePhoneMotion.js';
import { refreshActivity } from './mobileActivity.js';
import { mountTabBar, currentTabItem } from './mobileTabBar.js';

// Phone chrome shared by every page: the status-bar frost and the bottom tab
// bar (mobileTabBar.js), which replaced the top-left avatar on 2026-10-22.
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
  mountTabBar();
  mountPhoneMotion();
  const sync = () => { frost.hidden = !mobileOn(); refreshActivity(); };
  // Identity and mode can rebuild the sidebar independently of navigation;
  // focus that was inside it lands on the tab bar's current item.
  phone.addEventListener('change', () => {
    if (mobileOn() && document.getElementById('sidebar').contains(document.activeElement)) {
      requestAnimationFrame(() => {
        const target = currentTabItem() || [...document.querySelectorAll('.ms-chat-back')].find(n => getComputedStyle(n).visibility !== 'hidden' && n.getClientRects().length);
        target?.focus({ preventScroll: true });
      });
    }
  });
  phone.addEventListener('change', sync); document.addEventListener('kairos:appearance', sync); sync();
}

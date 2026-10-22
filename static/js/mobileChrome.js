import { mobileOn, phone, edgeBlur } from './mobileShared.js';
import { refreshActivity } from './mobileActivity.js';

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

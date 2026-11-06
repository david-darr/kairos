import { mobileOn, phone, button } from './mobileShared.js';

// How far the page runs below the layout viewport: 0, except in an iOS
// home-screen app, where the page is the full screen (style.css
// --ms-page-height) but the layout viewport is short by the status bar.
// Measured from the bottom of the app, which is the page.
export const belowFold = () => Math.max(0, ((document.getElementById?.('app') || document.documentElement)?.getBoundingClientRect().bottom || 0) - innerHeight);
// The keyboard's height above the layout viewport's bottom (sub-pixel noise is 0).
export const keyboardLift = (height, viewport) => {
  const lift = viewport ? height - viewport.height - viewport.offsetTop : 0;
  return lift > 1 ? lift : 0;
};
// --ms-keyboard is measured from the page bottom: 0 with the keyboard down, so
// surfaces sit at the true bottom; with it up, it includes the page below the
// layout viewport, so they land on the keyboard's top edge.
export function watchKeyboard(node) {
  const lifted = () => { const lift = mobileOn() ? keyboardLift(innerHeight, window.visualViewport) : 0; return lift ? lift + belowFold() : 0; };
  // 2.2.1: an iOS home-screen app can leave the page scrolled once the keyboard
  // closes, which strands bottom-docked surfaces (the chat bar) part or all of the
  // way off screen. With the keyboard down the app shell never scrolls, so put it
  // back. The lift is also capped so a bad reading can't throw the bar off the top.
  let wasLifted = false;
  const update = () => {
    let lift = lifted();
    lift = Math.min(lift, Math.round(innerHeight * 0.7));
    node.style.setProperty('--ms-keyboard', `${lift}px`);
    if (!lift && wasLifted && mobileOn() && (window.scrollY || document.documentElement.scrollTop)) window.scrollTo(0, 0);
    wasLifted = lift > 0;
  };
  update(); window.visualViewport?.addEventListener('resize', update); window.visualViewport?.addEventListener('scroll', update); window.addEventListener('resize', update);
  phone.addEventListener('change', update); document.addEventListener('kairos:appearance', update);
  return () => { window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update); phone.removeEventListener('change', update); document.removeEventListener('kairos:appearance', update); node.style.removeProperty('--ms-keyboard'); };
}

export function mountGitDock(panel, { files, message, commit, push, pull, pr }) {
  const dock = document.createElement('div'); dock.className = 'ms-git-dock ms-glass';
  const staged = files.filter(file => file.staged).length;
  if (files.length) {
    const action = button(`Commit ${staged || files.length}`, () => {
      if (message.value.trim() && !commit.disabled) { commit.click(); return; }
      message.scrollIntoView({ block: 'center' }); message.focus();
      // Without a message, reveal the original commit form first.
    });
    action.disabled = message.disabled || (!files.length && commit.disabled); dock.append(action);
  }
  for (const [label, target] of [['Sync: Push', push], ['Sync: Pull', pull], ['PR', pr]]) {
    if (!target) continue;
    const action = button(label, () => target.click()); action.disabled = target.disabled; dock.append(action);
  }
  panel.append(dock);
  const gate = () => { dock.hidden = !mobileOn(); }; gate();
  phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate);
  const keyboard = watchKeyboard(dock);
  return () => { keyboard(); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); dock.remove(); };
}

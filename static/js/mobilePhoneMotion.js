import { mobileOn, phone, button } from './mobileShared.js';
import { openNotifications } from './mobileActions.js';

// Presentation hooks only: the router still owns view lifetime and back/edge gestures.
export function mountPhoneMotion() {
  const positions = new Map(), entered = new WeakSet(), pushed = new Set();
  document.addEventListener('animationend', event => {
    const node = event.target;
    if (!mobileOn() || !node?.classList || !['rd-rise', 'rd-push', 'rd-opacity', 'ms-chat-reveal'].includes(event.animationName)) return;
    if (node.classList.contains('rd-push-in') || node.classList.contains('rd-enter-rise')) {
      node.dataset.msEntered = 'true'; node.classList.remove('rd-push-in', 'rd-enter-rise');
    }
  });
  let root, tab, frame, restoring;
  const scrollers = node => [node, ...node.querySelectorAll('[id], .ms-history-list, .mf-dashboard-body')];
  const key = (node, i) => node.id || `${node.className}:${i}`;
  const save = () => {
    if (mobileOn() && root && tab) positions.set(tab, new Map(scrollers(root).map((node, i) => [key(node, i), node.scrollTop])));
  };
  document.addEventListener('scroll', event => { if (root?.contains(event.target) || event.target === root) save(); }, true);
  const paint = () => {
    frame = 0;
    if (!mobileOn()) return;
    const next = document.getElementById('view-content');
    if (!next) return;
    if (root !== next) { save(); root = next; tab = next.dataset.view || document.documentElement.dataset.view; restoring = new Map(positions.get(tab) || []); }
    // Wait for the view's actual content, rather than animate its loading placeholder.
    if (!entered.has(root) && root.children.length && !root.firstElementChild.matches('.empty-state')) {
      entered.add(root); root.classList.add('rd-enter-rise');
    }
    if (restoring?.size) scrollers(root).forEach((node, i) => {
      const id = key(node, i), top = restoring.get(id);
      if (top !== undefined && node.scrollHeight - node.clientHeight >= top) { node.scrollTop = top; restoring.delete(id); }
    });
    // Reveal only the Agents stage: translating the messenger moves its full
    // width beyond the phone and reanchors its fixed Chats drawer and scrim.
    const pushSelector = '.ms-conversation:not(.ms-launch-chat), .mf-session, .agents-workspace.has-conversation .agents-messenger-stage, .library-editor, .vault-phone-detail, .settings-mobile-page[data-mobile-view=page] .set-page, .ms-model-options';
    const pages = [...(root.matches(pushSelector) ? [root] : []), ...root.querySelectorAll(pushSelector)];
    for (const page of pushed) if (!pages.includes(page)) pushed.delete(page);
    for (const page of pages) {
      if (page === root && root.classList.contains('rd-enter-rise')) root.classList.remove('rd-enter-rise');
      if (!pushed.has(page)) { pushed.add(page); page.classList.add('rd-push-in'); }
    }
    // These are shell-owned headers; individual tab headers remain for later phases.
    for (const header of root.querySelectorAll('.ms-header-row')) {
      // New / Chats is already the launch workspace's title, in its top row.
      if (!header.querySelector('.ms-root-title') && header.closest('.mf-project') && header.querySelector('.ms-switch')) {
        const title = document.createElement('h1'); title.className = 'ms-root-title'; title.textContent = 'Forge'; header.prepend(title);
      }
      const projects = header.querySelector('.mf-project-trigger');
      if (projects && !projects.querySelector('svg')) {
        projects.setAttribute('aria-label', 'Projects'); projects.title = 'Projects';
        projects.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/></svg>';
      }
      // Chats owns its two actions and offers Notifications in its actions sheet.
      if (!header.closest('.rd-chats-header') && !header.querySelector('.ms-notifications-open')) {
        const bell = button('Updates', () => openNotifications(bell), 'ms-notifications-open'); bell.setAttribute('aria-label', 'Notifications');
        bell.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0v6l2 3H4l2-3V9M10 21h4"/></svg>`; header.append(bell);
      }
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  new MutationObserver(schedule).observe(document.getElementById('app') || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-mobile-view'] });
  phone.addEventListener('change', schedule); document.addEventListener('kairos:appearance', schedule); schedule();
}

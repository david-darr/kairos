import { el } from './api.js';
import { pill, emptyState } from './kairosParts.js';
import { go, mobileOn, button } from './mobileShared.js';
import { openMobileSheet } from './mobileSheet.js';
import { activityItems } from './mobileActivity.js';
import { ICONS } from './icons.js';
import { createMascot } from './mascot.js';

// Use the destination's existing control once its asynchronous render is ready.
function destination(tab, options, selector, activate = false) {
  const old = document.getElementById('view-content');
  let timer;
  const observer = new MutationObserver(() => {
    const root = document.getElementById('view-content');
    if (!mobileOn()) { observer.disconnect(); clearTimeout(timer); return; }
    const target = root !== old && root?.querySelector(selector);
    if (!target) return;
    observer.disconnect(); clearTimeout(timer);
    target.scrollIntoView({ block: 'center' });
    if (activate) target.click(); else target.focus();
  });
  observer.observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
  timer = setTimeout(() => observer.disconnect(), 5000);
  go(tab, options);
}

export function openQuickCreate(opener) {
  if (!mobileOn()) return;
  const content = el('nav', { class: 'ms-quick-create rd-stagger', 'aria-label': 'Create' });
  let sheet;
  const actions = [
    ['New chat', 'Ask anything', 'chats', () => go('chat', { mobileConversation: true })],
    ['Quick note', 'Capture a thought', 'notes', () => destination('notes', {}, '[data-mobile-create-label="Add note"]')],
    ['New design', 'Website, app, poster, slides', 'design', () => destination('library', { section: 'designs' }, '.design-composer textarea')],
    ['Event or task', 'Schedule it', 'calendar', () => destination('calendar', {}, '[data-mobile-create-label="New event"]', true)],
    ['Talk to Kairos', 'Voice', 'voice', () => destination('chat', { mobileConversation: true }, '#chat-openmic', true)],
  ];
  for (const [text, detail, icon, action] of actions) {
    const row = pill({ text, kind: 'secondary', onClick: () => { sheet.close(); action(); } });
    row.classList.add('ms-quick-action');
    const mark = el('span', { class: 'ms-quick-icon', 'aria-hidden': 'true' }); mark.innerHTML = icon === 'voice' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>' : ICONS[icon] || ICONS.newChat;
    row.prepend(mark); row.append(el('small', { text: detail })); content.append(row);
  }
  sheet = openMobileSheet({ title: 'Quick create', content, opener });
  sheet.dialog.classList.add('ms-quick-popup');
  sheet.dialog.classList.remove('rd-sheet-in');
  sheet.dialog.append(sheet.dismiss);
  sheet.dismiss.className = 'ms-quick-close';
}

export function openNotifications(opener) {
  if (!mobileOn()) return;
  const content = el('div', { class: 'ms-notifications' });
  let sheet;
  const paint = () => {
    const { live, done } = activityItems(); content.replaceChildren();
    const groups = [ ['Live now', live.filter(i => !i.needsYou)], ['Needs you', live.filter(i => i.needsYou)], ['Earlier', done] ];
    for (const [title, items] of groups) {
      if (!items.length) continue;
      const section = el('section', { class: title === 'Live now' ? 'ms-notification-live' : title === 'Earlier' ? 'ms-notification-earlier' : 'ms-notification-needs' }, [el('h3', { text: title })]);
      const list = el('div', { class: 'ms-notification-list' });
      for (const item of items) {
        const row = button('', () => { sheet.close(); item.go?.(); }, 'ms-notification-row');
        if (title !== 'Earlier' && document.documentElement.dataset.mascot !== 'off') row.append(createMascot({ state: item.needsYou ? 'needs' : 'working', size: title === 'Live now' ? 64 : 40, decorative: true }));
        else row.append(el('span', { class: 'ms-notification-dot', 'aria-hidden': 'true', 'data-status': item.status }));
        // Earlier items read as one line with the outcome at the right; live and waiting ones stack title over detail.
        row.append(el('span', { class: 'ms-notification-copy' }, [el('strong', { text: item.title }), el('small', { text: item.detail || item.status || '' })]));
        list.append(row);
      }
      section.append(list);
      content.append(section);
    }
    if (!live.length && !done.length) content.append(emptyState({ title: 'All caught up', text: 'Work and replies will appear here.', action: { text: 'Back to your day', onClick: () => sheet.close() } }));
  };
  sheet = openMobileSheet({ title: 'Notifications', content, opener, onClose: () => document.removeEventListener('kairos:mobile-activity', paint) });
  sheet.dialog.classList.add('ms-notifications-sheet');
  paint(); document.addEventListener('kairos:mobile-activity', paint);
}

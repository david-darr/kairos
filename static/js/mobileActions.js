import { el } from './api.js';
import { emptyState } from './kairosParts.js';
import { go, mobileOn, button } from './mobileShared.js';
import { openMobileSheet } from './mobileSheet.js';
import { activityItems } from './mobileActivity.js';
import { createMascot } from './mascot.js';

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

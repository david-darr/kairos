import { el } from './api.js';
import { openMobileSheet } from './mobileSheet.js';

// Move the original controls, preserving their values and handlers. Their
// placeholder restores the exact desktop home when the sheet closes.
export function phoneDetails(title, nodes, opener, description) {
  const content = el('div', { class: 'phone-row-details' });
  const homes = nodes.map(node => {
    const home = document.createComment('Phone details home');
    node.before(home); content.append(node); return { node, home };
  });
  if (description) content.prepend(el('p', { text: description }));
  const restore = () => homes.forEach(({ node, home }) => { home.replaceWith(node); });
  const sheet = openMobileSheet({ title, content, opener, onClose: () => { observer.disconnect(); restore(); } });
  if (!sheet) { restore(); return; }
  // Existing confirmations are panel dialogs. Dismiss this native modal
  // before invoking them so their controls remain reachable in the page.
  content.addEventListener('click', event => {
    const action = event.target.closest('button');
    if (action?.matches('.danger, .row-action-btn, [aria-haspopup="dialog"]') || action?.textContent.trim() === 'Disconnect') sheet.close();
  }, true);
  const observer = new MutationObserver(() => {
    if (homes.some(({ home }) => !home.isConnected)) sheet.close();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return sheet;
}

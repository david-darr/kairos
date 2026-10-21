import { button, mobileOn, haptic } from './mobileShared.js';
import { attentionCount } from './mobileActivity.js';

let sheet, opener, startY;
export function closeTabSheet() {
  if (!sheet?.open) return;
  sheet.close(); sheet.removeAttribute('aria-modal'); opener?.isConnected && opener.focus({ preventScroll: true });
}

export function openTabSheet(from) {
  if (!mobileOn()) return;
  if (!sheet) {
    sheet = document.createElement('dialog'); sheet.className = 'ms-tab-sheet';
    sheet.setAttribute('aria-label', 'Your workspace');
    sheet.addEventListener('click', e => { if (e.target === sheet) closeTabSheet(); });
    sheet.addEventListener('cancel', e => { e.preventDefault(); closeTabSheet(); });
    sheet.addEventListener('touchstart', e => {
      startY = sheet.scrollTop <= 0 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    sheet.addEventListener('touchend', e => {
      if (startY && e.changedTouches[0].clientY - startY.y > 56 && Math.abs(e.changedTouches[0].clientX - startY.x) < 40) closeTabSheet(); startY = null;
    });
    sheet.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const controls = [...sheet.querySelectorAll('button, a[href]')].filter(n => !n.disabled && n.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    document.body.append(sheet);
  }
  opener = from; haptic();
  const panel = document.createElement('div'); panel.className = 'ms-sheet-panel';
  const grab = button('Close workspace', closeTabSheet, 'ms-sheet-grab'); grab.setAttribute('aria-label', 'Close workspace');
  const heading = document.createElement('h2'); heading.className = 'ms-sheet-heading'; heading.textContent = 'Your workspace';
  const grid = document.createElement('nav'); grid.className = 'ms-tab-grid'; grid.setAttribute('aria-label', 'Tabs');
  // The rendered nav is the source of truth for order, visibility, icons,
  // authorization and custom tabs. Copy presentation, delegate each action.
  for (const source of document.querySelectorAll('#nav .nav-item')) {
    const tile = button('', () => { closeTabSheet(); source.click(); }, 'ms-tab-tile ms-glass');
    tile.innerHTML = source.innerHTML; tile.dataset.tab = source.dataset.tab;
    tile.setAttribute('aria-label', source.getAttribute('aria-label') || source.textContent.trim());
    if (source.hasAttribute('aria-current')) tile.setAttribute('aria-current', 'page');
    if (source.dataset.tab === 'home' && attentionCount()) {
      const badge = document.createElement('span'); badge.className = 'nav-badge'; badge.textContent = String(attentionCount());
      tile.append(badge); tile.setAttribute('aria-label', `Home, ${attentionCount()} need you`);
    }
    grid.append(tile);
  }
  const mode = document.querySelector('#forge-mode-switch [data-mode="forge"]');
  if (mode && document.documentElement.dataset.appMode !== 'forge') {
    grid.append(button('Forge', () => { closeTabSheet(); mode.click(); }, 'ms-tab-tile ms-glass'));
  }
  // Retain the mode switch/project rail shortcut in Forge via the existing drawer.
  const footer = document.createElement('div'); footer.className = 'ms-sheet-footer';
  const name = document.querySelector('.sidebar-user-name')?.textContent || 'Account';
  const account = button(name, () => {
    account.setAttribute('aria-expanded', String(accountActions.hidden === false ? false : true));
    accountActions.hidden = !accountActions.hidden;
  }, 'ms-account-row');
  account.setAttribute('aria-expanded', 'false');
  const accountActions = document.createElement('div'); accountActions.hidden = true;
  for (const source of document.querySelectorAll('#sidebar-footer .overflow-menu-item')) {
    const action = button(source.textContent, () => { closeTabSheet(); source.click(); }, 'ms-account-row');
    action.disabled = source.disabled; action.title = source.title; accountActions.append(action);
  }
  footer.append(account, accountActions, button('Settings', () => { closeTabSheet(); document.querySelector('.sidebar-settings-btn')?.click(); }, 'ms-account-row'));
  const native = document.querySelector('.native-mobile-settings');
  if (native) footer.append(native.cloneNode(true));
  panel.append(grab, heading, grid, footer); sheet.replaceChildren(panel);
  sheet.setAttribute('aria-modal', 'true'); sheet.showModal(); grab.focus();
}

export function initTabSheet() {
  document.addEventListener('kairos:mobile-drawer-opening', closeTabSheet);
  const sync = () => { if (!mobileOn()) closeTabSheet(); };
  addEventListener('resize', sync); document.addEventListener('kairos:appearance', sync);
  // Badge and Layout updates are reflected on the next open without moving focus.
}

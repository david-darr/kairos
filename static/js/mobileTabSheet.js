import { button, mobileOn, haptic } from './mobileShared.js';
import { attentionCount, activityItems } from './mobileActivity.js';
import { ICONS } from './icons.js';

let sheet, opener, startY;
const libraryGlyph = () => { const t = document.createElement('template'); t.innerHTML = ICONS.library; return t.content.firstElementChild.innerHTML; };
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
    // A custom tab without its own icon falls back to the Library glyph; give it a distinct generic one here.
    if (source.dataset.tab !== 'library' && source.querySelector('svg')?.innerHTML === libraryGlyph()) tile.querySelector('svg').outerHTML = ICONS.tabGeneric;
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
    const forge = button('', () => { closeTabSheet(); mode.click(); }, 'ms-tab-tile ms-glass');
    forge.innerHTML = `${ICONS.code}<span>Forge</span>`; forge.setAttribute('aria-label', 'Forge'); grid.append(forge);
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
  const { live, done } = activityItems();
  const work = document.createElement('section'); work.className = 'ms-sheet-activity'; work.setAttribute('aria-label', 'Work and updates');
  if (live.length || done.length) {
    const title = document.createElement('h3'); title.textContent = 'Working and waiting'; work.append(title);
    for (const item of live) {
      const row = document.createElement('div'); row.className = 'ms-sheet-activity-row' + (item.needsYou ? ' ms-needs-you' : '');
      row.append(button(`${item.title}${item.detail ? ' · ' + item.detail : ''}`, () => { closeTabSheet(); item.go?.(); }, 'ms-sheet-activity-main'));
      if (item.stop) row.append(button('Stop', () => item.stop(), 'ms-sheet-activity-stop'));
      work.append(row);
    }
    for (const item of done) {
      const row = document.createElement('div'); row.className = 'ms-sheet-activity-row';
      row.append(button(`${item.title} · ${item.status}`, () => { closeTabSheet(); item.go(); }, 'ms-sheet-activity-main')); work.append(row);
    }
  }
  panel.append(grab, heading, grid, work, footer); sheet.replaceChildren(panel);
  sheet.setAttribute('aria-modal', 'true'); sheet.showModal();
  // Focus the dialog itself, not the grabber: no ring on open; Tab then reaches the first control.
  sheet.tabIndex = -1; sheet.focus({ preventScroll: true });
}

export function initTabSheet() {
  document.addEventListener('kairos:mobile-drawer-opening', closeTabSheet);
  const sync = () => { if (!mobileOn()) closeTabSheet(); };
  addEventListener('resize', sync); document.addEventListener('kairos:appearance', sync);
  // Badge and Layout updates are reflected on the next open without moving focus.
}

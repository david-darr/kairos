import { openNotifications } from './mobileActions.js';
import { attachSheetDrag } from './mobileSheet.js';
import { button, mobileOn, haptic, go } from './mobileShared.js';
import { activityItems } from './mobileActivity.js';
import { sidebarLayout, knownTabs } from './layout.js';
import { ICONS } from './icons.js';

// The More sheet: opened from More in the phone's sidebar (mobileSidebar.js,
// 2026-11-02). It holds every Kairos tab the sidebar does not, in any mode,
// grouped as Settings > Layout groups them; in Bots, the bots' chats and inbox;
// Forge projects, work in progress, and the account and Settings.
let sheet, opener;
// The tabs the sidebar itself shows; More lists the rest.
const IN_SIDEBAR = new Set(['home', 'chat']);
const libraryGlyph = () => { const t = document.createElement('template'); t.innerHTML = ICONS.library; return t.content.firstElementChild.innerHTML; };
export function closeMoreSheet() {
  if (!sheet?.open) return;
  sheet.close(); sheet.removeAttribute('aria-modal');
  opener?.isConnected && opener.focus({ preventScroll: true });
}

export function openMoreSheet(from) {
  if (!mobileOn()) return;
  if (!sheet) {
    sheet = document.createElement('dialog'); sheet.className = 'ms-tab-sheet ms-more-sheet rd-sheet-in'; sheet.id = 'ms-more-sheet';
    sheet.setAttribute('aria-label', 'More');
    sheet.addEventListener('click', e => { if (e.target === sheet) closeMoreSheet(); });
    sheet.addEventListener('cancel', e => { e.preventDefault(); closeMoreSheet(); });
    attachSheetDrag(sheet, closeMoreSheet, { enabled: mobileOn });
    sheet.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeMoreSheet(); return; }
      if (e.key !== 'Tab') return;
      const controls = [...sheet.querySelectorAll('button, a[href]')].filter(n => !n.disabled && n.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    document.body.append(sheet);
  }
  document.dispatchEvent(new CustomEvent('kairos:mobile-drawer-opening', { detail: { id: 'more-sheet' } }));
  opener = from; haptic();
  const panel = document.createElement('div'); panel.className = 'ms-sheet-panel';
  const grab = button('Close More', closeMoreSheet, 'ms-sheet-grab'); grab.setAttribute('aria-label', 'Close More');
  const heading = document.createElement('h2'); heading.className = 'ms-sheet-heading'; heading.textContent = 'More';
  const groups = document.createElement('nav'); groups.setAttribute('aria-label', 'Tabs');
  const grids = new Map();
  // Bots mode: the bots' own lists, which have no row in the sidebar.
  if (document.documentElement.dataset.appMode === 'bots') {
    const section = document.createElement('section'); section.className = 'ms-tab-group'; section.dataset.group = 'bots';
    const label = document.createElement('h3'); label.className = 'ms-group-label'; label.textContent = 'Bots';
    const grid = document.createElement('div'); grid.className = 'ms-tab-grid';
    const tile = (id, text, icon, open) => {
      const node = button('', () => { closeMoreSheet(); import('./mobileBots.js').then(open); }, 'ms-tab-tile ms-glass');
      node.innerHTML = `${ICONS[icon] || ''}<span></span>`; node.querySelector('span').textContent = text;
      node.dataset.tab = id; node.setAttribute('aria-label', text); return node;
    };
    grid.append(tile('botsChats', 'Chats', 'chats', m => m.openBotsList(opener)), tile('botsInbox', 'Inbox', 'inbox', m => m.openBotsInbox()));
    section.append(label, grid); groups.append(section);
  }
  // Every Kairos tab, from any mode: the list app.js last built (layout.js), so
  // Settings > Layout order and hidden tabs and custom tabs hold here too.
  const listed = knownTabs().filter(tab => !['design', 'designs'].includes(tab.id) && !IN_SIDEBAR.has(tab.id));
  const current = document.documentElement.dataset.appMode === 'kairos' || !document.documentElement.dataset.appMode ? document.documentElement.dataset.view : '';
  for (const group of sidebarLayout(listed.map(tab => tab.id))) {
    if (!group.ids.length) continue;
    const section = document.createElement('section'); section.className = 'ms-tab-group'; section.dataset.group = group.id;
    const label = document.createElement('h3'); label.className = 'ms-group-label'; label.textContent = group.label || 'Tabs';
    const grid = document.createElement('div'); grid.className = 'ms-tab-grid';
    section.append(label, grid); groups.append(section);
    for (const id of group.ids) grids.set(id, grid);
  }
  // Navigation switches back to Kairos itself (app.js modeForTab).
  for (const tab of listed) {
    const grid = grids.get(tab.id); if (!grid) continue;
    const tile = button('', () => { closeMoreSheet(); go(tab.id); }, 'ms-tab-tile ms-glass');
    tile.innerHTML = `${tab.svg || ''}<span></span>`; tile.querySelector('span').textContent = tab.label; tile.dataset.tab = tab.id;
    // A custom tab without its own icon falls back to the Library glyph; give it a distinct generic one here.
    if (tab.id !== 'library' && tile.querySelector('svg')?.innerHTML === libraryGlyph()) tile.querySelector('svg').outerHTML = ICONS.tabGeneric;
    tile.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    tile.setAttribute('aria-label', tab.label);
    if (tab.id === current) tile.setAttribute('aria-current', 'page');
    grid.append(tile);
  }
  const projects = document.createElement('section'); projects.className = 'ms-sheet-projects';
  const addProject = document.querySelector('.forge-project-section .forge-icon-button');
  if (addProject) {
    const label = document.createElement('h3'); label.className = 'ms-group-label'; label.textContent = 'Forge projects'; projects.append(label);
    const action = (label, source) => button(label, () => { closeMoreSheet(); source.forgeProjectActions?.(opener); }, 'ms-account-row');
    projects.append(action('Add project', addProject));
    for (const source of document.querySelectorAll('.forge-project-row')) {
      const row = document.createElement('div'); row.className = 'ms-sheet-activity-row';
      const name = source.getAttribute('aria-label') || source.textContent;
      row.append(button(name, () => { closeMoreSheet(); source.click(); }, 'ms-sheet-activity-main'));
      const more = action('Project actions', source); more.setAttribute('aria-label', `Actions for ${name}`); row.append(more); projects.append(row);
    }
  }
  const footer = document.createElement('div'); footer.className = 'ms-sheet-footer';
  const name = document.querySelector('.sidebar-user-name')?.textContent || 'Account';
  // Profile: the account's initial and name; it opens Switch User and Log Out.
  const account = button('', () => {
    closeMoreSheet();
    import('./workspaceProfile.js').then(module => module.openWorkspaceProfile(from));
    return;
  }, 'ms-account-row ms-profile-row');
  const initial = document.createElement('span'); initial.className = 'ms-profile-initial'; initial.setAttribute('aria-hidden', 'true');
  initial.textContent = document.querySelector('.sidebar-avatar')?.textContent || name.slice(0, 1).toUpperCase() || 'K';
  const who = document.createElement('span'); who.className = 'ms-profile-name'; who.textContent = name;
  const profileDetail = document.createElement('small'); profileDetail.className = 'ms-profile-detail'; profileDetail.textContent = 'Profile, switch user, log out';
  const copy = document.createElement('span'); copy.className = 'ms-profile-copy'; copy.append(who, profileDetail);
  account.append(initial, copy); account.setAttribute('aria-label', `${name}, account`); account.setAttribute('aria-haspopup', 'dialog');
  const settings = button('', () => { closeMoreSheet(); document.querySelector('.sidebar-settings-btn')?.click(); }, 'ms-account-row ms-settings-row');
  settings.innerHTML = `${ICONS.settings}<span>Settings</span>`; settings.firstElementChild?.setAttribute('aria-hidden', 'true'); settings.setAttribute('aria-label', 'Settings');
  const extras = document.createElement('details'); extras.className = 'ms-more-extras';
  const extrasLabel = document.createElement('summary'); extrasLabel.textContent = 'More options'; extras.append(extrasLabel);
  extras.append(button('Notifications', () => { closeMoreSheet(); openNotifications(from); }, 'ms-account-row'), projects);
  footer.append(account, settings);
  const native = document.querySelector('.native-mobile-settings');
  if (native) footer.append(button(native.textContent, () => { closeMoreSheet(); native.click(); }, 'ms-account-row'));
  const { live, done } = activityItems();
  const work = document.createElement('section'); work.className = 'ms-sheet-activity'; work.setAttribute('aria-label', 'Work and updates');
  if (live.length || done.length) {
    const title = document.createElement('h3'); title.textContent = 'Working and waiting'; work.append(title);
    for (const item of live) {
      const row = document.createElement('div'); row.className = 'ms-sheet-activity-row' + (item.needsYou ? ' ms-needs-you' : '');
      row.append(button(`${item.title}${item.detail ? ' · ' + item.detail : ''}`, () => { closeMoreSheet(); item.go?.(); }, 'ms-sheet-activity-main'));
      if (item.stop) row.append(button('Stop', () => item.stop(), 'ms-sheet-activity-stop'));
      work.append(row);
    }
    for (const item of done) {
      const row = document.createElement('div'); row.className = 'ms-sheet-activity-row';
      row.append(button(`${item.title} · ${item.status}`, () => { closeMoreSheet(); item.go(); }, 'ms-sheet-activity-main')); work.append(row);
    }
  }
  const header = document.createElement('header'); header.className = 'ms-more-header';
  extras.append(work);
  const closeButton = button('', closeMoreSheet, 'ms-sheet-close'); closeButton.innerHTML = ICONS.close; closeButton.setAttribute('aria-label', 'Close');
  header.append(heading, closeButton);
  panel.append(grab, header, groups, extras, footer); sheet.replaceChildren(panel);
  sheet.classList.add('rd-sheet-in'); sheet.setAttribute('aria-modal', 'true'); sheet.showModal();
  // Focus the dialog itself, not the grabber: no ring on open; Tab then reaches the first control.
  sheet.tabIndex = -1; sheet.focus({ preventScroll: true });
}

export function initMoreSheet() {
  document.addEventListener('kairos:mobile-drawer-opening', event => { if (event.detail?.id !== 'more-sheet') closeMoreSheet(); });
  const sync = () => { if (!mobileOn()) closeMoreSheet(); };
  addEventListener('resize', sync); document.addEventListener('kairos:appearance', sync);
  // Badge and Layout updates are reflected on the next open without moving focus.
}

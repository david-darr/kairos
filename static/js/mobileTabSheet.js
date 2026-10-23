import { openNotifications } from './mobileActions.js';
import { button, mobileOn, haptic, reduced } from './mobileShared.js';
import { activityItems } from './mobileActivity.js';
import { sidebarLayout } from './layout.js';
import { ICONS } from './icons.js';
import { ICON as KAIROS_MARK } from './brand.js';

// The More sheet (2026-10-22): opened from the tab bar's More (mobileTabBar.js).
// It holds every tab the bar does not, grouped as Settings > Layout groups
// them, the Kairos / Forge mode switch, Forge projects, work in progress, and
// the account and Settings. It replaced the avatar's workspace sheet.
let sheet, opener, startY;
// The tabs the bar itself shows; More lists the rest.
const ON_BAR = new Set(['home', 'chat', 'agents', 'calendar']);
const libraryGlyph = () => { const t = document.createElement('template'); t.innerHTML = ICONS.library; return t.content.firstElementChild.innerHTML; };
const setExpanded = value => { if (opener?.dataset?.tabbar === 'more') opener.setAttribute('aria-expanded', String(value)); };
export function closeMoreSheet() {
  if (!sheet?.open) return;
  sheet.close(); sheet.removeAttribute('aria-modal'); setExpanded(false);
  opener?.isConnected && opener.focus({ preventScroll: true });
}

export function openMoreSheet(from) {
  if (!mobileOn()) return;
  if (!sheet) {
    sheet = document.createElement('dialog'); sheet.className = 'ms-tab-sheet ms-more-sheet rd-sheet-in'; sheet.id = 'ms-more-sheet';
    sheet.setAttribute('aria-label', 'More');
    sheet.addEventListener('click', e => { if (e.target === sheet) closeMoreSheet(); });
    sheet.addEventListener('cancel', e => { e.preventDefault(); closeMoreSheet(); });
    sheet.addEventListener('touchstart', e => {
      startY = sheet.scrollTop <= 0 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    sheet.addEventListener('touchend', e => {
      if (startY && e.changedTouches[0].clientY - startY.y > 56 && Math.abs(e.changedTouches[0].clientX - startY.x) < 40) closeMoreSheet(); startY = null;
    });
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
  const sources = [...document.querySelectorAll('#nav .nav-item')];
  const grids = new Map();
  // Kairos's bar tabs, and Forge's only tab (Forge Home), are on the bar already.
  const forge = document.documentElement.dataset.appMode === 'forge';
  const listed = sources.filter(n => !['design', 'designs'].includes(n.dataset.tab) && !(forge || ON_BAR.has(n.dataset.tab)));
  for (const group of sidebarLayout(listed.map(n => n.dataset.tab))) {
    if (!group.ids.length) continue;
    const section = document.createElement('section'); section.className = 'ms-tab-group'; section.dataset.group = group.id;
    const label = document.createElement('h3'); label.className = 'ms-group-label'; label.textContent = group.label || 'Tabs';
    const grid = document.createElement('div'); grid.className = 'ms-tab-grid';
    section.append(label, grid); groups.append(section);
    for (const id of group.ids) grids.set(id, grid);
  }
  // The rendered nav is the source of truth for order, visibility, icons,
  // authorization and custom tabs. Copy presentation, delegate each action.
  for (const source of listed) {
    const grid = grids.get(source.dataset.tab); if (!grid) continue;
    const tile = button('', () => { closeMoreSheet(); source.click(); }, 'ms-tab-tile ms-glass');
    tile.innerHTML = source.innerHTML; tile.dataset.tab = source.dataset.tab;
    // A custom tab without its own icon falls back to the Library glyph; give it a distinct generic one here.
    if (source.dataset.tab !== 'library' && source.querySelector('svg')?.innerHTML === libraryGlyph()) tile.querySelector('svg').outerHTML = ICONS.tabGeneric;
    tile.setAttribute('aria-label', source.getAttribute('aria-label') || source.textContent.trim());
    if (source.hasAttribute('aria-current')) tile.setAttribute('aria-current', 'page');
    grid.append(tile);
  }
  const modeRow = modeSwitch();
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
    account.setAttribute('aria-expanded', String(accountActions.hidden === false ? false : true));
    accountActions.hidden = !accountActions.hidden;
  }, 'ms-account-row ms-profile-row');
  const initial = document.createElement('span'); initial.className = 'ms-profile-initial'; initial.setAttribute('aria-hidden', 'true');
  initial.textContent = document.querySelector('.sidebar-avatar')?.textContent || name.slice(0, 1).toUpperCase() || 'K';
  const who = document.createElement('span'); who.className = 'ms-profile-name'; who.textContent = name;
  account.append(initial, who); account.setAttribute('aria-label', `${name}, account`);
  account.setAttribute('aria-expanded', 'false');
  const accountActions = document.createElement('div'); accountActions.hidden = true;
  for (const source of document.querySelectorAll('#sidebar-footer .overflow-menu-item')) {
    const action = button(source.textContent, () => { closeMoreSheet(); source.click(); }, 'ms-account-row');
    action.disabled = source.disabled; action.title = source.title; accountActions.append(action);
  }
  const settings = button('', () => { closeMoreSheet(); document.querySelector('.sidebar-settings-btn')?.click(); }, 'ms-account-row ms-settings-row');
  settings.innerHTML = `${ICONS.settings}<span>Settings</span>`; settings.firstElementChild?.setAttribute('aria-hidden', 'true'); settings.setAttribute('aria-label', 'Settings');
  footer.append(button('Notifications', () => { closeMoreSheet(); openNotifications(from); }, 'ms-account-row'), account, accountActions, settings);
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
  header.append(heading, button('Close', closeMoreSheet, 'ms-sheet-close'));
  panel.append(grab, header, modeRow, groups, projects, work, footer); sheet.replaceChildren(panel);
  sheet.setAttribute('aria-modal', 'true'); sheet.showModal(); setExpanded(true);
  // Focus the dialog itself, not the grabber: no ring on open; Tab then reaches the first control.
  sheet.tabIndex = -1; sheet.focus({ preventScroll: true });
}

// The app mode switch at the top of the More sheet: one segmented radio group,
// Kairos and Forge Preview, each with its mark and a one-line description.
// It delegates to the sidebar's own mode buttons, so Kairos still lands on
// the dashboard and Forge on the Forge Home overview. Arrow keys move focus
// only (manual activation): Space or Enter switches, because switching
// closes the sheet and changes the whole app.
const MODES = {
  kairos: { name: 'Kairos', mark: () => KAIROS_MARK, about: 'Your assistant, chats and everyday tabs' },
  forge: { name: 'Forge', badge: 'Preview', mark: () => ICONS.code, about: 'Coding agents working across your projects' },
};
function modeSwitch() {
  const row = document.createElement('section'); row.className = 'ms-mode-row';
  const sources = [...document.querySelectorAll('#forge-mode-switch [data-mode]')].filter(source => MODES[source.dataset.mode]);
  row.hidden = sources.length < 2;
  if (row.hidden) return row;
  const active = document.documentElement.dataset.appMode === 'forge' ? 'forge' : 'kairos';
  const group = document.createElement('div'); group.className = 'ms-mode-switch';
  group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'App mode'); group.dataset.active = active;
  const thumb = document.createElement('span'); thumb.className = 'ms-mode-thumb'; thumb.setAttribute('aria-hidden', 'true'); group.append(thumb);
  const captions = [];
  let switching = false;
  const radios = sources.map(source => {
    const mode = source.dataset.mode, info = MODES[mode];
    const caption = document.createElement('p'); caption.className = 'ms-mode-caption'; caption.id = `ms-mode-about-${mode}`;
    caption.textContent = info.about; caption.hidden = mode !== active; captions.push(caption);
    const radio = button('', () => {
      if (switching) return;
      switching = true; haptic();
      radios.forEach(other => { other.setAttribute('aria-checked', String(other === radio)); other.tabIndex = other === radio ? 0 : -1; });
      captions.forEach(item => { item.hidden = item !== caption; });
      group.dataset.active = mode;
      // The thumb slides across before the app changes; with reduced motion it switches at once.
      setTimeout(() => { closeMoreSheet(); source.click(); }, reduced.matches ? 0 : 220);
    }, 'ms-mode-option');
    radio.setAttribute('role', 'radio'); radio.dataset.mode = mode;
    radio.setAttribute('aria-checked', String(mode === active)); radio.tabIndex = mode === active ? 0 : -1;
    radio.setAttribute('aria-describedby', caption.id);
    radio.innerHTML = info.mark();
    radio.firstElementChild?.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'ms-mode-name'; name.textContent = info.name; radio.append(name);
    if (info.badge) { const badge = document.createElement('small'); badge.textContent = info.badge; name.append(' ', badge); }
    group.append(radio);
    return radio;
  });
  group.addEventListener('keydown', event => {
    const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    const at = radios.indexOf(document.activeElement);
    if (at < 0 || !(event.key in keys || event.key === 'Home' || event.key === 'End')) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1 : (at + keys[event.key] + radios.length) % radios.length;
    radios.forEach((radio, i) => { radio.tabIndex = i === next ? 0 : -1; });
    radios[next].focus();
  });
  row.append(group, ...captions);
  return row;
}

export function initMoreSheet() {
  document.addEventListener('kairos:mobile-drawer-opening', event => { if (event.detail?.id !== 'more-sheet') closeMoreSheet(); });
  const sync = () => { if (!mobileOn()) closeMoreSheet(); };
  addEventListener('resize', sync); document.addEventListener('kairos:appearance', sync);
  // Badge and Layout updates are reflected on the next open without moving focus.
}

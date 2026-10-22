import { button, mobileOn, haptic } from './mobileShared.js';
import { attentionCount, activityItems } from './mobileActivity.js';
import { sidebarLayout } from './layout.js';
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
    sheet = document.createElement('dialog'); sheet.className = 'ms-tab-sheet'; sheet.id = 'ms-workspace-sheet';
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
      if (e.key === 'Escape') { e.preventDefault(); closeTabSheet(); return; }
      if (e.key !== 'Tab') return;
      const controls = [...sheet.querySelectorAll('button, a[href]')].filter(n => !n.disabled && n.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    document.body.append(sheet);
  }
  document.dispatchEvent(new CustomEvent('kairos:mobile-drawer-opening', { detail: { id: 'workspace-sheet' } }));
  opener = from; haptic();
  const panel = document.createElement('div'); panel.className = 'ms-sheet-panel';
  const grab = button('Close workspace', closeTabSheet, 'ms-sheet-grab'); grab.setAttribute('aria-label', 'Close workspace');
  const heading = document.createElement('h2'); heading.className = 'ms-sheet-heading'; heading.textContent = 'Your workspace';
  const groups = document.createElement('nav'); groups.setAttribute('aria-label', 'Tabs');
  const sources = [...document.querySelectorAll('#nav .nav-item')];
  const grids = new Map();
  for (const group of sidebarLayout(sources.map(n => n.dataset.tab))) {
    if (!group.ids.length) continue;
    const section = document.createElement('section'); section.className = 'ms-tab-group'; section.dataset.group = group.id;
    const label = document.createElement('h3'); label.className = 'ms-group-label'; label.textContent = document.documentElement.dataset.appMode === 'forge' ? 'Forge' : group.label || 'Top';
    const grid = document.createElement('div'); grid.className = 'ms-tab-grid';
    section.append(label, grid); groups.append(section);
    for (const id of group.ids) grids.set(id, grid);
  }
  // The rendered nav is the source of truth for order, visibility, icons,
  // authorization and custom tabs. Copy presentation, delegate each action.
  for (const source of sources) {
    const grid = grids.get(source.dataset.tab); if (!grid) continue;
    const tile = button('', () => { closeTabSheet(); source.click(); }, 'ms-tab-tile ms-glass');
    tile.innerHTML = source.innerHTML; tile.dataset.tab = source.dataset.tab;
    // A custom tab without its own icon falls back to the Library glyph; give it a distinct generic one here.
    if (source.dataset.tab !== 'library' && source.querySelector('svg')?.innerHTML === libraryGlyph()) tile.querySelector('svg').outerHTML = ICONS.tabGeneric;
    tile.setAttribute('aria-label', source.getAttribute('aria-label') || source.textContent.trim());
    if (source.dataset.tab === 'forgeHome') { tile.querySelector('span').textContent = 'Forge Home'; tile.setAttribute('aria-label', 'Forge Home'); }
    if (source.hasAttribute('aria-current')) tile.setAttribute('aria-current', 'page');
    if (source.dataset.tab === 'home' && attentionCount()) {
      const badge = document.createElement('span'); badge.className = 'nav-badge'; badge.textContent = String(attentionCount());
      tile.append(badge); tile.setAttribute('aria-label', `Home, ${attentionCount()} need you`);
    }
    grid.append(tile);
  }
  const modeRow = document.createElement('section'); modeRow.className = 'ms-mode-row';
  const modeLabel = document.createElement('h3'); modeLabel.className = 'ms-group-label'; modeLabel.textContent = 'Mode'; modeRow.append(modeLabel);
  for (const source of document.querySelectorAll('#forge-mode-switch [data-mode]')) {
    const mode = source.dataset.mode;
    const target = button(mode === 'forge' ? 'Forge Preview' : 'Kairos', () => { closeTabSheet(); source.click(); }, 'ms-account-row');
    target.setAttribute('aria-pressed', String(document.documentElement.dataset.appMode === mode)); modeRow.append(target);
  }
  modeRow.hidden = modeRow.childElementCount === 1;
  const projects = document.createElement('section'); projects.className = 'ms-sheet-projects';
  const addProject = document.querySelector('.forge-project-section .forge-icon-button');
  if (addProject) {
    const label = document.createElement('h3'); label.className = 'ms-group-label'; label.textContent = 'Forge projects'; projects.append(label);
    const action = (label, source) => button(label, () => { closeTabSheet(); source.forgeProjectActions?.(opener); }, 'ms-account-row');
    projects.append(action('Add project', addProject));
    for (const source of document.querySelectorAll('.forge-project-row')) {
      const row = document.createElement('div'); row.className = 'ms-sheet-activity-row';
      const name = source.getAttribute('aria-label') || source.textContent;
      row.append(button(name, () => { closeTabSheet(); source.click(); }, 'ms-sheet-activity-main'));
      const more = action('Project actions', source); more.setAttribute('aria-label', `Actions for ${name}`); row.append(more); projects.append(row);
    }
  }
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
  if (native) footer.append(button(native.textContent, () => { closeTabSheet(); native.click(); }, 'ms-account-row'));
  // TEMPORARY (2026-10-21): one line of iOS Safari page state for one screenshot from David. Remove after.
  footer.append(pageReadout());
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
  panel.append(grab, heading, groups, modeRow, projects, work, footer); sheet.replaceChildren(panel);
  sheet.setAttribute('aria-modal', 'true'); sheet.showModal();
  // Focus the dialog itself, not the grabber: no ring on open; Tab then reaches the first control.
  sheet.tabIndex = -1; sheet.focus({ preventScroll: true });
}

// TEMPORARY (2026-10-21): what Safari sees. Gate inputs, scroll state, the large viewport, and every fixed or
// sticky element at least 80% wide within 4px of the top or 3px of the bottom, with its background colour.
function pageReadout() {
  const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;top:0;width:1px;height:100lvh;visibility:hidden;pointer-events:none';
  document.body.append(probe); const lvh = probe.offsetHeight; probe.remove();
  const edges = [];
  for (const node of document.querySelectorAll('body *')) {
    if (node.closest('.ms-tab-sheet')) continue;
    const s = getComputedStyle(node); if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    const r = node.getBoundingClientRect(); if (!node.getClientRects().length || r.width < innerWidth * .8 || r.height < 3) continue;
    const top = r.top <= 4 && r.bottom > 0, bottom = r.bottom >= innerHeight - 3 && r.top < innerHeight;
    if (top || bottom) edges.push(`${node.id ? '#' + node.id : (node.className && typeof node.className === 'string' ? '.' + node.className.split(' ')[0] : node.tagName.toLowerCase())} ${s.position}${top ? ' top' : ''}${bottom ? ' bottom' : ''} ${s.backgroundColor}`);
  }
  const line = document.createElement('p'); line.className = 'ms-sheet-readout';
  line.textContent = `Safari tab ${document.documentElement.classList.contains('ms-safari-bleed') ? 'on' : 'off'} · touch-callout ${!!globalThis.CSS?.supports?.('-webkit-touch-callout', 'none')} · standalone ${navigator.standalone} · scrollY ${scrollY} · scrollHeight ${document.scrollingElement?.scrollHeight} · innerHeight ${innerHeight} · visualViewport ${Math.round(visualViewport?.height || 0)} · 100lvh ${lvh} · edges: ${edges.join('; ') || 'none'}`;
  return line;
}

export function initTabSheet() {
  document.addEventListener('kairos:mobile-drawer-opening', event => { if (event.detail?.id !== 'workspace-sheet') closeTabSheet(); });
  const sync = () => { if (!mobileOn()) closeTabSheet(); };
  addEventListener('resize', sync); document.addEventListener('kairos:appearance', sync);
  // Badge and Layout updates are reflected on the next open without moving focus.
}

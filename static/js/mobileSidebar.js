import { mobileOn, phone, go, haptic } from './mobileShared.js';
import { ICONS } from './icons.js';
import { ICON as KAIROS_MARK } from './brand.js';
import { openMoreSheet } from './mobileTabSheet.js';
import { keyboardLift } from './mobileDock.js';
import { chatPage } from './mobileShell.js';
import { badgeCounts } from './mobileActivity.js';
import { registerMobileDrawer, isMainDrawerZone } from './mobileDrawers.js';

// The phone's sliding sidebar (David, 2026-11-02, as the Claude app has it;
// it replaced the bottom tab bar of 2026-10-22). The brand at the top; Home,
// Chats, Forge and Bots; More, which lists every other tab; the profile, which
// opens Settings, and New chat at the bottom. It opens from the round menu
// button on each top-level page, Kip's menu button, or a swipe right; the page
// slides aside, rounded and dimmed, and a tap on it or a swipe left closes it.

// Pushed pages carry their own back control, and full-screen views their own
// way out; the menu button stays off them (a swipe still opens the sidebar).
const NO_BUTTON = [
  '.ms-conversation:not(.ms-launch-chat)', '.ms-live-chat', '.mf-session', '.settings-mobile-page', '.library-editor',
  '.vault-phone-detail', '.bots-shell', '.design-focus', '#chat-sessions.open', '.agent-conversations-home.is-open',
  '#view-content .artifact-panel', '.bots-panel-aside', '.bots-attn:not([hidden])',
].join(', ');
const glyph = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const GLYPHS = {
  menu: glyph('<path d="M4 8h16M4 16h11"/>'),
  home: glyph('<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>'),
  chats: glyph('<path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 10h8M8 13h5"/>'),
  forge: glyph('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>'),
  bots: glyph('<circle cx="9" cy="9" r="3.5"/><path d="M3 19c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5"/><circle cx="17" cy="8" r="2.5"/><path d="M16 13.5c2.4 0 4.2 1.2 5 3.5"/>'),
  more: glyph('<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>'),
  write: glyph('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
};
const mode = () => document.documentElement.dataset.appMode || 'kairos';
// Forge and Bots are admin-only; the sidebar's own mode switch exists only for an admin.
const hasMode = id => !!document.querySelector(`#forge-mode-switch [data-mode="${id}"]`);
const ROWS = [
  { id: 'home', label: 'Home', badge: 'activity', open: () => go('home') },
  { id: 'chats', label: 'Chats', open: () => {
    // Already on the chat workspace: Chats shows the list of chats.
    if (mode() === 'kairos' && document.querySelector('.ms-live-chat')) go('chat', { mobilePage: 1 });
    else if (mode() === 'kairos' && document.documentElement.dataset.view === 'mobileLaunch' && document.getElementById('ms-tab-1')?.isConnected) document.getElementById('ms-tab-1').click();
    else go('chat', { mobilePage: chatPage() });
  } },
  { id: 'forge', label: 'Forge', admin: true, open: () => go('forgeHome') },
  { id: 'bots', label: 'Bots', admin: true, badge: 'bots', open: () => go('botsHome') },
];

let drawer, scrim, nav, menu, opener = null, frame = 0, anchor = null;
// The page observer watches the whole document, these writes included: change only what changed.
const setHidden = (node, value) => { if (node.hidden !== value) node.hidden = value; };

// Which row the page on screen belongs to; anything else lives under More.
function selection() {
  if (mode() === 'forge') return 'forge';
  if (mode() === 'bots') return 'bots';
  return { home: 'home', mobileLaunch: 'chats', chat: 'chats' }[document.documentElement.dataset.view] || 'more';
}
export const drawerOpen = () => document.documentElement.classList.contains('ms-drawer-open');
const controls = () => [...drawer.querySelectorAll('button')].filter(node => !node.hidden && node.getClientRects().length);

function row(id, label, action) {
  const node = document.createElement('button'); node.type = 'button'; node.className = 'ms-drawer-row'; node.dataset.drawer = id;
  node.innerHTML = `${GLYPHS[id]}<span class="ms-drawer-label"></span>`;
  node.querySelector('.ms-drawer-label').textContent = label;
  node.addEventListener('click', () => { haptic(); action(); });
  return node;
}

function build() {
  drawer = document.createElement('div'); drawer.className = 'ms-drawer'; drawer.id = 'ms-drawer'; drawer.tabIndex = -1;
  drawer.setAttribute('aria-label', 'Menu');
  const brand = document.createElement('div'); brand.className = 'ms-drawer-brand';
  brand.innerHTML = `${KAIROS_MARK}<span>Kairos</span>`; brand.firstElementChild.setAttribute('aria-hidden', 'true');
  nav = document.createElement('nav'); nav.className = 'ms-drawer-nav'; nav.setAttribute('aria-label', 'Main');
  for (const item of ROWS) {
    const node = row(item.id, item.label, () => { close(false); item.open(); });
    if (item.admin) node.dataset.admin = 'true';
    if (item.badge) node.dataset.badge = item.badge;
    nav.append(node);
  }
  const more = row('more', 'More', () => { close(false); openMoreSheet(menuTarget()); });
  more.setAttribute('aria-haspopup', 'dialog'); nav.append(more);
  const foot = document.createElement('div'); foot.className = 'ms-drawer-foot';
  const profile = document.createElement('button'); profile.type = 'button'; profile.className = 'ms-drawer-profile';
  profile.innerHTML = '<span class="ms-drawer-avatar" aria-hidden="true"></span><span class="ms-drawer-name"></span>';
  profile.addEventListener('click', () => { haptic(); close(false); document.querySelector('.sidebar-settings-btn')?.click(); });
  const create = document.createElement('button'); create.type = 'button'; create.className = 'ms-drawer-new';
  create.innerHTML = `${GLYPHS.write}<span>New chat</span>`;
  create.addEventListener('click', () => { haptic(); close(false); go('chat', { mobileConversation: true }); });
  foot.append(profile, create);
  drawer.append(brand, nav, foot);
  scrim = document.createElement('div'); scrim.className = 'ms-drawer-scrim'; scrim.setAttribute('aria-hidden', 'true');
  scrim.addEventListener('click', () => close());
  drawer.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const list = controls(), first = list[0], last = list.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  menu = document.createElement('button'); menu.type = 'button'; menu.className = 'ms-menu-btn';
  menu.innerHTML = GLYPHS.menu; menu.setAttribute('aria-label', 'Open menu');
  menu.setAttribute('aria-haspopup', 'dialog'); menu.setAttribute('aria-controls', 'ms-drawer'); menu.setAttribute('aria-expanded', 'false');
  menu.addEventListener('click', () => openDrawer(menu));
  document.body.append(scrim, drawer, menu);
}

// The profile: the account's initial and name, as the desktop sidebar footer has them.
function paintProfile() {
  const name = document.querySelector('.sidebar-user-name')?.textContent.trim() || 'Account';
  drawer.querySelector('.ms-drawer-avatar').textContent = document.querySelector('.sidebar-avatar')?.textContent || name.slice(0, 1).toUpperCase();
  drawer.querySelector('.ms-drawer-name').textContent = name;
  drawer.querySelector('.ms-drawer-profile').setAttribute('aria-label', `${name}, Settings`);
}

function paintRows() {
  const current = selection();
  const { need, live } = badgeCounts();
  for (const node of nav.querySelectorAll('.ms-drawer-row')) {
    if (node.dataset.admin) setHidden(node, !hasMode(node.dataset.drawer));
    if (node.dataset.drawer === current) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    const label = node.querySelector('.ms-drawer-label').textContent;
    let count = '', spoken = '';
    if (node.dataset.badge === 'activity') { count = need || live || ''; spoken = need ? `${need} need you` : live ? `${live} working` : ''; }
    if (node.dataset.badge === 'bots') {
      count = document.querySelector('#nav .nav-item[data-tab="botsHome"] .nav-badge')?.textContent.trim() || '';
      spoken = count ? `${count} waiting on you` : '';
    }
    let badge = node.querySelector('.ms-drawer-badge');
    if (count && !badge) { badge = document.createElement('span'); badge.className = 'ms-drawer-badge'; badge.setAttribute('aria-hidden', 'true'); node.append(badge); }
    const text = typeof count === 'number' && count > 99 ? '99+' : String(count);
    if (badge) { if (badge.textContent !== text) badge.textContent = text; setHidden(badge, !count); }
    node.setAttribute('aria-label', spoken ? `${label}, ${spoken}` : label);
  }
}

// The top-level page's own title: the menu button sits beside it. While the
// sidebar is open the button keeps its place, hidden under it (CSS).
function pageTitle() {
  const view = document.getElementById('view-content');
  // Measured against the page, which is slid aside while the sidebar is open.
  const page = document.getElementById('content')?.getBoundingClientRect().left || 0;
  return [...view.querySelectorAll('h1, h2')].find(node => {
    if (!node.getClientRects().length) return false;
    const box = node.getBoundingClientRect();
    return box.top < 220 && box.left - page < 90;
  }) || null;
}

function placeMenu() {
  const show = mobileOn() && !document.querySelector(NO_BUTTON) && !(keyboardLift(innerHeight, window.visualViewport) > 0);
  const title = show ? (anchor?.isConnected && anchor.getClientRects().length ? anchor : pageTitle()) : null;
  if (anchor && anchor !== title) { anchor.classList.remove('ms-menu-indent'); anchor.style.removeProperty('--ms-menu-pad'); }
  if (title && title !== anchor) {
    // A title shorter than the button grows to its height, so the button never meets the row below.
    const height = title.getBoundingClientRect().height;
    if (height < 44) title.style.setProperty('--ms-menu-pad', `${(44 - height) / 2}px`);
    title.classList.add('ms-menu-indent');
  }
  anchor = title;
  setHidden(menu, !title);
  // The page rises in after it renders; follow its title until the person scrolls, then the button stays put.
  if (title && !(document.getElementById('view-content')?.scrollTop > 2)) {
    // Centred on the title's first line, so a title that wraps (or grows when a name loads) keeps it in place.
    const range = document.createRange(); range.selectNodeContents(title);
    const line = range.getClientRects()[0] || title.getBoundingClientRect();
    menu.style.setProperty('--ms-menu-top', `${Math.max(0, Math.round(line.top + line.height / 2 - 22))}px`);
  }
}

function update() {
  frame = 0;
  if (!drawer) return;
  if (!mobileOn() && drawerOpen()) close(false);
  paintRows(); placeMenu();
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
// A new page or size: measure its title afresh.
const release = () => { anchor?.classList.remove('ms-menu-indent'); anchor?.style.removeProperty('--ms-menu-pad'); anchor = null; };
// Kip draws its own menu button; focus returns to whichever opened the sidebar.
const menuTarget = () => (opener?.isConnected && opener.getClientRects().length ? opener : null) || (!menu.hidden ? menu : null);

export function openDrawer(from = menu) {
  if (!mobileOn() || !drawer || drawerOpen()) return;
  document.dispatchEvent(new CustomEvent('kairos:mobile-drawer-opening', { detail: { id: 'drawer' } }));
  opener = from; haptic(); paintProfile(); paintRows();
  const root = document.documentElement;
  root.classList.add('ms-drawer-open');
  drawer.inert = false; drawer.removeAttribute('aria-hidden'); drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true');
  const content = document.getElementById('content'); if (content) content.inert = true;
  for (const node of [menu, from]) node?.setAttribute('aria-expanded', 'true');
  // Focus the sidebar itself, not a row: no ring on open; Tab then reaches the first row.
  drawer.focus({ preventScroll: true });
}

export function closeDrawer(restoreFocus = true) { close(restoreFocus); }
function close(restoreFocus = true) {
  if (!drawer) return;
  const wasOpen = drawerOpen();
  document.documentElement.classList.remove('ms-drawer-open');
  drawer.inert = true; drawer.setAttribute('aria-hidden', 'true'); drawer.removeAttribute('role'); drawer.removeAttribute('aria-modal');
  const content = document.getElementById('content'); if (content) content.inert = false;
  for (const node of [menu, opener]) node?.setAttribute('aria-expanded', 'false');
  if (!wasOpen) return;
  schedule();
  if (restoreFocus) requestAnimationFrame(() => menuTarget()?.focus({ preventScroll: true }));
}

export function mountSidebar() {
  if (drawer) return;
  build(); close(false);
  registerMobileDrawer({ panel: drawer, backdrop: scrim, isOpen: drawerOpen,
    // Leave the outermost edge to Safari's system Back gesture (mobileDrawers.js).
    // A pager past its first page takes a swipe right back a page first, as iOS does (mobilePager.js).
    canOpen: (target, touch) => mobileOn() && isMainDrawerZone(touch) && !target.closest('.ms-page-track')?.firstElementChild?.inert,
    open: () => openDrawer(menuTarget() || menu), close: () => close(),
    onDrag: (offset, width) => {
      const root = document.documentElement;
      root.classList.add('ms-drawer-dragging');
      root.style.setProperty('--ms-drawer-x', `${Math.round(width + offset)}px`);
    },
    onDragEnd: () => {
      const root = document.documentElement;
      root.classList.remove('ms-drawer-dragging'); root.style.removeProperty('--ms-drawer-x');
    },
  });
  document.addEventListener('jarvis:navigate', () => close(false));
  document.addEventListener('kairos:mobile-drawer-opening', event => { if (event.detail?.id !== 'drawer') close(false); });
  // The page on screen, the pushed pages, full-screen sheets outside the page (the Bots inbox) and the Bots badge all live in the DOM; one observer, coalesced to a frame.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  new MutationObserver(schedule).observe(document.getElementById('nav'), { childList: true, subtree: true, characterData: true });
  new MutationObserver(() => { release(); schedule(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-view', 'data-app-mode'] });
  window.visualViewport?.addEventListener('resize', schedule);
  addEventListener('resize', () => { release(); schedule(); });
  phone.addEventListener('change', schedule); document.addEventListener('kairos:appearance', schedule);
  document.addEventListener('kairos:mobile-activity', schedule);
  // Entrance motion ends without changing the DOM; place the button again once the page has settled.
  document.getElementById('content')?.addEventListener('animationend', schedule);
  update();
}

// The control focus returns to on a phone: the menu button when the page shows one.
export const menuButton = () => (menu && !menu.hidden ? menu : null);

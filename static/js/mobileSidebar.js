import { mobileOn, phone, go, haptic, reduced } from './mobileShared.js';
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
// On a pushed page (a chat, a bot, a Forge session, a Settings page, a document,
// a vault note) a swipe right goes back first, the page following the finger;
// the next swipe, on the top-level page, opens the sidebar (2026-11-03, David).

// Pushed pages carry their own back control, and full-screen views their own
// way out; the menu button stays off them.
const NO_BUTTON = [
  '.ms-conversation:not(.ms-launch-chat)', '.ms-live-chat', '.mf-session', '.settings-mobile-page', '.library-editor',
  '.vault-phone-detail', '.bots-shell', '.design-focus', '#chat-sessions.open', '.agent-conversations-home.is-open',
  '#view-content .artifact-panel', '.bots-panel-aside', '.bots-attn:not([hidden])',
].join(', ');
// Each pushed page's way back, innermost first (a bot's drill-down page before the bot itself).
const BACK = ['.settings-mobile-back', '.library-editor-back', '.vault-phone-back', '.mf-back', '.bots-back', '.bots-head-back', '.ms-chat-back'];
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
// sidebar is open the button rides aside with the page, under the dim (CSS).
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

// Letting go of a swipe finishes at the finger's speed: the curve starts at
// about 2.25x its average speed (cubic-bezier(.32,.72,0,1)), so the slide lasts
// 2.25 x distance / speed, kept between 200ms and the usual 420ms.
let settleTimer = 0, settleEnd = null;
function pace(from, to, speed) {
  const root = document.documentElement;
  const distance = Math.abs(to - from);
  if (speed > 0 && distance > 0) root.style.setProperty('--ms-drawer-dur', `${Math.round(Math.min(420, Math.max(200, 2.25 * distance / speed)))}ms`);
  else root.style.removeProperty('--ms-drawer-dur');
}
// The page keeps its transform until the slide closed has finished, then lets it go
// (a transformed page would hold its fixed children, and the corners would pop).
function settle() {
  const root = document.documentElement, content = document.getElementById('content');
  clearTimeout(settleTimer); if (settleEnd) content?.removeEventListener('transitionend', settleEnd);
  const done = () => {
    clearTimeout(settleTimer); content?.removeEventListener('transitionend', onEnd); settleEnd = null;
    // At rest already: letting go of the transform must not start a transition of its own.
    if (!drawerOpen() && root.classList.contains('ms-drawer-settling')) {
      if (content) content.style.transition = 'none';
      root.classList.remove('ms-drawer-settling');
      content?.getBoundingClientRect();
      if (content) content.style.transition = '';
    }
    root.style.removeProperty('--ms-drawer-dur');
  };
  const onEnd = event => { if (event.target === content && event.propertyName === 'transform') done(); };
  settleEnd = onEnd; content?.addEventListener('transitionend', onEnd);
  settleTimer = setTimeout(done, (parseFloat(getComputedStyle(root).getPropertyValue('--ms-drawer-dur')) || 420) + 120);
}
// The swipe's own state ends only once open or close has set where the page goes,
// so the slide starts from the finger's place, not from where the page was.
function letGo() {
  const root = document.documentElement;
  if (!root.classList.contains('ms-drawer-dragging')) return;
  root.classList.remove('ms-drawer-dragging'); root.style.removeProperty('--ms-drawer-x'); root.style.removeProperty('--ms-drawer-p');
}
const drawerWidth = () => drawer.getBoundingClientRect().width || Math.min(innerWidth * .84, 330);
const pageX = () => Math.max(0, document.getElementById('content')?.getBoundingClientRect().left || 0);

export function openDrawer(from = menu, { speed = 0 } = {}) {
  if (!mobileOn() || !drawer || drawerOpen()) return;
  document.dispatchEvent(new CustomEvent('kairos:mobile-drawer-opening', { detail: { id: 'drawer' } }));
  opener = from; haptic(); paintProfile(); paintRows();
  const root = document.documentElement;
  pace(pageX(), drawerWidth(), speed);
  root.classList.add('ms-drawer-open', 'ms-drawer-settling'); letGo(); settle();
  drawer.inert = false; drawer.removeAttribute('aria-hidden'); drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true');
  const content = document.getElementById('content'); if (content) content.inert = true;
  // The menu button moves aside with the page, under the dim: out of reach until the sidebar closes.
  menu.inert = true;
  for (const node of [menu, from]) node?.setAttribute('aria-expanded', 'true');
  // Focus the sidebar itself, not a row: no ring on open; Tab then reaches the first row.
  drawer.focus({ preventScroll: true });
}

export function closeDrawer(restoreFocus = true) { close(restoreFocus); }
function close(restoreFocus = true, { speed = 0 } = {}) {
  if (!drawer) return;
  const wasOpen = drawerOpen(), root = document.documentElement;
  if (wasOpen) { pace(pageX(), 0, speed); root.classList.add('ms-drawer-settling'); }
  root.classList.remove('ms-drawer-open'); letGo();
  if (wasOpen) settle();
  drawer.inert = true; drawer.setAttribute('aria-hidden', 'true'); drawer.removeAttribute('role'); drawer.removeAttribute('aria-modal');
  const content = document.getElementById('content'); if (content) content.inert = false;
  if (menu) menu.inert = false;
  for (const node of [menu, opener]) node?.setAttribute('aria-expanded', 'false');
  if (!wasOpen) return;
  schedule();
  if (restoreFocus) requestAnimationFrame(() => menuTarget()?.focus({ preventScroll: true }));
}

// ---- Swipe back: the page follows the finger right, then its own Back runs ----
const shown = node => node.isConnected && !node.disabled && node.getClientRects().length > 0 &&
  getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden], [inert], [aria-hidden="true"], dialog, .ms-drawer');
function backControl(target, touch) {
  // The outermost edge is Safari's own Back, except in the home-screen app, which has none.
  if (!mobileOn() || touch.clientX > Math.min(200, innerWidth * .5) || (touch.clientX < 16 && navigator.standalone !== true)) return null;
  const content = document.getElementById('content');
  if (!content?.contains(target)) return null;
  for (const selector of BACK) {
    const node = [...content.querySelectorAll(selector)].find(shown);
    if (node) return node;
  }
  return null;
}
let backTimer = 0;
const backX = px => document.documentElement.style.setProperty('--ms-back-x', `${Math.round(px)}px`);
function backReset(animate) {
  const root = document.documentElement, content = document.getElementById('content');
  clearTimeout(backTimer);
  if (!animate) {
    // The page that replaced it appears in place, without sliding in from the side it left by.
    const moved = [content, document.querySelector('.ms-global-frost')].filter(Boolean);
    for (const node of moved) node.style.transition = 'none';
    root.classList.remove('ms-back-dragging', 'ms-back-leaving', 'ms-back-return');
    root.style.removeProperty('--ms-back-x'); root.style.removeProperty('--ms-back-dur');
    content?.getBoundingClientRect();
    for (const node of moved) node.style.transition = '';
    if (!reduced.matches) content?.animate({ opacity: [0, 1] }, { duration: 180, easing: 'ease-out' });
    return;
  }
  root.classList.add('ms-back-return'); root.classList.remove('ms-back-dragging', 'ms-back-leaving'); backX(0);
  backTimer = setTimeout(() => backReset(false), 340);
}
function backDrag(dx) {
  if (reduced.matches) return;
  document.documentElement.classList.add('ms-back-dragging'); backX(dx);
}
function backCancel() {
  const root = document.documentElement;
  if (root.classList.contains('ms-back-dragging')) { root.classList.add('ms-back-return'); root.classList.remove('ms-back-dragging'); backX(0); }
  clearTimeout(backTimer); backTimer = setTimeout(() => {
    root.classList.remove('ms-back-return'); root.style.removeProperty('--ms-back-x');
  }, 340);
}
// The page slides off at the finger's speed, then the page's own Back runs. If that
// leaves the page in place (an unsaved-changes question, a refusal), it slides back.
function backGo(control, { speed = 0 } = {}) {
  const root = document.documentElement;
  if (reduced.matches || !root.classList.contains('ms-back-dragging')) { haptic(); control.click(); backReset(false); return; }
  const from = parseFloat(root.style.getPropertyValue('--ms-back-x')) || 0, distance = Math.max(1, innerWidth - from);
  root.style.setProperty('--ms-back-dur', `${speed > 0 ? Math.round(Math.min(320, Math.max(160, 2.25 * distance / speed))) : 280}ms`);
  root.classList.add('ms-back-leaving'); root.classList.remove('ms-back-dragging'); backX(innerWidth);
  clearTimeout(backTimer);
  backTimer = setTimeout(() => {
    const content = document.getElementById('content');
    let changed = false;
    const watch = new MutationObserver(() => { changed = true; });
    if (content) watch.observe(content, { childList: true, subtree: true });
    haptic(); control.click();
    const began = performance.now();
    const check = () => {
      // The page changed (whatever opens over the new one); else a question over it (unsaved changes) keeps it.
      if (!shown(control) || (changed && performance.now() - began > 60)) { watch.disconnect(); backReset(false); return; }
      if (document.querySelector('dialog[open], [aria-modal="true"]:not(.ms-drawer)')) { watch.disconnect(); backReset(true); return; }
      if (performance.now() - began > 900) { watch.disconnect(); backReset(true); return; }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, parseFloat(root.style.getPropertyValue('--ms-back-dur')) + 20);
}

export function mountSidebar() {
  if (drawer) return;
  build(); close(false);
  registerMobileDrawer({ panel: drawer, backdrop: scrim, isOpen: drawerOpen,
    // Leave the outermost edge to Safari's system Back gesture (mobileDrawers.js).
    // A pushed page goes back first (back); a top-level page, the Chats and Sessions lists included, opens the sidebar.
    canOpen: (target, touch) => mobileOn() && isMainDrawerZone(touch),
    back: backControl, onBackDrag: backDrag, onBack: backGo, onBackCancel: backCancel,
    open: info => openDrawer(menuTarget() || menu, info), close: info => close(true, info),
    onDrag: (offset, width) => {
      const root = document.documentElement;
      root.classList.add('ms-drawer-dragging');
      root.style.setProperty('--ms-drawer-x', `${Math.round(width + offset)}px`);
      root.style.setProperty('--ms-drawer-p', String(Math.max(0, Math.min(1, 1 + offset / width))));
    },
    // A swipe that does not commit eases back from the finger as well.
    onDragEnd: () => queueMicrotask(() => {
      const root = document.documentElement;
      if (!root.classList.contains('ms-drawer-dragging')) return;
      if (!drawerOpen()) root.classList.add('ms-drawer-settling');
      letGo(); settle();
    }),
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

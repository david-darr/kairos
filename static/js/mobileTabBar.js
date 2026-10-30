import { mobileOn, phone, go, haptic, reduced } from './mobileShared.js';
import { ICONS } from './icons.js';
import { openMoreSheet } from './mobileTabSheet.js';
import { keyboardLift } from './mobileDock.js';
import { chatPage } from './mobileShell.js';
import { rememberedProject } from './mobileForge.js';
import { openQuickCreate } from './mobileActions.js';
import { badgeCounts } from './mobileActivity.js';

// The phone tab bar stays on every phone page. It steps aside only for the
// keyboard and the full-screen views listed in FULLSCREEN. Tapping the current
// item on a pushed page returns to that tab's root. The root carries
// .ms-tabbar-up while shown, reserving --ms-tabbar-space for docks and padding.
// A side panel inside the page (documents, files, the browser, the computer)
// covers the page on a phone; the page is a stacking context, so it cannot
// rise above the bar and the bar steps aside instead.
const FULLSCREEN = [
  '.design-focus', '#chat-sessions.open', '.agent-conversations-home.is-open', '#view-content .artifact-panel', '.bots-panel-aside',
  '.bots-attn:not([hidden])',
].join(', ');
const SUBPAGE = [
  '.ms-conversation:not(.ms-launch-chat)', '.ms-live-chat', '.mf-session', '.settings-mobile-page',
  '.library-editor', '.vault-phone-detail', '.bots-shell',
].join(', ');
const nav = id => document.querySelector(`#nav .nav-item[data-tab="${id}"]`);
const forge = () => document.documentElement.dataset.appMode === 'forge';
const bots = () => document.documentElement.dataset.appMode === 'bots';
// The mode the bar is showing; each mode has its own items (Kairos, Forge, Bots).
const modeKey = () => forge() ? 'forge' : bots() ? 'bots' : 'kairos';
const pagerTab = index => document.getElementById(`mf-tab-${index}`);
// Board glyphs are local to the phone shell; desktop and Classic keep their icons.
const shellIcon = (name) => {
  const paths = {
    home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    chats: '<path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 10h8M8 13h5"/>',
    agents: '<circle cx="9" cy="9" r="3.5"/><path d="M3 19c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5"/><circle cx="17" cy="8" r="2.5"/><path d="M16 13.5c2.4 0 4.2 1.2 5 3.5"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    more: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>',
    sessions: '<path d="M5 6h14M5 12h14M5 18h9"/>',
    inbox: '<path d="M4 13 6.5 6h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  };
  return paths[name] ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${paths[name]}</svg>` : ICONS[name] || '';
};

// Kairos items delegate to the sidebar's own nav items, so Settings > Layout
// visibility and every navigation rule stay in one place.
const KAIROS = [
  { id: 'home', label: 'Home', icon: 'home', source: 'home', badge: 'activity' },
  { id: 'chats', label: 'Chats', icon: 'chats', source: 'chat',
    open: () => {
      // Already on the chat workspace: Chats shows the list of chats.
      if (document.querySelector('.ms-live-chat')) go('chat', { mobilePage: 1 });
      else if (document.getElementById('ms-tab-1')?.isConnected && document.documentElement.dataset.view === 'mobileLaunch') document.getElementById('ms-tab-1').click();
      else go('chat', { mobilePage: chatPage() });
    } },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', source: 'calendar' },
];
const FORGE = [
  { id: 'forgeHome', label: 'Forge Home', icon: 'home', source: 'forgeHome', badge: 'activity' },
  { id: 'new', label: 'New', icon: 'code', source: 'forgeHome',
    open: () => pagerTab(0)?.isConnected ? pagerTab(0).click() : go('forgeHome', { projectId: rememberedProject(), mobilePage: 0 }) },
  { id: 'sessions', label: 'Sessions', icon: 'sessions', source: 'forgeHome',
    open: () => pagerTab(1)?.isConnected ? pagerTab(1).click() : go('forgeHome', { projectId: rememberedProject(), mobilePage: 1 }) },
];
// Bots mode (Agents 3.0): the roster with each bot's page under it; Chats, the sidebar's list in a sheet
// (rooms, teams, Team map and Automations sit under it); and the inbox, which carries the needs-you badge.
const BOTS = [
  { id: 'botsHome', label: 'Bots', icon: 'agents', source: 'botsHome' },
  { id: 'botsChats', label: 'Chats', icon: 'chats', source: 'botsHome',
    open: () => import('./mobileBots.js').then(m => m.openBotsList(glass.querySelector('[data-tabbar="botsChats"]'))) },
  { id: 'botsInbox', label: 'Inbox', icon: 'inbox', source: 'botsHome', badge: 'bots',
    open: () => import('./mobileBots.js').then(m => m.openBotsInbox()) },
];
const ITEMS = { kairos: KAIROS, forge: FORGE, bots: BOTS };

let bar, glass, more, current = 'home', frame = 0, signature = '';

// Which item the page on screen belongs to; anything else lives under More.
function selection() {
  const view = document.documentElement.dataset.view;
  if (forge()) {
    if (document.querySelector('#view-content .mf-session')) return 'sessions';
    if (document.querySelector('#view-content .mf-dashboard')) return 'forgeHome';
    if (document.querySelector('#view-content .mf-project')) return pagerTab(1)?.getAttribute('aria-selected') === 'true' ? 'sessions' : 'new';
    // A Forge view still loading keeps the item it was opened from.
    return view === 'forgeHome' ? current : 'more';
  }
  if (bots()) return view === 'botsHome' || view === 'botsShell' ? 'botsHome' : ['botsRoom', 'botsTeamMap', 'botsAutomations'].includes(view) ? 'botsChats' : 'more';
  return { home: 'home', mobileLaunch: 'chats', chat: 'chats', calendar: 'calendar' }[view] || 'more';
}

function hiddenNow() {
  if (!mobileOn()) return true;
  if (document.querySelector(FULLSCREEN)) return true;
  return keyboardLift(innerHeight, window.visualViewport) > 0;
}

function build() {
  const items = ITEMS[modeKey()].filter(item => nav(item.source));
  const nodes = items.map(item => {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'ms-tabbar-item'; node.dataset.tabbar = item.id;
    node.innerHTML = `${shellIcon(item.icon)}<span class="ms-tabbar-label"></span>`;
    node.querySelector('.ms-tabbar-label').textContent = item.label;
    node.firstElementChild?.setAttribute('aria-hidden', 'true');
    if (item.badge) node.dataset.badge = item.badge;
    node.addEventListener('click', () => {
      haptic();
      if (node.getAttribute('aria-current') === 'page' && document.querySelector(SUBPAGE)) {
        if (item.open) item.open(); else nav(item.source)?.click();
        return;
      }
      if (node.getAttribute('aria-current') === 'page' && !item.open) {
        // The tab already on screen: back to its top, as iOS does.
        document.getElementById('view-content')?.scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' });
        return;
      }
      if (item.open) item.open(); else nav(item.source)?.click();
    });
    return node;
  });
  more = document.createElement('button'); more.type = 'button'; more.className = 'ms-tabbar-item'; more.dataset.tabbar = 'more';
  more.innerHTML = `${shellIcon('more')}<span class="ms-tabbar-label">More</span>`;
  more.firstElementChild.setAttribute('aria-hidden', 'true');
  more.setAttribute('aria-haspopup', 'dialog'); more.setAttribute('aria-controls', 'ms-more-sheet');
  more.addEventListener('click', () => openMoreSheet(more));
  const pill = document.createElement('span'); pill.className = 'ms-tabbar-pill'; pill.setAttribute('aria-hidden', 'true');
  glass.replaceChildren(pill, ...nodes, more);
  glass.style.setProperty('--ms-tab-count', String(nodes.length + 1));
}

function paintBadges() {
  const { need, live } = badgeCounts();
  for (const node of glass.querySelectorAll('.ms-tabbar-item')) {
    const label = node.querySelector('.ms-tabbar-label').textContent;
    let count = 0, spoken = '';
    if (node.dataset.badge === 'activity') {
      count = need || live;
      spoken = need ? `${need} need you` : live ? `${live} working` : '';
    } else if (node.dataset.badge === 'bots') {
      const text = nav('botsHome')?.querySelector('.nav-badge')?.textContent.trim() || '';
      count = text ? text : 0; spoken = text ? `${text} waiting on you` : '';
    }
    let badge = node.querySelector(':scope > .ms-tabbar-badge');
    if (count && !badge) { badge = document.createElement('span'); badge.className = 'ms-tabbar-badge'; badge.setAttribute('aria-hidden', 'true'); node.append(badge); }
    if (badge) { badge.textContent = typeof count === 'number' && count > 99 ? '99+' : String(count); badge.hidden = !count; }
    node.setAttribute('aria-label', spoken ? `${label}, ${spoken}` : label);
  }
}

function update() {
  frame = 0;
  if (!bar) return;
  const mode = modeKey();
  const items = ITEMS[mode].filter(item => nav(item.source)).map(item => item.id).join();
  if (`${mode}:${items}` !== signature) { signature = `${mode}:${items}`; bar.dataset.mode = mode; build(); }
  const hide = hiddenNow();
  const on = mobileOn();
  bar.hidden = !on;
  bar.dataset.state = hide ? 'hidden' : 'shown';
  bar.inert = hide; bar.setAttribute('aria-hidden', String(hide));
  document.documentElement.classList.toggle('ms-tabbar-up', on && !hide);
  if (!hide) {
    const next = selection(); current = next;
    const nodes = [...glass.querySelectorAll('.ms-tabbar-item')];
    const index = Math.max(0, nodes.findIndex(node => node.dataset.tabbar === next));
    nodes.forEach((node, i) => { if (i === index) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    glass.style.setProperty('--ms-tab-index', String(index));
  }
  paintBadges();
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

export function mountTabBar() {
  if (bar) return bar;
  bar = document.createElement('nav'); bar.className = 'ms-tabbar'; bar.setAttribute('aria-label', 'Tabs');
  glass = document.createElement('div'); glass.className = 'ms-tabbar-glass';
  const create = document.createElement('button'); create.type = 'button'; create.className = 'ms-tabbar-create';
  create.innerHTML = ICONS.plus; create.setAttribute('aria-label', 'Quick create'); create.setAttribute('aria-haspopup', 'dialog');
  create.addEventListener('click', () => openQuickCreate(create));
  bar.append(glass, create); document.body.append(bar);
  // The page on screen, the pager page, the agents badge and the pushed
  // pages all live in the DOM; one observer, coalesced to a frame.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'class', 'hidden'] });
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-view', 'data-app-mode', 'class'] });
  window.visualViewport?.addEventListener('resize', schedule); addEventListener('resize', schedule);
  phone.addEventListener('change', schedule); document.addEventListener('kairos:appearance', schedule);
  document.addEventListener('kairos:mobile-activity', schedule);
  update();
  return bar;
}

// The item that stands for the page on screen, for focus to return to.
export const currentTabItem = () => bar && !bar.inert ? bar.querySelector('.ms-tabbar-item[aria-current=page]') : null;

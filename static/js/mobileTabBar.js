import { mobileOn, phone, go, haptic, reduced } from './mobileShared.js';
import { ICONS } from './icons.js';
import { openMoreSheet } from './mobileTabSheet.js';
import { keyboardLift } from './mobileDock.js';
import { chatPage } from './mobileShell.js';
import { rememberedProject } from './mobileForge.js';
import { badgeCounts } from './mobileActivity.js';

// The phone tab bar (2026-10-22, David): a floating liquid-glass bar at the
// bottom of every phone page, replacing the top-left avatar and its workspace
// sheet. Kairos shows Home, Chats, Agents, Calendar and More; Forge shows
// Forge Home, New, Sessions and More. More opens the sheet with every other
// tab (mobileTabSheet.js). Inside a conversation, a Forge session or any
// pushed page the composer owns the bottom, so the bar slides away; it also
// steps aside while the keyboard is up. While it shows, the root carries
// .ms-tabbar-up, which sets --ms-tabbar-space for docks and page padding
// (redesign-mobile.css, "Tab bar").

// Pages that own the bottom of the screen.
const PUSHED = [
  '.ms-conversation:not(.ms-launch-chat)', '.ms-live-chat', '.mf-session', '.settings-mobile-page',
  '.agents-messenger .side-chat-input', '.library-editor',
].join(', ');
const nav = id => document.querySelector(`#nav .nav-item[data-tab="${id}"]`);
const forge = () => document.documentElement.dataset.appMode === 'forge';
const pagerTab = index => document.getElementById(`mf-tab-${index}`);

// Kairos items delegate to the sidebar's own nav items, so Settings > Layout
// visibility and every navigation rule stay in one place.
const KAIROS = [
  { id: 'home', label: 'Home', icon: 'home', source: 'home', badge: 'activity' },
  { id: 'chats', label: 'Chats', icon: 'chats', source: 'chat',
    open: () => {
      // Already on the chat workspace: Chats shows the list of chats.
      if (document.getElementById('ms-tab-1')?.isConnected && document.documentElement.dataset.view === 'mobileLaunch') document.getElementById('ms-tab-1').click();
      else go('chat', { mobilePage: chatPage() });
    } },
  { id: 'agents', label: 'Agents', icon: 'agents', source: 'agents', badge: 'agents' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', source: 'calendar' },
];
const FORGE = [
  { id: 'forgeHome', label: 'Forge Home', icon: 'home', source: 'forgeHome', badge: 'activity' },
  { id: 'new', label: 'New', icon: 'newChat', source: 'forgeHome',
    open: () => pagerTab(0)?.isConnected ? pagerTab(0).click() : go('forgeHome', { projectId: rememberedProject(), mobilePage: 0 }) },
  { id: 'sessions', label: 'Sessions', icon: 'chats', source: 'forgeHome',
    open: () => pagerTab(1)?.isConnected ? pagerTab(1).click() : go('forgeHome', { projectId: rememberedProject(), mobilePage: 1 }) },
];

let bar, glass, more, current = 'home', frame = 0, signature = '';

// Which item the page on screen belongs to; anything else lives under More.
function selection() {
  const view = document.documentElement.dataset.view;
  if (forge()) {
    if (document.querySelector('#view-content .mf-dashboard')) return 'forgeHome';
    if (document.querySelector('#view-content .mf-project')) return pagerTab(1)?.getAttribute('aria-selected') === 'true' ? 'sessions' : 'new';
    // A Forge view still loading keeps the item it was opened from.
    return view === 'forgeHome' ? current : 'more';
  }
  return { home: 'home', mobileLaunch: 'chats', chat: 'chats', agents: 'agents', calendar: 'calendar' }[view] || 'more';
}

function hiddenNow() {
  if (!mobileOn()) return true;
  if (document.querySelector(PUSHED)) return true;
  return keyboardLift(innerHeight, window.visualViewport) > 0;
}

function build() {
  const items = (forge() ? FORGE : KAIROS).filter(item => nav(item.source));
  const nodes = items.map(item => {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'ms-tabbar-item'; node.dataset.tabbar = item.id;
    node.innerHTML = `${ICONS[item.icon] || ''}<span class="ms-tabbar-label"></span>`;
    node.querySelector('.ms-tabbar-label').textContent = item.label;
    node.firstElementChild?.setAttribute('aria-hidden', 'true');
    if (item.badge) node.dataset.badge = item.badge;
    node.addEventListener('click', () => {
      haptic();
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
  more.innerHTML = `${ICONS.more}<span class="ms-tabbar-label">More</span>`;
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
    } else if (node.dataset.badge === 'agents') {
      const text = nav('agents')?.querySelector('.nav-badge')?.textContent.trim() || '';
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
  const mode = forge() ? 'forge' : 'kairos';
  const items = (forge() ? FORGE : KAIROS).filter(item => nav(item.source)).map(item => item.id).join();
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
  bar.append(glass); document.body.append(bar);
  // The page on screen, the pager page, the agents badge and the pushed
  // pages all live in the DOM; one observer, coalesced to a frame.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'class'] });
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-view', 'data-app-mode', 'class'] });
  window.visualViewport?.addEventListener('resize', schedule); addEventListener('resize', schedule);
  phone.addEventListener('change', schedule); document.addEventListener('kairos:appearance', schedule);
  document.addEventListener('kairos:mobile-activity', schedule);
  update();
  return bar;
}

// The item that stands for the page on screen, for focus to return to.
export const currentTabItem = () => bar && !bar.inert ? bar.querySelector('.ms-tabbar-item[aria-current=page]') : null;

// The Kairos tour (/demo, 2026-11-05): a guided walk through every tab, with a
// highlight and a short popup per feature. It opens each tab for real. People can
// leave tabs out before starting, skip a tab or any step on the way, or end it.
// Built on the Bots tour (botsTour.js, botsSpotlight.js), but in the app's own
// tokens so it reads in every mode and theme. The pure parts (the stops, the
// plan) are exported for scripts/test_app_tour.mjs.

const KNOWN_TABS = new Set(['home', 'chat', 'notes', 'library', 'calendar', 'email', 'tasks', 'tool-store', 'cookbook',
  'settings', 'forgeHome', 'forgeShell', 'botsHome', 'botsShell', 'botsAutomations']);
const ADDED_TAB_NOTES = { studio: 'Make videos, edit them beat by beat and render them.', crm: 'Keep track of people and deals.' };

const visible = node => !!node && node.isConnected && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
const byText = (selector, text) => () => [...document.querySelectorAll(selector)].find(node => node.textContent.trim() === text && visible(node));
const settingsOpen = () => document.querySelector('.modal-backdrop:not(.hidden) .settings-window');

// Each stop is one tab (or one part of the app). `steps` point at what to show;
// a step whose target is not on screen is skipped, so the tour never points at nothing.
export const STOPS = [
  { id: 'around', label: 'Getting around', tab: 'home', steps: [
    { anchor: () => document.querySelector('#sidebar .segmented-tab')?.parentElement, admin: true, title: 'Three modes',
      text: 'Kairos is for your day: chats, notes, calendar and more. Forge works on software projects. Bots are helpers that keep working for you.' },
    { anchor: '#rd-all-tabs-btn', title: 'Every tab', text: 'Your pinned tabs sit in the sidebar. Open the rest from All tabs, and pin the ones you use most.' },
    { anchor: '#rd-search', title: 'Search everything', text: 'Find chats, notes, documents and tabs from one place.' },
  ] },
  { id: 'home', label: 'Home', tab: 'home', steps: [
    { anchor: '.hm-customize', title: 'Your Home', text: 'Home shows your week, what is coming up, your model use and how Kairos is running. Customize it to show what you care about.' },
    { anchor: '.dashboard-system-chip', title: 'Systems at a glance', text: 'Each chip is one part of Kairos and whether it is working. Select one to fix or set it up.' },
  ] },
  { id: 'chat', label: 'Chats', tab: 'chat', chat: true, steps: [
    { anchor: '#chat-input', title: 'Ask anything', text: 'Type a question or give Kairos a task. Type / to see every command.' },
    { anchor: '#model-picker-btn', title: 'Choose a model', text: 'Pick which model answers. Each chat keeps its own choice.' },
    { anchor: '#overflow-plus-btn', title: 'Attach and more', text: 'Attach files and open more options for this message.' },
    { anchor: '#chat-permission-pill', title: 'What Kairos may do', text: 'Choose how freely Kairos acts in this chat. It asks first for anything you have not allowed.' },
    { anchor: '.chat-pane-icon', title: 'Side panes', text: 'Open documents and a browser next to the chat.' },
    { anchor: '#sidebar .rd-history-trigger', title: 'Your chats', text: 'Open earlier chats here. New chat starts a fresh one.' },
  ] },
  { id: 'notes', label: 'Notes', tab: 'notes', steps: [
    { anchor: 'input[aria-label="New note"]', title: 'Quick notes', text: 'Jot down a to-do. Give it a due time and it shows on your Calendar too.' },
  ] },
  { id: 'library', label: 'Library', tab: 'library', steps: [
    { anchor: 'input[placeholder^="Search documents"]', title: 'Everything you made', text: 'Your documents, files from chats and designs live here. Search them all at once.' },
    { anchor: '.rd-segmented', title: 'Vault, Files and Designs', text: 'Switch between your notes vault, files from chats, and the designs, slides and PDFs Kairos made.' },
    { anchor: '.library-import', title: 'Bring files in', text: 'Import a document to read, search or ask Kairos about.' },
  ] },
  { id: 'calendar', label: 'Calendar', tab: 'calendar', steps: [
    { anchor: '.cal-calendars-trigger', title: 'Your calendars', text: 'Connect Google Calendar or keep events here. Note due dates show up too.' },
    { anchor: byText('button', 'New event'), title: 'Add an event', text: 'Add an event yourself, or ask Kairos in a chat to put one on your calendar.' },
  ] },
  { id: 'email', label: 'Email', tab: 'email', steps: [
    { anchor: '.email-accounts-trigger', title: 'Your inbox', text: 'Connect Gmail or any mail account. Read and write mail here, and ask Kairos to draft replies for you to check.' },
  ] },
  { id: 'tasks', label: 'Tasks', tab: 'tasks', steps: [
    { anchor: '.tasks-build-button', title: 'Hand Kairos a job', text: 'Describe a task and Kairos works through it. Schedule repeats too, like a morning summary.' },
  ] },
  { id: 'store', label: 'Tool Store', tab: 'tool-store', steps: [
    { anchor: '.tool-store-search', title: 'Add abilities', text: 'Find skills, tools, tabs and automations. Add a tab like Studio to make videos.' },
  ] },
  { id: 'cookbook', label: 'Cookbook', tab: 'cookbook', steps: [
    { anchor: () => [...document.querySelectorAll('.view-header')].find(node => visible(node) && /Cookbook/.test(node.textContent)), title: 'Models on this computer', text: 'Download a model and run it here, with no account and no internet needed.' },
  ] },
  { id: 'added', label: 'Your added tabs', tab: 'home', added: true, steps: [] },
  { id: 'settings', label: 'Settings', tab: 'home', settings: true, steps: [
    { anchor: '.modal-backdrop:not(.hidden) .settings-nav', title: 'Settings', text: 'Appearance, models, connections, shortcuts and more. Type /settings in a chat to come straight here.' },
  ] },
  { id: 'forge', label: 'Forge', tab: 'forgeHome', admin: true, steps: [
    { anchor: '#forge-message', title: 'Forge', text: 'Point an agent at a software project and let it work. Choose the project, where it runs and how it works.' },
    { anchor: '.forge-icon-button', title: 'Your projects', text: 'Add a project folder so agents can work on it.' },
  ] },
  { id: 'bots', label: 'Bots', tab: 'botsHome', admin: true, steps: [
    { anchor: '.bots-rail-desk', title: 'Kip', text: 'Kip is your assistant. It keeps an eye on your day and hands work to your other bots.' },
    { anchor: byText('button', 'New bot'), title: 'Make a bot', text: 'Make a bot for ongoing work, or start from a ready-made one.' },
  ] },
];

// The tabs the person added from the Tool Store that are on screen in the sidebar.
export function addedTabs(root = document) {
  return [...root.querySelectorAll('#sidebar .nav-item[data-tab]')]
    .filter(node => !KNOWN_TABS.has(node.dataset.tab) && node.getBoundingClientRect().height > 0)
    .map(node => ({ tab: node.dataset.tab, label: node.getAttribute('aria-label') || node.textContent.trim() || node.dataset.tab }));
}

// The stops this person gets: admin-only stops and steps only for an admin, and the
// added-tabs stop only when there are added tabs. Pure, for the tests.
export function planStops(stops, { admin = false, added = [] } = {}) {
  return stops.filter(stop => !stop.admin || admin).map(stop => {
    if (!stop.added) return { ...stop, steps: stop.steps.filter(step => !step.admin || admin) };
    return { ...stop, steps: added.map(({ tab, label }) => ({ anchor: `#sidebar .nav-item[data-tab="${tab}"]`, title: label,
      text: `${ADDED_TAB_NOTES[String(tab).replace(/^tab:/, '')] || 'A tab you added from the Tool Store.'} Remove or add tabs any time in the Tool Store.` })) };
  }).filter(stop => stop.steps.length);
}

// The text version, for a phone and for anyone who prefers to read.
export function tourText({ admin = false } = {}) {
  const lines = ['A quick tour of Kairos:',
    '- Home: your week, what is coming up, and how Kairos is running.',
    '- Chats: ask anything, pick a model, attach files. Type / for every command.',
    '- Notes: quick to-dos; due times show on Calendar.',
    '- Library: your documents, chat files and designs in one place.',
    '- Calendar: your events and due dates together.',
    '- Email: connect an account to read mail and have Kairos draft replies.',
    '- Tasks: hand Kairos a job, once or on a schedule.',
    '- Tool Store: add skills, tools, tabs (like Studio for videos) and automations.',
    '- Cookbook: download a model and run it on this computer.',
    '- Settings: appearance, models, connections and shortcuts. Type /settings.'];
  if (admin) lines.push('- Forge: agents that work on your software projects.', '- Bots: Kip and your other helpers, working in the background.');
  lines.push('', 'On a computer, /demo walks you through each tab.');
  return lines.join('\n');
}

// -- the walk itself --------------------------------------------------------------------------------
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function resolve(anchor) {
  if (typeof anchor === 'function') { const node = anchor(); return visible(node) ? node : null; }
  return [...document.querySelectorAll(anchor)].find(visible) || null;
}
async function find(anchor, ms = 3000) {
  for (let spent = 0; spent <= ms; spent += 100) {
    const node = resolve(anchor);
    if (node) return node;
    await wait(100);
  }
  return null;
}
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(Boolean));
  return node;
}
function loadCss() {
  if (document.querySelector('link[data-app-tour]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: '/static/css/app-tour.css', 'data-app-tour': 'true' }));
}

let active = null, returning = null;
export function endTour() { active?.end(); }

export async function startTour({ isAdmin = false, sessionId = null } = {}) {
  active?.end({ silent: true });
  clearTimeout(returning);  // a tour that just ended must not open a chat over this one
  loadCss();
  const navigate = detail => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail }));
  const opener = document.activeElement;
  const root = el('div', { class: 'app-tour', 'data-app-tour': 'open' });
  const ring = el('div', { class: 'app-tour-ring', 'aria-hidden': 'true', hidden: true });
  const shade = el('div', { class: 'app-tour-shade', 'aria-hidden': 'true' });
  const tip = el('div', { class: 'app-tour-tip', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'app-tour-title', tabindex: '-1' });
  root.append(shade, ring, tip);
  document.body.append(root);
  let dead = false, stops = [], at = { stop: 0, step: 0 }, current = null, target = null, anchor = null, revision = 0, moved = false;

  function place() {
    if (dead) return;
    const box = tip.getBoundingClientRect();
    // A tab that redraws replaces the element; point at its replacement.
    if (anchor && !visible(target)) target = resolve(anchor) || target;
    if (!target || !visible(target)) {
      ring.hidden = true; shade.hidden = false;
      Object.assign(tip.style, { left: `${Math.max(8, (innerWidth - box.width) / 2)}px`, top: `${Math.max(8, (innerHeight - box.height) / 2)}px` });
      return;
    }
    shade.hidden = true; ring.hidden = false;
    const rect = target.getBoundingClientRect();
    Object.assign(ring.style, { left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` });
    let top = rect.bottom + 12, left = rect.left;
    if (top + box.height > innerHeight - 8) top = rect.top - box.height - 12;
    if (top < 8) { top = Math.max(8, Math.min(innerHeight - box.height - 8, rect.top)); left = rect.right + 12 + box.width < innerWidth ? rect.right + 12 : rect.left - box.width - 12; }
    tip.style.top = `${Math.max(8, Math.min(innerHeight - box.height - 8, top))}px`;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - box.width - 8, left))}px`;
  }
  const observer = new ResizeObserver(place);
  observer.observe(tip);
  function card(children, focusFirst = true) {
    tip.replaceChildren(...children);
    place();
    (focusFirst ? tip.querySelector('button.primary, button') : tip)?.focus?.({ preventScroll: true });
  }
  const button = (label, onclick, primary = false, disabled = false) =>
    el('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, text: label, onclick, disabled });

  async function leave() {
    if (current?.settings && settingsOpen()) document.querySelector('.settings-titlebar-btn[title="Close"]')?.click();
    current = null;
  }
  async function enter(stop) {
    if (current === stop) return;
    await leave();
    current = stop; moved = true;
    if (stop.settings) {
      navigate({ tab: stop.tab });
      await wait(300);
      if (!settingsOpen()) document.querySelector('.sidebar-settings-btn')?.click();
    } else if (stop.chat && sessionId) navigate({ tab: 'chat', sessionId });
    else navigate({ tab: stop.tab });
    // Let the new tab replace the old one before looking for its parts.
    await wait(450);
  }
  // Move to a step; `direction` is where to keep going when a step has nothing to point at.
  async function show(stopIndex, stepIndex, direction = 1) {
    const mine = ++revision;
    while (!dead && mine === revision) {
      if (stopIndex < 0) { stopIndex = 0; stepIndex = 0; direction = 1; }
      if (stopIndex >= stops.length) return finish();
      const stop = stops[stopIndex];
      if (stepIndex < 0) { stopIndex -= 1; if (stopIndex < 0) { stopIndex = 0; stepIndex = 0; direction = 1; continue; } stepIndex = stops[stopIndex].steps.length - 1; continue; }
      if (stepIndex >= stop.steps.length) { stopIndex += 1; stepIndex = 0; continue; }
      await enter(stop);
      if (dead || mine !== revision) return;
      const step = stop.steps[stepIndex];
      tip.setAttribute('aria-busy', 'true');
      const node = await find(step.anchor);
      tip.removeAttribute('aria-busy');
      if (dead || mine !== revision) return;
      if (!node) { stepIndex += direction; continue; }
      at = { stop: stopIndex, step: stepIndex };
      target = node; anchor = step.anchor;
      node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      const first = stopIndex === 0 && stepIndex === 0, lastOfStop = stepIndex === stop.steps.length - 1;
      const lastStop = stopIndex === stops.length - 1;
      card([
        el('p', { class: 'app-tour-where', text: `${stop.label} · ${stepIndex + 1} of ${stop.steps.length}` }),
        el('h2', { id: 'app-tour-title', text: step.title }),
        el('p', { class: 'app-tour-text', text: step.text }),
        el('div', { class: 'app-tour-actions' }, [
          button('Back', () => show(at.stop, at.step - 1, -1), false, first),
          button(lastOfStop && lastStop ? 'Finish' : 'Next', () => show(at.stop, at.step + 1, 1), true),
          lastStop ? null : button(`Skip ${stop.label}`, () => show(at.stop + 1, 0, 1)),
          button('End tour', () => end()),
        ]),
        el('p', { class: 'app-tour-progress', text: `Part ${stopIndex + 1} of ${stops.length}` }),
      ]);
      return;
    }
  }
  function intro() {
    stops = planStops(STOPS, { admin: isAdmin, added: addedTabs() });
    target = null; anchor = null;
    const boxes = stops.map(stop => {
      const box = el('input', { type: 'checkbox', 'data-stop': stop.id, checked: true });
      return el('label', { class: 'app-tour-choice' }, [box, el('span', { text: stop.label })]);
    });
    card([
      el('h2', { id: 'app-tour-title', text: 'Take a tour of Kairos' }),
      el('p', { class: 'app-tour-text', text: 'I will open each tab and show you its main features. Untick anything you already know. You can skip a tab or end the tour at any point.' }),
      el('fieldset', { class: 'app-tour-choices' }, [el('legend', { text: 'Show me' }), ...boxes]),
      el('div', { class: 'app-tour-actions' }, [
        button('Start the tour', () => {
          const chosen = new Set(boxes.map(b => b.querySelector('input')).filter(b => b.checked).map(b => b.dataset.stop));
          stops = stops.filter(stop => chosen.has(stop.id));
          if (!stops.length) { end(); return; }
          show(0, 0, 1);
        }, true),
        button('Not now', () => end()),
      ]),
    ]);
  }
  function finish() {
    revision++;
    leave();
    target = null; anchor = null;
    card([
      el('h2', { id: 'app-tour-title', text: 'That is the tour' }),
      el('p', { class: 'app-tour-text', text: 'Type /help in any chat to see every command, or /demo to take this tour again.' }),
      el('div', { class: 'app-tour-actions' }, [button('Done', () => end(), true)]),
    ]);
  }
  function end({ silent = false } = {}) {
    if (dead) return;
    dead = true; revision++;
    leave();
    observer.disconnect();
    document.removeEventListener('keydown', key, true);
    removeEventListener('resize', place); removeEventListener('scroll', place, true);
    clearInterval(follow);
    root.remove();
    if (active?.end === end) active = null;
    // Back where the tour started, but only if it took the person anywhere (not for Not now).
    if (!silent && moved) {
      // Back to the chat the tour started from. A chat with only commands in it is not
      // saved yet, so then Kairos opens with a fresh chat, wherever the tour ended.
      if (sessionId) navigate({ tab: 'chat', sessionId });
      else { navigate({ tab: 'home' }); returning = setTimeout(() => document.querySelector('#sidebar .rd-new-chat')?.click(), 400); }
    }
    if (!silent && opener?.isConnected) setTimeout(() => opener.isConnected && opener.focus({ preventScroll: true }), moved ? 600 : 0);
  }
  function key(event) {
    if (dead) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); end(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...tip.querySelectorAll('button:not([disabled]), input')];
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && (index === controls.length - 1 || index < 0)) { event.preventDefault(); controls[0].focus(); }
  }
  document.addEventListener('keydown', key, true);
  addEventListener('resize', place); addEventListener('scroll', place, true);
  // Targets move as tabs finish drawing; keep the highlight on them.
  const follow = setInterval(place, 250);
  active = { end, state: () => ({ stops: stops.map(s => s.id), at: { ...at }, title: tip.querySelector('h2')?.textContent || '' }) };
  intro();
  return active;
}

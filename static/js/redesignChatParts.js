import { el } from './api.js';
import { emptyState } from './kairosParts.js';
import { createMascot } from './mascot.js';
import * as chatStream from './chatStream.js';
import { mountConversations } from './redesignConversations.js';

export function chatAge(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || !timestamp) return '';
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - Number(timestamp)) / 60));
  return minutes < 1 ? 'Now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

// Only the stream's real processing sessions appear here. Static roster faces
// are deliberately avoided so live activity and the mascot preference agree.
export function workingChats(sessions, open) {
  const live = sessions.filter(session => chatStream.getInFlight(session.id)?.status === 'processing');
  const section = el('section', { class: 'rd-chat-working', 'aria-label': 'Working now', hidden: !live.length });
  section.append(el('h2', { text: 'Working now' }));
  const row = el('div', { class: 'rd-chat-working-row' });
  for (const session of live) {
    const title = session.title || 'Untitled conversation';
    const button = el('button', { type: 'button', title, 'aria-label': `Open working chat: ${title}`, onclick: () => open(session.id) });
    if (document.documentElement.dataset.mascot !== 'off') button.append(createMascot({ state: 'thinking', size: 42, decorative: true }));
    button.append(el('span', { text: title })); row.append(button);
  }
  section.append(row); return section;
}

// Presentation outside #chat-messages: it must stay empty on New so the
// controller's figure/sky choice and reading-position anchor remain intact.
export function mountChatParts(container) {
  const main = container.querySelector('#chat-main');
  const list = container.querySelector('#sessions-list');
  const panel = container.querySelector('#chat-sessions');
  if (!main || !list || !panel) return () => {};
  const menus = [...container.querySelectorAll('.overflow-menu, .model-picker-menu')].filter(node => !node.classList.contains('rd-menu-in'));
  menus.forEach(node => node.classList.add('rd-menu-in'));
  const idle = emptyState({ mascotState: 'sleeping', title: 'What should we work on?', text: 'Kip is resting until you need it.' });
  idle.classList.add('rd-chat-idle'); idle.hidden = true;
  // The phone launch shell already owns its idle content and bottom dock.
  const dock = container.classList.contains('ms-launch-chat') ? null : main.querySelector('.chat-composer-dock');
  const idleLayout = el('div', { class: 'rd-chat-idle-layout' });
  if (dock) {
    dock.before(idleLayout);
    idleLayout.append(idle, dock);
  }
  const disposeConversations = mountConversations(container);
  const enabled = () => document.documentElement.classList.contains('kairos-redesign');
  const sync = () => {
    idle.hidden = !enabled() || !main.classList.contains('is-empty');
    const busy = chatStream.listInFlight().some(entry => entry.status === 'processing');
    idle.querySelector('p').textContent = busy ? 'Start something new while your other work continues.' : 'Kip is resting until you need it.';
    idle.querySelector('kairos-mascot')?.setAttribute('state', busy ? 'idle' : 'sleeping');
  };
  const state = new MutationObserver(sync); state.observe(main, { attributes: true, attributeFilter: ['class'] });
  const detach = chatStream.subscribeAll(sync);
  document.addEventListener('kairos:appearance', sync);
  sync();
  return () => {
    disposeConversations(); state.disconnect(); detach();
    document.removeEventListener('kairos:appearance', sync);
    if (dock) idleLayout.before(dock);
    idleLayout.remove();
    idle.remove();
    menus.forEach(node => node.classList.remove('rd-menu-in'));
  };
}

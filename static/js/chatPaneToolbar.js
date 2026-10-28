import { api, el } from './api.js';
import { paneIsOpen, closePaneKind } from './chatPaneStack.js';
import { openDesignTab, showArtifactPane } from './chatContent.js';
import { closeChatDesign, closeForeignChatDesign } from './chatDesignPane.js';
import { ICONS } from './icons.js';
import { openBrowser, closeBrowser, isBrowserOpen } from './browserPane.js';

const ICON_GLOBE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';

export function mountChatPaneToolbar({ header, host, getSessionId, backgroundTasks, getComputer, openComputer, menu }) {
  let session = null, design = null, disposed = false, revision = 0;
  const toolbar = el('div', { class: 'chat-pane-toolbar', role: 'group', 'aria-label': 'Side panes' });
  const buttons = {};
  // The browser pane is the side browser (browserPane.js), tracked there.
  const isOpen = kind => kind === 'browser' ? isBrowserOpen() : paneIsOpen(host, kind);
  const toggle = (kind, open) => {
    if (kind === 'browser') { if (isBrowserOpen()) closeBrowser(); else open(); }
    else if (paneIsOpen(host, kind)) closePaneKind(host, kind); else open();
    paint();
  };
  for (const [kind, label, icon, open] of [
    ['design', 'Design', ICONS.design, () => { if (design) openDesignTab(getSessionId(), design.id); }],
    ['background', 'Background tasks', ICONS.tasks, () => backgroundTasks.toggle()],
    ['documents', 'Documents', ICONS.library, () => showArtifactPane(buttons.documents)],
    ['browser', 'Browser', ICON_GLOBE, () => openBrowser('')],
    ['computer', 'Computer', ICONS.computer, openComputer],
  ]) {
    const button = buttons[kind] = el('button', { type: 'button', class: 'chat-pane-icon', title: label, 'aria-label': label, 'aria-pressed': 'false',
      onclick: () => kind === 'background' ? backgroundTasks.toggle() : toggle(kind, open) });
    button.innerHTML = icon || '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
    toolbar.append(button);
  }
  const newWindow = el('button', { type: 'button', class: 'chat-pane-icon chat-new-window', title: 'Open chat in new window', 'aria-label': 'Open chat in new window',
    onclick: () => { if (getSessionId()) window.jarvis?.openChatWindow?.(getSessionId()); } });
  newWindow.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="7" width="13" height="13" rx="2"/><path d="M9 3h12v12"/></svg>';
  const menuItem = el('button', { type: 'button', class: 'overflow-menu-item chat-window-menu-item', text: 'Open chat in new window', onclick: () => { menu.classList.add('hidden'); newWindow.click(); } });
  menu.append(menuItem);
  header.insertBefore(toolbar, header.querySelector('.chat-phone-tools')); header.insertBefore(newWindow, header.querySelector('.chat-phone-tools'));
  function paint() {
    const bg = backgroundTasks.getState();
    buttons.design.hidden = !design; buttons.background.hidden = !bg.available; buttons.computer.hidden = !getComputer();
    for (const [kind, button] of Object.entries(buttons)) button.setAttribute('aria-pressed', String(isOpen(kind)));
    buttons.background.classList.toggle('has-running', bg.count > 0);
    buttons.background.setAttribute('aria-label', `Background tasks${bg.count ? `, ${bg.count} running` : ''}`);
    newWindow.hidden = menuItem.hidden = !window.jarvis?.openChatWindow || !getSessionId() || matchMedia('(max-width: 768px)').matches;
  }
  async function refresh(force = false) {
    const sid = getSessionId();
    if (sid !== session || force) {
      const changed = sid !== session; session = sid; const request = ++revision;
      if (changed) { design = null; closeForeignChatDesign(sid); }
      if (sid) {
        const designs = await api(`/api/designs?chat=${encodeURIComponent(sid)}`).catch(() => []);
        if (disposed || request !== revision || getSessionId() !== sid) return;
        design = Array.isArray(designs) ? designs[0] : null;
      }
    }
    if (!disposed) paint();
  }
  const changedDesign = () => refresh(true);
  document.addEventListener('kairos:design-changed', changedDesign);
  document.addEventListener('kairos:chat-session', changedDesign);
  for (const event of ['kairos:chat-panes', 'kairos:background-ui']) document.addEventListener(event, paint);
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 1000); refresh();
  return () => { disposed = true; revision++; clearInterval(timer); closeChatDesign(); toolbar.remove(); newWindow.remove(); menuItem.remove();
    document.removeEventListener('kairos:design-changed', changedDesign);
    document.removeEventListener('kairos:chat-session', changedDesign);
    for (const event of ['kairos:chat-panes', 'kairos:background-ui']) document.removeEventListener(event, paint);
  };
}

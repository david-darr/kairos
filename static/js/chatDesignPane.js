import { el } from './api.js';
import { mountChatPane } from './chatPaneLayout.js';
import { mountSharedDesignCanvas } from './sharedDesignCanvas.js';
import { mountDesignModelPicker } from './designModelPicker.js';
import { reviewComposer } from './artifactReview.js';

let current = null;
export function designPaneOpen(sessionId, id) { return current?.sessionId === sessionId && current?.id === id; }
export function closeForeignChatDesign(sessionId) { if (current && current.sessionId !== sessionId) closeChatDesign(); }
export function closeChatDesign() {
  if (!current) return;
  const pane = current; current = null;
  pane.canvas.dispose(); pane.picker.dispose(); pane.layout.dispose(); pane.panel.remove();
}
export async function openChatDesign(sessionId, id) {
  if (designPaneOpen(sessionId, id)) return;
  const host = document.querySelector('.chat-layout');
  if (!host) return;
  closeChatDesign();
  const name = el('strong', { text: 'Design' }), detail = el('small', { text: 'Design' });
  const body = el('div', { class: 'chat-design-canvas' });
  const model = el('div', { class: 'design-model-host' });
  const action = (label, text, onclick) => el('button', { type: 'button', class: 'chat-pane-icon', title: label, 'aria-label': label, text, onclick });
  const expand = action('Expand design', '⛶', () => pane.layout.setMaximized(!pane.layout.isMaximized()));
  const panel = el('section', { class: 'chat-design-pane', 'aria-label': 'Design' }, [
    el('header', { class: 'chat-side-pane-header' }, [el('span', { text: '▧', 'aria-hidden': 'true' }), el('span', { class: 'chat-pane-heading' }, [name, detail]),
      action('Open in Library', '↗', () => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'library', section: 'designs', designId: id } }))), expand,
      action('Close design', '×', closeChatDesign)]), model, body,
  ]);
  const pane = current = { sessionId, id, panel };
  pane.layout = mountChatPane(host, panel, closeChatDesign, { kind: 'design' });
  panel.addEventListener('pane-maximize', e => { expand.title = e.detail ? 'Restore design' : 'Expand design'; expand.setAttribute('aria-label', expand.title); });
  pane.picker = mountDesignModelPicker(model, { getSession: () => ({ id: sessionId, title: name.textContent }) });
  pane.canvas = mountSharedDesignCanvas(body, { designId: id,
    onLoaded: data => { name.textContent = data.title; detail.textContent = `Design · ${Object.keys(data.boards || {}).length} boards`; },
    onSelection: (item, previous) => { if (item) reviewComposer()?.add(item, previous); },
    onComments: items => items.forEach(item => reviewComposer()?.add(item)),
  });
  pane.picker.update();
  await pane.canvas.ready;
}

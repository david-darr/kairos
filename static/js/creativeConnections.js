// Base app adapter: provider UI is loaded only from an enabled Store add-on.
import { api, el, toast } from './api.js';
const ui = () => import('/api/addons/_creative/files/static/creativeConnections.js');

export function creativeSelectionButton(scope, owner) {
  const button = el('button', { type: 'button', class: 'btn', text: 'Creative tools', hidden: true, 'aria-haspopup': 'dialog' });
  const refresh = () => api('/api/addons').then(rows => {
    button.hidden = !rows.some(row => ['blender', 'higgsfield'].includes(row.id) && row.enabled);
  }).catch(() => { button.hidden = true; });
  // The view owner bounds the listener's lifetime without retaining old chats.
  const listener = () => { if (button.isConnected) refresh(); else document.removeEventListener('kairos:addons-changed', listener); };
  document.addEventListener('kairos:addons-changed', listener);
  refresh();
  button.onclick = async () => {
    try {
      const implementation = (await ui()).creativeSelectionButton(scope, owner, button);
      implementation.click();
    } catch (error) { toast(error.message, 'error'); }
  };
  return button;
}

export async function openCreativeConnection(...args) {
  try { return (await ui()).openCreativeConnection(...args); }
  catch (error) { toast(error.message, 'error'); }
}

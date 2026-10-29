import { api, el } from './api.js';
import { mount as mountComputer } from './botsWorkbenchComputer.js';
import { addressUrl, lifetime } from './botsWorkbenchModel.js';

export async function mount(host, ctx) {
  const life = lifetime(ctx);
  const error = el('p', { class: 'bots-workbench-error', role: 'alert' });
  const address = el('input', { class: 'bots-browser-address', type: 'text', 'aria-label': 'Address or search', placeholder: 'Address or search', disabled: true });
  const chrome = el('form', { class: 'bots-browser-chrome', 'aria-label': 'Browser controls' });
  let pending = false;
  async function input(kind, values = {}) {
    if (pending) return;
    pending = true; error.textContent = '';
    try { await api(`/api/computer/${encodeURIComponent('agent:' + ctx.agentId)}/input`, { method: 'POST', body: JSON.stringify({ kind, ...values }), signal: life.signal, toast: false }); }
    catch (e) { if (life.active) error.textContent = e.message; }
    finally { pending = false; if (life.active) computer?.refresh(); }
  }
  for (const [kind, label] of [['back', 'Back'], ['forward', 'Forward'], ['reload', 'Reload']]) chrome.append(el('button', { type: 'button', class: 'bots-btn', text: label, disabled: true, onclick: () => input(kind) }));
  chrome.append(address, el('button', { type: 'submit', class: 'bots-btn', text: 'Go', disabled: true }));
  chrome.addEventListener('submit', event => { event.preventDefault(); try { input('navigate', { url: addressUrl(address.value, ctx.searchTemplate) }); } catch (e) { error.textContent = e.message; } });
  const screen = el('div'); host.replaceChildren(chrome, error, screen);
  let computer;
  computer = await mountComputer(screen, { ...ctx, signal: life.signal, onStatus: status => {
    if (!life.active) return;
    chrome.querySelectorAll('input, button').forEach(n => { n.disabled = !status.computer.taken_over; });
    if (document.activeElement !== address) address.value = status.computer.url || '';
    address.placeholder = status.browser.enabled ? 'Take control to browse' : 'Browser is off';
    ctx.onStatus?.(status);
  } });
  life.own(computer.destroy);
  return life.handle(computer.refresh);
}

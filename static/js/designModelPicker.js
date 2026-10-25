// The model for a design (David, 2026-10-22: "when in an individual design tab
// allow the user to switch through models"). It is the model of the design's
// linked chat: the same connections, versions and reasoning levels as the
// chat composer's picker (mobileModelSheet.js renders the rows), saved through
// the same route (POST /api/sessions/<id>/model), so the design composer's
// sends and the chat itself both use it.
import { api, el, toast } from './api.js';
import { renderMobileCatalogMenu, mountMobileModelSheet, appendEndpointCatalogs } from './mobileModelSheet.js';
import { getInFlight, subscribe } from './chatStream.js';

const EDITABLE = ['claude_cli', 'codex_cli', 'antigravity_cli', 'api'];

export function mountDesignModelPicker(host, { getSession }) {
  let sessionId = null, choice = { endpointId: null, model: null, effort: null }, endpoints = [], catalog = [];
  let unsubscribe = () => {}, generation = 0;
  const label = el('span', { class: 'design-model-label', text: 'Model' });
  const button = el('button', { type: 'button', class: 'btn quiet design-model-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    title: 'Model for this design', onclick: () => toggle() }, [label]);
  const menu = el('div', { class: 'model-picker-menu design-model-menu', role: 'dialog', 'aria-label': 'Model for this design', hidden: true });
  const root = el('div', { class: 'design-model-picker' }, [button, menu]);
  host.append(root);
  const mobilePicker = mountMobileModelSheet({ trigger: button, menu });
  let otherCatalogs = [];

  const busy = () => getInFlight(sessionId)?.status === 'processing';
  function paintLabel() {
    const endpoint = endpoints.find(item => item.id === choice.endpointId);
    const effective = (choice.model ?? endpoint?.model) || '';
    const known = catalog.find(item => item.id === effective || item.alias === effective);
    const version = endpoint ? (known?.display_name || effective || 'CLI default') : '';
    label.textContent = !sessionId ? 'No chat' : endpoint ? [endpoint.name, version, choice.effort].filter(Boolean).join(' · ') : 'Choose model';
    button.title = sessionId ? `Model for this design's chat: ${label.textContent}` : 'Link a chat to choose its model';
    button.disabled = !sessionId || busy();
  }
  function paintMenu() {
    renderMobileCatalogMenu(menu, {
      endpoints, endpointId: choice.endpointId, model: choice.model, effort: choice.effort, catalog,
      onConnection: id => save({ model_endpoint_id: id }),
      onModel: model => save({ model_endpoint_id: choice.endpointId, model_override: model }),
      // A level for the model in use: an effort the model does not offer is refused on the server.
      onEffort: effort => save({ model_endpoint_id: choice.endpointId, model_override: choice.model, effort }),
    });
    appendEndpointCatalogs(menu, otherCatalogs, (id, model) => save({ model_endpoint_id: id, model_override: model, effort: null }));
    menu.dispatchEvent(new Event('kairos:model-menu-updated'));
  }
  async function load() {
    const ticket = ++generation;
    const session = getSession();
    if (session?.id !== sessionId) {
      unsubscribe(); sessionId = session?.id || null;
      unsubscribe = sessionId ? subscribe(sessionId, paintLabel) : () => {};
    }
    if (!sessionId) { endpoints = []; catalog = []; paintLabel(); close(); return; }
    const [chat, choices] = await Promise.all([api(`/api/sessions/${encodeURIComponent(sessionId)}`).catch(() => null),
      api('/api/models/choices').catch(() => [])]);
    if (ticket !== generation || !chat) return;
    choice = { endpointId: chat.model_endpoint_id || null, model: chat.model_override ?? null, effort: chat.model_effort ?? null };
    endpoints = choices;
    const endpoint = endpoints.find(item => item.id === choice.endpointId);
    catalog = endpoint && EDITABLE.includes(endpoint.kind) ? await api(`/api/models/${endpoint.id}/catalog`).catch(() => []) : [];
    otherCatalogs = !matchMedia('(max-width: 768px)').matches
      ? await Promise.all(endpoints.filter(item => item.id !== choice.endpointId).map(async item => [item.id, await api(`/api/models/${item.id}/catalog`).catch(() => [])])) : [];
    if (ticket !== generation) return;
    paintLabel();
    paintMenu();
  }
  async function save(body) {
    if (!sessionId || busy()) { toast('Wait for the reply to finish before switching models.'); return; }
    try {
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/model`, { method: 'POST', body: JSON.stringify(body) });
      choice = { endpointId: result.model_endpoint_id || null, model: result.model_override ?? null, effort: result.effort ?? null };
      const endpoint = endpoints.find(item => item.id === choice.endpointId);
      catalog = endpoint && EDITABLE.includes(endpoint.kind) ? await api(`/api/models/${endpoint.id}/catalog`).catch(() => []) : [];
      otherCatalogs = [];
      if (!matchMedia('(max-width: 768px)').matches) {
        otherCatalogs = await Promise.all(endpoints.filter(item => item.id !== choice.endpointId).map(async item => [item.id, await api(`/api/models/${item.id}/catalog`).catch(() => [])]));
      }
      paintLabel(); paintMenu();
      if (body.model_override !== undefined || body.effort !== undefined) { close(); toast('Model updated for this design', 'success'); }
    } catch { /* api shows the reason; the menu stays open. */ }
  }
  const outside = event => { if (!root.contains(event.target)) close(); };
  const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); } };
  function toggle() { if (menu.hidden) openMenu(); else close(); }
  function openMenu() {
    if (!sessionId) return;
    paintMenu(); menu.hidden = false; menu.classList.remove('hidden'); button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true); menu.addEventListener('keydown', onKey);
    const items = [...menu.querySelectorAll('.model-picker-item')].filter(item => item.getClientRects().length);
    (items.find(item => item.classList.contains('active')) || items[0])?.focus({ preventScroll: true });
  }
  function close() {
    mobilePicker.close();
    menu.hidden = true; button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); menu.removeEventListener('keydown', onKey);
  }
  load();
  return {
    root, update: load, state: () => ({ sessionId, ...choice, label: label.textContent }),
    dispose() { generation++; unsubscribe(); close(); mobilePicker.dispose(); root.remove(); },
  };
}

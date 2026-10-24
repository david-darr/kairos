import { api, el } from './api.js';
import { mobileOn, button } from './mobileShared.js';
import { openMobileSheet } from './mobileSheet.js';
import { toSnap, staleOf, pctText, resetCopy, SIGN_IN } from './quotaReadings.js';

export const quotaTone = percent => percent >= 90 ? 'danger' : percent >= 80 ? 'warning' : 'normal';
// Never let the shared overlay's numeric conversion turn an unknown into 0%.
export const knownQuota = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

// For embedded Forge sessions, render presentation from the controller's
// already-fetched choices. All saves are callbacks into that controller.
export function renderMobileCatalogMenu(menu, { endpoints, endpointId, model, effort, catalog, onConnection, onModel, onEffort }) {
  // The same structure the composer menu builds (views/chat.js), so one set of rules styles both.
  const fragment = document.createDocumentFragment();
  const connections = el('div', { class: 'model-connection-list' });
  for (const endpoint of endpoints) {
    const row = button(endpoint.name, () => onConnection(endpoint.id), `model-picker-item model-connection-item${endpoint.id === endpointId ? ' active' : ''}`);
    row.dataset.provider = endpoint.provider || ({ claude_cli: 'Claude', codex_cli: 'Codex', api: 'API connections' }[endpoint.kind] || endpoint.kind);
    connections.append(row);
  }
  fragment.append(connections);
  const endpoint = endpoints.find(item => item.id === endpointId);
  const effective = (model ?? endpoint?.model) || '';
  const selected = catalog.find(item => item.id === effective || item.alias === effective);
  const section = el('div', { class: 'model-version-section' });
  const list = el('div', { class: 'model-catalog-list' });
  for (const entry of catalog) {
    const row = el('button', { type: 'button', class: `model-picker-item model-catalog-item${entry === selected ? ' active' : ''}`, onclick: () => onModel(entry.id) },
      [el('span', { class: 'model-catalog-name', text: entry.display_name || entry.id }), el('span', { class: 'model-catalog-desc', text: entry.description || entry.id })]);
    row.dataset.modelSearch = `${entry.id} ${entry.display_name || ''} ${entry.description || ''}`;
    row.dataset.modelDefault = String(!!endpoint?.model && (entry.id === endpoint.model || entry.alias === endpoint.model));
    list.append(row);
  }
  section.append(list);
  fragment.append(section);
  if (endpoint) section.append(button('Use endpoint setting', () => onModel(null), 'model-picker-item model-use-endpoint'));
  else if (!endpoints.length) fragment.append(el('p', { text: 'Add a model in Settings.' }));
  if (selected?.supported_efforts?.length) {
    const row = el('div', { class: 'model-effort-row', role: 'group', 'aria-label': 'Reasoning' }, [el('span', { class: 'model-effort-label', text: 'Reasoning' })]);
    for (const level of [{ effort: null }, ...selected.supported_efforts]) row.append(button(level.effort || 'Default', () => onEffort(level.effort), `model-effort-btn${(effort ?? null) === level.effort ? ' active' : ''}`));
    section.append(row);
  }
  menu.replaceChildren(fragment); menu.dispatchEvent(new Event('kairos:model-menu-updated'));
}

// Folded by default so the model list stays in reach: the summary reads both providers' headline usage, the
// full meters sit in the body (Monocode's account card works the same way).
async function loadAccount(card) {
  card.replaceChildren(el('summary', { text: 'Account: loading usage...' }));
  let data;
  try { data = await api('/api/models/quotas'); } catch { data = { providers: [] }; }
  if (!card.isConnected) return;
  const summary = el('summary'), body = el('div', { class: 'ms-account-body' }), brief = [];
  summary.append(el('strong', { text: 'Account' }));
  card.replaceChildren(summary, body);
  for (const id of ['claude', 'codex']) {
    const raw = data.providers?.find(provider => provider.provider === id);
    const name = id === 'claude' ? 'Claude' : 'Codex';
    const section = el('section', { class: 'ms-account-provider' }, [el('strong', { text: name })]);
    body.append(section);
    if (!raw) { section.append(el('p', { text: 'Usage unknown' })); brief.push(`${name} unknown`); continue; }
    const snap = toSnap(raw), stale = staleOf(snap);
    if (snap.status === 'needsAuth') { section.append(el('p', { text: SIGN_IN[id] })); brief.push(`${name} sign in`); continue; }
    if (stale) section.append(el('small', { text: 'Stale reading', role: 'status' }));
    if (!snap.windows.length) section.append(el('p', { text: raw.note || 'Usage unknown' }));
    let worst = null;
    snap.windows.forEach((window, index) => {
      const valid = knownQuota(raw.windows[index]?.used_percent);
      if (valid) worst = Math.max(worst ?? 0, window.used * 100);
      const label = `${window.label}: ${valid ? pctText(window.used) + '% used' : 'Unknown'}`;
      const row = el('div', { class: 'ms-quota', 'data-tone': valid ? quotaTone(window.used * 100) : 'unknown' }, [el('span', { text: label })]);
      if (valid) {
        const meter = el('progress', { max: '100', value: String(Math.min(100, window.used * 100)), 'aria-label': `${name} ${label}` });
        row.append(meter);
      }
      row.append(el('small', { text: resetCopy(window.resets_at) })); section.append(row);
    });
    brief.push(worst === null ? `${name} unknown` : `${name} ${Math.round(worst)}%`);
    if (worst !== null) section.dataset.tone = quotaTone(worst);
    if (raw.note) section.append(el('small', { text: raw.note }));
  }
  summary.append(el('span', { class: 'ms-account-brief', text: brief.join(' · ') }));
  if (body.querySelector('[data-tone=danger]')) card.dataset.tone = 'danger'; else if (body.querySelector('[data-tone=warning]')) card.dataset.tone = 'warning';
}

// The live desktop picker remains the source of truth. Its buttons still run
// refreshModelPicker/save and server validation; options click real effort
// buttons, and the permission select itself moves into the pushed page.
export function mountMobileModelSheet({ trigger, menu, permission }) {
  const menuRole = menu.getAttribute('role'), originalControls = trigger.getAttribute('aria-controls');
  trigger.setAttribute('aria-haspopup', 'dialog');
  let sheet = null, home = null, optionsPage = null, permissionHome = null, permissionNode = null;
  let search, account, root, optionsButton, empty;
  const restoreOptions = () => {
    if (permissionHome?.isConnected) permissionHome.after(permissionNode);
    permissionHome?.remove(); permissionHome = null;
    optionsPage?.remove(); optionsPage = null;
    if (root) root.hidden = false;
  };
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    const items = [...menu.querySelectorAll('.model-connection-item, .model-catalog-item')];
    for (const item of items) item.hidden = !`${item.dataset.provider || ''} ${item.dataset.modelSearch || item.textContent}`.toLowerCase().includes(query);
    empty.hidden = !query || items.some(item => !item.hidden);
    if (account) account.hidden = !!query;
    for (const heading of menu.querySelectorAll('.ms-provider-heading')) {
      let node = heading.nextElementSibling, visible = false;
      while (node?.matches('.model-connection-item')) { visible ||= !node.hidden; node = node.nextElementSibling; }
      heading.hidden = !visible;
    }
  };
  const options = () => {
    restoreOptions(); root.hidden = true;
    optionsPage = el('section', { class: 'ms-model-options rd-push-in' });
    const back = button('Back to models', () => { restoreOptions(); optionsButton.focus(); });
    optionsPage.append(back, el('h3', { text: 'Options' }));
    const levels = [...menu.querySelectorAll('.model-effort-btn')];
    if (levels.length) {
      const active = Math.max(0, levels.findIndex(level => level.classList.contains('active')));
      const label = el('label', { text: `Effort: ${levels[active].textContent}` });
      const slider = el('input', { type: 'range', min: '0', max: String(levels.length - 1), step: '1', value: String(active), 'aria-label': 'Reasoning effort', 'aria-valuetext': levels[active].textContent });
      const show = () => { label.firstChild.textContent = `Effort: ${levels[Number(slider.value)].textContent}`; slider.setAttribute('aria-valuetext', levels[Number(slider.value)].textContent); };
      slider.addEventListener('input', show); slider.addEventListener('change', () => levels[Number(slider.value)].click());
      label.append(slider); optionsPage.append(label, el('small', { text: levels.map(level => level.textContent).join(' · ') }));
    } else optionsPage.append(el('p', { text: 'This model does not publish effort options.' }));
    permissionNode = typeof permission === 'function' ? permission() : permission;
    if (permissionNode) {
      permissionHome = document.createComment('Permission control home'); permissionNode.before(permissionHome);
      optionsPage.append(el('h3', { text: 'Access mode' }), permissionNode);
    }
    sheet.body.append(optionsPage); back.focus();
  };
  const decorate = () => {
    if (!sheet) { decorateDesktop(); return; }
    menu.querySelectorAll('.ms-provider-heading, .ms-default-badge').forEach(node => node.remove());
    let provider = null;
    for (const item of menu.querySelectorAll('.model-connection-item')) {
      const name = item.dataset.provider || 'Models';
      provider = name;
      item.setAttribute('aria-pressed', String(item.classList.contains('active')));
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(item.classList.contains('active')));
    }
    for (const item of menu.querySelectorAll('.model-catalog-item')) {
      item.setAttribute('role', 'radio'); item.setAttribute('aria-checked', String(item.classList.contains('active')));
    }
    menu.querySelector('.model-connection-list')?.setAttribute('role', 'tablist');
    menu.querySelector('.model-catalog-list')?.setAttribute('role', 'radiogroup');
    nameEffort();
    filter();
  };
  // The board calls the effort row "Effort"; the controller's own label and buttons stay as they are.
  const nameEffort = () => { const label = menu.querySelector('.model-effort-label'); if (label) label.textContent = 'Effort'; };
  // Enhance the existing composer menu without changing its controller or data.
  // Catalogs remain loaded by the selected connection, never guessed here. The board lists
  // models under their provider, so each provider gets a label, and the active connection's
  // models sit right under its row. Only CSS order moves things, so DOM and focus order stay put.
  const decorateDesktop = () => {
    if (!document.documentElement.classList.contains('kairos-redesign') || menu.classList.contains('ms-model-menu')) return;
    menu.classList.add('rd-model-picker');
    nameEffort();
    menu.querySelectorAll('.rd-model-group').forEach(node => node.remove());
    const icon = () => { const mark = el('span', { class: 'rd-model-search-icon', 'aria-hidden': 'true' }); mark.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>'; return mark; };
    let row = menu.querySelector('.model-version-search');
    if (row) { if (!row.querySelector('.rd-model-search-icon')) row.prepend(icon()); row.classList.add('rd-model-search-row'); }
    else {
      row = menu.querySelector('.rd-model-search-row');
      if (!row) {
        const input = el('input', { type: 'search', class: 'rd-model-search', placeholder: 'Search models', 'aria-label': 'Search models' });
        input.addEventListener('input', () => {
          const query = input.value.trim().toLowerCase();
          for (const item of menu.querySelectorAll('.model-connection-item, .model-catalog-item')) item.hidden = !`${item.dataset.provider || ''} ${item.dataset.modelSearch || item.textContent}`.toLowerCase().includes(query);
          for (const group of menu.querySelectorAll('.rd-model-group')) group.hidden = !group.dataset.rows.split(',').some(id => !menu.querySelector(`[data-endpoint-id="${CSS.escape(id)}"]`)?.hidden);
        });
        row = el('label', { class: 'rd-model-search-row' }, [icon(), input]); menu.prepend(row);
      }
    }
    row.style.order = '-1';
    let step = 0, provider = null, group = null;
    const catalog = menu.querySelector('.model-catalog-list');
    for (const item of menu.querySelectorAll('.model-connection-item')) {
      const name = item.dataset.provider || 'Models';
      if (name !== provider) {
        step += 10; provider = name;
        group = el('div', { class: 'rd-model-group', text: name }); group.dataset.rows = '';
        group.style.order = String(step); item.before(group);
      }
      group.dataset.rows += (group.dataset.rows ? ',' : '') + (item.dataset.endpointId || '');
      item.style.order = String(step + 1);
      if (item.classList.contains('active') && catalog) catalog.style.order = String(step + 2);
    }
    // The effort buttons share one track, with the label beside it.
    for (const levels of menu.querySelectorAll('.model-effort-row')) {
      if (levels.querySelector('.rd-effort-seg')) continue;
      const seg = el('div', { class: 'rd-effort-seg' }); seg.append(...levels.querySelectorAll('.model-effort-btn')); levels.append(seg);
    }
    for (const node of menu.querySelectorAll('.model-effort-row, .model-custom-details, .model-use-endpoint')) node.style.order = '900';
    for (const node of menu.querySelectorAll('.model-add-item')) node.style.order = '1000';
  };
  const open = () => {
    if (!mobileOn() || trigger.disabled) return false;
    if (sheet) return true;
    root = el('div', { class: 'ms-model-root' });
    search = el('input', { type: 'search', placeholder: 'Search models', 'aria-label': 'Search models' });
    optionsButton = button('Options', options); account = el('details', { class: 'ms-account-card' });
    empty = el('p', { text: 'No models match that search.', hidden: true, role: 'status' });
    home = document.createComment('Model menu home'); menu.before(home);
    menu.querySelectorAll('.rd-model-search-row:not(.model-version-search), .rd-model-group').forEach(node => node.remove());
    menu.classList.remove('rd-model-picker'); menu.querySelectorAll('[style*="order"]').forEach(node => node.style.removeProperty('order'));
    const extras = el('details', { class: 'ms-model-extras' }, [el('summary', { text: 'Search and account' }), search, optionsButton, account]);
    root.append(menu, empty, extras); menu.classList.remove('hidden'); menu.classList.add('ms-model-menu');
    menu.removeAttribute('role');
    trigger.setAttribute('aria-expanded', 'true');
    arming = true; setTimeout(() => { arming = false; }, 0);
    sheet = openMobileSheet({ title: 'Model', content: root, opener: trigger, onClose: () => {
      restoreOptions();
      menu.querySelectorAll('[hidden]').forEach(node => { if (node.matches('.model-connection-item, .model-catalog-item')) node.hidden = false; });
      menu.querySelectorAll('.ms-provider-heading, .ms-default-badge').forEach(node => node.remove());
      for (const row of menu.querySelectorAll('.model-connection-item, .model-catalog-item')) {
        row.removeAttribute('role'); row.removeAttribute('aria-selected'); row.removeAttribute('aria-checked');
      }
      if (home?.isConnected) home.after(menu); home?.remove(); home = null;
      menu.classList.add('hidden'); menu.classList.remove('ms-model-menu'); trigger.setAttribute('aria-expanded', 'false'); sheet = null;
      if (menuRole) menu.setAttribute('role', menuRole);
      if (originalControls) trigger.setAttribute('aria-controls', originalControls); else trigger.removeAttribute('aria-controls');
    } });
    sheet.dialog.classList.add('ms-model-sheet');
    trigger.setAttribute('aria-controls', sheet.dialog.id);
    search.addEventListener('input', filter); decorate(); loadAccount(account); return true;
  };
  const click = event => { if (mobileOn() && !trigger.disabled) { event.preventDefault(); event.stopImmediatePropagation(); open(); } };
  const key = event => { if (mobileOn() && event.key === 'ArrowDown') { event.preventDefault(); event.stopImmediatePropagation(); open(); } };
  trigger.addEventListener('click', click, true); trigger.addEventListener('keydown', key, true);
  // Opening from the tools menu lets the same click reach the page's close-menus handler, which hides the menu
  // the sheet just adopted. For that one turn the sheet restores the menu instead of closing.
  let arming = false;
  const observer = new MutationObserver(() => {
    if (!sheet || !menu.classList.contains('hidden')) return;
    if (arming) menu.classList.remove('hidden'); else sheet.close();
  });
  observer.observe(menu, { attributes: true, attributeFilter: ['class'] });
  menu.addEventListener('kairos:model-menu-updated', decorate);
  return { open, dispose() { sheet?.close(); observer.disconnect(); menu.removeEventListener('kairos:model-menu-updated', decorate); trigger.removeEventListener('click', click, true); trigger.removeEventListener('keydown', key, true); } };
}

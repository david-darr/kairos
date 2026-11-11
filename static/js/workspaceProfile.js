import { api, el, openPanelDialog } from './api.js';
import { workspaceStats } from './workspaceParts.js';
import { ICONS } from './icons.js';

// Profile presents existing account actions and settings; authentication stays
// with the sidebar's original controls, including their authorization gates.
export async function openWorkspaceProfile(opener) {
  const body = el('div', { class: 'workspace-profile rd-stagger' });
  const dialog = openPanelDialog({ title: 'Profile', body, opener, group: 'workspace-profile', className: 'workspace-profile-panel rd-push-in' });
  dialog.panel.dataset.view = 'profile';
  dialog.panel.addEventListener('animationend', () => dialog.panel.classList.remove('rd-push-in'), { once: true });
  dialog.panel.parentElement.classList.add('rd-scrim-in');
  const navigate = (tab, options = {}) => {
    dialog.close();
    document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
  };
  const notifications = el('button', { type: 'button', class: 'btn workspace-phone-only workspace-round', 'aria-label': 'Notifications', onclick: () => navigate('settings', { section: 'notifications' }) });
  notifications.innerHTML = ICONS.bell;
  dialog.panel.querySelector('.modal-header').insertBefore(notifications, dialog.panel.querySelector('.modal-close-btn'));
  const identity = await api('/api/auth/status', { signal: dialog.signal }).catch(() => null);
  if (dialog.signal.aborted) return;
  if (!identity) { body.append(el('p', { role: 'status', text: 'Your account could not load. Close and open Profile to try again.' })); return; }
  const name = identity.username === 'local' ? 'Local User' : identity.username || 'Local User';
  const stats = el('div');
  body.append(el('section', { class: 'workspace-profile-card' }, [el('div', { class: 'workspace-profile-identity' }, [
    el('span', { class: 'workspace-profile-avatar', 'aria-hidden': 'true', text: name.slice(0, 1).toUpperCase() }),
    el('div', {}, [el('strong', { text: name }), el('p', { class: 'meta', text: identity.auth_enabled ? (identity.is_admin ? 'Admin' : 'Member') : 'This computer' })]),
    el('button', { type: 'button', class: 'btn', text: 'Edit', onclick: () => navigate('settings', { section: 'account' }) }),
  ]), stats]));
  // Accounts on this device, right under whose profile this is (the account switcher): each with Sign out, then Add another account and Sign out of all.
  const switcher = await import('./accountSwitcher.js');
  await switcher.loadDeviceAccounts();
  if (dialog.signal.aborted) return;
  const accountsHere = switcher.profileSection();
  if (accountsHere) body.append(accountsHere);
  const settings = el('section', { class: 'workspace-profile-settings' });
  for (const [label, icon, tab, section] of [
    ['Models', 'models', 'settings', 'added-models'], ['Appearance', 'settings', 'settings', 'appearance'],
    ['Notifications', 'bell', 'settings', 'notifications'],
    ...(identity.is_admin ? [['Permissions', 'shield', 'settings', 'permissions']] : []),
    ['Calendar sync', 'calendar', 'calendar', null],
  ]) {
    const glyph = el('span', { class: 'workspace-profile-icon', 'aria-hidden': 'true' }); glyph.innerHTML = ICONS[icon] || ICONS.settings;
    settings.append(el('button', { type: 'button', class: 'workspace-profile-setting', onclick: () => navigate(tab, section ? { section } : {}) },
      [glyph, el('span', { text: label }), el('span', { 'aria-hidden': 'true', text: '›' })]));
  }
  body.append(el('h3', { text: 'Settings' }), settings);
  const actions = el('div', { class: 'workspace-profile-actions' });
  for (const source of document.querySelectorAll('#sidebar-footer .overflow-menu-item')) {
    actions.append(el('button', { type: 'button', class: 'btn quiet', text: source.textContent, disabled: source.disabled,
      title: source.title, onclick: () => { dialog.close(); source.click(); } }));
  }
  if (!accountsHere) body.append(actions);
  const counts = await Promise.allSettled(['/api/sessions', '/api/agents', '/api/notes'].map(path => api(path, { signal: dialog.signal })));
  if (dialog.signal.aborted) return;
  stats.replaceChildren(workspaceStats(counts.flatMap((result, i) => result.status === 'fulfilled' && Array.isArray(result.value)
    ? [{ label: ['Chats', 'Agents', 'Notes'][i], value: i === 0 ? result.value.filter(s => !s.forge).length : result.value.length }] : [])));
}

// The account switcher (David's ask 2026-11-11, like Google's): every account signed in on this device, as
// coloured avatars, in the desktop title bar, the browser sidebar and the phone drawer. One click (or
// Ctrl+Shift+1..9) opens another account with no password; an account with a PIN asks it first. Adding an account
// signs it in once with its password (and two-step code). The server decides what this device may reach
// (routes/auth_routes.py): only accounts signed in on it, from an httponly cookie no page script can read.
//
// Switching reloads the page clean: nothing of the previous account stays on screen, in memory, in the live feed or
// its websocket, in open calls (they end, after asking), in shown notifications, or in this page's storage. Other
// windows of this app (a chat popped out, another browser tab) close or reload too, and the desktop app's Browse and
// side pane reopen on the new account's own browser profile (electron/browser-profiles.js closes them on reload).
import { api, el, toast, confirmDialog } from './api.js';
import { callInProgress, endOngoingCall } from './agentCall.js';

const HEADERS = { 'Content-Type': 'application/json', 'X-Kairos-Switch': '1' };
const CHANNEL = 'kairos-account';
const COLOR = /^[a-z]{2,16}$/;
let device = { enabled: false, accounts: [], max: 9, colors: [] };
let shortcutInstalled = false;
let leaving = false;  // this page is the one switching: its own follower ignores the news

export function deviceAccounts() { return device; }

// The open account's colour as a theme variable (css/account-switcher.css): a token name, never a raw colour.
export function paintAccountColor(color) {
  const root = document.documentElement;
  if (typeof color === 'string' && COLOR.test(color)) {
    root.style.setProperty('--account-color', `var(--acct-${color})`);
    root.dataset.accountColor = color;
  } else {
    root.style.removeProperty('--account-color');
    delete root.dataset.accountColor;
  }
}

export async function loadDeviceAccounts() {
  try { device = await api('/api/auth/device-accounts', { cache: 'no-store' }); }
  catch { device = { enabled: false, accounts: [], max: 9, colors: [] }; }
  return device;
}

async function send(path, body, method = 'POST') {
  const response = await fetch(path, { method, headers: HEADERS, credentials: 'same-origin', body: JSON.stringify(body || {}) });
  let data = {};
  try { data = await response.json(); } catch { /* an empty answer */ }
  return { ok: response.ok, status: response.status, data };
}

// Everything this page holds of the account that was open goes before the next one loads.
export async function leaveAccount() {
  leaving = true;
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'kairos:clear-notifications' }); } catch { /* no worker */ }
  try { sessionStorage.clear(); } catch { /* storage blocked */ }
  try { localStorage.removeItem('kairos.questionDrafts.v1'); } catch { /* storage blocked */ }
  try { indexedDB.deleteDatabase('kairos-faces'); } catch { /* no IndexedDB */ }
  try { const channel = new BroadcastChannel(CHANNEL); channel.postMessage({ type: 'switched' }); channel.close(); } catch { /* old browser */ }
  // The app's start page, not this address: a chat or bot link of the old account must not reopen under the new one.
  location.replace('/');
}

// Another window of this app switched accounts: this one's page belongs to the old account, so it goes too.
export function followOtherWindows() {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = event => {
    if (event.data?.type !== 'switched' || leaving) return;
    leaving = true;
    if (document.documentElement.classList.contains('single-chat-window')) window.close();
    setTimeout(() => location.replace('/'), 50);
  };
}

async function askToEndCall(name) {
  if (!callInProgress()) return true;
  const ok = await confirmDialog({ title: 'End the call?', message: `Switching to ${name} ends the call you are on.`, confirmLabel: 'End call and switch', danger: true });
  if (ok) endOngoingCall();
  return ok;
}

// A small sheet that asks an account's PIN; resolves to the PIN, or null when cancelled.
function askPin(name, message = '') {
  return new Promise(resolve => {
    const input = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', pattern: '[0-9]*',
      class: 'acct-pin-input', 'aria-label': `PIN for ${name}`, placeholder: 'PIN' });
    const error = el('div', { class: 'acct-pin-error', role: 'alert', text: message });
    const dialog = el('dialog', { class: 'acct-pin-dialog', 'aria-label': `Enter the PIN for ${name}` });
    const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
    const submit = () => { if (/^[0-9]{4,8}$/.test(input.value)) finish(input.value); else error.textContent = 'Enter 4 to 8 digits.'; };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.append(
      el('h2', { text: `Switch to ${name}` }),
      el('p', { class: 'meta', text: 'This account asks its PIN on this device.' }),
      input, error,
      el('div', { class: 'acct-pin-actions' }, [
        el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => finish(null) }),
        el('button', { type: 'button', class: 'btn primary', text: 'Switch', onclick: submit }),
      ]));
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

// Opens another account signed in on this device. Answers true when the page is on its way to it.
export async function switchAccount(username, { fromSignIn = false } = {}) {
  const target = device.accounts.find(account => account.username === username);
  if (!target) return false;
  if (target.active && !fromSignIn) return false;
  if (!fromSignIn && !await askToEndCall(username)) return false;
  let pin, note = '';
  for (;;) {
    if (target.pin && pin === undefined) {
      pin = await askPin(username, note);
      if (pin === null) return false;
    }
    const answer = await send('/api/auth/switch', { username, pin: pin || null });
    if (answer.ok) { await leaveAccount(); return true; }
    const code = answer.data.code;
    if (code === 'pin_required' || code === 'pin_wrong') {
      target.pin = true; pin = undefined;
      note = code === 'pin_wrong' ? `That PIN is not right. ${answer.data.tries_left} ${answer.data.tries_left === 1 ? 'try' : 'tries'} left before a short wait.` : '';
      continue;
    }
    if (code === 'password_required') { await addAccount({ username, reason: answer.data.detail }); return false; }
    toast(answer.data.detail || 'That account could not be opened.', 'error');
    return false;
  }
}

export async function signOutAccount(username) {
  const answer = await send('/api/auth/sign-out-account', { username });
  if (!answer.ok) { toast(answer.data.detail || 'That account could not be signed out.', 'error'); return; }
  if (answer.data.was_open) await leaveAccount();
  else { await loadDeviceAccounts(); refreshSwitcher(); toast(`${username} is signed out of this device.`, 'success'); }
}

export async function signOutAll() {
  const answer = await send('/api/auth/logout-all');
  if (!answer.ok) { toast(answer.data.detail || 'Could not sign out.', 'error'); return; }
  await leaveAccount();
}

// Signs one more account in on this device (its password, and its two-step code when it has one).
export async function addAccount({ username = '', reason = '' } = {}) {
  if (device.accounts.length >= device.max && !username) {
    toast(`This device already has ${device.max} accounts signed in. Sign out of one first.`, 'error');
    return;
  }
  if (!await askToEndCall(username || 'another account')) return;
  const overlay = document.getElementById('onboarding-overlay');
  const auth = await import('./auth.js');
  overlay.classList.remove('hidden');
  auth.renderAddAccount(overlay, { username, reason,
    onCancel: () => { overlay.classList.add('hidden'); overlay.replaceChildren(); },
    onDone: () => leaveAccount() });
}

function initialOf(name) { return (name || '?').slice(0, 1).toUpperCase(); }

function chip(account, index, { large = false } = {}) {
  const label = account.active ? `${account.username}, open now`
    : account.expired ? `${account.username}: sign in again` : `Switch to ${account.username}`;
  const keys = index < 9 && !matchMedia('(max-width: 768px)').matches ? ` (Ctrl+Shift+${index + 1})` : '';
  const button = el('button', { type: 'button', class: `acct-chip${large ? ' acct-chip-large' : ''}`, title: label + keys,
    'aria-label': label, 'aria-pressed': String(!!account.active), 'data-account': account.username },
  [el('span', { class: 'acct-chip-initial', 'aria-hidden': 'true', text: initialOf(account.username) })]);
  if (COLOR.test(account.color || '')) button.style.setProperty('--chip-color', `var(--acct-${account.color})`);
  if (account.expired) button.classList.add('is-expired');
  if (account.pin) button.append(el('span', { class: 'acct-chip-lock', 'aria-hidden': 'true' }));
  button.addEventListener('click', event => { event.stopPropagation(); if (!account.active) switchAccount(account.username); });
  return button;
}

function addButton() {
  const full = device.accounts.length >= device.max;
  return el('button', { type: 'button', class: 'acct-chip acct-add', text: '+', disabled: full,
    title: full ? `${device.max} accounts is the most on one device` : 'Add another account', 'aria-label': 'Add another account',
    onclick: event => { event.stopPropagation(); addAccount(); } });
}

function strip(kind) {
  const host = el('div', { class: `acct-switcher acct-switcher-${kind}`, role: 'group', 'aria-label': 'Accounts on this device' });
  device.accounts.forEach((account, index) => host.append(chip(account, index)));
  host.append(addButton());
  return host;
}

// (Re)draws the switcher wherever this page has a place for it. With accounts off there is none.
export function refreshSwitcher() {
  document.querySelectorAll('.acct-switcher').forEach(node => node.remove());
  if (!device.enabled || !device.accounts.length) return;
  const titlebar = document.documentElement.classList.contains('electron-shell') && document.getElementById('titlebar');
  if (titlebar) titlebar.append(strip('titlebar'));
  else document.getElementById('sidebar-footer')?.prepend(strip('sidebar'));
  const drawerFoot = document.querySelector('.ms-drawer-foot');
  if (drawerFoot) drawerFoot.prepend(strip('drawer'));
}

// The Profile panel's account section: every account here, and the sign-out choices.
export function profileSection() {
  if (!device.enabled || !device.accounts.length) return null;
  const rows = device.accounts.map((account, index) => {
    const name = el('span', { class: 'acct-row-name', text: account.username });
    const status = el('span', { class: 'meta', text: account.active ? 'Open now' : account.expired ? 'Sign in again' : account.pin ? 'PIN on this device' : 'One click' });
    const out = el('button', { type: 'button', class: 'btn quiet', text: 'Sign out', 'aria-label': `Sign ${account.username} out of this device`,
      onclick: () => signOutAccount(account.username) });
    return el('div', { class: 'acct-row' }, [chip(account, index, { large: true }), el('div', { class: 'acct-row-text' }, [name, status]), out]);
  });
  return el('section', { class: 'acct-profile-section', 'aria-label': 'Accounts on this device' }, [
    el('h3', { text: 'Accounts on this device' }), ...rows,
    el('div', { class: 'acct-profile-actions' }, [
      el('button', { type: 'button', class: 'btn', text: 'Add another account', disabled: device.accounts.length >= device.max, onclick: () => addAccount() }),
      el('button', { type: 'button', class: 'btn quiet danger', text: 'Sign out of all accounts', onclick: () => signOutAll() }),
    ]),
  ]);
}

// Ctrl+Shift+1..9 (Cmd+Shift on a Mac) on a desktop: the nth account in the switcher.
export function installShortcut() {
  if (shortcutInstalled) return;
  shortcutInstalled = true;
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
    const match = /^Digit([1-9])$/.exec(event.code || '');
    if (!match || !device.enabled || matchMedia('(max-width: 768px)').matches) return;
    const account = device.accounts[Number(match[1]) - 1];
    if (!account) return;
    event.preventDefault();
    if (!account.active) switchAccount(account.username);
  }, true);
}

// The app's start: paint the open account's colour and draw the switcher.
export async function mountAccountSwitcher(identity) {
  paintAccountColor(identity?.auth_enabled ? identity.color : null);
  await loadDeviceAccounts();
  refreshSwitcher();
  installShortcut();
}

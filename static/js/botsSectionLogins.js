// Signed-in sites: saved logins and 1Password (Phase 2, unit U5). Phase 1 mounts it from Computer and Settings.
// mount(host, ctx) -> {destroy, refresh, flush}.
//
// A saved login is a site, a username and a password (and optionally a one-time-code seed) that a bot's computer can
// fill into that site's sign-in form. The password and seed are write-only: they are encrypted at once, never come
// back, and are never in a backup. Rows show the site, username, who may use the login and when it was last used.
// A blank password on an edit keeps the saved one. Delete needs a second press. 1Password is optional: connect a
// service-account token, then give each vault to the bots that may use it; passwords are read only at fill time.
import { api, el, confirmDialog } from './api.js';
import { Card, Segmented, SwitchRow, Button, PageHeader, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { CONNECTIONS_CSS, chip, field, secretInput, statusBox, textInput } from './botsSectionConnections.js';
import { accessLabel, emptyLogin, loginBody, loginMeta, loginToForm, messageOf, validateLogin } from './botsConnectionsModel.js';

export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots.css');
  loadBotsCss(CONNECTIONS_CSS);
  const root = el('div', { class: 'bots-conn', 'data-section': 'logins' });
  host.append(root);

  let destroyed = false, loading = true, loadError = '', generation = 0, busy = '', notice = '', formError = '';
  let logins = [], onepassword = { available: false, connected: false, vaults: [], reason: '' }, names = {}, bots = [];
  let editor = null;          // { form, removeTotp, error }
  let opToken = '';

  async function load(quiet = false) {
    const mine = ++generation;
    loading = !logins.length && !quiet && !editor; loadError = '';
    if (loading) draw();
    try {
      const [list, roster] = await Promise.all([api('/api/bots/logins', { toast: false }), api('/api/agents', { toast: false }).catch(() => [])]);
      if (destroyed || mine !== generation) return;
      logins = list.logins || []; onepassword = list.onepassword || onepassword;
      bots = (Array.isArray(roster) ? roster : roster.agents || []).filter(b => !b.hidden);
      names = Object.fromEntries(bots.map(b => [b.id, b.name]));
    } catch (error) {
      if (destroyed || mine !== generation) return;
      loadError = messageOf(error);
    }
    loading = false;
    draw();
  }

  async function run(label, call, done = '') {
    if (busy || destroyed) return false;
    busy = label; formError = ''; notice = '';
    draw();
    try { await ctx.flush?.(); await call(); if (!destroyed && done) notice = done; return true; }
    catch (error) { if (!destroyed) formError = messageOf(error); return false; }
    finally { busy = ''; if (!destroyed) draw(); }
  }

  async function save() {
    const form = editor.form, editing = !!form.id;
    const problem = validateLogin(form, { editing });
    if (problem) { editor.error = problem; draw(); return; }
    editor.error = '';
    const body = loginBody(form, { editing, removeTotp: editor.removeTotp });
    const ok = await run('save', async () => {
      await api(editing ? `/api/bots/logins/${encodeURIComponent(form.id)}` : '/api/bots/logins', { method: editing ? 'PATCH' : 'POST', toast: false, body: JSON.stringify(body) });
      editor = null;
      await load(true);
    }, editing ? 'Saved.' : 'Login saved. The password is encrypted and will not be shown again.');
    if (!ok && editor) { editor.error = formError; formError = ''; draw(); }
  }

  // Delete needs a second press, in a dialog that names the site.
  async function remove(login) {
    if (!await confirmDialog({ title: `Delete the login for ${login.site}?`, message: `The saved password for ${login.username} is erased. Bots can no longer sign in there.`, confirmLabel: 'Delete' })) return;
    await run('delete', async () => { await api(`/api/bots/logins/${encodeURIComponent(login.id)}`, { method: 'DELETE', toast: false }); if (editor?.form.id === login.id) editor = null; await load(true); }, 'Deleted.');
  }

  // -- 1Password -----------------------------------------------------------------------------------------------
  const connect = () => !opToken.trim() ? (formError = 'Paste the service-account token first.', draw())
    : run('op-connect', async () => { const token = opToken; opToken = ''; onepassword = await api('/api/bots/logins/onepassword', { method: 'POST', toast: false, body: JSON.stringify({ token }) }); }, '1Password is connected.');
  const refresh = () => run('op-refresh', async () => { onepassword = await api('/api/bots/logins/onepassword/refresh', { method: 'POST', toast: false }); });
  const disconnect = () => run('op-off', async () => { onepassword = await api('/api/bots/logins/onepassword', { method: 'DELETE', toast: false }); }, '1Password is disconnected.');
  const setVault = (vault, value) => run('op-vault', async () => { onepassword = await api(`/api/bots/logins/onepassword/vaults/${encodeURIComponent(vault.id)}`, { method: 'PUT', toast: false, body: JSON.stringify({ bots: value }) }); });

  function loginRow(login) {
    const node = el('div', { class: 'bots-conn-item', 'data-login': login.id }, [el('div', { class: 'bots-row bots-conn-row' }, [
      el('span', { class: 'bots-conn-mark', 'aria-hidden': 'true' }, [icon('lock', { size: 16 })]),
      el('span', { class: 'bots-conn-main static' }, [el('span', { class: 'bots-row-title', text: login.site }), el('span', { class: 'bots-row-hint', text: loginMeta(login, names) })]),
      login.has_totp ? chip('2FA', 'good') : null,
      el('div', { class: 'bots-conn-actions' }, [
        Button({ label: 'Change', iconName: 'pencil', disabled: !!busy, onClick: () => { editor = { form: loginToForm(login), removeTotp: false, error: '' }; draw(); setTimeout(() => root.querySelector('.bots-conn-editor-card')?.scrollIntoView?.({ block: 'nearest' }), 0); } }),
        Button({ label: 'Delete', variant: 'danger', iconName: 'trash-2', disabled: !!busy, onClick: () => remove(login) })]),
    ])]);
    const buttons = node.querySelectorAll('.bots-conn-actions .bots-btn'); buttons[0].setAttribute('data-act', 'change'); buttons[1].setAttribute('data-act', 'delete');
    return node;
  }

  function botPicker(form) {
    const box = el('div', { class: 'bots-conn-checks', role: 'group', 'aria-label': 'Bots that may use this login' });
    for (const bot of bots) {
      const input = el('input', { type: 'checkbox', 'aria-label': bot.name }); input.checked = form.bots.includes(bot.id);
      input.addEventListener('change', () => { form.bots = input.checked ? [...new Set([...form.bots, bot.id])] : form.bots.filter(id => id !== bot.id); });
      box.append(el('label', { class: 'bots-conn-check', 'data-bot': bot.id }, [input, el('span', { text: bot.name })]));
    }
    if (!bots.length) box.append(el('div', { class: 'bots-row-hint', text: 'No bots yet.' }));
    return box;
  }

  function editorCard() {
    const form = editor.form, editing = !!form.id;
    const sync = (key, input) => { input.addEventListener('input', () => { form[key] = input.value; }); return input; };
    const password = sync('password', secretInput({ 'data-field': 'password', placeholder: editing ? 'Saved. Leave blank to keep it.' : 'Password' }));
    const seed = sync('totp', secretInput({ 'data-field': 'totp', placeholder: editing && form.has_totp ? 'Saved. Type to replace.' : 'Optional' }));
    const parts = [
      field('Site', sync('site', textInput(form.site, { 'data-field': 'site', placeholder: 'example.com' })), 'Just the site, for example example.com.'),
      field('Username', sync('username', textInput(form.username, { 'data-field': 'username' }))),
      field('Password', password, 'Encrypted when saved. It is never shown again.'),
      field('One-time-code seed', seed, 'Optional. The secret behind your authenticator app, or its otpauth:// address.'),
    ];
    if (editing && form.has_totp) parts.push(SwitchRow({ title: 'Remove the saved seed', hint: 'Bots will no longer be given a one-time code for this site.', checked: editor.removeTotp, onChange: on => { editor.removeTotp = on; } }));
    parts.push(SwitchRow({ title: 'This exact site only', hint: 'Off lets the login be used on the site\'s subdomains, such as login.example.com.', checked: form.exact_host, onChange: on => { form.exact_host = on; } }));
    parts.push(el('div', { class: 'bots-conn-field' }, [el('span', { class: 'bots-conn-label', text: 'Which bots may use it' }),
      Segmented({ label: 'Which bots may use it', value: form.access, options: [{ value: 'all', label: 'All bots' }, { value: 'some', label: 'Only these' }], onChange: v => { form.access = v; draw(); } }),
      form.access === 'some' ? botPicker(form) : null]));
    if (editor.error) parts.push(statusBox(editor.error, 'error'));
    parts.push(el('div', { class: 'bots-conn-buttons' }, [Button({ label: editing ? 'Save changes' : 'Save login', variant: 'primary', disabled: !!busy, onClick: save }),
      Button({ label: 'Cancel', disabled: !!busy, onClick: () => { editor = null; draw(); } })]));
    const buttons = parts[parts.length - 1].querySelectorAll('.bots-btn'); buttons[0].setAttribute('data-act', 'save'); buttons[1].setAttribute('data-act', 'cancel');
    return Card({ label: editing ? `Change the login for ${form.site}` : 'Add a login', className: 'bots-conn-editor-card', children: [el('div', { class: 'bots-conn-editor' }, parts)] });
  }

  function onePasswordCard() {
    const children = [];
    if (!onepassword.available) children.push(el('div', { class: 'bots-conn-editor' }, [el('div', { class: 'bots-row-hint', 'data-op': 'unavailable', text: onepassword.reason || '1Password is not available on this computer.' })]));
    else if (!onepassword.connected) {
      const token = secretInput({ 'data-field': 'op-token', placeholder: 'Service-account token', 'aria-label': 'Service-account token' });
      token.addEventListener('input', () => { opToken = token.value; });
      children.push(el('div', { class: 'bots-conn-editor' }, [field('Service-account token', token, 'Saved encrypted on this computer. Passwords stay in 1Password until a bot signs in.'),
        el('div', { class: 'bots-conn-buttons' }, [Button({ label: 'Connect', variant: 'primary', disabled: !!busy, onClick: connect })])]));
      children[0].querySelector('.bots-btn').setAttribute('data-act', 'op-connect');
    } else {
      const rows = (onepassword.vaults || []).map(vault => {
        const all = vault.bots === 'all';
        const node = el('div', { class: 'bots-conn-item', 'data-vault': vault.id }, [el('div', { class: 'bots-row bots-conn-row' }, [
          el('span', { class: 'bots-conn-main static' }, [el('span', { class: 'bots-row-title', text: vault.name }), el('span', { class: 'bots-row-hint', text: accessLabel(vault.bots, names) })]),
          el('div', { class: 'bots-conn-actions' }, [Button({ label: all ? 'No bots' : 'All bots', disabled: !!busy, onClick: () => setVault(vault, all ? [] : 'all') })])])]);
        if (!all) for (const bot of bots) {
          const input = el('input', { type: 'checkbox', 'aria-label': `${bot.name} may use ${vault.name}` }); input.checked = (vault.bots || []).includes(bot.id);
          input.addEventListener('change', () => setVault(vault, input.checked ? [...(vault.bots || []), bot.id] : (vault.bots || []).filter(id => id !== bot.id)));
          node.append(el('label', { class: 'bots-conn-check bots-conn-detail', 'data-bot': bot.id }, [input, el('span', { text: bot.name })]));
        }
        return node;
      });
      children.push(...(rows.length ? rows : [el('div', { class: 'bots-conn-editor' }, [el('div', { class: 'bots-row-hint', text: 'No vaults were found for this token.' })])]));
      children.push(el('div', { class: 'bots-conn-editor' }, [el('div', { class: 'bots-conn-buttons' }, [Button({ label: 'Refresh vaults', iconName: 'refresh-cw', disabled: !!busy, onClick: refresh }), Button({ label: 'Disconnect', variant: 'danger', disabled: !!busy, onClick: disconnect })])]));
    }
    return Card({ label: '1Password', children });
  }

  function draw() {
    if (destroyed) return;
    if (loading) { root.replaceChildren(statusBox('Loading saved logins...')); return; }
    if (loadError) { root.replaceChildren(statusBox(loadError, 'error'), Button({ label: 'Retry', iconName: 'refresh-cw', onClick: () => load() })); return; }
    const parts = ctx.embedded ? [] : [PageHeader({ title: 'Signed-in sites', intro: 'Logins a bot\'s computer can fill in for you. A bot never sees the password, and filling never presses the sign-in button.' })];
    if (notice) parts.push(statusBox(notice, 'good'));
    if (formError && !editor) parts.push(statusBox(formError, 'error'));
    parts.push(Card({ label: `Saved logins (${logins.length})`, children: logins.length ? logins.map(loginRow) : [el('div', { class: 'bots-conn-empty' }, [icon('lock', { size: 18 }), el('div', {}, [
      el('div', { class: 'bots-row-title', text: 'No saved logins' }), el('div', { class: 'bots-row-hint', text: 'Add one so a bot can sign in to a site for you.' })])])] }));
    if (editor) parts.push(editorCard());
    else { parts.push(el('div', { class: 'bots-conn-buttons' }, [Button({ label: 'Add a login', iconName: 'plus', disabled: !!busy, onClick: () => { editor = { form: emptyLogin(), removeTotp: false, error: '' }; draw(); } })])); parts[parts.length - 1].querySelector('.bots-btn').setAttribute('data-act', 'add'); }
    parts.push(onePasswordCard());
    root.replaceChildren(...parts);
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
  }

  load();
  return {
    destroy() { destroyed = true; generation++; opToken = ''; root.remove(); },
    refresh: () => load(true),
    flush: () => Promise.resolve(true),
  };
}

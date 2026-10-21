import { mountRobloxStylePanel } from '/api/addons/roblox/files/static/robloxStylePanel.js';
import { api, el, toast, customSelect } from '/static/js/api.js';
import { mountSessionChat } from '/static/js/sessionChat.js';
import * as live from '/static/js/chatStream.js';

const BASE = '/api/tab-roblox';

export async function render(container, _id, options = {}) {
  let disposed = false, closeChat = () => {}, stopWatch = () => {}, revision = 0;
  let status, active = null, pollTimer, healthTimer;
  const root = el('div', { class: 'roblox-workspace view-constrained' });
  container.replaceChildren(root);
  const cleanup = () => { disposed = true; revision++; clearTimeout(pollTimer); clearTimeout(healthTimer); closeChat(); stopWatch(); };
  options.registerCleanup?.(cleanup);
  const request = (path, method = 'GET', body) => api(BASE + path, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const button = (text, run, primary = false) => {
    const node = el('button', { type: 'button', class: primary ? 'btn primary' : 'btn', text });
    node.onclick = async () => {
      node.disabled = true;
      try { await run(); } catch (problem) { if (!disposed) toast(problem.message, 'error'); }
      finally { node.disabled = false; }
    };
    return node;
  };
  const field = (label, input) => el('label', { class: 'roblox-field' }, [el('span', { text: label }), input]);
  const card = (title, children = []) => el('section', { class: 'glass card roblox-card' }, [el('h3', { text: title }), ...children]);
  const note = text => el('p', { class: 'meta', text });
  const input = (placeholder, value = '') => el('input', { type: 'text', placeholder, value });
  const downloadLink = (pid, file) => el('a', { class: 'roblox-file',
    href: `${BASE}/projects/${pid}/files/${encodeURIComponent(file.name)}`, download: file.name, text: file.name });

  async function home() {
    const version = ++revision;
    closeChat(); stopWatch(); clearTimeout(healthTimer); active = null; root.classList.remove('roblox-project-open');
    root.replaceChildren(note('Loading Roblox workspace...'));
    try {
      const [nextStatus, projects] = await Promise.all([request('/status'), request('/projects')]);
      if (disposed || version !== revision) return;
      status = nextStatus;
      const refresh = button('Refresh', home);
      root.replaceChildren(el('div', { class: 'view-header' }, [el('div', {}, [el('h2', { text: 'Roblox' }),
        el('p', { class: 'sub', text: 'Bring an idea. Build it in Studio.' })]), refresh]));
      const setup = el('details', { class: 'roblox-settings glass' }, [el('summary', { text: 'Account & setup' })]);
      const setupBody = el('div', { class: 'roblox-setup' }); setup.append(setupBody);
      const accountSummary = el('div', { class: 'roblox-account-strip' }); root.append(accountSummary);
      const account = status.account;
      const accountCard = card('Roblox account', [note(account.connected
        ? `Connected as ${account.profile?.preferred_username || account.profile?.name || account.profile?.sub}`
        : 'Connect your account to find public creations and experiences you authorize.')]);
      if (account.connected) accountCard.append(button('Disconnect account', async () => {
        const result = await request('/account', 'DELETE'); if (result.warning) toast(result.warning); await home();
      }));
      else {
        const connect = button('Connect Roblox', async () => {
          const result = await request('/oauth/start', 'POST');
          window.open(result.url, '_blank', 'noopener,noreferrer');
          const deadline = Date.now() + 10 * 60 * 1000;
          const check = async () => {
            if (disposed || !root.isConnected || Date.now() > deadline) return;
            try { if ((await request('/status')).account.connected) { await home(); return; } } catch { /* Retry transient connection loss. */ }
            pollTimer = setTimeout(check, 1800);
          };
          clearTimeout(pollTimer); pollTimer = setTimeout(check, 1800);
          toast('Complete Roblox sign-in in your browser, then return here.');
        }, true);
        connect.disabled = !account.oauth_configured;
        accountCard.append(connect);
      }
      const studioCard = card('Native Roblox Studio', [note(status.studio.installed
        ? 'Studio is installed on the Kairos host computer. Changes happen in that app.'
        : 'Install Roblox Studio on the computer running Kairos to build and playtest.'), note(status.studio.instructions),
        el('a', { href: 'https://create.roblox.com/docs/studio/mcp', target: '_blank', rel: 'noopener noreferrer', text: 'Studio connection guide' })]);
      if (!status.admin) studioCard.append(note('An administrator must operate native Studio on this Kairos installation.'));
      setupBody.append(accountCard, studioCard);
      accountSummary.append(el('span', { class: 'roblox-badge', text: account.connected ? `Roblox: ${account.profile?.preferred_username || account.profile?.name || account.profile?.sub}` : 'Roblox account not connected' }),
        el('span', { class: 'meta', text: status.studio.installed ? 'Studio installed on this computer' : 'Studio installation needed' }),
        button('Account & setup', () => { setup.open = !setup.open; if (setup.open) setup.scrollIntoView({ block: 'nearest' }); }));
      if (status.admin) await renderOAuth(setupBody);
      if (disposed || version !== revision) return;
      const name = input('My obstacle course');
      const kind = customSelect({}, ['experiment', 'local', 'cloud'].map(value => el('option', { value,
        text: ({ experiment: 'New experiment', local: 'Existing local place', cloud: 'Cloud experience' })[value] })));
      const universe = input('Universe ID'), place = input('Place ID');
      universe.inputMode = place.inputMode = 'numeric';
      const cloudFields = el('div', { class: 'roblox-row', hidden: true }, [field('Universe ID', universe), field('Place ID', place)]);
      kind.onchange = () => { cloudFields.hidden = kind.value !== 'cloud'; };
      const createCard = card('Create or link a project', [el('div', { class: 'roblox-row' }, [field('Project name', name), field('Project type', kind)]),
        cloudFields, button('Create project', async () => {
          const row = await request('/projects', 'POST', { name: name.value, kind: kind.value,
            universe_id: universe.value || null, place_id: place.value || null });
          await open(row.id);
        }, true), note('Experiments start in an unpublished baseplate. Local projects accept a .rbxl or .rbxlx file. Link private or group places by their IDs.')]);
      const grid = el('div', { class: 'roblox-project-grid' });
      root.append(el('h3', { text: 'Your projects' }), grid);
      if (!projects.length) grid.append(note('No projects yet. Start an experiment or link a game.'));
      for (const p of projects) grid.append(el('button', { class: 'glass card roblox-project', type: 'button', onclick: () => open(p.id).catch(e => toast(e.message, 'error')) }, [
        el('span', { class: 'title', text: p.name }), el('span', { class: 'meta', text: `${p.kind === 'cloud' ? 'Cloud experience' : p.kind === 'local' ? 'Local place' : 'Experiment'}${p.studio_id ? ' | Studio linked' : ''}` }),
        el('span', { class: 'meta', text: new Date(p.updated_at * 1000).toLocaleString() }),
      ]));
      const createDetails = el('details', { class: 'roblox-create' }, [el('summary', { text: 'New project or linked experience' }), createCard]);
      createDetails.open = projects.length === 0; root.append(createDetails);
      if (account.connected) {
        const library = card('Roblox creations', [note('Load public creations and explicitly authorized experiences. Coverage depends on Roblox permissions.')]);
        library.append(button('Load creations', async () => {
          const result = await request('/library');
          if (disposed || version !== revision) return;
          const list = el('div', { class: 'roblox-project-grid' });
          for (const game of result.games) list.append(button(game.name, async () => {
            const existing = projects.find(p => p.universe_id === game.universe_id && p.place_id === game.place_id);
            const row = existing || await request('/projects', 'POST', { ...game, kind: 'cloud' });
            await open(row.id);
          }));
          library.replaceChildren(el('h3', { text: 'Roblox creations' }), note(result.coverage), ...result.warnings.map(note), list);
          if (!result.games.length) library.append(note('No creations returned. You can still link a cloud place by ID.'));
        })); root.append(library);
      }
      root.append(setup);
    } catch (problem) { if (!disposed && version === revision) root.replaceChildren(note(problem.message), button('Try again', home)); }
  }

  async function renderOAuth(host) {
    const cfg = await request('/oauth/config');
    if (disposed || !host.isConnected) return;
    const id = input('Roblox OAuth client ID', cfg.client_id);
    const origin = new URL(location.origin); if (origin.hostname === '127.0.0.1') origin.hostname = 'localhost';
    const redirect = input('Registered callback URL', cfg.redirect_uri || `${origin.origin}${BASE}/oauth/callback`);
    const secret = el('input', { type: 'password', autocomplete: 'off', placeholder: cfg.has_client_secret ? 'Saved; leave blank to keep' : 'Only for a registered confidential client' });
    const detail = el('details', { class: 'disclosure-panel roblox-oauth' }, [el('summary', { text: 'Roblox sign-in setup (administrator)' }),
      note('Register an OAuth app in Roblox Creator Dashboard. Enable openid, profile and universe:read. Use PKCE and register this exact callback. A distributed desktop client must not contain a client secret. Roblox review is required beyond private testing.'),
      note('Client ID is issued by Roblox for this OAuth app. The GitHub skill URL is not an application ID. Register the callback below exactly, including localhost and port.'),
      field('Client ID', id), field('Callback URL', redirect), field('Client secret (optional)', secret),
      button('Save sign-in settings', async () => {
        await request('/oauth/config', 'PUT', { client_id: id.value, redirect_uri: redirect.value, client_secret: secret.value || null });
        secret.value = ''; await home();
      }), el('a', { href: 'https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab', target: '_blank', rel: 'noopener noreferrer', text: 'Register Roblox OAuth app' }),
    ]); host.append(detail);
  }

  async function open(pid) {
    const version = ++revision;
    closeChat(); stopWatch(); clearTimeout(pollTimer); clearTimeout(healthTimer); active = pid; root.classList.add('roblox-project-open');
    const [p, currentStatus] = await Promise.all([request(`/projects/${pid}`), request('/status')]);
    if (disposed || version !== revision) return;
    status = currentStatus;
    const state = el('span', { class: 'roblox-state', role: 'status', text: 'Checking Studio connection...' });
    const accessState = el('span', { class: 'roblox-badge' });
    const diagnostic = el('p', { class: 'roblox-connection-message meta' });
    root.replaceChildren(el('div', { class: 'view-header' }, [el('div', {}, [button('All projects', home), el('h2', { text: p.name })])]));
    const controls = el('aside', { class: 'roblox-project-controls' });
    const chatHost = el('div', { class: 'glass roblox-chat' });
    const connectionBar = el('div', { class: 'roblox-connection-bar glass' }, [state, accessState]);
    root.append(connectionBar, diagnostic, el('div', { class: 'roblox-project-layout' }, [chatHost, controls]));
    let working = false, lastHealth = null, healthChecking = false;
    const valid = () => !disposed && active === pid && version === revision;
    async function refreshHealth() {
      if (!status.admin || !valid() || healthChecking || working) return;
      healthChecking = true;
      try {
        const health = await request(`/projects/${pid}/connection`);
        if (!valid()) return; lastHealth = health;
        state.dataset.state = health.state;
        state.textContent = ({ connected: 'Studio verified', disconnected: 'Studio disconnected', busy: 'Studio busy', needs_attention: 'Connection needs attention' })[health.state] || 'Studio unavailable';
        accessState.textContent = health.state === 'connected' ? (p.write_enabled ? 'AI edits enabled' : 'Inspect only') : health.state === 'busy' ? 'Verification pending' : 'AI access paused';
        diagnostic.textContent = health.message || '';
      } catch (problem) { if (valid()) { state.textContent = 'Connection check failed'; state.dataset.state = 'needs_attention'; accessState.textContent = 'AI access paused'; diagnostic.textContent = problem.message; } }
      finally { healthChecking = false; }
    }
    function scheduleHealth() {
      clearTimeout(healthTimer); healthTimer = setTimeout(async () => { if (!valid()) return; await refreshHealth(); if (valid()) scheduleHealth(); }, 10000);
    }
    const checkConnection = button('Check connection', refreshHealth); connectionBar.append(checkConnection);
    if (!status.admin) { state.textContent = 'Studio control requires an administrator'; accessState.textContent = 'Chat available'; }
    const brief = el('textarea', { rows: 5, maxlength: 12000, placeholder: 'Describe the game, audience, mechanics and visual direction. Attach UI and model references in the chat.' });
    brief.value = p.brief;
    const briefCard = card('Project brief', [brief, button('Save brief', async () => { await request(`/projects/${pid}/brief`, 'PUT', { text: brief.value }); toast('Project brief saved.'); })]);
    const copy = el('input', { type: 'file', accept: '.rbxl,.rbxlx', 'aria-label': 'Upload a saved Roblox place copy' });
    copy.onchange = async () => {
      const file = copy.files[0]; if (!file) return;
      copy.disabled = true;
      try {
        const form = new FormData(); form.append('file', file);
        Object.assign(p, await api(`${BASE}/projects/${pid}/place-copy`, { method: 'POST', headers: {}, body: form }));
        edits.checked = false; recoveryStatus.textContent = 'A recovery copy is saved. Download it below when needed.';
        await Promise.allSettled([refreshHealth(), refreshActivity()]); toast('Recovery copy saved. AI edits are off until you reconnect with edits enabled.');
      } catch (problem) { toast(problem.message, 'error'); } finally { copy.disabled = false; }
    };
    const recoveryStatus = note(p.backup ? 'A recovery copy is saved. Download it below when needed.'
      : p.kind === 'experiment' ? 'This is a disposable local experiment. Save a place copy from Studio to keep a full recovery file.'
      : 'Before AI edits, save a copy of this place in Studio and upload it here. The copy must match the place you connect.');
    const recoveryCard = card('Saved place copy', [recoveryStatus, copy,
      note('Script snapshots preserve source code. Restore models, terrain and other world changes by reopening your saved place copy in Studio.')]);
    const studio = card('Studio connection', [note('Reconnect the window that contains your work. Starting another blank experiment does not restore unsaved changes.'), note(status.studio.instructions)]);
    let edits = el('input', { type: 'checkbox' }); edits.checked = p.write_enabled;
    if (status.admin) {
      studio.append(button('Open in Roblox Studio', async () => {
        const result = await request(`/projects/${pid}/open`, 'POST');
        if (!valid()) return; toast(result.message); await refreshWindowsList(result.studio_id); await refreshHealth();
      }));
      let windows = customSelect({}, [el('option', { value: p.studio_id || '',
        text: p.studio_id ? `${p.studio_name || 'Connected Studio'} | ${p.studio_id.slice(0, 8)}` : 'Refresh to find Studio windows' })]);
      const windowField = field('Target Studio window', windows);
      const windowNote = note('Choose this project\'s window. Other open games stay outside this connection.');
      async function refreshWindowsList(preferred = p.studio_id) {
        const rows = await request('/studios'); if (!valid()) return;
        const opts = [el('option', { value: '', text: rows.length ? 'Choose a Studio window' : 'No Studio windows connected' }),
          ...rows.map(s => el('option', { value: s.studio_id, text: `${s.name} | ${s.place_id === '0' ? 'Local place' : `Place ${s.place_id}`} | ${s.studio_id.slice(0, 8)}` }))];
        const next = customSelect({}, opts);
        next.value = rows.some(row => row.studio_id === preferred) ? preferred : '';
        windows.replaceWith(next); windows = next;
        windowNote.textContent = rows.length ? 'Choose the window containing your game. IDs distinguish windows with the same name. Identity is checked before access is granted.' : 'No Studio windows found. Enable its MCP server and refresh. Preserve any unsaved scene.';
      }
      const refreshWindows = button('Refresh Studio windows', () => refreshWindowsList());
      studio.append(refreshWindows, windowField, windowNote,
        el('label', { class: 'roblox-edit-choice' }, [edits, 'Allow AI edits to this project']),
        button('Connect selected window', async () => {
          Object.assign(p, await request(`/projects/${pid}/studio`, 'PUT', { studio_id: windows.value, allow_edits: edits.checked }));
          await refreshHealth(); toast('Studio connection updated.');
        }, true));
      studio.append(button('Disconnect Studio', async () => { Object.assign(p, await request(`/projects/${pid}/studio`, 'DELETE')); edits.checked = false; await refreshHealth(); }));
    } else studio.append(note('Native Studio control is available to administrators.'));
    const preview = el('div', { class: 'roblox-viewport' });
    const viewportCard = status.admin ? card('Studio viewport', [button('Capture current viewport', async () => {
      const result = await request(`/projects/${pid}/viewport`, 'POST');
      preview.replaceChildren(...result.images.map(data => el('img', { src: `data:image/png;base64,${data}`, alt: 'Current Roblox Studio viewport' })), note(result.text));
    }), preview]) : null;
    const styleHost = card('Your growing style skill');
    const refreshStyle = mountRobloxStylePanel(styleHost, pid, () => !disposed && active === pid && version === revision);
    const assets = card('Asset provenance');
    const history = card('Activity');
    const files = card('Project files');
    const refreshActivity = async () => {
      try {
        const [row, entries, manifest] = await Promise.all([request(`/projects/${pid}`), request(`/projects/${pid}/files`), request(`/projects/${pid}/assets`)]);
        if (disposed || active !== pid || version !== revision) return;
        history.replaceChildren(el('h3', { text: 'Activity' }), ...row.activity.slice(-20).reverse().map(event =>
          el('details', { class: 'roblox-event' }, [el('summary', { text: `${event.ok ? '' : 'Failed: '}${event.name} | ${new Date(event.at * 1000).toLocaleTimeString()}` }), el('pre', { text: event.detail || '' })])));
        if (!row.activity.length) history.append(note('Studio actions and playtest results appear here.'));
        assets.replaceChildren(el('h3', { text: 'Asset provenance' }), note('Sources and import states reported by Kairos. Verify the actual imported result in Studio.'), ...manifest.map(asset =>
          el('details', {}, [el('summary', { text: `${asset.name} | ${asset.source} | ${asset.import_status}` }), el('pre', { text: JSON.stringify(asset, null, 2) })])));
        files.replaceChildren(el('h3', { text: 'Project files' }), ...entries.map(file => downloadLink(pid, file)));
        if (!entries.length) files.append(note('Saved place copies and script snapshots appear here.'));
      } catch (problem) { if (!disposed) toast(problem.message, 'error'); }
    };
    const tabs = el('div', { class: 'roblox-inspector-tabs', role: 'tablist', 'aria-label': 'Project inspector' });
    const panes = [];
    function selectPane(index) {
      panes.forEach((pane, i) => { pane.node.hidden = i !== index; pane.button.setAttribute('aria-selected', String(i === index)); pane.button.tabIndex = i === index ? 0 : -1; });
    }
    for (const [label, children] of [['Connection', [studio, viewportCard]], ['Brief', [briefCard]], ['Style', [styleHost]], ['Assets', [assets]], ['Files', [recoveryCard, files]], ['Activity', [history]]]) {
      const index = panes.length, id = `roblox-inspector-${label.toLowerCase()}`;
      const tab = button(label, () => selectPane(index)); tab.setAttribute('role', 'tab'); tab.id = id + '-tab'; tab.setAttribute('aria-controls', id);
      const pane = el('div', { class: 'roblox-inspector-pane', role: 'tabpanel', id, 'aria-labelledby': tab.id }, children.filter(Boolean));
      panes.push({ button: tab, node: pane }); tabs.append(tab);
    }
    tabs.onkeydown = event => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      const current = panes.findIndex(pane => pane.button === document.activeElement); if (current < 0) return;
      event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + panes.length) % panes.length;
      selectPane(index); panes[index].button.focus();
    };
    controls.append(tabs, ...panes.map(pane => pane.node)); selectPane(0);
    connectionBar.append(button('Reconnect window', () => { selectPane(0); controls.scrollIntoView({ block: 'nearest' }); }));
    const { session_id: sessionId } = await request(`/projects/${pid}/session`, 'POST');
    if (disposed || version !== revision) return;
    const chatCleanup = await mountSessionChat(chatHost, { sessionId, title: `Roblox: ${p.name}`, attachments: true,
      modelPicker: true, permissionPicker: true, openInChats: true, placeholder: 'Describe what to build, or attach a model or UI reference...',
      emptyTitle: 'Build with Kairos', emptyText: 'Connect Studio, choose a model, and describe your game.', onTurnEnd: async () => { working = false; await Promise.allSettled([refreshActivity(), refreshStyle(), refreshHealth()]); } });
    const fitWorkspace = () => { if (valid()) root.style.setProperty('--roblox-chat-height', `${Math.max(400, window.innerHeight - chatHost.getBoundingClientRect().top - 20)}px`); };
    window.addEventListener('resize', fitWorkspace); fitWorkspace();
    closeChat = () => { window.removeEventListener('resize', fitWorkspace); chatCleanup(); };
    if (disposed || version !== revision) { closeChat(); return; }
    await Promise.allSettled([refreshActivity(), refreshHealth()]); scheduleHealth();
    stopWatch = live.subscribe(sessionId, entry => {
      if (disposed || active !== pid) return;
      working = entry.status === 'processing';
      root.classList.toggle('is-working', working); checkConnection.disabled = working;
      if (working) { state.textContent = 'Kairos is working in Studio...'; state.dataset.state = 'busy'; }
      else if (lastHealth) refreshHealth();
    });
  }
  await home();
  return cleanup;
}

import { api, el, toast, openPanelDialog } from '/static/js/api.js';

const BASE = '/api/creative';
const request = (path, method = 'GET', body) => api(BASE + path, { method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const note = text => el('p', { class: 'meta', text });
const action = (text, run) => {
  const button = el('button', { type: 'button', class: 'btn', text });
  button.onclick = async () => { button.disabled = true;
    try { await run(); } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  };
  return button;
};

export function creativeSelectionButton(scope, owner, opener = null) {
  const button = action('Creative tools', async () => {
    const target = typeof scope === 'function' ? scope() : scope;
    if (!target?.sessionId && !target?.agentId) throw new Error('Start a conversation first.');
    const query = target.agentId ? `agent_id=${encodeURIComponent(target.agentId)}` : `session_id=${encodeURIComponent(target.sessionId)}`;
    const body = el('div');
    const dialog = openPanelDialog({ title: 'Creative tools for this ' + (target.agentId ? 'bot' : 'chat'), body, opener: opener || button, owner, group: 'creative' });
    const state = await request('/selection?' + query);
    if (dialog.signal.aborted) return;
    body.append(note('Only the connections checked here can be used. Manage your private accounts in Tool Store.'));
    const checks = state.connections.map(connection => {
      const cb = el('input', { type: 'checkbox', disabled: !connection.connected });
      cb.checked = state.selected.includes(connection.id);
      body.append(el('label', { class: 'workspace-row' }, [cb, `${connection.name}${connection.connected ? '' : ' (connect in Tool Store)'}`]));
      return [connection.id, cb];
    });
    body.append(action('Save creative tools', async () => {
      await request('/selection?' + query, 'PUT', { providers: checks.filter(([, cb]) => cb.checked && !cb.disabled).map(([id]) => id) });
      dialog.close(); toast('Creative tools saved.');
    }));
  });
  button.setAttribute('aria-haspopup', 'dialog');
  return button;
}

export function openCreativeConnection(provider, opener, owner, changed = () => {}) {
  const body = el('div', { class: 'creative-connection' });
  const dialog = openPanelDialog({ title: provider === 'blender' ? 'Connect Blender' : 'Connect Higgsfield', body, opener, owner, group: 'creative' });
  async function refresh() {
    const [catalog, jobs, auth] = await Promise.all([request(''), request('/jobs'), api('/api/auth/status')]);
    if (dialog.signal.aborted) return;
    const connection = catalog.find(c => c.id === provider);
    body.replaceChildren(note(connection.status || 'Connect your account to use it across Kairos.'),
      note('Choose this connection separately in each chat or bot. Account credentials stay private to your Kairos user.'));
    if (provider === 'blender') {
      body.append(note('In Blender: Preferences > Add-ons > Install from Disk. Install this file, enable it, then open the Kairos sidebar in the 3D View. Save a .blend file and start the connection.'),
        el('a', { href: BASE + '/blender/addon', download: 'kairos_blender.py', text: 'Download Kairos Blender add-on' }),
        note('Approved Python runs with your Blender permissions. Kairos saves a .blend checkpoint before each run.'));
      const port = el('input', { type: 'number', min: 1024, max: 65535, value: connection.port || 9876, 'aria-label': 'Blender loopback port' });
      const token = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Pairing token from Blender', 'aria-label': 'Blender pairing token' });
      if (auth.is_admin) body.append(port, token, action('Pair Blender', async () => {
        await request('/blender', 'POST', { port: Number(port.value), token: token.value.trim() }); token.value = ''; await refresh(); changed();
      }));
      else body.append(note('An administrator must pair the native Blender app.'));
      if (connection.file) body.append(note('Connected file: ' + connection.file));
    } else {
      body.append(note('Higgsfield requires its own account and eligible subscription. MCP requests use credits. Review each request before submitting; a web unlimited plan does not make MCP generations free.'),
        note('Sign in from the computer running Kairos so the browser can return to its local callback.'),
        action(connection.connected ? 'Reconnect Higgsfield' : 'Sign in to Higgsfield', async () => {
          const result = await request('/higgsfield/sign-in', 'POST');
          if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer');
          toast('Complete sign-in, then refresh this connection.');
        }));
    }
    body.append(action('Refresh connection', refresh));
    if (connection.connected) body.append(action('Check connection and tools', async () => {
      await request(`/${provider}/check`, 'POST', {}); await refresh(); changed();
    }));
    if (connection.held_tools?.length) {
      body.append(note('New or changed tools are held. Review their names and schema fingerprints below.'),
        el('pre', { text: JSON.stringify(connection.held_tools, null, 2) }),
        action('Review current tool schemas', async () => {
          const data = await request('/higgsfield/review');
          if (dialog.signal.aborted) return;
          const review = el('details', { open: true }, [el('summary', { text: 'Higgsfield tool schemas' }), el('pre', { text: JSON.stringify(data, null, 2) }),
            action('Accept reviewed tool schemas', async () => { await request('/higgsfield/check', 'POST', { accept: true }); await refresh(); changed(); })]);
          body.append(review);
        }));
    }
    if (connection.added) body.append(action('Disconnect ' + connection.name, async () => { await request('/' + provider, 'DELETE'); await refresh(); changed(); }));
    for (const job of jobs.filter(j => j.provider === provider && ['pending', 'uncertain'].includes(j.state))) {
      body.append(note(`${job.name}: ${job.state}. Check the native app or provider's job history before allowing another attempt.`),
        action('I checked the result; clear retry guard', async () => { await request(`/jobs/${job.id}/reviewed`, 'POST'); await refresh(); }));
    }
  }
  refresh().catch(error => { if (!dialog.signal.aborted) body.replaceChildren(note(error.message)); });
  return dialog;
}

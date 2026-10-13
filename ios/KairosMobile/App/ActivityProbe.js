// WKWebView.callAsyncJavaScript body, executed in WKContentWorld.defaultClient.
// Input arguments are structured values (never interpolated JavaScript).
// No message handler is exposed to page scripts or embedded previews.
if (location.origin !== expectedOrigin) throw new Error('Open the configured Kairos server first.');
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 8000);
const validID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const states = new Set(['running', 'awaiting_permission', 'completed', 'failed', 'interrupted', 'stopped']);
function summary(row) {
    if (!row || !validID(row.id) || !validID(row.session_id) || !states.has(row.state) ||
        !Number.isFinite(row.started_at) || !Number.isInteger(row.revision) || row.revision < 0) return null;
    const terminal = ['completed', 'failed', 'interrupted', 'stopped'].includes(row.state);
    return { id: row.id, sessionID: row.session_id,
        state: terminal ? row.state : (row.permissions?.length ? 'awaiting_permission' : 'running'),
        startedAt: row.started_at, revision: row.revision };
}
async function get(path) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: controller.signal });
    if (response.status === 401) return null;
    if (response.status === 404) return { missing: true };
    if (!response.ok) throw new Error('Kairos activity connection failed.');
    return await response.json();
}
try {
    const auth = await get('/api/auth/status');
    if (!auth?.username) return JSON.stringify({ signedIn: false, runs: [] });
    const rows = await get('/api/chat/runs?active=true');
    if (rows === null) return JSON.stringify({ signedIn: false, runs: [] });
    if (!Array.isArray(rows)) throw new Error('This server needs the mobile notifications build.');
    let selected = null;
    let missing = false;
    if (selectedID && validID(selectedID)) {
        const row = await get('/api/chat/runs/' + encodeURIComponent(selectedID));
        if (row === null) return JSON.stringify({ signedIn: false, runs: [] });
        missing = row.missing === true;
        selected = summary(row);
        if (!missing && !selected) throw new Error('Invalid activity summary.');
    }
    return JSON.stringify({ signedIn: true, account: auth.username,
        runs: rows.map(summary).filter(Boolean), selected, missing });
} finally {
    clearTimeout(timeout);
}

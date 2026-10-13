// Isolated WebKit world; project only public model labels and admin-scoped usage.
if (location.origin !== expectedOrigin) throw new Error('Wrong Kairos origin');
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 20000);
const clean = text => typeof text === 'string' ? text.slice(0, 80) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
async function get(path) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error('Usage unavailable');
    return response.json();
}
try {
    const auth = await get('/api/auth/status');
    const empty = status => JSON.stringify({ updatedAt: Date.now() / 1000, status, models: [] });
    if (!auth?.username) return empty('Sign in to sync usage');
    if (auth.username !== expectedAccount) return empty('Sign-in changed; reopen Kairos');
    if (!auth.is_admin) return empty('Usage requires a Kairos administrator');
    const [choices, quotas, usage] = await Promise.all([get('/api/models/choices'), get('/api/models/quotas'), get('/api/models/usage')]);
    if (!Array.isArray(choices) || !quotas || !usage) return empty('Sign in to sync usage');
    const models = choices.slice(0, 24).filter(ep => typeof ep?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ep.id)).map(ep => {
        const provider = ep.kind === 'codex_cli' ? 'codex' : ep.kind === 'claude_cli' ? 'claude' : null;
        const reading = provider && quotas.providers?.find(row => row.provider === provider);
        const recorded = !provider && usage[ep.id];
        const windows = (Array.isArray(reading?.windows) ? reading.windows : []).slice(0, 3)
            .filter(row => number(row.used_percent) !== null && row.used_percent <= 100)
            .map(row => ({ name: clean(row.name), usedPercent: row.used_percent, resetsAt: number(row.resets_at) }));
        return { id: ep.id, name: clean(ep.name), scope: provider ? 'Shared account allowance' : 'Recorded tokens · limits unavailable',
            windows, totalTokens: number(recorded?.total_tokens), stale: !!provider && (!reading || reading.stale || reading.status !== 'ok') };
    });
    const confirmed = await get('/api/auth/status');
    if (!confirmed?.is_admin || confirmed.username !== expectedAccount) return empty('Sign-in changed; reopen Kairos');
    return JSON.stringify({ updatedAt: Date.now() / 1000, status: models.length ? 'Synced from Kairos' : 'No models connected', models });
} finally { clearTimeout(timeout); }

// The webhook and connected-app event contract, in memory, for the Electron checks (Bots Phase 3 unit U4, 2026-10-29).
// Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 6 and 9. ui-smoke.cjs consults every
// scripts/fixtures/bots-*-backend.cjs while demoState.botsLive is set: read(path, query) and
// mutate(path, method, body, query) answer a route or return undefined to let someone else have it.
// This file answers ONLY /api/bot-webhooks* and /api/bot-app-triggers*. State lives in state.botsEvents.
// Statuses, keys and limits follow routes/bot_event_routes.py; scripts/test_bots_events_contract.cjs holds it to them.
const BODY_CAP = 256 * 1024, PER_MINUTE = 10, MAX_PENDING = [1, 50], DEFAULT_PENDING = 3, ATTEMPTS_SHOWN = 30, ATTEMPTS_KEPT = 2000;
const MAX_DELETED = 50, RESTORE_SECONDS = 7 * 24 * 3600, MAX_PER_BOT = 10;
const CAPABILITY_KEYS = ['id', 'label', 'delivery', 'delivery_label', 'available', 'reason', 'fix', 'accounts', 'events', 'fields'];
const CATALOGUE = [
  { id: 'mail', label: 'Email', delivery: 'poll', delivery_label: 'Checked about every 15 minutes',
    events: [{ type: 'mail.received', label: 'A new email arrives' }],
    fields: [{ key: 'account_id', label: 'Email account', kind: 'account', required: true }] },
  { id: 'calendar', label: 'Calendar', delivery: 'poll', delivery_label: 'Checked about every 5 minutes',
    events: [{ type: 'calendar.event_starting', label: 'A calendar event is about to start' }],
    fields: [{ key: 'lead_minutes', label: 'Minutes before it starts', kind: 'number', required: false, min: 5, max: 60, default: 15 }] },
  { id: 'kairos', label: 'Kairos activity', delivery: 'instant', delivery_label: 'Instant',
    events: [{ type: 'task.finished', label: 'A task or goal run finished' }, { type: 'card.review', label: 'A board card is ready for review' },
      { type: 'agent.inbox', label: 'A bot sent a report or a question' }], fields: [] },
];

class Refusal extends Error { constructor(status, detail, extra = {}) { super(detail); this.status = status; this.extra = extra; } }
const bad = (detail) => new Refusal(400, detail);
const redact = (text) => String(text || '').replace(/\/api\/bot-webhooks\/in\/\S+/g, '[address]')
  .replace(/(bearer\s+\S+|sha256=[0-9a-f]{16,}|(?:secret|token|password|key|credential)[=:]\s*\S+)/gi, '[hidden]')
  .replace(/[A-Za-z0-9_-]{32,}/g, '[hidden]').slice(0, 300);

module.exports = ({ state, data, now }) => {
  const clock = () => (typeof now === 'number' ? now : Date.now() / 1000);
  const seeded = () => {
    if (state.botsEvents) return state.botsEvents;
    return state.botsEvents = { counter: 1, owner: 'local', bots: ['a1', 'a2'], mailAccounts: [{ id: 'mail1', label: 'me@example.test' }],
      webhooks: [], deletedWebhooks: [], appTriggers: [], deletedApp: [], attempts: {}, samples: {}, hits: {}, pending: {} };
  };
  const id = (prefix) => `${prefix}${(seeded().counter++).toString(16).padStart(6, '0')}${Math.floor(clock() % 1000)}`;
  const credential = () => Array.from({ length: 43 }, (_, i) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[(seeded().counter * 7 + i * 13 + i * i) % 64]).join('');
  const record = (hookId, outcome, extra = {}) => {
    const list = seeded().attempts[hookId] ||= [];
    list.unshift({ at: clock(), outcome, event_type: redact(extra.event_type), delivery: redact(extra.delivery),
      status_code: extra.status_code ?? null, detail: redact(extra.detail) });
    list.length = Math.min(list.length, ATTEMPTS_KEPT);
  };
  const webhook = (hookId) => {
    const hook = seeded().webhooks.find(h => h.id === hookId);
    if (!hook) throw new Refusal(404, 'webhook not found');
    return hook;
  };
  const shown = (hook) => { const { secret, ...rest } = hook; return { ...rest, pending_runs: seeded().pending[hook.id] || 0,
    has_sample: !!seeded().samples[hook.id], attempt_count: (seeded().attempts[hook.id] || []).length }; };
  const addressOf = (hook) => `/api/bot-webhooks/in/${hook.id}/${hook.secret}`;
  const conditions = (list) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 10 || list.some(c => !c || !String(c.path || '').trim())) throw new Refusal(422, 'conditions are up to 10 filters, each with a field');
    return list.map(c => ({ path: String(c.path).trim(), equals: String(c.equals ?? '') }));
  };
  const lookup = (payload, dotted) => dotted.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), payload);
  const strict = (body, allowed) => { const extra = Object.keys(body || {}).filter(k => !allowed.includes(k)); if (extra.length) throw new Refusal(422, `unknown field: ${extra.join(', ')}`); };
  // Any bot a check made through the Bots core fixture (state.botsCore) counts; the fixed pair is the fallback.
  const botExists = (botId) => seeded().bots.includes(botId) || (state.botsCore?.agents || []).some(a => a.id === botId);
  const available = (cap) => (cap.id === 'mail'
    ? (seeded().mailAccounts.length ? { available: true, reason: '', fix: null, accounts: seeded().mailAccounts.map(a => ({ ...a })) }
      : { available: false, reason: 'No email account is connected.', fix: { label: 'Connect email', target: 'email' }, accounts: [] })
    : { available: true, reason: '', fix: null, accounts: [] });
  const capabilities = () => CATALOGUE.map(cap => ({ ...JSON.parse(JSON.stringify(cap)), ...available(cap) }));
  const subPublic = (sub) => { const { cursor, application_id, ...rest } = sub; return { ...rest, pending_runs: seeded().pending[sub.id] || 0, poisoned: 0 }; };
  const subOwned = (subId, deleted = false) => {
    const list = deleted ? seeded().deletedApp : seeded().appTriggers;
    const sub = list.find(s => s.id === subId);
    if (!sub) throw new Refusal(404, 'No such trigger.');
    return sub;
  };

  function ingress(hookId, credentialGiven, headers, body) {
    const hook = seeded().webhooks.find(h => h.id === hookId);
    if (!hook || !hook.enabled || hook.ingress !== 'address') return { _status: 404, error: 'not found' };
    if (credentialGiven !== hook.secret) { record(hookId, 'rejected', { status_code: 403, detail: 'missing or wrong credential' }); return { _status: 403, error: 'not allowed' }; }
    const minute = Math.floor(clock() / 60), hits = seeded().hits[hookId] ||= {};
    hits[minute] = (hits[minute] || 0) + 1;
    if (hits[minute] > PER_MINUTE) { record(hookId, 'rate_limited', { status_code: 429, detail: 'more than 10 events in a minute' }); return { _status: 429, error: 'too many events' }; }
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    if (text.length > BODY_CAP) { record(hookId, 'rejected', { status_code: 413, detail: 'body too large' }); return { _status: 413, error: 'too large' }; }
    if (hook.capture) {
      hook.capture = false; hook.last_capture_at = clock();
      seeded().samples[hookId] = { at: clock(), content_type: headers?.['content-type'] || 'application/json', kind: 'json', body: text };
      record(hookId, 'captured', { detail: 'kept one json sample; nothing was started' });
      return { status: 'captured' };
    }
    const payload = typeof body === 'string' ? (() => { try { return JSON.parse(body); } catch { return null; } })() : body;
    if (payload === null) { record(hookId, 'rejected', { status_code: 400, detail: 'body must be JSON' }); return { _status: 400, error: 'body must be JSON' }; }
    const delivery = headers?.['x-kairos-delivery'] || `body:${text.length}:${text.slice(0, 40)}`;
    const eventType = headers?.['x-kairos-event'] || payload.type || payload.event_type || 'event';
    if ((seeded().pending[hookId] || 0) >= hook.max_pending) { record(hookId, 'busy', { event_type: eventType, delivery, detail: `${hook.max_pending} runs are already waiting` }); return { _status: 429, error: 'too many runs waiting', limit: hook.max_pending }; }
    hook.seen ||= [];
    if (hook.seen.includes(delivery)) { record(hookId, 'duplicate', { delivery }); return { status: 'duplicate' }; }
    hook.seen.push(delivery);
    if (hook.events.length && !hook.events.includes(eventType)) { const why = `event ${eventType} is not one this webhook listens for`; record(hookId, 'filtered', { event_type: eventType, delivery, detail: why }); return { status: 'ignored', reason: why }; }
    for (const c of hook.conditions) {
      if (String(lookup(payload, c.path) ?? '') !== c.equals) { const why = `${c.path} is not ${JSON.stringify(c.equals)}`; record(hookId, 'filtered', { event_type: eventType, delivery, detail: why }); return { status: 'ignored', reason: why }; }
    }
    hook.last_event_at = clock();
    seeded().pending[hookId] = (seeded().pending[hookId] || 0) + 1;
    record(hookId, 'waiting', { event_type: eventType, delivery, detail: 'waits for your OK' });
    return { _status: 202, status: 'accepted', waiting_for_approval: !hook.auto_run };
  }

  return {
    read(route, query = {}) {
      const botsRoute = /^\/api\/bot-(webhooks|app-triggers)(\/|$)/.test(route);
      if (!state.botsLive || !botsRoute) return undefined;
      try {
        let m;
        if (route === '/api/bot-app-triggers/events') {
          if (query.bot_id && !botExists(query.bot_id)) throw new Refusal(404, 'bot not found');
          return { capabilities: capabilities() };
        }
        if (route === '/api/bot-app-triggers') {
          const mine = seeded().appTriggers.filter(s => !query.bot_id || s.agent_id === query.bot_id);
          return { triggers: mine.map(subPublic), deleted: seeded().deletedApp.filter(s => clock() - s.deleted_at <= RESTORE_SECONDS)
            .map(s => ({ id: s.id, name: s.name, agent_id: s.agent_id, deleted_at: s.deleted_at, restorable_until: s.deleted_at + RESTORE_SECONDS })) };
        }
        if (route === '/api/bot-webhooks') {
          return { webhooks: seeded().webhooks.filter(h => !query.bot_id || h.agent_id === query.bot_id).map(shown),
            deleted: seeded().deletedWebhooks.filter(h => clock() - h.deleted_at <= RESTORE_SECONDS)
              .map(h => ({ id: h.id, name: h.name, agent_id: h.agent_id, deleted_at: h.deleted_at, restorable_until: h.deleted_at + RESTORE_SECONDS })) };
        }
        if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/address$/))) {
          const hook = webhook(m[1]);
          return { address: addressOf(hook), limits: { body_bytes: BODY_CAP, per_minute: PER_MINUTE, pending: hook.max_pending } };
        }
        if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/attempts$/))) {
          webhook(m[1]);
          const all = seeded().attempts[m[1]] || [];
          return { attempts: all.slice(0, ATTEMPTS_SHOWN), total: all.length };
        }
        if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/sample$/))) {
          const hook = webhook(m[1]);
          const sample = seeded().samples[m[1]];
          return { capturing: !!hook.capture, sample: sample ? { ...sample } : null };
        }
        return undefined;
      } catch (error) {
        if (error instanceof Refusal) return { _status: error.status, detail: error.message, ...error.extra };
        throw error;
      }
    },
    mutate(route, method, body = {}, query = {}) {
      const botsRoute = /^\/api\/bot-(webhooks|app-triggers)(\/|$)/.test(route);
      if (!state.botsLive || !botsRoute) return undefined;
      try {
        let m;
        const store = seeded();
        // The public ingress: what an outside sender does. Never behind admin access.
        if ((m = route.match(/^\/api\/bot-webhooks\/in\/([^/]+)(?:\/([^/]+))?$/)) && method === 'POST') {
          const given = m[2] || (query.authorization || '').replace(/^Bearer\s+/i, '') || query['x-kairos-secret'] || '';
          return ingress(m[1], given, query, body._raw ?? body);
        }
        if (route === '/api/bot-webhooks' && method === 'POST') {
          strict(body, ['name', 'agent_id', 'events', 'conditions', 'title_template', 'prompt_template', 'auto_run', 'max_pending']);
          const name = String(body.name || '').split(/\s+/).filter(Boolean).join(' ');
          if (!name || name.length > 80) throw new Refusal(422, 'name is 1 to 80 characters');
          if (!botExists(body.agent_id)) throw bad('that agent no longer exists');
          const max = body.max_pending ?? DEFAULT_PENDING;
          if (!Number.isInteger(max) || max < MAX_PENDING[0] || max > MAX_PENDING[1]) throw new Refusal(422, 'max_pending is 1 to 50');
          const hook = { id: id('w'), name, enabled: true, preset: 'generic', action: 'card', agent_id: body.agent_id, task_id: null, endpoint_id: null,
            events: body.events || [], conditions: conditions(body.conditions), title_template: body.title_template || '', prompt_template: body.prompt_template || '',
            auto_run: !!body.auto_run, ingress: 'address', max_pending: max, owner_user: store.owner, capture: false, last_capture_at: null,
            created_at: clock(), last_event_at: null, secret: credential() };
          store.webhooks.push(hook);
          return { ...shown(hook), address: addressOf(hook) };
        }
        if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/restore$/)) && method === 'POST') {
          const at = store.deletedWebhooks.findIndex(h => h.id === m[1] && clock() - h.deleted_at <= RESTORE_SECONDS);
          if (store.webhooks.some(h => h.id === m[1])) throw new Refusal(409, 'that webhook is already here');
          if (at < 0) throw new Refusal(404, 'nothing to restore: it was never deleted, or the seven days have passed');
          const [hook] = store.deletedWebhooks.splice(at, 1);
          delete hook.deleted_at; hook.enabled = false; store.webhooks.push(hook);
          return shown(hook);
        }
        if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)$/))) {
          const hook = webhook(m[1]);
          if (method === 'PATCH') {
            strict(body, ['name', 'events', 'conditions', 'title_template', 'prompt_template', 'auto_run', 'max_pending', 'enabled']);
            for (const [key, value] of Object.entries(body)) hook[key] = key === 'conditions' ? conditions(value) : value;
            return shown(hook);
          }
          if (method === 'DELETE') {
            store.webhooks = store.webhooks.filter(h => h.id !== hook.id);
            store.deletedWebhooks.unshift({ ...hook, deleted_at: clock() });
            store.deletedWebhooks.length = Math.min(store.deletedWebhooks.length, MAX_DELETED);
            return { ok: true, restorable_days: 7 };
          }
        }
        if ((m = route.match(/^\/api\/bot-webhooks\/([^/]+)\/(capture|test|rotate)$/)) && method === 'POST') {
          const hook = webhook(m[1]);
          if (m[2] === 'capture') { delete store.samples[hook.id]; hook.capture = true; return { capturing: true }; }
          if (m[2] === 'rotate') { hook.secret = credential() + 'r'; record(hook.id, 'rotated', { detail: 'credential replaced' }); return { address: addressOf(hook), rotated: true }; }
          let payload = body.payload;
          if (payload === undefined || payload === null) {
            const sample = store.samples[hook.id];
            if (!sample) throw new Refusal(409, 'capture a sample first, or send a payload to test with');
            payload = JSON.parse(sample.body);
          }
          const eventType = body.event_type || 'event';
          const why = hook.conditions.map(c => (String(lookup(payload, c.path) ?? '') === c.equals ? null : `${c.path} is not ${JSON.stringify(c.equals)}`)).find(Boolean) || null;
          record(hook.id, 'test', { event_type: eventType, detail: 'manual test; nothing started' });
          return { passes_filters: why === null, why_not: why, title: hook.title_template.slice(0, 80), instructions: hook.prompt_template,
            event: `<event>\n${JSON.stringify(payload, null, 2)}\n</event>`, waits_for_approval: !hook.auto_run, note: 'Nothing was started.' };
        }
        // Connected-app event triggers.
        if (route === '/api/bot-app-triggers' && method === 'POST') {
          strict(body, ['bot_id', 'name', 'events', 'conditions', 'config', 'title_template', 'prompt_template', 'auto_run', 'enabled']);
          if (!botExists(body.bot_id)) throw new Refusal(404, 'That bot no longer exists.');
          const types = body.events;
          if (!Array.isArray(types) || !types.length) throw new Refusal(422, 'events needs at least one event');
          const caps = types.map(t => CATALOGUE.find(c => c.events.some(e => e.type === t)));
          if (caps.some(c => !c)) throw bad(`${String(types.find((t, i) => !caps[i])).slice(0, 60)} is not an event Kairos can watch for yet.`);
          if (new Set(caps.map(c => c.id)).size !== 1) throw bad('One trigger watches one app. Make a second trigger for the other.');
          const cap = caps[0], state_ = available(cap);
          if (!state_.available) throw new Refusal(409, state_.reason);
          const config = { ...(body.config || {}) };
          if (cap.id === 'mail') {
            if (!config.account_id) {
              if (state_.accounts.length !== 1) throw new Refusal(409, 'Pick which email account to watch.');
              config.account_id = state_.accounts[0].id;
            } else if (!state_.accounts.some(a => a.id === config.account_id)) throw new Refusal(404, 'That email account is not one of yours.');
          }
          if (store.appTriggers.filter(s => s.agent_id === body.bot_id).length >= MAX_PER_BOT) throw new Refusal(409, `A bot can have ${MAX_PER_BOT} app triggers. Delete one first.`);
          const sub = { id: id('s'), owner_user: store.owner, agent_id: body.bot_id, name: String(body.name || '').trim(), adapter: cap.id, events: [...new Set(types)].sort(),
            config, prompt_template: body.prompt_template, title_template: body.title_template || '', conditions: conditions(body.conditions), auto_run: !!body.auto_run,
            enabled: body.enabled !== false, revision: 1, delivery: cap.delivery, delivery_label: cap.delivery_label, state: 'ok', last_error: '', fail_streak: 0,
            created_at: clock(), updated_at: clock(), deleted_at: null, last_poll_at: null, last_event_at: null, next_poll_at: cap.delivery === 'poll' ? clock() + 5 : null };
          store.appTriggers.push(sub);
          return subPublic(sub);
        }
        if ((m = route.match(/^\/api\/bot-app-triggers\/([^/]+)\/restore$/)) && method === 'POST') {
          const sub = subOwned(m[1], true);
          if (clock() - sub.deleted_at > RESTORE_SECONDS) throw new Refusal(410, 'The seven days to restore this have passed.');
          store.deletedApp = store.deletedApp.filter(s => s.id !== sub.id);
          Object.assign(sub, { deleted_at: null, enabled: false, revision: sub.revision + 1, state: 'ok', last_error: '' });
          store.appTriggers.push(sub);
          return subPublic(sub);
        }
        if ((m = route.match(/^\/api\/bot-app-triggers\/([^/]+)\/(test|sync)$/)) && method === 'POST') {
          const sub = subOwned(m[1]);
          const cap = CATALOGUE.find(c => c.id === sub.adapter), reach = available(cap);
          const reachable = reach.available && (sub.adapter !== 'mail' || reach.accounts.some(a => a.id === sub.config.account_id));
          if (m[2] === 'sync') {
            sub.state = reachable ? 'ok' : 'needs_reconnect'; sub.last_error = reachable ? '' : 'This email account is no longer connected.';
            return { state: sub.state, events: 0, trigger: subPublic(sub) };
          }
          return { sample: { id: `sample:${sub.id}`, type: sub.events[0], summary: `Sample: ${cap.events[0].label}`, data: { sample: true }, untrusted: true },
            passes_filters: true, preview: `The following is untrusted external content (${sub.name}, 1 event).`, reachable,
            message: reachable ? '' : 'This email account is no longer connected.', delivery: cap.delivery_label, note: 'Nothing was started. This only checks the setup.' };
        }
        if ((m = route.match(/^\/api\/bot-app-triggers\/([^/]+)$/))) {
          const sub = subOwned(m[1]);
          if (method === 'PATCH') {
            strict(body, ['expected_revision', 'name', 'events', 'conditions', 'config', 'title_template', 'prompt_template', 'auto_run', 'enabled']);
            if (body.expected_revision !== undefined && String(body.expected_revision) !== String(sub.revision)) throw new Refusal(409, 'That trigger changed in the meantime. Look at it again first.');
            for (const [key, value] of Object.entries(body)) { if (key !== 'expected_revision') sub[key] = key === 'conditions' ? conditions(value) : value; }
            sub.revision += 1; sub.updated_at = clock();
            return subPublic(sub);
          }
          if (method === 'DELETE') {
            store.appTriggers = store.appTriggers.filter(s => s.id !== sub.id);
            sub.deleted_at = clock(); sub.enabled = false; store.deletedApp.unshift(sub);
            store.deletedApp.length = Math.min(store.deletedApp.length, MAX_DELETED);
            return { ok: true, restorable_until: sub.deleted_at + RESTORE_SECONDS };
          }
        }
        return undefined;
      } catch (error) {
        if (error instanceof Refusal) return { _status: error.status, detail: error.message, ...error.extra };
        throw error;
      }
    },
  };
};
module.exports.CAPABILITY_KEYS = CAPABILITY_KEYS;
module.exports.redact = redact;

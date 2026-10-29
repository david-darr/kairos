// Fixture lane for bot usage and spend (Bots Phase 6, unit U3). While demoState.botsLive is set it answers
// /api/bot-usage/* in the real server's shapes (routes/bot_usage_routes.py, services/bot_usage.py): an empty month
// unless a check seeds state.botsUsage.runs, a budget with no cap, the price table, no plan windows, and the
// housekeeping defaults. Saves change the lane's own state and are logged in state.botsUsage.writes.
module.exports = ({ state }) => {
  class Refusal extends Error { constructor(status, message) { super(message); this.status = status; } }
  const lane = () => (state.botsUsage ||= {
    runs: [], budget: { monthly_usd: null, warn_percent: 80 }, prices_override: {},
    housekeeping: { event_retention_days: 30, event_size_cap_mb: 64 }, plan: { providers: [] }, writes: [],
  });
  const totals = rows => {
    const known = rows.filter(r => r.cost_usd !== null && r.cost_usd !== undefined);
    return { runs: rows.length, duration_s: rows.reduce((n, r) => n + (r.duration_s || 0), 0),
      cost_usd: known.length ? known.reduce((n, r) => n + r.cost_usd, 0) : null, unknown_cost_runs: rows.length - known.length,
      tokens: rows.reduce((n, r) => n + (r.tokens || 0), 0), steps: rows.reduce((n, r) => n + (r.steps || 0), 0),
      tools: rows.reduce((n, r) => n + (r.tools || 0), 0), errors: rows.reduce((n, r) => n + (r.errors || 0), 0) };
  };
  const pick = query => lane().runs.filter(r => !query.bot_id || r.bot_id === query.bot_id);
  const spent = () => totals(lane().runs).cost_usd || 0;

  function read(route, query = {}) {
    const s = lane();
    if (route === '/api/bot-usage/summary') {
      const groupBy = query.group_by || 'bot', groups = {};
      for (const row of pick(query)) (groups[row[{ bot: 'bot_id', endpoint: 'endpoint_id', routine: 'routine_id' }[groupBy] || groupBy] || 'Unknown'] ||= []).push(row);
      return { totals: totals(pick(query)), groups: Object.entries(groups).map(([key, rows]) => ({ key, ...totals(rows) })),
        group_by: groupBy, cost_note: 'List-price equivalent, not billed' };
    }
    if (route === '/api/bot-usage/runs') {
      const offset = Number(query.offset || 0), limit = Number(query.limit || 50), rows = pick(query);
      return { rows: rows.slice(offset, offset + limit), total: rows.length };
    }
    if (route === '/api/bot-usage/budget') {
      const cap = s.budget.monthly_usd;
      return { ...s.budget, spent_usd: spent(), capped: cap !== null && spent() >= cap, near_cap: cap !== null && spent() >= cap * s.budget.warn_percent / 100 };
    }
    if (route === '/api/bot-usage/prices') return { as_of: '2026-10-01', prices: {}, prices_override: s.prices_override };
    if (route === '/api/bot-usage/plan') return s.plan;
    if (route === '/api/bot-usage/housekeeping') return { ...s.housekeeping };
    if (route === '/api/bot-usage/traces') return { rows: [], total: 0 };
    return undefined;
  }

  function mutate(route, method, body = {}) {
    const s = lane();
    if (method !== 'PUT') return undefined;
    if (route === '/api/bot-usage/budget') {
      if (body.monthly_usd !== null && !(Number.isFinite(body.monthly_usd) && body.monthly_usd >= 0)) throw new Refusal(422, 'Enter a cap of 0 or more.');
      s.budget = { monthly_usd: body.monthly_usd, warn_percent: body.warn_percent ?? s.budget.warn_percent };
    } else if (route === '/api/bot-usage/prices') {
      if (!body.prices_override || typeof body.prices_override !== 'object') throw new Refusal(422, 'Prices must be an object.');
      s.prices_override = body.prices_override;
    } else if (route === '/api/bot-usage/housekeeping') {
      const days = body.event_retention_days, size = body.event_size_cap_mb;
      if (!(days >= 1 && days <= 3650) || !(size >= 0.25 && size <= 4096)) throw new Refusal(422, 'Out of range.');
      s.housekeeping = { event_retention_days: days, event_size_cap_mb: size };
    } else return undefined;
    s.writes.push({ route, body });
    return read(route);
  }

  return {
    read(route, query = {}) {
      if (!state.botsLive || !route.startsWith('/api/bot-usage/')) return undefined;
      try { return read(route, query); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
    mutate(route, method, body = {}) {
      if (!state.botsLive || !route.startsWith('/api/bot-usage/')) return undefined;
      try { return mutate(route, method, body || {}); }
      catch (error) { if (error instanceof Refusal) return { _status: error.status, detail: error.message }; throw error; }
    },
  };
};

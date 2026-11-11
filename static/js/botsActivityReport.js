// A bot's report and its team's (David, 2026-11-11: "an easier way to see individual Bot's reports").
// Data: GET /api/bot-reports/bots/{id} and /api/bot-reports/teams/{id} (services/bot_activity_report.py), and the
// team's Suggest models proposal, GET and POST /api/bot-departments/{id}/models (services/bot_model_tiers.py).
// Opened from a bot's card on the team map, its Usage section, a team's menu, and Studio > Content's team panel.
// Styled by static/css/bots-report.css with the Bots tokens only. The dialog carries data-app-mode="bots" itself,
// so it looks the same when Studio opens it.
//
// The first half is plain functions with no DOM, so scripts/test_bots_activity_report.cjs can load this file in Node.

export const WINDOWS = [7, 30];

export function plural(count, word, many = `${word}s`) { return `${count} ${count === 1 ? word : many}`; }

export function tokensText(tokens) {
  const n = Number(tokens) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tokens`;
  return plural(n, 'token');
}

export function spendText(usd, complete = true) {
  if (usd === null || usd === undefined) return 'Spend not priced';
  const value = Number(usd);
  const shown = value < 0.01 && value > 0 ? 'under $0.01' : `$${value.toFixed(2)}`;
  return complete ? shown : `${shown} or more`;
}

export function clock(seconds) {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function runRange(run) {
  const start = clock(run.started_at);
  if (!run.ended_at) return start;
  const secs = Math.max(0, Math.round(run.ended_at - run.started_at));
  const long = secs >= 3600 ? `${Math.round(secs / 360) / 10} h` : secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs} s`;
  return `${start}, took ${long}`;
}

// "Asked you 3 times: 2 allowed, 1 denied. 12 steps went ahead as the team's own work."
export function approvalsLine(summary = {}) {
  const parts = [];
  if (summary.asked) {
    const answers = [summary.allowed ? `${summary.allowed} allowed` : '', summary.denied ? `${summary.denied} denied` : '',
      summary.expired ? `${summary.expired} not answered in time` : ''].filter(Boolean).join(', ');
    parts.push(`Asked you ${plural(summary.asked, 'time')}${answers ? `: ${answers}` : ''}.`);
  } else parts.push('Did not need to ask you.');
  if (summary.team) parts.push(`${plural(summary.team, 'step')} went ahead as the team's own work.`);
  if (summary.could_not_ask) parts.push(`${plural(summary.could_not_ask, 'step')} did not run because nobody was there to ask.`);
  return parts.join(' ');
}

export function totalsLine(totals = {}) {
  const runs = `${plural(totals.runs || 0, 'run')}${totals.failed ? `, ${totals.failed} failed` : ''}`;
  return [runs, tokensText(totals.tokens), spendText(totals.cost_usd, totals.cost_complete !== false)].join(' · ');
}

// The import preview and Suggest models both show a relative cost line, recomputed as picks change.
export const WEIGHT = { light: 1, standard: 4, strong: 15 };
export function optionTier(option) {
  if (!option) return null;
  if (WEIGHT[option.tier]) return option.tier;
  return { low: 'light', medium: 'standard', high: 'strong', xhigh: 'strong' }[option.model_effort] || 'standard';
}
export function costLine(tiers) {
  const known = tiers.filter(t => WEIGHT[t]);
  if (!known.length) return '';
  const percent = Math.max(1, Math.round(100 * known.reduce((sum, t) => sum + WEIGHT[t], 0) / (known.length * WEIGHT.strong)));
  return percent >= 100 ? 'Estimated cost: the same as every bot on a strong model.'
    : `Estimated cost: about ${percent}% of running every bot on a strong model. An estimate, not a quote.`;
}

// -- The dialog ------------------------------------------------------------------------------------------------

async function ui() {
  const [kit, api] = await Promise.all([import('./botsUi.js'), import('./api.js')]);
  await Promise.all([kit.loadBotsCss('/static/css/bots.css'), kit.loadBotsCss('/static/css/bots-report.css')]);
  return { ...kit, api: api.api };
}

function surface(kit, title) {
  const { h, IconButton } = kit;
  const opener = document.activeElement;
  const body = h('div', { class: 'bots-report-body' });
  const dialog = h('dialog', { class: 'bots-report-dialog', 'aria-label': title });
  const scope = h('div', { 'data-app-mode': 'bots', class: 'bots-report-scope' }, [dialog]);
  const close = () => { dialog.close(); scope.remove(); if (opener?.isConnected) opener.focus(); };
  const heading = h('h2', { text: title });
  dialog.append(h('header', { class: 'bots-report-head' }, [heading, IconButton({ label: 'Close', iconName: 'x', onClick: close })]), body);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const b = dialog.getBoundingClientRect();
    if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) close();
  });
  document.body.append(scope);
  dialog.showModal();
  return { dialog, body, heading, close };
}

const navigate = target => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: target }));
const errorText = error => String(error?.message || error || 'This could not load.').replace(/^\d+:\s*/, '');

function windowPicker(kit, days, onPick) {
  const { h } = kit;
  const select = h('select', { 'aria-label': 'Report window', class: 'bots-report-window' },
    WINDOWS.map(n => h('option', { value: String(n), text: `Last ${n} days`, selected: n === days || undefined })));
  select.addEventListener('change', () => onPick(Number(select.value)));
  return select;
}

function producedList(kit, produced) {
  const { h } = kit;
  if (!produced?.length) return h('p', { class: 'bots-report-quiet', text: 'Nothing recorded in this window.' });
  return h('ul', { class: 'bots-report-made' }, produced.map(item => h('li', {}, [
    h('strong', { text: `${item.label}: ${item.count}` }),
    item.items?.length ? h('span', { class: 'bots-report-quiet', text: ` ${item.items.join(', ')}` }) : null,
  ])));
}

function openLink(kit, link, close) {
  if (!link?.agentId) return null;
  return kit.Button({ label: link.sessionId ? 'Open conversation' : 'Open bot', iconName: 'message-square', onClick: () => {
    close(); navigate({ tab: 'botsShell', agentId: link.agentId, ...(link.sessionId ? { sessionId: link.sessionId } : {}) });
  } });
}

function runItem(kit, run, close) {
  const { h } = kit;
  const steps = run.steps?.length ? h('ol', { class: 'bots-report-steps' }, run.steps.map(text => h('li', { text })))
    : h('p', { class: 'bots-report-quiet', text: run.tool_calls ? 'Its steps were not kept.' : 'It answered without using tools.' });
  const failed = (run.failed_steps || []).map(step => h('p', { class: 'bots-report-error', text: `${step.step}: ${step.detail}` }));
  return h('details', { class: 'bots-report-run', 'data-outcome': run.outcome || '' }, [
    h('summary', {}, [
      h('span', { class: 'bots-report-badge', 'data-outcome': run.outcome || '', text: run.result || 'Running' }),
      h('span', { class: 'bots-report-run-what', text: run.what }),
      h('span', { class: 'bots-report-quiet', text: runRange(run) }),
    ]),
    steps, ...failed,
    run.truncated ? h('p', { class: 'bots-report-quiet', text: 'Some steps were left out of the record.' }) : null,
    h('div', { class: 'bots-report-actions' }, [
      h('span', { class: 'bots-report-quiet', text: [tokensText(run.tokens), run.cost_usd != null ? spendText(run.cost_usd) : '', run.model || ''].filter(Boolean).join(' · ') }),
      openLink(kit, run.link, close),
    ]),
  ]);
}

function section(kit, title, children) {
  const { h } = kit;
  return h('section', { class: 'bots-report-section', 'aria-label': title }, [h('h3', { text: title }), ...children]);
}

function renderBot(kit, data, close) {
  const { h } = kit;
  const approvals = data.approvals || {};
  return [
    h('p', { class: 'bots-report-sub', text: [data.bot.role, data.bot.team ? `Team: ${data.bot.team}` : ''].filter(Boolean).join(' · ') }),
    h('p', { class: 'bots-report-totals', role: 'status', text: totalsLine(data.totals) }),
    section(kit, 'What it made', [producedList(kit, data.produced)]),
    section(kit, 'Recent runs', data.runs?.length ? data.runs.map(run => runItem(kit, run, close))
      : [h('p', { class: 'bots-report-quiet', text: 'No runs in this window.' })]),
    section(kit, 'Approvals', [h('p', { text: approvalsLine(approvals.summary) }),
      approvals.recent?.length ? h('ul', { class: 'bots-report-list' }, approvals.recent.map(row => h('li', {}, [
        h('span', { class: 'bots-report-quiet', text: `${clock(row.at)} ` }), h('span', { text: row.text })]))) : null]),
    section(kit, 'Errors and fixes', data.errors?.length ? data.errors.map(err => h('div', { class: 'bots-report-fix' }, [
      h('p', { class: 'bots-report-error', text: `${err.at ? `${clock(err.at)}: ` : ''}${err.what}` }),
      h('p', { text: `Fix: ${err.fix}` }), openLink(kit, err.link, close)])) : [h('p', { class: 'bots-report-quiet', text: 'No errors in this window.' })]),
  ];
}

function renderTeam(kit, data, close) {
  const { h, Button } = kit;
  const totals = data.totals || {};
  const members = (data.members || []).map(m => h('article', { class: 'bots-report-member', 'data-bot-id': m.bot_id }, [
    h('div', { class: 'bots-report-member-head' }, [h('strong', { text: m.name }), m.tier ? h('span', { class: 'bots-report-badge', text: m.tier }) : null]),
    h('p', { class: 'bots-report-quiet', text: m.role }),
    h('p', { text: `${plural(m.runs, 'run')}${m.failed ? `, ${m.failed} failed` : ''} · ${tokensText(m.tokens)} · ${spendText(m.cost_usd)}` }),
    h('p', { text: m.last ? `Last: ${m.last.what}, ${m.last.result.toLowerCase()} ${clock(m.last.ended_at)}` : 'No runs in this window.' }),
    h('p', { class: 'bots-report-quiet', text: `Asked you ${plural(m.asked, 'time')}. ${m.team_allowed} team steps went ahead.${m.could_not_ask ? ` ${m.could_not_ask} could not ask.` : ''}` }),
    Button({ label: 'Open report', onClick: () => { close(); openBotReport({ botId: m.bot_id }); } }),
  ]));
  return [
    h('p', { class: 'bots-report-totals', role: 'status', text: `${totalsLine(totals)} · Asked you ${plural(totals.asked || 0, 'time')}` }),
    section(kit, 'What the team made', [producedList(kit, data.produced)]),
    section(kit, 'Bots', [h('div', { class: 'bots-report-members' }, members)]),
  ];
}

async function openReport({ title, path, render, days = 7 }) {
  const kit = await ui();
  const view = surface(kit, title);
  let current = days;
  async function load() {
    view.body.replaceChildren(kit.h('p', { role: 'status', text: 'Loading the report...' }));
    try {
      const data = await kit.api(`${path}?days=${current}`, { toast: false });
      if (!view.dialog.isConnected) return;
      const head = kit.h('div', { class: 'bots-report-toolbar' }, [windowPicker(kit, current, n => { current = n; load(); }),
        kit.Button({ label: 'Refresh', iconName: 'refresh-cw', onClick: load })]);
      if (data.bot) view.heading.textContent = `${data.bot.name}: report`;
      if (data.team) view.heading.textContent = `${data.team.name} team: report`;
      view.body.replaceChildren(head, ...render(kit, data, view.close));
    } catch (error) {
      view.body.replaceChildren(kit.h('p', { role: 'alert', text: `The report could not load. ${errorText(error)}` }), kit.Button({ label: 'Try again', onClick: load }));
    }
  }
  await load();
  return view;
}

export const openBotReport = ({ botId, days } = {}) => openReport({ title: 'Report', path: `/api/bot-reports/bots/${encodeURIComponent(botId)}`, render: renderBot, days });
export const openTeamReport = ({ teamId, days } = {}) => openReport({ title: 'Team report', path: `/api/bot-reports/teams/${encodeURIComponent(teamId)}`, render: renderTeam, days });

// Pause team / Resume team (the kill switch): the team's bots may only read until resumed, and for the Content
// Studio team nothing is posted (services/content_studio/handsoff.py).
export async function setTeamPaused(teamId, paused) {
  const { api } = await import('./api.js');
  await api(`/api/bot-departments/${encodeURIComponent(teamId)}/flags`, { method: 'PUT', body: JSON.stringify({ paused }), toast: false });
  document.dispatchEvent(new CustomEvent('jarvis:agents-changed', { detail: { source: 'teams' } }));
}

// Suggest models: the team's tier map as models from the connections this account has. Applies only on a click.
export async function openSuggestModels({ teamId } = {}) {
  const kit = await ui();
  const { h, Button } = kit;
  const view = surface(kit, 'Suggest models');
  const path = `/api/bot-departments/${encodeURIComponent(teamId)}/models`;
  async function load(note = '') {
    view.body.replaceChildren(h('p', { role: 'status', text: 'Working out models...' }));
    try {
      paint(await kit.api(path, { toast: false }), note);
    } catch (error) {
      view.body.replaceChildren(h('p', { role: 'alert', text: `Models could not load. ${errorText(error)}` }), Button({ label: 'Try again', onClick: () => load() }));
    }
  }
  function paint(data, note) {
    const byValue = Object.fromEntries((data.options || []).map(o => [o.value, o]));
    const picks = new Map();
    const cost = h('p', { class: 'bots-report-totals', role: 'status' });
    const recost = () => { cost.textContent = costLine([...picks.values()].map(v => optionTier(byValue[v])).filter(Boolean)) || data.cost || ''; };
    const rows = (data.rows || []).map(row => {
      const select = h('select', { 'aria-label': `Model for ${row.name}`, disabled: !row.value || undefined },
        [h('option', { value: '', text: 'Keep its model' }), ...(data.options || []).map(o => h('option', { value: o.value, text: o.label, selected: o.value === row.value || undefined }))]);
      if (row.value && !row.same) picks.set(row.bot_id, row.value);
      if (row.same) select.value = '';
      select.addEventListener('change', () => { if (select.value) picks.set(row.bot_id, select.value); else picks.delete(row.bot_id); recost(); });
      return h('div', { class: 'bots-report-model-row' }, [
        h('div', {}, [h('strong', { text: row.name }), h('span', { class: 'bots-report-quiet', text: ` ${row.role}` })]),
        h('p', { text: `${row.tier_label}. Now: ${row.current}.${row.same ? ' Already matches.' : ''}` }),
        select, row.note ? h('p', { class: 'bots-report-quiet', text: row.note }) : null]);
    });
    const status = h('p', { role: 'status', text: note });
    const apply = Button({ label: 'Apply these models', variant: 'primary', onClick: async () => {
      if (!picks.size) { status.textContent = 'Nothing to change.'; return; }
      apply.disabled = true; status.textContent = 'Applying...';
      const models = Object.fromEntries([...picks.entries()].map(([id, value]) => {
        const [endpoint_id, model_override, model_effort] = value.split('|');
        return [id, { endpoint_id, model_override: model_override || null, model_effort: model_effort || null }];
      }));
      try {
        const result = await kit.api(path, { method: 'POST', body: JSON.stringify({ models }), toast: false });
        document.dispatchEvent(new CustomEvent('jarvis:agents-changed', { detail: { source: 'teams' } }));
        load(`Updated ${plural(result.changed?.length || 0, 'bot')}.`);
      } catch (error) { status.textContent = errorText(error); apply.disabled = false; }
    } });
    recost();
    view.body.replaceChildren(h('p', { text: 'Each bot gets a model sized to its role, from the models you have connected. Nothing changes until you apply.' }),
      ...rows, cost, h('div', { class: 'bots-report-actions' }, [apply]), status);
  }
  await load();
  return view;
}

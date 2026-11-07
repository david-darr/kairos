// A model's measured speed and reliability in words (Session Usage and Model Tracking, unit 3, 2026-11-07),
// from GET /api/models/stats or the `stats` each model carries in /api/models/quotas: this account's own runs
// over the last 7 days. Shown in Settings > Added Models and on Home's model card. Under five runs it says
// "not enough data" rather than a figure; what a provider does not report is named, never shown as zero.

export const ERROR_WORDS = { rate_limit: 'rate limit', overload: 'overloaded', overflow: 'context full', auth: 'sign-in or key',
  network: 'network', other: 'other error' };

function seconds(s) { return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`; }

// "1 failed of 24 (rate limit)", "none failed of 24".
export function reliabilityText(stat) {
  if (!stat?.runs) return '';
  if (!stat.failed) return `none failed of ${stat.runs}`;
  const top = Object.entries(stat.failures_by_class || {}).sort((a, b) => b[1] - a[1])[0];
  return `${stat.failed} failed of ${stat.runs}${top ? ` (mostly ${ERROR_WORDS[top[0]] || top[0]})` : ''}`;
}

// The one-line summary, or '' when the model has no runs in the window.
export function speedLine(stat, days = 7) {
  if (!stat || !stat.runs) return '';
  if (!stat.enough_data) return `Not enough data yet: ${stat.runs} run${stat.runs === 1 ? '' : 's'} in the last ${days} days`;
  const parts = [];
  if (Number.isFinite(stat.ttft_median_s)) parts.push(`first output ${seconds(stat.ttft_median_s)}` + (Number.isFinite(stat.ttft_p90_s) ? ` (p90 ${seconds(stat.ttft_p90_s)})` : ''));
  if (Number.isFinite(stat.tokens_per_second_median)) parts.push(`${Math.round(stat.tokens_per_second_median)} tok/s`);
  parts.push(reliabilityText(stat));
  if (stat.stopped) parts.push(`${stat.stopped} stopped`);
  if (stat.cost && Number.isFinite(stat.cost.total_usd)) parts.push(costText(stat.cost));
  return `Last ${days} days: ${parts.join(' · ')}`;
}

// The longer note for a tooltip: where the figures come from and what this provider does not report.
export function statsTitle(stat, days = 7) {
  if (!stat) return '';
  const lines = [`Measured from this account's runs over the last ${days} days. Medians need at least 5 runs.`];
  if (stat.tool_quality) {
    const q = stat.tool_quality;
    const broken = (q.invalid_json || 0) + (q.unknown_tool || 0) + (q.missing_arguments || 0);
    const total = Object.values(q).reduce((a, b) => a + b, 0);
    lines.push(`Tool calls: ${total - broken} of ${total} well formed${q.repaired ? `, ${q.repaired} repaired` : ''}.`);
  }
  if (Number.isFinite(stat.retries) && stat.retries) lines.push(`Kairos retried on a backup model ${stat.retries} time${stat.retries === 1 ? '' : 's'}.`);
  if (stat.cost) lines.push(`Cost: ${costText(stat.cost)}. ${costSource(stat.cost)}`.trim());
  for (const missing of stat.not_reported || []) lines.push(`Not reported: ${missing}.`);
  return lines.join('\n');
}

// Cost in words (unit 4): "$0.0123 estimated", "included (subscription or local)", "unknown"; never "$0" for
// unknown. Sub-cent amounts keep 4 decimals. `cost` is a summary from core/run_cost.py summarize.
export function formatUsd(value) {
  if (!Number.isFinite(value)) return 'unknown';
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function costText(cost) {
  if (!cost || !cost.statuses) return 'unknown';
  const s = cost.statuses;
  const priced = (s.estimated || 0) + (s.actual || 0);
  const runs = Object.values(s).reduce((a, b) => a + b, 0);
  if (!priced) return s.included && s.included === runs ? 'included (subscription or local)' : 'unknown';
  const kind = s.actual && !s.estimated ? 'reported' : 'estimated';
  const rest = runs - priced;
  const restWord = s.included === rest ? 'included' : 'not priced';
  return `${formatUsd(cost.total_usd)} ${kind}` + (rest ? `, ${rest} run${rest === 1 ? '' : 's'} ${restWord}` : '');
}

export function costSource(cost) {
  return cost?.sources?.length ? `Priced from: ${cost.sources.join('; ')}.` : '';
}

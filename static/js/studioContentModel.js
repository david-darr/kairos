// Pure logic for the Content section of Studio (no DOM): pipeline columns, ages, channel status, score text,
// decision numbers and the metrics CSV mapping. studioContent.js draws it; scripts/test_studio_content_model.cjs checks it.

export const OWNERS = { producer: 'Producer', researcher: 'Researcher', evaluator: 'Evaluator', script_writer: 'Script Writer',
  editor: 'Editor', publisher: 'Publisher', executor: 'Executor', user: 'You' };
export const PLATFORMS = [['youtube', 'YouTube'], ['tiktok', 'TikTok'], ['instagram', 'Instagram']];
export const platformName = id => PLATFORMS.find(p => p[0] === id)?.[1] || id || '';
export const ownerName = id => OWNERS[id] || id || '';

// The six steps from the spec, in order. Rejected posts get a seventh column only when there are some.
export const COLUMNS = [
  { id: 'topic', title: 'Topic', steps: ['pick'] },
  { id: 'scripting', title: 'Scripting', steps: ['script'] },
  { id: 'rendering', title: 'Rendering', steps: ['render', 'queue'] },
  { id: 'approval', title: 'Awaiting approval', steps: ['approval'] },
  { id: 'approved', title: 'Approved', steps: ['publish'] },
  { id: 'posted', title: 'Posted', steps: ['tracking'] },
];
const REJECTED = { id: 'rejected', title: 'Rejected', steps: ['rejected'] };

export function boardColumns(items) {
  const columns = COLUMNS.map(c => ({ ...c, items: [] }));
  const rejected = { ...REJECTED, items: [] };
  for (const item of items || []) {
    const column = [...columns, rejected].find(c => c.steps.includes(item.step));
    if (column) column.items.push(item);
  }
  for (const c of [...columns, rejected]) c.items.sort((a, b) => (b.age_h || 0) - (a.age_h || 0));
  return rejected.items.length ? [...columns, rejected] : columns;
}

export function formatAge(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) return '';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function cardFlags(item) {
  const flags = [];
  if (item.status === 'failed') flags.push(['Render failed', 'error']);
  else if (item.overdue) flags.push(['Overdue', 'warn']);
  if (item.rejection_count >= 2 && item.state !== 'posted') flags.push([`Rejected ${item.rejection_count} times`, 'warn']);
  return flags;
}

export function overdueText(item) {
  if (!item.overdue) return '';
  const window = item.window_h;
  return `${formatAge(item.in_step_h)} in this step${window ? `, expected within ${formatAge(window)}` : ''}.`;
}

// A channel's status pill: paused (a platform warning), archived or live.
export function channelState(channel) {
  if (channel.status === 'archived') return { label: 'Archived', tone: 'muted' };
  if (channel.paused) return { label: 'Paused', tone: 'error' };
  return { label: 'Live', tone: 'ok' };
}

// The watch names each open platform warning in its message: "<Platform> warned <handle>: <text> The channel is paused."
export function warningFor(channelId, findings) {
  const found = (findings || []).find(f => f.kind === 'platform_warning' && f.channel_id === channelId);
  if (!found) return '';
  return String(found.message || '').replace(/\s*The channel is paused\.$/, '');
}

export function urgentFindings(findings) {
  return (findings || []).filter(f => f.severity === 'urgent' && f.kind !== 'platform_warning');
}

// The user's channels grouped by niche, live niches first. A niche with no channels still shows, so it can be filled.
export function groupChannels(niches, channels) {
  const rank = n => (n.status === 'live' ? 0 : 1);
  return [...(niches || [])].sort((a, b) => rank(a) - rank(b) || a.id - b.id)
    .map(niche => ({ niche, channels: (channels || []).filter(c => c.niche_id === niche.id) }));
}

export function aiLabel(platform) {
  return platform === 'youtube' || platform === 'tiktok'
    ? { required: true, text: `${platformName(platform)} needs the AI-content label. Prepare post turns it on.` }
    : { required: false, text: `${platformName(platform)} does not require one here; Prepare post turns on its AI label anyway.` };
}

// A render reference is a link, a Studio video id, or free text from the Editor.
export function renderLink(ref) {
  const text = String(ref || '').trim();
  if (!text) return null;
  if (/^[a-f0-9]{12}$/.test(text)) return { href: `#/studio/${text}`, label: 'Open in Studio', external: false };
  if (/^https?:\/\/\S+$/i.test(text)) return { href: text, label: 'Open render', external: true };
  if (/^\/(?!\/)\S*$/.test(text)) return { href: text, label: 'Open render', external: false };
  return { href: '', label: text, external: false };
}

// -- scoreboard ---------------------------------------------------------------------------------

export function scoreText(row) {
  return row.eligible && row.score != null ? row.score.toFixed(1) : '';
}

// Rows that have enough data first, best first; the rest keep their order under them.
export function rankRows(rows) {
  const enough = rows.filter(r => r.eligible && r.score != null).sort((a, b) => b.score - a.score);
  return [...enough, ...rows.filter(r => !(r.eligible && r.score != null))];
}

export function minimumText(minimum) {
  return `Judged after ${minimum.weeks} weeks and ${minimum.posts} posts.`;
}

export function weightsText(weights) {
  const pct = v => Math.round((v / Object.values(weights).reduce((a, b) => a + b, 0)) * 100);
  return `Score out of 100: views ${pct(weights.views)}, watch time ${pct(weights.watch)}, follows and engagement ${pct(weights.engagement)}. Each part is ranked within its platform.`;
}

const ROLE_TITLES = { script_writer: 'Script Writer strategies', evaluator: 'Evaluator strategies' };
export const roleTitle = role => ROLE_TITLES[role] || role;

// -- decisions ------------------------------------------------------------------------------------

export const DECISION_WORDS = { retire: 'Retire', promote: 'Promote', replace: 'Replace', add: 'Add' };
export function decisionTitle(d) {
  const noun = ({ channel: 'channel', strategy: 'strategy', format: 'format' })[d.subject_type] || 'niche';
  return `${DECISION_WORDS[d.kind] || d.kind} ${noun} ${d.subject_name}`.trim();
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : null);
export function decisionNumbers(d) {
  const n = d.numbers || {};
  const bits = [];
  if (num(n.score) != null) bits.push(`score ${num(n.score)}`);
  if (num(n.team_median) != null) bits.push(`team median ${num(n.team_median)}`);
  if (n.winner && num(n.winner.score) != null) bits.push(`${n.winner.name || 'winner'} ${num(n.winner.score)}`);
  if (num(n.posts_scored) != null) bits.push(`${num(n.posts_scored)} posts scored`);
  if (num(n.age_days) != null) bits.push(`${Math.round(n.age_days)} days of data`);
  if (num(n.freed_slots) != null) bits.push(`${num(n.freed_slots)} slot${n.freed_slots === 1 ? '' : 's'} freed`);
  if (num(n.slots_after) != null) bits.push(`${num(n.slots_after)} slots after`);
  if (n.niche) bits.push(`niche ${n.niche}`);
  if (num(n.live_niches) != null && num(n.cap) != null) bits.push(`${num(n.live_niches)} of ${num(n.cap)} niches live`);
  return bits.join(', ');
}

// A proposed new niche carries the Researcher's evidence: where it saw it and what is rising.
export function decisionEvidence(d) {
  const p = d.payload || {};
  if (d.kind !== 'add' || !p.source) return '';
  return `Source: ${p.source}${p.signal ? `. Signal: ${p.signal}` : ''}.`;
}

export function decisionStatus(d) {
  return ({ proposed: ['With the Producer', 'accent'], awaiting_user: ['Needs you', 'warn'], confirmed: ['Confirmed', 'ok'],
    rejected: ['Rejected', 'muted'], open: ['Open', 'accent'] })[d.status] || [d.status, 'muted'];
}

// Split decisions into what waits for the user, what waits for the Producer, and what is done.
export function sortDecisions(decisions) {
  const list = [...(decisions || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
  return {
    awaiting: list.filter(d => d.status === 'awaiting_user'),
    producer: list.filter(d => d.status === 'proposed'),
    recent: list.filter(d => ['confirmed', 'rejected', 'open'].includes(d.status)),
  };
}

// -- channels, YouTube and team settings ----------------------------------------------------------

export const ASPECTS = [['', 'Platform default (9:16)'], ['9:16', '9:16 tall'], ['16:9', '16:9 wide'], ['1:1', '1:1 square']];

export function channelLookText(channel, packs) {
  const bits = [];
  if (channel.style_pack) bits.push(`style ${packName(channel.style_pack, packs)}`);
  if (channel.renderer) bits.push(`3D in ${channel.renderer === 'blender' ? 'Blender' : 'three.js'}`);
  if (channel.look) bits.push(`look ${channel.look}`);
  if (channel.aspect) bits.push(channel.aspect);
  if (channel.notes) bits.push('voice notes set');
  if (channel.made_for_kids === 1 || channel.made_for_kids === 0) bits.push(channel.made_for_kids ? 'made for kids' : 'not made for kids');
  return bits.length ? bits.join(', ') : 'No look set';
}
// Made for kids (YouTube's audience setting): a channel's or post's answer, "yes", "no" or "" (not set; a post then uses its
// channel's). Stored as 1, 0 or null.
export const KIDS_OPTIONS = [['', 'Not set'], ['no', 'No, not made for kids'], ['yes', 'Yes, made for kids']];
export const POST_KIDS_OPTIONS = [['', 'The channel\'s answer'], ['no', 'No, not made for kids'], ['yes', 'Yes, made for kids']];
export const kidsValue = stored => stored === 1 ? 'yes' : stored === 0 ? 'no' : '';
export function kidsText(stored) {
  return stored === 1 ? 'Yes, made for kids (this post\'s setting).' : stored === 0 ? 'No, not made for kids (this post\'s setting).' : '';
}

const shortDate = seconds => new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function connectionState(status) {
  if (!status) return ['Unavailable', 'muted'];
  if (status.needs_reconnect) return ['Reconnect', 'error'];
  if (status.connected) return ['Connected', 'ok'];
  if (status.pending) return ['Waiting for Google', 'warn'];
  return ['Not connected', 'muted'];
}

export function analyticsText(status) {
  if (!status?.connected) return 'Reads views, watch time, likes and follows for your YouTube posts once a day. Read-only: it never posts.';
  const parts = [status.google_account?.email ? `As ${status.google_account.email}.` : '',
    status.last_sync ? `Last synced ${shortDate(status.last_sync)}.` : 'Not synced yet.'];
  if (status.last_error) parts.push(status.last_error);
  return parts.filter(Boolean).join(' ');
}

export function syncText(result) {
  if (!result) return 'Synced.';
  const stored = result.stored || 0;
  const head = stored ? `Stored numbers for ${stored} post${stored === 1 ? '' : 's'}.` : 'No new numbers yet.';
  if (result.stopped === 'quota') return head + ' YouTube\'s quota ran out; the rest comes at the next sync.';
  if (result.channels_not_owned?.length) return head + ` Not on this Google account: ${result.channels_not_owned.join(', ')}.`;
  return head;
}

export const PRIVACY = [['private', 'Private'], ['unlisted', 'Unlisted'], ['public', 'Public']];

export function postingText(status) {
  if (!status?.connected) return 'Post approved YouTube posts through your own Google project. Optional: Prepare post stays the default (Publishing).';
  return status.google_account?.email ? `As ${status.google_account.email}.` : 'Connected.';
}

export function publishText(result) {
  if (result?.note) return result.note;
  return `Posted to YouTube as ${result?.privacy || 'private'}.`;
}

export function batchText(result) {
  const done = result?.approved?.length || 0, skipped = result?.skipped?.length || 0;
  return `Approved ${done} post${done === 1 ? '' : 's'}.` + (skipped ? ` ${skipped} could not be approved and still wait.` : '');
}

export const WEIGHTS = [['views', 'Views at 7 days'], ['watch', 'Watch time'], ['engagement', 'Follows and engagement']];

export function weightPercents(weights) {
  const total = Object.values(weights || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  return Object.fromEntries(WEIGHTS.map(([k]) => [k, total > 0 ? Math.round(((Number(weights[k]) || 0) / total) * 100) : 0]));
}

// The three percentages as the weights the server takes, or a sentence saying what is wrong.
export function weightsFromPercents(values) {
  const out = {};
  for (const [k, label] of WEIGHTS) {
    const v = Number(values[k]);
    if (!Number.isFinite(v) || v < 0 || v > 100) return { error: `${label} must be between 0 and 100.` };
    out[k] = v / 100;
  }
  if (Object.values(out).reduce((a, b) => a + b, 0) <= 0) return { error: 'At least one weight must be above 0.' };
  return { weights: out };
}

// -- format cards and ports ---------------------------------------------------------------------------

const span = seconds => {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return { n: s, unit: 'second' };
  return { n: Math.round(s / 60), unit: 'minute' };
};
const words = ({ n, unit }) => `${n} ${unit}${n === 1 ? '' : 's'}`;

// A card's typical length in plain words: "1 to 5 minutes", "45 seconds to 2 minutes", "about 3 minutes".
export function formatLength(min, max) {
  const a = span(min), b = span(max);
  if (a.n === b.n && a.unit === b.unit) return `about ${words(b)}`;
  return a.unit === b.unit ? `${a.n} to ${words(b)}` : `${words(a)} to ${words(b)}`;
}

const count = n => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : null);

// One evidence row: every number with the date it was checked.
export function evidenceText(e) {
  const bits = [];
  if (count(e.views) != null) bits.push(`${count(e.views)} views`);
  if (count(e.age_days) != null) bits.push(`${count(e.age_days)} day${e.age_days === 1 ? '' : 's'} old`);
  return `${bits.length ? bits.join(', ') + ' when seen. ' : ''}Checked ${e.checked}.${e.note ? ' ' + e.note : ''}`;
}

export function audienceText(a = {}) {
  return `${a.age_band || 'Any age'}, ${a.interests || 'no interests named'}, on ${platformName(a.platform)}. Why they watch: ${a.why || 'not stated'}.`;
}

export const CHECK_NAMES = [['audience_match', 'Audience match'], ['distance', 'Distance from the source'], ['cost', 'Cost to make'], ['series', 'Series rule']];

// Each of the Evaluator's port checks as [name, result, tone]: Passed, Warning or Refused. Empty until checked.
export function portChecks(checks) {
  if (!checks || !Array.isArray(checks.findings)) return [];
  // Pack C's brand rule (another company's block game's name) shows only when it found something.
  const names = checks.findings.some(f => f.check === 'brand') ? [...CHECK_NAMES, ['brand', 'Another game\'s name']] : CHECK_NAMES;
  return names.map(([key, name]) => {
    const found = checks.findings.filter(f => f.check === key);
    if (found.some(f => f.result === 'reject')) return [name, 'Refused', 'error'];
    if (found.length) return [name, 'Warning', 'warn'];
    return [name, 'Passed', 'ok'];
  });
}

export function portReasons(checks) {
  return (checks?.findings || []).map(f => f.reason).filter(Boolean);
}

export function portStatus(port) {
  return ({ proposed: ['With the Evaluator', 'accent'], accepted: ['Accepted', 'ok'], rejected: ['Rejected', 'muted'],
    retired: ['Retired', 'muted'] })[port.status] || [port.status, 'muted'];
}

// The server's style pack list names them; this is the fallback where it is not loaded (services/content_studio/formats.py).
const PACK_NAMES = { 'motion-type': 'Motion type', 'flat-2d': 'Flat 2D explainer', 'glossy-3d': 'Glossy 3D mascot', 'voxel-3d': 'Blocky voxel 3D' };
export function packName(id, packs) {
  return (packs || []).find(p => p.id === id)?.name || PACK_NAMES[id] || id || '';
}

export function costText(cost) {
  if (!cost || cost.units == null) return '';
  const head = `About ${cost.units} planning units`;
  if (cost.ratio == null) return `${head}; no pack can make this length today.`;
  return cost.ratio > 1 ? `${head}, ${cost.ratio} times the cheapest pack that could make it.` : `${head}, the cheapest way to make it.`;
}

// A post made from a format card names it and its style pack; posts without one show nothing.
export function postFormatText(post, packs) {
  if (!post.format_id && !post.style_pack) return '';
  const bits = [];
  if (post.format_name) bits.push(`Format: ${post.format_name}${post.port_id ? ' (ported)' : ''}.`);
  if (post.style_pack) bits.push(`Style pack: ${packName(post.style_pack, packs)}.`);
  return bits.join(' ');
}

// -- failures -------------------------------------------------------------------------------------

export function loadFailure(error) {
  const text = String(error?.message || error || '');
  if (/^401\b/.test(text)) return 'You were signed out. Reload Kairos to sign in again.';
  if (/^403\b/.test(text)) return 'Your account cannot open Content Studio. Ask an admin of this Kairos.';
  return text.replace(/^\d{3}:\s*/, '') || 'Content Studio could not load.';
}

// -- metrics import -------------------------------------------------------------------------------

export const IMPORT_FIELDS = [
  { key: 'post', label: 'Post (id, link or title)', required: true,
    aliases: ['post id', 'post', 'video id', 'video link', 'video url', 'permalink', 'link', 'url', 'video title', 'title', 'video', 'content'] },
  { key: 'views', label: 'Views', required: true, aliases: ['views', 'video views', 'plays', 'video plays'] },
  { key: 'avg_view_duration_s', label: 'Average view duration', required: true,
    aliases: ['average view duration', 'avg view duration', 'average watch time', 'avg watch time', 'average time watched', 'watch time per view'] },
  { key: 'video_length_s', label: 'Video length', required: false, aliases: ['video length', 'video duration', 'duration', 'length'] },
  { key: 'likes', label: 'Likes', required: false, aliases: ['likes', 'like'] },
  { key: 'comments', label: 'Comments', required: false, aliases: ['comments', 'comment'] },
  { key: 'shares', label: 'Shares', required: false, aliases: ['shares', 'share', 'reposts'] },
  { key: 'follows_gained', label: 'Follows gained', required: false,
    aliases: ['follows gained', 'follows', 'new followers', 'followers gained', 'subscribers gained', 'new subscribers', 'subscribers', 'net follows'] },
  { key: 'taken_at', label: 'Date of the numbers', required: false, aliases: ['date', 'taken at', 'as of'] },
];

const plain = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Quoted fields, doubled quotes and CRLF are handled; the delimiter is the commonest of comma, tab and semicolon in line one.
export function parseCsv(text) {
  const source = String(text || '').replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', '\t', ';'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  const [headers = [], ...body] = rows;
  return { headers: headers.map(h => h.trim()), rows: body };
}

// Best guess of which column feeds each field: an exact header first, then a header that contains the alias.
export function guessMapping(headers) {
  const names = headers.map(plain), used = new Set(), mapping = {};
  for (const field of IMPORT_FIELDS) {
    let at = -1;
    for (const alias of field.aliases) { at = names.findIndex((n, i) => !used.has(i) && n === alias); if (at >= 0) break; }
    if (at < 0) for (const alias of field.aliases) { at = names.findIndex((n, i) => !used.has(i) && n.includes(alias)); if (at >= 0) break; }
    mapping[field.key] = at;
    if (at >= 0) used.add(at);
  }
  return mapping;
}

export function parseSeconds(value) {
  const t = String(value ?? '').trim().toLowerCase();
  if (!t) return NaN;
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (clock) return Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const words = /^(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$/.exec(t);
  if (words && (words[1] || words[2])) return Number(words[1] || 0) * 60 + Number(words[2] || 0);
  const plainNumber = /^(\d+(?:\.\d+)?)$/.exec(t.replace(/,/g, ''));
  return plainNumber ? Number(plainNumber[1]) : NaN;
}

export function parseCount(value) {
  const t = String(value ?? '').trim().replace(/[,\s]/g, '');
  if (!t) return 0;
  return /^\d+(?:\.\d+)?$/.test(t) ? Math.round(Number(t)) : NaN;
}

const normalLink = s => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

// Finds the posted post a row means: by id, by posted link, then by an unambiguous title.
export function matchPost(value, posts) {
  const text = String(value ?? '').trim();
  if (!text) return { error: 'no post named' };
  if (/^\d+$/.test(text)) {
    const byId = posts.find(p => p.id === Number(text));
    return byId ? { id: byId.id } : { error: `post ${text} is not a posted post` };
  }
  const a = normalLink(text);
  const byLink = posts.filter(p => p.posted_url && (normalLink(p.posted_url) === a
    || (a.length >= 8 && normalLink(p.posted_url).includes(a)) || (normalLink(p.posted_url).length >= 8 && a.includes(normalLink(p.posted_url)))));
  if (byLink.length === 1) return { id: byLink[0].id };
  const byTitle = posts.filter(p => plain(p.title) === plain(text));
  if (byTitle.length === 1) return { id: byTitle[0].id };
  return { error: byLink.length > 1 || byTitle.length > 1 ? `"${text}" matches more than one post` : `no posted post matches "${text}"` };
}

// rows: parsed body rows; mapping: field key -> column index (-1 for none); posts: posted posts.
// Returns the request body for POST /metrics/import plus a line-numbered list of problems.
export function buildImport(rows, mapping, posts, { defaultLength = null } = {}) {
  const out = [], problems = [];
  const cell = (row, key) => (mapping[key] >= 0 ? row[mapping[key]] : undefined);
  if (rows.length > 500) problems.push({ line: 0, text: 'Import up to 500 rows at a time.' });
  rows.slice(0, 500).forEach((row, index) => {
    const line = index + 2, fail = text => problems.push({ line, text });
    const post = matchPost(cell(row, 'post'), posts);
    if (post.error) return fail(post.error);
    const views = parseCount(cell(row, 'views'));
    if (!Number.isFinite(views) || cell(row, 'views') === undefined || String(cell(row, 'views')).trim() === '') return fail('views is not a number');
    const avg = parseSeconds(cell(row, 'avg_view_duration_s'));
    if (!Number.isFinite(avg)) return fail('average view duration is not a time');
    let length = mapping.video_length_s >= 0 ? parseSeconds(cell(row, 'video_length_s')) : NaN;
    if (!Number.isFinite(length) && defaultLength) length = defaultLength;
    if (!Number.isFinite(length)) return fail('video length is missing');
    const entry = { post_id: post.id, views, avg_view_duration_s: avg, video_length_s: length };
    for (const key of ['likes', 'comments', 'shares', 'follows_gained']) {
      const raw = cell(row, key);
      if (raw === undefined || String(raw).trim() === '') continue;
      const n = parseCount(raw);
      if (!Number.isFinite(n)) return fail(`${key.replace('_', ' ')} is not a number`);
      entry[key] = n;
    }
    const when = cell(row, 'taken_at');
    if (when !== undefined && String(when).trim()) {
      const ms = Date.parse(String(when).trim());
      if (!Number.isFinite(ms)) return fail('date is not a date');
      entry.taken_at = ms / 1000;
    }
    out.push(entry);
  });
  return { body: { rows: out }, problems };
}

// -- characters (Pack A, Video Styles unit 3) -----------------------------------------------------------------------
// A character version moves draft -> waiting for your OK (its sheet was rendered) -> approved or rejected.
export const FAMILIES = [['round', 'Round'], ['square', 'Square'], ['triangle', 'Triangle']];
export const ACCESSORIES = [['none', 'None'], ['scarf', 'Scarf'], ['antenna', 'Antenna'], ['leaf', 'Leaf'], ['cap', 'Cap'], ['bow', 'Bow']];
export function characterStatus(status) {
  return ({ draft: ['Draft, no sheet yet', 'muted'], awaiting_approval: ['Waiting for your OK', 'accent'], approved: ['Approved', 'ok'],
    rejected: ['Rejected', 'warn'] })[status] || [status || '', 'muted'];
}
export const sheetUrl = (id, version) => `/api/characters/${encodeURIComponent(id)}/versions/${Number(version)}/sheet.png`;
// What a video may cast: the newest approved version, else none.
export function castableText(character) {
  const v = character.approved_version;
  return v ? `Videos can cast version ${v}.` : 'No approved version yet, so no video can use it.';
}
// Only the colours the dialog changed become a new version's changes.
export function characterChanges(spec, form) {
  const changes = {}, palette = {};
  for (const key of ['body', 'body_shade', 'head', 'accent']) {
    const value = String(form[key] || '').toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(value) && value !== spec.palette[key]) palette[key] = value;
  }
  if (Object.keys(palette).length) changes.palette = palette;
  if (form.accessory && form.accessory !== spec.accessory) changes.accessory = form.accessory;
  const name = String(form.name || '').trim();
  if (name && name !== spec.name) changes.name = name;
  return changes;
}

// -- user-made style packs (Video Styles, routes/style_pack_routes.py) --------------------------------------------------

export function packStatus(version) {
  if (!version) return ['No version', 'muted'];
  const sample = version.sample?.status || '';
  if (version.status === 'draft') {
    if (sample === 'rendering') return ['Rendering its sample', 'accent'];
    if (sample.startsWith('waiting')) return ['Waiting for character sheets', 'warn'];
    if (sample.startsWith('failed')) return ['Sample failed', 'warn'];
    return ['Draft, no sample yet', 'muted'];
  }
  return ({ awaiting_approval: ['Waiting for your OK', 'accent'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'warn'] })[version.status]
    || [version.status || '', 'muted'];
}
// What a channel can do with the pack: use its approved version, or nothing yet.
export function packUseText(pack) {
  const v = pack.approved_version;
  return v ? `Channels and videos use version ${v}.` : 'Not approved yet, so no channel can use it.';
}
// Pack B's 3D renderer as Studio shows it: three.js is built in; Blender only when it is installed (routes/style_pack_routes.py `renderers`).
export function rendererText(renderer, status) {
  const blender = status?.blender;
  if (renderer === 'blender') {
    if (blender?.supported) return `Blender ${blender.version}, installed on this computer. Softer, more realistic light; much slower to render.`;
    return `Blender, but ${blender?.found ? `this computer has Blender ${blender.version}, older than 4.2` : 'Blender isn\'t installed on this computer'}, so it renders with three.js.`;
  }
  return 'three.js, built into Kairos. Fast; nothing to install.';
}
export function rendererOptions(status, { inherit = false } = {}) {
  const blender = status?.blender;
  const out = inherit ? [['', 'The style pack\'s choice']] : [];
  out.push(['threejs', 'three.js (built in)']);
  out.push(['blender', blender?.supported ? `Blender ${blender.version} (installed)` : 'Blender (not installed)']);
  return out;
}
export function packOriginText(origin) {
  const from = origin?.from && origin.kind !== 'starter' ? ` (${origin.from})` : '';
  const label = ({ brief: 'Made from a written brief', duplicate: 'Duplicated', starter: 'Starter pack', import: 'Imported',
    shared: 'Added from the shared library', reference: 'Made from a reference video' })[origin?.kind];
  return label ? label + from + '.' : '';
}
export function packFacts(spec, renderers) {
  if (!spec) return [];
  const palette = typeof spec.look.palette === 'string' ? `${spec.look.palette} palette` : 'its own palette';
  return [
    ['Look', spec.base === 'glossy-3d' ? `Glossy 3D studio with a 3D mascot, design look ${spec.look.design_look}`
      : spec.base === 'voxel-3d' ? `Blocky world of soft toy blocks with blocky characters, design look ${spec.look.design_look}`
      : `${spec.base === 'flat-2d' ? 'Flat 2D with characters' : 'Motion type'}, ${palette}, ${spec.look.lighting} light, design look ${spec.look.design_look}`],
    ...(spec.base === 'glossy-3d' ? [['3D renderer', rendererText(spec.renderer, renderers)]] : []),
    ...(spec.base === 'voxel-3d' ? [['3D renderer', 'three.js, built into Kairos. The blocky world has no Blender option.'],
      ['Audience', 'This look draws children. Each channel and post says whether its videos are made for kids before they go up.']] : []),
    ['Characters', spec.characters.length ? `${spec.characters.length} in its set (${spec.look.families.join(', ')} families)` : 'None'],
    [spec.base === 'glossy-3d' ? 'Studio sets' : spec.base === 'voxel-3d' ? 'Worlds' : 'Scenes', `${spec.scenes.settings.join(', ')}; ${spec.scenes.shots.join(', ')} shots`
      + (spec.base === 'voxel-3d' && spec.scenes.times ? `; ${spec.scenes.times.join(', ')}` : '')],
    ['Camera and cuts', `${spec.scenes.cameras.join(', ')}; ${spec.scenes.transitions.join(', ')}`],
    ['Pacing', `${spec.pacing.words_per_second} words a second, shots of ${spec.pacing.shot_seconds[0]} to ${spec.pacing.shot_seconds[1]} s, hook in ${spec.pacing.hook_seconds} s`],
    ['Captions', spec.captions.on ? `On, ${spec.captions.case === 'upper' ? 'upper case' : 'sentence case'}` : 'Off'],
    ['Music and voice', `${spec.music.mood} music, voice ${spec.voice.voice}`],
  ];
}
// The pack options a channel can pick: the built-ins that run today and the account's approved packs.
export function packOptions(available) {
  return [['', 'Motion type (default)'], ...(available || []).filter(p => p.id !== 'motion-type').map(p => [p.id, p.name])];
}

// A chapter's start as YouTube writes it: 00:00, 01:05, 1:02:03.
export function clock(seconds) {
  const t = Math.floor(Number(seconds) || 0), two = n => String(n).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor(t % 3600 / 60))}:${two(t % 60)}` : `${two(Math.floor(t / 60))}:${two(t % 60)}`;
}

// -- the publishing dashboard (Studio > Content > Publishing; services/content_studio/publishing.py) ----------------
export const PUBLISH_STATES = [['drafted', 'Drafted'], ['awaiting_approval', 'Waiting for your approval'], ['approved', 'Approved'],
  ['prepared', 'Prepared'], ['waiting_for_you', 'Waiting for you to press Post'], ['posted', 'Posted'], ['failed', 'Failed'], ['rejected', 'Rejected']];
const STATE_TONES = { drafted: 'muted', awaiting_approval: 'warn', approved: 'accent', prepared: 'accent', waiting_for_you: 'warn',
  posted: 'ok', failed: 'error', rejected: 'muted' };
export const stateLabel = state => (PUBLISH_STATES.find(s => s[0] === state) || [state, state])[1];
export const stateTone = state => STATE_TONES[state] || 'muted';
export const POST_BUTTONS = { youtube: 'Publish', tiktok: 'Post', instagram: 'Share' };
export const FILL_NAMES = { file: 'Video', title: 'Title', description: 'Description', caption: 'Caption', tags: 'Tags', ai_label: 'AI label',
  made_for_kids: 'Audience', thumbnail: 'Thumbnail' };

// The states that have posts, in order, for the filter row.
export function stateCounts(counts = {}) {
  return PUBLISH_STATES.filter(([id]) => counts[id]).map(([id, label]) => ({ id, label, count: counts[id] }));
}

// 'to_post' is both states that wait for the person to press Post (prepared, and filled on the page).
export function filterItems(items, state) {
  if (state === 'to_post') return items.filter(i => ['prepared', 'waiting_for_you'].includes(i.state));
  return state && state !== 'all' ? items.filter(i => i.state === state) : items;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = n => String(n).padStart(2, '0');

// Seconds of local midnight `days` after the day `at` falls on (calendar days, so a clock change never shifts a column).
export function addDays(at, days) {
  const d = new Date(at * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime() / 1000;
}
export function weekOf(at) {
  const d = new Date(at * 1000);
  return addDays(at, -((d.getDay() + 6) % 7));
}
export function weekDays(weekStart) {
  return DAY_NAMES.map((name, i) => { const at = addDays(weekStart, i); const d = new Date(at * 1000); return { at, name, label: `${name} ${d.getDate()} ${MONTHS[d.getMonth()]}` }; });
}
export function weekLabel(weekStart, thisWeek) {
  const d = new Date(weekStart * 1000), end = new Date(addDays(weekStart, 6) * 1000);
  const span = `${d.getDate()} ${MONTHS[d.getMonth()]} to ${end.getDate()} ${MONTHS[end.getMonth()]}`;
  return weekStart === thisWeek ? `This week, ${span}` : `Week of ${span}`;
}
// The week's items, one list per day, earliest first.
export function itemsByDay(items, weekStart) {
  const days = weekDays(weekStart).map(d => d.at), end = addDays(weekStart, 7);
  return days.map((start, i) => items.filter(item => item.when >= start && item.when < (i < 6 ? days[i + 1] : end)).sort((a, b) => a.when - b.when));
}
export function timeText(at) {
  const d = new Date(at * 1000);
  return `${DAY_NAMES[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}
export function whenText(item) {
  if (item.posted_at) return `Posted ${timeText(item.posted_at)}`;
  if (item.scheduled_at) return `Scheduled for ${timeText(item.scheduled_at)}`;
  if (item.approved_at) return `Approved ${timeText(item.approved_at)}, not scheduled`;
  return `Made ${timeText(item.created_at)}`;
}
export function nextText(next) {
  if (!next) return '';
  return `${next.who === 'you' ? 'You' : 'Team'}: ${next.what}`;
}
// What the fill did on the page, in words.
export function fillText(fill) {
  if (!fill || !fill.stage) return '';
  const names = keys => (keys || []).map(k => FILL_NAMES[k] || k).join(', ');
  const parts = [];
  if (fill.filled?.length) parts.push(`Kairos filled: ${names(fill.filled)}.`);
  if (fill.missing?.length) parts.push(`Not found on the page, do these yourself: ${names(fill.missing)}.`);
  if (fill.stage === 'stopped' && fill.note) parts.push(`Stopped: ${fill.note}.`);
  return parts.join(' ');
}
// <input type=datetime-local> value for a time, and back.
export function scheduleValue(at) {
  if (!at) return '';
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}
export function parseSchedule(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime() / 1000;
}
export function prepareText(prep) {
  const pkg = prep?.package || {};
  if (pkg.problems?.length) return `Prepared with a problem: ${pkg.problems[0]}`;
  return `Prepared for ${pkg.platform_name || 'its platform'}. ${pkg.routes?.includes('api') ? 'Post to YouTube, or open the upload page.' : 'Open the upload page when you are ready.'}`;
}

// -- page-read analytics (TikTok and Instagram) ----------------------------------------------------------------
const READ_STATUS = { ok: 'read', signed_out: 'signed out', not_yours: 'not this channel\'s page', parse_failed: 'no numbers found',
  failed: 'could not read', unavailable: 'desktop app closed' };
export function pageReadText(p) {
  if (!p) return '';
  if (!p.on) return `Off. Turn it on to read ${p.name} numbers from your own signed-in pages in the Kairos Browser.`;
  if (p.paused === 'signed_out') return `Paused: you are signed out of ${p.name} in the Kairos Browser. Sign in there; reading resumes within six hours.`;
  if (p.paused === 'page_changed') return `Paused: several reads in a row found no numbers, so ${p.name} may have changed its page. Check a post's analytics page, then press Try again.`;
  const last = p.last ? ` Last read ${timeText(p.last.at)} (${READ_STATUS[p.last.status] || p.last.status}).` : ' Nothing read yet.';
  return `On. ${p.reads_today} of ${p.max_per_day} page reads today.${last}`;
}

// -- the channel dashboard (Studio > Content laid out like a creator studio, by channel) ---------------------------
// The rail picks a scope: 'all' (every channel), one channel (its id), or a library ('lib:formats' and so on).
export const OVERVIEW_TABS = [['dashboard', 'Dashboard'], ['approvals', 'Approvals'], ['pipeline', 'Pipeline'], ['calendar', 'Calendar'],
  ['publishing', 'Publishing'], ['analytics', 'Analytics'], ['report', 'Report']];
export const CHANNEL_TABS = [['dashboard', 'Dashboard'], ['pipeline', 'Pipeline'], ['calendar', 'Calendar'], ['approvals', 'Approvals'],
  ['publishing', 'Publishing'], ['analytics', 'Analytics'], ['settings', 'Settings']];
export const LIBRARIES = [['formats', 'Formats'], ['styles', 'Styles'], ['characters', 'Characters'], ['connections', 'Connections']];
export const tabsFor = scope => scope === 'all' ? OVERVIEW_TABS : typeof scope === 'number' ? CHANNEL_TABS : [];

// A channel's round avatar: the first letter of its handle, coloured from its look (the look id, else its style pack, else
// the handle), so channels that share a look share a colour.
export function avatarFor(channel) {
  const letter = String(channel?.handle || '').replace(/^@/, '').slice(0, 1).toUpperCase() || '?';
  return { letter, key: channel?.look || channel?.style_pack || channel?.handle || '' };
}
export const PLATFORM_SHORT = { youtube: 'YT', tiktok: 'TT', instagram: 'IG' };
export const channelName = channel => channel ? `${platformName(channel.platform)} ${channel.handle}` : '';

// The pipeline of one channel: its own posts, plus its niche's topics (a topic belongs to a niche until a post is made).
export function channelItems(items, channel) {
  if (!channel) return items || [];
  return (items || []).filter(i => i.kind === 'topic' ? i.niche_id === channel.niche_id : i.channel_id === channel.id);
}
// Post id to channel id, from the publishing items (every post is one).
export function postChannels(pubItems) {
  return Object.fromEntries((pubItems || []).map(i => [i.post_id, i.channel_id]));
}
export const forChannel = (list, channelId, key = 'channel_id') => channelId == null ? (list || []) : (list || []).filter(x => x[key] === channelId);
export const TO_POST = ['prepared', 'waiting_for_you'];

// What needs the person, as rows to jump from: posts to approve, long video plans, prepared posts waiting for Post and failed
// preparations; for every channel also character sheets, style packs and team decisions. channelId null means every channel.
export function needsYou({ approvals = [], plans = [], pubItems = [], sheets = [], packs = [], decisions = [] } = {}, channelId = null) {
  const owner = postChannels(pubItems);
  const mine = channelId == null ? plans : plans.filter(p => owner[p.post_id] === channelId);
  const pub = forChannel(pubItems, channelId);
  const rows = [
    { key: 'approvals', count: forChannel(approvals, channelId).length, one: 'post to approve', many: 'posts to approve', tab: 'approvals' },
    { key: 'plans', count: mine.length, one: 'long video plan to approve', many: 'long video plans to approve', tab: 'approvals' },
    { key: 'to_post', count: pub.filter(i => TO_POST.includes(i.state)).length, one: 'prepared post waiting for you to post it', many: 'prepared posts waiting for you to post them', tab: 'publishing', filter: 'to_post' },
    { key: 'failed', count: pub.filter(i => i.state === 'failed').length, one: 'preparation that failed', many: 'preparations that failed', tab: 'publishing', filter: 'failed' },
  ];
  if (channelId == null) rows.push(
    { key: 'sheets', count: sheets.length, one: 'character sheet to approve', many: 'character sheets to approve', tab: 'approvals' },
    { key: 'packs', count: packs.length, one: 'style pack to approve', many: 'style packs to approve', tab: 'approvals' },
    { key: 'decisions', count: decisions.filter(d => d.status === 'awaiting_user').length, one: 'team decision to confirm', many: 'team decisions to confirm', tab: 'analytics' });
  return rows.filter(r => r.count > 0).map(r => ({ ...r, text: `${r.count} ${r.count === 1 ? r.one : r.many}` }));
}
export const needsCount = rows => rows.reduce((n, r) => n + r.count, 0);

// The newest posted posts (newest first) and the next scheduled ones (soonest first).
export function latestPosted(pubItems, n = 4, channelId = null) {
  return forChannel(pubItems, channelId).filter(i => i.state === 'posted' && i.posted_at).sort((a, b) => b.posted_at - a.posted_at).slice(0, n);
}
export function upcoming(pubItems, now, n = 5, channelId = null) {
  return forChannel(pubItems, channelId).filter(i => i.scheduled_at && i.scheduled_at >= now && !['posted', 'rejected'].includes(i.state))
    .sort((a, b) => a.scheduled_at - b.scheduled_at).slice(0, n);
}

// A post's newest number set (its latest snapshot), or null before any numbers came in.
export function latestNumbers(metrics) {
  const s = [...(metrics || [])].sort((a, b) => (a.taken_at || 0) - (b.taken_at || 0)).at(-1);
  if (!s) return null;
  return { views: s.views || 0, avg: s.avg_view_duration_s ?? null, length: s.video_length_s ?? null, likes: s.likes || 0, comments: s.comments || 0,
    shares: s.shares || 0, follows: s.follows_gained || 0, at: s.taken_at, source: s.source || '' };
}
// Totals over the posts whose numbers were read: views, follows, likes, comments, shares and the mean average view duration.
export function numberTotals(list) {
  const got = (list || []).filter(Boolean);
  const sum = key => got.reduce((n, x) => n + (x[key] || 0), 0);
  const avgs = got.map(x => x.avg).filter(v => typeof v === 'number');
  return { posts: got.length, views: sum('views'), follows: sum('follows'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares'),
    avg: avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null };
}
// 950, 1.2K, 34K, 1.5M.
export function compact(n) {
  const v = Number(n) || 0, a = Math.abs(v);
  if (a < 1000) return String(Math.round(v));
  if (a < 1e6) return `${(v / 1e3).toFixed(a < 1e4 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(v / 1e6).toFixed(a < 1e7 ? 1 : 0).replace(/\.0$/, '')}M`;
}
export function durationText(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'no number yet';
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
// How many items sit in each pipeline column, for the dashboard.
export function pipelineCounts(items) {
  return boardColumns(items).map(c => ({ id: c.id, title: c.title, count: c.items.length }));
}
const counted = (count, one, many = one + 's') => `${count} ${count === 1 ? one : many}`;
// One channel's week in plain lines: posted, scheduled, waiting, and its niche on the scoreboard.
export function channelWeek(channel, pubItems, now, niche = null) {
  const week = now - 7 * 86400, mine = forChannel(pubItems, channel.id);
  const lines = [
    `Posted in the last 7 days: ${counted(mine.filter(i => i.state === 'posted' && (i.posted_at || 0) >= week).length, 'post')}.`,
    `Scheduled from now on: ${counted(upcoming(mine, now, Infinity).length, 'post')}.`,
    `Waiting for your approval: ${counted(mine.filter(i => i.state === 'awaiting_approval').length, 'post')}.`,
    `Prepared and waiting for you to post: ${counted(mine.filter(i => TO_POST.includes(i.state)).length, 'post')}.`];
  if (niche) lines.push(niche.eligible && niche.score != null ? `Its niche, ${niche.name}, scores ${niche.score.toFixed(1)} on the scoreboard.`
    : `Its niche, ${niche.name}, is not scored yet: ${niche.not_yet || 'no posts yet'}.`);
  return lines;
}
// The phone's channel picker: every channel (in niche order), then the libraries.
export function pickerOptions(niches, channels) {
  const out = [['all', 'All channels']];
  for (const { niche, channels: list } of groupChannels(niches, channels)) {
    for (const c of list) out.push([String(c.id), `${channelName(c)}, ${niche.name}${c.status === 'archived' ? ', archived' : ''}`]);
  }
  return [...out, ...LIBRARIES.map(([id, label]) => [`lib:${id}`, label])];
}
export function parseScope(value) {
  if (value == null || value === 'all') return 'all';
  if (/^lib:(formats|styles|characters|connections)$/.test(String(value))) return String(value);
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 'all';
}

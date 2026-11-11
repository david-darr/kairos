// Standalone offline UI checks for Studio > Content: node scripts/studio-content-checks.cjs
// Uses the real shell, the folder tab renderer and a stateful mock of /api/content-studio/. Records every write.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const binary = process.env.JARVIS_ELECTRON_BINARY || require('../electron/node_modules/electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(binary, [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 420000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const assert = require('node:assert/strict');
const fixture = require('../demo/fixtures.js')({ state: { empty: false } }).fixture;
const output = path.join(root, 'data/ui-review', 'studio-content-' + Date.now());
const lock = path.join(root, 'data/electron.lock');
let ownsLock = false, win, server;
const errors = [], outside = [], writes = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = Date.now() / 1000;
const customTab = { id: 'studio', label: 'Studio', user_tab: false, format: 'folder', view_url: '/tab-files/studio/view.js', style_url: '/tab-files/studio/view.css', icon_svg: '<svg viewBox="0 0 24 24"><path d="M3 6h18v15H3z"/></svg>' };

// -- the mock Content Studio store ------------------------------------------------------------------------------
const store = { forbidden: false, metrics: {}, niches: [], channels: [], items: [], approvals: [], plans: [], findings: [], decisions: [], posted: [], team: [], pubItems: [], reads: { tiktok: false, instagram: false },
  settings: { weights: { views: 0.4, watch: 0.4, engagement: 0.2 }, batch_approval: false },
  yt: { configured: true, connected: false, pending: false, google_account: null, needs_reconnect: false, last_sync: null, notice: 'Read only.' },
  ytPost: { configured: true, connected: true, pending: false, google_account: { id: 'g1', email: 'me@example.com' }, needs_reconnect: false, privacy: 'private',
    notice: 'YouTube may keep uploads from a project that has not passed its API audit private.' } };
// Publishing (Prepare post and the dashboard): a week of posts in every state. Times are this week's, local.
const monday = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7).getTime() / 1000; })();
const at = (day, hour, minute = 0) => { const d = new Date(monday * 1000); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, hour, minute).getTime() / 1000; };
const pageReadsData = () => ({ note: 'Read from your signed-in pages in the Kairos Browser, read-only. It may stop working when TikTok or Instagram change their pages; the numbers are only as good as what the page showed.',
  rules_note: 'Platform limits and page layouts are from general knowledge (2026-11), not checked against the platforms\' own pages. If a platform says otherwise, the platform wins.',
  desktop: true, platforms: {
    tiktok: { on: store.reads.tiktok, name: 'TikTok', reads_today: 3, max_per_day: 40, last: { at: at(1, 20, 5), status: 'ok' }, paused: '', paused_until: null, posts: 3 },
    instagram: { on: store.reads.instagram, name: 'Instagram', reads_today: 2, max_per_day: 40, last: { at: at(1, 20, 6), status: 'parse_failed' }, paused: store.reads.instagram ? 'page_changed' : '', paused_until: null, posts: 2 } } });
const pubItem = (post_id, title, platform, state, extra = {}) => ({ post_id, title, platform, platform_name: { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }[platform],
  handle: { youtube: '@cooks', tiktok: '@cooks.tt', instagram: '@trips' }[platform], channel_id: { youtube: 1, tiktok: 2, instagram: 3 }[platform], niche: platform === 'instagram' ? 'Travel' : 'Cooking', long_form: false, state, scheduled_at: null, posted_at: null, posted_url: null,
  approved_at: at(0, 9), created_at: at(0, 8), prep_id: null, route: null, routes: [], problems: [], error: '', fill: {}, checklist: [], rejection_count: 0, ...extra,
  when: extra.when || extra.posted_at || extra.scheduled_at || extra.approved_at || at(0, 9) });
const NEXT = { drafted: ['team', 'The Script Writer writes the script.'], awaiting_approval: ['you', 'Approve, edit or reject it in Approvals.'],
  approved: ['team', 'The Publisher prepares it for YouTube, or press Prepare post.'], prepared: ['you', 'Press Post to YouTube, or Open upload page to post it yourself.'],
  waiting_for_you: ['you', 'Check the TikTok page and press Post yourself, then paste the live link (Mark posted).'], posted: ['team', 'Its numbers are tracked.'],
  failed: ['you', 'Fix it and try again: The upload page could not be filled.'], rejected: ['you', 'Redraft it or leave it.'] };
function pubData() {
  const items = store.pubItems.map(i => ({ ...i, next: { who: NEXT[i.state][0], what: NEXT[i.state][1] }, week: monday }));
  const counts = {}; for (const i of items) counts[i.state] = (counts[i.state] || 0) + 1;
  return { items, counts, labels: {}, now, this_week: monday, page_reads: pageReadsData() };
}
const checklist = [{ key: 'file', text: 'Attach 9-16-v2.mp4 (9:16, 0:31), the editor\'s export of the version you approved', by: 'kairos', status: 'todo' },
  { key: 'title', text: 'Title', by: 'kairos', status: 'todo' }, { key: 'description', text: 'Description and 2 hashtags', by: 'kairos', status: 'todo' },
  { key: 'tags', text: 'Tags (3), under Show more', by: 'kairos', status: 'todo' }, { key: 'made_for_kids', text: 'Audience: No, it\'s not made for kids', by: 'kairos', status: 'todo' },
  { key: 'ai_label', text: 'Altered or synthetic content: on. In Details, under Altered content, answer Yes.', by: 'kairos', status: 'todo' },
  { key: 'cover', text: 'Thumbnail: Upload the thumbnail in Details. Shorts take a frame you pick in the YouTube app. Kairos made post-32.jpg from the video.', by: 'you', status: 'todo' },
  { key: 'schedule', text: 'Schedule for Tue 11 Nov 2026, 09:00. In Visibility, choose Schedule and set the date and time.', by: 'you', status: 'todo' },
  { key: 'check', text: 'Read the page once: every field as approved, nothing added by the platform you do not want.', by: 'you', status: 'todo' },
  { key: 'post', text: 'Press Publish yourself. Kairos never presses it.', by: 'you', status: 'todo' },
  { key: 'link', text: 'Paste the live link in Kairos (Mark posted), or the Publisher records it, so the numbers can be tracked.', by: 'you', status: 'todo' }];
const prepFor = (id) => { const i = store.pubItems.find(x => x.prep_id === id); return { id, post_id: i.post_id, platform: i.platform, state: i.state === 'failed' ? 'failed' : i.state === 'waiting_for_you' ? 'waiting_for_you' : 'prepared',
  route: i.route, scheduled_at: i.scheduled_at, error: i.error, fill: i.fill, package: { platform: i.platform, platform_name: i.platform_name, routes: i.routes, problems: i.problems,
    file: { name: '9-16-v2.mp4', aspect: '9:16', seconds: 31, approved_file: false }, text: i.platform === 'youtube' ? { title: i.title, description: 'Sunlight scatters off the air.\n\n#sky #science', tags: 'sky, science, light' } : { caption: 'Sunlight scatters off the air.\n\n#sky #science' },
    hashtags: ['#sky', '#science'], hashtags_left_out: [], ai_label: { on: true, name: 'Altered or synthetic content' }, cover: { name: 'Thumbnail', file: 'post-32.jpg', what: 'A blue sky over a sun' },
    checklist, rules_note: 'Platform limits and page layouts are from general knowledge (2026-11), not checked against the platforms\' own pages.' } }; };
const post = (id, extra = {}) => ({ id, channel_id: 1, title: `Post ${id}`, caption: 'A caption', script_ref: 'Hook, three steps, ask', render_ref: 'https://example.com/render.mp4',
  render_status: 'ok', state: 'awaiting_approval', rejection_count: 0, platform: 'youtube', handle: '@cooks', niche_id: 1, niche_name: 'Cooking', ...extra });
const board = () => ({ at: now, weights: { views: 0.4, watch: 0.4, engagement: 0.2 }, minimum: { weeks: 3, posts: 10 },
  niches: [{ id: 1, name: 'Cooking', status: 'live', slots: 1, eligible: false, score: null, posts_posted: 4, posts_scored: 2, age_days: 6, not_yet: '2 of 10 posts with 7 day numbers; 6 of 21 days' },
    { id: 2, name: 'Travel', status: 'live', slots: 1, eligible: true, score: 71.5, posts_posted: 14, posts_scored: 12, age_days: 30, not_yet: '' }],
  strategies: { script_writer: [{ id: 1, name: 'Hook first', status: 'active', is_default: true, eligible: false, score: null, posts_posted: 0, posts_scored: 0, age_days: 0, not_yet: '0 of 10 posts with 7 day numbers; 0 of 21 days' }], evaluator: [] },
  formats: [], style_packs: [{ id: 'motion-type', name: 'Motion type', available: true, eligible: false, score: null, posts_posted: 3, posts_scored: 1, age_days: 4, not_yet: '1 of 10 posts with 7 day numbers; 4 of 21 days' }],
  top_posts: [{ post_id: 35, title: 'Clouds weigh tons', platform: 'youtube', niche: 'Cooking', posted_url: 'https://www.youtube.com/watch?v=abcdefghijk', score: 64.2 }], posts_scored: 14, posts_posted: 18 });
// Example format card and ports for this check only (example.test links, made-up numbers).
const formatsData = () => ({
  formats: [{ id: 3, name: 'One person at a time', premise: 'An impossible ability applied to everyone, revealed one person at a time.',
    beats: ['hook', 'rules of the premise', 'repeating segment', 'twist', 'payoff'], length_min_s: 60, length_max_s: 300, source_niche: 'Pop psychology',
    audience: { age_band: '16-30', interests: 'what-if questions', platform: 'youtube', why: 'Curiosity about other people' },
    do_not_use: ['Mister Glimpse', 'Glimpse Lab'], status: 'active',
    evidence: [{ url: 'https://www.example.test/watch?v=abc', channel: 'Glimpse Lab', title: 'A source video', views: 1200000, age_days: 12, checked: '2026-11-10', note: '' }] }],
  ports: [{ id: 2, format_id: 3, niche_id: 1, niche_name: 'Cooking', source_niche: 'Pop psychology', status: 'accepted', verdict_reason: 'Same audience, cheap to make.',
    audience_match: 'Both audiences are curious young adults who watch what-if videos on YouTube.',
    audience_evidence: [{ url: 'https://www.example.test/audience', supports: 'Viewer overlap', checked: '2026-11-10' }],
    premise: 'A hidden number floats above every dish.', subject: 'Kitchen science', mascot: 'Pip the owl', style_pack: 'motion-type',
    thumbnail: 'An owl over a steaming pot', example_title: 'Every dish has a secret number',
    checks: { ok: true, findings: [{ check: 'cost', result: 'warn', reason: 'Keep episodes under 8 minutes: that is what Motion type makes today.' }], cost: { units: 3, ratio: 1 } } },
  { id: 4, format_id: 3, niche_id: 2, niche_name: 'Travel', source_niche: 'Pop psychology', status: 'rejected', verdict_reason: 'Pack not built.',
    audience_match: 'Travellers share the curiosity.', audience_evidence: [{ url: 'https://www.example.test/travel', supports: 'Survey', checked: '2026-11-09' }],
    premise: 'Every city shows a hidden number.', subject: 'Cities', mascot: 'none', style_pack: 'glossy-3d', thumbnail: 'A city skyline', example_title: 'Cities and their numbers',
    checks: { ok: false, findings: [{ check: 'cost', result: 'reject', reason: 'Glossy 3D mascot cannot be made yet.' }], cost: { units: 30, ratio: 10 } } }],
  style_packs: [{ id: 'motion-type', name: 'Motion type', available: true, note: 'Exists today.' }, { id: 'glossy-3d', name: 'Glossy 3D mascot', available: false, note: 'Not built yet (build unit 5).' }] });
const reportData = () => ({ from: now - 7 * 86400, to: now, text: 'Content Studio weekly report\n\nWhat won: Travel (71.5).\n  Best script writer strategy: Hook first (60.0).\nRetiring: Cooking (awaiting user).\nSpend this month: $12.00 (all bots $14.00, cap $50).' });
function content(method, p, body) {
  if (store.forbidden && method === 'GET') return [403, { detail: 'Forbidden' }];
  const id = Number((/\/(\d+)(?:\/|$)/.exec(p) || [])[1]);
  const channel = store.channels.find(c => c.id === id);
  if (p === '/niches') {
    if (method === 'POST') { const n = { id: store.niches.length + 1, name: body.name, status: 'live', slots: 1 }; store.niches.push(n); return [200, n]; }
    return [200, { niches: store.niches, max_live: 5 }];
  }
  if (p === '/channels') {
    if (method === 'POST') {
      const n = store.niches.find(x => x.id === body.niche_id);
      const c = { id: store.channels.length + 1, niche_id: n.id, platform: body.platform, handle: body.handle, status: 'live', paused: 0, niche_name: n.name };
      store.channels.push(c); return [200, c];
    }
    return [200, { channels: store.channels }];
  }
  if (/^\/channels\/\d+\/edit$/.test(p)) { Object.assign(channel, body); return [200, channel]; }
  if (p === '/analytics/youtube/status') return [200, store.yt];
  if (p === '/posting/youtube/status') return [200, store.ytPost];
  if (p === '/posting/youtube/privacy') { store.ytPost.privacy = body.privacy; return [200, store.ytPost]; }
  if (p === '/approvals/approve-batch') { const ids = body.post_ids; store.approvals = store.approvals.filter(x => !ids.includes(x.id)); return [200, { approved: ids.map(id => ({ id })), skipped: [] }]; }
  if (/^\/posts\/\d+\/publish-youtube$/.test(p)) return [200, { video_id: 'NEWvideo_01', privacy: 'private', note: '' }];
  if (/^\/channels\/\d+\/archive$/.test(p)) { Object.assign(channel, { status: 'archived', archive_reason: 'archived by you' }); return [200, channel]; }
  if (/^\/channels\/\d+\/restore$/.test(p)) { Object.assign(channel, { status: 'live', archive_reason: null }); return [200, channel]; }
  if (/^\/channels\/\d+\/resume$/.test(p)) { channel.paused = 0; store.findings = store.findings.filter(f => f.channel_id !== id); return [200, channel]; }
  if (p === '/pipeline') return [200, { items: store.items }];
  if (p === '/publishing') return [200, pubData()];
  if (p === '/analytics/pages') { if (method === 'PUT') Object.assign(store.reads, body); return [200, pageReadsData()]; }
  if (p === '/analytics/pages/read' || p === '/analytics/pages/try-again') return [200, { started: true, ...pageReadsData() }];
  if (/^\/preparations\/\d+$/.test(p)) return [200, prepFor(id)];
  if (/^\/posts\/\d+\/prepare$/.test(p)) { const i = store.pubItems.find(x => x.post_id === id); Object.assign(i, { state: 'prepared', prep_id: 40 + id, route: 'api', routes: ['api', 'browser'], checklist }); return [200, prepFor(40 + id)]; }
  if (/^\/posts\/\d+\/schedule$/.test(p)) { const i = store.pubItems.find(x => x.post_id === id); i.scheduled_at = body.at; i.when = body.at || i.approved_at; return [200, prepFor(i.prep_id)]; }
  if (p === '/approvals') return [200, { posts: store.approvals, characters: pending(), style_packs: pendingPacks(), plans: store.plans }];
  if (p === '/watch') return [200, { findings: store.findings }];
  if (p === '/settings') { if (method === 'PUT') Object.assign(store.settings, body); return [200, { ...store.settings, team_bot_ids: store.team }]; }
  if (p === '/posts' && method === 'GET') return [200, { posts: store.posted }];
  let found = store.approvals.find(x => x.id === id) || store.items.find(x => x.kind === 'post' && x.id === id) && post(id, { state: store.items.find(x => x.id === id).state });
  if (/^\/posts\/\d+$/.test(p)) return [200, { ...found, metrics: store.metrics[id] || [] }];
  if (/^\/posts\/\d+\/edit$/.test(p)) { Object.assign(found, body); return [200, found]; }
  if (/^\/posts\/\d+\/approve$/.test(p)) { store.approvals = store.approvals.filter(x => x.id !== id); return [200, { ...found, state: 'approved' }]; }
  if (/^\/posts\/\d+\/reject$/.test(p)) { store.approvals = store.approvals.filter(x => x.id !== id); return [200, { ...found, state: 'rejected' }]; }
  if (/^\/posts\/\d+\/(redraft|posted)$/.test(p)) return [200, { ...found }];
  if (p === '/scoreboard') return [200, board()];
  if (p === '/decisions') return [200, { decisions: store.decisions }];
  if (/^\/decisions\/\d+\/(confirm|reject)$/.test(p)) { const d = store.decisions.find(x => x.id === id); d.status = p.endsWith('confirm') ? 'confirmed' : 'rejected'; return [200, d]; }
  if (p === '/formats') return [200, formatsData()];
  if (p === '/report') return [200, reportData()];
  if (p === '/report/send') return [200, { delivered: true }];
  if (p === '/metrics/import') return [200, { stored: body.rows.length }];
  return [404, { detail: 'Missing content mock: ' + p }];
}
const populate = () => {
  Object.assign(store, {
    pubItems: [
      pubItem(31, 'Why the sky is blue', 'tiktok', 'waiting_for_you', { prep_id: 7, route: 'browser', routes: ['browser'], scheduled_at: at(0, 18), fill: { stage: 'done', filled: ['file', 'caption', 'ai_label'], missing: [] } }),
      pubItem(32, 'Why the sky is blue', 'youtube', 'prepared', { prep_id: 8, route: 'api', routes: ['api', 'browser'], scheduled_at: at(1, 9) }),
      pubItem(33, 'Why the sky is blue', 'instagram', 'failed', { prep_id: 9, route: 'browser', routes: ['browser'], error: 'The upload page could not be filled.', approved_at: at(2, 10) }),
      pubItem(34, 'Clouds weigh tons', 'tiktok', 'posted', { posted_at: at(3, 17, 30), posted_url: 'https://www.tiktok.com/@sky.kairos/video/7350000000000000001' }),
      pubItem(35, 'Clouds weigh tons', 'youtube', 'posted', { posted_at: at(3, 18), posted_url: 'https://www.youtube.com/watch?v=abcdefghijk' }),
      pubItem(26, 'YouTube ready', 'youtube', 'approved', { approved_at: at(4, 11) }),
      pubItem(11, 'Five minute soup', 'youtube', 'awaiting_approval', { approved_at: null, created_at: at(4, 8), when: at(4, 8) }),
      pubItem(21, 'Scripting now', 'youtube', 'drafted', { approved_at: null, created_at: at(5, 8), when: at(5, 8) }),
      pubItem(36, 'Rainbow myths', 'instagram', 'rejected', { approved_at: null, created_at: at(6, 12), when: at(6, 12) })], niches: [{ id: 1, name: 'Cooking', status: 'live', slots: 1 }, { id: 2, name: 'Travel', status: 'live', slots: 1 }],
    channels: [{ id: 1, niche_id: 1, platform: 'youtube', handle: '@cooks', status: 'live', paused: 1, niche_name: 'Cooking' },
      { id: 2, niche_id: 1, platform: 'tiktok', handle: '@cooks.tt', status: 'live', paused: 0, niche_name: 'Cooking' },
      { id: 3, niche_id: 2, platform: 'instagram', handle: '@trips', status: 'archived', paused: 0, niche_name: 'Travel', archive_reason: 'archived by you' }],
    findings: [{ kind: 'platform_warning', severity: 'urgent', channel_id: 1, message: 'YouTube warned @cooks: Reused content notice. The channel is paused.' }],
    approvals: [post(11, { title: 'Five minute soup', format_id: 3, format_name: 'One person at a time', port_id: 2, style_pack: 'motion-type', thumbnail: 'A pot with a glowing number' }), post(12, { title: 'Pasta in one pan', platform: 'tiktok', handle: '@cooks.tt', channel_id: 2 }),
      post(13, { title: 'Sauce basics', platform: 'instagram', handle: '@trips', channel_id: 3, niche_id: 2, niche_name: 'Travel' }), post(14, { title: 'Bread at home' })],
    items: [{ kind: 'topic', id: 1, title: 'Street food trends', niche_id: 2, channel_id: null, niche_name: 'Travel', step: 'pick', owner: 'evaluator', status: 'candidate', age_h: 5, source: 'Search trends' },
      { kind: 'post', id: 21, title: 'Scripting now', niche_id: 1, channel_id: 1, niche_name: 'Cooking', platform: 'youtube', step: 'script', owner: 'script_writer', status: 'working', age_h: 30, in_step_h: 30, window_h: 12, overdue: true, rejection_count: 0, state: 'drafted' },
      { kind: 'post', id: 22, title: 'Render broke', niche_id: 1, channel_id: 2, niche_name: 'Cooking', platform: 'tiktok', step: 'render', owner: 'editor', status: 'failed', age_h: 8, in_step_h: 8, window_h: 6, overdue: false, rejection_count: 0, state: 'drafted' },
      { kind: 'post', id: 11, title: 'Five minute soup', niche_id: 1, channel_id: 1, niche_name: 'Cooking', platform: 'youtube', step: 'approval', owner: 'user', status: 'waiting', age_h: 3, in_step_h: 3, rejection_count: 0, state: 'awaiting_approval' },
      { kind: 'post', id: 23, title: 'Ready to post', niche_id: 2, channel_id: 3, niche_name: 'Travel', platform: 'instagram', step: 'publish', owner: 'publisher', status: 'waiting', age_h: 50, in_step_h: 20, rejection_count: 0, state: 'approved' },
      { kind: 'post', id: 24, title: 'Already live', niche_id: 2, channel_id: 3, niche_name: 'Travel', platform: 'instagram', step: 'tracking', owner: 'executor', status: 'posted', age_h: 100, in_step_h: 90, rejection_count: 0, state: 'posted' },
      { kind: 'post', id: 26, title: 'YouTube ready', niche_id: 1, channel_id: 1, niche_name: 'Cooking', platform: 'youtube', step: 'publish', owner: 'publisher', status: 'waiting', age_h: 4, in_step_h: 2, rejection_count: 0, state: 'approved' }],
    decisions: [{ id: 1, kind: 'retire', subject_type: 'channel', subject_id: 1, subject_name: 'youtube:@cooks', status: 'awaiting_user', reason: 'Below half the team median two reviews running.', at: now - 3600,
      numbers: { score: 20.5, team_median: 71.5, posts_scored: 12, age_days: 30 } },
    { id: 2, kind: 'promote', subject_type: 'niche', subject_id: 2, subject_name: 'Travel', status: 'confirmed', reason: 'Takes the freed slot.', at: now - 86400, numbers: { score: 71.5, slots_after: 2 } },
    { id: 4, kind: 'add', subject_type: 'niche', subject_id: 0, subject_name: 'Deep sea', status: 'awaiting_user', reason: 'A replacement for Chess.', at: now - 7200,
      numbers: { live_niches: 2, cap: 5 }, payload: { name: 'Deep sea', source: 'https://trends.example.test/deep-sea', signal: 'up 40% in 30 days' } }],
    metrics: { 35: [{ post_id: 35, taken_at: at(3, 20), views: 300, avg_view_duration_s: 18, likes: 10, comments: 1, shares: 0, follows_gained: 2, source: 'youtube' },
      { post_id: 35, taken_at: at(4, 20), views: 1240, avg_view_duration_s: 21.4, likes: 84, comments: 6, shares: 3, follows_gained: 9, source: 'youtube' }],
      34: [{ post_id: 34, taken_at: at(4, 21), views: 860, avg_view_duration_s: 14, likes: 40, comments: 2, shares: 5, follows_gained: 4, source: 'page-read' }] },
    posted: [{ id: 24, title: 'Already live', posted_url: 'https://youtu.be/LIVE1234567' }, { id: 25, title: 'Second live', posted_url: 'https://youtu.be/LIVE7654321' }] });
};

// Pack A characters (routes/character_routes.py): one character with an approved version and a draft.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const pipSpec = { name: 'Pip', family: 'round', accessory: 'leaf', outline: 7, palette: { body: '#f4a259', body_shade: '#e0843d', head: '#f7c08a', accent: '#7cc6a4' } };
const cast = { characters: [{ id: 'abcdefabcdef', name: 'Pip', family: 'round', approved_version: 1, versions: [
  { version: 1, status: 'approved', note: 'First version.', reason: '', sheet: true, sheet_url: '/api/characters/abcdefabcdef/versions/1/sheet.png' },
  { version: 2, status: 'draft', note: 'Warmer orange', reason: '', sheet: false, sheet_url: null }] }] };
const pending = () => cast.characters.flatMap(c => c.versions.filter(v => v.status === 'awaiting_approval').map(v => ({ id: c.id, name: c.name, family: c.family, ...v })));
function characters(method, p, body) {
  if (p === '/api/characters' && method === 'GET') return [200, { characters: cast.characters, pending: pending() }];
  if (p === '/api/characters' && method === 'POST') {
    const c = { id: 'bbbbbbbbbbbb', name: body.name || 'Bo', family: body.family, approved_version: null, versions: [{ version: 1, status: 'draft', note: 'First version.', reason: '', sheet: false, sheet_url: null }] };
    cast.characters.push(c); return [200, c];
  }
  const m = /^\/api\/characters\/([a-f0-9]{12})(?:\/versions(?:\/(\d+))?(?:\/(sheet|approve|reject))?)?$/.exec(p);
  const c = m && cast.characters.find(x => x.id === m[1]);
  if (!c) return [404, { detail: 'No such character.' }];
  const v = m[2] && c.versions.find(x => x.version === Number(m[2]));
  if (!m[2] && p.endsWith('/versions')) { c.versions.push({ version: c.versions.length + 1, status: 'draft', note: body.note, reason: '', sheet: false, sheet_url: null }); return [200, c]; }
  if (m[3] === 'sheet') { Object.assign(v, { status: 'awaiting_approval', sheet: true, sheet_url: `/api/characters/${c.id}/versions/${v.version}/sheet.png` }); return [200, c]; }
  if (m[3] === 'approve') { v.status = 'approved'; c.approved_version = v.version; return [200, c]; }
  if (m[3] === 'reject') { Object.assign(v, { status: 'rejected', reason: body.reason }); return [200, c]; }
  return [200, { ...c, spec: pipSpec }];
}

// User-made style packs (routes/style_pack_routes.py): an approved starter pack and a draft made from a brief.
const packSpec = name => ({ name, summary: `${name} in flat shapes.`, renderer: '2d-engine', base: 'flat-2d', director_brief: `The brief of ${name}.\nSecond paragraph.`,
  look: { design_look: 'nordic', palette: { sky: ['#173d7a', '#3f7bc8'] }, families: ['round', 'square'], outline: 7, lighting: 'glow' },
  characters: [{ character: 'abcdefabcdef', version: 1 }], scenes: { settings: ['meadow', 'space'], shots: ['wide', 'close'], props: ['sun'], cameras: ['still', 'push'], transitions: ['cut'] },
  pacing: { words_per_second: 2.6, shot_seconds: [2, 8], hook_seconds: 5 }, captions: { on: true, case: 'sentence' }, music: { mood: 'calm', volume: .55 }, voice: { voice: 'af_heart' } });
const packVersion = (id, version, status, extra = {}) => ({ version, status, note: 'First version.', reason: '', sample: status === 'draft' ? null : { status: 'ready', notes: [] },
  sample_url: status === 'draft' ? null : `/api/style-packs/${id}/versions/${version}/sample.mp4`, sheet_url: status === 'draft' ? null : `/api/style-packs/${id}/versions/${version}/sample-sheet.png`,
  export_url: `/api/style-packs/${id}/export?v=${version}`, ...extra });
const styles = { packs: [
  { id: 'aaaaaaaaaaaa', name: 'Flat science explainer', origin: { kind: 'starter', from: 'flat-science-explainer' }, approved_version: 1, spec: packSpec('Flat science explainer'),
    versions: [packVersion('aaaaaaaaaaaa', 1, 'approved', { note: 'The starter pack.' })] },
  { id: 'cccccccccccc', name: 'Night mode', origin: { kind: 'brief', from: 'david' }, approved_version: null, spec: packSpec('Night mode'),
    versions: [packVersion('cccccccccccc', 1, 'draft', { note: 'From a brief.' })] }],
  built_in: [{ id: 'motion-type', name: 'Motion type', available: true, note: 'Kinetic type.' }, { id: 'glossy-3d', name: 'Glossy 3D mascot', available: false, note: 'Not built yet (build unit 5).' }],
  available: [{ id: 'motion-type', name: 'Motion type' }, { id: 'flat-2d', name: 'Flat 2D explainer' }, { id: 'aaaaaaaaaaaa', name: 'Flat science explainer' }],
  starters: [{ id: 'flat-science-explainer', name: 'Flat science explainer', summary: 'Flat science.' }] };
const pendingPacks = () => styles.packs.flatMap(k => k.versions.filter(v => v.status === 'awaiting_approval').map(v => ({ id: k.id, name: k.name, ...v })));
function stylePacks(method, p, body) {
  if (p === '/api/style-packs' && method === 'GET') return [200, { ...styles, pending: pendingPacks() }];
  if (p === '/api/style-packs' || p === '/api/style-packs/import') {
    const id = 'dddddddddddd'.slice(0, 11) + styles.packs.length;
    const k = { id, name: body?.name || 'New pack', origin: { kind: body?.source || 'import' }, approved_version: null, spec: packSpec(body?.name || 'New pack'), versions: [packVersion(id, 1, 'draft')] };
    styles.packs.push(k); return [200, k];
  }
  const m = /^\/api\/style-packs\/([a-f0-9]{12})\/versions(?:\/(\d+)\/(sample|approve|reject))?$/.exec(p);
  const k = m && styles.packs.find(x => x.id === m[1]);
  if (!k) return [404, { detail: 'No such style pack.' }];
  if (!m[2]) { k.versions.push(packVersion(k.id, k.versions.length + 1, 'draft', { note: body.note })); return [200, k]; }
  const v = k.versions.find(x => x.version === Number(m[2]));
  if (m[3] === 'sample') Object.assign(v, packVersion(k.id, v.version, 'awaiting_approval'));
  if (m[3] === 'approve') { v.status = 'approved'; k.approved_version = v.version; }
  if (m[3] === 'reject') Object.assign(v, { status: 'rejected', reason: body.reason });
  return [200, k];
}

function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
async function serve(req, res) {
  const url = new URL(req.url, 'http://localhost'), p = url.pathname;
  if (p.startsWith('/api/')) {
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      body = (req.headers['content-type'] || '').startsWith('multipart/form-data') ? { multipart: raw.includes('kairos.style-pack') } : raw ? JSON.parse(raw) : {};
      writes.push({ path: p, method: req.method, body });
    }
    if (/^\/api\/characters\/[a-f0-9]{12}\/versions\/\d+\/sheet\.png$/.test(p)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PIXEL); return; }
    if (p.startsWith('/api/characters')) { const [status, value] = characters(req.method, p, body); return json(res, value, status); }
    if (/^\/api\/style-packs\/[a-f0-9]{12}\/versions\/\d+\/sample(\.mp4|-sheet\.png)$/.test(p)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PIXEL); return; }
    if (p.startsWith('/api/style-packs')) { const [status, value] = stylePacks(req.method, p, body); return json(res, value, status); }
    // A long video's plan decision is the person's own route on the video (routes/video_routes.py).
    if (/^\/api\/videos\/[a-f0-9]{12}\/plan\/(approve|reject)$/.test(p)) { store.plans = store.plans.filter(v => !p.includes(v.video_id)); return json(res, { status: p.endsWith('approve') ? 'approved' : 'rejected' }); }
    if (p.startsWith('/api/content-studio/')) { const [status, value] = content(req.method, p.slice('/api/content-studio'.length), body); return json(res, value, status); }
    if (p === '/api/system/custom-tabs') return json(res, [customTab]);
    if (p === '/api/tab-studio/looks') return json(res, { default: 'sport', looks: [{ id: 'sport', name: 'Sport' }] });
    if (p === '/api/videos/ffmpeg') return json(res, { found: true, message: '' });
    if (p === '/api/videos') return json(res, []);
    if (p === '/api/bot-lifecycle/templates') return json(res, { teams: [{ id: 'research-desk', name: 'Research desk', description: 'A small research team.', package: {} }, { id: 'content-studio', name: 'Content Studio', description: 'A seven-bot team.', package: {} }],
      ready: ['Juno', 'Compass', 'Pantry', 'Harbor', 'Brief', 'Lookout', 'Cairn', 'Ferry', 'Inkwell', 'Plain', 'Orchard', 'Wayfarer', 'Loom', 'Tally', 'Trellis'].map(name => ({ name })) });
    if (p === '/api/bot-lifecycle/packages/inspect') return json(res, { token: 'tok', preview: { name: 'Content Studio', bots: [{ key: 'producer', name: 'Producer', role: 'Leads the team' }], sections: ['departments'] } });
    if (p === '/api/chat/live/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: [] })}\n\n`);
      return;
    }
    if (p === '/api/system/tabs') return json(res, [{ slug: 'studio', name: 'Studio', blurb: 'Make and edit videos', enabled: true, kind: 'prebuilt' }]);
    try { return json(res, fixture(url)); } catch (error) { errors.push(error.message); return json(res, { detail: 'Missing fixture: ' + p }, 404); }
  }
  const tabFile = /^\/tab-files\/studio\/(view\.js|view\.css)$/.exec(p);
  const file = tabFile ? path.join(root, 'tabs/studio', tabFile[1]) : path.resolve(root, p === '/' ? 'static/index.html' : '.' + decodeURIComponent(p));
  if (!tabFile && !file.startsWith(path.join(root, 'static') + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
}
async function acquireLock() {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let n = 0; n < 120; n++) {
    try { fs.mkdirSync(lock); ownsLock = true; return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await pause(1000);
  }
  throw Error('Another Electron test holds data/electron.lock');
}
function cleanup() {
  if (win && !win.isDestroyed()) win.destroy();
  server?.close();
  if (ownsLock) { fs.rmdirSync(lock); ownsLock = false; }
}
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  try {
    await acquireLock(); fs.mkdirSync(output, { recursive: true });
    server = http.createServer((req, res) => { serve(req, res).catch(error => { errors.push(error.stack); json(res, { detail: error.message }, 500); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const allow = details.url.startsWith(base + '/') || details.url.startsWith('data:') || details.url.startsWith('blob:') || details.url === 'about:blank';
      if (!allow) outside.push(details.url); cb({ cancel: !allow });
    });
    win = new BrowserWindow({ width: 1440, height: 1000, show: false, useContentSize: true, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    const js = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + ' | in: ' + String(code).slice(0, 240)); });
    const wait = async expression => {
      for (let n = 0; n < 300; n++) { if (await js(expression)) return; await pause(50); }
      throw Error('Timed out: ' + expression);
    };
    const T = JSON.stringify;
    // Click the first element matching a selector whose text equals (or starts with) the label.
    const click = async (selector, text) => { await wait(`[...document.querySelectorAll(${T(selector)})].some(n=>n.textContent===${T(text)}||n.getAttribute('aria-label')===${T(text)})`);
      await js(`[...document.querySelectorAll(${T(selector)})].find(n=>n.textContent===${T(text)}||n.getAttribute('aria-label')===${T(text)}).click()`); await pause(120); };
    const fill = async (label, value) => js(`(() => { const n=document.querySelector('[aria-label=${T(label)}]'); n.value=${T(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    const last = (suffix, method = 'POST') => writes.filter(w => w.path.endsWith(suffix) && w.method === method).at(-1);
    const shotsDir = process.env.STUDIO_CONTENT_SHOTS;   // also keep every capture there (for David)
    const capture = async name => { await pause(150); const png = (await win.webContents.capturePage()).toPNG(); fs.writeFileSync(path.join(output, name + '.png'), png);
      if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); fs.writeFileSync(path.join(shotsDir, name + '.png'), png); } };
    const noOverflow = async () => assert.equal(await js("document.documentElement.scrollWidth > innerWidth + 2 || [...document.querySelectorAll('.studio-view,.sc')].some(n=>n.scrollWidth>n.clientWidth+2)"), false, 'No sideways scroll');
    const labels = async () => assert.deepEqual(await js(`[...document.querySelectorAll('.sc button,.sc input,.sc textarea,.sc select')].filter(n=>!(n.getAttribute('aria-label')||n.textContent.trim()||n.labels?.length)).map(n=>n.outerHTML)`), [], 'Every control has a label');
    // Wait for the tab first: right after Content opens (or a reload) the tab bar is still being drawn, and clicking at
    // once threw on a missing tab about 1 run in 3 (release gate, 2.3.0-beta.3).
    const tab = async name => { await wait(`!!document.querySelector('.sc-tab[data-tab=${T(name)}]')`);
      await js(`document.querySelector('.sc-tab[data-tab=${T(name)}]').click()`); await pause(150); };
    const scopeTo = async value => { await wait(`!!document.querySelector('.sc-rail [data-scope=${T(String(value))}]')`);
      await js(`document.querySelector('.sc-rail [data-scope=${T(String(value))}]').click()`); await wait(`document.querySelector('.sc-shell')?.dataset.scope===${T(String(value))}`); await pause(150); };
    const bodyText = () => js("document.querySelector('.sc-body').textContent");
    let loads = 0;
    const openContent = async () => { await win.loadURL(base + '/?load=' + (++loads) + '#/studio'); await wait("!!document.querySelector('.studio-sections')");
      await js("document.getElementById('onboarding-overlay')?.classList.add('hidden')"); await click('.studio-sections button', 'Content'); };

    // 1. Empty state: the team in two lines, with the template and channel buttons.
    await openContent();
    await wait("!!document.querySelector('.sc-empty')");
    assert.ok(await js("document.querySelector('.sc-empty').textContent.includes('Kairos never creates accounts')"));
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-empty button')].map(b=>b.textContent)"), ['Add the Content Studio team', 'Add a channel']);
    assert.equal(await js("document.querySelectorAll('.sc-empty p').length"), 2, 'Two lines of explanation');
    await capture('desktop-empty'); await noOverflow(); await labels();
    win.setContentSize(390, 900); await pause(350); await noOverflow(); await capture('phone-empty');
    win.setContentSize(1440, 1000); await pause(350);
    // The Templates popup opened from Studio looks exactly like the one opened from Bots (it once rendered unstyled, because the
    // Bots look is scoped to [data-app-mode="bots"]) and opens straight on the Content Studio team's preview, in both themes.
    const tplShots = process.env.STUDIO_TEMPLATES_SHOTS;   // also keep the popup's screenshots there (for David)
    const keepShot = async name => { await capture(name); if (tplShots) { fs.mkdirSync(tplShots, { recursive: true }); fs.copyFileSync(path.join(output, name + '.png'), path.join(tplShots, name + '.png')); } };
    const popupStyle = () => js(`(() => { const pick = (n, props) => Object.fromEntries(props.map(k => [k, getComputedStyle(n)[k]]));
      const tabs = document.querySelector('.bots-lifecycle-tabs'), tab = document.querySelector('.bots-lifecycle-tabs button');
      return { tabs: pick(tabs, ['display', 'backgroundColor', 'borderRadius', 'padding', 'gap']),
        tab: pick(tab, ['backgroundColor', 'color', 'borderRadius', 'borderTopWidth', 'paddingLeft', 'fontFamily', 'fontSize', 'minHeight']),
        selected: pick(document.querySelector('.bots-lifecycle-tabs [aria-selected=true]'), ['backgroundColor']),
        tabCount: tabs.querySelectorAll('button').length }; })()`);
    const waitPopup = async () => { await wait("!!document.querySelector('.bots-lifecycle-dialog') && !!document.querySelector('.bots-lifecycle-tabs button')"); await pause(300); };
    const closePopup = async () => { await js("document.querySelector('.bots-lifecycle-dialog .modal-close-btn').click()"); await wait("!document.querySelector('.bots-lifecycle-dialog')"); };
    for (const [theme, color] of [['light', '#f3eadb'], ['dark', '#15171d']].filter(([t]) => !process.env.STUDIO_TEMPLATES_THEME || process.env.STUDIO_TEMPLATES_THEME === t)) {
      await js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: ${T(color)} }))`); await pause(300);
      assert.notEqual(await js("document.documentElement.dataset.appMode"), 'bots', 'Studio is not in Bots mode');
      await click('.sc-empty button', 'Add the Content Studio team');
      await waitPopup(); await keepShot('templates-popup-studio-opened-' + theme);
      await wait("[...document.querySelectorAll('.bots-package-preview h3')].some(h=>h.textContent==='Content Studio')");
      assert.equal(await js("document.querySelector('.bots-lifecycle-dialog').textContent.includes('Their teams')"), true, theme + ': the Content Studio team preview is shown');
      const fromStudio = await popupStyle();
      await keepShot('templates-popup-studio-preview-' + theme);
      await js("[...document.querySelectorAll('.bots-lifecycle-tabs button')].find(b=>b.textContent==='Explore').click()");
      await wait("document.querySelectorAll('.bots-lifecycle-card').length===2 && document.querySelectorAll('.bots-lifecycle-content > button').length===15");
      const chipsStudio = await js("(() => { const b=document.querySelector('.bots-lifecycle-content > button'), c=getComputedStyle(b); return [c.backgroundColor, c.borderRadius, c.paddingLeft, c.fontFamily, c.minHeight]; })()");
      await keepShot('templates-popup-studio-explore-' + theme);
      await closePopup();
      // The same popup from Bots mode, the reference.
      await js("document.documentElement.dataset.appMode='bots'");
      await js("import('/static/js/botsTemplates.js').then(m => m.openTemplates({ tab: 'explore' }).then(() => 0))");
      await waitPopup(); await wait("document.querySelectorAll('.bots-lifecycle-content > button').length===15");
      const fromBots = await popupStyle();
      const chipsBots = await js("(() => { const b=document.querySelector('.bots-lifecycle-content > button'), c=getComputedStyle(b); return [c.backgroundColor, c.borderRadius, c.paddingLeft, c.fontFamily, c.minHeight]; })()");
      await keepShot('templates-popup-bots-explore-' + theme);
      await closePopup();
      await js("delete document.documentElement.dataset.appMode");
      assert.deepEqual(fromStudio, fromBots, theme + ': the popup tabs look the same from Studio as from Bots');
      assert.deepEqual(chipsStudio, chipsBots, theme + ': the popup name chips look the same from Studio as from Bots');
      assert.notEqual(fromStudio.tab.borderRadius, '0px', theme + ': tabs are styled, not default buttons');
    }
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'default' }))"); await pause(300);

    // 2. Add a channel with a new niche. Kairos says it never creates accounts.
    await click('.sc-empty button', 'Add a channel');
    await wait("!!document.querySelector('.sc-dialog')");
    assert.ok(await js("document.querySelector('.sc-dialog').textContent.includes('Kairos never creates accounts')"));
    await click('.sc-dialog-panel button', 'Add channel');
    assert.ok(await js("document.querySelector('.sc-dialog .set-error').textContent.includes('Name the niche')"), 'A niche name is required');
    await fill('New niche name', 'Cooking'); await fill('Platform', 'tiktok'); await fill('Channel handle', '@cooks.tt');
    await click('.sc-dialog-panel button', 'Add channel');
    await wait("!document.querySelector('.sc-dialog')");
    assert.deepEqual(writes.filter(w => w.path.startsWith('/api/content-studio/')).map(w => [w.path.split('/api/content-studio')[1], w.body]),
      [['/niches', { name: 'Cooking' }], ['/channels', { niche_id: 1, platform: 'tiktok', handle: '@cooks.tt' }]]);
    await wait("!!document.querySelector('.sc-tabs')");

    // 3. Populated data: the rail, the overview dashboard, the warning shown and resolved with a confirmation.
    populate();
    await openContent();
    await wait("!!document.querySelector('.sc-alert') && !!document.querySelector('.sc-tile-needs')");
    assert.ok(await js("document.querySelector('.sc-alert').textContent.includes('Reused content notice')"), 'Warning text is shown at the top');
    assert.equal(await js("document.querySelector('.sc-shell').dataset.scope"), 'all', 'Opens on All channels');
    assert.equal(await js("document.querySelector('.sc-tab[aria-selected=true]').dataset.tab"), 'dashboard', 'Opens on the dashboard');
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tab')].map(t=>t.textContent)"), ['Dashboard', 'Approvals 4', 'Pipeline', 'Calendar', 'Publishing', 'Analytics', 'Report']);
    // The rail: All channels, each channel under its niche with its avatar and platform, Add channel, then the libraries.
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-rail-top > *')].map(n=>n.classList.contains('sc-rail-heading') ? '# '+n.textContent : n.dataset.scope ? n.dataset.scope+' '+n.querySelector('.sc-rail-name').textContent : n.textContent)"),
      ['all All channels', '# Cooking', '1 @cooks', '2 @cooks.tt', '# Travel', '3 @trips', 'Add channel']);
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-rail-item[data-scope=\"1\"], .sc-rail-item[data-scope=\"3\"]')].map(n=>[n.querySelector('.sc-avatar').textContent, n.querySelector('.sc-rail-sub').textContent, n.getAttribute('aria-label')])"),
      [['C', 'YouTube Paused', 'YouTube @cooks, paused, 3 waiting for you'], ['T', 'Instagram Archived', 'Instagram @trips, archived, 2 waiting for you']]);
    assert.equal(await js("document.querySelector('.sc-rail-item[data-scope=all]').getAttribute('aria-current')"), 'page');
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-rail-lower button')].map(b=>b.textContent)"), ['Editor', 'Formats', 'Styles', 'Characters', 'Connections', 'Templates']);
    // The overview dashboard's cards.
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tile')].map(t=>t.dataset.tile)"), ['needs', 'latest', 'analytics', 'report', 'upcoming', 'pipeline', 'channels']);
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tile-needs .sc-need')].map(b=>b.textContent)"),
      ['4 posts to approve', '2 prepared posts waiting for you to post them', '1 preparation that failed', '2 team decisions to confirm']);
    const latestText = await js("document.querySelector('.sc-tile-latest').textContent");
    for (const part of ['Clouds weigh tons', 'YouTube @cooks', '1.2K views, 21 s average view, 84 likes', 'TikTok @cooks.tt', '860 views, 14 s average view, 40 likes']) assert.ok(latestText.includes(part), part);
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tile-latest [data-latest]')].map(n=>n.dataset.latest)"), ['35', '34'], 'newest first');
    const analyticsText = await js("document.querySelector('.sc-tile-analytics').textContent");
    for (const part of ['18posts posted', '14with 7 day numbers', '71.5best niche, Travel', 'Judged after 3 weeks and 10 posts.']) assert.ok(analyticsText.includes(part), part);
    assert.ok((await js("document.querySelector('.sc-tile-report').textContent")).includes('What won: Travel (71.5).'));
    // Coming up: the posts scheduled from now on, soonest first (the mock's week is this week, so it depends on today).
    const upcomingIds = channelId => store.pubItems.filter(i => i.scheduled_at && i.scheduled_at >= Date.now() / 1000 && !['posted', 'rejected'].includes(i.state) && (channelId == null || i.channel_id === channelId))
      .sort((a, b) => a.scheduled_at - b.scheduled_at).map(i => String(i.post_id));
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tile-upcoming [data-pub]')].map(n=>n.dataset.pub)"), upcomingIds(null), 'Coming up lists scheduled posts');
    assert.ok((await js("document.querySelector('.sc-tile-pipeline').textContent")).includes('1Topic'));
    assert.ok(!(await bodyText()).includes('—'), 'No em-dashes in the copy');
    await capture('overview-dashboard'); await noOverflow(); await labels();
    // A dashboard row jumps to its tab: the posts to approve.
    await js("document.querySelector('.sc-need[data-need=approvals]').click()");
    await wait("document.querySelector('.sc-tab[aria-selected=true]')?.dataset.tab==='approvals'");
    // The tabs move with the arrow keys.
    await js("document.querySelector('.sc-tab[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
    await wait("document.querySelector('.sc-tab[aria-selected=true]')?.dataset.tab==='pipeline' && document.activeElement?.dataset.tab==='pipeline'");

    // 3a. A channel: its dashboard, then Settings with the warning, archive and restore, and its look.
    await scopeTo(1);
    await wait("!!document.querySelector('.sc-tile-latest')");
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tab')].map(t=>t.textContent)"), ['Dashboard', 'Pipeline', 'Calendar', 'Approvals 2', 'Publishing', 'Analytics', 'Settings']);
    assert.ok(await js("document.querySelector('.sc-head').textContent.includes('@cooks') && document.querySelector('.sc-head').textContent.includes('Niche Cooking') && document.querySelector('.sc-head').textContent.includes('Paused')"));
    assert.equal(await js("document.querySelector('.sc-rail-item[data-scope=\"1\"]').getAttribute('aria-current')"), 'page');
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tile')].map(t=>t.dataset.tile)"), ['latest', 'numbers', 'needs', 'upcoming', 'pipeline', 'look']);
    const latestOne = await js("document.querySelector('.sc-tile-latest').textContent");
    for (const part of ['Clouds weigh tons', '1.2Kviews', '21 saverage view', '84likes', '6comments', '3shares', '9follows gained', '(youtube)']) assert.ok(latestOne.includes(part), part);
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tile-needs .sc-need')].map(b=>b.textContent)"), ['2 posts to approve', '1 prepared post waiting for you to post it']);
    assert.ok((await js("document.querySelector('.sc-tile-numbers').textContent")).includes('1posts posted'));
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-tile-upcoming [data-pub]')].map(n=>n.dataset.pub)"), upcomingIds(1));
    await capture('channel-dashboard'); await noOverflow(); await labels();
    await tab('settings');
    await wait("!!document.querySelector('.sc-warning')");
    assert.ok(await js("document.querySelector('.sc-warning').textContent.includes('Reused content notice')"), 'Warning on the channel');
    assert.ok(await js("document.querySelector('[data-cadence]').textContent.includes('1 posting slot')"), 'Cadence names the niche slots');
    await js("document.querySelector('.sc-row-warning button[aria-label=\"Resolve warning for @cooks\"]').click()");
    await wait("!!document.querySelector('.confirm-panel')");
    await click('.confirm-panel button', 'Cancel');
    assert.equal(writes.filter(w => w.path.includes('/resume')).length, 0, 'Resolving asks first');
    await js("document.querySelector('.sc-row-warning button[aria-label=\"Resolve warning for @cooks\"]').click()");
    await wait("!!document.querySelector('.confirm-panel')");
    await click('.confirm-panel button', 'Resume channel');
    await wait("!document.querySelector('.sc-warning') && !document.querySelector('.sc-alert')");
    assert.ok(last('/channels/1/resume'));
    assert.equal(await js("document.querySelector('.sc-tab[aria-selected=true]').dataset.tab"), 'settings', 'A reload keeps the channel and tab');
    // Archive asks first; restore does not.
    await scopeTo(2); await tab('settings');
    await js("document.querySelector('button[aria-label=\"Archive TikTok @cooks.tt\"]').click()");
    await wait("!!document.querySelector('.confirm-panel')");
    await click('.confirm-panel button', 'Archive');
    await wait("document.querySelector('[data-channel-id=\"2\"] .set-pill')?.textContent==='Archived'");
    assert.ok(last('/channels/2/archive'));
    assert.ok(await js("document.querySelector('.sc-rail-item[data-scope=\"2\"]').textContent.includes('Archived')"), 'The rail says archived');
    await js("document.querySelector('button[aria-label=\"Restore TikTok @cooks.tt\"]').click()");
    await wait("document.querySelector('[data-channel-id=\"2\"] .set-pill')?.textContent==='Live'");
    assert.ok(last('/channels/2/restore'));
    // A channel's look: the Editor and Script Writer follow it.
    await scopeTo(1); await tab('settings');
    await wait("!!document.querySelector('[aria-label=\"Look id\"]')");
    assert.ok(await js("document.querySelector('[data-channel-id=\"1\"]').textContent.includes('No look set')"));
    assert.deepEqual(await js("[...document.querySelector('[aria-label=\"Style pack\"]').options].map(o=>o.textContent)"),
      ['Motion type (default)', 'Flat 2D explainer', 'Flat science explainer'], 'Only approved packs are offered');
    await fill('Look id', 'sport'); await fill('Aspect', '16:9'); await fill('Voice notes', 'Calm, curious.'); await fill('Narrator voice', 'af_heart');
    await fill('Style pack', 'aaaaaaaaaaaa');
    assert.equal(await js("document.querySelector('[aria-label=\"Long videos a week\"]').value"), '1', 'One long video a week on YouTube by default');
    await fill('Long videos a week', '2');
    // Pack B: the 3D renderer is shown plainly; without Blender on the computer it cannot be picked.
    assert.deepEqual(await js("[...document.querySelector('[aria-label=\"3D renderer\"]').options].map(o=>[o.textContent, o.disabled])"),
      [["The style pack's choice", false], ['three.js (built in)', false], ['Blender (not installed)', true]]);
    // Step 6: the channel's frame rate.
    await js("(() => { const s = document.querySelector('[aria-label=\"Frame rate\"]'); s.value = '60'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    // Pack C: the channel says honestly whether its videos are made for kids (not set until the person answers).
    assert.deepEqual(await js("[...document.querySelector('[aria-label=\"Made for kids\"]').options].map(o=>o.value)"), ['', 'no', 'yes']);
    await js("(() => { const s = document.querySelector('[aria-label=\"Made for kids\"]'); s.value = 'yes'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await capture('channel-settings'); await noOverflow(); await labels();
    await click('.sc button', 'Save the settings of YouTube @cooks');
    await wait("document.querySelector('[data-channel-id=\"1\"]')?.textContent.includes('style Flat science explainer, look sport, 16:9, voice notes set')");
    assert.deepEqual(last('/channels/1/edit').body, { look: 'sport', aspect: '16:9', notes: 'Calm, curious.', voice: 'af_heart', style_pack: 'aaaaaaaaaaaa', renderer: '', fps: 60, made_for_kids: 'yes', long_per_week: 2 });
    assert.equal(await js("document.querySelector('[data-scope=\"1\"] .sc-avatar').style.getPropertyValue('--avatar-hue') !== document.querySelector('[data-scope=\"2\"] .sc-avatar').style.getPropertyValue('--avatar-hue')"), true, 'The avatar colour follows the look');
    await noOverflow(); await labels();
    // The account's connections live in a library: YouTube analytics not connected offers Connect; posting is connected with its privacy.
    await scopeTo('lib:connections');
    await wait("!!document.querySelector('[data-youtube=analytics]')");
    assert.equal(await js("!!document.querySelector('.sc-tabs')"), false, 'A library has no tabs');
    assert.ok(await js("document.querySelector('[data-youtube=analytics]').textContent.includes('Not connected') && !!document.querySelector('button[aria-label=\"Connect YouTube analytics\"]')"));
    assert.ok(await js("document.querySelector('[data-youtube=posting]').textContent.includes('As me@example.com') && document.querySelector('[data-youtube=posting]').textContent.includes('API audit')"));
    assert.ok(await js("document.querySelector('[data-niche-id=\"1\"]').textContent.includes('1 posting slot. 2 channels.')"), 'The niches with their slots');
    await fill('Privacy of YouTube uploads', 'unlisted');
    for (let n = 0; n < 100 && !last('/posting/youtube/privacy', 'PUT'); n++) await pause(50);
    assert.deepEqual(last('/posting/youtube/privacy', 'PUT').body, { privacy: 'unlisted' });
    await capture('library-connections'); await noOverflow(); await labels();

    // 4. The pipeline board: steps, owner, age, overdue flag; a click opens the details. Every channel, then one.
    await scopeTo('all'); await tab('pipeline');
    await wait("document.querySelectorAll('.sc-col').length===6");
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-col-title')].map(t=>t.firstChild.textContent)"), ['Topic', 'Scripting', 'Rendering', 'Awaiting approval', 'Approved', 'Posted']);
    assert.ok(await js("document.querySelector('[data-column=scripting] .sc-item').textContent.includes('Script Writer') && document.querySelector('[data-column=scripting] .sc-item').textContent.includes('30h')"));
    assert.ok(await js("document.querySelector('[data-column=scripting] .sc-item').textContent.includes('Overdue')"));
    assert.ok(await js("document.querySelector('[data-column=rendering] .sc-item').textContent.includes('Render failed')"));
    assert.equal(await js("document.querySelectorAll('[data-column=topic] .sc-item').length"), 1);
    await capture('overview-pipeline'); await noOverflow(); await labels();
    await js("document.querySelector('[data-item=post-23]').click()");
    await wait("!!document.querySelector('.sc-dialog .sc-preview')");
    assert.ok(await js("document.querySelector('.sc-dialog').textContent.includes('Prepare post assembles it for its platform')"));
    assert.equal(await js("[...document.querySelectorAll('.sc-dialog button')].find(b=>b.textContent==='Prepare post').disabled"), false, 'Prepare post is built');
    await fill('Link to the live post', 'https://www.instagram.com/p/abc');
    await click('.sc-dialog button', 'Mark posted');
    await wait("!document.querySelector('.sc-dialog')");
    assert.deepEqual(last('/posts/23/posted').body, { url: 'https://www.instagram.com/p/abc' });
    assert.equal(writes.filter(w => w.path.endsWith('/publish-youtube')).length, 0, 'An Instagram post has no direct posting');
    // An approved YouTube post can go out through the person's own Google project, after a confirmation.
    await js("document.querySelector('[data-item=post-26]').click()");
    await wait("!!document.querySelector('.sc-dialog .sc-preview')");
    await click('.sc-dialog button', 'Post to YouTube');
    await wait("!!document.querySelector('.confirm-panel')");
    assert.ok(await js("document.querySelector('.confirm-panel').textContent.includes('exactly as approved') && document.querySelector('.confirm-panel').textContent.includes('AI-content label')"));
    await click('.confirm-panel button', 'Post to YouTube');
    await wait("!document.querySelector('.sc-dialog')");
    assert.ok(last('/posts/26/publish-youtube'));
    // One channel's pipeline: its own posts only. The Travel channel also sees its niche's topics.
    await scopeTo(1); await tab('pipeline');
    await wait("!!document.querySelector('.sc-board')");
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-item')].map(n=>n.dataset.item).sort()"), ['post-11', 'post-21', 'post-26']);
    await capture('channel-pipeline'); await noOverflow(); await labels();
    await scopeTo(3); await tab('pipeline');
    await wait("!!document.querySelector('.sc-board')");
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-item')].map(n=>n.dataset.item).sort()"), ['post-23', 'post-24', 'topic-1']);

    // 5. Approvals: preview, then Approve / Edit / Reject with a note / Redraft call the right endpoints. One channel first.
    await scopeTo(1); await tab('approvals');
    await wait("document.querySelectorAll('.sc-post').length===2");
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-post')].map(n=>n.dataset.postId)"), ['11', '14'], 'only this channel\'s posts');
    await capture('channel-approvals'); await noOverflow(); await labels();
    await scopeTo('all'); await tab('approvals');
    await wait("document.querySelectorAll('.sc-post').length===4");
    const card = id => `.sc-post[data-post-id="${id}"]`;
    const text = await js(`document.querySelector(${T(card(11))}).textContent`);
    for (const part of ['Five minute soup', '@cooks', 'A caption', 'Hook, three steps, ask', 'Open render', 'AI label', 'Required', 'you press Post yourself',
      'Format: One person at a time (ported). Style pack: Motion type.', 'A pot with a glowing number']) assert.ok(text.includes(part), part);
    assert.equal(await js(`!!document.querySelector('.sc-post[data-post-id="12"] [data-post-format]')`), false, 'No format block without a format');
    assert.ok((await js(`document.querySelector(${T(card(13))}).textContent`)).includes('Not needed'), 'Instagram needs no AI label');
    assert.ok((await bodyText()).includes('Nothing is posted by approving'));
    await capture('overview-approvals');
    await js("document.querySelector('button[aria-label=\"Approve Five minute soup\"]').click()");
    await wait("document.querySelectorAll('.sc-post').length===3");
    assert.deepEqual(last('/posts/11/approve').body, {});
    // Edit: only the changed fields are sent.
    await js("document.querySelector('button[aria-label=\"Edit Pasta in one pan\"]').click()");
    await wait("!!document.querySelector('.sc-edit')");
    await fill('Caption', 'A better caption');
    await click('.sc-edit button', 'Save changes');
    await wait("!document.querySelector('.sc-edit')");
    assert.deepEqual(last('/posts/12/edit').body, { caption: 'A better caption' });
    // Reject carries the note.
    await js("document.querySelector('button[aria-label=\"Reject Pasta in one pan\"]').click()");
    await wait("!!document.querySelector('[aria-label=\"Why are you rejecting this?\"]')");
    await fill('Why are you rejecting this?', 'Too long for a short');
    await click('.sc-post button', 'Reject post');
    await wait("document.querySelectorAll('.sc-post').length===2");
    assert.deepEqual(last('/posts/12/reject').body, { reason: 'Too long for a short' });
    // Redraft rejects with the note, then sends the post back to drafting.
    await js("document.querySelector('button[aria-label=\"Redraft Sauce basics\"]').click()");
    await wait("!!document.querySelector('[aria-label=\"What should change?\"]')");
    await fill('What should change?', 'Open with the result');
    await click('.sc-post button', 'Send back for redraft');
    await wait("document.querySelectorAll('.sc-post').length===1");
    assert.deepEqual(last('/posts/13/reject').body, { reason: 'Open with the result' });
    assert.ok(last('/posts/13/redraft'));
    assert.equal(await js("!!document.querySelector('.sc-batch')"), false, 'No batch button while batch approval is off');
    // With batch approval on, one tap approves the posts shown, after a confirmation.
    store.settings.batch_approval = true;
    store.approvals.push(post(15, { title: 'Soup two' }));
    await pause(1100); await openContent(); await tab('approvals');
    await wait("!!document.querySelector('button[aria-label=\"Approve all 2 posts\"]')");
    await js("document.querySelector('button[aria-label=\"Approve all 2 posts\"]').click()");
    await wait("!!document.querySelector('.confirm-panel')");
    await click('.confirm-panel button', 'Approve all');
    await wait("document.querySelectorAll('.sc-post').length===0");
    assert.deepEqual(last('/approvals/approve-batch').body, { post_ids: [14, 15] });
    // A long video's shot plan waits in Approvals before it renders: chapters, every shot, Approve or Reject with a note.
    store.plans = [{ video_id: 'abcabcabcabc', title: 'The Moon, in depth', seconds: 213, version: 3, submitted_by: 'Editor', post_id: 30,
      chapters: [{ title: 'Our nearest neighbour', start: 0 }, { title: 'Why the Moon changes shape', start: 61.2 }, { title: 'The pull behind the tides', start: 125 }],
      text: 'Chapter 1 at 0:00: Our nearest neighbour (61 s)\n  00:00.0-00:05.1 hook scene: says "Look up tonight."' }];
    await pause(1100); await openContent(); await tab('approvals');
    await wait("!!document.querySelector('.sc-plan')");
    const ptext = await js("document.querySelector('.sc-plan').textContent");
    for (const part of ['Long video plan: The Moon, in depth', '3.6 min', '3 chapters', '00:00 Our nearest neighbour', '01:01 Why the Moon changes shape', 'renders only after you approve']) assert.ok(ptext.includes(part), part);
    assert.equal(await js("document.querySelector('.sc-tab[data-tab=approvals]').textContent"), 'Approvals 1');
    await capture('desktop-plan'); await noOverflow(); await labels();
    await js("document.querySelector('button[aria-label=\"Approve the plan of The Moon, in depth\"]').click()");
    await wait("!document.querySelector('.sc-plan')");
    assert.ok(last('/api/videos/abcabcabcabc/plan/approve'));

    // 5a. Publishing: every post with its state, schedule, link and next action; the calendar; the prepared post's
    // checklist; Prepare post, Schedule, Open upload page (the desktop bridge stand-in) and Mark posted.
    const shots = process.env.STUDIO_PUBLISHING_SHOTS;   // also keep the dashboard's screenshots there (for David)
    const keep = async name => { await capture(name); if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.copyFileSync(path.join(output, name + '.png'), path.join(shots, name + '.png')); } };
    await win.loadURL(base + '/?load=' + (++loads) + '#/studio'); await wait("!!document.querySelector('.studio-sections')");
    await js("document.getElementById('onboarding-overlay')?.classList.add('hidden')");
    await js("window.__prepared = []; window.jarvis = { ...(window.jarvis || {}), browse: { preparePost: async id => { window.__prepared.push(id); return { ok: true, tabId: 4 }; }, onPrepareProgress: h => { window.__progress = h; return () => {}; } } }; true");
    await click('.studio-sections button', 'Content');
    await tab('publishing');
    await wait("document.querySelectorAll('.sc-pub').length===9");
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-pub')].map(n=>[n.dataset.pub, n.querySelector('.set-pill').textContent])"), [
      ['31', 'Waiting for you to press Post'], ['32', 'Prepared'], ['33', 'Failed'], ['34', 'Posted'], ['35', 'Posted'], ['26', 'Approved'],
      ['11', 'Waiting for your approval'], ['21', 'Drafted'], ['36', 'Rejected']], 'every state, labelled');
    const pubText = await bodyText();
    for (const part of ['stops before Post, which you press yourself', 'You: Check the TikTok page and press Post yourself', 'Kairos filled: Video, Caption, AI label.',
      'Scheduled for', 'Posted ', 'https://www.tiktok.com/@sky.kairos/video/7350000000000000001', 'Team: The Publisher prepares it', 'You: Fix it and try again']) assert.ok(pubText.includes(part), part);
    assert.ok(!pubText.includes('—'), 'No em-dashes in the copy');
    assert.equal(await js("document.querySelector('.sc-routes')"), null, 'Routes are per channel');
    assert.equal(await js("document.querySelector('[data-pub=\"34\"] a').getAttribute('rel')"), 'noopener noreferrer');
    assert.deepEqual(await js("[...document.querySelectorAll('[data-pub=\"32\"] .sc-actions button')].map(b=>b.textContent)"), ['Post to YouTube', 'Open upload page', 'Checklist', 'Schedule', 'Mark posted']);
    assert.deepEqual(await js("[...document.querySelectorAll('[data-pub=\"33\"] .sc-actions button')].map(b=>b.textContent)"), ['Open upload page', 'Checklist', 'Schedule', 'Mark posted', 'Prepare again']);
    assert.equal(await js("[...document.querySelectorAll('.sc-filters button')].map(b=>b.textContent).join('|')"),
      'All 9|To post 2|Drafted 1|Waiting for your approval 1|Approved 1|Prepared 1|Waiting for you to press Post 1|Posted 2|Failed 1|Rejected 1');
    await keep('publishing-list'); await noOverflow(); await labels();
    // Filter to one state, and to both states that wait for Post.
    await click('.sc-filters button', 'Posted 2');
    await wait("document.querySelectorAll('.sc-pub').length===2");
    await click('.sc-filters button', 'To post 2');
    await wait("document.querySelectorAll('.sc-pub').length===2 && !!document.querySelector('.sc-pub[data-pub=\"31\"]') && !!document.querySelector('.sc-pub[data-pub=\"32\"]')");
    await click('.sc-filters button', 'All 9');
    await wait("document.querySelectorAll('.sc-pub').length===9");
    // The checklist of a prepared post: what Kairos fills and what you do, the text with Copy, the rules note.
    await js("document.querySelector('button[aria-label=\"Checklist for Why the sky is blue on YouTube\"]').click()");
    await wait("!!document.querySelector('.sc-checklist')");
    const ctext0 = await js("document.querySelector('.sc-prepared').textContent");
    for (const part of ['9-16-v2.mp4, 9:16, 00:31', "the editor's export", 'Sunlight scatters off the air.', 'Altered or synthetic content: on', 'post-32.jpg: A blue sky over a sun',
      'Press Publish yourself. Kairos never presses it.', 'not checked against the platforms']) assert.ok(ctext0.includes(part), part);
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-check')].map(li=>li.dataset.check+':'+li.querySelector('.set-pill').textContent)").then(r => r.slice(0, 3)), ['file:Kairos', 'title:Kairos', 'description:Kairos']);
    assert.equal(await js("document.querySelectorAll('.sc-prepared button.sc-copy').length"), 3, 'Copy for title, description and tags');
    await keep('publishing-checklist'); await noOverflow(); await labels();
    // Open upload page from the checklist: the desktop bridge gets the prepared post's id only.
    await click('.sc-dialog-panel .sc-actions button', 'Open upload page');
    await wait("window.__prepared.length===1");
    assert.deepEqual(await js('window.__prepared'), [8]);
    await wait("!document.querySelector('.sc-checklist')");
    // The fill's report reloads the dashboard.
    const loadsBefore = writes.length;
    await js("window.__progress({ prepId: 8, stage: 'done', filled: ['file', 'title'], missing: [] }); true");
    await pause(300);
    assert.equal(writes.length, loadsBefore, 'a progress report writes nothing');
    // Prepare post on an approved post.
    await click('.sc-pub button', 'Prepare post');
    await wait("document.querySelector('[data-pub=\"26\"] .set-pill').textContent==='Prepared'");
    assert.deepEqual(last('/posts/26/prepare').body, {});
    // Schedule it.
    await js("document.querySelector('button[aria-label=\"Schedule YouTube ready on YouTube\"]').click()");
    await wait("!!document.querySelector('[aria-label=\"When to post\"]')");
    const when = new Date((at(4, 11) + 7 * 86400) * 1000); const two = n => String(n).padStart(2, '0');
    await fill('When to post', `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}T15:30`);
    await click('.sc-dialog-panel button', 'Save schedule');
    await wait("!document.querySelector('[aria-label=\"When to post\"]')");
    assert.equal(new Date(last('/posts/26/schedule').body.at * 1000).getHours(), 15);
    // Mark posted: the live link.
    await js("document.querySelector('button[aria-label=\"Mark Why the sky is blue on TikTok posted\"]').click()");
    await wait("!!document.querySelector('[aria-label=\"Link to the live post\"]')");
    await fill('Link to the live post', 'https://www.tiktok.com/@sky.kairos/video/7350000000000000002');
    await click('.sc-dialog-panel button', 'Mark posted');
    await wait("!document.querySelector('[aria-label=\"Link to the live post\"]')");
    assert.deepEqual(last('/posts/31/posted').body, { url: 'https://www.tiktok.com/@sky.kairos/video/7350000000000000002' });
    assert.equal(writes.filter(w => /\/(publish-youtube)$/.test(w.path) && w.path.includes('/32/')).length, 0, 'Nothing posts without the person');
    // The calendar of every channel.
    await tab('calendar');
    await wait("document.querySelectorAll('.sc-day').length===7");
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-day')].map(d=>d.querySelectorAll('.sc-cal').length)"), [1, 1, 1, 2, 1, 1, 1], 'posts on their days (the scheduled one moved to next week)');
    assert.match(await js("document.querySelector('.sc-week-title').textContent"), /^This week, /);
    await keep('publishing-week'); await capture('overview-calendar'); await noOverflow(); await labels();
    await click('.sc-week-nav button', 'Next week');
    await wait("document.querySelector('.sc-week-title').textContent.startsWith('Week of')");
    assert.equal(await js("document.querySelectorAll('.sc-cal').length"), 1, 'the scheduled post moved to next week');
    await click('.sc-week-nav button', 'This week');
    await wait("document.querySelector('.sc-week-title').textContent.startsWith('This week')");
    await js("document.querySelector('.sc-cal[data-pub=\"32\"]').click()");
    await wait("!!document.querySelector('.sc-checklist')");
    await js("document.querySelector('.sc-dialog-panel .modal-close-btn, .sc-dialog-panel [aria-label=Close]')?.click()");
    await pause(200);
    if (await js("!!document.querySelector('.sc-checklist')")) await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await wait("!document.querySelector('.sc-checklist')");
    win.setContentSize(390, 1000); await pause(350); await noOverflow(); await labels(); await keep('publishing-week-phone');
    await tab('publishing'); await pause(200); await noOverflow(); await keep('publishing-list-phone');
    win.setContentSize(1440, 1000); await pause(350);
    // One channel's calendar and publishing: its own posts, and how its posts go out (YouTube adds direct posting).
    await scopeTo(1); await tab('calendar');
    await wait("document.querySelectorAll('.sc-day').length===7");
    assert.equal(await js("[...document.querySelectorAll('.sc-cal')].every(n=>n.getAttribute('aria-label').includes('YouTube @cooks'))"), true, 'only this channel on its calendar');
    await capture('channel-calendar'); await noOverflow(); await labels();
    await tab('publishing');
    await wait("!!document.querySelector('.sc-routes')");
    assert.deepEqual(await js("[...document.querySelectorAll('[data-publish-route]')].map(n=>n.dataset.publishRoute)"), ['prepare', 'youtube-api']);
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-pub')].map(n=>n.dataset.pub)"), ['32', '35', '26', '11', '21']);
    assert.ok(await js("document.querySelector('[data-publish-route=prepare]').textContent.includes('You press Publish yourself')"));
    await capture('channel-publishing'); await noOverflow(); await labels();
    await scopeTo(2); await tab('publishing');
    await wait("!!document.querySelector('.sc-routes')");
    assert.deepEqual(await js("[...document.querySelectorAll('[data-publish-route]')].map(n=>n.dataset.publishRoute)"), ['prepare', 'page-reads']);
    // Connections: the TikTok and Instagram page-read switches, off until the person turns them on.
    await scopeTo('lib:connections');
    await wait("!!document.querySelector('[data-page-reads=tiktok]')");
    assert.ok(await js("document.querySelector('[data-page-reads=tiktok]').textContent.includes('Off. Turn it on')"));
    assert.ok((await bodyText()).includes('may stop working when TikTok or Instagram change their pages'), 'labelled as page-read');
    await js("document.querySelector('[aria-label=\"Read TikTok numbers from your signed-in pages\"]').click()");
    for (let n = 0; n < 100 && !last('/analytics/pages', 'PUT'); n++) await pause(50);
    assert.deepEqual(last('/analytics/pages', 'PUT').body, { tiktok: true });
    await wait("document.querySelector('[data-page-reads=tiktok]').textContent.includes('3 of 40 page reads today')");
    await click('.sc button', 'Read TikTok numbers now');
    for (let n = 0; n < 100 && !last('/analytics/pages/read'); n++) await pause(50);
    assert.deepEqual(last('/analytics/pages/read').body, { platform: 'tiktok' });
    await js("document.querySelector('[aria-label=\"Read Instagram numbers from your signed-in pages\"]').click()");
    await wait("!!document.querySelector('button[aria-label=\"Try Instagram page reads again\"]')");
    assert.ok(await js("document.querySelector('[data-page-reads=instagram]').textContent.includes('may have changed its page')"));
    await keep('publishing-page-reads'); await noOverflow(); await labels();

    // 5b. Formats: cards with every number and its date, ports with what changes and the checks. It only reads.
    await scopeTo('lib:formats');
    await wait("!!document.querySelector('.sc-format')");
    const ftext = await js("document.querySelector('.sc-format').textContent");
    for (const part of ['One person at a time', 'An impossible ability', '1 to 5 minutes', 'Glimpse Lab. 1,200,000 views, 12 days old when seen. Checked 2026-11-10.',
      'Not ours to use', 'Mister Glimpse', 'From Pop psychology into Cooking', 'Because: Both audiences', 'Pip the owl', 'Every dish has a secret number',
      'Audience match: Passed', 'Distance from the source: Passed', 'Cost to make: Warning', 'Series rule: Passed', 'The Evaluator: Same audience']) assert.ok(ftext.includes(part), part);
    assert.ok(await js("document.querySelector('[data-port-id=\"4\"]').textContent.includes('Cost to make: Refused') && document.querySelector('[data-port-id=\"4\"]').textContent.includes('Glossy 3D mascot')"), 'A refused port says why');
    assert.ok(await js("document.querySelector('[data-pack=\"glossy-3d\"]').textContent.includes('Not built yet')"));
    assert.equal(await js("document.querySelector('[data-evidence]').querySelector('a').getAttribute('rel')"), 'noopener noreferrer');
    assert.ok(!(await bodyText()).includes('—'), 'No em-dashes in the copy');
    assert.equal(writes.filter(w => w.path.includes('/formats')).length, 0, 'Formats only reads');
    await capture('library-formats'); await noOverflow(); await labels();

    // 5c. Characters (Pack A): versions with their sheets; making a sheet sends it to Approvals, where only the person approves.
    await scopeTo('lib:characters');
    await wait("!!document.querySelector('.sc-character')");
    const ctext = await js("document.querySelector('.sc-character').textContent");
    for (const part of ['Pip', 'Round family. Videos can cast version 1.', 'Version 2', 'Draft, no sheet yet', 'Warmer orange', 'Version 1', 'Approved']) assert.ok(ctext.includes(part), part);
    assert.ok(await js("!!document.querySelector('[data-character-version=\"abcdefabcdef-1\"] img.sc-sheet-thumb')"), 'An approved version shows its sheet');
    await capture('library-characters'); await noOverflow(); await labels();
    await click('.sc button', 'Make the sheet of Pip version 2');
    for (let n = 0; n < 100 && !last('/api/characters/abcdefabcdef/versions/2/sheet'); n++) await pause(50);
    await click('.sc button', 'Review Pip version 2');
    await wait("document.querySelector('.sc-tab[aria-selected=true]')?.dataset.tab==='approvals' && document.querySelector('.sc-tab[data-tab=approvals]').textContent==='Approvals 1'");
    await wait("!!document.querySelector('[data-sheet=\"abcdefabcdef-2\"]')");
    assert.ok(await js("document.querySelector('[data-sheet=\"abcdefabcdef-2\"] img').alt.includes('every view, expression and mouth shape')"));
    await capture('desktop-sheet-approval'); await labels();
    await click('.sc button', 'Approve Pip, version 2');
    await wait("!document.querySelector('[data-sheet]')");
    assert.ok(last('/api/characters/abcdefabcdef/versions/2/approve'));
    await scopeTo('lib:characters');
    await wait("!!document.querySelector('.sc-character') && document.querySelector('.sc-character').textContent.includes('Videos can cast version 2.')");
    await click('.sc button', 'New version of Pip');
    await wait("!!document.querySelector('.sc-dialog [aria-label=Accessory]')");
    await click('.sc-dialog-panel button', 'Save new version');
    await wait("document.querySelector('.sc-dialog .set-error').textContent.includes('Change something first')");
    await fill('Accessory', 'cap'); await fill('What changed', 'A cap for winter');
    await click('.sc-dialog-panel button', 'Save new version');
    await wait("!document.querySelector('.sc-dialog')");
    assert.deepEqual(last('/api/characters/abcdefabcdef/versions').body, { changes: { accessory: 'cap' }, note: 'A cap for winter' });
    await click('.sc button', 'New character');
    await wait("!!document.querySelector('.sc-dialog [aria-label=Family]')");
    await fill('Family', 'square'); await fill('Name', 'Bo');
    await click('.sc-dialog-panel button', 'Make character');
    await wait("!document.querySelector('.sc-dialog')");
    assert.deepEqual(last('/api/characters').body, { family: 'square', name: 'Bo' });
    assert.ok(!(await bodyText()).includes('—'), 'No em-dashes in the copy');
    await pause(1100);

    // 5d. Styles: the account's own style packs. Make one from a brief, duplicate, edit the brief, import, render a sample,
    // and approve it in Approvals (only the person approves). Export and Share are offered on an approved pack.
    await scopeTo('lib:styles');
    await wait("document.querySelectorAll('.sc-style-pack').length===2");
    const stext = await bodyText();
    for (const part of ['Flat science explainer', 'Starter pack. Channels and videos use version 1.', 'Night mode',
      'Made from a written brief (david). Not approved yet', 'Draft, no sample yet', 'Not approved yet, so no channel can use it.', 'Show the brief', 'Built into Kairos',
      'Flat 2D with characters, its own palette, glow light', 'You approve each pack from its sample']) assert.ok(stext.includes(part), part);
    assert.ok(!stext.includes('Add Flat science explainer'), 'The starter pack is offered only until it is added');
    assert.ok(!stext.includes('—'), 'No em-dashes in the copy');
    assert.equal(await js("document.querySelector('a[aria-label=\"Export Flat science explainer\"]').getAttribute('href')"), '/api/style-packs/aaaaaaaaaaaa/export?v=1');
    assert.deepEqual(await js("[...document.querySelectorAll('.sc-style-pack')].map(g=>[...g.querySelectorAll('button')].some(b=>b.textContent==='Share'))"), [true, false], 'Only an approved pack is shared');
    await capture('library-styles'); await noOverflow(); await labels();
    await click('.sc button', 'Make the sample of Night mode version 1');
    for (let n = 0; n < 100 && !last('/api/style-packs/cccccccccccc/versions/1/sample'); n++) await pause(50);
    await scopeTo('all'); await tab('approvals');
    await wait("document.querySelector('.sc-tab[data-tab=approvals]').textContent==='Approvals 1' && !!document.querySelector('[data-pack-approval=\"cccccccccccc-1\"] video')");
    assert.ok(await js("document.querySelector('[data-pack-approval=\"cccccccccccc-1\"] img').alt.includes('Contact sheet')"));
    await capture('desktop-pack-approval'); await labels();
    await click('.sc button', 'Approve Night mode, version 1');
    await wait("!document.querySelector('[data-pack-approval]')");
    assert.ok(last('/api/style-packs/cccccccccccc/versions/1/approve'));
    await scopeTo('lib:styles');
    await wait("document.querySelectorAll('.sc-style-pack').length===2");
    await click('.sc button', 'New from a brief');
    await wait("!!document.querySelector('.sc-dialog [aria-label=Brief]')");
    await click('.sc-dialog-panel button', 'Make pack');
    await wait("document.querySelector('.sc-dialog .set-error').textContent.includes('Write the brief first')");
    await fill('Brief', 'Calm ocean explainers. Deep teal water, slow pans, gentle music.'); await fill('Name', 'Ocean calm');
    await click('.sc-dialog-panel button', 'Make pack');
    await wait("!document.querySelector('.sc-dialog')");
    assert.deepEqual(last('/api/style-packs').body, { source: 'brief', brief: 'Calm ocean explainers. Deep teal water, slow pans, gentle music.', name: 'Ocean calm' });
    await wait("document.querySelectorAll('.sc-style-pack').length===3");
    await click('.sc button', 'Duplicate Flat science explainer');
    await wait("!!document.querySelector('.sc-dialog [aria-label=Name]')");
    await click('.sc-dialog-panel button', 'Duplicate');
    await wait("!document.querySelector('.sc-dialog')");
    assert.deepEqual(last('/api/style-packs').body, { source: 'duplicate', pack_id: 'aaaaaaaaaaaa', name: 'Flat science explainer copy' });
    await wait("document.querySelectorAll('.sc-style-pack').length===4");
    await click('.sc button', 'Edit Night mode');
    await wait("!!document.querySelector('.sc-dialog [aria-label=\"Director brief\"]')");
    await click('.sc-dialog-panel button', 'Save new version');
    await wait("document.querySelector('.sc-dialog .set-error').textContent.includes('Change something first')");
    await fill('Director brief', 'A calmer brief.'); await fill('Caption case', 'upper'); await fill('What changed', 'Calmer');
    await click('.sc-dialog-panel button', 'Save new version');
    await wait("!document.querySelector('.sc-dialog')");
    assert.deepEqual(last('/api/style-packs/cccccccccccc/versions').body, { changes: { director_brief: 'A calmer brief.', captions: { on: true, case: 'upper' } }, note: 'Calmer' });
    await click('.sc button', 'Import');
    await wait("!!document.querySelector('.sc-dialog [aria-label=\"Style pack file\"]')");
    await click('.sc-dialog-panel button', 'Import');
    await wait("document.querySelector('.sc-dialog .set-error').textContent.includes('Choose a pack file')");
    await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ format: 'kairos.style-pack', format_version: 1 })], 'pack.kairos-style.json', { type: 'application/json' }));
      document.querySelector('[aria-label="Style pack file"]').files = dt.files; })()`);
    await click('.sc-dialog-panel button', 'Import');
    await wait("!document.querySelector('.sc-dialog')");
    assert.deepEqual(last('/api/style-packs/import').body, { multipart: true });
    await noOverflow(); await labels();
    assert.ok(!(await bodyText()).includes('—'), 'No em-dashes in the copy');
    await pause(1100);

    // 6. Analytics: the scoreboard (needs more data, scores, top posts, decisions with Confirm / Reject, team settings), then one channel's.
    await scopeTo('all'); await tab('analytics');
    await wait("!!document.querySelector('[data-score-row=Cooking]')");
    assert.ok(await js("document.querySelector('[data-score-row=Cooking]').textContent.includes('Needs more data')"));
    assert.ok(await js("document.querySelector('[data-score-row=Cooking]').textContent.includes('2 of 10 posts')"));
    assert.equal(await js("document.querySelector('[data-score-row=Travel] .sc-score').textContent"), '71.5');
    assert.ok(await js("document.querySelector('[data-score-row=\"Hook first\"]').textContent.includes('Needs more data')"));
    assert.ok((await bodyText()).includes('Judged after 3 weeks and 10 posts.'));
    assert.ok(await js("document.querySelector('[data-score-row=\"Motion type\"]').textContent.includes('Needs more data')"), 'Style packs are ranked');
    assert.ok((await bodyText()).includes('views 40, watch time 40, follows and engagement 20'));
    assert.ok(await js("document.querySelector('[data-top-post=\"35\"]').textContent.includes('Clouds weigh tons') && document.querySelector('[data-top-post=\"35\"] .sc-score').textContent==='64.2'"), 'Top posts');
    assert.ok(await js("document.querySelector('[data-decision-id=\"2\"]').textContent.includes('Promote niche Travel') && document.querySelector('[data-decision-id=\"2\"]').textContent.includes('score 71.5')"), 'Recent decision with numbers');
    assert.ok(await js("document.querySelector('[data-decision-id=\"1\"]').textContent.includes('team median 71.5')"), 'Awaiting decision with numbers');
    assert.ok(await js("document.querySelector('[data-decision-id=\"4\"]').textContent.includes('Add niche Deep sea') && document.querySelector('[data-decision-id=\"4\"]').textContent.includes('Source: https://trends.example.test/deep-sea')"), 'A proposed niche shows its evidence');
    // Team settings: the score weights and batch approval.
    assert.equal(await js("document.querySelector('[aria-label=\"Views at 7 days weight, percent\"]').value"), '40');
    await fill('Watch time weight, percent', '0'); await fill('Views at 7 days weight, percent', '0'); await fill('Follows and engagement weight, percent', '0');
    await click('.sc button', 'Save score weights');
    await wait("[...document.querySelectorAll('.sc .set-error')].some(n=>n.textContent.includes('above 0'))");
    assert.equal(writes.filter(w => w.path.endsWith('/settings') && w.method === 'PUT' && w.body.weights).length, 0, 'All-zero weights are not sent');
    await fill('Views at 7 days weight, percent', '50'); await fill('Watch time weight, percent', '30'); await fill('Follows and engagement weight, percent', '20');
    await click('.sc button', 'Save score weights');
    for (let n = 0; n < 100 && !last('/settings', 'PUT'); n++) await pause(50);
    assert.deepEqual(last('/settings', 'PUT').body, { weights: { views: 0.5, watch: 0.3, engagement: 0.2 } });
    await wait("!!document.querySelector('[aria-label=\"One-tap batch approval\"]')");
    await fill('One-tap batch approval', 'off');
    for (let n = 0; n < 100 && last('/settings', 'PUT').body.batch_approval !== false; n++) await pause(50);
    assert.deepEqual(last('/settings', 'PUT').body, { batch_approval: false });
    await capture('overview-analytics'); await noOverflow(); await labels();
    await js("document.querySelector('button[aria-label=\"Confirm: Retire channel youtube:@cooks\"]').click()");
    await wait("!!document.querySelector('.confirm-panel')");
    assert.ok(await js("document.querySelector('.confirm-panel').textContent.includes('Nothing is deleted')"));
    await click('.confirm-panel button', 'Confirm');
    await wait("!document.querySelector('button[aria-label=\"Confirm: Retire channel youtube:@cooks\"]')");
    assert.deepEqual(last('/decisions/1/confirm').body, { actor: 'user' });
    await js("document.querySelector('button[aria-label=\"Confirm: Add niche Deep sea\"]').click()");
    await wait("!!document.querySelector('.confirm-panel')");
    assert.ok(await js("document.querySelector('.confirm-panel').textContent.includes('Create them yourself')"), 'A new niche says the person creates its channels');
    await click('.confirm-panel button', 'Confirm');
    await wait("!document.querySelector('button[aria-label=\"Confirm: Add niche Deep sea\"]')");
    assert.deepEqual(last('/decisions/4/confirm').body, { actor: 'user' });
    store.decisions.push({ id: 3, kind: 'retire', subject_type: 'channel', subject_id: 2, subject_name: 'tiktok:@cooks.tt', status: 'awaiting_user', reason: 'Behind.', at: now, numbers: {} });
    await pause(1100); // identical reads within a second share one request (api.js)
    await tab('pipeline'); await tab('analytics');
    await wait("!!document.querySelector('button[aria-label^=\"Reject: \"]')");
    await js("document.querySelector('button[aria-label^=\"Reject: \"]').click()");
    await wait("!document.querySelector('button[aria-label^=\"Reject: \"]')");
    assert.ok(last('/decisions/3/reject'));
    // One channel's analytics: its numbers post by post, its niche on the scoreboard, its week, where its numbers come from.
    await scopeTo(1); await tab('analytics');
    await wait("!!document.querySelector('[data-post-numbers=\"35\"]')");
    assert.ok(await js("document.querySelector('[data-post-numbers=\"35\"]').textContent.includes('1.2K views, 21 s average view, 84 likes')"));
    assert.ok(await js("document.querySelector('[data-score-row=Cooking]').textContent.includes('Needs more data') && !!document.querySelector('[data-top-post=\"35\"]')"), 'its niche and its top post');
    assert.ok(await js("document.querySelector('[data-channel-report]').textContent.includes('Posted in the last 7 days')"));
    assert.ok(await js("document.querySelector('[data-numbers-source=youtube]').textContent.includes('Not connected')"));
    await capture('channel-analytics'); await noOverflow(); await labels();
    await scopeTo(2); await tab('analytics');
    await wait("!!document.querySelector('[data-numbers-source=tiktok]')");
    assert.ok(await js("document.querySelector('[data-post-numbers=\"34\"]').textContent.includes('860 views')"));

    // 7. Report and the numbers import.
    await scopeTo('all'); await tab('report');
    await wait("!!document.querySelector('[data-report]')");
    assert.ok(await js("document.querySelector('[data-report]').textContent.includes('What won: Travel (71.5)')"));
    await click('.sc button', 'Send to my Inbox');
    await pause(150); assert.ok(last('/report/send'));
    await fill('Paste CSV', 'Video title,Views,Average view duration,Video length,Likes\r\n"Already live","1,200",0:30,0:45,12\r\nSecond live,800,22,45,\r\nGhost video,5,1,45,0');
    await click('.sc button', 'Read columns');
    await wait("!!document.querySelector('select[aria-label=\"Column for Views\"]')");
    assert.equal(await js("document.querySelector('select[aria-label=\"Column for Views\"]').selectedOptions[0].textContent"), 'Views', 'Columns are guessed');
    assert.equal(await js("document.querySelector('select[aria-label=\"Column for Average view duration\"]').selectedOptions[0].textContent"), 'Average view duration');
    assert.ok(await js("document.querySelector('.sc-import-count').textContent.includes('2 of 3 rows ready')"));
    assert.ok(await js("document.querySelector('.sc-problems').textContent.includes('Line 4: no posted post matches')"), 'Unmatched rows are named');
    await capture('overview-report'); await noOverflow(); await labels();
    // Content keeps the Studio section bar and its own header; the editor hides them only while a video is open.
    assert.ok(await js("!document.querySelector('.studio-view').classList.contains('studio-editing') && !document.querySelector('.studio-sections').hidden && getComputedStyle(document.querySelector('.studio-view > .view-header')).display !== 'none'"), 'Content keeps its header and sections');
    await click('.sc-import button', 'Import 2 rows');
    for (let n = 0; n < 100 && !last('/metrics/import'); n++) await pause(50);
    assert.deepEqual(last('/metrics/import').body, { rows: [
      { post_id: 24, views: 1200, avg_view_duration_s: 30, video_length_s: 45, likes: 12 },
      { post_id: 25, views: 800, avg_view_duration_s: 22, video_length_s: 45 }] });

    // 7a. A dark base: the same dashboard in the person's own colour (working tokens only).
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: '#15171d' }))"); await pause(400);
    await scopeTo('all'); await tab('dashboard'); await wait("!!document.querySelector('.sc-tile-latest [data-latest]')");
    await capture('overview-dashboard-dark');
    await scopeTo(1); await wait("!!document.querySelector('.sc-tile-latest .sc-stats')"); await capture('channel-dashboard-dark');
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'default' }))"); await pause(400);

    // 7b. The rail's Editor opens Studio's video editor (the Videos section).
    await click('.sc-rail-lower button', 'Open the video editor');
    await wait("document.querySelector('.studio-sections [data-section=videos]')?.getAttribute('aria-selected')==='true' && !document.querySelector('.sc')");
    await click('.studio-sections button', 'Content');
    await wait("!!document.querySelector('.sc-shell')");

    // 8. Phone layout: the rail becomes a channel picker; nothing spills sideways and every control is at least 44px. The video
    // editor's stylesheet is loaded too (it stays in the page once a video was opened), so its dense desktop rules cannot reach Content.
    await js("new Promise(r => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/static/css/studio-editor.css'; l.onload = l.onerror = r; document.head.append(l); })");
    assert.ok(await js("[...document.styleSheets].some(s => (s.href || '').endsWith('/studio-editor.css') && s.cssRules.length > 20)"), 'Editor stylesheet loaded');
    win.setContentSize(390, 1000); await pause(350);
    assert.equal(await js("getComputedStyle(document.querySelector('.sc-rail')).display"), 'none', 'No rail on a phone');
    assert.deepEqual(await js("[...document.querySelector('.sc-picker select').options].map(o=>o.value)"), ['all', '1', '2', '3', 'lib:formats', 'lib:styles', 'lib:characters', 'lib:connections']);
    const phoneTargets = async name => {
      await pause(250); await noOverflow(); await labels();
      assert.deepEqual(await js("[...document.querySelectorAll('.sc button,.sc select,.sc input:not([type=checkbox]),.sc textarea')].filter(n=>n.getBoundingClientRect().height>0 && n.getBoundingClientRect().height<43).map(n=>n.outerHTML.slice(0,90))"), [], `Phone targets in ${name}`);
      await capture('phone-' + name);
    };
    const pick = async value => { await fill('Channel or library', String(value)); await wait(`document.querySelector('.sc-shell')?.dataset.scope===${T(String(value))}`); await pause(200); };
    await pick('all');
    for (const name of ['dashboard', 'approvals', 'pipeline', 'calendar', 'publishing', 'analytics', 'report']) { await tab(name); await phoneTargets('overview-' + name); }
    await pick(1);
    for (const name of ['dashboard', 'pipeline', 'calendar', 'approvals', 'publishing', 'analytics', 'settings']) { await tab(name); await phoneTargets('channel-' + name); }
    assert.ok(await js("(() => { const bar = document.querySelector('.sc-tabs'), on = bar.querySelector('[aria-selected=true]').getBoundingClientRect(), b = bar.getBoundingClientRect(); return on.left >= b.left - 1 && on.right <= b.right + 1; })()"), 'The open tab is in view on a phone');
    for (const lib of ['formats', 'characters', 'styles', 'connections']) { await pick('lib:' + lib); await phoneTargets('library-' + lib); }
    win.setContentSize(1440, 1000); await pause(350);

    // 9. A 403 reads as a plain sentence, and a signed-out account is told so.
    store.forbidden = true;
    await openContent();
    await wait("!!document.querySelector('.sc-error')");
    assert.match(await js("document.querySelector('.sc-error').textContent"), /Your account cannot open Content Studio/);
    store.forbidden = false;

    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    console.log(JSON.stringify({ ok: true, output, writes: writes.length, checks: ['empty state and template deep link', 'add channel', 'rail and overview dashboard', 'channel dashboard and tabs', 'channel settings', 'connections library', 'channel pipeline, calendar, approvals, publishing routes, analytics', 'dark base', 'editor from the rail', 'phone channel picker', 'warning shown and resolved', 'archive and restore', 'youtube connections and privacy', 'channel look', 'pipeline board', 'details', 'post to youtube', 'approve', 'edit', 'reject with note', 'redraft', 'batch approval', 'scoreboard needs more data', 'niche proposal', 'team settings', 'decisions confirm and reject', 'publishing dashboard, checklist, prepare, schedule, open upload page, mark posted, week calendar, page-read switches', 'format cards and ports', 'characters and sheet approval', 'style packs: brief, duplicate, edit, import, sample, approval', 'channel style pack', 'report', 'csv mapping and import', '390 phone', '403', 'offline'] }));
  } catch (error) {
    console.error(error.stack);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error(JSON.stringify({ errors, outside, output, writes: writes.slice(-6) })); process.exitCode = 1;
  } finally { cleanup(); exitAfterFlush(process.exitCode || 0); }
}).catch(error => { console.error(error); cleanup(); exitAfterFlush(1); });

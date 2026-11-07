// Pure checks for the Content section of Studio (static/js/studioContentModel.js).
// Run: node scripts/test_studio_content_model.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '../static/js/studioContentModel.js')).href);

  // Pipeline columns follow the spec's six steps; Rejected only appears when there is one.
  const item = (step, extra = {}) => ({ kind: 'post', id: Math.random(), step, age_h: 1, ...extra });
  const cols = M.boardColumns([item('pick'), item('script'), item('render'), item('queue'), item('approval'), item('publish'), item('tracking')]);
  assert.deepEqual(cols.map(c => c.title), ['Topic', 'Scripting', 'Rendering', 'Awaiting approval', 'Approved', 'Posted']);
  assert.equal(cols[2].items.length, 2, 'render and queue share Rendering');
  assert.equal(M.boardColumns([item('rejected')]).at(-1).title, 'Rejected');
  assert.equal(M.formatAge(0.2), '12m');
  assert.deepEqual([M.formatAge(5), M.formatAge(30), M.formatAge(72)], ['5h', '30h', '3d']);
  assert.deepEqual(M.cardFlags({ overdue: true, status: 'working' }), [['Overdue', 'warn']]);
  assert.deepEqual(M.cardFlags({ status: 'failed' }), [['Render failed', 'error']]);

  // Channel status and the warning text come from the watch.
  assert.deepEqual(M.channelState({ status: 'live', paused: 0 }), { label: 'Live', tone: 'ok' });
  assert.deepEqual(M.channelState({ status: 'live', paused: 1 }), { label: 'Paused', tone: 'error' });
  assert.deepEqual(M.channelState({ status: 'archived', paused: 0 }), { label: 'Archived', tone: 'muted' });
  const findings = [{ kind: 'platform_warning', channel_id: 4, severity: 'urgent', message: 'YouTube warned @cooks: Reused content notice. The channel is paused.' },
    { kind: 'spend_near_cap', severity: 'urgent', message: 'Spend is near the monthly cap.' }];
  assert.equal(M.warningFor(4, findings), 'YouTube warned @cooks: Reused content notice.');
  assert.equal(M.warningFor(5, findings), '');
  assert.deepEqual(M.urgentFindings(findings).map(f => f.kind), ['spend_near_cap']);
  const groups = M.groupChannels([{ id: 2, status: 'retired' }, { id: 1, status: 'live' }], [{ niche_id: 1, id: 9 }]);
  assert.deepEqual(groups.map(g => g.niche.id), [1, 2]);
  assert.equal(groups[0].channels.length, 1);

  // The AI label is required on YouTube and TikTok only; a render reference becomes a safe link.
  assert.equal(M.aiLabel('youtube').required, true);
  assert.equal(M.aiLabel('tiktok').required, true);
  assert.equal(M.aiLabel('instagram').required, false);
  assert.deepEqual(M.renderLink('abcdef123456'), { href: '#/studio/abcdef123456', label: 'Open in Studio', external: false });
  assert.equal(M.renderLink('https://example.com/v.mp4').external, true);
  assert.equal(M.renderLink('javascript:alert(1)').href, '', 'No script links');
  assert.equal(M.renderLink('//evil.example/x').href, '', 'No protocol-relative links');
  assert.equal(M.renderLink(''), null);

  // Scoreboard: a row without the minimum shows "needs more data" (no score text); ranked rows come first.
  const rows = [{ name: 'a', eligible: false, score: 80 }, { name: 'b', eligible: true, score: 40 }, { name: 'c', eligible: true, score: 60 }];
  assert.deepEqual(M.rankRows(rows).map(r => r.name), ['c', 'b', 'a']);
  assert.equal(M.scoreText(rows[0]), '');
  assert.equal(M.scoreText(rows[2]), '60.0');
  assert.equal(M.minimumText({ weeks: 3, posts: 10 }), 'Judged after 3 weeks and 10 posts.');
  assert.match(M.weightsText({ views: 0.4, watch: 0.4, engagement: 0.2 }), /views 40, watch time 40, follows and engagement 20/);

  // Decisions with their numbers, and the split by who must act.
  const retire = { id: 1, kind: 'retire', subject_type: 'niche', subject_name: 'Cooking', status: 'awaiting_user', at: 3,
    numbers: { score: 31.25, team_median: 68, posts_scored: 12, age_days: 24.4, winner: { name: 'Travel', score: 74 }, freed_slots: 1 } };
  assert.equal(M.decisionTitle(retire), 'Retire niche Cooking');
  assert.equal(M.decisionNumbers(retire), 'score 31.3, team median 68, Travel 74, 12 posts scored, 24 days of data, 1 slot freed');
  const split = M.sortDecisions([retire, { id: 2, status: 'proposed', at: 2 }, { id: 3, status: 'confirmed', at: 1 }]);
  assert.deepEqual([split.awaiting.length, split.producer.length, split.recent.length], [1, 1, 1]);

  // 401 and 403 get plain words.
  assert.match(M.loadFailure(new Error('401: Not signed in')), /signed out/);
  assert.match(M.loadFailure(new Error('403: Forbidden')), /cannot/);
  assert.equal(M.loadFailure(new Error('409: that channel is paused')), 'that channel is paused');

  // CSV: quotes, CRLF, tabs and a byte-order mark.
  const csv = '﻿Video title,"Views","Average view duration","Likes"\r\n"Soup, fast",1200,0:45,30\r\nPasta,"2,400",50,8\r\n';
  const parsed = M.parseCsv(csv);
  assert.deepEqual(parsed.headers, ['Video title', 'Views', 'Average view duration', 'Likes']);
  assert.deepEqual(parsed.rows[0], ['Soup, fast', '1200', '0:45', '30']);
  assert.equal(M.parseCsv('a\tb\n1\t2').rows[0][1], '2');
  assert.deepEqual([M.parseSeconds('1:23'), M.parseSeconds('83.5'), M.parseSeconds('1m 23s'), M.parseSeconds('0:01:05'), M.parseSeconds('x')], [83, 83.5, 83, 65, NaN]);
  assert.equal(M.parseCount('2,400'), 2400);
  assert.ok(Number.isNaN(M.parseCount('lots')));

  // Mapping: headers are guessed, then rows turn into the import endpoint's body.
  const mapping = M.guessMapping(parsed.headers);
  assert.deepEqual([mapping.post, mapping.views, mapping.avg_view_duration_s, mapping.likes, mapping.video_length_s], [0, 1, 2, 3, -1]);
  const posts = [{ id: 7, title: 'Soup, fast', posted_url: 'https://youtu.be/AAA111bbb' }, { id: 8, title: 'Pasta', posted_url: 'https://youtu.be/CCC222ddd' }];
  const built = M.buildImport(parsed.rows, mapping, posts, { defaultLength: 60 });
  assert.deepEqual(built.problems, []);
  assert.deepEqual(built.body, { rows: [
    { post_id: 7, views: 1200, avg_view_duration_s: 45, video_length_s: 60, likes: 30 },
    { post_id: 8, views: 2400, avg_view_duration_s: 50, video_length_s: 60, likes: 8 }] });
  // Without a video length anywhere a row is a problem, not a guess.
  const noLength = M.buildImport(parsed.rows, mapping, posts);
  assert.equal(noLength.body.rows.length, 0);
  assert.match(noLength.problems[0].text, /video length/);
  // Matching by id and by link; unknown posts are named and nothing is invented.
  assert.equal(M.matchPost('8', posts).id, 8);
  assert.equal(M.matchPost('youtu.be/AAA111bbb?t=3', posts).id, 7);
  assert.match(M.matchPost('Nope', posts).error, /no posted post/);
  assert.match(M.matchPost('99', posts).error, /not a posted post/);
  const bad = M.buildImport([['Ghost', '5', '1', '0']], mapping, posts, { defaultLength: 30 });
  assert.equal(bad.body.rows.length, 0);
  assert.equal(bad.problems[0].line, 2);
  // A proposed niche: its title, its numbers and the Researcher's evidence.
  const add = { kind: 'add', subject_type: 'niche', subject_name: 'Deep sea', numbers: { live_niches: 3, cap: 5 },
    payload: { source: 'https://trends.example.test', signal: 'up 40%' } };
  assert.equal(M.decisionTitle(add), 'Add niche Deep sea');
  assert.equal(M.decisionNumbers(add), '3 of 5 niches live');
  assert.equal(M.decisionEvidence(add), 'Source: https://trends.example.test. Signal: up 40%.');
  assert.equal(M.decisionEvidence({ kind: 'retire', payload: { source: 'x' } }), '');

  // Channel looks, YouTube connections, batch results and the score weights.
  assert.equal(M.channelLookText({}), 'No look set');
  assert.equal(M.channelLookText({ look: 'sport', aspect: '16:9', notes: 'Calm.' }), 'look sport, 16:9, voice notes set');
  assert.deepEqual(M.connectionState(null), ['Unavailable', 'muted']);
  assert.deepEqual(M.connectionState({ connected: true, needs_reconnect: true }), ['Reconnect', 'error']);
  assert.deepEqual(M.connectionState({ connected: false, pending: true }), ['Waiting for Google', 'warn']);
  assert.deepEqual(M.connectionState({ connected: true }), ['Connected', 'ok']);
  assert.match(M.analyticsText({ connected: false }), /never posts/);
  assert.match(M.analyticsText({ connected: true, google_account: { email: 'a@b.test' }, last_sync: null }), /As a@b\.test\. Not synced yet\./);
  assert.match(M.analyticsText({ connected: true, last_sync: 1_790_000_000, last_error: 'Quota.' }), /Last synced .*Quota\./);
  assert.equal(M.syncText({ stored: 1 }), 'Stored numbers for 1 post.');
  assert.match(M.syncText({ stored: 0, stopped: 'quota' }), /No new numbers yet\. YouTube's quota ran out/);
  assert.match(M.syncText({ stored: 2, channels_not_owned: ['@x'] }), /Not on this Google account: @x\./);
  assert.match(M.postingText({ connected: false }), /Prepare post stays the default/);
  assert.equal(M.publishText({ privacy: 'unlisted', note: '' }), 'Posted to YouTube as unlisted.');
  assert.equal(M.publishText({ privacy: 'private', note: 'YouTube kept it private.' }), 'YouTube kept it private.');
  assert.equal(M.batchText({ approved: [1, 2], skipped: [] }), 'Approved 2 posts.');
  assert.equal(M.batchText({ approved: [1], skipped: [{}] }), 'Approved 1 post. 1 could not be approved and still wait.');
  assert.deepEqual(M.weightPercents({ views: 0.4, watch: 0.4, engagement: 0.2 }), { views: 40, watch: 40, engagement: 20 });
  assert.deepEqual(M.weightPercents({ views: 1, watch: 1, engagement: 2 }), { views: 25, watch: 25, engagement: 50 });
  assert.deepEqual(M.weightsFromPercents({ views: '50', watch: '30', engagement: '20' }), { weights: { views: 0.5, watch: 0.3, engagement: 0.2 } });
  assert.match(M.weightsFromPercents({ views: '0', watch: '0', engagement: '0' }).error, /above 0/);
  assert.match(M.weightsFromPercents({ views: '120', watch: '0', engagement: '0' }).error, /Views at 7 days must be between 0 and 100/);
  assert.match(M.weightsFromPercents({ views: 'x', watch: '1', engagement: '1' }).error, /between 0 and 100/);
  for (const text of [M.analyticsText({}), M.postingText({}), M.batchText({ approved: [], skipped: [{}] })]) assert.ok(!text.includes('—'), 'no em-dashes');

  console.log('studio content model ok');
})().catch(error => { console.error(error); process.exit(1); });

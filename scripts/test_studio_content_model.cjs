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


  // Format cards and ports (build unit 2): every number with its date, checks in plain words, no em-dashes.
  assert.equal(M.formatLength(60, 300), '1 to 5 minutes');
  assert.equal(M.formatLength(45, 120), '45 seconds to 2 minutes');
  assert.equal(M.formatLength(180, 180), 'about 3 minutes');
  assert.equal(M.evidenceText({ views: 1200000, age_days: 12, checked: '2026-11-10' }), '1,200,000 views, 12 days old when seen. Checked 2026-11-10.');
  assert.equal(M.evidenceText({ checked: '2026-11-10', note: 'Reported by a course seller; unverified.' }), 'Checked 2026-11-10. Reported by a course seller; unverified.');
  assert.match(M.audienceText({ age_band: '16-30', interests: 'science', platform: 'youtube', why: 'Curiosity' }), /16-30, science, on YouTube\. Why they watch: Curiosity\./);
  assert.deepEqual(M.portChecks({}), []);
  assert.deepEqual(M.portChecks({ ok: false, findings: [{ check: 'distance', result: 'reject', reason: 'a' }, { check: 'cost', result: 'warn', reason: 'b' }] }),
    [['Audience match', 'Passed', 'ok'], ['Distance from the source', 'Refused', 'error'], ['Cost to make', 'Warning', 'warn'], ['Series rule', 'Passed', 'ok']]);
  assert.deepEqual(M.portReasons({ findings: [{ reason: 'a' }, { reason: 'b' }] }), ['a', 'b']);
  assert.deepEqual(M.portStatus({ status: 'proposed' }), ['With the Evaluator', 'accent']);
  assert.equal(M.packName('glossy-3d'), 'Glossy 3D mascot');
  assert.equal(M.packName('motion-type', [{ id: 'motion-type', name: 'Motion' }]), 'Motion');
  assert.equal(M.costText({ units: 20, ratio: 10 }), 'About 20 planning units, 10 times the cheapest pack that could make it.');
  assert.equal(M.costText({ units: 2, ratio: 1 }), 'About 2 planning units, the cheapest way to make it.');
  assert.equal(M.postFormatText({ format_id: 3, format_name: 'One person at a time', port_id: 2, style_pack: 'motion-type' }),
    'Format: One person at a time (ported). Style pack: Motion type.');
  assert.equal(M.postFormatText({}), '');
  assert.equal(M.decisionTitle({ kind: 'retire', subject_type: 'format', subject_name: 'Weak format' }), 'Retire format Weak format');
  for (const text of [M.formatLength(10, 600), M.evidenceText({ checked: 'x' }), M.costText({ units: 1, ratio: null })]) assert.ok(!text.includes('—'), 'no em-dashes');

  // Characters (Pack A): status pills, what a video may cast, and a new version's changes from the dialog.
  assert.deepEqual(M.characterStatus('awaiting_approval'), ['Waiting for your OK', 'accent']);
  assert.deepEqual(M.characterStatus('approved'), ['Approved', 'ok']);
  assert.equal(M.castableText({ approved_version: 2 }), 'Videos can cast version 2.');
  assert.equal(M.castableText({ approved_version: null }), 'No approved version yet, so no video can use it.');
  assert.equal(M.sheetUrl('abcdef123456', 3), '/api/characters/abcdef123456/versions/3/sheet.png');
  const spec = { name: 'Pip', accessory: 'leaf', palette: { body: '#f4a259', body_shade: '#e0843d', head: '#f7c08a', accent: '#7cc6a4' } };
  assert.deepEqual(M.characterChanges(spec, { body: '#F4A259', accent: '#123456', accessory: 'leaf', name: 'Pip' }), { palette: { accent: '#123456' } });
  assert.deepEqual(M.characterChanges(spec, { body: 'red', accessory: 'cap', name: ' Pippa ' }), { accessory: 'cap', name: 'Pippa' });
  assert.deepEqual(M.characterChanges(spec, {}), {});

  // Style packs: status pills by sample progress, what channels can do with a pack, its origin, facts and channel options.
  assert.deepEqual(M.packStatus({ status: 'draft', sample: null }), ['Draft, no sample yet', 'muted']);
  assert.deepEqual(M.packStatus({ status: 'draft', sample: { status: 'rendering' } }), ['Rendering its sample', 'accent']);
  assert.deepEqual(M.packStatus({ status: 'draft', sample: { status: 'waiting for character sheets' } }), ['Waiting for character sheets', 'warn']);
  assert.deepEqual(M.packStatus({ status: 'draft', sample: { status: 'failed: no desktop app' } }), ['Sample failed', 'warn']);
  assert.deepEqual(M.packStatus({ status: 'awaiting_approval' }), ['Waiting for your OK', 'accent']);
  assert.equal(M.packUseText({ approved_version: 2, spec: { renderer: '2d-engine' } }), 'Channels and videos use version 2.');
  assert.equal(M.packUseText({ approved_version: null, spec: { renderer: '2d-engine' } }), 'Not approved yet, so no channel can use it.');
  // Pack C (unit 6): a blocky world pack renders with three.js, says so, and asks for the made-for-kids answer.
  assert.equal(M.packUseText({ approved_version: 1, spec: { renderer: 'threejs', base: 'voxel-3d' } }), 'Channels and videos use version 1.');
  const blocky = { base: 'voxel-3d', renderer: 'threejs', look: { design_look: 'nordic', families: ['round'], palette: 'dawn', lighting: 'soft' }, characters: [],
    scenes: { settings: ['meadow', 'cave'], shots: ['wide'], cameras: ['still'], transitions: ['cut'], times: ['day', 'night'] },
    pacing: { words_per_second: 2.6, shot_seconds: [2, 7], hook_seconds: 5 }, captions: { on: true, case: 'sentence' }, music: { mood: 'calm' }, voice: { voice: 'af_heart' } };
  const blockyFacts = Object.fromEntries(M.packFacts(blocky));
  assert.match(blockyFacts['3D renderer'], /three\.js.*no Blender/);
  assert.match(blockyFacts.Audience, /made for kids/);
  assert.equal(blockyFacts.Worlds, 'meadow, cave; wide shots; day, night');
  assert.deepEqual([M.kidsValue(1), M.kidsValue(0), M.kidsValue(null)], ['yes', 'no', '']);
  assert.match(M.channelLookText({ made_for_kids: 1 }), /made for kids/);
  assert.deepEqual(M.portChecks({ ok: false, findings: [{ check: 'brand', result: 'reject', reason: 'x' }] }).at(-1), ["Another game's name", 'Refused', 'error']);
  assert.ok(!/—/.test(Object.values(blockyFacts).join(' ')), 'no em-dashes');
  // Pack B: a glossy 3D pack renders with three.js or Blender, and Studio says plainly when Blender is not installed.
  assert.equal(M.packUseText({ approved_version: 1, spec: { renderer: 'blender', base: 'glossy-3d' } }), 'Channels and videos use version 1.');
  const none = { blender: { found: false, supported: false } }, have = { blender: { found: true, supported: true, version: '5.2.2' } };
  assert.match(M.rendererText('blender', none), /Blender isn't installed on this computer, so it renders with three\.js/);
  assert.match(M.rendererText('blender', have), /Blender 5\.2\.2, installed/);
  assert.match(M.rendererText('threejs', none), /three\.js, built into Kairos/);
  assert.deepEqual(M.rendererOptions(none, { inherit: true }).map(o => o[1]), ["The style pack's choice", 'three.js (built in)', 'Blender (not installed)']);
  assert.ok(!/—/.test(M.rendererText('blender', none) + M.rendererText('blender', have)), 'no em-dashes');
  assert.ok(M.packFacts({ base: 'glossy-3d', renderer: 'blender', look: { palette: 'dawn', design_look: 'nordic', lighting: 'soft', families: ['round'] }, characters: [],
    scenes: { settings: ['lavender'], shots: ['wide'], cameras: ['still'], transitions: ['cut'] }, pacing: { words_per_second: 2.6, shot_seconds: [2, 6], hook_seconds: 5 },
    captions: { on: true, case: 'sentence' }, music: { mood: 'calm' }, voice: { voice: 'af_heart' } }, none).some(([k, v]) => k === '3D renderer' && /isn't installed/.test(v)));
  assert.equal(M.packOriginText({ kind: 'brief', from: 'david' }), 'Made from a written brief (david).');
  assert.equal(M.packOriginText({ kind: 'starter', from: 'flat-science-explainer' }), 'Starter pack.');
  assert.equal(M.packOriginText({ kind: 'nope' }), '');
  const packSpec = { base: 'flat-2d', look: { palette: { sky: ['#000000', '#111111'] }, lighting: 'glow', design_look: 'nordic', families: ['round'] },
    characters: [{ character: 'abcdefabcdef', version: 1 }], scenes: { settings: ['space'], shots: ['wide', 'close'], cameras: ['push'], transitions: ['cut'] },
    pacing: { words_per_second: 2.6, shot_seconds: [2, 8], hook_seconds: 5 }, captions: { on: true, case: 'upper' }, music: { mood: 'calm' }, voice: { voice: 'af_heart' } };
  const facts = Object.fromEntries(M.packFacts(packSpec));
  assert.equal(facts.Look, 'Flat 2D with characters, its own palette, glow light, design look nordic');
  assert.equal(facts.Captions, 'On, upper case');
  assert.deepEqual(M.packFacts(null), []);
  for (const [, text] of M.packFacts(packSpec)) assert.ok(!text.includes('—'), 'no em-dashes');
  assert.deepEqual(M.packOptions([{ id: 'motion-type', name: 'Motion type' }, { id: 'flat-2d', name: 'Flat 2D explainer' }, { id: 'abcdefabcdef', name: 'Mine' }]),
    [['', 'Motion type (default)'], ['flat-2d', 'Flat 2D explainer'], ['abcdefabcdef', 'Mine']]);
  assert.equal(M.channelLookText({ style_pack: 'abcdefabcdef', look: 'sport' }, [{ id: 'abcdefabcdef', name: 'Mine' }]), 'style Mine, look sport');

  // Publishing: states, the week calendar, the fill's words, the schedule field, the page-read lines.
  assert.equal(M.stateLabel('waiting_for_you'), 'Waiting for you to press Post');
  assert.deepEqual(M.stateCounts({ posted: 2, drafted: 1, failed: 0 }), [{ id: 'drafted', label: 'Drafted', count: 1 }, { id: 'posted', label: 'Posted', count: 2 }]);
  assert.deepEqual(M.filterItems([{ state: 'posted' }, { state: 'failed' }], 'failed'), [{ state: 'failed' }]);
  const wed = new Date(2026, 10, 11, 15, 30).getTime() / 1000;              // Wednesday 11 Nov 2026
  const mon = M.weekOf(wed);
  assert.equal(new Date(mon * 1000).getDay(), 1); assert.equal(new Date(mon * 1000).getHours(), 0);
  assert.equal(new Date(mon * 1000).getDate(), 9);
  assert.equal(M.weekOf(mon), mon, 'a Monday is its own week');
  assert.deepEqual(M.weekDays(mon).map(d => d.label), ['Mon 9 Nov', 'Tue 10 Nov', 'Wed 11 Nov', 'Thu 12 Nov', 'Fri 13 Nov', 'Sat 14 Nov', 'Sun 15 Nov']);
  assert.equal(M.weekLabel(mon, mon), 'This week, 9 Nov to 15 Nov');
  assert.equal(M.weekLabel(M.addDays(mon, 7), mon), 'Week of 16 Nov to 22 Nov');
  const days = M.itemsByDay([{ when: wed }, { when: mon }, { when: M.addDays(mon, 7) }, { when: wed - 3600 }], mon);
  assert.deepEqual(days.map(d => d.length), [1, 0, 2, 0, 0, 0, 0]);
  assert.ok(days[2][0].when < days[2][1].when, 'earliest first');
  assert.equal(M.timeText(wed), 'Wed 11 Nov, 15:30');
  assert.equal(M.whenText({ posted_at: wed }), 'Posted Wed 11 Nov, 15:30');
  assert.equal(M.whenText({ scheduled_at: wed }), 'Scheduled for Wed 11 Nov, 15:30');
  assert.equal(M.nextText({ who: 'you', what: 'Press Post.' }), 'You: Press Post.');
  assert.equal(M.fillText({ stage: 'stopped', filled: ['file', 'caption'], missing: ['ai_label'], note: 'time ran out' }),
    'Kairos filled: Video, Caption. Not found on the page, do these yourself: AI label. Stopped: time ran out.');
  assert.equal(M.fillText({}), '');
  assert.equal(M.scheduleValue(wed), '2026-11-11T15:30');
  assert.equal(M.parseSchedule('2026-11-11T15:30'), wed);
  assert.equal(M.parseSchedule('soon'), null);
  assert.match(M.pageReadText({ on: false, name: 'TikTok' }), /^Off\. Turn it on/);
  assert.match(M.pageReadText({ on: true, name: 'TikTok', paused: 'signed_out' }), /signed out of TikTok/);
  assert.match(M.pageReadText({ on: true, name: 'Instagram', paused: 'page_changed' }), /Try again/);
  assert.equal(M.pageReadText({ on: true, name: 'TikTok', reads_today: 3, max_per_day: 40, last: { at: wed, status: 'ok' } }), 'On. 3 of 40 page reads today. Last read Wed 11 Nov, 15:30 (read).');
  assert.equal(M.prepareText({ package: { platform_name: 'TikTok', routes: ['browser'], problems: [] } }), 'Prepared for TikTok. Open the upload page when you are ready.');
  for (const text of [M.pageReadText({ on: false, name: 'TikTok' }), M.fillText({ stage: 'done', filled: ['file'] }), M.aiLabel('instagram').text]) assert.ok(!text.includes('—'), 'no em-dashes');

  // The channel dashboard: scopes and their tabs, avatars, what needs you, latest and coming up, numbers, the phone picker.
  assert.deepEqual(M.tabsFor('all').map(t => t[0]), ['dashboard', 'approvals', 'pipeline', 'calendar', 'publishing', 'analytics', 'report']);
  assert.deepEqual(M.tabsFor(3).map(t => t[0]), ['dashboard', 'pipeline', 'calendar', 'approvals', 'publishing', 'analytics', 'settings']);
  assert.deepEqual(M.tabsFor('lib:styles'), []);
  assert.deepEqual([M.parseScope('all'), M.parseScope('4'), M.parseScope('lib:formats'), M.parseScope('lib:nope'), M.parseScope('-2'), M.parseScope(null)], ['all', 4, 'lib:formats', 'all', 'all', 'all']);
  assert.deepEqual(M.avatarFor({ handle: '@cooks', look: 'sport' }), { letter: 'C', key: 'sport' });
  assert.deepEqual(M.avatarFor({ handle: 'trips', style_pack: 'flat-2d' }), { letter: 'T', key: 'flat-2d' });
  assert.equal(M.avatarFor({ handle: '@' }).letter, '?');
  // Every channel's avatar is told apart: two letters no other channel uses, hues at least 30 degrees apart, the platform glyph.
  const same = [{ id: 1, handle: '@cooks', platform: 'youtube', look: 'sport' }, { id: 2, handle: '@cooks.tt', platform: 'tiktok', look: 'sport' },
    { id: 3, handle: '@trips', platform: 'instagram' }, { id: 4, handle: '@cooks', platform: 'instagram', look: 'sport' }, { id: 5, handle: 'CookingDaily', platform: 'youtube' },
    { id: 6, handle: '@c', platform: 'tiktok' }, { id: 7, handle: '@c', platform: 'youtube' }];
  const avatars = M.avatarsFor(same);
  assert.deepEqual([...avatars.values()].map(a => a.letters), ['CO', 'CT', 'TR', 'CK', 'CD', 'C2', 'C3']);
  assert.deepEqual([...avatars.values()].map(a => a.glyph), ['YT', 'TT', 'IG', 'IG', 'YT', 'TT', 'YT']);
  assert.equal(new Set([...avatars.values()].map(a => a.letters)).size, same.length, 'no two channels share letters');
  const hues = [...avatars.values()].map(a => a.hue);
  for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) {
    const d = Math.abs(hues[i] - hues[j]) % 360; assert.ok(Math.min(d, 360 - d) >= 30, `hues ${i} and ${j} are apart`);
  }
  assert.deepEqual(M.avatarsFor([...same].reverse()).get(1), avatars.get(1), 'id order, so an added channel never changes an older avatar');
  assert.deepEqual(M.avatarsFor(same.slice(0, 2)).get(2), avatars.get(2), 'a later channel does not change an earlier one');
  assert.equal(M.channelName({ platform: 'tiktok', handle: '@a' }), 'TikTok @a');
  const ch = { id: 2, niche_id: 7 };
  const mixed = [{ kind: 'topic', id: 1, niche_id: 7 }, { kind: 'topic', id: 2, niche_id: 8 }, { kind: 'post', id: 3, channel_id: 2, niche_id: 7 }, { kind: 'post', id: 4, channel_id: 5, niche_id: 7 }];
  assert.deepEqual(M.channelItems(mixed, ch).map(i => i.kind + i.id), ['topic1', 'post3'], 'a channel shows its posts and its niche\'s topics');
  assert.equal(M.channelItems(mixed, null).length, 4);
  const pubs = [{ post_id: 1, channel_id: 2, state: 'prepared', scheduled_at: 500 }, { post_id: 2, channel_id: 2, state: 'waiting_for_you' }, { post_id: 3, channel_id: 5, state: 'failed', scheduled_at: 300 },
    { post_id: 4, channel_id: 2, state: 'posted', posted_at: 200 }, { post_id: 5, channel_id: 5, state: 'posted', posted_at: 400 }, { post_id: 6, channel_id: 2, state: 'rejected', scheduled_at: 900 },
    { post_id: 7, channel_id: 2, state: 'awaiting_approval' }];
  assert.deepEqual(M.postChannels(pubs)[3], 5);
  const needs = M.needsYou({ approvals: [{ id: 7, channel_id: 2 }, { id: 8, channel_id: 5 }], plans: [{ post_id: 1 }, { post_id: 3 }], pubItems: pubs,
    sheets: [{}], packs: [], decisions: [{ status: 'awaiting_user' }, { status: 'confirmed' }] });
  assert.deepEqual(needs.map(r => r.text), ['2 posts to approve', '2 long video plans to approve', '2 prepared posts waiting for you to post them', '1 preparation that failed', '1 character sheet to approve', '1 team decision to confirm']);
  assert.equal(M.needsCount(needs), 9);
  const mineNeeds = M.needsYou({ approvals: [{ id: 7, channel_id: 2 }], plans: [{ post_id: 1 }, { post_id: 3 }], pubItems: pubs, sheets: [{}], decisions: [{ status: 'awaiting_user' }] }, 2);
  assert.deepEqual(mineNeeds.map(r => [r.key, r.count, r.tab]), [['approvals', 1, 'approvals'], ['plans', 1, 'approvals'], ['to_post', 2, 'publishing']], 'a channel: its own posts and plans, no libraries');
  assert.equal(mineNeeds[0].text, '1 post to approve');
  assert.deepEqual(M.needsYou({}, null), []);
  assert.deepEqual(M.latestPosted(pubs).map(i => i.post_id), [5, 4]);
  assert.deepEqual(M.latestPosted(pubs, 4, 2).map(i => i.post_id), [4]);
  assert.deepEqual(M.upcoming(pubs, 100).map(i => i.post_id), [3, 1], 'soonest first, rejected left out');
  assert.deepEqual(M.upcoming(pubs, 400, 5, 2).map(i => i.post_id), [1]);
  assert.deepEqual(M.filterItems(pubs, 'to_post').map(i => i.post_id), [1, 2]);
  const nums = M.latestNumbers([{ taken_at: 2, views: 900, avg_view_duration_s: 20, likes: 5, follows_gained: 1 }, { taken_at: 1, views: 100 }]);
  assert.deepEqual([nums.views, nums.avg, nums.likes, nums.comments, nums.follows], [900, 20, 5, 0, 1], 'the newest snapshot');
  assert.equal(M.latestNumbers([]), null);
  const totals = M.numberTotals([nums, null, { views: 100, avg: 10, likes: 1, follows: 0 }]);
  assert.deepEqual([totals.posts, totals.views, totals.likes, totals.avg], [2, 1000, 6, 15]);
  assert.equal(M.numberTotals([]).avg, null);
  assert.deepEqual([M.compact(950), M.compact(1200), M.compact(1000), M.compact(34400), M.compact(1500000), M.compact(12000000)], ['950', '1.2K', '1K', '34K', '1.5M', '12M']);
  assert.deepEqual([M.durationText(21.4), M.durationText(75), M.durationText(null)], ['21 s', '1 min 15 s', 'no number yet']);
  assert.deepEqual(M.pipelineCounts([item('pick'), item('script'), item('script')]).map(c => c.count), [1, 2, 0, 0, 0, 0]);
  const week = M.channelWeek({ id: 2 }, pubs, 300, { name: 'Sky', eligible: false, score: null, not_yet: '2 of 10 posts' });
  assert.deepEqual(week, ['Posted in the last 7 days: 1 post.', 'Scheduled from now on: 1 post.', 'Waiting for your approval: 1 post.',
    'Prepared and waiting for you to post: 2 posts.', 'Its niche, Sky, is not scored yet: 2 of 10 posts.']);
  assert.match(M.channelWeek({ id: 2 }, pubs, 300, { name: 'Sky', eligible: true, score: 61.25 }).at(-1), /scores 61\.3/);
  assert.deepEqual(M.pickerOptions([{ id: 1, name: 'Sky', status: 'live' }], [{ id: 4, niche_id: 1, platform: 'youtube', handle: '@sky', status: 'archived' }]),
    [['all', 'All channels'], ['4', 'YouTube @sky, Sky, archived'], ['lib:formats', 'Formats'], ['lib:styles', 'Styles'], ['lib:characters', 'Characters'], ['lib:connections', 'Connections']]);
  for (const text of [...needs.map(r => r.text), ...week]) assert.ok(!text.includes('—'), 'no em-dashes');

  console.log('studio content model ok');
})().catch(error => { console.error(error); process.exit(1); });

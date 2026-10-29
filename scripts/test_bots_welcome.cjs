const assert = require('node:assert/strict');
const fs = require('node:fs');
const load = async file => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '')).toString('base64'));
(async () => {
  const W = await load('static/js/botsWelcome.js');
  const H = await load('static/js/botsHints.js');
  const N = await load('static/js/botsNotices.js');
  const T = await load('static/js/botsTour.js');
  const P = await load('static/js/botsPrefs.js');
  assert.deepEqual(W.stepDashes(1, 3).map(d => d.current), [false, true, false]);
  assert.equal(W.stepDashes(1, 3)[1].label, 'Step 2 of 3');
  const off = W.registerOnboardingBeat({ id: 'extension', order: 20, mount() {} });
  assert.deepEqual(W.onboardingBeats().map(b => b.id), ['meet', 'extension', 'setup']); off();
  assert.throws(() => W.registerOnboardingBeat({ id: 'bad' }));
  const seen = new Set(); assert.equal(H.claimHint(seen, 'widget'), true); assert.equal(H.claimHint(seen, 'widget'), false);
  const q = N.createNoticeQueue({ old: { dismissed: true } });
  assert.equal(q.add({ id: 'old' }), false); assert.equal(q.add({ id: 'new' }), true); assert.equal(q.add({ id: 'new' }), false);
  for (const busy of [{ dialog: true }, { firstChat: true }, { call: true }]) assert.equal(q.next(busy), null);
  assert.equal(q.next({}).id, 'new'); assert.equal(q.next({}), null);
  assert.equal(T.TOUR_STEPS.length, 10);
  assert.equal(T.tourSteps(T.TOUR_STEPS, selector => selector.includes('textarea') ? {} : null).length, 1);
  const storage = new Map(); global.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  P.setPref('sendKey', 'shift-enter'); assert.equal(storage.get('kairos:bots-send-key'), 'shift-enter'); assert.equal(P.getPref('sendKey'), 'shift-enter');
  P.setPref('width', 'wide'); assert.equal(P.getPref('width'), 'wide'); assert.throws(() => P.setPref('width', 'huge'));
  storage.set('kairos:bots-chat-width', 'invalid'); assert.equal(P.getPref('width'), 'default');
  const state = { botsLive: true }, fixture = require('./fixtures/bots-onboarding-backend.cjs')({ state });
  assert.equal(fixture.read('/api/bot-onboarding'), undefined); assert.equal(fixture.mutate('/api/bot-onboarding', 'PATCH', {}), undefined);
  state.botsOnboarding = { welcome_seen: false, notices: {}, hints_seen: [] };
  fixture.mutate('/api/bot-onboarding', 'PATCH', { welcome_seen: true, hints: ['widget'], notices: { example: { dismissed: true } } });
  fixture.mutate('/api/bot-onboarding', 'PATCH', { notices: { example: { dismissed: false } } });
  assert.equal(fixture.read('/api/bot-onboarding').notices.example.dismissed, true);
  assert.equal(fixture.read('/other-route'), undefined);
  for (const file of ['botsWelcome', 'botsSetupChecklist', 'botsHints', 'botsNotices', 'botsTour', 'botsSpotlight', 'botsSettingsBots', 'botsPrefs']) {
    assert.doesNotMatch(fs.readFileSync(`static/js/${file}.js`, 'utf8'), /#[a-f0-9]{3,8}\b|rgba?\(|\u2014/i);
  }
  console.log('Bots welcome, tour, notices and preferences: passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

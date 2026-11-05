// No canvas, browser, dependencies or on-disk temporary modules required.
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
(async () => {
  const moduleURL = name => pathToFileURL(path.join(__dirname, '../static/motion', name)).href;
  const L = await import(moduleURL('layout.js')), K = await import(moduleURL('kit.js'));
  const p = L.normalizeProject({ bpm: 120, fps: 60, beats: [
    { id: 'a', kind: 'title', bars: 1, transition: 'whip' },
    { id: 'b', bars: 2, transition: 'zoom' }, { id: 'c', kind: 'end', bars: 1 }
  ] });
  assert.equal(p.duration, 8); assert.equal(p.fps, 30); assert.equal(p.bar, 2);
  assert.deepEqual(p.beats.map(b => [b.start, b.end]), [[0, 2], [2, 6], [6, 8]]);
  assert.equal(L.beatAt(p, 2).id, 'b'); assert.equal(L.beatAt(p, -1).id, 'a');
  assert.equal(L.beatAt(p, 8).id, 'c'); assert.equal(L.beatAt(p, Infinity).id, 'a');
  assert.equal(L.transitionAt(p, 1.824), null);
  assert.equal(L.transitionAt(p, 1.825).kind, 'whip');
  assert.ok(Math.abs(L.transitionAt(p, 2).p - .5) < 1e-12); assert.equal(L.transitionAt(p, 2.175), null);
  assert.equal(L.transitionAt(p, 6).kind, 'zoom');
  assert.deepEqual(L.transitionWindows(p).map(w => w.cut), [2, 6]);
  const end = p.beats[2];
  assert.equal(L.beatElapsed(end, 6.5), 2); assert.equal(L.beatElapsed(end, 7.9), 2);
  assert.equal(L.beatElapsed({ ...end, end: 7 }, 6), 1); // short end beat is immediately still
  assert.equal(L.beatElapsed(p.beats[0], .5), .5);
  const bad = L.normalizeProject({ bpm: 900, beats: [{ id: 'same', kind: 'bogus', bars: -2, camera: 'bad', transition: 'bad', treatment: 'bad',
    text: 'x'.repeat(999), sub: 'x'.repeat(999), number: 'x'.repeat(999), items: Array(9).fill('x'.repeat(999)), image: '../../secret' },
  { id: 'same', bars: 999 }, null] });
  assert.equal(bad.bpm, 240); assert.equal(bad.beats[0].kind, 'statement');
  assert.equal(bad.beats[0].bars, .25); assert.equal(bad.beats[1].bars, 16);
  assert.equal(bad.beats[0].camera, 'still'); assert.equal(bad.beats[0].transition, 'cut');
  assert.equal(bad.beats[0].treatment, 'none'); assert.equal(bad.beats[0].image, '');
  assert.equal(bad.beats[0].text.length, L.LIMITS.text); assert.equal(bad.beats[0].sub.length, L.LIMITS.sub);
  assert.equal(bad.beats[0].number.length, L.LIMITS.number); assert.equal(bad.beats[0].items.length, 5);
  assert.equal(bad.beats[0].items[0].length, 100); assert.notEqual(bad.beats[0].id, bad.beats[1].id);
  assert.equal(L.normalizeProject({ bpm: -5 }).bpm, 40);
  assert.equal(L.normalizeProject({ beats: Array(90).fill({}) }).beats.length, 64);
  for (const value of [null, {}, { beats: [] }]) assert.ok(L.normalizeProject(value).duration > 0);
  assert.equal(L.assetName('assets/abc-123.jpg'), 'abc-123.jpg');
  for (const name of ['https://x/y', '/etc/passwd', 'assets/../x', 'a%2fb.png', 'x?rt=bad']) assert.equal(L.assetName(name), '');
  const a = K.seededRandom('beat-123'), b = K.seededRandom('beat-123'), c = K.seededRandom('other');
  const sequence = Array.from({ length: 50 }, a);
  assert.deepEqual(sequence, Array.from({ length: 50 }, b)); assert.notDeepEqual(sequence, Array.from({ length: 50 }, c));
  assert.ok(sequence.every(n => n >= 0 && n < 1)); assert.equal(K.hash('hello'), K.hash('hello'));
  assert.equal(K.pop(-1), 0); assert.equal(K.pop(1), 1); assert.ok(K.pop(.25) > 1);
  assert.equal(K.inOut(.5), .5); assert.equal(K.typedText('abc', .1), 'ab');
  assert.equal(K.contrast('#fff', '#000'), 21); assert.ok(K.contrast('#fff', '#fff') < 4.5);
  assert.equal(K.readable('#aaa', '#fff', ['#111', '#aaa']), '#111');
  let boxesChecked = 0;
  const measure = (s, size) => [...s].length * size * .57;
  for (const aspect of Object.keys(L.SIZES)) for (const kind of L.KINDS) for (const long of [false, true]) {
    const beat = L.normalizeProject({ beats: [{ kind, text: long ? 'A long measured title '.repeat(20) : 'Every kid plays',
      sub: long ? 'Detailed information '.repeat(20) : 'Spring signup', number: '312', image: 'assets/test.png',
      items: Array(5).fill(long ? 'Long item '.repeat(15) : 'Coach-led practice') }] }).beats[0];
    const safe = L.safeArea(aspect), boxes = L.beatLayout(beat, aspect, measure);
    if (kind === 'list') assert.equal(new Set(boxes.filter(b => b.role === 'body').map(b => b.size)).size, 1);
    for (const box of boxes.filter(b => b.kind === 'text')) {
      assert.ok(box.x >= safe.x - 1e-6 && box.y >= safe.y - 1e-6);
      assert.ok(box.x + box.w <= safe.x + safe.w + 1e-6 && box.y + box.h <= safe.y + safe.h + 1e-6);
      const floor = box.role === 'number' ? 525 : box.role === 'body' ? (kind === 'list' ? 59.4 : kind === 'big-number' ? 54 : kind === 'end' ? 59.4 : 45.36) : L.TYPE[kind][0];
      assert.ok(box.size >= floor - .01, `${kind}/${aspect}/${box.role}: ${box.size} < ${floor}`);
      assert.equal(box.minSize, floor);
      if (box.role === 'title' && !['split'].includes(kind)) assert.ok(box.w >= safe.w * .60);
      if (box.role === 'title' && !long && ['title', 'end'].includes(kind)) {
        assert.ok(Math.max(...box.lines.map(line => measure(line, box.size))) >= safe.w * .60, `${kind}/${aspect}: headline uses safe width`);
      }
      assert.ok(box.lines.every(line => measure(line, box.size) <= box.w + .01));
      assert.ok(box.lines.length * box.lineHeight <= box.h + .01);
      boxesChecked++;
    }
  }
  for (const aspect of Object.keys(L.SIZES)) for (const composition of ['left', 'center', 'bottom']) {
    // Condensed display metrics reproduce the Sport one-line regression.
    const condensed = (text, size) => [...text].length * size * .32;
    for (const text of ['EVERY KID PLAYS. EVERY GAME.', 'Every player gets a team and every team gets a chance to make this season count.', 'A long measured statement '.repeat(20)]) {
      const beat = L.normalizeProject({ beats: [{ kind: 'statement', text }] }).beats[0];
      const box = L.beatLayout(beat, aspect, condensed, { composition })[0];
      assert.ok(box.lines.length >= 2 && box.lines.length <= 3, `${aspect}/${composition}: statement line count`);
      assert.ok(box.size >= 150 && box.size <= 195, 'statement retains 10-13% S cap height');
      assert.ok(box.lines.every(line => condensed(line, box.size) <= box.w));
      if (text.length < 40 && aspect === '16:9') assert.equal(box.size, 195, 'wrap at target size before shrinking');
      if (text.length < 80) {
        const widths = box.lines.map(line => condensed(line, box.size));
        assert.ok(Math.min(...widths) / Math.max(...widths) > .45, 'balanced statement lines');
        assert.equal(box.truncated, false);
      }
    }
    const beat = L.normalizeProject({ beats: [{ kind: 'list', text: 'What you get', items: ['Coach-led practices', 'Eight games', 'Team kit', 'New friends', 'A place to play'] }] }).beats[0];
    const rows = L.beatLayout(beat, aspect, measure, { composition }).filter(b => b.role === 'body');
    assert.equal(new Set(rows.map(row => row.size)).size, 1);
    assert.equal(new Set(rows.map(row => row.x)).size, 1);
    for (const row of rows) {
      assert.equal(row.align, 'left'); assert.ok(row.size >= 1080 * .055 - .01);
      const marker = L.listMarker(row);
      assert.equal(row.x - marker.x, 24, 'consistent bullet/text inset');
      assert.ok(marker.x - marker.radius >= L.safeArea(aspect).x);
      const y0 = row.y + (row.h - row.lines.length * row.lineHeight) * (composition === 'bottom' ? 1 : .5);
      assert.equal(marker.y, y0 + row.size * .52, 'bullet follows first-line cap centre');
    }
  }
  const sequenceProject = L.normalizeProject({ beats: Array.from({ length: 30 }, (_, i) => ({ kind: L.KINDS[i % L.KINDS.length], text: 'Designed for motion' })) });
  const compositions = sequenceProject.beats.map((_, i) => L.compositionAt(sequenceProject.beats, i));
  assert.deepEqual(compositions, sequenceProject.beats.map((_, i) => L.compositionAt(sequenceProject.beats, i)));
  assert.equal(new Set(compositions).size, 3);
  assert.ok(compositions.every((value, i) => !i || value !== compositions[i - 1]));
  // Mount with a fake canvas/font measurer: tests the public frame-zero layout,
  // including the exact reveal clock used by the renderer, without Electron.
  const E = await import(moduleURL('engine.js'));
  const quoteStyle = { display: 'MissingDisplay', sans: 'BodyFont', weight: 400, accent: '#c6ff3d' };
  for (const available of ['title', 'body', 'shape']) {
    const calls = [], fills = [];
    const g = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
      fill() { fills.push(this.fillStyle); }, fillText(text) { calls.push({ text, font: this.font, color: this.fillStyle }); },
      measureText(text) {
        const hasGlyph = available === 'title' || available === 'body' && this.font.includes('BodyFont');
        return { width: text === '\u201c' && hasGlyph ? 42 : 60 };
      } };
    assert.equal(E.drawQuoteMark(g, quoteStyle, 100, 60), available);
    if (available === 'shape') { assert.equal(calls.length, 0); assert.deepEqual(fills, [quoteStyle.accent, quoteStyle.accent]); }
    else { assert.equal(calls[0].text, '\u201c'); assert.ok(calls[0].font.includes(available === 'body' ? 'BodyFont' : 'MissingDisplay')); }
  }
  // Renderer regression: the old score dash was a five-pixel rectangle at safe bottom.
  const rectangles = [];
  const context = new Proxy({ fillRect: (...args) => rectangles.push(args), measureText: text => ({ width: measure(text, 100) }),
    createLinearGradient: () => ({ addColorStop() {} }) }, {
    get(target, key) { return key in target ? target[key] : () => {}; },
    set(target, key, value) { target[key] = value; return true; }
  });
  const doc = { URL: 'http://localhost/player', baseURI: 'http://localhost/player', documentElement: {},
    body: { append() {} }, fonts: { load: async () => [], ready: Promise.resolve() },
    createElement: () => ({ style: { setProperty() {} }, remove() {}, getContext: () => context }) };
  global.getComputedStyle = element => ({ color: element.style?.color?.includes('CanvasText') ? '#ffffff' : '#101418',
    fontFamily: 'sans-serif', getPropertyValue: () => '' });
  for (const aspect of Object.keys(L.SIZES)) for (const kind of L.KINDS) for (const camera of ['still', 'push']) {
    const sample = { aspects: [aspect], beats: [{ kind, camera, text: 'Designed for motion', number: '312', sub: 'A clear next step', items: ['One', 'Two'] }] };
    const mounted = E.mount({ ownerDocument: doc, getContext: () => context }, sample);
    await mounted.ready;
    mounted.drawFrame(mounted.duration * .7);
    assert.ok(!rectangles.some(([x, y, w, h]) => h === 5), 'no persistent corner score mark');
    rectangles.length = 0;
    assert.ok(mounted.layout(0).some(b => b.kind === 'text' && b.text.length), `${kind}/${aspect}/${camera}: frame zero has text`);
  }
  delete global.getComputedStyle;
  const portraitSafe = L.safeArea('9:16');
  assert.equal(portraitSafe.x, 54); assert.ok(Math.abs(portraitSafe.y - 249.6) < 1e-9);
  assert.equal(portraitSafe.w, 972); assert.equal(portraitSafe.h, 1344);
  assert.equal(L.dimensions('bad').aspect, '16:9');
  const huge = L.fitText('W'.repeat(180), { w: 450, h: 180 }, { min: 72, max: 200, measure });
  assert.equal(huge.truncated, true); assert.ok(huge.text.endsWith('...'));
  for (const camera of L.CAMERAS) {
    assert.deepEqual(L.cameraAt(camera, .6, 3), L.cameraAt(camera, .6, 3));
    assert.ok(L.cameraAt(camera, .6, 3).scale >= 1);
  }
  for (const kind of L.TRANSITIONS) for (const progress of [0, .25, .5, .75, 1]) {
    const tf = L.transitionTransform(kind, progress, true, 1920, 1080), safe = L.safeArea('16:9');
    const v = L.visibleBox({ ...safe, kind: 'text' }, tf, safe, 1920, 1080);
    if (v) assert.ok(v.x >= safe.x && v.y >= safe.y && v.x + v.w <= safe.x + safe.w + 1e-6 && v.y + v.h <= safe.y + safe.h + 1e-6);
  }
  // A big-number with no number would draw "0" (Phase 4 benchmark): it is drawn as a statement instead.
  const noNumber = L.normalizeProject({ beats: [{ id: 'n', kind: 'big-number', bars: 1, text: 'Relaunch [DATE]' }] });
  assert.equal(noNumber.beats[0].kind, 'statement');
  assert.equal(L.normalizeProject({ beats: [{ id: 'n', kind: 'big-number', bars: 1, number: '312' }] }).beats[0].kind, 'big-number');
  // Long words stay whole when shrinking fits them (a Studio preview broke "opening" mid-word).
  const charWidth = (s, size) => Array.from(s).length * size * .55;
  assert.ok(L.fitText('Valid opening', { w: 500, h: 600 }, { min: 40, max: 200, measure: charWidth }).lines.every(l => !/^g$/.test(l) && !l.endsWith('openin')));
  console.log(`Motion engine pure checks passed (${boxesChecked} fitted text boxes; all kinds/aspects/cameras/transitions).`);
})().catch(error => { console.error(error); process.exitCode = 1; });

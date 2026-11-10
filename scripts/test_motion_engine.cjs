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
  assert.equal(L.normalizeProject({ beats: Array(130).fill({}) }).beats.length, 100);
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
      // Below the floor only a short figure or heading that would otherwise be cut off with "..." (layout.js).
      const short = box.role === 'number' || box.text.split(/\s+/u).length <= 4;
      assert.ok(box.size >= floor - .01 || (short && !box.truncated), `${kind}/${aspect}/${box.role}: ${box.size} < ${floor}`);
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
      assert.ok(Math.abs(row.x - marker.x - 24 * Math.max(1, row.size / 90)) < 1e-9, 'consistent bullet/text inset, grown with the row');
      assert.ok(marker.x - marker.radius >= L.safeArea(aspect).x);
      const y0 = row.y + (row.h - row.lines.length * row.lineHeight) * (composition === 'bottom' ? 1 : .5);
      assert.equal(marker.y, y0 + row.size * .52, 'bullet follows first-line cap centre');
    }
  }
  // A short list with no heading sets large and uses the frame (2026-11-05 pass: two rows sat small and empty).
  // Four untitled rows also set above body size (Studio click-through: they filled a third of the frame).
  const lists = [[['Automatic reminders', 'Card + bank payments'], 96], [['Lantern parade', 'Night market', 'Fireworks finale', 'Edited in Studio by hand'], 72]];
  for (const aspect of Object.keys(L.ASPECTS || { '16:9': 1, '9:16': 1, '1:1': 1 })) for (const [items, least] of lists) {
    const short = L.normalizeProject({ beats: [{ kind: 'list', items }] }).beats[0];
    const rows = L.beatLayout(short, aspect, measure, { composition: 'left' }).filter(b => b.role === 'body');
    assert.ok(rows.every(row => row.size >= least), `${items.length}-row list sets large (${aspect}: ${rows.map(r => r.size)})`);
    assert.ok(rows.every(row => !row.truncated), 'list rows fit');
    const safe = L.safeArea(aspect);
    for (const row of rows) {
      const marker = L.listMarker(row);
      assert.ok(marker.x - marker.radius >= safe.x, 'a grown marker stays inside the safe area');
      assert.ok(row.y + row.h <= safe.y + safe.h + .5, 'rows stay inside the safe area');
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
  // Pack A: the rig's timing is deterministic and the scene beat is normalized defensively.
  const R = await import(moduleURL('rig.js')), S = await import(moduleURL('scene.js'));
  const blinks = Array.from({ length: 300 }, (_, i) => R.blinkAt('pip:b1', i / 30));
  assert.deepEqual(blinks, Array.from({ length: 300 }, (_, i) => R.blinkAt('pip:b1', i / 30)), 'blinks are seeded');
  assert.ok(blinks.some(b => b === 1) && blinks.filter(b => b > 0).length < 40, 'a few short blinks in ten seconds');
  assert.equal(R.mouthAt('XXXXXXXXAEOMF', 8 / 30), 'A');
  assert.equal(R.mouthAt('XXXXXXXXAEOMF', 11 / 30), 'MBP');
  assert.equal(R.mouthAt('XXXXXXXXAEOMF', 12 / 30), 'FV');
  assert.equal(R.mouthAt('XA', 5), 'rest');
  assert.equal(R.mouthAt('', 0), 'rest');
  assert.deepEqual([0, .5, .6, .7].map(t => R.viewAt('front', 'side', t, .5)), ['front', 'front', 'three_quarter', 'side']);
  assert.equal(R.viewAt('front', undefined, 9, 0), 'front');
  const jump = Array.from({ length: 48 }, (_, i) => R.poseAt('jump', i / 30));
  assert.ok(Math.min(...jump.map(p => p.sy)) < .9 && Math.max(...jump.map(p => p.sy)) > 1.1, 'squash and stretch on a hop');
  assert.ok(Math.max(...jump.map(p => p.lift)) > .2, 'the hop leaves the ground');
  assert.ok(R.poseAt('wave', 1).arm[1][0] > 2, 'a wave raises the arm');
  const pip = { family: 'round', outline: 7, proportions: { head: .42, body_width: .62, limb_length: .26, limb_width: .055, eye_size: .036 }, palette: {} };
  const geo = R.geometry(pip, 1000);
  // core/character_checks.body_centre places the body's centre the same way.
  assert.ok(Math.abs((geo.bodyTop + geo.bodyBottom) / 2 - (-1000 + 420 * .82 + -260 * .9) / 2) < 1e-9);
  const box = R.figureBox(pip, 500, 900, 400, { pose: R.poseAt('idle', 0) });
  assert.ok(box.y < 900 - 400 && box.body.cy < 900 && box.body.cy > 900 - 400 && Math.abs(box.outline - 2.8) < 1e-9);
  const sc = L.normalizeScene({ setting: 'volcano', shot: 'huge', cast: [{ character: 'abc', action: 'dance', view: 'up', x: 9 }, null, { nope: 1 }],
    props: Array(9).fill({ icon: 'sun', size: 9 }) });
  assert.deepEqual([sc.setting, sc.shot, sc.cast.length, sc.cast[0].action, sc.cast[0].view, sc.cast[0].x, sc.props.length, sc.props[0].size],
    ['meadow', 'medium', 1, 'idle', 'front', 1, 6, .35]);
  const sp = L.normalizeProject({ palette: 'dusk', characters: { abcdefabcdef: { version: 1, spec: pip } }, beats: [
    { id: 's', kind: 'scene', seconds: 3, text: 'A label', spoken: { mouth: 'XXAAO' }, scene: { shot: 'wide', cast: [{ character: 'abcdefabcdef', speaking: true }] } }] });
  assert.equal(sp.beats[0].mouth, 'XXAAO');
  assert.equal(L.normalizeProject({ beats: [{ id: 's', kind: 'scene', spoken: { mouth: '<script>' } }] }).beats[0].mouth, '');
  const boxes = S.sceneBoxes(sp.beats[0], sp, 1920, 1080, 900, 1, .3);
  const figure = boxes.find(b => b.kind === 'character');
  assert.equal(figure.shot, 'wide');
  assert.ok(Math.abs(figure.height / 1080 - .30) < .03, 'a wide shot is about 30% of the short side');
  assert.equal(S.sceneBoxes({ ...sp.beats[0], scene: { cast: [{ character: 'unknown00000' }] } }, sp, 1920, 1080, 900, 1, .3).length, 0, 'no spec, nothing drawn');
  const label = L.beatLayout(sp.beats[0], '16:9', charWidth, { captioned: true });
  assert.equal(label.length, 1);
  assert.ok(label[0].y + label[0].h <= 1080 * .25 && label[0].align === 'center', 'a scene label stays at the top');
  // A close shot is cut at the near ground, so the caption band under the ground line never covers the figure.
  const band = L.captionBand('16:9'), ground = S.groundLine(1080, band, true);
  const close = { ...sp.beats[0], scene: { ...sp.beats[0].scene, shot: 'close' } };
  for (const camera of ['still', 'push', 'pull', 'pan']) {
    const fig = S.sceneBoxes({ ...close, camera }, sp, 1920, 1080, ground, 1, .5).find(b => b.kind === 'character');
    assert.ok(fig.clip != null && fig.y + fig.h <= band.y, `${camera}: a close figure ends above the caption band`);
    assert.ok(fig.height / 1080 > .58, 'still a close shot');
  }
  const medium = S.sceneBoxes({ ...sp.beats[0], camera: 'push', scene: { ...sp.beats[0].scene, shot: 'medium' } }, sp, 1920, 1080, ground, 1, 1).find(b => b.kind === 'character');
  assert.ok(medium.y + medium.h < band.y + 8 && medium.clip === undefined, 'a medium figure stands clear of the band');
  // A user-made style pack reaches the engine as checked colours and names only.
  const pack = L.normalizePack({ palette: { sky: ['#173d7a', '#3f7bc8'], far: '#6c8fd8', mid: '#4a6fc0', near: '#dfe6f5', ground: '#b9c6e4', prop: '#ffd166', ink: '#1b2a4a', glow: '#ffffff' },
    lighting: 'glow', caption_case: 'upper', script: 'alert(1)' });
  assert.deepEqual([pack.lighting, pack.captionCase, pack.palette.near, 'script' in pack], ['glow', 'upper', '#dfe6f5', false]);
  assert.equal(L.normalizePack({ palette: { sky: ['red', 'blue'] }, lighting: 'laser' }).palette, null, 'a bad palette is dropped, never drawn');
  assert.equal(L.normalizePack({ palette: { sky: ['red', 'blue'] }, lighting: 'laser' }).lighting, 'soft');
  assert.equal(S.paletteOf({ palette: 'dusk', pack: pack }).near, '#dfe6f5');
  assert.equal(S.paletteOf({ palette: 'dusk', pack: pack }).light, S.LIGHTING.glow);
  assert.equal(S.paletteOf({ palette: 'dusk', pack: null }).near, S.PALETTES.dusk.near);
  // One light per sky: the sky's own disc (or far planet in space) only when the scene brings no sun or moon of its own
  // (the 2026-11-10 pack sample drew a pale disc beside its rayed sun).
  assert.equal(S.skyBody('meadow', []), 'glow');
  assert.equal(S.skyBody('space', [{ icon: 'planet' }]), 'planet');
  assert.equal(S.skyBody('room', []), null);
  for (const setting of ['meadow', 'city', 'ocean', 'space']) {
    assert.equal(S.skyBody(setting, [{ icon: 'sun' }]), null, `${setting}: a sun prop is the only light`);
    assert.equal(S.skyBody(setting, [{ icon: 'moon' }, { icon: 'star' }]), null, `${setting}: a moon prop is the only light`);
  }
  // A pack's cards (title, statement, end...) are drawn in its sky, light and ground, never the look's plain card, and
  // every colour copy can sit on keeps 4.5:1 (the 2026-11-10 sample's end card was plain white).
  const lit = S.packCard(pack);
  assert.deepEqual([lit.bg, lit.palette.near, lit.rule, lit.text], ['#173d7a', '#dfe6f5', '#ffd166', '#ffffff']);
  assert.ok(lit.glow > S.packCard({ ...pack, lighting: 'soft' }).glow * 1.5 && S.packCard({ ...pack, lighting: 'flat' }).glow === 0, 'lighting sets the light');
  assert.deepEqual(S.packCard(pack), lit, 'deterministic');
  for (const [name, palette] of Object.entries({ ...S.PALETTES, starter: pack.palette })) {
    for (const lighting of ['flat', 'soft', 'glow']) {
      const c = S.packCard({ palette, lighting });
      const grounds = [c.bg, c.backdrop, c.worstBg];
      for (const [role, color] of Object.entries({ text: c.text, dim: c.dim, accent: c.accent })) {
        assert.ok(grounds.every(g => K.contrast(color, g) >= 4.5), `${name}/${lighting}: ${role} ${color} reads on its card`);
      }
    }
  }
  console.log(`Motion engine pure checks passed (${boxesChecked} fitted text boxes; all kinds/aspects/cameras/transitions; Pack A rig and scenes; style packs and close shots).`);
})().catch(error => { console.error(error); process.exitCode = 1; });

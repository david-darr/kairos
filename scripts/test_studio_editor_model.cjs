// Pure checks for Studio's video editor (static/js/studioEditorModel.js).
// Run: node scripts/test_studio_editor_model.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '../static/js/studioEditorModel.js')).href);
  const p = { bpm: 120, beats: [
    { id: 'a', kind: 'title', text: 'Hello', bars: 1 },
    { id: 'b', kind: 'statement', text: 'Spoken', bars: 1, say: 'A line.', seconds: 3.4, spoken: { key: 'k', seconds: 2.7, parts: [[.25, 2.95, 'A line.']] } },
    { id: 'c', kind: 'scene', bars: 2, scene: { setting: 'lab', shot: 'close' } }],
    chapters: [{ id: 'c1', title: 'One', start: 'a' }, { id: 'c2', title: 'Two', start: 'c' }] };

  // Clips: bars at the tempo, narrated beats at their measured length.
  const list = M.clips(p);
  assert.deepEqual(list.map(c => [c.start, c.end]), [[0, 2], [2, 5.4], [5.4, 9.4]]);
  assert.deepEqual(list.map(c => c.narrated), [false, true, false]);
  assert.equal(list[2].label, 'lab, close shot');
  assert.equal(M.totalSeconds(p), 9.4);
  assert.deepEqual(M.chapterMarks(p, list).map(m => [m.title, m.time]), [['One', 0], ['Two', 5.4]]);
  assert.equal(M.clipAt(list, 2).id, 'b'); assert.equal(M.clipAt(list, 99).id, 'c');

  // Timecodes and frame steps at 30 fps.
  assert.equal(M.timecode(0), '00:00.00');
  assert.equal(M.timecode(65.5), '01:05.15');
  assert.equal(M.timecode(3725), '1:02:05.00');
  assert.equal(M.stepFrames(1, 1, 10), 1 + 1 / 30);
  assert.equal(M.stepFrames(0, -10, 10), 0);
  assert.equal(M.stepFrames(9.99, 10, 10), 299 / 30, 'Stepping stops on the last frame');
  assert.equal(M.spokenTime(65.25), '1 min 5.3 s');

  // Zoom: clamped, the slider is logarithmic both ways, fit shows the whole video.
  assert.equal(M.clampZoom(1), M.ZOOM.min); assert.equal(M.clampZoom(9999), M.ZOOM.max);
  for (const z of [4, 30, 60, 200, 480]) assert.ok(Math.abs(M.sliderToZoom(M.zoomToSlider(z)) - z) / z < .01, 'slider round trip ' + z);
  assert.ok(M.fitZoom(10, 1024) * 10 <= 1000);
  assert.equal(M.zoomBy(60, 2), 120);

  // Ruler: labels stay apart at every zoom; ticks start at 0 and include the end.
  for (const z of [4, 20, 60, 200, 480]) {
    const { major, minor } = M.rulerStep(z);
    assert.ok(major * z >= 72 || major === 600, 'labels apart at ' + z); assert.ok(minor <= major);
  }
  const ticks = M.rulerTicks(60, 9.4);
  assert.equal(ticks[0].t, 0); assert.ok(ticks[0].major); assert.equal(ticks[0].label, '0:00');
  assert.ok(ticks.filter(t => t.major).map(t => t.label).includes('0:08'));
  assert.equal(M.rulerLabel(1 + 1 / 30, 1 / 15), '01.01');

  // Snapping: within 8 px only; the nearest target wins.
  const targets = M.snapTargets(list, { playhead: 4, marks: M.chapterMarks(p, list) });
  assert.deepEqual(targets, [0, 2, 4, 5.4, 9.4]);
  assert.deepEqual(M.snap(2.1, targets, 60), { t: 2, snapped: true });
  assert.deepEqual(M.snap(2.3, targets, 60), { t: 2.3, snapped: false });
  assert.deepEqual(M.snap(3.95, targets, 60), { t: 4, snapped: true });

  // Trimming: half-bar steps from 0.5 to 8 at the tempo.
  assert.equal(M.barsFor(2, 120), 1); assert.equal(M.barsFor(2.6, 120), 1.5); assert.equal(M.barsFor(.1, 120), .5); assert.equal(M.barsFor(99, 120), 8);
  // Dropping a dragged clip.
  assert.equal(M.dropIndex(list, 8, 0), 2, 'First clip dropped after the last');
  assert.equal(M.dropIndex(list, .5, 2), 0, 'Last clip dropped at the start');
  assert.equal(M.dropIndex(list, 3, 1), 1, 'Dropped on itself stays');

  // J/K/L and playback in the work area.
  assert.deepEqual([M.shuttle(0, 'l'), M.shuttle(1, 'l'), M.shuttle(4, 'l'), M.shuttle(8, 'l')], [1, 2, 8, 8]);
  assert.deepEqual([M.shuttle(2, 'j'), M.shuttle(-1, 'j'), M.shuttle(-8, 'j'), M.shuttle(-2, 'k')], [-1, -2, -8, 0]);
  assert.deepEqual(M.playRange(10, 2, 5), { start: 2, end: 5 });
  assert.deepEqual(M.playRange(10, 5, 5), { start: 0, end: 10 }, 'An empty work area plays everything');
  assert.deepEqual(M.advance(4.9, .2, 1, { start: 2, end: 5 }, true).t.toFixed(2), '2.10');
  assert.deepEqual(M.advance(4.9, .2, 1, { start: 2, end: 5 }, false), { t: 5, stopped: true });
  assert.equal(M.advance(2.1, .2, -1, { start: 2, end: 5 }, true).t.toFixed(2), '4.90');

  // Keys.
  const k = (key, extra = {}) => M.keyAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  assert.equal(k(' '), 'play'); assert.equal(k('J'), 'shuttle-j'); assert.equal(k('k'), 'shuttle-k');
  assert.equal(k('ArrowLeft'), 'back-1'); assert.equal(k('ArrowRight', { shiftKey: true }), 'forward-10');
  assert.equal(k('i'), 'mark-in'); assert.equal(k('o'), 'mark-out'); assert.equal(k('x', { altKey: true }), 'clear-work-area');
  assert.equal(k('Delete'), 'delete'); assert.equal(k('d', { ctrlKey: true }), 'duplicate');
  assert.equal(k('z', { ctrlKey: true }), 'undo'); assert.equal(k('Z', { ctrlKey: true, shiftKey: true }), 'redo'); assert.equal(k('y', { metaKey: true }), 'redo');
  assert.equal(k('ArrowRight', { altKey: true }), 'move-later'); assert.equal(k('?', { shiftKey: true }), 'shortcuts');
  assert.equal(k('s', { ctrlKey: true }), null); assert.equal(k('q'), null);
  for (const [keys] of M.SHORTCUTS) assert.ok(!keys.includes('—'), 'No em-dashes');
  assert.equal(M.isTyping({ tagName: 'INPUT', type: 'text' }), true); assert.equal(M.isTyping({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(M.isTyping({ tagName: 'TEXTAREA' }), true); assert.equal(M.isTyping({ tagName: 'BUTTON' }), false);
  assert.equal(M.edgeTime(list, 3, 1), 5.4); assert.equal(M.edgeTime(list, 5.4, -1), 2); assert.equal(M.edgeTime(list, 0, -1), 0); assert.equal(M.edgeTime(list, 9.4, 1), 9.4);

  // Panes: clamped, the preview keeps room, bad stored values fall back, flags default on.
  assert.deepEqual(M.clampPanes({}, { width: 1440, height: 900 }), { left: 248, right: 340, timeline: 236, guides: true, snap: true, ripple: false });
  assert.equal(M.clampPanes({ ripple: true }).ripple, true); assert.equal(M.clampPanes({ ripple: 'yes' }).ripple, false);
  const tight = M.clampPanes({ left: 500, right: 600 }, { width: 1000, height: 700 });
  assert.ok(tight.left + tight.right <= 1000 - 332 + 1 || tight.left === M.PANES.left[0]);
  assert.equal(M.clampPanes({ left: 'x', timeline: 9999 }, { width: 1440, height: 700 }).timeline, 440);
  assert.deepEqual(M.clampPanes({ leftTab: 'assets', rightTab: '<x>', snap: false }).leftTab, 'assets');
  assert.equal(M.clampPanes({ rightTab: '<x>' }).rightTab, undefined);
  assert.equal(M.clampPanes({ snap: false }).snap, false);
  assert.equal(M.panesKey('Alex'), 'kairos:studio-editor:v1:Alex');

  // Narration spans and the music bed ducking under them.
  assert.deepEqual(M.speechSpans(p, list), [{ beat: 'b', start: 2.25, end: 4.95 }]);
  const spans = M.speechSpans(p, list);
  assert.equal(M.musicLevel(1, spans, .8), .8);
  assert.ok(Math.abs(M.musicLevel(3, spans, .8) - .2) < 1e-9, 'Ducked under the voice');
  assert.ok(M.musicLevel(5.1, spans, .8) > .2 && M.musicLevel(5.1, spans, .8) < .8, 'Releases after the line');
  assert.equal(M.musicLevel(2.16, spans, .8) < .8, true, 'Opens early');

  // The scene lists are the server's (scripts/test_studio_tab.py compares them with core).
  assert.equal(M.SETTINGS.length, 6); assert.equal(M.ACTIONS.length, 8);
  // Tracks and clips (step 3): split, trim both edges, ripple delete, room on a track, new clips and the keys.
  const q = { bpm: 120, beats: [{ id: 'a', kind: 'title', bars: 2 }], tracks: [{ id: 't1', kind: 'overlay', name: 'Titles', clips: [
    { id: 'k1', kind: 'text', start: 1, in: 0, out: 2, fade_in: .5, fade_out: .5, text: 'Hi' }, { id: 'k2', kind: 'text', start: 4, in: 0, out: 1, fade_in: 0, fade_out: 0, text: 'Yo' }] }] };
  const t1 = q.tracks[0], k1 = t1.clips[0];
  assert.equal(M.clipEnd(k1), 3); assert.equal(M.findClip(q, 'k2').index, 1); assert.equal(M.findClip(q, 'zz'), null);
  assert.equal(M.uniqueId(q, 'k'), 'k3'); assert.equal(M.uniqueId(q, 't'), 't2');
  assert.equal(M.fits(t1, 3, 1), true); assert.equal(M.fits(t1, 2.5, 1), false); assert.equal(M.fits(t1, 2.5, 1, 'k1'), true);
  assert.equal(M.freeStart(t1, 1.5, 1), 3); assert.equal(M.freeStart(t1, 2.5, 1.5), 5);
  const copy = structuredClone(k1), second = M.splitClip(copy, 2.25, 'k1-1');
  assert.deepEqual([copy.start, copy.in, copy.out, copy.fade_in, copy.fade_out], [1, 0, 1.25, .5, 0]);
  assert.deepEqual([second.start, second.in, second.out, second.fade_in, second.fade_out], [2.25, 1.25, 2, 0, .5]);
  assert.equal(M.splitClip(structuredClone(k1), 1.01, 'x'), null, 'No split inside the first frame');
  assert.deepEqual(M.trimClip(k1, 'left', 2, { track: t1 }), { start: 2, in: 1, out: 2, fade_in: .5, fade_out: .5 });
  assert.equal(M.trimClip(k1, 'left', 0, { track: t1 }).start, 1, 'A left edge never goes before in 0');
  assert.equal(M.trimClip(k1, 'right', 9, { track: t1 }).out, 3, 'A right edge stops at the next clip');
  assert.equal(M.trimClip({ ...k1, id: 'snd' }, 'right', 9, { limit: 2.5 }).out, 2.5, 'A sound stays inside its file');
  assert.equal(M.trimClip(k1, 'right', 1, { track: t1 }).out, .0333, 'At least one frame (to 4 places, as the server keeps it)');
  const rippled = structuredClone(t1); M.removeClip(rippled, 'k1', true); assert.deepEqual(rippled.clips.map(c => [c.id, c.start]), [['k2', 2]]);
  const kept = structuredClone(t1); M.removeClip(kept, 'k1'); assert.equal(kept.clips[0].start, 4);
  const made = M.newClip(q, 'text', 2.5);
  assert.deepEqual([made.id, made.start, made.out, made.style, made.box.x], ['k3', 2.5, 3, 'card', .1]);
  assert.equal(M.newClip(q, 'sound', 0, { audio: 'assets/x.wav', out: 1.2 }).out, 1.2);
  assert.equal(M.clipLabel({ kind: 'sound', audio: 'assets/abc.wav' }, { 'assets/abc.wav': { title: 'Ding' } }), 'Ding');
  assert.ok(M.clipSnapTargets(q, M.clips(q), {}, 'k1').includes(5) && !M.clipSnapTargets(q, M.clips(q), {}, 'k1').includes(3));
  assert.equal(k('s'), 'split'); assert.equal(k('c'), 'comment'); assert.equal(k('Escape'), 'escape');
  assert.equal(M.pinVisible({ t: 2 }, 3.4), true); assert.equal(M.pinVisible({ t: 2 }, 3.6), false);
  assert.deepEqual(M.CLIP_COLORS, ['text', 'dim', 'accent', 'accent-2', 'bg', 'surface', 'white', 'black']);
  console.log('studio editor model ok');
})().catch(error => { console.error(error); process.exit(1); });

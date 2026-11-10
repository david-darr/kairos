// The inspector for a clip on an overlay or audio track (Content Studio Editor build spec, step 3): timing (start,
// length, in, fades), opacity or volume, what it shows (text, image, shape or sound), where it sits (a box as shares
// of the frame) and its track. Written exactly to the schema core/video_tracks.py checks, so a field error lands on
// its field. tabs/studio/view.js owns the project; every edit goes back through helpers.change (one undo step per
// field while typing).
import { el } from './api.js';
import * as M from './studioEditorModel.js';

const KIND_NAME = { text: 'Text clip', image: 'Image clip', shape: 'Shape clip', sound: 'Sound clip' };
const COLOR_NAME = { text: 'Text', dim: 'Soft text', accent: 'Accent', 'accent-2': 'Second accent', bg: 'Background', surface: 'Surface', white: 'White', black: 'Black' };

// options: { p, trackIndex, clipIndex, images: [asset], sounds: {asset: info}, time, helpers: { field, select, change, redraw },
//            actions: { split(), remove(ripple), moveTo(trackId), uploadSound(file) } }
export function clipForm({ p, trackIndex, clipIndex, images = [], sounds = {}, time = 0, helpers, actions }) {
  const track = p.tracks[trackIndex], clip = track.clips[clipIndex], path = `tracks[${trackIndex}].clips[${clipIndex}]`;
  const { field, select, change } = helpers, locked = !!track.locked;
  const box = el('div', { class: 'ste-clip-form', 'data-clip-form': clip.id });
  // Find this clip again by id: sorting by start can move it within its track.
  const edit = (mutate, key) => change(q => { const found = M.findClip(q, clip.id); if (found) { mutate(found.clip, found.track); M.sortClips(found.track); } }, `${clip.id}.${key}`);
  const number = (label, key, { min = 0, max = 1200, step = .01, value = clip[key], hint = '', set } = {}) => {
    const input = el('input', { type: 'number', min, max, step, value: String(Math.round(value * 1000) / 1000), 'aria-label': label, disabled: locked });
    input.value = String(Math.round(value * 1000) / 1000);
    input.addEventListener('input', () => { const v = Number(input.value); if (input.value !== '' && Number.isFinite(v)) edit(c => (set ? set(c, v) : (c[key] = v)), key); });
    return field(label, input, `${path}.${key}`, hint);
  };
  const range = (label, key, hint) => {
    const output = el('output', { text: `${Math.round(clip[key] * 100)}%` });
    const input = el('input', { type: 'range', min: 0, max: 1, step: .01, value: clip[key], 'aria-label': label, disabled: locked });
    input.addEventListener('input', () => { output.textContent = `${Math.round(Number(input.value) * 100)}%`; edit(c => { c[key] = Number(input.value); }, key); });
    return field(label, el('div', { class: 'ste-range' }, [input, output]), `${path}.${key}`, hint);
  };
  const choice = (label, key, values, names = {}) => {
    const node = select(label, values.map(v => [v, names[v] || v]), clip[key], v => edit(c => { c[key] = v; }, key));
    node.disabled = locked;
    return field(label, node, `${path}.${key}`);
  };
  const length = M.clipLength(clip);
  box.append(el('div', { class: 'ste-inspector-head' }, [el('h3', { text: `${KIND_NAME[clip.kind]} ${clip.id}` }),
    el('p', { class: 'meta', text: `On ${track.name}, ${M.timecode(clip.start)} to ${M.timecode(M.clipEnd(clip))}, ${length.toFixed(2)} s` })]));
  if (locked) box.append(el('p', { class: 'meta ste-locked-note', role: 'note', text: 'This track is locked. Unlock it on the timeline (L) to change its clips.' }));

  // What it shows.
  const content = el('section', { class: 'ste-group', 'data-group': 'clip-content' }, [el('h4', { text: clip.kind === 'sound' ? 'Sound' : 'Content' })]);
  if (clip.kind === 'text') {
    const text = el('textarea', { rows: 2, maxlength: 140, 'aria-label': 'Clip text', disabled: locked });
    text.value = clip.text || '';
    const node = field('Text', text, `${path}.text`, `${(clip.text || '').length}/140 characters`);
    text.addEventListener('input', () => { edit(c => { c.text = text.value; }, 'text'); node.querySelector('.meta').textContent = `${text.value.length}/140 characters`; });
    content.append(node, el('div', { class: 'ste-row2' }, [choice('Size', 'role', ['title', 'body'], { title: 'Headline', body: 'Body' }),
      choice('Style', 'style', ['card', 'plain'], { card: 'On a card', plain: 'Plain' }), choice('Colour', 'color', M.CLIP_COLORS, COLOR_NAME),
      choice('Align', 'align', ['left', 'center', 'right'])]));
  } else if (clip.kind === 'image') {
    const picker = select('Clip image', [['', 'Choose an image'], ...images.map(a => [a, a.slice(7, 23) + '...'])], clip.image || '', v => edit(c => { c.image = v; }, 'image'));
    picker.disabled = locked;
    content.append(field('Image', picker, `${path}.image`, images.length ? 'From this video\'s images (Assets tab).' : 'Upload an image in the Assets tab first.'),
      choice('Fit', 'fit', ['contain', 'cover'], { contain: 'Whole image in the box', cover: 'Fill the box' }));
  } else if (clip.kind === 'shape') {
    content.append(el('div', { class: 'ste-row2' }, [choice('Shape', 'shape', M.CLIP_SHAPES, { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' }),
      choice('Colour', 'color', M.CLIP_COLORS, COLOR_NAME)]));
    const fill = el('input', { type: 'checkbox', checked: clip.fill !== false, disabled: locked, 'aria-label': 'Filled' });
    fill.addEventListener('change', () => edit(c => { c.fill = fill.checked; }, 'fill'));
    content.append(el('label', { class: 'studio-check' }, [fill, el('span', { text: 'Filled (off draws the outline)' })]),
      number('Line width (share of the short side)', 'stroke', { min: .001, max: .05, step: .001 }));
  } else {
    const list = Object.entries(sounds);
    const picker = select('Clip sound', [['', 'Choose a sound'], ...list.map(([a, info]) => [a, `${info.title} (${info.seconds.toFixed(1)} s)`])], clip.audio || '', v => edit(c => { c.audio = v; }, 'audio'));
    picker.disabled = locked;
    content.append(field('Sound', picker, `${path}.audio`, 'Your own sound files, uploaded in the Assets tab. Kairos never fetches sounds.'));
  }
  box.append(content);

  // When it plays.
  const timing = el('section', { class: 'ste-group', 'data-group': 'clip-timing' }, [el('h4', { text: 'Timing' })]);
  const limit = clip.kind === 'sound' ? sounds[clip.audio]?.seconds : null;
  timing.append(el('div', { class: 'ste-row2' }, [
    number('Start (seconds)', 'start', { hint: 'Where it begins on the timeline.' }),
    number('Length (seconds)', 'length', { min: 1 / 30, value: length, set: (c, v) => { c.out = Math.round((c.in + Math.max(1 / 30, v)) * 10000) / 10000; } }),
    number(clip.kind === 'sound' ? 'From (seconds into the sound)' : 'In (its own time)', 'in', { max: limit ?? 1200,
      hint: clip.kind === 'sound' ? (limit ? `The sound is ${limit.toFixed(2)} s long.` : '') : 'Shifts where its fades sit.', set: (c, v) => { const d = v - c.in; c.in = v; c.out = Math.round((c.out + d) * 10000) / 10000; } }),
    number('Fade in (seconds)', 'fade_in', { max: 10, step: .05 }), number('Fade out (seconds)', 'fade_out', { max: 10, step: .05 })]));
  timing.append(clip.kind === 'sound' ? range('Volume', 'volume', 'Mixed over the music and narration, then the whole soundtrack is levelled.') : range('Opacity', 'opacity'));
  box.append(timing);

  // Where it sits.
  if (clip.box) {
    const where = el('section', { class: 'ste-group', 'data-group': 'clip-box' }, [el('h4', { text: 'Position and size' })]);
    const share = (label, key) => number(label, key, { min: 0, max: 100, step: .5, value: clip.box[key] * 100, set: (c, v) => { c.box = { ...c.box, [key]: Math.round(v * 10) / 1000 }; } });
    where.append(el('div', { class: 'ste-row2' }, [share('Left (%)', 'x'), share('Top (%)', 'y'), share('Width (%)', 'w'), share('Height (%)', 'h')]),
      el('small', { class: 'studio-error', 'data-error-path': `${path}.box`, role: 'alert' }),
      el('p', { class: 'meta', text: 'Shares of the frame, so it keeps its place in every aspect. Text stays readable inside 5% to 95%; the box is outlined on the preview.' }));
    box.append(where);
  }

  // Which track, and the clip's actions.
  const others = p.tracks.filter(t => t.kind === track.kind);
  const move = select('Track', others.map(t => [t.id, t.name + (t.locked ? ' (locked)' : '')]), track.id, v => actions.moveTo(v));
  move.disabled = locked;
  box.append(el('section', { class: 'ste-group', 'data-group': 'clip-track' }, [el('h4', { text: 'Track' }), field('Track', move, `${path}.track`, 'Later tracks draw on top. The captions stay above every track.'),
    el('div', { class: 'studio-actions' }, [
      actionButton('Split at playhead', () => actions.split(), { title: 'Split (S)', disabled: locked || !(time > clip.start && time < M.clipEnd(clip)) }),
      actionButton('Delete clip', () => actions.remove(false), { class: 'btn danger', disabled: locked, title: 'Delete (Delete key)' }),
      actionButton('Delete and close the gap', () => actions.remove(true), { class: 'btn quiet', disabled: locked, title: 'Ripple delete: later clips on this track move up' })])]));
  return box;
}

function actionButton(text, action, extra = {}) {
  const node = el('button', { type: 'button', class: 'btn', text, ...extra });
  node.addEventListener('click', () => { try { action(); } catch (error) { node.dispatchEvent(new CustomEvent('studio-error', { bubbles: true, detail: error.message })); } });
  return node;
}

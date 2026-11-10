// The inspector for a clip on an overlay or audio track (Content Studio Editor build spec, step 3): timing (start,
// length, in, fades), opacity or volume, what it shows (text, image, shape or sound), where it sits (a box as shares
// of the frame) and its track. Written exactly to the schema core/video_tracks.py checks, so a field error lands on
// its field. tabs/studio/view.js owns the project; every edit goes back through helpers.change (one undo step per
// field while typing). Step 5 adds Motion: each keyable property's value at the playhead, Animate (keyframes on or
// off), a key at the playhead with its ease, and the previous or next key. Step 7 adds video clips.
import { el } from './api.js';
import * as M from './studioEditorModel.js';

const KIND_NAME = { text: 'Text clip', image: 'Image clip', shape: 'Shape clip', video: 'Video clip', sound: 'Sound clip' };
const COLOR_NAME = { text: 'Text', dim: 'Soft text', accent: 'Accent', 'accent-2': 'Second accent', bg: 'Background', surface: 'Surface', white: 'White', black: 'Black' };

// options: { p, trackIndex, clipIndex, images: [asset], sounds: {asset: info}, time, helpers: { field, select, change, redraw },
//            actions: { split(), remove(ripple), moveTo(trackId), uploadSound(file) } }
export function clipForm({ p, trackIndex, clipIndex, images = [], sounds = {}, media = {}, time = 0, selectedKeys = [], helpers, actions }) {
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
  } else if (clip.kind === 'video') {
    const list = Object.entries(media);
    const picker = select('Clip video', [['', 'Choose a video'], ...list.map(([m, info]) => [m, `${info.title} (${info.seconds.toFixed(1)} s)`])], clip.video || '', v => edit(c => { c.video = v; }, 'video'));
    picker.disabled = locked;
    const info = media[clip.video];
    content.append(field('Video', picker, `${path}.video`, info ? `${info.seconds.toFixed(1)} s, ${info.width} x ${info.height}, 30 frames a second. Its sound is a separate sound clip.` : 'Upload a video file in the Assets tab first.'),
      choice('Fit', 'fit', ['contain', 'cover'], { contain: 'Whole picture in the box', cover: 'Fill the box' }));
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
  const limit = clip.kind === 'sound' ? sounds[clip.audio]?.seconds : clip.kind === 'video' ? media[clip.video]?.seconds : null;
  timing.append(el('div', { class: 'ste-row2' }, [
    number('Start (seconds)', 'start', { hint: 'Where it begins on the timeline.' }),
    number('Length (seconds)', 'length', { min: 1 / 30, value: length, set: (c, v) => { c.out = Math.round((c.in + Math.max(1 / 30, v)) * 10000) / 10000; } }),
    number(clip.kind === 'sound' ? 'From (seconds into the sound)' : clip.kind === 'video' ? 'From (seconds into the video)' : 'In (its own time)', 'in', { max: limit ?? 1200,
      hint: clip.kind === 'sound' || clip.kind === 'video' ? (limit ? `The file is ${limit.toFixed(2)} s long.` : '') : 'Shifts where its fades and keyframes sit.', set: (c, v) => { const d = v - c.in; c.in = v; c.out = Math.round((c.out + d) * 10000) / 10000; } }),
    number('Fade in (seconds)', 'fade_in', { max: 10, step: .05 }), number('Fade out (seconds)', 'fade_out', { max: 10, step: .05 })]));
  timing.append(clip.kind === 'sound' ? range('Volume', 'volume', 'Mixed over the music and narration, then the whole soundtrack is levelled.')
    : clip.keys?.opacity?.length ? el('p', { class: 'meta', text: 'Opacity is animated: change it under Motion.' }) : range('Opacity', 'opacity'));
  box.append(timing);

  // Where it sits.
  if (clip.box) {
    const where = el('section', { class: 'ste-group', 'data-group': 'clip-box' }, [el('h4', { text: 'Position and size' })]);
    const share = (label, key) => number(label, key, { min: 0, max: 100, step: .5, value: clip.box[key] * 100, set: (c, v) => { c.box = { ...c.box, [key]: Math.round(v * 10) / 1000 }; } });
    where.append(el('div', { class: 'ste-row2' }, [share('Left (%)', 'x'), share('Top (%)', 'y'), share('Width (%)', 'w'), share('Height (%)', 'h')]),
      el('small', { class: 'studio-error', 'data-error-path': `${path}.box`, role: 'alert' }),
      el('p', { class: 'meta', text: 'Shares of the frame, so it keeps its place in every aspect. Text stays readable inside 5% to 95%. Drag the box on the preview to move, scale or turn it; an animated left or top is set under Motion.' }));
    box.append(where);
  }

  // Motion (step 5): keyframes on position, size, turn and opacity.
  if (clip.box) box.append(motion());

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

  function motion() {
    const inside = time >= clip.start && time <= M.clipEnd(clip), at = Math.min(Math.max(time, clip.start), M.clipEnd(clip) - 1e-4);
    const values = M.clipValues(clip, at), own = M.ownTime(clip, at), moments = M.keyMoments(clip);
    const here = moments.find(m => Math.abs(m.own - own) < 1 / 120);
    const section = el('section', { class: 'ste-group ste-motion', 'data-group': 'clip-motion' }, [el('h4', { text: 'Motion' }),
      el('p', { class: 'meta', text: inside ? `Values at the playhead, ${M.timecode(time)}. A property with Animate on gets a keyframe where you change it; the others keep one value.` : 'Move the playhead inside the clip to see and key its values.' })]);
    const SHOW = { x: [v => v * 100, v => v / 100, '%', .5], y: [v => v * 100, v => v / 100, '%', .5], scale: [v => v * 100, v => v / 100, '%', 1], rotation: [v => v, v => v, 'degrees', 1], opacity: [v => v * 100, v => v / 100, '%', 1] };
    const rows = el('div', { class: 'ste-motion-rows' });
    for (const prop of M.KEY_PROPS) {
      const [toShow, fromShow, unit, step] = SHOW[prop], keyed = !!clip.keys?.[prop]?.length;
      const input = el('input', { type: 'number', step, value: String(Math.round(toShow(values[prop]) * 100) / 100), 'aria-label': `${M.KEY_NAMES[prop]} (${unit})`, disabled: locked || !inside, 'data-motion': prop });
      input.value = String(Math.round(toShow(values[prop]) * 100) / 100);
      input.addEventListener('change', () => { const v = Number(input.value); if (input.value !== '' && Number.isFinite(v)) { edit(c => M.applyValues(c, at, { [prop]: fromShow(v) }), `motion.${prop}`); actions.redraw?.(); } });
      const animate = el('input', { type: 'checkbox', checked: keyed, disabled: locked || !inside, 'aria-label': `Animate ${M.KEY_NAMES[prop].toLowerCase()}`, 'data-animate': prop });
      animate.addEventListener('change', () => { edit(c => { if (animate.checked) M.setKey(c, prop, at, M.clipValues(c, at)[prop]); else M.unanimate(c, prop, at); }, `animate.${prop}`); actions.redraw?.(); });
      const count = clip.keys?.[prop]?.length || 0;
      rows.append(el('div', { class: 'ste-motion-row' + (keyed ? ' keyed' : ''), 'data-prop': prop }, [el('span', { class: 'ste-motion-name', text: M.KEY_NAMES[prop] }), input, el('span', { class: 'meta', text: unit }),
        el('label', { class: 'studio-check' }, [animate, el('span', { text: keyed ? `Animate (${count})` : 'Animate' })])]));
    }
    section.append(rows);
    const ease = select('Ease from this keyframe', Object.entries(M.EASE_NAMES), here ? (clip.keys[here.props[0]].find(k => Math.abs(k.t - here.own) < 1 / 120)?.ease || 'linear') : 'linear',
      v => { edit(c => { for (const prop of M.KEY_PROPS) for (const k of c.keys?.[prop] || []) if (Math.abs(k.t - own) < 1 / 120) k.ease = v; }, 'ease'); actions.redraw?.(); });
    ease.disabled = locked || !here;
    section.append(el('div', { class: 'studio-actions' }, [
      actionButton('< Key', () => actions.jump?.(-1), { title: 'Previous keyframe ([)', 'aria-label': 'Previous keyframe', disabled: !moments.length }),
      actionButton('Add keyframes here', () => actions.keyAll?.(), { class: 'btn primary', title: 'Keyframes at the playhead (A)', disabled: locked || !inside }),
      actionButton('Key >', () => actions.jump?.(1), { title: 'Next keyframe (])', 'aria-label': 'Next keyframe', disabled: !moments.length })]),
    field('Ease from the keyframe at the playhead', ease, `${path}.keys`, here ? `Keyed here: ${here.props.map(k => M.KEY_NAMES[k].toLowerCase()).join(', ')}. The ease shapes the move to the next keyframe.` : 'No keyframe at the playhead.'));
    if (moments.length) section.append(el('ol', { class: 'ste-key-list', 'aria-label': 'Keyframes of this clip' }, moments.map(m => el('li', {}, [
      el('button', { type: 'button', class: 'ste-key-go' + (selectedKeys.some(o => Math.abs(o - m.own) < 1 / 120) ? ' picked' : ''), text: `${M.timecode(m.t)}`, 'aria-label': `Go to the keyframe at ${M.timecode(m.t)}`, onclick: () => actions.seek?.(m.t) }),
      el('span', { class: 'meta', text: m.props.map(k => M.KEY_NAMES[k].toLowerCase()).join(', ') })]))));
    return section;
  }
}

function actionButton(text, action, extra = {}) {
  const node = el('button', { type: 'button', class: 'btn', text, ...extra });
  node.addEventListener('click', () => { try { action(); } catch (error) { node.dispatchEvent(new CustomEvent('studio-error', { bubbles: true, detail: error.message })); } });
  return node;
}

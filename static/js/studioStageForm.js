// The Pack B stage beat's inspector form (Content Studio Editor build spec, step 2): the set's tone, shot, pedestal,
// 3D characters on screen (position, expression, action, facing, who speaks, a reaction at a time), stand-in people,
// glossy props and labels floating over heads. It replaces editing the stage as raw JSON and writes exactly what
// core/video_store.py _stage checks, so field errors land on the field. static/motion/stage.js (Pack B) draws it and is
// not touched here.
// Pack C's voxel beat (static/js/studioVoxelForm.js) has the same cast, stand-in people and labels (video_store
// _shot_cast, _shot_people, _shot_labels), so those three parts are built here by shotParts for both forms.
import { el } from './api.js';
import * as M from './studioEditorModel.js';

export const words = v => String(v).replaceAll('_', ' ').replaceAll('-', ' ');
export const options = values => values.map(v => [v, words(v)]);
export const across = v => v === 0 ? 'centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`;

// A range with its value shown beside it; `write` gets each new value.
export function rangeField(field, label, aria, value, min, max, step, show, at, write) {
  const input = el('input', { type: 'range', min, max, step, value, 'aria-label': aria });
  input.value = String(value);
  const out = el('output', { text: show(value) });
  input.addEventListener('input', () => { out.textContent = show(Number(input.value)); write(Number(input.value)); });
  return field(label, el('div', { class: 'ste-range' }, [input, out]), at);
}
export const errorSlot = path => el('small', { class: 'studio-error', 'data-error-path': path, 'data-error-exact': '', role: 'alert' });

// The cast, stand-in people and labels of a 3D shot. `noun` names a cast member in labels ("3D character", "blocky
// character"), `form` is the character form the shot casts, `tag` the data attribute prefix (stage, voxel).
export function shotParts({ shot, where, set, helpers, cast, names, forms, form, noun, tag, maxPeople, noCast }) {
  const { field, select, redraw } = helpers;
  const range = (...args) => rangeField(field, ...args);
  const remove = (label, action) => el('button', { type: 'button', class: 'btn quiet', text: 'Remove', 'aria-label': label, onclick: () => { set(action); redraw(); } });
  const Noun = noun[0].toUpperCase() + noun.slice(1);

  const members = Array.isArray(shot.cast) ? shot.cast : [];
  const castIds = (cast || []).map(c => c.character).filter(id => forms[id] === form);
  const nameOf = id => names[id] || `Character ${id.slice(0, 6)}`;
  const castBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `${Noun}s on screen (${members.length} of ${M.MAX_ON_SCREEN})` })]);
  members.forEach((m, i) => {
    const n = i + 1, at = `${where}.cast[${i}]`;
    const free = castIds.filter(id => id === m.character || !members.some(o => o.character === id));
    const choices = free.includes(m.character) ? free : [m.character, ...free];
    const speaks = el('input', { type: 'checkbox', checked: !!m.speaking, 'aria-label': `${Noun} ${n} speaks the narration` });
    speaks.addEventListener('change', () => set(s => { s.cast.forEach((o, j) => { o.speaking = j === i ? speaks.checked : speaks.checked ? false : o.speaking; }); }));
    const reacts = el('input', { type: 'checkbox', checked: !!m.react, 'aria-label': `${Noun} ${n} reacts` });
    reacts.addEventListener('change', () => { set(s => { if (reacts.checked) s.cast[i].react = { at: 1, expression: 'surprised' }; else delete s.cast[i].react; }); redraw(); });
    // Labels name cast members by place (c0, c1, ...): removing one shifts the labels after it.
    const dropMember = s => {
      s.cast.splice(i, 1);
      s.labels = (s.labels || []).filter(l => l.over !== `c${i}`)
        .map(l => l.over[0] === 'c' && Number(l.over.slice(1)) > i ? { ...l, over: 'c' + (Number(l.over.slice(1)) - 1) } : l);
    };
    const row = el('div', { class: 'ste-member', [`data-${tag}-member`]: n }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `${n}. ${nameOf(m.character)}` }), remove(`Remove ${noun} ${n}`, dropMember)]),
      field('Character', select(`${Noun} ${n}`, choices.map(id => [id, nameOf(id)]), m.character, v => { set(s => { s.cast[i].character = v; }); redraw(); }), at + '.character'),
      range('Position', `Position of ${noun} ${n}`, m.x ?? 0, -1, 1, .01, across, at + '.x', v => set(s => { s.cast[i].x = v; }, `${at}.x`)),
      el('div', { class: 'ste-row2' }, [
        field('Expression', select(`Expression of ${noun} ${n}`, options(M.EXPRESSIONS), m.expression || 'neutral', v => set(s => { s.cast[i].expression = v; })), at + '.expression'),
        field('Action', select(`Action of ${noun} ${n}`, options(M.ACTIONS), m.action || 'idle', v => set(s => { s.cast[i].action = v; })), at + '.action'),
        field('Facing', select(`Facing of ${noun} ${n}`, options(M.STAGE_FACINGS), m.facing || 'camera', v => set(s => { s.cast[i].facing = v; })), at + '.facing')]),
      el('label', { class: 'studio-check' }, [speaks, el('span', { text: 'Speaks the narration (one at a time)' })]),
      el('label', { class: 'studio-check' }, [reacts, el('span', { text: 'Reacts during the shot' })])]);
    if (m.react) {
      const when = el('input', { type: 'number', min: 0, max: 60, step: .1, value: m.react.at ?? 1, 'aria-label': `When ${noun} ${n} reacts, seconds into the shot` });
      when.value = String(m.react.at ?? 1);
      when.addEventListener('input', () => set(s => { s.cast[i].react.at = Number(when.value); }, `${at}.react.at`));
      row.append(el('div', { class: 'ste-row2' }, [field('Reacts at (seconds)', when, at + '.react.at'),
        field('Changes to', select(`Reaction of ${noun} ${n}`, options(M.EXPRESSIONS), m.react.expression || 'surprised', v => set(s => { s.cast[i].react.expression = v; })), at + '.react.expression')]));
    }
    castBox.append(row);
  });
  const addable = castIds.filter(id => !members.some(m => m.character === id));
  if (!castIds.length) castBox.append(el('p', { class: 'meta', text: noCast }));
  castBox.append(el('button', { type: 'button', class: 'btn', text: `Add a ${noun}`, disabled: !addable.length || members.length >= M.MAX_ON_SCREEN, onclick: () => {
    set(s => { s.cast ||= []; s.cast.push({ character: addable[0], x: 0, expression: 'neutral', action: 'idle', facing: 'camera', speaking: false }); }); redraw();
  } }), errorSlot(where + '.cast'));

  // Stand-in people.
  const people = shot.people || { count: 0 };
  const seed = el('input', { type: 'number', min: 0, max: 999, step: 1, value: people.seed ?? 0, 'aria-label': 'Stand-in people variation' });
  seed.value = String(people.seed ?? 0);
  seed.addEventListener('input', () => set(s => { s.people = { count: 0, ...(s.people || {}), seed: Math.round(Number(seed.value)) }; }, where + '.people.seed'));
  const peopleBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: 'Stand-in people' }), el('div', { class: 'ste-row2' }, [
    range('How many', 'Stand-in people', people.count ?? 0, 0, maxPeople, 1, v => `${v} ${v === 1 ? 'person' : 'people'}`, where + '.people.count',
      v => set(s => { s.people = { ...(s.people || {}), count: v }; s.labels = (s.labels || []).filter(l => l.over[0] !== 'p' || Number(l.over.slice(1)) < v); }, where + '.people.count')),
    field('Variation', seed, where + '.people.seed', 'A number from 0 to 999 that varies their looks.')])]);

  // Labels floating over a cast member (c0, c1, ...) or a stand-in person (p0, p1, ...).
  const labels = Array.isArray(shot.labels) ? shot.labels : [];
  const heads = [...members.map((m, i) => [`c${i}`, nameOf(m.character)]), ...Array.from({ length: people.count || 0 }, (_, i) => [`p${i}`, `Person ${i + 1}`])];
  const labelBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `Labels over heads (${labels.length} of ${M.MAX_LABELS})` })]);
  labels.forEach((label, i) => {
    const n = i + 1, at = `${where}.labels[${i}]`;
    const text = el('input', { value: label.text || '', maxlength: 16, 'aria-label': `Label ${n} text` });
    text.value = label.text || '';
    text.addEventListener('input', () => set(s => { s.labels[i].text = text.value; }, `${at}.text`));
    const sub = el('input', { value: label.sub || '', maxlength: 32, 'aria-label': `Label ${n} line under it` });
    sub.value = label.sub || '';
    sub.addEventListener('input', () => set(s => { s.labels[i].sub = sub.value; }, `${at}.sub`));
    const when = el('input', { type: 'number', min: 0, max: 60, step: .1, value: label.at ?? 0, 'aria-label': `Label ${n} appears at, seconds` });
    when.value = String(label.at ?? 0);
    when.addEventListener('input', () => set(s => { s.labels[i].at = Number(when.value); }, `${at}.at`));
    const over = heads.some(([v]) => v === label.over) ? heads : [[label.over, label.over], ...heads];
    labelBox.append(el('div', { class: 'ste-member', [`data-${tag}-label`]: n }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `${n}. ${label.text || 'Label'}` }), remove(`Remove label ${n}`, s => { s.labels.splice(i, 1); })]),
      field('Floats over', select(`Label ${n} floats over`, over, label.over, v => set(s => { s.labels[i].over = v; })), at + '.over'),
      el('div', { class: 'ste-row2' }, [field('Text', text, at + '.text', 'Up to 16 characters, like 5 h 40 m.'), field('Line under it', sub, at + '.sub', 'Up to 32 characters.'),
        field('Appears at (seconds)', when, at + '.at')])]));
  });
  labelBox.append(el('button', { type: 'button', class: 'btn', text: 'Add a label', disabled: !heads.length || labels.length >= M.MAX_LABELS,
    title: heads.length ? 'Add a label' : `Put a ${noun} or a stand-in person on the shot first.`, onclick: () => {
      set(s => { s.labels ||= []; s.labels.push({ over: heads[0][0], text: 'New', sub: '', at: 0 }); }); redraw();
    } }), errorSlot(where + '.labels'));
  return { castBox, peopleBox, labelBox, remove };
}

// helpers: field(label, control, path, hint), select(label, values, value, onChange), change(mutate, group), redraw()
export function stageForm({ beat, path, cast, names, forms = {}, helpers }) {
  const { field, select, change, redraw } = helpers;
  const stage = beat.stage || {}, where = path + '.stage';
  const set = (mutate, group) => change(p => {
    const b = p.beats.find(x => x.id === beat.id);
    b.stage ||= { set: 'lavender', shot: 'medium', cast: [], people: { count: 0 }, props: [], labels: [] };
    mutate(b.stage);
  }, group);
  const range = (...args) => rangeField(field, ...args);
  const box = el('div', { class: 'ste-scene', 'data-stage-form': '' });
  const pedestal = el('input', { type: 'checkbox', checked: !!stage.pedestal, 'aria-label': 'Pedestal under the cast' });
  pedestal.addEventListener('change', () => set(s => { s.pedestal = pedestal.checked; }));
  box.append(el('div', { class: 'ste-row2' }, [
    field('Set', select('Stage set', options(M.STAGE_SETS), stage.set || 'lavender', v => set(s => { s.set = v; })), where + '.set'),
    field('Shot', select('Stage shot', options(M.SHOTS), stage.shot || 'medium', v => set(s => { s.shot = v; })), where + '.shot')]),
  el('label', { class: 'studio-check' }, [pedestal, el('span', { text: 'A pedestal under the cast' })]));

  // 3D characters on screen (only 3D characters the project casts), stand-in people and labels.
  const parts = shotParts({ shot: stage, where, set, helpers, cast, names, forms, form: '3d', noun: '3D character', tag: 'stage', maxPeople: M.MAX_PEOPLE,
    noCast: 'This video has no 3D character in its cast yet. Add one (form 3D) in Project > Cast first.' });
  box.append(parts.castBox, parts.peopleBox);

  // Glossy props.
  const props = Array.isArray(stage.props) ? stage.props : [];
  const propBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `Props (${props.length} of ${M.MAX_PROPS})` })]);
  props.forEach((prop, i) => {
    const n = i + 1, at = `${where}.props[${i}]`;
    propBox.append(el('div', { class: 'ste-member', 'data-stage-prop': n }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `${n}. ${prop.shape}` }), parts.remove(`Remove 3D prop ${n}`, s => { s.props.splice(i, 1); })]),
      el('div', { class: 'ste-row2' }, [
        field('Shape', select(`3D prop ${n}`, options(M.STAGE_PROPS), prop.shape, v => { set(s => { s.props[i].shape = v; }); redraw(); }), at + '.shape'),
        field('Colour', select(`Colour of 3D prop ${n}`, M.STAGE_COLORS.map((c, k) => [String(k), c]), String(prop.color ?? i % 5), v => set(s => { s.props[i].color = Number(v); })), at + '.color')]),
      range('Across', `3D prop ${n} across`, prop.x ?? 0, -1, 1, .01, across, at + '.x', v => set(s => { s.props[i].x = v; }, `${at}.x`)),
      range('Depth', `3D prop ${n} depth`, prop.depth ?? .5, 0, 1, .01, v => `${Math.round(v * 100)}% back`, at + '.depth', v => set(s => { s.props[i].depth = v; }, `${at}.depth`)),
      range('Size', `3D prop ${n} size`, prop.size ?? .4, .1, 1, .01, v => `${Math.round(v * 100)}%`, at + '.size', v => set(s => { s.props[i].size = v; }, `${at}.size`))]));
  });
  propBox.append(el('button', { type: 'button', class: 'btn', text: 'Add a 3D prop', disabled: props.length >= M.MAX_PROPS, onclick: () => {
    set(s => { s.props ||= []; const k = s.props.length; s.props.push({ shape: M.STAGE_PROPS[k % M.STAGE_PROPS.length], x: k % 2 ? .7 : -.7, depth: .5, size: .4, color: k % 5 }); }); redraw();
  } }), errorSlot(where + '.props'));
  box.append(propBox, parts.labelBox, errorSlot(where));
  return box;
}

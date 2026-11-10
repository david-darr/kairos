// The scene beat's inspector form (Content Studio Editor build spec, step 2): setting, shot, cast on screen with
// position, view, expression, action, facing, head turn and who speaks, and the props. It replaces editing the scene
// as raw JSON and writes exactly the schema core/video_store.py checks (_scene), so field errors land on the field.
import { el } from './api.js';
import * as M from './studioEditorModel.js';

const words = v => String(v).replaceAll('_', ' ');
const options = values => values.map(v => [v, words(v)]);

// helpers: field(label, control, path, hint), select(label, values, value, onChange), change(mutate, group), redraw()
export function sceneForm({ beat, path, cast, names, forms = {}, helpers }) {
  const { field, select, change, redraw } = helpers;
  const scene = beat.scene || {}, where = path + '.scene';
  const set = (mutate, group) => change(p => { const b = p.beats.find(x => x.id === beat.id); b.scene ||= { setting: 'meadow', shot: 'medium', cast: [], props: [] }; mutate(b.scene); }, group);
  const box = el('div', { class: 'ste-scene', 'data-scene-form': '' });
  box.append(el('div', { class: 'ste-row2' }, [
    field('Setting', select('Setting', options(M.SETTINGS), scene.setting || 'meadow', v => set(s => { s.setting = v; })), where + '.setting'),
    field('Shot', select('Shot', options(M.SHOTS), scene.shot || 'medium', v => set(s => { s.shot = v; })), where + '.shot')]));

  // Cast on screen: only characters the project casts (each pinned to a version).
  const members = Array.isArray(scene.cast) ? scene.cast : [];
  const castBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `Characters on screen (${members.length} of ${M.MAX_ON_SCREEN})` })]);
  // A scene shows flat (2D) characters; 3D ones (Pack B) play stage beats.
  const castIds = (cast || []).map(c => c.character).filter(id => forms[id] !== '3d'), nameOf = id => names[id] || `Character ${id.slice(0, 6)}`;
  members.forEach((m, i) => {
    const n = i + 1, at = `${where}.cast[${i}]`;
    const free = castIds.filter(id => id === m.character || !members.some(o => o.character === id));
    const choices = free.includes(m.character) ? free : [m.character, ...free];
    const x = el('input', { type: 'range', min: 0, max: 1, step: .01, value: m.x ?? .5, 'aria-label': `Position of character ${n}` });
    x.value = String(m.x ?? .5);
    const xOut = el('output', { text: `${Math.round((m.x ?? .5) * 100)}% across` });
    x.addEventListener('input', () => { xOut.textContent = `${Math.round(Number(x.value) * 100)}% across`; set(s => { s.cast[i].x = Number(x.value); }, `${at}.x`); });
    const speaks = el('input', { type: 'checkbox', checked: !!m.speaking, 'aria-label': `Character ${n} speaks the narration` });
    speaks.addEventListener('change', () => set(s => { s.cast.forEach((o, j) => { o.speaking = j === i ? speaks.checked : speaks.checked ? false : o.speaking; }); }));
    const row = el('div', { class: 'ste-member', 'data-member': n }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `${n}. ${nameOf(m.character)}` }),
        el('button', { type: 'button', class: 'btn quiet', text: 'Remove', 'aria-label': `Remove character ${n}`, onclick: () => { set(s => { s.cast.splice(i, 1); }); redraw(); } })]),
      field('Character', select(`Character ${n}`, choices.map(id => [id, nameOf(id)]), m.character, v => { set(s => { s.cast[i].character = v; }); redraw(); }), at + '.character'),
      field('Position', el('div', { class: 'ste-range' }, [x, xOut]), at + '.x'),
      el('div', { class: 'ste-row2' }, [
        field('View', select(`View of character ${n}`, options(M.VIEWS), m.view || 'front', v => set(s => { s.cast[i].view = v; })), at + '.view'),
        field('Expression', select(`Expression of character ${n}`, options(M.EXPRESSIONS), m.expression || 'neutral', v => set(s => { s.cast[i].expression = v; })), at + '.expression'),
        field('Action', select(`Action of character ${n}`, options(M.ACTIONS), m.action || 'idle', v => set(s => { s.cast[i].action = v; })), at + '.action'),
        field('Facing', select(`Facing of character ${n}`, [['right', 'right'], ['left', 'left']], m.facing || 'right', v => set(s => { s.cast[i].facing = v; })), at + '.facing'),
        field('Head turns to', select(`Head turn of character ${n}`, [['', 'no turn'], ...options(M.VIEWS)], m.turn || '', v => set(s => { if (v) s.cast[i].turn = v; else delete s.cast[i].turn; })), at + '.turn')]),
      el('label', { class: 'studio-check' }, [speaks, el('span', { text: 'Speaks the narration (one at a time; the mouth follows the voice)' })])]);
    castBox.append(row);
  });
  const addable = castIds.filter(id => !members.some(m => m.character === id));
  if (!castIds.length) castBox.append(el('p', { class: 'meta', text: 'This video has no cast yet. Add a character in Project > Cast first.' }));
  const add = el('button', { type: 'button', class: 'btn', text: 'Add a character', 'aria-label': 'Add a character to the scene',
    disabled: !addable.length || members.length >= M.MAX_ON_SCREEN, onclick: () => {
      set(s => { s.cast ||= []; const k = s.cast.length; s.cast.push({ character: addable[0], x: Math.round((k + 1) / (k + 2) * 100) / 100, view: 'front', expression: 'neutral', action: 'idle', facing: 'right', speaking: false }); });
      redraw();
    } });
  castBox.append(add, el('small', { class: 'studio-error', 'data-error-path': where + '.cast', role: 'alert' }));
  box.append(castBox);

  // Props: icons from a fixed set, placed in the frame.
  const props = Array.isArray(scene.props) ? scene.props : [];
  const propBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `Props (${props.length} of ${M.MAX_PROPS})` })]);
  props.forEach((prop, i) => {
    const n = i + 1, at = `${where}.props[${i}]`;
    const slider = (key, label, min, max, step, fallback, show) => {
      const input = el('input', { type: 'range', min, max, step, value: prop[key] ?? fallback, 'aria-label': `Prop ${n} ${label}` });
      input.value = String(prop[key] ?? fallback);
      const out = el('output', { text: show(prop[key] ?? fallback) });
      input.addEventListener('input', () => { out.textContent = show(Number(input.value)); set(s => { s.props[i][key] = Number(input.value); }, `${at}.${key}`); });
      return field(label[0].toUpperCase() + label.slice(1), el('div', { class: 'ste-range' }, [input, out]), `${at}.${key}`);
    };
    const floats = el('input', { type: 'checkbox', checked: !!prop.float, 'aria-label': `Prop ${n} floats` });
    floats.addEventListener('change', () => set(s => { s.props[i].float = floats.checked; }));
    propBox.append(el('div', { class: 'ste-member', 'data-prop': n }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `${n}. ${prop.icon}` }),
        el('button', { type: 'button', class: 'btn quiet', text: 'Remove', 'aria-label': `Remove prop ${n}`, onclick: () => { set(s => { s.props.splice(i, 1); }); redraw(); } })]),
      field('Icon', select(`Prop ${n}`, options(M.PROPS), prop.icon, v => { set(s => { s.props[i].icon = v; }); redraw(); }), at + '.icon'),
      slider('x', 'across', 0, 1, .01, .5, v => `${Math.round(v * 100)}%`), slider('y', 'height', 0, 1, .01, .3, v => `${Math.round(v * 100)}% down`),
      slider('size', 'size', .03, .35, .01, .1, v => `${Math.round(v * 100)}% of the frame`),
      el('label', { class: 'studio-check' }, [floats, el('span', { text: 'Floats gently' })])]));
  });
  propBox.append(el('button', { type: 'button', class: 'btn', text: 'Add a prop', disabled: props.length >= M.MAX_PROPS, onclick: () => {
    set(s => { s.props ||= []; s.props.push({ icon: M.PROPS[s.props.length % M.PROPS.length], x: .5, y: .3, size: .1, float: false }); }); redraw();
  } }), el('small', { class: 'studio-error', 'data-error-path': where + '.props', role: 'alert' }));
  box.append(propBox, el('small', { class: 'studio-error', 'data-error-path': where, role: 'alert' }));
  return box;
}

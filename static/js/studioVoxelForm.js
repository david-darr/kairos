// Pack C's voxel beat in the inspector (Content Studio polish for 2.3.0): the look (pastel toy blocks or the classic
// block world), the world, the time of day, the shot, the seed that varies the world, blocky characters on screen
// (position, expression, action, facing, who speaks, a reaction at a time), stand-in people, props and labels over heads.
// It replaces editing the voxel shot as raw JSON and writes exactly what core/video_store.py _voxel checks (the cast,
// people and labels are the stage form's own parts, studioStageForm.js shotParts), so field errors land on the field.
// Fields the form does not show are left as they are. static/motion/voxel.js and classic.js draw it.
import { el } from './api.js';
import * as M from './studioEditorModel.js';
import { shotParts, rangeField, options, across, errorSlot } from './studioStageForm.js';

export const NEW_VOXEL = { world: 'meadow', time: 'day', shot: 'medium', seed: 0, cast: [], people: { count: 0 }, props: [], labels: [] };
const LOOK_NAMES = { pastel: 'Pastel toy blocks', classic: 'Classic block world' };

// helpers: field(label, control, path, hint), select(label, values, value, onChange), change(mutate, group), redraw()
export function voxelForm({ beat, path, cast, names, forms = {}, helpers }) {
  const { field, select, change, redraw } = helpers;
  const voxel = beat.voxel || {}, where = path + '.voxel';
  const classic = voxel.look === 'classic';
  const set = (mutate, group) => change(p => { const b = p.beats.find(x => x.id === beat.id); b.voxel ||= structuredClone(NEW_VOXEL); mutate(b.voxel); }, group);
  const range = (...args) => rangeField(field, ...args);
  const box = el('div', { class: 'ste-scene', 'data-voxel-form': '' });

  // The pastel look is the default and is not stored (video_store drops look: pastel).
  const look = select('Voxel look', M.VOXEL_LOOKS.map(v => [v, LOOK_NAMES[v]]), classic ? 'classic' : 'pastel', v => {
    set(s => { if (v === 'classic') s.look = 'classic'; else delete s.look; }); redraw();
  });
  const seed = el('input', { type: 'number', min: 0, max: 999, step: 1, value: voxel.seed ?? 0, 'aria-label': 'World variation' });
  seed.value = String(voxel.seed ?? 0);
  seed.addEventListener('input', () => set(s => { s.seed = Math.round(Number(seed.value)); }, where + '.seed'));
  box.append(field('Look', look, where + '.look', classic ? 'Classic block characters (form block, such as Rook) play this look; ocean shows as a beach and night as dusk.'
    : 'Blocky characters (form voxel, such as Pip Block) play this look.'),
  el('div', { class: 'ste-row2' }, [
    field('World', select('Voxel world', options(M.VOXEL_WORLDS), voxel.world || 'meadow', v => set(s => { s.world = v; })), where + '.world'),
    field('Time of day', select('Voxel time of day', options(M.VOXEL_TIMES), voxel.time || 'day', v => set(s => { s.time = v; })), where + '.time'),
    field('Shot', select('Voxel shot', options(M.SHOTS), voxel.shot || 'medium', v => set(s => { s.shot = v; })), where + '.shot'),
    field('World variation', seed, where + '.seed', '0 to 999: varies hills, trees and clouds.')]));

  const parts = shotParts({ shot: voxel, where, set, helpers, cast, names, forms, form: classic ? 'block' : 'voxel', noun: 'blocky character', tag: 'voxel',
    maxPeople: M.VOXEL_MAX_PEOPLE, noCast: classic ? 'This video has no classic block character in its cast yet. Add one (form block, such as Rook) in Project > Cast first.'
      : 'This video has no blocky character in its cast yet. Add one (form voxel, such as Pip Block) in Project > Cast first.' });
  box.append(parts.castBox, parts.peopleBox);

  // Props: gem, lantern, crate, flag, ball, star, each across and back.
  const props = Array.isArray(voxel.props) ? voxel.props : [];
  const propBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `Props (${props.length} of ${M.MAX_PROPS})` })]);
  props.forEach((prop, i) => {
    const n = i + 1, at = `${where}.props[${i}]`;
    propBox.append(el('div', { class: 'ste-member', 'data-voxel-prop': n }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `${n}. ${prop.kind}` }), parts.remove(`Remove voxel prop ${n}`, s => { s.props.splice(i, 1); })]),
      field('Kind', select(`Voxel prop ${n}`, options(M.VOXEL_PROPS), prop.kind, v => { set(s => { s.props[i].kind = v; }); redraw(); }), at + '.kind'),
      range('Across', `Voxel prop ${n} across`, prop.x ?? (i % 2 ? .7 : -.7), -1, 1, .01, across, at + '.x', v => set(s => { s.props[i].x = v; }, `${at}.x`)),
      range('Depth', `Voxel prop ${n} depth`, prop.depth ?? .5, 0, 1, .01, v => `${Math.round(v * 100)}% back`, at + '.depth', v => set(s => { s.props[i].depth = v; }, `${at}.depth`))]));
  });
  propBox.append(el('button', { type: 'button', class: 'btn', text: 'Add a voxel prop', disabled: props.length >= M.MAX_PROPS, onclick: () => {
    set(s => { s.props ||= []; const k = s.props.length; s.props.push({ kind: M.VOXEL_PROPS[k % M.VOXEL_PROPS.length], x: k % 2 ? .7 : -.7, depth: .5 }); }); redraw();
  } }), errorSlot(where + '.props'));
  box.append(propBox, parts.labelBox, errorSlot(where));
  return box;
}

// Pack C classic's Story Short beat in the inspector (Content Studio polish for 2.3.0): who speaks the line (or how long
// a shot without a line holds) and the gap after it, the flashback flag, the place, time and seed, the block characters on
// screen (place across and height, pose, mood, which way they face, changes on a word or a time, a walk or run, leaving),
// up to three shots cut on words (size, on whom, with whom, push, shake, side), effects (fuse, blast, splat, fall, pop),
// props, sounds on words and the key words the captions colour. It replaces editing the story as raw JSON and writes
// exactly what core/video_store.py _story_beat checks, so field errors land on the field. Fields the form does not show
// are left as they are, so a beat opened and closed is unchanged. static/motion/classic.js and story.js draw it.
import { el } from './api.js';
import * as M from './studioEditorModel.js';
import { options, rangeField, errorSlot } from './studioStageForm.js';
import { normalizeStory, balanceCoverage } from '../motion/classic.js';

export const NEW_STORY = { place: 'meadow', seed: 0, time: 'day', cast: [], shots: [{ shot: 'medium', on: 0 }], fx: [], props: [], sfx: [], keys: [] };
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round = v => Math.round(v * 1000) / 1000;

// helpers: field(label, control, path, hint), select(label, values, value, onChange), change(mutate, group), redraw()
export function storyForm({ beat, path, cast, names, forms = {}, helpers, beats = [] }) {
  const { field, select, change, redraw } = helpers;
  const story = beat.story || {}, where = path + '.story';
  const say = beat.say || '', words = M.clauseWords(say);
  // mutate(story, beat): the story object and the beat itself (speaker, flashback, gap and hold live on the beat).
  const set = (mutate, group) => change(p => { const b = p.beats.find(x => x.id === beat.id); b.story ||= structuredClone(NEW_STORY); mutate(b.story, b); }, group);
  const range = (...args) => rangeField(field, ...args);
  const nameOf = id => names[id] || `Character ${String(id).slice(0, 6)}`;
  const blockIds = (cast || []).map(c => c.character).filter(id => forms[id] === 'block');
  const remove = (label, action) => el('button', { type: 'button', class: 'btn quiet', text: 'Remove', 'aria-label': label, onclick: () => { set(action); redraw(); } });
  const check = (aria, text, on, write) => {
    const input = el('input', { type: 'checkbox', checked: !!on, 'aria-label': aria });
    input.addEventListener('change', () => write(input.checked));
    return el('label', { class: 'studio-check' }, [input, el('span', { text })]);
  };
  const number = (aria, value, min, max, step, at, write) => {
    const input = el('input', { type: 'number', min, max, step, 'aria-label': aria });
    input.value = String(value);
    input.addEventListener('input', () => { if (input.value !== '') write(Number(input.value)); });
    return input;
  };
  // A number that may be left empty (the field is then not stored).
  const optional = (aria, value, min, max, step, at, write) => {
    const input = el('input', { type: 'number', min, max, step, placeholder: 'auto', 'aria-label': aria });
    input.value = value == null ? '' : String(value);
    input.addEventListener('input', () => write(input.value === '' ? undefined : Number(input.value)));
    return input;
  };
  const members = Array.isArray(story.cast) ? story.cast : [];
  const memberOptions = members.map((m, i) => [String(i), `${i + 1}. ${nameOf(m.character)}`]);

  // A moment: a word of this shot's line ({word: n}, optionally some seconds after it) or a time into the shot ({t}).
  const moment = (label, aria, ref, at, write) => {
    const current = ref && 'word' in ref ? `w${ref.word}` : 't';
    const choices = [...words.map((w, i) => [`w${i}`, `Word ${i + 1}: ${w}`]), ['t', 'A time into the shot']];
    if (!choices.some(c => c[0] === current)) choices.unshift([current, `Word ${Number(ref.word) + 1} (past the line's end)`]);
    const mode = select(aria, choices, current, v => { write(v === 't' ? { t: 0 } : { word: Number(v.slice(1)), ...(ref?.after ? { after: ref.after } : {}) }); redraw(); });
    const extra = current === 't'
      ? field('Seconds in', number(`${aria}, seconds into the shot`, num(ref?.t, 0), 0, 60, .1, at, v => write({ t: v })), at + '.t')
      : field('Seconds after it', optional(`${aria}, seconds after the word`, ref?.after, 0, 3, .05, at, v => write(v === undefined ? { word: ref.word } : { word: ref.word, after: v })), at + '.after');
    return el('div', { class: 'ste-row2', 'data-moment': aria }, [field(label, mode, at + '.word', ref ? M.momentText(ref, say) : ''), extra, errorSlot(at)]);
  };
  const firstMoment = () => words.length ? { word: 0 } : { t: 0 };
  // Which way a character faces: camera, left, right, away, another cast member (c0, c1...) or an angle in degrees.
  const faceChoices = self => [...M.STORY_FACES.map(f => [f, f]), ...members.map((m, k) => [`c${k}`, `towards ${k + 1}. ${nameOf(m.character)}`]).filter((_, k) => k !== self), ['angle', 'an angle']];
  const faceValue = f => typeof f === 'number' ? 'angle' : (f ?? 'camera');

  // The player varies coverage (classic.js balanceCoverage): say which of this beat's closes it plays as a medium.
  const played = (beats || []).map(b => b.kind === 'story' ? { id: b.id, kind: 'story', speaker: b.speaker, story: normalizeStory(b.story) } : { id: b.id, kind: b.kind });
  balanceCoverage(played);
  const playedShots = played.find(b => b.id === beat.id)?.story?.shots || [];
  const box = el('div', { class: 'ste-scene', 'data-story-form': '' });

  // The line: its speaker and gap, or a held shot without a line; the flashback.
  const lineBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: 'The line' })]);
  if (beat.say) {
    const speakers = blockIds.includes(beat.speaker) || !beat.speaker ? blockIds : [beat.speaker, ...blockIds];
    lineBox.append(el('div', { class: 'ste-row2' }, [
      field('Who speaks it', select('Speaker', [...(beat.speaker ? [] : [['', 'Choose who speaks']]), ...speakers.map(id => [id, nameOf(id)])], beat.speaker || '',
        v => set((s, b) => { if (v) b.speaker = v; else delete b.speaker; })), path + '.speaker', blockIds.length ? 'Each speaker talks in their own voice.' : 'Add a block character (such as Rook) in Project > Cast first.'),
      field('Gap after the line (seconds)', number('Gap after the line', num(beat.gap, .3), M.STORY_GAP[0], M.STORY_GAP[1], .05, path + '.gap', v => set((s, b) => { b.gap = v; }, path + '.gap')),
        path + '.gap', `${M.STORY_GAP[0]} to ${M.STORY_GAP[1]}.`)]));
  } else {
    lineBox.append(field('Holds for (seconds)', number('Hold without a line', num(beat.hold, 1.2), M.STORY_HOLD[0], M.STORY_HOLD[1], .1, path + '.hold', v => set((s, b) => { b.hold = v; }, path + '.hold')),
      path + '.hold', 'This shot has no line. Write one under Narration to give it a speaker.'));
  }
  lineBox.append(check('Flashback', 'A flashback (sepia, with a FLASHBACK tag)', beat.flashback, on => set((s, b) => { b.flashback = on; })));
  const keys = el('input', { value: M.keysText(story.keys), 'aria-label': 'Key words' });
  keys.value = M.keysText(story.keys);
  keys.addEventListener('input', () => set(s => { s.keys = M.keysFrom(keys.value); }, where + '.keys'));
  lineBox.append(field('Key words', keys, where + '.keys', 'Comma separated, up to 8. The captions show them in the speaker\'s colour (help, sorry and the like always are).'));
  box.append(lineBox);

  // The place.
  const seed = el('input', { type: 'number', min: 0, max: 999, step: 1, 'aria-label': 'Story variation' });
  seed.value = String(num(story.seed, 0));
  seed.addEventListener('input', () => { if (seed.value !== '') set(s => { s.seed = Math.round(Number(seed.value)); }, where + '.seed'); });
  box.append(el('div', { class: 'ste-row2' }, [
    field('Place', select('Story place', options(M.STORY_PLACES), story.place || 'meadow', v => set(s => { s.place = v; })), where + '.place'),
    field('Time of day', select('Story time of day', options(M.STORY_TIMES), story.time || 'day', v => set(s => { s.time = v; })), where + '.time'),
    field('Variation', seed, where + '.seed', '0 to 999: varies the place.')]));

  // Block characters on screen. Shots, effects and faces name them by number, so removing one renumbers those.
  const castBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `Characters on screen (${members.length} of ${M.STORY_MAX_CAST})` })]);
  const dropMember = i => s => {
    s.cast.splice(i, 1);
    const shift = v => v > i ? v - 1 : v;
    for (const shot of s.shots || []) {
      if (typeof shot.on === 'number') shot.on = shot.on === i ? 0 : shift(shot.on);
      if (typeof shot.with === 'number') { if (shot.with === i) delete shot.with; else shot.with = shift(shot.with); }
    }
    for (const fx of s.fx || []) if (typeof fx.on === 'number') { if (fx.on === i) { if (['fall', 'splat'].includes(fx.kind)) fx.on = 0; else delete fx.on; } else fx.on = shift(fx.on); }
    const face = f => typeof f === 'string' && /^c\d$/.test(f) ? (Number(f[1]) === i ? 'camera' : `c${shift(Number(f[1]))}`) : f;
    for (const m of s.cast) { if ('face' in m) m.face = face(m.face); for (const c of m.changes || []) if ('face' in c) c.face = face(c.face); }
  };
  members.forEach((m, i) => {
    const n = i + 1, at = `${where}.cast[${i}]`, noun = `story character ${n}`;
    const free = blockIds.filter(id => id === m.character || !members.some(o => o.character === id));
    const choices = free.includes(m.character) ? free : [m.character, ...free];
    const faceSelect = select(`Story character ${n} faces`, faceChoices(i), faceValue(m.face), v => { set(s => { s.cast[i].face = v === 'angle' ? 0 : v; }); redraw(); });
    const row = el('div', { class: 'ste-member', 'data-story-member': n }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `${n}. ${nameOf(m.character)}` }), remove(`Remove ${noun}`, dropMember(i))]),
      field('Character', select(`Story character ${n}`, choices.map(id => [id, nameOf(id)]), m.character, v => { set(s => { s.cast[i].character = v; }); redraw(); }), at + '.character'),
      el('div', { class: 'ste-row2' }, [
        range('Across', `Story character ${n} across`, num(m.x, 0), -12, 12, .1, v => `${v} blocks`, at + '.x', v => set(s => { s.cast[i].x = v; }, `${at}.x`)),
        range('Height', `Story character ${n} height`, num(m.y, 0), -6, 12, .1, v => `${v} blocks`, at + '.y', v => set(s => { s.cast[i].y = v; }, `${at}.y`))]),
      el('div', { class: 'ste-row2' }, [
        field('Pose', select(`Pose of story character ${n}`, options(M.STORY_POSES), m.pose || 'idle', v => set(s => { s.cast[i].pose = v; })), at + '.pose'),
        field('Mood', select(`Mood of story character ${n}`, options(M.STORY_MOODS), m.mood || 'neutral', v => set(s => { s.cast[i].mood = v; })), at + '.mood'),
        field('Faces', faceSelect, at + '.face')])]);
    if (typeof m.face === 'number') row.append(field('Face angle (degrees)', number(`Story character ${n} face angle`, m.face, -180, 180, 5, at + '.face', v => set(s => { s.cast[i].face = v; }, at + '.face')), at + '.face'));
    // Changes on a word or a time: a new pose, mood or facing.
    const changes = Array.isArray(m.changes) ? m.changes : [];
    const changeBox = el('div', { class: 'ste-sublist' }, [el('p', { class: 'meta', text: `Changes during the shot (${changes.length} of 6)` })]);
    changes.forEach((c, j) => {
      const cw = `${at}.changes[${j}]`, cn = `Change ${j + 1} of story character ${n}`;
      const keep = (key, values, label) => field(label, select(`${cn} ${key}`, [['', 'no change'], ...values], key === 'face' ? (key in c ? faceValue(c.face) : '') : (c[key] || ''), v => {
        set(s => { const t = s.cast[i].changes[j]; if (!v) delete t[key]; else t[key] = key === 'face' && v === 'angle' ? 0 : v; }); redraw();
      }), `${cw}.${key}`);
      changeBox.append(el('div', { class: 'ste-member', 'data-story-change': `${n}.${j + 1}` }, [
        el('div', { class: 'ste-member-head' }, [el('strong', { text: `Change ${j + 1}` }), remove(`Remove ${cn.toLowerCase()}`, s => { s.cast[i].changes.splice(j, 1); })]),
        moment('At', `${cn} at`, c.at, `${cw}.at`, ref => set(s => { s.cast[i].changes[j].at = ref; }, `${cw}.at`)),
        el('div', { class: 'ste-row2' }, [keep('pose', options(M.STORY_POSES), 'Pose'), keep('mood', options(M.STORY_MOODS), 'Mood'), keep('face', faceChoices(i), 'Faces')]),
        typeof c.face === 'number' ? field('Face angle (degrees)', number(`${cn} face angle`, c.face, -180, 180, 5, `${cw}.face`, v => set(s => { s.cast[i].changes[j].face = v; }, `${cw}.face`)), `${cw}.face`) : null,
        errorSlot(cw)]));
    });
    changeBox.append(el('button', { type: 'button', class: 'btn', text: 'Add a change', 'aria-label': `Add a change to story character ${n}`, disabled: changes.length >= 6, onclick: () => {
      set(s => { const t = s.cast[i]; t.changes ||= []; t.changes.push({ at: firstMoment(), mood: 'shocked' }); }); redraw();
    } }), errorSlot(at + '.changes'));
    row.append(changeBox);
    // A walk or run to a spot, and leaving the shot.
    row.append(check(`Story character ${n} moves`, 'Walks or runs to a spot', !!m.move, on => { set(s => { if (on) s.cast[i].move = { to: [round(num(m.x, 0) + 4), round(num(m.y, 0))], at: firstMoment(), run: false }; else delete s.cast[i].move; }); redraw(); }));
    if (m.move) {
      const mv = m.move, mw = `${at}.move`;
      row.append(el('div', { class: 'ste-row2' }, [
        field('To across', number(`Story character ${n} moves to across`, num(mv.to?.[0], 0), -14, 14, .1, `${mw}.to[0]`, v => set(s => { s.cast[i].move.to[0] = v; }, `${mw}.to[0]`)), `${mw}.to[0]`),
        field('To height', number(`Story character ${n} moves to height`, num(mv.to?.[1], 0), -8, 14, .1, `${mw}.to[1]`, v => set(s => { s.cast[i].move.to[1] = v; }, `${mw}.to[1]`)), `${mw}.to[1]`)]),
      moment('Starts', `Story character ${n} starts moving at`, mv.at || { t: 0 }, `${mw}.at`, ref => set(s => { s.cast[i].move.at = ref; }, `${mw}.at`)),
      check(`Story character ${n} runs`, 'Runs instead of walking', mv.run, on => set(s => { s.cast[i].move.run = on; })), errorSlot(mw));
    }
    row.append(check(`Story character ${n} leaves`, 'Turns and walks out of the shot', !!m.leave, on => { set(s => { if (on) s.cast[i].leave = { at: firstMoment() }; else delete s.cast[i].leave; }); redraw(); }));
    if (m.leave) row.append(moment('Leaves', `Story character ${n} leaves at`, m.leave.at, `${at}.leave.at`, ref => set(s => { s.cast[i].leave.at = ref; }, `${at}.leave.at`)), errorSlot(at + '.leave'));
    castBox.append(row);
  });
  const addable = blockIds.filter(id => !members.some(m => m.character === id));
  if (!blockIds.length) castBox.append(el('p', { class: 'meta', text: 'This video has no block character in its cast yet. Add one (form block, such as Rook, Fenn or Juno) in Project > Cast first.' }));
  castBox.append(el('button', { type: 'button', class: 'btn', text: 'Add a character', 'aria-label': 'Add a story character', disabled: !addable.length || members.length >= M.STORY_MAX_CAST, onclick: () => {
    set(s => { s.cast ||= []; s.cast.push({ character: addable[0], x: s.cast.length ? round(num(s.cast.at(-1).x, 0) + 3) : 0, y: 0, pose: 'idle', mood: 'neutral', face: 'camera' }); }); redraw();
  } }), errorSlot(where + '.cast'));
  box.append(castBox);

  // Shots: up to three, the later ones cutting on a word or a time.
  const shots = Array.isArray(story.shots) && story.shots.length ? story.shots : [{ shot: 'medium', on: 0 }];
  const who = memberOptions.length ? memberOptions : [['0', 'the first character']];
  const shotBox = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `Shots (${shots.length} of ${M.STORY_MAX_SHOTS})` })]);
  shots.forEach((shot, j) => {
    const n = j + 1, sw = `${where}.shots[${j}]`;
    const row = el('div', { class: 'ste-member', 'data-story-shot': n }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `Shot ${n}: ${shot.shot || 'medium'}` }), shots.length > 1 ? remove(`Remove shot ${n}`, s => {
        s.shots.splice(j, 1); if (s.shots[0]) delete s.shots[0].at;
      }) : null]),
      el('div', { class: 'ste-row2' }, [
        field('Shot', select(`Shot ${n} size`, options(M.STORY_SHOTS), shot.shot || 'medium', v => { set(s => { s.shots[j].shot = v; }); redraw(); }), sw + '.shot'),
        field('On', select(`Shot ${n} on`, who, String(shot.on ?? 0), v => set(s => { s.shots[j].on = Number(v); })), sw + '.on'),
        field('With', select(`Shot ${n} with`, [['', 'nobody else'], ...memberOptions.filter(o => o[0] !== String(shot.on ?? 0))], shot.with == null ? '' : String(shot.with),
          v => set(s => { if (v === '') delete s.shots[j].with; else s.shots[j].with = Number(v); })), sw + '.with'),
        field('Side', select(`Shot ${n} side`, [['', 'automatic'], ['left', 'left'], ['right', 'right']], shot.side || '', v => set(s => { if (v) s.shots[j].side = v; else delete s.shots[j].side; })), sw + '.side')])]);
    const turned = playedShots[j]?.balanced;
    if (turned) row.append(el('p', { class: 'meta', 'data-balanced': '', text: `Plays as a medium${playedShots[j].with != null ? ' two-shot' : ''}: ${nameOf(turned.character)} has ${turned.closes} closes in the video's ${turned.shots} shots, and the player keeps one character's closes to a fifth.` }));
    if (j > 0) row.append(moment('Cuts at', `Shot ${n} cuts at`, shot.at || { t: 0 }, sw + '.at', ref => set(s => { s.shots[j].at = ref; }, sw + '.at')));
    row.append(range('Push in', `Shot ${n} push`, num(shot.push, .3), 0, .6, .05, v => `${Math.round(v * 100)}%`, sw + '.push', v => set(s => { s.shots[j].push = v; }, sw + '.push')),
      check(`Shot ${n} shakes`, 'Shakes (a panicky close)', shot.shake, on => set(s => { s.shots[j].shake = on; })), errorSlot(sw));
    shotBox.append(row);
  });
  shotBox.append(el('button', { type: 'button', class: 'btn', text: 'Add a shot', disabled: shots.length >= M.STORY_MAX_SHOTS, onclick: () => {
    set(s => {
      if (!Array.isArray(s.shots) || !s.shots.length) s.shots = [{ shot: 'medium', on: 0 }];
      const next = words.length ? { word: Math.min(words.length - 1, 2 * s.shots.length) } : { t: Number((.8 * s.shots.length).toFixed(1)) };
      s.shots.push({ shot: 'close', on: Math.min(s.shots.length, Math.max(0, members.length - 1)), at: next, push: .3 });
    }); redraw();
  } }), errorSlot(where + '.shots'));
  box.append(shotBox);

  // Effects, props and sounds.
  const list = (key, most, legend, noun, tag, fresh, rows) => {
    const items = Array.isArray(story[key]) ? story[key] : [];
    const group = el('fieldset', { class: 'ste-group' }, [el('legend', { text: `${legend} (${items.length} of ${most})` })]);
    items.forEach((item, j) => group.append(el('div', { class: 'ste-member', [`data-story-${tag}`]: j + 1 }, [
      el('div', { class: 'ste-member-head' }, [el('strong', { text: `${j + 1}. ${item.kind}` }), remove(`Remove ${noun} ${j + 1}`, s => { s[key].splice(j, 1); })]),
      ...rows(item, j, `${where}.${key}[${j}]`), errorSlot(`${where}.${key}[${j}]`)])));
    group.append(el('button', { type: 'button', class: 'btn', text: `Add ${noun === 'effect' ? 'an' : 'a'} ${noun}`, disabled: items.length >= most, onclick: () => {
      set(s => { s[key] ||= []; s[key].push(fresh()); }); redraw();
    } }), errorSlot(`${where}.${key}`));
    return group;
  };
  box.append(list('fx', M.STORY_MAX_FX, 'Effects', 'effect', 'fx', () => ({ kind: 'pop', at: firstMoment() }), (fx, j, fw) => {
    const n = j + 1, needsOn = ['fall', 'splat'].includes(fx.kind);
    const opt = (key, label, lo, hi, step, hint) => field(label, optional(`Effect ${n} ${key}`, fx[key], lo, hi, step, `${fw}.${key}`, v => set(s => { if (v === undefined) delete s.fx[j][key]; else s.fx[j][key] = v; }, `${fw}.${key}`)), `${fw}.${key}`, hint);
    return [
      el('div', { class: 'ste-row2' }, [
        field('Effect', select(`Effect ${n}`, options(M.STORY_FX), fx.kind, v => { set(s => { s.fx[j].kind = v; if (['fall', 'splat'].includes(v) && typeof s.fx[j].on !== 'number') s.fx[j].on = 0; }); redraw(); }), fw + '.kind'),
        field('On', select(`Effect ${n} on`, [...(needsOn ? [] : [['', 'a spot']]), ...(memberOptions.length ? memberOptions : [['0', 'the first character']])], fx.on == null ? '' : String(fx.on),
          v => set(s => { if (v === '') delete s.fx[j].on; else s.fx[j].on = Number(v); })), fw + '.on', needsOn ? `A ${fx.kind} happens to a character.` : '')]),
      moment('When', `Effect ${n} at`, fx.at || { t: 0 }, fw + '.at', ref => set(s => { s.fx[j].at = ref; }, fw + '.at')),
      el('div', { class: 'ste-row2' }, [opt('x', 'Across', -14, 14, .5), opt('y', 'Height', -8, 16, .5), opt('radius', 'Radius (blocks)', 1, 5, .5), opt('seconds', 'Lasts (seconds)', .3, 4, .1)])];
  }));
  box.append(list('props', M.STORY_MAX_PROPS, 'Props', 'prop', 'prop', () => ({ kind: 'crate', x: 2, y: 0 }), (prop, j, pw) => {
    const n = j + 1;
    const colour = el('input', { value: prop.colour || '', placeholder: 'auto', maxlength: 7, 'aria-label': `Story prop ${n} colour` });
    colour.value = prop.colour || '';
    colour.addEventListener('input', () => set(s => { if (colour.value) s.props[j].colour = colour.value; else delete s.props[j].colour; }, `${pw}.colour`));
    return [el('div', { class: 'ste-row2' }, [
      field('Prop', select(`Story prop ${n}`, options(M.STORY_PROPS), prop.kind, v => { set(s => { s.props[j].kind = v; }); redraw(); }), pw + '.kind'),
      field('Across', optional(`Story prop ${n} across`, prop.x, -14, 14, .5, `${pw}.x`, v => set(s => { if (v === undefined) delete s.props[j].x; else s.props[j].x = v; }, `${pw}.x`)), pw + '.x'),
      field('Height', optional(`Story prop ${n} height`, prop.y, -8, 16, .5, `${pw}.y`, v => set(s => { if (v === undefined) delete s.props[j].y; else s.props[j].y = v; }, `${pw}.y`)), pw + '.y'),
      field('Colour', colour, pw + '.colour', 'Optional: # and six hex digits.')])];
  }));
  box.append(list('sfx', M.STORY_MAX_SFX, 'Sounds', 'sound', 'sfx', () => ({ kind: 'pop', at: firstMoment() }), (sfx, j, sw) => [
    field('Sound', select(`Sound ${j + 1}`, options(M.STORY_SFX), sfx.kind, v => { set(s => { s.sfx[j].kind = v; }); redraw(); }), sw + '.kind'),
    moment('When', `Sound ${j + 1} at`, sfx.at || { t: 0 }, sw + '.at', ref => set(s => { s.sfx[j].at = ref; }, sw + '.at'))]));
  box.append(errorSlot(where));
  return box;
}

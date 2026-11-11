// Studio's timeline (Content Studio Editor build spec, steps 1 and 3): a time ruler with zoom, a playhead you drag, the
// beats as clips sized by their real length, chapter markers, a narration waveform lane and a music lane (both read
// only), snapping, selection, drag to reorder and edge drag to change a beat's bars. Step 3 adds tracks around it:
// overlay lanes (text, image and shape clips) above the beats, audio lanes (sound clips) under the narration, each
// with Hide (Mute for sound), Lock and Remove; clips drag along their lane and between lanes of their kind, trim at
// both edges and split at the playhead. Comment pins (step 4) show on their own lane. Our own plain JavaScript; the
// maths lives in studioEditorModel.js. tabs/studio/view.js owns the project and passes every change back up.
// Step 5 adds a keyframe row under each overlay track that has keyframes (or holds the selected clip): a diamond per
// keyframe moment of each clip, picked by a click (Shift adds), dragged along the clip (snapping to the playhead and
// whole frames), and track names that show whole (a wider head, the full name as a tip) and rename in place (double-click
// or F2 on the name).
import { el } from './api.js';
import * as M from './studioEditorModel.js';

const KIND_GROUP = { title: 'type', statement: 'type', quote: 'type', 'big-number': 'data', list: 'data', image: 'picture',
  split: 'picture', logo: 'picture', end: 'type', scene: 'scene', stage: 'stage', voxel: 'stage' };
const CLIP_GROUP = { text: 'type', image: 'picture', shape: 'data', video: 'picture', sound: 'sound' };
const MAX_CANVAS = 16000;
const peakCache = new Map();
function peaksOf(info) {
  if (!info?.peaks) return null;
  if (!peakCache.has(info.peaks)) { try { peakCache.set(info.peaks, Uint8Array.from(atob(info.peaks), ch => ch.charCodeAt(0))); } catch { peakCache.set(info.peaks, null); } }
  return peakCache.get(info.peaks);
}

function button(text, label, action, extra = {}) {
  const node = el('button', { type: 'button', class: 'btn ste-tool', text, 'aria-label': label, title: label, ...extra });
  node.addEventListener('click', action);
  return node;
}
const token = (node, name) => getComputedStyle(node).getPropertyValue(name).trim();

// handlers: seek(t), select(index), move(from, to), trim(index, bars), zoom(z, anchorTime), toggleSnap(), clearWorkArea(),
// selectClip(id), moveClip(id, trackId, start), trimClip(id, { start, in, out, fade_in, fade_out }), split(), toggleRipple(),
// addTrack(kind), trackAction(trackId, 'hidden' | 'locked' | 'remove'), addClip(kind), selectComment(id),
// selectKey(clipId, own, add), moveKey(clipId, fromOwn, toOwn), renameTrack(trackId, name)
export function createTimeline(handlers) {
  let s = null, drag = null, swallowClick = false;
  const zoomSlider = el('input', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': 'Timeline zoom', class: 'ste-zoom' });
  zoomSlider.addEventListener('input', () => handlers.zoom(M.sliderToZoom(zoomSlider.value), s?.time));
  const snapButton = button('Snap', 'Snapping (N)', () => handlers.toggleSnap(), { 'aria-pressed': 'true' });
  const workText = el('span', { class: 'meta ste-work-text', 'aria-live': 'polite' });
  const clearWork = button('Clear', 'Clear the work area (Alt + X)', () => handlers.clearWorkArea());
  const splitButton = button('Split', 'Split the selected clip at the playhead (S)', () => handlers.split?.(), { class: 'btn ste-tool ste-track-tool' });
  const rippleButton = button('Ripple', 'Ripple delete: deleting a clip closes the gap on its track', () => handlers.toggleRipple?.(), { 'aria-pressed': 'false', class: 'btn ste-tool ste-track-tool' });
  const addTrack = el('select', { 'aria-label': 'Add a track', class: 'ste-add-track' }, [el('option', { value: '', text: 'Add track' }),
    el('option', { value: 'overlay', text: 'Overlay track (text, images, shapes)' }), el('option', { value: 'audio', text: 'Audio track (sounds)' })]);
  addTrack.addEventListener('change', () => { const kind = addTrack.value; addTrack.value = ''; if (kind) handlers.addTrack?.(kind); });
  const bar = el('div', { class: 'ste-tl-bar' }, [
    button('-', 'Zoom out (-)', () => handlers.zoom(M.zoomBy(s.zoom, 1 / 1.5), s.time)), zoomSlider,
    button('+', 'Zoom in (=)', () => handlers.zoom(M.zoomBy(s.zoom, 1.5), s.time)),
    button('Fit', 'Fit the whole video (\\)', () => handlers.zoom(M.fitZoom(s.total, scroll.clientWidth), 0)),
    snapButton, el('span', { class: 'ste-tl-sep', 'aria-hidden': 'true' }), splitButton, rippleButton,
    button('+ Text', 'Add a text clip at the playhead', () => handlers.addClip?.('text'), { class: 'btn ste-tool ste-track-tool' }),
    button('+ Shape', 'Add a shape clip at the playhead', () => handlers.addClip?.('shape'), { class: 'btn ste-tool ste-track-tool' }), addTrack,
    el('span', { class: 'ste-tl-spacer' }), workText, clearWork]);
  const heads = el('div', { class: 'ste-tl-heads' });
  const content = el('div', { class: 'ste-tl-content' });
  const scroll = el('div', { class: 'ste-tl-scroll' }, [content]);
  const body = el('div', { class: 'ste-tl-body' }, [heads, scroll]);
  const root = el('section', { class: 'ste-timeline', 'aria-label': 'Timeline' }, [bar, body]);
  const playhead = el('div', { class: 'ste-playhead', role: 'slider', tabindex: '0', 'aria-label': 'Playhead', 'aria-valuemin': '0' }, [el('span', { class: 'ste-playhead-head' })]);
  const workArea = el('div', { class: 'ste-workarea', 'aria-hidden': 'true' });
  const insert = el('div', { class: 'ste-insert', 'aria-hidden': 'true', hidden: true });
  const tip = el('div', { class: 'ste-tip', role: 'status', hidden: true });
  let ruler, beatsLane, voiceLane, musicLane;
  // Lane canvases are kept between redraws while what they show is unchanged, so typing or dragging does not make
  // hundreds of new canvases.
  let canvases = new Map(), kept = new Map();
  const cached = (key, make) => { const node = canvases.get(key) || make(); kept.set(key, node); return node; };

  const x = t => t * s.zoom;
  const timeAt = clientX => Math.max(0, Math.min(s.total, (clientX - content.getBoundingClientRect().left) / s.zoom));
  const targets = (exclude) => M.snapTargets(s.list, { playhead: s.time, inPoint: s.inPoint, outPoint: s.outPoint, marks: s.marks }).filter(t => exclude === undefined || Math.abs(t - exclude) > 1e-6);
  const clipTargets = id => M.clipSnapTargets(s.p, s.list, { playhead: s.time, inPoint: s.inPoint, outPoint: s.outPoint, marks: s.marks }, id);

  function lane(cls, label) { heads.append(el('div', { class: 'ste-head ' + cls, text: label, 'aria-hidden': 'true' })); const node = el('div', { class: 'ste-lane ' + cls }); content.append(node); return node; }
  // A track's lane: its head names it and carries Hide (Mute for sound), Lock and Remove.
  function trackLane(track) {
    const kind = track.kind === 'audio' ? 'ste-alane' : 'ste-olane';
    const tool = (text, label, action, pressed) => {
      const b = el('button', { type: 'button', class: 'ste-head-tool', text, 'aria-label': label, title: label, 'data-track-action': action, ...(pressed === undefined ? {} : { 'aria-pressed': String(pressed) }) });
      b.addEventListener('click', () => handlers.trackAction?.(track.id, action)); return b;
    };
    const name = el('button', { type: 'button', class: 'ste-head-name', text: track.name, title: `${track.name}. Double-click (or F2) to rename.`, 'aria-label': `Track ${track.name}. Press F2 to rename.`, 'data-track-name': track.id });
    const rename = () => {
      if (track.locked) return;
      const input = el('input', { class: 'ste-head-rename', value: track.name, maxlength: 40, 'aria-label': `Rename track ${track.name}` });
      input.value = track.name;
      let done = false;
      const finish = commit => { if (done) return; done = true; if (commit && input.value.trim() && input.value.trim() !== track.name) handlers.renameTrack?.(track.id, input.value); else input.replaceWith(name); };
      input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finish(true); } if (event.key === 'Escape') { event.preventDefault(); finish(false); name.focus(); } });
      input.addEventListener('blur', () => finish(true));
      name.replaceWith(input); input.focus(); input.select();
    };
    name.addEventListener('dblclick', rename);
    name.addEventListener('keydown', event => { if (event.key === 'F2' || (event.key === 'Enter' && event.shiftKey)) { event.preventDefault(); event.stopPropagation(); rename(); } });
    heads.append(el('div', { class: `ste-head ste-trackhead ${kind}`, role: 'group', 'aria-label': `Track ${track.name}`, 'data-track-head': track.id, title: track.name }, [
      name,
      tool(track.kind === 'audio' ? 'M' : 'H', `${track.kind === 'audio' ? 'Mute' : 'Hide'} track ${track.name}`, 'hidden', !!track.hidden),
      tool('L', `Lock track ${track.name}`, 'locked', !!track.locked),
      tool('x', `Remove track ${track.name}`, 'remove')]));
    const node = el('div', { class: `ste-lane ${kind}` + (track.hidden ? ' off' : '') + (track.locked ? ' locked' : ''), 'data-track': track.id, 'data-track-kind': track.kind,
      role: 'group', 'aria-label': `Clips on ${track.name}` });
    content.append(node);
    for (const c of track.clips) node.append(clipNode(track, c));
    if (track.kind === 'overlay' && track.clips.some(c => c.keys || c.id === s.selectedClip)) keyLane(track);
    return node;
  }
  // A track's keyframe row: one diamond per keyframe moment of each clip, inside the clip's span.
  function keyLane(track) {
    heads.append(el('div', { class: 'ste-head ste-khead', text: 'Keyframes', title: `Keyframes on ${track.name}. A adds them at the playhead.`, 'aria-hidden': 'true' }));
    const node = el('div', { class: 'ste-lane ste-klane' + (track.locked ? ' locked' : ''), 'data-key-track': track.id, role: 'group', 'aria-label': `Keyframes on ${track.name}` });
    for (const c of track.clips) {
      const span = el('span', { class: 'ste-kspan' + (c.id === s.selectedClip ? ' selected' : ''), 'aria-hidden': 'true' });
      span.style.left = x(c.start) + 'px'; span.style.width = Math.max(2, x(M.clipLength(c))) + 'px'; node.append(span);
      for (const m of M.keyMoments(c)) {
        if (m.t < c.start - 1e-6 || m.t > M.clipEnd(c) + 1e-6) continue;
        const picked = s.selectedKeys?.clip === c.id && s.selectedKeys.owns.some(o => Math.abs(o - m.own) < 1 / 120);
        const props = m.props.map(k => M.KEY_NAMES[k].toLowerCase()).join(', ');
        const key = el('button', { type: 'button', class: 'ste-key' + (picked ? ' picked' : ''), 'data-key-clip': c.id, 'data-key-own': String(m.own), 'aria-pressed': String(picked),
          title: `${M.timecode(m.t)}: ${props}`, 'aria-label': `Keyframe of clip ${c.id} at ${M.timecode(m.t)}: ${props}` });
        key.style.left = x(m.t) + 'px'; node.append(key);
      }
    }
    content.append(node);
  }
  function clipNode(track, c) {
    const selected = c.id === s.selectedClip, length = M.clipLength(c), label = M.clipLabel(c, s.sounds, s.media);
    const node = el('button', { type: 'button', class: 'ste-tclip' + (selected ? ' selected' : '') + (track.locked ? ' locked' : ''), 'data-clip': c.id, 'data-track': track.id,
      'data-kind': CLIP_GROUP[c.kind] || 'type', 'data-clip-kind': c.kind, 'aria-pressed': String(selected),
      'aria-label': `${c.kind} clip ${c.id} on ${track.name}: ${label}. ${M.spokenTime(length)}, from ${M.timecode(c.start)}.${track.locked ? ' Locked.' : ''}` }, [
      el('span', { class: 'ste-clip-top' }, [el('span', { class: 'ste-clip-kind', text: c.kind }), el('span', { class: 'ste-clip-time', text: `${length.toFixed(1)} s` })]),
      el('span', { class: 'ste-clip-label', text: label })]);
    node.style.left = x(c.start) + 'px'; node.style.width = Math.max(4, x(length) - 1) + 'px';
    if (c.kind === 'sound') {
      const info = s.sounds?.[c.audio];
      node.prepend(cached(`a|${c.id}|${c.start}|${c.in}|${c.out}|${s.zoom}|${info?.peaks?.length || 0}|${c.volume}`, () => soundCanvas(c, info)));
    }
    if (!track.locked) node.append(el('span', { class: 'ste-ctrim left', 'data-edge': 'left', 'data-trim-clip': c.id, 'aria-hidden': 'true', title: 'Drag to trim the start' }),
      el('span', { class: 'ste-ctrim right', 'data-edge': 'right', 'data-trim-clip': c.id, 'aria-hidden': 'true', title: 'Drag to trim the end' }));
    return node;
  }
  function soundCanvas(c, info) {
    const length = M.clipLength(c), w = Math.max(1, Math.min(MAX_CANVAS, Math.round(x(length)))), node = el('canvas', { class: 'ste-swave', 'aria-hidden': 'true' });
    node.width = w; node.height = 26;
    const ctx = node.getContext('2d'), peaks = peaksOf(info), rate = info?.rate || 40, mid = 13;
    ctx.fillStyle = token(root, '--chart-6') || token(root, '--accent'); ctx.globalAlpha = .7;
    for (let px = 0; px < w; px++) {
      const at = Math.floor((c.in + px / w * length) * rate);
      const v = peaks && at < peaks.length ? peaks[at] : 0, half = Math.max(.5, v / 255 * (mid - 1) * Math.max(.15, c.volume ?? 1));
      ctx.fillRect(px, mid - half, 1, half * 2);
    }
    return node;
  }
  function build() {
    heads.replaceChildren(); content.replaceChildren();
    const width = Math.ceil(x(s.total)) + 120;
    content.style.width = width + 'px';
    zoomSlider.value = String(M.zoomToSlider(s.zoom));
    snapButton.setAttribute('aria-pressed', String(!!s.snap)); snapButton.classList.toggle('primary', !!s.snap);
    rippleButton.setAttribute('aria-pressed', String(!!s.ripple)); rippleButton.classList.toggle('primary', !!s.ripple);
    splitButton.disabled = !s.selectedClip;
    const hasWork = Number.isFinite(s.inPoint) || Number.isFinite(s.outPoint);
    workText.textContent = hasWork ? `Work area ${M.timecode(Number.isFinite(s.inPoint) ? s.inPoint : 0)} to ${M.timecode(Number.isFinite(s.outPoint) ? s.outPoint : s.total)}` : 'No work area. I and O set one.';
    clearWork.hidden = !hasWork;
    // Ruler.
    ruler = lane('ste-ruler', 'Time');
    for (const tick of M.rulerTicks(s.zoom, s.total)) {
      const node = el('span', { class: 'ste-tick' + (tick.major ? ' major' : '') }); node.style.left = x(tick.t) + 'px';
      if (tick.label) node.append(el('span', { class: 'ste-tick-label', text: tick.label }));
      ruler.append(node);
    }
    // Chapters.
    if (s.marks.length) {
      const chapters = lane('ste-chapters', 'Chapters');
      for (const m of s.marks) {
        const node = el('span', { class: 'ste-mark', title: `Chapter ${m.number}: ${m.title}`, text: `${m.number}. ${m.title}` });
        node.style.left = x(m.time) + 'px'; chapters.append(node);
      }
    }
    // Comment pins at their time, on their own lane so they never cover a clip.
    const pins = (s.comments || []).filter(c => c.status === 'open');
    if (pins.length) {
      const pinLane = lane('ste-pinlane', 'Comments');
      pins.forEach(c => {
        const number = s.comments.indexOf(c) + 1;
        const node = el('button', { type: 'button', class: 'ste-pinmark', 'data-pin': c.id, text: String(number), 'aria-label': `Comment ${number} at ${M.timecode(c.t)}: ${c.text}`, title: c.text });
        node.style.left = x(c.t) + 'px'; node.addEventListener('click', () => handlers.selectComment?.(c.id)); pinLane.append(node);
      });
    }
    // Overlay tracks, the top one first (it draws on top of the ones under it).
    const tracks = M.tracksOf(s.p);
    for (const track of [...tracks].reverse()) if (track.kind === 'overlay') trackLane(track);
    // Beats.
    beatsLane = lane('ste-beats', 'Beats');
    beatsLane.setAttribute('role', 'group'); beatsLane.setAttribute('aria-label', 'Beats on the timeline');
    for (const c of s.list) {
      const selected = c.index === s.selected && !s.selectedClip;
      const clip = el('button', { type: 'button', class: 'ste-clip' + (selected ? ' selected' : ''), 'data-index': c.index, 'data-kind': KIND_GROUP[c.kind] || 'type',
        'aria-pressed': String(selected), 'aria-label': `Beat ${c.index + 1}, ${c.kind}: ${c.label}. ${M.spokenTime(c.seconds)}, from ${M.timecode(c.start)}.${c.narrated ? ' Length set by its narration.' : ''}` }, [
        el('span', { class: 'ste-clip-top' }, [el('span', { class: 'ste-clip-kind', text: `${c.index + 1} ${c.kind}` }), el('span', { class: 'ste-clip-time', text: `${c.seconds.toFixed(1)} s` })]),
        el('span', { class: 'ste-clip-label', text: c.label })]);
      clip.style.left = x(c.start) + 'px'; clip.style.width = Math.max(2, x(c.seconds) - 1) + 'px';
      if (!c.narrated) clip.append(el('span', { class: 'ste-trim', 'data-trim': c.index, title: 'Drag to change its length in bars', 'aria-hidden': 'true' }));
      else clip.classList.add('narrated');
      beatsLane.append(clip);
    }
    // Narration: the line's own peak levels when it has been spoken, else the measured caption spans.
    if (s.list.some(c => c.narrated)) {
      voiceLane = lane('ste-voice', 'Narration');
      for (const c of s.list) if (c.narrated) {
        const beat = s.p.beats[c.index], wave = s.peaks?.[c.id];
        voiceLane.append(cached(`w|${c.id}|${c.start}|${c.seconds}|${s.zoom}|${wave?.key || ''}|${beat.spoken?.key || ''}`, () => waveCanvas(c)));
      }
    } else voiceLane = null;
    // Audio tracks: the person's own sounds.
    for (const track of tracks) if (track.kind === 'audio') trackLane(track);
    // Music: the bed at its volume, ducking under the voice.
    musicLane = lane('ste-music', `Music, ${s.music?.mood || 'none'}`);
    const spanKey = s.spans.map(x => `${x.start.toFixed(3)}-${x.end.toFixed(3)}`).join(',');
    for (const c of s.list) musicLane.append(cached(`m|${c.start}|${c.seconds}|${s.zoom}|${s.music?.volume}|${spanKey}`, () => musicCanvas(c)));
    canvases = kept; kept = new Map();
    content.append(workArea, insert, playhead, tip);
    placeWorkArea(); setTime(s.time);
  }
  function canvasFor(c, cls) {
    const w = Math.max(1, Math.min(MAX_CANVAS, Math.round(x(c.seconds)))), node = el('canvas', { class: cls, 'aria-hidden': 'true' });
    node.addEventListener('contextrestored', () => { if (s && node.isConnected) { canvases = new Map(); build(); } });
    node.width = w; node.height = 28; node.style.left = x(c.start) + 'px'; node.style.width = Math.max(1, x(c.seconds)) + 'px';
    return node;
  }
  function waveCanvas(c) {
    const node = canvasFor(c, 'ste-wave'), ctx = node.getContext('2d'), h = node.height, mid = h / 2;
    const color = token(root, '--chart-3') || token(root, '--accent'), wave = s.peaks?.[c.id];
    ctx.fillStyle = color;
    if (wave && Array.isArray(wave.peaks) && wave.peaks.length) {
      const scale = node.width / Math.max(1e-6, x(c.seconds));
      for (let px = 0; px < node.width; px++) {
        const lineTime = px / scale / s.zoom - (wave.offset ?? M.LEAD), at = Math.floor(lineTime * wave.rate);
        if (at < 0 || at >= wave.peaks.length) continue;
        const end = Math.max(at + 1, Math.floor((lineTime + 1 / scale / s.zoom) * wave.rate));
        let v = 0; for (let i = at; i < Math.min(end, wave.peaks.length); i++) v = Math.max(v, wave.peaks[i]);
        const half = Math.max(.5, v / 255 * (mid - 1));
        ctx.fillRect(px, mid - half, 1, half * 2);
      }
      node.dataset.wave = 'peaks';
    } else {
      ctx.globalAlpha = .45;
      const beat = s.p.beats[c.index];
      for (const part of beat.spoken?.parts || []) ctx.fillRect(x(part[0]) * node.width / Math.max(1, x(c.seconds)), mid - 5, Math.max(1, x(part[1] - part[0]) * node.width / Math.max(1, x(c.seconds))), 10);
      if (!beat.spoken) { ctx.globalAlpha = .3; ctx.fillRect(0, mid - 1, node.width, 2); }
      node.dataset.wave = beat.spoken ? 'spans' : 'not-narrated';
    }
    return node;
  }
  function musicCanvas(c) {
    const node = canvasFor(c, 'ste-bed'), ctx = node.getContext('2d'), h = node.height, scale = node.width / Math.max(1e-6, x(c.seconds));
    ctx.fillStyle = token(root, '--chart-6') || token(root, '--accent'); ctx.globalAlpha = .55;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let px = 0; px <= node.width; px += 2) ctx.lineTo(px, h - M.musicLevel(c.start + px / scale / s.zoom, s.spans, s.music?.volume) * (h - 2));
    ctx.lineTo(node.width, h); ctx.closePath(); ctx.fill();
    return node;
  }
  function placeWorkArea() {
    const a = Number.isFinite(s.inPoint) ? s.inPoint : null, b = Number.isFinite(s.outPoint) ? s.outPoint : null;
    workArea.hidden = a === null && b === null;
    if (workArea.hidden) return;
    workArea.style.left = x(a ?? 0) + 'px'; workArea.style.width = Math.max(1, x((b ?? s.total) - (a ?? 0))) + 'px';
  }
  function setTime(t, follow = false) {
    if (!s) return;
    s.time = t;
    playhead.style.transform = `translateX(${x(t)}px)`;
    playhead.setAttribute('aria-valuemax', s.total.toFixed(2)); playhead.setAttribute('aria-valuenow', t.toFixed(2)); playhead.setAttribute('aria-valuetext', M.timecode(t));
    if (follow) {
      const px = x(t);
      if (px < scroll.scrollLeft || px > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = Math.max(0, px - 40);
    }
  }
  function showTip(text, px) { tip.hidden = false; tip.textContent = text; tip.style.left = px + 'px'; }

  // Pointer: the ruler and empty lanes scrub, a clip selects or drags, a beat's right edge and both edges of a
  // track clip trim.
  content.addEventListener('pointerdown', event => {
    if (!s || event.button !== 0 || event.target.closest('.ste-pinmark, .ste-head-rename')) return;
    const keyNode = event.target.closest('.ste-key');
    if (keyNode) {
      const found = M.findClip(s.p, keyNode.dataset.keyClip);
      if (!found) return;
      try { content.setPointerCapture(event.pointerId); } catch { /* a pointer the page did not start */ }
      drag = { mode: 'key-press', id: found.clip.id, clip: found.clip, track: found.track, own: Number(keyNode.dataset.keyOwn), node: keyNode, x0: event.clientX, shift: event.shiftKey };
      event.preventDefault();
      return;
    }
    const trim = event.target.closest('[data-trim]'), clip = event.target.closest('.ste-clip');
    const edge = event.target.closest('[data-edge]'), tclip = event.target.closest('.ste-tclip');
    try { content.setPointerCapture(event.pointerId); } catch { /* a pointer the page did not start */ }
    if (edge) {
      const found = M.findClip(s.p, edge.dataset.trimClip);
      drag = { mode: 'clip-trim', id: found.clip.id, edge: edge.dataset.edge, node: edge.parentElement, clip: found.clip, track: found.track };
    } else if (tclip) {
      const found = M.findClip(s.p, tclip.dataset.clip);
      drag = { mode: 'clip-press', id: found.clip.id, node: tclip, x0: event.clientX, y0: event.clientY, clip: found.clip, track: found.track };
    } else if (trim) {
      const c = s.list[Number(trim.dataset.trim)];
      drag = { mode: 'trim', c, node: trim.parentElement, bars: s.p.beats[c.index].bars };
    } else if (clip) {
      drag = { mode: 'press', index: Number(clip.dataset.index), node: clip, x0: event.clientX };
    } else {
      drag = { mode: 'scrub' }; scrubTo(event);
    }
    event.preventDefault();
  });
  function scrubTo(event) {
    let t = timeAt(event.clientX);
    if (s.snap && !event.shiftKey) t = M.snap(t, targets(), s.zoom).t;
    handlers.seek(t);
  }
  // The lane under the pointer, for a clip dragged between tracks.
  function laneAt(clientY) {
    for (const node of content.querySelectorAll('.ste-lane[data-track]')) { const r = node.getBoundingClientRect(); if (clientY >= r.top && clientY < r.bottom) return node; }
    return null;
  }
  function clipDrag(event) {
    const d = drag, length = M.clipLength(d.clip);
    let start = Math.max(0, d.clip.start + (event.clientX - d.x0) / s.zoom);
    if (s.snap && !event.shiftKey) {
      const all = clipTargets(d.id), a = M.snap(start, all, s.zoom), b = M.snap(start + length, all, s.zoom);
      if (a.snapped && (!b.snapped || Math.abs(a.t - start) <= Math.abs(b.t - start - length))) start = a.t; else if (b.snapped) start = Math.max(0, b.t - length);
    }
    const laneNode = laneAt(event.clientY) || content.querySelector(`.ste-lane[data-track="${d.track.id}"]`);
    const target = M.tracksOf(s.p).find(t => t.id === laneNode?.dataset.track) || d.track;
    const sameKind = target.kind === d.track.kind, ok = sameKind && !target.locked && M.fits(target, start, length, d.id);
    d.to = { track: target.id, start: Math.round(start * 10000) / 10000, ok };
    const dy = laneNode ? laneNode.getBoundingClientRect().top - d.node.parentElement.getBoundingClientRect().top : 0;
    d.node.style.transform = `translate(${x(start - d.clip.start)}px, ${dy}px)`;
    d.node.classList.toggle('blocked', !ok);
    showTip(`${M.timecode(start)}${target.id !== d.track.id ? ', on ' + target.name : ''}${ok ? '' : !sameKind ? ' (another kind of track)' : target.locked ? ' (locked track)' : ' (overlaps a clip)'}`, x(start));
  }
  content.addEventListener('pointermove', event => {
    if (!drag) return;
    if (drag.mode === 'scrub') return scrubTo(event);
    if (drag.mode === 'key-press' && !drag.track.locked && Math.abs(event.clientX - drag.x0) > 3) drag.mode = 'key-move';
    if (drag.mode === 'key-move') {
      let t = timeAt(event.clientX);
      if (!event.shiftKey) {
        if (s.snap && Math.abs(t - s.time) * s.zoom <= 8) t = s.time;
        else t = Math.round(t * M.FPS) / M.FPS;
      }
      t = Math.min(M.clipEnd(drag.clip), Math.max(drag.clip.start, t));
      drag.to = M.ownTime(drag.clip, t);
      drag.node.style.left = x(t) + 'px'; drag.node.classList.add('dragging');
      showTip(`Keyframe at ${M.timecode(t)}`, x(t));
      return;
    }
    if (drag.mode === 'clip-press' && !drag.track.locked && Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) > 4) { drag.mode = 'clip-move'; drag.node.classList.add('dragging'); }
    if (drag.mode === 'clip-move') return clipDrag(event);
    if (drag.mode === 'clip-trim') {
      let t = timeAt(event.clientX);
      if (s.snap && !event.shiftKey) t = M.snap(t, clipTargets(drag.id), s.zoom).t;
      const limit = drag.clip.kind === 'sound' ? (s.sounds?.[drag.clip.audio]?.seconds ?? Infinity) : Infinity;
      drag.result = M.trimClip(drag.clip, drag.edge, t, { track: drag.track, limit });
      const start = drag.result.start, length = drag.result.out - drag.result.in;
      drag.node.style.left = x(start) + 'px'; drag.node.style.width = Math.max(4, x(length) - 1) + 'px';
      showTip(`${M.timecode(start)} to ${M.timecode(start + length)}, ${length.toFixed(2)} s`, x(drag.edge === 'left' ? start : start + length));
      return;
    }
    if (drag.mode === 'press' && Math.abs(event.clientX - drag.x0) > 4) { drag.mode = 'move'; drag.node.classList.add('dragging'); }
    if (drag.mode === 'move') {
      drag.node.style.transform = `translateX(${event.clientX - drag.x0}px)`;
      const to = M.dropIndex(s.list, timeAt(event.clientX), drag.index); drag.to = to;
      const at = to > drag.index ? s.list[to].end : s.list[to].start;
      insert.hidden = false; insert.style.left = x(at) + 'px';
    }
    if (drag.mode === 'trim') {
      let end = timeAt(event.clientX);
      if (s.snap && !event.shiftKey) end = M.snap(end, targets(drag.c.end), s.zoom).t;
      drag.bars = M.barsFor(end - drag.c.start, s.p.bpm);
      const seconds = drag.bars * 240 / s.p.bpm;
      drag.node.style.width = Math.max(2, x(seconds) - 1) + 'px';
      showTip(`${drag.bars} ${drag.bars === 1 ? 'bar' : 'bars'}, ${seconds.toFixed(1)} s`, x(drag.c.start + seconds));
    }
  });
  const finish = event => {
    if (!drag) return;
    const d = drag; drag = null; insert.hidden = true; tip.hidden = true;
    try { content.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (d.mode === 'move') { swallowClick = true; d.node.classList.remove('dragging'); d.node.style.transform = ''; if (d.to !== undefined && d.to !== d.index) handlers.move(d.index, d.to); }
    if (d.mode === 'trim') { swallowClick = true; if (d.bars !== s.p.beats[d.c.index].bars) handlers.trim(d.c.index, d.bars); else build(); }
    if (d.mode === 'press' && event.type === 'pointerup') { swallowClick = true; handlers.select(d.index); }
    if (d.mode === 'clip-press' && event.type === 'pointerup') { swallowClick = true; handlers.selectClip?.(d.id); }
    if (d.mode === 'clip-move') {
      swallowClick = true; d.node.classList.remove('dragging', 'blocked'); d.node.style.transform = '';
      if (event.type === 'pointerup' && d.to?.ok && (d.to.track !== d.track.id || Math.abs(d.to.start - d.clip.start) > 1e-6)) handlers.moveClip?.(d.id, d.to.track, d.to.start); else build();
    }
    if (d.mode === 'clip-trim') { swallowClick = true; if (event.type === 'pointerup' && d.result) handlers.trimClip?.(d.id, d.result); else build(); }
    if (d.mode === 'key-press' && event.type === 'pointerup') { swallowClick = true; handlers.selectKey?.(d.id, d.own, d.shift); }
    if (d.mode === 'key-move') { swallowClick = true; if (event.type === 'pointerup' && d.to !== undefined && Math.abs(d.to - d.own) > 1e-6) handlers.moveKey?.(d.id, d.own, d.to); else build(); }
    setTimeout(() => { swallowClick = false; }, 0);
  };
  content.addEventListener('pointerup', finish);
  content.addEventListener('pointercancel', finish);
  // Keyboard (Enter on a clip) selects; a pointer press already did.
  content.addEventListener('click', event => {
    if (swallowClick) { swallowClick = false; return; }
    const clip = event.target.closest('.ste-clip'), tclip = event.target.closest('.ste-tclip'), keyNode = event.target.closest('.ste-key');
    if (keyNode) handlers.selectKey?.(keyNode.dataset.keyClip, Number(keyNode.dataset.keyOwn), event.shiftKey);
    else if (clip) handlers.select(Number(clip.dataset.index));
    else if (tclip) handlers.selectClip?.(tclip.dataset.clip);
  });
  // Ctrl + wheel zooms around the pointer; a plain wheel scrolls the timeline sideways.
  scroll.addEventListener('wheel', event => {
    if (!s) return;
    if (event.ctrlKey || event.metaKey) { event.preventDefault(); handlers.zoom(M.zoomBy(s.zoom, event.deltaY < 0 ? 1.25 : 1 / 1.25), timeAt(event.clientX), event.clientX - scroll.getBoundingClientRect().left); }
    else if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && scroll.scrollWidth > scroll.clientWidth) { scroll.scrollLeft += event.deltaY; event.preventDefault(); }
  }, { passive: false });

  return {
    node: root,
    update(next) { s = { ...next }; build(); },
    setTime,
    // Keep the time at `anchorTime` under the same spot after a zoom.
    keep(anchorTime, offset) { if (!s || !Number.isFinite(anchorTime)) return; scroll.scrollLeft = Math.max(0, x(anchorTime) - (Number.isFinite(offset) ? offset : scroll.clientWidth / 2)); },
    reveal(index) { const c = s?.list[index]; if (!c) return; const a = x(c.start), b = x(c.end); if (a < scroll.scrollLeft || b > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = Math.max(0, a - 40); },
    revealTime(t) { if (!s) return; const a = x(t); if (a < scroll.scrollLeft || a > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = Math.max(0, a - 40); },
    width: () => scroll.clientWidth,
    get zoom() { return s?.zoom; },
  };
}

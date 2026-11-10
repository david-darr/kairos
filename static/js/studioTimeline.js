// Studio's timeline (Content Studio Editor build spec, step 1): a time ruler with zoom, a playhead you drag, the
// beats as clips sized by their real length, chapter markers, a narration waveform lane and a music lane (both read
// only), snapping, selection, drag to reorder and edge drag to change a beat's bars. Our own plain JavaScript; the
// maths lives in studioEditorModel.js. tabs/studio/view.js owns the project and passes every change back up.
import { el } from './api.js';
import * as M from './studioEditorModel.js';

const KIND_GROUP = { title: 'type', statement: 'type', quote: 'type', 'big-number': 'data', list: 'data', image: 'picture',
  split: 'picture', logo: 'picture', end: 'type', scene: 'scene', stage: 'stage' };
const MAX_CANVAS = 16000;

function button(text, label, action, extra = {}) {
  const node = el('button', { type: 'button', class: 'btn ste-tool', text, 'aria-label': label, title: label, ...extra });
  node.addEventListener('click', action);
  return node;
}
const token = (node, name) => getComputedStyle(node).getPropertyValue(name).trim();

// handlers: seek(t), select(index), move(from, to), trim(index, bars), zoom(z, anchorTime), toggleSnap(), clearWorkArea()
export function createTimeline(handlers) {
  let s = null, drag = null, swallowClick = false;
  const zoomSlider = el('input', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': 'Timeline zoom', class: 'ste-zoom' });
  zoomSlider.addEventListener('input', () => handlers.zoom(M.sliderToZoom(zoomSlider.value), s?.time));
  const snapButton = button('Snap', 'Snapping (N)', () => handlers.toggleSnap(), { 'aria-pressed': 'true' });
  const workText = el('span', { class: 'meta ste-work-text', 'aria-live': 'polite' });
  const clearWork = button('Clear', 'Clear the work area (Alt + X)', () => handlers.clearWorkArea());
  const bar = el('div', { class: 'ste-tl-bar' }, [
    button('-', 'Zoom out (-)', () => handlers.zoom(M.zoomBy(s.zoom, 1 / 1.5), s.time)), zoomSlider,
    button('+', 'Zoom in (=)', () => handlers.zoom(M.zoomBy(s.zoom, 1.5), s.time)),
    button('Fit', 'Fit the whole video (\\)', () => handlers.zoom(M.fitZoom(s.total, scroll.clientWidth), 0)),
    snapButton, el('span', { class: 'ste-tl-spacer' }), workText, clearWork]);
  const heads = el('div', { class: 'ste-tl-heads', 'aria-hidden': 'true' });
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

  function lane(cls, label) { heads.append(el('div', { class: 'ste-head ' + cls, text: label })); const node = el('div', { class: 'ste-lane ' + cls }); content.append(node); return node; }
  function build() {
    heads.replaceChildren(); content.replaceChildren();
    const width = Math.ceil(x(s.total)) + 120;
    content.style.width = width + 'px';
    zoomSlider.value = String(M.zoomToSlider(s.zoom));
    snapButton.setAttribute('aria-pressed', String(!!s.snap)); snapButton.classList.toggle('primary', !!s.snap);
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
    // Beats.
    beatsLane = lane('ste-beats', 'Beats');
    beatsLane.setAttribute('role', 'group'); beatsLane.setAttribute('aria-label', 'Beats on the timeline');
    for (const c of s.list) {
      const selected = c.index === s.selected;
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

  // Pointer: the ruler and empty lanes scrub, a clip selects or drags, a clip's right edge trims.
  content.addEventListener('pointerdown', event => {
    if (!s || event.button !== 0) return;
    const trim = event.target.closest('[data-trim]'), clip = event.target.closest('.ste-clip');
    try { content.setPointerCapture(event.pointerId); } catch { /* a pointer the page did not start */ }
    if (trim) {
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
  content.addEventListener('pointermove', event => {
    if (!drag) return;
    if (drag.mode === 'scrub') return scrubTo(event);
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
    setTimeout(() => { swallowClick = false; }, 0);
  };
  content.addEventListener('pointerup', finish);
  content.addEventListener('pointercancel', finish);
  // Keyboard (Enter on a clip) selects; a pointer press already did.
  content.addEventListener('click', event => {
    if (swallowClick) { swallowClick = false; return; }
    const clip = event.target.closest('.ste-clip');
    if (clip) handlers.select(Number(clip.dataset.index));
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
    width: () => scroll.clientWidth,
    get zoom() { return s?.zoom; },
  };
}

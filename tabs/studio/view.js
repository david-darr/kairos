import { api, clearSharedReads, el, toast, confirmDialog } from '/static/js/api.js';
import { createMascot } from '/static/js/mascot.js';
import * as M from '/static/js/studioEditorModel.js';
import { createTimeline } from '/static/js/studioTimeline.js';
import { sceneForm } from '/static/js/studioSceneForm.js';
import { stageForm } from '/static/js/studioStageForm.js';

// Runtime URLs also work in the generated website demo, which keeps motion modules.
const MOTION_URL = '/static/motion/engine.js';
const LAYOUT_URL = '/static/motion/layout.js';  // read only: the copy safe area and caption band for the guides

const BASE = '/api/tab-studio';
const ASPECTS = ['16:9', '9:16', '1:1'];
const KINDS = ['title', 'statement', 'big-number', 'list', 'image', 'quote', 'split', 'logo', 'end', 'scene', 'stage'];
const NEW_SCENE = { setting: 'meadow', shot: 'medium', cast: [], props: [] };
// Pack B: a 3D studio shot (static/motion/stage.js): set tone, shot, 3D cast, stand-in people, glossy props, labels over heads.
const NEW_STAGE = { set: 'lavender', shot: 'medium', cast: [], people: { count: 0 }, props: [], labels: [] };
// A Pack A video's cast: each character's spec at the version the project pins (routes/character_routes.py).
const castCache = new Map();
async function castSpecs(p) {
  const out = {};
  for (const entry of p.cast || []) {
    const key = `${entry.character}:${entry.version}`;
    if (!castCache.has(key)) castCache.set(key, api(`/api/characters/${encodeURIComponent(entry.character)}/versions/${Number(entry.version)}`).catch(e => { castCache.delete(key); throw e; }));
    out[entry.character] = { version: entry.version, spec: (await castCache.get(key)).spec };
  }
  return out;
}
const CAMERAS = ['still', 'push', 'pull', 'pan', 'shake'];
const TRANSITIONS = ['cut', 'whip', 'zoom', 'flip', 'dither', 'mosaic', 'wipe'];
const MOODS = ['energetic', 'calm', 'warm', 'dark', 'playful'];
const PALETTES = ['dawn', 'mint', 'dusk', 'night', 'paper'];
const clone = value => structuredClone(value);
// A narrated beat lasts as long as its spoken line (the server measures it into `seconds`); others last their bars.
const beatSeconds = (b, p) => Number.isFinite(b.seconds) && b.seconds > 0 ? b.seconds : Number(b.bars) * 240 / p.bpm;
const duration = p => p.beats.reduce((s, b) => s + beatSeconds(b, p), 0);
const maxBeats = p => p.beats.some(b => b.say) ? (p.chapters?.length ? 400 : 100) : 40;
const seconds = n => `${Number(n || 0).toFixed(1)} s`;
const beatId = () => 'b' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
const jobLabel = status => {
  const frames = /^rendering (\d+)\/(\d+)/.exec(status || '');
  return frames ? `Rendering ${Math.round(Number(frames[1]) / Number(frames[2]) * 100)}%` : status;
};
// A long video (Video Styles unit 4): chapters render one by one, resumably, after the person approves the shot plan.
const megabytes = bytes => `${(Number(bytes || 0) / 1048576).toFixed(bytes > 1048576 * 100 ? 0 : 1)} MB`;
const minutes = secondsLeft => secondsLeft >= 90 ? `about ${Math.round(secondsLeft / 60)} min left` : `about ${Math.max(1, Math.round(secondsLeft))} s left`;
const CHAPTER_STATE = { done: 'Done', rendering: 'Rendering', waiting: 'Waiting' };
const STOPPED = { paused: 'Stopped', interrupted: 'Stopped when the app closed', failed: 'Failed' };
const go = (tab, options = {}) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
const write = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body), toast: false });
let lastSection = 'videos';
const sessions = new Map();
const tokenCache = new Map();

// api() flattens FastAPI's structured field errors into a string. Preserve
// those paths for the editor, while using its shared-read invalidation hook.
async function putProject(path, project) {
  clearSharedReads();
  try {
    const response = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) });
    const body = await response.json();
    if (!response.ok) {
      const fields = Array.isArray(body.detail) ? body.detail.map(error => {
        let path = '';
        for (const part of (error.loc || []).filter(p => p !== 'body')) path += typeof part === 'number' ? `[${part}]` : (path ? '.' : '') + part;
        return [path || 'project', error.msg];
      }) : [];
      const error = new Error(fields.length ? fields.map(([path, message]) => `${path}: ${message}`).join('\n') : String(body.detail || 'Video could not save.'));
      error.fields = Object.fromEntries(fields); error.stale = response.status === 409; throw error;
    }
    return body;
  } finally { clearSharedReads(); }
}

function button(text, action, extra = {}) {
  const node = el('button', { type: 'button', class: 'btn', text, ...extra });
  node.addEventListener('click', async () => {
    if (node.disabled) return;
    node.disabled = true;
    try { await action(); } catch (error) { toast(error.message, 'error'); }
    finally { node.disabled = false; }
  });
  return node;
}
function select(label, values, value, action) {
  const node = el('select', { 'aria-label': label }, values.map(v => el('option', { value: Array.isArray(v) ? v[0] : v, text: Array.isArray(v) ? v[1] : v })));
  node.value = value;
  node.addEventListener('change', () => action(node.value));
  return node;
}
function field(label, control, path, hint = '') {
  control.id ||= 'studio-' + crypto.randomUUID();
  const error = el('small', { class: 'studio-error', id: control.id + '-error', 'data-error-path': path || '', role: 'alert' });
  control.setAttribute('aria-describedby', error.id);
  return el('div', { class: 'studio-field', 'data-field-path': path || '' }, [el('label', { for: control.id, text: label }), control,
    el('small', { class: 'meta', text: hint }), error]);
}
async function lookTokens(look) {
  if (!tokenCache.has(look)) tokenCache.set(look, api(`${BASE}/tokens/${encodeURIComponent(look)}`).catch(e => { tokenCache.delete(look); throw e; }));
  return tokenCache.get(look);
}
async function preview(canvas, p, aspect) {
  const [data, { mount }] = await Promise.all([lookTokens(p.look), import(MOTION_URL)]);
  // Font-face rules are produced by the same server helper as the render player.
  if (data.font_css && !document.getElementById('studio-font-' + p.look)) {
    const style = el('style', { id: 'studio-font-' + p.look, text: data.font_css });
    document.head.append(style);
  }
  const characters = p.cast?.length ? await castSpecs(p) : {};
  const options = { aspect, tokens: data.variables, assetsBase: `/api/videos/${p.id}/assets/` };
  try {
    const player = mount(canvas, { ...p, characters }, options);
    await player.ready;
    return player;
  } catch (error) {
    // Pack B's 3D shots load three.js by its bare name, which only the render player's page maps; the app page cannot
    // yet. Preview them as stand-in cards of the same length instead of losing the whole preview; renders are unchanged.
    if (!p.beats.some(b => b.kind === 'stage') || !/three/i.test(error.message)) throw error;
    const flat = { ...p, characters, beats: p.beats.map(b => b.kind !== 'stage' ? b : { ...b, kind: 'statement', stage: undefined, text: b.text || '3D shot', sub: '3D shot, drawn in the render' }) };
    delete flat.renderer;
    const player = mount(canvas, flat, options);
    await player.ready;
    player.standIn = true;
    return player;
  }
}
function loadJobs(id) {
  try { return JSON.parse(localStorage.getItem('kairos:studio-jobs:' + id) || '[]'); } catch { return []; }
}
function rememberJobs(id, jobs) {
  try { localStorage.setItem('kairos:studio-jobs:' + id, JSON.stringify(jobs.map(j => j.id).filter(Boolean).slice(-50))); } catch { /* Optional device state. */ }
}

export async function render(container, tabId, options = {}) {
  let disposed = false, editorCleanup = () => {}, homeGeneration = 0;
  let looks = [], defaultLook = 'kairos', query = '', sort = 'newest';
  const root = el('div', { class: 'studio-view view-constrained' });
  const banner = el('div');
  const content = el('div');
  // Videos and Content (the Content Studio team's channels, pipeline and approvals) share the Studio home.
  let section = lastSection, contentControl = null;
  const sectionBar = el('div', { class: 'studio-actions studio-sections', role: 'tablist', 'aria-label': 'Studio sections' },
    [['videos', 'Videos'], ['content', 'Content']].map(([id, name]) => {
      const node = el('button', { type: 'button', role: 'tab', class: 'btn', 'data-section': id, text: name });
      node.addEventListener('click', () => { section = lastSection = id; home(); });
      return node;
    }));
  root.append(el('header', { class: 'view-header' }, [el('div', {}, [el('h2', { text: 'Studio' }), el('p', { class: 'meta', text: 'Make a video. Shape each beat. Download it in your look.' })])]), sectionBar, banner, content);
  container.replaceChildren(root);
  const cleanup = () => { disposed = true; homeGeneration++; contentControl?.abort(); editorCleanup(); };
  options.registerCleanup?.(cleanup);
  const results = await Promise.allSettled([api(`${BASE}/looks`), api('/api/videos/ffmpeg')]);
  if (disposed) return cleanup;
  if (results[0].status === 'fulfilled') { looks = results[0].value.looks; defaultLook = results[0].value.default; }
  else banner.append(el('p', { role: 'alert', text: results[0].reason.message }));
  if (results[1].status === 'fulfilled' && !results[1].value.found) {
    const message = results[1].value.message;
    // The server's message names each system's command in backticks: show them as copyable commands, not raw text.
    const notice = el('aside', { class: 'studio-banner', 'aria-label': 'FFmpeg setup' }, [el('strong', { text: 'Rendering needs FFmpeg' }),
      el('p', { text: 'FFmpeg turns your video into an MP4. Install it once with the command for your computer, then render again. You can edit and preview without it. Kairos never installs it for you.' })]);
    const systems = ['Windows', 'macOS', 'Debian or Ubuntu'];
    [...message.matchAll(/`([^`]+)`/g)].forEach((match, i) => notice.append(el('div', { class: 'studio-actions' }, [
      el('span', { class: 'meta', text: systems[i] || 'Command' }), el('code', { text: match[1] }),
      button('Copy command', () => navigator.clipboard.writeText(match[1]))])));
    banner.append(notice);
  }
  async function open(id) {
    editorCleanup(); contentControl?.abort(); sectionBar.hidden = true; banner.hidden = false;
    const generation = ++homeGeneration;
    history.replaceState(null, '', `#/studio/${id}`);
    const close = await editor(content, id, looks, home, () => disposed || generation !== homeGeneration);
    if (disposed || generation !== homeGeneration) close(); else editorCleanup = close;
  }
  async function chat(videoId, draft) {
    const result = await write(`${BASE}/chat`, { video_id: videoId || null });
    go('chat', { sessionId: result.session_id, mobileDraft: draft, mobileConversation: true });
  }
  async function home() {
    editorCleanup(); editorCleanup = () => {};
    history.replaceState(null, '', '#/studio');
    const generation = ++homeGeneration;
    contentControl?.abort(); contentControl = null; sectionBar.hidden = false;
    for (const node of sectionBar.children) { const on = node.dataset.section === section; node.setAttribute('aria-selected', String(on)); node.classList.toggle('primary', on); }
    banner.hidden = section === 'content';
    if (section === 'content') {
      content.replaceChildren(el('p', { role: 'status', text: 'Loading Content...' }));
      contentControl = new AbortController();
      try { await (await import('/static/js/studioContent.js')).mountContent(content, { signal: contentControl.signal }); }
      catch (error) { if (!disposed && generation === homeGeneration) content.replaceChildren(el('p', { role: 'alert', text: error.message }), button('Try again', home)); }
      return;
    }
    content.replaceChildren(el('p', { role: 'status', text: 'Loading videos...' }));
    try {
      const projects = await api('/api/videos');
      if (disposed || generation !== homeGeneration) return;
      const grid = el('div', { class: 'studio-grid' });
      const search = el('input', { type: 'search', value: query, placeholder: 'Search videos', 'aria-label': 'Search videos', oninput: event => { query = event.target.value; drawGrid(); } });
      const newMenu = el('details', { class: 'disclosure-panel' }, [el('summary', { text: 'New video' }), el('div', { class: 'studio-actions' }, [
        button('From a brief', () => chat(null, 'Make a video about ...')),
        button('Blank', async () => {
          const p = await write('/api/videos', { title: 'Untitled video', look: defaultLook, beats: [
            { id: 'title', kind: 'title', text: 'Your title', bars: 1 }, { id: 'statement', kind: 'statement', text: 'Your message', bars: 1 }, { id: 'end', kind: 'end', text: 'What comes next', bars: 1 }] });
          await open(p.id);
        }), button('From a design', async () => {
          const designs = await api('/api/designs');
          const picker = select('Design to turn into a video', [['', 'Choose a design'], ...designs.map(d => [d.id, d.title])], '', async id => {
            if (!id) return;
            picker.disabled = true;
            try { await open((await write(`${BASE}/from-design`, { design_id: id })).id); }
            catch (error) { toast(error.message, 'error'); picker.disabled = false; }
          });
          newMenu.append(field('Design to turn into a video', picker)); picker.focus();
        }),
      ])]);
      content.replaceChildren(el('div', { class: 'studio-actions' }, [search, select('Sort videos', [['newest', 'Updated: newest first'], ['oldest', 'Updated: oldest first']], sort, value => { sort = value; drawGrid(); }), newMenu]), grid);
      function drawGrid() {
        grid.replaceChildren();
        const visible = projects.filter(p => p.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => (b.updated - a.updated) * (sort === 'newest' ? 1 : -1));
        if (!visible.length) grid.append(el('p', { text: projects.length ? 'No matching videos.' : 'Your first video starts with a brief, a blank project or a design.' }));
        for (const p of visible) {
          const canvas = el('canvas', { 'aria-label': `First frame of ${p.title}`, class: 'studio-thumbnail' });
          const imageHost = el('div', {}, [canvas]);
          const status = el('span', { class: 'meta', text: 'Draft' });
          const card = el('article', { class: 'card studio-project', 'data-video-id': p.id }, [imageHost, el('h3', { text: p.title }),
            el('p', { class: 'meta', text: `${seconds(duration(p))} · ${p.aspects.join(', ')} · ${looks.find(l => l.id === p.look)?.name || p.look}` }), status,
            el('p', { class: 'meta', text: `Updated ${new Date(p.updated * 1000).toLocaleString()}` }), button('Open video', () => open(p.id), { 'aria-label': `Open video ${p.title}` })]);
          grid.append(card);
          api(`${BASE}/videos/${p.id}/resources`).then(async resources => {
            if (disposed || !card.isConnected) return;
            const job = resources.jobs.at(-1);
            status.textContent = job ? jobLabel(job.status) : resources.renders.some(f => f.endsWith('.mp4')) ? 'Ready' : 'Draft';
            if (resources.thumbnail) {
              const img = el('img', { src: `/api/videos/${p.id}/renders/${resources.thumbnail}`, alt: `Thumbnail of ${p.title}`, class: 'studio-thumbnail' });
              imageHost.replaceChildren(img);
            } else {
              const player = await preview(canvas, { ...p, beats: p.beats.slice(0, 1) }, p.aspects[0]);
              if (card.isConnected) player.drawFrame(Math.min(.8, player.duration / 2));
            }
          }).catch(error => { if (card.isConnected) status.textContent = `Preview unavailable: ${error.message}`; });
        }
      }
      drawGrid();
    } catch (error) { if (!disposed) content.replaceChildren(el('p', { role: 'alert', text: error.message }), button('Try again', home)); }
  }
  const id = options.videoId || /^#\/studio\/([a-f0-9]{12})$/.exec(location.hash)?.[1];
  if (id) await open(id); else await home();
  return cleanup;
}

// The editor (Content Studio Editor build spec, steps 1 and 2): docked panes (beats and assets, the preview with
// safe-area guides, the inspector, the timeline), dense and in Kairos's own tokens, resizable and remembered per person.
// Phone widths stack the same parts. The project stays the beat sheet the server validates; nothing here changes it.
let editorStyles;
function loadEditorStyles() {
  editorStyles ||= new Promise(resolve => {
    const link = el('link', { rel: 'stylesheet', href: '/static/css/studio-editor.css' });
    link.addEventListener('load', () => resolve(), { once: true }); link.addEventListener('error', () => resolve(), { once: true });
    document.head.append(link);
  });
  return editorStyles;
}
let username = null;
async function whoAmI() {
  if (username === null) { try { username = (await api('/api/auth/status')).username || 'local'; } catch { username = 'local'; } }
  return username;
}
function loadPanes(user) { try { return JSON.parse(localStorage.getItem(M.panesKey(user)) || '{}'); } catch { return {}; } }
function storePanes(user, panes) { try { localStorage.setItem(M.panesKey(user), JSON.stringify(panes)); } catch { /* applies for this visit */ } }
function tabs(label, items, onShow) {
  const list = el('div', { class: 'ste-tabs', role: 'tablist', 'aria-label': label });
  const panels = items.map(([key, name, panel]) => {
    panel.setAttribute('role', 'tabpanel'); panel.classList.add('ste-tabpanel'); panel.dataset.panel = key;
    const tab = el('button', { type: 'button', role: 'tab', class: 'ste-tab', 'data-tab': key, text: name });
    tab.addEventListener('click', () => show(key));
    list.append(tab);
    return [key, tab, panel];
  });
  function show(key) {
    if (!panels.some(([k]) => k === key)) key = panels[0][0];
    for (const [k, tab, panel] of panels) { const on = k === key; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; panel.hidden = !on; }
    onShow(key);
  }
  list.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const at = panels.findIndex(([, tab]) => tab === document.activeElement); if (at < 0) return;
    const next = panels[(at + (event.key === 'ArrowRight' ? 1 : panels.length - 1)) % panels.length];
    event.preventDefault(); event.stopPropagation(); next[1].focus(); show(next[0]);
  });
  return { list, panels: panels.map(([, , panel]) => panel), show, current: () => panels.find(([, tab]) => tab.getAttribute('aria-selected') === 'true')?.[0] };
}

async function editor(host, id, looks, back, parentDisposed) {
  let disposed = false, timer, previewTimer, pollTimer, frame = 0, mountGeneration = 0, lastGroup = '', lastGroupAt = 0;
  let selected = 0, aspect = '16:9', rate = 0, looping = true, time = 0, lastFrame = 0, player, layoutModule = null;
  let resources = { assets: [], renders: [], jobs: [] }, jobs = [], errors = {}, plan = null, peaks = {}, peaksKey = '', accountCharacters = null;
  const names = {}, forms = {};  // each cast character's name and its form (2d draws scenes, 3d plays stage beats)
  const state = sessions.get(id) || { p: null, undo: [], redo: [], dirty: false, revision: 0, saving: null, error: '' };
  state.view ||= {};
  sessions.set(id, state);
  const view = state.view;
  const endpoint = `/api/videos/${id}`;
  host.replaceChildren(el('p', { role: 'status', text: 'Loading video...' }));
  let user = 'local';
  try {
    const [latest] = await Promise.all([api(endpoint), loadEditorStyles(), whoAmI().then(u => { user = u; })]);
    if (!state.dirty) state.p = latest;
    resources = await api(`${BASE}/videos/${id}/resources`);
    const recovered = await Promise.allSettled(loadJobs(id).map(jobId => api(`/api/video-jobs/${jobId}`)));
    jobs = [...new Map([...resources.jobs, ...recovered.filter(r => r.status === 'fulfilled').map(r => r.value)].map(j => [j.id, j])).values()];
    aspect = view.aspect && state.p.aspects.includes(view.aspect) ? view.aspect : state.p.aspects[0];
    await loadPlan();
  } catch (error) { host.replaceChildren(el('p', { role: 'alert', text: error.message }), button('Back to projects', back)); return () => { disposed = true; }; }
  if (parentDisposed()) return () => {};
  let panes = M.clampPanes(loadPanes(user), { width: innerWidth, height: innerHeight });
  const savePanes = () => storePanes(user, panes);
  const total = () => M.totalSeconds(state.p);
  const clipList = () => M.clips(state.p);

  // -- the parts ------------------------------------------------------------------------------------------------
  const status = el('span', { role: 'status', 'aria-live': 'polite', class: 'ste-status' });
  const summaryError = el('p', { role: 'alert', class: 'studio-error' });
  const list = el('div', { class: 'studio-beats', role: 'list', 'aria-label': 'Video beats' });
  const inspector = el('div', { class: 'studio-inspector', 'aria-label': 'Beat fields' });
  const projectPanel = el('div', { class: 'ste-project', 'aria-label': 'Project fields' });
  const stage = el('div', { class: 'studio-stage' });
  const frameBox = el('div', { class: 'ste-frame' });
  const guides = el('div', { class: 'ste-guides', 'aria-hidden': 'true' });
  stage.append(frameBox);
  const previewError = el('p', { role: 'status', class: 'studio-error' });
  const previewNote = el('p', { class: 'meta ste-preview-note', role: 'status' });
  const clock = el('output', { 'aria-label': 'Current preview time', class: 'ste-clock' });
  const rateBadge = el('span', { class: 'ste-rate', 'aria-live': 'polite' });
  const queue = el('section', { class: 'studio-queue', 'aria-label': 'Render queue' });
  const historyHost = el('div', { class: 'ste-history' });
  const undo = button('Undo', () => travel('undo', 'redo'), { title: 'Undo (Ctrl + Z)' });
  const redo = button('Redo', () => travel('redo', 'undo'), { title: 'Redo (Ctrl + Shift + Z)' });
  const play = button('Play', () => togglePlay(), { class: 'btn primary ste-play', title: 'Play or pause (Space)' });
  const guideToggle = button('Guides', () => run('guides'), { 'aria-pressed': String(panes.guides), title: 'Safe area guides (G)' });
  const ask = el('textarea', { placeholder: 'Describe a change', 'aria-label': 'Describe a change', rows: 4, maxlength: 4000 });
  const shell = el('div', { class: 'studio-editor ste-shell', 'data-video-id': id });
  const timeline = createTimeline({
    seek: t => { stop(); time = t; drawFrame(); },
    select: index => selectBeat(index, { seek: true }),
    move: (from, to) => move(from, to),
    trim: (index, bars) => { selected = index; changed(p => { p.beats[index].bars = bars; }); drawInspector(); },
    zoom: (z, anchor, offset) => { view.zoom = z; view.fit = anchor === 0 && offset === undefined && z === M.fitZoom(total(), timeline.width()); refreshTimeline(); timeline.keep(anchor ?? time, offset); },
    toggleSnap: () => run('snap'),
    clearWorkArea: () => run('clear-work-area'),
  });

  // -- saving, undo and the timing of everything ---------------------------------------------------------------
  function renderErrors() {
    summaryError.textContent = state.error;
    for (const node of shell.querySelectorAll('[data-error-path]')) {
      const path = node.dataset.errorPath, exact = node.hasAttribute('data-error-exact');
      node.textContent = Object.entries(errors).filter(([key]) => key === path || (!exact && key.startsWith(path + '['))).map(([, value]) => value).join(' ');
      const input = node.parentElement.querySelector('input,textarea,select');
      input?.setAttribute('aria-invalid', String(!!node.textContent));
    }
    status.textContent = state.saving ? 'Saving...' : state.error ? 'Changes need attention' : state.dirty ? 'Unsaved changes' : 'Saved';
    status.dataset.state = state.saving ? 'saving' : state.error ? 'error' : state.dirty ? 'dirty' : 'saved';
    undo.disabled = !state.undo.length; redo.disabled = !state.redo.length;
  }
  async function save() {
    clearTimeout(timer);
    if (state.saving) { await state.saving; if (!disposed) renderErrors(); if (state.dirty && !state.error) return save(); return !state.error; }
    if (!state.dirty) { if (!disposed) renderErrors(); return !state.error; }
    const revision = state.revision, snapshot = clone(state.p);
    state.error = ''; errors = {};
    state.saving = (async () => {
      try {
        const saved = await putProject(endpoint, snapshot);
        state.p.version = saved.version; state.p.updated = saved.updated;
        if (revision === state.revision) { state.p = saved; state.dirty = false; }
      } catch (error) {
        state.error = error.message;
        errors = error.fields || {};
        if (error.stale) {  // Another edit (a model's video_edit, another window) saved first: load it.
          try { clearSharedReads(); state.p = await api(endpoint); state.dirty = false; state.undo = []; state.redo = []; } catch { /* the message stays */ }
        }
        const match = /(?:\d+: )?([\w]+(?:\[\d+\])?(?:\.[\w]+(?:\[\d+\])?)*): (.+)/.exec(error.message);
        if (match) errors[match[1]] = match[2];
      } finally { state.saving = null; if (!disposed) { renderErrors(); timing(); } }
    })();
    renderErrors(); await state.saving;
    if (state.dirty && !state.error) return save();
    return !state.error;
  }
  // Every edit goes through here. Typing in one field, or dragging one slider, is one undo step, not one per key.
  function changed(action, record = true, group = '') {
    const now = Date.now();
    if (record && !(group && group === lastGroup && now - lastGroupAt < 1500)) { state.undo.push(clone(state.p)); state.undo = state.undo.slice(-30); state.redo = []; }
    lastGroup = record ? group : ''; lastGroupAt = now;
    action(state.p); state.revision++; state.dirty = true; state.error = ''; errors = {};
    clearTimeout(timer); timer = setTimeout(save, 500);
    clearTimeout(previewTimer); previewTimer = setTimeout(remount, 250);
    drawBeats(); timing(); renderErrors();
  }
  function travel(from, to) {
    if (!state[from].length) return;
    state[to].push(clone(state.p)); state.p = state[from].pop(); lastGroup = '';
    selected = Math.min(selected, state.p.beats.length - 1);
    changed(() => {}, false); drawInspector(); drawProject();
  }
  function selectBeat(index, { seek = false } = {}) {
    if (index < 0 || index >= state.p.beats.length) return;
    selected = index;
    if (seek) { const c = clipList()[index]; if (time < c.start || time >= c.end) { stop(); time = c.start; } }
    drawBeats(); drawInspector(); refreshTimeline(); timeline.reveal(index); drawFrame();
  }
  function move(from, to) {
    if (from < 0 || from >= state.p.beats.length || to < 0 || to >= state.p.beats.length || from === to) return;
    changed(p => { const [beat] = p.beats.splice(from, 1); p.beats.splice(to, 0, beat); });
    selected = to; drawBeats(); drawInspector(); refreshTimeline();
    list.querySelector(`[data-index="${to}"] button`)?.focus();
  }
  function duplicateBeat() {
    if (state.p.beats.length >= maxBeats(state.p)) throw Error(`A video can have at most ${maxBeats(state.p)} beats.`);
    changed(p => p.beats.splice(selected + 1, 0, { ...clone(p.beats[selected]), id: beatId() })); selected++; drawBeats(); drawInspector(); refreshTimeline();
  }
  function deleteBeat() {
    if (state.p.beats.length === 1) throw Error('Keep at least one beat.');
    changed(p => {
      const [gone] = p.beats.splice(selected, 1), next = p.beats[selected];
      // A chapter that started at the deleted beat now starts at the next one (or ends, when that one starts a chapter).
      if (p.chapters?.length) p.chapters = p.chapters.flatMap(c => c.start !== gone.id ? [c] : next && !p.chapters.some(o => o.start === next.id) ? [{ ...c, start: next.id }] : []);
    }); selected = Math.min(selected, state.p.beats.length - 1); drawBeats(); drawInspector(); refreshTimeline();
  }
  function refreshTimeline() {
    const clipsNow = clipList(), sum = total();
    // Until the person zooms, the whole video fits, at any pane width.
    if (!Number.isFinite(view.zoom) || view.fit !== false) { view.zoom = M.fitZoom(sum, timeline.width() || 900); view.fit ??= true; }
    if (Number.isFinite(view.inPoint) && view.inPoint > sum) delete view.inPoint;
    if (Number.isFinite(view.outPoint) && view.outPoint > sum) delete view.outPoint;
    timeline.update({ p: state.p, list: clipsNow, total: sum, time, selected, zoom: view.zoom, snap: panes.snap, inPoint: view.inPoint, outPoint: view.outPoint,
      marks: M.chapterMarks(state.p, clipsNow), peaks, spans: M.speechSpans(state.p, clipsNow), music: state.p.music });
  }
  function timing() {
    time = Math.min(time, total()); refreshTimeline(); drawFrame(); loadPeaks();
  }
  function drawFrame() {
    try { player?.drawFrame(Math.min(time, player.duration)); } catch (error) { previewError.textContent = error.message; }
    clock.textContent = `${M.timecode(time)} / ${M.timecode(total())}`;
    timeline.setTime(time, rate !== 0);
  }
  // The narration lane draws each spoken line's own peak levels (read from its cached audio by the server).
  async function loadPeaks() {
    const key = state.p.beats.map(b => b.spoken?.key || '').join(',');
    if (key === peaksKey) return;
    peaksKey = key;
    if (!state.p.beats.some(b => b.spoken)) { peaks = {}; return; }
    try {
      const result = await api(`${BASE}/videos/${id}/waveform`);
      if (disposed || key !== peaksKey) return;
      peaks = result.beats || {}; refreshTimeline();
    } catch { /* the lane keeps the measured caption spans */ }
  }
  async function remount() {
    const generation = ++mountGeneration;
    const canvas = el('canvas', { 'aria-label': 'Live video preview' });
    // The browser can drop a canvas's pixels (a GPU reset); the engine's own buffers go too, so mount it again.
    canvas.addEventListener('contextrestored', () => { if (!disposed && canvas.isConnected) remount(); });
    try {
      const [next] = await Promise.all([preview(canvas, clone(state.p), aspect), layoutModule || import(LAYOUT_URL).then(m => { layoutModule = m; })]);
      if (disposed || generation !== mountGeneration) return;
      let named = false;
      for (const [cid, entry] of Object.entries(await castSpecs(state.p).catch(() => ({})))) { const form = entry.spec?.form === '3d' ? '3d' : '2d'; if ((entry.spec?.name && names[cid] !== entry.spec.name) || forms[cid] !== form) { names[cid] = entry.spec?.name || names[cid]; forms[cid] = form; named = true; } }
      if (named) { drawInspector(); drawProject(); }
      player = next; frameBox.replaceChildren(canvas, guides); stage.dataset.aspect = aspect; previewError.textContent = ''; previewNote.textContent = next.standIn ? 'The 3D shots show here as stand-in cards of the same length; renders draw them in 3D.' : ''; fitFrame(); drawFrame();
    } catch (error) { if (!disposed && generation === mountGeneration) { player = null; previewError.textContent = 'Preview unavailable: ' + error.message; } }
  }
  // The preview keeps its aspect inside whatever room the pane has; the guides sit over it, never in the video.
  function fitFrame() {
    const [w, h] = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] }[aspect];
    const room = stage.getBoundingClientRect();
    if (!(room.width > 0)) return;
    const phone = matchMedia('(max-width: 760px)').matches;
    const scale = Math.max(.05, Math.min((room.width - 16) / w, phone ? 300 / h : (room.height - 16) / h));
    frameBox.style.width = Math.round(w * scale) + 'px'; frameBox.style.height = Math.round(h * scale) + 'px';
    // A resized canvas element can come back blank in some compositors: draw the current frame again.
    if (player) try { player.drawFrame(Math.min(time, player.duration)); } catch { /* drawFrame reports its own errors */ }
    guides.hidden = !panes.guides;
    if (!layoutModule) return;
    const captioned = state.p.narration?.captions !== false && state.p.beats.some(b => b.spoken?.parts?.length);
    const box = (name, r, label) => { const node = el('div', { class: 'ste-guide ' + name, 'data-guide': name }, [el('span', { text: label })]);
      Object.assign(node.style, { left: r.x / w * 100 + '%', top: r.y / h * 100 + '%', width: r.w / w * 100 + '%', height: r.h / h * 100 + '%' }); return node; };
    guides.replaceChildren(box('copy', layoutModule.safeArea(aspect, captioned), 'Copy safe area'));
    if (captioned) guides.append(box('captions', layoutModule.captionBand(aspect), 'Captions'));
  }

  // -- playback -------------------------------------------------------------------------------------------------
  function setRate(next) {
    rate = next; lastFrame = 0;
    play.textContent = rate ? 'Pause' : 'Play';
    rateBadge.textContent = rate && rate !== 1 ? `${rate > 0 ? '' : '-'}${Math.abs(rate)}x` : '';
  }
  function stop() { if (rate) setRate(0); }
  function togglePlay() {
    if (rate) return setRate(0);
    const range = M.playRange(total(), view.inPoint, view.outPoint);
    if (time >= range.end - 1 / 30 || time < range.start) time = range.start;
    return setRate(1);
  }
  function animate(now) {
    if (disposed) return;
    if (rate && player) {
      if (lastFrame) {
        const out = M.advance(time, Math.min((now - lastFrame) / 1000, .1), rate, M.playRange(Math.min(total(), player.duration), view.inPoint, view.outPoint), looping);
        time = out.t; if (out.stopped) setRate(0);
      }
      drawFrame();
    }
    lastFrame = now; frame = requestAnimationFrame(animate);
  }

  // -- the keyboard ---------------------------------------------------------------------------------------------
  const sheet = el('dialog', { class: 'ste-sheet', 'aria-label': 'Keyboard shortcuts' }, [el('h3', { text: 'Keyboard shortcuts' }),
    el('p', { class: 'meta', text: 'They work anywhere in the editor except while you type in a field. Ctrl is Cmd on a Mac. Enter presses a focused button.' }),
    el('dl', {}, M.SHORTCUTS.flatMap(([keys, what]) => [el('dt', {}, [el('kbd', { text: keys })]), el('dd', { text: what })])),
    el('form', { method: 'dialog' }, [el('button', { type: 'submit', class: 'btn primary', text: 'Close' })])]);
  function run(action) {
    const sum = total(), clipsNow = clipList();
    switch (action) {
      case 'play': return togglePlay();
      case 'shuttle-j': case 'shuttle-k': case 'shuttle-l': return setRate(M.shuttle(rate, action.slice(-1)));
      case 'back-1': case 'forward-1': case 'back-10': case 'forward-10':
        stop(); time = M.stepFrames(time, (action.startsWith('back') ? -1 : 1) * (action.endsWith('10') ? 10 : 1), sum); return drawFrame();
      case 'previous-edge': case 'next-edge': stop(); time = M.edgeTime(clipsNow, time, action === 'previous-edge' ? -1 : 1); return drawFrame();
      case 'start': stop(); time = 0; return drawFrame();
      case 'end': stop(); time = M.stepFrames(sum, 0, sum); return drawFrame();
      case 'mark-in': view.inPoint = time; if (Number.isFinite(view.outPoint) && view.outPoint <= time) delete view.outPoint; return refreshTimeline();
      case 'mark-out': view.outPoint = time; if (Number.isFinite(view.inPoint) && view.inPoint >= time) delete view.inPoint; return refreshTimeline();
      case 'clear-work-area': delete view.inPoint; delete view.outPoint; return refreshTimeline();
      case 'delete': return deleteBeat();
      case 'duplicate': return duplicateBeat();
      case 'move-earlier': return move(selected, selected - 1);
      case 'move-later': return move(selected, selected + 1);
      case 'undo': return travel('undo', 'redo');
      case 'redo': return travel('redo', 'undo');
      case 'zoom-in': case 'zoom-out': view.fit = false; view.zoom = M.zoomBy(view.zoom, action === 'zoom-in' ? 1.5 : 1 / 1.5); refreshTimeline(); return timeline.keep(time);
      case 'zoom-fit': view.fit = true; refreshTimeline(); return timeline.keep(0, 0);
      case 'snap': panes.snap = !panes.snap; savePanes(); return refreshTimeline();
      case 'guides': panes.guides = !panes.guides; savePanes(); guideToggle.setAttribute('aria-pressed', String(panes.guides)); guideToggle.classList.toggle('primary', panes.guides); return fitFrame();
      case 'shortcuts': if (!sheet.open) sheet.showModal(); return undefined;
      default: return undefined;
    }
  }
  let spaceTaken = false;
  function onKey(event) {
    if (disposed || !shell.isConnected || event.defaultPrevented || event.isComposing) return;
    if (M.isTyping(event.target) || sheet.open || document.querySelector('.confirm-panel, dialog[open]')) return;
    if (event.target && event.target !== document.body && !shell.contains(event.target)) return;
    const action = M.keyAction(event);
    if (!action) return;
    // Space plays even on a focused button (Enter still presses it), as in other video editors.
    event.preventDefault(); spaceTaken = event.key === ' ';
    try { run(action); } catch (error) { toast(error.message, 'error'); }
  }
  const onKeyUp = event => { if (spaceTaken && event.key === ' ') { event.preventDefault(); spaceTaken = false; } };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp, true);

  // -- the left pane: beats, assets, Ask Kairos ------------------------------------------------------------------
  function drawBeats() {
    list.replaceChildren();
    const starts = new Map((state.p.chapters || []).map((c, n) => [c.start, [c, n]]));
    const clipsNow = clipList();
    state.p.beats.forEach((beat, index) => {
      if (starts.has(beat.id)) { const [c, n] = starts.get(beat.id); list.append(el('h4', { class: 'studio-chapter', role: 'presentation', text: `Chapter ${n + 1}: ${c.title}` })); }
      const row = el('div', { class: 'studio-beat' + (index === selected ? ' selected' : ''), draggable: true, role: 'listitem', 'data-index': index });
      row.append(button(`${index + 1}. ${beat.kind}: ${M.beatLabel(beat)} (${seconds(clipsNow[index].seconds)})`, () => selectBeat(index, { seek: true }), { 'aria-pressed': String(index === selected), class: 'btn studio-beat-pick' }),
        el('div', { class: 'studio-actions ste-move' }, [button('Up', () => move(index, index - 1), { disabled: index === 0, 'aria-label': `Move beat ${index + 1} up` }), button('Down', () => move(index, index + 1), { disabled: index === state.p.beats.length - 1, 'aria-label': `Move beat ${index + 1} down` })]));
      row.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', String(index)));
      row.addEventListener('dragover', event => event.preventDefault());
      row.addEventListener('drop', event => { event.preventDefault(); const from = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(from)) move(from, index); });
      row.addEventListener('keydown', event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); move(index, index + (event.key === 'ArrowUp' ? -1 : 1)); } });
      list.append(row);
    });
  }
  const addKind = select('Kind of beat to add', KINDS, 'statement', () => {});
  const beatsPanel = el('div', {}, [list, el('div', { class: 'ste-add' }, [addKind, button('Add beat', () => {
    if (state.p.beats.length >= maxBeats(state.p)) throw Error(`A video can have at most ${maxBeats(state.p)} beats.`);
    changed(p => p.beats.splice(selected + 1, 0, { id: beatId(), kind: addKind.value, text: '', bars: 1, ...(addKind.value === 'scene' ? { scene: structuredClone(NEW_SCENE) } : {}), ...(addKind.value === 'stage' ? { stage: structuredClone(NEW_STAGE) } : {}) }));
    selectBeat(selected + 1);
  })]), el('p', { class: 'meta', text: 'Drag on the timeline or here to reorder. Alt + Up or Down moves a beat in this list.' })]);
  const assetsPanel = el('div', { class: 'ste-assets' });
  function drawAssets() {
    const beat = state.p.beats[selected], pictured = ['image', 'split', 'logo'].includes(beat?.kind);
    assetsPanel.replaceChildren(el('p', { class: 'meta', text: pictured ? `Choose an image for beat ${selected + 1}.` : 'Images in this video. Select an image, split or logo beat to use one.' }));
    const grid = el('div', { class: 'ste-asset-tiles' });
    for (const asset of resources.assets) {
      const on = beat?.image === asset;
      grid.append(el('button', { type: 'button', class: 'ste-asset' + (on ? ' selected' : ''), disabled: !pictured, 'aria-pressed': String(on), 'aria-label': `Use image ${asset.slice(7, 19)} on beat ${selected + 1}`,
        onclick: () => { changed(p => { p.beats[selected].image = asset; }); drawInspector(); drawAssets(); } }, [el('img', { src: `/api/videos/${id}/assets/${asset.slice(7)}`, alt: '' })]));
    }
    if (!resources.assets.length) grid.append(el('p', { class: 'meta', text: 'No images yet. Upload one from the Beat panel of an image beat, or bring one from a design.' }));
    assetsPanel.append(grid);
  }
  const askMascot = createMascot({ state: 'idle', size: 56 });
  const askPanel = el('div', { class: 'ste-ask' }, [el('div', { class: 'ste-ask-head' }, [askMascot, el('p', { class: 'meta', text: 'Kairos opens a chat about this video with your words as a draft. Nothing is sent until you send it.' })]),
    field('Describe a change', ask), button('Ask Kairos', async () => {
      if (!ask.value.trim()) { ask.focus(); return; }
      askMascot.setAttribute('state', 'thinking');
      try {
        if (!await save()) throw Error('Fix the highlighted fields before asking Kairos.');
        const result = await write(`${BASE}/chat`, { video_id: id });
        go('chat', { sessionId: result.session_id, mobileDraft: `For [Video: ${state.p.title}](/videos/${id}): ${ask.value.trim()}`, mobileConversation: true });
      } finally { askMascot.setAttribute('state', 'idle'); }
    }, { class: 'btn primary' })]);
  const leftTabs = tabs('Beats and assets', [['beats', 'Beats', beatsPanel], ['assets', 'Assets', assetsPanel], ['ask', 'Ask Kairos', askPanel]],
    key => { panes.leftTab = key; savePanes(); if (key === 'assets') drawAssets(); });

  // -- the right pane: the selected beat, the project, renders, history -------------------------------------------
  const group = (title, children, extra = {}) => el('section', { class: 'ste-group', ...extra }, [el('h4', { text: title }), ...children]);
  const sceneHelpers = { field, select, change: (mutate, g) => changed(mutate, true, g), redraw: () => drawInspector() };
  function drawInspector() {
    inspector.replaceChildren();
    const beat = state.p.beats[selected], path = `beats[${selected}]`, c = clipList()[selected];
    const setBeat = (key, value) => changed(p => { if ((key === 'image' || key === 'say') && !value) delete p.beats[selected][key]; else p.beats[selected][key] = value; }, true, path + '.' + key);
    const textField = (label, key, limit, multiline = false) => {
      const input = el(multiline ? 'textarea' : 'input', { value: beat[key] ?? '', 'aria-label': label, maxlength: limit, ...(multiline ? { rows: 2 } : {}) });
      input.value = beat[key] ?? '';
      const node = field(label, input, path + '.' + key, `${String(beat[key] ?? '').length}/${limit} characters`);
      input.addEventListener('input', () => { setBeat(key, input.value); node.querySelector('.meta').textContent = `${input.value.length}/${limit} characters`; });
      return node;
    };
    // Show only the fields this kind of beat draws (static/motion/layout.js); the rest stay hidden, not cleared,
    // so switching kinds back keeps what was typed.
    const kind = beat.kind, pictured = ['image', 'split', 'logo'].includes(kind);
    const only = (node, shown) => { node.hidden = !shown; return node; };
    inspector.append(el('div', { class: 'ste-inspector-head' }, [el('h3', { text: `Beat ${selected + 1} of ${state.p.beats.length}` }),
      el('p', { class: 'meta', text: `${M.timecode(c.start)} to ${M.timecode(c.end)}, ${seconds(c.seconds)}${c.narrated ? ', length set by its narration' : ''}` })]));
    const items = el('textarea', { rows: 4, 'aria-label': 'List items, one per line', value: (beat.items || []).join('\n') });
    items.value = (beat.items || []).join('\n');
    const itemField = field('List items, one per line', items, path + '.items', `${(beat.items || []).length}/5 items; 60 characters each`);
    items.addEventListener('input', () => { const lines = items.value ? items.value.split('\n') : []; setBeat('items', lines); itemField.querySelector('.meta').textContent = `${lines.length}/5 items; ${lines.map(s => s.length + '/60').join(', ')} characters`; });
    inspector.append(group('Content', [field('Kind', select('Beat kind', KINDS, beat.kind, v => {
      // A scene needs its scene; another kind must not keep one.
      changed(p => {
        const b = p.beats[selected]; b.kind = v;
        if (v === 'scene') b.scene ||= structuredClone(NEW_SCENE); else delete b.scene;
        if (v === 'stage') b.stage ||= structuredClone(NEW_STAGE); else delete b.stage;
      }); drawInspector(); drawProject();
    }), path + '.kind'),
    textField('Text', 'text', 140, true), only(textField('Supporting text', 'sub', 100), !['big-number', 'list'].includes(kind)),
    only(textField('Number', 'number', 140), kind === 'big-number'), only(itemField, kind === 'list')]));
    if (kind === 'scene') inspector.append(group('Scene', [sceneForm({ beat, path, cast: state.p.cast || [], names, forms, helpers: sceneHelpers })], { 'data-group': 'scene' }));
    if (kind === 'stage') inspector.append(group('3D stage', [stageForm({ beat, path, cast: state.p.cast || [], names, forms, helpers: sceneHelpers })], { 'data-group': 'stage' }));
    // Pictures.
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', 'aria-label': 'Upload an image' });
    upload.addEventListener('change', async () => {
      if (!upload.files[0]) return;
      const targetId = beat.id, form = new FormData(); form.append('file', upload.files[0]); upload.disabled = true;
      try {
        const result = await api(endpoint + '/assets', { method: 'POST', headers: {}, body: form });
        resources.assets = [...new Set([...resources.assets, result.asset])];
        changed(p => { const target = p.beats.find(b => b.id === targetId); if (target) target.image = result.asset; }); drawInspector();
      } catch (error) { toast(error.message, 'error'); } finally { upload.disabled = false; }
    });
    const designHost = el('div');
    inspector.append(only(group('Picture', [field('Image', select('Video image', [['', 'No image'], ...resources.assets.map(a => [a, a.slice(7, 23) + '…'])], beat.image || '', v => setBeat('image', v)), path + '.image'),
      textField('Image treatment', 'treatment', 80), field('Upload an image', upload, '', 'PNG, JPEG, GIF or WebP. Up to 25 MB and 40 megapixels.'),
      button('Choose image from a design', async () => {
        const designs = await api('/api/designs');
        const targetId = beat.id;
        const assetsHost = el('div');
        const designPicker = select('Design images', [['', 'Choose a design'], ...designs.map(d => [d.id, d.title])], '', async designId => {
          try {
            assetsHost.replaceChildren();
            if (!designId) return;
            const assets = await api(`${BASE}/designs/${designId}/assets`);
            if (!assets.length) assetsHost.append(el('p', { text: 'This design has no images.' }));
            for (const asset of assets) assetsHost.append(button('Use image ' + asset.slice(7, 19), async () => {
              const result = await write(endpoint + '/assets', { design_id: designId, asset });
              resources.assets = [...new Set([...resources.assets, result.asset])];
              changed(p => { const target = p.beats.find(b => b.id === targetId); if (target) target.image = result.asset; }); drawInspector();
            }), el('img', { src: `/api/designs/${designId}/${asset}`, alt: 'Design image ' + asset.slice(7, 19), class: 'studio-thumbnail' }));
          } catch (error) { toast(error.message, 'error'); }
        });
        designHost.replaceChildren(field('Design images', designPicker), assetsHost); designPicker.focus();
      }), designHost]), pictured));
    // Narration and chapters: a long narrated video (up to 20 minutes) in parts; each chapter starts at a beat.
    const chapter = (state.p.chapters || []).find(ch => ch.start === beat.id);
    const chapterTitle = el('input', { value: chapter?.title || '', maxlength: 80, 'aria-label': 'Chapter that starts at this beat' });
    chapterTitle.value = chapter?.title || '';
    const chapterField = field('Chapter that starts here', chapterTitle, 'chapters', 'Leave empty for none. A long video has 2 to 30 chapters, the first at the first beat; YouTube shows 3 or more, each at least 10 seconds.');
    chapterTitle.addEventListener('input', () => changed(p => {
      const order = new Map(p.beats.map((b, i) => [b.id, i])), title = chapterTitle.value;
      let next = (p.chapters || []).filter(ch => ch.start !== beat.id);
      if (title.trim()) next.push({ ...(chapter ? { id: chapter.id } : { id: 'c' + crypto.randomUUID().replaceAll('-', '').slice(0, 10) }), title, start: beat.id });
      next = next.sort((a, b) => order.get(a.start) - order.get(b.start));
      if (next.length) p.chapters = next; else delete p.chapters;
    }, true, path + '.chapter'));
    inspector.append(group('Narration', [textField('Narration (the line spoken over this beat)', 'say', 400, true), only(chapterField, !!beat.say || !!state.p.chapters?.length)]));
    const bars = el('input', { type: 'number', min: .5, max: 8, step: .5, value: beat.bars, 'aria-label': 'Beat bars', oninput: event => setBeat('bars', Number(event.target.value)) });
    inspector.append(group('Timing and camera', [field('Bars', bars, path + '.bars', beat.say ? 'This beat is narrated, so it lasts as long as its spoken line; bars do not change it.'
      : '0.5 to 8, in half-bar steps, or drag the clip\'s right edge on the timeline. Total: at most 120 seconds, 480 when narrated, or 20 minutes in chapters.'),
    el('div', { class: 'ste-row2' }, [field('Camera', select('Camera', CAMERAS, beat.camera || 'still', v => setBeat('camera', v)), path + '.camera'),
      field('Transition to next beat', select('Transition', TRANSITIONS, beat.transition || 'cut', v => setBeat('transition', v)), path + '.transition')])]));
    inspector.append(el('div', { class: 'studio-actions' }, [button('Duplicate beat', duplicateBeat, { title: 'Duplicate (Ctrl + D)' }), button('Delete beat', deleteBeat, { class: 'btn danger', title: 'Delete (Delete key)' })]));
    renderErrors();
    if (leftTabs.current() === 'assets') drawAssets();
  }
  function drawProject() {
    projectPanel.replaceChildren();
    const title = el('input', { value: state.p.title, maxlength: 120, 'aria-label': 'Video title' });
    title.value = state.p.title;
    const titleField = field('Title', title, 'title', `${state.p.title.length}/120 characters`);
    title.addEventListener('input', () => { changed(p => { p.title = title.value; }, true, 'title'); titleField.querySelector('.meta').textContent = `${title.value.length}/120 characters`; titleText.textContent = title.value || 'Untitled video'; });
    const swatches = el('div', { class: 'studio-swatches', 'aria-label': 'Look colours' });
    lookTokens(state.p.look).then(data => { if (!swatches.isConnected) return; for (const key of ['--ds-bg', '--ds-text', '--ds-accent', '--ds-accent-2']) { const swatch = el('span', { title: `${key}: ${data.variables[key]}`, 'aria-label': `${key}: ${data.variables[key]}` }); swatch.style.background = data.variables[key]; swatches.append(swatch); } }).catch(() => {});
    const aspects = el('fieldset', {}, [el('legend', { text: 'Aspects to render' })]);
    for (const a of ASPECTS) aspects.append(el('label', { class: 'studio-check' }, [el('input', { type: 'checkbox', checked: state.p.aspects.includes(a), onchange: event => {
      changed(p => { p.aspects = event.target.checked ? [...p.aspects, a] : p.aspects.filter(v => v !== a); });
    } }), el('span', { text: a })]));
    projectPanel.append(group('Video', [titleField, field('Look', select('Project look', looks.map(l => [l.id, l.name]), state.p.look, v => { changed(p => { p.look = v; }); drawProject(); }), 'look'), swatches,
      aspects, el('small', { class: 'studio-error', 'data-error-path': 'aspects', role: 'alert' })]),
    group('Music', [el('div', { class: 'ste-row2' }, [field('Tempo (BPM)', el('input', { type: 'number', min: 60, max: 180, value: state.p.bpm, 'aria-label': 'Tempo in beats per minute', oninput: e => changed(p => { p.bpm = Number(e.target.value); }, true, 'bpm') }), 'bpm', '60 to 180 BPM'),
      field('Music mood', select('Music mood', MOODS, state.p.music.mood, v => changed(p => { p.music.mood = v; })), 'music.mood')]),
    field('Music volume', el('input', { type: 'range', min: 0, max: 1, step: .01, value: state.p.music.volume, 'aria-label': 'Music volume', oninput: e => changed(p => { p.music.volume = Number(e.target.value); }, true, 'music.volume') }), 'music.volume', '0 to 1. The music ducks under narration on its own.')]));
    // Pack B: what draws the 3D stage beats. Blender is offered only when this computer has it (Kairos never installs it).
    if (state.p.beats.some(b => b.kind === 'stage')) {
      const choice = select('3D renderer', [['threejs', 'three.js (built in)'], ['blender', 'Blender']], state.p.renderer || 'threejs', v => changed(p => { p.renderer = v; }));
      const host = field('3D renderer', choice, 'renderer', 'three.js is built in and fast.');
      projectPanel.append(group('3D', [host], { 'data-group': 'renderer' }));
      api('/api/video-renderers').then(status => {
        const b = status.blender, option = choice.querySelector('option[value="blender"]');
        option.textContent = b.supported ? `Blender ${b.version} (installed)` : 'Blender (not installed)';
        option.disabled = !b.supported && state.p.renderer !== 'blender';
        host.querySelector('.meta').textContent = b.supported ? `three.js is built in and fast. Blender ${b.version} is installed: softer light, much slower to render.`
          : `three.js is built in and fast. ${b.message}`;
      }).catch(() => {});
    }
    projectPanel.append(castGroup());
  }
  // The project's cast: characters pinned to a version. A scene can only show characters cast here.
  function castGroup() {
    const box = group('Cast', [], { 'data-group': 'cast' });
    const cast = state.p.cast || [];
    const used = new Set(state.p.beats.flatMap(b => b.kind === 'scene' ? (b.scene?.cast || []).map(m => m.character) : b.kind === 'stage' ? (b.stage?.cast || []).map(m => m.character) : []));
    if (state.p.beats.some(b => b.kind === 'scene') || cast.length) box.append(field('Scene palette', select('Scene palette', PALETTES, state.p.palette || 'dawn', v => changed(p => { p.palette = v; })), 'palette'));
    cast.forEach((entry, i) => {
      const known = accountCharacters?.find(c => c.id === entry.character), name = names[entry.character] || known?.name || 'Character';
      const versions = known ? known.versions.map(v => [String(v.version), `Version ${v.version}, ${v.status.replaceAll('_', ' ')}`]) : [[String(entry.version), `Version ${entry.version}`]];
      box.append(el('div', { class: 'ste-member', 'data-cast': entry.character }, [el('div', { class: 'ste-member-head' }, [el('strong', { text: name }),
        button('Remove', () => { changed(p => { p.cast.splice(i, 1); if (!p.cast.length) delete p.cast; }); drawProject(); }, { class: 'btn quiet', disabled: used.has(entry.character), 'aria-label': `Remove ${name} from the cast`,
          title: used.has(entry.character) ? 'A scene shows this character; take it out of the scene first.' : 'Remove from the cast' })]),
      field('Version', select(`Version of ${name}`, versions, String(entry.version), v => changed(p => { p.cast[i].version = Number(v); })), `cast[${i}]`, 'A video renders only an approved version.')]));
    });
    const add = select('Add a character to the cast', [['', accountCharacters ? 'Add a character' : 'Loading characters...']], '', v => {
      const c = accountCharacters?.find(x => x.id === v); if (!c) return;
      changed(p => { (p.cast ||= []).push({ character: c.id, version: c.approved_version || c.versions.at(-1).version }); }); names[c.id] = c.name; drawProject(); drawInspector();
    });
    box.append(field('Add a character', add, 'cast', 'Characters come from Content > Characters.'));
    if (accountCharacters === null) {
      accountCharacters = undefined;
      api('/api/characters').then(r => { accountCharacters = r.characters || []; if (!disposed) { drawProject(); if (state.p.beats[selected]?.kind === 'scene') drawInspector(); } }).catch(() => { accountCharacters = []; if (!disposed) drawProject(); });
    } else if (accountCharacters) {
      for (const c of accountCharacters) names[c.id] ||= c.name;
      const free = accountCharacters.filter(c => !cast.some(e => e.character === c.id));
      add.replaceChildren(el('option', { value: '', text: free.length ? 'Add a character' : 'No more characters to add' }), ...free.map(c => el('option', { value: c.id, text: `${c.name}${c.approved_version ? '' : ' (not approved yet)'}` })));
    }
    return box;
  }
  async function drawHistory() {
    historyHost.replaceChildren(el('p', { role: 'status', text: 'Loading versions...' }));
    try {
      const history = await api(endpoint + '/history');
      historyHost.replaceChildren(...history.map(p => el('div', { class: 'studio-actions' }, [el('span', { text: `Version ${p.version} · ${new Date(p.updated * 1000).toLocaleString()}` }), button('Restore version ' + p.version, async () => {
        if (!await confirmDialog({ title: 'Restore this version?', message: 'This saves the older version as a new version. Your current version stays in history.', confirmLabel: 'Restore', danger: false })) return;
        if (!await save()) throw Error('Fix the highlighted fields first.');
        state.p = await write(endpoint + `/restore/${p.version}`, {}); state.dirty = false; state.undo = []; state.redo = []; selected = 0;
        drawBeats(); drawInspector(); drawProject(); timing(); remount();
      })])));
      if (!history.length) historyHost.append(el('p', { text: 'No earlier versions yet.' }));
    } catch (error) { historyHost.textContent = error.message; }
  }
  const rightTabs = tabs('Inspector', [['beat', 'Beat', inspector], ['project', 'Project', projectPanel], ['render', 'Render', queue],
    ['history', 'History', el('div', {}, [el('p', { class: 'meta', text: 'Every save is a version. Restoring one saves it again as the newest.' }), historyHost])]],
  key => { panes.rightTab = key; savePanes(); if (key === 'history') drawHistory(); });

  // -- render queue (unchanged behaviour) -----------------------------------------------------------------------
  function planPanel() {
    if (!state.p.chapters?.length) return null;
    const status = plan?.status || 'none';
    const text = { approved: 'Approved. The long render can start.', awaiting_approval: 'Waiting for your approval.', rejected: 'Rejected. Change it, then approve it when it is right.',
      changed: 'Changed since it was ' + (plan?.was === 'approved' ? 'approved' : 'sent') + '. Approve the plan as it is now to render.', none: 'Not approved yet. A long video renders only after you approve its plan.' }[status] || status;
    const box = el('section', { class: 'card studio-plan', 'aria-label': 'Shot plan approval', 'data-plan-status': status }, [el('h4', { text: 'Shot plan' }), el('p', { class: 'meta', text })]);
    const details = el('details', { class: 'disclosure-panel' }, [el('summary', { text: 'Read the plan' }), el('pre', { class: 'studio-note', text: plan?.current || '' })]);
    box.append(details);
    if (status !== 'approved') box.append(el('div', { class: 'studio-actions' }, [button('Approve plan', async () => {
      if (!await save()) throw Error('Fix the highlighted fields before approving the plan.');
      await write(endpoint + '/plan/approve', {}); await loadPlan(); drawJobs(); toast('Plan approved. You can render it now.');
    }, { class: 'btn primary' })]));
    return box;
  }
  function chapterRows(job) {
    const rows = el('ol', { class: 'studio-chapters', 'aria-label': 'Chapters' });
    for (const c of job.chapters || []) {
      const label = c.state === 'rendering' && c.frames ? `Rendering ${Math.round((c.done || 0) / c.frames * 100)}%` : CHAPTER_STATE[c.state] || c.state;
      const row = el('li', { 'data-chapter-state': c.state }, [el('span', { text: c.title }), el('span', { class: 'meta', text: label })]);
      if (c.state === 'rendering') row.append(el('progress', { max: c.frames, value: c.done || 0, 'aria-label': `Frames rendered in ${c.title}` }));
      rows.append(row);
    }
    return rows;
  }
  function longJob(job) {
    const stopped = job.status === 'paused' || job.status === 'interrupted' || job.status === 'failed' || job.status.startsWith('failed:');
    const done = (job.chapters || []).filter(c => c.state === 'done').length, count = (job.chapters || []).length;
    const overall = job.frames_total ? Math.round((job.frames_done ?? (job.chapters || []).reduce((n, c) => n + (c.state === 'done' ? c.frames : c.done || 0), 0)) / job.frames_total * 100) : 0;
    const head = job.status === 'ready' ? 'Ready' : stopped ? (STOPPED[job.status] || 'Failed') : job.status === 'joining' ? 'Joining the chapters' : job.status === 'narrating' ? 'Narrating' : `Rendering ${overall}%`;
    const facts = [`${done} of ${count} chapters done`];
    if (job.fps) facts.push(`${Number(job.fps).toFixed(1)} frames a second`);
    if (!stopped && job.status !== 'ready' && job.eta_seconds) facts.push(minutes(job.eta_seconds));
    if (job.render_seconds) facts.push(`rendered in ${Math.round(job.render_seconds / 60)} min`);
    const item = el('article', { class: 'card studio-job studio-long-job', 'data-job-id': job.id || '', 'data-long-status': job.status }, [
      el('strong', { text: `${job.aspect} · Long video · ${head}` }), el('p', { class: 'meta', text: facts.join(' · ') })]);
    if (!stopped && job.status !== 'ready' && job.frames_total) item.append(el('progress', { max: job.frames_total, value: job.frames_done || 0, 'aria-label': 'Frames rendered in the whole video' }));
    item.append(chapterRows(job));
    if (job.status.startsWith('failed:')) item.append(el('p', { class: 'studio-error', text: job.status.slice(8) }));
    if (job.error) item.append(el('p', { class: 'studio-error', text: job.error }));
    if (stopped) {
      item.append(el('p', { class: 'meta', text: 'Finished chapters are kept. Resume starts at the first unfinished chapter.' }),
        button('Resume render', () => startRender([job.aspect]), { 'aria-label': `Resume the ${job.aspect} render` }));
    } else if (job.status !== 'ready' && job.id) {
      item.append(button('Stop render', async () => { Object.assign(job, await write(`/api/video-jobs/${job.id}/cancel`, {})); drawJobs(); }));
    }
    for (const note of job.notes || []) item.append(el('p', { text: typeof note === 'string' ? note : JSON.stringify(note), class: 'studio-note' }));
    return item;
  }
  function drawJobs() {
    queue.replaceChildren(el('h3', { text: 'Render queue and downloads' }), el('div', { class: 'studio-actions' }, [
      ...ASPECTS.map(a => button('Render ' + a, () => startRender([a]))), button('Render chosen aspects', () => startRender(state.p.aspects)),
    ]));
    const panel = planPanel();
    if (panel) queue.append(panel);
    // A long render from an earlier run (before an app restart) shows with Resume until a new job takes over its aspect.
    const liveLong = new Set(jobs.filter(j => j.kind === 'long').map(j => j.aspect));
    for (const stored of resources.long_renders || []) if (!liveLong.has(stored.aspect) && stored.status !== 'ready') queue.append(longJob(stored));
    if (resources.disk && (resources.disk.parts || resources.disk.videos)) {
      const used = el('p', { class: 'meta studio-disk', text: `Renders use ${megabytes(resources.disk.total)}` + (resources.disk.parts ? `, of which saved chapter parts ${megabytes(resources.disk.parts)}.` : '.') });
      const row = el('div', { class: 'studio-actions' }, [used]);
      if (resources.disk.parts) row.append(button('Remove saved chapter parts', async () => {
        if (!await confirmDialog({ title: 'Remove saved chapter parts?', message: 'Finished videos stay. A stopped long render then starts again from its first chapter.', confirmLabel: 'Remove parts', danger: false })) return;
        const out = await write(endpoint + '/parts/clean', {}); resources.disk = out.disk; resources.long_renders = (await api(endpoint + '/long-renders')).renders; drawJobs(); toast(`Freed ${megabytes(out.freed)}.`);
      }));
      queue.append(row);
    }
    for (const job of jobs) {
      if (job.kind === 'long') { queue.append(longJob(job)); continue; }
      const item = el('article', { class: 'card studio-job', 'data-job-id': job.id }, [el('strong', { text: `${job.aspect} · ${job.status}` })]);
      const match = /^rendering (\d+)\/(\d+)/.exec(job.status);
      if (match) item.append(el('progress', { max: match[2], value: match[1], 'aria-label': 'Frames rendered' }));
      if (!job.status.startsWith('failed:') && job.status !== 'ready') item.append(button('Cancel render', async () => { Object.assign(job, await write(`/api/video-jobs/${job.id}/cancel`, {})); drawJobs(); }));
      for (const note of job.notes || []) item.append(el('p', { text: typeof note === 'string' ? note : JSON.stringify(note), class: 'studio-note' }));
      queue.append(item);
    }
    const files = [...new Set([...resources.renders, ...jobs.filter(j => j.status === 'ready').map(j => j.file)])].filter(f => /^(16-9|9-16|1-1)-v\d+\.mp4$/.test(f));
    for (const file of files) {
      const url = endpoint + '/renders/' + file, slug = file.split('-v')[0];
      const links = el('div', { class: 'studio-actions' });
      const extras = resources.renders.includes(file.replace(/\.mp4$/, '.chapters.txt')) ? [['Download chapter list', file.replace(/\.mp4$/, '.chapters.txt')]] : [];
      for (const [label, name] of [['Download MP4', file], ['Download contact sheet', `sheet-${slug}.png`], ['Download soundtrack (WAV)', 'soundtrack.wav'], ...extras]) links.append(el('a', { class: 'btn', href: endpoint + '/renders/' + name, download: name, text: label }));
      queue.append(el('article', { class: 'card studio-download' }, [el('h4', { text: file }), el('video', { src: url, controls: true, preload: 'metadata', 'aria-label': `Rendered video ${file}` }), links]));
    }
  }
  async function startRender(aspects) {
    if (!await save()) throw Error('Fix the highlighted fields before rendering.');
    if (!aspects.length || aspects.some(a => !state.p.aspects.includes(a))) throw Error('Choose these aspects in the project fields first.');
    if (state.p.chapters?.length) { await loadPlan(); if (plan?.status !== 'approved') { drawJobs(); throw Error('Approve the shot plan first: a long video renders only after you approve it.'); } }
    for (const a of aspects) {
      const job = await write(endpoint + '/render', { aspect: a });
      // Starting a long render that is already running returns that job; keep one card per job.
      const at = jobs.findIndex(j => j.id === job.id); if (at >= 0) jobs[at] = job; else jobs.push(job);
      rememberJobs(id, jobs); drawJobs();
    }
  }
  async function loadPlan() { plan = state.p.chapters?.length ? await api(endpoint + '/plan').catch(() => null) : null; }
  async function poll() {
    try {
      const results = await Promise.allSettled([api(endpoint), ...jobs.filter(j => j.status !== 'ready' && !j.status.startsWith('failed:')).map(j => api(`/api/video-jobs/${j.id}`))]);
      if (disposed) return;
      const latest = results[0].status === 'fulfilled' ? results[0].value : null;
      if (latest && !state.dirty && !state.saving && latest.version !== state.p.version) {
        state.undo = []; state.redo = []; state.p = latest; selected = Math.min(selected, latest.beats.length - 1);
        resources = await api(`${BASE}/videos/${id}/resources`);
        if (disposed) return;
        drawBeats(); drawInspector(); drawProject(); timing(); remount();
      }
      let jobChanged = false;
      for (const result of results.slice(1)) if (result.status === 'fulfilled') {
        const index = jobs.findIndex(j => j.id === result.value.id);
        if (JSON.stringify(jobs[index]) !== JSON.stringify(result.value)) { jobs[index] = result.value; jobChanged = true; }
      }
      if (jobChanged) {
        // A long render that just finished or stopped: refresh the stored renders and the disk use.
        if (jobs.some(j => j.kind === 'long')) { try { resources = await api(`${BASE}/videos/${id}/resources`); } catch { /* the next poll tries again */ } }
        drawJobs();
      }
    } catch (error) { if (!disposed) previewError.textContent = 'Refresh unavailable: ' + error.message; }
    finally { if (!disposed) pollTimer = setTimeout(poll, 3000); }
  }

  // -- the shell: top bar, panes, splitters ---------------------------------------------------------------------
  const titleText = el('h2', { class: 'ste-title', text: state.p.title || 'Untitled video' });
  const aspectPicker = select('Preview aspect', ASPECTS, aspect, value => { aspect = view.aspect = value; remount(); });
  const transport = el('div', { class: 'ste-transport' }, [
    button('|<', () => run('start'), { 'aria-label': 'Go to the start (Home)', title: 'Go to the start (Home)' }),
    button('<', () => run('back-1'), { 'aria-label': 'One frame back (Left)', title: 'One frame back (Left)' }), play,
    button('>', () => run('forward-1'), { 'aria-label': 'One frame forward (Right)', title: 'One frame forward (Right)' }),
    button('>|', () => run('end'), { 'aria-label': 'Go to the end (End)', title: 'Go to the end (End)' }), clock, rateBadge,
    el('span', { class: 'ste-tl-spacer' }),
    button('In', () => run('mark-in'), { 'aria-label': 'Set the work area start here (I)', title: 'Work area start (I)' }),
    button('Out', () => run('mark-out'), { 'aria-label': 'Set the work area end here (O)', title: 'Work area end (O)' }),
    el('label', { class: 'studio-check' }, [el('input', { type: 'checkbox', checked: looping, onchange: e => { looping = e.target.checked; } }), el('span', { text: 'Loop' })])]);
  const top = el('div', { class: 'studio-editor-top ste-top' }, [button('Projects', async () => { if (await save()) await back(); }), titleText, undo, redo, status, button('Save now', save),
    el('span', { class: 'ste-tl-spacer' }), aspectPicker, guideToggle, button('?', () => run('shortcuts'), { 'aria-label': 'Keyboard shortcuts (?)', title: 'Keyboard shortcuts (?)' })]);
  guideToggle.classList.toggle('primary', panes.guides);
  const left = el('aside', { class: 'ste-pane ste-left', 'aria-label': 'Beats and assets' }, [leftTabs.list, ...leftTabs.panels]);
  const right = el('aside', { class: 'ste-pane ste-right', 'aria-label': 'Inspector' }, [rightTabs.list, ...rightTabs.panels]);
  const centre = el('section', { class: 'ste-centre studio-centre', 'aria-label': 'Preview' }, [stage, previewError, previewNote, transport,
    el('small', { class: 'studio-error', 'data-error-path': 'beats', 'data-error-exact': '', role: 'alert' })]);
  function splitter(name, label, orientation) {
    const node = el('div', { class: `ste-split ste-split-${name}`, role: 'separator', tabindex: '0', 'aria-label': label, 'aria-orientation': orientation, 'data-split': name });
    let start = null;
    const apply = () => { panes = M.clampPanes(panes, { width: innerWidth, height: innerHeight }); layout(); };
    node.addEventListener('pointerdown', event => { node.setPointerCapture(event.pointerId); start = { x: event.clientX, y: event.clientY, ...panes }; node.classList.add('active'); event.preventDefault(); });
    node.addEventListener('pointermove', event => {
      if (!start) return;
      if (name === 'left') panes.left = start.left + event.clientX - start.x;
      if (name === 'right') panes.right = start.right - (event.clientX - start.x);
      if (name === 'timeline') panes.timeline = start.timeline - (event.clientY - start.y);
      apply();
    });
    const end = () => { if (!start) return; start = null; node.classList.remove('active'); savePanes(); refreshTimeline(); };
    node.addEventListener('pointerup', end); node.addEventListener('pointercancel', end);
    node.addEventListener('dblclick', () => { panes[name] = M.PANES[name][2]; apply(); savePanes(); refreshTimeline(); });
    node.addEventListener('keydown', event => {
      const step = event.shiftKey ? 48 : 16, sign = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
      if (!sign) return;
      event.preventDefault(); event.stopPropagation();
      if (name === 'left') panes.left += sign * step;
      if (name === 'right') panes.right -= sign * step;
      if (name === 'timeline') panes.timeline -= sign * step;
      apply(); savePanes();
    });
    return node;
  }
  const splits = [splitter('left', 'Resize the beats panel', 'vertical'), splitter('right', 'Resize the inspector', 'vertical'), splitter('timeline', 'Resize the timeline', 'horizontal')];
  const grid = el('div', { class: 'ste-dock' }, [left, splits[0], centre, splits[1], right, splits[2], timeline.node]);
  shell.append(top, summaryError, grid, sheet);
  function layout() {
    shell.style.setProperty('--ste-left', panes.left + 'px'); shell.style.setProperty('--ste-right', panes.right + 'px'); shell.style.setProperty('--ste-timeline', panes.timeline + 'px');
    const room = Math.max(560, Math.floor(innerHeight - grid.getBoundingClientRect().top - 12));
    shell.style.setProperty('--ste-height', room + 'px');
    for (const node of splits) { const name = node.dataset.split; node.setAttribute('aria-valuenow', String(panes[name])); node.setAttribute('aria-valuemin', String(M.PANES[name][0])); node.setAttribute('aria-valuemax', String(M.PANES[name][1])); }
    fitFrame();
  }
  const onResize = () => { panes = M.clampPanes(panes, { width: innerWidth, height: innerHeight }); layout(); refreshTimeline(); };
  const stageObserver = new ResizeObserver(() => fitFrame());
  host.replaceChildren(shell);
  host.closest('.studio-view')?.classList.add('studio-editing');
  layout(); stageObserver.observe(stage); addEventListener('resize', onResize);
  leftTabs.show(panes.leftTab || 'beats'); rightTabs.show(panes.rightTab || 'beat');
  drawBeats(); drawInspector(); drawProject(); timing(); drawJobs(); remount();
  frame = requestAnimationFrame(animate); pollTimer = setTimeout(poll, 3000);
  if (state.dirty) timer = setTimeout(save, 500);
  return () => {
    disposed = true; mountGeneration++; rate = 0; player = null;
    clearTimeout(timer); clearTimeout(previewTimer); clearTimeout(pollTimer); cancelAnimationFrame(frame);
    document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp, true); removeEventListener('resize', onResize); stageObserver.disconnect();
    if (sheet.open) sheet.close();
    host.closest('.studio-view')?.classList.remove('studio-editing');
    rememberJobs(id, jobs); if (state.dirty && !state.error) void save();
  };
}

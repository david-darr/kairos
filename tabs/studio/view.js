import { api, clearSharedReads, el, toast, confirmDialog } from '/static/js/api.js';

// Runtime URL also works in the generated website demo, which keeps motion modules.
const MOTION_URL = '/static/motion/engine.js';

const BASE = '/api/tab-studio';
const ASPECTS = ['16:9', '9:16', '1:1'];
const KINDS = ['title', 'statement', 'big-number', 'list', 'image', 'quote', 'split', 'logo', 'end', 'scene'];
const NEW_SCENE = { setting: 'meadow', shot: 'medium', cast: [], props: [] };
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
const clone = value => structuredClone(value);
// A narrated beat lasts as long as its spoken line (the server measures it into `seconds`); others last their bars.
const beatSeconds = (b, p) => Number.isFinite(b.seconds) && b.seconds > 0 ? b.seconds : Number(b.bars) * 240 / p.bpm;
const duration = p => p.beats.reduce((s, b) => s + beatSeconds(b, p), 0);
const maxBeats = p => p.beats.some(b => b.say) ? 100 : 40;
const seconds = n => `${Number(n || 0).toFixed(1)} s`;
const beatId = () => 'b' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
const jobLabel = status => {
  const frames = /^rendering (\d+)\/(\d+)/.exec(status || '');
  return frames ? `Rendering ${Math.round(Number(frames[1]) / Number(frames[2]) * 100)}%` : status;
};
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
  const player = mount(canvas, { ...p, characters }, { aspect, tokens: data.variables, assetsBase: `/api/videos/${p.id}/assets/` });
  await player.ready;
  return player;
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

async function editor(host, id, looks, back, parentDisposed) {
  let disposed = false, timer, previewTimer, pollTimer, frame = 0, mountGeneration = 0;
  let selected = 0, aspect = '16:9', playing = false, looping = true, time = 0, lastFrame = 0, player;
  let resources = { assets: [], renders: [], jobs: [] }, jobs = [], errors = {};
  const state = sessions.get(id) || { p: null, undo: [], redo: [], dirty: false, revision: 0, saving: null, error: '' };
  sessions.set(id, state);
  const endpoint = `/api/videos/${id}`;
  const status = el('span', { role: 'status', 'aria-live': 'polite' });
  const summaryError = el('p', { role: 'alert', class: 'studio-error' });
  const list = el('div', { class: 'studio-beats', role: 'list', 'aria-label': 'Video beats' });
  const inspector = el('aside', { class: 'studio-inspector', 'aria-label': 'Beat and project fields' });
  const stage = el('div', { class: 'studio-stage' });
  const previewError = el('p', { role: 'status', class: 'studio-error' });
  const scrub = el('input', { type: 'range', min: 0, step: .01, value: 0, 'aria-label': 'Preview time' });
  const markers = el('div', { class: 'studio-markers' });
  const clock = el('output', { 'aria-label': 'Current preview time' });
  const queue = el('section', { class: 'studio-queue', 'aria-label': 'Render queue' });
  const historyHost = el('div');
  const undo = button('Undo', () => travel('undo', 'redo'));
  const redo = button('Redo', () => travel('redo', 'undo'));
  const play = button('Play', () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; if (time >= duration(state.p)) time = 0; lastFrame = 0; });
  const ask = el('textarea', { placeholder: 'Describe a change', 'aria-label': 'Describe a change', rows: 2, maxlength: 4000 });
  const shell = el('div', { class: 'studio-editor', 'data-video-id': id });
  host.replaceChildren(el('p', { role: 'status', text: 'Loading video...' }));
  try {
    const latest = await api(endpoint);
    if (!state.dirty) state.p = latest;
    resources = await api(`${BASE}/videos/${id}/resources`);
    const recovered = await Promise.allSettled(loadJobs(id).map(jobId => api(`/api/video-jobs/${jobId}`)));
    jobs = [...new Map([...resources.jobs, ...recovered.filter(r => r.status === 'fulfilled').map(r => r.value)].map(j => [j.id, j])).values()];
    aspect = state.p.aspects[0];
  } catch (error) { host.replaceChildren(el('p', { role: 'alert', text: error.message }), button('Back to projects', back)); return () => { disposed = true; }; }
  if (parentDisposed()) return () => {};
  function renderErrors() {
    summaryError.textContent = state.error;
    for (const node of shell.querySelectorAll('[data-error-path]')) {
      const path = node.dataset.errorPath;
      node.textContent = Object.entries(errors).filter(([key]) => key === path || key.startsWith(path + '[')).map(([, value]) => value).join(' ');
      const input = node.parentElement.querySelector('input,textarea,select');
      input?.setAttribute('aria-invalid', String(!!node.textContent));
    }
    status.textContent = state.saving ? 'Saving...' : state.error ? 'Changes need attention' : state.dirty ? 'Unsaved changes' : 'Saved';
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
      } finally { state.saving = null; if (!disposed) renderErrors(); }
    })();
    renderErrors(); await state.saving;
    if (state.dirty && !state.error) return save();
    return !state.error;
  }
  function changed(action, record = true) {
    if (record) { state.undo.push(clone(state.p)); state.undo = state.undo.slice(-30); state.redo = []; }
    action(state.p); state.revision++; state.dirty = true; state.error = ''; errors = {};
    clearTimeout(timer); timer = setTimeout(save, 500);
    clearTimeout(previewTimer); previewTimer = setTimeout(remount, 250);
    drawBeats(); timing(); renderErrors();
  }
  function travel(from, to) {
    if (!state[from].length) return;
    state[to].push(clone(state.p)); state.p = state[from].pop();
    selected = Math.min(selected, state.p.beats.length - 1);
    changed(() => {}, false); drawInspector();
  }
  function move(from, to) {
    if (from < 0 || from >= state.p.beats.length || to < 0 || to >= state.p.beats.length || from === to) return;
    changed(p => { const [beat] = p.beats.splice(from, 1); p.beats.splice(to, 0, beat); });
    selected = to; drawBeats(); drawInspector();
    list.querySelector(`[data-index="${to}"] button`)?.focus();
  }
  function drawBeats() {
    list.replaceChildren();
    state.p.beats.forEach((beat, index) => {
      const row = el('div', { class: 'studio-beat' + (index === selected ? ' selected' : ''), draggable: true, role: 'listitem', 'data-index': index });
      row.append(button(`${index + 1}. ${beat.kind}: ${beat.text || beat.number || (beat.items || []).filter(Boolean).join(', ') || 'No text'} (${seconds(beatSeconds(beat, state.p))})`, () => { selected = index; drawBeats(); drawInspector(); }, { 'aria-pressed': String(index === selected) }),
        el('div', { class: 'studio-actions' }, [button('Move up', () => move(index, index - 1), { disabled: index === 0, 'aria-label': `Move beat ${index + 1} up` }), button('Move down', () => move(index, index + 1), { disabled: index === state.p.beats.length - 1, 'aria-label': `Move beat ${index + 1} down` })]));
      row.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', String(index)));
      row.addEventListener('dragover', event => event.preventDefault());
      row.addEventListener('drop', event => { event.preventDefault(); const from = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(from)) move(from, index); });
      row.addEventListener('keydown', event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(index, index + (event.key === 'ArrowUp' ? -1 : 1)); } });
      list.append(row);
    });
  }
  function timing() {
    const total = duration(state.p); scrub.max = total;
    let start = 0; markers.replaceChildren();
    for (const [index, beat] of state.p.beats.entries()) {
      const at = start;
      markers.append(button(String(index + 1), () => { time = at; selected = index; drawBeats(); drawInspector(); drawFrame(); }, { 'aria-label': `Seek to beat ${index + 1}`, style: `flex:${beatSeconds(beat, state.p)}` }));
      start += beatSeconds(beat, state.p);
    }
    time = Math.min(time, total); drawFrame();
  }
  function drawFrame() {
    try { player?.drawFrame(Math.min(time, player.duration)); } catch (error) { previewError.textContent = error.message; }
    scrub.value = time; clock.textContent = `${seconds(time)} / ${seconds(duration(state.p))}`;
  }
  async function remount() {
    const generation = ++mountGeneration;
    const canvas = el('canvas', { 'aria-label': 'Live video preview' });
    try {
      const next = await preview(canvas, clone(state.p), aspect);
      if (disposed || generation !== mountGeneration) return;
      player = next; stage.replaceChildren(canvas); stage.dataset.aspect = aspect; previewError.textContent = ''; drawFrame();
    } catch (error) { if (!disposed && generation === mountGeneration) { player = null; previewError.textContent = 'Preview unavailable: ' + error.message; } }
  }
  function animate(now) {
    if (disposed) return;
    if (playing && player) {
      if (lastFrame) time += Math.min((now - lastFrame) / 1000, .1);
      if (time >= player.duration) { time = looping ? time % player.duration : player.duration; if (!looping) { playing = false; play.textContent = 'Play'; } }
      drawFrame();
    }
    lastFrame = now; frame = requestAnimationFrame(animate);
  }
  scrub.addEventListener('input', () => { time = Number(scrub.value); drawFrame(); });
  function drawInspector() {
    inspector.replaceChildren();
    const beat = state.p.beats[selected], path = `beats[${selected}]`;
    const setBeat = (key, value) => changed(p => { if ((key === 'image' || key === 'say') && !value) delete p.beats[selected][key]; else p.beats[selected][key] = value; });
    const textField = (label, key, limit, multiline = false) => {
      const input = el(multiline ? 'textarea' : 'input', { value: beat[key] ?? '', 'aria-label': label, maxlength: limit, ...(multiline ? { rows: 3 } : {}) });
      input.value = beat[key] ?? '';
      const node = field(label, input, path + '.' + key, `${String(beat[key] ?? '').length}/${limit} characters`);
      input.addEventListener('input', () => { setBeat(key, input.value); node.querySelector('.meta').textContent = `${input.value.length}/${limit} characters`; });
      return node;
    };
    // Show only the fields this kind of beat draws (static/motion/layout.js); the rest stay hidden, not cleared,
    // so switching kinds back keeps what was typed.
    const kind = beat.kind, pictured = ['image', 'split', 'logo'].includes(kind);
    const only = (node, shown) => { node.hidden = !shown; return node; };
    inspector.append(el('h3', { text: `Beat ${selected + 1}` }), field('Kind', select('Beat kind', KINDS, beat.kind, v => {
      // A scene needs its scene; another kind must not keep one.
      changed(p => { const b = p.beats[selected]; b.kind = v; if (v === 'scene') b.scene ||= structuredClone(NEW_SCENE); else delete b.scene; }); drawInspector();
    }), path + '.kind'),
      textField('Text', 'text', 140, true), only(textField('Supporting text', 'sub', 100), !['big-number', 'list'].includes(kind)),
      only(textField('Number', 'number', 140), kind === 'big-number'));
    const items = el('textarea', { rows: 5, 'aria-label': 'List items, one per line', value: (beat.items || []).join('\n') });
    items.value = (beat.items || []).join('\n');
    const itemField = field('List items, one per line', items, path + '.items', `${(beat.items || []).length}/5 items; 60 characters each`);
    items.addEventListener('input', () => { const lines = items.value ? items.value.split('\n') : []; setBeat('items', lines); itemField.querySelector('.meta').textContent = `${lines.length}/5 items; ${lines.map(s => s.length + '/60').join(', ')} characters`; });
    // A scene's setting, shot, cast and props as JSON (the Editor bot usually writes these; character ids come from the cast).
    const sceneText = el('textarea', { rows: 8, 'aria-label': 'Scene as JSON', spellcheck: 'false' });
    sceneText.value = JSON.stringify(beat.scene || NEW_SCENE, null, 1);
    const sceneField = field('Scene (setting, shot, cast, props)', sceneText, path + '.scene', 'Settings: meadow, city, space, room, ocean, lab. Shots: wide, medium, close.');
    sceneText.addEventListener('input', () => {
      try { const value = JSON.parse(sceneText.value); setBeat('scene', value); sceneField.querySelector('.meta').textContent = 'Saved.'; }
      catch { sceneField.querySelector('.meta').textContent = 'Not valid JSON yet; nothing saved.'; }
    });
    inspector.append(only(itemField, kind === 'list'), only(sceneField, kind === 'scene'), textField('Narration (the line spoken over this beat)', 'say', 400, true));
    const bars = el('input', { type: 'number', min: .5, max: 8, step: .5, value: beat.bars, 'aria-label': 'Beat bars', oninput: event => setBeat('bars', Number(event.target.value)) });
    inspector.append(field('Bars', bars, path + '.bars', beat.say ? 'This beat is narrated, so it lasts as long as its spoken line; bars do not change it.'
      : '0.5 to 8, in half-bar steps. Total video: at most 120 seconds, or 480 when narrated.'),
      field('Camera', select('Camera', CAMERAS, beat.camera || 'still', v => setBeat('camera', v)), path + '.camera'),
      field('Transition to next beat', select('Transition', TRANSITIONS, beat.transition || 'cut', v => setBeat('transition', v)), path + '.transition'), only(textField('Image treatment', 'treatment', 80), pictured));
    inspector.append(only(field('Image', select('Video image', [['', 'No image'], ...resources.assets.map(a => [a, a.slice(7, 23) + '…'])], beat.image || '', v => setBeat('image', v)), path + '.image'), pictured));
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
    inspector.append(only(field('Upload an image', upload, '', 'PNG, JPEG, GIF or WebP. Up to 25 MB and 40 megapixels.'), pictured), only(button('Choose image from a design', async () => {
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
      inspector.append(field('Design images', designPicker), assetsHost); designPicker.focus();
    }), pictured), el('div', { class: 'studio-actions' }, [button('Duplicate beat', () => {
      if (state.p.beats.length >= maxBeats(state.p)) throw Error(`A video can have at most ${maxBeats(state.p)} beats.`);
      changed(p => p.beats.splice(selected + 1, 0, { ...clone(p.beats[selected]), id: beatId() })); selected++; drawBeats(); drawInspector();
    }), button('Delete beat', () => {
      if (state.p.beats.length === 1) throw Error('Keep at least one beat.');
      changed(p => p.beats.splice(selected, 1)); selected = Math.min(selected, state.p.beats.length - 1); drawBeats(); drawInspector();
    })]));
    const title = el('input', { value: state.p.title, maxlength: 120, 'aria-label': 'Video title' });
    const titleField = field('Title', title, 'title', `${state.p.title.length}/120 characters`);
    title.addEventListener('input', () => { changed(p => { p.title = title.value; }); titleField.querySelector('.meta').textContent = `${title.value.length}/120 characters`; });
    inspector.append(el('h3', { text: 'Project' }), titleField,
      field('Look', select('Project look', looks.map(l => [l.id, l.name]), state.p.look, v => { changed(p => { p.look = v; }); drawInspector(); }), 'look'));
    const swatches = el('div', { class: 'studio-swatches', 'aria-label': 'Look colours' });
    inspector.append(swatches);
    lookTokens(state.p.look).then(data => { if (!swatches.isConnected) return; for (const key of ['--ds-bg', '--ds-text', '--ds-accent', '--ds-accent-2']) { const swatch = el('span', { title: `${key}: ${data.variables[key]}`, 'aria-label': `${key}: ${data.variables[key]}` }); swatch.style.background = data.variables[key]; swatches.append(swatch); } }).catch(() => {});
    const aspects = el('fieldset', {}, [el('legend', { text: 'Aspects to render' })]);
    for (const a of ASPECTS) aspects.append(el('label', { class: 'studio-check' }, [el('input', { type: 'checkbox', checked: state.p.aspects.includes(a), onchange: event => {
      changed(p => { p.aspects = event.target.checked ? [...p.aspects, a] : p.aspects.filter(v => v !== a); });
    } }), el('span', { text: a })]));
    inspector.append(aspects, el('small', { class: 'studio-error', 'data-error-path': 'aspects', role: 'alert' }),
      field('Tempo (BPM)', el('input', { type: 'number', min: 60, max: 180, value: state.p.bpm, 'aria-label': 'Tempo in beats per minute', oninput: e => changed(p => { p.bpm = Number(e.target.value); }) }), 'bpm', '60 to 180 BPM'),
      field('Music mood', select('Music mood', MOODS, state.p.music.mood, v => changed(p => { p.music.mood = v; })), 'music.mood'),
      field('Music volume', el('input', { type: 'range', min: 0, max: 1, step: .01, value: state.p.music.volume, 'aria-label': 'Music volume', oninput: e => changed(p => { p.music.volume = Number(e.target.value); }) }), 'music.volume', '0 to 1'));
    renderErrors();
  }
  function drawJobs() {
    queue.replaceChildren(el('h3', { text: 'Render queue and downloads' }), el('div', { class: 'studio-actions' }, [
      ...ASPECTS.map(a => button('Render ' + a, () => startRender([a]))), button('Render chosen aspects', () => startRender(state.p.aspects)),
    ]));
    for (const job of jobs) {
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
      for (const [label, name] of [['Download MP4', file], ['Download contact sheet', `sheet-${slug}.png`], ['Download soundtrack (WAV)', 'soundtrack.wav']]) links.append(el('a', { class: 'btn', href: endpoint + '/renders/' + name, download: name, text: label }));
      queue.append(el('article', { class: 'card studio-download' }, [el('h4', { text: file }), el('video', { src: url, controls: true, preload: 'metadata', 'aria-label': `Rendered video ${file}` }), links]));
    }
  }
  async function startRender(aspects) {
    if (!await save()) throw Error('Fix the highlighted fields before rendering.');
    if (!aspects.length || aspects.some(a => !state.p.aspects.includes(a))) throw Error('Choose these aspects in the project fields first.');
    for (const a of aspects) { const job = await write(endpoint + '/render', { aspect: a }); jobs.push(job); rememberJobs(id, jobs); drawJobs(); }
  }
  async function poll() {
    try {
      const results = await Promise.allSettled([api(endpoint), ...jobs.filter(j => j.status !== 'ready' && !j.status.startsWith('failed:')).map(j => api(`/api/video-jobs/${j.id}`))]);
      if (disposed) return;
      const latest = results[0].status === 'fulfilled' ? results[0].value : null;
      if (latest && !state.dirty && !state.saving && latest.version !== state.p.version) {
        state.undo = []; state.redo = []; state.p = latest; selected = Math.min(selected, latest.beats.length - 1);
        resources = await api(`${BASE}/videos/${id}/resources`);
        if (disposed) return;
        drawBeats(); drawInspector(); timing(); remount();
      }
      let jobChanged = false;
      for (const result of results.slice(1)) if (result.status === 'fulfilled') {
        const index = jobs.findIndex(j => j.id === result.value.id);
        if (JSON.stringify(jobs[index]) !== JSON.stringify(result.value)) { jobs[index] = result.value; jobChanged = true; }
      }
      if (jobChanged) drawJobs();
    } catch (error) { if (!disposed) previewError.textContent = 'Refresh unavailable: ' + error.message; }
    finally { if (!disposed) pollTimer = setTimeout(poll, 3000); }
  }
  const addKind = select('Kind of beat to add', KINDS, 'statement', () => {});
  shell.append(el('div', { class: 'studio-editor-top studio-actions' }, [button('Projects', async () => { if (await save()) await back(); }), undo, redo, status, button('Save now', save)]), summaryError,
    el('div', { class: 'studio-columns' }, [el('aside', { 'aria-label': 'Beat sequence' }, [el('h3', { text: 'Beats' }), el('p', { class: 'meta', text: 'Drag to reorder, use Move buttons, or Alt + Arrow keys.' }), list,
      field('Add beat by kind', addKind), button('Add beat', () => {
        if (state.p.beats.length >= maxBeats(state.p)) throw Error(`A video can have at most ${maxBeats(state.p)} beats.`);
        changed(p => p.beats.push({ id: beatId(), kind: addKind.value, text: '', bars: 1, ...(addKind.value === 'scene' ? { scene: structuredClone(NEW_SCENE) } : {}) })); selected = state.p.beats.length - 1; drawBeats(); drawInspector();
      })]), el('section', { class: 'studio-centre', 'aria-label': 'Preview and rendering' }, [
      field('Preview aspect', select('Preview aspect', ASPECTS, aspect, value => { aspect = value; remount(); })), stage, previewError,
      el('div', { class: 'studio-actions' }, [play, el('label', { class: 'studio-check' }, [el('input', { type: 'checkbox', checked: looping, onchange: e => { looping = e.target.checked; } }), el('span', { text: 'Loop' })]), clock]),
      scrub, markers, el('small', { class: 'studio-error', 'data-error-path': 'beats', role: 'alert' }), queue,
      el('h3', { text: 'Ask Kairos' }), field('Describe a change', ask), button('Ask Kairos', async () => {
        if (!ask.value.trim()) { ask.focus(); return; }
        if (!await save()) throw Error('Fix the highlighted fields before asking Kairos.');
        const result = await write(`${BASE}/chat`, { video_id: id });
        go('chat', { sessionId: result.session_id, mobileDraft: `For [Video: ${state.p.title}](/videos/${id}): ${ask.value.trim()}`, mobileConversation: true });
      }), el('details', { class: 'disclosure-panel', ontoggle: async event => {
        if (!event.target.open) return;
        try {
          const history = await api(endpoint + '/history');
          historyHost.replaceChildren(...history.map(p => el('div', { class: 'studio-actions' }, [el('span', { text: `Version ${p.version} · ${new Date(p.updated * 1000).toLocaleString()}` }), button('Restore version ' + p.version, async () => {
            if (!await confirmDialog({ title: 'Restore this version?', message: 'This saves the older version as a new version. Your current version stays in history.', confirmLabel: 'Restore', danger: false })) return;
            if (!await save()) throw Error('Fix the highlighted fields first.');
            state.p = await write(endpoint + `/restore/${p.version}`, {}); state.dirty = false; state.undo = []; state.redo = []; selected = 0;
            drawBeats(); drawInspector(); timing(); remount();
          })])));
          if (!history.length) historyHost.append(el('p', { text: 'No earlier versions yet.' }));
        } catch (error) { historyHost.textContent = error.message; }
      } }, [el('summary', { text: 'Version history' }), historyHost]),
    ]), inspector]));
  host.replaceChildren(shell);
  drawBeats(); drawInspector(); timing(); drawJobs(); remount();
  frame = requestAnimationFrame(animate); pollTimer = setTimeout(poll, 3000);
  if (state.dirty) timer = setTimeout(save, 500);
  return () => {
    disposed = true; mountGeneration++; playing = false; player = null;
    clearTimeout(timer); clearTimeout(previewTimer); clearTimeout(pollTimer); cancelAnimationFrame(frame);
    rememberJobs(id, jobs); if (state.dirty && !state.error) void save();
  };
}

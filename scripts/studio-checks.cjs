// Standalone offline UI checks: node scripts/studio-checks.cjs
// Uses the real shell, folder tab renderer, motion engine and chat renderer.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const binary = process.env.JARVIS_ELECTRON_BINARY || require('../electron/node_modules/electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(binary, [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 420000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const assert = require('node:assert/strict');
const fixture = require('../demo/fixtures.js')({ state: { empty: false } }).fixture;
const output = path.join(root, 'data/ui-review', 'studio-' + Date.now());
const lock = path.join(root, 'data/electron.lock');
let ownsLock = false, win, server;
const errors = [], outside = [], writes = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = 'abcdef123456';
const project = { id, owner: 'local', title: 'Spring season', look: 'sport', bpm: 120, fps: 30, aspects: ['16:9', '9:16', '1:1'],
  beats: [{ id: 'title', kind: 'title', text: 'Spring season is here', bars: 1 }, { id: 'message', kind: 'statement', text: 'Every kid plays', bars: 1 }, { id: 'end', kind: 'end', text: 'Find your team', bars: 1 }],
  music: { mood: 'energetic', volume: .7 }, version: 1, updated: Date.now() / 1000, created: Date.now() / 1000 };
const original = structuredClone(project), history = [structuredClone(project)], jobs = [], renders = [];
// A long video in chapters (Video Styles unit 4): a stopped render from before a restart, the plan gate, Resume, progress.
const longId = 'fedcba654321';
const say = n => ({ say: `Line ${n} of the long video, spoken over this beat.`, seconds: 4 });
const longProject = { id: longId, owner: 'local', title: 'The Moon', look: 'sport', bpm: 120, fps: 30, aspects: ['16:9'],
  beats: [1, 2, 3, 4, 5, 6].map(n => ({ id: `b${n}`, kind: 'statement', text: `Point ${n}`, bars: 1, ...say(n) })),
  chapters: [{ id: 'c1', title: 'Opening', start: 'b1' }, { id: 'c2', title: 'Phases', start: 'b3' }, { id: 'c3', title: 'Tides', start: 'b5' }],
  narration: { voice: 'af_heart', captions: true }, music: { mood: 'calm', volume: .5 }, version: 1, updated: Date.now() / 1000, created: Date.now() / 1000 };
const longChapters = state => longProject.chapters.map((c, i) => ({ id: c.id, title: c.title, frames: 240, done: state[i] === 'done' ? 240 : state[i] === 'rendering' ? 120 : 0, state: state[i] }));
let longPlan = 'none', longJob = null;
const longRenders = [];
// A Pack A scene video with narration (the inspector's scene form, the waveform lane, the caption guide).
const sceneId = 'aaaabbbbcccc', pipId = 'abcdefabcdef';
const pipSpec = { name: 'Pip', family: 'round', accessory: 'leaf', outline: 7,
  proportions: { head: .42, body_width: .62, limb_length: .26, limb_width: .055, eye_size: .036 },
  palette: { body: '#f4a259', body_shade: '#e0843d', head: '#f7c08a', limb: '#5b4a6b', eye: '#231b2e', mouth: '#8c3b4a', outline: '#2e2438', accent: '#7cc6a4', cheek: '#f08a8a' },
  parts: ['head', 'body', 'arm_left', 'arm_right', 'leg_left', 'leg_right'], views: ['front', 'three_quarter', 'side', 'back'],
  expressions: ['neutral', 'happy', 'surprised', 'worried', 'thinking'], mouths: ['rest', 'A', 'E', 'O', 'MBP', 'FV'] };
const sceneProject = { id: sceneId, owner: 'local', title: 'Why the sky is blue', look: 'sport', bpm: 120, fps: 30, aspects: ['16:9'], palette: 'dawn',
  cast: [{ character: pipId, version: 1 }, { character: 'cccccccccccc', version: 1 }], narration: { voice: 'af_heart', captions: true },
  beats: [{ id: 's1', kind: 'scene', text: 'Look up', bars: 1, say: 'Look up on a clear day.', seconds: 2.9,
    spoken: { key: '0123456789abcdef', seconds: 2.2, parts: [[.25, 2.45, 'Look up on a clear day.']] },
    scene: { setting: 'meadow', shot: 'medium', cast: [{ character: pipId, x: .5, view: 'front', expression: 'neutral', action: 'idle', facing: 'right', speaking: false }], props: [] } },
  { id: 's2', kind: 'statement', text: 'Light scatters', bars: 2 },
  { id: 's3', kind: 'stage', text: 'In 3D', bars: 2, stage: { set: 'lavender', shot: 'medium', pedestal: false, cast: [{ character: 'cccccccccccc', x: 0, expression: 'neutral', action: 'idle', facing: 'camera', speaking: false }], people: { count: 0, seed: 0 }, props: [], labels: [] } }],
  music: { mood: 'calm', volume: .5 }, version: 1, updated: Date.now() / 1000, created: Date.now() / 1000 };
const characters = { characters: [{ id: pipId, name: 'Pip', family: 'round', approved_version: 1, versions: [{ version: 1, status: 'approved' }] },
  { id: 'bbbbbbbbbbbb', name: 'Bo', family: 'square', approved_version: null, versions: [{ version: 1, status: 'draft' }] },
  { id: 'cccccccccccc', name: 'Pip 3D', family: 'round', approved_version: 1, versions: [{ version: 1, status: 'approved' }] },
  { id: 'dddddddddddd', name: 'Pip Block', family: 'round', approved_version: 1, versions: [{ version: 1, status: 'approved' }] },
  { id: 'eeeeeeeeeeee', name: 'Rook', family: 'square', approved_version: 1, versions: [{ version: 1, status: 'approved' }] },
  { id: 'ffffffffffff', name: 'Fenn', family: 'round', approved_version: 1, versions: [{ version: 1, status: 'approved' }] }], pending: [] };
const tokens = { '--ds-bg': '#101418', '--ds-surface': '#1b2129', '--ds-text': '#ffffff', '--ds-text-dim': '#b4bdc8', '--ds-accent': '#c6ff3d',
  '--ds-accent-2': '#ff5a1f', '--ds-on-accent': '#101418', '--ds-font-display': 'Arial, sans-serif', '--ds-font-sans': 'Arial, sans-serif', '--ds-radius-m': '4px' };
let enabled = true;
const template = fs.readFileSync(path.join(root, 'static/motion/player.html'), 'utf8');
// Steps 3 and 4: a video for tracks and clips, a sound and an image it holds, and Ask Kairos's state (a stand-in for
// core/video_agent.py: an applied run, a dry run over five changes, undo, comments).
const trackId = 'cccc0000dddd', imageAsset = 'assets/' + 'e'.repeat(64) + '.png', soundAsset = 'assets/' + 'd'.repeat(64) + '.wav';
const trackProject = { id: trackId, owner: 'local', title: 'Layers', look: 'sport', bpm: 120, fps: 30, aspects: ['16:9'],
  beats: [{ id: 'l1', kind: 'title', text: 'Layers on top', bars: 2 }, { id: 'l2', kind: 'statement', text: 'Clips over beats', bars: 2 }, { id: 'l3', kind: 'end', text: 'See you soon', bars: 2 }],
  music: { mood: 'calm', volume: .6 }, version: 1, updated: Date.now() / 1000, created: Date.now() / 1000 };
const trackSounds = { [soundAsset]: { seconds: 2.5, title: 'Chime', rate: 40, peaks: Buffer.from(Array.from({ length: 100 }, (_, i) => Math.round(90 + 80 * Math.sin(i / 4)))).toString('base64') } };
const review = { comments: [], runs: [], since: { since: null, changes: [] }, connection: 'Test model', dry_run_over: 5 };
// Step 7: a video file this video holds (its decoded frames stand in as the app icon) with its sound.
const videoSha = 'f'.repeat(64), trackMedia = { ['media/' + videoSha]: { seconds: 4, frames: 120, width: 192, height: 192, title: 'Waves', bytes: 2400000, audio: soundAsset, cut: false } };
const asks = [];
// Polish for 2.3.0: Pack C's voxel beat and Pack C classic's story beat in their own forms. The starter specs come from
// core/character_store.py so the preview draws the real blocky and block characters.
const packC = (() => {
  const python = [path.join(root, '.venv', 'Scripts', 'python.exe'), path.join(root, '.venv', 'bin', 'python')].find(p => fs.existsSync(p));
  const out = require('node:child_process').spawnSync(python, ['-c', "import json; from core import character_store as c; print(json.dumps({'voxel': c.starter_voxel('round'), 'rook': c.starter_block('square'), 'fenn': c.starter_block('round')}))"], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw Error('Could not read the starter characters: ' + out.stderr);
  return JSON.parse(out.stdout);
})();
const voxId = 'aaaa1111bbbb', blockPip = 'dddddddddddd', rookId = 'eeeeeeeeeeee', fennId = 'ffffffffffff';
const PACK_C_SPECS = { [blockPip]: packC.voxel, [rookId]: packC.rook, [fennId]: packC.fenn };
// Stored as the server keeps them (defaults filled in), with fields the forms do not show (a face angle, a change some
// seconds after its word, a move, a leave, a prop colour) so opening the beats must not change a thing.
const voxelBeat = { id: 'v1', kind: 'voxel', text: 'Blocks', bars: 2, voxel: { world: 'cave', time: 'dusk', shot: 'medium', seed: 7,
  cast: [{ character: blockPip, x: -.2, expression: 'happy', action: 'wave', facing: 'camera', speaking: false }], people: { count: 1, seed: 3 },
  props: [{ kind: 'gem', x: .6, depth: .4 }], labels: [{ over: 'c0', text: '3.5%', sub: 'salt', at: .5 }] } };
const storyBeats = [
  { id: 'st1', kind: 'story', text: '', bars: 1, say: 'Help me, I am slipping off the edge!', speaker: rookId, gap: .3, flashback: false, seconds: 2.6,
    story: { place: 'cliff', seed: 4, time: 'day',
      cast: [{ character: rookId, x: 0, y: -1, pose: 'hang', mood: 'scared', face: 25, changes: [{ at: { word: 4, after: .2 }, mood: 'shocked' }] },
        { character: fennId, x: 3, y: 0, pose: 'idle', mood: 'neutral', face: 'c0', changes: [], move: { to: [1.5, 0], at: { word: 2 }, run: true }, leave: { at: { t: 2.2 } } }],
      shots: [{ shot: 'medium', on: 0, push: .3, shake: false }, { shot: 'close', on: 1, with: 0, at: { word: 3 }, push: .2, shake: true, side: 'left' }],
      fx: [{ kind: 'fall', at: { word: 6 }, on: 0, seconds: 1.4 }], props: [{ kind: 'crate', x: 4, y: 0, colour: '#e8434e' }],
      sfx: [{ kind: 'gasp', at: { word: 0 } }], keys: ['edge'] } },
  { id: 'st2', kind: 'story', text: '', bars: 1, hold: 1.2, flashback: true,
    story: { place: 'meadow', seed: 0, time: 'day', cast: [{ character: fennId, x: 0, y: 0, pose: 'think', mood: 'neutral', face: 'camera', changes: [] }],
      shots: [{ shot: 'wide', on: 0, push: .3, shake: false }], fx: [], props: [], sfx: [], keys: [] } }];
const voxProject = { id: voxId, owner: 'local', title: 'Blocks and stories', look: 'sport', bpm: 120, fps: 30, aspects: ['9:16'],
  cast: [{ character: blockPip, version: 1 }, { character: rookId, version: 1 }, { character: fennId, version: 1 }],
  beats: [voxelBeat, ...storyBeats], music: { mood: 'calm', volume: .5 }, version: 1, updated: Date.now() / 1000, created: Date.now() / 1000 };
const voxOriginal = structuredClone(voxProject);
// The app page carries the exact Content-Security-Policy the backend sends for "/" (core/middleware.py), so the
// hashed three.js import map is checked in a real browser under the real policy.
const appPolicy = (() => {
  const python = [path.join(root, '.venv', 'Scripts', 'python.exe'), path.join(root, '.venv', 'bin', 'python')].find(p => fs.existsSync(p));
  const out = require('node:child_process').spawnSync(python, ['-c', "from core.middleware import content_security_policy; print(content_security_policy('/'))"], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0 || !out.stdout.includes("script-src 'self' 'sha256-")) throw Error('Could not read the app page policy: ' + out.stderr);
  return out.stdout.trim();
})();
const policyViolations = [];
const customTab = { id: 'studio', label: 'Studio', user_tab: false, format: 'folder', view_url: '/tab-files/studio/view.js', style_url: '/tab-files/studio/view.css', icon_svg: '<svg viewBox="0 0 24 24"><path d="M3 6h18v15H3z"/></svg>' };
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
async function serve(req, res) {
  const url = new URL(req.url, 'http://localhost'), p = url.pathname;
  if (p === `/api/videos/${id}/player`) {
    res.setHeader('Content-Type', 'text/html');
    res.end(template.replace('<!--KD-TOKENS-->', `<style>:root{${Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(';')}}</style>`)
      .replace('<!--KD-PROJECT-->', `<script type="application/json" id="kd-project">${JSON.stringify(project)}</script>`)); return;
  }
  if (/^\/api\/videos\/[^/]+\/renders\/.+\.(mp4|webm|mov|gif)$/.test(p)) {
    res.setHeader('Content-Type', 'video/mp4'); res.end(fs.readFileSync(path.join(root, 'docs/media/kairos-ad.mp4'))); return;
  }
  if (p.startsWith('/api/')) {
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      body = raw ? JSON.parse(raw) : {};
      writes.push({ path: p, method: req.method, body });
    }
    if (p === '/api/system/custom-tabs') return json(res, enabled ? [customTab] : []);
    if (p === `/api/videos/${trackId}`) return json(res, req.method === 'PUT' ? Object.assign(trackProject, body, { version: trackProject.version + 1 }) : trackProject);
    if (p === `/api/tab-studio/videos/${trackId}/resources`) return json(res, { assets: [imageAsset], renders: [], jobs: [], thumbnail: null });
    if (p === `/api/videos/${trackId}/assets/${imageAsset.slice(7)}`) { res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(path.join(root, 'static/img/app-192.png'))); return; }
    if (p === `/api/videos/${trackId}/audio`) return json(res, { sounds: trackSounds });
    if (p === `/api/videos/${trackId}/media`) return json(res, { media: trackMedia });
    if (p.startsWith(`/api/videos/${trackId}/assets/media/${videoSha}/`)) { res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(path.join(root, 'static/img/app-192.png'))); return; }
    if (/^\/api\/videos\/[a-f0-9]{12}\/media$/.test(p)) return json(res, { media: {} });
    if (p === `/api/videos/${sceneId}/narrate`) {
      // Narrating with a word style finds the line's word times (core/video_align.py): six words, aligned surely.
      sceneProject.beats[0].spoken = { ...sceneProject.beats[0].spoken, words: [[.3, .55], [.6, .8], [.85, 1.05], [1.1, 1.3], [1.35, 1.7], [1.75, 2.4]], align: { method: 'whisper.cpp base.en', confidence: 1 } };
      sceneProject.version++; return json(res, sceneProject);
    }
    if (p === `/api/videos/${trackId}/review`) return json(res, review);
    if (/^\/api\/videos\/[a-f0-9]{12}\/audio$/.test(p)) return json(res, { sounds: {} });
    if (/^\/api\/videos\/[a-f0-9]{12}\/review$/.test(p)) return json(res, { comments: [], runs: [], since: { since: null, changes: [] }, connection: 'Test model', dry_run_over: 5 });
    if (p === `/api/videos/${trackId}/comments`) {
      const c = { id: 'm' + (review.comments.length + 1), ...body, status: 'open', created: Date.now() / 1000 }; review.comments.push(c); return json(res, c);
    }
    if (p.startsWith(`/api/videos/${trackId}/comments/`)) {
      const cid = p.split('/').pop(), c = review.comments.find(x => x.id === cid);
      if (req.method === 'DELETE') { review.comments.splice(review.comments.indexOf(c), 1); return json(res, { ok: true }); }
      Object.assign(c, body); return json(res, c);
    }
    if (p === `/api/videos/${trackId}/agent/ask`) {
      asks.push(body);
      const run = { id: 'r' + (review.runs.length + 1), request: body.request, comments: body.comments, reply: '', status: 'applied', created: Date.now() / 1000, before: structuredClone(trackProject) };
      if (/many/.test(body.request)) {
        run.status = 'pending'; run.reply = 'Six short points, one after another.';
        run.changes = Array.from({ length: 6 }, (_, i) => ({ item: `clip:p${i}`, type: 'clip', change: 'added', words: `Added clip p${i} (text "Point ${i + 1}") on Overlay 1 from 0:0${i}.0 to 0:0${i}.5.` }));
      } else {
        const clip = trackProject.tracks?.flatMap(t => t.clips).find(c => c.kind === 'text');
        if (clip) clip.text = 'Welcome'; else trackProject.beats[1].text = 'Changed by Kairos';
        trackProject.version++;
        run.reply = 'Made the greeting warmer.';
        run.changes = [{ item: `clip:${clip?.id}`, type: 'clip', change: 'changed', words: `Changed clip ${clip?.id} (text "Welcome"): text.` }];
        run.after = structuredClone(trackProject);
        for (const c of review.comments) if (body.comments.includes(c.id)) c.status = 'resolved';
        review.since = { since: trackProject.version, changes: [] };
      }
      review.runs.unshift(run);
      const { before, after, ...out } = run; return json(res, out);
    }
    const runAction = new RegExp(`^/api/videos/${trackId}/agent/runs/(r\\d+)/(apply|discard|undo)$`).exec(p);
    if (runAction) {
      const run = review.runs.find(r => r.id === runAction[1]), action = runAction[2];
      if (action === 'undo') { Object.assign(trackProject, structuredClone(run.before), { version: trackProject.version + 1 }); run.status = 'undone'; run.conflicts = []; }
      if (action === 'apply') { trackProject.beats[0].text = 'Six points'; trackProject.version++; run.status = 'applied'; }
      if (action === 'discard') run.status = 'discarded';
      const { before, after, ...out } = run;
      return json(res, action === 'discard' ? out : { run: out, project: trackProject });
    }
    if (p === `/api/videos/${longId}`) return json(res, req.method === 'PUT' ? Object.assign(longProject, body, { version: longProject.version + 1 }) : longProject);
    if (p === `/api/videos/${longId}/plan`) return json(res, { chaptered: true, status: longPlan, current: 'Chapter 1 at 0:00: Opening\n  00:00.0-00:04.0 b1 statement' });
    if (p === `/api/videos/${longId}/plan/approve`) { longPlan = 'approved'; return json(res, { status: 'approved' }); }
    if (p === `/api/tab-studio/videos/${longId}/resources`) return json(res, { assets: [], renders: longRenders, jobs: longJob ? [longJob] : [], thumbnail: null,
      long_renders: longJob ? [] : [{ aspect: '16:9', status: 'interrupted', live: false, chapters: longChapters(['done', 'waiting', 'waiting']), fps: 41.5, frames_total: 720, resumable: true }],
      disk: { parts: 12582912, videos: 0, other: 0, total: 12582912 }, plan: { status: longPlan } });
    if (p === `/api/videos/${longId}/render`) {
      if (longPlan !== 'approved') return json(res, { detail: 'plan: The shot plan of this long video has not been sent to the person.' }, 422);
      longJob = { id: 'long1', kind: 'long', video_id: longId, aspect: body.aspect, status: 'rendering 360/720', chapters: longChapters(['done', 'rendering', 'waiting']),
        frames_done: 360, frames_total: 720, fps: 41.5, eta_seconds: 9, polls: 0, resumed: true, reused: 1 };
      return json(res, longJob);
    }
    if (p === '/api/video-jobs/long1') {
      longJob.polls++;
      if (longJob.polls >= 2) {
        Object.assign(longJob, { status: 'ready', chapters: longChapters(['done', 'done', 'done']), frames_done: 720, eta_seconds: 0, file: '16-9-v1.mp4', render_seconds: 61, notes: [] });
        if (!longRenders.length) longRenders.push('16-9-v1.mp4', '16-9-v1.chapters.txt', 'sheet-16-9.png', 'soundtrack.wav');
      }
      return json(res, longJob);
    }
    if (p === `/api/videos/${sceneId}`) return json(res, req.method === 'PUT' ? Object.assign(sceneProject, body, { version: sceneProject.version + 1 }) : sceneProject);
    if (p === `/api/videos/${voxId}`) return json(res, req.method === 'PUT' ? Object.assign(voxProject, body, { version: voxProject.version + 1 }) : voxProject);
    if (p === `/api/tab-studio/videos/${voxId}/resources`) return json(res, { assets: [], renders: [], jobs: [], thumbnail: null });
    if (p === `/api/tab-studio/videos/${voxId}/waveform`) return json(res, { beats: {} });
    const packCSpec = /^\/api\/characters\/([a-f0-9]{12})\/versions\/1$/.exec(p);
    if (packCSpec && PACK_C_SPECS[packCSpec[1]]) return json(res, { version: 1, status: 'approved', spec: PACK_C_SPECS[packCSpec[1]] });
    if (p === `/api/tab-studio/videos/${sceneId}/resources`) return json(res, { assets: [], renders: [], jobs: [], thumbnail: null });
    if (p === `/api/tab-studio/videos/${sceneId}/waveform`) return json(res, { beats: { s1: { key: '0123456789abcdef', rate: 40, offset: .25, peaks: Array.from({ length: 88 }, (_, i) => Math.round(120 + 100 * Math.sin(i / 3))) } } });
    if (p === '/api/characters') return json(res, characters);
    if (p === `/api/characters/${pipId}/versions/1`) return json(res, { version: 1, status: 'approved', spec: pipSpec });
    if (p === '/api/characters/cccccccccccc/versions/1') return json(res, { version: 1, status: 'approved', spec: { ...pipSpec, name: 'Pip 3D', form: '3d' } });
    if (p === '/api/video-renderers') return json(res, { threejs: { supported: true }, blender: { supported: false, version: null, message: 'Blender is not installed on this computer.' } });
    if (p === '/api/characters/bbbbbbbbbbbb/versions/1') return json(res, { version: 1, status: 'draft', spec: { ...pipSpec, name: 'Bo', family: 'square', accessory: 'antenna',
      palette: { ...pipSpec.palette, body: '#4fb3bf', body_shade: '#3a919c', head: '#a9dde3' } } });
    if (p === '/api/tab-studio/looks') return json(res, { default: 'sport', looks: [{ id: 'sport', name: 'Sport' }] });
    if (p === '/api/tab-studio/tokens/sport') return json(res, { variables: tokens, font_css: '' });
    if (p === '/api/videos/ffmpeg') return json(res, { found: false, message: 'Video needs FFmpeg. Windows: `winget install --id Gyan.FFmpeg -e`. Kairos never installs it for you.' });
    if (p === '/api/videos') return json(res, req.method === 'POST' ? Object.assign(project, body) : [project]);
    if (p === `/api/tab-studio/videos/${id}/resources`) return json(res, { assets: [], renders, jobs, thumbnail: null });
    if (p === `/api/videos/${id}`) {
      if (req.method === 'PUT') {
        if (!body.title) return json(res, { detail: [{ loc: ['body', 'title'], msg: 'Title must not be empty.' }] }, 422);
        if (body.beats[0].text === 'invalid fixture') return json(res, { detail: 'beats[0].text: shorten this text.' }, 422);
        Object.assign(project, body, { version: project.version + 1, updated: Date.now() / 1000 });
        history.unshift(structuredClone(project));
      }
      return json(res, project);
    }
    if (p === `/api/videos/${id}/history`) return json(res, history);
    if (p.startsWith(`/api/videos/${id}/restore/`)) {
      const prior = history.find(p => p.version === Number(url.pathname.split('/').pop()));
      Object.assign(project, structuredClone(prior), { version: project.version + 1 }); return json(res, project);
    }
    if (p === `/api/videos/${id}/render`) {
      const job = { id: 'job' + (jobs.length + 1), video_id: id, aspect: body.aspect, status: 'rendering 0/180', polls: 0, ...(body.format && body.format !== 'mp4' ? { kind: 'export', format: body.format, status: 'rendering the MP4 first' } : {}) };
      jobs.push(job); return json(res, job);
    }
    if (p.startsWith('/api/video-jobs/')) {
      const job = jobs.find(j => j.id === p.split('/')[3]);
      if (p.endsWith('/cancel')) job.status = 'failed: cancelled';
      else if (!job.status.startsWith('failed:')) {
        job.polls++;
        job.status = job.polls === 1 ? (job.kind === 'export' ? `encoding ${job.format.toUpperCase()}` : 'rendering 90/180') : job.polls === 2 ? 'encoding' : 'ready';
        if (job.status === 'ready' && job.kind === 'export') {
          const slug = job.aspect.replace(':', '-'); Object.assign(job, { file: `${slug}-v1.${job.format}`, bytes: 1572864, seconds_spent: 4.2, notes: [] });
        } else if (job.status === 'ready') {
          const slug = job.aspect.replace(':', '-'); job.file = `${slug}-v1.mp4`; job.notes = ['The end card stays still.'];
          if (!renders.includes(job.file)) renders.push(job.file, `sheet-${slug}.png`, 'soundtrack.wav');
        }
      }
      return json(res, job);
    }
    if (p === '/api/tab-studio/chat') return json(res, { session_id: 's1' });
    if (p === '/api/chat/live/events') {  // The chat's live stream: an open, quiet event stream.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: [] })}\n\n`);
      return;
    }
    if (p === '/api/system/tabs') return json(res, [{ slug: 'studio', name: 'Studio', blurb: 'Make and edit videos', enabled, kind: 'prebuilt' }]);
    try { return json(res, fixture(url)); } catch (error) { errors.push(error.message); return json(res, { detail: 'Missing fixture: ' + p }, 404); }
  }
  const tabFile = /^\/tab-files\/studio\/(view\.js|view\.css)$/.exec(p);
  const file = tabFile ? path.join(root, 'tabs/studio', tabFile[1]) : path.resolve(root, p === '/' ? 'static/index.html' : '.' + decodeURIComponent(p));
  if (!tabFile && !file.startsWith(path.join(root, 'static') + path.sep)) { res.writeHead(404); res.end(); return; }
  if (p === '/') res.setHeader('Content-Security-Policy', appPolicy);
  try {
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
}
async function acquireLock() {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let n = 0; n < 120; n++) {
    try { fs.mkdirSync(lock); ownsLock = true; return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await pause(1000);
  }
  throw Error('Another Electron test holds data/electron.lock');
}
function cleanup() {
  if (win && !win.isDestroyed()) win.destroy();
  server?.close();
  if (ownsLock) { fs.rmdirSync(lock); ownsLock = false; }
}
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  try {
    await acquireLock(); fs.mkdirSync(output, { recursive: true });
    server = http.createServer((req, res) => { serve(req, res).catch(error => { errors.push(error.stack); json(res, { detail: error.message }, 500); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const allow = details.url.startsWith(base + '/') || details.url.startsWith('data:') || details.url.startsWith('blob:') || details.url === 'about:blank';
      if (!allow) outside.push(details.url); cb({ cancel: !allow });
    });
    win = new BrowserWindow({ width: 1440, height: 1000, show: false, useContentSize: true, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    const js = code => win.webContents.executeJavaScript(code);
    // Renderer errors go to the log, so a failed check says why.
    win.webContents.on('console-message', (...args) => { const e = args[0], level = e.level ?? args[1], message = e.message ?? args[2]; if (level === 'error' || level === 3) console.error('renderer: ' + message); });
    const wait = async expression => {
      for (let n = 0; n < 300; n++) { if (await js(expression)) return; await pause(50); }
      throw Error('Timed out: ' + expression);
    };
    const click = async text => { await js(`[...document.querySelectorAll('.studio-view button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`); await pause(100); };
    const edit = async (label, value) => js(`(() => { const input=document.querySelector('[aria-label=${JSON.stringify(label)}]'); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const capture = async name => { await pause(150); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const noOverflow = async () => assert.equal(await js("document.documentElement.scrollWidth > innerWidth + 2 || [...document.querySelectorAll('.studio-view')].some(n=>n.scrollWidth>n.clientWidth+2)"), false, 'No sideways scroll');
    const labels = async () => assert.deepEqual(await js(`(() => {
      return [...document.querySelectorAll('.studio-view button,.studio-view input,.studio-view textarea,.studio-view select')].filter(n => {
        if(n.getAttribute('aria-label') || n.textContent.trim() || n.labels?.length) return false;
        return true;
      }).map(n=>n.outerHTML);
    })()`), [], 'Every control has a label');
    // Real input through DevTools: an offscreen window does not get native mouse or keyboard input reliably.
    const debug = win.webContents.debugger;
    const devtools = async () => { if (!debug.isAttached()) debug.attach('1.3'); await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); };
    const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
    const KEYS = { ' ': ['Space', 32], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40],
      Home: ['Home', 36], End: ['End', 35], Delete: ['Delete', 46], Backspace: ['Backspace', 8], Escape: ['Escape', 27], '=': ['Equal', 187], '-': ['Minus', 189], '\\': ['Backslash', 220], '?': ['Slash', 191] };
    const press = async (key, ...mods) => {
      const [code, vk] = KEYS[key] || ['Key' + key.toUpperCase(), key.toUpperCase().charCodeAt(0)];
      const modifiers = mods.reduce((n, m) => n | MODS[m], 0), text = key.length === 1 && !(modifiers & 7) ? key : undefined;
      await debug.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
      await debug.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
      await pause(80);
    };
    const mouse = (type, x, y, modifiers = 0) => debug.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers });
    const drag = async (from, to, modifiers = 0) => {
      await mouse('mouseMoved', from.x, from.y); await mouse('mousePressed', from.x, from.y, modifiers);
      for (let i = 1; i <= 8; i++) { await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8, button: 'left', buttons: 1, modifiers }); await pause(16); }
      await mouse('mouseReleased', to.x, to.y, modifiers); await pause(120);
    };
    const tap = async point => { await mouse('mouseMoved', point.x, point.y); await mouse('mousePressed', point.x, point.y); await mouse('mouseReleased', point.x, point.y); await pause(120); };
    // Any Content-Security-Policy refusal on the page is a failure (the import map must run under the real policy).
    win.webContents.on('did-finish-load', () => { js("window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI))").catch(() => {}); });
    const box = async selector => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    const saved = () => wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    const playhead = async () => Number(await js("document.querySelector('.ste-playhead').getAttribute('aria-valuenow')"));
    const zoomNow = async () => js("(() => { const c = document.querySelector('.ste-clip'); return c.getBoundingClientRect().width + 1; })()");
    const tab = async name => { await js(`document.querySelector('.ste-tab[data-tab=${name}]').click()`); await pause(120); };
    const blur = () => js("document.activeElement?.blur(); document.body.focus()");
    const timeX = async t => { const content = await box('.ste-tl-content'), pps = await js("(() => { const c = document.querySelectorAll('.ste-clip')[1]; return parseFloat(c.style.left) / 2; })()"); return content.x + t * pps; };

    await win.loadURL(base + '/#/studio');
    await wait("!!document.querySelector('.studio-grid .studio-project')");
    await js("addEventListener('unhandledrejection', e => console.error('unhandled: ' + (e.reason?.stack || e.reason))); addEventListener('error', e => console.error('error: ' + e.message))");
    await js("document.getElementById('onboarding-overlay')?.classList.add('hidden')");
    assert.ok(await js("document.querySelector('.studio-banner').textContent.includes('Kairos never installs')"));
    await wait("!!document.querySelector('.studio-thumbnail')?.width");
    await capture('desktop-projects'); await noOverflow(); await labels();
    win.setContentSize(390, 1000); await pause(350); await noOverflow(); await labels(); await capture('phone-projects');
    win.setContentSize(1440, 1000); await pause(350);
    await js("document.querySelector('.studio-project button').click()");
    await wait("!!document.querySelector('.studio-stage canvas') && document.querySelectorAll('.ste-clip').length===3");
    await devtools();
    assert.equal(await js('location.hash'), '#/studio/' + id);
    assert.equal(await js(`(() => { const c=document.querySelector('.studio-stage canvas'), pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data; return pixels.some((v,i)=>i%4===3 && v>0) && new Set(pixels).size>8; })()`), true, 'Preview draws real content');
    // The docked layout: beats and assets, the preview, the inspector, the timeline under them.
    assert.deepEqual(await js("['.ste-left','.ste-centre','.ste-right','.ste-timeline'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 150 && r.height > 120; })"), [true, true, true, true], 'Four docked panes');
    assert.ok(await js("document.querySelector('.ste-left').getBoundingClientRect().right <= document.querySelector('.ste-centre').getBoundingClientRect().left && document.querySelector('.ste-centre').getBoundingClientRect().bottom <= document.querySelector('.ste-timeline').getBoundingClientRect().top"), 'Beats left of the preview, timeline below');
    assert.equal(await js("document.querySelectorAll('.ste-guide[data-guide=copy]').length"), 1, 'Copy safe area guide over the preview');
    assert.equal(await js("!!document.querySelector('[aria-label=\"Scene as JSON\"]')"), false, 'No raw JSON editing');
    // A title beat shows only the fields it draws (click-through 2026-11-05: every field showed on every beat).
    const shown = label => js(`!document.querySelector('[aria-label=${JSON.stringify(label)}]').closest('[hidden]')`);
    assert.deepEqual([await shown('Text'), await shown('Supporting text'), await shown('Number'), await shown('List items, one per line'), await shown('Video image'), await shown('Upload an image')],
      [true, true, false, false, false, false], 'Title beat fields');
    await js("document.querySelector('[aria-label=\"Beat kind\"]').value='list'; document.querySelector('[aria-label=\"Beat kind\"]').dispatchEvent(new Event('change',{bubbles:true}))");
    await wait("!document.querySelector('[aria-label=\"List items, one per line\"]').closest('[hidden]')");
    assert.equal(await shown('Supporting text'), false, 'A list has no supporting text');
    await js("document.querySelector('[aria-label=\"Beat kind\"]').value='title'; document.querySelector('[aria-label=\"Beat kind\"]').dispatchEvent(new Event('change',{bubbles:true}))");
    await wait("!!document.querySelector('[aria-label=\"List items, one per line\"]').closest('[hidden]')");
    await edit('Text', 'Changed opening');
    await saved();
    assert.ok(writes.some(w => w.method === 'PUT' && w.body.beats[0].text === 'Changed opening'));
    assert.ok(await js("document.querySelector('.ste-clip').textContent.includes('Changed opening')"), 'The clip shows the edit');
    await edit('Text', 'invalid fixture');
    await wait("document.querySelector('[data-error-path=\"beats[0].text\"]').textContent.includes('shorten')");
    await edit('Text', 'Valid opening');
    await saved();
    await edit('Video title', '');
    await wait("document.querySelector('[data-error-path=title]').textContent.includes('must not be empty')");
    await edit('Video title', 'Spring season');
    await saved();
    await js("document.querySelector('[aria-label=\"Move beat 1 down\"]').click()");
    await wait("document.querySelector('.studio-beat button').textContent.includes('Every kid plays')");
    await saved();
    assert.equal(project.beats[1].text, 'Valid opening');
    await click('Undo');
    await wait("document.querySelector('.studio-beat button').textContent.includes('Valid opening')");
    await saved();

    // Timeline: clips sized by length, zoom by button and key, fit.
    const sizes = await js("[...document.querySelectorAll('.ste-clip')].map(c => Math.round(c.getBoundingClientRect().width))");
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, 'Three one-bar beats are the same length: ' + sizes);
    const fitWidth = await zoomNow();
    await click('+'); assert.ok(Math.abs(await zoomNow() / fitWidth - 1.5) < .02, 'Zoom in button');
    await blur(); await press('='); assert.ok(Math.abs(await zoomNow() / fitWidth - 2.25) < .03, 'Zoom in key');
    await press('-'); await press('\\');
    assert.ok(Math.abs(await zoomNow() - fitWidth) < 2, 'Fit returns to the whole video');
    assert.ok(await js("document.querySelector('.ste-tl-content').getBoundingClientRect().width - 120 <= document.querySelector('.ste-tl-scroll').clientWidth"), 'Fit shows it all');
    // Playhead drag on the ruler, with snapping to a beat edge; Shift turns snapping off.
    const ruler = await box('.ste-lane.ste-ruler');
    await drag({ x: await timeX(0), y: ruler.cy }, { x: await timeX(3), y: ruler.cy });
    assert.ok(Math.abs(await playhead() - 3) < .05, 'Playhead dragged to 3 s: ' + await playhead());
    assert.ok((await js("document.querySelector('.ste-clock').textContent")).startsWith('00:03'), 'Timecode follows the playhead');
    const pps = (await timeX(1)) - (await timeX(0));
    await drag({ x: await timeX(3), y: ruler.cy }, { x: (await timeX(2)) + 5, y: ruler.cy });
    assert.equal(await playhead(), 2, 'Snapped to the beat edge');
    await drag({ x: await timeX(2), y: ruler.cy }, { x: (await timeX(2)) + 5, y: ruler.cy }, MODS.shift);
    assert.ok(Math.abs(await playhead() - (2 + 5 / pps)) < .02, 'Shift drags without snapping');
    // Selection: a click selects the clip and opens it in the inspector.
    await tap({ x: (await box('.ste-clip[data-index="1"]')).cx, y: (await box('.ste-clip[data-index="1"]')).cy });
    assert.equal(await js("document.querySelector('.ste-clip.selected').dataset.index"), '1');
    assert.equal(await js("document.querySelector('.ste-inspector-head h3').textContent"), 'Beat 2 of 3');
    assert.equal(await js("document.querySelector('[aria-label=\"Text\"]').value"), 'Every kid plays');
    assert.ok(await js("document.querySelector('.studio-beat[data-index=\"1\"]').classList.contains('selected')"), 'The beat list follows');
    // Drag a clip to reorder: the first beat to the end.
    const first = await box('.ste-clip[data-index="0"]'), last = await box('.ste-clip[data-index="2"]');
    await drag({ x: first.cx, y: first.cy }, { x: last.x + last.w * .8, y: last.cy });
    await saved();
    assert.deepEqual(project.beats.map(b => b.id), ['message', 'end', 'title'], 'Dragged to the end');
    assert.equal(await js("document.querySelector('.ste-clip.selected').dataset.index"), '2', 'The moved beat stays selected');
    // Drag a clip's right edge: bars in half steps, with the length shown while dragging.
    const second = await box('.ste-clip[data-index="1"]');
    await mouse('mouseMoved', second.x + second.w - 2, second.cy); await mouse('mousePressed', second.x + second.w - 2, second.cy);
    for (let i = 1; i <= 6; i++) { await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: second.x + second.w - 2 + pps * i / 6, y: second.cy, button: 'left', buttons: 1 }); await pause(16); }
    assert.ok((await js("document.querySelector('.ste-tip').textContent")).includes('1.5 bars'), 'Trim shows its length');
    await mouse('mouseReleased', second.x + second.w - 2 + pps, second.cy); await pause(120);
    await saved();
    assert.equal(project.beats[1].bars, 1.5, 'Trimmed to 1.5 bars');
    assert.ok(Math.abs(((await box('.ste-clip[data-index="1"]')).w + 1) / ((await box('.ste-clip[data-index="0"]')).w + 1) - 1.5) < .03, 'The clip is 1.5 times its one-bar neighbour');
    await capture('desktop-editor'); await noOverflow(); await labels();

    // Keyboard: play and pause, J/K/L, frame steps, beat edges, work area, delete, duplicate, undo and redo.
    await blur(); await tap({ x: (await box('.ste-clip[data-index="0"]')).cx, y: (await box('.ste-clip[data-index="0"]')).cy });
    await press('Home'); assert.equal(await playhead(), 0);
    await press(' '); await pause(300);
    assert.equal(await js("document.querySelector('.ste-play').textContent"), 'Pause', 'Space plays');
    await press(' '); assert.equal(await js("document.querySelector('.ste-play').textContent"), 'Play', 'Space pauses');
    assert.ok(await playhead() > 0, 'It played');
    await press('l'); await press('l'); assert.equal(await js("document.querySelector('.ste-rate').textContent"), '2x', 'L twice is double speed');
    await press('k'); assert.equal(await js("document.querySelector('.ste-play').textContent"), 'Play', 'K stops');
    await press('j'); assert.equal(await js("document.querySelector('.ste-rate').textContent"), '-1x', 'J plays backwards'); await press('k');
    await press('Home'); await press('ArrowRight'); assert.equal(await playhead(), +(1 / 30).toFixed(2));
    await press('ArrowRight', 'shift'); assert.equal(await playhead(), +(11 / 30).toFixed(2), 'Shift steps ten frames');
    await press('ArrowLeft'); assert.equal(await playhead(), +(10 / 30).toFixed(2));
    await press('ArrowDown'); assert.equal(await playhead(), 2, 'Next beat edge');
    await press('i'); await press('ArrowDown'); await press('o');
    assert.ok(await js("!document.querySelector('.ste-workarea').hidden && document.querySelector('.ste-work-text').textContent==='Work area 00:02.00 to 00:05.00'"), 'I and O set the work area');
    await press('ArrowUp'); await press('ArrowUp'); await press(' '); await pause(250); await press(' ');
    assert.ok(await playhead() >= 2, 'Playback starts at the work area');
    await press('x', 'alt'); assert.equal(await js("document.querySelector('.ste-workarea').hidden"), true, 'Alt + X clears it');
    await press('Delete'); await saved();
    assert.equal(project.beats.length, 2, 'Delete removes the selected beat');
    await press('z', 'ctrl'); await saved(); assert.equal(project.beats.length, 3, 'Ctrl + Z undoes');
    await press('z', 'ctrl', 'shift'); await saved(); assert.equal(project.beats.length, 2, 'Ctrl + Shift + Z redoes');
    await press('y', 'ctrl'); await press('z', 'ctrl'); await saved(); assert.equal(project.beats.length, 3);
    await press('d', 'ctrl'); await saved(); assert.equal(project.beats.length, 4, 'Ctrl + D duplicates');
    assert.equal(project.beats[1].text, project.beats[0].text);
    await press('z', 'ctrl'); await saved(); assert.equal(project.beats.length, 3);
    await press('ArrowRight', 'alt'); await saved(); assert.deepEqual(project.beats.map(b => b.id), ['message', 'title', 'end'], 'Alt + Right moves the beat later');
    await press('ArrowLeft', 'alt'); await saved();
    await press('n'); assert.equal(await js("document.querySelector('[aria-label=\"Snapping (N)\"]').getAttribute('aria-pressed')"), 'false', 'N turns snapping off');
    await press('n');
    await press('g'); assert.equal(await js("document.querySelector('.ste-guides').hidden"), true, 'G hides the guides'); await press('g');
    await press('?', 'shift'); assert.equal(await js("document.querySelector('.ste-sheet').open"), true, '? opens the shortcuts');
    assert.ok(await js("document.querySelector('.ste-sheet').textContent.includes('Set the start or end of the work area')"));
    await capture('desktop-shortcuts');
    await press('Escape'); assert.equal(await js("document.querySelector('.ste-sheet').open"), false);
    // Keys typed into a field stay in the field.
    const before = await playhead();
    await js("document.querySelector('[aria-label=\"Text\"]').focus()");
    await press('Home'); await press('ArrowRight'); await press('End'); await pause(100);
    assert.equal(await playhead(), before, 'Keys typed in a field are not shortcuts');
    assert.equal(project.beats.length, 3);
    await blur();

    // Aspect, playback button, render queue and downloads (Render tab), history (History tab).
    await js("document.querySelector('[aria-label=\"Preview aspect\"]').value='9:16'; document.querySelector('[aria-label=\"Preview aspect\"]').dispatchEvent(new Event('change'))");
    await wait("document.querySelector('.studio-stage canvas')?.height===1920");
    assert.ok(await js("(() => { const f = document.querySelector('.ste-frame').getBoundingClientRect(); return Math.abs(f.width / f.height - 9 / 16) < .02; })()"), 'The preview keeps its aspect');
    await tab('render');
    await click('Render 16:9');
    await wait("document.querySelector('.studio-job')?.textContent.includes('rendering')");
    await wait("document.querySelector('.studio-job')?.textContent.includes('encoding')");
    await wait("!!document.querySelector('.studio-download video')");
    assert.equal(await js("document.querySelectorAll('.studio-download a[download]').length"), 3);
    assert.ok(await js("document.querySelector('.studio-job').textContent.includes('end card stays still')"));
    await capture('desktop-render');
    await tab('history');
    await wait("[...document.querySelectorAll('.studio-view button')].some(n=>n.textContent.startsWith('Restore version'))");
    await js("[...document.querySelectorAll('.studio-view button')].find(n=>n.textContent.startsWith('Restore version')).click()");
    await wait("!!document.querySelector('.confirm-panel')");
    await js("[...document.querySelectorAll('.confirm-panel button')].find(n=>n.textContent==='Cancel').click()");
    assert.equal(writes.filter(w => w.path.includes('/restore/')).length, 0, 'Restore requires confirmation');
    await tab('project');

    // Pane sizes are remembered per person: drag the beats pane wider, reload, it stays.
    const split = await box('.ste-split-left'), leftBefore = (await box('.ste-left')).w;
    await drag({ x: split.cx, y: split.cy }, { x: split.cx + 60, y: split.cy });
    assert.ok(Math.abs((await box('.ste-left')).w - leftBefore - 60) < 3, 'The beats pane widened');
    const stored = JSON.parse(await js("localStorage.getItem('kairos:studio-editor:v1:Alex')"));
    assert.equal(stored.left, Math.round(leftBefore + 60)); assert.equal(stored.rightTab, 'project');
    await js(`(async()=>{ const m=await import('/static/js/chatContent.js'); const body=document.createElement('div'); body.id='studio-chat-test'; document.querySelector('.studio-view').prepend(body); m.renderMessageBody(body,'[Video: Spring season](/videos/${id})','s1'); })()`);
    await wait("document.querySelector('.video-card-link button')?.textContent==='Open in Studio'");
    await js("document.querySelector('.video-card-link button').click()");
    await wait("!!document.querySelector('.studio-stage canvas')");
    // Jobs and downloads recover after the view has been torn down and mounted again.
    await wait("!!document.querySelector('.studio-download video')");
    await win.loadURL(base + '/?reload=1#/studio/' + id); await wait("!!document.querySelector('.studio-stage canvas') && !!document.querySelector('.ste-left')");
    assert.ok(Math.abs((await box('.ste-left')).w - (leftBefore + 60)) < 3, 'Width remembered after a reload');
    assert.equal(await js("document.querySelector('.ste-tab[data-tab=project]').getAttribute('aria-selected')"), 'true', 'Inspector tab remembered');
    await js("localStorage.removeItem('kairos:studio-editor:v1:Alex')");
    await tab('beat');

    // Both themes: the editor uses only working tokens, so a dark base re-derives it.
    await capture('desktop-light');
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: '#1f1b18' }))"); await pause(400);
    assert.notEqual(await js("getComputedStyle(document.querySelector('.ste-pane')).backgroundColor"), 'rgb(251, 246, 238)', 'Dark base reaches the panes');
    await capture('desktop-dark'); await labels();
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'default' }))"); await pause(300);
    // 2026-11-10: the colour base round trip leaves an animated background effect saved in Appearance, and with it
    // running this offscreen window's captures show every 2D canvas blank, though the pixels are right (checked) and
    // no context is lost. Clear the test profile's appearance and reload so the captures below show what a person sees.
    await js("localStorage.removeItem('jarvis:appearance:v1:Alex')");
    await win.loadURL(base + '/?theme=1#/studio/' + id); await wait("!!document.querySelector('.studio-stage canvas') && !!document.querySelector('.ste-clip')"); await devtools();

    // Phone: the same parts stacked, no splitters, 44px targets, nothing sideways.
    for (const width of [390, 1440]) {
      win.setContentSize(width, 1000); await pause(400); await noOverflow(); await labels();
      await capture(width === 390 ? 'phone-editor' : 'desktop-ready');
      // The preview's own pixels beside the window capture (offscreen captures have shown it blank late in a run).
      fs.writeFileSync(path.join(output, (width === 390 ? 'phone-editor' : 'desktop-ready') + '-canvas.png'),
        Buffer.from((await js("document.querySelector('.studio-stage canvas').toDataURL('image/png')")).split(',')[1], 'base64'));
      if (width === 390) {
        assert.deepEqual(await js("[...document.querySelectorAll('.studio-view button,.studio-view select,.studio-view input:not([type=checkbox]),.studio-view summary')].filter(n=>n.getBoundingClientRect().height>0 && n.getBoundingClientRect().height<43).map(n=>n.outerHTML.slice(0, 120))"), [], 'Phone targets are at least 44px');
        assert.equal(await js("[...document.querySelectorAll('.ste-split')].every(n => getComputedStyle(n).display === 'none')"), true, 'No splitters on a phone');
        assert.ok(await js("(() => { const c = document.querySelector('.ste-centre').getBoundingClientRect(), t = document.querySelector('.ste-timeline').getBoundingClientRect(), r = document.querySelector('.ste-right').getBoundingClientRect(); return c.bottom <= t.top && t.bottom <= r.top && Math.abs(c.width - t.width) < 2; })()"), 'Preview, timeline and inspector stacked');
        assert.equal(await js("getComputedStyle(document.querySelector('.studio-view > .view-header')).display"), 'none', 'The page header stays hidden while editing');
        assert.equal(await js(`(() => { const c=document.querySelector('.studio-stage canvas'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; return new Set(d).size > 8; })()`), true, 'The phone preview draws');
        await js("document.querySelector('.ste-clip[data-index=\"1\"]').scrollIntoView({ block: 'center', inline: 'center' })"); await pause(200);
        await tap({ x: (await box('.ste-clip[data-index="1"]')).cx, y: (await box('.ste-clip[data-index="1"]')).cy });
        assert.equal(await js("document.querySelector('.ste-inspector-head h3').textContent"), 'Beat 2 of 3', 'A tap selects on a phone');
        await js("scrollTo(0, 0); document.querySelector('.studio-view')?.closest('[class*=view], main')?.scrollTo?.(0, 0)");
      }
    }

    // A scene beat: the inspector form edits cast, setting, shot, props and camera, and undo takes it back.
    await win.loadURL(base + '/#/studio/' + sceneId); await wait("!!document.querySelector('.studio-stage canvas') && !!document.querySelector('[data-scene-form]')");
    await devtools();
    await wait("!!document.querySelector('.ste-wave[data-wave=peaks]')");
    // Pack B's 3D shots preview live: the app page maps three.js with its hashed import map under the real policy.
    assert.equal(await js("document.querySelector('script[type=importmap]')?.textContent"), '{"imports":{"three":"/static/vendor/three/three.module.js"}}');
    assert.equal(await js("document.querySelector('.ste-preview-note').textContent"), '', 'No stand-in note: the 3D shots draw in three.js');
    assert.deepEqual(await js('window.__csp || []'), [], 'Nothing refused by the page policy');
    assert.equal(await js("document.querySelectorAll('.ste-bed').length"), 3, 'A music lane under every beat');
    assert.equal(await js("document.querySelectorAll('.ste-guide[data-guide=captions]').length"), 1, 'A narrated video shows its caption band');
    assert.ok(await js("document.querySelector('.ste-clip.narrated').getAttribute('aria-label').includes('Length set by its narration') && !document.querySelector('.ste-clip.narrated .ste-trim')"), 'A narrated beat is not trimmed by hand');
    // Step 7: word captions. The style is a project choice; narrating finds the word times, and the preview lights the word.
    await tab('project');
    await wait("!!document.querySelector('[aria-label=\"Caption style\"]')");
    await js("(() => { const s = document.querySelector('[aria-label=\"Caption style\"]'); s.value = 'box'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.equal(writes.filter(w => w.path === `/api/videos/${sceneId}` && w.method === 'PUT').at(-1).body.narration.caption_style, 'box', 'The caption style is saved on the narration');
    await click('Narrate and align words');
    await wait("document.querySelector('[data-caption-status]')?.textContent.startsWith('1 of 1 lines have word times')");
    await js("document.querySelector('[data-group=captions]').scrollIntoView({ block: 'center' })");
    // The preview lights the word being said: at 1.0 s, the fourth word ("a clear day" fixture times).
    await blur(); await press('Home'); for (let i = 0; i < 30; i++) await press('ArrowRight');
    await pause(300); await capture('desktop-captions');
    await tab('beat');
    await wait("document.querySelector('.ste-member strong')?.textContent === '1. Pip'");
    const sceneEdit = async (label, value) => js(`(() => { const n=document.querySelector('[aria-label=${JSON.stringify(label)}]'); if (n.type === 'checkbox') n.checked = value; else n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event(n.tagName === 'SELECT' || n.type === 'checkbox' ? 'change' : 'input', { bubbles: true })); })()`);
    const lastScene = () => writes.filter(w => w.path === `/api/videos/${sceneId}` && w.method === 'PUT').at(-1)?.body.beats[0].scene;
    await sceneEdit('Setting', 'lab'); await sceneEdit('Shot', 'close'); await sceneEdit('Expression of character 1', 'happy'); await sceneEdit('Action of character 1', 'wave');
    await js("document.querySelector('[aria-label=\"Character 1 speaks the narration\"]').click()");
    await sceneEdit('Position of character 1', '0.3');
    await js("[...document.querySelectorAll('[data-scene-form] button')].find(b => b.textContent === 'Add a prop').click()"); await pause(100);
    await sceneEdit('Prop 1', 'atom'); await sceneEdit('Prop 1 size', '0.2');
    await sceneEdit('Camera', 'push');
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.deepEqual(lastScene(), { setting: 'lab', shot: 'close', cast: [{ character: pipId, x: .3, view: 'front', expression: 'happy', action: 'wave', facing: 'right', speaking: true }],
      props: [{ icon: 'atom', x: .5, y: .3, size: .2, float: false }] }, 'The form writes the schema');
    assert.equal(sceneProject.beats[0].camera, 'push');
    await capture('desktop-scene');
    await blur(); for (let n = 0; n < 4; n++) await press('z', 'ctrl');
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.equal(sceneProject.beats[0].camera, undefined, 'Undo takes back the camera');
    assert.equal(lastScene().props.length, 0, 'and the prop');
    assert.equal(await js("document.querySelector('[aria-label=\"Setting\"]').value"), 'lab', 'Earlier edits stay');
    await press('z', 'shift', 'ctrl'); await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.equal(lastScene().props.length, 1, 'Redo brings the prop back');
    // The project's cast: the account's characters, each pinned to a version.
    await tab('project');
    await wait("!!document.querySelector('[aria-label=\"Add a character to the cast\"] option[value=bbbbbbbbbbbb]')");
    assert.equal(await js("document.querySelector('[aria-label=\"Remove Pip from the cast\"]').disabled"), true, 'A cast member a scene shows cannot be removed');
    await sceneEdit('Add a character to the cast', 'bbbbbbbbbbbb');
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.deepEqual(sceneProject.cast, [{ character: pipId, version: 1 }, { character: 'cccccccccccc', version: 1 }, { character: 'bbbbbbbbbbbb', version: 1 }]);
    assert.ok(await js("document.querySelector('[data-group=renderer]').textContent.includes('Blender (not installed)')"), 'The 3D renderer choice says Blender is not installed');
    await tab('beat');
    await js("[...document.querySelectorAll('[data-scene-form] button')].find(b => b.textContent === 'Add a character').click()"); await pause(150);
    assert.equal(await js("document.querySelectorAll('[data-member]').length"), 2, 'The new cast member can join the scene');
    assert.equal(await js("[...document.querySelectorAll('[data-scene-form] select')].filter(n => (n.getAttribute('aria-label') || '').startsWith('Character ')).some(n => [...n.options].some(o => o.value === 'cccccccccccc'))"), false, 'A scene offers no 3D character');
    // A Pack B stage beat: its own form (set, shot, 3D cast, people, props, labels), no raw JSON.
    await js("document.querySelector('.ste-clip[data-index=\"2\"]').click()"); await wait("!!document.querySelector('[data-stage-form]')");
    assert.equal(await js("!!document.querySelector('[aria-label=\"Stage as JSON\"]')"), false, 'No raw JSON for stage beats');
    await wait("document.querySelector('[data-stage-member] strong')?.textContent === '1. Pip 3D'");
    const lastStage = () => writes.filter(w => w.path === `/api/videos/${sceneId}` && w.method === 'PUT').at(-1)?.body.beats[2].stage;
    await sceneEdit('Stage set', 'night'); await sceneEdit('Stage shot', 'close'); await sceneEdit('Facing of 3D character 1', 'left');
    await js("document.querySelector('[aria-label=\"3D character 1 reacts\"]').click()"); await pause(100);
    await sceneEdit('When 3D character 1 reacts, seconds into the shot', '1.5');
    await sceneEdit('Stand-in people', '2');
    await js("[...document.querySelectorAll('[data-stage-form] button')].find(b => b.textContent === 'Add a 3D prop').click()"); await pause(100);
    await sceneEdit('Colour of 3D prop 1', '2');
    await js("[...document.querySelectorAll('[data-stage-form] button')].find(b => b.textContent === 'Add a label').click()"); await pause(100);
    await sceneEdit('Label 1 floats over', 'p1'); await sceneEdit('Label 1 text', '5 h 40 m'); await sceneEdit('Label 1 line under it', 'slept last night');
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.deepEqual(lastStage(), { set: 'night', shot: 'close', pedestal: false,
      cast: [{ character: 'cccccccccccc', x: 0, expression: 'neutral', action: 'idle', facing: 'left', speaking: false, react: { at: 1.5, expression: 'surprised' } }],
      people: { count: 2, seed: 0 }, props: [{ shape: 'ball', x: -.7, depth: .5, size: .4, color: 2 }], labels: [{ over: 'p1', text: '5 h 40 m', sub: 'slept last night', at: 0 }] }, 'The stage form writes the schema');
    await sceneEdit('Stand-in people', '1'); await pause(100);
    await wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
    assert.equal(lastStage().labels.length, 0, 'A label over a person who left goes too');
    // The stage shot draws in 3D in the preview: its frame has the lavender set and shading, not a flat stand-in card.
    await js("document.querySelector('.ste-clip[data-index=\"2\"]').click()"); await pause(600);
    const stagePixels = await js(`(() => { const c = document.querySelector('.studio-stage canvas'), g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data, seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 997) seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)); return seen.size; })()`);
    assert.ok(stagePixels > 30, 'The 3D shot has shading in the preview (' + stagePixels + ' colours sampled)');
    fs.writeFileSync(path.join(output, 'desktop-stage-canvas.png'), Buffer.from((await js("document.querySelector('.studio-stage canvas').toDataURL('image/png')")).split(',')[1], 'base64'));
    await capture('desktop-stage');
    await noOverflow(); await labels();
    win.setContentSize(390, 1000); await pause(400); await noOverflow(); await labels(); await capture('phone-stage');
    win.setContentSize(1440, 1000); await pause(300);
    await js("document.querySelector('.ste-clip[data-index=\"0\"]').click()"); await wait("!!document.querySelector('[data-scene-form]')");
    await noOverflow(); await labels();
    win.setContentSize(390, 1000); await pause(400); await noOverflow(); await labels(); await capture('phone-scene');
    win.setContentSize(1440, 1000); await pause(300);

    // Polish for 2.3.0: Pack C's voxel beat and Pack C classic's story beat have their own forms, edited here with real
    // DevTools mouse and keyboard input. Opening them changes nothing; every edit writes exactly the schema.
    {
      const label = text => `[aria-label=${JSON.stringify(text)}]`;
      const focusOn = async text => js(`(() => { const n = document.querySelector(${JSON.stringify(label(text))}); n.scrollIntoView({ block: 'center' }); n.focus(); return document.activeElement === n; })()`);
      const realClick = async selector => { await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`); await pause(60); const b = await box(selector); await tap({ x: b.cx, y: b.cy }); };
      // A select picked with the arrow keys (a closed select on Windows changes its value and fires change on each key).
      const choose = async (text, value) => {
        for (let n = 0; n < 40; n++) {
          const [now, target] = await js(`(() => { const s = document.querySelector(${JSON.stringify(label(text))}); return [s.selectedIndex, [...s.options].findIndex(o => o.value === ${JSON.stringify(value)})]; })()`);
          assert.ok(target >= 0, `${text} offers ${value}`);
          if (now === target) return;
          assert.ok(await focusOn(text), `${text} takes focus`);
          await press(target > now ? 'ArrowDown' : 'ArrowUp'); await pause(40);
        }
        throw Error(`Could not choose ${value} in ${text}`);
      };
      const clickButton = async (scope, text) => { await js(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b => b.textContent === ${JSON.stringify(text)}).dataset.hit = '1'`); await realClick('[data-hit="1"]'); await js(`document.querySelector('[data-hit]')?.removeAttribute('data-hit')`); };
      const typeInto = async (text, value) => {
        await realClick(label(text)); await press('a', 'ctrl'); await press('Backspace');
        if (value) await debug.sendCommand('Input.insertText', { text: value });
        await pause(80);
      };
      const nudge = async (text, key, times) => { assert.ok(await focusOn(text)); for (let n = 0; n < times; n++) await press(key); };
      const voxSaved = () => wait("document.querySelector('.studio-editor-top [role=status]').textContent==='Saved'");
      const voxPuts = () => writes.filter(w => w.path === `/api/videos/${voxId}` && w.method === 'PUT');
      const lastVox = () => voxPuts().at(-1)?.body;
      const pickBeat = async index => { await realClick(`.ste-clip[data-index="${index}"]`); await pause(250); };
      await win.loadURL(base + '/#/studio/' + voxId); await wait("!!document.querySelector('.studio-stage canvas') && !!document.querySelector('[data-voxel-form]')");
      await devtools(); await blur();
      await wait("document.querySelector('[data-voxel-member] strong')?.textContent === '1. Pip Block'");
      assert.equal(await js("!!document.querySelector('[aria-label=\"Blocky world as JSON\"], [aria-label=\"Story shot as JSON\"]')"), false, 'No raw JSON for voxel or story beats');
      // Round trip: opening each beat in its form writes nothing.
      await pickBeat(1); await wait("!!document.querySelector('[data-story-form]')");
      await wait("document.querySelector('[data-story-member] strong')?.textContent === '1. Rook'");
      await pickBeat(2); await wait("document.querySelector('[data-story-member] strong')?.textContent === '1. Fenn'");
      assert.ok(await js("!!document.querySelector('[aria-label=\"Hold without a line\"]') && !document.querySelector('[aria-label=\"Speaker\"]')"), 'A held story shot shows its hold, not a speaker');
      await pickBeat(0); await wait("!!document.querySelector('[data-voxel-form]')"); await pause(1200);
      assert.equal(voxPuts().length, 0, 'Opening the voxel and story beats in their forms changes nothing');
      assert.deepEqual(voxProject, voxOriginal, 'The video is exactly as stored');
      // The pickers offer only the characters each look casts.
      const pickerIds = text => js(`[...document.querySelector(${JSON.stringify(label(text))}).options].map(o => o.value)`);
      assert.deepEqual(await pickerIds('Blocky character 1'), [blockPip], 'A pastel voxel beat casts blocky characters only');

      // The voxel form, by real input.
      await choose('Voxel world', 'village'); await choose('Voxel time of day', 'night');
      await typeInto('World variation', '42');
      await choose('Expression of blocky character 1', 'surprised');
      await realClick(label('Blocky character 1 speaks the narration'));
      await nudge('Position of blocky character 1', 'ArrowRight', 10);
      await choose('Voxel prop 1', 'star');
      await clickButton('[data-voxel-form]', 'Add a voxel prop');
      await wait("document.querySelectorAll('[data-voxel-prop]').length === 2");
      await typeInto('Label 1 text', '4%');
      await voxSaved();
      assert.deepEqual(lastVox().beats[0], { ...voxelBeat, voxel: { world: 'village', time: 'night', shot: 'medium', seed: 42,
        cast: [{ character: blockPip, x: -.1, expression: 'surprised', action: 'wave', facing: 'camera', speaking: true }], people: { count: 1, seed: 3 },
        props: [{ kind: 'star', x: .6, depth: .4 }, { kind: 'lantern', x: .7, depth: .5 }], labels: [{ over: 'c0', text: '4%', sub: 'salt', at: .5 }] } }, 'The voxel form writes the schema');
      assert.deepEqual(lastVox().beats.slice(1), storyBeats, 'and leaves the story beats alone');
      // The classic look casts block characters (stored as look: classic); back to pastel drops the field again.
      await choose('Voxel look', 'classic'); await voxSaved();
      assert.equal(lastVox().beats[0].voxel.look, 'classic');
      assert.deepEqual(await pickerIds('Blocky character 1'), [blockPip, rookId, fennId], 'The classic look offers block characters');
      await capture('desktop-voxel'); await noOverflow(); await labels();
      for (const [sel, name] of [['[data-voxel-member]', 'desktop-voxel-cast'], ['[data-voxel-prop]', 'desktop-voxel-props']]) { await js(`document.querySelector('${sel}').scrollIntoView({ block: 'start' })`); await capture(name); }
      await choose('Voxel look', 'pastel'); await voxSaved();
      assert.equal('look' in lastVox().beats[0].voxel, false, 'The pastel look is the default and is not stored');

      // The story form, by real input.
      await pickBeat(1); await wait("!!document.querySelector('[data-story-form]')");
      assert.deepEqual(await pickerIds('Story character 1'), [rookId], 'A story beat casts block characters only (the free ones)');
      assert.deepEqual(await pickerIds('Speaker'), [rookId, fennId]);
      assert.equal(await js("document.querySelector('[aria-label=\"Story character 1 faces\"]').value"), 'angle', 'A face angle shows as an angle');
      assert.equal(await js("document.querySelector('[aria-label=\"Story character 1 face angle\"]').value"), '25');
      assert.equal(await js("document.querySelector('[aria-label=\"Change 1 of story character 1 at, seconds after the word\"]').value"), '0.2', 'A change some seconds after its word');
      await choose('Story place', 'beach');
      await choose('Pose of story character 1', 'flail'); await choose('Mood of story character 2', 'angry');
      await realClick(label('Flashback'));
      await typeInto('Key words', 'edge, help');
      await choose('Shot 2 size', 'top'); await choose('Shot 2 cuts at', 'w5');
      await choose('Effect 1', 'splat'); await choose('Sound 1', 'boom');
      await clickButton('[data-story-form]', 'Add a shot');
      await wait("document.querySelectorAll('[data-story-shot]').length === 3");
      await realClick(label('Add a change to story character 2'));
      await wait("!!document.querySelector('[data-story-change=\"2.1\"]')");
      await choose('Speaker', fennId);
      await typeInto('Gap after the line', '0.5');
      await voxSaved();
      const st = storyBeats[0], s = st.story;
      assert.deepEqual(lastVox().beats[1], { ...st, speaker: fennId, gap: .5, flashback: true, story: { ...s, place: 'beach',
        cast: [{ ...s.cast[0], pose: 'flail' }, { ...s.cast[1], mood: 'angry', changes: [{ at: { word: 0 }, mood: 'shocked' }] }],
        shots: [s.shots[0], { ...s.shots[1], shot: 'top', at: { word: 5 } }, { shot: 'close', on: 1, at: { word: 4 }, push: .3 }],
        fx: [{ ...s.fx[0], kind: 'splat' }], sfx: [{ kind: 'boom', at: { word: 0 } }], keys: ['edge', 'help'] } }, 'The story form writes the schema, keeping what it does not show');
      await capture('desktop-story'); await noOverflow(); await labels();
      for (const [sel, name] of [['[data-story-member]', 'desktop-story-cast'], ['[data-story-member="2"]', 'desktop-story-cast-2'], ['[data-story-shot]', 'desktop-story-shots'], ['[data-story-fx]', 'desktop-story-effects']]) { await js(`document.querySelector('${sel}').scrollIntoView({ block: 'start' })`); await capture(name); }
      win.setContentSize(390, 1000); await pause(400); await noOverflow(); await labels(); await capture('phone-story');
      win.setContentSize(1440, 1000); await pause(300);
      // A held shot given a line gets a speaker (the first block character on it) and loses its hold; clearing the line
      // gives the hold back.
      await pickBeat(2); await wait("!!document.querySelector('[aria-label=\"Hold without a line\"]')");
      await typeInto('Narration (the line spoken over this beat)', 'Back then.');
      await wait("!!document.querySelector('[aria-label=\"Speaker\"]')"); await voxSaved();
      assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Narration (the line spoken over this beat)', 'The line keeps its focus');
      assert.deepEqual((({ say, speaker, hold, gap }) => ({ say, speaker, hold, gap }))(lastVox().beats[2]), { say: 'Back then.', speaker: fennId, hold: undefined, gap: undefined });
      await typeInto('Narration (the line spoken over this beat)', '');
      await wait("!!document.querySelector('[aria-label=\"Hold without a line\"]')"); await voxSaved();
      assert.deepEqual((({ say, speaker, hold, gap }) => ({ say, speaker, hold, gap }))(lastVox().beats[2]), { say: undefined, speaker: undefined, hold: 1.2, gap: undefined });
      await pickBeat(0); await wait("!!document.querySelector('[data-voxel-form]')");
      win.setContentSize(390, 1000); await pause(400); await noOverflow(); await labels(); await capture('phone-voxel');
      win.setContentSize(1440, 1000); await pause(300);
    }

    // Steps 3 and 4: tracks and clips on the timeline, the clip inspector, sounds, then Ask Kairos with comment pins,
    // an applied run with its own undo, and a dry run applied after a look.
    await win.loadURL(base + '/#/studio/' + trackId); await wait("!!document.querySelector('.studio-stage canvas') && document.querySelectorAll('.ste-clip').length===3");
    await devtools(); await blur();
    const lastTracks = () => writes.filter(w => w.path === `/api/videos/${trackId}` && w.method === 'PUT').at(-1)?.body.tracks;
    const tX = async t => { const content = await box('.ste-tl-content'), pps = await js("parseFloat(document.querySelector('.ste-clip[data-index=\"1\"]').style.left) / 4"); return content.x + t * pps; };
    const tpps = (await tX(1)) - (await tX(0));
    const rulerBox = await box('.ste-lane.ste-ruler');
    await tap({ x: await tX(1), y: rulerBox.cy });
    await js("document.querySelector('[aria-label=\"Add a text clip at the playhead\"]').click()"); await pause(150);
    await wait("document.querySelectorAll('.ste-tclip').length===1 && document.querySelectorAll('.ste-lane.ste-olane').length===1");
    assert.equal(await js("document.querySelector('.ste-tab[data-tab=beat]').textContent"), 'Clip', 'The inspector shows the clip');
    assert.equal(await js("document.querySelector('[data-clip-form] h3').textContent"), 'Text clip k1');
    assert.equal(await js("!!document.querySelector('.ste-selbox[data-guide=clip]')"), true, 'The clip is outlined on the preview');
    await edit('Clip text', 'Hello layers'); await saved();
    assert.deepEqual((({ id, kind, start, in: i, out, text }) => ({ id, kind, start: Math.round(start * 10) / 10, in: i, out, text }))(lastTracks()[0].clips[0]), { id: 'k1', kind: 'text', start: 1, in: 0, out: 3, text: 'Hello layers' }, 'A new text clip at the playhead');
    // Drag along the lane (Shift: no snapping), then trim each edge.
    let clipBox = await box('.ste-tclip[data-clip=k1]');
    await drag({ x: clipBox.cx, y: clipBox.cy }, { x: clipBox.cx + tpps, y: clipBox.cy }, MODS.shift); await saved();
    assert.ok(Math.abs(lastTracks()[0].clips[0].start - 2) < .05, 'Dragged one second later');
    clipBox = await box('.ste-tclip[data-clip=k1] .ste-ctrim.right');
    await drag({ x: clipBox.cx, y: clipBox.cy }, { x: clipBox.cx + tpps / 2, y: clipBox.cy }, MODS.shift); await saved();
    assert.ok(Math.abs(lastTracks()[0].clips[0].out - 3.5) < .1, 'Right edge trimmed half a second longer: ' + JSON.stringify(lastTracks()[0].clips[0]));
    clipBox = await box('.ste-tclip[data-clip=k1] .ste-ctrim.left');
    await drag({ x: clipBox.cx, y: clipBox.cy }, { x: clipBox.cx + tpps / 2, y: clipBox.cy }, MODS.shift); await saved();
    let k1 = lastTracks()[0].clips[0];
    assert.ok(Math.abs(k1.start - 2.5) < .1 && Math.abs(k1.in - .5) < .1 && Math.abs(k1.out - 3.5) < .1, 'Left edge trimmed: start and in move together: ' + JSON.stringify(k1));
    // Split at the playhead with S.
    await tap({ x: await tX(3.5), y: rulerBox.cy }); await blur(); await press('s'); await saved();
    const parts = lastTracks()[0].clips;
    assert.deepEqual(parts.map(c => c.id), ['k1', 'k1-1'], 'S splits the clip at the playhead');
    assert.ok(Math.abs(parts[1].start - 3.5) < .02 && Math.abs(parts[0].start + parts[0].out - parts[0].in - 3.5) < .02 && Math.abs(parts[1].in - (3.5 - parts[0].start + parts[0].in)) < .02, 'The halves meet at the playhead');
    // A second overlay track, and a clip dragged onto it.
    await js("(() => { const s = document.querySelector('[aria-label=\"Add a track\"]'); s.value = 'overlay'; s.dispatchEvent(new Event('change', { bubbles: true })); })()"); await saved();
    assert.equal(await js("document.querySelectorAll('.ste-lane.ste-olane').length"), 2, 'Two overlay lanes');
    const lane2 = await box('.ste-lane[data-track=t2]'); clipBox = await box('.ste-tclip[data-clip="k1-1"]');
    await drag({ x: clipBox.cx, y: clipBox.cy }, { x: clipBox.cx, y: lane2.cy }, MODS.shift); await saved();
    assert.deepEqual(lastTracks().map(t => [t.id, t.clips.map(c => c.id)]), [['t1', ['k1']], ['t2', ['k1-1']]], 'Dragged between lanes');
    assert.equal(await js("document.querySelector('.ste-tclip[data-clip=\"k1-1\"]').dataset.track"), 't2');
    // Lock and hide.
    await js("document.querySelector('[aria-label=\"Lock track Overlay 1\"]').click()"); await saved();
    assert.equal(lastTracks()[0].locked, true);
    await js("document.querySelector('.ste-tclip[data-clip=k1]').click()"); await pause(120); await blur(); await press('Delete'); await pause(150);
    assert.equal(await js("!!document.querySelector('.ste-tclip[data-clip=k1]')"), true, 'A locked clip is not deleted');
    assert.equal(await js("document.querySelector('[aria-label=\"Clip text\"]').disabled"), true, 'The inspector is read only on a locked track');
    await js("document.querySelector('[aria-label=\"Lock track Overlay 1\"]').click()"); await saved();
    await js("document.querySelector('[aria-label=\"Hide track Overlay 2\"]').click()"); await saved();
    assert.equal(lastTracks()[1].hidden, true); assert.equal(await js("document.querySelector('.ste-lane[data-track=t2]').classList.contains('off')"), true, 'A hidden lane is shaded');
    await js("document.querySelector('[aria-label=\"Hide track Overlay 2\"]').click()"); await saved();
    // Ripple delete closes the gap on the track; undo brings it back.
    await js("document.querySelector('.ste-tclip[data-clip=k1]').click()"); await pause(120);
    await tap({ x: await tX(5), y: rulerBox.cy });
    await js("document.querySelector('[aria-label=\"Add a text clip at the playhead\"]').click()"); await saved();
    assert.deepEqual(lastTracks()[0].clips.map(c => c.id), ['k1', 'k2'], 'A new clip lands on the selected clip\'s track');
    await js("document.querySelector('[aria-label^=\"Ripple delete\"]').click()"); await pause(100);
    await js("document.querySelector('.ste-tclip[data-clip=k1]').click()"); await pause(120); await blur(); await press('Delete'); await saved();
    const k1Length = 3.5 - parts[0].start;
    assert.ok(lastTracks()[0].clips.length === 1 && Math.abs(lastTracks()[0].clips[0].start - (5 - k1Length)) < .03, 'Ripple delete moved the next clip up by the deleted length');
    await press('z', 'ctrl'); await saved();
    assert.deepEqual(lastTracks()[0].clips.map(c => [c.id, Math.round(c.start * 10) / 10]), [['k1', Math.round(parts[0].start * 10) / 10], ['k2', 5]], 'Undo restores both');
    await js("document.querySelector('[aria-label^=\"Ripple delete\"]').click()"); await pause(100);
    // A sound from the video's own files, and an image over the video.
    await js("document.querySelector('.ste-tab[data-tab=assets]').click()"); await pause(150);
    await tap({ x: await tX(.5), y: rulerBox.cy });
    await js("document.querySelector('[aria-label=\"Add Chime at the playhead\"]').click()"); await saved();
    const audio = lastTracks().find(t => t.kind === 'audio');
    assert.deepEqual((({ kind, audio: a, start, in: i, out }) => ({ kind, audio: a, start: Math.round(start * 10) / 10, in: i, out }))(audio.clips[0]), { kind: 'sound', audio: soundAsset, start: .5, in: 0, out: 2.5 }, 'A sound clip at the playhead');
    assert.equal(await js("document.querySelectorAll('.ste-alane .ste-tclip[data-clip-kind=sound] canvas.ste-swave').length"), 1, 'The sound shows its waveform');
    await js(`document.querySelector('[aria-label="Put image ${imageAsset.slice(7, 19)} over the video at the playhead"]').click()`); await saved();
    assert.ok(lastTracks().some(t => t.clips.some(c => c.kind === 'image' && c.image === imageAsset)), 'An image over the video');
    await js("document.querySelector('.ste-tclip[data-clip=k1]').click()"); await pause(150);
    await tap({ x: await tX(3), y: rulerBox.cy }); await pause(300);
    await capture('desktop-tracks');
    await noOverflow(); await labels();

    // Ask Kairos: a comment pinned on the preview, a request about the selected clip, the run and its undo.
    await js("document.querySelector('.ste-tab[data-tab=ask]').click()"); await pause(150);
    await blur(); await press('c');
    assert.equal(await js("document.querySelector('.studio-stage').classList.contains('commenting')"), true, 'C turns on comment mode');
    const frameBox = await box('.ste-frame');
    await tap({ x: frameBox.x + frameBox.w * .3, y: frameBox.y + frameBox.h * .2 });
    await wait("!!document.querySelector('.ste-pin-form textarea')");
    await js("(() => { const t = document.querySelector('.ste-pin-form textarea'); t.value = 'Make this warmer'; document.querySelector('.ste-pin-form button[type=submit]').click(); })()");
    await wait("document.querySelectorAll('.ste-comment').length===1 && !!document.querySelector('.ste-pin[data-pin=m1]') && !!document.querySelector('.ste-pinmark[data-pin=m1]')");
    const pinned = writes.filter(w => w.path === `/api/videos/${trackId}/comments`).at(-1).body;
    assert.ok(Math.abs(pinned.x - .3) < .02 && Math.abs(pinned.y - .2) < .02 && Math.abs(pinned.t - 3) < .05, 'The pin keeps its place and moment');
    assert.ok(pinned.under.includes('clip k1'), 'The pin names what is under it: ' + pinned.under);
    await press('Escape');
    assert.equal(await js("document.querySelector('.studio-stage').classList.contains('commenting')"), false, 'Escape leaves comment mode');
    await capture('desktop-comment-pin');
    await js("document.querySelector('.ste-tclip[data-clip=k1]').click()"); await pause(150);
    await edit('Describe a change', 'Make the greeting warmer');
    await js("document.querySelector('[title=\"Ask Kairos to change the video\"]').click()");
    await wait("!!document.querySelector('.ste-run[data-status=applied]')");
    const asked = asks.at(-1);
    assert.equal(asked.request, 'Make the greeting warmer');
    assert.deepEqual(asked.selection.clips, ['k1'], 'Kairos is told the selected clip'); assert.deepEqual(asked.comments, ['m1'], 'and the pinned comment');
    assert.ok(Number.isFinite(asked.selection.time));
    await wait("document.querySelector('.ste-tclip[data-clip=k1] .ste-clip-label').textContent==='Welcome'");
    assert.ok(await js("document.querySelector('.ste-run[data-status=applied]').textContent.includes('Changed clip k1')"), 'The run lists its change in plain words');
    assert.equal(await js("document.querySelectorAll('.ste-comment').length"), 0, 'The comment it addressed is resolved');
    await js("document.querySelector('.ste-run[data-status=applied]').scrollIntoView({ block: 'center' })"); await capture('desktop-ask-kairos');
    await click("Undo Kairos's change");
    await wait("!!document.querySelector('.ste-run[data-status=undone]') && document.querySelector('.ste-tclip[data-clip=k1] .ste-clip-label').textContent==='Hello layers'");
    // A bigger change waits as a dry run until the person applies it.
    await edit('Describe a change', 'Add many short points');
    await js("document.querySelector('[title=\"Ask Kairos to change the video\"]').click()");
    await wait("!!document.querySelector('.ste-pending .ste-run[data-status=pending]')");
    assert.equal(await js("document.querySelectorAll('.ste-pending .ste-change-list li').length"), 6, 'Every proposed change listed before anything is saved');
    await js("document.querySelector('.ste-pending .ste-run').scrollIntoView({ block: 'center' })"); await capture('desktop-dry-run');
    // The person's changes since Kairos's last turn come back with the next review read.
    review.since = { since: 9, changes: [{ item: 'beat:l2', type: 'beat', change: 'changed', words: 'Changed beat l2 (statement "Clips over beats"): text.' }] };
    await click('Apply these changes');
    await wait("!document.querySelector('.ste-pending .ste-run') && document.querySelector('.ste-clip[data-index=\"0\"]').textContent.includes('Six points')");
    await wait("document.querySelector('.ste-since summary').textContent.includes('(1)')");
    assert.ok(await js("document.querySelector('.ste-since').textContent.includes('Changed beat l2')"), 'The person sees their changes since Kairos last turn');
    // Step 5: the track names read whole and rename in place; the clip moves, snaps, nudges, scales and turns on the
    // preview with real DevTools input; keyframes are added with A, made by a drag at another time, dragged on their row,
    // copied, pasted and deleted.
    assert.equal(await js("(() => { const n = document.querySelector('.ste-head-name[data-track-name=t1]'); return n.scrollWidth <= n.clientWidth + 1; })()"), true, 'The track name reads whole');
    await js("document.querySelector('.ste-head-name[data-track-name=t1]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    await wait("!!document.querySelector('.ste-head-rename')");
    await js("(() => { const i = document.querySelector('.ste-head-rename'); i.value = 'Titles and lower thirds'; })()");
    await js("document.querySelector('.ste-head-rename').focus()"); await press('Enter'); await saved();
    assert.equal(lastTracks()[0].name, 'Titles and lower thirds', 'A track renamed in place');
    assert.equal(await js("document.querySelector('[data-track-head=t1]').title"), 'Titles and lower thirds', 'The full name is the head tip');
    await js("document.querySelector('.ste-tclip[data-clip=k2]').click()"); await pause(150);
    await tap({ x: await tX(5.5), y: rulerBox.cy }); await blur(); await pause(200);
    const frameNow = await box('.ste-frame'), pxShare = 1 / frameNow.w;
    const k2At = () => lastTracks()[0].clips.find(c => c.id === 'k2');
    let sel = await box('.ste-selbox[data-clip-box=k2]');
    const before2 = structuredClone(k2At().box);
    await drag({ x: sel.cx, y: sel.cy }, { x: sel.cx - 40, y: sel.cy + 30 }, MODS.alt); await saved();
    assert.ok(Math.abs(k2At().box.x - (before2.x - 40 * pxShare)) < .006 && Math.abs(k2At().box.y - (before2.y + 30 / frameNow.h)) < .006, 'Dragged on the preview: ' + JSON.stringify([before2, k2At().box]));
    // Snapping: dropped a few pixels off the frame's centre line, the clip's centre lands on it and the guide shows while dragging.
    sel = await box('.ste-selbox[data-clip-box=k2]');
    const toCentre = frameNow.x + frameNow.w / 2 + 4;
    await mouse('mouseMoved', sel.cx, sel.cy); await mouse('mousePressed', sel.cx, sel.cy);
    for (let i = 1; i <= 8; i++) { await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sel.cx + (toCentre - sel.cx) * i / 8, y: sel.cy, button: 'left', buttons: 1 }); await pause(16); }
    assert.equal(await js("!!document.querySelector('.ste-snapline.x')"), true, 'A snap guide shows on the centre line');
    await capture('desktop-canvas-snap');
    await mouse('mouseReleased', toCentre, sel.cy); await pause(120); await saved();
    assert.ok(Math.abs(k2At().box.x + k2At().box.w / 2 - .5) < 1e-3, 'Snapped to the centre line: ' + JSON.stringify(k2At().box));
    // Arrow nudges with the box focused: 1 frame pixel, Shift 10.
    const nudged = structuredClone(k2At().box);
    await js("document.querySelector('.ste-selbox[data-clip-box=k2]').focus()");
    await press('ArrowRight'); await press('ArrowDown', 'shift'); await saved();
    assert.ok(Math.abs(k2At().box.x - (nudged.x + 1 / 1920)) < 2e-4 && Math.abs(k2At().box.y - (nudged.y + 10 / 1080)) < 2e-4, 'Nudged 1 px right and 10 px down: ' + JSON.stringify([nudged, k2At().box]));
    assert.ok(Math.abs(await playhead() - 5.5) < .02, 'Arrows on the focused clip box do not move the playhead');
    // Scale from a corner, turn with the knob.
    sel = await box('.ste-selbox[data-clip-box=k2] .ste-handle.corner.se');
    const centre = await box('.ste-selbox[data-clip-box=k2]');
    await drag({ x: sel.cx, y: sel.cy }, { x: centre.cx + (sel.cx - centre.cx) * 1.5, y: centre.cy + (sel.cy - centre.cy) * 1.5 }); await saved();
    assert.ok(Math.abs(k2At().scale - 1.5) < .08, 'Scaled from the corner: ' + k2At().scale);
    sel = await box('.ste-selbox[data-clip-box=k2] .ste-handle.rotate');
    const knob = await box('.ste-selbox[data-clip-box=k2]');
    await drag({ x: sel.cx, y: sel.cy }, { x: knob.cx + (knob.cy - sel.cy), y: knob.cy }, MODS.shift); await saved();
    assert.ok(Math.abs(k2At().rotation - 90) < 1, 'Turned a quarter with Shift: ' + k2At().rotation);
    await capture('desktop-canvas-handles');
    // Keyframes: A at 5.5 s keys every property; a drag at 7 s keys the position there.
    await blur(); await press('a'); await saved();
    assert.deepEqual(Object.keys(k2At().keys).sort(), ['opacity', 'rotation', 'scale', 'x', 'y'], 'A keys every property at the playhead');
    assert.ok(Object.values(k2At().keys).every(list => list.length === 1 && Math.abs(list[0].t - .5) < 1e-3), 'At the clip\'s own time 0.5 s');
    await tap({ x: await tX(7), y: rulerBox.cy }); await blur(); await pause(200);
    sel = await box('.ste-selbox[data-clip-box=k2]');
    await drag({ x: sel.cx, y: sel.cy }, { x: sel.cx - 120, y: sel.cy }, MODS.alt); await saved();
    assert.equal(k2At().keys.x.length, 2, 'Dragging an animated clip at another time adds a keyframe there');
    assert.ok(Math.abs(k2At().keys.x[1].t - 2) < 1e-3 && k2At().keys.x[1].v < k2At().keys.x[0].v, 'The new key holds the new place: ' + JSON.stringify(k2At().keys.x));
    assert.equal(await js("document.querySelectorAll('.ste-klane[data-key-track=t1] .ste-key[data-key-clip=k2]').length"), 2, 'Two keyframe diamonds on the row');
    // The playhead between the keys: the engine draws the clip between its two places (our own interpolation).
    await tap({ x: await tX(6.25), y: rulerBox.cy }); await pause(150);
    const mid = await js("(() => { const b = document.querySelector('.ste-selbox[data-clip-box=k2]'); return parseFloat(b.style.left) / 100; })()");
    assert.ok(mid < k2At().keys.x[0].v && mid > k2At().keys.x[1].v, 'Between the keys the clip is between its places: ' + mid);
    // Drag the second diamond half a second earlier (Shift: no snapping to frames).
    let diamond = await box('.ste-key[data-key-clip=k2][data-key-own="2"]');
    await drag({ x: diamond.cx, y: diamond.cy }, { x: diamond.cx - tpps / 2, y: diamond.cy }, MODS.shift); await saved();
    assert.ok(Math.abs(k2At().keys.x[1].t - 1.5) < .05, 'The keyframe moved half a second earlier: ' + JSON.stringify(k2At().keys.x));
    // Pick it, copy, paste at 7.5 s, then delete the picked pasted keys.
    diamond = await box(`.ste-key[data-key-clip=k2][data-key-own="${k2At().keys.x[1].t}"]`);
    await tap({ x: diamond.cx, y: diamond.cy });
    assert.equal(await js("document.querySelectorAll('.ste-key.picked').length"), 1, 'A click picks the keyframe');
    await blur(); await press('c', 'ctrl');
    await tap({ x: await tX(7.5), y: rulerBox.cy }); await blur(); await press('v', 'ctrl'); await saved();
    assert.equal(k2At().keys.x.length, 3, 'Pasted at the playhead');
    assert.ok(Math.abs(k2At().keys.x[2].t - 2.5) < .02, 'At the clip\'s own time 2.5 s: ' + JSON.stringify(k2At().keys.x));
    await blur(); await press('Delete'); await saved();
    assert.equal(k2At().keys.x.length, 2, 'Delete removes the picked keyframes, not the clip');
    assert.ok(lastTracks()[0].clips.some(c => c.id === 'k2'), 'The clip stays');
    // [ and ] jump between keyframes; the Motion inspector shows the eases and sets one.
    await blur(); await press('[');
    assert.ok(Math.abs(await playhead() - 6.5) < .03, '[ goes to the previous keyframe: ' + await playhead());
    await press('[');
    assert.ok(Math.abs(await playhead() - 5.5) < .03, 'and the one before: ' + await playhead());
    await wait("!!document.querySelector('[aria-label=\"Ease from this keyframe\"]') && !document.querySelector('[aria-label=\"Ease from this keyframe\"]').disabled");
    await js("(() => { const s = document.querySelector('[aria-label=\"Ease from this keyframe\"]'); s.value = 'out'; s.dispatchEvent(new Event('change', { bubbles: true })); })()"); await saved();
    assert.ok(Object.values(k2At().keys).every(list => list[0].ease === 'out'), 'The ease is set on every key at that moment');
    await js("document.querySelector('[data-group=clip-motion]').scrollIntoView({ block: 'center' })"); await capture('desktop-keyframes');
    // Step 7: a video clip from the person's own file, with its sound on an audio track at the same time.
    await tab('assets');
    await tap({ x: await tX(.25), y: rulerBox.cy });
    await js("document.querySelector('[aria-label=\"Add Waves at the playhead\"]').click()"); await saved();
    const vclip = lastTracks().flatMap(t => t.clips).find(c => c.kind === 'video');
    assert.ok(vclip && vclip.video === 'media/' + videoSha && Math.abs(vclip.out - 4) < 1e-6 && vclip.fit === 'cover', 'A video clip at the playhead: ' + JSON.stringify(vclip));
    assert.ok(lastTracks().filter(t => t.kind === 'audio').flatMap(t => t.clips).some(c => c.audio === soundAsset && Math.abs(c.start - vclip.start) < 1e-6 && Math.abs(c.out - c.in - 4) < 1e-6), 'Its sound at the same time');
    await tap({ x: await tX(1), y: rulerBox.cy }); await pause(400);
    const lit = await js(`(() => { const c = document.querySelector('.studio-stage canvas'), g = c.getContext('2d'); const b = ${JSON.stringify(vclip.box)};
      const d = g.getImageData(Math.round((b.x + b.w * .3) * c.width), Math.round((b.y + b.h * .3) * c.height), Math.round(b.w * .4 * c.width), Math.round(b.h * .4 * c.height)).data, seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 31) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3)); return seen.size; })()`);
    assert.ok(lit > 6, 'The video frame draws in the clip box (' + lit + ' colours)');
    await capture('desktop-video-clip');
    // Step 6: the frame rate on the project.
    await tab('project');
    await js("(() => { const s = document.querySelector('[aria-label=\"Frame rate\"]'); s.value = '60'; s.dispatchEvent(new Event('change', { bubbles: true })); })()"); await saved();
    assert.equal(writes.filter(w => w.path === `/api/videos/${trackId}` && w.method === 'PUT').at(-1).body.fps, 60, 'The frame rate is saved');
    await tab('beat');
    await noOverflow(); await labels();
    win.setContentSize(390, 1000); await pause(400); await noOverflow(); await labels(); await capture('phone-tracks');
    fs.writeFileSync(path.join(output, 'phone-tracks-canvas.png'), Buffer.from((await js("document.querySelector('.studio-stage canvas').toDataURL('image/png')")).split(',')[1], 'base64'));
    assert.equal(await js("[...document.querySelectorAll('.ste-track-tool')].every(n => getComputedStyle(n).display === 'none')"), true, 'Track tools stay on desktop (the phone strip shows beats only)');
    assert.equal(await js("[...document.querySelectorAll('.ste-klane, .ste-khead')].every(n => getComputedStyle(n).display === 'none')"), true, 'Keyframe rows stay on desktop too');
    win.setContentSize(1440, 1000); await pause(300);
    assert.deepEqual(await js('window.__csp || []'), [], 'Nothing refused by the page policy');

    // A long video: chapter headings and timeline markers, a render stopped by an app restart with Resume, the plan gate, then progress per chapter.
    await win.loadURL(base + '/#/studio/' + longId); await wait("!!document.querySelector('.studio-stage canvas')");
    assert.equal(await js("document.querySelectorAll('.studio-chapter').length"), 3, 'Chapter headings in the beat list');
    assert.deepEqual(await js("[...document.querySelectorAll('.ste-mark')].map(m => m.textContent)"), ['1. Opening', '2. Phases', '3. Tides'], 'Chapter markers on the timeline');
    assert.equal(await js("document.querySelector('[aria-label=\"Chapter that starts at this beat\"]').value"), 'Opening');
    assert.equal(await js("document.querySelectorAll('.ste-wave[data-wave=spans]').length"), 0, 'Unspoken lines show as not narrated yet');
    await tab('render');
    await wait("document.querySelector('.studio-long-job')?.textContent.includes('Stopped when the app closed')");
    assert.ok(await js("document.querySelector('.studio-plan').dataset.planStatus==='none'"));
    assert.ok(await js("document.querySelector('.studio-disk').textContent.includes('saved chapter parts 12.0 MB')"));
    await click('Resume render');
    await pause(400);
    assert.equal(writes.filter(w => w.path === `/api/videos/${longId}/render`).length, 0, 'No long render before the plan is approved');
    await click('Approve plan');
    await wait("document.querySelector('.studio-plan')?.dataset.planStatus==='approved'");
    await click('Resume render');
    await wait("document.querySelector('.studio-long-job[data-long-status^=rendering]')?.textContent.includes('1 of 3 chapters done')");
    assert.ok(await js("document.querySelector('.studio-long-job').textContent.includes('41.5 frames a second')"));
    assert.equal(await js("document.querySelectorAll('.studio-long-job [data-chapter-state=rendering] progress').length"), 1);
    await capture('long-render');
    await wait("document.querySelector('.studio-long-job')?.dataset.longStatus==='ready'");
    await wait("[...document.querySelectorAll('.studio-download a[download]')].some(a=>a.textContent==='Download chapter list')");
    await noOverflow(); await labels();
    await tab('beat');
    // Step 6: exports. WebM, MOV and a GIF of the work area, made from the MP4 of this version.
    await win.loadURL(base + '/#/studio/' + id); await wait("!!document.querySelector('.studio-stage canvas')");
    await tab('render');
    await wait("!!document.querySelector('[data-group=exports]')");
    await click('Export WebM');
    await wait("[...document.querySelectorAll('.studio-job[data-job-kind=export] a[download]')].some(a => a.textContent === 'Download WEBM')");
    assert.equal(writes.filter(w => w.path === `/api/videos/${id}/render`).at(-1).body.format, 'webm', 'The export asks for WebM');
    const ruler0 = await box('.ste-lane.ste-ruler');
    await blur(); await tap({ x: await timeX(1), y: ruler0.cy }); await blur(); await press('i');
    await tap({ x: await timeX(2.5), y: ruler0.cy }); await blur(); await press('o'); await tab('render');
    await js("[...document.querySelectorAll('[data-group=exports] button')].find(b => b.textContent.startsWith('Export GIF')).click()"); await pause(400);
    const gifAsk = writes.filter(w => w.path === `/api/videos/${id}/render`).at(-1).body;
    assert.equal(gifAsk.format, 'gif', 'The GIF export'); assert.ok(Math.abs(gifAsk.start - 1) < .05 && Math.abs(gifAsk.end - 2.5) < .05, 'of the work area: ' + JSON.stringify(gifAsk));
    await js("document.querySelector('[data-group=exports]').scrollIntoView({ block: 'center' })"); await capture('desktop-exports');
    await tab('beat');
    // Deep-link a fresh shell load.
    await win.loadURL(base + '/#/studio/' + id); await wait("!!document.querySelector('.studio-stage canvas')");
    enabled = false;
    await js(`(async()=>{const m=await import('/static/js/chatContent.js');const b=document.createElement('div');document.querySelector('.studio-view').prepend(b);m.renderMessageBody(b,'[Video: Spring season](/videos/${id})','s1')})()`);
    await wait("document.querySelector('.video-card-link button')?.textContent==='Turn on Studio'");
    await js("document.querySelector('.video-card-link button').click()");
    await wait("document.querySelector('.tool-store-search')?.value==='Studio'");
    assert.ok(await js("[...document.querySelectorAll('.tool-store-filters button')].some(b=>b.textContent==='Tabs'&&b.getAttribute('aria-pressed')==='true')"));
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    console.log(JSON.stringify({ ok: true, output, writes: writes.length, checks: ['projects', 'FFmpeg banner', 'docked panes', 'safe-area guides', 'live canvas', 'edit and PUT', 'inline validation', 'reorder', 'undo',
      'timeline clip sizes', 'zoom button, keys and fit', 'playhead drag', 'snapping and Shift', 'clip selection opens the inspector', 'clip drag reorder', 'edge trim in half bars',
      'Space, J/K/L, frame steps, beat edges, I/O, Alt+X, Delete, Ctrl+D, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Alt+arrows, N, G, ?', 'keys in fields', 'aspect', 'render progress', 'downloads',
      'history confirmation', 'pane persistence per person', 'both themes', 'phone stacked view', 'scene inspector round trip', 'scene undo and redo', 'stage inspector round trip', 'voxel and story forms: unchanged on open, real input, exact schema, line toggles speaker and hold', 'cast picker', 'waveform and music lanes',
      'chat card', 'recovery', 'long video chapters, markers, plan gate and resume', '3D preview under the real policy',
      'tracks: add, drag, trim both edges, split, lanes, lock, hide, ripple, undo, sound, image', 'Ask Kairos: comment pin, run, undo, dry run',
      'step 5: track rename in place, canvas move, snap guide, nudges, scale, turn, keyframes (A, drag, row drag, copy, paste, delete, [ ], ease)',
      'step 6: frame rate, WebM and GIF exports', 'step 7: video clip with its sound, frame drawn, word caption style and narrate', 'deep link', 'Studio enable handoff', '1440 and 390', 'labels', 'offline'] }));
  } catch (error) {
    console.error(error.stack);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error(JSON.stringify({ errors, outside, output })); process.exitCode = 1;
  } finally { cleanup(); exitAfterFlush(process.exitCode || 0); }
}).catch(error => { console.error(error); cleanup(); exitAfterFlush(1); });

// A real narrated video render through the app's own render path. Run via run-electron-test.cjs:
//   node scripts/run-electron-test.cjs video-render-smoke [--sample | --pack-a | --style-pack | --long-form] [--models <kokoro folder>] [--keep <folder>] [--name <stem>]
// --long-form renders a 3 to 5 minute chaptered video in the starter pack, stops it in its second chapter and resumes it (up to an hour).
// Electron runs only the app's render worker (electron/designRender.js); scripts/video_render_smoke.py serves the
// player and renders with core/video_render.render on a free loopback port, with temporary data. Without --models a
// tone stands in for Kokoro, so the suite needs no download. FFmpeg must be on the machine (Kairos never installs it).
const { app } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { exitAfterFlush } = require('./electron-exit.cjs');
const worker = require('../electron/designRender');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
app.setPath('userData', path.join(ROOT, 'data', 'video-render-smoke-profile'));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

let backend;
function finish(code, message) {
  worker.stop();
  if (backend && backend.exitCode === null) backend.kill();
  (code ? console.error : console.log)(message);
  exitAfterFlush(code);
}
process.on('unhandledRejection', error => finish(1, error.stack));
setTimeout(() => finish(1, 'Video render smoke timed out'), args.includes('--long-form') ? 3540000 : 400000);
// The worker's offscreen windows are the only windows; the suite ends itself, not the last window closing.
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', (event, level, message) => console.log('player console:', event.message ?? message));
  win.webContents.on('did-fail-load', (_e, code, description, url) => console.log('player failed to load:', code, description, url));
  win.webContents.on('render-process-gone', (_e, details) => console.log('player renderer gone:', details.reason));
});

app.whenReady().then(async () => {
  const port = await freePort(), token = crypto.randomBytes(24).toString('hex');
  const out = path.join(os.tmpdir(), `video-render-smoke-${process.pid}.json`);
  const python = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const py = ['-B', '-X', 'utf8', path.join(__dirname, 'video_render_smoke.py'), '--port', String(port), '--out', out];
  if (args.includes('--sample')) py.push('--sample');
  if (args.includes('--pack-a')) py.push('--pack-a');
  if (args.includes('--style-pack')) py.push('--style-pack');
  if (args.includes('--long-form')) py.push('--long-form');
  for (const name of ['--models', '--keep', '--name']) if (flag(name)) py.push(name, flag(name));
  backend = spawn(python, py, { cwd: ROOT, env: { ...process.env, KAIROS_RENDER_TOKEN: token }, stdio: 'inherit', windowsHide: true });
  const exited = new Promise(resolve => backend.on('exit', code => resolve(code)));
  const backendUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { await fetch(`${backendUrl}/static/motion/kit.js`); break; } catch { await new Promise(r => setTimeout(r, 150)); }
  }
  worker.start({ backendUrl, token });
  const code = await exited;
  let result = {};
  try { result = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true }); } catch { /* Reported below. */ }
  if (code !== 0 || !result.ok) return finish(1, 'Video render smoke failed: ' + (result.error || `backend exited ${code}`));
  const job = result.job;
  const summary = { seconds: job.seconds, render_seconds: result.render_seconds, real_voice: result.real_voice, loudness: job.loudness,
    narration: job.narration, notes: job.notes, sheets: result.sheets, sheet_match: result.sheet_match, pack: result.pack || null, kept: result.kept || null, long: result.long || null };
  console.log(JSON.stringify(summary, null, 2));
  if (!job.narration || !job.narration.lines) return finish(1, 'The render has no narration track.');
  // Pack A: each character's sheet rendered and passed its own checks, and no frame drifted from its sheet.
  if (!(result.sheets || []).length || result.sheets.some(s => !s.metrics || !s.metrics.ok)) return finish(1, 'A character sheet did not render or failed its checks.');
  const drift = (job.notes || []).filter(n => /approved sheet|outside the .* shot|could not be found where the rig/.test(n));
  if (drift.length) return finish(1, 'Frames do not match the approved sheets: ' + drift.join(' '));
  const match = result.sheet_match || {};
  if (!(match.frames_with_characters > 0)) return finish(1, 'No sampled frame had a character to compare with its sheet.');
  if (!(match.wrong_palette_notes > 0)) return finish(1, 'The sheet-match check did not notice a wrong palette.');
  // Captions stay clear of characters in every sampled moment, close shots included.
  const covered = (job.notes || []).filter(n => /caption covers a character/.test(n));
  if (covered.length) return finish(1, 'A caption covers a character: ' + covered.join(' '));
  // A line stays on its own beat: no scene's narration captioned on a title or end card.
  const spilled = (job.notes || []).filter(n => /card carries narration|runs onto the .* card|caption shows on the .* card/.test(n));
  if (spilled.length) return finish(1, 'Narration lands on a title or end card: ' + spilled.join(' '));
  // A style pack's sample waits for the person's approval once rendered, and keeps to the pack's rules.
  if (args.includes('--style-pack')) {
    if (!result.pack || result.pack.step !== 'sample' || result.pack.status !== 'awaiting_approval') return finish(1, 'The style pack sample was not sent for approval.');
    const strays = (job.notes || []).filter(n => /pack (does not use|keeps shots)|outside the .* pack|opening beat runs past/.test(n));
    if (strays.length) return finish(1, 'The sample strays from its own pack: ' + strays.join(' '));
    if (!(job.seconds >= 20 && job.seconds <= 30)) return finish(1, `The sample runs ${job.seconds} s, outside 20 to 30 s.`);
  }
  // A long video: refused before its plan was approved, stopped in its second chapter and resumed from there, joined into one
  // 3 to 5 minute video with YouTube chapters, inside its pack's rules.
  if (args.includes('--long-form')) {
    const long = result.long || {};
    if (!/plan/.test(long.refused_before_approval || '')) return finish(1, 'The long video was not refused before its plan was approved.');
    if (long.stopped_status !== 'paused' || long.stopped_chapters?.[0] !== 'done') return finish(1, 'The stop did not keep the first chapter: ' + JSON.stringify(long.stopped_chapters));
    if (!(long.reused_on_resume >= 1)) return finish(1, 'The resume rendered the first chapter again.');
    if (!(job.seconds >= 180 && job.seconds <= 300)) return finish(1, `The long sample runs ${job.seconds} s, outside 3 to 5 minutes.`);
    const lines = (long.chapters_text || '').split('\n');
    if (lines.length < 3 || !lines[0].startsWith('00:00 ')) return finish(1, 'The YouTube chapter list is wrong: ' + long.chapters_text);
    const strays = (job.notes || []).filter(n => /pack (does not use|keeps shots)|outside the .* pack|opening beat runs past|YouTube/.test(n));
    if (strays.length) return finish(1, 'The long sample strays from its pack or YouTube rules: ' + strays.join(' '));
  }
  finish(0, 'Video render smoke passed.');
});

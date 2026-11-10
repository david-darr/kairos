// A real narrated video render through the app's own render path. Run via run-electron-test.cjs:
//   node scripts/run-electron-test.cjs video-render-smoke [--sample] [--models <kokoro folder>] [--keep <folder>] [--name <stem>]
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
setTimeout(() => finish(1, 'Video render smoke timed out'), 400000);
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
    narration: job.narration, notes: job.notes, kept: result.kept || null };
  console.log(JSON.stringify(summary, null, 2));
  if (!job.narration || !job.narration.lines) return finish(1, 'The render has no narration track.');
  finish(0, 'Video render smoke passed.');
});

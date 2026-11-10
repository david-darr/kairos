// Standalone: node scripts/motion-engine-checks.cjs
// The shared runner currently allowlists suite names; this mirrors its launcher
// without requiring a change to that file. Also runnable directly with Electron.
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
const http = require('node:http');
const assert = require('node:assert/strict');
// Caller owns the shared machine-wide Electron lock; this suite never touches it.
const output = path.join(root, 'data/ui-review');
let win, server;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const project = { id: 'motion-check', title: 'Spring season', bpm: 120, fps: 30, aspects: ['16:9', '9:16', '1:1'], beats: [
  { id: 'title', kind: 'title', text: 'Spring season is here', sub: 'PSA Soccer', bars: 1, camera: 'push', transition: 'whip' },
  { id: 'statement', kind: 'statement', text: 'Every kid plays. Every game.', bars: 1, camera: 'pull', transition: 'zoom' },
  { id: 'number', kind: 'big-number', number: '312', text: 'players last fall', bars: 1, camera: 'shake', transition: 'flip' },
  { id: 'photo', kind: 'image', image: 'assets/field.svg', treatment: 'none', text: 'Saturdays at Riverside', sub: 'Find your team', bars: 1, camera: 'pan', transition: 'dither' },
  { id: 'list', kind: 'list', text: 'What you get', items: ['Coach-led practices', '8 games', 'Team kit', 'New friends', 'A place to play'], bars: 2, transition: 'mosaic' },
  { id: 'quote', kind: 'quote', text: 'Best part of my week.', sub: 'Maya, U10', bars: 1, transition: 'wipe' },
  { id: 'split', kind: 'split', text: 'Ages 5 to 14', sub: '$85, scholarships open', image: 'assets/field.svg', bars: 1, camera: 'push', transition: 'cut' },
  { id: 'logo', kind: 'logo', image: 'assets/mark.svg', text: 'Your team starts here', bars: 1, transition: 'dither' },
  { id: 'half', kind: 'image', image: 'assets/field.svg', treatment: 'halftone', text: 'Make your mark', bars: 1, transition: 'mosaic' },
  { id: 'dither', kind: 'image', image: 'assets/field.svg', treatment: 'dither', text: 'A season to remember', bars: 1, transition: 'zoom' },
  { id: 'end', kind: 'end', text: 'Sign up by March 1', sub: 'psasoccer.org', bars: 2, camera: 'shake' }
] };
const looks = {
  dark: { '--ds-bg': '#101418', '--ds-surface': '#1b2129', '--ds-text': '#ffffff', '--ds-text-dim': '#b4bdc8', '--ds-accent': '#c6ff3d', '--ds-accent-2': '#ff5a1f', '--ds-on-accent': '#101418', '--ds-font-display': 'Impact, sans-serif', '--ds-font-sans': 'Arial, sans-serif', '--ds-radius-m': '4px', '--ds-label-case': 'upper', '--ds-display-weight': '400', '--ds-pattern': 'stripes' },
  light: { '--ds-bg': '#fbf3f6', '--ds-surface': '#ffffff', '--ds-text': '#3b2a3f', '--ds-text-dim': '#6e5a72', '--ds-accent': '#a54a7c', '--ds-accent-2': '#8fb9a8', '--ds-on-accent': '#ffffff', '--ds-font-display': 'Georgia, serif', '--ds-font-sans': 'Arial, sans-serif', '--ds-radius-m': '20px', '--ds-label-case': 'none', '--ds-display-weight': '500', '--ds-display-style': 'italic', '--ds-pattern': 'dots' }
};
const photo = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><defs><linearGradient id="g" x2=".2" y2="1"><stop stop-color="#faf3ab"/><stop offset=".45" stop-color="#6094a4"/><stop offset="1" stop-color="#152d34"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1200v900H0z"/><circle cx="860" cy="210" r="135" fill="#fff5d0"/><path fill="#458272" d="M0 560L270 300 570 620 860 420 1200 600V900H0Z"/><path fill="#b0cb84" d="M0 700Q500 490 1200 760V900H0Z"/><path stroke="#f8f5da" fill="none" stroke-width="12" d="M0 790H1200M600 650V900"/><circle cx="600" cy="790" r="90" stroke="#f8f5da" fill="none" stroke-width="10"/></svg>';
const mark = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="500"><path fill="#a54a7c" d="M300 10 570 160 510 400 300 490 90 400 30 160Z"/><path fill="#fbf3f6" d="m300 100 140 100-50 170H210l-50-170Z"/><circle cx="300" cy="260" r="65" fill="#3b2a3f"/></svg>';
const template = fs.readFileSync(path.join(root, 'static/motion/player.html'), 'utf8');
function serve(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/videos/sample/player') {
    const tokens = looks[url.searchParams.get('look')] || looks.dark;
    const css = Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(';');
    res.setHeader('Content-Type', 'text/html');
    res.end(template.replace('<!--KD-TOKENS-->', `<style>:root{${css}}</style>`)
      .replace('<!--KD-PROJECT-->', `<script type="application/json" id="kd-project">${JSON.stringify(project)}</script>`)); return;
  }
  if (url.pathname.startsWith('/api/videos/sample/assets/')) {
    if (url.searchParams.get('rt') !== 'fixture-token') { res.writeHead(403); res.end(); return; }
    const image = { 'field.svg': photo, 'mark.svg': mark }[path.posix.basename(url.pathname)];
    res.writeHead(image ? 200 : 404, { 'Content-Type': 'image/svg+xml' }); res.end(image || ''); return;
  }
  const name = path.posix.basename(url.pathname);
  if (url.pathname === `/static/motion/${name}` && ['engine.js', 'kit.js', 'layout.js'].includes(name)) {
    res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'static/motion', name))); return;
  }
  res.writeHead(404); res.end();
}
function cleanup() {
  if (win && !win.isDestroyed()) win.destroy();
  server?.close();
}
app.setPath('userData', path.join(output, `motion-profile-${process.pid}`));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  server = http.createServer(serve); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(base + '/') && !details.url.startsWith('data:') && details.url !== 'about:blank' }));
  win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const expectedDuration = project.beats.reduce((n, b) => n + b.bars * 2, 0);
  for (const aspect of ['16:9', '9:16', '1:1']) {
    const captures = [], designedCaptures = [], hashes = {};
    for (const look of ['dark', 'light']) {
      await win.loadURL(`${base}/api/videos/sample/player?aspect=${encodeURIComponent(aspect)}&rt=fixture-token&look=${look}`);
      for (let i = 0; i < 100 && !await js('!!window.kdReady'); i++) await pause(50);
      await js('Promise.race([window.kdReady, new Promise((_, reject) => setTimeout(() => reject(Error("kdReady timeout")), 20000))]).then(() => true)');
      const info = await js('window.kdInfo');
      assert.equal(info.duration, expectedDuration); assert.equal(info.fps, 30); assert.equal(info.aspect, aspect);
      assert.equal(info.beats.length, project.beats.length);
      assert.deepEqual([info.width, info.height], aspect === '16:9' ? [1920, 1080] : aspect === '9:16' ? [1080, 1920] : [1080, 1080]);
      const result = await js(`(async () => {
        const canvas = document.getElementById('kd-canvas'), g = canvas.getContext('2d');
        const hash = async t => { kdDrawFrame(t); const pixels = g.getImageData(0,0,canvas.width,canvas.height).data;
          const digest = await crypto.subtle.digest('SHA-256', pixels); return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join(''); };
        const samples = kdInfo.beats.map(b => Math.min(b.end-.01, b.start+(b.end-b.start)*.72));
        const first = [], repeat = [], reverse = [];
        for (const t of samples) first.push(await hash(t));
        for (const t of samples) repeat.push(await hash(t));
        for (const t of [...samples].reverse()) reverse.unshift(await hash(t));
        const frames = [], designedFrames = [], variances = [], shares = [], errors = [], floorErrors = [], contrasts = [];
        const L = await import('/static/motion/layout.js'), K = await import('/static/motion/kit.js');
        const safe = L.safeArea(kdInfo.aspect);
        const times = [...samples, ...kdInfo.beats.slice(1).flatMap(b=>[b.start-.15,b.start-.05,b.start,b.start+.05,b.start+.15]), 0, kdInfo.duration];
        for (const t of times) {
          kdDrawFrame(t);
          for (const b of kdLayout(t).filter(b=>b.kind==='text')) {
            if (b.x<safe.x-.01 || b.y<safe.y-.01 || b.x+b.w>safe.x+safe.w+.01 || b.y+b.h>safe.y+safe.h+.01) errors.push({t,b});
            const source = ${JSON.stringify(project.beats)}.find(beat=>beat.id===b.beat);
            const floor = b.role==='number' ? 525 : b.role==='body' ? (source.kind==='list' ? 59.4 : source.kind==='big-number' ? 54 : source.kind==='end' ? 59.4 : 45.36) : L.TYPE[source.kind][0];
            if (b.fontSize < floor-.01) floorErrors.push({t,b,floor});
            contrasts.push(K.contrast(b.color,b.bg)); contrasts.push(K.contrast(b.highlightColor,b.bg));
          }
        }
        // Inspect settled plans with real font metrics, away from transitions.
        const layoutErrors = [];
        const displayMeasure = (text, size, role) => {
          const css = getComputedStyle(document.documentElement);
          g.font = (role === 'body' ? '500 ' : css.getPropertyValue('--ds-display-weight') + ' ') + size + 'px ' + css.getPropertyValue(role === 'body' ? '--ds-font-sans' : '--ds-font-display');
          return g.measureText(text).width;
        };
        for (const composition of ['left', 'center', 'bottom']) {
          const beats = L.normalizeProject(${JSON.stringify(project)}).beats;
          const statement = L.beatLayout(beats.find(b=>b.kind==='statement'), kdInfo.aspect, displayMeasure, {composition})[0];
          if (statement.lines.length < 2 || statement.lines.length > 3 || statement.size < 150) layoutErrors.push({composition,statement});
          const rows = L.beatLayout(beats.find(b=>b.kind==='list'), kdInfo.aspect, displayMeasure, {composition}).filter(b=>b.role==='body');
          // The marker sits 24px left of its row at body size and grows with rows set above 90px (dd059f2e), so the
          // gap scales with the row; every marker shares one x, clears the text and stays inside the safe area.
          const firstMarker = L.listMarker(rows[0]);
          for (const row of rows) {
            const marker = L.listMarker(row), gap = row.x-marker.x;
            if (row.align !== 'left' || row.size < 59.39 || row.x !== rows[0].x || marker.x !== firstMarker.x
              || Math.abs(gap - 24*Math.max(1, row.size/90)) > 1e-6 || marker.x+marker.radius >= row.x || marker.x-marker.radius < safe.x) layoutErrors.push({composition,row,marker});
          }
        }
        const designedTimes = [0, ...kdInfo.beats.map(b=>b.start+(b.end-b.start)*.60)];
        const capture = () => {
          const c=document.createElement('canvas');c.width=320;c.height=Math.round(320*canvas.height/canvas.width);
          c.getContext('2d').drawImage(canvas,0,0,c.width,c.height);return c.toDataURL();
        };
        for (const t of [...new Set([...samples, ...designedTimes])]) {
          kdDrawFrame(t); const pixels = g.getImageData(0,0,canvas.width,canvas.height).data;
          const bg = K.rgb(getComputedStyle(document.documentElement).getPropertyValue('--ds-bg'));
          let sum=0,sum2=0,count=0,nonbg=0;
          for(let i=0;i<pixels.length;i+=64){
            const v=(pixels[i]+pixels[i+1]+pixels[i+2])/3;sum+=v;sum2+=v*v;count++;
            if(Math.max(...bg.map((v,c)=>Math.abs(pixels[i+c]-v)))>8) nonbg++;
          }
          variances.push(sum2/count-(sum/count)**2); shares.push(nonbg/count);
          if(t===0 && !kdLayout(0).some(b=>b.kind==='text' && b.text)) errors.push({t,error:'empty poster layout'});
        }
        for (const t of samples) {kdDrawFrame(t);frames.push(capture());}
        for (const t of designedTimes) {kdDrawFrame(t);designedFrames.push(capture());}
        const hold = await hash(kdInfo.duration-1.49), final = await hash(kdInfo.duration);
        const nearFinal = await hash(kdInfo.duration-.2);
        // Exercise the public mount API with a separate canvas and explicit tokens.
        const E = await import('/static/motion/engine.js'), extra = document.createElement('canvas');
        const mounted=E.mount(extra,JSON.parse(document.getElementById('kd-project').textContent),{aspect:kdInfo.aspect,tokens:${JSON.stringify(looks[look])},assetsBase:'/api/videos/sample/assets/'});
        await mounted.ready; mounted.drawFrame(samples[0]);
        const publicLayout=mounted.layout(samples[0]);
        const publicPixels=extra.getContext('2d').getImageData(0,0,extra.width,extra.height).data;
        const publicHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',publicPixels))].map(v=>v.toString(16).padStart(2,'0')).join('');
        return {layoutErrors,first,repeat,reverse,variances,shares,errors,floorErrors,contrasts,frames,designedFrames,hold,final,nearFinal,publicHash,publicBoxes:publicLayout.length};
      })()`);
      assert.deepEqual(result.first, result.repeat, `${aspect}/${look}: repeat pixels`);
      assert.deepEqual(result.first, result.reverse, `${aspect}/${look}: call-order independence`);
      assert.ok(result.variances.every(v => v > 20), `${aspect}/${look}: nonblank frames ${result.variances}`);
      assert.ok(result.shares.every(v => v > .08), `${aspect}/${look}: >8% non-background pixels ${result.shares}`);
      assert.deepEqual(result.layoutErrors, [], `${aspect}/${look}: balanced statements and aligned list rows`);
      assert.deepEqual(result.floorErrors, [], `${aspect}/${look}: type floors`);
      assert.deepEqual(result.errors, [], `${aspect}/${look}: safe-area checks`);
      assert.ok(result.contrasts.every(c => c >= 4.5), `${aspect}/${look}: contrast`);
      assert.equal(result.hold, result.final, `${aspect}/${look}: final 1.5 second hold`);
      assert.equal(result.nearFinal, result.final); assert.equal(result.publicHash, result.first[0]); assert.ok(result.publicBoxes > 0);
      designedCaptures.push(...result.designedFrames.map((src, i) => ({src,label:`${look} / ${i ? project.beats[i-1].kind + ' 60%' : 'frame 0'}`})));
      hashes[look] = result.first; captures.push(...result.frames.map((src, i) => ({ src, label: `${look} / ${project.beats[i].kind}` })));
    }
    assert.ok(hashes.dark.every((v, i) => v !== hashes.light[i]), `${aspect}: looks differ for every beat`);
    for (const [suffix, sheets, count] of [['', captures, project.beats.length], ['-designed', designedCaptures, project.beats.length + 1]]) {
      const png = await js(`(async () => {
        const frames=${JSON.stringify(sheets)}, count=${count}, cols=4, rows=Math.ceil(count/cols), thumbH=Math.round(320*kdInfo.height/kdInfo.width);
        const c=document.createElement('canvas');c.width=cols*320;c.height=rows*(thumbH+28)*2;
        const g=c.getContext('2d');g.fillStyle='#202020';g.fillRect(0,0,c.width,c.height);g.font='16px sans-serif';
        for(let i=0;i<frames.length;i++) { const f=frames[i],image=new Image();image.src=f.src;await image.decode();
          const look=Math.floor(i/count),n=i%count,x=(n%cols)*320,y=(look*rows+Math.floor(n/cols))*(thumbH+28);
          g.drawImage(image,x,y+28);g.fillStyle='#ffffff';g.fillText(f.label,x+8,y+20); }
        return c.toDataURL('image/png').split(',')[1];
      })()`);
      const destination = path.join(output, `motion-${aspect.replace(':', 'x')}${suffix}.png`);
      fs.writeFileSync(destination, Buffer.from(png, 'base64')); console.log(`PASS ${aspect}; contact sheet: ${destination}`);
    }
  }
  console.log('Motion engine Electron checks passed (two looks, three aspects, all beats, cameras, transitions and image treatments).');
  cleanup(); app.exit(0);
}).catch(error => { console.error(error); cleanup(); app.exit(1); });

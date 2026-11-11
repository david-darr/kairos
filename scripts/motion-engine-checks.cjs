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
  { id: 'scene', kind: 'scene', text: 'Meet the coach', bars: 2, camera: 'push', transition: 'wipe', spoken: { mouth: 'XXXXXXXXAAEEOOMMFFAAOO' },
    scene: { setting: 'meadow', shot: 'medium', cast: [{ character: 'abcdefabcdef', action: 'wave', expression: 'happy', speaking: true }],
      props: [{ icon: 'sun', x: .8, y: .2, size: .12 }] } },
  { id: 'end', kind: 'end', text: 'Sign up by March 1', sub: 'psasoccer.org', bars: 2, camera: 'shake' }
], palette: 'mint', characters: { abcdefabcdef: { version: 1, spec: { name: 'Pip', family: 'round', accessory: 'leaf', outline: 7,
  proportions: { head: .42, body_width: .62, limb_length: .26, limb_width: .055, eye_size: .036 },
  palette: { body: '#f4a259', body_shade: '#e0843d', head: '#f7c08a', limb: '#5b4a6b', eye: '#231b2e', mouth: '#8c3b4a', outline: '#2e2438', accent: '#7cc6a4', cheek: '#f08a8a' } } } } };
// Pack C classic's Story Short (static/motion/story.js, classic.js, classic3d.js): two speakers, a shot now and a flashback.
const outfit = (shirt, hair) => ({ skin: '#f0c8a8', hair, hair_style: 'short', shirt, detail: '#f2f2f2', detail_style: 'zip', pants: '#2a2833', shoes: '#ececec', eyes: '#2d2140' });
const story = { id: 'story-check', title: 'Story', bpm: 120, fps: 30, aspects: ['9:16'], look: 'brutalist', narration: { voice: 'af_heart', captions: true },
  characters: { a00000000001: { version: 1, spec: { form: 'block', colour: '#b05aff', outfit: outfit('#5e2b8c', '#1d1a22') } },
    a00000000002: { version: 1, spec: { form: 'block', colour: '#ffa028', outfit: outfit('#e2592c', '#16110e') } } },
  beats: [
    { id: 'now', kind: 'story', say: 'Help me please!', speaker: 'a00000000001', seconds: 2, gap: .3,
      spoken: { key: 'k', seconds: 1.6, parts: [[.06, 1.66, 'Help me please!']], mouth: 'XXAAAAEEXXOOAAAAEEXX', words: [[.06, .4], [.5, .8], [.9, 1.5]] },
      story: { place: 'cliff', seed: 2, cast: [{ character: 'a00000000001', pose: 'hang', mood: 'scared' }, { character: 'a00000000002', x: .7, y: .9, face: 'c0' }],
        shots: [{ shot: 'close', on: 0, shake: true }, { shot: 'low', on: 1, at: { word: 2 } }], keys: ['please'] } },
    { id: 'then', kind: 'story', say: 'My house!', speaker: 'a00000000002', flashback: true, seconds: 2, gap: .4,
      spoken: { key: 'k2', seconds: 1.2, parts: [[.06, 1.26, 'My house!']], mouth: 'XXAAEEAAOOXX', words: [[.06, .5], [.6, 1.2]] },
      story: { place: 'village', seed: 1, cast: [{ character: 'a00000000002', x: 9, y: 5.2, pose: 'cry', mood: 'crying' }], shots: [{ shot: 'close', on: 0 }] } }] };
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
  // A video clip's decoded frames (step 7): frame n is a flat colour from its number, so a drawn pixel names the frame.
  const frameMatch = /^\/api\/videos\/sample\/assets\/media\/a{64}\/(\d{1,6})\.jpg$/.exec(url.pathname);
  if (frameMatch) {
    if (url.searchParams.get('rt') !== 'fixture-token') { res.writeHead(403); res.end(); return; }
    const n = Number(frameMatch[1]);
    res.writeHead(n < 30 ? 200 : 404, { 'Content-Type': 'image/svg+xml' });
    res.end(n < 30 ? `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="rgb(${n * 8},${255 - n * 8},90)"/></svg>` : ''); return;
  }
  if (url.pathname.startsWith('/api/videos/sample/assets/')) {
    if (url.searchParams.get('rt') !== 'fixture-token') { res.writeHead(403); res.end(); return; }
    const image = { 'field.svg': photo, 'mark.svg': mark }[path.posix.basename(url.pathname)];
    res.writeHead(image ? 200 : 404, { 'Content-Type': 'image/svg+xml' }); res.end(image || ''); return;
  }
  const name = path.posix.basename(url.pathname);
  if (url.pathname === `/static/motion/${name}` && ['engine.js', 'kit.js', 'layout.js', 'rig.js', 'scene.js', 'stage.js', 'overlay.js', 'voxel.js',
    'blocks.js', 'classic.js', 'classic3d.js', 'story.js'].includes(name)) {
    res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'static/motion', name))); return;
  }
  // Pack C classic's Story Short: the vendored three.js (its two module files) and the bundled caption font.
  if (['/static/vendor/three/three.module.js', '/static/vendor/three/three.core.js'].includes(url.pathname)) {
    res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, url.pathname.slice(1)))); return;
  }
  if (url.pathname === '/static/fonts/looks/archivoblack/ArchivoBlack-Regular.ttf') {
    res.setHeader('Content-Type', 'font/ttf'); res.end(fs.readFileSync(path.join(root, url.pathname.slice(1)))); return;
  }
  if (url.pathname === '/api/videos/story/player') {
    res.setHeader('Content-Type', 'text/html');
    res.end(template.replace('<!--KD-TOKENS-->', `<style>:root{${Object.entries(looks.dark).map(([k, v]) => `${k}:${v}`).join(';')}}
      @font-face { font-family: "Kairos Story Caption"; src: url("/static/fonts/looks/archivoblack/ArchivoBlack-Regular.ttf"); }</style>`)
      .replace('<!--KD-PROJECT-->', `<script type="application/json" id="kd-project">${JSON.stringify(story)}</script>`)); return;
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
        // Pack A: the scene draws its character where the layout says, in the spec's body colour.
        const sceneBeat = kdInfo.beats.find(b => b.id === 'scene'), st = sceneBeat.start + (sceneBeat.end - sceneBeat.start) * .6;
        kdDrawFrame(st);
        const figure = kdLayout(st).find(b => b.kind === 'character');
        if (!figure) errors.push({t: st, error: 'no character in the scene layout'});
        else {
          const px = g.getImageData(Math.round(figure.body.cx), Math.round(figure.body.cy + figure.body.h * .3), 1, 1).data;
          const want = K.rgb('#f4a259'), shade = K.rgb('#e0843d');
          const near = c => Math.hypot(px[0]-c[0], px[1]-c[1], px[2]-c[2]) < 40;
          if (!near(want) && !near(shade)) errors.push({t: st, error: 'body colour missing at the body', px: [...px]});
          if (figure.character !== 'abcdefabcdef' || figure.mouth === undefined) errors.push({t: st, error: 'character box fields', figure});
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
  // Overlay tracks (Content Studio Editor step 3): clips draw over the beats in track order, fade, stay out of hidden
  // tracks, report their boxes for the checks, and draw the same pixels every time (drawFrame(t) stays deterministic).
  const tracks = [
    { id: 't1', kind: 'overlay', name: 'Titles', clips: [
      { id: 'o1', kind: 'text', start: .5, in: 0, out: 2, fade_in: .5, fade_out: 0, opacity: 1, text: 'Overlay title', box: { x: .1, y: .1, w: .5, h: .15 }, style: 'card', color: 'accent' },
      { id: 's1', kind: 'shape', start: 3, in: 0, out: 1, opacity: 1, shape: 'rect', color: 'accent-2', fill: true, box: { x: .6, y: .6, w: .2, h: .2 } }] },
    { id: 't2', kind: 'overlay', name: 'On top', clips: [
      { id: 'i1', kind: 'image', start: 0, in: 0, out: 2, opacity: 1, image: 'assets/field.svg', fit: 'cover', box: { x: .05, y: .7, w: .2, h: .2 } },
      { id: 's2', kind: 'shape', start: 3, in: 0, out: 1, opacity: 1, shape: 'ellipse', color: 'white', fill: true, box: { x: .65, y: .65, w: .1, h: .1 } }] },
    { id: 't3', kind: 'overlay', name: 'Hidden', hidden: true, clips: [{ id: 's3', kind: 'shape', start: 0, in: 0, out: 20, shape: 'rect', color: 'black', box: { x: 0, y: 0, w: .05, h: .05 } }] },
    { id: 'a1', kind: 'audio', name: 'Sound', clips: [{ id: 'snd', kind: 'sound', start: 0, in: 0, out: 1, audio: 'assets/x.wav' }] }];
  await win.loadURL(`${base}/api/videos/sample/player?aspect=16:9&rt=fixture-token&look=dark`);
  for (let i = 0; i < 100 && !await js('!!window.kdReady'); i++) await pause(50);
  await js('window.kdReady.then(() => true)');
  const overlayResult = await js(`(async () => {
    const E = await import('/static/motion/engine.js'), K = await import('/static/motion/kit.js');
    const base = JSON.parse(document.getElementById('kd-project').textContent), options = { aspect: '16:9', tokens: ${JSON.stringify(looks.dark)}, assetsBase: '/api/videos/sample/assets/' };
    const plain = document.createElement('canvas'), layered = document.createElement('canvas');
    const a = E.mount(plain, base, options), b = E.mount(layered, { ...base, tracks: ${JSON.stringify(tracks)} }, options);
    await Promise.all([a.ready, b.ready]);
    const px = (c, x, y) => [...c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
    const hash = async (m, c, t) => { m.drawFrame(t); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', d))].map(v => v.toString(16).padStart(2, '0')).join(''); };
    const W = 1920, H = 1080, out = { info: b.info.clips.map(c => c.id) };
    a.drawFrame(3.5); b.drawFrame(3.5);
    out.top = px(layered, .7 * W, .7 * H); out.under = px(layered, .62 * W, .62 * H); out.plainUnder = px(plain, .62 * W, .62 * H);
    out.style = { accent2: K.rgb(getComputedStyle(document.documentElement).getPropertyValue('--ds-accent-2')) };
    a.drawFrame(1); b.drawFrame(1);
    out.hidden = [px(layered, 20, 20), px(plain, 20, 20)];
    out.image = [px(layered, .15 * W, .8 * H), px(plain, .15 * W, .8 * H)];
    a.drawFrame(2.6); b.drawFrame(2.6);
    out.gap = [px(layered, .7 * W, .7 * H), px(plain, .7 * W, .7 * H)];
    out.fade = b.layout(.75).find(e => e.clip === 'o1')?.alpha;
    out.box = b.layout(1.5).find(e => e.clip === 'o1');
    out.layoutIds = b.layout(1).filter(e => e.clip).map(e => e.clip).sort();
    const h1 = await hash(b, layered, 3.5), h2 = await hash(b, layered, .9), h3 = await hash(b, layered, 3.5);
    out.deterministic = h1 === h3 && h1 !== h2;
    b.drawFrame(1.5); out.frame = layered.toDataURL('image/png').split(',')[1];
    a.dispose(); b.dispose();
    return out;
  })()`);
  assert.deepEqual(overlayResult.info, ['o1', 's1', 'i1', 's2'], 'Visible overlay clips in drawing order (hidden and audio tracks left out)');
  assert.deepEqual(overlayResult.top, [255, 255, 255], 'The later track draws on top');
  assert.ok(overlayResult.under.every((v, i) => Math.abs(v - overlayResult.style.accent2[i]) < 3), 'The lower track shows where nothing covers it');
  assert.notDeepEqual(overlayResult.under, overlayResult.plainUnder);
  assert.deepEqual(overlayResult.hidden[0], overlayResult.hidden[1], 'A hidden track draws nothing');
  assert.notDeepEqual(overlayResult.image[0], overlayResult.image[1], 'An image clip draws its picture');
  assert.deepEqual(overlayResult.gap[0], overlayResult.gap[1], 'Nothing between clips');
  assert.ok(Math.abs(overlayResult.fade - .5) < .01, 'Half way through a 0.5 s fade in: ' + overlayResult.fade);
  assert.equal(overlayResult.box.kind, 'text'); assert.equal(overlayResult.box.role, 'overlay'); assert.equal(overlayResult.box.text, 'Overlay title');
  assert.ok(overlayResult.box.bg && !overlayResult.box.truncated && Math.abs(overlayResult.box.x - 192) < 1 && Math.abs(overlayResult.box.w - 960) < 1, 'The text clip reports its box on its card');
  assert.deepEqual(overlayResult.layoutIds, ['i1', 'o1'], 'Layout reports the clips on screen, and none from a hidden track');
  assert.ok(overlayResult.deterministic, 'The same time draws the same pixels');
  fs.writeFileSync(path.join(output, 'motion-overlays.png'), Buffer.from(overlayResult.frame, 'base64'));
  console.log('PASS overlay tracks; frame: ' + path.join(output, 'motion-overlays.png'));
  // Steps 5 to 7: keyframes drawn by our own interpolation, a video clip's exact frame by number (the render page
  // awaits it), 60 frames a second in the player's info, and the word being said lit in the captions.
  const later = await js(`(async () => {
    const E = await import('/static/motion/engine.js'), O = await import('/static/motion/overlay.js');
    const base = JSON.parse(document.getElementById('kd-project').textContent), options = { aspect: '16:9', tokens: ${JSON.stringify(looks.dark)}, assetsBase: '/api/videos/sample/assets/' };
    const out = {}, canvas = () => document.createElement('canvas');
    const px = (c, x, y) => [...c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
    const hash = async (m, c, t) => { m.drawFrame(t); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', d))].map(v => v.toString(16).padStart(2, '0')).join(''); };
    // Keyframes: x from -0.3 to 0.4 (ease out) over the clip's own 0 to 1 s, a quarter turn and a half to full size.
    const keyed = [{ id: 'k', kind: 'overlay', name: 'Moves', clips: [{ id: 'm1', kind: 'shape', start: 1, in: 0, out: 2, opacity: 1, shape: 'rect', color: 'white', fill: true,
      box: { x: .1, y: .4, w: .2, h: .2 }, keys: { x: [{ t: 0, v: -.3, ease: 'out' }, { t: 1, v: .4 }], rotation: [{ t: 0, v: 0 }, { t: 1, v: 90 }], scale: [{ t: 0, v: .5 }, { t: 1, v: 1 }] } }] }];
    const kc = canvas(), km = E.mount(kc, { ...base, tracks: keyed }, options); await km.ready;
    const at = t => km.layout(t).find(e => e.clip === 'm1');
    out.keyMid = at(1.5); out.keyEnd = at(2.5); out.keyBefore = at(1);
    out.easeOut = O.ease('out', .5);
    const k1 = await hash(km, kc, 1.37), k2 = await hash(km, kc, 1.61), k3 = await hash(km, kc, 1.37);
    out.keyDeterministic = k1 === k3 && k1 !== k2;
    km.drawFrame(1.5); out.keyFrame = kc.toDataURL('image/png').split(',')[1];
    // A video clip: 30 decoded frames, the clip starts at 1 s and plays from 0.2 s into the file.
    const media = { ['a'.repeat(64)]: { frames: 30, width: 64, height: 36 } };
    const video = [{ id: 'v', kind: 'overlay', name: 'Video', clips: [{ id: 'v1', kind: 'video', start: 1, in: .2, out: 1, opacity: 1, video: 'media/' + 'a'.repeat(64), fit: 'cover', box: { x: .5, y: .5, w: .3, h: .3 } }] }];
    const vc = canvas(), vm = E.mount(vc, { ...base, tracks: video, media }, { ...options, strict: true }); await vm.ready;
    try { vm.drawFrame(1.5); out.strictThrew = false; } catch (error) { out.strictThrew = /not ready/.test(error.message); }
    const colourAt = async t => { await vm.prepare(t); vm.drawFrame(t); return px(vc, 1920 * .65, 1080 * .65); };
    out.frames = { a: await colourAt(1.5), b: await colourAt(1.5 + 1 / 120), c: await colourAt(1.5 + 1 / 30) };
    out.frameIndex = vm.layout(1.5).find(e => e.clip === 'v1')?.videoFrame;
    out.infoKinds = vm.info.clips.map(c => c.kind);
    // 60 frames a second: the player says so, and every frame's time is n / 60.
    const sixty = E.mount(canvas(), { ...base, fps: 60 }, options); await sixty.ready; out.fps = sixty.info.fps; sixty.dispose();
    // Word captions: one narrated beat, six aligned words; the box style lights the word being said.
    const words = [[.3, .55], [.6, .8], [.85, 1.05], [1.1, 1.3], [1.35, 1.7], [1.75, 2.4]];
    const narrated = style => ({ ...base, narration: { voice: 'af_heart', captions: true, caption_style: style },
      beats: [{ id: 'w', kind: 'statement', text: 'Sky', bars: 2, seconds: 3, say: 'Look up on a clear day.', spoken: { key: 'k', seconds: 2.4, parts: [[.25, 2.45, 'Look up on a clear day.']], words } }] });
    const lc = canvas(), bc = canvas(), hc = canvas();
    const line = E.mount(lc, narrated('line'), options), boxed = E.mount(bc, narrated('box'), options), lit = E.mount(hc, narrated('highlight'), options);
    await Promise.all([line.ready, boxed.ready, lit.ready]);
    out.word = [.2, .65, 1.2, 2.0].map(t => boxed.layout(t).find(e => e.role === 'caption')?.word ?? null);
    out.wordStyle = boxed.layout(1.2).find(e => e.role === 'caption')?.captionStyle;
    const diff = async (a, ca, b, cb, t) => { a.drawFrame(t); b.drawFrame(t); const x = ca.getContext('2d').getImageData(0, 0, 1920, 1080).data, y = cb.getContext('2d').getImageData(0, 0, 1920, 1080).data; let n = 0; for (let i = 0; i < x.length; i += 4) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) n++; return n; };
    out.boxDiff = await diff(line, lc, boxed, bc, 1.2); out.litDiff = await diff(line, lc, lit, hc, 1.2); out.beforeDiff = await diff(line, lc, boxed, bc, .26);
    const unsure = E.mount(canvas(), { ...narrated('box'), beats: narrated('box').beats.map(b => ({ ...b, spoken: { ...b.spoken, words: undefined } })) }, options); await unsure.ready;
    out.fallback = unsure.layout(1.2).find(e => e.role === 'caption')?.captionStyle;
    boxed.drawFrame(1.2); out.wordFrame = bc.toDataURL('image/png').split(',')[1];
    for (const m of [km, vm, line, boxed, lit, unsure]) m.dispose();
    return out;
  })()`);
  const eased = -.3 + .7 * later.easeOut;
  assert.ok(Math.abs(later.keyMid.frame.x / 1920 - eased) < 1e-4, 'Half way, x follows the ease out curve: ' + later.keyMid.frame.x / 1920 + ' vs ' + eased);
  assert.ok(Math.abs(later.keyMid.rotation - 45) < 1e-6 && Math.abs(later.keyMid.scale - .75) < 1e-6, 'Rotation and scale between their keys (linear)');
  assert.ok(Math.abs(later.keyEnd.frame.x / 1920 - .4) < 1e-6 && later.keyEnd.rotation === 90, 'After the last key the values hold');
  assert.ok(Math.abs(later.keyBefore.frame.x / 1920 + .3) < 1e-6, 'At the first key: its value');
  assert.ok(later.keyMid.w > later.keyMid.frame.w * .75 * .99, 'The reported box bounds the turned, scaled clip');
  assert.ok(later.keyDeterministic, 'Keyframed clips draw the same pixels at the same time');
  assert.equal(later.strictThrew, true, 'The render page never draws a video frame it has not loaded');
  assert.equal(later.frameIndex, 21, 'Frame floor((0.2 + 0.5) x 30) = 21 at 1.5 s');
  assert.deepEqual(later.frames.a, [168, 87, 90], 'The pixel is frame 21\'s own colour: ' + later.frames.a);
  assert.deepEqual(later.frames.a, later.frames.b, 'A time inside the same frame draws the same frame');
  assert.notDeepEqual(later.frames.a, later.frames.c, 'The next frame draws the next picture');
  assert.deepEqual(later.infoKinds, ['video']);
  assert.equal(later.fps, 60, 'A 60 fps video tells the render worker its frame rate');
  assert.deepEqual(later.word, [null, 1, 3, 5], 'The word being said, and the last one said between words');
  assert.equal(later.wordStyle, 'box');
  assert.ok(later.boxDiff > 500 && later.litDiff > 50, 'The lit word draws differently from the line style: ' + later.boxDiff + ', ' + later.litDiff);
  assert.equal(later.beforeDiff, 0, 'Before the first word the caption is the plain line');
  assert.equal(later.fallback, 'line', 'A line without word times keeps line captions');
  fs.writeFileSync(path.join(output, 'motion-keyframes.png'), Buffer.from(later.keyFrame, 'base64'));
  fs.writeFileSync(path.join(output, 'motion-word-caption.png'), Buffer.from(later.wordFrame, 'base64'));
  console.log('PASS keyframes, video frames by number, 60 fps info, word captions; frames: motion-keyframes.png, motion-word-caption.png');
  // The Story Short frame (Pack C classic): the split screen with the speaker's border and the divider, one outlined word,
  // the scene below; a flashback graded sepia with its tag; the same pixels every time.
  await win.loadURL(`${base}/api/videos/story/player?aspect=9%3A16&rt=fixture-token`);
  for (let i = 0; i < 100 && !await js('!!window.kdReady'); i++) await pause(50);
  await js('Promise.race([window.kdReady, new Promise((_, reject) => setTimeout(() => reject(Error("kdReady timeout")), 30000))]).then(() => true)');
  const shortInfo = await js(`(async () => {
    const canvas = document.getElementById('kd-canvas'), g = canvas.getContext('2d');
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    const region = (x0, y0, w, h) => { const d = g.getImageData(x0, y0, w, h).data; let r = 0, gg = 0, b = 0, ordered = 0, n = 0;
      for (let i = 0; i < d.length; i += 16) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; if (d[i] >= d[i + 1] - 2 && d[i + 1] >= d[i + 2] - 2) ordered++; n++; } return { r: r / n, g: gg / n, b: b / n, ordered: ordered / n }; };
    const hash = async t => { kdDrawFrame(t); const digest = await crypto.subtle.digest('SHA-256', g.getImageData(0, 0, 1080, 1920).data); return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join(''); };
    const out = { info: kdInfo };
    kdDrawFrame(.7);
    out.border = px(6, 320); out.divider = px(540, 640); out.layout = kdLayout(.7); out.now = region(0, 700, 1080, 1200);
    out.frameNow = canvas.toDataURL('image/png').split(',')[1];
    kdDrawFrame(2.9);
    out.borderThen = px(6, 320); out.then = region(0, 700, 1080, 1200); out.layoutThen = kdLayout(2.9);
    out.frameThen = canvas.toDataURL('image/png').split(',')[1];
    out.same = (await hash(1.1)) === (await hash(1.1));
    return out;
  })()`);
  const close = (a, b, tol, msg) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= tol), msg + ': ' + a + ' vs ' + b);
  assert.equal(shortInfo.info.format, 'story-short');
  assert.deepEqual([shortInfo.info.width, shortInfo.info.height], [1080, 1920]);
  close(shortInfo.border, [176, 90, 255], 12, 'The avatar strip\'s border is the speaker\'s colour');
  close(shortInfo.borderThen, [255, 160, 40], 12, 'and changes with the speaker');
  close(shortInfo.divider, [12, 10, 18], 10, 'An 8 px dark divider on the seam');
  const word = shortInfo.layout.find(e => e.role === 'caption');
  assert.ok(word && word.story && word.text.split(' ').length === 1 && word.y > 640, 'One caption word under the divider: ' + JSON.stringify(word));
  assert.equal(shortInfo.layout.find(e => e.kind === 'story').shot, 'close');
  assert.ok(shortInfo.layout.some(e => e.kind === 'character' && e.classic && e.y + e.h > 640), 'The cast is reported in the scene below the strip');
  assert.ok(shortInfo.then.ordered > .9 && shortInfo.then.r > shortInfo.then.b + 20, 'The flashback is graded sepia: ' + JSON.stringify(shortInfo.then));
  assert.ok(shortInfo.now.ordered < .9 || shortInfo.now.b > shortInfo.now.r, 'Now is not sepia: ' + JSON.stringify(shortInfo.now));
  assert.ok(!shortInfo.layoutThen.some(e => e.kind === 'character'), 'Flashback frames are not colour-checked against the sheets');
  assert.ok(shortInfo.same, 'A story frame draws the same pixels every time');
  fs.writeFileSync(path.join(output, 'motion-story-now.png'), Buffer.from(shortInfo.frameNow, 'base64'));
  fs.writeFileSync(path.join(output, 'motion-story-flashback.png'), Buffer.from(shortInfo.frameThen, 'base64'));
  console.log('PASS Story Short: split screen, speaker border and divider, one-word captions, sepia flashback, deterministic; frames: motion-story-now.png, motion-story-flashback.png');
  console.log('Motion engine Electron checks passed (two looks, three aspects, all beats, cameras, transitions, image treatments, overlay tracks, keyframes, video clips, word captions and the Story Short).');
  cleanup(); app.exit(0);
}).catch(error => { console.error(error); cleanup(); app.exit(1); });

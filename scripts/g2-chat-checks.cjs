// g2 (A04 + A22): the composer's + actions end to end, attachments, screen capture,
// dictation and Open Mic, in real Chromium against the mocked backend. Run with
// `ui-smoke.cjs --g2-only`. Page-level stubs (window.fetch for the speech and upload routes,
// getUserMedia, MediaRecorder, speechSynthesis, CaptureController) stand in for hardware; the
// app code under test is the real one. Real mouse input goes through the debugger.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, capture, delay, navigate, writes, demoState, base, reads }) => {
  const dbg = (type, x, y, extra = {}) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const toast = text => `[...document.querySelectorAll('.toast')].some(t => t.textContent.includes(${JSON.stringify(text)}))`;
  const livePosts = () => writes.filter(w => w.path === '/api/chat/live' && w.method === 'POST');
  const clearToasts = () => js("document.querySelectorAll('.toast').forEach(t => t.remove()); true");
  const plus = label => js(`(() => { document.body.click(); document.querySelector('#overflow-plus-btn').click();
    const item = [...document.querySelectorAll('#overflow-menu .overflow-menu-item')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
    if (!item) throw Error('No + item ' + ${JSON.stringify(label)}); item.click(); return true; })()`);
  const openChat = async () => { await navigate('chat', { sessionId: 's1' }); await waitFor("!!document.querySelector('#chat-input') && document.querySelectorAll('#chat-messages .msg').length > 0"); };

  // ---- page stubs --------------------------------------------------------------------------
  await openChat();
  await js(`(() => {
    const g = window.__g2 = { uploads: [], validations: [], transcribes: [], gum: [], stopped: 0, recorders: 0,
      speech: { engine_available: true, active_model: 'base.en', models: [] }, transcript: 'hello world', transcribeError: null,
      transcribeDelay: 0, mic: 'ok', uploadRule: () => ({}), spoken: [], posts: [], session: null,
      // Recent runs per connection (Session Usage and Model Tracking, unit 7): m1 keeps failing, m3 beats m2.
      stats: { endpoints: {
        m1: { runs: 10, enough_data: true, failed: 6, failures_by_class: { overload: 6 }, recent_outcomes: ['failed', 'failed', 'finished', 'failed', 'failed', 'failed', 'finished', 'failed', 'finished', 'finished'] },
        m2: { runs: 12, enough_data: true, failed: 3, ttft_median_s: 0.4, recent_outcomes: [] },
        m3: { runs: 9, enough_data: true, failed: 0, ttft_median_s: 1.2, recent_outcomes: [] } } } };
    g.real = window.fetch.bind(window);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = (init.method || 'GET').toUpperCase();
      if (url.pathname === '/api/speech/status') return json(g.speech);
      if (url.pathname === '/api/speech/transcribe' && method === 'POST') {
        const file = init.body.get('audio');
        g.transcribes.push({ bytes: file.size, name: file.name });
        if (g.transcribeDelay) await new Promise(r => setTimeout(r, g.transcribeDelay));
        return g.transcribeError ? json({ detail: g.transcribeError }, 422) : json({ text: g.transcript });
      }
      if (url.pathname === '/api/chat/attachments' && method === 'POST') {
        const file = init.body.get('file'), rule = g.uploadRule(file) || {};
        g.uploads.push({ name: file.name, size: file.size, type: file.type, status: rule.status || 200 });
        return rule.status ? json({ detail: rule.detail }, rule.status) : json({ id: 'att-' + g.uploads.length, filename: file.name });
      }
      if (url.pathname === '/api/chat/validate-attachments' && method === 'POST') { g.validations.push(JSON.parse(init.body)); return json({ ok: true }); }
      if (url.pathname === '/api/models/stats' && method === 'GET') return json(g.stats);
      if (url.pathname === '/api/sessions/s1/fork' && method === 'POST') { g.posts.push(['fork', JSON.parse(init.body)]); return json({ id: 'fork-1', title: 'A clearer direction (fork)', project_id: null }); }
      if (url.pathname === '/api/sessions/s1/fallback' && method === 'POST') { g.posts.push(['fallback', JSON.parse(init.body)]); return json({ ok: true }); }
      if (url.pathname === '/api/sessions/s1/model' && method === 'POST') { g.posts.push(['model', JSON.parse(init.body)]); return json({ ok: true }); }
      if (url.pathname === '/api/sessions/s1/rewind' && method === 'POST') { g.posts.push(['rewind', JSON.parse(init.body)]); return json({ messages: [] }); }
      if (g.session && method === 'GET' && url.pathname === '/api/sessions/s1') return json(g.session);
      if (method === 'GET' && url.pathname === '/api/sessions/s1') {   // the real API always carries this field (None for new chats)
        const body = await (await g.real(input, init)).json(); if (body.enabled_integration_ids === undefined) body.enabled_integration_ids = null; return json(body);
      }
      return g.real(input, init);
    };
    const wav = seconds => { const rate = 16000, n = Math.floor(rate * seconds), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 8000, true); return new Blob([buf], { type: 'audio/wav' }); };
    window.FakeRecorder = class { constructor(stream) { this.stream = stream; this.state = 'inactive'; this.l = {}; }
      addEventListener(n, f) { (this.l[n] ||= []).push(f); }
      start() { this.state = 'recording'; g.recorders++; }
      stop() { if (this.state !== 'recording') return; this.state = 'inactive';
        queueMicrotask(() => { (this.l.dataavailable || []).forEach(f => f({ data: wav(0.5) })); (this.l.stop || []).forEach(f => f({})); }); } };
    window.MediaRecorder = window.FakeRecorder;
    const ac = new AudioContext();
    navigator.mediaDevices.getUserMedia = async constraints => {
      g.gum.push(constraints.audio);
      if (g.mic === 'denied') throw new DOMException('blocked', 'NotAllowedError');
      if (g.mic === 'none') throw new DOMException('none', 'NotFoundError');
      if (g.mic === 'lost-saved' && constraints.audio.deviceId) throw new DOMException('gone', 'NotFoundError');
      const stream = ac.createMediaStreamDestination().stream;
      stream.getTracks().forEach(t => { const stop = t.stop.bind(t); t.stop = () => { g.stopped++; stop(); }; });
      return stream;
    };
    return true;
  })()`);
  const g = expr => js(`window.__g2.${expr}`);

  // ---- 1. + > Attach files: multiple / image / rejected / removal / send once ---------------
  await plus('Attach files');   // the + item must hand off to the real file input
  await js(`(() => { window.__g2.uploadRule = f => f.name.endsWith('.exe') ? { status: 415, detail: 'That file type is not supported' }
      : f.size > 5e6 ? { status: 413, detail: 'That file is too large' } : {}; return true; })()`);
  const feed = (selector, specs) => js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const dt = new DataTransfer();
    for (const [name, type, size] of ${JSON.stringify(specs)}) dt.items.add(new File([new Uint8Array(size).fill(65)], name, { type }));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return input.files.length; })()`);
  const fileInputSelector = await js("(() => { const i = [...document.querySelectorAll('.overflow-wrapper input[type=file]')].find(n => !n.capture); i.id = 'g2-file-input'; return '#g2-file-input'; })()");
  assert.equal(await js("document.querySelector('#g2-file-input').multiple"), true, 'Attach files takes several files at once');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=';
  await js(`(() => { const input = document.querySelector('#g2-file-input'); const dt = new DataTransfer();
    dt.items.add(new File(['plan'], 'plan.txt', { type: 'text/plain' }));
    dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png)}), c => c.charCodeAt(0))], 'dot.png', { type: 'image/png' }));
    dt.items.add(new File([new Uint8Array(64)], 'tool.exe', { type: 'application/x-msdownload' }));
    dt.items.add(new File([new Uint8Array(6e6)], 'huge.pdf', { type: 'application/pdf' }));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor("window.__g2.uploads.length === 4");
  assert.deepEqual(await g("uploads.map(u => [u.name, u.status])"), [['plan.txt', 200], ['dot.png', 200], ['tool.exe', 415], ['huge.pdf', 413]], 'every file is uploaded on its own and judged on its own');
  assert.equal(await js("document.querySelectorAll('.attach-chip').length"), 2, 'only the accepted files become chips');
  assert.ok(await js(toast("Couldn't attach tool.exe")) && await js(toast("Couldn't attach huge.pdf")), 'each rejected file says why, by name');
  assert.ok(await js(toast('not supported')) && await js(toast('too large')), 'the server reason reaches the user');
  assert.equal(await js("document.querySelector('#g2-file-input').value"), '', 'the picker is reset so the same file can be chosen again');
  // Image chip previews; text chip has no preview button.
  assert.equal(await js("document.querySelectorAll('.attach-chip-preview-button').length"), 1);
  await js("document.querySelector('.attach-chip-preview-button').click()");
  assert.equal(await js("document.querySelector('.media-viewer .artifact-image-viewport img')?.alt"), 'dot.png', 'preview shows the clicked image');
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert.equal(await js("!!document.querySelector('.media-viewer')"), false, 'Escape closes the image preview');
  // Removal: the removed file is not sent.
  await js("[...document.querySelectorAll('.attach-chip')].find(c => c.textContent.includes('plan.txt')).querySelector('button[title=Remove]').click()");
  assert.deepEqual(await js("[...document.querySelectorAll('.attach-chip span')].map(n => n.textContent)"), ['dot.png'], 'removal leaves the other file staged');
  await js("(() => { const i = document.querySelector('#chat-input'); i.value = 'Look at this'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chat-send').click(); })()");
  await waitFor("window.__g2.validations.length === 1");
  await delay(300);
  assert.deepEqual(await g('validations[0].attachment_ids'), ['att-2'], 'validation covers only the kept file');
  const send = livePosts().at(-1);
  assert.ok(send, 'the turn was sent');
  assert.deepEqual(JSON.parse(send.body).attachment_ids, ['att-2'], 'the turn carries exactly the kept attachment id, once');
  assert.equal(await js("document.querySelectorAll('.attach-chip').length"), 0, 'chips clear after the send');
  const afterAttachSend = livePosts().length;
  await delay(400);

  // ---- 2. + > Capture screen ----------------------------------------------------------------
  const hasBridge = await js("typeof window.jarvis");
  assert.equal(hasBridge, 'undefined', 'the mocked shell has no native screen-grab bridge, so Capture screen takes the browser path');
  await openChat();
  await js("window.__g2.uploads.length = 0; true");
  // 2a. Web dialog opens, Escape closes, focus lands inside the dialog. A browser without
  // CaptureController (a phone, Safari, Firefox) gets the upload-only dialog.
  await js("window.__realCaptureController = window.CaptureController; delete window.CaptureController; true");
  await plus('Capture screen');
  await waitFor("!!document.querySelector('.screen-capture-dialog')");
  assert.equal(await js("document.querySelector('.screen-capture-dialog').getAttribute('role')"), 'dialog');
  assert.equal(await js("document.activeElement.closest('.screen-capture-dialog') !== null"), true, 'focus moves into the dialog');
  assert.equal(await js("document.querySelector('.screen-capture-choice[data-action=screen]').disabled"), true,
    'without CaptureController the picker path is disabled with an honest note, leaving Upload');
  assert.ok(await js("document.querySelector('.screen-capture-choice[data-action=screen] small').textContent.includes('Upload a screenshot')"));
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert.equal(await js("!!document.querySelector('.screen-capture-dialog')"), false, 'Escape closes the capture dialog');
  assert.equal(await g('uploads.length'), 0, 'cancelling attaches nothing');
  await js("if (window.__realCaptureController) window.CaptureController = window.__realCaptureController; true");
  // 2b. Upload path attaches; a refusal keeps the dialog open with a message.
  await plus('Capture screen');
  await waitFor("!!document.querySelector('.screen-capture-dialog')");
  await js(`(() => { window.__g2.uploadRule = () => ({ status: 415, detail: 'bad image' }); const i = document.querySelector('.screen-capture-file'); const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' })); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor("document.querySelector('.screen-capture-status').textContent.includes('could not be attached')");
  assert.equal(await js("!!document.querySelector('.screen-capture-dialog')"), true, 'a refused screenshot keeps the dialog open to retry');
  await js(`(() => { window.__g2.uploadRule = () => ({}); const i = document.querySelector('.screen-capture-file'); const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' })); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor("!document.querySelector('.screen-capture-dialog')");
  assert.deepEqual(await js("[...document.querySelectorAll('.attach-chip span')].map(n => n.textContent)"), ['shot.png'], 'the uploaded screenshot becomes one chip');
  await js("document.querySelector('.attach-chip button[title=Remove]').click()");

  // 2c. Browser picker path: deny, cancel, success at a 4K size, crop maths, attach full.
  await js(`(() => {
    window.CaptureController = class { setFocusBehavior(mode) { window.__g2.focusMode = mode; } };
    const g = window.__g2; g.display = 'ok';
    navigator.mediaDevices.getDisplayMedia = async opts => {
      g.displayOpts = { video: opts.video, audio: opts.audio, controller: opts.controller instanceof window.CaptureController };
      if (g.display === 'denied') throw new DOMException('no', 'NotAllowedError');
      if (g.display === 'aborted') throw new DOMException('closed', 'AbortError');
      const canvas = document.createElement('canvas'); canvas.width = 3840; canvas.height = 2160;
      const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(30);
      let n = 0; const timer = setInterval(() => { ctx.fillStyle = n++ % 2 ? '#c33' : '#36c'; ctx.fillRect(0, 0, 3840, 2160); ctx.fillStyle = '#fff'; ctx.fillRect(100, 100, 400, 200); }, 50);
      stream.getTracks().forEach(t => { const stop = t.stop.bind(t); t.stop = () => { clearInterval(timer); g.displayStopped = (g.displayStopped || 0) + 1; stop(); }; });
      return stream;
    };
    return true; })()`);
  await js("window.__g2.uploads.length = 0; true");
  const openPicker = async () => { await plus('Capture screen'); await waitFor("!!document.querySelector('.screen-capture-dialog') && !document.querySelector('.screen-capture-choice[data-action=screen]').disabled"); };
  await openPicker();
  await js("window.__g2.display = 'denied'; document.querySelector('.screen-capture-choice[data-action=screen]').click()");
  await waitFor("!document.querySelector('.screen-capture-dialog').hidden && !document.querySelector('.screen-capture-choices').hidden");
  assert.equal(await js("document.querySelector('.screen-capture-status').textContent"), '', 'denied OS/browser permission is a quiet return to the choices');
  assert.equal(await g('uploads.length'), 0);
  await js("window.__g2.display = 'aborted'; document.querySelector('.screen-capture-choice[data-action=screen]').click()");
  await waitFor("document.querySelector('.screen-capture-status').textContent.length > 0");
  assert.equal(await js("document.querySelector('.screen-capture-status').textContent"), 'closed', 'a cancelled/aborted pick says so and returns to the choices');
  assert.equal(await g('focusMode'), 'no-focus-change', 'the capture keeps Kairos in front');
  assert.deepEqual(await g('displayOpts'), { video: true, audio: false, controller: true }, 'one video still, never audio');
  await js("window.__g2.display = 'ok'; document.querySelector('.screen-capture-choice[data-action=screen]').click()");
  await waitFor("!document.querySelector('.screen-capture-review').hidden", 20000);
  assert.ok((await g('displayStopped')) >= 1, 'the screen stream is stopped as soon as the still is taken');
  assert.ok(await js("document.querySelector('.screen-capture-image-wrap img').src.startsWith('blob:')"));
  // Crop: drag over the middle of the preview with real mouse input, then attach the crop.
  await waitFor("document.querySelector('.screen-capture-image-wrap img').complete && document.querySelector('.screen-capture-image-wrap img').naturalWidth === 3840");
  const box = await js("(() => { const r = document.querySelector('.screen-capture-image-wrap img').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()");
  await dbg('mouseMoved', box.l + box.w * 0.25, box.t + box.h * 0.25, { buttons: 0 });
  await dbg('mousePressed', box.l + box.w * 0.25, box.t + box.h * 0.25);
  await dbg('mouseMoved', box.l + box.w * 0.75, box.t + box.h * 0.5);
  await dbg('mouseReleased', box.l + box.w * 0.75, box.t + box.h * 0.5);
  await waitFor("!document.querySelector('[data-action=crop]').disabled");
  await js("document.querySelector('[data-action=crop]').click()");
  await waitFor("window.__g2.uploads.length === 1");
  const crop = await js("(async () => { const up = window.__g2.uploads[0]; return up; })()");
  assert.equal(crop.type, 'image/jpeg');
  assert.ok(/^Screenshot-\d+\.jpg$/.test(crop.name), 'screenshots are named by capture time');
  await waitFor("!document.querySelector('.screen-capture-dialog')");
  assert.deepEqual(await js("[...document.querySelectorAll('.attach-chip span')].map(n => /^Screenshot-\\d+\\.jpg$/.test(n.textContent))"), [true], 'the crop is one chip');
  await js("document.querySelector('.attach-chip button[title=Remove]').click()");
  // The crop covers 50% x 25% of a 3840x2160 capture: 1920x540 at full resolution, not preview size.
  // Verify by decoding what was uploaded (kept by the second capture below with a decode hook).
  await js(`(() => { const real = window.__g2.uploadRule; window.__g2.decoded = []; window.__g2.uploadRule = file => { createImageBitmap(file).then(b => window.__g2.decoded.push([b.width, b.height])); return {}; }; return true; })()`);
  await openPicker();
  await js("document.querySelector('.screen-capture-choice[data-action=screen]').click()");
  await waitFor("!document.querySelector('.screen-capture-review').hidden", 20000);
  await waitFor("document.querySelector('.screen-capture-image-wrap img').naturalWidth === 3840");
  const box2 = await js("(() => { const r = document.querySelector('.screen-capture-image-wrap img').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()");
  await dbg('mouseMoved', box2.l + box2.w * 0.25, box2.t + box2.h * 0.25, { buttons: 0 });
  await dbg('mousePressed', box2.l + box2.w * 0.25, box2.t + box2.h * 0.25);
  await dbg('mouseMoved', box2.l + box2.w * 0.75, box2.t + box2.h * 0.5);
  await dbg('mouseReleased', box2.l + box2.w * 0.75, box2.t + box2.h * 0.5);
  await waitFor("!document.querySelector('[data-action=crop]').disabled");
  await js("document.querySelector('[data-action=crop]').click()");
  await waitFor("window.__g2.decoded.length === 1");
  const [cw, ch] = await g('decoded[0]');
  assert.ok(Math.abs(cw - 1920) <= 3 && Math.abs(ch - 540) <= 3, `crop is mapped to capture pixels (got ${cw}x${ch}, want 1920x540)`);
  await waitFor("!document.querySelector('.screen-capture-dialog')");
  await js("document.querySelector('.attach-chip button[title=Remove]')?.click()");
  // Full image keeps the whole 4K frame; Retake returns to the choices.
  await openPicker();
  await js("document.querySelector('.screen-capture-choice[data-action=screen]').click()");
  await waitFor("!document.querySelector('.screen-capture-review').hidden", 20000);
  await js("document.querySelector('[data-action=retake]').click()");
  assert.equal(await js("document.querySelector('.screen-capture-choices').hidden"), false, 'Retake returns to the choices');
  await js("document.querySelector('.screen-capture-choice[data-action=screen]').click()");
  await waitFor("!document.querySelector('.screen-capture-review').hidden", 20000);
  await waitFor("document.querySelector('.screen-capture-image-wrap img').naturalWidth === 3840");
  await js("document.querySelector('[data-action=full]').click()");
  await waitFor("window.__g2.decoded.length === 2");
  assert.deepEqual(await g('decoded[1]'), [3840, 2160], 'Attach full image keeps the full capture resolution');
  await waitFor("!document.querySelector('.screen-capture-dialog')");
  await js("document.querySelector('.attach-chip button[title=Remove]')?.click(); window.__g2.uploadRule = () => ({}); true");
  // Closing mid-review stops everything and attaches nothing.
  await openPicker();
  await js("document.querySelector('.screen-capture-choice[data-action=screen]').click()");
  await waitFor("!document.querySelector('.screen-capture-review').hidden", 20000);
  const uploadsBeforeClose = await g('uploads.length');
  await js("document.querySelector('.screen-capture-close').click()");
  assert.equal(await js("!!document.querySelector('.screen-capture-dialog')"), false);
  assert.equal(await g('uploads.length'), uploadsBeforeClose, 'closing the review attaches nothing');
  // 2d. Desktop-shell path (window.jarvis.screenGrab): success, cancel, failure, malformed data.
  await js(`(() => { const g = window.__g2; g.grab = async () => 'data:image/png;base64,${png}';
    window.jarvis = { screenGrab: { capture: () => g.grab() } }; g.uploads.length = 0; return true; })()`);
  await plus('Capture screen');
  await waitFor("window.__g2.uploads.length === 1");
  assert.equal(await g('uploads[0].type'), 'image/png');
  assert.ok(/^Screenshot-\d+\.png$/.test(await g('uploads[0].name')), 'the native grab is attached directly with no dialog');
  assert.equal(await js("!!document.querySelector('.screen-capture-dialog')"), false);
  await js("document.querySelector('.attach-chip button[title=Remove]').click(); window.__g2.grab = async () => null; true");
  await plus('Capture screen'); await delay(300);
  assert.equal(await g('uploads.length'), 1, 'a cancelled native grab attaches nothing');
  await js("window.__g2.grab = async () => { throw new Error('Screen recording permission denied'); }; true");
  await plus('Capture screen');
  await waitFor(toast("Couldn't capture screen: Screen recording permission denied"));
  await clearToasts();
  await js("window.__g2.grab = async () => 'data:text/html;base64,PHNjcmlwdD4='; true");
  await plus('Capture screen');
  await waitFor(toast('Invalid screenshot data'));
  assert.equal(await g('uploads.length'), 1, 'non-image data is refused before upload');
  await js("delete window.jarvis; true");
  await clearToasts();

  // ---- 3. + > Documents, Workspace, Integrations, Browse the web, Use a skill, Mode ---------
  await openChat();
  await plus('Documents');
  await waitFor("!!document.querySelector('.documents-popover .documents-menu-row')");
  const docCount = await js("document.querySelectorAll('.documents-popover .documents-menu-row').length");
  assert.ok(docCount >= 2, 'Documents lists the library');
  await js("(() => { const s = document.querySelector('.documents-menu-search'); s.value = 'zzz-none'; s.dispatchEvent(new Event('input')); })()");
  assert.equal(await js("document.querySelector('.documents-menu-empty')?.textContent"), 'No documents match this search.', 'a search with no match says so');
  await js("(() => { const s = document.querySelector('.documents-menu-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()");
  await js("document.querySelector('#chat-input').value = 'Summarise:'; document.querySelector('.documents-menu-row').click()");
  await waitFor("document.querySelector('#chat-input').value.includes('[Document: ')");
  const inserted = await js("document.querySelector('#chat-input').value");
  assert.ok(inserted.startsWith('Summarise:\n\n[Document: ') && inserted.includes('Make the important things easy to find.'), 'the document text is appended to the draft');
  assert.equal(inserted.split('[Document: ').length, 2, 'inserted exactly once');
  assert.equal(await js("!!document.querySelector('.documents-popover')"), false, 'the picker closes after insertion');
  assert.equal(livePosts().length, afterAttachSend, 'inserting a document does not send');
  await js("document.querySelector('#chat-input').value = ''; true");

  await plus('Workspace');
  await waitFor("!document.querySelector('.workspace-path-input').closest('.modal-backdrop').classList.contains('hidden') && document.querySelectorAll('.workspace-row').length > 1");
  assert.equal(await js("document.querySelector('.workspace-path-input').value"), 'C:\\Users\\Alex\\Documents');
  await js("document.querySelectorAll('.workspace-row')[1].click()");
  await js("[...document.querySelectorAll('.modal-footer button')].find(b => b.textContent === 'Use this folder').click()");
  await delay(300);
  const ws = writes.findLast(w => /\/api\/sessions\/s1\/workspace$/.test(w.path));
  assert.ok(ws && JSON.parse(ws.body).path, 'Use this folder saves the chosen folder to this chat');
  assert.equal(await js("document.querySelector('.workspace-path-input').closest('.modal-backdrop').classList.contains('hidden')"), true, 'the modal closes after saving');
  assert.ok(await js("!!document.querySelector('.workspace-pill')"), 'the workspace pill shows the folder');
  await js("document.querySelector('.workspace-pill button').click()");
  await delay(300);
  assert.equal(JSON.parse(writes.findLast(w => /\/api\/sessions\/s1\/workspace$/.test(w.path)).body).path, null, 'clearing the pill clears the workspace');

  await plus('Integrations');
  await waitFor("[...document.querySelectorAll('.workspace-row input[type=checkbox]')].length >= 2");
  await js("[...document.querySelectorAll('.workspace-row')].find(r => r.textContent.includes('Sentry')).querySelector('input').click()");
  await js("[...document.querySelectorAll('.modal-footer button')].find(b => b.textContent === 'Save').click()");
  await delay(300);
  const integ = writes.findLast(w => /\/api\/sessions\/s1\/integrations$/.test(w.path));
  assert.ok(integ, 'Save posts this chat\'s integration selection');
  assert.ok(Array.isArray(JSON.parse(integ.body).enabled_integration_ids) || JSON.parse(integ.body).enabled_integration_ids === null, 'a selection or the ordinary default is sent');

  await plus('Browse the web');
  await waitFor("!!document.querySelector('.browser-pane, .chat-browser-pane, [class*=browser-pane]')");
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  await delay(200);
  await openChat();

  // Mode: the permission control lives on the composer (Base/Auto).
  assert.ok(await js("!!document.querySelector('.chat-input-left [aria-label*=ermission], .chat-input-left .permission-control, #permission-control')"), 'the Mode control is on the composer');

  // ---- 4. Dictation ---------------------------------------------------------------------------
  const resetVoice = () => js("(() => { const g = window.__g2; g.transcribes.length = 0; g.gum.length = 0; g.stopped = 0; g.recorders = 0; g.mic = 'ok'; g.transcript = 'hello world'; g.transcribeError = null; g.transcribeDelay = 0; g.speech.active_model = 'base.en'; return true; })()");
  const micIdle = "(() => { const m = document.querySelector('#chat-mic'); return !m.classList.contains('recording') && !m.classList.contains('busy') && !m.disabled; })()";
  await openChat(); await resetVoice();
  assert.equal(await js("document.querySelector('#chat-mic').hidden"), false, 'recording is supported here');
  if (await js("matchMedia('(min-width: 769px)').matches")) {
    // Desktop redesign: no idle mic on the prompt; Dictate is in the + menu.
    assert.equal(await js("getComputedStyle(document.querySelector('#chat-mic')).display"), 'none', 'the desktop prompt has no idle mic');
    await js("document.body.click(); document.querySelector('#overflow-plus-btn').click()");
    assert.ok(await js("(() => { const d = [...document.querySelectorAll('#overflow-menu .overflow-menu-item')].find(b => b.textContent.trim() === 'Dictate'); return !!d && !d.hidden && d.getClientRects().length > 0; })()"), 'Dictate is in the + menu');
    await js("document.body.click()");
  }
  const livePostsBefore = livePosts().length;
  // 4a. Start, stop: text lands once, appended to the draft; the device is released; nothing is sent.
  await js("(() => { const i = document.querySelector('#chat-input'); i.value = 'Draft'; i.dispatchEvent(new Event('input')); })()");
  await js("document.querySelector('#chat-mic').click()");
  await waitFor("document.querySelector('#chat-mic').classList.contains('recording')");
  assert.notEqual(await js("getComputedStyle(document.querySelector('#chat-mic')).display"), 'none', 'the mic shows while recording');
  assert.equal(await js("document.querySelector('#chat-mic').getAttribute('aria-label')"), 'Stop recording and transcribe');
  assert.deepEqual(await g('gum[0]'), { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 'the mic is opened with echo cancellation and noise suppression');
  assert.equal(await g('recorders'), 1, 'one recorder, started immediately');
  await js("document.querySelector('#chat-mic').click()");
  await waitFor("document.querySelector('#chat-input').value === 'Draft hello world'");
  await waitFor(micIdle);
  assert.equal(await g('transcribes.length'), 1, 'one transcription request');
  assert.ok((await g('transcribes[0].bytes')) > 1000 && (await g('transcribes[0].name')) === 'speech.wav', 'a decoded WAV is what is uploaded');
  assert.ok((await g('stopped')) >= 1, 'the microphone is released after dictation');
  assert.equal(livePosts().length, livePostsBefore, 'dictation never sends the message');
  assert.equal(await js("document.querySelector('#chat-mic').getAttribute('aria-label')"), 'Dictate a message');
  // 4b. Slow transcription: the button is busy and a second click cannot double-submit.
  await resetVoice(); await js("window.__g2.transcribeDelay = 600; document.querySelector('#chat-input').value = ''; true");
  await js("document.querySelector('#chat-mic').click()");
  await waitFor("document.querySelector('#chat-mic').classList.contains('recording')");
  await js("document.querySelector('#chat-mic').click()");
  await waitFor("document.querySelector('#chat-mic').classList.contains('busy')");
  assert.equal(await js("document.querySelector('#chat-mic').disabled"), true, 'busy disables the button');
  await js("document.querySelector('#chat-mic').click(); document.querySelector('#chat-mic').click()");
  await waitFor("document.querySelector('#chat-input').value === 'hello world'");
  await waitFor(micIdle);
  assert.equal(await g('transcribes.length'), 1, 'repeated clicks while transcribing do not duplicate the request or the text');
  // 4c. Silence, and a transcription failure: nothing inserted, button recovers, nothing sent.
  for (const [setup, expected] of [["g.transcript = ''", 'No speech was picked up.'], ["g.transcribeError = 'The speech model failed to load'", 'The speech model failed to load']]) {
    await resetVoice(); await clearToasts();
    await js(`(() => { const g = window.__g2; ${setup}; const i = document.querySelector('#chat-input'); i.value = 'keep me'; return true; })()`);
    await js("document.querySelector('#chat-mic').click()");
    await waitFor("document.querySelector('#chat-mic').classList.contains('recording')");
    await js("document.querySelector('#chat-mic').click()");
    await waitFor(toast(expected));
    await waitFor(micIdle);
    assert.equal(await js("document.querySelector('#chat-input').value"), 'keep me', 'a failed dictation leaves the draft untouched');
  }
  assert.equal(livePosts().length, livePostsBefore, 'no failure path sends anything');
  // 4d. Denied access, no device, no speech model, engine missing.
  for (const [mode, text] of [['denied', 'Microphone access was blocked. Allow it and try again.'], ['none', 'No microphone is available.']]) {
    await resetVoice(); await clearToasts(); await js(`window.__g2.mic = ${JSON.stringify(mode)}; true`);
    await js("document.querySelector('#chat-mic').click()");
    await waitFor(toast(text));
    assert.ok(await js(micIdle) && !(await js("document.querySelector('#chat-mic').classList.contains('recording')")), mode + ' leaves the mic idle');
    assert.equal(await g('transcribes.length'), 0);
    assert.equal(await g('recorders'), 0, 'no recording ever started');
  }
  await resetVoice(); await clearToasts();
  await delay(1100);
  await js("window.__g2.speech.active_model = null; import('/static/js/voiceInput.js').then(m => m.refreshSpeechStatus())");
  await js("document.querySelector('#chat-mic').click()");
  await waitFor(toast('No speech model downloaded yet'));
  assert.equal(await g('gum.length'), 0, 'the model is checked before the device is opened');
  // 4e. A saved input device that has been unplugged falls back to the default and forgets the stale choice.
  await delay(1100);  // api.js shares identical GETs for 1 s, so let the previous speech status expire
  await resetVoice(); await js("window.__g2.mic = 'lost-saved'; import('/static/js/voiceInput.js').then(m => { m.refreshSpeechStatus(); m.setInputDevice('unplugged-mic'); return true; })");
  await js("document.querySelector('#chat-mic').click()");
  await waitFor("document.querySelector('#chat-mic').classList.contains('recording')");
  assert.deepEqual(await g('gum.map(a => !!a.deviceId)'), [true, false], 'first tries the saved device exactly, then the default');
  assert.deepEqual(await g('gum[0].deviceId'), { exact: 'unplugged-mic' });
  assert.equal(await js("import('/static/js/voiceInput.js').then(m => m.getInputDevice())"), '', 'the stale device choice is cleared');
  // 4f. Cancel mid-recording (navigating away or Escape-style cancel): device released, no request, no text.
  const stoppedBefore = await g('stopped');
  await js("document.querySelector('#chat-mic').dispatchEvent(new Event('kairos:cancel-dictation'))");
  await waitFor(micIdle);
  assert.ok((await g('stopped')) > stoppedBefore, 'cancel releases the microphone');
  assert.equal(await g('transcribes.length'), 0, 'a cancelled recording is never transcribed');
  // Leaving the chat while recording also releases the device.
  await resetVoice();
  await js("document.querySelector('#chat-mic').click()");
  await waitFor("document.querySelector('#chat-mic').classList.contains('recording')");
  await navigate('notes');
  await waitFor("window.__g2.stopped >= 1");
  assert.equal(await g('transcribes.length'), 0, 'navigating away mid-recording abandons it without a request');
  await openChat();

  // ---- 5. Open Mic from the real button -------------------------------------------------------
  await resetVoice(); await clearToasts();
  await js("document.querySelector('#chat-openmic').click()");
  await waitFor("document.querySelector('#chat-openmic').dataset.micState === 'listening'");
  assert.ok(await js("document.querySelector('#chat-openmic').classList.contains('active') && document.querySelector('#chat-main').classList.contains('open-mic')"));
  assert.equal(await g('recorders'), 0, 'an open mic listens without recording until speech is heard');
  assert.equal(await g('gum[0].echoCancellation'), true, 'echo cancellation guards against hearing the assistant');
  const omOn = writes.findLast(w => /\/api\/sessions\/s1\/open-mic$/.test(w.path));
  assert.deepEqual(JSON.parse(omOn.body), { active: true }, 'the session is told Open Mic began');
  await js("document.querySelector('#chat-openmic').click()");
  await waitFor("!document.querySelector('#chat-openmic').classList.contains('active')");
  assert.ok((await g('stopped')) >= 1, 'ending Open Mic releases the microphone');
  for (let i = 0; i < 50 && JSON.parse(writes.findLast(w => /\/api\/sessions\/s1\/open-mic$/.test(w.path)).body).active; i++) await delay(100);
  const omOff = writes.findLast(w => /\/api\/sessions\/s1\/open-mic$/.test(w.path));
  assert.deepEqual(JSON.parse(omOff.body), { active: false }, 'the session is told Open Mic ended');
  assert.equal(await js("document.querySelector('#chat-main').classList.contains('open-mic')"), false);

  // ---- 9. Fork and model fallback in the real transcript -----------------------------------
  const failedSession = partial => ({ id: 's1', title: 'A clearer direction', updated_at: 1, model_endpoint_id: 'm1', compactions: [], enabled_integration_ids: null, workspace_dir: null,
    messages: [
      { role: 'user', content: 'one', ts: 1, status: 'complete' }, { role: 'assistant', content: 'answer one', ts: 2, status: 'complete' },
      { role: 'user', content: 'please do it', ts: 3, status: 'complete' },
      { role: 'assistant', content: partial ? 'half an answ' : '', ts: 4, status: 'failed', failure_kind: 'model_error', failure_model_endpoint_id: 'm1', failure_model_name: 'Claude', failure_had_tools: false }] });
  await js(`window.__g2.session = (${failedSession.toString()})(false); window.__g2.posts.length = 0; true`);
  await openChat();
  await waitFor("document.querySelectorAll('#chat-messages > .msg').length === 4 && !!document.querySelector('#chat-messages .msg-fork')");
  assert.equal(await js("document.querySelectorAll('#chat-messages .msg-fork').length"), 4, 'every saved message offers Fork');
  assert.equal(await js("document.querySelectorAll('#chat-messages .msg-fallback').length"), 1, 'only the failed last reply offers another model');
  assert.equal(await js("document.querySelector('.msg-fallback').textContent"), 'Try another model', 'an empty failure offers a retry, not a continue');
  assert.equal(await js("document.querySelectorAll('#chat-messages .msg-regenerate').length"), 1);
  // A model that keeps failing gets a suggestion with the cost of switching; showing it switches nothing.
  await waitFor("!!document.querySelector('.chat-switch-suggestion')");
  const suggestion = await js("document.querySelector('.chat-switch-suggestion span').textContent");
  assert.ok(suggestion.startsWith('Claude has failed 6 of its last 10 runs, mostly overloaded.') && suggestion.includes('without the prompt cache'), suggestion);
  assert.deepEqual(await g('posts'), [], 'advice alone posts nothing');
  // Fork from the first answer: one request, source untouched (no rewind), the new chat opens.
  await js("document.querySelectorAll('#chat-messages .msg-fork')[1].click()");
  await waitFor("window.__g2.posts.length === 1");
  assert.deepEqual(await g('posts'), [['fork', { through_index: 1 }]], 'Fork posts the chosen message index once and cuts nothing from the source');
  await waitFor(toast('Chat forked from this message'));
  assert.equal(await js("document.querySelectorAll('.toast').length > 0"), true);
  await js("window.__g2.posts.length = 0; true");
  // Fallback with a draft present is refused: nothing is cut, nothing is sent.
  await openChat();
  await waitFor("!!document.querySelector('.msg-fallback')");
  const liveBeforeFallback = livePosts().length;
  await js("document.querySelector('#chat-input').value = 'half-typed draft'; document.querySelector('.msg-fallback').click()");
  await waitFor("document.querySelectorAll('.chat-fallback-choices button').length > 0");
  const options = await js("[...document.querySelectorAll('.chat-fallback-choices button')].map(b => b.textContent)");
  assert.ok(options.length >= 2 && !options.some(t => t.startsWith('Claude')), 'the failed model is not offered; others are: ' + options.join(' | '));
  // Ranked by recent success, then speed: m3 (none failed) before m2 (3 of 12 failed), each with its note.
  assert.deepEqual(await js("[...document.querySelectorAll('.chat-fallback-choices button')].slice(0, 2).map(b => b.dataset.endpointId)"), ['m3', 'm2']);
  assert.equal(await js("document.querySelector('.chat-fallback-note').textContent"), '9 runs, none failed, first output 1.2 s');
  assert.ok((await js("document.querySelector('.chat-fallback-cost').textContent")).includes('without the prompt cache'));
  await js("document.querySelectorAll('.toast').forEach(t => t.remove()); document.querySelector('.chat-fallback-choices button').click()");
  await waitFor(toast('Finish or clear the current draft before retrying the failed message.'));
  assert.deepEqual(await g('posts'), [], 'a refused retry posts nothing');
  assert.equal(livePosts().length, liveBeforeFallback, 'and sends nothing');
  // Clear the draft: one fallback request (index of the failed reply) then exactly one resend of the same text.
  await js("document.querySelector('#chat-input').value = ''; document.querySelector('.chat-fallback-choices button').click()");
  await waitFor("window.__g2.posts.some(p => p[0] === 'fallback')");
  await delay(600);
  const fallbackPosts = await g("posts.filter(p => p[0] === 'fallback')");
  assert.equal(fallbackPosts.length, 1, 'one fallback request even though the button was clicked once');
  assert.equal(fallbackPosts[0][1].failed_index, 3, 'the failed reply is identified by its index');
  assert.ok(['m2', 'm3'].includes(fallbackPosts[0][1].model_endpoint_id));
  const resent = livePosts().slice(liveBeforeFallback);
  assert.equal(resent.length, 1, 'the retried message is sent exactly once');
  assert.equal(JSON.parse(resent[0].body).message, 'please do it', 'the original text is what is re-sent');
  // A partial failure can only switch and continue: model switch, no rewind, no resend.
  await js(`window.__g2.session = (${failedSession.toString()})(true); window.__g2.posts.length = 0; true`);
  await delay(1100);
  await openChat();
  await waitFor("document.querySelector('.msg-fallback')?.textContent === 'Switch model'");
  const liveBeforeSwitch = livePosts().length;
  await js("document.querySelector('.msg-fallback').click()");
  await waitFor("!!document.querySelector('.chat-fallback-choices button')");
  assert.ok((await js("document.querySelector('.chat-fallback-panel strong').textContent")).startsWith('Continue with another model'));
  await js("document.querySelector('.chat-fallback-choices button').click()");
  await waitFor("window.__g2.posts.some(p => p[0] === 'model')");
  await delay(400);
  assert.deepEqual(await g("posts.map(p => p[0])"), ['model'], 'switching keeps the partial attempt: no fallback, no rewind');
  assert.equal(livePosts().length, liveBeforeSwitch, 'switching sends nothing by itself');
  await js("window.__g2.session = null; window.__g2.posts.length = 0; true");

  // ---- 10. Cheap app-side benchmarks (printed as BENCH lines; no assertions on speed) -----------
  const bench = [];
  const timeIt = async (name, fn) => { const t = Date.now(); await fn(); bench.push([name, Date.now() - t]); };
  await js(`window.__g2.session = { id: 's1', title: 'Long chat', updated_at: 1, model_endpoint_id: 'm1', compactions: [], enabled_integration_ids: null, workspace_dir: null,
    messages: Array.from({ length: 1000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', ts: i + 1, status: 'complete', content: 'Message ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(8) })) }; true`);
  await timeIt('open_1000_message_chat_ms', async () => { await openChat(); await waitFor("document.querySelectorAll('#chat-messages > .msg').length >= 1000", 30000); });
  bench.push(['dom_nodes_after_1000_messages', await js("document.querySelectorAll('*').length")]);
  await js("window.__g2.session = null; true");
  await openChat();
  await timeIt('send_to_first_visible_reply_ms_mocked_backend', async () => {
    await js("(() => { const i = document.querySelector('#chat-input'); i.value = 'Benchmark message'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chat-send').click(); })()");
    await waitFor("[...document.querySelectorAll('#chat-messages .msg')].some(m => m.textContent.includes('Tab build request received.'))", 15000);
  });
  await delay(1100);
  await timeIt('dictation_stop_to_text_inserted_ms_stubbed_engine', async () => {
    await js("window.__g2.mic = 'ok'; window.__g2.speech.active_model = 'base.en'; import('/static/js/voiceInput.js').then(m => m.refreshSpeechStatus()); document.querySelector('#chat-input').value = ''; true");
    await js("document.querySelector('#chat-mic').click()");
    await waitFor("document.querySelector('#chat-mic').classList.contains('recording')");
    await js("window.__t0 = performance.now(); document.querySelector('#chat-mic').click()");
    await waitFor("document.querySelector('#chat-input').value === 'hello world'");
  });
  console.log('BENCH ' + bench.map(([k, v]) => `${k}=${v}`).join(' '));

  // ---- 11. Requests per chat open/switch and idle cost (EFFICIENCY lines, with regression bounds) -------------
  // Bounds carry margin over the measured numbers (E2/E3, 2026-10-27); the targets are open <= 8, switch <= 6, idle < 6/min.
  const tally = from => { const counts = {}; for (const r of reads.slice(from)) counts[r.path] = (counts[r.path] || 0) + 1; return counts; };
  const quiet = async ms => { await delay(ms); };
  const noRepeats = (counts, label) => assert.deepEqual(Object.entries(counts).filter(([path, n]) => n > 1 && !/^\/api\/computer/.test(path)), [], label + ' reads no path twice: ' + JSON.stringify(counts));
  demoState.stoppedOwners = ['chat:s1'];  // a finished computer: nothing is running, so this is the idle case
  await navigate('home'); await quiet(1500);
  let mark = reads.length, wmark = writes.length;
  await navigate('chat', { sessionId: 's1' });
  await waitFor("document.querySelectorAll('#chat-messages > .msg').length > 0"); await quiet(2600);
  const openReads = tally(mark);
  console.log('EFFICIENCY chat_open_requests total=' + Object.values(openReads).length + ' GETs=' + (reads.length - mark) + ' writes=' + (writes.length - wmark) + ' ' + JSON.stringify(openReads));
  noRepeats(openReads, 'opening a chat from Home');
  assert.ok(reads.length - mark <= 12, 'opening a chat from Home is at most 12 GETs (3 are the closed computer), got ' + (reads.length - mark));
  assert.equal(writes.length - wmark, 0, 'opening a chat writes nothing');
  mark = reads.length;
  await navigate('chat', { sessionId: 's2' }).catch(() => {}); await quiet(2600);
  const switchReads = tally(mark);
  console.log('EFFICIENCY chat_switch_requests GETs=' + (reads.length - mark) + ' ' + JSON.stringify(switchReads));
  noRepeats(switchReads, 'switching chats');
  assert.ok(reads.length - mark <= 9, 'switching chats is at most 9 GETs, got ' + (reads.length - mark));
  await navigate('chat', { sessionId: 's1' }); await waitFor("document.querySelectorAll('#chat-messages > .msg').length > 0"); await quiet(3000);
  mark = reads.length; wmark = writes.length;
  const idleStart = Date.now(); await quiet(30000);
  const idleSecs = (Date.now() - idleStart) / 1000;
  const idleReads = reads.length - mark;
  console.log(`EFFICIENCY chat_idle_30s GETs=${idleReads} writes=${writes.length - wmark} per_minute=${Math.round(idleReads * 60 / idleSecs)} ${JSON.stringify(tally(mark))}`);
  const idleTally = tally(mark);
  assert.ok((idleTally['/api/computer'] || 0) <= 2, 'an idle chat polls the computer at most twice in 30 s: ' + JSON.stringify(idleTally));
  assert.ok((idleTally['/api/sessions/s1'] || 0) <= 2, 'an idle chat re-reads its session at most twice in 30 s: ' + JSON.stringify(idleTally));
  assert.equal(writes.length - wmark, 0, 'an idle chat writes nothing');
  assert.ok(idleReads <= 14, 'an idle chat (shell pollers included) stays at or under 14 GETs per 30 s, got ' + idleReads);
  // Hidden tab: the chat's own pollers stop. (The shell's 30 s pollers also skip while hidden; 8 s window.)
  await js("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); true");
  mark = reads.length; await quiet(8000);
  const hiddenReads = tally(mark);
  await js("delete document.hidden; true");
  console.log('EFFICIENCY chat_hidden_8s GETs=' + (reads.length - mark) + ' ' + JSON.stringify(hiddenReads));
  assert.deepEqual(Object.keys(hiddenReads), [], 'a hidden tab makes no requests: ' + JSON.stringify(hiddenReads));
  // api.js read sharing (E2): concurrent identical GETs make one request; a write clears the share; a signal opts out.
  await delay(1200);
  const share = await js(`(async () => { const m = await import('/static/js/api.js'); const real = window.fetch; let n = 0;
    window.fetch = (...a) => { n++; return real(...a); };
    try {
      await Promise.all([m.api('/api/tasks'), m.api('/api/tasks'), m.api('/api/tasks')]); const concurrent = n; n = 0;
      await m.api('/api/tasks'); const soon = n; n = 0;
      await m.api('/api/chat/live/stop', { method: 'POST', body: JSON.stringify({ session_id: 'none' }) }).catch(() => {});
      n = 0; await m.api('/api/tasks'); const afterWrite = n; n = 0;
      await Promise.all([m.api('/api/tasks', { signal: new AbortController().signal }), m.api('/api/tasks', { signal: new AbortController().signal })]); const withSignal = n;
      const a = await m.api('/api/tasks'), b = await m.api('/api/tasks');
      return { concurrent, soon, afterWrite, withSignal, independent: a !== b };
    } finally { window.fetch = real; } })()`);
  assert.deepEqual(share, { concurrent: 1, soon: 0, afterWrite: 1, withSignal: 2, independent: true }, 'api.js shares identical GETs and clears on writes: ' + JSON.stringify(share));
  // A running computer is the one thing that keeps the 2 s poll going.
  demoState.stoppedOwners = [];
  await navigate('chat', { sessionId: 's1' }); await waitFor("document.querySelectorAll('#chat-messages > .msg').length > 0"); await quiet(1500);
  mark = reads.length; await quiet(7000);
  assert.ok((tally(mark)['/api/computer'] || 0) >= 2, 'a running computer is still polled while the chat is open: ' + JSON.stringify(tally(mark)));
  demoState.stoppedOwners = [];
};

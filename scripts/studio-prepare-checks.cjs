// Prepare post and page-read analytics, in the real Electron engine (run from scripts/browser-smoke.cjs).
//
// Every page here is a local mock (scripts/fixtures/studio-mock/) that mimics the shape of a platform's upload or
// analytics flow; no real site is ever loaded. What is proven:
//   - electron/studio-prepare.js fills each platform's mock upload page (video file, thumbnail, title, description,
//     caption, tags, the AI-content label and YouTube's "not made for kids") as the fields appear, including after the
//     person's own clicks (Instagram's Create and Next);
//   - THE STOP-BEFORE-POST GUARANTEE: across all three flows Kairos clicks nothing but a switch, checkbox or radio; it
//     never clicks a button, link or any element marked final (Post, Publish, Share, Next, Discard), never submits a
//     form, and never falls for a submit button dressed as the AI switch. The test fails if it ever does;
//   - it never acts on a page off the platform's site, and its page script refuses buttons, links and secrets;
//   - electron/studio-pages.js reads a creator page read-only with the profile's own sign-in (a cookie), reports a
//     sign-in redirect and an off-site redirect, and the backend's parser reads the numbers from what it read.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async function studioChecks({ check, assert, root, BrowserWindow, session }) {
  const prepare = require(path.join(root, 'electron', 'studio-prepare.js'));
  const pages = require(path.join(root, 'electron', 'studio-pages.js'));
  const mock = path.join(root, 'scripts', 'fixtures', 'studio-mock');
  const files = { '/youtube/upload': 'youtube-upload.html', '/tiktok/upload': 'tiktok-upload.html', '/instagram/': 'instagram.html',
    '/recorder.js': 'recorder.js', '/tiktokstudio/analytics/123': 'tiktok-analytics.html', '/reel/ABCDE12/': 'instagram-reel.html', '/login': 'login.html' };
  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const signedIn = /(?:^|;\s*)sid=ok\b/.test(req.headers.cookie || '');
    // The analytics pages need the profile's sign-in; without it the platform sends the reader to its sign-in page.
    if ((url.pathname.startsWith('/tiktokstudio/') || url.pathname.startsWith('/reel/')) && !signedIn) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
    if (url.pathname === '/tiktokstudio/analytics/555') { res.writeHead(302, { Location: `http://other.test:${port}/tiktokstudio/analytics/123` }); res.end(); return; }
    const name = files[url.pathname];
    if (!name) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(mock, name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-prepare-smoke-'));
  const video = path.join(dir, '9-16-v1.mp4'), wide = path.join(dir, '16-9-v1.mp4'), cover = path.join(dir, 'post-1.jpg');
  for (const f of [video, wide]) fs.writeFileSync(f, Buffer.from('not really a video, a stand-in file for the picker'));
  fs.writeFileSync(cover, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function page(url) {
    const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { partition: 'kairos-prepare-smoke', sandbox: true, contextIsolation: true } });
    await win.loadURL(url);
    return win;
  }
  const js = (win, code) => win.webContents.executeJavaScript(code);
  // A click the person makes (the page records who clicked).
  const personClicks = (win, selector) => js(win, `(() => { window.__person = true; try { document.querySelector(${JSON.stringify(selector)}).click(); } finally { window.__person = false; } })()`);
  const waitFor = async (win, expression, ms = 8000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await js(win, expression)) return true; await pause(100); }
    throw new Error('timed out waiting for ' + expression);
  };
  // The guarantee, checked after every flow: Kairos never clicked a final control, never submitted, and only ever
  // clicked switches, checkboxes or radios.
  async function neverPressedPost(win) {
    const record = await js(win, '({ clicks: window.__clicks, submits: window.__submits })');
    const mine = record.clicks.filter(c => c.who === 'kairos');
    assert.deepEqual(mine.filter(c => c.final), [], 'Kairos clicked a final control: ' + JSON.stringify(mine));
    assert.equal(record.submits, 0, 'a form was submitted');
    for (const c of mine) {
      assert.ok(['switch', 'checkbox', 'radio'].includes(c.role) || (c.tag === 'INPUT' && ['checkbox', 'radio'].includes(c.type)),
        'Kairos clicked something that is not a switch, checkbox or radio: ' + JSON.stringify(c));
      assert.notEqual(c.tag, 'BUTTON', 'Kairos clicked a button');
      assert.notEqual(c.tag, 'A', 'Kairos clicked a link');
    }
    return mine;
  }

  const reports = [];
  const runFill = (win, plan, timeoutMs = 20000) => prepare.run({ wc: win.webContents, plan, extraHosts: ['127.0.0.1'], tickMs: 150, timeoutMs,
    report: async body => { reports.push(body); }, log: { error: () => {} } });

  await check('prepare: YouTube page filled (file, title, description, tags, thumbnail, audience, AI label), Publish never pressed', async () => {
    const win = await page(base + '/youtube/upload');
    try {
      const plan = { prep_id: 1, platform: 'youtube', fields: [
        { key: 'file', kind: 'file', path: wide, name: '16-9-v1.mp4' },
        { key: 'title', kind: 'text', value: 'What a black hole hides' },
        { key: 'description', kind: 'text', value: 'Light cannot escape.\n\nChapters\n0:00 Intro\n1:10 The horizon\n\n#space #physics' },
        { key: 'tags', kind: 'text', value: 'space, physics,' },
        { key: 'thumbnail', kind: 'file', path: cover, name: 'post-1.jpg' }],
        toggles: [{ key: 'ai_label' }, { key: 'made_for_kids' }] };
      const running = runFill(win, plan);
      // The person opens Show more, where the tags are.
      await waitFor(win, "!document.getElementById('details').hidden");
      await pause(600);
      await personClicks(win, '#show-more');
      const result = await running;
      assert.deepEqual(result.missing, [], 'everything found: ' + JSON.stringify(result));
      const state = await js(win, `({
        file: document.querySelector('input[name=Filedata]').files[0]?.name,
        thumb: document.getElementById('file-loader').files[0]?.name,
        title: document.querySelector('#title-textarea #textbox').innerText,
        description: document.querySelector('#description-textarea #textbox').innerText,
        chips: [...document.querySelectorAll('#chips .chip')].map(c => c.textContent),
        notForKids: document.querySelector('[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]').getAttribute('aria-checked'),
        forKids: document.querySelector('[name=VIDEO_MADE_FOR_KIDS_MFK]').getAttribute('aria-checked'),
        altered: [...document.querySelectorAll('#altered [role=radio]')].map(r => r.textContent + ':' + r.getAttribute('aria-checked')) })`);
      assert.equal(state.file, '16-9-v1.mp4');
      assert.equal(state.thumb, 'post-1.jpg');
      assert.equal(state.title, 'What a black hole hides', 'the title replaced the file name YouTube put there');
      assert.equal(state.description.replace(/\s+/g, ' ').trim(), plan.fields[2].value.replace(/\s+/g, ' ').trim());
      assert.ok(state.description.includes('0:00 Intro\n1:10 The horizon'), 'the chapter lines stay lines: ' + JSON.stringify(state.description));
      assert.deepEqual(state.chips, ['space', 'physics']);
      assert.deepEqual([state.notForKids, state.forKids], ['true', 'false'], 'not made for kids, never "made for kids"');
      assert.deepEqual(state.altered, ['Yes:true', 'No:false'], 'altered or synthetic content: Yes');
      const mine = await neverPressedPost(win);
      assert.equal(mine.length, 2, 'exactly the two radios: ' + JSON.stringify(mine));
      assert.equal(reports.at(-1).stage, 'done');
    } finally { win.destroy(); }
  });

  await check('prepare: TikTok page filled (file, caption, AI-generated switch), the trap switch and Post never pressed', async () => {
    const win = await page(base + '/tiktok/upload');
    try {
      const plan = { prep_id: 2, platform: 'tiktok', fields: [
        { key: 'file', kind: 'file', path: video, name: '9-16-v1.mp4' },
        { key: 'caption', kind: 'text', value: 'Why is the sky blue? Sunlight scatters.\n\n#sky #science' }], toggles: [{ key: 'ai_label' }] };
      const running = runFill(win, plan);
      await waitFor(win, "!document.getElementById('post').hidden");
      await pause(500);
      await personClicks(win, '#more-btn');
      const result = await running;
      assert.deepEqual(result.missing, []);
      const state = await js(win, `({ file: document.querySelector('input[type=file]').files[0]?.name,
        caption: document.querySelector('.public-DraftEditor-content').innerText,
        ai: document.getElementById('aigc').getAttribute('aria-checked'), trap: document.getElementById('trap').getAttribute('aria-checked') })`);
      assert.equal(state.file, '9-16-v1.mp4');
      assert.equal(state.caption.replace(/\s+/g, ' ').trim(), 'Why is the sky blue? Sunlight scatters. #sky #science', 'the file name TikTok put there is replaced');
      assert.equal(state.ai, 'true');
      assert.equal(state.trap, 'false', 'the submit button dressed as the AI switch was never touched');
      const mine = await neverPressedPost(win);
      assert.deepEqual(mine.map(c => c.role), ['switch']);
    } finally { win.destroy(); }
  });

  await check('prepare: Instagram fills as the person moves through Create and Next; Share never pressed', async () => {
    const win = await page(base + '/instagram/');
    try {
      const plan = { prep_id: 3, platform: 'instagram', fields: [
        { key: 'file', kind: 'file', path: video, name: '9-16-v1.mp4' },
        { key: 'caption', kind: 'text', value: 'Why the sky is blue\n\n#science #sky' }], toggles: [{ key: 'ai_label' }] };
      const running = runFill(win, plan);
      await pause(800);
      assert.equal(await js(win, "document.getElementById('modal').hidden"), true, 'Kairos does not press Create');
      await personClicks(win, '#create');
      await waitFor(win, "!document.querySelector('#step-crop')?.hidden");
      await personClicks(win, '#step-crop .next');
      await personClicks(win, '#step-edit .next');
      const result = await running;
      assert.deepEqual(result.missing, []);
      const state = await js(win, `({ file: document.querySelector('#modal input[type=file]').files[0]?.name,
        caption: document.querySelector('[aria-label="Write a caption..."]').innerText, ai: document.getElementById('ai-label').checked })`);
      assert.equal(state.file, '9-16-v1.mp4');
      assert.equal(state.caption.replace(/\s+/g, ' ').trim(), 'Why the sky is blue #science #sky');
      assert.equal(state.ai, true);
      await neverPressedPost(win);
      const record = await js(win, 'window.__clicks.filter(c => c.final).map(c => c.who)');
      assert.deepEqual(record, ['person', 'person'], 'the only final presses are the person\'s two Nexts');
    } finally { win.destroy(); }
  });

  await check('prepare: never acts on a page off the platform\'s site', async () => {
    const win = await page(`http://other.test:${port}/tiktok/upload`);
    try {
      const result = await runFill(win, { prep_id: 4, platform: 'tiktok', fields: [{ key: 'file', kind: 'file', path: video, name: '9-16-v1.mp4' }], toggles: [{ key: 'ai_label' }] }, 2500);
      assert.deepEqual(result.filled, []);
      assert.equal(await js(win, "document.querySelector('input[type=file]').files.length"), 0);
      assert.equal(await js(win, 'window.__clicks.length'), 0);
    } finally { win.destroy(); }
  });

  await check('prepare: the page script refuses buttons, links, final words and secrets; only plain toggles pass', async () => {
    const win = await page(base + '/login');
    try {
      await win.webContents.executeJavaScriptInIsolatedWorld(1010, [{ code: prepare.PAGE_SCRIPT }]);
      await js(win, `document.body.insertAdjacentHTML('beforeend', \`<form id="f">
        <button id="b1" type="submit">Post</button><button id="b2" role="switch" aria-label="AI label">x</button>
        <input id="b3" type="submit" value="Go"><span id="b5" role="switch" aria-label="Share to Facebook"></span>
        <input id="b6" type="checkbox" aria-label="Schedule video"></form>
        <a id="b4" href="#" role="switch" aria-label="AI">x</a><div role="button" id="b7" aria-label="AI-generated content"></div>
        <button id="ok1" type="button" role="switch" aria-label="AI-generated content"></button>
        <span id="ok2" role="switch" aria-label="AI-generated content"></span><label><input id="ok3" type="checkbox"> Add AI label</label>
        <input id="pw" type="password" aria-label="Password">\`)`);
      const verdict = await win.webContents.executeJavaScriptInIsolatedWorld(1010, [{ code:
        "Object.fromEntries(['b1','b2','b3','b4','b5','b6','b7','ok1','ok2','ok3','pw'].map(id => [id, window.__kp.safeToggle(document.getElementById(id))]))" }]);
      assert.deepEqual(verdict, { b1: false, b2: false, b3: false, b4: false, b5: false, b6: false, b7: false, ok1: true, ok2: true, ok3: true, pw: false });
    } finally { win.destroy(); }
  });

  // -- page reads ---------------------------------------------------------------------------------------------------
  const partition = 'kairos-pages-smoke';
  await session.fromPartition(partition).cookies.set({ url: base, name: 'sid', value: 'ok' });
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  const parse = (platform, text) => {
    const out = spawnSync(fs.existsSync(python) ? python : 'python', ['-c',
      'import json,sys; from services.content_studio import page_reads as p; t=sys.stdin.read(); ' +
      'print(json.dumps({"numbers": p.parse(sys.argv[1], t), "mine": p.shows_handle({"text": t}, "@space.kairos"), "theirs": p.shows_handle({"text": t}, "@someone.else")}))', platform],
      { cwd: root, input: text, encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (out.status !== 0) throw new Error('python parse failed: ' + out.stderr);
    return JSON.parse(out.stdout.trim().split('\n').at(-1));
  };

  await check('page read: TikTok analytics read with the profile\'s sign-in, numbers parsed, handle shown', async () => {
    const pageRead = await pages.readPage({ partition, platform: 'tiktok', url: base + '/tiktokstudio/analytics/123', extraHosts: ['127.0.0.1'], settleMs: 10000 });
    assert.ok(pageRead.text.includes('Video views') && pageRead.text.includes('1.2K'), 'the late numbers were waited for: ' + pageRead.text.slice(0, 200));
    const out = parse('tiktok', pageRead.text);
    assert.deepEqual(out.numbers, { views: 1200, total_play_s: 7384, avg_view_duration_s: 7.3, follows_gained: 12, likes: 210, comments: 14, shares: 9 });
    assert.equal(out.mine, true); assert.equal(out.theirs, false);
  });

  await check('page read: Instagram reel insights parsed', async () => {
    const pageRead = await pages.readPage({ partition, platform: 'instagram', url: base + '/reel/ABCDE12/', extraHosts: ['127.0.0.1'], settleMs: 6000 });
    const out = parse('instagram', pageRead.text);
    assert.deepEqual(out.numbers, { views: 3456, total_play_s: 3720, avg_view_duration_s: 5, likes: 120, comments: 8, shares: 5, follows_gained: 3 });
    assert.equal(out.mine, true);
  });

  await check('page read: signed out lands on the sign-in page; an off-site redirect is stopped, not followed', async () => {
    const signedOut = await pages.readPage({ partition: 'kairos-pages-smoke-empty', platform: 'tiktok', url: base + '/tiktokstudio/analytics/123', extraHosts: ['127.0.0.1'], settleMs: 4000 });
    assert.equal(new URL(signedOut.url).pathname, '/login');
    const offSite = await pages.readPage({ partition, platform: 'tiktok', url: base + '/tiktokstudio/analytics/555', extraHosts: ['127.0.0.1'], settleMs: 3000 });
    assert.equal(new URL(offSite.url).hostname, 'other.test');
    assert.equal(offSite.text, '', 'nothing read from the other site');
    await assert.rejects(pages.readPage({ partition, platform: 'tiktok', url: `http://other.test:${port}/tiktokstudio/analytics/123`, settleMs: 1000 }), /not on the platform/);
    await assert.rejects(pages.readPage({ partition, platform: 'youtube', url: 'https://www.youtube.com/', settleMs: 1000 }), /TikTok and Instagram/);
  });

  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
};

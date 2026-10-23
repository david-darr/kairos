// Run only through run-electron-test.cjs, against bg_tasks_scripted.py.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = process.env.KAIROS_BG_URL || argument('bg-url');
const sid = process.env.KAIROS_BG_SESSION || argument('bg-session');
if (!base || !sid) throw Error('Set KAIROS_BG_URL and KAIROS_BG_SESSION from the scripted harness startup line');
const target = new URL(base);
assert(['127.0.0.1', 'localhost'].includes(target.hostname), 'Use the isolated local harness');
assert(!['8420', '8430'].includes(target.port), 'Never use the app or dev port');
const output = path.resolve(__dirname, '../data/review/bg-tasks');
fs.mkdirSync(output, { recursive: true });
const profile = path.resolve(__dirname, '../data/bg-tasks-smoke-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  fs.writeSync(1, 'Background smoke: Electron ready\n');
  const win = new BrowserWindow({ width: 1280, height: 800, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', details => { if (details.level === 'error') fs.writeSync(2, `Renderer: ${details.message}\n`); });
  fs.writeSync(1, 'Background smoke: window created\n');
  const js = async (code, step = code) => {
    const value = await win.webContents.executeJavaScript(`(async () => { try { return await (${code}); } catch (error) { return '__BG_ERROR__:' + error.message; } })()`);
    assert(!(typeof value === 'string' && value.startsWith('__BG_ERROR__:')), `${step}: ${value}`);
    return value;
  };
  const wait = async (condition, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await js(condition, 'Wait: ' + condition)) return; await delay(80); }
    throw Error('Timed out: ' + condition);
  };
  const click = selector => js(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw Error('Missing ' + ${JSON.stringify(selector)}); node.click(); })()`, 'Click: ' + selector);
  const capture = async name => {
    await delay(150);
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const mount = async () => {
    await wait("document.querySelector('#view-content')?.children.length > 0 && !document.querySelector('#view-content').textContent.includes('Loading...')");
    await js(`document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'chat', sessionId: ${JSON.stringify(sid)} } }))`, 'Navigate to chat');
    await wait(`document.querySelector('#chat-messages[data-session-id="${sid}"]')`);
    await js("(() => { window.bgAlerts = 0; window.alert = () => { window.bgAlerts++; }; })()", 'Install alert counter');
  };
  const reload = async () => {
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    await mount();
    // openSession hands the session to the pill last; wait for it before clicking.
    await wait("!document.querySelector('.bg-tasks').hidden");
  };
  const pill = '.bg-tasks-pill';
  const survey = '.bg-task-row[data-item-id^="claude:survey-"]';
  const command = '.bg-task-row[data-item-id^="claude:slow-"]';
  const agent = '.bg-task-row[data-item-id^="card:"]';
  try {
    fs.writeSync(1, 'Background smoke: loading shell\n');
    await win.loadURL(base); await mount();
    await js("(() => { const input = document.querySelector('#chat-input'); input.value = 'Start the background jobs'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    const sentAt = Date.now();
    await click('#chat-send');
    await wait("document.querySelector('.bg-tasks-caption')?.textContent.includes('running in background') && !document.querySelector('.bg-tasks').hidden", 10000);
    // The model connection itself may take time to initialize; the three
    // stream tasks must be visible within 3 seconds of its first response.
    await wait("document.querySelector('#chat-messages')?.textContent.includes('Starting two background jobs.')");
    await wait("Number(document.querySelector('.bg-tasks-caption').textContent.match(/^[0-9]+/)[0]) >= 3", 3000);
    await capture('desktop-pill'); await click(pill);
    await wait(`document.querySelector(${JSON.stringify(survey)}) && document.querySelector(${JSON.stringify(command)}) && document.querySelector(${JSON.stringify(agent)})`);
    assert(await js("[...document.querySelectorAll('.bg-task-status')].some(n => n.textContent === 'Running')"), 'List contains Running rows');
    const before = await js("[...document.querySelectorAll('.bg-task-elapsed')].map(n => n.textContent).join(',')");
    await delay(1100);
    assert.notEqual(await js("[...document.querySelectorAll('.bg-task-elapsed')].map(n => n.textContent).join(',')"), before, 'Elapsed time ticks');
    await capture('desktop-list');
    assert(await js("document.querySelector('.bg-tasks-panel').textContent.includes('<img src=x onerror=alert(1)>')"), 'XSS label is literal text');
    assert.equal(await js("document.querySelectorAll('.bg-tasks-panel img').length + window.bgAlerts"), 0, 'XSS label creates no images or alerts');
    await click(survey);
    await wait("document.querySelector('.bg-task-steps')?.textContent.includes('Grep')", 12000);
    assert(await js("['Prompt', 'Steps'].every(label => [...document.querySelectorAll('.bg-task-section-heading')].some(n => n.textContent === label))"), 'Subagent detail has Prompt and Steps headings');
    assert(await js("document.querySelector('.bg-task-usage')?.textContent === '100 tokens · 1 tool use · 3s'"), 'Usage uses plain words and middle dots');
    await capture('desktop-subagent-detail');
    await click('.bg-task-back'); await click(command);
    await wait("document.querySelector('.bg-task-output')?.textContent.includes('Slow test')");
    assert(await js("['Command', 'Output'].every(label => [...document.querySelectorAll('.bg-task-section-heading')].some(n => n.textContent === label)) && !document.querySelector('.bg-task-output-note')"), 'Command output has headings and no false truncation note');
    await capture('desktop-command-detail');
    // Reload while commands still run; state must come from the backend.
    assert(Date.now() - sentAt < 35000, 'Reload happens during the command');
    await reload();
    await wait("!document.querySelector('.bg-tasks').hidden");
    assert(await js("document.querySelector('.bg-tasks-caption').textContent.includes('running')"), 'Running items survive reload');
    win.setContentSize(390, 844);
    await reload();
    await wait("!document.querySelector('.bg-tasks').hidden");
    await capture('phone-pill');
    const above = await js("(() => { const pill = document.querySelector('.bg-tasks-pill').getBoundingClientRect(), input = document.querySelector('#chat-input').getBoundingClientRect(); return pill.height >= 44 && pill.bottom <= input.top; })()");
    assert(above, 'Phone pill sits above the composer and is at least 44px');
    await click(pill);
    await wait("document.querySelector('.ms-sheet[open] .bg-tasks-list')");
    assert.equal(await js("[...document.querySelectorAll('.ms-sheet[open] h2, .ms-sheet[open] h3')].filter(n => n.textContent === 'Background tasks').length", 'Phone sheet heading count'), 1, 'Phone sheet has one Background tasks heading');
    await capture('phone-sheet-list'); await click(survey);
    await wait("document.querySelector('.ms-sheet[open] .bg-task-detail')");
    await capture('phone-sheet-detail');
    await js("document.querySelector('.ms-sheet').dispatchEvent(new Event('cancel', { cancelable: true }))");
    win.setContentSize(1280, 800); await reload(); await click(pill);
    await wait("[...document.querySelectorAll('.bg-task-row')].some(n => n.dataset.itemId.startsWith('card:') && n.textContent.includes('Done'))", 45000);
    await click(agent);
    await wait("document.querySelector('.bg-task-timeline')?.textContent.includes('Grep')");
    await capture('desktop-agent-timeline');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await wait("document.querySelector('.bg-tasks-caption')?.textContent.includes('finished in background')", 45000);
    await wait("document.querySelector('#chat-messages').textContent.includes('The slow suite passed.') && document.querySelector('#chat-messages').textContent.includes('The repo survey finished: 14 TODOs.')");
    assert(await js("document.querySelectorAll('#chat-messages .bg-followup-caption').length >= 2", 'Follow-up captions'), 'Both follow-ups have After background work captions');
    assert(await js("document.querySelectorAll('.bg-task-note').length >= 4"), 'Transcript has completion notes');
    assert.equal(await js('window.bgAlerts'), 0, 'No alerts after follow-ups');
    await capture('desktop-transcript-notes');
    console.log('PASS: background pill/list/detail, transcript notes, follow-ups, reload, XSS text, phone sheet and agent timeline');
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); await capture('failure').catch(() => {}); win.destroy(); app.exit(1);
  }
});

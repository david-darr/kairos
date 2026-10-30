const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
module.exports = async ({ js, waitFor, delay, navigate, win, demoState, base, capture }) => {
  const q = JSON.stringify, originalSize = win.getContentSize();
  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined,
    botsOnboarding: { welcome_seen: false, tour: { done: true, step: 0, variant: 'simple' }, hints_seen: [], notices: {}, log: [] } });
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)},{method:${q(method)},headers:{'Content-Type':'application/json'},body:${body ? q(JSON.stringify(body)) : 'undefined'}}).then(r=>r.json())`);
  const clickText = (selector, text) => js(`(()=>{const n=[...document.querySelectorAll(${q(selector)})].find(n=>n.textContent.trim()===${q(text)});if(!n)throw new Error('Missing '+${q(text)});n.click();return true;})()`);
  const escape = () => js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  let botId, sid;
  try {
    await win.loadURL(base); await waitFor("!!document.querySelector('.dashboard-core')");
    botId = (await call('/api/agents', 'POST', { name: `Welcome ${Date.now()} ${Math.random()}` })).id;
    sid = (await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Welcome checks' })).id;
    assert.ok(botId && sid);
    await navigate('botsShell', { agentId: botId, sessionId: sid });
    await waitFor("!!document.querySelector('.bots-welcome[open]')");
    assert.equal(await js("document.querySelectorAll('.bots-welcome-dash').length"), 2);
    await js("document.querySelectorAll('.bots-welcome-dash')[1].click()");
    await waitFor("document.querySelectorAll('.bots-setup-row').length===6");
    assert.equal(await js("document.querySelector('[data-check=model] .bots-setup-status').textContent"), 'Ready');
    await js("document.querySelector('[data-check=computer] button').click()");
    await waitFor("!document.querySelector('.bots-welcome') && !!document.querySelector('.modal-backdrop:not(.hidden) .settings-window')");
    assert.ok(demoState.botsOnboarding.welcome_seen);
    await js("document.querySelector('.settings-titlebar-btn[title=Close]').click()");
    await navigate('home'); await navigate('botsShell', { agentId: botId, sessionId: sid }); await delay(300);
    assert.equal(await js("!!document.querySelector('.bots-welcome')"), false, 'welcome shown once');
    await js("import('/static/js/views/settings.js').then(m => m.openSettingsWindow('bots')).then(() => true)"); await waitFor("!!document.querySelector('[data-bots-settings]')");
    for (const [label, value, attr] of [['Interface', 'advanced', 'botsInterface'], ['Send key', 'shift-enter', 'botsSendKey'], ['Chat width', 'wide', 'botsWidth'], ['Chat font', 'serif', 'botsChatFont']]) {
      await js(`(()=>{const node=document.querySelector('[data-bots-settings] select[aria-label="${label}"]');node.value=${q(value)};node.dispatchEvent(new Event('change'));return true;})()`);
      assert.equal(await js(`document.documentElement.dataset[${q(attr)}]`), value);
    }
    // A switch is named by its row's title (aria-labelledby), so find the row and press its switch.
    await js(`(()=>{const row=[...document.querySelectorAll('[data-bots-settings] .bots-switch-row')].find(r=>r.querySelector('.bots-row-title')?.textContent.trim()==='Show tool calls');if(!row)throw new Error('Missing Show tool calls');row.querySelector('[role=switch]').click();return true;})()`);
    assert.equal(await js("document.documentElement.dataset.botsTools"), 'false');
    // Sidebar density belongs to the sidebar's own per-person layout; the open sidebar follows the row at once.
    const densityRow = '[data-bots-settings] select[aria-label="Sidebar density"]';
    await waitFor(`!document.querySelector(${q(densityRow)}).disabled`);
    const densityBefore = await js(`document.querySelector(${q(densityRow)}).value`);
    const setDensity = value => js(`(()=>{const node=document.querySelector(${q(densityRow)});node.value=${q('VALUE')};node.dispatchEvent(new Event('change'));return true;})()`.replace('VALUE', value));
    await setDensity(densityBefore === 'compact' ? 'icons' : 'compact');
    const densityNow = densityBefore === 'compact' ? 'icons' : 'compact';
    await waitFor(`document.documentElement.dataset.botsDensity === ${q(densityNow)}`);
    const person = (await call('/api/auth/status')).username || 'local';
    assert.equal(await js(`JSON.parse(localStorage.getItem(${q(`kairos:bots-sidebar:${encodeURIComponent(person)}`)})).density`), densityNow, 'stored with the sidebar layout');
    await setDensity(densityBefore); await waitFor(`document.documentElement.dataset.botsDensity === ${q(densityBefore)}`);
    // Universal pins (Advanced): a pinned bot leaves the list's Pinned section for the panel above the list, and back.
    await call(`/api/agents/conversations/agent/${botId}`, 'POST', { action: 'pin' });
    await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
    const pinKey = `[data-key="pinned:bot:${botId}"]`;
    await waitFor(`!!document.querySelector('.bots-rail-list .bots-rail-section[data-section=pinned] ${pinKey}')`);
    const pinSwitch = `[...document.querySelectorAll('[data-bots-settings] .bots-switch-row')].find(r=>r.querySelector('.bots-row-title')?.textContent.trim()==='Universal pins')`;
    await js(`${pinSwitch}.querySelector('[role=switch]').click()`);
    await waitFor(`!document.querySelector('.bots-rail-universal').hidden && !!document.querySelector('.bots-rail-universal ${pinKey}') && !document.querySelector('.bots-rail-list .bots-rail-section[data-section=pinned]')`);
    assert.equal(await js("document.documentElement.dataset.botsUniversalPins"), 'true');
    assert.ok(await js("getComputedStyle(document.querySelector('.bots-rail-universal')).overflowY === 'auto'"), 'the panel scrolls on its own');
    await js(`${pinSwitch}.querySelector('[role=switch]').click()`);
    await waitFor(`document.querySelector('.bots-rail-universal').hidden && !!document.querySelector('.bots-rail-list .bots-rail-section[data-section=pinned] ${pinKey}')`);
    await call(`/api/agents/conversations/agent/${botId}`, 'POST', { action: 'unpin' });
    await clickText('[data-bots-settings] button', 'Replay welcome'); await waitFor("!!document.querySelector('.bots-welcome[open]')");
    await clickText('.bots-welcome button', 'Not now');
    await clickText('[data-bots-settings] button', 'Replay tour');
    await waitFor("!!document.querySelector('.bots-spotlight-tip')");
    assert.ok(await js("document.querySelector('.bots-spotlight-tip').getAttribute('aria-modal')==='true'"));
    await escape(); await waitFor("!document.querySelector('.bots-spotlight')");
    for (let i = 0; i < 40 && !demoState.botsOnboarding.tour.done; i++) await delay(50);
    assert.ok(demoState.botsOnboarding.tour.done);
    await js("import('/static/js/views/settings.js').then(m => m.openSettingsWindow('bots')).then(() => true)"); await waitFor("!!document.querySelector('[data-bots-settings]')");
    assert.equal(await js(`document.querySelector('[aria-label="Chat width"]').value`), 'wide');
    await clickText('[data-bots-settings] button', 'Check setup'); await waitFor("document.querySelectorAll('[data-bots-settings] .bots-setup-row').length===6");
    await win.setContentSize(390, 844); await delay(150);
    // Switches keep their size and get a 44px target from an invisible area around them (bots-prefs.css).
    assert.ok(await js("[...document.querySelectorAll('[data-bots-settings] button:not(.bots-switch),[data-bots-settings] input,[data-bots-settings] select,[data-bots-settings] a')].filter(n=>n.getBoundingClientRect().width).every(n=>n.getBoundingClientRect().height>=44)"));
    await capture?.('phone-bots-onboarding');
    // The public notice and hint lanes: wait for a dialog to close, then show one at a time.
    await js("document.dispatchEvent(new CustomEvent('kairos:bots-notice',{detail:{id:'fixture-notice',text:'A check notice'}}))");
    await delay(150); assert.equal(await js("document.querySelector('.bots-notices').hidden"), true, 'notices wait for Settings');
    await js("document.querySelector('.settings-titlebar-btn[title=Close]').click()");
    await waitFor("document.querySelector('.bots-notices:not([hidden])')?.textContent.includes('A check notice')");
    await clickText('.bots-notices button', 'Got it'); await waitFor("document.querySelector('.bots-notices').hidden");
    await js("document.dispatchEvent(new CustomEvent('kairos:bots-notice',{detail:{id:'fixture-notice',text:'Must not return'}}))"); await delay(100);
    assert.equal(await js("document.querySelector('.bots-notices').hidden"), true);
    await js("(()=>{const node=document.createElement('div');node.id='hint-check';node.dataset.richKind='widget';document.querySelector('.bots-chat-host').append(node);return true;})()");
    await waitFor("!!document.querySelector('#hint-check .bots-card-hint')");
    // The hint shows first and saves after, so give the save a moment to land.
    for (let i = 0; i < 40 && !demoState.botsOnboarding.hints_seen.includes('widget'); i++) await delay(50);
    assert.ok(demoState.botsOnboarding.hints_seen.includes('widget'));
    await js("(()=>{const node=document.createElement('div');node.id='hint-check-twice';node.dataset.richKind='widget';document.querySelector('.bots-chat-host').append(node);return true;})()");
    await delay(100); assert.equal(await js("!!document.querySelector('#hint-check-twice .bots-card-hint')"), false);
  } finally {
    await js("document.querySelector('#hint-check')?.remove();document.querySelector('#hint-check-twice')?.remove();import('/static/js/botsTour.js').then(m=>m.closeTour());document.querySelector('.settings-titlebar-btn[title=Close]')?.click()").catch(() => {});
    await navigate('home').catch(() => {});
    if (sid) await call(`/api/agents/${botId}/threads/delete`, 'POST', { thread_ids: [sid] }).catch(() => {});
    if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
    await win.setContentSize(...originalSize); await restore();
  }
};

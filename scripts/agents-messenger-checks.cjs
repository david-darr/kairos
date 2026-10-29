// The old Agents messenger, migrated to the Bots sidebar and bot page (Phase 1 check migration; flag
// --agents-messenger-only). Same intents: real lists of bots (and the team still reachable), exact conversation
// selection, an unsent draft that survives switching and layout changes, pinning and unread on conversations, search,
// the conversation fitting every window size and zoom, phone access to Back and the conversation list with focus kept,
// the Inbox still reachable, the look editor saving through the panel, and an empty state that allows creation without
// fake chats. It makes its own bots and conversations through the fixture API and removes nothing it did not make.
// (The old call/rail-collapse specifics belong to the call check and the density control; the density control is
// covered here by the icons mode keeping the mounted conversation.)
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base }) => {
  const q = JSON.stringify;
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const fill = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const key = (selector, name) => js(`(() => { const n = document.querySelector(${q(selector)}) || document; n.dispatchEvent(new KeyboardEvent('keydown', { key: ${q(name)}, bubbles: true, cancelable: true })); return true; })()`);
  const menuRow = label => `[...document.querySelectorAll('.bots-menu:not([data-closing]) .bots-menu-row')].find(n => n.textContent === ${q(label)})`;
  const pickMenu = async (opener, label) => {
    await waitFor("!document.querySelector('.bots-menu')");
    await click(opener);
    await waitFor(`!!${menuRow(label)}`);
    await js(`${menuRow(label)}.click()`);
  };
  const fits = async what => {
    const over = await js(`(() => ['.bots-shell', '.bots-shell-main', '.bots-chat-host', '.bots-composer'].filter(s => { const n = document.querySelector(s); return n && n.scrollWidth > n.clientWidth + 2; }).concat(document.documentElement.scrollWidth > innerWidth + 1 ? ['page ' + document.documentElement.scrollWidth + '>' + innerWidth] : []))()`);
    assert.deepEqual(over, [], `${what}: the conversation fits the available width`);
  };
  const setAdvanced = on => js(`import('/static/js/botsUi.js').then(m => { m.setAdvanced(${on}); return true; })`);
  const open = (agentId, sessionId) => navigate('botsShell', { agentId, ...(sessionId ? { sessionId } : {}) });
  const composer = '.bots-composer-input';
  const threadsOf = async id => (await call(`/api/agents/${id}/threads?include_archived=1`)).body.threads;
  const link = id => `[data-thread-id="${id}"]`;

  const restore = await isolateBotsCheck({ js, demoState });
  const savedPrefs = await js("Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('kairos:bots-sidebar:')).map(k => [k, localStorage.getItem(k)]))");
  try {
    demoState.botsLive = true;
    await js("Object.keys(localStorage).filter(k => k.startsWith('kairos:bots-sidebar:')).forEach(k => localStorage.removeItem(k)); true");
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");
    const stamp = Date.now() % 100000;
    const one = (await call('/api/agents', 'POST', { name: `Messenger One ${stamp}`, role: 'Keeps the reading list' })).body;
    const two = (await call('/api/agents', 'POST', { name: `Messenger Two ${stamp}` })).body;
    const main = (await call(`/api/agents/${one.id}/threads`, 'POST', { title: 'Main' })).body.id;
    const alpha = (await call(`/api/agents/${one.id}/threads`, 'POST', { title: 'Msg alpha' })).body.id;
    const beta = (await call(`/api/agents/${one.id}/threads`, 'POST', { title: 'Msg beta' })).body.id;
    await call(`/api/agents/${two.id}/threads`, 'POST', { title: 'Main' });
    await setAdvanced(true);

    // 1. The roster is a real list of bots, each with its face; Home is the welcome.
    await navigate('agents');
    await waitFor("document.getElementById('view-content').dataset.view === 'botsHome' && !!document.querySelector('.bots-rail-row')");
    const ids = await js("[...document.querySelectorAll('.bots-rail-row')].map(n => n.dataset.agentId)");
    assert.ok(ids.includes(one.id) && ids.includes(two.id), 'both bots are listed in the sidebar');
    assert.equal(await js("document.querySelectorAll('.bots-rail-row img').length"), ids.length, 'every row has a face');
    assert.ok(await exists('.bots-home-title') && await exists('.bots-bot-card .bots-bot-card-name'), 'the welcome page shows the bots');
    await capture?.('desktop-bots-messenger-welcome');

    // 2. Opening a bot opens its exact conversation; a typed draft is kept per conversation.
    await js(`document.querySelector('.bots-rail-row[data-agent-id=${one.id}]').click()`);
    await waitFor(`document.documentElement.dataset.botsAgent === ${q(one.id)} && !!document.querySelector('${composer}')`);
    await open(one.id, alpha);
    await waitFor(`document.querySelector('.bots-head-thread')?.textContent.includes('Msg alpha') && !!document.querySelector('${composer}')`);
    await fill(composer, 'Keep my unsent draft');
    await js(`window.__input = document.querySelector('${composer}'); true`);
    await capture?.('desktop-bots-messenger-conversation');
    await fits('1440');

    // 3. Window sizes and zoom: the name card, the composer and the thread stay inside the window.
    for (const width of [1280, 1920, 900]) {
      win.setContentSize(width, 800); await delay(300); await fits(String(width));
      assert.ok(await js("(() => { const p = document.querySelector('.bots-shell-main').getBoundingClientRect(); return ['.bots-head-pill', '.bots-head-convos', '.bots-composer'].every(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= p.left - 1 && r.right <= p.right + 1; }); })()"), `${width}: header controls and composer stay in the page`);
    }
    win.setContentSize(1440, 900); await delay(300);

    // 4. Conversations: exact selection from the sidebar tree, the draft returns, pin and unread are saved.
    const toggle = `[...document.querySelectorAll('.bots-rail-toggle')].find(n => n.getAttribute('aria-label').includes(${q(one.name)}))`;
    await waitFor(`!!${toggle}`);
    if ((await js(`${toggle}.getAttribute('aria-expanded')`)) !== 'true') await js(`${toggle}.click()`);
    await waitFor(`!!document.querySelector('${link(alpha)}') && !!document.querySelector('${link(beta)}')`);
    await js(`document.querySelector('${link(beta)} .bots-thread-row').click()`);
    await waitFor(`document.querySelector('.bots-head-thread')?.textContent.includes('Msg beta')`);
    assert.equal(await js(`document.querySelector('${composer}').value`), '', 'another conversation has its own empty composer');
    await js(`document.querySelector('${link(alpha)} .bots-thread-row').click()`);
    await waitFor(`document.querySelector('.bots-head-thread')?.textContent.includes('Msg alpha') && !!document.querySelector('${composer}')`);
    assert.equal(await js(`document.querySelector('${composer}').value`), 'Keep my unsent draft', 'switching conversations restores the unsent draft');
    await pickMenu(`${link(beta)} .bots-rail-more`, 'Pin');
    for (let i = 0; i < 100 && !(await threadsOf(one.id)).find(t => t.id === beta).thread.pinned; i++) await delay(50);
    assert.equal((await threadsOf(one.id)).find(t => t.id === beta).thread.pinned, true, 'a pinned conversation is saved');
    await pickMenu(`${link(beta)} .bots-rail-more`, 'Mark as unread');
    for (let i = 0; i < 100 && !(await threadsOf(one.id)).find(t => t.id === beta).thread.unread; i++) await delay(50);
    assert.equal((await threadsOf(one.id)).find(t => t.id === beta).thread.unread, true, 'unread is saved');
    await waitFor(`!!document.querySelector('${link(beta)} .bots-thread-unread')`);

    // 5. Changing the density keeps the mounted conversation and its draft.
    await js("window.__input = document.querySelector('.bots-composer-input'); true");
    await click('.bots-rail-density');
    await waitFor("document.querySelector('.bots-rail').dataset.density === 'compact'");
    await click('.bots-rail-density');
    await waitFor("document.querySelector('.bots-rail').dataset.density === 'icons'");
    assert.ok(await js(`document.querySelector('${composer}') === window.__input && window.__input.value === 'Keep my unsent draft'`), 'a narrow sidebar keeps the mounted chat and draft');
    await capture?.('desktop-bots-messenger-icons');
    await click('.bots-rail-density');
    await waitFor("document.querySelector('.bots-rail').dataset.density === 'comfortable'");

    // 6. Search finds a conversation by title and opens it.
    await fill('.bots-rail-search', 'Msg beta');
    await waitFor("!!document.querySelector('.bots-search-thread')");
    assert.match(await js("document.querySelector('.bots-search-thread').textContent"), /Msg beta/);
    await js("document.querySelector('.bots-search-thread').click()");
    await waitFor(`document.querySelector('.bots-head-thread')?.textContent.includes('Msg beta')`);
    await key('.bots-rail-search', 'Escape');
    await fill('.bots-rail-search', '');

    // 7. The Inbox is still one click away.
    await click('.bots-rail-attention-btn[data-panel=inbox]');
    await waitFor("!!document.querySelector('.bots-attn:not([hidden])')");
    assert.ok(await js("document.querySelector('.bots-attn').getClientRects().length > 0"), 'the inbox opens beside the conversation');
    await click('.bots-rail-attention-btn[data-panel=inbox]');
    await waitFor("!document.querySelector('.bots-attn:not([hidden])') || document.querySelector('.bots-attn').hidden");

    // 8. A team is still reachable and its group message uses the persisted broadcast route.
    await navigate('agents', { team: 's1' });
    await waitFor("document.getElementById('view-content').dataset.view === 'swarm' && !!document.querySelector('.swarm-composer')");
    // The standalone Swarm view addresses the lead by default; Everyone is one choice away.
    assert.equal(await js("document.querySelector('.swarm-recipient').value"), '', 'a group message goes to the lead unless the person chooses Everyone');
    await js("(() => { const r = document.querySelector('.swarm-recipient'); r.value = 'all'; r.dispatchEvent(new Event('change')); })()");
    assert.ok(await exists('.swarm-messages'));
    await capture?.('desktop-bots-messenger-team');
    await js("document.querySelector('.swarm-composer textarea').value='Group message test';document.querySelector('.swarm-composer textarea').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.swarm-composer').requestSubmit()");
    await waitFor("document.querySelector('.swarm-composer').textContent.includes('read when the team next works')");
    assert.ok(writes.some(w => w.path === '/api/swarm/systems/s1/messages' && JSON.parse(w.body).body === 'Group message test' && JSON.parse(w.body).to === 'all'), 'the group composer uses the persisted broadcast endpoint');
    await js("localStorage.setItem('kairos:app-mode', 'bots'); true");
    await open(one.id, alpha);
    await waitFor(`!!document.querySelector('${composer}')`);

    // 9. Phone and landscape: no sideways scroll, Back is a real target, and the conversation list keeps focus.
    for (const [name, w, h] of [['phone', 375, 812], ['landscape', 812, 375]]) {
      win.setContentSize(w, h); await delay(400); await fits(name); await capture?.(`${name}-bots-messenger`);
    }
    win.setContentSize(375, 812); await delay(400);
    assert.ok(await js("(() => { const b = document.querySelector('.bots-head-back'), r = b.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5 && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })()"), 'Back is reachable and 44 px');
    await js("document.querySelector('.bots-head-convos').focus(); document.querySelector('.bots-head-convos').click()");
    await waitFor("!document.querySelector('#bots-convos').hidden");
    assert.ok(await js("document.querySelector('#bots-convos').contains(document.activeElement)"), 'the conversation list takes focus');
    await key('#bots-convos', 'Escape');
    await waitFor("document.querySelector('#bots-convos').hidden");
    assert.ok(await js("document.activeElement === document.querySelector('.bots-head-convos')"), 'Escape returns focus to the button that opened the list');
    await js("document.querySelector('.bots-head-convos').click()");
    await waitFor("!document.querySelector('#bots-convos').hidden");
    await js(`document.querySelector('#bots-convos [data-session="${beta}"] .bots-convo-open').click()`);
    await waitFor(`document.querySelector('#bots-convos').hidden && document.querySelector('.bots-head-thread')?.textContent.includes('Msg beta')`);
    await js(`document.querySelector('.bots-head-convos').click()`);
    await waitFor("!document.querySelector('#bots-convos').hidden");
    await js(`document.querySelector('#bots-convos [data-session="${alpha}"] .bots-convo-open').click()`);
    await waitFor(`document.querySelector('.bots-head-thread')?.textContent.includes('Msg alpha') && !!document.querySelector('${composer}')`);
    assert.equal(await js(`document.querySelector('${composer}').value`), 'Keep my unsent draft', 'the draft survives a conversation switch on a phone');
    win.setContentSize(1440, 900); await delay(300);
    win.webContents.setZoomFactor(2); await delay(300); await fits('zoom 2');
    await capture?.('desktop-bots-messenger-zoom'); win.webContents.setZoomFactor(1); await delay(300);

    // 10. The look is edited in the panel and saved through the real profile save.
    await navigate('agents', { agentId: one.id, profile: true });
    await waitFor("!!document.querySelector('#bots-panel .bots-acc-item')");
    const clickSection = async () => {
      for (let i = 0; i < 40; i++) {
        if (await js("(() => { const b = document.querySelector('#bots-panel [data-panel-card=identity] .bots-avatar-editor'); return !!b && b.getClientRects().length > 0; })()")) return;
        if (!(await exists('#bots-panel .bots-acc-item[data-section=identity][data-open=true]'))) await click('#bots-panel .bots-acc-head[data-section=identity]');
        await delay(150);
      }
      throw new Error('The identity section did not open');
    };
    await clickSection();
    const mark = writes.length;
    for (const [keyName, value] of [['shape', 'squircle'], ['accessory', 'laurel'], ['body', '#B5C7A5']]) await click(`#bots-panel [aria-label="Kip ${keyName}"] [data-value="${value}"]`);
    for (let i = 0; i < 100 && !writes.slice(mark).some(w => w.path === `/api/agents/${one.id}` && JSON.parse(w.body || '{}').avatar?.acc === 'laurel'); i++) await delay(50);
    const saved = JSON.parse(writes.slice(mark).filter(w => w.path === `/api/agents/${one.id}` && JSON.parse(w.body || '{}').avatar).at(-1).body).avatar;
    assert.deepEqual([saved.version, saved.character, saved.shape, saved.color, saved.acc, saved.finish], [3, 'ajar', 'squircle', '#B5C7A5', 'laurel', 'flat'], 'the look persists through the real profile save');
    await capture?.('desktop-bots-messenger-custom-character');
    await click('#bots-panel .bots-panel-close');

    // 11. With no bots there is an empty state that allows creation, and no fake chats.
    await navigate('home');
    demoState.botsCore.agents.forEach(a => { a.__hidden = a.hidden; a.hidden = true; });
    await js("localStorage.setItem('kairos:app-mode', 'bots'); true");
    await navigate('botsHome');
    await waitFor("!!document.querySelector('.bots-home-empty')");
    assert.ok(await exists('.bots-home-empty .bots-btn.primary'), 'the empty state offers to create a bot');
    assert.equal(await js("document.querySelectorAll('.bots-bot-card, .bots-rail-row[data-agent-id]').length"), 0, 'no fake bots or chats are drawn');
    demoState.botsCore.agents.forEach(a => { a.hidden = a.__hidden; delete a.__hidden; });
    console.log('PASS: Bots messenger (roster, selection, drafts, pin/unread, density, search, team, inbox, phone, zoom, look, empty state).');
  } finally {
    win.webContents.setZoomFactor(1);
    win.setContentSize(1440, 900);
    for (const a of demoState.botsCore?.agents || []) if ('__hidden' in a) { a.hidden = a.__hidden; delete a.__hidden; }
    await js(`(() => { Object.keys(localStorage).filter(k => k.startsWith('kairos:bots-sidebar:')).forEach(k => localStorage.removeItem(k)); for (const [k, v] of Object.entries(${q(savedPrefs)})) localStorage.setItem(k, v); return true; })()`).catch(() => {});
    await restore();
  }
};

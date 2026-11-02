// Bots on a phone (2026-10-30): the tab bar's Bots, Chats and Inbox; the Chats sheet that carries the sidebar's
// list; a bot's page and a room using the whole screen above the tab bar; the room's round call button.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, demoState, base, capture }) => {
  const q = JSON.stringify, originalSize = win.getContentSize();
  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined, botsRooms: {} });
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, {method:${q(method)},headers:{'Content-Type':'application/json'},body:${body ? q(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,body:await r.json()}))`);
  const unique = Math.random().toString(36).slice(2, 8), botIds = [];
  let roomId = null;
  try {
    win.setContentSize(390, 844);
    await win.loadURL(base); await waitFor("!!document.querySelector('.dashboard-core')");
    for (const name of [`Phone Ada ${unique}`, `Phone Bo ${unique}`]) botIds.push((await call('/api/agents', 'POST', { name })).body.id);
    const [ada] = botIds;
    roomId = (await call('/api/bot-rooms', 'POST', { name: `Phone room ${unique}`, bot_ids: botIds, setup_done: true })).body.id;
    assert.ok(roomId, 'the check makes its own room');

    // The tab bar: the roster, the list and the inbox, then More.
    await navigate('botsHome');
    await waitFor("document.querySelector('.ms-tabbar')?.dataset.mode === 'bots'");
    assert.deepEqual(await js("[...document.querySelectorAll('.ms-tabbar-item')].map(n => n.dataset.tabbar)"), ['botsHome', 'botsChats', 'botsInbox', 'more']);
    assert.equal(await js("document.querySelector('.ms-tabbar-item[aria-current=page]').dataset.tabbar"), 'botsHome');

    // Chats: the sidebar's list in a sheet, with the bots and the room; picking one closes the sheet.
    await js("document.querySelector('[data-tabbar=botsChats]').click()");
    await waitFor(`!!document.querySelector('#ms-bots-sheet[open] .bots-rail [data-key="bot:${ada}"]') && !!document.querySelector('#ms-bots-sheet[open] .bots-rail-room[data-room-id="${roomId}"]')`);
    assert.equal(await js("document.querySelector('[data-tabbar=botsChats]').getAttribute('aria-expanded')"), 'true');
    assert.deepEqual(await js("[...document.querySelectorAll('#ms-bots-sheet .bots-rail-room, #ms-bots-sheet .nav-item')].filter(n => n.getClientRects().length).filter(n => n.getBoundingClientRect().height < 44).map(n => n.textContent.trim())"), [], 'rows in the sheet are 44 px');
    await capture?.('phone-bots-chats-sheet');
    await js(`document.querySelector('#ms-bots-sheet .bots-rail-room[data-room-id="${roomId}"]').click()`);
    await waitFor(`!document.querySelector('#ms-bots-sheet[open]') && !!document.querySelector('.bots-room[data-room-id="${roomId}"]')`);
    await waitFor("document.querySelector('.ms-tabbar-item[aria-current=page]')?.dataset.tabbar === 'botsChats'");

    // The room uses the screen: its header at the top, its composer above the tab bar, a 44 px round call button.
    await waitFor("!!document.querySelector('.bots-room .bots-composer') && !!document.querySelector('.bots-room-call .agent-call-open')");
    await delay(300);
    assert.ok(await js("document.querySelector('.bots-room-header').getBoundingClientRect().top < 30"), 'no blank band above the room header');
    assert.ok(await js("document.querySelector('.bots-room .bots-composer').getBoundingClientRect().bottom <= document.querySelector('.ms-tabbar-glass').getBoundingClientRect().top + 1"), 'the composer sits above the tab bar');
    assert.deepEqual(await js("(() => { const r = document.querySelector('.bots-room-call .agent-call-open').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()"), [44, 44]);
    assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"), 'no sideways scroll');

    // A bot's page from the sheet: the same spacing; the page is full screen (2026-11-02), so the tab bar steps aside and its back button returns.
    await js("document.querySelector('[data-tabbar=botsChats]').click()");
    await waitFor(`!!document.querySelector('#ms-bots-sheet[open] [data-key="bot:${ada}"] .bots-rail-row')`);
    await js(`document.querySelector('#ms-bots-sheet [data-key="bot:${ada}"] .bots-rail-row').click()`);
    await waitFor(`!document.querySelector('#ms-bots-sheet[open]') && document.querySelector('.bots-shell')?.dataset.agentId === ${q(ada)}`);
    await waitFor("!!document.querySelector('.bots-shell .bots-composer') || !!document.querySelector('.bots-chat-blocked')");
    assert.ok(await js("document.querySelector('.bots-shell-header').getBoundingClientRect().top < 30"), 'no blank band above the bot header');
    await waitFor("document.querySelector('.ms-tabbar').dataset.state === 'hidden'");
    assert.ok(await js("getComputedStyle(document.querySelector('.bots-head-back')).display !== 'none'"), 'a bot page has its own back button');
    await js("document.querySelector('.bots-head-back').click()");
    await waitFor("document.documentElement.dataset.view === 'botsHome' && document.querySelector('.ms-tabbar').dataset.state === 'shown'");
    assert.equal(await js("document.querySelector('.ms-tabbar-item[aria-current=page]').dataset.tabbar"), 'botsHome');

    // Inbox: the attention sheet; the tab bar steps aside while it is open and comes back after.
    await js("document.querySelector('[data-tabbar=botsInbox]').click()");
    await waitFor("!!document.querySelector('.bots-attn:not([hidden])') && document.querySelector('.ms-tabbar').dataset.state === 'hidden'");
    await capture?.('phone-bots-inbox');
    await js("document.querySelector('.bots-attn button[aria-label=\"Close\"]').click()");
    await waitFor("document.querySelector('.bots-attn').hidden && document.querySelector('.ms-tabbar').dataset.state === 'shown'");
  } finally {
    await js("document.querySelector('#ms-bots-sheet[open]')?.close()").catch(() => {});
    if (roomId) await call(`/api/bot-rooms/${roomId}`, 'DELETE').catch(() => {});
    for (const id of botIds) await call(`/api/agents/${id}`, 'DELETE').catch(() => {});
    win.setContentSize(...originalSize); await restore();
  }
};

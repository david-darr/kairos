// Cards in rooms (2026-10-31): a bot's card shows in the room's transcript, and pressing it answers through the
// room's own route, addressed to that bot. The rooms fixture lane stands in for services/bot_widgets.py press_room.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, win, demoState, base, capture }) => {
  const q = JSON.stringify, originalSize = win.getContentSize();
  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined, botsRooms: {} });
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, {method:${q(method)},headers:{'Content-Type':'application/json'},body:${body ? q(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,body:await r.json()}))`);
  const unique = Math.random().toString(36).slice(2, 8), botIds = [];
  let roomId = null;
  try {
    await win.loadURL(base); win.setContentSize(1440, 1000);
    await waitFor("!!document.querySelector('.dashboard-core')");
    for (const name of [`Card Ada ${unique}`, `Card Bo ${unique}`]) botIds.push((await call('/api/agents', 'POST', { name })).body.id);
    const [, bo] = botIds;
    roomId = (await call('/api/bot-rooms', 'POST', { name: `Cards ${unique}`, bot_ids: botIds, setup_done: true })).body.id;
    await js(`(async()=>{
      window.__cardScratch=document.createElement('div'); __cardScratch.dataset.appMode='bots';
      Object.assign(__cardScratch.style,{position:'fixed',inset:'0',zIndex:'1000'}); document.body.append(__cardScratch);
      const m=await import('/static/js/views/botsRoom.js');
      window.__cardRoom=await m.mountRoom(__cardScratch,{roomId:${q(roomId)},sourceFactory:()=>({addEventListener(){},close(){}})});
      return true;
    })()`);
    const widget = { type: 'card', title: 'Pick a day', children: [{ type: 'Select', id: 'day', label: 'Day', options: ['Mon', 'Tue'] }],
      confirm: { label: 'Book it', ref: 'confirm' }, cancel: { label: 'Never mind', ref: 'cancel' } };
    const placed = await call(`/api/bot-rooms/${roomId}/__fixture/card`, 'POST', { bot_id: bo, widget });
    assert.equal(placed.status, 200);
    await js('window.__cardRoom.refresh()');
    const cardSel = `.bots-room [data-message-id="${placed.body.id}"].bots-widget, .bots-room .bots-widget[data-message-id="${placed.body.id}"]`;
    await waitFor(`!!document.querySelector(${q(cardSel)}) && [...document.querySelector(${q(cardSel)}).querySelectorAll('button')].some(b => b.textContent.trim() === 'Book it')`);
    await capture?.('desktop-bots-room-card');

    // Pressing answers through the room, as the person, to the bot that showed the card.
    await js(`(()=>{const card=document.querySelector(${q(cardSel)});const pick=card.querySelector('select');if(pick){pick.value='Tue';pick.dispatchEvent(new Event('change',{bubbles:true}));}[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='Book it').click();return true;})()`);
    for (let i = 0; i < 60 && !(demoState.botsRooms.presses || []).length; i++) await new Promise(r => setTimeout(r, 50));
    const press = (demoState.botsRooms.presses || [])[0];
    assert.ok(press, 'the press went to the room route');
    assert.deepEqual([press.room, press.message_id, press.ref, press.rev], [roomId, placed.body.id, 'confirm', 1]);
    const answer = (demoState.botsRooms.messages[roomId] || []).find(m => m.role === 'person' && m.reply_to_id === placed.body.id);
    assert.ok(answer && answer.text.startsWith(`@Card Bo ${unique} I answered the card`), 'the answer is addressed to the bot that showed the card');
    await js('window.__cardRoom.refresh()');
    await waitFor(`!document.querySelector(${q(cardSel)}) || ![...document.querySelector(${q(cardSel)}).querySelectorAll('button')].some(b => b.textContent.trim() === 'Book it' && !b.disabled)`);

    // A question a bot asks during its room turn waits in its seat conversation; the room shows it and answers it there
    // (found live 2026-11-02: before, it showed nowhere and the room waited until the turn timed out).
    const seat = (await call(`/api/bot-rooms/${roomId}`)).body.members.find(m => m.bot_id === bo).seat_session_id;
    assert.ok(seat, 'each member has a seat conversation');
    const asked = await call('/api/bot-cards/__fixture/open', 'POST', { kind: 'question', thread_id: seat, bot_id: bo, title: 'Which layout?',
      questions: [{ id: 'q1', question: 'Which layout should it use?', options: [{ label: 'Two columns' }, { label: 'Tabs' }] }] });
    assert.equal(asked.status, 200);
    await js('window.__cardRoom.refresh()');
    const seatSel = '.bots-room .bots-room-seat-card:not([hidden])';
    await waitFor(`[...document.querySelectorAll(${q(seatSel)})].some(n => n.innerText.includes('Which layout should it use?'))`);
    const fits = await js(`(()=>{const h=document.querySelector('.bots-room-seat-cards'),c=document.querySelector('.bots-room textarea');return !!c && h.getBoundingClientRect().height <= innerHeight * 0.45 + 1 && c.getBoundingClientRect().bottom <= innerHeight;})()`);
    assert.ok(fits, 'the question is capped, so the composer stays on screen');
    await js(`(()=>{const card=document.querySelector(${q(seatSel)});[...card.querySelectorAll('button,label,[role=radio]')].find(n=>n.innerText.trim().startsWith('Tabs')).click();return true;})()`);
    await js(`(()=>{const card=document.querySelector(${q(seatSel)});[...card.querySelectorAll('button')].find(b=>['Submit','Send','Send answers'].includes(b.textContent.trim())).click();return true;})()`);
    for (let i = 0; i < 60 && !(demoState.botsCards.answers || []).some(a => a.id === asked.body.id); i++) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual((demoState.botsCards.answers || []).find(a => a.id === asked.body.id)?.answers, { q1: 'Tabs' }, 'the answer went to the seat card');
    await waitFor(`!document.querySelector(${q(seatSel)})`);
  } finally {
    await js('window.__cardRoom?.destroy();window.__cardScratch?.remove();delete window.__cardRoom;delete window.__cardScratch;true').catch(() => {});
    if (roomId) await call(`/api/bot-rooms/${roomId}`, 'DELETE').catch(() => {});
    for (const id of botIds) await call(`/api/agents/${id}`, 'DELETE').catch(() => {});
    win.setContentSize(...originalSize); await restore();
  }
};

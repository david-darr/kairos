// Runs against U2's bots-rooms-backend.cjs. This check mounts the view directly
// so the nav skeleton may land separately. No fixture ids or shared rooms used.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, win, demoState, base }) => {
  const q = JSON.stringify;
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, {method:${q(method)},headers:{'Content-Type':'application/json'},body:${body === undefined ? 'undefined' : q(JSON.stringify(body))}}).then(async r=>({status:r.status,body:await r.json()}))`);
  const click = selector => js(`(() => { const n=document.querySelector(${q(selector)}); if(!n) throw Error('Missing '+${q(selector)}); n.click(); })()`);
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${q(selector)}); if(!n) throw Error('Missing '+${q(selector)}); n.value=${q(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const button = (selector, label) => js(`(() => { const n=[...document.querySelectorAll(${q(selector)})].find(n=>n.textContent.trim()===${q(label)}); if(!n) throw Error('Missing '+${q(label)}); n.click(); })()`);
  const restore = await isolateBotsCheck({ js, demoState }, { botsRooms: {} });
  const originalSize = win.getContentSize();
  const botIds = [], roomIds = [];
  let preferences = null;
  try {
    await win.loadURL(base);
    win.setContentSize(1440, 1000);
    await waitFor("!!document.querySelector('.dashboard-core')");
    preferences = await js(`Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kairos:bots-draft:')).map(k=>[k,localStorage.getItem(k)]))`);
    for (const role of ['Scout', 'Writer']) {
      const created = await call('/api/agents', 'POST', { name: `${role} ${Math.random().toString(36).slice(2, 8)}` });
      assert.equal(created.status, 200); assert.ok(created.body.id); botIds.push(created.body.id);
    }
    await js(`(async()=>{
      window.__roomScratch=document.createElement('div'); __roomScratch.dataset.appMode='bots';
      Object.assign(__roomScratch.style,{position:'fixed',inset:'0',zIndex:'1000'}); document.body.append(__roomScratch);
      window.__roomModule=await import('/static/js/views/botsRoom.js');
      window.__roomSource=url=>{
        const handlers={}, source={addEventListener:(k,fn)=>{handlers[k]=fn;},close:()=>{source.closed=true;clearInterval(source.timer);}};
        let cursor=0, running=false;
        const poll=async()=>{if(running||source.closed)return;running=true;try{
          const page=await fetch('/api/bot-rooms/_frames?after='+cursor).then(r=>r.json());
          if(source.closed)return;
          if(page.reset){handlers.hello?.({data:JSON.stringify({cursor:page.cursor,reset:true})});cursor=page.cursor;}
          for(const frame of page.frames||[]){handlers[frame.type]?.({data:JSON.stringify({room_id:frame.room_id,...frame.data}),lastEventId:String(frame.id)});cursor=frame.id;}
        }finally{running=false;}};
        source.timer=setInterval(()=>poll().catch(()=>{}),60);return source;
      };
      window.__roomNew=await import('/static/js/botsNewRoom.js');
      window.__roomNewDialog=await __roomNew.openNewRoom({onCreated:room=>{window.__madeRoom=room;}});
    })()`);
    await fill('.bots-room-dialog [aria-label="Room name"]', `Room ${Date.now()}`);
    for (const id of botIds) await click(`.bots-room-dialog [data-bot-id="${id}"]`);
    await button('.bots-room-dialog button', 'Create room with 2 bots');
    await waitFor('!!window.__madeRoom?.id');
    const room = await js('window.__madeRoom'); roomIds.push(room.id);
    const mount = async id => {
      await js(`(async()=>{window.__roomUI?.destroy(); window.__roomUI=await __roomModule.mountRoom(__roomScratch,{roomId:${q(id)},sourceFactory:__roomSource});})()`);
    };
    await mount(room.id);
    await waitFor("!!document.querySelector('.bots-room-setup')");
    await fill('.bots-room-setup [aria-label="Room instructions"]', 'Keep replies short.');
    await click('.bots-room-setup [role="radio"][data-value="everyone"]');
    await button('.bots-room-setup button', 'Save');
    await waitFor("!document.querySelector('.bots-room-setup')");
    assert.equal((await call(`/api/bot-rooms/${room.id}`)).body.bulletin, 'Keep replies short.');
    // A second room proves Skip and teardown are independent of the first one.
    const second = await call('/api/bot-rooms', 'POST', { name: `Skip ${Date.now()}`, bot_ids: [botIds[0]] }); roomIds.push(second.body.id);
    await mount(second.body.id); await button('.bots-room-setup button', 'Skip');
    await waitFor("!document.querySelector('.bots-room-setup')");
    assert.equal((await call(`/api/bot-rooms/${second.body.id}`)).body.setup_state, 'skipped');
    await mount(room.id);
    const send = async text => { await fill('.bots-room .bots-composer-input', text); await click('.bots-room .bots-composer-primary'); };
    await send('Hello [slow]');
    await waitFor("!!document.querySelector('.bots-room-face[data-state=working]')");
    // U2 fixture has no model transport; inject canonical SSE frames into its
    // own replay store. The production client still consumes the real contract.
    const tid = await js('__roomUI.model.state.threadId');
    const emit = (type, data) => { const s = demoState.botsRooms; const frame = { id: ++s.cursor, type, room_id: room.id, data }; s.frames.push(frame); };
    emit('room.chunk', { thread_id: tid, turn_id: 'ui-stream-turn', bot_id: botIds[0], revision: 1, chunk: 'A streamed reply' });
    await waitFor("document.querySelector('.bots-room .bots-live')?.textContent.includes('A streamed reply')");
    assert.ok(await js("!!document.querySelector('.bots-room .bots-live .msg-cursor')"));
    emit('room.chunk', { thread_id: tid, turn_id: 'ui-stream-turn', bot_id: botIds[0], revision: 1, chunk: 'duplicate' });
    await waitFor(`window.__roomUI.stream.cursor()>=${demoState.botsRooms.cursor}`);
    assert.equal(await js("document.querySelector('.bots-room .bots-live')?.textContent.includes('duplicate')"), false);
    // The composer takes one send at a time; the second goes once the first is in the queue.
    await send('First queued');
    await waitFor("document.querySelectorAll('.bots-room-queue li').length===1");
    await send('Second queued');
    await waitFor("document.querySelectorAll('.bots-room-queue li').length===2");
    await button('.bots-room-header button', 'Members');
    await waitFor("document.querySelector('.bots-room-members')?.textContent.includes('when it is idle')");
    assert.equal(await js("[...document.querySelectorAll('.bots-room-members input')].every(n=>n.disabled)"), true);
    await button('.bots-room-dialog header button', 'Close');
    await button('.bots-room-stops button', 'Stop all');
    await waitFor("!![...document.querySelectorAll('.bots-room-chip button')].find(b=>b.textContent==='Retry')");
    await button('.bots-room-chip button', 'Retry');
    await waitFor("document.querySelector('.bots-room .bots-log')?.textContent.includes('Please try your last room reply again.')");
    await js('__roomUI.refresh()');
    await waitFor("!document.querySelector('.bots-room-face[data-state=working]')");
    await call(`/api/bot-rooms/${room.id}/holds`, 'POST', { bot_id: botIds[0], held: true });
    await waitFor("!!document.querySelector('.bots-room-held')");
    assert.equal(await js("!!document.querySelector('.bots-room-face[data-state=held] .bots-room-pause')"), true);
    const botName = (await call(`/api/bot-rooms/${room.id}`)).body.members.find(m => m.bot_id === botIds[0]).name;
    await button('.bots-room-held button', `Resume ${botName}`);
    await waitFor("!document.querySelector('.bots-room-held')");
    emit('room.turn', { thread_id: tid, turn_id: 'ui-waiting', bot_id: botIds[1], status: 'waiting' });
    await waitFor("!!document.querySelector('.bots-room-face[data-state=queued]')");
    emit('room.turn', { thread_id: tid, turn_id: 'ui-waiting', bot_id: botIds[1], status: 'ended' });
    await waitFor(`document.querySelector('.bots-room-face[data-bot-id="${botIds[1]}"]')?.dataset.state==='ready'`);
    const waitingRows = demoState.botsRooms.messages[room.id];
    const elsewhere = { id: `ui-wait-${Date.now()}`, room_id: room.id, thread_id: tid, seq: waitingRows.length + 1, role: 'system', kind: 'chip',
      bot_id: null, text: 'A member is finishing another conversation.', created_at: Date.now() / 1000, meta: { kind_hint: 'busy-elsewhere', bot_id: botIds[1] } };
    waitingRows.push(elsewhere); emit('room.message', { message: elsewhere });
    await waitFor("!!document.querySelector('.bots-room-face[data-state=elsewhere]')");
    // Restore through a fresh snapshot before the next fixture frame.
    await js('__roomUI.refresh()');
    await button('.bots-room-header > button', room.name);
    await fill('.bots-room-panel [aria-label="Room instructions"]', 'Updated instructions');
    await js(`document.querySelector('.bots-room-panel textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))`);
    await waitFor("document.querySelector('.bots-room-bulletin')?.textContent.includes('Updated instructions')");
    await button('.bots-room-dialog header button', 'Close');
    assert.equal(await js("document.activeElement.textContent"), room.name, 'settings returns focus to its opener');
    await js(`import('/static/js/botsUi.js').then(m=>m.setAdvanced(true))`);
    await button('.bots-room-advanced button', 'Find');
    await fill('.bots-room-find input', 'Hello');
    await waitFor("document.querySelector('.bots-room-find [role=status]')?.textContent.includes('of')");
    await button('.bots-room-find button', 'Close find');
    await click('.bots-room .bots-goal-chip'); await send('Finish the room goal');
    await waitFor("!!document.querySelector('.bots-room-goal[data-status=working]')");
    await button('.bots-room-goal button', 'Stop goal');
    await waitFor("!!document.querySelector('.bots-room-goal[data-status=stopped]')");
    win.setContentSize(390, 844);
    await button('.bots-room-header button', 'Members');
    await waitFor("!!document.querySelector('.bots-room-dialog')");
    assert.ok(await js("document.querySelector('.bots-room-dialog').getBoundingClientRect().width<=innerWidth"));
    await button('.bots-room-dialog header button', 'Close');
    assert.ok(await js("document.querySelector('.bots-room').scrollWidth<=innerWidth"), 'phone has no horizontal overflow');
    assert.equal(await js("document.activeElement.textContent"), 'Members');
  } finally {
    try {
      await js(`window.__roomUI?.destroy();window.__roomNewDialog?.close();window.__roomScratch?.remove()`);
      for (const id of roomIds.reverse()) { await call(`/api/bot-rooms/${id}/stop`, 'POST', {}); await call(`/api/bot-rooms/${id}`, 'DELETE'); }
      for (const id of botIds.reverse()) await call(`/api/agents/${id}`, 'DELETE');
      if (preferences) await js(`(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('kairos:bots-draft:'))localStorage.removeItem(k);for(const[k,v]of Object.entries(${q(preferences)}))localStorage.setItem(k,v);})()`);
      await js(`for(const k of ['__roomScratch','__roomModule','__roomSource','__roomNew','__roomNewDialog','__madeRoom','__roomUI'])delete window[k]`);
    } finally {
      win.setContentSize(...originalSize); await restore();
      await js("import('/static/js/botsUi.js').then(m=>{m.resetBotsInterfaceForTest();m.applyBotsInterface();})");
    }
  }
};

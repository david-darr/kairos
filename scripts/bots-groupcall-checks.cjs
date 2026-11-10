// Group calls from a room (Bots Phase 6). Uses the rooms and voice fixture lanes and synthetic device audio, never a
// microphone or voice server. Who answers each turn is covered by scripts/test_bots_group_call.py; the turn stream is
// NDJSON, which the fixture server does not speak.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, win, demoState, base }) => {
  const q = JSON.stringify, originalSize = win.getContentSize();
  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined, botsRooms: {}, botsVoice: {
    callsEnabled: true, catalog: { voices: [], models: [] }, notes: {}, counter: 0, log: [],
  } });
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, {method:${q(method)},headers:{'Content-Type':'application/json'},body:${body ? q(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,body:await r.json()}))`);
  const botIds = [], unique = Math.random().toString(36).slice(2, 8);
  let roomId = null, preferences = {};
  try {
    await win.loadURL(base); win.setContentSize(1440, 1000);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const names = [`Call Ada ${unique}`, `Call Bo ${unique}`];
    for (const name of names) botIds.push((await call('/api/agents', 'POST', { name })).body.id);
    const [ada, bo] = botIds;
    const room = await call('/api/bot-rooms', 'POST', { name: `Launch ${unique}`, bot_ids: [ada, bo], setup_done: true, default_responder: { kind: 'member', bot_id: bo } });
    assert.equal(room.status, 200, JSON.stringify(room.body)); roomId = room.body.id;
    const agentKey = `room-${roomId}`;
    preferences = await js(`Object.fromEntries(${q(['kairos:call-conversation:', 'kairos:call-model:v2:', 'kairos:call-input:', 'kairos:neural-voice:', 'kairos:agent-voice:'].map(prefix => prefix + agentKey))}.map(key=>[key,localStorage.getItem(key)]))`);
    // Two device voices, so the members can sound different; a silent stream stands in for the microphone.
    await js(`(async()=>{
      const t=window.__groupCallCheck={synthesis:Object.getOwnPropertyDescriptor(window,'speechSynthesis'),getUserMedia:navigator.mediaDevices.getUserMedia};
      t.context=new AudioContext();const source=t.context.createOscillator(),gain=t.context.createGain(),destination=t.context.createMediaStreamDestination();gain.gain.value=0;source.connect(gain);gain.connect(destination);source.start();t.source=source;
      navigator.mediaDevices.getUserMedia=async()=>destination.stream.clone();
      Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{pending:false,speaking:false,getVoices:()=>[{name:'Fixture one',lang:'en-GB',localService:true},{name:'Fixture two',lang:'en-US',localService:true}],addEventListener(){},cancel(){},speak(){}}});
      window.__groupScratch=document.createElement('div'); __groupScratch.dataset.appMode='bots';
      Object.assign(__groupScratch.style,{position:'fixed',inset:'0',zIndex:'1000'}); document.body.append(__groupScratch);
      const source2=()=>{const s={addEventListener(){},close(){}};return s;};
      const m=await import('/static/js/views/botsRoom.js');
      window.__groupRoom=await m.mountRoom(__groupScratch,{roomId:${q(roomId)},sourceFactory:source2});
      return true;
    })()`);

    // The room header offers a call; the dialog names the members and offers no paid cloud voice.
    await waitFor("!!document.querySelector('.bots-room-call .agent-call-open')");
    await js("document.querySelector('.bots-room-call .agent-call-open').click()");
    // One tap: a group call goes live at once too.
    await waitFor("document.querySelector('.agent-call')?.dataset.state==='listening'");
    assert.equal(await js("document.querySelector('.agent-call').getAttribute('aria-label')"), `Group call in Launch ${unique}`);
    assert.equal(await js("document.querySelector('.agent-call-members').textContent"), `With ${names.join(', ')}. Say a name to choose who answers.`);
    assert.equal(await js("!!document.querySelector('[aria-label=\"Call mode\"] option[value=cloud]')"), false, 'group calls are local only');
    assert.match(await js("document.querySelector('.agent-call-privacy').textContent"), /saved in the room/);
    assert.equal(await js("document.querySelector('[aria-label=\"Conversation model connection\"]').value"), 'voice-check-model');
    const made = Object.values(demoState.botsVoice.calls || {}).at(-1);
    assert.equal(made.room_id, roomId, 'the call is started for the room');
    assert.equal(made.agent_id, bo, "it opens with the room's chosen responder");
    assert.equal(made.parent_id, roomId);

    // Back to the room: the bar sits above the room's composer and lists the members; the shortcut hangs up.
    await js("[...document.querySelectorAll('.agent-call-tabs button')].find(n=>n.textContent==='Chat').click()");
    await waitFor("!!document.querySelector('.bots-room .bots-call-bar:not([hidden])') && !document.querySelector('.agent-call').open");
    assert.match(await js("document.querySelector('.bots-call-bar [data-call-clock]').textContent"), new RegExp(`^Group call in Launch ${unique} · `));
    assert.equal(await js("document.querySelector('.bots-call-bar .bots-call-members').textContent"), `With ${names.join(', ')}`);
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'h',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))");
    await waitFor("!document.querySelector('.bots-call-bar')");
    // The end request goes out in the background, so give it a moment to land.
    for (let i = 0; i < 40 && !Object.values(demoState.botsVoice.calls).every(c => c.ended); i++) await delay(50);
    assert.ok(Object.values(demoState.botsVoice.calls).every(c => c.ended), 'hanging up ends the call');

    // The summary the call leaves in the room reads as a call summary.
    assert.equal(await js("import('/static/js/botsTeamChips.js').then(m=>m.TEAM_ROW_KINDS.includes('call_summary')&&m.chipLabel({kind:'call_summary'}))"), 'Call summary');

    // A room with every member on hold has nobody to call.
    for (const id of botIds) await call(`/api/bot-rooms/${roomId}/holds`, 'POST', { bot_id: id, held: true });
    await js('window.__groupRoom.refresh()');
    await waitFor("document.querySelector('.bots-room-call')?.hidden === true");
  } finally {
    await js(`(()=>{const t=window.__groupCallCheck;if(t){t.source?.stop();t.context?.close();if(t.synthesis)Object.defineProperty(window,'speechSynthesis',t.synthesis);else delete window.speechSynthesis;navigator.mediaDevices.getUserMedia=t.getUserMedia;delete window.__groupCallCheck;}document.querySelector('.agent-call .is-end')?.click();window.__groupRoom?.destroy();window.__groupScratch?.remove();delete window.__groupRoom;delete window.__groupScratch;return true;})()`).catch(() => {});
    if (roomId) await call(`/api/bot-rooms/${roomId}`, 'DELETE').catch(() => {});
    for (const id of botIds) await call(`/api/agents/${id}`, 'DELETE').catch(() => {});
    await js(`(()=>{for(const [key,value] of Object.entries(${q(preferences)})){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}return true;})()`).catch(() => {});
    await win.setContentSize(...originalSize); await restore();
  }
};

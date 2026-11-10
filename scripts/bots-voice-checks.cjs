// Written for the orchestrator. Uses synthetic device audio, never a microphone or voice server.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
module.exports = async ({ js, waitFor, delay, navigate, win, demoState, base, capture }) => {
  const q = JSON.stringify, originalSize = win.getContentSize();
  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined, botsVoice: {
    callsEnabled: true, catalog: { voices: [{ id: 'fixture', name: 'Fixture voice' }], models: ['fixture'] }, notes: {}, counter: 0, log: [],
  } });
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, {method:${q(method)},headers:{'Content-Type':'application/json'},body:${body ? q(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,body:await r.json()}))`);
  const click = selector => js(`document.querySelector(${q(selector)}).click()`);
  let botId, sid, otherBot, otherSid, preferences = {};
  try {
    await win.loadURL(base); await waitFor("!!document.querySelector('.dashboard-core')");
    botId = (await call('/api/agents', 'POST', { name: `Voice ${Date.now()} ${Math.random()}` })).body.id;
    sid = (await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Voice checks' })).body.id;
    assert.ok(botId && sid);
    otherBot = (await call('/api/agents', 'POST', { name: `Other voice ${Date.now()} ${Math.random()}` })).body.id;
    otherSid = (await call(`/api/agents/${otherBot}/threads`, 'POST', { title: 'Other voice checks' })).body.id;
    preferences = await js(`Object.fromEntries(${q([botId, otherBot].flatMap(id => ['kairos:call-conversation:', 'kairos:call-model:v2:', 'kairos:call-input:', 'kairos:neural-voice:', 'kairos:agent-voice:'].map(prefix => prefix + id)))}.map(key=>[key,localStorage.getItem(key)]))`);
    demoState.botsVoice.botIds = [botId];
    // Device voices and a silent MediaStream are the only replaced browser APIs. They go in before the bot page opens,
    // because the call reads the device voices when it mounts.
    await js(`(async()=>{
      const t=window.__botsVoiceCheck={utterance:window.SpeechSynthesisUtterance,synthesis:Object.getOwnPropertyDescriptor(window,'speechSynthesis'),getUserMedia:navigator.mediaDevices.getUserMedia,spoken:[]};
      t.context=new AudioContext();const source=t.context.createOscillator(),gain=t.context.createGain(),destination=t.context.createMediaStreamDestination();gain.gain.value=0;source.connect(gain);gain.connect(destination);source.start();t.source=source;
      navigator.mediaDevices.getUserMedia=async()=>destination.stream.clone();
      window.SpeechSynthesisUtterance=class extends EventTarget{constructor(text){super();this.text=text;}};
      Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{pending:false,speaking:false,getVoices:()=>[{name:'Fixture device',lang:'en-GB',localService:true}],addEventListener(){},cancel(){this.pending=false;this.speaking=false;},speak(u){t.spoken.push(u.text);this.speaking=true;queueMicrotask(()=>{u.dispatchEvent(new Event('start'));this.speaking=false;u.dispatchEvent(new Event('end'));});}}});
      return true;
    })()`);
    await navigate('botsShell', { agentId: botId, sessionId: sid }); await waitFor("!!document.querySelector('.agent-call-open')");
    // One tap: the only connection is picked by itself and the call goes live (no setup form).
    await click('.agent-call-open');
    await waitFor("document.querySelector('.agent-call')?.dataset.state==='listening'");
    assert.equal(await js("document.querySelector('[aria-label=\"Conversation model connection\"]').value"), 'voice-check-model');
    assert.equal(await js("document.querySelector('.agent-call-setup').hidden"), true);
    // Minimize (2026-11-10, David: "minimize the call so you can still utilize other kairos features"): the chevron at
    // the top shrinks the call to a pill with the bot's mascot, name, timer, mute and hang up.
    const pill = "document.querySelector('.call-pill')";
    await click('.agent-call-minimize');
    await waitFor(`!!${pill} && !${pill}.hidden && !document.querySelector('.agent-call').open`);
    const shape = await js(`(()=>{const p=${pill};return {name:p.querySelector('.call-pill-name').textContent,clock:/^\\d+:\\d\\d$/.test(p.querySelector('[data-call-clock]').textContent),mascot:p.querySelector('kairos-mascot')?.getAttribute('state'),keys:[...p.querySelectorAll('[data-call]')].map(n=>n.dataset.call),dot:p.querySelector('.call-pill-unread').hidden,small:[...p.querySelectorAll('button')].filter(n=>n.getClientRects().length).filter(n=>n.getBoundingClientRect().height<44).length}})()`);
    assert.equal(shape.name, await js(`fetch('/api/agents/${botId}').then(r=>r.json()).then(d=>d.agent.name)`), 'the pill names the bot');
    assert.ok(shape.clock, 'and runs the timer');
    assert.equal(shape.mascot, 'listening', "and shows the bot's mascot in the call's state");
    assert.deepEqual(shape.keys, ['mute', 'hangup'], 'with mute and hang up');
    assert.equal(shape.dot, true, 'and no unread dot yet');
    assert.equal(shape.small, 0, 'every pill control is 44 px');
    const clear = sel => `(()=>{const a=${pill}.getBoundingClientRect(),c=document.querySelector(${q(sel)})?.getBoundingClientRect();return !c||a.bottom<=c.top||a.top>=c.bottom||a.right<=c.left||a.left>=c.right})()`;
    assert.ok(await js(clear('.bots-shell .bots-composer')), 'the pill never covers the composer');
    await capture?.('call-pill-desktop');
    // Mute from the pill (and its shortcut), with the call screen agreeing.
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))");
    await waitFor(`${pill}.querySelector('[data-call=mute]').getAttribute('aria-pressed')==='true' && document.querySelector('.agent-call [data-call=mute]').getAttribute('aria-pressed')==='true'`);
    await js(`${pill}.querySelector('[data-call=mute]').click()`);
    await waitFor(`${pill}.querySelector('[data-call=mute]').getAttribute('aria-pressed')==='false'`);
    // The call stays up while the person goes anywhere in Kairos.
    for (const tab of ['home', 'chat', 'library', 'botsHome']) {
      await navigate(tab); await delay(200);
      assert.ok(await js(`!!${pill} && !${pill}.hidden && document.documentElement.dataset.botsCallActive==='true'`), `the call survives a move to ${tab}`);
      assert.ok(await js(`(()=>{const r=${pill}.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`), `and its pill is on screen in ${tab}`);
      assert.ok(await js(clear('.chat-input-bar')) && await js(clear('.bots-composer')), `and keeps clear of the composer in ${tab}`);
      if (tab === 'chat') await capture?.('call-pill-chat-tab');
    }
    assert.ok(Object.values(demoState.botsVoice.calls).some(c => !c.ended), 'the call record is still open');
    await capture?.('call-pill-other-tab');
    // The bot posts in its chat while the call is minimized and the chat is not on screen: a dot, which opens the chat.
    require('./fixtures/bots-chat-backend.cjs').latest.seed(sid, [{ role: 'assistant', content: 'Your report is ready.' }]);
    await waitFor(`!${pill}.querySelector('.call-pill-unread').hidden`, 15000);
    await capture?.('call-pill-unread');
    await js(`${pill}.querySelector('.call-pill-unread').click()`);
    await waitFor(`document.querySelector('.bots-shell')?.dataset.agentId===${q(botId)} && ${pill}.querySelector('.call-pill-unread').hidden && !${pill}.hidden`);
    // A desktop pill drags to a corner and stays there.
    const corner = await js("localStorage.getItem('kairos:call-pill-corner')");
    await js(`(()=>{const b=${pill}.querySelector('.call-pill-back'),r=b.getBoundingClientRect(),o={bubbles:true,pointerId:7,button:0,isPrimary:true};b.dispatchEvent(new PointerEvent('pointerdown',{...o,clientX:r.left+20,clientY:r.top+20}));b.dispatchEvent(new PointerEvent('pointermove',{...o,clientX:120,clientY:140}));b.dispatchEvent(new PointerEvent('pointerup',{...o,clientX:120,clientY:140}));return true})()`);
    await delay(50);
    assert.equal(await js(`${pill}.dataset.corner`), 'top-left', 'a drag drops the pill in the nearest corner');
    assert.ok(await js(`(()=>{const r=${pill}.getBoundingClientRect();return r.left<=20&&r.top<innerHeight/2})()`), 'and it moves there');
    assert.equal(await js('document.querySelector(\'.agent-call\').open'), false, 'a drag is not a tap');
    await js(`(${q(corner)}===null?localStorage.removeItem('kairos:call-pill-corner'):localStorage.setItem('kairos:call-pill-corner',${q(corner)}),${pill}.refresh?.(),true)`);
    // Tap returns to the full call.
    await js(`${pill}.querySelector('.call-pill-back').click()`);
    await waitFor(`document.querySelector('.agent-call').open && ${pill}.hidden`);
    // Back to chat (More) is the same minimize; another bot's page offers Return to call.
    await js("document.querySelector('.agent-call [data-call=chat]').click()");
    await waitFor(`!${pill}.hidden && !document.querySelector('.agent-call').open`);
    await navigate('botsShell', { agentId: otherBot, sessionId: otherSid });
    await waitFor(`!${pill}.hidden && document.querySelector('.agent-call-open')?.textContent==='Return to call'`);
    // A phone: the pill docks at the bottom, full width, above the composer.
    await win.setContentSize(390, 844); await delay(250);
    const phonePill = await js(`(()=>{const r=${pill}.getBoundingClientRect(),c=document.querySelector('.bots-shell .bots-composer')?.getBoundingClientRect();return {left:Math.round(r.left),width:Math.round(r.width),bottom:r.bottom,inner:innerHeight,clear:!c||r.bottom<=c.top+1,corner:${pill}.dataset.corner}})()`);
    assert.equal(phonePill.corner, 'bottom', 'on a phone the pill docks at the bottom');
    assert.ok(phonePill.left === 12 && phonePill.width === 390 - 24, `edge to edge inside a 12 px gutter (${JSON.stringify(phonePill)})`);
    assert.ok(phonePill.clear && phonePill.bottom <= phonePill.inner - 12, 'above the composer and the bottom edge');
    await capture?.('phone-call-pill');
    await win.setContentSize(...originalSize); await delay(150);
    await js("document.querySelector('.call-pill .call-pill-back').click()");
    await waitFor("document.querySelector('.agent-call').open");
    await js("document.querySelector('.agent-call [data-call=chat]').click()");
    await waitFor(`!${pill}.hidden`);
    // Hang up from the pill (its shortcut).
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'h',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))");
    await waitFor(`!${pill}`);
    await waitFor("document.querySelector('.agent-call-open')?.textContent==='Call'");
    await navigate('botsShell', { agentId: botId, sessionId: sid });
    await waitFor("!!document.querySelector('.bots-chat-host .bots-composer')");
    // Exercise the real read-aloud endpoint and device queue.
    await js(`(async()=>{const {createReadAloud}=await import('/static/js/botsSpeak.js');window.__botsVoiceCheck.reader=createReadAloud();await window.__botsVoiceCheck.reader.update('Hello there. The reply is ready.',true);return true;})()`);
    await waitFor("window.__botsVoiceCheck.spoken.length===2");
    const result = await call(`/api/bot-voice/${botId}/notes`, 'POST', { text: 'A short note for you.' }); assert.equal(result.status, 200);
    await js(`(async()=>{const m=await import('/static/js/botsVoiceNote.js');const slot=document.createElement('div');slot.id='voice-check-note';document.querySelector('.bots-chat-host').append(slot);slot.append(m.renderVoiceNoteRow({voice_note:${q(result.body)}}));return true;})()`);
    await click('.bots-voice-note button'); await waitFor("document.querySelector('.bots-voice-transcript')?.textContent==='A short note for you.'");
    assert.ok(await js("document.querySelector('.bots-voice-note audio').controls"));
    await waitFor("document.querySelector('.bots-voice-note audio').readyState>=1");
    await js("document.querySelector('.bots-voice-note audio').currentTime=.05");
    assert.ok(await js("document.querySelector('.bots-voice-note audio').currentTime>=.04"), 'voice note can seek');
    await js(`import('/static/js/botsPanelHost.js').then(m=>m.openBotSettings(${q(botId)},{section:'voice'}))`);
    // The built-in Voice and alerts section saves Speak its replies.
    const voiceCard = '[data-panel-card=voice]';
    const speakRow = `[...document.querySelector(${q(voiceCard)})?.querySelectorAll('.bots-switch-row')||[]].find(r=>r.querySelector('.bots-row-title')?.textContent.trim()==='Speak its replies')`;
    await waitFor(`!!${speakRow}`);
    await js(`${speakRow}.click()`);
    await waitFor(`fetch('/api/agents/${botId}').then(r=>r.json()).then(d=>d.agent.speak_replies===true)`);
    await win.setContentSize(390, 844);
    assert.deepEqual(await js(`[...document.querySelector(${q(voiceCard)}).querySelectorAll('.bots-switch-row,button:not(.bots-switch),select')].filter(n=>n.getBoundingClientRect().width).filter(n=>n.getBoundingClientRect().height<44).map(n=>n.className+' '+n.textContent.slice(0,30)+' '+n.getBoundingClientRect().height)`), [], 'voice tap targets are 44px on a phone (a switch row is tapped as a whole)');
    await capture?.('phone-bots-voice');
  } finally {
    await js(`(()=>{const t=window.__botsVoiceCheck;if(t){t.reader?.destroy();t.source?.stop();t.context?.close();window.SpeechSynthesisUtterance=t.utterance;if(t.synthesis)Object.defineProperty(window,'speechSynthesis',t.synthesis);else delete window.speechSynthesis;navigator.mediaDevices.getUserMedia=t.getUserMedia;delete window.__botsVoiceCheck;}document.querySelector('#voice-check-note')?.remove();return true;})()`).catch(() => {});
    await js("document.querySelector('.agent-call .is-end')?.click();import('/static/js/botsPanelHost.js').then(m=>m.closeBotSettings({restoreFocus:false}))").catch(() => {});
    if (sid) await call(`/api/agents/${botId}/threads/delete`, 'POST', { thread_ids: [sid] }).catch(() => {});
    if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
    if (otherSid) await call(`/api/agents/${otherBot}/threads/delete`, 'POST', { thread_ids: [otherSid] }).catch(() => {});
    if (otherBot) await call(`/api/agents/${otherBot}`, 'DELETE').catch(() => {});
    await js(`(()=>{for(const [key,value] of Object.entries(${q(preferences)})){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}return true;})()`).catch(() => {});
    await win.setContentSize(...originalSize); await restore();
  }
};

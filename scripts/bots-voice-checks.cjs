// Written for the orchestrator. Uses synthetic device audio, never a microphone or voice server.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
module.exports = async ({ js, waitFor, navigate, win, demoState, base, capture }) => {
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
    await js("[...document.querySelectorAll('.agent-call-tabs button')].find(n=>n.textContent==='Chat').click()");
    await waitFor("!!document.querySelector('.bots-call-bar:not([hidden])') && !document.querySelector('.agent-call').open");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))");
    await waitFor("[...document.querySelectorAll('.bots-call-bar button')].some(n=>n.textContent==='Unmute')");
    await navigate('botsShell', { agentId: otherBot, sessionId: otherSid });
    await waitFor("document.querySelector('.bots-call-bar')?.hasAttribute('data-floating') && document.querySelector('.agent-call-open')?.textContent==='Return to call'");
    await js("[...document.querySelectorAll('.bots-call-bar button')].find(n=>n.textContent==='Return to call').click()");
    await waitFor("document.querySelector('.agent-call').open");
    await js("[...document.querySelectorAll('.agent-call-tabs button')].find(n=>n.textContent==='Chat').click()");
    await waitFor("!!document.querySelector('.bots-call-bar:not([hidden])')");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'h',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))");
    await waitFor("!document.querySelector('.bots-call-bar')");
    assert.ok(Object.values(demoState.botsVoice.calls).every(c => c.ended));
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

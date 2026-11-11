// A ring answered with no tap, and the one call summary message (2026-11-11, David's iPhone: a ring answered from its
// push notification gave a dead call, every later call in that page load was dead until a refresh, and a call's
// summary landed as a run of messages). Synthetic device audio only: a lockable AudioContext stands in for a phone's
// audio rules (resume() waits for a tap that never comes), and getUserMedia can refuse once. No microphone, no server.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, demoState, capture }) => {
  const q = JSON.stringify;
  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined, botsVoice: {
    callsEnabled: true, catalog: { voices: [], models: [] }, notes: {}, counter: 0, log: [],
  } });
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, {method:${q(method)},headers:{'Content-Type':'application/json'},body:${body ? q(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,body:await r.json()}))`);
  const name = `Ring ${Date.now()} ${Math.random().toString(16).slice(2, 6)}`;
  const dialog = `document.querySelector(${q(`dialog.agent-call[aria-label="Voice call with ${name}"]`)})`;
  const calls = () => Object.values(demoState.botsVoice.calls || {});
  const hangUp = async () => {
    await js(`${dialog}.querySelector('[data-call=hangup]').click()`);
    await waitFor(`!${dialog}.open`);
  };
  const answerRing = id => js(`import('/static/js/ringHost.js').then(m=>{m.setPendingRing({id:${q(id)},agentId:window.__ringCheck.botId,reason:'Just calling to say hi.',name:${q(name)}});document.dispatchEvent(new CustomEvent('kairos:ring-answered',{detail:{agentId:window.__ringCheck.botId}}));return true;})`);
  let botId, sid, preferences = {};
  try {
    botId = (await call('/api/agents', 'POST', { name })).body.id;
    sid = (await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Ring checks' })).body.id;
    assert.ok(botId && sid);
    // A texting-style bot (David's Kip): a long reply is split into bubbles, which is how one call summary read as many.
    assert.equal((await call(`/api/agents/${botId}`, 'PATCH', { reply_style: 'conversational' })).status, 200);
    preferences = await js(`Object.fromEntries(${q(['kairos:call-conversation:', 'kairos:call-model:v2:', 'kairos:call-input:', 'kairos:neural-voice:', 'kairos:agent-voice:'].map(prefix => prefix + botId))}.map(key=>[key,localStorage.getItem(key)]))`);
    demoState.botsVoice.botIds = [botId];
    // The call summaries this bot's chat already holds: one new-style (details on the message), one saved before the fix.
    require('./fixtures/bots-chat-backend.cjs').latest.seed(sid, [
      { role: 'user', content: 'Ring me to say hi.' },
      { role: 'assistant', content: 'First paragraph of a normal reply.\n\nSecond paragraph of it.' },
      { role: 'assistant', content: '**Call summary.** Kip rang to say hi; David confirmed the call works.', call_summary_id: 'a'.repeat(32),
        call_details: { transcript: '**You:** Is the build green?\n\n**Kip:** Yes, all green.', latency: 'Latency: first audio 640 ms after pick-up.', work: [{ title: 'Check the build', status: 'done', task_id: 't1' }], note: '', seconds: 125 } },
      { role: 'assistant', content: '**Call summary**\n\n# Call Notes\n\n- Tested the call.\n\nLatency: first audio 3131 ms after pick-up.\n\n**Transcript**\n\n**You:** Hello?\n\n**Kip:** Hi David.', call_summary_id: 'b'.repeat(32) },
    ]);
    await js(`(async()=>{
      const t=window.__ringCheck={botId:${q(botId)},utterance:window.SpeechSynthesisUtterance,synthesis:Object.getOwnPropertyDescriptor(window,'speechSynthesis'),getUserMedia:navigator.mediaDevices.getUserMedia,Real:window.AudioContext,spoken:[],locked:false,inTap:false,resumes:[],denyMic:0};
      t.context=new t.Real();const source=t.context.createOscillator(),gain=t.context.createGain(),destination=t.context.createMediaStreamDestination();gain.gain.value=0;source.connect(gain);gain.connect(destination);source.start();t.source=source;
      navigator.mediaDevices.getUserMedia=async()=>{if(t.denyMic>0){t.denyMic--;throw new DOMException('Permission denied','NotAllowedError');}return destination.stream.clone();};
      // A phone's audio rule: while locked, a context stays suspended and resume() waits for a tap that never comes.
      window.AudioContext=class extends t.Real{
        get state(){return t.locked&&!this.__started?'suspended':super.state;}
        resume(){t.resumes.push({locked:t.locked,inTap:t.inTap});if(t.locked)return new Promise(()=>{});this.__started=true;return super.resume();}
      };
      window.SpeechSynthesisUtterance=class extends EventTarget{constructor(text){super();this.text=text;}};
      Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{pending:false,speaking:false,getVoices:()=>[{name:'Fixture device',lang:'en-GB',localService:true}],addEventListener(){},cancel(){this.pending=false;this.speaking=false;},speak(u){t.spoken.push(u.text);this.speaking=true;queueMicrotask(()=>{u.dispatchEvent(new Event('start'));this.speaking=false;u.dispatchEvent(new Event('end'));});}}});
      return true;
    })()`);
    await navigate('botsShell', { agentId: botId, sessionId: sid }); await waitFor("!!document.querySelector('.agent-call-open')");

    // -- Bug 2: one call, one message -------------------------------------------------------------------------------
    await waitFor("[...document.querySelectorAll('.bots-msg')].some(n=>n.textContent.includes('Kip rang to say hi'))");
    const cards = await js(`[...document.querySelectorAll('.bots-msg.bot')].map(n=>({text:n.textContent,bubbles:n.querySelectorAll('.bots-msg-bubble').length,fold:n.querySelector('.call-summary-details > summary')?.textContent||null,inside:n.querySelector('.call-summary-details')?.textContent||''}))`);
    const normal = cards.find(c => c.text.includes('First paragraph')), fresh = cards.find(c => c.text.includes('Kip rang to say hi')), legacy = cards.find(c => c.text.includes('Tested the call'));
    assert.equal(normal.bubbles, 2, 'a conversational bot still splits an ordinary reply');
    assert.equal(fresh.bubbles, 1, 'a call summary is one message, never split into bubbles');
    assert.equal(fresh.fold, 'Transcript and details', 'its transcript and latency fold under it');
    for (const part of ['Is the build green?', 'Latency: first audio 640 ms after pick-up.', 'Check the build: done', 'Length: 2 min 5 s.']) assert.ok(fresh.inside.includes(part), `the fold holds: ${part}`);
    assert.equal(await js("document.querySelector('.bots-call-summary .call-summary-details').open"), false, 'and starts folded');
    assert.equal(legacy.bubbles, 1, 'a summary saved before the fix is one message too');
    assert.ok(legacy.fold === 'Transcript and details' && legacy.inside.includes('Hi David.'), 'with its old transcript folded');
    assert.equal(cards.filter(c => c.text.includes('Call summary')).length, 2, 'one card per call');
    await capture?.('call-summary-one-message');

    // -- Bug 1a: a ring answered with no tap waits for one --------------------------------------------------------------
    await js('window.__ringCheck.locked=true;true');
    const before = calls().length;
    await answerRing('c'.repeat(32));
    await waitFor(`${dialog}?.open && ${dialog}.dataset.gate==='open'`, 15000);
    const gated = await js(`(()=>{const d=${dialog};return {status:d.querySelector('.agent-call-status').textContent,label:d.querySelector('[data-call=answer]').textContent,ring:d.querySelector('.agent-call-ring').textContent,ringShown:!d.querySelector('.agent-call-ring').hidden,mute:d.querySelector('[data-call=mute]').disabled,end:d.querySelector('[data-call=hangup]').getAttribute('aria-label'),state:d.dataset.state}})()`);
    assert.equal(gated.status, 'Tap Answer to start the call.', 'it says plainly what to do, never "Ready when you are"');
    assert.equal(gated.label, 'Answer', 'with one big Answer key');
    assert.ok(gated.ringShown && gated.ring.includes('Just calling to say hi.'), 'and who rang and why');
    assert.equal(gated.state, 'setup');
    assert.equal(calls().length, before, 'no call is opened on the server while the audio is locked');
    await capture?.('ring-answer-tap-to-answer');
    // The tap: the voice is asked to start inside it, and the call goes live with the ring's opening.
    await js(`(()=>{const t=window.__ringCheck;t.locked=false;t.resumes=[];t.inTap=true;${dialog}.querySelector('[data-call=answer]').click();t.inTap=false;return true})()`);
    assert.ok(await js('window.__ringCheck.resumes.some(r=>r.inTap)'), 'the Answer tap starts the audio inside the tap');
    try { await waitFor(`${dialog}.dataset.state==='listening'`, 15000); }
    catch (problem) { console.log('DEBUG', JSON.stringify(await js(`(()=>{const d=${dialog};return {state:d.dataset.state,status:d.querySelector('.agent-call-status').textContent,error:d.querySelector('.agent-call-error').textContent,blocker:d.querySelector('.agent-call-blocker').textContent,gate:d.dataset.gate,resumes:window.__ringCheck.resumes}})()`)), JSON.stringify(demoState.botsVoice.log), JSON.stringify(calls())); throw problem; }
    assert.ok(await js(`${dialog}.dataset.gate===undefined && ${dialog}.querySelector('.agent-call-gate').hidden`), 'the key goes once the call is live');
    const answered = calls().at(-1);
    assert.equal(answered.ring_id, 'c'.repeat(32), 'the call answers that ring');
    for (let i = 0; i < 40 && !demoState.botsVoice.log.some(e => e.route === `/api/agent-calls/${answered.id}/opening`); i++) await delay(50);
    assert.ok(demoState.botsVoice.log.some(e => e.route === `/api/agent-calls/${answered.id}/opening`), 'and the bot opens with why it rang');
    assert.equal(await js(`${dialog}.querySelector('[data-call=mute]').disabled`), false, 'Mute works in the live call');
    await hangUp();
    assert.ok(calls().at(-1).ended, 'hanging up ends it');

    // -- Bug 1b: after a dead start, the next call in the same page load works with no refresh --------------------------
    // Hang up while the start is still waiting on locked audio (the old code kept `starting` forever).
    await js('window.__ringCheck.locked=true;true');
    await js(`document.querySelector('.agent-call-open').click()`);
    await waitFor(`${dialog}.open && ${dialog}.dataset.state==='preparing'`);
    await hangUp();
    await delay(1900);   // past AUDIO_WAIT_MS: the abandoned start's timeout must not reopen anything
    assert.equal(await js(`${dialog}.open`), false, 'an abandoned start stays abandoned');
    // Locked again, the Call button reaches the tap key instead of a dead screen, and Close leaves cleanly.
    await js(`document.querySelector('.agent-call-open').click()`);
    await waitFor(`${dialog}.dataset.gate==='open'`, 15000);
    assert.equal(await js(`${dialog}.querySelector('[data-call=answer]').textContent`), 'Tap to start', 'a plain call says Tap to start');
    await hangUp();
    await js('window.__ringCheck.locked=false;true');
    const count = calls().length;
    await js(`document.querySelector('.agent-call-open').click()`);
    await waitFor(`${dialog}.dataset.state==='listening'`, 15000);
    assert.equal(calls().length, count + 1, 'the next call starts, in the same page load');
    await hangUp();

    // -- Bug 1c: a refused microphone says so, with a retry, and the retry works ----------------------------------------
    await js('window.__ringCheck.denyMic=1;true');
    await js(`document.querySelector('.agent-call-open').click()`);
    await waitFor(`!${dialog}.querySelector('.agent-call-blocker').hidden`, 15000);
    const refused = await js(`(()=>{const d=${dialog};return {status:d.querySelector('.agent-call-status').textContent,text:d.querySelector('.agent-call-blocker p').textContent,action:d.querySelector('.agent-call-blocker-action').textContent}})()`);
    assert.equal(refused.status, 'Call could not start');
    assert.equal(refused.text, 'Kairos needs your microphone for calls. Allow it, then try again.');
    assert.equal(refused.action, 'Allow microphone');
    await js(`${dialog}.querySelector('.agent-call-blocker-action').click()`);
    await waitFor(`${dialog}.dataset.state==='listening'`, 15000);
    await hangUp();

    // -- Bug 1d: an answer that already has its tap (desktop, the in-app ring sheet) goes straight in -------------------
    await js(`(()=>{const d=${dialog};window.__ringCheck.gateSeen=false;window.__ringCheck.watch=new MutationObserver(()=>{if(d.dataset.gate==='open')window.__ringCheck.gateSeen=true;});window.__ringCheck.watch.observe(d,{attributes:true});return true})()`);
    await answerRing('d'.repeat(32));
    await waitFor(`${dialog}.dataset.state==='listening'`, 15000);
    assert.equal(await js('window.__ringCheck.gateSeen'), false, 'no extra tap when the audio is already allowed');
    assert.equal(calls().at(-1).ring_id, 'd'.repeat(32));
    await hangUp();
  } finally {
    await js(`(()=>{const t=window.__ringCheck;if(t){t.watch?.disconnect();t.source?.stop();t.context?.close();window.AudioContext=t.Real;window.SpeechSynthesisUtterance=t.utterance;if(t.synthesis)Object.defineProperty(window,'speechSynthesis',t.synthesis);else delete window.speechSynthesis;navigator.mediaDevices.getUserMedia=t.getUserMedia;delete window.__ringCheck;}return true;})()`).catch(() => {});
    await js(`(()=>{const d=document.querySelector(${q(`dialog.agent-call[aria-label="Voice call with ${name}"]`)});d?.querySelector('[data-call=hangup]')?.click();return true})()`).catch(() => {});
    if (sid) await call(`/api/agents/${botId}/threads/delete`, 'POST', { thread_ids: [sid] }).catch(() => {});
    if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
    await js(`(()=>{for(const [key,value] of Object.entries(${q(preferences)})){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}return true;})()`).catch(() => {});
    await restore();
  }
};

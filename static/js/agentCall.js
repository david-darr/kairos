// Native Kairos calls: call-owned dialogue, streamed speech and delegated agent work.
import { api, el, toast } from './api.js';
import { liveVoice } from './callLive.js';
import { realtimeVoice } from './realtimeVoice.js';
import { callTransport } from './callTransport.js';
import { voiceSettings, neuralSpeaker } from './callVoice.js';
import { transcribeBlob, transcribePartial, refreshSpeechStatus, encodeWav } from './voiceInput.js';
import { createPartialTranscriber } from './partialTranscript.js';
import { createCallRecorder, isCallRecordingSupported } from './callRecorder.js';
import { createTurnEndpoint, postTurn } from './turnEndpoint.js';
import { createSpeaker, isSpeechOutputSupported, whenVoicesReady, resolveVoice } from './voiceOutput.js';
import { createMascot } from './mascot.js';
import { createVoiceTrace } from './voiceTrace.js';
import { takePendingRing } from './ringHost.js';
import { createFillerGate, fetchFillerClip } from './voiceFiller.js';
import { isBackchannel, endsInQuestion } from './backchannel.js';

// In a call the bot's Kip replaces the orb (Kairos Mascot build spec,
// 2026-10-22). It reads the orb's --level (microphone) and --word (speech)
// by inheritance: eyes widen while listening, squash and the point pulses
// while speaking, and a halo swells with the level. The orb core stays as
// the fallback when Show Kip is off.
const CALL_MASCOT = { setup: 'idle', preparing: 'thinking', listening: 'listening', transcribing: 'thinking', thinking: 'thinking', speaking: 'speaking', paused: 'sleeping' };
let ongoingCall = null;

export function agentCall(agent, controller) {
  if (ongoingCall?.isActive()) {
    const current = ongoingCall;
    const button = el('span', { class: 'agent-call-slot' });
    button.append(el('button', { type: 'button', class: 'agent-call-open btn quiet', text: 'Return to call', onclick: () => current.restore() }));
    let replacement = null, dead = false, summaryTimer = null;
    const refreshSummary = async (id, attempt = 0) => {
      if (dead || attempt > 90) return;
      try {
        const record = await api(`/api/agent-calls/${id}`, { toast: false });
        if (dead) return;
        if (record.summary_state === 'saved') { await controller.summarySaved?.(record); return; }
        if (record.summary_state === 'failed') return;
      } catch { /* a later check can recover a pending summary */ }
      summaryTimer = setTimeout(() => refreshSummary(id, attempt + 1), 2000);
    };
    const ended = event => {
      if (dead || event.detail.active || current.isActive()) return;
      document.removeEventListener('kairos:bots-call-state', ended);
      replacement = agentCall(agent, controller); button.replaceChildren(replacement.button);
      if (event.detail.callId && event.detail.agentId === agent.id && event.detail.sessionId === controller.sessionId()) refreshSummary(event.detail.callId);
    };
    document.addEventListener('kairos:bots-call-state', ended);
    return { button, update() {}, dispose() { dead = true; clearTimeout(summaryTimer); document.removeEventListener('kairos:bots-call-state', ended); replacement?.dispose(); button.remove(); } };
  }
  let recorder = null, active = false, disposed = false, starting = false, epoch = 0;
  let minimized = false, detached = false, callBar = null, lastActivity = Date.now();
  let livePrefs = { voice: 'marin', read_typed: false, idle_minutes: 5 };
  let readingTyped = false;
  const emitState = () => {
    document.documentElement.dataset.botsCallActive = String(active);
    document.dispatchEvent(new CustomEvent('kairos:bots-call-state', { detail: { agentId: agent.id, sessionId: controller.sessionId(), callId: transport.record?.id || null, active, minimized, muted: microphoneMuted, startedAt } }));
    callBar?.refresh();
  };
  const restore = () => { minimized = false; if (!dialog.open) dialog.showModal(); emitState(); };
  const minimize = async () => {
    if (!active) return;
    minimized = true; cancelHold(); dialog.close();
    try {
      const { mountCallBar } = await import('./botsCallBar.js');
      if (!active || disposed) return;
      callBar ||= mountCallBar({ agent, members: room ? room.memberIds().map(id => room.memberName(id)) : null, snapshot: () => ({ active, minimized, muted: microphoneMuted, startedAt }),
        mute: () => setMicrophoneMuted(!microphoneMuted), hangup, restore,
        onSettings: () => { document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'settings', section: 'bot-voice' } })); minimize(); } });
      emitState();
    } catch { minimized = false; if (!dialog.open) dialog.showModal(); error.textContent = 'Call bar could not load. The call is still open.'; }
  };
  let microphoneMuted = false, assistantMuted = false, state = 'setup';
  let pending = null, startedAt = 0, timer = null, downloadTimer = null;
  const turnEndpoint = createTurnEndpoint({ post: postTurn, encode: pcm => encodeWav(pcm, 16000) });
  let voices = [], speech = null, wordTimer = null, speechFlushTimer = null;
  let speechActive = false, audioQueue = [], texts = [], transcribing = false, dispatching = false, revision = 0;
  let response = null, deferredReply = null, recognitionTiming = {};
  let holding = false, holdPointer = null, voiceBusy = false, utteranceEnded = 0;
  let workUpdates=[], announcedWork=new Set();
  // Latency of each spoken turn, kept in memory for this call (see voiceTrace.js).
  const voiceTrace=createVoiceTrace({label:'call'});let turnTrace=null, currentTrace=null, flushQueued=false;
  // Rolling transcription while the user talks (partialTranscript.js): captions the words as they come and lets the end of
  // the turn send only a tail, or nothing. Any failure there falls back to the whole clip.
  const partials=createPartialTranscriber({send:(wav,signal)=>transcribePartial(wav,{signal,model:model.value,backend:acceleration.value}),
    onText:text=>{if(active&&!microphoneMuted&&text)heard.textContent=`Hearing: ${text}`;}});
  let bargeIns=0, backchannels=0, utterance={during:false,asked:false}, fillerOn=false;
  // A call that answers a ring (ringHost.js): the bot opens with the reason it rang. Taken by the first call screen that opens.
  let ring = null, ringOpening = null;
  const announceWork=id=>{if(active&&callMode.value==='local'&&!announcedWork.has(id)){announcedWork.add(id);workUpdates.push(id);scheduleFlush();}};
  let endpoints = [];
  // A group call (a room's controller has roomId): each reply names the member who spoke, and on device voices
  // every member gets a different voice. Its summary goes to the room, so "chat" reads "room" in the copy.
  const room = controller.roomId?.() ? controller : null;
  let speaking = null;
  const who = () => speaking?.name || agent.name;
  const savedIn = room ? 'the room' : 'chat';
  const conversationKey = `kairos:call-conversation:${agent.id}`;
  const conversation = el('select', {'aria-label':'Conversation model connection'});
  const conversationModel = el('input', {type:'text','aria-label':'Conversation model version',placeholder:'Exact model ID'});
  const modelSuggestions=el('datalist',{id:`call-models-${agent.id}`});conversationModel.setAttribute('list',modelSuggestions.id);
  const workList = el('div', {class:'agent-call-work','aria-label':'Call work'});
  const summaryStatus = el('div', {class:'agent-call-summary',role:'status'});
  const transport = callTransport(controller, record => {
    workList.replaceChildren(...record.jobs.map(job => el('div',{},[el('span',{text:`${job.title}: ${job.status}`}), ...(['ready','running'].includes(job.status)?[el('button',{type:'button',class:'btn quiet',text:'Stop work',onclick:()=>transport.stopWork(job.task_id)})]:[])])));
    if(record.live_error)error.textContent=record.live_error;
    if(active&&callMode.value==='local')for(const job of record.jobs)if(!['ready','running'].includes(job.status))announceWork(job.task_id);
    if(record.ended&&active)hangup();
    if(record.ended) { summaryStatus.textContent = record.summary_state==='saved'?`Call summary saved in ${savedIn}.`:record.summary_state==='failed'?record.summary_error:'Saving call summary?'; }
  }, event => { if (event.type === 'work' && event.task_id) { announceWork(event.task_id); transport.refresh(); } });
  const callMode=el('select',{'aria-label':'Call mode'},[el('option',{value:'local',text:'Local recognition + conversation model'}),...(room?[]:[el('option',{value:'cloud',text:'GPT-Live (paid cloud voice)'}),el('option',{value:'realtime',text:'Realtime speech-to-speech (your OpenAI, Grok or Gemini key)'})])]);
  const liveEndpoint=el('select',{'aria-label':'Cloud voice API connection'});
  const liveVoiceChoice=el('select',{'aria-label':'Cloud voice'},['marin','cedar','coral','sage','ash'].map(name=>el('option',{value:name,text:name})));
  const paid=el('input',{type:'checkbox','aria-label':'Use paid cloud voice for this call'});
  const consentText=el('span',{text:'Use paid cloud voice for this call. Audio is sent to OpenAI; voice and backend model usage are billed to your API account.'});
  const realtimeChoice=()=>callMode.value==='realtime'?(liveChoicesByMode.realtime||[]).find(e=>e.id===liveEndpoint.value):null;
  const cloudSetup=el('div',{hidden:true,class:'agent-call-cloud-setup'},[el('label',{},[el('span',{text:'Voice API connection'}),liveEndpoint]),el('label',{},[el('span',{text:'Live voice'}),liveVoiceChoice]),el('label',{class:'agent-call-consent'},[paid,consentText])]);
  // No realtime connection yet: offer the free Gemini key setup right here (freeVoiceSetup.js).
  const freeVoice=el('button',{type:'button',class:'btn agent-call-free-voice',text:'Set up free Gemini voice',hidden:true});
  freeVoice.onclick=async()=>{const {openFreeVoiceSetup}=await import('./freeVoiceSetup.js');openFreeVoiceSetup({onConnected:async()=>{try{const found=await api('/api/agent-calls/realtime-choices',{toast:false});liveChoicesByMode.realtime=Array.isArray(found)?found:[];}catch{}fillLiveChoices();syncModel();}});};
  const liveCallbacks=[next=>{if(!active)return;if(next==='ended'){hangup();return;}setState(next,next==='speaking'?`${agent.name} is speaking. You can interrupt naturally.`:'Listening...');},(role,delta)=>{heard.textContent=(heard.dataset.speaker===role?heard.textContent:`${role}: `)+delta;heard.dataset.speaker=role;},level=>orb.style.setProperty('--word',String(level)),message=>{error.textContent=message;}];
  const gptLive=liveVoice(...liveCallbacks);
  let realtimeInfo=null;
  const realtimeLive=realtimeVoice(...liveCallbacks,info=>{if(info.work){announceRealtimeWork(info.work);return;}realtimeInfo=info;});
  let liveImpl=gptLive;
  const live={start(...args){liveImpl=callMode.value==='realtime'?realtimeLive:gptLive;realtimeInfo=null;return liveImpl.start(...args);},muteMicrophone:value=>liveImpl.muteMicrophone(value),muteAssistant:value=>liveImpl.muteAssistant(value),stop(){gptLive.stop();realtimeLive.stop();}};
  const isCloud=()=>callMode.value==='cloud'||callMode.value==='realtime';
  let liveChoicesByMode={cloud:[],realtime:[]};
  function fillLiveChoices(){const choices=liveChoicesByMode[callMode.value]||[];liveEndpoint.replaceChildren(...choices.map(e=>el('option',{value:e.id,text:e.provider?`${e.name} (${e.label})`:e.name})));fillLiveVoices();}
  function fillLiveVoices(){if(callMode.value!=='realtime'){liveVoiceChoice.replaceChildren(...['marin','cedar','coral','sage','ash'].map(name=>el('option',{value:name,text:name})));return;}const choice=liveChoicesByMode.realtime.find(e=>e.id===liveEndpoint.value);liveVoiceChoice.replaceChildren(...(choice?.voices||[]).map(name=>el('option',{value:name,text:name})));if(choice)liveVoiceChoice.value=choice.default_voice;}
  function announceRealtimeWork(work){transport.refresh();if(work.status!=='running'&&work.task_id)announceWork(work.task_id);}
  // The call screen shows who is speaking and a running cost estimate (the provider's own bill is the truth).
  function drawRealtimeCost(seconds){if(callMode.value!=='realtime'||!realtimeInfo)return;if(realtimeInfo.free_tier){timing.textContent=`${realtimeInfo.label} (${realtimeInfo.model}) on your free key: no charge, within Google's free-tier limits`;return;}const cost=seconds/60*realtimeInfo.price_per_minute;timing.textContent=`${realtimeInfo.label} (${realtimeInfo.model}): about $${cost.toFixed(2)} so far, an estimate at $${realtimeInfo.price_per_minute.toFixed(2)} a minute${realtimeInfo.verified?'':'; not yet checked against the live service'}`;}
  const modelKey = `kairos:call-model:v2:${agent.id}`;
  const modeKey = `kairos:call-input:${agent.id}`;
  const heard = el('p', { class: 'agent-call-heard', 'aria-live': 'polite' });
  const timing = el('p', { class: 'agent-call-timing', role: 'status' });
  const voiceKey = `kairos:agent-voice:${agent.id}`;
  const dialog = el('dialog', { class: 'agent-call', 'aria-label': room ? `Group call in ${agent.name}` : `Voice call with ${agent.name}` });
  dialog.dataset.state = 'setup';
  const clock = el('time', { class: 'agent-call-clock', text: '00:00' });
  const status = el('div', { class: 'agent-call-status', role: 'status', text: 'Ready when you are' });
  const callMascot = createMascot({ agent, state: 'idle' });
  const orb = el('div', { class: 'agent-call-orb', 'aria-hidden': 'true' }, [el('div', { class: 'agent-call-orb-core' }), callMascot]);
  const error = el('p', { class: 'agent-call-error', role: 'alert' });
  const readiness = el('p', { class: 'agent-call-readiness', role: 'status', text: 'Checking speech on this device...' });
  const voice = el('select', { 'aria-label': 'Call voice', disabled: true });
  const model = el('select', { 'aria-label': 'Speech recognition model' });
  const inputMode = el('select', { 'aria-label': 'Call input mode' }, [el('option', { value: 'automatic', text: 'Automatic' }), el('option', { value: 'hold', text: 'Hold to talk (complete sentences)' })]);
  try { inputMode.value = localStorage.getItem(modeKey) === 'hold' ? 'hold' : 'automatic'; } catch {}
  inputMode.onchange = () => { try { localStorage.setItem(modeKey, inputMode.value); } catch {} };
  const acceleration = el('select', { 'aria-label': 'Speech acceleration' }, [el('option', { value: 'auto', text: 'GPU when configured, otherwise CPU' }), el('option', { value: 'cpu', text: 'Built-in CPU' })]);
  const engineStatus = el('p', { class: 'agent-call-engine', role: 'status' });
  const runtimeFolder = el('input', { type: 'text', placeholder: 'Installed whisper.cpp CUDA folder', 'aria-label': 'Whisper CUDA runtime folder' });
  const runtimeStatus = el('p', { role: 'status' });
  const connectRuntime = el('button', { class: 'btn quiet', type: 'button', text: 'Use runtime', onclick: async () => {
    connectRuntime.disabled = true; runtimeStatus.textContent = 'Checking runtime files...';
    try { await api('/api/speech/runtime', { method: 'POST', body: JSON.stringify({ folder: runtimeFolder.value.trim() }) }); runtimeStatus.textContent = 'Runtime registered. GPU availability is checked when the call starts.'; refreshSpeechStatus(); }
    catch (problem) { runtimeStatus.textContent = problem.message; }
    finally { connectRuntime.disabled = false; }
  } });
  const browseRuntime = el('button', { class: 'btn quiet', type: 'button', text: 'Choose folder', hidden: !window.jarvis?.pickVaultFolder, onclick: async () => {
    const folder = await window.jarvis.pickVaultFolder(); if (folder) runtimeFolder.value = folder;
  } });
  const removeRuntime = el('button', { class: 'btn quiet', type: 'button', text: 'Disconnect runtime', onclick: async () => {
    removeRuntime.disabled = true;
    try { await api('/api/speech/runtime', { method: 'DELETE' }); runtimeStatus.textContent = 'Disconnected. Built-in CPU recognition is available.'; refreshSpeechStatus(); }
    catch (problem) { runtimeStatus.textContent = problem.message; }
    finally { removeRuntime.disabled = false; }
  } });
  const runtimeSetup = el('details', { class: 'agent-call-runtime' }, [el('summary', { text: 'Optional GPU acceleration' }),
    el('p', { text: 'Select an installed whisper.cpp CUDA folder. Kairos manages recognition locally; nothing downloads. Setup requires an administrator.' }), runtimeFolder, browseRuntime, connectRuntime, removeRuntime, runtimeStatus]);
  const modelBox = el('div', { class: 'agent-call-model', hidden: true }, [el('label', {}, [el('span', { text: 'Speech recognition' }), model])]);
  const download = el('button', { class: 'btn quiet', type: 'button', text: 'Download speech model', hidden: true, onclick: downloadModel });
  const start = el('button', { class: 'btn primary', type: 'submit', text: 'Start call', disabled: true });
  const setup = el('form', { class: 'agent-call-setup' }, [readiness, freeVoice,
    el('label', {}, [el('span', { text: 'Voice' }), voice]), modelBox,
    el('label', {}, [el('span', { text: 'Input' }), inputMode]),
    el('label', {}, [el('span', { text: 'Recognition processor' }), acceleration]), runtimeSetup, download, start]);
  const neural = voiceSettings(agent, voice, {changed:()=>{if(speech)syncModel();}});
  setup.prepend(el('label',{},[el('span',{text:'Conversation model'}),conversation]),el('label',{},[el('span',{text:'Model version'}),conversationModel]),el('p',{text:'Choose a fast API or local model for conversation. Your agent keeps its existing work model.'}),neural.node);
  setup.prepend(el('label',{},[el('span',{text:'Call mode'}),callMode]),cloudSetup);
  callMode.onchange=()=>{cloudSetup.hidden=!isCloud();fillLiveChoices();syncModel();};paid.onchange=syncModel;liveEndpoint.onchange=()=>{fillLiveVoices();syncModel();};
  conversation.onchange = () => { conversationModel.value=endpoints.find(e=>e.id===conversation.value)?.model||''; saveConversation();loadConversationModels(); };
  setup.append(modelSuggestions);
  async function loadConversationModels(){const ident=conversation.value;modelSuggestions.replaceChildren();if(!ident)return;try{const models=await api(`/api/models/${encodeURIComponent(ident)}/catalog`);if(conversation.value===ident)modelSuggestions.replaceChildren(...models.map(m=>el('option',{value:m.id,label:m.label||m.id})));}catch{}}
  conversationModel.onchange = saveConversation;
  function saveConversation(){try{localStorage.setItem(conversationKey,JSON.stringify({endpoint:conversation.value,model:conversationModel.value}));}catch{}syncModel();}
  const action = (title, click, cls = '') => el('button', { type: 'button', class: `btn quiet agent-call-action ${cls}`, text: title, onclick: click });
  const assistant = action('Mute assistant', () => {
    assistantMuted = !assistantMuted; assistant.setAttribute('aria-pressed', String(assistantMuted));
    assistant.textContent = assistantMuted ? 'Unmute assistant' : 'Mute assistant';
    if(isCloud())live.muteAssistant(assistantMuted);
    if (assistantMuted && state === 'speaking') { stopPlayback(); listen(); }
  });
  const microphone = action('Mute microphone', () => setMicrophoneMuted(!microphoneMuted));
  assistant.setAttribute('aria-pressed', 'false'); microphone.setAttribute('aria-pressed', 'false');
  const controls = el('div', { class: 'agent-call-controls', hidden: true }, [assistant, microphone,
    action('End call', () => hangup(), 'is-end'), action('Interrupt', interrupt)]);
  function interrupt() {
      if(isCloud()){toast('Speak to interrupt the live conversation. Delegated work keeps running.');return;}
      transport.interrupt(false, state === 'speaking' || voiceBusy ? speaker.heard() : null); voiceBusy=false; partials.cancel();
      revision++; pending?.abort(); audioQueue = []; texts = []; deferredReply = null; speechActive = false;
      cancelHold(); recorder?.setEnabled(false); stopPlayback(); listen(); scheduleFlush();
  }
  const hold = action('Hold to talk', () => {}, 'agent-call-hold');
  controls.append(hold);
  hold.hidden = true; hold.setAttribute('aria-pressed', 'false');
  const holdHint = el('p', { class: 'agent-call-hold-hint', text: 'Hold the button or F9. Release to send. You can pause within a sentence.', hidden: true });
  function cancelHold() { holding = false; holdPointer = null; hold.setAttribute('aria-pressed', 'false'); hold.textContent = 'Hold to talk'; recorder?.cancelHold(); }
  function beginHold() {
    if (!active || microphoneMuted || inputMode.value !== 'hold' || holding || !dialog.open || !recorder) return;
    if (state === 'speaking' || voiceBusy) interrupt();
    holding = true; speechActive = true; hold.setAttribute('aria-pressed', 'true'); hold.textContent = 'Recording. Release to send';
    recorder.beginHold(); status.textContent = 'Recording your full sentence...';
  }
  function endHold() { if (!holding) return; holding = false; holdPointer = null; hold.setAttribute('aria-pressed', 'false'); hold.textContent = 'Hold to talk'; recorder?.endHold(); }
  hold.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); hold.focus(); holdPointer = event.pointerId; hold.setPointerCapture(event.pointerId); beginHold(); });
  hold.addEventListener('pointerup', endHold);
  hold.addEventListener('pointercancel', () => { cancelHold(); speechActive = false; scheduleFlush(); });
  hold.addEventListener('lostpointercapture', () => { if (holding && holdPointer != null) endHold(); });
  function keyDown(event) { if (event.code === 'F9' || event.target === hold && ['Space','Enter'].includes(event.code)) { event.preventDefault(); if (!event.repeat) beginHold(); } }
  function keyUp(event) { if (event.code === 'F9' || event.target === hold && ['Space','Enter'].includes(event.code)) { event.preventDefault(); endHold(); } }
  function loseFocus() { if (holding) { cancelHold(); speechActive = false; if (active) listen(); scheduleFlush(); } }
  dialog.addEventListener('keydown', keyDown); dialog.addEventListener('keyup', keyUp); window.addEventListener('blur', loseFocus);
  document.addEventListener('visibilitychange', visibilityChanged);
  function visibilityChanged() { if (document.hidden) loseFocus(); }
  const chat = action('Chat', () => { if (!active) { hangup(); return; } minimize(); });
  const close = action('Close', () => hangup());
  dialog.append(el('header', { class: 'agent-call-header' }, [clock,
    el('div', { class: 'agent-call-tabs' }, [chat, el('span', { text: 'Voice', 'aria-current': 'page' })]), close]),
    el('div', { class: 'agent-call-scene' }, [orb, el('h1', { text: agent.name }), status]), engineStatus, heard, timing, setup, error, controls, holdHint, workList, summaryStatus,
    el('p', { class: 'agent-call-privacy', text: `Recognition stays on this device. Dialogue goes to your selected conversation model. Only a summary is saved in ${savedIn} after the call.` }));
  const membersLine = el('p', { class: 'agent-call-members' });
  const drawMembers = () => { membersLine.textContent = `With ${room.memberIds().map(id => room.memberName(id)).join(', ')}. Say a name to choose who answers.`; };
  if (room) { drawMembers(); dialog.querySelector('.agent-call-scene').append(membersLine); }
  document.body.append(dialog);
  const ringNote = el('p', { class: 'agent-call-ring', role: 'status', hidden: true });
  dialog.querySelector('.agent-call-scene').append(ringNote);
  const button = el('button', { type: 'button', class: 'agent-call-open btn quiet', 'aria-label': `Call ${agent.name}`, title: `Call ${agent.name}`, text: 'Call', onclick: async () => {
    if (disposed) return;
    if (room) drawMembers();
    dialog.showModal();
    if (active) return;
    error.textContent = ''; await loadSetup();
  } });
  // Answering a ring (ringHost.js) opens this call screen with the reason it rang; the bot says it first.
  const adoptRing = () => {
    const found = takePendingRing(agent.id);
    if (!found || active || disposed) return;
    ring = found; ringOpening = found.id; ringNote.textContent = `${agent.name} is calling: ${found.reason}`; ringNote.hidden = false;
    if (!dialog.open) button.click();
  };
  document.addEventListener('kairos:ring-answered', adoptRing);
  setTimeout(adoptRing, 0);
  // Phone (Kairos Mobile v2): the call button is a round phone icon; the word stays for a desktop.
  const callIcon = el('span', { class: 'agent-call-open-icon', 'aria-hidden': 'true' });
  callIcon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/></svg>';
  button.replaceChildren(callIcon, el('span', { class: 'agent-call-open-label', text: 'Call' }));
  const speakerOptions = {
    onSentenceReady: () => { fillerGate.sentenceReady(); voiceTrace.mark(currentTrace, 'first_sentence'); },
    onSentenceStart: index => { fillerOn = false; voiceTrace.sentenceStart(currentTrace); if (index > 0) drawTiming(); },
    onLevel:level=>{if(active&&state==='speaking')orb.style.setProperty('--word',String(level));},
    getVoice: () => {
      const chosen = voices.find(item => item.name === voice.value) || resolveVoice(voices);
      if (!room || !speaking || !voices.length) return chosen;
      const at = Math.max(0, room.memberIds().indexOf(speaking.id)), base = Math.max(0, voices.indexOf(chosen));
      return voices[(base + at) % voices.length];
    },
    onStart: () => { if (active) { setState('speaking', `${who()} is speaking. Interrupt to speak.`); if (fillerOn) { if (response && response.filler_ms == null) { response.filler_ms = Math.round(performance.now() - response.submitted); drawTiming(); } } else if (response && response.first_audio_ms == null) { response.first_audio_ms=Math.round(performance.now()-response.submitted); response.end_to_audio_ms=utteranceEnded?Math.round(performance.now()-utteranceEnded):null; drawTiming();if(transport.record&&response.end_to_audio_ms!=null)api(`/api/agent-calls/${transport.record.id}/timing`,{method:'POST',toast:false,body:JSON.stringify({end_to_audio_ms:response.end_to_audio_ms,first_audio_ms:response.first_audio_ms,trace:voiceTrace.offsets(currentTrace)})}).catch(()=>{}); } } },
    onEnd: () => { voiceTrace.report(currentTrace); if (readingTyped) { readingTyped = false; if (isCloud()) live.muteMicrophone(microphoneMuted); } if (active && state === 'speaking') { if(voiceBusy)setState('thinking',`${who()} is finishing the reply...`);else listen(); scheduleFlush(); } },
    onBoundary: () => {
      // OS speech exposes word timing, not its PCM amplitude. This pulse
      // follows real word events; microphone energy is measured separately.
      if (!active || state !== 'speaking') return;
      orb.style.setProperty('--word', '1'); clearTimeout(wordTimer);
      wordTimer = setTimeout(() => orb.style.setProperty('--word', '0'), 180);
    },
    onError: () => { if (active) { error.textContent = 'Voice playback failed. Check the selected device voice or mute the assistant to continue.'; if (readingTyped) { stopPlayback(); listen(); } } },
  };
  const deviceSpeaker=createSpeaker(speakerOptions), localSpeaker=neuralSpeaker(speakerOptions,neural.selection);
  const selectedSpeaker=()=>neural.selection().provider==='neural'?localSpeaker:deviceSpeaker;
  const speaker={reset:()=>{clearTimeout(speechFlushTimer);selectedSpeaker().reset();},feed:text=>{selectedSpeaker().feed(text);clearTimeout(speechFlushTimer);speechFlushTimer=setTimeout(()=>selectedSpeaker().flushSentence(),100);},finish:()=>{clearTimeout(speechFlushTimer);selectedSpeaker().finish();},cancel:()=>{clearTimeout(speechFlushTimer);deviceSpeaker.cancel();localSpeaker.cancel();},
    pause:()=>selectedSpeaker().pause?.(),resume:()=>selectedSpeaker().resume?.(),heard:()=>selectedSpeaker().heard?.()||[],filler:clip=>selectedSpeaker().filler?.(clip)};
  // Instant acknowledgement (voiceFiller.js): if no sentence of the answer is ready half a second after the turn was sent.
  const fillerSelection=()=>{const chosen=neural.selection();return chosen.provider==='neural'?chosen:{provider:'device'};};
  const fillerGate=createFillerGate({fetchClip:(last,text)=>fetchFillerClip({selection:fillerSelection(),last,text}),
    blocked:()=>!active||assistantMuted||speechActive||state==='listening'||state==='paused',
    play:clip=>{fillerOn=true;speaker.filler(clip);}});
  const preview=el('button',{type:'button',class:'btn quiet',text:'Preview voice',onclick:async()=>{try{await localSpeaker.prepare();speaker.reset();speaker.feed(`Hi, I'm ${agent.name}. How can I help today?`);speaker.finish();}catch(problem){error.textContent=problem.message;}}});
  setup.insertBefore(preview,modelBox);
  voice.onchange = () => { try { localStorage.setItem(voiceKey, voice.value); } catch {} };
  function setState(next, text) {
    state = next; dialog.dataset.state = next; status.textContent = text;
    if (['speaking', 'thinking', 'transcribing'].includes(next)) lastActivity = Date.now();
    emitState();
    callMascot.setAttribute('state', CALL_MASCOT[next] || 'idle');
    if (next !== 'listening') orb.style.setProperty('--level', '0');
    if (next !== 'speaking') orb.style.setProperty('--word', '0');
    applyMicrophone(next);
  }
  // The microphone is on in every state but speaking/paused/preparing/setup. While Kairos SPEAKS (local, automatic input) it
  // stays open in barge-in mode instead: echo-cancelled capture that only watches for the user's voice over the echo
  // (speechSegments.js BargeIn) and interrupts. Hold-to-talk stays deaf while speaking: pressing the button already interrupts.
  function applyMicrophone(at = state) {
    const duplex = active && !microphoneMuted && at === 'speaking' && callMode.value === 'local' && inputMode.value === 'automatic';
    recorder?.setEnabled(active && !microphoneMuted && (duplex || !['speaking', 'paused', 'preparing', 'setup'].includes(at)), duplex);
  }
  async function loadSetup() {
    const token = epoch; start.disabled = true;
    try {
      const [nextSpeech, available, choices, _, liveChoices, prefs, realtimeChoices, realtimePrefs] = await Promise.all([api('/api/speech/status'), whenVoicesReady(), api('/api/agent-calls/choices'), neural.load(), api('/api/agent-calls/live-choices'), api('/api/bot-voice/live-settings', { toast: false }).catch(() => null), api('/api/agent-calls/realtime-choices', { toast: false }).catch(() => []), api('/api/agent-calls/realtime-settings', { toast: false }).catch(() => null)]);
      if (disposed || epoch !== token || active || !dialog.open) return;
      const asList = value => Array.isArray(value) ? value : [];
      liveChoicesByMode = { cloud: asList(liveChoices), realtime: asList(realtimeChoices) };
      fillLiveChoices();
      if (prefs) { livePrefs = prefs; liveVoiceChoice.value = prefs.voice; }
      if (agent.call_mode === 'realtime' && liveChoicesByMode.realtime.length) {
        callMode.value = 'realtime'; cloudSetup.hidden = false; fillLiveChoices();
        const mine = (realtimePrefs && typeof realtimePrefs === 'object' && (realtimePrefs.bots?.[agent.id] || realtimePrefs)) || {};
        if (mine.endpoint_id && liveChoicesByMode.realtime.some(e => e.id === mine.endpoint_id)) { liveEndpoint.value = mine.endpoint_id; fillLiveVoices(); }
        if (mine.voice && [...liveVoiceChoice.options].some(o => o.value === mine.voice)) liveVoiceChoice.value = mine.voice;
      }
      else if (agent.call_mode === 'live' && liveChoicesByMode.cloud.length) { callMode.value = 'cloud'; cloudSetup.hidden = false; }
      else if (agent.call_mode === 'turns') { callMode.value = 'local'; cloudSetup.hidden = true; }
      if (agent.voice_id) {
        const profile = neural.node.querySelector('[aria-label="Neural voice profile"]');
        const provider = neural.node.querySelector('[aria-label="Voice provider"]');
        if ([...profile.options].some(option => option.value === agent.voice_id)) {
          profile.value = agent.voice_id; provider.value = 'neural'; profile.dispatchEvent(new Event('change'));
        }
      }
      endpoints=choices;let savedConversation={};try{savedConversation=JSON.parse(localStorage.getItem(conversationKey)||'{}');}catch{}
      conversation.replaceChildren(el('option',{value:'',text:'Choose a connection'}),...endpoints.map(e=>el('option',{value:e.id,text:e.name})));
      conversation.value=endpoints.some(e=>e.id===savedConversation.endpoint)?savedConversation.endpoint:'';conversationModel.value=savedConversation.model||endpoints.find(e=>e.id===conversation.value)?.model||'';
      loadConversationModels();
      await loadPendingSummaries();
      start.textContent = 'Start call'; speech = nextSpeech; voices = available.filter(item => item.localService === true);
      let saved = ''; try { saved = localStorage.getItem(voiceKey) || ''; } catch {}
      voice.replaceChildren(...voices.map(item => el('option', { value: item.name, text: `${item.name} (${item.lang})` })));
      voice.value = voices.some(item => item.name === saved) ? saved : resolveVoice(voices)?.name || '';
      voice.disabled = !voices.length;
      let savedModel = model.value; try { savedModel ||= localStorage.getItem(modelKey) || ''; } catch {}
      model.replaceChildren(...(speech.models || []).map(item => el('option', { value: item.name, text: `${item.label} (${item.size_mb} MB${item.downloaded ? ', ready' : ', download needed'})` })));
      model.value = (speech.models || []).some(item => item.name === savedModel) ? savedModel : speech.call_model || 'small.en';
      modelBox.hidden = !speech.engine_available;
      runtimeSetup.hidden = !speech.acceleration?.supported;
      runtimeStatus.textContent = speech.acceleration?.configured ? 'Runtime registered. GPU availability is checked when the call starts.' : 'No GPU runtime configured. CPU recognition is available.';
      neural.sync();syncModel();
    } catch (problem) {
      if (disposed || token !== epoch) return;
      error.textContent = problem.message; readiness.textContent = 'Speech could not load.';
      start.textContent = 'Retry'; start.disabled = false;
    }
  }
  function syncModel() {
    const cloud=isCloud();
    const privacy=dialog.querySelector('.agent-call-privacy');
    const free=realtimeChoice()?.free_tier;
    freeVoice.hidden=!(callMode.value==='realtime'&&!liveEndpoint.value);
    consentText.textContent=callMode.value!=='realtime'?'Use paid cloud voice for this call. Audio is sent to OpenAI; voice and backend model usage are billed to your API account.':free?'Use realtime voice for this call. Audio is sent to Google on your free Gemini key: no charge within Google's free-tier limits, and Google may use it to improve its products.':'Use realtime voice for this call. Audio is sent to the provider you chose and billed to your API account.';
    if(privacy)privacy.textContent=callMode.value==='realtime'&&free?'Realtime voice sends your audio, through Kairos, to Google on your free Gemini key. Real work still goes to this agent. Dialogue stays out of chat; a summary is saved afterwards.':callMode.value==='realtime'?'Realtime voice sends your audio, through Kairos, to the provider you chose and incurs API charges on your key. Real work still goes to this agent. Dialogue stays out of chat; a summary is saved afterwards.':cloud?'Cloud voice sends audio to OpenAI and incurs API charges. Dialogue stays out of chat; a summary is saved afterwards.':`Recognition stays on this device. Dialogue goes to your selected conversation model. Only a summary is saved in ${savedIn} afterwards.`;
    neural.node.hidden=cloud;preview.hidden=cloud;
    inputMode.closest('label').hidden=cloud;acceleration.closest('label').hidden=cloud;
    modelBox.hidden=cloud||!speech?.engine_available;runtimeSetup.hidden=cloud||!speech?.acceleration?.supported;
    voice.closest('label').hidden=cloud||neural.selection().provider!=='device';
    const chosen = speech?.models?.find(item => item.name === model.value);
    download.hidden = !!chosen?.downloaded || !speech?.engine_available;
    download.disabled = !chosen;
    start.disabled = true;
    if(cloud){
      download.hidden=true;
      start.disabled=!liveEndpoint.value||!paid.checked||!conversation.value||!conversationModel.value.trim();
      readiness.textContent=!liveEndpoint.value?(callMode.value==='realtime'?'Add an API connection with a key for OpenAI, xAI or Google in Settings > Models (mark it for realtime voice if its address is custom).':'Add an official OpenAI API connection with an API key in Settings > Models.'):!conversation.value?'Choose a conversation model below for post-call summaries.':'Cloud voice uses its own recognition and voice. Your selected conversation model generates the summary.';return;
    }
    if (!isCallRecordingSupported()) readiness.textContent = 'Calls need microphone access and AudioWorklet support. Use the Kairos desktop app or an up-to-date secure browser.';
    else if (!speech?.engine_available) readiness.textContent = 'Speech recognition is unavailable in this build. Install the latest Kairos runtime to enable calls.';
    else if (!chosen?.downloaded) readiness.textContent = 'Download the selected speech model below. Nothing downloads automatically.';
    else if (!conversation.value || !conversationModel.value.trim()) readiness.textContent='Choose a conversation connection and exact model version. Add connections in Settings > Models.';
    else if (!neural.ready()) readiness.textContent='Connect a local voice server and choose an installed engine and profile.';
    else if (neural.selection().provider==='device' && (!isSpeechOutputSupported() || !voices.length)) readiness.textContent = 'No device voice is available. Add a voice in your operating system Speech settings, then reopen calls.';
    else { readiness.textContent = `${chosen.label} recognition selected. ${chosen.description || 'Ready on this device.'}`; start.disabled = false; }
  }
  model.onchange = () => { try { localStorage.setItem(modelKey, model.value); } catch {} syncModel(); };
  async function downloadModel() {
    if (download.disabled || !model.value || !dialog.open) return;
    const name = model.value, token = epoch;
    download.disabled = true; model.disabled = true; error.textContent = '';
    try {
      await api(`/api/speech/models/${encodeURIComponent(name)}/download`, { method: 'POST' });
      if (disposed || token !== epoch || !dialog.open) return;
      readiness.textContent = 'Downloading speech model...';
      const poll = async () => {
        try {
          const progress = await api(`/api/speech/models/${encodeURIComponent(name)}/progress`);
          if (disposed || epoch !== token || !dialog.open) return;
          if (progress.error) throw new Error('Speech model download failed. Try again.');
          if (progress.done) { refreshSpeechStatus(); model.disabled = false; await loadSetup(); return; }
          readiness.textContent = progress.total ? `Downloading speech model: ${Math.round(progress.completed / progress.total * 100)}%` : 'Downloading speech model...';
          downloadTimer = setTimeout(poll, 700);
        } catch (problem) { if (!disposed && token === epoch) { error.textContent = problem.message; download.disabled = false; model.disabled = false; } }
      };
      await poll();
    } catch (problem) { if (!disposed && token === epoch) { error.textContent = problem.message; download.disabled = false; model.disabled = false; } }
  }
  function stopPlayback() {
    clearTimeout(wordTimer); wordTimer = null; orb.style.setProperty('--word', '0'); fillerGate.cancel(); fillerOn = false;
    // Change state first so the speaker's cancel callback cannot resume capture.
    if (state === 'speaking') state = 'paused';
    speaker.cancel();
    if (readingTyped) { readingTyped = false; if (isCloud()) live.muteMicrophone(microphoneMuted); }
  }
  async function setMicrophoneMuted(value) {
    microphoneMuted = value;
    emitState();
    if(isCloud()){live.muteMicrophone(value);microphone.setAttribute('aria-pressed',String(value));microphone.textContent=value?'Unmute microphone':'Mute microphone';return;}
    microphone.setAttribute('aria-pressed', String(value)); microphone.textContent = value ? 'Unmute microphone' : 'Mute microphone';
    if (value) { cancelHold(); partials.cancel(); recorder?.close(); recorder = null; speechActive = false; orb.style.setProperty('--level', '0'); if (state === 'listening') status.textContent = 'Microphone muted'; scheduleFlush(); }
    else if (active) {
      try { await openMicrophone(); if (state === 'listening') status.textContent = 'Listening...'; }
      catch (problem) { microphoneMuted = true; microphone.setAttribute('aria-pressed', 'true'); microphone.textContent = 'Unmute microphone'; error.textContent = problem.message; }
    }
  }
  async function openMicrophone() {
    if (recorder || !active || microphoneMuted) return;
    const token = epoch;
    const next = createCallRecorder({
      mode: inputMode.value,
      onLevel: level => { if (active && !microphoneMuted && state !== 'speaking') orb.style.setProperty('--level', String(level)); },
      onChunk: pcm => { if (active && !microphoneMuted && epoch === token) partials.push(pcm); },
      // Smart Turn: at a short pause, ask whether the sentence is finished. No answer (not set up, slow) = today's silence wait.
      onPause: (id, pcm) => { turnEndpoint.ask(pcm).then(verdict => { if (verdict && active && epoch === token && recorder === next) next.verdict(id, verdict.complete); else if (turnEndpoint.off && recorder === next) next.setSmartTurn(false); }); },
      onBargeIn: () => { if (epoch === token) bargeIn(); },
      // A pause that can be taken back: the user's voice just started over Kairos. A nod ("mm-hm") ends before it counts.
      onBargeDuck: () => { if (epoch === token && active && state === 'speaking') speaker.pause(); },
      onBargeClear: () => { if (epoch === token) speaker.resume(); },
      onSpeechStart: () => { if (active && !microphoneMuted) { if (!utterance.during) utterance = { during: state === 'speaking' || state === 'thinking' || voiceBusy, asked: false }; partials.begin(); speechActive = true; status.textContent = inputMode.value === 'hold' ? 'Recording your full sentence...' : voiceBusy ? 'Listening to your next sentence...' : 'Listening...'; } },
      onSegment: (blob, measured, pcm) => {
        speechActive = false;
        const spoke = utterance; utterance = { during: false, asked: false };   // whatever this utterance was said over, it is used up
        const session = partials.take();
        if (inputMode.value === 'hold') { holding = false; hold.setAttribute('aria-pressed', 'false'); hold.textContent = 'Hold to talk'; }
        if (!active || microphoneMuted || epoch !== token || !blob) session?.cancel();
        if (!active || microphoneMuted || epoch !== token) return;
        if (blob) {
          if (audioQueue.length >= 6) { setMicrophoneMuted(true); error.textContent = 'Speech is arriving faster than recognition can process it. The microphone is muted while the queued sentences finish.'; return; }
          if (measured.limit) error.textContent = 'The 60-second recording limit was reached. Hold again to continue.';
          utteranceEnded=performance.now()-(measured.endpoint_ms||0);
          const trace=voiceTrace.begin(utteranceEnded); voiceTrace.mark(trace,'endpoint');
          audioQueue.push({ blob, measured, ended:utteranceEnded, revision, trace, pcm, session, during: spoke.during, asked: spoke.asked }); processAudio();
        }
        scheduleFlush();
      },
      onError: problem => { cancelHold(); speechActive = false; microphoneMuted = true; microphone.setAttribute('aria-pressed','true'); microphone.textContent = 'Unmute microphone'; recorder = null; error.textContent = problem.message; if (state === 'listening') status.textContent = 'Microphone stopped'; scheduleFlush(); },
    });
    recorder = next;
    try { await next.start(); } catch (problem) { next.close(); if (recorder === next) recorder = null; throw problem; }
    if (!active || disposed || epoch !== token || microphoneMuted || recorder !== next) { next.close(); return; }
    if (inputMode.value === 'automatic' && speech?.turn_detect?.ready && !turnEndpoint.off) next.setSmartTurn(true);
    applyMicrophone();
  }
  // The user's voice held for ~250 ms over Kairos speaking (the worklet decided; see speechSegments.js for the thresholds).
  // Stop the speech now: the speaker's cancel aborts every queued and prefetched sentence, and the server marks the reply
  // as cut off. The worklet already holds the start of the user's sentence and keeps recording it as a normal utterance.
  function bargeIn() {
    if (!active || state !== 'speaking' || callMode.value !== 'local') return;
    const began = performance.now();
    bargeIns++; dialog.dataset.bargeIns = String(bargeIns);
    const heardNow = speaker.heard();
    utterance = { during: true, asked: endsInQuestion(heardNow) };
    transport.interrupt(true, heardNow); voiceBusy = false; revision++; pending?.abort(); audioQueue = []; texts = []; deferredReply = null;
    stopPlayback();
    speechActive = true; listen();
    dialog.dataset.bargeStopMs = String(Math.round(performance.now() - began));
  }
  function listen() {
    if (!active) return;
    setState('listening', microphoneMuted ? 'Microphone muted' : inputMode.value === 'hold' ? 'Ready. Hold to talk.' : 'Listening...');
  }
  function drawTiming() {
    if (recognitionTiming.engine) showEngine(recognitionTiming);
    const parts = [];
    if (recognitionTiming.endpoint_ms != null) parts.push(`Pause ${recognitionTiming.endpoint_ms} ms`);
    if(response?.end_to_audio_ms!=null)parts.push(`First audio ${response.end_to_audio_ms} ms after speech`);
    if(response?.first_output_ms!=null)parts.push(`First text ${response.first_output_ms} ms`);
    if (recognitionTiming.upload_ms != null) parts.push(`Recognition ${recognitionTiming.upload_ms} ms${recognitionTiming.partial ? ` (rolling: ${recognitionTiming.partial})` : ''}`);
    if (response?.reply_ms != null) parts.push(`Agent ${(response.reply_ms/1000).toFixed(1)} s`);
    if (response?.playback_ms != null) parts.push(`Voice ${response.playback_ms} ms`);
    const stages = voiceTrace.format(response?.trace);
    timing.textContent = parts.join(' / ') + (stages ? ` | ${stages}` : '');
    dialog.dataset.callTimings = JSON.stringify({ ...recognitionTiming, ...(response || {}), trace: response?.trace ? voiceTrace.offsets(response.trace) : undefined });
  }
  function showEngine(info) {
    engineStatus.textContent = `${model.value === 'small.en' ? 'Small' : model.value} / ${info.engine === 'cuda' ? 'GPU accelerated' : 'CPU recognition'}${info.fallback ? ` — ${info.fallback}` : ''}`;
  }
  // Called from every event that can make a flush possible (an utterance ending, a transcript arriving, speech or a
  // reply finishing, finished work). It runs at the end of the current event instead of on a 180 ms poll; flushText
  // itself does not re-arm, so each of those events is the trigger.
  function scheduleFlush() {
    if (!active || flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => { flushQueued = false; flushText(); });
  }
  // Final transcript of one finished utterance: the rolling session's text when it has one (nothing to send, or only the
  // tail), otherwise, or if anything about that goes wrong, the whole clip exactly as before.
  async function recognize(item, signal, onTiming) {
    const options = { pcm: true, model: model.value, backend: acceleration.value, signal, onTiming };
    if (item.session && item.pcm) {
      try {
        const rolled = await item.session.finalize(item.pcm, wav => transcribeBlob(wav, options));
        if (rolled) { item.rolled = rolled.mode; return rolled.text; }
      } catch (problem) { if (problem.name === 'AbortError') throw problem; }
    }
    return transcribeBlob(item.blob, options);
  }
  async function processAudio() {
    if (transcribing || !active) return;
    transcribing = true; const callToken = epoch;
    try {
      while (active && epoch === callToken && audioQueue.length) {
        const item = audioQueue.shift(), mine = item.revision;
        if (mine !== revision) continue;
        if (!voiceBusy) setState('transcribing', 'Transcribing. You can keep speaking...');
        const started = performance.now(); pending = new AbortController();
        try {
          voiceTrace.mark(item.trace, 'upload_sent');
          const text = await recognize(item, pending.signal, value => { recognitionTiming = { ...value }; });
          if (!active || epoch !== callToken || revision !== mine) continue;
          voiceTrace.mark(item.trace, 'transcript_back');
          recognitionTiming = { ...recognitionTiming, ...item.measured, upload_ms: Math.round(performance.now()-started), capture_queue_ms: Math.round(started-item.ended), partial: item.rolled || undefined };
          drawTiming();
          // A nod over Kairos's voice ("mm-hm", "yeah") is not a turn: nothing is sent, nothing interrupts.
          if (text.trim() && item.during && isBackchannel(text.trim(), item.asked)) { backchannels++; dialog.dataset.backchannels = String(backchannels); heard.textContent = `Heard (not a turn): ${text.trim()}`; continue; }
          if (text.trim()) {
            texts.push(text.trim()); turnTrace = item.trace; heard.textContent = `Heard: ${text.trim()}`;
            if (state === 'speaking') { stopPlayback(); listen(); }
          }
        } catch (problem) { if (active && epoch === callToken && mine === revision && problem.name !== 'AbortError') error.textContent = problem.message; }
      }
    } finally {
      transcribing = false;
      if (active && epoch === callToken) { if (!voiceBusy && !speechActive) listen(); scheduleFlush(); }
      else if (active && audioQueue.length) processAudio();
    }
  }
  async function flushText() {
    if (!active || disposed) return;
    if (!texts.length && !workUpdates.length && !deferredReply && !transcribing && !audioQueue.length) return;
    if (speechActive || transcribing || audioQueue.length || dispatching || voiceBusy || state==='speaking') return;
    if (!texts.length && !workUpdates.length) {
      if (deferredReply) { const text = deferredReply; deferredReply = null; say(text); }
      return;
    }
    const text = texts.join(' '), workId=text?null:workUpdates.shift(); texts = []; deferredReply = null;
    currentTrace = (text && turnTrace) || voiceTrace.begin(); turnTrace = null; voiceTrace.mark(currentTrace, 'turn_started');
    const token = epoch, mine = revision; dispatching = true;
    try {
      speaking = null;
      setState('thinking', `${room ? 'The room' : agent.name} is thinking. You can keep speaking...`);
      response = { submitted: performance.now(), trace: currentTrace };
      voiceBusy=true; speaker.reset(); fillerOn = false;
      fillerGate.arm({ text, workUpdate: !!workId, muted: assistantMuted });
      let output='', deferred=false;
      const consume = event => {
        if(!active||epoch!==token||revision!==mine)return;
        if(event.type==='error')throw new Error(event.message);
        if(event.type==='speaker') { speaking = { id: event.id, name: event.name }; dialog.dataset.speaker = event.id; setState('thinking', `${event.name} is answering...`); return; }
        if(event.type==='text') {
          output+=event.delta; heard.textContent=`${who()}: ${output}`;
          if(event.first_output_ms!=null)response.first_output_ms=event.first_output_ms;
          voiceTrace.mark(currentTrace, 'first_token'); fillerGate.sentenceReady();   // the answer has started: an acknowledgement now would only delay it
          // If the caller is already continuing, retain the reply until the
          // next utterance can be considered instead of talking over them.
          if(speechActive||transcribing||audioQueue.length||texts.length){deferred=true;stopPlayback();}
          if(!assistantMuted&&!deferred)speaker.feed(event.delta);
        }
        if(event.type==='done') { response.reply_ms=event.reply_ms; drawTiming(); }
      };
      if(workId==='ring-opening')await transport.opening(consume);else if(workId)await transport.update(workId,consume);else await transport.turn(text,consume);
      if (!active || epoch !== token || revision !== mine) return;
      voiceBusy=false;
      if(deferred){deferredReply=output;listen();}
      else if(!assistantMuted)speaker.finish();else listen();

    } catch (problem) {
      if (active && epoch === token && revision === mine) {
        if(problem.name!=='AbortError')error.textContent=problem.message; voiceBusy=false; stopPlayback();listen();
      }
    } finally { dispatching = false;if(epoch===token&&revision===mine){voiceBusy=false;fillerGate.cancel();}scheduleFlush(); }
  }
  function say(text) {
    if (!active || assistantMuted || !text?.trim()) { listen(); return; }
    currentTrace = null;
    setState('speaking', `${who()} is speaking...`);
    try { speaker.reset(); speaker.feed(text); speaker.finish(); }
    catch { stopPlayback(); error.textContent = 'Voice playback failed. Check the selected device voice.'; listen(); }
  }
  setup.addEventListener('submit', async event => {
    event.preventDefault(); if (active || starting) return;
    if (ongoingCall?.isActive()) { ongoingCall.restore(); return; }
    if (callMode.value==='local' && (!speech?.models?.some(item => item.name === model.value && item.downloaded) || !neural.ready() || (neural.selection().provider==='device'&&!voices.length))) { start.textContent = 'Start call'; await loadSetup(); return; }
    starting = true; start.disabled = true; error.textContent = '';
    const token = ++epoch;
    workUpdates=[];announcedWork=new Set();
    try {
      if (callMode.value==='local'&&!isCallRecordingSupported()) throw new Error('Microphone access is unavailable. Check your device permissions.');
      if(isCloud()&&(!navigator.mediaDevices?.getUserMedia||(callMode.value==='cloud'&&!window.RTCPeerConnection)||(callMode.value==='realtime'&&!window.AudioWorkletNode)))throw new Error('Cloud voice requires a secure browser with microphone access'+(callMode.value==='cloud'?' and WebRTC.':' and AudioWorklet.'));
      await localSpeaker.prepare(); stopPlayback();
      await transport.start(agent,conversation.value,conversationModel.value.trim(),ringOpening);
      if(disposed||epoch!==token||!dialog.open){transport.end();return;}
      voiceTrace.reset(); partials.reset(); turnTrace = currentTrace = null; bargeIns = 0; backchannels = 0; utterance = { during: false, asked: false }; delete dialog.dataset.bargeIns; delete dialog.dataset.backchannels;
      if (callMode.value === 'local' && fillerSelection().provider === 'neural') api('/api/agent-calls/filler/warm', { method: 'POST', toast: false, body: JSON.stringify({ model: fillerSelection().model, voice: fillerSelection().voice }) }).catch(() => {});
      setState('preparing','Preparing the conversation model...');
      await api(`/api/agent-calls/${transport.record.id}/prepare`,{method:'POST',toast:false});
      if(disposed||epoch!==token||!dialog.open){transport.end();return;}
      if(isCloud()){
        setState('preparing','Connecting cloud voice...');active=true;microphoneMuted=false;assistantMuted=false;
        await live.start(transport.record.id,liveEndpoint.value,liveVoiceChoice.value,paid.checked);
        if(!active||epoch!==token){live.stop();transport.end();return;}
      } else {
      setState('preparing', 'Preparing the selected speech model...');
      const ready = await api('/api/speech/prepare', { method: 'POST', body: JSON.stringify({ model: model.value, backend: acceleration.value }) });
      if (disposed || epoch !== token || !dialog.open) return;
      recognitionTiming = { prepare_ms: ready.prepare_ms }; drawTiming();
      showEngine(ready);
      if (ready.engine !== 'cuda') partials.disable('cpu'); dialog.dataset.partials = partials.state.disabled || 'on';
      active = true; microphoneMuted = false; assistantMuted = false;
      dialog.dataset.inputMode = inputMode.value;
      microphone.setAttribute('aria-pressed', 'false'); microphone.textContent = 'Mute microphone'; assistant.setAttribute('aria-pressed', 'false'); assistant.textContent = 'Mute assistant';
      await openMicrophone();
      if (!active || epoch !== token) return;
      }
      setup.hidden = true; controls.hidden = false; hold.hidden = holdHint.hidden = isCloud()||inputMode.value !== 'hold'; button.classList.add('is-call-active'); startedAt = lastActivity = Date.now(); ongoingCall = { isActive: () => active, restore }; listen();
      if (ringOpening && callMode.value === 'local') { ringOpening = null; workUpdates.push('ring-opening'); scheduleFlush(); }
      timer = setInterval(() => { const seconds = Math.floor((Date.now() - startedAt) / 1000); clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; drawRealtimeCost(seconds); if (Date.now() - lastActivity > livePrefs.idle_minutes * 60000 && !voiceBusy && !speechActive) hangup(); }, 1000);
    } catch (problem) { if (epoch === token) { active = false; live.stop();transport.end();recorder?.close(); recorder = null; setState('setup','Call could not start');error.textContent = problem.message; } }
    finally { starting = false; start.disabled = false; }
  });
  function hangup() {
    active = false; epoch++; revision++; audioQueue = []; texts = []; workUpdates=[];deferredReply = null; flushQueued = false; clearInterval(timer); timer = null; clearTimeout(downloadTimer); downloadTimer = null;
    cancelHold(); partials.cancel(); recorder?.close(); recorder = null; speechActive = false; pending?.abort(); pending = null; stopPlayback();
    live.stop();transport.end();voiceBusy=false;paid.checked=false;
    setup.hidden = false; controls.hidden = true; clock.textContent = '00:00'; model.disabled = false;
    response = null; recognitionTiming = {}; timing.textContent = ''; heard.textContent = '';
    engineStatus.textContent = ''; hold.hidden = holdHint.hidden = true;
    setState('setup', 'Ready when you are'); dialog.close(); button.classList.remove('is-call-active');
    minimized = false; ongoingCall = null; speaking = null; delete dialog.dataset.speaker; callBar?.destroy(); callBar = null; emitState();
    if (detached) cleanup();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); hangup(); });
  async function loadPendingSummaries() {
    const parent=controller.sessionId();if(!parent)return;
    const records=await api(`/api/agent-calls/pending/${parent}`);
    summaryStatus.replaceChildren(...records.map(record=>el('div',{},[el('span',{text:record.summary_state==='failed'?'Call summary needs retry.':'Call summary is being saved.'}),el('button',{type:'button',class:'btn quiet',text:'Retry summary',onclick:async()=>{await api(`/api/agent-calls/${record.id}/summary`,{method:'POST'});watchSummary(record.id);}})])));
    for(const record of records)if(record.summary_state==='pending')watchSummary(record.id);
  }
  function watchSummary(id,attempt=0) {
    if(disposed||attempt>90)return;
    setTimeout(async()=>{if(disposed)return;try{const record=await api(`/api/agent-calls/${id}`);if(record.summary_state==='saved'){await controller.summarySaved(record);summaryStatus.textContent='Call summary saved in chat.';}else if(record.summary_state==='pending')watchSummary(id,attempt+1);else await loadPendingSummaries();}catch{}},2000);
  }
  const settingsChanged = event => { livePrefs = event.detail; };
  const botSaved = event => { if (event.detail?.agentId === agent.id && event.detail.agent) Object.assign(agent, event.detail.agent); };
  const typedReply = async event => {
    if (room || !active || assistantMuted || !livePrefs.read_typed || event.detail.agentId !== agent.id || voiceBusy || state === 'speaking') return;
    const mine = epoch;
    try {
      const prepared = await api('/api/bot-voice/speak/prepare', { method: 'POST', toast: false, body: JSON.stringify({ text: event.detail.text.slice(0, 100000), voice_id: null }) });
      if (!active || epoch !== mine || assistantMuted || voiceBusy || state === 'speaking' || !livePrefs.read_typed || prepared.withheld) return;
      const text = prepared.blocks.slice(0, 3).join(' ') + (prepared.blocks.length > 3 ? ' The full answer is in the chat.' : '');
      if (!text) return;
      readingTyped = true; if (isCloud()) live.muteMicrophone(true); say(text);
    } catch { if (active && epoch === mine) error.textContent = 'Typed reply speech could not load. The reply is in chat.'; }
  };
  document.addEventListener('kairos:bots-live-settings', settingsChanged);
  document.addEventListener('kairos:bots-typed-reply', typedReply);
  document.addEventListener('kairos:bots-saved', botSaved);
  function cleanup() { if (disposed) return; disposed = true; transport.dispose(); localSpeaker.dispose(); deviceSpeaker.cancel(); callBar?.destroy(); document.removeEventListener('kairos:bots-live-settings', settingsChanged); document.removeEventListener('kairos:bots-typed-reply', typedReply); document.removeEventListener('kairos:bots-saved', botSaved); document.removeEventListener('kairos:ring-answered', adoptRing); window.removeEventListener('blur', loseFocus); document.removeEventListener('visibilitychange', visibilityChanged); dialog.remove(); button.remove(); }
  // Moving between Bots conversations keeps a call going in its bar; leaving Bots mode ends it, so a live
  // microphone never runs behind a page that has no call bar.
  let modeWatch = null;
  const inBots = () => document.documentElement.dataset.appMode === 'bots';
  const endDetached = () => { modeWatch?.disconnect(); modeWatch = null; if (active) hangup(); cleanup(); };
  return { button, minimize, restore, update() {}, dispose() {
    if (active && inBots()) {
      detached = true; minimize(); button.remove();
      modeWatch = new MutationObserver(() => { if (!inBots()) endDetached(); });
      modeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-app-mode'] });
    } else { hangup(); cleanup(); }
  } };
}

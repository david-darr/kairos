// Native Kairos calls: call-owned dialogue, streamed speech and delegated agent work.
import { api, el, toast } from './api.js';
import { liveVoice } from './callLive.js';
import { callTransport } from './callTransport.js';
import { voiceSettings, neuralSpeaker } from './callVoice.js';
import { transcribeBlob, refreshSpeechStatus } from './voiceInput.js';
import { createCallRecorder, isCallRecordingSupported } from './callRecorder.js';
import { createSpeaker, isSpeechOutputSupported, whenVoicesReady, resolveVoice } from './voiceOutput.js';
import { createMascot } from './mascot.js';

// In a call the bot's Kip replaces the orb (Kairos Mascot build spec,
// 2026-10-22). It reads the orb's --level (microphone) and --word (speech)
// by inheritance: eyes widen while listening, squash and the point pulses
// while speaking, and a halo swells with the level. The orb core stays as
// the fallback when Show Kip is off.
const CALL_MASCOT = { setup: 'idle', preparing: 'thinking', listening: 'listening', transcribing: 'thinking', thinking: 'thinking', speaking: 'speaking', paused: 'sleeping' };

export function agentCall(agent, controller) {
  let recorder = null, active = false, disposed = false, starting = false, epoch = 0;
  let microphoneMuted = false, assistantMuted = false, state = 'setup';
  let pending = null, startedAt = 0, timer = null, downloadTimer = null;
  let voices = [], speech = null, wordTimer = null, speechFlushTimer = null;
  let speechActive = false, audioQueue = [], texts = [], transcribing = false, dispatching = false, flushTimer = null, revision = 0;
  let response = null, deferredReply = null, recognitionTiming = {};
  let holding = false, holdPointer = null, voiceBusy = false, utteranceEnded = 0;
  let workUpdates=[], announcedWork=new Set();
  let endpoints = [];
  const conversationKey = `kairos:call-conversation:${agent.id}`;
  const conversation = el('select', {'aria-label':'Conversation model connection'});
  const conversationModel = el('input', {type:'text','aria-label':'Conversation model version',placeholder:'Exact model ID'});
  const modelSuggestions=el('datalist',{id:`call-models-${agent.id}`});conversationModel.setAttribute('list',modelSuggestions.id);
  const workList = el('div', {class:'agent-call-work','aria-label':'Call work'});
  const summaryStatus = el('div', {class:'agent-call-summary',role:'status'});
  const transport = callTransport(controller, record => {
    workList.replaceChildren(...record.jobs.map(job => el('div',{},[el('span',{text:`${job.title}: ${job.status}`}), ...(['ready','running'].includes(job.status)?[el('button',{type:'button',class:'btn quiet',text:'Stop work',onclick:()=>transport.stopWork(job.task_id)})]:[])])));
    if(record.live_error)error.textContent=record.live_error;
    if(active&&callMode.value==='local')for(const job of record.jobs){if(!['ready','running'].includes(job.status)&&!announcedWork.has(job.task_id)){announcedWork.add(job.task_id);workUpdates.push(job.task_id);scheduleFlush();}}
    if(record.ended&&active)hangup();
    if(record.ended) { summaryStatus.textContent = record.summary_state==='saved'?'Call summary saved in chat.':record.summary_state==='failed'?record.summary_error:'Saving call summary?'; }
  });
  const callMode=el('select',{'aria-label':'Call mode'},[el('option',{value:'local',text:'Local recognition + conversation model'}),el('option',{value:'cloud',text:'GPT-Live (paid cloud voice)'})]);
  const liveEndpoint=el('select',{'aria-label':'Cloud voice API connection'});
  const liveVoiceChoice=el('select',{'aria-label':'Cloud voice'},['marin','cedar','coral','sage','ash'].map(name=>el('option',{value:name,text:name})));
  const paid=el('input',{type:'checkbox','aria-label':'Use paid cloud voice for this call'});
  const cloudSetup=el('div',{hidden:true,class:'agent-call-cloud-setup'},[el('label',{},[el('span',{text:'OpenAI API connection'}),liveEndpoint]),el('label',{},[el('span',{text:'Live voice'}),liveVoiceChoice]),el('label',{class:'agent-call-consent'},[paid,el('span',{text:'Use paid cloud voice for this call. Audio is sent to OpenAI; voice and backend model usage are billed to your API account.'})])]);
  const live=liveVoice(next=>{if(!active)return;if(next==='ended'){hangup();return;}setState(next,next==='speaking'?`${agent.name} is speaking. You can interrupt naturally.`:'Listening...');},(role,delta)=>{heard.textContent=(heard.dataset.speaker===role?heard.textContent:`${role}: `)+delta;heard.dataset.speaker=role;},level=>orb.style.setProperty('--word',String(level)),message=>{error.textContent=message;});
  const modelKey = `kairos:call-model:v2:${agent.id}`;
  const modeKey = `kairos:call-input:${agent.id}`;
  const heard = el('p', { class: 'agent-call-heard', 'aria-live': 'polite' });
  const timing = el('p', { class: 'agent-call-timing', role: 'status' });
  const voiceKey = `kairos:agent-voice:${agent.id}`;
  const dialog = el('dialog', { class: 'agent-call', 'aria-label': `Voice call with ${agent.name}` });
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
  const setup = el('form', { class: 'agent-call-setup' }, [readiness,
    el('label', {}, [el('span', { text: 'Voice' }), voice]), modelBox,
    el('label', {}, [el('span', { text: 'Input' }), inputMode]),
    el('label', {}, [el('span', { text: 'Recognition processor' }), acceleration]), runtimeSetup, download, start]);
  const neural = voiceSettings(agent, voice, {changed:()=>{if(speech)syncModel();}});
  setup.prepend(el('label',{},[el('span',{text:'Conversation model'}),conversation]),el('label',{},[el('span',{text:'Model version'}),conversationModel]),el('p',{text:'Choose a fast API or local model for conversation. Your agent keeps its existing work model.'}),neural.node);
  setup.prepend(el('label',{},[el('span',{text:'Call mode'}),callMode]),cloudSetup);
  callMode.onchange=()=>{cloudSetup.hidden=callMode.value!=='cloud';syncModel();};paid.onchange=syncModel;liveEndpoint.onchange=syncModel;
  conversation.onchange = () => { conversationModel.value=endpoints.find(e=>e.id===conversation.value)?.model||''; saveConversation();loadConversationModels(); };
  setup.append(modelSuggestions);
  async function loadConversationModels(){const ident=conversation.value;modelSuggestions.replaceChildren();if(!ident)return;try{const models=await api(`/api/models/${encodeURIComponent(ident)}/catalog`);if(conversation.value===ident)modelSuggestions.replaceChildren(...models.map(m=>el('option',{value:m.id,label:m.label||m.id})));}catch{}}
  conversationModel.onchange = saveConversation;
  function saveConversation(){try{localStorage.setItem(conversationKey,JSON.stringify({endpoint:conversation.value,model:conversationModel.value}));}catch{}syncModel();}
  const action = (title, click, cls = '') => el('button', { type: 'button', class: `btn quiet agent-call-action ${cls}`, text: title, onclick: click });
  const assistant = action('Mute assistant', () => {
    assistantMuted = !assistantMuted; assistant.setAttribute('aria-pressed', String(assistantMuted));
    assistant.textContent = assistantMuted ? 'Unmute assistant' : 'Mute assistant';
    if(callMode.value==='cloud')live.muteAssistant(assistantMuted);
    if (assistantMuted && state === 'speaking') { stopPlayback(); listen(); }
  });
  const microphone = action('Mute microphone', () => setMicrophoneMuted(!microphoneMuted));
  assistant.setAttribute('aria-pressed', 'false'); microphone.setAttribute('aria-pressed', 'false');
  const controls = el('div', { class: 'agent-call-controls', hidden: true }, [assistant, microphone,
    action('End call', () => hangup(), 'is-end'), action('Interrupt', interrupt)]);
  function interrupt() {
      if(callMode.value==='cloud'){toast('Speak to interrupt the live conversation. Delegated work keeps running.');return;}
      transport.interrupt(); voiceBusy=false;
      revision++; pending?.abort(); audioQueue = []; texts = []; deferredReply = null; speechActive = false;
      cancelHold(); recorder?.setEnabled(false); stopPlayback(); listen();
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
  const chat = action('Chat', () => { if (!active) { hangup(); return; } const speaking = state === 'speaking'; setMicrophoneMuted(true); stopPlayback(); if (speaking) listen(); dialog.close(); });
  const close = action('Close', () => hangup());
  dialog.append(el('header', { class: 'agent-call-header' }, [clock,
    el('div', { class: 'agent-call-tabs' }, [chat, el('span', { text: 'Voice', 'aria-current': 'page' })]), close]),
    el('div', { class: 'agent-call-scene' }, [orb, el('h1', { text: agent.name }), status]), engineStatus, heard, timing, setup, error, controls, holdHint, workList, summaryStatus,
    el('p', { class: 'agent-call-privacy', text: 'Recognition stays on this device. Dialogue goes to your selected conversation model. Only a summary is saved in chat after the call.' }));
  document.body.append(dialog);
  const button = el('button', { type: 'button', class: 'agent-call-open btn quiet', 'aria-label': `Call ${agent.name}`, title: `Call ${agent.name}`, text: 'Call', onclick: async () => {
    if (disposed) return;
    dialog.showModal();
    if (active) return;
    error.textContent = ''; await loadSetup();
  } });
  const speakerOptions = {
    onLevel:level=>{if(active&&state==='speaking')orb.style.setProperty('--word',String(level));},
    getVoice: () => voices.find(item => item.name === voice.value) || resolveVoice(voices),
    onStart: () => { if (active) { setState('speaking', `${agent.name} is speaking. Interrupt to speak.`); if (response && response.first_audio_ms == null) { response.first_audio_ms=Math.round(performance.now()-response.submitted); response.end_to_audio_ms=utteranceEnded?Math.round(performance.now()-utteranceEnded):null; drawTiming();if(transport.record&&response.end_to_audio_ms!=null)api(`/api/agent-calls/${transport.record.id}/timing`,{method:'POST',toast:false,body:JSON.stringify({end_to_audio_ms:response.end_to_audio_ms,first_audio_ms:response.first_audio_ms})}).catch(()=>{}); } } },
    onEnd: () => { if (active && state === 'speaking') { if(voiceBusy)setState('thinking',`${agent.name} is finishing the reply...`);else listen(); scheduleFlush(); } },
    onBoundary: () => {
      // OS speech exposes word timing, not its PCM amplitude. This pulse
      // follows real word events; microphone energy is measured separately.
      if (!active || state !== 'speaking') return;
      orb.style.setProperty('--word', '1'); clearTimeout(wordTimer);
      wordTimer = setTimeout(() => orb.style.setProperty('--word', '0'), 180);
    },
    onError: () => { if (active) error.textContent = 'Voice playback failed. Check the selected device voice or mute the assistant to continue.'; },
  };
  const deviceSpeaker=createSpeaker(speakerOptions), localSpeaker=neuralSpeaker(speakerOptions,neural.selection);
  const selectedSpeaker=()=>neural.selection().provider==='neural'?localSpeaker:deviceSpeaker;
  const speaker={reset:()=>{clearTimeout(speechFlushTimer);selectedSpeaker().reset();},feed:text=>{selectedSpeaker().feed(text);clearTimeout(speechFlushTimer);speechFlushTimer=setTimeout(()=>selectedSpeaker().flushSentence(),100);},finish:()=>{clearTimeout(speechFlushTimer);selectedSpeaker().finish();},cancel:()=>{clearTimeout(speechFlushTimer);deviceSpeaker.cancel();localSpeaker.cancel();}};
  const preview=el('button',{type:'button',class:'btn quiet',text:'Preview voice',onclick:async()=>{try{await localSpeaker.prepare();speaker.reset();speaker.feed(`Hi, I'm ${agent.name}. How can I help today?`);speaker.finish();}catch(problem){error.textContent=problem.message;}}});
  setup.insertBefore(preview,modelBox);
  voice.onchange = () => { try { localStorage.setItem(voiceKey, voice.value); } catch {} };
  function setState(next, text) {
    state = next; dialog.dataset.state = next; status.textContent = text;
    callMascot.setAttribute('state', CALL_MASCOT[next] || 'idle');
    if (next !== 'listening') orb.style.setProperty('--level', '0');
    if (next !== 'speaking') orb.style.setProperty('--word', '0');
    recorder?.setEnabled(active && !microphoneMuted && !['speaking', 'paused', 'preparing', 'setup'].includes(next));
  }
  async function loadSetup() {
    const token = epoch; start.disabled = true;
    try {
      const [nextSpeech, available, choices, _, liveChoices] = await Promise.all([api('/api/speech/status'), whenVoicesReady(), api('/api/agent-calls/choices'), neural.load(), api('/api/agent-calls/live-choices')]);
      if (disposed || epoch !== token || active || !dialog.open) return;
      liveEndpoint.replaceChildren(...liveChoices.map(e=>el('option',{value:e.id,text:e.name})));
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
    const cloud=callMode.value==='cloud';
    const privacy=dialog.querySelector('.agent-call-privacy');
    if(privacy)privacy.textContent=cloud?'Cloud voice sends audio to OpenAI and incurs API charges. Dialogue stays out of chat; a summary is saved afterwards.':'Recognition stays on this device. Dialogue goes to your selected conversation model. Only a summary is saved in chat afterwards.';
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
      readiness.textContent=!liveEndpoint.value?'Add an official OpenAI API connection with an API key in Settings > Models.':!conversation.value?'Choose a conversation model below for post-call summaries.':'Cloud voice uses its own recognition and voice. Your selected conversation model generates the summary.';return;
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
    clearTimeout(wordTimer); wordTimer = null; orb.style.setProperty('--word', '0');
    // Change state first so the speaker's cancel callback cannot resume capture.
    if (state === 'speaking') state = 'paused';
    speaker.cancel();
  }
  async function setMicrophoneMuted(value) {
    microphoneMuted = value;
    if(callMode.value==='cloud'){live.muteMicrophone(value);microphone.setAttribute('aria-pressed',String(value));microphone.textContent=value?'Unmute microphone':'Mute microphone';return;}
    microphone.setAttribute('aria-pressed', String(value)); microphone.textContent = value ? 'Unmute microphone' : 'Mute microphone';
    if (value) { cancelHold(); recorder?.close(); recorder = null; speechActive = false; orb.style.setProperty('--level', '0'); if (state === 'listening') status.textContent = 'Microphone muted'; }
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
      onLevel: level => { if (active && !microphoneMuted) orb.style.setProperty('--level', String(level)); },
      onSpeechStart: () => { if (active && !microphoneMuted) { speechActive = true; status.textContent = inputMode.value === 'hold' ? 'Recording your full sentence...' : voiceBusy ? 'Listening to your next sentence...' : 'Listening...'; } },
      onSegment: (blob, measured) => {
        speechActive = false;
        if (inputMode.value === 'hold') { holding = false; hold.setAttribute('aria-pressed', 'false'); hold.textContent = 'Hold to talk'; }
        if (!active || microphoneMuted || epoch !== token) return;
        if (blob) {
          if (audioQueue.length >= 6) { setMicrophoneMuted(true); error.textContent = 'Speech is arriving faster than recognition can process it. The microphone is muted while the queued sentences finish.'; return; }
          if (measured.limit) error.textContent = 'The 60-second recording limit was reached. Hold again to continue.';
          utteranceEnded=performance.now()-(measured.endpoint_ms||0); audioQueue.push({ blob, measured, ended:utteranceEnded, revision }); processAudio();
        }
        scheduleFlush();
      },
      onError: problem => { cancelHold(); speechActive = false; microphoneMuted = true; microphone.setAttribute('aria-pressed','true'); microphone.textContent = 'Unmute microphone'; recorder = null; error.textContent = problem.message; if (state === 'listening') status.textContent = 'Microphone stopped'; scheduleFlush(); },
    });
    recorder = next;
    try { await next.start(); } catch (problem) { next.close(); if (recorder === next) recorder = null; throw problem; }
    if (!active || disposed || epoch !== token || microphoneMuted || recorder !== next) { next.close(); return; }
    next.setEnabled(!['speaking','paused'].includes(state));
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
    if (recognitionTiming.upload_ms != null) parts.push(`Recognition ${recognitionTiming.upload_ms} ms`);
    if (response?.reply_ms != null) parts.push(`Agent ${(response.reply_ms/1000).toFixed(1)} s`);
    if (response?.playback_ms != null) parts.push(`Voice ${response.playback_ms} ms`);
    timing.textContent = parts.join(' / ');
    dialog.dataset.callTimings = JSON.stringify({ ...recognitionTiming, ...(response || {}) });
  }
  function showEngine(info) {
    engineStatus.textContent = `${model.value === 'small.en' ? 'Small' : model.value} / ${info.engine === 'cuda' ? 'GPU accelerated' : 'CPU recognition'}${info.fallback ? ` — ${info.fallback}` : ''}`;
  }
  function scheduleFlush() {
    clearTimeout(flushTimer);
    if (active) flushTimer = setTimeout(flushText, 180);
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
          const text = await transcribeBlob(item.blob, { pcm: true, model: model.value, backend: acceleration.value, signal: pending.signal, onTiming: value => { recognitionTiming = { ...value }; } });
          if (!active || epoch !== callToken || revision !== mine) continue;
          recognitionTiming = { ...recognitionTiming, ...item.measured, upload_ms: Math.round(performance.now()-started), capture_queue_ms: Math.round(started-item.ended) };
          drawTiming();
          if (text.trim()) {
            texts.push(text.trim()); heard.textContent = `Heard: ${text.trim()}`;
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
    if (speechActive || transcribing || audioQueue.length || dispatching || voiceBusy || state==='speaking') { scheduleFlush(); return; }
    if (!texts.length && !workUpdates.length) {
      if (deferredReply) { const text = deferredReply; deferredReply = null; say(text); }
      return;
    }
    const text = texts.join(' '), workId=text?null:workUpdates.shift(); texts = []; deferredReply = null;
    const token = epoch, mine = revision; dispatching = true;
    try {
      setState('thinking', `${agent.name} is thinking. You can keep speaking...`);
      response = { submitted: performance.now() };
      voiceBusy=true; speaker.reset();
      let output='', deferred=false;
      const consume = event => {
        if(!active||epoch!==token||revision!==mine)return;
        if(event.type==='error')throw new Error(event.message);
        if(event.type==='text') {
          output+=event.delta; heard.textContent=`${agent.name}: ${output}`;
          if(event.first_output_ms!=null)response.first_output_ms=event.first_output_ms;
          // If the caller is already continuing, retain the reply until the
          // next utterance can be considered instead of talking over them.
          if(speechActive||transcribing||audioQueue.length||texts.length){deferred=true;stopPlayback();}
          if(!assistantMuted&&!deferred)speaker.feed(event.delta);
        }
        if(event.type==='done') { response.reply_ms=event.reply_ms; drawTiming(); }
      };
      if(workId)await transport.update(workId,consume);else await transport.turn(text,consume);
      if (!active || epoch !== token || revision !== mine) return;
      voiceBusy=false;
      if(deferred){deferredReply=output;listen();}
      else if(!assistantMuted)speaker.finish();else listen();

    } catch (problem) {
      if (active && epoch === token && revision === mine) {
        if(problem.name!=='AbortError')error.textContent=problem.message; voiceBusy=false; stopPlayback();listen();
      }
    } finally { dispatching = false;if(epoch===token&&revision===mine)voiceBusy=false;scheduleFlush(); }
  }
  function say(text) {
    if (!active || assistantMuted || !text?.trim()) { listen(); return; }
    setState('speaking', `${agent.name} is speaking...`);
    try { speaker.reset(); speaker.feed(text); speaker.finish(); }
    catch { stopPlayback(); error.textContent = 'Voice playback failed. Check the selected device voice.'; listen(); }
  }
  setup.addEventListener('submit', async event => {
    event.preventDefault(); if (active || starting) return;
    if (callMode.value==='local' && (!speech?.models?.some(item => item.name === model.value && item.downloaded) || !neural.ready() || (neural.selection().provider==='device'&&!voices.length))) { start.textContent = 'Start call'; await loadSetup(); return; }
    starting = true; start.disabled = true; error.textContent = '';
    const token = ++epoch;
    workUpdates=[];announcedWork=new Set();
    try {
      if (callMode.value==='local'&&!isCallRecordingSupported()) throw new Error('Microphone access is unavailable. Check your device permissions.');
      if(callMode.value==='cloud'&&(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection))throw new Error('Cloud voice requires a secure browser with WebRTC and microphone access.');
      await localSpeaker.prepare(); stopPlayback();
      await transport.start(agent,conversation.value,conversationModel.value.trim());
      if(disposed||epoch!==token||!dialog.open){transport.end();return;}
      setState('preparing','Preparing the conversation model...');
      await api(`/api/agent-calls/${transport.record.id}/prepare`,{method:'POST',toast:false});
      if(disposed||epoch!==token||!dialog.open){transport.end();return;}
      if(callMode.value==='cloud'){
        setState('preparing','Connecting cloud voice...');active=true;microphoneMuted=false;assistantMuted=false;
        await live.start(transport.record.id,liveEndpoint.value,liveVoiceChoice.value,paid.checked);
        if(!active||epoch!==token){live.stop();transport.end();return;}
      } else {
      setState('preparing', 'Preparing the selected speech model...');
      const ready = await api('/api/speech/prepare', { method: 'POST', body: JSON.stringify({ model: model.value, backend: acceleration.value }) });
      if (disposed || epoch !== token || !dialog.open) return;
      recognitionTiming = { prepare_ms: ready.prepare_ms }; drawTiming();
      showEngine(ready);
      active = true; microphoneMuted = false; assistantMuted = false;
      dialog.dataset.inputMode = inputMode.value;
      microphone.setAttribute('aria-pressed', 'false'); microphone.textContent = 'Mute microphone'; assistant.setAttribute('aria-pressed', 'false'); assistant.textContent = 'Mute assistant';
      await openMicrophone();
      if (!active || epoch !== token) return;
      }
      setup.hidden = true; controls.hidden = false; hold.hidden = holdHint.hidden = callMode.value==='cloud'||inputMode.value !== 'hold'; button.classList.add('is-call-active'); startedAt = Date.now(); listen();
      timer = setInterval(() => { const seconds = Math.floor((Date.now() - startedAt) / 1000); clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }, 1000);
    } catch (problem) { if (epoch === token) { active = false; live.stop();transport.end();recorder?.close(); recorder = null; setState('setup','Call could not start');error.textContent = problem.message; } }
    finally { starting = false; start.disabled = false; }
  });
  function hangup() {
    active = false; epoch++; revision++; audioQueue = []; texts = []; workUpdates=[];deferredReply = null; clearTimeout(flushTimer); flushTimer = null; clearInterval(timer); timer = null; clearTimeout(downloadTimer); downloadTimer = null;
    cancelHold(); recorder?.close(); recorder = null; speechActive = false; pending?.abort(); pending = null; stopPlayback();
    live.stop();transport.end();voiceBusy=false;paid.checked=false;
    setup.hidden = false; controls.hidden = true; clock.textContent = '00:00'; model.disabled = false;
    response = null; recognitionTiming = {}; timing.textContent = ''; heard.textContent = '';
    engineStatus.textContent = ''; hold.hidden = holdHint.hidden = true;
    setState('setup', 'Ready when you are'); dialog.close(); button.classList.remove('is-call-active');
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
  return { button, update() {}, dispose() { disposed = true; hangup();transport.dispose();localSpeaker.dispose(); window.removeEventListener('blur', loseFocus); document.removeEventListener('visibilitychange', visibilityChanged); dialog.remove(); button.remove(); } };
}

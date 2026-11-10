import { api, el, toast } from '../api.js';
import { refreshSpeechStatus, listInputDevices, getInputDevice, setInputDevice, requestMicrophoneAccess, isRecordingSupported } from '../voiceInput.js';
import { isSpeechOutputSupported, whenVoicesReady, resolveVoice, getPreferredVoice, setPreferredVoice } from '../voiceOutput.js';
import { group, row, note, pill } from '../settingsKit.js';
import { voiceSettings } from '../callVoice.js';

// Settings > Workspace > Speech (David's ask 2026-09-15). Since 2026-11-10 (Locked shape) the main path is one plain
// Voice choice (voiceEnginesSetup.js) and the microphone; everything technical (Voicebox, the voice picker, the
// recognition model, optional downloads, the GPU runtime folder, realtime keys) sits under More options.
//
// Dictation ships with the engine but no model, so without this panel there
// is no way to obtain one and the mic button can only ever refuse. Models are
// several hundred megabytes and land in the shared data directory, so
// downloading is admin-gated the same way adding a model endpoint is; the
// status itself is readable by anyone, since a non-admin still needs to know
// why dictation is unavailable.

const POLL_MS = 700;

export async function renderSpeechPanel(content, status) {
  const isAdmin = !!(status && status.is_admin);
  const root = el('section', { class: 'speech-panel' });
  content.append(root);

  const timers = new Set();
  // Registered so leaving the panel mid-download stops the polling rather
  // than leaving intervals running against a detached DOM.
  const stopPolling = () => { timers.forEach(clearInterval); timers.clear(); };
  const observer = new MutationObserver(() => { if (!root.isConnected) { stopPolling(); observer.disconnect(); } });
  observer.observe(content, { childList: true });

  // -- devices ---------------------------------------------------------------
  async function drawDevices() {
    if (!isRecordingSupported()) return null;
    const { devices, labelled } = await listInputDevices();

    const select = el('select', { id: 'speech-input-device', 'aria-label': 'Microphone' });
    select.append(el('option', { value: '', text: 'System default' }));
    for (const device of devices) {
      // An unlabelled device still has to be selectable, so it gets a stable
      // stand-in rather than an empty row.
      const label = device.label || `Microphone ${device.deviceId.slice(0, 6)}`;
      select.append(el('option', { value: device.deviceId, text: label }));
    }
    select.value = getInputDevice();
    select.addEventListener('change', () => {
      setInputDevice(select.value);
      toast(select.value ? 'Microphone updated' : 'Using the system default microphone', 'success');
    });

    const rows = [row({ title: 'Input device', description: 'Which device dictation and Open Mic record from.', control: select })];
    if (!labelled && devices.length) {
      // Browsers withhold device names until a page has been granted access,
      // so the list is real but unreadable. Saying why beats showing blanks.
      rows.push(row({ title: 'Device names are hidden', description: 'They appear once microphone access is allowed.',
        control: el('button', { type: 'button', class: 'btn', text: 'Allow and show names', onclick: async () => {
          try { await requestMicrophoneAccess(); draw(); }
          catch { toast('Microphone access was blocked.', 'error'); }
        } }) }));
    }
    return group({ title: 'Microphone', cls: 'speech-devices' }, rows);
  }

  // -- voice -----------------------------------------------------------------
  async function drawVoice() {
    if (!isSpeechOutputSupported()) return null;
    const voices = await whenVoicesReady();
    if (!root.isConnected) return null;
    const automatic = resolveVoice(voices);
    const select = el('select', { id: 'speech-voice', 'aria-label': 'Voice' });
    select.append(el('option', {
      value: '',
      // Naming what "automatic" actually resolves to, so the default is not a
      // black box someone has to test to understand.
      text: automatic ? `Automatic (${automatic.name})` : 'Automatic',
    }));
    for (const voice of voices) {
      select.append(el('option', { value: voice.name, text: `${voice.name} · ${voice.lang}` }));
    }
    select.value = getPreferredVoice();
    // A saved voice whose language pack was removed leaves the select with no
    // matching option, which silently displays the first one. Reset instead.
    if (select.value !== getPreferredVoice()) setPreferredVoice('');

    const preview = el('button', { type: 'button', class: 'btn quiet', text: 'Preview' });
    preview.addEventListener('click', () => {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance('All systems online. What are we working on today?');
      const chosen = voices.find(v => v.name === select.value) || automatic;
      if (chosen) { utterance.voice = chosen; utterance.lang = chosen.lang; }
      utterance.rate = 1.02;
      window.speechSynthesis.speak(utterance);
    });

    select.addEventListener('change', () => {
      setPreferredVoice(select.value);
      toast(select.value ? 'Voice updated' : 'Using the best available voice', 'success');
    });

    const rows = [row({ title: 'Device voice', description: 'The voice this device speaks with when no other voice is ready.', control: [preview, select] })];
    if (!voices.some(v => /^en[-_]GB/i.test(v.lang))) {
      // David asked for a British voice. None is installed, and quietly
      // offering a list of American ones would look like the request was
      // ignored. This says what is missing and exactly how to fix it.
      rows.push(row({ title: 'No British English voice installed', description:
        'Only the American voices are listed. Add one in Windows Settings under Time & language, Speech, Manage voices, Add voices, '
        + 'English (United Kingdom). It appears here after a restart and is then chosen automatically.' }));
    }
    // Open Mic speaks through the same sentence speaker a call uses. By default it follows the Voice above; a voice
    // picked here is used for Open Mic instead. Saved as kairos:neural-voice:openmic (openMic.js OPEN_MIC_VOICE_KEY).
    const neural = voiceSettings({ id: 'openmic' }, select, {}, { follow: true });
    neural.sync();
    let neuralLoaded = false;
    const loadNeural = () => { if (neuralLoaded) return; neuralLoaded = true; neural.load(); };
    neural.node.addEventListener('change', () => { if (neural.selection().provider === 'neural') loadNeural(); });
    if (neural.selection().provider === 'neural') loadNeural();
    rows.push(row({ title: 'Open Mic voice', description: 'Same as the Voice follows your choice above. Or pick a voice from its engine, or the device voice, for Open Mic only.', control: [neural.node] }));
    // Stated here because this is exactly where someone looks for it, and
    // silence would read as an oversight rather than a real constraint.
    rows.push(row({ title: 'Output device', description:
      'Spoken replies always play through your system default output. The browser speech engine provides no way to choose a device, so change it in your operating system sound settings.' }));
    // speech-voice is its own hook, so a test can target this group rather
    // than whichever speech-devices group matched first.
    return group({ title: 'Voice picker', cls: 'speech-devices speech-voice' }, rows);
  }

  async function draw() {
    let state;
    try {
      state = await api('/api/speech/status');
    } catch {
      root.replaceChildren(el('p', { class: 'meta', text: 'Speech status could not be loaded.' }));
      return;
    }
    if (!root.isConnected) return;

    // The main path: the Voice and the microphone. `parts` collects More options.
    const main = [], parts = [];
    const kokoroReady = (state.optional || []).some(item => item.name === 'kokoro' && item.state === 'ready');
    const choice = await drawVoiceChoice(kokoroReady, () => draw());
    if (choice && root.isConnected) main.push(choice);

    if (state.vc_runtime?.missing) {
      // Windows without Microsoft's C++ runtime (the installer normally adds it): one plain line, not a DLL error.
      main.push(group({}, [row({ title: state.vc_runtime.message || 'Install the Microsoft Visual C++ runtime',
        description: 'Microsoft download: aka.ms/vs/17/release/vc_redist.x64.exe. Restart Kairos afterwards.' })]));
    } else if (!state.engine_available) {
      // A missing binding is a broken build, not something a download fixes,
      // so this deliberately does not offer one.
      main.push(group({}, [row({ title: 'Speech recognition is unavailable in this build.',
        description: 'The speech engine could not be loaded, so dictation cannot run. Reinstalling the latest release usually resolves it.' })]));
    }

    const modelRows = [];
    for (const model of state.engine_available ? state.models : []) {
      let control;
      if (model.downloaded) {
        control = model.name === state.active_model ? pill('In use', 'ok') : pill('Downloaded', 'muted');
      } else if (!isAdmin) {
        control = el('span', { class: 'meta', text: 'An admin can download this' });
      } else {
        const progress = el('span', { class: 'meta', role: 'status' });
        const button = el('button', { type: 'button', class: 'btn', text: 'Download' });
        button.addEventListener('click', async () => {
          button.disabled = true;
          progress.textContent = 'Starting…';
          try {
            await api(`/api/speech/models/${model.name}/download`, { method: 'POST' });
          } catch (error) {
            progress.textContent = '';
            button.disabled = false;
            toast(error.message || 'Download could not be started.', 'error');
            return;
          }
          const timer = setInterval(async () => {
            if (!root.isConnected) { clearInterval(timer); timers.delete(timer); return; }
            let info;
            try { info = await api(`/api/speech/models/${model.name}/progress`); } catch { return; }
            if (info.total) {
              progress.textContent = `${Math.round((info.completed / info.total) * 100)}%`;
            }
            if (info.done) {
              clearInterval(timer);
              timers.delete(timer);
              if (info.error) {
                progress.textContent = '';
                button.disabled = false;
                toast(`Download failed: ${info.error}`, 'error');
                return;
              }
              // The cached status drives whether the mic button works at all,
              // so it has to be invalidated here or dictation keeps refusing
              // until the page is reloaded.
              refreshSpeechStatus();
              toast(`${model.label} speech model ready`, 'success');
              draw();
            }
          }, POLL_MS);
          timers.add(timer);
        });
        control = el('div', { class: 'speech-model-actions' }, [progress, button]);
      }
      modelRows.push(row({ title: `${model.label} · ${model.size_mb} MB`, description: model.description || '', control, cls: 'speech-model' }));
    }
    if (state.engine_available) parts.push(group({ title: 'Recognition model', description: state.active_model
      ? `Using the ${state.active_model} model.`
      : 'No model downloaded yet. Dictation stays unavailable until one is.' }, modelRows));

    // Optional ONNX downloads. Each row says plainly what is missing; nothing downloads unless Download is pressed.
    const optionalRows = (state.optional || []).map(item => {
      const status = el('span', { class: 'meta', role: 'status', text: item.status });
      const parts = [status];
      if (item.state === 'ready') parts.unshift(pill('Ready', 'ok'));
      if (item.downloaded && isAdmin) {
        parts.push(el('button', { type: 'button', class: 'btn quiet', text: 'Remove', onclick: async () => {
          try { await api(`/api/speech/optional/${item.name}`, { method: 'DELETE' }); refreshSpeechStatus(); draw(); }
          catch (error) { toast(error.message || 'Could not remove it.', 'error'); }
        } }));
      } else if (!item.downloaded && item.pinned && item.state !== 'downloading') {
        if (!isAdmin) parts.push(el('span', { class: 'meta', text: 'An admin can download this' }));
        else {
          const button = el('button', { type: 'button', class: 'btn', text: 'Download' });
          button.addEventListener('click', async () => {
            button.disabled = true; status.textContent = 'Starting…';
            try { await api(`/api/speech/optional/${item.name}/download`, { method: 'POST' }); }
            catch (error) { status.textContent = item.status; button.disabled = false; toast(error.message || 'Download could not be started.', 'error'); return; }
            const timer = setInterval(async () => {
              if (!root.isConnected) { clearInterval(timer); timers.delete(timer); return; }
              let info; try { info = await api(`/api/speech/optional/${item.name}/progress`); } catch { return; }
              if (info.total) status.textContent = `${Math.min(100, Math.round((info.completed / info.total) * 100))}%`;
              if (info.done) {
                clearInterval(timer); timers.delete(timer);
                if (info.error) { status.textContent = item.status; button.disabled = false; toast(`Download failed: ${info.error}`, 'error'); return; }
                refreshSpeechStatus(); toast(`${item.label} downloaded`, 'success'); draw();
              }
            }, POLL_MS);
            timers.add(timer);
          });
          parts.push(button);
        }
      }
      // Not yet downloaded but the runtime is also missing: say so up front rather than after a long download.
      const needs = !item.downloaded && item.missing_runtime?.length ? ` Also needs ${item.missing_runtime_text || item.missing_runtime.join(', ')}.` : '';
      // Once usable, say which part of the computer runs it (Kokoro: the graphics card when it can, else the processor).
      const runsOn = item.runs_on ? ` ${item.runs_on}` : '';
      return row({ title: `${item.label} · ${item.size_mb} MB`, description: (item.description || '') + needs + runsOn, control: el('div', { class: 'speech-model-actions' }, parts), cls: 'speech-optional' });
    });
    if (optionalRows.length) parts.push(group({ title: 'Optional voice features', description: 'Not needed for dictation. They need the ONNX runtime and stay off until you download them.', cls: 'speech-optional-group' }, optionalRows));

    const deviceSection = await drawDevices();
    if (deviceSection && root.isConnected) main.push(deviceSection);
    const engines = await drawVoiceServers(isAdmin, () => draw());
    if (engines && root.isConnected) parts.unshift(engines);
    const voiceSection = await drawVoice();
    if (voiceSection && root.isConnected) parts.splice(engines ? 1 : 0, 0, voiceSection);
    const sayings = await drawPronunciations();
    if (sayings && root.isConnected) parts.splice((engines ? 1 : 0) + (voiceSection ? 1 : 0), 0, sayings);
    if (state.engine_available && state.acceleration?.supported) parts.push(drawRuntime(state));
    const freeVoice = await drawFreeVoice();
    if (freeVoice && root.isConnected) parts.push(freeVoice);

    parts.push(note('Larger recognition models are more accurate and slower. Recognition runs on the processor unless a GPU runtime is connected, so a long recording on a modest machine takes a few seconds.'));
    const more = el('details', { class: 'speech-more' }, [el('summary', { class: 'speech-more-summary', text: 'More options' }), ...parts]);
    if (moreOpen) more.open = true;
    more.addEventListener('toggle', () => { moreOpen = more.open; });
    root.replaceChildren(...main, more);
  }
  let moreOpen = false;

  // The one Voice choice (voiceEnginesSetup.js): Kairos Voice, GPT-Live, ElevenLabs.
  async function drawVoiceChoice(kokoroReady, redraw) {
    const state = await api('/api/voice-engines', { toast: false }).catch(() => null);
    if (!state) return null;
    const { voiceChoice, APPLIES } = await import('../voiceEnginesSetup.js');
    return group({ title: 'Voice', cls: 'speech-voice-choice', description: APPLIES }, [voiceChoice(state, { kokoroReady, onChanged: redraw })]);
  }

  // More options: Voicebox, or another voice server on this computer (an admin connects them).
  async function drawVoiceServers(admin, redraw) {
    const state = await api('/api/voice-engines', { toast: false }).catch(() => null);
    if (!state) return null;
    const { voiceboxSetup, compatibleSetup } = await import('../voiceEnginesSetup.js');
    return group({ title: 'Voice servers on this computer', cls: 'speech-voice-engines',
      description: 'For people who already run their own voice server. If it fails, Kokoro (when downloaded) or the device voice takes over.' }, [
      row({ title: 'Voicebox', description: 'Free, open source, with cloned and designed voices. You install and open it yourself.', control: state.choice === 'voicebox' ? pill('In use', 'ok') : pill('Not in use', 'muted') }),
      voiceboxSetup(state, { isAdmin: admin, onChanged: redraw }),
      row({ title: 'Another voice server', description: 'Any server on this computer that speaks the OpenAI speech API.', control: state.choice === 'compatible' ? pill('In use', 'ok') : pill('Not in use', 'muted') }),
      compatibleSetup(state, { isAdmin: admin, onChanged: redraw }),
    ]);
  }

  // More options: how Kairos Voice says particular words (names it gets wrong).
  async function drawPronunciations() {
    const found = await api('/api/voice-engines/pronunciations', { toast: false }).catch(() => null);
    if (!found) return null;
    const { pronunciationsSetup } = await import('../voiceEnginesSetup.js');
    return group({ title: 'Pronunciations', cls: 'speech-pronunciations-group',
      description: 'Words Kairos Voice says wrong, like a name. Write how to say it with hyphens between syllables and the stressed one in capitals, like shi-VAWN for Siobhan.' },
      [pronunciationsSetup(found.items || [])]);
  }

  // More options: the GPU runtime folder for recognition (the same setting Call settings offers; an admin sets it).
  function drawRuntime(state) {
    const folder = el('input', { type: 'text', placeholder: 'Installed whisper.cpp CUDA folder', 'aria-label': 'GPU runtime folder' });
    const said = el('span', { class: 'meta', role: 'status', text: state.acceleration?.configured ? 'Connected. Recognition uses the graphics card when it can, else the processor.' : 'Not connected. Recognition runs on the processor.' });
    const act = (text, run) => el('button', { type: 'button', class: 'btn quiet', text, onclick: async () => {
      try { await run(); refreshSpeechStatus(); draw(); } catch (error) { said.textContent = error.message || 'That did not work.'; }
    } });
    const controls = isAdmin ? [folder, act('Use runtime', () => api('/api/speech/runtime', { method: 'POST', body: JSON.stringify({ folder: folder.value.trim() }) })),
      ...(state.acceleration?.configured ? [act('Disconnect', () => api('/api/speech/runtime', { method: 'DELETE' }))] : [])] : [el('span', { class: 'meta', text: 'An admin can connect one' })];
    return group({ title: 'Processor', cls: 'speech-runtime', description: 'Optional: a whisper.cpp CUDA build you installed makes recognition faster on an NVIDIA graphics card. Nothing downloads.' },
      [row({ title: 'GPU runtime folder', description: said, control: el('div', { class: 'speech-model-actions' }, controls) })]);
  }

  // Free realtime voice (freeVoiceSetup.js): realtime speech-to-speech on a free Gemini key, set up in a few steps.
  async function drawFreeVoice() {
    const state = await api('/api/models/free-voice', { toast: false }).catch(() => null);
    if (!state) return null;
    const { freeVoiceSetup } = await import('../freeVoiceSetup.js');
    const badge = state.configured ? pill('Connected', 'ok') : pill('Not set up', 'muted');
    return group({ title: 'Realtime calls on a free key', cls: 'speech-free-voice',
      description: 'Realtime voice is the quickest, most natural way to talk with a bot. It needs a provider key; a free Gemini key from Google works. Realtime calls send your audio to Google, unlike dictation, which stays on this computer.' }, [
      row({ title: 'Gemini free key', description: state.configured ? `Realtime voice can use Gemini (${state.model}) at no cost.` : 'Not set up yet.', control: badge }),
      freeVoiceSetup({ configured: state.configured, onConnected: () => draw() }),
    ]);
  }

  await draw();
}

import { api, el, toast } from '../api.js';
import { refreshSpeechStatus, listInputDevices, getInputDevice, setInputDevice, requestMicrophoneAccess, isRecordingSupported } from '../voiceInput.js';
import { isSpeechOutputSupported, whenVoicesReady, resolveVoice, getPreferredVoice, setPreferredVoice } from '../voiceOutput.js';
import { group, row, pill } from '../settingsKit.js';
import { voiceSettings } from '../callVoice.js';

// Settings > Workspace > Speech (David's ask 2026-09-15). Since 2026-11-10 (Locked shape) the main path is one plain
// Voice choice (voiceEnginesSetup.js) and the microphone. More options was reorganised the same day (David: "clean up
// the extended voice settings") into a few named groups, each with a one-line purpose:
//   Voice quality and voice  - the Standard voice download (Kokoro), HD voice on an NVIDIA card, the fallback device
//                              voice and the Open Mic voice
//   Pronunciations           - words Kairos Voice says wrong
//   Listening                - the recognition model and Smart Turn (when you have finished speaking)
//   Voice servers on this computer - Voicebox and another OpenAI-compatible server, each set up behind its own button
//   Realtime on a free Gemini key
//   Advanced (one disclosure) - the whisper.cpp GPU folder, where each voice runs, the HD voice's files
// Removed as duplicates: the Open Mic voice's own "Connect local voices" (the same as Voice servers) and the separate
// "Optional voice features" and "Processor" groups (their rows live in the groups above now).
//
// Dictation ships with the engine but no model, so without this panel there is no way to obtain one and the mic button
// can only ever refuse. Models are several hundred megabytes and land in the shared data directory, so downloading is
// admin-gated the same way adding a model endpoint is; the status itself is readable by anyone, since a non-admin
// still needs to know why dictation is unavailable.

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

  // -- the device voice and the Open Mic voice (rows of Voice quality and voice) --------------------------------------
  async function voiceRows() {
    if (!isSpeechOutputSupported()) return [];
    const voices = await whenVoicesReady();
    if (!root.isConnected) return [];
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

    // David asked for a British voice. When none is installed, quietly offering a list of American ones would look
    // like the request was ignored, so the row says what is missing and how to add one.
    const british = voices.some(v => /^en[-_]GB/i.test(v.lang)) ? '' : ' No British English voice is installed: add one in Windows Settings, Time & language, Speech, Manage voices.';
    const rows = [row({ title: 'Backup voice', description: `This device's own voice. Kairos uses it only when no other voice is ready.${british}`, control: [preview, select] })];
    // Open Mic speaks through the same sentence speaker a call uses. By default it follows the Voice above; a voice
    // picked here is used for Open Mic instead. Saved as kairos:neural-voice:openmic (openMic.js OPEN_MIC_VOICE_KEY).
    // The engine's own servers are set up under Voice servers, so the call screen's "Connect local voices" is hidden.
    const neural = voiceSettings({ id: 'openmic' }, select, {}, { follow: true, connect: false });
    neural.sync();
    let neuralLoaded = false;
    const loadNeural = () => { if (neuralLoaded) return; neuralLoaded = true; neural.load(); };
    neural.node.addEventListener('change', () => { if (neural.selection().provider === 'neural') loadNeural(); });
    if (neural.selection().provider === 'neural') loadNeural();
    rows.push(row({ title: 'Open Mic voice', description: 'Same as the Voice, unless you pick another voice for Open Mic only.', control: [neural.node], stack: true, cls: 'speech-openmic-voice' }));
    // Stated here, next to the voice, because that is where someone looks for it (speechSynthesis has no output choice).
    rows.push(row({ title: 'Output device', description: 'Spoken replies play through your system default output. Change it in your operating system sound settings.' }));
    return rows;
  }

  // An optional download row (Kokoro, Smart Turn): its state in plain words, Download with progress, Remove.
  function optionalRow(item, title, description) {
    const said = el('span', { class: 'meta', role: 'status', text: item.state === 'ready' ? '' : item.status });
    const parts = [said];
    if (item.state === 'ready') parts.unshift(pill('Ready', 'ok'));
    if (item.downloaded && isAdmin) {
      parts.push(el('button', { type: 'button', class: 'btn quiet', text: 'Remove', onclick: async () => {
        try { await api(`/api/speech/optional/${item.name}`, { method: 'DELETE' }); refreshSpeechStatus(); draw(); }
        catch (error) { toast(error.message || 'Could not remove it.', 'error'); }
      } }));
    } else if (!item.downloaded && item.pinned && item.state !== 'downloading') {
      if (!isAdmin) parts.push(el('span', { class: 'meta', text: 'An admin can download this' }));
      else {
        const button = el('button', { type: 'button', class: 'btn', text: `Download · ${item.size_mb} MB`, 'data-speech-download': item.name });
        button.addEventListener('click', async () => {
          button.disabled = true; said.textContent = 'Starting…';
          try { await api(`/api/speech/optional/${item.name}/download`, { method: 'POST' }); }
          catch (error) { said.textContent = item.status; button.disabled = false; toast(error.message || 'Download could not be started.', 'error'); return; }
          const timer = setInterval(async () => {
            if (!root.isConnected) { clearInterval(timer); timers.delete(timer); return; }
            let info; try { info = await api(`/api/speech/optional/${item.name}/progress`); } catch { return; }
            if (info.total) said.textContent = `${Math.min(100, Math.round((info.completed / info.total) * 100))}%`;
            if (info.done) {
              clearInterval(timer); timers.delete(timer);
              if (info.error) { said.textContent = item.status; button.disabled = false; toast(`Download failed: ${info.error}`, 'error'); return; }
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
    return row({ title, description: description + needs, control: el('div', { class: 'speech-model-actions' }, parts), cls: 'speech-optional', attrs: { 'data-optional': item.name } });
  }

  // -- the recognition models (rows of Listening) ---------------------------------------------------------------------
  function recognitionRows(state) {
    return (state.engine_available ? state.models : []).map(model => {
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
            if (info.total) progress.textContent = `${Math.round((info.completed / info.total) * 100)}%`;
            if (info.done) {
              clearInterval(timer);
              timers.delete(timer);
              if (info.error) {
                progress.textContent = '';
                button.disabled = false;
                toast(`Download failed: ${info.error}`, 'error');
                return;
              }
              // The cached status drives whether the mic button works at all, so it has to be invalidated here or
              // dictation keeps refusing until the page is reloaded.
              refreshSpeechStatus();
              toast(`${model.label} speech model ready`, 'success');
              draw();
            }
          }, POLL_MS);
          timers.add(timer);
        });
        control = el('div', { class: 'speech-model-actions' }, [progress, button]);
      }
      return row({ title: `Recognition: ${model.label} · ${model.size_mb} MB`, description: model.description || '', control, cls: 'speech-model' });
    });
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
    const engines = await api('/api/voice-engines', { toast: false }).catch(() => null);
    if (!root.isConnected) return;
    const setup = await import('../voiceEnginesSetup.js');
    const optional = Object.fromEntries((state.optional || []).map(item => [item.name, item]));

    // The main path: the Voice and the microphone.
    const main = [];
    if (engines) main.push(group({ title: 'Voice', cls: 'speech-voice-choice', description: setup.APPLIES },
      [setup.voiceChoice(engines, { kokoroReady: optional.kokoro?.state === 'ready', isAdmin, onChanged: () => draw() })]));
    if (state.vc_runtime?.missing) {
      // Windows without Microsoft's C++ runtime (the installer normally adds it): one plain line, not a DLL error.
      main.push(group({}, [row({ title: state.vc_runtime.message || 'Install the Microsoft Visual C++ runtime',
        description: 'Microsoft download: aka.ms/vs/17/release/vc_redist.x64.exe. Restart Kairos afterwards.' })]));
    }
    if (!state.engine_available) {
      // A missing binding is a broken build, not something a download fixes, so this deliberately does not offer one.
      main.push(group({}, [row({ title: 'Speech recognition is unavailable in this build.',
        description: 'The speech engine could not be loaded, so dictation cannot run. Reinstalling the latest release usually resolves it.' })]));
    }
    const devices = await drawDevices();
    if (devices && root.isConnected) main.push(devices);

    // More options, in named groups.
    const parts = [];
    const quality = [];
    if (optional.kokoro) quality.push(optionalRow(optional.kokoro, 'Standard voice (Kokoro)', 'The voice Kairos Voice speaks with on any computer. One download, then it runs on this computer.'));
    const hdNode = engines ? setup.hdVoiceSetup(engines, { isAdmin, onChanged: () => draw() }) : null;
    if (hdNode) quality.push(row({ title: 'HD voice (NVIDIA)', description: engines.hd?.installed ? 'Pick the HD voice and play a short sample.' : '', below: hdNode, cls: 'speech-hd-row' }));
    quality.push(...await voiceRows());
    if (!root.isConnected) return;
    parts.push(group({ title: 'Voice quality and voice', cls: 'speech-voice-quality speech-voice', description: 'What Kairos Voice sounds like and which voice speaks.' }, quality));

    const sayings = await api('/api/voice-engines/pronunciations', { toast: false }).catch(() => null);
    if (sayings) parts.push(group({ title: 'Pronunciations', cls: 'speech-pronunciations-group',
      description: 'Words Kairos Voice says wrong, like a name. Write how to say it with hyphens between syllables and the stressed one in capitals, like shi-VAWN for Siobhan.' + (engines?.hd?.offered ? ' HD voice uses these spellings; phonemes apply to the Standard voice only.' : '') },
      [setup.pronunciationsSetup(sayings.items || [])]));

    const listening = recognitionRows(state);
    if (optional['smart-turn']) listening.push(optionalRow(optional['smart-turn'], 'Know when you have finished (Smart Turn)', 'Answers sooner without cutting you off mid-sentence. Runs on the processor in about 12 ms.'));
    if (listening.length) parts.push(group({ title: 'Listening', cls: 'speech-listening', description: state.active_model
      ? `How Kairos hears you, on this computer. Using the ${state.active_model} model; larger models are more accurate and slower.`
      : 'How Kairos hears you, on this computer. Dictation stays unavailable until a recognition model is downloaded.' }, listening));

    if (engines) parts.push(drawVoiceServers(engines));
    const freeVoice = await drawFreeVoice();
    if (freeVoice && root.isConnected) parts.push(freeVoice);
    const advanced = drawAdvanced(state, optional, engines);
    if (advanced) parts.push(advanced);

    const more = el('details', { class: 'speech-more' }, [el('summary', { class: 'speech-more-summary', text: 'More options' }), ...parts]);
    if (moreOpen) more.open = true;
    more.addEventListener('toggle', () => { moreOpen = more.open; });
    root.replaceChildren(...main, more);
  }
  let moreOpen = false;

  // A server's or key's setup sits behind one button, open only while it is in use or being set up.
  function behind(label, node, open = false) {
    const box = el('details', { class: 'speech-setup' }, [el('summary', { text: label }), node]);
    box.open = open;
    return box;
  }

  // More options: Voicebox, or another voice server on this computer (an admin connects them).
  function drawVoiceServers(state) {
    const { voiceboxSetup, compatibleSetup } = setupModule;
    const voicebox = state.choice === 'voicebox', compatible = state.choice === 'compatible';
    return group({ title: 'Voice servers on this computer', cls: 'speech-voice-engines',
      description: 'For people who already run their own voice server. If it fails, the Standard voice or the backup voice takes over.' }, [
      row({ title: 'Voicebox', description: 'Free and open source, with cloned and designed voices. You install and open it yourself.', control: voicebox ? pill('In use', 'ok') : pill('Not in use', 'muted'),
        below: behind(voicebox ? 'Change' : 'Set up', voiceboxSetup(state, { isAdmin, onChanged: () => draw() }), voicebox) }),
      row({ title: 'Another voice server', description: 'Any server on this computer that speaks the OpenAI speech API.', control: compatible ? pill('In use', 'ok') : pill('Not in use', 'muted'),
        below: behind(compatible ? 'Change' : 'Set up', compatibleSetup(state, { isAdmin, onChanged: () => draw() }), compatible) }),
    ]);
  }

  // More options: realtime speech-to-speech on a free Gemini key (freeVoiceSetup.js), set up in a few steps.
  async function drawFreeVoice() {
    const state = await api('/api/models/free-voice', { toast: false }).catch(() => null);
    if (!state) return null;
    const { freeVoiceSetup } = await import('../freeVoiceSetup.js');
    const badge = state.configured ? pill('Connected', 'ok') : pill('Not set up', 'muted');
    return group({ title: 'Realtime on a free Gemini key', cls: 'speech-free-voice',
      description: 'The quickest, most natural way to talk with a bot. Realtime calls send your audio to Google; dictation stays on this computer.' }, [
      row({ title: 'Gemini free key', description: state.configured ? `Realtime voice can use Gemini (${state.model}) at no cost.` : 'Not set up yet.', control: badge,
        below: behind(state.configured ? 'Replace the key' : 'Set up', freeVoiceSetup({ configured: state.configured, onConnected: () => draw() })) }),
    ]);
  }

  // More options > Advanced: engineering details, one disclosure.
  function drawAdvanced(state, optional, engines) {
    const rows = [];
    if (state.engine_available && state.acceleration?.supported) {
      const folder = el('input', { type: 'text', placeholder: 'Installed whisper.cpp CUDA folder', 'aria-label': 'GPU runtime folder' });
      const said = el('span', { class: 'meta', role: 'status', text: state.acceleration?.configured ? 'Connected. Recognition uses the graphics card when it can, else the processor.' : 'Not connected. Recognition runs on the processor.' });
      const act = (text, run) => el('button', { type: 'button', class: 'btn quiet', text, onclick: async () => {
        try { await run(); refreshSpeechStatus(); draw(); } catch (error) { said.textContent = error.message || 'That did not work.'; }
      } });
      const controls = isAdmin ? [folder, act('Use runtime', () => api('/api/speech/runtime', { method: 'POST', body: JSON.stringify({ folder: folder.value.trim() }) })),
        ...(state.acceleration?.configured ? [act('Disconnect', () => api('/api/speech/runtime', { method: 'DELETE' }))] : [])] : [el('span', { class: 'meta', text: 'An admin can connect one' })];
      rows.push(row({ title: 'Recognition on the graphics card', description: [said, ' A whisper.cpp CUDA build you installed makes recognition faster on an NVIDIA card. Nothing downloads.'],
        control: el('div', { class: 'speech-model-actions' }, controls), stack: true, cls: 'speech-runtime' }));
    }
    const where = [optional.kokoro?.runs_on ? `Standard voice: ${optional.kokoro.runs_on}` : '', engines?.hd?.installed ? `HD voice: on the ${engines.hd.card || 'NVIDIA card'}, in its own process, stopped after 5 minutes unused.` : '']
      .filter(Boolean).join(' ');
    if (where) rows.push(row({ title: 'Where the voices run', description: where }));
    if (engines?.hd?.installed) rows.push(row({ title: 'HD voice files', description: (engines.hd.sources || []).map(s => `${s.name} (${s.licence}, from ${s.from})`).join('; ') + '.' }));
    if (!rows.length) return null;
    return el('details', { class: 'speech-advanced' }, [el('summary', { text: 'Advanced' }), group({ cls: 'speech-advanced-group' }, rows)]);
  }

  const setupModule = await import('../voiceEnginesSetup.js');
  await draw();
}

import { createRecorder, transcribeBlob, getSpeechStatus, isRecordingSupported } from './voiceInput.js';
import { toast } from './api.js';
import { mobileOn, phone, button } from './mobileShared.js';
import { mountMobileVoiceRow } from './mobileVoiceRow.js';

// Forge had no Open Mic session. Reuse Kairos's dictation engine without
// inventing a second voice conversation protocol for it.
export function mountMobileDictation(composer, input, footer) {
  let recorder = null, disposed = false, working = false;
  const mic = button('Mic', async () => {
    if (working || disposed || input.disabled || input.readOnly) return;
    working = true; mic.disabled = true;
    try {
      if (recorder) {
        const active = recorder; recorder = null; mic.classList.remove('recording'); mic.classList.add('busy');
        const blob = await active.stop(); const text = blob ? await transcribeBlob(blob) : '';
        if (!disposed && text) { input.value += `${input.value ? ' ' : ''}${text}`; input.dispatchEvent(new Event('input')); input.focus(); }
      } else {
        const status = await getSpeechStatus();
        if (disposed) return;
        if (!status?.engine_available || !status.active_model) throw new Error('Set up speech recognition in Settings > Speech.');
        const active = createRecorder({ onLevel: level => mic.style.setProperty('--mic-level', String(level)) });
        await active.start();
        if (disposed) { active.cancel(); return; }
        recorder = active; mic.classList.add('recording');
      }
    } catch (error) { if (!disposed) toast(error.message, 'error'); }
    finally { working = false; mic.disabled = input.disabled || input.readOnly; mic.classList.remove('busy'); }
  }, 'ms-forge-mic');
  mic.setAttribute('aria-label', 'Dictate a message');
  const cancel = () => { recorder?.cancel(); recorder = null; mic.classList.remove('recording'); };
  mic.addEventListener('kairos:cancel-dictation', cancel);
  const unused = document.createElement('button');
  footer.append(mic);
  const voice = mountMobileVoiceRow(composer, mic, unused);
  const gate = () => { mic.hidden = !mobileOn() || !isRecordingSupported(); mic.disabled = working || input.disabled || input.readOnly; if (!mobileOn()) cancel(); };
  const stateObserver = new MutationObserver(gate); stateObserver.observe(input, { attributes: true, attributeFilter: ['disabled', 'readonly'] });
  phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate); gate();
  return () => { disposed = true; stateObserver.disconnect(); cancel(); voice(); mic.remove(); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); };
}

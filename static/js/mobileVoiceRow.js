import { mobileOn, phone, reduced, button } from './mobileShared.js';

export function mountMobileVoiceRow(composer, mic, openMic) {
  const row = document.createElement('div'); row.className = 'ms-voice-row'; row.hidden = true;
  const cancel = button('Cancel', () => {
    if (mic.classList.contains('recording')) mic.dispatchEvent(new Event('kairos:cancel-dictation'));
    else if (openMic.classList.contains('active')) openMic.click();
  });
  const wave = document.createElement('span'); wave.className = 'ms-voice-wave'; wave.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 9; i++) wave.append(document.createElement('i'));
  const timer = document.createElement('span'); timer.className = 'ms-voice-timer'; timer.setAttribute('role', 'timer');
  const done = button('Done', () => { if (mic.classList.contains('recording')) mic.click(); else if (openMic.classList.contains('active')) openMic.click(); });
  row.append(cancel, wave, timer, done); composer.append(row);
  let started = 0, interval;
  const tick = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const sync = () => {
    const active = mobileOn() && (mic.classList.contains('recording') || mic.classList.contains('busy') || openMic.classList.contains('active'));
    row.hidden = !active;
    if (composer.classList.contains('ms-dictating') !== active) composer.classList.toggle('ms-dictating', active);
    if (active && !interval) { started = Date.now(); tick(); interval = setInterval(tick, 1000); }
    if (!active) { clearInterval(interval); interval = null; }
    const busy = mic.classList.contains('busy'); done.disabled = busy; cancel.disabled = busy;
    const level = reduced.matches ? '.15' : mic.style.getPropertyValue('--mic-level') || '.15'; wave.style.setProperty('--ms-level', level);
    wave.setAttribute('aria-label', openMic.dataset.micState || (busy ? 'Transcribing' : 'Recording'));
  };
  const observer = new MutationObserver(sync);
  for (const node of [mic, openMic]) observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-mic-state'] });
  phone.addEventListener('change', sync); reduced.addEventListener('change', sync); document.addEventListener('kairos:appearance', sync); sync();
  return () => { observer.disconnect(); clearInterval(interval); row.remove(); composer.classList.remove('ms-dictating'); phone.removeEventListener('change', sync); reduced.removeEventListener('change', sync); document.removeEventListener('kairos:appearance', sync); };
}

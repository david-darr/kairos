// Where a call's voice plays (call screen redesign, 2026-11-10). Only an AudioContext with setSinkId can choose a
// device: the Kairos Voice and realtime voice play through one; a device voice (speechSynthesis) always plays on the
// system default. The choice is kept on this device and applied to every call voice that starts after it.
const KEY = 'kairos:call-output';
const live = new Set();

export const outputSupported = () => typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function'
  && !!navigator.mediaDevices?.enumerateDevices;

export function chosenOutput() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }

// Speakers and headphones this device offers (labels appear once the microphone was allowed).
export async function listOutputs() {
  if (!outputSupported()) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, at) => ({ id: d.deviceId, label: d.label || `Speaker ${at + 1}` }));
  } catch { return []; }
}

// A call voice's AudioContext: play on the chosen device now and after any later choice. Never throws.
export function routeContext(context) {
  if (!context || typeof context.setSinkId !== 'function') return;
  live.add(context);
  const id = chosenOutput();
  if (id) context.setSinkId(id).catch(() => {});
}

export function chooseOutput(id) {
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* the choice lasts this call */ }
  for (const context of live) {
    if (context.state === 'closed') { live.delete(context); continue; }
    context.setSinkId(id || '').catch(() => {});
  }
}

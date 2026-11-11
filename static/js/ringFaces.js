// The caller's face on a ring notification (2026-11-10). A push arrives when no Kairos window may be open, and a
// notification icon must be a picture the phone can show (not an SVG), so whenever a bot's call screen is set up this
// draws its Kip once into a small PNG and keeps it in this device's IndexedDB ('kairos-faces'), where the service worker
// (static/sw.js) reads it for "<Bot> is calling". A bot with its own uploaded picture uses that instead. Nothing leaves
// the device; a failure only means the app icon is shown.
import { botMascot, mascotUrl } from './mascot.js';

const SIZE = 192;
const DB = 'kairos-faces';
const done = new Set();

function store(agentId, record) {
  return new Promise(resolve => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('faces');
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction('faces', 'readwrite');
          tx.objectStore('faces').put(record, agentId);
          tx.oncomplete = () => { open.result.close(); resolve(true); };
          tx.onerror = () => { open.result.close(); resolve(false); };
        } catch { resolve(false); }
      };
    } catch { resolve(false); }
  });
}

export async function drawFace(agent, { size = SIZE } = {}) {
  const url = mascotUrl(botMascot(agent), 'idle');
  const image = new Image(size, size);
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(image, 0, 0, size, size);
  return { png: canvas.toDataURL('image/png'), key: url.length + ':' + url.slice(-48) };
}

// Called with a bot whose call screen just mounted; at most once per bot per page, in idle time.
export function rememberFace(agent) {
  if (!agent?.id || done.has(agent.id) || typeof indexedDB === 'undefined' || typeof document === 'undefined') return;
  done.add(agent.id);
  const run = async () => { try { const face = await drawFace(agent); await store(String(agent.id), { ...face, at: Date.now() }); } catch { /* the app icon stands in */ } };
  (window.requestIdleCallback || (fn => setTimeout(fn, 1500)))(run);
}

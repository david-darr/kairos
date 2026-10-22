import { avatarSpec } from './agentAvatar.js';
import { kipUrl, kipStripUrl } from './mascot.js';

// The village draws each bot as its Kip in the pixel style (Kairos
// Mascot build spec, 2026-10-22; David: Kip is the visual agent ecosystem).
// The still sprite is rasterized once per look and pose at twice the 24px
// grid, so it stays crisp; walking, working and waiting play strips of frames
// with CSS steps() (agent-ecosystem.css), one per look, with no frame loop.
const sprites = new Map();
export function profileSprite(agent, pose = 'idle') {
  const spec = avatarSpec(agent), source = kipUrl(spec, pose), key = JSON.stringify(spec);
  const cacheKey = source;
  if (!sprites.has(cacheKey)) {
    if (sprites.size >= 128) sprites.delete(sprites.keys().next().value);
    const promise = new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, 0, 0, 48, 48);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => { sprites.delete(cacheKey); resolve(source); };
      image.src = source;
    });
    sprites.set(cacheKey, promise);
  }
  const node = document.createElement('img'); node.className = 'ecosystem-profile-pixels';
  node.alt = ''; node.setAttribute('aria-hidden', 'true'); node.dataset.avatarSpec = key; node.dataset.pose = pose;
  node.src = source; node.draggable = false;
  sprites.get(cacheKey).then(url => { node.src = url; node.dataset.pixelReady = 'true'; });
  return node;
}

// The moving poses as CSS custom properties for a character's sprite box.
export function kipSheets(agent) {
  const spec = avatarSpec(agent), out = {};
  for (const [name, state] of [['walk', 'walk'], ['work', 'thinking'], ['needs', 'needs']]) {
    const { url, frames } = kipStripUrl(spec, state);
    out[`--kip-${name}`] = `url("${url}")`;
    out[`--kip-${name}-frames`] = String(frames);
  }
  return out;
}

import { avatarSpec, avatarUrl } from './agentAvatar.js';

// Rasterize the actual profile at sprite resolution, once per profile revision.
// The resulting pixels preserve its silhouette, face, accessories and finish.
const sprites = new Map();
export function profileSprite(agent) {
  const spec = avatarSpec(agent), source = avatarUrl(spec), key = JSON.stringify(spec);
  if (!sprites.has(key)) {
    if (sprites.size >= 128) sprites.delete(sprites.keys().next().value);
    const promise = new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 40;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, 40, 40);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => { sprites.delete(key); resolve(source); };
      image.src = source;
    });
    sprites.set(key, promise);
  }
  const node = document.createElement('img'); node.className = 'ecosystem-profile-pixels';
  node.alt = ''; node.setAttribute('aria-hidden', 'true'); node.dataset.avatarSpec = key;
  node.src = source; node.draggable = false;
  sprites.get(key).then(url => { node.src = url; node.dataset.pixelReady = 'true'; });
  return node;
}

import { mountDesignCanvas } from './designCanvas.js';

// A design keeps one live canvas across Chat and Library. Parking preserves
// selections, iframe editing state, token drafts, comments and the viewport.
const canvases = new Map();
export function mountSharedDesignCanvas(host, options) {
  let entry = canvases.get(options.designId);
  if (!entry) {
    entry = { options };
    const delegate = name => (...args) => entry.options[name]?.(...args);
    entry.canvas = mountDesignCanvas(host, { designId: options.designId,
      onLoaded: delegate('onLoaded'), onSelection: delegate('onSelection'), onComments: delegate('onComments'), onOpenChat: delegate('onOpenChat') });
    canvases.set(options.designId, entry);
  }
  entry.options = options;
  const { canvas } = entry;
  if (canvas.root.parentElement !== host) {
    if (host.moveBefore && canvas.root.isConnected) host.moveBefore(canvas.root, null);
    else host.append(canvas.root);
  }
  if (canvas.design) options.onLoaded?.(canvas.design);
  return { ...canvas, get design() { return canvas.design; }, dispose() {
    if (canvas.root.parentElement !== host) return;
    let parking = document.getElementById('design-canvas-parking');
    if (!parking) {
      parking = document.createElement('div'); parking.id = 'design-canvas-parking'; parking.hidden = true; parking.inert = true;
      const holder = document.createElement('div'); parking.attachShadow({ mode: 'open' }).append(holder); document.body.append(parking);
    }
    parking = parking.shadowRoot.firstElementChild;
    if (parking.moveBefore) parking.moveBefore(canvas.root, null); else parking.append(canvas.root);
    entry.options = {};
  } };
}

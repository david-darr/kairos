// Animated (David, 2026-10-28: "the actual picture displayed unchanged"): a piece drawn by ASCII
// Magic's own player (static/vendor/ascii-magic/runtime/player.js), exactly as ascii-magic.com
// shows it. The whole piece is centred and as large as its space allows; nothing is drawn over
// it or around it, and the space it leaves shows the background behind the host.
import { play } from '../vendor/ascii-magic/runtime/player.js';
import { CELL_W, cellAspect } from '../vendor/ascii-magic/runtime/canvas.js';
import { ART_CATALOG } from './artCatalog.js';

export const DEFAULT_ART_PIECE = 'aurora-cabin-snowfall';
export const isArtPiece = slug => ART_CATALOG.some(([id]) => id === slug);
export const loadArtPiece = slug => import(`../vendor/ascii-magic/pieces/${isArtPiece(slug) ? slug : DEFAULT_ART_PIECE}.js`);

// `look` is one of the player's own looks, or 'original' for the piece as made; `still` holds one
// frame (the player also does for reduced motion); `crop` fills the host and lets the edges go, for
// thumbnails too small to show a whole piece. Returns a function that stops and removes it.
export function mountArt(host, { piece, look = 'original', still = false, crop = false }) {
  const pre = document.createElement('pre');
  pre.className = 'art-player'; pre.setAttribute('aria-hidden', 'true');
  host.append(pre);
  let stop = () => {}, meta = null, disposed = false;
  // The player reads its cell size from the <pre>'s font size, so fitting is one style.
  const fit = () => {
    if (!meta) return;
    const across = host.clientWidth / (meta.cols * CELL_W), down = host.clientHeight / (meta.rows * CELL_W * cellAspect(meta));
    // A crop keeps cells large enough to read (halftone dots vanish below about two pixels).
    pre.style.fontSize = `${crop ? Math.max(across, down, 5) : Math.max(.25, Math.min(across, down))}px`;
  };
  const resize = new ResizeObserver(fit);
  resize.observe(host);
  loadArtPiece(piece).then(mod => {
    if (disposed) return;
    meta = mod.meta; fit();
    // A still frame a few seconds in: many pieces open on a dark first frame and fade in.
    stop = play(pre, mod, { still: still || undefined, t0: still ? 3 : 0, look: look === 'original' ? {} : { look } });
  }).catch(() => { /* the background stays */ });
  return () => { disposed = true; stop(); resize.disconnect(); pre._canvas?.remove(); pre.remove(); };
}

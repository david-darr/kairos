// static/js/browseLook.js — Browse's own look (David, 2026-11-03: "more
// customization with the sidebar/background, such as all the appearance
// settings within normal Kairos along with a chameleon mode"; "Its own look").
//
// Kairos has one appearance for the whole app (appearance.js). Browse keeps a
// look of its own and lays it over that appearance only while Browse is on
// screen (setAppearanceOverride), so the rest of Kairos never changes:
//   - Same as Kairos (the default), Parchment, a Colour, Liquid glass, an
//     Animated piece, or Flow: the same styles as Settings > Appearance.
//     Kairos's Image style is not offered here: its picture belongs to the
//     account; the home screen has a picture of its own instead.
//   - Chameleon: the sidebar and background take the colour of the site in
//     the active tab (its theme colour, else one sampled from the top of the
//     page, electron/browser-tabs.js); on the home screen, the look above.
// Saved on this device, like Kairos's own appearance.

import { setAppearanceOverride, GLASS_WALLPAPERS } from './appearance.js';
import { ART_CATALOG } from './artCatalog.js';

const KEY = 'kairos:browse-look:v1';
export const LOOKS = [['kairos', 'Same as Kairos'], ['default', 'Parchment'], ['color', 'Colour'], ['glass', 'Liquid glass'], ['animated', 'Animated'], ['shader', 'Flow']];
export const COLOURS = [['Parchment', '#f3eadb'], ['Linen', '#e9e4da'], ['Stone', '#a7aca5'], ['Clay', '#533c32'], ['Plum', '#3c2943'], ['Ocean', '#233447'], ['Forest', '#23302e'], ['Graphite', '#202127'], ['Espresso', '#18130f']];
const DEFAULT_LOOK = Object.freeze({ look: 'kairos', color: '#233447', glassWallpaper: 'lagoon', animatedPiece: ART_CATALOG[0][0], chameleon: false });

export function cleanLook(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_LOOK };
  if (LOOKS.some(([id]) => id === v.look)) out.look = v.look;
  if (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color)) out.color = v.color.toLowerCase();
  if (Object.hasOwn(GLASS_WALLPAPERS, v.glassWallpaper || '')) out.glassWallpaper = v.glassWallpaper;
  if (ART_CATALOG.some(([id]) => id === v.animatedPiece)) out.animatedPiece = v.animatedPiece;
  if (typeof v.chameleon === 'boolean') out.chameleon = v.chameleon;
  return out;
}

export function loadLook() {
  try { return cleanLook(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return cleanLook(null); }
}
export function saveLook(look) {
  const clean = cleanLook(look);
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* the look still applies for this visit */ }
  return clean;
}

// What to lay over Kairos's appearance for this look and the active page's
// colour (null on the home screen or a page with none). null = nothing.
export function overrideFor(look, pageColor) {
  if (look.chameleon && pageColor && /^#[0-9a-f]{6}$/i.test(pageColor)) return { mode: 'color', color: pageColor.toLowerCase() };
  switch (look.look) {
    case 'default': return { mode: 'default' };
    case 'color': return { mode: 'color', color: look.color };
    case 'glass': return { mode: 'glass', glassWallpaper: look.glassWallpaper };
    case 'animated': return { mode: 'animated', animatedPiece: look.animatedPiece };
    case 'shader': return { mode: 'shader' };
    default: return null;
  }
}

// Applied only when it changes, so a stream of tab updates with the same
// colour doesn't redraw the whole app.
let lastKey = '';
export function applyLook(look, pageColor) {
  const patch = overrideFor(look, pageColor);
  const key = JSON.stringify(patch);
  if (key === lastKey) return;
  lastKey = key;
  document.documentElement.toggleAttribute('data-browse-chameleon', !!look.chameleon);
  setAppearanceOverride(patch);
}
export function clearLook() {
  lastKey = '';
  document.documentElement.removeAttribute('data-browse-chameleon');
  setAppearanceOverride(null);
}

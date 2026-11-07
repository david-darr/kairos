import { PICTURE_EFFECTS, ART_LOOKS, OWN_ART, normalizeEffectOptions } from './backgroundEffectPreferences.js';
import { pieceColors, pictureColors } from './artTheme.js';
import { mountArt, isArtPiece, loadArtPiece, DEFAULT_ART_PIECE } from './artPlayer.js';
import { ART_CATALOG } from './artCatalog.js';
import { kipStyleOf, DEFAULT_KIP_STYLE } from './kipStyle.js';
// Device-local appearance. Images are decoded into canvas pixels, never
// injected as URLs or uploaded. IndexedDB keeps them out of small JSON storage.
const DEFAULTS = Object.freeze({ mode: 'default', color: '#f3eadb', tint: .65,
  distortion: .35, swirl: .3, grainMixer: .2, grainOverlay: .12, motion: true, chatStyle: 'standard', halftone: true, backgroundEffect: 'dithered', effectOptions: null, animatedPiece: DEFAULT_ART_PIECE, kip: DEFAULT_KIP_STYLE, mascot: true,
  artLook: 'original', chatMessages: 'plain', glassWallpaper: 'lagoon', glassStrength: .6, glassDither: .35,
  glassDesktop: true, glassWindow: .5, artBase: '#15171d', artAccent: '', artPanels: .6 });
// Liquid glass (desktop redesign, 2026-10-28; canvas board Glass): a drifting
// wallpaper behind a translucent window. Each wallpaper is a base (the theme
// is derived from it like a Color base) and three light blooms.
export const GLASS_WALLPAPERS = Object.freeze({
  lagoon: { title: 'Lagoon', base: '#1f3a44', blooms: ['#2f7f86', '#7cc4c0', '#d9b260'] },
  dusk: { title: 'Dusk', base: '#2a2235', blooms: ['#6b4a7a', '#d99a92', '#e9ba68'] },
  parchment: { title: 'Parchment', base: '#efe4d2', blooms: ['#d9b260', '#b9d2e3', '#d99a92'] },
});
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const TOKENS = ['--bg', '--bg-panel', '--bg-panel-solid', '--surface-2', '--sidebar-bg',
  '--text', '--text-dim', '--text-faint', '--sidebar-text', '--sidebar-muted', '--sidebar-accent', '--border', '--border-strong', '--accent', '--accent-rgb',
  '--ink-rgb', '--shade-rgb', '--scrim', '--danger', '--danger-rgb', '--success', '--success-rgb', '--warn', '--warn-rgb', '--wash-rgb'];
// Status colors that stay readable on each kind of base: Kairos's own on a
// light one, lighter tints on a dark one (both clear WCAG AA on their base).
const STATUS = {
  light: { danger: [168, 67, 47], success: [77, 108, 72], warn: [140, 88, 21] },
  dark: { danger: [240, 128, 136], success: [140, 200, 172], warn: [217, 182, 125] },
};
let settings, storageKey = '', imageBitmap = null;
// A control can change the look while authentication is still resolving.
// Carry those explicit changes into the first account load, then consume them.
let startupPatch = null;
let imageCanvas, shaderCanvas, previewCanvas, glScene, animation = 0, lastFrame = 0, time = 0;
let storageIssue = '', imageRevision = 0, identityRevision = 0, imageQueue = Promise.resolve();
// Animated (David, 2026-10-28): the art fills the window and the theme follows its colours.
// Scatter's six pieces are picked once a session; your own animation is kept as it was chosen
// (IndexedDB, this device only) and played from an object URL.
let ownArt = null, artRevision = 0, artColorsKey = '';
const artDbKey = () => storageKey + ':art';

// Custom halftone pictures (David, 2026-10-08): one optional picture per
// scene - Home's banner and the chat's figure/sky - stored the same way as
// the Image background (IndexedDB, device-local), each under its own key so
// replacing one never touches the others. `halftoneUrl` holds the live
// object URL for a slot with a picture (null falls back to the Kairos one);
// `halftoneRevision` only moves forward, so a loader call started before a
// replace or reset can tell it's stale and drop its result.
const HALFTONE_SLOTS = ['home', 'figure', 'sky'];
const HALFTONE_DEFAULT_SRC = { home: '/static/img/home-figure.webp', figure: '/static/img/home-figure.webp', sky: '/static/img/kairos-sky.jpg' };
let halftoneUrl = { home: null, figure: null, sky: null };
let halftoneRevision = { home: 0, figure: 0, sky: 0 };
const halftoneDbKey = (slot) => storageKey + ':halftone:' + slot;

function normalizeHalftoneSlot(raw) {
  const focusX = typeof raw?.focusX === 'number' && Number.isFinite(raw.focusX) ? Math.max(0, Math.min(1, raw.focusX)) : 0.5;
  const focusY = typeof raw?.focusY === 'number' && Number.isFinite(raw.focusY) ? Math.max(0, Math.min(1, raw.focusY)) : 0.5;
  const hash = typeof raw?.hash === 'string' && /^[0-9a-f]{0,64}$/.test(raw.hash) ? raw.hash : '';
  return { focusX, focusY, hash };
}
function normalize(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const value = { ...DEFAULTS };
  if (['default', 'color', 'image', 'shader', 'glass', 'animated'].includes(raw.mode)) value.mode = raw.mode;
  // Animated art was once a background effect; it is now a background style of its own.
  if (raw.backgroundEffect === 'animated' && ['default', 'color', undefined].includes(raw.mode)) value.mode = 'animated';
  if (/^#[\da-f]{6}$/i.test(raw.color)) value.color = raw.color;
  for (const key of ['tint', 'distortion', 'swirl', 'grainMixer', 'grainOverlay']) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) value[key] = Math.max(0, Math.min(1, raw[key]));
  }
  if (PICTURE_EFFECTS.includes(raw.backgroundEffect)) value.backgroundEffect = raw.backgroundEffect;
  value.effectOptions = normalizeEffectOptions(raw.effectOptions);
  // Any vendored piece, or your own animation. Scatter is gone; it falls back to the default piece.
  if (raw.animatedPiece === OWN_ART || isArtPiece(raw.animatedPiece)) value.animatedPiece = raw.animatedPiece;
  // The colours last taken from the art, kept so the theme is right before the art loads.
  if (/^#[\da-f]{6}$/i.test(raw.artBase)) value.artBase = raw.artBase;
  value.artAccent = /^#[\da-f]{6}$/i.test(raw.artAccent) ? raw.artAccent : '';
  if (typeof raw.artPanels === 'number' && Number.isFinite(raw.artPanels)) value.artPanels = Math.max(0, Math.min(1, raw.artPanels));
  // The look starts as made; the earlier animatedLook drew the art in looks of its own and is dropped.
  if (ART_LOOKS.some(([id]) => id === raw.artLook)) value.artLook = raw.artLook;
  // Chat messages (desktop redesign): plain text on the backdrop, or the bubble cards.
  if (['plain', 'cards'].includes(raw.chatMessages)) value.chatMessages = raw.chatMessages;
  if (Object.hasOwn(GLASS_WALLPAPERS, raw.glassWallpaper || '')) value.glassWallpaper = raw.glassWallpaper;
  if (typeof raw.glassDesktop === 'boolean') value.glassDesktop = raw.glassDesktop;
  for (const key of ['glassStrength', 'glassDither', 'glassWindow']) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) value[key] = Math.max(0, Math.min(1, raw[key]));
  }
  if (typeof raw.motion === 'boolean') value.motion = raw.motion;
  if (typeof raw.halftone === 'boolean') value.halftone = raw.halftone;
  // Kip style (David, 2026-10-25): flat, halftone, pixel or hidden. Hidden is
  // the old Show Kip switch off: it brings back the plain markers and the
  // mark (mascot.css, data-mascot). `mascot` stays the derived on/off.
  value.kip = kipStyleOf(raw);
  value.mascot = value.kip !== 'hidden';
  // Legacy look preferences are intentionally omitted; every account uses the redesign.
  // Terminal chat style (David's ask 2026-09-25): chats look and read like a
  // terminal harness. Presentation only; see the [data-chat-style] rules.
  if (['standard', 'terminal'].includes(raw.chatStyle)) value.chatStyle = raw.chatStyle;
  // Per-slot focus point (default centre) and a content hash, so two slots
  // that hold the same picture can be told apart from two that merely look
  // similar (chatBackdrop.js skips the dissolve when figure and sky match).
  value.halftoneImages = Object.fromEntries(HALFTONE_SLOTS.map((slot) => [slot, normalizeHalftoneSlot(raw.halftoneImages?.[slot])]));
  return value;
}
settings = normalize(DEFAULTS);
// A look laid over the saved one while a part of the app shows, never saved
// as the account's appearance (Browse's own look and Chameleon, David
// 2026-11-03). `saved` holds the account's settings while one is applied.
let overridePatch = null, saved = null;
const OVERRIDE_KEYS = ['mode', 'color', 'glassWallpaper', 'animatedPiece', 'artLook', 'artBase', 'artAccent'];
export function setAppearanceOverride(patch) {
  const clean = patch && typeof patch === 'object' ? Object.fromEntries(OVERRIDE_KEYS.filter(k => k in patch).map(k => [k, patch[k]])) : null;
  if (clean && Object.keys(clean).length) {
    if (!saved) saved = settings;
    overridePatch = clean;
    settings = normalize({ ...saved, ...clean });
  } else if (saved) {
    settings = saved; saved = null; overridePatch = null;
  } else return;
  apply();
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const css = values => `rgb(${values.map(Math.round).join(', ')})`;
const mix = (color, target, amount) => color.map(v => v * (1 - amount) + target * amount);
function luminance(color) {
  return color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};
// A status color moved toward the text color until it reads on the base.
function legible(status, base, text) {
  for (let amount = 0; amount <= 1; amount += .05) {
    const value = status.map((v, i) => Math.round(v * (1 - amount) + text[i] * amount));
    if (contrast(value, base) >= 4.5) return value;
  }
  return text;
}
function readable(color, fade = 0) {
  const foreground = luminance(color) > .179 ? 0 : 255;
  for (let amount = fade; amount >= 0; amount -= .02) {
    const text = color.map(v => Math.round(v * amount + foreground * (1 - amount)));
    const a = luminance(color), b = luminance(text);
    if ((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5) return text;
  }
  return [foreground, foreground, foreground];
}

// The halftone backgrounds (David, 2026-10-07): Home's card and the chat's
// figure and sky. Kairos draws them in the painting's own colors; Color
// draws them two-tone, the theme's ink on its base, so they suit any light
// or dark pick. Image and Shader bring their own background, so they don't
// offer it. null means the painting's colors.
export function halftonePalette() {
  if (settings.mode !== 'color') return null;
  const base = rgb(settings.color);
  // On a dark base the bright sky has to become the base, so the figure
  // reads light-on-dark; its ink is softened there so it stays a quiet
  // etching rather than a stark negative.
  const soften = luminance(base) > .179 ? 0 : .45;
  const ink = readable(base).map((v, i) => Math.round(v + (base[i] - v) * soften));
  return { ink, base };
}
const halftoneState = () => !['default', 'color'].includes(settings.mode) ? 'none' : settings.halftone ? 'on' : 'off';

// A slot's picture: the stored one (an object URL) or the Kairos default.
// `halftoneFocus` returns null for a default picture, so callers keep their
// own built-in anchor until a custom picture actually needs one.
export function halftoneSource(slot) { return halftoneUrl[slot] || HALFTONE_DEFAULT_SRC[slot]; }
export function halftoneFocus(slot) {
  if (!halftoneUrl[slot]) return null;
  const { focusX, focusY } = settings.halftoneImages[slot];
  return { x: focusX, y: focusY };
}
// Only moves forward on a replace or reset; dither.js folds it into its
// cache key so a new picture at the same slot always redraws.
export function halftoneVersion(slot) { return halftoneRevision[slot]; }
// True once figure and sky hold the identical picture (by content, not by
// slot), so chatBackdrop.js can skip the dissolve between them.
export function halftoneSharedChatPicture() {
  const { figure, sky } = settings.halftoneImages;
  return !!figure.hash && figure.hash === sky.hash;
}

export function appearanceName(value = getAppearance()) {
  const palette = { '#f3eadb': 'Parchment', '#e9e4da': 'Linen', '#a7aca5': 'Stone', '#533c32': 'Clay', '#3c2943': 'Plum', '#233447': 'Ocean', '#23302e': 'Forest', '#202127': 'Graphite', '#18130f': 'Espresso' };
  return value.mode === 'default' ? 'Parchment' : value.mode === 'color'
    ? palette[value.color?.toLowerCase()] || value.color : value.mode === 'glass' ? `Liquid glass, ${GLASS_WALLPAPERS[value.glassWallpaper].title}`
    : value.mode === 'animated' ? `Animated, ${value.animatedPiece === OWN_ART ? 'your own'
      : ART_CATALOG.find(([id]) => id === value.animatedPiece)?.[1]}`
    : { image: 'Image', shader: 'Flow' }[value.mode];
}

export function getAppearance() {
  return { ...settings, effectOptions: structuredClone(settings.effectOptions), hasImage: !!imageBitmap, storageIssue,
    hasArt: !!ownArt,
    staticFallback: settings.mode === 'shader' && glScene === false,
    halftoneSlots: Object.fromEntries(HALFTONE_SLOTS.map((slot) => [slot,
      { hasImage: !!halftoneUrl[slot], focusX: settings.halftoneImages[slot].focusX, focusY: settings.halftoneImages[slot].focusY }])) };
}
function imageStore(action, value, key = storageKey) {
  const operation = imageQueue.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('jarvis-appearance', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Image storage is busy. Close other Kairos windows and retry.'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('images', action === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('images');
      const op = action === 'put' ? store.put(value, key) : store[action](key);
      tx.oncomplete = () => { db.close(); resolve(op.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error('Image could not be saved.')); };
    };
  }));
  imageQueue = operation;
  return operation;
}

export async function initAppearance(username) {
  const revision = ++identityRevision;
  ++imageRevision;
  imageBitmap?.close(); imageBitmap = null; storageIssue = '';
  ++artRevision; dropOwnArt(); artColorsKey = '';
  for (const slot of HALFTONE_SLOTS) { if (halftoneUrl[slot]) URL.revokeObjectURL(halftoneUrl[slot]); halftoneUrl[slot] = null; ++halftoneRevision[slot]; }
  storageKey = 'jarvis:appearance:v1:' + String(username || 'local');
  try { settings = normalize(JSON.parse(localStorage.getItem(storageKey) || '{}')); }
  catch { settings = normalize(DEFAULTS); }
  if (overridePatch) { saved = settings; settings = normalize({ ...saved, ...overridePatch }); }
  // Persist normalized preferences so obsolete look flags migrate on load.
  try { localStorage.setItem(storageKey, JSON.stringify(saved || settings)); }
  catch { storageIssue = 'Preferences could not be saved on this device.'; }
  if (startupPatch) {
    const patch = startupPatch; startupPatch = null;
    updateAppearance(patch);
  }
  ensureCanvases();
  apply();
  try {
    const saved = await imageStore('get');
    if (saved instanceof Blob) {
      const bitmap = await createImageBitmap(saved);
      if (revision !== identityRevision) { bitmap.close(); return; }
      imageBitmap = bitmap;
    }
  } catch { if (revision === identityRevision) storageIssue = 'The saved image could not be loaded. Choose it again to retry.'; }
  try {
    const saved = await imageStore('get', undefined, artDbKey());
    if (revision !== identityRevision) return;
    if (saved instanceof Blob) ownArt = await openArt(saved);
  } catch { /* Animated falls back to Scatter until the file is chosen again */ }
  if (revision !== identityRevision) { dropOwnArt(); return; }
  for (const slot of HALFTONE_SLOTS) {
    try {
      const saved = await imageStore('get', undefined, halftoneDbKey(slot));
      if (revision !== identityRevision) return;
      if (saved instanceof Blob) halftoneUrl[slot] = URL.createObjectURL(saved);
    } catch { /* that slot keeps its default picture */ }
  }
  if (revision !== identityRevision) return;
  apply();
}

export function updateAppearance(patch) {
  // The old on/off Show Kip still works: on keeps the chosen look, off is hidden.
  if (typeof patch.mascot === 'boolean' && !('kip' in patch)) patch = { ...patch, kip: patch.mascot ? (settings.kip === 'hidden' ? DEFAULT_KIP_STYLE : settings.kip) : 'hidden' };
  if (!storageKey) startupPatch = { ...startupPatch, ...patch };
  // With a look laid over (Browse), a change goes to the saved settings and
  // the look stays on top.
  if (saved) { saved = normalize({ ...saved, ...patch }); settings = normalize({ ...saved, ...overridePatch }); }
  else settings = normalize({ ...settings, ...patch });
  storageIssue = '';
  try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(saved || settings)); }
  catch { storageIssue = 'Preview applied, but preferences could not be saved on this device.'; }
  apply();
}

// Signed-out screens use only the last device palette, never an account identity.
export function restoreWelcomeAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem('jarvis:welcome-appearance:v1') || '{}');
    settings = normalize({ ...(saved && typeof saved === 'object' ? saved : {}), ...startupPatch }); apply();
  } catch { settings = normalize({ ...DEFAULTS, ...startupPatch }); apply(); }
}

// Validate, decode and downsample a picture (shared by the Image background
// and the halftone slots): PNG/JPEG/WebP, up to 12 MB, long edge capped at
// 2560px, re-encoded to WebP. Never uploaded - the blob this returns only
// ever goes into this device's IndexedDB.
async function prepareImageBlob(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Choose an image smaller than 12 MB.');
  let decoded;
  try { decoded = await createImageBitmap(file); } catch { throw new Error('This image could not be opened. Try another image.'); }
  if (decoded.width * decoded.height > 40000000) { decoded.close(); throw new Error('Choose an image below 40 megapixels.'); }
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 2560 / Math.max(decoded.width, decoded.height));
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  canvas.getContext('2d').drawImage(decoded, 0, 0, canvas.width, canvas.height);
  decoded.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .88));
  if (!blob) throw new Error('This image could not be prepared.');
  return blob;
}
// A short content hash (not reversible), used only to tell whether two
// halftone slots hold the same picture.
async function hashBlob(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function setAppearanceImage(file) {
  const revision = ++imageRevision;
  const blob = await prepareImageBlob(file);
  if (revision !== imageRevision) return;
  // Saving first means a quota failure leaves the previous image intact.
  try { await imageStore('put', blob); } catch { throw new Error('Image could not be saved. Free some device storage and retry.'); }
  const next = await createImageBitmap(blob);
  if (revision !== imageRevision) { next.close(); return; }
  imageBitmap?.close(); imageBitmap = next;
  updateAppearance({ mode: 'image' });
}

export async function removeAppearanceImage() {
  ++imageRevision;
  await imageStore('delete');
  imageBitmap?.close(); imageBitmap = null;
  updateAppearance({ mode: settings.mode === 'image' ? 'color' : settings.mode });
}

export async function setHalftoneImage(slot, file) {
  if (!HALFTONE_SLOTS.includes(slot)) throw new Error('Unknown halftone slot.');
  const revision = ++halftoneRevision[slot];
  // Hashed from the original upload, not the downsampled/re-encoded blob:
  // two slots given the same picture should match even though re-encoding a
  // picture to WebP twice isn't guaranteed to produce identical bytes.
  const hash = await hashBlob(file);
  const blob = await prepareImageBlob(file);
  if (revision !== halftoneRevision[slot]) return;
  // Saving first means a quota failure leaves the previous picture intact.
  try { await imageStore('put', blob, halftoneDbKey(slot)); } catch { throw new Error('Image could not be saved. Free some device storage and retry.'); }
  if (revision !== halftoneRevision[slot]) return;
  if (halftoneUrl[slot]) URL.revokeObjectURL(halftoneUrl[slot]);
  halftoneUrl[slot] = URL.createObjectURL(blob);
  updateAppearance({ halftoneImages: { ...settings.halftoneImages, [slot]: { focusX: .5, focusY: .5, hash } } });
}

export async function removeHalftoneImage(slot) {
  if (!HALFTONE_SLOTS.includes(slot)) throw new Error('Unknown halftone slot.');
  ++halftoneRevision[slot];
  await imageStore('delete', undefined, halftoneDbKey(slot));
  if (halftoneUrl[slot]) URL.revokeObjectURL(halftoneUrl[slot]);
  halftoneUrl[slot] = null;
  updateAppearance({ halftoneImages: { ...settings.halftoneImages, [slot]: { focusX: .5, focusY: .5, hash: '' } } });
}

// Click-to-anchor on a slot's thumbnail (appearancePanel.js); a no-op
// without a custom picture there, since the default pictures keep their own
// built-in anchor.
export function setHalftoneFocus(slot, x, y) {
  if (!HALFTONE_SLOTS.includes(slot) || !halftoneUrl[slot]) return;
  const prev = settings.halftoneImages[slot];
  updateAppearance({ halftoneImages: { ...settings.halftoneImages, [slot]: { ...prev, focusX: Math.max(0, Math.min(1, x)), focusY: Math.max(0, Math.min(1, y)) } } });
}

// Your own animation for the Animated style: a GIF, animated WebP or PNG, or a short MP4 or WebM,
// up to 12 MB. It is kept exactly as chosen, so it plays as it is; only its colours are read.
const ART_TYPES = ['image/gif', 'image/webp', 'image/png', 'image/apng', 'video/mp4', 'video/webm'];
function dropOwnArt() {
  if (!ownArt) return;
  URL.revokeObjectURL(ownArt.url); ownArt.still?.close(); ownArt = null;
}
// Opens a stored or chosen file: its object URL, whether it is a video, a still first frame (for
// reduced motion) and a few frames to take its colours from.
async function openArt(blob) {
  const url = URL.createObjectURL(blob), video = blob.type.startsWith('video/');
  try {
    if (!video) {
      const still = await createImageBitmap(blob);
      return { url, video, still, frames: [still] };
    }
    const element = document.createElement('video');
    element.muted = true; element.preload = 'auto'; element.src = url;
    await new Promise((resolve, reject) => { element.onloadeddata = resolve; element.onerror = () => reject(new Error('decode')); });
    const frames = [];
    for (const at of [0, .33, .66]) {
      element.currentTime = Math.min(element.duration || 0, (element.duration || 0) * at);
      await new Promise(resolve => { element.onseeked = resolve; setTimeout(resolve, 1500); });
      frames.push(await createImageBitmap(element));
    }
    element.removeAttribute('src'); element.load();
    return { url, video, still: frames[0], frames };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}
export async function setAppearanceArt(file) {
  if (!ART_TYPES.includes(file.type)) throw new Error('Choose a GIF, WebP, PNG, MP4 or WebM file.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Choose a file smaller than 12 MB.');
  const revision = ++artRevision;
  let next;
  try { next = await openArt(file); } catch { throw new Error('This file could not be opened. Try another one.'); }
  if (revision !== artRevision) { URL.revokeObjectURL(next.url); return; }
  // Saving first means a quota failure leaves the previous animation intact.
  try { await imageStore('put', file, artDbKey()); } catch { URL.revokeObjectURL(next.url); throw new Error('This file could not be saved. Free some device storage and retry.'); }
  if (revision !== artRevision) { URL.revokeObjectURL(next.url); return; }
  dropOwnArt(); ownArt = next; artColorsKey = '';
  updateAppearance({ mode: 'animated', animatedPiece: OWN_ART });
}
export async function removeAppearanceArt() {
  ++artRevision;
  await imageStore('delete', undefined, artDbKey());
  dropOwnArt(); artColorsKey = '';
  updateAppearance({ animatedPiece: settings.animatedPiece === OWN_ART ? DEFAULT_ART_PIECE : settings.animatedPiece });
}
// Your own animation, for the art layer and the Appearance preview.
export function ownArtSource() { return ownArt && { url: ownArt.url, video: ownArt.video, still: ownArt.still }; }

// Works out the art's colours once per piece (or file) and keeps them with the settings; the
// theme updates when they differ from the ones it was drawn with.
async function refreshArtColors() {
  const piece = settings.animatedPiece === OWN_ART && !ownArt ? DEFAULT_ART_PIECE : settings.animatedPiece;
  const key = piece === OWN_ART ? `${OWN_ART}:${ownArt.url}` : piece;
  if (settings.mode !== 'animated' || key === artColorsKey) return;
  artColorsKey = key;
  let colors = null;
  try {
    if (piece === OWN_ART) colors = pictureColors(ownArt.frames);
    else colors = pieceColors(await loadArtPiece(piece));
  } catch { /* the last colours stay */ }
  if (!colors || key !== artColorsKey) return;
  if (colors.base === settings.artBase && (colors.accent || '') === settings.artAccent) return;
  // Art chosen by a look laid over the saved one (Browse) keeps its colours
  // in that look, not in the account's appearance.
  if (saved && overridePatch && 'animatedPiece' in overridePatch) setAppearanceOverride({ ...overridePatch, artBase: colors.base, artAccent: colors.accent || '' });
  else updateAppearance({ artBase: colors.base, artAccent: colors.accent || '' });
}

export async function resetAppearance() {
  await removeAppearanceArt();
  await removeAppearanceImage();
  for (const slot of HALFTONE_SLOTS) await removeHalftoneImage(slot);
  updateAppearance(DEFAULTS);
}
export function setAppearancePreview(canvas) { previewCanvas = canvas; draw(); }

function ensureCanvases() {
  if (imageCanvas) return;
  imageCanvas = document.createElement('canvas');
  shaderCanvas = document.createElement('canvas');
  for (const canvas of [imageCanvas, shaderCanvas]) {
    canvas.className = 'app-background'; canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
  }
  shaderCanvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); glScene = false; apply();
  });
  shaderCanvas.addEventListener('webglcontextrestored', () => { glScene = undefined; apply(); });
  window.addEventListener('resize', draw);
  document.addEventListener('visibilitychange', animate);
  motionQuery.addEventListener('change', () => { draw(); animate(); if (settings.mode === 'animated') syncArt(document.documentElement); });
}

function apply() {
  ensureCanvases();
  const root = document.documentElement;
  root.dataset.appearance = settings.mode;
  root.dataset.chatStyle = settings.chatStyle;
  root.dataset.halftone = halftoneState();  // on | off | none (style.css, app.js)
  root.dataset.mascot = settings.mascot ? 'on' : 'off';
  root.dataset.kip = settings.kip;
  root.dataset.chatMessages = settings.chatMessages;
  syncRedesign(root);
  syncGlass(root);
  syncArt(root);
  // The signed-out screens follow the account's own look, never one laid over it.
  const own = saved || settings;
  try { localStorage.setItem('jarvis:welcome-appearance:v1', JSON.stringify({ mode: own.mode === 'color' ? 'color' : 'default', color: own.color, halftone: own.halftone, backgroundEffect: own.backgroundEffect, effectOptions: own.effectOptions, animatedPiece: own.animatedPiece })); } catch { /* Appearance still works without storage. */ }
  if (settings.mode === 'default') {
    TOKENS.forEach(key => root.style.removeProperty(key));
    root.style.removeProperty('color-scheme');
  } else {
    const art = settings.mode === 'animated';
    const color = rgb(settings.mode === 'glass' ? GLASS_WALLPAPERS[settings.glassWallpaper].base : art ? settings.artBase : settings.color), light = luminance(color) > .179;
    const sidebar = mix(color, 0, .18).map(Math.round);
    const text = readable(color), status = STATUS[light ? 'light' : 'dark'];
    // Animated takes its accent from the art, moved toward the text colour until it reads.
    const artAccent = art && settings.artAccent ? rgb(settings.artAccent) : null;
    const accent = artAccent ? legible(artAccent, color, text) : readable(color, .12);
    const values = {
      '--bg': css(color), '--sidebar-bg': css(sidebar),
      '--sidebar-text': css(readable(sidebar)), '--sidebar-muted': css(readable(sidebar, .28)),
      '--sidebar-accent': css(artAccent ? legible(artAccent, sidebar, readable(sidebar)) : readable(sidebar, .12)),
      '--bg-panel': css(mix(color, light ? 255 : 0, light ? .24 : .16)),
      '--bg-panel-solid': css(mix(color, light ? 255 : 0, light ? .4 : .25)),
      '--surface-2': css(mix(color, light ? 0 : 255, light ? .08 : .1)),
      '--text': css(readable(color)),
      '--text-dim': css(readable(color, .22)),
      '--text-faint': css(readable(color, .35)),
      '--border': light ? 'rgba(0,0,0,.13)' : 'rgba(255,255,255,.12)',
      '--border-strong': light ? 'rgba(0,0,0,.25)' : 'rgba(255,255,255,.25)',
      '--accent': css(accent), '--accent-rgb': accent.join(', '),
      '--ink-rgb': light ? text.join(', ') : '255, 255, 255',
      '--shade-rgb': light ? text.join(', ') : '0, 0, 0',
      '--scrim': light ? `rgba(${text.join(', ')}, .28)` : 'rgba(0, 0, 0, .55)',
      '--wash-rgb': color.join(', '),  // the halftone washes, in the base color
    };
    for (const [name, wanted] of Object.entries(status)) {
      const value = legible(wanted, color, text);
      values[`--${name}`] = css(value); values[`--${name}-rgb`] = value.join(', ');
    }
    if (art) {
      // Every card and pane lets the art through, as solid as Show art through panels asks.
      const alpha = Math.round((.94 - settings.artPanels * .6) * 100) / 100;
      values['--bg-panel'] = `rgba(${mix(color, light ? 255 : 0, light ? .24 : .16).map(Math.round).join(', ')}, ${alpha})`;
      values['--bg-panel-solid'] = `rgba(${mix(color, light ? 255 : 0, light ? .4 : .25).map(Math.round).join(', ')}, ${Math.min(.96, alpha + .08)})`;
    }
    for (const [key, value] of Object.entries(values)) root.style.setProperty(key, value);
    root.style.colorScheme = light ? 'light' : 'dark';
  }
  if (settings.mode === 'shader' && glScene === undefined) glScene = createShader();
  draw(); animate();
  syncTitleBar();
  // The halftone backgrounds redraw in the new colors (chatBackdrop.js, home.js).
  document.dispatchEvent(new CustomEvent('kairos:appearance'));
}

// Liquid glass: the wallpaper's blooms, how see-through the surfaces are and
// how strong its dither grain is, as custom properties appearance.css reads.
const GLASS_PROPS = ['--glass-bloom-1', '--glass-bloom-2', '--glass-bloom-3', '--glass-alpha', '--glass-dither', '--glass-grain', '--glass-window'];
let glassGrain = '';
// The desktop app can let the real desktop show through the window in Liquid glass (David,
// 2026-10-28): Windows 11's acrylic behind a page that goes partly transparent (electron/main.js).
export const canSeeThroughWindow = () => typeof window.jarvis?.setSeeThrough === 'function';
let seeThrough = false;
function syncSeeThrough(root, on) {
  root.dataset.glassDesktop = on ? 'on' : 'off';
  if (on !== seeThrough && canSeeThroughWindow()) window.jarvis.setSeeThrough(on);
  seeThrough = on;
}
function syncGlass(root) {
  syncSeeThrough(root, settings.mode === 'glass' && settings.glassDesktop && canSeeThroughWindow());
  if (settings.mode !== 'glass') { GLASS_PROPS.forEach(key => root.style.removeProperty(key)); document.getElementById('app-glass')?.remove(); return; }
  // How much of the wallpaper stays over the desktop: 0 keeps it all, 1 leaves a light veil.
  root.style.setProperty('--glass-window', String(Math.round((1 - settings.glassWindow * .85) * 100) / 100));
  const paper = GLASS_WALLPAPERS[settings.glassWallpaper];
  paper.blooms.forEach((hex, i) => root.style.setProperty(`--glass-bloom-${i + 1}`, hex));
  // Strength 0 is nearly solid, 1 nearly clear.
  root.style.setProperty('--glass-alpha', String(Math.round((.92 - settings.glassStrength * .62) * 100) / 100));
  root.style.setProperty('--glass-dither', String(settings.glassDither));
  if (!glassGrain) {
    // A 4x4 Bayer threshold tile, drawn once: the grain laid over the blooms.
    const tile = document.createElement('canvas'); tile.width = tile.height = 4;
    const g = tile.getContext('2d'), bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    bayer.forEach((v, i) => { g.fillStyle = `rgba(0,0,0,${(v / 16) * .5})`; g.fillRect(i % 4, Math.floor(i / 4), 1, 1); });
    glassGrain = `url("${tile.toDataURL()}")`;
  }
  root.style.setProperty('--glass-grain', glassGrain);
  if (!document.getElementById('app-glass')) {
    const layer = document.createElement('div');
    layer.id = 'app-glass'; layer.className = 'app-glass'; layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = '<span class="app-glass-bloom"></span><span class="app-glass-bloom"></span><span class="app-glass-bloom"></span><span class="app-glass-grain"></span>';
    document.body.prepend(layer);
  }
}

// Animated: the art behind the whole window (#app-art). A piece is drawn unchanged by ASCII
// Magic's own player (artPlayer.js); your own animation plays as an image or a muted looping
// video. Either holds its first frame when motion is off. --art-alpha is how solid the panels
// over it are.
let artLayer = null;
function syncArt(root) {
  if (settings.mode !== 'animated') {
    root.style.removeProperty('--art-alpha'); root.style.removeProperty('--art-stage');
    if (artLayer) { artLayer.dispose(); artLayer.node.remove(); artLayer = null; }
    return;
  }
  root.style.setProperty('--art-alpha', String(Math.round((.94 - settings.artPanels * .6) * 100) / 100));
  // The stage a piece is shown on: ASCII Magic's own black, so the art looks as it does there.
  root.style.setProperty('--art-stage', '#000');
  const own = settings.animatedPiece === OWN_ART && ownArt;
  const still = !settings.effectOptions.animated.motion || motionQuery.matches;
  const piece = settings.animatedPiece === OWN_ART ? DEFAULT_ART_PIECE : settings.animatedPiece;
  const kind = own ? `${own.url}:${still ? 'still' : 'play'}` : `${piece}:${settings.artLook}:${still ? 'still' : 'play'}`;
  if (artLayer?.kind !== kind || !artLayer.node.isConnected) {
    if (artLayer) { artLayer.dispose(); artLayer.node.remove(); }
    const node = document.createElement('div');
    node.id = 'app-art'; node.className = 'app-art'; node.setAttribute('aria-hidden', 'true');
    document.body.prepend(node);
    let dispose = () => {};
    if (!own) dispose = mountArt(node, { piece, look: settings.artLook, still });
    else if (still) {
      const canvas = document.createElement('canvas'); canvas.className = 'art-still';
      canvas.width = own.still.width; canvas.height = own.still.height;
      canvas.getContext('2d').drawImage(own.still, 0, 0); node.append(canvas);
    } else if (own.video) {
      const video = Object.assign(document.createElement('video'), { src: own.url, muted: true, loop: true, autoplay: true, playsInline: true });
      video.setAttribute('muted', ''); node.append(video);
      const visibility = () => { if (document.hidden) video.pause(); else video.play().catch(() => {}); };
      document.addEventListener('visibilitychange', visibility);
      dispose = () => document.removeEventListener('visibilitychange', visibility);
    } else node.append(Object.assign(document.createElement('img'), { src: own.url, alt: '' }));
    artLayer = { node, kind, dispose };
  }
  refreshArtColors();
}

// The shared redesign backdrop reuses the chat scene renderer and palette.
let redesignBackdrop = null;
function syncRedesign(root) {
  root.classList.add('kairos-redesign');
  const content = document.getElementById('content');
  if (!content || redesignBackdrop?.host.isConnected) return;
  const host = document.createElement('div');
  host.className = 'kairos-redesign-backdrop';
  host.setAttribute('aria-hidden', 'true');
  content.prepend(host);
  redesignBackdrop = { host, dispose() {} };
  import('./chatBackdrop.js').then(({ mountChatBackdrop }) => {
    if (!host.isConnected) return;  // replaced while loading
    const mounted = mountChatBackdrop(host);
    redesignBackdrop = { host, dispose: mounted.dispose };
    // No scene dissolve here; the engine owns the selected effect's motion.
    mounted.show('sky');
  }).catch(() => { /* the parchment stays */ });
}

// The desktop window's own controls (electron/preload.js setTitleBar).
function syncTitleBar() {
  if (!window.jarvis?.setTitleBar) return;
  const probe = document.createElement('span');
  document.body.append(probe);
  const hex = name => {
    probe.style.color = `var(${name})`;
    const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g).map(Number);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  };
  // The title bar's own colour: the controls sit inside it (style.css .titlebar).
  const colors = [hex('--sidebar-bg'), hex('--text-dim')];
  probe.remove();
  window.jarvis.setTitleBar(...colors);
}

const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function fit(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
}
function cover(ctx, image, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  ctx.drawImage(image, (width - image.width * scale) / 2, (height - image.height * scale) / 2, image.width * scale, image.height * scale);
}
function draw() {
  if (!imageCanvas) return;
  // Limit the full-screen shader's pixel budget. Controls remain responsive
  // on integrated graphics and high-DPI displays.
  const scale = Math.min(1, 1280 / Math.max(innerWidth, innerHeight));
  const width = Math.max(1, Math.round(innerWidth * scale)), height = Math.max(1, Math.round(innerHeight * scale));
  const isShader = settings.mode === 'shader' && !!glScene;
  // Liquid glass draws its own wallpaper (#app-glass), so neither canvas shows.
  imageCanvas.hidden = ['default', 'glass', 'animated'].includes(settings.mode) || isShader;
  shaderCanvas.hidden = !isShader;
  fit(imageCanvas, width, height);
  if (isShader) {
    fit(shaderCanvas, width, height);
    glScene.draw(width, height, motionQuery.matches ? 0 : time, settings);
  } else {
    const ctx = imageCanvas.getContext('2d');
    ctx.fillStyle = settings.mode === 'default' ? token('--bg') : settings.mode === 'animated' ? settings.artBase : settings.color;
    ctx.fillRect(0, 0, width, height);
    if (settings.mode === 'image' && imageBitmap) {
      cover(ctx, imageBitmap, width, height);
      ctx.globalAlpha = settings.tint; ctx.fillStyle = settings.color;
      ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;
    } else if (settings.mode === 'shader') {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, settings.color); gradient.addColorStop(.5, css(mix(rgb(settings.color), 255, .18)));
      gradient.addColorStop(1, settings.color); ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    }
  }
  if (previewCanvas?.isConnected) {
    const ctx = previewCanvas.getContext('2d');
    ctx.drawImage(isShader ? shaderCanvas : imageCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
    ctx.fillStyle = ['default', 'animated'].includes(settings.mode) ? token('--sidebar-bg') : css(mix(rgb(settings.color), 0, .18));
    ctx.fillRect(0, 0, previewCanvas.width * .16, previewCanvas.height);
  } else previewCanvas = null;
}
function animate() {
  cancelAnimationFrame(animation); animation = 0; lastFrame = 0;
  if (settings.mode !== 'shader' || !glScene || !settings.motion || motionQuery.matches || document.hidden) return;
  function frame(now) {
    if (!lastFrame || now - lastFrame >= 40) {
      time += lastFrame ? Math.min((now - lastFrame) / 1000, .1) : 0;
      lastFrame = now; draw();
    }
    animation = requestAnimationFrame(frame);
  }
  animation = requestAnimationFrame(frame);
}

function createShader() {
  const gl = shaderCanvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
  if (!gl) return false;
  let program, buffer;
  const shaders = [];
  try {
    const compile = (kind, source) => {
      const shader = gl.createShader(kind); shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
      precision highp float;
      uniform vec2 resolution; uniform vec3 base;
      uniform float clock, distortion, swirl, mixer, grain, lightBase;
      float noise(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      void main(){
        vec2 p=(gl_FragCoord.xy-.5*resolution)/resolution.y;
        float angle=swirl*7.*exp(-length(p)*1.3)+clock*.045;
        p=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*p;
        p+=distortion*.4*vec2(sin(p.y*5.+clock*.12),cos(p.x*4.-clock*.1));
        float band=.5+.5*sin(p.x*4.+p.y*2.+sin(p.y*3.)+clock*.1);
        band=mix(band,noise(floor(p*180.)),mixer*.55);
        vec3 shade=mix(base*.96,mix(base,vec3(.227,.165,.125),.06),lightBase);
        vec3 lift=mix(mix(base,vec3(1.),.22),mix(base,vec3(.851,.698,.376),.12),lightBase);
        vec3 color=mix(shade,lift,smoothstep(.15,.9,band));
        color+=(noise(gl_FragCoord.xy)-.5)*grain*.16;
        gl_FragColor=vec4(clamp(color,0.,1.),1.);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    shaders.forEach(shader => gl.deleteShader(shader)); shaders.length = 0;
    buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = Object.fromEntries(['resolution', 'base', 'clock', 'distortion', 'swirl', 'mixer', 'grain', 'lightBase'].map(key => [key, gl.getUniformLocation(program, key)]));
    return { draw(width, height, elapsed, prefs) {
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uniforms.resolution, width, height);
      const base = rgb(prefs.color);
      gl.uniform3fv(uniforms.base, base.map(v => v / 255));
      gl.uniform1f(uniforms.lightBase, luminance(base) > .179 ? 1 : 0);
      gl.uniform1f(uniforms.clock, elapsed);
      gl.uniform1f(uniforms.distortion, prefs.distortion); gl.uniform1f(uniforms.swirl, prefs.swirl);
      gl.uniform1f(uniforms.mixer, prefs.grainMixer); gl.uniform1f(uniforms.grain, prefs.grainOverlay);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    } };
  } catch {
    shaders.forEach(shader => gl.deleteShader(shader));
    if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program);
    return false;
  }
}

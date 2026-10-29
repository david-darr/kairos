// Every bot's face is its own Kip (Kairos Mascot build spec, 2026-10-22; David:
// every bot switches to Kip right away and the dot-face picker is removed).
// A bot's look is one of the six agent pastels, a shape and one accessory;
// the gold point, the bite and the eyes are Kairos's and never change.
//
// Faces in lists stay static, cached SVG data URLs (mascotUrl): the
// 2026-10-14 lesson still holds, a roster of live SVGs or filtered images
// made ui-smoke flaky, and a static image has no per-instance canvas or
// observer, so rosters stay cheap to poll. Live movement is <kairos-mascot>
// (mascot.js), used only where a state changes.
import { AJAR_ACCESSORIES, AJAR_ACCESSORY_NAMES, AJAR_COLORS, AJAR_COLOR_NAMES, AJAR_SHAPES,
  createMascot, defaultMascot, mascotUrl, rememberBot, toAjarSpec } from './mascot.js';
import { loadBotsCss } from './botsUi.js';

export function defaultAvatar(id, color) { return defaultMascot(id, color); }
// Any stored spec, v2 dot face or v3 Ajar, as a clean Ajar spec.
export function avatarSpec(agent) { return toAjarSpec(agent?.avatar, { id: agent?.id, color: agent?.color }); }
export function avatarUrl(spec, pose = 'idle') { return mascotUrl(spec, pose); }

// -- an uploaded picture beside the Kip (Phase 1, unit U2) --------------------------------------
// A bot may carry avatar_image {asset_id, shape, zoom, focus_x, focus_y}: a picture owned by the bot
// (services/bot_avatar_service.py), drawn in a circle, a rounded square, a square or the Kip's own
// silhouette. The Kip spec is untouched, so clearing the picture brings the same Kip back.
export const IMAGE_SHAPES = Object.freeze(['circle', 'rounded', 'square', 'kip']);
const ASSET_ID = /^[0-9a-f]{32}$/;
const clampTo = (value, low, high, fallback) => (Number.isFinite(Number(value)) ? Math.min(high, Math.max(low, Number(value))) : fallback);
// A saved or drafted framing as a safe one: a known shape, zoom 1 to 3, focus 0 to 1.
export function cleanFraming(image) {
  if (!image || typeof image !== 'object' || !ASSET_ID.test(String(image.asset_id || ''))) return null;
  return { asset_id: image.asset_id, shape: IMAGE_SHAPES.includes(image.shape) ? image.shape : 'circle',
    zoom: clampTo(image.zoom, 1, 3, 1), focus_x: clampTo(image.focus_x, 0, 1, 0.5), focus_y: clampTo(image.focus_y, 0, 1, 0.5) };
}
// Where the picture is fetched from: the bot's own folder, or the signed-in person's draft folder
// (a bot that is not made yet; the framing then carries draft: true).
export function avatarImageUrl(agent) {
  const image = cleanFraming(agent?.avatar_image);
  if (!image) return '';
  if (agent.avatar_image.draft) return `/api/agents/avatar-drafts/${image.asset_id}`;
  return agent.id ? `/api/agents/${encodeURIComponent(agent.id)}/avatar-image/${image.asset_id}` : '';
}
// The crop as CSS for the <img>: the picture fills the box, is scaled around the focus point.
export function framingStyle(image) {
  const f = cleanFraming(image) || { zoom: 1, focus_x: 0.5, focus_y: 0.5 };
  const origin = `${(f.focus_x * 100).toFixed(1)}% ${(f.focus_y * 100).toFixed(1)}%`;
  return { objectFit: 'cover', objectPosition: origin, transformOrigin: origin, transform: `scale(${f.zoom})` };
}

function pictureNode(agent, size, spec, pose) {
  const image = cleanFraming(agent.avatar_image), src = avatarImageUrl(agent);
  if (!image || !src) return null;
  loadBotsCss('/static/css/bots-avatar.css');
  const node = document.createElement('span');
  node.className = 'agent-avatar agent-dot-avatar agent-mascot agent-avatar-picture';
  node.style.width = `${size}px`; node.style.height = `${size}px`;
  node.dataset.avatarSpec = JSON.stringify(spec); node.dataset.pose = pose;
  node.dataset.shape = image.shape; node.dataset.avatarImage = image.asset_id;
  node.setAttribute('aria-hidden', 'true');
  if (image.shape === 'kip') node.style.setProperty('--avatar-mask', `url("${mascotUrl(spec, pose)}")`);
  const picture = document.createElement('img');
  picture.alt = ''; picture.decoding = 'async'; picture.src = src;
  Object.assign(picture.style, framingStyle(image));
  // A picture that will not load (deleted, offline) falls back to the bot's Kip, never a broken box.
  picture.addEventListener('error', () => {
    node.classList.remove('agent-avatar-picture'); delete node.dataset.shape; delete node.dataset.avatarImage;
    node.style.removeProperty('--avatar-mask');
    picture.removeAttribute('style'); picture.src = mascotUrl(spec, pose);
  }, { once: true });
  node.append(picture);
  return node;
}

export function agentAvatar(agent, size = 72, pose = 'idle') {
  rememberBot(agent);
  const spec = avatarSpec(agent);
  const withPicture = agent?.avatar_image ? pictureNode(agent, size, spec, pose) : null;
  if (withPicture) return withPicture;
  const node = document.createElement('span');
  // agent-dot-avatar stays as the layout hook every view already sizes by.
  node.className = 'agent-avatar agent-dot-avatar agent-mascot';
  node.style.width = `${size}px`; node.style.height = `${size}px`;
  node.dataset.avatarSpec = JSON.stringify(spec);
  node.dataset.pose = pose;
  node.setAttribute('aria-hidden', 'true');
  const image = document.createElement('img');
  image.src = mascotUrl(spec, pose); image.alt = ''; image.decoding = 'async';
  node.append(image);
  return node;
}

// A live face for the one place a bot's state changes in front of you: the
// open conversation's header. A text status sits beside it, so it is decorative.
export function liveAgentAvatar(agent, size = 42, state = 'idle') {
  rememberBot(agent);
  const node = document.createElement('span');
  node.className = 'agent-avatar agent-dot-avatar agent-mascot-live';
  node.style.width = `${size}px`; node.style.height = `${size}px`;
  node.dataset.avatarSpec = JSON.stringify(avatarSpec(agent));
  node.setAttribute('aria-hidden', 'true');
  node.append(createMascot({ agent, state, size }));
  return node;
}

// Static faces carry the colours of the theme they were drawn in; redraw the
// ones on screen when Appearance changes (mascotUrl caches per theme).
if (typeof document !== 'undefined') document.addEventListener('kairos:appearance', () => {
  for (const node of document.querySelectorAll('.agent-mascot[data-avatar-spec]')) {
    try {
      const url = mascotUrl(JSON.parse(node.dataset.avatarSpec), node.dataset.pose || 'idle');
      // A picture keeps its own image; only the Kip silhouette it may be cut to follows the theme.
      if (node.dataset.avatarImage) { if (node.dataset.shape === 'kip') node.style.setProperty('--avatar-mask', `url("${url}")`); }
      else node.firstElementChild.src = url;
    } catch { /* left as drawn */ }
  }
});

const choose = values => values[Math.floor(Math.random() * values.length)];

// One picker serves creation and profile editing. Its DOM stays mounted while
// polls arrive; setSpec only syncs untouched drafts (2026-10-14). Three
// choices: body colour, shape, one accessory. No sliders, no free colour.
export function avatarPicker(initial, onChange = () => {}) {
  let spec = toAjarSpec(initial), dirty = false;
  const root = document.createElement('div'); root.className = 'agent-avatar-picker agent-mascot-picker';
  const preview = document.createElement('div'); preview.className = 'agent-avatar-picker-preview';
  const controls = document.createElement('div'); controls.className = 'agent-avatar-picker-controls';
  const groups = new Map();
  const change = (key, value) => {
    spec = { ...spec, [key]: value };
    dirty = true; sync(); paint(true); onChange({ ...spec });
  };
  // 2026-10-14: roving radio focus gives each grid one Tab stop and arrow
  // navigation; thumbnails reuse mascotUrl's cached data URLs.
  const group = (key, title, values, label) => {
    const section = document.createElement('section'); section.className = `agent-avatar-choice agent-avatar-choice-${key}`;
    const heading = document.createElement('h4'); heading.textContent = title;
    const grid = document.createElement('div'); grid.className = `agent-avatar-options agent-avatar-options-${key === 'color' ? 'color' : 'faces'}`;
    grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', `Kip ${title.toLowerCase()}`);
    const buttons = values.map(value => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.value = value;
      button.className = 'agent-avatar-option'; button.setAttribute('role', 'radio'); button.setAttribute('aria-label', label(value));
      if (key === 'color') { button.classList.add('agent-avatar-swatch'); button.style.setProperty('--swatch', `var(--m-body-${value.slice(1).toLowerCase()})`); }
      else {
        const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; button.append(image);
        const text = document.createElement('span'); text.textContent = label(value); button.append(text);
      }
      button.addEventListener('click', () => change(key, value));
      grid.append(button); return button;
    });
    grid.addEventListener('keydown', event => {
      const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
      if (!direction && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length;
      buttons[next].focus(); change(key, buttons[next].dataset.value);
    });
    section.append(heading, grid); controls.append(section); groups.set(key, buttons);
  };
  group('color', 'Body', AJAR_COLORS, value => AJAR_COLOR_NAMES[value.slice(1).toLowerCase()] || value);
  group('shape', 'Shape', AJAR_SHAPES, value => value[0].toUpperCase() + value.slice(1));
  group('acc', 'Accessory', AJAR_ACCESSORIES, value => AJAR_ACCESSORY_NAMES[value]);
  const note = document.createElement('p'); note.className = 'meta agent-avatar-note';
  note.textContent = 'Every bot is a Kip. The gold point and the eyes stay the same on all of them.';
  const shuffle = document.createElement('button'); shuffle.type = 'button'; shuffle.className = 'btn agent-avatar-shuffle'; shuffle.textContent = 'Shuffle';
  shuffle.onclick = () => {
    let next;
    do next = { ...spec, color: choose(AJAR_COLORS), shape: choose(AJAR_SHAPES), acc: choose(AJAR_ACCESSORIES) };
    while (next.color === spec.color && next.shape === spec.shape && next.acc === spec.acc);
    spec = next; dirty = true; sync(); paint(false);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) preview.animate([
      { transform: 'rotate(-9deg) scale(.9)', opacity: .65 }, { transform: 'rotate(8deg) scale(1.06)', opacity: 1 },
      { transform: 'none', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
    onChange({ ...spec });
  };
  controls.append(note, shuffle); root.append(preview, controls);
  function sync() {
    for (const [key, buttons] of groups) for (const button of buttons) {
      const active = button.dataset.value === spec[key];
      button.setAttribute('aria-checked', String(active)); button.tabIndex = active ? 0 : -1;
      const image = button.querySelector('img');
      if (image) image.src = mascotUrl({ ...spec, [key]: button.dataset.value });
    }
  }
  function paint(animate = false) {
    preview.getAnimations().forEach(animation => animation.cancel());
    preview.replaceChildren(agentAvatar({ avatar: spec }, 176));
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) preview.animate([
      { transform: 'scale(.92)', opacity: .8 }, { transform: 'scale(1.035)', opacity: 1 },
      { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  sync(); paint();
  return { root, getSpec: () => ({ ...spec }), isDirty: () => dirty,
    setSpec(next) {
      const clean = toAjarSpec(next);
      if (dirty || root.contains(document.activeElement) || JSON.stringify(spec) === JSON.stringify(clean)) return;
      spec = clean; sync(); paint();
    },
    markSaved() { dirty = false; } };
}


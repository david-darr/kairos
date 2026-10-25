import { el } from '../api.js';
import { EFFECTS, ART_PIECES } from '../backgroundEffectPreferences.js';
import { mountBackgroundEffect } from '../backgroundEffects.js';
import { group, row, toggle, staggerEntrance } from '../settingsKit.js';
import { kipChoices } from '../kipPicker.js';
import { getAppearance, updateAppearance, setAppearanceImage, removeAppearanceImage,
  resetAppearance, setAppearancePreview, halftoneSource, setHalftoneImage, removeHalftoneImage, setHalftoneFocus } from '../appearance.js';

// The three halftone slots (Build spec, 2026-10-08): Home's banner and the
// chat's two scenes. Each is optional - an empty slot keeps the Kairos picture.
const HALFTONE_SLOTS = [
  ['home', 'Home', "Your dashboard's banner."],
  ['figure', 'New chat', 'The chat scene before any messages.'],
  ['sky', 'Conversation', 'The chat scene once a chat has messages.'],
];

export function renderAppearancePanel(content, _status, page) {
  const root = el('section', { class: 'appearance-panel' });
  const status = el('p', { class: 'appearance-status meta', role: 'status', 'aria-live': 'polite' });
  const preview = el('canvas', { width: '640', height: '280', 'aria-hidden': 'true' });
  const previewScene = el('div', { class: 'appearance-preview-scene', 'aria-hidden': 'true' });
  let previewSceneKey = '', stopPreviewScene = null;
  const previewFrame = el('div', { class: 'appearance-preview' }, [preview, previewScene,
    el('div', { class: 'appearance-preview-copy' }, [el('span', { text: 'KAIROS' }), el('strong', { text: 'Not more time. The right time.' })]),
    el('span', { class: 'appearance-preview-badge', text: 'Live preview' }),
  ]);
  const modeButtons = new Map();
  const modes = el('div', { class: 'appearance-modes', role: 'group', 'aria-label': 'Background style' });
  for (const [mode, title, subtitle] of [['default', 'Kairos', 'Parchment & bistre'], ['color', 'Color', 'A clean canvas'], ['image', 'Image', 'Your perspective'], ['shader', 'Flow', 'Color in motion']]) {
    const button = el('button', { type: 'button', class: 'appearance-mode', 'data-mode': mode, onclick: () => {
      updateAppearance({ mode }); sync();
    } }, [el('span', { class: `appearance-mode-art art-${mode}`, 'aria-hidden': 'true' }), el('strong', { text: title }), el('span', { text: subtitle })]);
    modeButtons.set(mode, button); modes.append(button);
  }
  // Chat style (David's ask 2026-09-25): Terminal reads like a terminal
  // harness - monospace, prompt lines instead of bubbles. Also /terminal.
  const styleButtons = new Map();
  const chatStyles = el('div', { class: 'appearance-chat-styles', role: 'group', 'aria-label': 'Chat style' });
  for (const [style, title, subtitle] of [['standard', 'Standard', 'Bubbles and prose'], ['terminal', 'Terminal', 'Monospace prompt lines']]) {
    const button = el('button', { type: 'button', class: 'appearance-chat-style', 'data-chat-style': style, onclick: () => {
      updateAppearance({ chatStyle: style }); sync();
    } }, [el('span', { class: `appearance-chat-art art-${style}`, 'aria-hidden': 'true', text: style === 'terminal' ? '❯ _' : 'Aa' }),
      el('strong', { text: title }), el('span', { text: subtitle })]);
    styleButtons.set(style, button); chatStyles.append(button);
  }
  // Kip style (David, 2026-10-25): flat, halftone, pixel or hidden.
  const kip = kipChoices();
  kip.node.id = 'appearance-kip';
  const mascotSection = el('div', { class: 'appearance-mascot-setting' }, [
    group({}, [row({ title: 'Kip', description: 'Kip, the Kairos mascot, on Home, in the chat while it works, on empty pages and in calls. Hidden shows the plain markers. Bots keep their faces.', below: kip.node, stack: true })]),
  ]);
  const chatStyleSection = el('section', { class: 'appearance-chat-style-setting' }, [
    el('h3', { text: 'Chat style' }), chatStyles,
    el('p', { class: 'meta', text: 'Terminal changes how chats look, not what Kairos can do. Type /terminal in a chat to switch.' }),
  ]);
  const color = el('input', { type: 'color', id: 'appearance-color', 'aria-label': 'Custom base color' });
  const hex = el('span', { class: 'appearance-color-value' });
  const swatches = el('div', { class: 'appearance-swatches', role: 'group', 'aria-label': 'Base colors' });
  for (const [name, value] of [['Parchment', '#f3eadb'], ['Linen', '#e9e4da'], ['Stone', '#a7aca5'], ['Clay', '#533c32'], ['Plum', '#3c2943'], ['Ocean', '#233447'], ['Forest', '#23302e'], ['Graphite', '#202127']]) {
    swatches.append(el('button', { type: 'button', title: name, 'aria-label': name, 'data-color': value,
      style: `--swatch:${value}`, onclick: () => { updateAppearance({ color: value }); sync(); } }));
  }
  color.addEventListener('input', () => { updateAppearance({ color: color.value }); sync(); });
  const palette = el('div', { class: 'appearance-palette' }, [
    el('label', { for: 'appearance-color', class: 'title', text: 'Base color' }),
    el('div', { class: 'appearance-color-row' }, [swatches, color, hex]),
    el('p', { class: 'meta', text: 'Your sidebar follows in a slightly darker shade.' }),
  ]);

  // Halftone (David, 2026-10-07): Kairos and Color only; Image and Shader
  // have their own background.
  const halftone = toggle({ label: 'Halftone backgrounds', onChange: (on) => { updateAppearance({ halftone: on }); sync(); } });
  halftone.id = 'appearance-halftone';
  // Custom halftone pictures (Build spec, 2026-10-08): one optional picture
  // per slot, stored device-local the same way as the Image background.
  // Clicking the thumbnail sets where it's anchored when cropped to the card.
  function halftoneCard(slot, title, description) {
    const thumb = el('img', { class: 'appearance-halftone-thumb', alt: '' });
    const focusBtn = el('button', { type: 'button', class: 'appearance-halftone-thumb-btn', 'aria-label': `Set the focus point for ${title}` }, [thumb]);
    focusBtn.addEventListener('click', (event) => {
      const box = focusBtn.getBoundingClientRect();
      const keyboard = !event.detail && !event.clientX && !event.clientY;
      setHalftoneFocus(slot, keyboard ? .5 : (event.clientX - box.left) / box.width, keyboard ? .5 : (event.clientY - box.top) / box.height);
      sync();
    });
    focusBtn.addEventListener('keydown', event => {
      const delta = { ArrowLeft: [-.05, 0], ArrowRight: [.05, 0], ArrowUp: [0, -.05], ArrowDown: [0, .05] }[event.key];
      if (!delta) return;
      event.preventDefault();
      const info = getAppearance().halftoneSlots[slot];
      setHalftoneFocus(slot, Math.max(0, Math.min(1, info.focusX + delta[0])), Math.max(0, Math.min(1, info.focusY + delta[1])));
      sync();
    });
    const upload = el('input', { type: 'file', id: `appearance-halftone-${slot}`, accept: 'image/png,image/jpeg,image/webp' });
    const uploadLabel = el('label', { for: upload.id, class: 'btn quiet', text: 'Replace' });
    const reset = el('button', { type: 'button', class: 'btn quiet', text: 'Reset', onclick: async () => {
      try { await removeHalftoneImage(slot); sync(); } catch { status.textContent = 'Picture could not be removed. Try again.'; }
    } });
    upload.addEventListener('change', async () => {
      const file = upload.files[0]; if (!file) return;
      upload.disabled = true; status.textContent = 'Preparing your picture…';
      try { await setHalftoneImage(slot, file); sync(); }
      catch (error) { status.textContent = error.message; }
      finally { upload.disabled = false; upload.value = ''; }
    });
    const card = el('div', { class: 'appearance-halftone-card' }, [
      focusBtn,
      el('div', { class: 'appearance-halftone-card-body' }, [
        el('strong', { text: title }), el('p', { class: 'meta', text: description }),
        el('div', { class: 'appearance-halftone-card-actions' }, [
          el('span', { class: 'appearance-halftone-replace' }, [uploadLabel, upload]), reset,
        ]),
      ]),
    ]);
    return { card, thumb, reset };
  }
  const halftoneCards = Object.fromEntries(HALFTONE_SLOTS.map(([slot, title, description]) => [slot, halftoneCard(slot, title, description)]));
  const halftoneSection = el('div', { class: 'appearance-halftone-setting' }, [
    group({}, [row({ title: 'Halftone backgrounds', description: "Home's card and the chat's figure and sky, drawn with your chosen background effect.", control: halftone })]),
    el('div', { class: 'appearance-halftone-grid' }, HALFTONE_SLOTS.map(([slot]) => halftoneCards[slot].card)),
    el('p', { class: 'meta', text: 'Replace any scene with your own picture. PNG, JPEG or WebP · Up to 12 MB · Stored only on this device.' }),
  ]);

  const effectChoices = new Map();
  const effectGrid = el('div', { class: 'appearance-effects-grid' });
  const effectTitles = ['Dithered', 'Halftone dots', 'ASCII', 'Numbers', 'Binary', 'Animated art'];
  for (const [index, effect] of EFFECTS.entries()) {
    const input = el('input', { type: 'radio', name: 'background-effect', value: effect,
      id: `appearance-effect-${effect}` });
    const thumb = el('span', { class: 'appearance-effect-thumb', 'aria-hidden': 'true' });
    input.addEventListener('change', () => { if (input.checked) { updateAppearance({ backgroundEffect: effect }); sync(); } });
    effectChoices.set(effect, { input, thumb });
    effectGrid.append(el('label', { class: 'appearance-effect-choice', for: input.id }, [
      thumb, el('span', { class: 'appearance-effect-label' }, [input, el('span', { text: effectTitles[index] })]),
    ]));
  }
  const piece = el('select', { id: 'appearance-art-piece' }, ART_PIECES.map(([value, text]) => el('option', { value, text })));
  piece.addEventListener('change', () => { updateAppearance({ animatedPiece: piece.value }); sync(); });
  const pieceRow = el('label', { class: 'appearance-effect-control', for: piece.id }, [el('span', { text: 'Animated piece' }), piece]);
  const density = el('input', { type: 'range', min: '3', max: '24', step: '1', id: 'appearance-effect-density' });
  const densityValue = el('output', { for: density.id });
  const densityRow = el('label', { class: 'appearance-effect-control', for: density.id }, [el('span', { text: 'Density (cell size)' }), density, densityValue]);
  const tint = el('select', { id: 'appearance-effect-tint' }, [
    el('option', { value: 'original', text: 'Original palette' }),
    el('option', { value: 'theme', text: 'Theme accent' }), el('option', { value: 'picture', text: 'Picture colours' }),
  ]);
  function saveEffect(patch) {
    const a = getAppearance(), key = a.backgroundEffect;
    updateAppearance({ effectOptions: { ...a.effectOptions, [key]: { ...a.effectOptions[key], ...patch } } }); sync();
  }
  density.addEventListener('input', () => saveEffect({ density: Number(density.value) }));
  tint.addEventListener('change', () => saveEffect({ tint: tint.value }));
  const effectMotion = toggle({ label: 'Animate effect', onChange: motion => saveEffect({ motion }) });
  const effectSection = el('fieldset', { class: 'appearance-effect-section', 'aria-describedby': 'appearance-effect-note' }, [
    el('legend', { text: 'Background effect' }), effectGrid, pieceRow,
    densityRow,
    el('label', { class: 'appearance-effect-control', for: tint.id }, [el('span', { text: 'Tint' }), tint]),
    group({}, [row({ title: 'Animate effect', description: 'Motion pauses when hidden. Reduced motion shows a still frame.', control: effectMotion })]),
    el('p', { class: 'meta', id: 'appearance-effect-note', text: 'Options are saved separately for each effect on this device. Smaller cells show more detail. Original palette preserves the existing dithered look. Dithered motion controls scene transitions. Halftone dots stay still.' }),
    el('p', { class: 'meta appearance-effect-credit' }, [el('span', { text: 'Credits: Animated art by ' }),
      el('a', { href: 'https://github.com/kailashsr38/ascii-magic-art', target: '_blank', rel: 'noopener noreferrer', text: 'ASCII Magic' }),
      el('span', { text: ' (MIT). Picture colours uses the art palette for animated pieces.' })]),
  ]);
  let effectPreviewSource = '', effectPreviewStops = [];

  const controls = new Map();
  function dial(key, title, description) {
    const output = el('output', { for: `appearance-${key}` });
    const input = el('input', { type: 'range', id: `appearance-${key}`, min: '0', max: '100', step: '1', 'aria-label': title });
    const knob = el('div', { class: 'appearance-knob' }, [el('span', { 'aria-hidden': 'true' }), input]);
    input.addEventListener('input', () => { updateAppearance({ [key]: Number(input.value) / 100 }); sync(); });
    let drag = null;
    input.addEventListener('pointerdown', event => {
      if (key === 'tint') return;
      if (event.button !== 0) return;
      event.preventDefault(); input.focus(); input.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, value: Number(input.value) };
    });
    input.addEventListener('pointermove', event => {
      if (!drag) return;
      input.value = String(Math.max(0, Math.min(100, drag.value + (event.clientX - drag.x) * .6 + (drag.y - event.clientY) * .6)));
      input.dispatchEvent(new Event('input'));
    });
    input.addEventListener('pointerup', () => { drag = null; });
    input.addEventListener('lostpointercapture', () => { drag = null; });
    input.addEventListener('pointercancel', () => { drag = null; });
    const card = el('div', { class: 'appearance-dial' }, [knob,
      el('div', {}, [el('label', { for: input.id, text: title }), el('p', { text: description })]), output]);
    controls.set(key, { input, output, knob });
    return card;
  }
  const upload = el('input', { type: 'file', id: 'appearance-image', accept: 'image/png,image/jpeg,image/webp' });
  const imageLabel = el('label', { for: upload.id, class: 'appearance-upload', text: 'Choose an image' });
  const remove = el('button', { type: 'button', class: 'btn quiet', text: 'Remove image', onclick: async () => {
    try { await removeAppearanceImage(); sync(); } catch { status.textContent = 'Image could not be removed. Try again.'; }
  } });
  upload.addEventListener('change', async () => {
    const file = upload.files[0]; if (!file) return;
    upload.disabled = true; status.textContent = 'Preparing your image…';
    try { await setAppearanceImage(file); sync(); }
    catch (error) { status.textContent = error.message; }
    finally { upload.disabled = false; upload.value = ''; }
  });
  const imageOptions = el('div', { class: 'appearance-image-options' }, [
    el('div', { class: 'appearance-upload-row' }, [imageLabel, upload, remove]),
    el('p', { class: 'meta', text: 'PNG, JPEG or WebP · Up to 12 MB · Stored only on this device' }),
    dial('tint', 'Tint', 'Blend your base color over the image.'),
  ]);
  const motion = el('input', { type: 'checkbox', id: 'appearance-motion' });
  motion.addEventListener('change', () => { updateAppearance({ motion: motion.checked }); sync(); });
  const shaderOptions = el('div', { class: 'appearance-shader-options' }, [
    el('div', { class: 'appearance-dials' }, [
      dial('distortion', 'Distortion', 'Bend the color field.'), dial('swirl', 'Swirl', 'Twist the flow.'),
      dial('grainMixer', 'Grain mixer', 'Break up the color blend.'), dial('grainOverlay', 'Grain overlay', 'Add a fine texture.'),
    ]), el('label', { class: 'appearance-motion', for: motion.id }, [motion, el('span', { text: 'Animate background' })]),
    el('p', { class: 'meta', text: 'Motion pauses in the background and follows your reduced-motion preference.' }),
  ]);
  const reset = el('button', { type: 'button', class: 'btn quiet', text: 'Reset appearance', onclick: async () => {
    try { await resetAppearance(); sync(); } catch { status.textContent = 'Appearance could not be reset. Try again.'; }
  } });
  const overlay = window.jarvis?.usageOverlay;
  const overlayToggle = toggle({ label: 'Show above other windows' });
  overlayToggle.id = 'usage-overlay-toggle';
  const overlayNote = el('span', { text: 'Kip, activity and Claude Code and Codex account limits at the screen edge. Hidden by default.' });
  // The notch's edge and fold (design from CodeNotch; see static/css/usage-overlay.css)
  const overlayEdge = el('select', { id: 'usage-overlay-edge' }, [
    el('option', { value: 'top-centre', text: 'Top centre (notch)' }), el('option', { value: 'right', text: 'Right edge' }), el('option', { value: 'left', text: 'Left edge' }),
    el('option', { value: 'top', text: 'Top edge' }), el('option', { value: 'bottom', text: 'Bottom edge' })]);
  const overlayDisplay = el('select', { id: 'usage-overlay-display' });
  // Where along the edge: 0 is the top (or left) end, 100 the bottom (or right).
  const overlayOffset = el('input', { type: 'range', id: 'usage-overlay-offset', min: '0', max: '100', step: '1', style: 'width:200px;' });
  const offsetLabel = el('span', { text: 'Position along the edge' });
  const overlayFold = toggle({ label: 'Fold to a sliver' });
  overlayFold.id = 'usage-overlay-fold';
  const overlaySection = el('div', { class: 'appearance-overlay-setting' }, [
    group({ title: 'The notch' }, [
      row({ title: 'Show above other windows', description: overlayNote, control: overlayToggle }),
      row({ title: 'Monitor', control: overlayDisplay }),
      row({ title: 'Screen edge', control: overlayEdge }),
      row({ title: offsetLabel, control: overlayOffset }),
      row({ title: 'Fold to a sliver', description: 'Until the pointer reaches it.', control: overlayFold }),
    ]),
  ]);
  if (overlay) {
    const syncOverlay = state => {
      overlayToggle.disabled = !state.supported;
      overlayToggle.checked = !!state.visible;
      overlayEdge.disabled = overlayFold.disabled = overlayDisplay.disabled = overlayOffset.disabled = !state.supported;
      overlayEdge.value = ['left', 'top', 'bottom', 'top-centre'].includes(state.edge) ? state.edge : 'right';
      overlayFold.checked = state.foldOnHover !== false;
      // The monitors present right now; a saved one that was unplugged reads as the main display
      const displays = Array.isArray(state.displays) ? state.displays : [];
      overlayDisplay.replaceChildren(el('option', { value: '', text: 'Main display' }),
        ...displays.map(d => el('option', { value: String(d.id), text: d.label })));
      overlayDisplay.value = displays.some(d => d.id === state.displayId) ? String(state.displayId) : '';
      if (document.activeElement !== overlayOffset) overlayOffset.value = String(Math.round((Number(state.offset) || 0) * 100));
      offsetLabel.textContent = (state.edge === 'top' || state.edge === 'bottom' || state.edge === 'top-centre') ? 'Position along the edge (left to right)' : 'Position along the edge (top to bottom)';
      if (!state.supported) overlayNote.textContent = 'The desktop overlay is currently available on Windows.';
    };
    overlay.state().then(syncOverlay).catch(() => { overlayNote.textContent = 'Overlay setting unavailable.'; });
    const unsubscribe = overlay.onState(syncOverlay);
    const observer = new MutationObserver(() => {
      if (!root.isConnected) { unsubscribe(); observer.disconnect(); }
    });
    observer.observe(content, { childList: true });
    overlayToggle.addEventListener('click', async () => {
      overlayToggle.disabled = true;
      try { syncOverlay(await overlay.setVisible(overlayToggle.checked)); }
      catch { overlayNote.textContent = 'Could not change the overlay. Try again.'; overlayToggle.disabled = false; }
    });
    const saveConfig = async (changes) => {
      try { syncOverlay(await overlay.setConfig(changes)); }
      catch { overlayNote.textContent = 'Could not change the overlay. Try again.'; }
    };
    overlayEdge.addEventListener('change', () => saveConfig({ edge: overlayEdge.value }));
    overlayDisplay.addEventListener('change', () => saveConfig({ displayId: overlayDisplay.value ? Number(overlayDisplay.value) : null }));
    // Moves live while dragging, saved as it goes: the notch follows the slider.
    overlayOffset.addEventListener('input', () => saveConfig({ offset: Number(overlayOffset.value) / 100 }));
    overlayFold.addEventListener('click', () => saveConfig({ foldOnHover: overlayFold.checked }));
  } else {
    overlayToggle.disabled = overlayEdge.disabled = overlayFold.disabled = overlayDisplay.disabled = overlayOffset.disabled = true;
    overlayNote.textContent = 'Open the Windows desktop app to use the overlay.';
  }
  // Inside Settings the page header carries the title and Reset; anywhere
  // else this keeps its own heading.
  if (page) page.actions([reset]);
  else root.append(el('div', { class: 'appearance-heading' }, [el('div', {}, [el('h2', { text: 'Appearance' }),
    el('p', { class: 'meta', text: 'A workspace that feels like yours.' })]), reset]));
  // Group related controls in rows that resize together.
  const modeSection = el('section', { class: 'appearance-background-setting' }, [
    el('h3', { class: 'rd-appearance-label', text: 'Background style' }), modes,
  ]);
  halftoneSection.prepend(el('h3', { class: 'rd-appearance-label', text: 'Halftone backgrounds' }));
  imageOptions.prepend(el('h3', { class: 'rd-appearance-label', text: 'Your image' }));
  shaderOptions.prepend(el('h3', { class: 'rd-appearance-label', text: 'Flow' }));
  for (const [heading, text] of [[palette.querySelector('.title'), 'Color'], [imageOptions.querySelector('h3'), 'Image'], [shaderOptions.querySelector('h3'), 'Flow']]) {
    heading.append(el('span', { class: 'rd-appearance-tag', text }));
  }
  const effectControls = el('div', { class: 'appearance-effect-controls' });
  effectSection.insertBefore(effectControls, pieceRow);
  effectControls.append(pieceRow, densityRow, tint.closest('label'), effectSection.querySelector('.set-section'));
  const characterSection = el('div', { class: 'appearance-character-setting' }, [
    el('h3', { class: 'rd-appearance-label', text: 'Kip' }), mascotSection,
  ]);
  const styleRow = el('div', { class: 'appearance-style-row' }, [palette, chatStyleSection]);
  root.append(previewFrame, modeSection, styleRow, halftoneSection, effectSection, imageOptions, shaderOptions, characterSection, overlaySection, status);
  for (const list of [modes, effectGrid, chatStyles, halftoneSection.querySelector('.appearance-halftone-grid')]) staggerEntrance(list);
  content.replaceChildren(root);
  function sync() {
    const value = getAppearance();
    for (const [mode, button] of modeButtons) button.setAttribute('aria-pressed', String(mode === value.mode));
    for (const [style, button] of styleButtons) button.setAttribute('aria-pressed', String(style === value.chatStyle));
    palette.hidden = value.mode === 'default'; imageOptions.hidden = value.mode !== 'image'; shaderOptions.hidden = value.mode !== 'shader';
    halftoneSection.hidden = !['default', 'color'].includes(value.mode); halftone.checked = value.halftone;
    kip.sync();
    effectSection.hidden = !['default', 'color'].includes(value.mode);
    for (const [effect, { input }] of effectChoices) input.checked = value.backgroundEffect === effect;
    const effectPrefs = value.effectOptions[value.backgroundEffect];
    density.value = effectPrefs.density; densityValue.textContent = `${effectPrefs.density} px`;
    tint.options[0].hidden = value.backgroundEffect !== 'dithered';
    tint.value = effectPrefs.tint; effectMotion.checked = effectPrefs.motion;
    piece.value = value.animatedPiece; pieceRow.hidden = value.backgroundEffect !== 'animated';
    const nextPreviewSource = halftoneSource('home');
    previewScene.hidden = !['default', 'color'].includes(value.mode) || !value.halftone;
    const homeFocus = value.halftoneSlots.home;
    const sceneKey = `${nextPreviewSource}:${homeFocus.focusX}:${homeFocus.focusY}`;
    if (sceneKey !== previewSceneKey) {
      stopPreviewScene?.(); previewSceneKey = sceneKey;
      stopPreviewScene = mountBackgroundEffect(previewScene, nextPreviewSource, { preview: true, focusX: homeFocus.focusX, focusY: homeFocus.focusY });
    }
    if (nextPreviewSource !== effectPreviewSource) {
      effectPreviewStops.forEach(stop => stop()); effectPreviewSource = nextPreviewSource;
      effectPreviewStops = [...effectChoices].map(([effect, { thumb }]) =>
        mountBackgroundEffect(thumb, nextPreviewSource, { effect, preview: true, focusX: .7, focusY: .4 }));
    }
    for (const [slot, { thumb, reset }] of Object.entries(halftoneCards)) {
      const info = value.halftoneSlots[slot];
      thumb.src = halftoneSource(slot);
      thumb.style.objectPosition = `${(info.focusX * 100).toFixed(2)}% ${(info.focusY * 100).toFixed(2)}%`;
      reset.hidden = !info.hasImage;
    }
    color.value = value.color; hex.textContent = value.color.toUpperCase();
    for (const button of swatches.children) button.setAttribute('aria-pressed', String(button.dataset.color === value.color));
    for (const [key, control] of controls) {
      const number = Math.round(value[key] * 100);
      control.input.value = number; control.output.textContent = number + '%';
      control.knob.style.setProperty('--dial-angle', `${-135 + number * 2.7}deg`);
      control.knob.style.setProperty('--dial-fill', `${number * 2.7}deg`);
    }
    motion.checked = value.motion;
    remove.hidden = !value.hasImage;
    imageLabel.textContent = value.hasImage ? 'Replace image' : 'Choose an image';
    status.textContent = value.storageIssue || (value.staticFallback ? 'Motion is unavailable on this device. A static gradient is active.' :
      value.mode === 'image' && !value.hasImage ? 'Choose an image to finish your background.' : 'Saved for this user on this device.');
    setAppearancePreview(preview);
  }
  sync();
}

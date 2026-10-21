// No SVG filters in these faces (2026-10-14). The first version blurred its
// shadow and generated plush texture with feTurbulence; browsers rasterize
// filtered SVG images per size and per instance, and a chat full of faces
// made ui-smoke fail at random (3 of 5 runs, 0 of 3 with the filters removed).
// A gradient shadow and a dot pattern draw the same look for almost nothing.
// 2026-10-14: Agent faces are original, cached SVG data URLs. A static image
// has no per-instance canvas or ResizeObserver, so rosters stay cheap to poll.
export const AVATAR_FORMS = ['round', 'pill', 'triangle', 'ears', 'cloud', 'heart', 'sprout', 'scallop', 'hexagon', 'diamond', 'robot', 'shield', 'star', 'bean', 'squircle'];
export const AVATAR_COLORS = ['#FA70AB', '#DD6ADC', '#A25BFF', '#4778FF', '#00B1FF', '#04BB9F', '#B6D80B', '#FFCC38', '#FF8066'];
export const AVATAR_FINISHES = ['matte', 'plush', 'glossy', 'ceramic'];
export const AVATAR_FACES = ['smile', 'content', 'curious', 'sleepy', 'wink'];
export const AVATAR_ACCESSORIES = ['none', 'bow', 'glasses', 'hat', 'headphones', 'flower'];
const cache = new Map();
const svgNS = 'http://www.w3.org/2000/svg';

function hashId(id) {
  let hash = 2166136261;
  for (const char of String(id || 'agent')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function defaultAvatar(id) {
  const seed = hashId(id);
  return { form: AVATAR_FORMS[seed % AVATAR_FORMS.length],
    color: AVATAR_COLORS[Math.floor(seed / 11) % AVATAR_COLORS.length], finish: 'matte',
    face: AVATAR_FACES[Math.floor(seed / 97) % AVATAR_FACES.length], accessory: 'none', version: 2, style: 'folded', eyes: 'oval' };
}

export function avatarSpec(agent) { return agent?.avatar || defaultAvatar(agent?.id); }

function xml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }

function shape(form) {
  const shapes = {
    shield: '<path d="M64 12Q83 26 109 32L106 72Q104 96 64 116Q24 96 22 72L19 32Q45 26 64 12Z"/>',
    star: '<path d="M64 11Q72 11 80 37L107 38Q119 39 106 56L91 73L98 99Q103 116 84 106L64 92L42 106Q24 116 30 98L37 73L20 54Q9 39 27 38L48 37Q56 11 64 11Z"/>',
    bean: '<path d="M30 25Q57 5 90 25Q112 39 99 64Q83 78 104 96Q109 112 74 116Q22 117 20 77Q17 44 30 25Z"/>',
    squircle: '<path d="M30 21Q64 7 99 22Q116 38 110 86Q107 111 80 114Q33 121 22 101Q10 78 18 43Q21 28 30 21Z"/>',
    round: '<circle cx="64" cy="62" r="43"/>',
    pill: '<rect x="26" y="12" width="76" height="99" rx="38"/>',
    triangle: '<path d="M64 13 Q71 13 76 22 L111 91 Q115 102 104 108 Q91 116 64 114 Q37 116 24 108 Q13 102 17 91 L52 22 Q57 13 64 13Z"/>',
    ears: '<path d="M27 59 Q23 31 28 17 Q31 9 40 17 L52 33 Q64 28 76 33 L88 17 Q97 9 100 17 Q105 31 101 59 C107 91 91 112 64 113 C37 112 21 91 27 59Z"/>',
    cloud: '<path d="M30 55 C15 42 29 23 45 31 C51 12 78 12 85 31 C104 22 117 44 103 57 C117 76 105 99 85 99 C70 113 50 108 42 99 C21 106 12 75 30 55Z"/>',
    heart: '<path d="M64 111 C42 94 15 71 17 46 C19 20 47 15 64 38 C81 15 109 20 111 46 C113 71 86 94 64 111Z"/>',
    sprout: '<path d="M63 38 C52 23 39 20 31 23 C32 38 43 45 61 45 C62 35 72 23 91 22 C93 37 84 46 66 47 L66 52 C91 51 107 69 104 87 C100 106 85 113 64 113 C43 113 28 106 24 87 C21 69 37 51 63 52Z"/>',
    scallop: '<path d="M64 20 C73 8 87 14 90 29 C104 22 115 34 110 48 C125 56 120 72 108 78 C113 94 100 107 87 102 C78 118 63 119 54 105 C39 114 24 103 27 88 C12 84 10 68 21 58 C13 43 23 29 39 32 C42 17 55 11 64 20Z"/>',
    hexagon: '<path d="M45 16 Q64 10 83 16 L105 39 Q116 64 105 89 L83 111 Q64 117 45 111 L23 89 Q12 64 23 39Z"/>',
    diamond: '<path d="M64 11 Q70 11 76 19 L109 55 Q116 64 109 73 L76 108 Q64 120 52 108 L19 73 Q12 64 19 55 L52 19 Q58 11 64 11Z"/>',
    robot: '<rect x="22" y="26" width="84" height="86" rx="25"/><path d="M64 27 V14" stroke="currentColor" stroke-width="5" fill="none"/><circle cx="64" cy="12" r="5"/>',
  };
  return shapes[form] || shapes.round;
}

function faceMarkup(face, ink, spec = {}) {
  spec = { ...spec };
  const customized = spec.eyes && spec.eyes !== 'auto' || spec.mouth && spec.mouth !== 'auto';
  if (!spec.eyes || spec.eyes === 'auto') spec.eyes = ['sleepy', 'wink'].includes(face) ? face : 'dots';
  if (!spec.mouth || spec.mouth === 'auto') spec.mouth = face === 'curious' ? 'curious' : ['content', 'sleepy'].includes(face) ? 'small' : 'smile';
  if (customized) {
    const eyes = ({ dots:'<circle cx="48" cy="60" r="5"/><circle cx="80" cy="60" r="5"/>',
      oval:'<rect x="42" y="47" width="12" height="25" rx="6" transform="rotate(-12 48 60)"/><rect x="74" y="47" width="12" height="25" rx="6" transform="rotate(-12 80 60)"/>',
      wide:'<ellipse cx="48" cy="60" rx="8" ry="12"/><ellipse cx="80" cy="60" rx="8" ry="12"/><circle cx="46" cy="56" r="2" fill="white"/><circle cx="78" cy="56" r="2" fill="white"/>',
      happy:'<path d="M40 63q8-17 16 0m16 0q8-17 16 0" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>',
      sleepy:'<path d="M41 61h14m18 0h14" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>',
      wink:'<rect x="42" y="48" width="12" height="24" rx="6"/><path d="M73 61q7-8 14 0" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>' })[spec.eyes] || '<circle cx="48" cy="60" r="5"/><circle cx="80" cy="60" r="5"/>';
    const mouth = ({ smile:'<path d="M56 81q8 9 16 0" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>',
      grin:'<path d="M53 79h22q-11 20-22 0Z"/>', small:'<path d="M60 82h8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
      curious:'<ellipse cx="64" cy="82" rx="5" ry="6" fill="none" stroke="currentColor" stroke-width="3"/>', none:'' })[spec.mouth || 'smile'] || '';
    return `<g fill="${ink}" color="${ink}"><path d="M40 39q7-4 15-1m18 0q7-3 14 1" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".55"/>${eyes}${mouth}</g>`;
  }
  const eyes = face === 'sleepy' ? '<path d="M43 62q7 7 14 0 M71 62q7 7 14 0" fill="none" stroke="#332C33" stroke-width="3.4" stroke-linecap="round"/>'
    : face === 'wink' ? '<circle cx="49" cy="61" r="3.8"/><path d="M72 62q7 6 14 0" fill="none" stroke="#332C33" stroke-width="3.4" stroke-linecap="round"/>'
      : '<circle cx="49" cy="61" r="3.8"/><circle cx="79" cy="61" r="3.8"/>';
  const mouth = face === 'curious' ? '<circle cx="64" cy="80" r="4" fill="none" stroke="#332C33" stroke-width="2.6"/>'
    : face === 'content' || face === 'sleepy' ? '<path d="M59 80h10" fill="none" stroke="#332C33" stroke-width="2.8" stroke-linecap="round"/>'
      : '<path d="M57 78q7 9 14 0" fill="none" stroke="#332C33" stroke-width="2.8" stroke-linecap="round"/>';
  return `<g fill="${ink}">${eyes.replaceAll('#332C33', ink)}${mouth.replaceAll('#332C33', ink)}</g>`;
}

function accessoryMarkup(accessory) {
  return ({
    none: '',
    bow: '<g fill="#FFF8EF" stroke="#7D4760" stroke-width="2"><path d="M65 30Q39 12 38 31Q39 44 65 36Q91 44 90 31Q89 12 65 30Z"/><circle cx="65" cy="33" r="5"/></g>',
    glasses: '<g fill="none" stroke="#403641" stroke-width="3"><circle cx="49" cy="62" r="13"/><circle cx="79" cy="62" r="13"/><path d="M62 60q2-2 4 0M35 59l-7-2M93 59l7-2"/></g>',
    hat: '<path d="M38 36Q43 13 64 14Q85 13 90 36Z" fill="#FFF8EF" stroke="#665562" stroke-width="2"/><path d="M27 37Q64 43 101 37" fill="none" stroke="#665562" stroke-width="5" stroke-linecap="round"/>',
    headphones: '<path d="M26 69V54a38 38 0 0 1 76 0v15" fill="none" stroke="#4B4854" stroke-width="5"/><rect x="20" y="58" width="13" height="28" rx="6" fill="#FFF8EF" stroke="#4B4854" stroke-width="2"/><rect x="95" y="58" width="13" height="28" rx="6" fill="#FFF8EF" stroke="#4B4854" stroke-width="2"/>',
    flower: '<g transform="translate(94 31)" fill="#FFF8EF"><circle cx="0" cy="-9" r="7"/><circle cx="9" cy="0" r="7"/><circle cx="0" cy="9" r="7"/><circle cx="-9" cy="0" r="7"/><circle cx="0" cy="0" r="5" fill="#E7A442"/></g>',
  })[accessory] || '';
}

export function avatarUrl(spec) {
  const key = JSON.stringify(spec);
  if (cache.has(key)) return cache.get(key);
  const color = /^#[0-9a-f]{6}$/i.test(spec.color) ? spec.color : AVATAR_COLORS[0];
  const channels = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255);
  const luminance = channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
  const ink = luminance < .23 ? '#FFF8EF' : '#332C33';
  const plush = spec.finish === 'plush';
  const glossy = spec.finish === 'glossy';
  const ceramic = spec.finish === 'ceramic';
  const folded = spec.style === 'folded';
  const accent = /^#[0-9a-f]{6}$/i.test(spec.accent || '') ? spec.accent : '#FFF8EF';
  const svg = `<svg xmlns="${svgNS}" viewBox="0 0 128 128" width="128" height="128"><defs>
    <radialGradient id="body" cx="34%" cy="24%" r="80%"><stop stop-color="#fff" stop-opacity="${ceramic ? '.65' : glossy ? '.48' : '.32'}"/><stop offset=".34" stop-color="${xml(color)}"/><stop offset=".77" stop-color="${xml(color)}"/><stop offset="1" stop-color="#3B2C46" stop-opacity=".75"/></radialGradient>
    <radialGradient id="shadow"><stop stop-color="#5F493D" stop-opacity=".32"/><stop offset="1" stop-color="#5F493D" stop-opacity="0"/></radialGradient>
    <pattern id="fuzz" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1.2" cy="1.3" r=".8" fill="#fff"/><circle cx="3.7" cy="3.6" r=".6" fill="#fff"/><circle cx="4.1" cy="0.9" r=".4" fill="#fff"/></pattern>
    <clipPath id="shape">${shape(spec.form)}</clipPath></defs>
    <ellipse cx="64" cy="115" rx="44" ry="9" fill="url(#shadow)"/>
    ${folded ? `<g transform="translate(4 3)" fill="#332C33" opacity=".35">${shape(spec.form)}</g>` : ''}
    <g fill="${folded ? xml(color) : 'url(#body)'}" stroke="#47364B" stroke-opacity="${ceramic ? '.15' : '.08'}" stroke-width="1">${shape(spec.form)}</g>
    ${folded ? '<g clip-path="url(#shape)"><path d="M93 9Q123 56 94 115L118 122 128 20Z" fill="#332C33" opacity=".18"/><path d="M16 27Q56 3 97 25" fill="none" stroke="white" stroke-opacity=".3" stroke-width="5"/></g>' : ''}
    ${plush ? '<g clip-path="url(#shape)" opacity=".22"><rect x="10" y="10" width="108" height="108" fill="url(#fuzz)"/></g>' : ''}
    <ellipse cx="48" cy="37" rx="19" ry="9" transform="rotate(-24 48 37)" fill="#fff" opacity="${glossy ? '.38' : ceramic ? '.3' : '.15'}" clip-path="url(#shape)"/>
    ${faceMarkup(spec.face, ink, spec)}${[...new Set([spec.accessory, ...(spec.accessories || [])])].map(accessoryMarkup).join('').replaceAll('#FFF8EF', accent)}</svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  if (cache.size >= 512) cache.delete(cache.keys().next().value);
  cache.set(key, url);
  return url;
}

export function agentAvatar(agent, size = 72) {
  const spec = avatarSpec(agent);
  const node = document.createElement('span');
  node.className = 'agent-avatar agent-dot-avatar';
  node.style.width = `${size}px`; node.style.height = `${size}px`;
  node.dataset.avatarSpec = JSON.stringify(spec);
  node.setAttribute('aria-hidden', 'true');
  const image = document.createElement('img');
  image.src = avatarUrl(spec); image.alt = ''; image.decoding = 'async';
  node.append(image);
  return node;
}

// One picker serves creation and profile editing. Its DOM stays mounted while
// polls arrive; setSpec only syncs untouched drafts (2026-10-14).
export function avatarPicker(initial, onChange = () => {}) {
  let spec = { ...initial }, dirty = false;
  const root = document.createElement('div'); root.className = 'agent-avatar-picker';
  const preview = document.createElement('div'); preview.className = 'agent-avatar-picker-preview';
  const controls = document.createElement('div'); controls.className = 'agent-avatar-picker-controls';
  const groups = new Map();
  const custom = document.createElement('input'); custom.type = 'color'; custom.className = 'agent-avatar-custom-input';
  custom.setAttribute('aria-label', 'Avatar custom color');
  const change = (key, value) => {
    if (key === 'face') { delete spec.eyes; delete spec.mouth; }
    spec = { ...spec, [key]: value, ...(['eyes','mouth','accent','accessories','style'].includes(key) ? { version: 2 } : {}) };
    dirty = true; sync(); paint(true); onChange({ ...spec });
  };
  // 2026-10-14: roving radio focus gives each visual grid one Tab stop and
  // arrow navigation; thumbnails reuse avatarUrl's cached SVG data URLs.
  const group = (key, values, kind = 'faces') => {
    const section = document.createElement('section'); section.className = `agent-avatar-choice agent-avatar-choice-${key}`;
    const title = document.createElement('h4'); title.textContent = key[0].toUpperCase() + key.slice(1);
    const grid = document.createElement('div'); grid.className = kind === 'finish' ? 'segmented-tabs agent-avatar-options' : `agent-avatar-options agent-avatar-options-${kind}`;
    grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', `Avatar ${key}`);
    const buttons = values.map(value => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.value = value;
      button.className = kind === 'finish' ? 'segmented-tab agent-avatar-option' : 'agent-avatar-option';
      button.setAttribute('role', 'radio'); button.setAttribute('aria-label', value === 'custom' ? 'Custom color' : value);
      if (kind === 'color') {
        button.classList.add('agent-avatar-swatch');
        if (value === 'custom') button.textContent = '+';
        else button.style.setProperty('--swatch', value);
      } else if (kind === 'finish') button.textContent = value[0].toUpperCase() + value.slice(1);
      else {
        const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; button.append(image);
        const label = document.createElement('span'); label.textContent = value; button.append(label);
      }
      button.addEventListener('click', () => {
        if (key === 'face') { delete spec.eyes; delete spec.mouth; }
        value === 'custom' ? custom.click() : change(key, value);
      });
      grid.append(button); return button;
    });
    grid.addEventListener('keydown', event => {
      const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
      if (!direction && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length;
      buttons[next].focus();
      if (buttons[next].dataset.value !== 'custom') change(key, buttons[next].dataset.value);
    });
    section.append(title, grid); controls.append(section); groups.set(key, buttons);
  };
  group('color', [...AVATAR_COLORS, 'custom'], 'color');
  group('form', AVATAR_FORMS); group('face', AVATAR_FACES);
  group('accessory', AVATAR_ACCESSORIES); group('finish', AVATAR_FINISHES, 'finish');
  group('style', ['rounded', 'folded'], 'finish');
  group('eyes', ['auto', 'dots', 'oval', 'wide', 'happy', 'sleepy', 'wink']);
  group('mouth', ['auto', 'smile', 'grin', 'small', 'curious', 'none']);
  const accentInput = document.createElement('input'); accentInput.type = 'color'; accentInput.value = spec.accent || '#FFF8EF';
  accentInput.setAttribute('aria-label', 'Avatar accent color'); accentInput.oninput = () => change('accent', accentInput.value.toUpperCase());
  const accentLabel = document.createElement('label'); accentLabel.className = 'agent-avatar-accent'; accentLabel.textContent = 'Accessory color'; accentLabel.append(accentInput); controls.append(accentLabel);
  const layers = document.createElement('div'); layers.className = 'agent-avatar-layers'; layers.setAttribute('aria-label', 'Layered accessories');
  for (const value of AVATAR_ACCESSORIES.slice(1)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn quiet'; button.textContent = value;
    button.setAttribute('aria-pressed', String((spec.accessories || []).includes(value)));
    button.onclick = () => { const active = new Set(spec.accessories || []); active.has(value) ? active.delete(value) : active.add(value); change('accessories', [...active]); button.setAttribute('aria-pressed', String(active.has(value))); };
    layers.append(button);
  }
  controls.append(layers);
  const presetKey = 'kairos:avatar-presets';
  const presetActions = document.createElement('div'); presetActions.className = 'agent-avatar-presets';
  const savePreset = document.createElement('button'); savePreset.type = 'button'; savePreset.className = 'btn'; savePreset.textContent = 'Save this look';
  const presetList = document.createElement('div'); presetList.className = 'agent-avatar-options'; presetList.setAttribute('aria-label', 'Saved looks');
  const presetStatus = document.createElement('span'); presetStatus.className = 'meta'; presetStatus.setAttribute('role', 'status');
  const drawPresets = () => {
    presetList.replaceChildren(); let saved = []; try { saved = JSON.parse(localStorage.getItem(presetKey) || '[]'); } catch { /* optional storage */ }
    for (const [index, value] of (Array.isArray(saved) ? saved : []).filter(v => v && typeof v === 'object' && typeof v.color === 'string' && (!v.accessories || Array.isArray(v.accessories))).slice(0, 8).entries()) { const button = document.createElement('button'); button.type = 'button'; button.className = 'agent-avatar-option'; button.setAttribute('aria-label', `Saved look ${index + 1}`); button.append(agentAvatar({ avatar: value }, 44)); button.onclick = () => { spec = { ...value }; dirty = true; sync(); paint(); onChange({ ...spec }); }; presetList.append(button); }
  };
  savePreset.onclick = () => { try { const raw = JSON.parse(localStorage.getItem(presetKey) || '[]'); const saved = Array.isArray(raw) ? raw : []; saved.unshift({ ...spec }); localStorage.setItem(presetKey, JSON.stringify(saved.slice(0, 8))); drawPresets(); presetStatus.textContent = 'Look saved on this device.'; } catch { presetStatus.textContent = 'Could not save this look on this device.'; } };
  presetActions.append(savePreset, presetStatus, presetList); controls.append(presetActions); drawPresets();
  custom.value = /^#[0-9a-f]{6}$/i.test(spec.color) ? spec.color : AVATAR_COLORS[0];
  custom.oninput = () => change('color', custom.value.toUpperCase());
  const shuffle = document.createElement('button'); shuffle.type = 'button'; shuffle.className = 'btn agent-avatar-shuffle'; shuffle.textContent = 'Shuffle';
  shuffle.onclick = () => { const choose = values => values[Math.floor(Math.random() * values.length)];
    let next; do { next = { form: choose(AVATAR_FORMS), color: choose(AVATAR_COLORS), finish: choose(AVATAR_FINISHES),
      face: choose(AVATAR_FACES), accessory: choose(AVATAR_ACCESSORIES), version: 2, style: 'folded', eyes: choose(['oval','dots','wide','happy','wink']) }; } while (JSON.stringify(next) === JSON.stringify(spec));
    spec = next; dirty = true; sync(); paint(false);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) preview.animate([
      { transform: 'rotate(-9deg) scale(.9)', opacity: .65 }, { transform: 'rotate(8deg) scale(1.06)', opacity: 1 },
      { transform: 'none', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
    onChange({ ...spec });
  };
  controls.append(shuffle, custom); root.append(preview, controls);
  function sync() {
    for (const [key, buttons] of groups) {
      const selected = key === 'color' && !AVATAR_COLORS.includes(spec.color) ? 'custom' : spec[key] || (['eyes','mouth'].includes(key) ? 'auto' : key === 'style' ? 'rounded' : '');
      for (const button of buttons) {
        const active = button.dataset.value === selected;
        button.setAttribute('aria-checked', String(active)); button.tabIndex = active ? 0 : -1;
        if (button.dataset.value === 'custom') button.style.setProperty('--swatch', spec.color);
        const image = button.querySelector('img');
        if (image) image.src = avatarUrl({ ...spec, ...(key === 'face' ? { eyes: 'auto', mouth: 'auto' } : {}), [key]: button.dataset.value });
      }
    }
    custom.value = spec.color;
    accentInput.value = spec.accent || '#FFF8EF';
    [...layers.children].forEach(button => button.setAttribute('aria-pressed', String((spec.accessories || []).includes(button.textContent))));
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
    setSpec(next) { if (dirty || root.contains(document.activeElement) || JSON.stringify(spec) === JSON.stringify(next)) return;
      spec = { ...next }; sync(); paint(); },
    markSaved() { dirty = false; } };
}

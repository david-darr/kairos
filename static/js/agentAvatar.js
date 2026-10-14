// 2026-10-14: Agent faces are original, cached SVG data URLs. A static image
// has no per-instance canvas or ResizeObserver, so rosters stay cheap to poll.
export const AVATAR_FORMS = ['round', 'pill', 'triangle', 'ears', 'cloud', 'heart', 'sprout', 'scallop', 'hexagon', 'diamond', 'robot'];
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
    face: AVATAR_FACES[Math.floor(seed / 97) % AVATAR_FACES.length], accessory: 'none' };
}

export function avatarSpec(agent) { return agent?.avatar || defaultAvatar(agent?.id); }

function xml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }

function shape(form) {
  const shapes = {
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

function faceMarkup(face, ink) {
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
  const svg = `<svg xmlns="${svgNS}" viewBox="0 0 128 128" width="128" height="128"><defs>
    <radialGradient id="body" cx="34%" cy="24%" r="80%"><stop stop-color="#fff" stop-opacity="${ceramic ? '.65' : glossy ? '.48' : '.32'}"/><stop offset=".34" stop-color="${xml(color)}"/><stop offset=".77" stop-color="${xml(color)}"/><stop offset="1" stop-color="#3B2C46" stop-opacity=".75"/></radialGradient>
    <filter id="shadow" x="-60%" y="-100%" width="220%" height="300%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="texture" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency=".34" numOctaves="2" seed="7" result="noise"/><feComposite in="noise" in2="SourceGraphic" operator="in"/></filter>
    <clipPath id="shape">${shape(spec.form)}</clipPath></defs>
    <ellipse cx="64" cy="115" rx="37" ry="6" fill="#5F493D" opacity=".2" filter="url(#shadow)"/>
    <g fill="url(#body)" stroke="#47364B" stroke-opacity="${ceramic ? '.15' : '.08'}" stroke-width="1">${shape(spec.form)}</g>
    ${plush ? '<g clip-path="url(#shape)" opacity=".17" filter="url(#texture)"><rect x="10" y="10" width="108" height="108" fill="#fff"/></g>' : ''}
    <ellipse cx="48" cy="37" rx="19" ry="9" transform="rotate(-24 48 37)" fill="#fff" opacity="${glossy ? '.38' : ceramic ? '.3' : '.15'}" clip-path="url(#shape)"/>
    ${faceMarkup(spec.face, ink)}${accessoryMarkup(spec.accessory)}</svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
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
  const fields = {};
  const field = (key, values) => {
    const label = document.createElement('label'); label.textContent = key[0].toUpperCase() + key.slice(1);
    const select = document.createElement('select'); select.setAttribute('aria-label', `Avatar ${key}`);
    for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = value[0].toUpperCase() + value.slice(1); select.append(option); }
    if (key === 'color') { const option = document.createElement('option'); option.value = ''; option.textContent = 'Custom'; select.append(option); }
    select.value = key === 'color' && !AVATAR_COLORS.includes(spec.color) ? '' : spec[key];
    select.onchange = () => { spec[key] = key === 'color' && !select.value ? custom.value.toUpperCase() : select.value;
      dirty = true; paint(); onChange(spec); };
    label.append(select); controls.append(label); fields[key] = select;
  };
  field('form', AVATAR_FORMS); field('color', AVATAR_COLORS); field('finish', AVATAR_FINISHES);
  field('face', AVATAR_FACES); field('accessory', AVATAR_ACCESSORIES);
  const custom = document.createElement('input'); custom.type = 'color'; custom.setAttribute('aria-label', 'Avatar custom color');
  custom.value = /^#[0-9a-f]{6}$/i.test(spec.color) ? spec.color : AVATAR_COLORS[0];
  custom.oninput = () => { spec.color = custom.value.toUpperCase(); fields.color.value = ''; dirty = true; paint(); onChange(spec); };
  const customLabel = document.createElement('label'); customLabel.textContent = 'Custom color'; customLabel.append(custom); controls.append(customLabel);
  const shuffle = document.createElement('button'); shuffle.type = 'button'; shuffle.className = 'btn agent-avatar-shuffle'; shuffle.textContent = 'Shuffle';
  shuffle.onclick = () => { const choose = values => values[Math.floor(Math.random() * values.length)];
    let next; do { next = { form: choose(AVATAR_FORMS), color: choose(AVATAR_COLORS), finish: choose(AVATAR_FINISHES),
      face: choose(AVATAR_FACES), accessory: choose(AVATAR_ACCESSORIES) }; } while (JSON.stringify(next) === JSON.stringify(spec));
    spec = next; dirty = true; sync(); paint(); onChange(spec);
  };
  controls.append(shuffle); root.append(preview, controls);
  function sync() { for (const [key, select] of Object.entries(fields)) select.value = key === 'color' && !AVATAR_COLORS.includes(spec.color) ? '' : spec[key];
    custom.value = spec.color; }
  function paint() { preview.replaceChildren(agentAvatar({ avatar: spec }, 112)); }
  paint();
  return { root, getSpec: () => ({ ...spec }), isDirty: () => dirty,
    setSpec(next) { if (dirty || root.contains(document.activeElement)) return; spec = { ...next }; sync(); paint(); },
    markSaved() { dirty = false; } };
}

// TEMPORARY (2026-10-21): on-device viewport diagnostics for the iPhone
// home-screen app height and top-frost bugs. Opened from the last row of the
// phone workspace sheet (mobileTabSheet.js). Delete this file and that row
// once the layout fix lands.
const ID = 'vp-diag';
let overlay = null, body = null, status = null, lastText = '', listening = false;

const px = n => (Number.isFinite(n) ? Math.round(n * 10) / 10 : String(n));
const rectText = r => `top ${px(r.top)}  bottom ${px(r.bottom)}  h ${px(r.height)}  left ${px(r.left)}  w ${px(r.width)}`;
const describe = node => {
  if (node === document.documentElement) return 'html' + (node.className ? '.' + String(node.className).trim().split(/\s+/).join('.') : '');
  let s = node.tagName.toLowerCase();
  if (node.id) s += '#' + node.id;
  const cls = typeof node.className === 'string' ? node.className.trim() : node.getAttribute('class') || '';
  if (cls) s += '.' + cls.split(/\s+/).slice(0, 4).join('.');
  return s;
};
const alpha = color => {
  if (!color || color === 'transparent') return 0;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return color.includes('color(') || color.includes('oklch') || color.includes('lab(') ? (/\/\s*0(\.0+)?\s*\)/.test(color) ? 0 : 1) : 1;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 4 ? parseFloat(parts[3]) : 1;
};
const short = (value, n = 140) => (value && value.length > n ? value.slice(0, n) + '...' : value);
const backdropOf = s => s.backdropFilter && s.backdropFilter !== 'none' ? s.backdropFilter : (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none' ? s.webkitBackdropFilter : 'none');
const maskOf = s => (s.maskImage && s.maskImage !== 'none' ? s.maskImage : s.webkitMaskImage) || 'none';

function probe(css) {
  const node = document.createElement('div');
  node.style.cssText = 'position:fixed;left:0;top:0;width:1px;visibility:hidden;pointer-events:none;box-sizing:content-box;' + css;
  document.body.append(node);
  return node;
}

function measure() {
  const out = [];
  const section = (title, lines) => out.push({ title, lines });
  const vv = window.visualViewport;
  const mode = ['standalone', 'fullscreen', 'minimal-ui', 'browser'].filter(m => matchMedia(`(display-mode: ${m})`).matches);
  section('Window', [
    `innerHeight ${innerHeight}   innerWidth ${innerWidth}`,
    `outerHeight ${outerHeight}   outerWidth ${outerWidth}`,
    `screen.height ${screen.height}   screen.width ${screen.width}   availHeight ${screen.availHeight}`,
    `visualViewport.height ${px(vv?.height)}   offsetTop ${px(vv?.offsetTop)}   pageTop ${px(vv?.pageTop)}   scale ${vv?.scale}`,
    `documentElement.clientHeight ${document.documentElement.clientHeight}   clientWidth ${document.documentElement.clientWidth}`,
    `devicePixelRatio ${devicePixelRatio}`,
    `display-mode: ${mode.join(', ') || 'none matched'}   navigator.standalone ${navigator.standalone}`,
    `orientation ${screen.orientation?.type || window.orientation}`,
  ]);
  section('Scroll offsets', [
    `window.scrollY ${px(scrollY)}   html.scrollTop ${px(document.documentElement.scrollTop)}   body.scrollTop ${px(document.body.scrollTop)}`,
    `scrollingElement.scrollHeight ${document.scrollingElement?.scrollHeight}`,
    ...['#app', '#content', '#view-content', '.view.active', '.ms-shell', '.ms-page-window']
      .map(sel => [sel, document.querySelector(sel)]).filter(([, n]) => n)
      .map(([sel, n]) => `${sel} scrollTop ${px(n.scrollTop)}  scrollHeight ${n.scrollHeight}  clientHeight ${n.clientHeight}`),
  ]);
  const units = ['100vh', '100svh', '100lvh', '100dvh', '100%', 'var(--ms-page-height)', 'var(--ms-below-fold)'];
  const probes = units.map(u => probe(`height:${u}`));
  const full = probe('inset:0;width:auto;height:auto');
  const insets = ['top', 'bottom', 'left', 'right'].map(side => [side, probe(`height:0;padding-${side === 'left' || side === 'right' ? 'left' : 'top'}:env(safe-area-inset-${side}, 0px)`), probe(`height:0;padding-top:var(--mobile-safe-${side}, 0px)`)]);
  const fullRect = full.getBoundingClientRect();
  section('Height probes (position: fixed)', [
    ...units.map((u, i) => `${u.replace(/^var\((.*)\)$/, '$1').padEnd(7)} ${px(probes[i].getBoundingClientRect().height)}`),
    `inset:0  top ${px(fullRect.top)}  bottom ${px(fullRect.bottom)}  h ${px(fullRect.height)}`,
  ]);
  section('Safe-area insets', insets.map(([side, env, mobile]) => {
    const s = getComputedStyle(env);
    return `${side.padEnd(6)} env ${side === 'left' || side === 'right' ? s.paddingLeft : s.paddingTop}   --mobile-safe-${side} ${getComputedStyle(mobile).paddingTop}`;
  }));
  [...probes, full, ...insets.flatMap(([, a, b]) => [a, b])].forEach(n => n.remove());
  section('Switches', switchReport());
  const html = document.documentElement, shell = document.querySelector('.ms-shell');
  section('Custom properties', [
    `html --ms-page-height: ${getComputedStyle(html).getPropertyValue('--ms-page-height').trim() || '(unset)'}`,
    `.ms-shell --ms-keyboard: ${shell ? shell.style.getPropertyValue('--ms-keyboard') || '(unset)' : '(no shell)'}`,
    `--native-safe-top: ${getComputedStyle(html).getPropertyValue('--native-safe-top') || '(unset)'}`,
    `html classes: ${short(html.className, 200)}   data-view ${html.dataset.view}`,
  ]);
  const boxes = [
    ['html', html], ['body', document.body], ['#app', document.getElementById('app')], ['#content', document.getElementById('content')],
    ['.kairos-redesign-backdrop', document.querySelector('.kairos-redesign-backdrop')],
    ['.view.active', document.querySelector('#content > .view.active') || document.querySelector('.view.active')],
    ['.dashboard-content', document.querySelector('.view.active .dashboard-content')],
    ['.ms-shell', shell], ['.ms-header', document.querySelector('.ms-shell .ms-header')],
    ['.ms-page-window', document.querySelector('.ms-page-window')], ['.ms-launch-bottom', document.querySelector('.ms-launch-bottom')],
    ['.ms-launch-composer', document.querySelector('.ms-launch-composer')], ['.chat-composer-dock', document.querySelector('.view.active .chat-composer-dock')],
    ['.ms-composer', document.querySelector('.view.active .ms-composer')], ['.ms-dock', document.querySelector('.ms-dock')],
    ['#mobile-menu-btn', document.getElementById('mobile-menu-btn')], ['.ms-global-frost', document.querySelector('.ms-global-frost')],
  ];
  section('Element rects', boxes.filter(([, n]) => n).map(([label, n]) => {
    const s = getComputedStyle(n);
    const shown = n.getClientRects().length ? '' : '  (no box)';
    const extra = [s.position !== 'static' ? s.position : '', s.transform !== 'none' ? 'transform ' + s.transform : '', s.paddingTop !== '0px' ? 'pad-top ' + s.paddingTop : '', s.paddingBottom !== '0px' ? 'pad-bottom ' + s.paddingBottom : '', s.marginTop !== '0px' ? 'margin-top ' + s.marginTop : '', s.visibility === 'hidden' ? 'visibility hidden' : ''].filter(Boolean).join('  ');
    return `${label}: ${rectText(n.getBoundingClientRect())}${shown}${extra ? '\n    ' + extra : ''}`;
  }));
  section('Backgrounds', [
    `html bg ${getComputedStyle(html).backgroundColor}   height ${getComputedStyle(html).height}   overflow ${getComputedStyle(html).overflow}`,
    `body bg ${getComputedStyle(document.body).backgroundColor}   height ${getComputedStyle(document.body).height}   overflow ${getComputedStyle(document.body).overflow}`,
    `meta theme-color ${document.querySelector('meta[name=theme-color]')?.content}`,
  ]);
  // Every painted layer that touches the top 160px: backdrop blur, tint or image, on the element or its pseudo-elements.
  const layers = [];
  for (const node of document.querySelectorAll('body *, html')) {
    if (node.closest('#' + ID) || !node.getClientRects().length) continue;
    const r = node.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= 160 || r.right <= 0 || r.left >= innerWidth || r.width === 0 || r.height === 0) continue;
    for (const pseudo of [null, '::before', '::after']) {
      const s = getComputedStyle(node, pseudo);
      if (pseudo && (s.content === 'none' || s.content === 'normal' || s.display === 'none')) continue;
      const blur = backdropOf(s), bg = s.backgroundColor, img = s.backgroundImage;
      if (blur === 'none' && alpha(bg) <= 0 && (!img || img === 'none')) continue;
      layers.push({ blur: blur !== 'none', text: `${describe(node)}${pseudo || ''}\n    rect ${pseudo ? '(host) ' : ''}${rectText(r)}${pseudo ? `\n    pseudo top ${s.top} height ${s.height} inset ${s.inset}` : ''}\n    backdrop ${blur}   bg ${bg}${img && img !== 'none' ? '\n    bg-image ' + short(img) : ''}\n    mask ${short(maskOf(s))}\n    z ${s.zIndex}   opacity ${s.opacity}   visibility ${s.visibility}` });
    }
  }
  layers.sort((a, b) => b.blur - a.blur);
  // Dot contrast of each visible dither canvas, per 20px band from the top: mean/stddev of brightness.
  // A flat band (stddev near 0) means the canvas itself has no dots there.
  const canvases = [...document.querySelectorAll('canvas.dither-canvas')].filter(c => c.getClientRects().length && c.width > 50 && c.height > 50);
  section('Dither canvas dot contrast (top 200px, mean/stddev per 20px)', canvases.map(c => {
    const r = c.getBoundingClientRect(), k = c.height / r.height, bands = [];
    try {
      const ctx = c.getContext('2d');
      for (let y = Math.max(0, -r.top); y < Math.min(200 - r.top, r.height); y += 20) {
        const d = ctx.getImageData(0, Math.round(y * k), c.width, Math.max(1, Math.round(20 * k))).data;
        let sum = 0, sq = 0, n = 0;
        for (let i = 0; i < d.length; i += 16) { const l = .3 * d[i] + .59 * d[i + 1] + .11 * d[i + 2]; sum += l; sq += l * l; n++; }
        const m = sum / n; bands.push(`${Math.round(r.top + y)}:${Math.round(m)}/${Math.sqrt(Math.max(0, sq / n - m * m)).toFixed(0)}`);
      }
    } catch (error) { bands.push('unreadable: ' + error.message); }
    const host = c.parentElement ? describe(c.parentElement) : '?';
    return `${host} canvas ${c.width}x${c.height} at ${rectText(r)}
    ${bands.join('  ')}`;
  }));
  section(`Top 160px layers (${layers.filter(l => l.blur).length} with blur, ${layers.length} total)`, layers.map(l => l.text));
  return out;
}

function render() {
  if (!overlay) return;
  let sections;
  try { sections = measure(); } catch (error) { sections = [{ title: 'Error', lines: [String(error?.stack || error)] }]; }
  lastText = `Kairos viewport diagnostics ${new Date().toISOString()}\n` + sections.map(s => `\n== ${s.title} ==\n${s.lines.join('\n')}`).join('\n');
  body.replaceChildren(...sections.map(s => {
    const block = document.createElement('section');
    const h = document.createElement('h3'); h.textContent = s.title;
    const pre = document.createElement('pre'); pre.textContent = s.lines.join('\n');
    block.append(h, pre); return block;
  }));
  status.textContent = 'Measured ' + new Date().toLocaleTimeString();
}

// Each switch names exactly what it hides; the Switches section counts its targets
// and checks the computed result, so a switch that matches nothing shows up as such.
const LAYERS = [
  { name: 'Status-bar frost', what: 'display:none on .ms-blur-top and .ms-global-frost', sel: '.ms-blur-top, .ms-global-frost',
    css: '.ms-blur-top, .ms-global-frost { display: none !important; }', done: n => getComputedStyle(n).display === 'none' },
  { name: 'Glass pills', what: 'backdrop blur off on .ms-glass pills and the chat capsule', sel: '.ms-glass',
    css: '.ms-glass, .ms-chat-capsule::before { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
    done: n => { const s = getComputedStyle(n); return (s.backdropFilter || 'none') === 'none' && (s.webkitBackdropFilter || 'none') === 'none'; } },
  { name: 'Background wash', what: 'the ::after wash over the launch and Home pictures', sel: '.dashboard-core',
    css: '.ms-background::after, .dashboard-core::after { display: none !important; }', done: n => getComputedStyle(n, '::after').display === 'none' },
  { name: 'Background dots', what: 'the launch picture (.ms-background), dots and all', sel: '.ms-background',
    css: '.ms-background { visibility: hidden !important; }', done: n => getComputedStyle(n).visibility === 'hidden' },
  { name: 'Sky backdrop', what: 'the page sky behind every view (.kairos-redesign-backdrop)', sel: '.kairos-redesign-backdrop',
    css: '.kairos-redesign-backdrop { visibility: hidden !important; }', done: n => getComputedStyle(n).visibility === 'hidden' },
];
const hidden = new Set();
function applyHidden() {
  let node = document.getElementById('vp-diag-hide');
  if (!node) { node = document.createElement('style'); node.id = 'vp-diag-hide'; document.head.append(node); }
  node.textContent = LAYERS.filter(l => hidden.has(l.name)).map(l => l.css).join('\n');
}
// theme-color: present (the app's value), removed, or transparent. iOS may read it only at launch.
const THEMES = ['present', 'removed', 'transparent'];
const themeOriginal = () => document.documentElement.dataset.themeColor || document.querySelector('meta[name=theme-color]')?.content || '#F3EADB';
function themeState() {
  const meta = document.querySelector('meta[name=theme-color]');
  return !meta ? 'removed' : meta.content === 'transparent' ? 'transparent' : 'present';
}
function setTheme(state) {
  const value = themeOriginal(); document.documentElement.dataset.themeColor = value;
  document.querySelectorAll('meta[name=theme-color]').forEach(n => n.remove());
  if (state === 'removed') return;
  const meta = document.createElement('meta'); meta.name = 'theme-color'; meta.content = state === 'transparent' ? 'transparent' : value;
  document.head.append(meta);
}
function switchReport() {
  return [
    `theme-color meta: ${themeState()} (${document.querySelector('meta[name=theme-color]')?.content || 'none'}; app value ${themeOriginal()})`,
    ...LAYERS.map(l => {
      const nodes = [...document.querySelectorAll(l.sel)].filter(n => !n.closest('#' + ID));
      const state = hidden.has(l.name) ? `ON: ${nodes.filter(l.done).length}/${nodes.length} hidden` : `off: ${nodes.length} targets`;
      return `${l.name}: ${state}\n    ${l.what}`;
    }),
  ];
}

let frame = 0;
const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); };

async function copy() {
  try { await navigator.clipboard.writeText(lastText); status.textContent = 'Copied'; return; } catch { /* Fall back below. */ }
  const area = document.createElement('textarea'); area.value = lastText; area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'; overlay.append(area);
  area.select(); area.setSelectionRange(0, lastText.length);
  let done = false; try { done = document.execCommand('copy'); } catch { done = false; }
  area.remove(); status.textContent = done ? 'Copied' : 'Copy failed: select the text and copy by hand';
}

export function closeViewportDiagnostics() {
  if (!overlay) return;
  overlay.remove(); overlay = null;
  if (listening) {
    removeEventListener('resize', schedule); removeEventListener('orientationchange', schedule);
    visualViewport?.removeEventListener('resize', schedule); visualViewport?.removeEventListener('scroll', schedule);
    listening = false;
  }
}

export function openViewportDiagnostics() {
  if (overlay) { render(); return; }
  overlay = document.createElement('div'); overlay.id = ID;
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Viewport diagnostics');
  const style = document.createElement('style');
  style.textContent = `#${ID}{position:fixed;inset:0;z-index:2147483000;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#fff;color:#111;font:15px/1.45 -apple-system,system-ui,sans-serif;padding:calc(env(safe-area-inset-top,0px) + 8px) 12px calc(env(safe-area-inset-bottom,0px) + 24px);box-sizing:border-box}
#${ID} .vp-bar{position:sticky;top:calc(-8px - env(safe-area-inset-top,0px));display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 0;background:#fff;border-bottom:1px solid #ccc}
#${ID} .vp-toggles{position:static}#${ID} button[aria-pressed=true]{background:#333;color:#fff}#${ID} button{min-height:44px;min-width:44px;padding:0 14px;font:600 15px system-ui,sans-serif;border:1px solid #888;border-radius:10px;background:#f2f2f2;color:#111}
#${ID} h2{margin:0;flex:1 1 100%;font-size:17px}#${ID} h3{margin:16px 0 4px;font-size:16px}
#${ID} pre{margin:0;white-space:pre-wrap;word-break:break-word;font:14px/1.45 ui-monospace,Menlo,monospace}#${ID} .vp-status{font-size:13px;color:#555}`;
  const bar = document.createElement('div'); bar.className = 'vp-bar';
  const title = document.createElement('h2'); title.textContent = 'Viewport diagnostics (temporary)';
  const make = (label, action) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); return b; };
  status = document.createElement('span'); status.className = 'vp-status';
  bar.append(title, make('Refresh', render), make('Copy', copy), make('Close', closeViewportDiagnostics), status);
  // Layer switches: hide one top layer, close this screen and look. They last until the app reloads.
  const toggles = document.createElement('div'); toggles.className = 'vp-bar vp-toggles';
  const label = document.createElement('h3'); label.textContent = 'Switch a layer, then Close to look (lasts until the app reloads)'; label.style.flex = '1 1 100%';
  toggles.append(label);
  for (const layer of LAYERS) {
    const b = make('', () => {
      const on = !hidden.has(layer.name); on ? hidden.add(layer.name) : hidden.delete(layer.name);
      relabel(); applyHidden(); render();
    });
    const relabel = () => { b.textContent = `${hidden.has(layer.name) ? 'Hidden' : 'Hide'}: ${layer.name}`; b.setAttribute('aria-pressed', String(hidden.has(layer.name))); b.title = layer.what; };
    relabel(); toggles.append(b);
  }
  const theme = make('', () => { setTheme(THEMES[(THEMES.indexOf(themeState()) + 1) % THEMES.length]); themeLabel(); render(); });
  const themeLabel = () => { theme.textContent = `theme-color: ${themeState()} (tap to change)`; theme.setAttribute('aria-pressed', String(themeState() !== 'present')); };
  themeLabel(); toggles.append(theme);
  body = document.createElement('div');
  overlay.append(style, bar, toggles, body);
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeViewportDiagnostics(); } });
  document.body.append(overlay);
  addEventListener('resize', schedule); addEventListener('orientationchange', schedule);
  visualViewport?.addEventListener('resize', schedule); visualViewport?.addEventListener('scroll', schedule);
  listening = true;
  render();
  bar.querySelector('button').focus({ preventScroll: true });
}

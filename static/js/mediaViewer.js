import { el, toast } from './api.js';
import { renderArtifact, renderImage, renderMedia, loadingSkeleton } from './artifactViewer.js';
import { suppressBrowser, releaseBrowser } from './browserPane.js';
import { mobileOn } from './mobileShared.js';
import { clampIndex, contentURL, counterText, detailParts, extensionOf, swipeIntent } from './mediaItems.js';

// The in-chat media viewer (In-Chat Media Viewer build spec, 2026-11-07): a
// lightbox over the dimmed chat on desktop, a full sheet on phones. It hosts
// the Documents pane's renderers (artifactViewer.js), so every kind looks and
// behaves the same in both places; it never renders a file a second way.
// The chat underneath is never touched: closing returns focus to the item
// that opened it and leaves every scroll position where it was.

const svg = path => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICONS = {
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>'),
  save: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  pane: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="14" y1="4" x2="14" y2="20"/>'),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  prev: svg('<polyline points="15 18 9 12 15 6"/>'),
  next: svg('<polyline points="9 18 15 12 9 6"/>'),
  play: svg('<polygon points="7 4 20 12 7 20 7 4"/>'),
  audio: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
};
const iconButton = (name, label, onclick, extra = {}) => {
  const button = el('button', { type: 'button', class: `media-viewer-btn media-viewer-${name}`, 'aria-label': label, title: label, onclick, ...extra });
  button.innerHTML = ICONS[name];
  return button;
};
// Arrow keys belong to whatever has its own: slides, players, fields.
const OWNS_ARROWS = 'input, textarea, select, [contenteditable="true"], video, audio, .office-deck, .office-tabs';

let active = null;
export const viewerOpen = () => !!active;

export function openMediaViewer(items, start = 0, { opener = document.activeElement } = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  active?.close();
  let index = clampIndex(start, items.length);
  let controller = null, ticket = 0;

  const count = el('span', { class: 'media-viewer-count', 'aria-live': 'polite' });
  const copy = iconButton('copy', 'Copy image', () => copyImage(items[index]));
  const share = iconButton('share', 'Share', () => shareItem(items[index]));
  const save = el('a', { class: 'media-viewer-btn media-viewer-save', 'aria-label': 'Save', title: 'Save', rel: 'noopener' });
  save.innerHTML = ICONS.save;
  const toPane = iconButton('pane', mobileOn() ? 'Open in Documents' : 'Open beside chat', () => openInPane(items[index]));
  const close = iconButton('close', 'Close viewer', () => api.close());
  const name = el('strong', { class: 'media-viewer-name' });
  const facts = el('span', { class: 'media-viewer-facts' });
  const details = el('div', { class: 'media-viewer-details' }, [name, facts]);
  const tools = el('div', { class: 'media-viewer-tools artifact-toolbar' });
  const content = el('div', { class: 'media-viewer-content artifact-preview', 'aria-live': 'polite' });
  const prev = iconButton('prev', 'Previous item', () => go(index - 1));
  const next = iconButton('next', 'Next item', () => go(index + 1));
  const stage = el('div', { class: 'media-viewer-stage' }, [prev, content, next]);
  const strip = el('div', { class: 'media-viewer-strip', role: 'group', 'aria-label': 'All items' });
  const bar = el('header', { class: 'media-viewer-bar' }, [count, el('span', { class: 'media-viewer-fill' }), copy, share, save, toPane, close]);
  const grab = el('div', { class: 'media-viewer-grab', 'aria-hidden': 'true' });
  const sheet = el('div', { class: 'media-viewer-sheet' }, [grab, bar, details, tools, stage, strip]);
  const scrim = el('div', { class: 'media-viewer-scrim' });
  const root = el('div', { class: 'media-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Viewer' }, [scrim, sheet]);
  root.classList.toggle('is-phone', mobileOn());

  const thumbs = items.map((item, i) => {
    const thumb = el('button', { type: 'button', class: `media-viewer-thumb is-${item.kind}`, 'aria-label': `${counterText(i, items.length)}: ${item.name}`, onclick: () => go(i) });
    if (item.kind === 'image' && item.src) thumb.append(el('img', { src: item.src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }));
    else {
      const glyph = el('span', { class: 'media-viewer-thumb-glyph', 'aria-hidden': 'true' });
      if (item.kind === 'video') glyph.innerHTML = ICONS.play;
      else if (item.kind === 'audio') glyph.innerHTML = ICONS.audio;
      else glyph.textContent = (extensionOf(item.name) || 'file').toUpperCase().slice(0, 4);
      thumb.append(glyph);
    }
    return thumb;
  });
  strip.append(...thumbs);
  strip.hidden = items.length < 2;
  root.classList.toggle('is-single', items.length < 2);

  // The page under the viewer keeps every scroll position it had.
  const scrolls = [];
  for (let node = opener?.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    if (node.scrollTop || node.scrollLeft) scrolls.push([node, node.scrollTop, node.scrollLeft]);
  }
  const keepScroll = () => { for (const [node, top, left] of scrolls) { if (node.scrollTop !== top) node.scrollTop = top; if (node.scrollLeft !== left) node.scrollLeft = left; } };

  function paintFacts(info) {
    facts.replaceChildren(...detailParts(info).map(part => el('span', { text: part })));
  }

  async function show() {
    const item = items[index], mine = ++ticket;
    controller?.abort();
    content._disposeRenderer?.(); content._disposeRenderer = null;
    controller = new AbortController();
    const signal = controller.signal;
    tools.replaceChildren(); tools.hidden = true;
    content.pageCount = null;
    content.artifact = null;
    content.className = `media-viewer-content artifact-preview is-${item.kind}`;
    count.textContent = counterText(index, items.length);
    name.textContent = item.name;
    const info = { name: item.name, kind: item.kind };
    paintFacts(info);
    prev.disabled = index === 0; next.disabled = index === items.length - 1;
    thumbs.forEach((thumb, i) => thumb.setAttribute('aria-current', String(i === index)));
    thumbs[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    copy.hidden = item.kind !== 'image' || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write;
    share.hidden = !(mobileOn() && typeof navigator.share === 'function' && typeof navigator.canShare === 'function');
    toPane.hidden = !(item.url && item.sessionId && document.querySelector('.chat-layout'));
    save.href = item.url && item.sessionId ? contentURL(item.sessionId, item.url, true) : item.src;
    save.setAttribute('download', item.name);
    root.dataset.kind = item.kind;
    loadingSkeleton(content);
    const onError = error => { if (mine === ticket) content.textContent = `Preview unavailable. ${error?.message || ''}`.trim(); };
    try {
      if (item.url && item.sessionId) {
        await renderArtifact({ sessionId: item.sessionId, url: item.url, controller, content, actions: tools, detail: el('span'), onError },
          { download: false, wheelZoom: true });
        if (content.artifact) { info.size = content.artifact.size; if (content.artifact.kind === 'video' || content.artifact.kind === 'audio') info.kind = content.artifact.kind; }
      } else if (item.kind === 'image') renderImage(content, tools, { filename: item.name }, item.src, controller, onError, { wheelZoom: true });
      else if (item.kind === 'video' || item.kind === 'audio') renderMedia(content, { kind: item.kind, filename: item.name }, item.src, controller);
    } catch (error) { if (error?.name !== 'AbortError') onError(error); }
    if (mine !== ticket || signal.aborted) return;
    tools.hidden = !tools.childElementCount;
    if (content.pageCount?.count) { info.pages = content.pageCount.count; info.pageUnit = content.pageCount.unit; }
    paintFacts(info);
    const picture = content.querySelector('.artifact-image-viewport img, img.artifact-svg-image');
    const media = content.querySelector('video, audio');
    const measure = () => {
      if (mine !== ticket) return;
      if (picture?.naturalWidth) { info.width = picture.naturalWidth; info.height = picture.naturalHeight; }
      if (media?.videoWidth) { info.width = media.videoWidth; info.height = media.videoHeight; }
      if (media && Number.isFinite(media.duration)) info.duration = media.duration;
      paintFacts(info);
    };
    if (picture) { if (picture.complete && picture.naturalWidth) measure(); else picture.addEventListener('load', measure, { signal }); }
    if (media) {
      media.addEventListener('loadedmetadata', () => { if (item.startAt && media.duration > item.startAt) media.currentTime = item.startAt; measure(); }, { signal });
      if (media.readyState >= 1) measure();
    }
  }

  function go(to) {
    const target = clampIndex(to, items.length);
    if (target === index) return;
    index = target; show();
  }

  // Keyboard: Escape closes, arrows move, Home/End jump, Tab stays inside.
  function onKey(event) {
    if (!root.isConnected) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      api.close(); return;
    }
    if (event.key === 'Tab') {
      const stops = [...root.querySelectorAll('button, a[href], video, audio, iframe, [tabindex]:not([tabindex="-1"])')]
        .filter(node => !node.disabled && !node.closest('[hidden]') && node.getClientRects().length);
      if (!stops.length) return;
      const at = stops.indexOf(document.activeElement);
      if (event.shiftKey && at <= 0) { event.preventDefault(); stops.at(-1).focus(); }
      else if (!event.shiftKey && (at === stops.length - 1 || at < 0 && !root.contains(document.activeElement))) { event.preventDefault(); stops[0].focus(); }
      return;
    }
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    if (event.target instanceof Element && event.target.closest(OWNS_ARROWS)) return;
    event.preventDefault();
    go(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1));
  }

  // Touch: swipe sideways between items, drag down to close (the grab bar and
  // header always; a picture, video or audio item anywhere on the stage).
  let gesture = null;
  const scrollsSideways = target => {
    for (let node = target; node && node !== content.parentElement; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
    }
    return false;
  };
  function onPointerDown(event) {
    if (event.pointerType === 'mouse' || !event.isPrimary) { gesture = null; return; }
    if (event.target.closest?.('button, a, video, audio, input, select, .media-viewer-strip')) return;
    const fromTop = !!event.target.closest('.media-viewer-grab, .media-viewer-bar, .media-viewer-details');
    const zoomed = !!content.querySelector('.is-zoomed');
    gesture = { x: event.clientX, y: event.clientY, t: performance.now(), id: event.pointerId,
      sideways: !fromTop && !zoomed && !scrollsSideways(event.target),
      down: fromTop || (!zoomed && ['image', 'video', 'audio'].includes(items[index].kind) && content.scrollTop <= 0) };
  }
  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (!event.isPrimary) { gesture = null; return; }
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (gesture.down && dy > 0 && dy > Math.abs(dx)) sheet.style.transform = `translateY(${dy}px)`;
    else if (gesture.sideways && Math.abs(dx) > Math.abs(dy)) content.style.transform = `translateX(${dx * .4}px)`;
  }
  function onPointerEnd(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const intent = event.type === 'pointerup' ? swipeIntent({ dx: event.clientX - gesture.x, dy: event.clientY - gesture.y, ms: performance.now() - gesture.t }) : null;
    const { sideways, down } = gesture;
    gesture = null;
    sheet.style.transform = ''; content.style.transform = '';
    if (intent === 'close' && down) api.close();
    else if ((intent === 'next' || intent === 'prev') && sideways) go(index + (intent === 'next' ? 1 : -1));
  }
  // A second finger is a pinch, never a swipe.
  root.addEventListener('pointerdown', event => { if (!event.isPrimary) gesture = null; }, true);
  sheet.addEventListener('pointerdown', onPointerDown);
  sheet.addEventListener('pointermove', onPointerMove);
  sheet.addEventListener('pointerup', onPointerEnd);
  sheet.addEventListener('pointercancel', onPointerEnd);
  scrim.addEventListener('click', () => api.close());

  const api = {
    get index() { return index; },
    items,
    root,
    go,
    // handOff: the item moves to the Documents pane, which takes focus and
    // lays the chat out anew, so the viewer leaves both alone.
    close({ handOff = false } = {}) {
      if (active !== api) return;
      active = null;
      ticket++;
      controller?.abort();
      content._disposeRenderer?.();
      document.removeEventListener('keydown', onKey, true);
      document.documentElement.classList.remove('media-viewer-open');
      root.remove();
      releaseBrowser();
      if (handOff) return;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      keepScroll();
      requestAnimationFrame(keepScroll);
    },
  };
  active = api;
  suppressBrowser();
  document.documentElement.classList.add('media-viewer-open');
  document.body.append(root);
  document.addEventListener('keydown', onKey, true);
  close.focus({ preventScroll: true });
  keepScroll();
  show();
  return api;
}

export function closeMediaViewer(options) { active?.close(options); }

async function blobOf(item) {
  const url = item.url && item.sessionId ? contentURL(item.sessionId, item.url) : item.src;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.blob();
}

async function copyImage(item) {
  try {
    let blob = await blobOf(item);
    if (blob.type !== 'image/png') {
      const bitmap = await createImageBitmap(blob);
      const canvas = el('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close?.();
      blob = await new Promise((resolve, reject) => canvas.toBlob(png => png ? resolve(png) : reject(new Error('encode')), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied', 'success');
  } catch { toast('Could not copy this image. Use Save instead.', 'error'); }
}

async function shareItem(item) {
  try {
    const blob = await blobOf(item);
    const file = new File([blob], item.name, { type: blob.type || 'application/octet-stream' });
    if (!navigator.canShare({ files: [file] })) throw new Error('unsupported');
    await navigator.share({ files: [file], title: item.name });
  } catch (error) {
    if (error?.name !== 'AbortError') toast('This device cannot share the file. Use Save instead.', 'error');
  }
}

async function openInPane(item) {
  const opener = document.querySelector(`[data-viewer-url="${CSS.escape(item.url)}"]`);
  closeMediaViewer({ handOff: true });
  const { openArtifact } = await import('./chatContent.js');
  await openArtifact(item.sessionId, item.url, item.name, opener?.isConnected ? opener : null);
}

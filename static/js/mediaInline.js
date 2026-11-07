import { el } from './api.js';
import { cardAspect, counterText, extensionOf, itemData, itemFromData } from './mediaItems.js';

// Media in the message itself (In-Chat Media Viewer build spec, 2026-11-07):
// one picture is a card, several in a row are a fanned stack you swipe or
// step through, video and audio play in place, and other files keep their
// file card. A tap opens mediaViewer.js over the chat with every viewable
// item in the transcript. Looks live in static/css/media-viewer.css.

const ICON_EXPAND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const ICON_AUDIO = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
// The widest transcript around an item, so the gallery is the whole chat.
const SCOPES = ['[data-viewer-scope]', '#chat-messages', '[role="log"]', '.forge-transcript', '.msg'];

// Every viewable item around `node`, in transcript order, and where `node` sits.
export function galleryFor(node) {
  const owner = node.closest('[data-viewer-item]') || node;
  const parent = owner.parentElement;
  const scope = SCOPES.map(selector => parent?.closest(selector)).find(Boolean) || parent || owner;
  const items = [];
  let index = 0;
  for (const candidate of scope.querySelectorAll('[data-viewer-item]')) {
    const item = itemFromData(candidate.dataset);
    if (!item) continue;
    if (candidate === owner) index = items.length;
    const playing = candidate.querySelector('video, audio');
    if (playing && candidate === owner && playing.currentTime > 0) item.startAt = playing.currentTime;
    items.push(item);
  }
  if (!items.length) { const self = itemFromData(owner.dataset); if (self) items.push(self); }
  return { items, index };
}

export async function openGallery(node, opener = node) {
  const { items, index } = galleryFor(node);
  if (!items.length) return null;
  for (const media of document.querySelectorAll('.media-card video, .media-card audio')) if (!media.paused) media.pause();
  const { openMediaViewer } = await import('./mediaViewer.js');
  return openMediaViewer(items, index, { opener });
}

function openWith(node, event) {
  if (node._swipedAt && performance.now() - node._swipedAt < 400) return;
  if (event && (event.ctrlKey || event.metaKey) && node.dataset.viewerUrl && node.dataset.viewerSession) {
    import('./chatContent.js').then(m => m.openArtifact(node.dataset.viewerSession, node.dataset.viewerUrl, node.dataset.viewerName, node, { background: true }));
    return;
  }
  openGallery(node);
}

function imageCard(item) {
  const label = el('span', { class: 'media-card-label', text: item.name });
  const img = el('img', { src: item.src, alt: item.name, loading: 'lazy', decoding: 'async', draggable: 'false' });
  const card = el('button', { type: 'button', class: 'media-card media-card-image', 'aria-label': `Open ${item.name}`, ...itemData(item) }, [img, label]);
  img.addEventListener('load', () => { card.style.setProperty('--mv-aspect', String(cardAspect(img.naturalWidth, img.naturalHeight))); card.classList.add('is-loaded'); });
  img.addEventListener('error', () => card.classList.add('is-broken'));
  card.addEventListener('click', event => openWith(card, event));
  return card;
}

function expandButton(card, name) {
  const button = el('button', { type: 'button', class: 'media-card-expand', 'aria-label': `Open ${name} in the viewer`, title: 'Open in the viewer' });
  button.innerHTML = ICON_EXPAND;
  button.addEventListener('click', event => openWith(card, event));
  return button;
}

function videoCard(item) {
  const video = el('video', { src: item.src, controls: true, preload: 'metadata', playsinline: true, 'aria-label': item.name });
  const card = el('div', { class: 'media-card media-card-video', role: 'group', 'aria-label': `Video: ${item.name}`, ...itemData(item) }, [video]);
  card.append(expandButton(card, item.name));
  video.addEventListener('loadedmetadata', () => card.style.setProperty('--mv-aspect', String(cardAspect(video.videoWidth, video.videoHeight))));
  video.addEventListener('error', () => card.classList.add('is-broken'));
  return card;
}

function audioCard(item) {
  const glyph = el('span', { class: 'media-card-glyph', 'aria-hidden': 'true' });
  glyph.innerHTML = ICON_AUDIO;
  const audio = el('audio', { src: item.src, controls: true, preload: 'metadata', 'aria-label': item.name });
  const card = el('div', { class: 'media-card media-card-audio', role: 'group', 'aria-label': `Audio: ${item.name}`, ...itemData(item) }, [
    glyph, el('div', { class: 'media-card-audio-body' }, [el('span', { class: 'media-card-name', text: item.name }), audio]),
  ]);
  card.append(expandButton(card, item.name));
  return card;
}

// One media node per item. `reuse` (a Map kept on the message body) hands back
// the node a previous paint made, so a reply that re-renders on every token
// never reloads its pictures or stops a playing video.
export function inlineMedia(item, reuse = null, used = null) {
  const key = `${item.kind} ${item.src}`;
  const kept = reuse?.get(key);
  if (kept && !used?.has(key)) { used?.add(key); return kept; }
  const node = item.kind === 'video' ? videoCard(item) : item.kind === 'audio' ? audioCard(item) : imageCard(item);
  if (reuse && !used?.has(key)) { reuse.set(key, node); used?.add(key); }
  return node;
}

// A document's card (the long-standing .artifact-card look). A tap opens the
// viewer; Ctrl/Cmd-click and middle-click still open it in the Documents pane
// (`openInPane`, when the caller has it, does that at once).
export function fileCard(item, label = '', { openInPane = null } = {}) {
  const ext = extensionOf(item.name).toUpperCase() || 'FILE';
  const card = el('button', { type: 'button', class: 'artifact-card', 'aria-label': `Preview ${item.name}`, ...itemData(item) }, [
    el('span', { class: 'artifact-icon', text: ext.slice(0, 5) }),
    el('span', { class: 'artifact-info' }, [el('strong', { text: item.name }), el('span', { text: label && label !== item.name ? label : 'Generated file · Preview and download' })]),
    el('span', { class: 'artifact-arrow', text: '↗', 'aria-hidden': 'true' }),
  ]);
  const toPane = () => openInPane ? openInPane(item.sessionId, item.url, item.name, card, { background: true })
    : import('./chatContent.js').then(m => m.openArtifact(item.sessionId, item.url, item.name, card, { background: true }));
  card.addEventListener('click', event => {
    if ((event.ctrlKey || event.metaKey) && item.url && item.sessionId) toPane();
    else openWith(card);
  });
  card.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
  card.addEventListener('auxclick', event => {
    if (event.button !== 1 || !item.url || !item.sessionId) return;
    event.preventDefault(); toPane();
  });
  return card;
}

function stackOf(cards, state) {
  const count = cards.length;
  const deck = el('div', { class: 'media-stack-deck' }, cards);
  const counter = el('span', { class: 'media-stack-count', 'aria-live': 'polite' });
  const prev = el('button', { type: 'button', class: 'media-stack-step', 'aria-label': 'Previous image', text: '‹' });
  const next = el('button', { type: 'button', class: 'media-stack-step', 'aria-label': 'Next image', text: '›' });
  const root = el('div', { class: 'media-stack', role: 'group', 'aria-roledescription': 'stack', 'aria-label': `${count} images` }, [
    deck, el('div', { class: 'media-stack-nav' }, [prev, counter, next]),
  ]);
  let front = Math.min(state.front || 0, count - 1);
  const paint = () => {
    cards.forEach((card, i) => {
      const depth = (i - front + count) % count;
      card.dataset.depth = String(Math.min(depth, 3));
      card.tabIndex = depth ? -1 : 0;
      card.setAttribute('aria-hidden', String(!!depth));
    });
    counter.textContent = counterText(front, count);
    state.front = front;
  };
  const flip = delta => {
    const focused = cards.includes(document.activeElement);
    front = (front + delta + count) % count; paint();
    if (focused) cards[front].focus({ preventScroll: true });
  };
  prev.addEventListener('click', () => flip(-1));
  next.addEventListener('click', () => flip(1));
  deck.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); event.stopPropagation();
    flip(event.key === 'ArrowRight' ? 1 : -1);
  });
  // Swipe the stack in place (touch, pen or a mouse drag); a swipe is never a tap.
  let start = null;
  deck.addEventListener('pointerdown', event => { if (event.button === 0) start = { x: event.clientX, y: event.clientY, id: event.pointerId }; });
  deck.addEventListener('pointerup', event => {
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 36 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    const now = performance.now(); for (const card of cards) card._swipedAt = now;
    flip(dx < 0 ? 1 : -1);
  });
  deck.addEventListener('pointercancel', () => { start = null; });
  paint();
  return root;
}

const isBlank = node => node.nodeType === Node.TEXT_NODE ? !node.textContent.trim() : node.nodeName === 'BR';
const isMediaOnly = node => node.nodeName === 'P' && node.querySelector('.media-card')
  && [...node.childNodes].every(child => isBlank(child) || child.classList?.contains('media-card'));
const isMediaNode = node => node.classList?.contains('media-card') || isMediaOnly(node);

function groupOf(cards, stacks) {
  const group = el('div', { class: 'media-inline' });
  for (let i = 0; i < cards.length;) {
    if (cards[i].classList.contains('media-card-image')) {
      let end = i;
      while (end + 1 < cards.length && cards[end + 1].classList.contains('media-card-image')) end++;
      const run = cards.slice(i, end + 1);
      if (run.length === 1) group.append(run[0]);
      else {
        const key = run.map(card => card.dataset.viewerUrl || card.dataset.viewerSrc).join('|');
        if (!stacks.has(key)) stacks.set(key, {});
        group.append(stackOf(run, stacks.get(key)));
      }
      i = end + 1;
    } else { group.append(cards[i]); i++; }
  }
  return group;
}

// Media cards leave the paragraph they were written in and gather into
// groups: consecutive pictures become one stack, at the first one's place.
export function arrangeMedia(fragment, stacks = new Map()) {
  const cards = [...fragment.querySelectorAll('.media-card')];
  if (!cards.length) return;
  const lifted = new Map();
  for (const card of cards) {
    let block = card;
    while (block.parentNode && block.parentNode !== fragment) block = block.parentNode;
    if (block === card || isMediaOnly(block)) continue;
    const anchor = lifted.get(block) || block;
    anchor.after(card); lifted.set(block, card);
  }
  let run = [];
  const flush = () => {
    const nodes = run; run = [];
    while (nodes.length && isBlank(nodes.at(-1))) nodes.pop();
    if (!nodes.length) return;
    const found = nodes.flatMap(node => node.classList?.contains('media-card') ? [node] : [...(node.querySelectorAll?.('.media-card') || [])]);
    // Hold the place first: building the group moves the cards (the first node may be one).
    const place = document.createComment('media');
    nodes[0].before(place);
    place.replaceWith(groupOf(found, stacks));
    for (const node of nodes) if (!node.classList?.contains('media-card')) node.remove();
  };
  for (const node of [...fragment.childNodes]) {
    if (isMediaNode(node)) run.push(node);
    else if (run.length && node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) run.push(node);
    else flush();
  }
  flush();
}

// Under the pictures, the reply's "Sources:" links as cards (site and title).
// No remote thumbnails: the app loads no remote images.
export function addSourceCards(fragment) {
  const groups = [...fragment.querySelectorAll('.media-inline')];
  if (!groups.length) return;
  for (const block of fragment.querySelectorAll('p, li')) {
    if (!/^\s*sources?\s*:/i.test(block.textContent)) continue;
    const seen = new Set(), links = [];
    for (const link of block.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(link.getAttribute('href')); } catch { continue; }
      if (!/^https?:$/.test(url.protocol) || seen.has(url.href) || links.length >= 6) continue;
      seen.add(url.href); links.push({ url, title: link.textContent.trim() || url.hostname });
    }
    if (!links.length) continue;
    // The pictures the sources belong to: the last picture group before them, else the first.
    const pictures = groups.filter(group => group.querySelector('.media-card-image'));
    const before = pictures.filter(group => group.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING);
    const target = before.at(-1) || pictures[0] || groups[0];
    if (target.querySelector(':scope > .media-sources')) continue;
    target.append(el('div', { class: 'media-sources', role: 'list', 'aria-label': 'Sources' }, links.map(({ url, title }) =>
      el('a', { class: 'media-source', role: 'listitem', href: url.href, target: '_blank', rel: 'noopener noreferrer', title: url.href }, [
        el('span', { class: 'media-source-site', text: url.hostname.replace(/^www\./, '') }),
        el('span', { class: 'media-source-title', text: title }),
      ]))));
  }
}

// A message's own attachments (your uploads): pictures as cards or a stack,
// video and audio in place, other files as file cards.
export function attachmentMedia(items) {
  if (!items.length) return null;
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(item.kind === 'file' ? fileCard(item, 'Attachment · Preview and download') : inlineMedia(item));
  const wrap = el('div', { class: 'msg-attachments' });
  const files = [...fragment.querySelectorAll(':scope > .artifact-card')];
  arrangeMedia(fragment);
  wrap.append(fragment);
  for (const card of files) wrap.append(card);
  return wrap;
}

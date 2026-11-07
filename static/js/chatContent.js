import { api, el, toast, openOptionMenu, closeOptionMenu } from './api.js';
import { marked, DOMPurify, hljs } from './vendor/chat-vendor.js';
import { installDesignAutoOpen } from './designAutoOpen.js';
import { mountChatPane } from './chatPaneLayout.js';
import { desktopPanes } from './chatPaneStack.js';
import { openChatDesign, designPaneOpen } from './chatDesignPane.js';
import { mobileOn } from './mobileShared.js';
import { renderArtifact, loadingSkeleton } from './artifactViewer.js';
import { mountArtifactReview } from './artifactReview.js';
import { mountForeignReview } from './artifactForeignReview.js';
import { reviewsChanged } from './artifactReview.js';
import { inlineMedia, fileCard, arrangeMedia, addSourceCards } from './mediaInline.js';
import { mediaKind, isInlineMedia, contentURL } from './mediaItems.js';

const GENERATED = /^\/generated-(?:images|files)\/[^/?#]+$/;
const ARTIFACT_URL = /^(?:\/generated-(?:images|files)\/[^/?#]+|\/chat-files\/[a-f0-9]{24}|\/designs\/[a-f0-9]{12})$/;
// A design opens as a Design tab in this pane (designCanvas.js).
const DESIGN_URL = /^\/designs\/([a-f0-9]{12})$/;
const VIDEO_URL = /^\/videos\/([a-f0-9]{12})$/;
const TAGS = ['p', 'br', 'strong', 'em', 'del', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'input'];

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success'); }
  catch { toast('Clipboard unavailable. Select the text to copy it.', 'error'); }
}

// Live replies (David, 2026-10-07): a file card, code block or table that
// appears while a reply streams forms in halftone dots (chat.css
// .is-forming). Every paint re-renders the whole body, so each block's start
// time is kept on the body and its animation resumes where it was. Blocks
// in a reply that was already there (history) never animate.
const FORM_MS = 900;
function formBlocks(body, fragment, live) {
  const started = body._forming ??= new Map();
  const now = performance.now();
  const counts = {};
  for (const node of fragment.querySelectorAll('.artifact-card, .chat-code-block, .chat-table-wrap')) {
    const kind = node.classList[0];
    const key = kind + ' ' + (counts[kind] = (counts[kind] || 0) + 1);
    if (!started.has(key)) started.set(key, live ? now : -Infinity);
    const elapsed = now - started.get(key);
    if (elapsed < FORM_MS) { node.classList.add('is-forming'); node.style.animationDelay = `${-Math.round(elapsed)}ms`; }
  }
}

// Sanitize into a detached fragment BEFORE insertion. No remote image loads,
// raw HTML styles, event handlers, frames, IDs, or application-local links.
// `live`: the reply is streaming in now (see formBlocks).
export function highlightCode(code, raw, language = 'text') {
  code.textContent = raw;
  code.classList.add('hljs');
  if (raw.length < 100000 && hljs.getLanguage(language)) code.innerHTML = hljs.highlight(raw, { language, ignoreIllegals: true }).value;
}

// `remoteImage(url, alt)`: a caller that wants remote images offered rather
// than dropped (the Vault reader's click-to-load) returns the node to show.
export function renderMessageBody(body, text, sessionId, rich = true, { live = false, remoteImage = null } = {}) {
  body._rawText = text;
  body.classList.toggle('chat-prose', rich);
  if (!rich) { body.textContent = text; return; }
  const fragment = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }), {
    ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ['href', 'src', 'alt', 'class', 'type', 'checked', 'disabled', 'start'],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const node of fragment.querySelectorAll('[class]')) {
    const language = node.tagName === 'CODE' && [...node.classList].find(c => /^language-[a-z0-9_-]+$/i.test(c));
    node.removeAttribute('class');
    if (language) node.classList.add(language);
  }
  for (const input of fragment.querySelectorAll('input')) {
    input.type = 'checkbox'; input.disabled = true;
  }
  // Pictures, video and audio a reply links show in the message (the media
  // viewer, 2026-11-07). Their nodes survive re-paints while a reply streams.
  const reuse = body._media ??= new Map(), used = new Set();
  for (const node of fragment.querySelectorAll('a, img')) {
    const url = node.getAttribute(node.tagName === 'IMG' ? 'src' : 'href') || '';
    const label = node.tagName === 'IMG' ? node.getAttribute('alt') : node.textContent;
    if (GENERATED.test(url) && sessionId) {
      let filename;
      try { filename = decodeURIComponent(url.split('/').pop()).replace(/^[a-f0-9]{12}_/, ''); }
      catch { filename = 'Generated file'; }
      const kind = mediaKind(filename);
      const item = { kind, name: filename, url, sessionId, src: isInlineMedia(kind) ? contentURL(sessionId, url) : '' };
      node.replaceWith(isInlineMedia(kind) ? inlineMedia(item, reuse, used) : fileCard(item, label, { openInPane: openArtifact }));
    } else if (node.tagName === 'A' && VIDEO_URL.test(url) && sessionId) {
      const videoId = url.match(VIDEO_URL)[1];
      const title = (label || 'Video').replace(/^Video:\s*/, '');
      const detail = el('span', { text: 'Video' });
      const info = el('span', { class: 'artifact-info' }, [el('strong', { text: title }), detail]);
      const action = el('button', { type: 'button', class: 'btn', text: 'Open in Studio', style: 'min-height:44px', onclick: () => {
        document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: action.dataset.enabled === 'true' ? 'studio' : 'tool-store',
          videoId, category: 'Tabs', query: 'Studio' } }));
      } });
      action.disabled = true;
      const card = el('div', { class: 'artifact-card video-card-link', style: 'flex-wrap:wrap;max-width:100%;overflow:hidden' }, [info, action]);
      Promise.all([api(`/api/videos/${videoId}`), api('/api/system/custom-tabs')]).then(async ([p, tabs]) => {
        action.dataset.enabled = String(tabs.some(t => t.id === 'studio'));
        action.textContent = action.dataset.enabled === 'true' ? 'Open in Studio' : 'Turn on Studio';
        action.disabled = false;
        detail.textContent = `${p.beats.reduce((sum, b) => sum + b.bars, 0) * 240 / p.bpm} s · ${p.aspects.join(', ')}`;
        const image = el('iframe', { src: `/api/videos/${videoId}/player?aspect=${encodeURIComponent(p.aspects[0])}`, title: `First frame of ${p.title}`,
          sandbox: 'allow-scripts allow-same-origin', loading: 'lazy', style: 'width:160px;height:90px;max-width:100%;border:0;pointer-events:none' });
        image.addEventListener('load', () => { const w = image.contentWindow; w?.kdReady?.then(() => w.kdDrawFrame(.8)).catch(() => {}); });
        card.prepend(image);
        try {
          const resources = await api(`/api/tab-studio/videos/${videoId}/resources`);
          if (resources.thumbnail) image.replaceWith(el('img', { src: `/api/videos/${videoId}/renders/${resources.thumbnail}`, alt: `Thumbnail of ${p.title}`, style: 'width:160px;height:90px;max-width:100%;object-fit:contain' }));
          const file = resources.renders.filter(f => /\.mp4$/.test(f)).at(-1);
          if (file) card.append(el('button', { type: 'button', class: 'btn', text: 'Play video', style: 'min-height:44px', onclick: event => {
            event.currentTarget.replaceWith(el('video', { src: `/api/videos/${videoId}/renders/${file}`, controls: true, autoplay: true,
              'aria-label': `Play ${p.title}`, style: 'width:100%;max-height:280px' }));
          } }));
        } catch { /* A disabled tab may not have its helper routes mounted yet. */ }
      }).catch(() => { detail.textContent = 'Video · no longer available'; action.textContent = 'Video unavailable'; });
      node.replaceWith(card);
    } else if (node.tagName === 'A' && DESIGN_URL.test(url) && sessionId) {
      const designId = url.match(DESIGN_URL)[1];
      const title = (label || 'Design').replace(/^Design:\s*/, '');
      const detail = el('span', { text: 'Design · Open beside the chat' });
      const card = el('button', { type: 'button', class: 'artifact-card design-card-link', 'aria-label': `Open design ${title}`, onclick: () => openDesignTab(sessionId, designId, card) }, [
        el('span', { class: 'artifact-icon', text: 'DSGN' }),
        el('span', { class: 'artifact-info' }, [el('strong', { text: title }), detail]),
        el('span', { class: 'artifact-arrow', text: '↗', 'aria-hidden': 'true' }),
      ]);
      api(`/api/designs/${designId}`).then(d => { detail.textContent = `${d.title} · ${d.boards ? Object.keys(d.boards).length : 0} boards · Open`; }).catch(() => { detail.textContent = 'Design · no longer available'; });
      node.replaceWith(card);
    } else if (node.tagName === 'IMG' && remoteImage && /^https?:\/\//i.test(url)) {
      node.replaceWith(remoteImage(url, label || ''));
    } else if (node.tagName === 'IMG') {
      node.replaceWith(document.createTextNode(label || '[Image]'));
    } else if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer');
    } else {
      node.replaceWith(document.createTextNode(node.textContent));
    }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const wrap = el('div', { class: 'chat-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Response table' });
    table.replaceWith(wrap); wrap.append(table);
  }
  for (const code of fragment.querySelectorAll('pre > code')) {
    const raw = code.textContent;
    const language = [...code.classList].find(c => c.startsWith('language-'))?.slice(9) || 'text';
    highlightCode(code, raw, language);
    const pre = code.parentElement;
    const block = el('div', { class: 'chat-code-block' });
    pre.replaceWith(block);
    block.append(el('div', { class: 'chat-code-header' }, [
      el('span', { text: language }), el('button', { type: 'button', text: 'Copy code', onclick: () => copyText(raw) }),
    ]), pre);
  }
  if (used.size || reuse.size) {
    for (const key of [...reuse.keys()]) if (!used.has(key)) reuse.delete(key);
    arrangeMedia(fragment, body._mediaStacks ??= new Map());
    addSourceCards(fragment);
  }
  formBlocks(body, fragment, live);
  body.replaceChildren(fragment);
}

let viewer = null;
let nextTabId = 0;
let restored = false;
let restoring = false;
let context = { sessionId: null, sessions: [] };
const STORAGE_KEY = 'jarvis:artifact-pane';
const titleFor = id => context.sessions.find(session => session.id === id)?.title || 'another chat';
const goToChat = id => import('./views/chat.js').then(module => module.openSessionById(id));

function savePane() {
  if (!restored || restoring) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: (viewer?.tabs || []).slice(0, 20).map(tab => ({
      sessionId: tab.sessionId, url: tab.url, name: tab.name,
      comments: tab.foreign.comments, note: tab.foreign.note, queued: tab.foreign.queued,
    })), active: Math.max(0, viewer?.tabs.indexOf(viewer.active) ?? 0), maximized: !!viewer?.maximized }));
  } catch { /* Device storage is optional. */ }
}

export function setArtifactContext(sessionId, sessions = context.sessions) {
  context = { sessionId, sessions };
  document.dispatchEvent(new CustomEvent('kairos:chat-session', { detail: { sessionId } }));
  if (viewer) {
    for (const tab of viewer.tabs) {
      tab.origin.hidden = sessionId === tab.sessionId;
      if (tab.designComposer) tab.designComposer.root.hidden = sessionId === tab.sessionId;
      tab.origin.textContent = `from ${titleFor(tab.sessionId)}`;
      tab.foreignReview.update();
    }
    refreshArtifactVersions(viewer);
  }
  reviewsChanged();
}

// Unregister the layout, but keep each viewer/controller and its live DOM.
// State-preserving moves also keep iframe browsing contexts on Chromium.
const parking = () => {
  let node = document.getElementById('artifact-pane-parking');
  if (!node) { node = el('div', { id: 'artifact-pane-parking', hidden: true, inert: true }); document.body.append(node); }
  return node;
};
function movePanel(parent, panel) {
  if (parent.moveBefore && parent.isConnected && panel.isConnected) parent.moveBefore(panel, null);
  else parent.append(panel);
}
export function hideArtifact({ navigation = false } = {}) {
  if (!viewer) return;
  closeOptionMenu();
  const current = viewer;
  current.maximized = current.layout?.isMaximized() ?? current.maximized;
  const layout = current.layout; current.layout = null;
  // Park first: disposing the last stacked pane removes the shared root, which would detach the panel
  // (and reload an HTML iframe) before a state-preserving move.
  movePanel(parking(), current.panel);
  layout?.dispose();
  current.messageObserver?.disconnect();
  current.visible = !navigation ? false : current.visible && window.innerWidth > 1100;
  current.panel.classList.remove('artifact-panel', 'artifact-viewer');
  if (current.opener?.isConnected && !navigation) current.opener.focus({ preventScroll: true });
  savePane();
}
function attachViewer(current, host) {
  if (current.layout && current.panel.closest('.chat-layout') === host) return;
  // mountChatPane closes the prior pane; move the live document only after
  // that registration has released the region.
  current.panel.classList.add('artifact-panel', 'artifact-viewer');
  current.layout = mountChatPane(host, current.panel, hideArtifact);
  current.visible = true;
  current.layout.setMaximized(current.maximized);
  if (current.active) restoreScroll(current.active);
  const messages = host.querySelector('#chat-messages');
  current.messageObserver?.disconnect();
  if (messages) {
    current.messageObserver = new MutationObserver(() => {
      cancelAnimationFrame(current.versionFrame);
      current.versionFrame = requestAnimationFrame(() => refreshArtifactVersions(current));
    });
    current.messageObserver.observe(messages, { childList: true, subtree: true, characterData: true });
  }
}

export async function mountArtifactPane(host) {
  if (!restored) {
    restored = true;
    restoring = true;
    try {
      let saved;
      try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* Invalid or disabled storage. */ }
      let tabs = Array.isArray(saved?.tabs) ? saved.tabs.slice(0, 20).filter(tab => typeof tab?.sessionId === 'string' && typeof tab.name === 'string' && typeof tab.url === 'string' && tab.url.length <= 500 && ARTIFACT_URL.test(tab.url)) : [];
      if (desktopPanes(host) || mobileOn()) {
        const design = tabs.find(tab => DESIGN_URL.test(tab.url));
        tabs = tabs.filter(tab => !DESIGN_URL.test(tab.url));
        if (design && design.sessionId === context.sessionId) await openChatDesign(design.sessionId, design.url.match(DESIGN_URL)[1]);
      }
      if (tabs.length && !viewer) {
        const current = createViewer(host);
        current.maximized = !!saved.maximized;
        if (window.innerWidth <= 1100) hideArtifact({ navigation: true });
        for (const tab of tabs) addTab(current, tab.sessionId, tab.url, tab.name, tab);
        const preferred = current.tabs[Math.min(Math.max(0, Math.floor(Number(saved.active) || 0)), current.tabs.length - 1)];
        // Metadata validates all saved tabs in one batch; inactive renderers
        // remain lazy. Transient failures retain the tab for a later retry.
        let removed = 0;
        await Promise.all(current.tabs.slice().map(async tab => {
          try {
            if (DESIGN_URL.test(tab.url)) await api(`/api/designs/${tab.url.match(DESIGN_URL)[1]}`);
            else await api(`/api/chat/artifacts?${new URLSearchParams({ session_id: tab.sessionId, url: tab.url })}`);
            if (current.tabs.includes(tab)) tab.foreignReview.resume();
          }
          catch (error) { if (/^(400|404):/.test(error.message) && current.tabs.includes(tab)) { removed++; closeTab(current, tab); } }
        }));
        if (removed) toast(`${removed} saved document${removed === 1 ? '' : 's'} removed because ${removed === 1 ? 'it is' : 'they are'} no longer available.`);
        if (viewer === current) {
          activateTab(current, current.tabs.includes(preferred) ? preferred : current.tabs[0]);
          current.layout?.setMaximized(current.maximized);
          if (window.innerWidth <= 1100) hideArtifact({ navigation: true });
        }
      }
    } finally { restoring = false; }
  } else if (viewer?.visible && window.innerWidth > 1100) attachViewer(viewer, host);
  setArtifactContext(context.sessionId);
  savePane();
}

export function showArtifactPane(opener) {
  const host = document.querySelector('.chat-layout');
  if (!host) return;
  const current = viewer || createViewer(host, null, opener);
  attachViewer(current, host);
  if (!current.tabs.length) openArtifactMenu(current.plus);
  else { ensureRendered(current.active); current.panel.focus({ preventScroll: true }); }
}

async function openArtifactMenu(anchor) {
  const menu = openOptionMenu(anchor, [{ heading: 'Loading files…' }], () => {});
  const search = el('input', { type: 'search', class: 'documents-menu-search', placeholder: 'Find a file…', 'aria-label': 'Find a file' });
  menu.prepend(search); menu.classList.add('artifact-open-menu'); menu.setAttribute('aria-label', 'Open a document');
  const width = Math.min(360, window.innerWidth - 24);
  menu.style.left = `${Math.max(12, Math.min(anchor.getBoundingClientRect().left, window.innerWidth - width - 12))}px`;
  search.focus();
  const rows = el('div'); menu.append(rows);
  const origin = context.sessionId;
  const results = await Promise.allSettled([origin ? api(`/api/chat/files?session_id=${encodeURIComponent(origin)}`) : Promise.resolve([]), api('/api/chat/files/library')]);
  if (!menu.isConnected) return;
  menu.querySelector('.custom-select-heading')?.remove();
  const local = results[0].status === 'fulfilled' ? results[0].value : [];
  const groups = results[1].status === 'fulfilled' ? results[1].value : [];
  const paint = () => {
    rows.replaceChildren();
    const query = search.value.toLowerCase().trim();
    for (const group of [{ session_id: origin, title: 'This chat', files: local }, ...groups.filter(group => group.session_id !== origin)]) {
      const files = group.files.filter(file => file.exists && `${file.name} ${group.title}`.toLowerCase().includes(query));
      if (!files.length) continue;
      rows.append(el('div', { class: 'custom-select-heading', text: group.title }));
      for (const file of files) rows.append(el('button', { type: 'button', role: 'option', class: 'custom-select-item', text: file.name, onclick: () => {
        closeOptionMenu(); openArtifact(group.session_id, file.url, file.name, anchor);
      } }));
    }
    if (!rows.children.length) rows.append(el('div', { class: 'meta', text: results.every(result => result.status === 'rejected') ? 'Could not load files. Try again.' : 'No files match this search.' }));
  };
  search.addEventListener('input', paint); paint();
}

export function closeArtifact() {
  if (!viewer) return;
  const current = viewer;
  viewer = null;
  for (const tab of current.tabs) { tab.foreignReview.dispose(); tab.review?.dispose(); tab.controller.abort(); }
  current.layout?.dispose(); current.panel.remove();
  current.disposePhoneChrome?.();
  current.messageObserver?.disconnect();
  cancelAnimationFrame(current.versionFrame);
  document.removeEventListener('keydown', current.onKey);
  if (current.opener?.isConnected) current.opener.focus({ preventScroll: true });
  savePane();
}

function activateTab(current, active, focus = false) {
  current.active = active;
  for (const tab of current.tabs) {
    const selected = tab === active;
    tab.button.setAttribute('aria-selected', String(selected));
    tab.button.tabIndex = selected ? 0 : -1;
    tab.row.classList.toggle('active', selected);
    tab.container.hidden = !selected;
    tab.container.inert = !selected;
  }
  current.panel.setAttribute('aria-label', `File preview: ${active.name}`);
  active.header.append(current.controls);
  current.syncPhoneChrome?.();
  restoreScroll(active);
  if (current.layout) ensureRendered(active);
  if (focus) active.button.focus({ preventScroll: true });
  active.row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  savePane();
}

// Synchronous, right as the tab becomes visible: restoring a frame later
// fires a scroll event after the user may already have opened a menu, and
// app menus close on any outside scroll.
function restoreScroll(tab) {
  const offset = tab.scrollOffset();
  if (offset && tab.content.offsetParent && tab.content.scrollTop !== offset) tab.content.scrollTop = offset;
}

function ensureRendered(tab) {
  if (!tab.ready) tab.ready = DESIGN_URL.test(tab.url) ? renderDesignTab(tab) : renderArtifact(tab);
  return tab.ready;
}

// A design in the Documents pane: the canvas, compact. Selections become chips
// in this chat's composer when the design belongs to this chat; otherwise they
// go to the tab's own composer, which sends to the design's linked chat.
async function renderDesignTab(tab) {
  const [{ mountDesignCanvas }, { mountDesignComposer }, { reviewComposer }] = await Promise.all([
    import('./designCanvas.js'), import('./designComposer.js'), import('./artifactReview.js')]);
  tab.content.replaceChildren();
  tab.content.classList.add('design-pane-content');
  const designId = tab.url.match(DESIGN_URL)[1];
  let local = null;
  const ownChat = () => { const c = reviewComposer(); return c && c.sessionId() === tab.sessionId ? c : null; };
  const toComposer = (item, previous) => {
    const main = ownChat();
    if (main) { if (item) main.add(item, previous); return; }
    local.setSelection(item, previous);
  };
  const canvas = mountDesignCanvas(tab.content, {
    designId, compact: true,
    onSelection: toComposer,
    onComments: items => { const main = ownChat(); if (main) items.forEach(item => main.add(item)); else local.addComments(items); },
    onLoaded: data => { tab.detail.textContent = `Design · ${Object.keys(data.boards).length} boards · v${data.version}`; },
  });
  local = mountDesignComposer(tab.content, {
    getSession: () => ({ id: tab.sessionId, title: titleFor(tab.sessionId) }),
    onOpenChat: () => goToChat(tab.sessionId),
  });
  local.root.classList.add('design-pane-composer');
  // Beside its own chat, the chat's composer takes the chips; elsewhere this one does.
  tab.designComposer = local; local.root.hidden = context.sessionId === tab.sessionId;
  tab.actions.append(el('button', { type: 'button', class: 'btn quiet', text: 'Open in Library', onclick: () =>
    document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'library', section: 'designs', designId } })) }));
  tab.content.viewerRoot = canvas.root;
  tab.design = canvas;
  const dispose = () => { canvas.dispose(); local.dispose(); };
  tab.controller.signal.addEventListener('abort', dispose, { once: true });
  await canvas.ready;
  return canvas.root;
}

export async function openDesignTab(sessionId, designId, opener, options = {}) {
  const host = document.querySelector('.chat-layout');
  if (host && (desktopPanes(host) || mobileOn())) {
    // Mount the design beside the placeholder first and drop the placeholder after, so the shared root never
    // empties: tearing it down would reflow the chat at full width and the browser's scroll anchoring would
    // move the reader before the width observer could restore their place.
    const opening = openChatDesign(sessionId, designId);
    if (viewer?.empty.dataset.designPending) hideArtifact();
    return opening;
  }
  let title = 'Design';
  try { title = (await api(`/api/designs/${designId}`)).title || title; } catch { toast('That design is no longer available.', 'error'); return; }
  await openArtifact(sessionId, `/designs/${designId}`, title, opener, options);
}

// The pane opens with the design as soon as it exists (designAutoOpen.js).
const PENDING_TEXT = 'Starting the design. Its boards appear here as the model makes them.';
installDesignAutoOpen({
  currentSession: () => document.querySelector('.chat-layout') ? context.sessionId : null,
  isOpen: (sessionId, designId) => designPaneOpen(sessionId, designId) || !!viewer?.tabs.some(tab => tab.url === `/designs/${designId}`),
  openDesign: (sessionId, designId) => openDesignTab(sessionId, designId, null, { quiet: true }).catch(() => {}),
  showPlaceholder(sessionId) {
    const host = document.querySelector('.chat-layout');
    if (!host || viewer?.tabs.length) return;
    const current = viewer || createViewer(host, sessionId, null);
    attachViewer(current, host);
    current.empty.dataset.designPending = sessionId;
    current.empty.querySelector('h2').textContent = 'Design';
    current.empty.querySelector('p').textContent = PENDING_TEXT;
  },
  clearPlaceholder(sessionId) {
    if (viewer?.empty.dataset.designPending !== sessionId) return;
    delete viewer.empty.dataset.designPending;
    viewer.empty.querySelector('h2').textContent = 'Documents';
    viewer.empty.querySelector('p').textContent = 'Use + to open a document.';
    if (!viewer.tabs.length) hideArtifact();
  },
});

function closeTab(current, tab) {
  const index = current.tabs.indexOf(tab);
  if (index < 0) return;
  const hadFocus = tab.row.contains(document.activeElement) || tab.container.contains(document.activeElement);
  tab.foreignReview.dispose(); tab.review?.dispose(); tab.controller.abort(); tab.container.remove(); tab.row.remove();
  current.tabs.splice(index, 1);
  if (!current.tabs.length) { current.active = null; closeArtifact(); return; }
  if (current.active === tab) activateTab(current, current.tabs[Math.min(index, current.tabs.length - 1)], hadFocus);
  else if (hadFocus) current.active.button.focus({ preventScroll: true });
  savePane();
}

function createViewer(host, sessionId, opener) {
  const tabs = [];
  const strip = el('div', { class: 'artifact-tabs', role: 'tablist', 'aria-label': 'Open artifacts' });
  const maximize = el('button', { type: 'button', class: 'btn quiet artifact-maximize', text: 'Maximize',
    'aria-label': 'Maximize file preview', 'aria-pressed': 'false' });
  const close = el('button', { type: 'button', class: 'btn quiet', text: '×', 'aria-label': 'Close file preview', onclick: hideArtifact });
  const panel = el('aside', { class: 'artifact-panel artifact-viewer', role: 'region', tabindex: '-1', 'aria-label': 'File preview' }, [
    el('div', { class: 'artifact-pane-top' }, [strip]),
  ]);
  // Each tab has its own header, toolbar and preview body. The shared header
  // controls sit next to its title when the tab is activated.
  const controls = el('div', { class: 'artifact-header-controls' }, [maximize, close]);
  const plus = el('button', { type: 'button', class: 'btn quiet artifact-tab-add', text: '+', 'aria-label': 'Open another document', onclick: () => openArtifactMenu(plus) });
  strip.append(plus);
  const empty = el('div', { class: 'artifact-empty' }, [
    el('header', { class: 'artifact-header' }, [el('h2', { text: 'Documents' }), controls]),
    el('p', { class: 'meta', text: 'Use + to open a document.' }),
  ]);
  panel.append(empty);
  const current = { panel, strip, tabs, opener, controls, plus, empty, visible: true, maximized: false, transcripts: new Map(), completedEntries: new Map() };
  // On phones the document title precedes its tabs, as on ChatDocument.
  // Move the live strip so selection, keyboard navigation and downloads keep
  // their existing controllers. Restore its desktop home on resize/Classic.
  const stripHome = panel.firstElementChild;
  const phone = matchMedia('(max-width: 768px)');
  current.syncPhoneChrome = () => {
    const on = phone.matches;
    const active = current.active;
    if (on && active) active.header.after(stripHome);
    else if (stripHome.parentElement !== panel) panel.prepend(stripHome);
  };
  phone.addEventListener('change', current.syncPhoneChrome);
  document.addEventListener('kairos:appearance', current.syncPhoneChrome);
  current.disposePhoneChrome = () => {
    phone.removeEventListener('change', current.syncPhoneChrome);
    document.removeEventListener('kairos:appearance', current.syncPhoneChrome);
  };
  attachViewer(current, host);
  maximize.onclick = () => current.layout.setMaximized(!current.layout.isMaximized());
  panel.addEventListener('pane-maximize', event => {
    maximize.textContent = event.detail ? 'Restore' : 'Maximize';
    maximize.setAttribute('aria-label', event.detail ? 'Restore chat and file preview' : 'Maximize file preview');
    maximize.setAttribute('aria-pressed', String(event.detail));
    if (current.layout) { current.maximized = event.detail; savePane(); }
  });
  current.onKey = event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const focusedPane = event.target.closest?.('.chat-stacked-pane');
    if (focusedPane && focusedPane !== current.panel) return;
    if (!current.layout || !current.panel.isConnected) return;
    event.preventDefault();
    if (current.active?.review?.leave()) return;
    if (current.layout.isMaximized()) current.layout.setMaximized(false);
    else hideArtifact();
  };
  document.addEventListener('keydown', current.onKey);
  viewer = current;
  return current;
}

function originalArtifactName(url) {
  try { return decodeURIComponent(url.split('/').pop()).replace(/^[a-f0-9]{12}_/, ''); }
  catch { return url; }
}

// The client's message bodies retain the exact source in _rawText, both for
// loaded history and streaming replies. Walk transcript order, deduplicate
// repeated links, and observe only the transcript (no polling/new endpoint).
function refreshArtifactVersions(current) {
  const urls = [];
  const messages = document.querySelector('.chat-layout #chat-messages');
  for (const body of messages?.querySelectorAll('.msg.assistant .msg-body') || []) {
    for (const match of (body._rawText || '').matchAll(/!?\[[^\]]*\]\(<?(\/generated-(?:images|files)\/[^\s)>]+)>?\)/g)) {
      if (!urls.includes(match[1])) urls.push(match[1]);
    }
  }
  for (const tab of current.tabs) {
    const source = tab.sessionId === context.sessionId && messages?.dataset.sessionId === tab.sessionId ? urls : current.transcripts.get(tab.sessionId) || [];
    const name = tab.url.startsWith('/chat-files/') ? tab.content.artifact?.filename || tab.name : originalArtifactName(tab.url);
    const versions = source.filter(url => originalArtifactName(url) === name);
    if (!versions.includes(tab.url)) versions.unshift(tab.url);
    const changed = !tab.versions || tab.versions.length !== versions.length || tab.versions.some((url, index) => url !== versions[index]);
    tab.versions = versions;
    tab.versionPicker.hidden = versions.length < 2;
    if (changed) tab.versionPicker.replaceChildren(...versions.map((url, index) => el('option', { value: url, text: `v${index + 1}` })));
    tab.versionPicker.value = tab.url;
    tab.newer.hidden = versions.indexOf(tab.url) >= versions.length - 1;
  }
}

async function fetchOriginVersions(current, sessionId, force = false) {
  const ticket = {};
  current.versionRequests ??= new Map();
  if (!force && current.versionRequests.has(sessionId)) return;
  current.versionRequests.set(sessionId, ticket);
  try {
    const session = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (viewer !== current || current.versionRequests.get(sessionId) !== ticket) return;
    const urls = [];
    for (const message of session.messages || []) {
      if (message.role !== 'assistant') continue;
      for (const url of [...(message.artifact_urls || []), ...[...(message.content || '').matchAll(/!?\[[^\]]*\]\(<?(\/generated-(?:images|files)\/[^\s)>]+)>?\)/g)].map(match => match[1])]) {
        if (GENERATED.test(url) && !urls.includes(url)) urls.push(url);
      }
    }
    current.transcripts.set(sessionId, urls); refreshArtifactVersions(current);
  } catch { /* A transient transcript failure must not discard documents. */ }
  finally { if (current.versionRequests.get(sessionId) === ticket) current.versionRequests.delete(sessionId); }
}

async function switchArtifactVersion(current, tab, url) {
  if (url === tab.url) return;
  const existing = current.tabs.find(other => other !== tab && other.url === url && other.sessionId === tab.sessionId);
  if (existing) { activateTab(current, existing, true); refreshArtifactVersions(current); return; }
  tab.controller.abort(); tab.content._disposeRenderer?.();
  tab.controller = new AbortController(); tab.url = url; tab.content.viewerRoot = null;
  tab.actions.replaceChildren(tab.newer);
  tab.container.dispatchEvent(new CustomEvent('artifact-version', { bubbles: true, detail: { url } }));
  refreshArtifactVersions(current);
  tab.ready = renderArtifact(tab);
  savePane();
  await tab.ready;
}

export async function openArtifact(sessionId, url, name, opener, { background = false, quiet = false } = {}) {
  const host = document.querySelector('.chat-layout');
  if (!host) return;
  const current = viewer || createViewer(host, sessionId, opener);
  attachViewer(current, host);
  current.opener = opener || current.opener;
  const existing = current.tabs.find(tab => tab.url === url && tab.sessionId === sessionId);
  if (existing) { if (!background) activateTab(current, existing, !quiet); await existing.ready; return; }
  if (current.tabs.length >= 20) { toast('Keep at most 20 documents open. Close a tab to open another.'); return; }
  const tab = addTab(current, sessionId, url, name);
  tab.foreignReview.resume();
  if (!background || !current.active) {
    activateTab(current, tab);
    // Opened for you (a design as it is made) keeps your focus where it is.
    if (!quiet) current.controls.querySelector('[aria-label="Close file preview"]').focus({ preventScroll: true });
  }
  savePane();
  await tab.ready;
}

function addTab(current, sessionId, url, name, saved = {}) {
  const comments = (Array.isArray(saved.comments) ? saved.comments : []).slice(0, 10).filter(item =>
    item?.kind === 'artifact_comment' && typeof item.url === 'string' && item.url.length <= 500 && ARTIFACT_URL.test(item.url)
    && typeof item.comment === 'string' && item.comment.trim() && item.comment.length <= 4000 && typeof item.label === 'string'
    && Array.isArray(item.picks) && item.picks.length > 0 && item.picks.length <= 50
    && item.picks.every(pick => typeof pick === 'string' && pick.length <= 300)
  ).map(item => ({ kind: 'artifact_comment', url: item.url, comment: item.comment, label: item.label, picks: [...item.picks] }));
  // A send queued before a restart comes back as a draft: it never fires on
  // its own at startup, possibly hours later. The user presses Send again.
  const interrupted = !!saved.queued && !!comments.length;
  saved = { comments, note: typeof saved.note === 'string' ? saved.note.slice(0, 16000) : '', queued: false,
    status: interrupted ? 'Not sent: the app closed before these could send. Press Send.' : '' };
  if (GENERATED.test(url)) name = name.replace(/^[a-f0-9]{12}_/, '');
  else if (DESIGN_URL.test(url) && !/^Design/.test(name)) name = `Design: ${name}`;
  const id = `artifact-tab-${++nextTabId}`;
  const controller = new AbortController();
  const detail = el('span', { class: 'artifact-detail', text: 'Document preview' });
  const content = el('div', { class: 'artifact-preview', 'aria-live': 'polite' });
  loadingSkeleton(content);
  // A hidden or parked tab loses its scroll offset (display: none), so keep
  // the last one seen while visible and put it back when the tab shows again.
  let scroll = 0;
  content.addEventListener('scroll', () => { if (content.offsetParent) scroll = content.scrollTop; }, { passive: true });
  const actions = el('div', { class: 'artifact-toolbar' });
  const origin = el('button', { type: 'button', class: 'btn quiet artifact-origin', text: `from ${titleFor(sessionId)}`, hidden: sessionId === context.sessionId, onclick: () => goToChat(sessionId) });
  const header = el('header', { class: 'artifact-header' }, [el('div', {}, [el('h2', { text: name }), origin, detail])]);
  const container = el('div', { class: 'artifact-tab-panel', id: `${id}-panel`, role: 'tabpanel', 'aria-labelledby': id }, [header, actions, content]);
  const button = el('button', { type: 'button', class: 'artifact-tab-label', id, role: 'tab',
    text: name, title: name, 'aria-controls': container.id });
  const close = el('button', { type: 'button', class: 'artifact-tab-close', text: '×', 'aria-label': `Close ${name}` });
  const row = el('div', { class: 'artifact-tab', role: 'presentation' }, [button, close]);
  const versionPicker = el('select', { class: 'artifact-version-picker', 'aria-label': `Version of ${name}`, hidden: true });
  const newer = el('button', { type: 'button', class: 'btn quiet', text: 'Newer version', hidden: true });
  const tab = { sessionId, url, name, controller, container, content, actions, detail, header, button, row, versionPicker, newer, origin, scrollOffset: () => scroll };
  tab.onError = error => {
    if (!/^(400|404):/.test(error.message) || !current.tabs.includes(tab)) return;
    closeTab(current, tab);
    current.removed = (current.removed || 0) + 1;
    clearTimeout(current.removalToast);
    current.removalToast = setTimeout(() => {
      toast(`${current.removed} document${current.removed === 1 ? '' : 's'} removed because ${current.removed === 1 ? 'it is' : 'they are'} no longer available.`);
      current.removed = 0;
    }, 100);
  };
  tab.foreignReview = mountForeignReview(tab, {
    title: () => titleFor(sessionId), openChat: () => goToChat(sessionId), save: savePane,
    completed: entry => {
      if (current.completedEntries.get(sessionId) === entry) return;
      current.completedEntries.set(sessionId, entry);
      fetchOriginVersions(current, sessionId, true);
    },
  }, saved);
  tab.review = DESIGN_URL.test(url) ? null : mountArtifactReview(tab);
  row.insertBefore(versionPicker, close); actions.append(newer);
  versionPicker.onchange = () => switchArtifactVersion(current, tab, versionPicker.value);
  newer.onclick = () => switchArtifactVersion(current, tab, tab.versions.at(-1));
  button.onclick = () => activateTab(current, tab);
  close.onclick = () => closeTab(current, tab);
  row.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
  row.addEventListener('auxclick', event => {
    if (event.button === 1) { event.preventDefault(); closeTab(current, tab); }
  });
  button.addEventListener('keydown', event => {
    if (event.key === 'Delete') { event.preventDefault(); close.click(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = current.tabs.indexOf(tab), count = current.tabs.length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
    activateTab(current, current.tabs[next], true);
  });
  current.tabs.push(tab); current.strip.insertBefore(row, current.plus); current.panel.append(container);
  current.empty.hidden = true;
  container.hidden = true; container.inert = true;
  refreshArtifactVersions(current);
  if (!current.transcripts.has(sessionId)) fetchOriginVersions(current, sessionId);
  return tab;
}

export async function openArtifactComment(sessionId, item, opener) {
  const filename = item.url.startsWith('/chat-files/') ? item.label?.split(' · ')[0] || 'Chat file' : originalArtifactName(item.url);
  await openArtifact(sessionId, item.url, filename, opener);
  viewer?.tabs.find(tab => tab.url === item.url && tab.sessionId === sessionId)?.review?.edit(item);
}

// Attachments for a Bots conversation (Phase 1, U3): staging uploads for the
// composer, and the gallery and preview under a sent message.
//
// Uploads use the app's existing staging (POST /api/chat/attachments) and the
// existing exact-session file read (/api/chat/images/<session>/<id>). Nothing
// persists a blob URL, and every one made here is revoked on dispose.
import { h } from './botsMessageActions.js';
import { icon } from './botsIcons.js';

export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MEDIA_MIME = ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg'];
export const IMAGE_MAX = 10 * 1024 * 1024, FILE_MAX = 25 * 1024 * 1024, MAX_STAGED = 10;
export const PASTE_CHARS = 900, PASTE_LINES = 12;
const RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];

export const isImageName = name => /\.(png|jpe?g|gif|webp)$/i.test(name || '');
export const formatSize = bytes => !Number.isFinite(bytes) ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
// Long pasted text becomes a file chip instead of flooding the editor.
export const shouldChipPaste = text => String(text || '').length > PASTE_CHARS || String(text || '').split('\n').length > PASTE_LINES;

// Returns an error sentence, or '' when the file may be staged.
export function validateFile(file) {
  if (!file || !file.size) return 'That file is empty.';
  const image = String(file.type || '').startsWith('image/');
  if (image && !IMAGE_MIME.includes(file.type)) return 'Images must be PNG, JPEG, GIF or WebP.';
  if (image && file.size > IMAGE_MAX) return 'Images can be up to 10 MB.';
  if (file.size > FILE_MAX) return 'Files can be up to 25 MB.';
  return '';
}

// The uploader the composer holds. Items: { key, name, size, type, state: 'uploading'|'ready'|'failed', id, preview, error }.
// `upload(file)` resolves to the staged record ({ id, name }) or throws an error with .status.
export function createUploader({ upload, onChange = () => {}, makePreview = file => URL.createObjectURL(file), revoke = url => URL.revokeObjectURL(url), initialIds = [] }) {
  let items = initialIds.map(id => ({ key: `kept-${id}`, id, name: 'Earlier attachment', state: 'ready' })), counter = 0, disposed = false;
  const previews = new Set();
  const emit = () => { if (!disposed) onChange(items.map(item => ({ ...item }))); };
  async function attempt(file) {
    try { return await upload(file); }
    catch (error) { if (RETRY_STATUS.includes(error?.status)) return upload(file); throw error; }
  }
  async function add(files) {
    const room = MAX_STAGED - items.length;
    const list = [...files].slice(0, Math.max(0, room));
    const problems = [];
    if (files.length > list.length) problems.push(`You can attach up to ${MAX_STAGED} files.`);
    await Promise.all(list.map(async file => {
      const refusal = validateFile(file);
      if (refusal) { problems.push(`${file.name || 'File'}: ${refusal}`); return; }
      const item = { key: `up-${++counter}`, name: file.name || 'file', size: file.size, type: file.type || '', state: 'uploading', id: null, preview: null, error: '' };
      if (item.type.startsWith('image/')) { try { item.preview = makePreview(file); previews.add(item.preview); } catch { /* A preview is optional. */ } }
      items.push(item); emit();
      try { const staged = await attempt(file); if (disposed) return; item.id = staged.id; item.name = staged.name || item.name; item.state = 'ready'; }
      catch (error) { item.state = 'failed'; item.error = error?.message || 'The upload failed.'; problems.push(`${item.name}: ${item.error}`); }
      emit();
    }));
    return problems;
  }
  return {
    add,
    items: () => items.map(item => ({ ...item })),
    ids: () => items.filter(item => item.state === 'ready' && item.id).map(item => item.id),
    // Submission waits for this: an upload in flight can neither be sent nor lost.
    busy: () => items.some(item => item.state === 'uploading'),
    remove(key) { const found = items.find(item => item.key === key); if (found?.preview) { revoke(found.preview); previews.delete(found.preview); } items = items.filter(item => item !== found); emit(); },
    // After a send is accepted only the files it carried leave; anything added meanwhile stays.
    removeIds(ids) { const gone = new Set(ids); for (const item of items.filter(i => gone.has(i.id))) { if (item.preview) { revoke(item.preview); previews.delete(item.preview); } } items = items.filter(i => !gone.has(i.id)); emit(); },
    clear() { for (const url of previews) revoke(url); previews.clear(); items = []; emit(); },
    dispose() { disposed = true; for (const url of previews) revoke(url); previews.clear(); },
  };
}

// -- Gallery under a sent message ------------------------------------------------
export const galleryLimit = beneath => (beneath ? 6 : 4);
export function galleryItems(attachments, { expanded = false, beneath = false } = {}) {
  const all = Array.isArray(attachments) ? attachments : [];
  const limit = galleryLimit(beneath);
  return { shown: expanded ? all : all.slice(0, limit), hidden: expanded ? 0 : Math.max(0, all.length - limit) };
}
export const kindOf = att => IMAGE_MIME.includes(att.mime) || (!att.mime && isImageName(att.name)) ? 'image'
  : MEDIA_MIME.includes(att.mime) ? (att.mime.startsWith('video/') ? 'video' : 'audio') : 'file';
// The aspect ratio of a thumbnail is clamped so a tall or wide image keeps the row tidy.
export const clampAspect = ratio => Math.min(2.4, Math.max(0.6, Number.isFinite(ratio) && ratio > 0 ? ratio : 4 / 3));
export const fileUrl = (sessionId, att) => `/api/chat/images/${encodeURIComponent(sessionId)}/${encodeURIComponent(att.id)}`;

export function attachmentGallery(attachments, { sessionId, beneath = false, load = url => fetch(url) } = {}) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  const root = h('div', { class: 'bots-gallery' });
  const blobs = new Set();
  let expanded = false;
  const preview = start => openPreview(attachments.filter(a => kindOf(a) === 'image'), attachments.filter(a => kindOf(a) === 'image').indexOf(start), sessionId);
  const draw = () => {
    const { shown, hidden } = galleryItems(attachments, { expanded, beneath });
    root.replaceChildren(...shown.map(att => tile(att)), ...(hidden ? [h('button', { type: 'button', class: 'bots-btn bots-gallery-more', text: `${hidden} more`, onclick: () => { expanded = true; draw(); } })] : []));
  };
  function tile(att) {
    const kind = kindOf(att), label = att.name || 'Attachment';
    if (kind === 'image' && sessionId && att.id) {
      const img = h('img', { src: fileUrl(sessionId, att), alt: label, loading: 'lazy', decoding: 'async' });
      img.addEventListener('load', () => { img.parentElement.style.aspectRatio = String(clampAspect(img.naturalWidth / img.naturalHeight)); });
      return h('button', { type: 'button', class: 'bots-gallery-image', 'aria-label': `Open ${label}`, onclick: () => preview(att) }, [img]);
    }
    if ((kind === 'video' || kind === 'audio') && sessionId && att.id) {
      const slot = h('div', { class: 'bots-gallery-media' });
      const play = h('button', { type: 'button', class: 'bots-btn', text: `Load ${kind}: ${label}`, onclick: async () => {
        play.disabled = true;
        try {
          const res = await load(fileUrl(sessionId, att));
          if (!res.ok) throw new Error(`Could not load (${res.status})`);
          const blob = await res.blob();
          if (!MEDIA_MIME.includes(blob.type) || blob.size > FILE_MAX) throw new Error('That file cannot be played here.');
          const url = URL.createObjectURL(blob); blobs.add(url);
          slot.replaceChildren(h(kind, { src: url, controls: true, 'aria-label': label }));
        } catch (problem) { play.disabled = false; play.textContent = problem.message || 'Could not load'; }
      } });
      slot.append(play); return slot;
    }
    return h('span', { class: 'bots-file-chip' }, [icon('paperclip', { size: 14 }), h('span', { class: 'bots-file-name', text: label }), att.size ? h('span', { class: 'bots-file-size', text: formatSize(att.size) }) : null]);
  }
  draw();
  root.dispose = () => { for (const url of blobs) URL.revokeObjectURL(url); blobs.clear(); };
  return root;
}

// Preview: the app's one media viewer (mediaViewer.js, 2026-11-07), with this
// message's pictures: n of N, arrows and swipe, zoom, Save, a focus trap.
export function openPreview(images, start, sessionId) {
  if (!images.length || start < 0) return null;
  const opener = document.activeElement;
  const items = images.map(att => ({ kind: 'image', name: att.name || 'Attachment', src: fileUrl(sessionId, att), url: '', sessionId: '' }));
  const viewer = import('./mediaViewer.js').then(m => m.openMediaViewer(items, start, { opener }));
  return { close: () => viewer.then(v => v?.close()) };
}

// The composer's strip of staged files: remove buttons, upload state and errors.
export function stagedStrip(items, { remove, disabled = false } = {}) {
  return items.map(item => h('div', { class: `bots-staged ${item.state}`, 'data-key': item.key }, [
    item.preview ? h('img', { src: item.preview, alt: '' }) : icon('paperclip', { size: 14 }),
    h('span', { class: 'bots-staged-name', text: item.name }),
    item.state === 'uploading' ? h('span', { class: 'bots-staged-state', text: 'Uploading' }) : null,
    item.state === 'failed' ? h('span', { class: 'bots-staged-state error', role: 'alert', text: item.error || 'Failed' }) : null,
    h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': `Remove ${item.name}`, disabled, onclick: () => remove?.(item.key) }, [icon('x', { size: 14 })]),
  ]));
}

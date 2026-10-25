// The notch's drop zone (Kairos Notch build spec, 4a and phase 3), drawn to
// the NotchDrop board. Files dragged over the collapsed pill open a dashed
// slot; on drop, files upload through the chat attachment route (25 MB each,
// routes/chat_routes.py) and folders ask the permissions broker for a
// path-root grant (routes/notch_routes.py). Nothing is ever sent from here:
// what was dropped lands in the quick composer, and only Send starts a turn.
//
// The window is click-through until the pointer is over the notch; the
// native pointer poll (electron/usage-overlay-tracking.js) makes the pill
// interactive under a drag as it does under a hover, which is when the
// browser starts delivering drag events to it.
import { createMascot, KAIROS_SPEC } from './mascot.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const KINDS = ['Documents', 'PDFs', 'Images', 'Code', 'Folders'];

export function megabytes(bytes) { return `${Math.round(bytes / (1024 * 1024))} MB`; }

// Files over the limit are refused in words, before any upload starts.
export function splitBySize(files) {
  const ok = [], refused = [];
  for (const file of files) (file.size > MAX_FILE_BYTES ? refused : ok).push(file);
  return { ok, refused };
}
export function refusalLine(refused) {
  if (!refused.length) return '';
  const names = refused.map(file => file.name);
  const list = names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ');
  return `${list} ${refused.length === 1 ? 'is' : 'are'} over the 25 MB limit, so ${refused.length === 1 ? 'it was' : 'they were'} not added.`;
}

const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');

// Files and folders from a drop. A folder has no File contents to read; its
// path comes from the Electron bridge (webUtils.getPathForFile).
export function dropped(dataTransfer, pathFor) {
  const files = [], folders = [];
  for (const item of dataTransfer?.items || []) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.(), file = item.getAsFile();
    if (entry?.isDirectory) { const path = file && pathFor ? pathFor(file) : ''; if (path) folders.push(path); }
    else if (file) files.push(file);
  }
  return { files, folders };
}

// One file through POST /api/chat/attachments, with upload progress.
export function uploadFile(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/chat/attachments');
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    request.onload = () => {
      if (request.status === 413) reject(new Error(`${file.name} is over the 25 MB limit, so it was not added.`));
      else if (request.status >= 200 && request.status < 300) { try { resolve(JSON.parse(request.responseText)); } catch { reject(new Error(`${file.name} could not be added.`)); } }
      else reject(new Error(`${file.name} could not be added.`));
    };
    request.onerror = () => reject(new Error(`${file.name} could not be added.`));
    request.onabort = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    signal?.addEventListener('abort', () => request.abort(), { once: true });
    const form = new FormData();
    form.append('file', file, file.name);
    request.send(form);
  });
}

// A folder's path-root grant: the broker's request arrives on the stream and
// is answered in the notch like any approval; the stream then says allowed
// (with the folder reference) or rejected.
export async function askFolder({ sessionId, path, onRequest, signal }) {
  const response = await fetch('/api/notch/folder', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, path }) });
  if (!response.ok) {
    let detail = 'That folder could not be added.';
    try { detail = (await response.json()).detail || detail; } catch { /* keep the default */ }
    return { status: 'refused', detail };
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', outcome = { status: 'rejected' };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      if (!line.startsWith('data: ')) continue;
      const packet = JSON.parse(line.slice(6));
      if (packet.permission) onRequest(packet.permission);
      else if (packet.status) outcome = packet;
    }
  }
  return outcome;
}

// The dashed slot. `kip` open, sage glow, the kinds it takes.
export function dropPanel() {
  const node = document.createElement('section');
  node.className = 'n-panel n-drop';
  node.dataset.kind = 'drop';
  node.setAttribute('aria-label', 'Drop files to start a chat');
  const slot = document.createElement('div'); slot.className = 'n-drop-slot';
  const face = createMascot({ state: 'open', size: 54, spec: KAIROS_SPEC });
  const title = document.createElement('span'); title.className = 'n-panel-title'; title.textContent = 'Drop files to start a chat';
  const kinds = document.createElement('span'); kinds.className = 'n-drop-kinds';
  for (const kind of KINDS) { const chip = document.createElement('span'); chip.className = 'n-drop-kind'; chip.textContent = kind; kinds.append(chip); }
  const note = document.createElement('span'); note.className = 'n-panel-detail'; note.textContent = 'Up to 25 MB a file. They go into a new chat; nothing is sent yet.';
  slot.append(face, title, kinds, note);
  node.append(slot);
  return { key: 'drop', kind: 'drop', kip: 'open', glow: 'sage', node, dispose() {} };
}

// Drag tracking for the whole page: dragging is true from the first enter
// with files until the drag leaves the window or drops.
export function watchDrags({ onChange, onDrop, pathFor }) {
  let depth = 0, dragging = false;
  const set = value => { if (value !== dragging) { dragging = value; onChange(value); } };
  document.addEventListener('dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); depth += 1; set(true); });
  document.addEventListener('dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; set(true); });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) set(false); });
  document.addEventListener('drop', event => {
    event.preventDefault();  // a dropped file never navigates the notch
    depth = 0; set(false);
    if (hasFiles(event)) onDrop(dropped(event.dataTransfer, pathFor));
  });
  return { get dragging() { return dragging; } };
}

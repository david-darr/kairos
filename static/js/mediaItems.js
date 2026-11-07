// The in-chat media viewer's model (In-Chat Media Viewer build spec,
// 2026-11-07): what kind a file is, how its details read, how a gesture is
// read, and which items a chat holds. No DOM work happens at import, so
// scripts/test_media_viewer.cjs loads this in plain Node.

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
export const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov'];
export const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac'];
const OFFICE = { xlsx: 'Spreadsheet', csv: 'Spreadsheet', docx: 'Document', pptx: 'Slides' };
const CODE_EXT = ['py', 'js', 'ts', 'jsx', 'tsx', 'css', 'json', 'xml', 'yaml', 'yml', 'sql', 'sh', 'ps1', 'java', 'c', 'cpp', 'rs', 'go'];
const TEXT_EXT = ['txt', 'log', 'md', 'markdown'];

export function extensionOf(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : '';
}

// image, video and audio show in the message itself; everything else is a file card.
export function mediaKind(name) {
  const ext = extensionOf(name);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return 'file';
}
export const isInlineMedia = kind => kind === 'image' || kind === 'video' || kind === 'audio';

export function typeLabel(name, kind = mediaKind(name)) {
  const ext = extensionOf(name);
  if (kind === 'image' || ext === 'svg') return 'Image';
  if (kind === 'video') return 'Video';
  if (kind === 'audio') return 'Audio';
  if (ext === 'pdf') return 'PDF';
  if (OFFICE[ext]) return OFFICE[ext];
  if (ext === 'html' || ext === 'htm') return 'Web page';
  if (CODE_EXT.includes(ext)) return 'Code';
  if (TEXT_EXT.includes(ext)) return 'Text';
  return 'File';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

// The details row: type, format, then whatever the file has (dimensions,
// pages, slides, duration), then its size. Unknown parts are left out.
export function detailParts({ name = '', kind, width, height, pages, pageUnit = 'pages', duration, size } = {}) {
  const ext = extensionOf(name);
  const parts = [typeLabel(name, kind || mediaKind(name))];
  if (ext && ext.toUpperCase() !== parts[0].toUpperCase()) parts.push(ext.toUpperCase());
  if (width > 0 && height > 0) parts.push(`${Math.round(width)} × ${Math.round(height)}`);
  if (pages > 0) parts.push(`${pages} ${pages === 1 ? pageUnit.replace(/s$/, '') : pageUnit}`);
  const time = formatDuration(duration);
  if (time) parts.push(time);
  const bytes = formatBytes(size);
  if (bytes) parts.push(bytes);
  return parts;
}

export const counterText = (index, total) => `${index + 1} of ${total}`;
export const clampIndex = (index, total) => Math.min(Math.max(0, index), Math.max(0, total - 1));

// A finished touch or pen gesture. Sideways means move between items only when
// it is clearly sideways and long enough; a downward drag closes the phone sheet.
export function swipeIntent({ dx = 0, dy = 0, ms = 0 } = {}) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const fast = ms > 0 && ms < 260;
  if (ax >= (fast ? 36 : 64) && ax > ay * 1.5) return dx < 0 ? 'next' : 'prev';
  if (dy >= (fast ? 60 : 110) && dy > ax * 1.5) return 'close';
  return null;
}

// A tall or wide picture keeps the message tidy: its card's shape is clamped.
export const cardAspect = (width, height) => {
  const ratio = width > 0 && height > 0 ? width / height : 4 / 3;
  return Math.min(1.9, Math.max(0.62, ratio));
};

export const contentURL = (sessionId, url, download = false) =>
  `/api/chat/artifacts/content?${new URLSearchParams({ session_id: sessionId, url })}${download ? '&download=true' : ''}`;

// Every viewable thing in a transcript carries data-viewer-item; its data
// attributes say what it is. Only same-app paths are accepted as sources.
const LOCAL = /^(?:\/(?!\/)|data:image\/(?:png|jpeg|gif|webp);base64,|blob:)/;
export function itemFromData(data = {}) {
  const name = String(data.viewerName || 'File');
  const url = typeof data.viewerUrl === 'string' && /^\/(?:generated-(?:images|files)\/[^/?#]+|chat-files\/[a-f0-9]{24})$/.test(data.viewerUrl) ? data.viewerUrl : '';
  const sessionId = String(data.viewerSession || '');
  const direct = typeof data.viewerSrc === 'string' && LOCAL.test(data.viewerSrc) ? data.viewerSrc : '';
  const kind = ['image', 'video', 'audio', 'file'].includes(data.viewerKind) ? data.viewerKind : mediaKind(name);
  const src = direct || (url && sessionId && kind !== 'file' ? contentURL(sessionId, url) : '');
  if (!src && !(url && sessionId)) return null;
  return { kind, name, url: url && sessionId ? url : '', sessionId, src };
}

export function itemData(item) {
  const data = { 'data-viewer-item': '', 'data-viewer-kind': item.kind, 'data-viewer-name': item.name };
  if (item.url) data['data-viewer-url'] = item.url;
  if (item.sessionId) data['data-viewer-session'] = item.sessionId;
  if (item.src && !(item.url && item.src === contentURL(item.sessionId, item.url))) data['data-viewer-src'] = item.src;
  return data;
}

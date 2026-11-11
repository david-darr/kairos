// Notification worker only. Never caches pages, API responses or transcripts.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const APP_ICON = '/static/img/app-192.png';
// A phone ring: buzz, pause, buzz, like a call (2026-11-10). Platforms without vibration ignore it.
const RING_VIBRATE = [500, 250, 500, 250, 500, 1000, 500, 250, 500];
const RING_ID = /^[a-f0-9]{32}$/;

function chatUrl(value) {
  const url = new URL(value || '/', self.location.origin);
  if (url.origin !== self.location.origin || url.pathname !== '/' ||
      (url.search && !/^\?(chat=[a-f0-9]{12}|agent=[A-Za-z0-9_-]{1,64}(&ring=[a-f0-9]{32}(&exp=\d{1,12})?)?)$/.test(url.search))) return self.location.origin + '/';
  url.hash = '';
  return url.href;
}

// The caller's face for a ringing call: the bot's own picture (fetched here, with the sign-in cookie, and handed to the
// notification as a data URL), else the Kip the app drew last time it showed this bot (ringFaces.js keeps it in
// IndexedDB), else the app icon. Any failure is the app icon; a face is never worth a missing ring.
async function bytesToDataUrl(buffer, type) {
  const bytes = new Uint8Array(buffer); let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${type};base64,${btoa(text)}`;
}
async function pictureFor(path) {
  if (typeof path !== 'string' || !/^\/api\/agents\/[A-Za-z0-9_-]{1,64}\/avatar-image\/[a-f0-9]{32}$/.test(path)) return '';
  try {
    const response = await fetch(path, { credentials: 'same-origin' });
    const type = response.headers.get('Content-Type') || '';
    if (!response.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return '';
    const buffer = await response.arrayBuffer();
    return buffer.byteLength && buffer.byteLength <= 400000 ? bytesToDataUrl(buffer, type) : '';
  } catch { return ''; }
}
function savedFace(agentId) {
  return new Promise(resolve => {
    if (typeof agentId !== 'string' || !self.indexedDB) { resolve(''); return; }
    try {
      const open = self.indexedDB.open('kairos-faces', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('faces');
      open.onerror = () => resolve('');
      open.onsuccess = () => {
        try {
          const read = open.result.transaction('faces', 'readonly').objectStore('faces').get(agentId);
          read.onsuccess = () => { const png = read.result?.png; resolve(typeof png === 'string' && png.startsWith('data:image/png') ? png : ''); open.result.close(); };
          read.onerror = () => { resolve(''); open.result.close(); };
        } catch { resolve(''); }
      };
    } catch { resolve(''); }
  });
}
async function faceFor(data) {
  return (await pictureFor(data.avatar)) || (await savedFace(data.agent_id)) || APP_ICON;
}

const name60 = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : 'A bot');

// A ring ended (answered here or elsewhere, declined, or missed): the ringing notification comes down on this device.
// A push must always show something (userVisibleOnly), so a missed call stays as a quiet note, and an answered or
// declined one is shown silently and closed at once.
async function ringEnded(data) {
  const tag = 'kairos-ring-' + data.ring_id;
  for (const shown of await self.registration.getNotifications({ tag })) shown.close();
  const missed = data.outcome === 'missed';
  await self.registration.showNotification(missed ? `Missed call from ${name60(data.bot_name)}` : 'Kairos', {
    body: missed ? 'It is in your inbox. Tap to call back from there.' : data.outcome === 'answered' ? 'Call answered.' : 'Call declined.',
    icon: APP_ICON, tag, silent: true, renotify: false, data: { url: '/' } });
  if (!missed) for (const shown of await self.registration.getNotifications({ tag })) shown.close();
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch (_) {}
    if (data.kind === 'bot_call_end' && RING_ID.test(data.ring_id || '')) { await ringEnded(data); return; }
    // Always show a visible notification: userVisibleOnly subscription.
    const expired = data.kind === 'permission' && Number(data.expires_at) <= Date.now() / 1000;
    const body = expired ? 'A permission request expired. Tap to review the chat.' :
      ({ completed: 'Your reply is ready. Tap to open the chat.', failed: 'A chat could not finish. Tap to review.',
         permission: 'A chat needs your permission. Tap to review before the request expires.',
         test: 'Notifications are enabled on this device.',
         // Bots (2026-10-14): as generic as chats; a lock screen shows no content.
         bot_needs_you: 'A bot needs you. Tap to review.', bot_results: 'A bot has results. Tap to review.',
         // A ring (2026-11-06): who is calling, never why.
         bot_call: typeof data.body === 'string' && data.body ? data.body.slice(0, 120) : 'Tap to answer.' }[data.kind]
        || 'There is an update in Kairos.');
    const ringing = data.kind === 'bot_call' && RING_ID.test(data.ring_id || '') && Number(data.expires_at) > Date.now() / 1000;
    if (data.kind === 'bot_call' && !ringing) return self.registration.showNotification('Kairos', { body: 'You missed a call. It is in your inbox.', icon: APP_ICON, tag: 'kairos-ring-missed', data: { url: '/' } });
    if (ringing) {
      // A call-style notification (2026-11-10): "<Bot> is calling", the bot's face, a ring pattern, and Answer / Decline
      // where the platform shows actions (Android Chrome, desktop browsers). An iPhone home-screen app shows the title and
      // body as a plain banner; tapping it answers the same way.
      const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : `${name60(data.bot_name)} is calling`;
      await self.registration.showNotification(title, { body, icon: await faceFor(data), badge: APP_ICON,
        tag: 'kairos-ring-' + data.ring_id, requireInteraction: true, renotify: true, silent: false, vibrate: RING_VIBRATE,
        actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
        data: { url: chatUrl(data.url), ring: data.ring_id, expires: Number(data.expires_at) } });
      return;
    }
    await self.registration.showNotification('Kairos', { body, icon: APP_ICON,
      tag: typeof data.tag === 'string' ? data.tag.slice(0, 100) : 'kairos', data: { url: chatUrl(data.url) } });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const ring = event.notification.data?.ring;
    if (event.action === 'decline' && RING_ID.test(ring || '')) {
      // Decline: the server tells the bot and takes the ring down on every device.
      await fetch(`/api/rings/${ring}/decline`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      return;
    }
    // Answer, or a tap on the banner: open Kairos on the deep link, which answers the ring once (ringHost.js).
    const url = chatUrl(event.notification.data?.url);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === '/') {
        client.postMessage({ type: 'kairos:open-chat', url });
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'kairos:clear-notifications') event.waitUntil((async () => {
    for (const notification of await self.registration.getNotifications()) notification.close();
  })());
});

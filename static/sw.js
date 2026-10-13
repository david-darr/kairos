// Notification worker only. Never caches pages, API responses or transcripts.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function chatUrl(value) {
  const url = new URL(value || '/', self.location.origin);
  if (url.origin !== self.location.origin || url.pathname !== '/' ||
      (url.search && !/^\?chat=[a-f0-9]{12}$/.test(url.search))) return self.location.origin + '/';
  url.hash = '';
  return url.href;
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch (_) {}
    // Always show a visible notification: userVisibleOnly subscription.
    const expired = data.kind === 'permission' && Number(data.expires_at) <= Date.now() / 1000;
    const body = expired ? 'A permission request expired. Tap to review the chat.' :
      ({ completed: 'Your reply is ready. Tap to open the chat.', failed: 'A chat could not finish. Tap to review.',
         permission: 'A chat needs your permission. Tap to review before the request expires.',
         test: 'Notifications are enabled on this device.' }[data.kind] || 'There is an update in Kairos.');
    await self.registration.showNotification('Kairos', { body, icon: '/static/img/app-192.png',
      tag: typeof data.tag === 'string' ? data.tag.slice(0, 100) : 'kairos', data: { url: chatUrl(data.url) } });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
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

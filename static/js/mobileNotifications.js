import { api } from './api.js';

export function supportReason() {
  if (!window.isSecureContext || location.protocol !== 'https:') return 'Open Kairos through HTTPS Remote Access to enable notifications.';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches)
    return 'On iPhone or iPad, use Share → Add to Home Screen, then open Kairos from its icon.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return 'This browser does not support background notifications. Try a current Safari, Chrome, Edge or Firefox.';
  if (Notification.permission === 'denied') return 'Notifications are blocked. Allow them in your device or browser settings, then return here.';
  return '';
}

export async function registration() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return null;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export async function currentDevice(status) {
  const worker = await registration();
  const subscription = await worker?.pushManager.getSubscription();
  if (!subscription) return null;
  const id = localStorage.getItem('kairos:push-device');
  return status.devices.find(device => device.id === id && device.current_login) || null;
}

export function enableNotifications(status, worker) {
  // Keep the iOS user gesture: no awaited request precedes permission.
  const permission = Notification.requestPermission();
  return (async () => {
    if (await permission !== 'granted') throw new Error('Notifications were not allowed. You can enable them later.');
    const key = Uint8Array.from(atob(status.public_key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - status.public_key.length % 4) % 4)), ch => ch.charCodeAt(0));
    const subscription = await worker.pushManager.getSubscription() || await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    try {
      const device = await api('/api/notifications/devices', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
      localStorage.setItem('kairos:push-device', device.id);
      return device;
    } catch (error) { await subscription.unsubscribe(); throw error; }
  })();
}

export async function disableNotifications(device) {
  await api(`/api/notifications/devices/${device.id}`, { method: 'DELETE' });
  const worker = await registration();
  await (await worker?.pushManager.getSubscription())?.unsubscribe();
  localStorage.removeItem('kairos:push-device');
  worker?.active?.postMessage({ type: 'kairos:clear-notifications' });
}

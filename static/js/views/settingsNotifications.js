import { api, el } from '../api.js';
import { pageHeader, group, row, note, toggle } from '../settingsKit.js';
import { supportReason, registration, currentDevice, enableNotifications, disableNotifications } from '../mobileNotifications.js';

export async function renderNotificationsPanel(container) {
  container.replaceChildren(pageHeader('Notifications', 'Know when a chat finishes or needs your attention, even after you leave Kairos.'));
  const reason = supportReason();
  if (reason) { container.append(note(reason)); return; }
  const statusLine = el('p', { class: 'set-note', role: 'status', 'aria-live': 'polite' });
  container.append(statusLine);
  try {
    const [status, worker] = await Promise.all([api('/api/notifications'), registration()]);
    if (!container.isConnected) return;
    const device = await currentDevice(status);
    const button = el('button', { type: 'button', class: 'btn', text: device ? 'Disable on this device' : 'Enable notifications' });
    button.addEventListener('click', () => {
      button.disabled = true;
      const action = device ? disableNotifications(device) : enableNotifications(status, worker);
      action.then(() => renderNotificationsPanel(container)).catch(error => {
        statusLine.textContent = error.message.replace(/^\d+: /, ''); button.disabled = false;
      });
    });
    container.append(group({ title: 'This device' }, [row({ title: device ? 'Notifications enabled' : 'Stay informed',
      description: 'Lock-screen messages say only that a chat is ready or needs attention. Chat content stays in Kairos.', control: button })]));
    if (device) {
      const prefs = { ...device.preferences };
      container.append(group({ title: 'Notify me about' }, [
        ['completed', 'Reply ready', 'A response has finished.'],
        ['permission', 'Permission needed', 'Tap to review a request in Kairos. Unanswered requests still expire.'],
        ['failed', 'Chat failed', 'A response could not finish.'],
      ].map(([key, title, description]) => row({ title, description, control: toggle({ label: title, checked: prefs[key], onChange: async value => {
        const next = { ...prefs, [key]: value };
        await api(`/api/notifications/devices/${device.id}`, { method: 'PUT', body: JSON.stringify(next) });
        Object.assign(prefs, next);
      } }) }))));
      const test = el('button', { type: 'button', class: 'btn', text: 'Send test notification', onclick: async () => {
        test.disabled = true;
        try {
          await api(`/api/notifications/devices/${device.id}/test`, { method: 'POST' });
          statusLine.textContent = 'Test notification queued. If it does not arrive, check your device notification settings.';
        } catch (error) { statusLine.textContent = error.message; }
        finally { test.disabled = false; }
      } });
      container.append(group({}, [row({ title: 'Check delivery', description: 'Send an alert to this device.', control: test })]));
    }
    const other = status.devices.filter(item => item.id !== device?.id);
    if (other.length) container.append(group({ title: 'Other enrollments' }, other.map(item => row({
      title: `Enrolled ${new Date(item.created_at * 1000).toLocaleDateString()}`,
      description: item.last_status >= 400 ? 'Last notification could not be delivered.' : 'A device or an earlier sign-in.',
      control: el('button', { type: 'button', class: 'btn', text: 'Remove', onclick: async () => {
        await api(`/api/notifications/devices/${item.id}`, { method: 'DELETE' });
        renderNotificationsPanel(container);
      } }),
    }))));
    container.append(note('Keep your Kairos host awake and connected. Opening a notification requires your Remote Access connection and sign-in.'));
  } catch (error) { statusLine.textContent = error.message.replace(/^\d+: /, ''); }
}

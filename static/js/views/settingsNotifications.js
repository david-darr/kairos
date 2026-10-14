import { api, el } from '../api.js';
import { pageHeader, group, row, note, toggle } from '../settingsKit.js';
import { supportReason, registration, currentDevice, enableNotifications, disableNotifications } from '../mobileNotifications.js';
import { prefs as botPrefs, savePrefs as saveBotPrefs } from '../botNotifications.js';

export async function renderNotificationsPanel(container) {
  container.replaceChildren(pageHeader('Notifications', 'Know when a chat finishes, or a bot needs you, even after you leave Kairos.'));
  container.append(await botsGroup());
  // Phone and browser push needs HTTPS Remote Access; desktop notifications
  // above do not, so a missing connection no longer hides them (2026-10-14).
  container.append(group({ title: 'Phone and browser push', description: 'Chats and bots, on a phone or another browser, through Remote Access.' }));
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
      // Devices enrolled before bot pushes existed have no bot keys: on by default.
      const prefs = { bot_needs_you: true, bot_results: true, ...device.preferences };
      container.append(group({ title: 'Notify me about' }, [
        ['completed', 'Reply ready', 'A response has finished.'],
        ['permission', 'Permission needed', 'Tap to review a request in Kairos. Unanswered requests still expire.'],
        ['failed', 'Chat failed', 'A response could not finish.'],
        ['bot_needs_you', 'A bot needs you', 'One of your bots asked a question.'],
        ['bot_results', 'Bot results', 'A bot sent a report, or has work ready for review.'],
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

// Desktop notifications for bots and the floating bot window (Agents 2.0,
// 2026-10-14). Stored on this computer; they work without Remote Access.
async function botsGroup() {
  const current = botPrefs();
  const rows = [
    ['enabled', 'Bot notifications', 'Show a notification on this computer when a bot needs you or has results.'],
    ['needs_you', 'Needs you', 'A bot asked a question.'],
    ['results', 'Results', 'A bot sent a report, or has work ready for review.'],
  ].map(([key, title, description]) => row({ title, description, control: toggle({ label: title, checked: current[key],
    onChange: value => { Object.assign(current, saveBotPrefs({ [key]: value })); } }) }));
  const bridge = window.jarvis?.botWindow;
  if (bridge) {
    const state = await bridge.state().catch(() => ({ visible: false }));
    rows.push(row({ title: 'Floating bot window', description: 'A small window that stays on top and lists the bots that need you. Also in the tray menu.',
      control: toggle({ label: 'Floating bot window', checked: !!state.visible, onChange: value => bridge.setVisible(value) }) }));
  }
  return group({ title: 'Bots on this computer' }, rows);
}

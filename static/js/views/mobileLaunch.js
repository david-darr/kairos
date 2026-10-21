// Phone Chats owns the launch pager; Home keeps its dashboard.
import { render as renderHome } from './home.js';
export function render(container, tab, options = {}) {
  return renderHome(container, tab, { ...options, mobileLaunchSurface: true });
}

// A terminal asking to pair with Kairos (the Kairos CLI; core/cli_access.py).
//
// The backend sends the request on the live feed to the app window only.
// It is an ordinary approval prompt: the same dialog, the same answer route,
// and closing it rejects. The window comes forward first, because the CLI may
// have started Kairos in the tray (--background) and the person still has to
// see the words to compare them with the terminal.
import { showPermissionPrompt, dismissPermissionPrompt } from './permissionPrompt.js';

const seen = new Set();

document.addEventListener('kairos:cli-pair', event => {
  const request = event.detail;
  if (!request?.id || seen.has(request.id)) return;
  if (request.expires_at && request.expires_at * 1000 <= Date.now()) return;
  seen.add(request.id);
  try { window.jarvis?.showWindow?.(); } catch { /* a browser tab has no window to raise */ }
  const dialog = showPermissionPrompt(request);
  dialog?.classList.add('cli-pair-prompt');
});

document.addEventListener('kairos:cli-pair-closed', event => {
  // Answered elsewhere or timed out: close it without sending a second answer.
  dismissPermissionPrompt(event.detail?.id);
});

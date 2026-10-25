// What the desktop notch's buttons ask the main window to do (the Electron
// main process forwards them: electron/usage-overlay-navigation.js). Each is
// the app's own action, reached the way a click would reach it: a tab, a chat
// by id, a new chat with a draft to review (nothing is sent), the Notes
// field, Open Mic, or the composer's menu with Attach files.
export function notchNavigation(target, detail = {}) {
  switch (target) {
    case 'settings': return { tab: 'settings', options: { section: 'appearance' } };
    case 'chat': return { tab: 'chat', options: detail.sessionId ? { sessionId: detail.sessionId } : detail.draft ? { mobileDraft: detail.draft } : {} };
    case 'notes': return { tab: 'notes', options: {}, then: { selector: 'input[aria-label="New note"]' } };
    case 'talk': return { tab: 'chat', options: {}, then: { selector: '#chat-openmic', click: true } };
    case 'attach': return { tab: 'chat', options: {}, then: { selector: '#overflow-plus-btn', click: true } };
    default: return { tab: target, options: {} };
  }
}

// Once the destination has drawn its control, focus it or press it. A file
// chooser needs a real click, so Attach only opens the menu that holds it.
export function whenReady({ selector, click = false }) {
  const before = document.querySelector(selector);
  let timer;
  const act = control => { observer.disconnect(); clearTimeout(timer); if (click) control.click(); else control.focus(); };
  const observer = new MutationObserver(() => {
    const control = document.querySelector(selector);
    if (control && control !== before) act(control);
  });
  observer.observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
  // Already on that view: nothing is redrawn, so use the control that is there.
  timer = setTimeout(() => { observer.disconnect(); const control = document.querySelector(selector); if (control) act(control); }, 4000);
}

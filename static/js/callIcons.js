// Line icons for the call screen and its minimized pill (agentCall.js, botsCallBar.js). currentColor only, so the
// call tokens in agents-messages.css and bots-voice.css colour them.
const PATHS = {
  minimize: '<path d="M6 9l6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  speaker: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
  speakerOff: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 10l4 4M20 10l-4 4"/>',
  mic: '<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  micOff: '<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16"/>',
  hangup: '<path d="M3.5 14.5c4.7-4.4 12.3-4.4 17 0l-2.3 2.6-3.4-1.4.2-2.6a10 10 0 0 0-6 0l.2 2.6-3.4 1.4z"/>',
  chat: '<path d="M5 5h14v10H10l-4 4v-4H5z"/>',
};

export function callIcon(name, size = 26) {
  const span = document.createElement('span');
  span.className = 'call-icon'; span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`;
  return span;
}

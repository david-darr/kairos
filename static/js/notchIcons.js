// The notch's line icons, drawn to the Kairos Mobile v2 boards (NotchWorking,
// NotchQuiet, NotchSide): the nav row at 15 px, the quick actions at 18 px.
const line = (size, body) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  home: line(15, '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>'),
  chats: line(15, '<path d="M5 5h14v11h-8l-5 3v-3H5z"/>'),
  settings: line(15, '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'),
  plus: line(18, '<path d="M12 5v14M5 12h14"/>'),
  note: line(18, '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h6M9 16h4"/>'),
  talk: line(18, '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/>'),
  drop: line(18, '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/>'),
  calendar: line(16, '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4M16 3v4M4 10h16"/>'),
};

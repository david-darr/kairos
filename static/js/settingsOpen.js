// Whether the Settings window is on screen. While it covers the app, the background refreshes behind it (the Home
// refresh, the sidebar's need-you poll) pause, and each catches up once with one read when it closes. Settings
// sets this from hidePageBehind()/restorePageBehind(); listeners hear "kairos:settings-visibility".
let open = false;
export const settingsOpen = () => open;
export function setSettingsOpen(value) {
  if (open === value) return;
  open = value;
  document.dispatchEvent(new CustomEvent("kairos:settings-visibility", { detail: { open } }));
}

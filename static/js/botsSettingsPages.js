// Mount-only descriptors for the shared Settings shell.
export const PAGES = [
  { id: 'bots', label: 'Bots', load: () => import('./botsSettingsBots.js'), exportName: 'mount' },
  { id: 'bot-voice', label: 'Bot voice', load: () => import('./botsCallBar.js'), exportName: 'mountLiveSettings' },
];

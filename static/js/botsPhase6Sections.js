// Deferred registration avoids the panel/extension import cycle.
import { registerBotSection } from './botsPanel.js';
import { h } from './botsUi.js';
queueMicrotask(() => registerBotSection({ id: 'voice', label: 'Voice and alerts', iconName: 'bell', order: 110,
  keywords: 'voice speak calls alerts notifications', render(ctx) {
    const host = h('section', { 'data-section': 'voice', 'data-module': 'Voice' }, [h('p', { text: 'Loading voices...' })]);
    const track = ctx.bindTrack ? ctx.bindTrack() : ctx.track;
    ctx.loadModule('Voice').then(async module => {
      if (!host.isConnected) return;
      const handle = await module.mount(host, ctx);
      if (!host.isConnected) handle?.destroy?.(); else track?.(handle);
    }).catch(() => { if (host.isConnected) host.replaceChildren(h('p', { role: 'status', text: 'Voice settings could not load. Close and try again.' })); });
    return host;
  } }));

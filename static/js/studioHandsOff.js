// Studio > Content: the team's posting switch and Pause team (services/content_studio/handsoff.py, 2026-11-11).
// Hands-off posting is the person's own click, explained before it turns on; Pause team stops posting and the team's
// bots at once. Data: GET /api/content-studio/hands-off, PUT /hands-off {on}, PUT /team-pause {on}.
// Mounted by studioContent.js with one call; styled by static/css/studio-handsoff.css with the Kairos tokens.
import { api, el, confirmDialog } from './api.js';

const BASE = '/api/content-studio';

export function stateLine(s) {
  if (s.paused) return 'The team is paused. Nothing is posted and its bots only read until you resume it.';
  if (s.on) return `Hands-off posting is on. The Producer approves posts and Kairos posts them to YouTube and Instagram.${s.taps ? ` ${s.taps} TikTok post${s.taps === 1 ? '' : 's'} need${s.taps === 1 ? 's' : ''} your tap.` : ''}`;
  return 'Every post waits for your OK.';
}

export function mountHandsOff(host, { onChanged } = {}) {
  if (!document.querySelector('link[href="/static/css/studio-handsoff.css"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/static/css/studio-handsoff.css' }));
  const box = el('section', { class: 'sc-handsoff', 'aria-label': 'Team posting' });
  host.replaceChildren(box);
  async function load() {
    let s;
    try { s = await api(`${BASE}/hands-off`, { toast: false }); } catch { box.replaceChildren(); return; }
    const status = el('p', { class: 'sc-handsoff-text', role: 'status', text: stateLine(s) });
    const toggle = el('button', { type: 'button', class: 'sc-handsoff-btn', 'data-action': 'hands-off', text: s.on ? 'Turn hands-off posting off' : 'Turn on hands-off posting' });
    toggle.addEventListener('click', async () => {
      if (!s.on) {
        const ok = await confirmDialog({ title: 'Turn on hands-off posting?', confirmLabel: 'Turn on',
          message: 'The Producer will approve the team\'s posts and Kairos will post them to YouTube and Instagram on schedule, at most the niche\'s slots a day per channel. TikTok still waits for your tap. You get the weekly report and alerts for platform warnings, spend near the cap, repeated failures, retirements and TikTok taps. The AI label, the monthly cap and Pause team always apply.' });
        if (!ok) return;
      }
      await api(`${BASE}/hands-off`, { method: 'PUT', body: JSON.stringify({ on: !s.on }), toast: false });
      await load(); onChanged?.();
    });
    const pause = el('button', { type: 'button', class: `sc-handsoff-btn sc-handsoff-pause${s.paused ? ' is-paused' : ''}`, 'data-action': 'pause-team', text: s.paused ? 'Resume team' : 'Pause team' });
    pause.addEventListener('click', async () => {
      await api(`${BASE}/team-pause`, { method: 'PUT', body: JSON.stringify({ on: !s.paused }), toast: false });
      await load(); onChanged?.();
    });
    box.dataset.state = s.paused ? 'paused' : s.on ? 'on' : 'off';
    box.replaceChildren(status, el('div', { class: 'sc-handsoff-actions' }, [toggle, pause]));
  }
  load();
  return { refresh: load };
}

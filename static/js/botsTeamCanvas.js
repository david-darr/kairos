import { h, Button, IconButton, openMenu, withBotColor } from './botsUi.js';
import { icon } from './botsIcons.js';
import { agentAvatar } from './agentAvatar.js';
import { openBotSettings } from './botsPanelHost.js';
import { botState, readLayout, layoutTeams, zoomAt, fitToView, gesture, dropTarget, clampPosition, CANVAS_KEY } from './botsTeamMapModel.js';
import { teamNavigate, teamRequest, teamChanged, teamError, openTeamDialog, openTeamInstructions, openTeamMemory, openTeamSettings } from './botsTeamHost.js';

export function mount(host, ctx = {}) {
  let disposed = false, data = { departments: [], edges: [] }, tiles = [], active = null, ghost = null, suppressClick = false;
  let view;
  try { view = readLayout(JSON.parse(localStorage.getItem(CANVAS_KEY) || '{}')); } catch { view = readLayout(); }
  const savedView = !!(view.x || view.y || Object.keys(view.teams).length);
  const phone = matchMedia('(max-width: 720px)');
  const request = ctx.api || teamRequest;
  const world = h('div', { class: 'bots-team-world' });
  const surface = h('div', { class: 'bots-team-canvas', tabindex: '0', role: 'region', 'aria-label': 'Team map. Arrow keys pan. Plus and minus zoom. Zero fits.' }, [world]);
  const live = h('div', { class: 'bots-team-live', role: 'status', 'aria-live': 'polite' });
  const percent = Button({ label: 'Fit', onClick: fit });
  const controls = h('div', { class: 'bots-team-zoom' }, [IconButton({ label: 'Zoom out', iconName: 'zoom-out', onClick: () => zoom(.8) }), percent,
    IconButton({ label: 'Zoom in', iconName: 'zoom-in', onClick: () => zoom(1.25) }), IconButton({ label: 'Fit to view', iconName: 'maximize', onClick: fit })]);
  host.append(surface, controls, live);
  function save() { try { localStorage.setItem(CANVAS_KEY, JSON.stringify(view)); } catch { /* Layout is optional. */ } }
  function paint() {
    world.style.transform = phone.matches ? '' : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    surface.style.backgroundSize = `${20 * view.scale}px ${20 * view.scale}px`;
    surface.style.backgroundPosition = `${view.x}px ${view.y}px`;
    percent.textContent = `${Math.round(view.scale * 100)}%`; controls.hidden = phone.matches;
    for (const tile of tiles) {
      const node = world.querySelector(`[data-team-key="${CSS.escape(tile.id)}"]`);
      if (!node) continue;
      node.style.left = `${tile.x}px`; node.style.top = `${tile.y}px`; node.style.width = `${tile.width}px`;
      node.style.setProperty('--team-columns', tile.columns);
    }
  }
  function fit() { Object.assign(view, fitToView(tiles, { width: surface.clientWidth, height: surface.clientHeight })); paint(); save(); }
  function zoom(factor) { view = zoomAt(view, { x: surface.clientWidth / 2, y: surface.clientHeight / 2 }, view.scale * factor); paint(); save(); }
  function menu(team, anchor) {
    openMenu(anchor, [
      { label: 'Manage bots', iconName: 'users', onSelect: () => openTeamDialog({ departmentId: team.id }) },
      { label: 'Team instructions', iconName: 'book-open', onSelect: () => openTeamInstructions({ departmentId: team.id }) },
      { label: 'Team memory', iconName: 'brain', onSelect: () => openTeamMemory({ departmentId: team.id }) },
      { label: 'Team settings', iconName: 'settings', onSelect: () => openTeamSettings({ departmentId: team.id }) },
        { label: 'Team report', iconName: 'gauge', onSelect: () => import('./botsActivityReport.js').then(m => m.openTeamReport({ teamId: team.id })) },
        { label: 'Suggest models', iconName: 'sparkles', onSelect: () => import('./botsActivityReport.js').then(m => m.openSuggestModels({ teamId: team.id })) },
        { label: team.paused ? 'Resume team' : 'Pause team', iconName: team.paused ? 'play' : 'pause', onSelect: () => import('./botsActivityReport.js').then(m => m.setTeamPaused(team.id, !team.paused)) },
      { label: 'Rename', iconName: 'pencil', onSelect: () => openTeamDialog({ departmentId: team.id, mode: 'rename' }) },
      { label: 'Delete', iconName: 'trash-2', danger: true, onSelect: () => openTeamDialog({ departmentId: team.id, mode: 'delete' }) },
    ], { align: 'end' });
  }
  function botCard(bot, team) {
    const state = botState(bot);
    const card = h('article', { class: 'bots-team-bot', 'data-bot-id': bot.id, 'data-team-id': team.id, 'data-state': state.state, tabindex: '0', 'aria-label': `${bot.name}, ${state.label}` });
    const tag = Button({ label: bot.name || 'Bot', onClick: () => { if (!suppressClick) ctx.onTag?.(bot.id); } });
    tag.classList.add('bots-team-bot-name');
    const main = h('div', { class: 'bots-team-bot-main' }, [agentAvatar(bot, 38), h('div', { class: 'bots-team-bot-copy' }, [
      h('div', { class: 'bots-team-name-line' }, [tag, bot.chief ? icon('crown', { size: 16, label: 'Chief of Staff' }) : null]),
      h('p', { text: bot.title || bot.role || 'No job yet' }),
    ])]);
    card.append(main, h('div', { class: 'bots-team-bot-foot' }, [
      IconButton({ label: `Chat with ${bot.name || 'bot'}`, iconName: 'message-square', onClick: () => { if (!suppressClick) teamNavigate('botsShell', { agentId: bot.id }); } }),
      IconButton({ label: `Report for ${bot.name || 'bot'}`, iconName: 'gauge', onClick: () => { if (!suppressClick) import('./botsActivityReport.js').then(m => m.openBotReport({ botId: bot.id })); } }),
      h('span', { class: 'bots-team-status' }, [h('span', { class: 'bots-status-dot', 'data-state': state.state }), h('span', { text: state.label })]),
      Button({ label: bot.model_label || bot.model_override || 'Model', onClick: () => { if (!suppressClick) openBotSettings(bot.id, { section: 'model' }); } }),
    ]));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === card) { e.preventDefault(); ctx.onTag?.(bot.id); } });
    if (data.edges.some(edge => [edge.source_bot_id, edge.target_bot_id, edge.assignee_bot_id, edge.requester?.bot_id].includes(bot.id))) card.classList.add('partner');
    return withBotColor(card, bot.color);
  }
  function refresh(next = data) {
    if (disposed) return;
    data = next; tiles = layoutTeams(data.departments, view.teams, surface.clientWidth || 1100);
    world.replaceChildren(...tiles.map(team => {
      const more = IconButton({ label: `Options for ${team.name}`, iconName: 'ellipsis', onClick: e => menu(team, e.currentTarget) });
      const header = h('header', { class: 'bots-team-tile-head', 'data-team-drag': team.id }, [icon('move', { size: 16 }), h('h2', { text: team.name }),
        h('span', { class: 'bots-row-hint', text: String(team.members.length) }),
        // Pause team, the kill switch, always in sight on the team's tile.
        team.ungrouped ? null : Button({ label: team.paused ? 'Resume team' : 'Pause team', iconName: team.paused ? 'play' : 'pause',
          onClick: () => import('./botsActivityReport.js').then(m => m.setTeamPaused(team.id, !team.paused)).then(() => ctx.onChanged?.()) }),
        team.ungrouped ? null : more]);
      return h('section', { class: 'bots-team-tile', 'data-team-key': team.id, 'aria-label': team.name }, [header,
        h('div', { class: 'bots-team-grid' }, team.members.length ? team.members.map(b => botCard(b, team)) : [h('p', { text: 'No bots in this team.' })])]);
    }));
    paint();
  }
  surface.addEventListener('wheel', e => {
    if (phone.matches) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const b = surface.getBoundingClientRect(); view = zoomAt(view, { x: e.clientX - b.left, y: e.clientY - b.top }, view.scale * Math.exp(-e.deltaY * .002)); }
    else { view.x = clampPosition(view.x - e.deltaX); view.y = clampPosition(view.y - e.deltaY); }
    paint(); save();
  }, { passive: false });
  surface.addEventListener('keydown', e => {
    if (phone.matches || e.target.closest('button, input, textarea, select') || e.altKey || e.ctrlKey || e.metaKey) return;
    const pan = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[e.key];
    if (pan) { e.preventDefault(); view.x = clampPosition(view.x + pan[0]); view.y = clampPosition(view.y + pan[1]); paint(); save(); }
    else if (['+', '=', '-', '0'].includes(e.key)) { e.preventDefault(); e.key === '0' ? fit() : zoom(e.key === '-' ? .8 : 1.25); }
  });
  const worldPoint = e => { const b = surface.getBoundingClientRect(); return { x: (e.clientX - b.left - view.x) / view.scale, y: (e.clientY - b.top - view.y) / view.scale }; };
  surface.addEventListener('pointerdown', e => {
    if (phone.matches || e.button !== 0 || e.target.closest('input, textarea, select, .bots-team-tile-head button')) return;
    const bot = e.target.closest('[data-bot-id]'), team = e.target.closest('[data-team-drag]');
    active = { start: { x: e.clientX, y: e.clientY }, kind: bot ? 'bot' : team ? 'team' : 'pan', botId: bot?.dataset.botId, teamId: bot?.dataset.teamId || team?.dataset.teamDrag,
      view: { ...view }, pos: { ...tiles.find(t => t.id === (bot?.dataset.teamId || team?.dataset.teamDrag)) }, node: bot || team, pointer: e.pointerId, moving: false };
  });
  surface.addEventListener('pointermove', e => {
    if (!active) return;
    const kind = gesture(active.start, { x: e.clientX, y: e.clientY }, active.kind);
    if (kind === 'click') return;
    if (!active.moving) {
      active.moving = true; surface.setPointerCapture?.(active.pointer); active.node?.classList.add('moving');
      if (kind === 'bot') { ghost = h('div', { class: 'bots-team-ghost', text: 'Move bot to a team' }); surface.append(ghost); }
    }
    const dx = e.clientX - active.start.x, dy = e.clientY - active.start.y;
    if (kind === 'pan') { view.x = clampPosition(active.view.x + dx); view.y = clampPosition(active.view.y + dy); }
    if (kind === 'team') { const tile = tiles.find(t => t.id === active.teamId); tile.x = clampPosition(active.pos.x + dx / view.scale); tile.y = clampPosition(active.pos.y + dy / view.scale); }
    if (kind === 'bot') {
      const target = dropTarget(worldPoint(e), tiles, active.teamId);
      for (const node of world.children) node.classList.toggle('drop', node.dataset.teamKey === target?.id);
      const b = surface.getBoundingClientRect(); ghost.style.left = `${e.clientX - b.left + 12}px`; ghost.style.top = `${e.clientY - b.top + 12}px`;
      ghost.textContent = target ? `Move to ${target.name}` : 'Choose another team';
    }
    paint();
  });
  const finish = async (e, cancelled = false) => {
    const drag = active; if (!drag) return;
    active = null; drag.node?.classList.remove('moving'); ghost?.remove(); ghost = null;
    for (const node of world.children) node.classList.remove('drop');
    if (!drag.moving) return;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    if (cancelled) { view = drag.view; refresh(); return; }
    if (drag.kind === 'team') { const tile = tiles.find(t => t.id === drag.teamId); view.teams[drag.teamId] = { x: tile.x, y: tile.y }; }
    if (drag.kind === 'bot') {
      const target = dropTarget(worldPoint(e), tiles, drag.teamId);
      if (target) {
        const ok = await (ctx.confirm || (async message => (await import('./api.js')).confirmDialog({ title: message, message: 'Its shared team context will change.', confirmLabel: 'Move bot', danger: false })))(`Move this bot to ${target.name}?`);
        if (ok && !disposed) try { await request(`/api/agents/${encodeURIComponent(drag.botId)}`, { method: 'PATCH', body: { section: target.ungrouped ? '' : target.name } }); teamChanged(); ctx.onChanged?.(); }
        catch (error) { live.textContent = teamError(error); }
      }
    }
    save();
  };
  surface.addEventListener('pointerup', e => finish(e)); surface.addEventListener('pointercancel', e => finish(e, true));
  surface.addEventListener('click', e => { if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  const resize = () => { if (!active) { refresh(); paint(); } };
  phone.addEventListener('change', resize);
  const observer = new ResizeObserver(resize); observer.observe(surface);
  return { refresh, fit, get view() { return view; }, initialFit() { if (!savedView) fit(); },
    sent(ids) { for (const id of ids) { const card = world.querySelector(`[data-bot-id="${CSS.escape(id)}"]`); card?.classList.add('sent'); setTimeout(() => card?.classList.remove('sent'), 1400); } },
    select(ids) { for (const node of world.querySelectorAll('[data-bot-id]')) node.classList.toggle('selected', ids.includes(node.dataset.botId)); },
    destroy() { disposed = true; observer.disconnect(); phone.removeEventListener('change', resize); active = null; surface.remove(); controls.remove(); live.remove(); } };
}

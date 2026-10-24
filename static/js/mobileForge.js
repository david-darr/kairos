import { api, el } from './api.js';
import { mobileOn, phone, button, go, edgeBlur } from './mobileShared.js';
import { mountPager } from './mobilePager.js';
import { openMobileSheet } from './mobileSheet.js';
import { attachActivity, refreshActivity } from './mobileActivity.js';
import { mountForgeSessions } from './mobileForgeSessions.js';
import { emptyState, dotMatrix } from './kairosParts.js';
import { createMascot } from './mascot.js';
import { sessionStatus, diffCounts, changeTotals } from './forgeUi.js';
import { watchKeyboard } from './mobileDock.js';
import { ICONS } from './icons.js';

let lastPage = 0, lastProject = null;
// The project last shown on a phone, so Home and Sessions open on the same one.
export const rememberedProject = () => lastProject;
// On a phone, Forge Home is the overview (as Kairos Home is the dashboard);
// any request for a page, a composer or the workspace opens the New / Sessions pager.
export const wantsOverview = (options = {}) => options.mobilePage == null && !options.compose && !options.mobileWorkspace;
// Own only phone arrangement. All moved controls keep their handlers and state.
export function mountMobileForge({ page, composer, banner, toolbar, grid, hint, getState, pickProject, refresh, initialPage, overview = false }) {
  if (initialPage != null) lastPage = initialPage;
  let metaVersion = 0, boardSignature;
  let shell, pager, history, sheet, detachActivity, keyboard, newSession, homes = [];
  const move = (node, target) => { const home = document.createComment('Forge desktop home'); node.before(home); homes.push([node, home]); target.append(node); };
  function projects(opener) {
    const body = el('div', { class: 'mf-projects' });
    const addProject = () => { sheet.close(); document.querySelector('#nav .forge-project-section > header button')?.forgeProjectActions?.(opener); };
    const search = el('input', { type: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects' });
    const list = el('div');
    const draw = () => {
      list.replaceChildren();
      for (const project of getState().projects.filter(p => p.name.toLowerCase().includes(search.value.toLowerCase()))) {
        const source = [...document.querySelectorAll('#nav [data-forge-project]')].find(n => n.dataset.forgeProject === project.id);
        const pick = button('', () => { pickProject(project.id); update(); sheet.close(); });
        pick.append(el('strong', { text: project.name }), el('small', { text: project.path || '' }));
        pick.setAttribute('aria-pressed', String(project.id === getState().project?.id)); pick.title = project.path;
        const actions = button('...', () => { sheet.close(); source?.forgeProjectActions?.(opener); });
        actions.setAttribute('aria-label', `Project actions for ${project.name}`);
        list.append(el('div', { class: 'mf-project-row' }, [pick, actions]));
      }
      if (!list.childElementCount) list.append(emptyState({ title: 'No projects match.', text: 'Try another name or add a project.', action: { text: 'Add project', onClick: addProject } }));
    };
    search.oninput = draw; draw();
    body.append(search, list, button('Add project', addProject, 'rd-pill rd-pill-primary'));
    sheet = openMobileSheet({ title: 'Projects', content: body, opener, fullHeight: true });
  }
  function workspace(opener) {
    const { location, project, sessions } = getState();
    const body = el('div', { class: 'mf-workspace-options' });
    for (const [value, label] of [['in_place', 'Current checkout'], ['new_worktree', 'New worktree'], ['existing_branch', 'Existing branch in a new worktree']]) {
      const choice = button(label, () => { location.value = value; location.dispatchEvent(new Event('change')); update(); sheet.close(); });
      choice.disabled = !location || location.disabled || composer.querySelector('.chat-input-bottom')?.inert;
      choice.setAttribute('aria-pressed', String(location?.value === value)); body.append(choice);
    }
    const worktrees = el('details', {}, [el('summary', { text: 'Existing worktrees' })]);
    for (const s of sessions.filter(s => !s.forge.removed && s.forge.isolation !== 'in_place')) worktrees.append(button(`Continue ${s.forge.branch || s.title}`, () => { sheet.close(); go('forgeShell', { sessionId: s.id, closeSheet: true }); }));
    if (worktrees.childElementCount === 1) worktrees.append(el('p', { text: 'No existing session worktrees.' }));
    const checkout = sessions.find(s => !s.forge.removed && s.forge.isolation === 'in_place');
    const changes = button('View changes', () => { sheet.close(); go('forgeShell', { sessionId: checkout.id, mobileChanges: true, closeSheet: true }); });
    changes.disabled = location?.value !== 'in_place' || !checkout;
    body.append(worktrees, changes, button('Explorer', () => { sheet.close(); go('forgeShell', { projectId: project?.id, mobileTool: 'explorer' }); }), el('small', { text: changes.disabled ? 'Open an existing worktree to review its changes. A new worktree is created when you send.' : project?.path || 'Add a project to begin.' }));
    sheet = openMobileSheet({ title: 'Workspace', content: body, opener });
  }
  // Home: the desktop dashboard's toolbar (Customize) and cards, moved into a phone page.
  function enableOverview() {
    boardSignature = null;
    shell = el('section', { class: 'ms-shell mf-dashboard', 'aria-label': 'Forge overview' });
    newSession = button('', () => go('forgeHome', { projectId: getState().project?.id, mobilePage: 0 }), 'mf-icon mf-dashboard-new');
    newSession.innerHTML = ICONS.plus; newSession.setAttribute('aria-label', 'New session');
    const projectButton = button('', () => projects(projectButton), 'mf-icon mf-project-trigger');
    projectButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h6l2 2h8v10H4z"/></svg>';
    projectButton.setAttribute('aria-label', 'Switch project');
    const header = el('header', { class: 'ms-header' }, [el('div', { class: 'ms-header-row' }, [
      el('div', { class: 'mf-title-copy' }, [el('small', { text: 'Forge' }), el('h1', { class: 'mf-dashboard-title' })]), projectButton, newSession])]);
    const body = el('div', { class: 'mf-dashboard-body mf-overview' });
    const board = el('div', { class: 'mf-board rd-stagger' });
    const extra = el('details', { class: 'mf-dashboard-extra' }, [el('summary', { text: 'Dashboard & repository details' })]);
    body.append(board, extra); shell.append(header, body); page.prepend(shell);
    move(banner, shell); banner.classList.add('ms-background'); move(toolbar, extra); move(grid, extra);
    page.classList.add('mf-home');
  }
  function enable() {
    if (overview) { enableOverview(); update(); return; }
    shell = el('section', { class: 'ms-shell mf-project', 'aria-label': 'Forge project' });
    const projectButton = button('Projects', () => projects(projectButton)); projectButton.classList.add('mf-project-trigger');
    const tabs = [button('New', () => {}, 'ms-segment'), button('Sessions', () => {}, 'ms-segment')];
    const switcher = el('div', { class: 'ms-switch ms-glass', role: 'tablist', 'aria-label': 'Forge pages' }, [el('span', { class: 'ms-switch-thumb', 'aria-hidden': 'true' }), ...tabs]);
    const line = button('', () => workspace(line), 'mf-workspace-line');
    const homeButton = button('', () => go('forgeHome'), 'mf-icon mf-home-trigger');
    homeButton.innerHTML = ICONS.home; homeButton.setAttribute('aria-label', 'Back to Forge Home');
    const header = el('header', { class: 'ms-header' }, [el('div', { class: 'ms-header-row' }, [el('h1', { class: 'mf-page-title', text: 'New session' }), homeButton]), switcher, line, projectButton]);
    const launch = el('section', { class: 'ms-page ms-launch', role: 'tabpanel', id: 'mf-new' });
    const sessionsPage = el('section', { class: 'ms-page ms-history', role: 'tabpanel', id: 'mf-sessions' });
    tabs.forEach((tab, i) => { tab.setAttribute('role', 'tab'); tab.id = `mf-tab-${i}`; tab.setAttribute('aria-controls', i ? 'mf-sessions' : 'mf-new'); [launch, sessionsPage][i].setAttribute('aria-labelledby', tab.id); });
    const mark = el('div', { class: 'mf-mark', 'aria-hidden': 'true' });
    if (document.documentElement.dataset.mascot !== 'off') mark.append(createMascot({ state: 'idle', size: 84, decorative: true }));
    const caption = el('p', { class: 'mf-project-caption' });
    launch.append(el('div', { class: 'ms-intro' }, [mark, el('h1', { text: 'What should we work on?' }), caption]));
    const bottom = el('div', { class: 'ms-launch-bottom' }), activity = el('div', { class: 'ms-activity-slot' }); bottom.append(activity); launch.append(bottom);
    const track = el('div', { class: 'ms-page-track' }, [launch, sessionsPage]);
    shell.append(header, el('div', { class: 'ms-page-window' }, [track])); page.prepend(shell);
    move(banner, shell); banner.classList.add('ms-background'); move(composer, bottom); move(hint, bottom);
    page.classList.add('mf-home');
    pager = mountPager(shell, [launch, sessionsPage], tabs, lastPage, index => { lastPage = index; shell.dataset.forgePage = String(index); shell.querySelector('.mf-page-title').textContent = index ? 'Sessions' : 'New session'; });
    // As on the Chats launch: the shell fills the page and the keyboard lift pads its bottom.
    keyboard = watchKeyboard(shell);
    history = mountForgeSessions(sessionsPage); detachActivity = attachActivity(activity, item => getState().sessions.some(s => s.id === item.sessionId)); update();
  }
  function disable() {
    sheet?.close(); sheet = null; detachActivity?.(); keyboard?.(); keyboard = null; pager?.dispose(); history?.dispose();
    for (const [node, home] of homes) { home.after(node); home.remove(); } homes = [];
    newSession?.remove(); newSession = null;
    banner.classList.remove('ms-background'); shell?.remove(); shell = null; page.classList.remove('mf-home');
  }
  async function loadCounts() {
    const version = ++metaVersion, { sessions } = getState();
    await Promise.allSettled(sessions.filter(s => !s.forge.removed).map(async s => { s._changes = (await api(`/api/forge/sessions/${encodeURIComponent(s.id)}/changes`)).files; }));
    if (version === metaVersion && shell) paint();
  }
  function update(refreshCounts = true) { paint(); if (shell && refreshCounts) loadCounts(); }
  function paint() {
    if (!shell) return;
    const { project, sessions, models, location } = getState();
    if (project) lastProject = project.id;
    if (overview) {
      shell.querySelector('.mf-dashboard-title').textContent = project?.name || 'Forge Home';
      const board = shell.querySelector('.mf-board');
      const signature = JSON.stringify([project, sessions.map(s => [s.id, s.title, s.forge, s.model_endpoint_id, s.model_override, s._changes, sessionStatus(s)]), models, getState().apps]);
      if (signature === boardSignature) return;
      boardSignature = signature;
      const summary = project?.git, days = summary?.activity;
      const files = sessions.filter(s => !s.forge.removed && s.forge.isolation === 'in_place').slice(0, 1).flatMap(s => s._changes || []);
      const checkout = sessions.find(s => !s.forge.removed && s.forge.isolation === 'in_place');
      const branch = button('', () => workspace(branch), 'mf-workspace-line');
      const branchIcon = el('span', { class: 'mf-branch-icon', 'aria-hidden': 'true' });
      branchIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-10 6"/></svg>';
      branch.append(branchIcon, el('span', { text: `${summary?.branch || 'Current checkout'}${checkout?._changes ? ` \u00b7 ${files.length} files` : ''}` }));
      if (checkout?._changes) branch.append(diffCounts(changeTotals(files)));
      board.replaceChildren(branch);
      if (!project) { board.append(emptyState({ title: 'Choose a project', text: 'Open a project to start building.', action: { text: 'Projects', onClick: event => projects(event.currentTarget) } })); return; }
      const working = sessions.filter(s => !s.forge.removed && ['approval', 'working'].includes(sessionStatus(s).key)).sort((a, b) => sessionStatus(a).rank - sessionStatus(b).rank);
      const workingCount = working.filter(s => sessionStatus(s).key === 'working').length;
      if (days?.length) {
        const total = days.reduce((n, d) => n + d.commits, 0), max = Math.max(1, ...days.map(d => d.commits));
        board.append(el('section', { class: 'mf-activity mf-card' }, [el('div', { class: 'mf-activity-heading' }, [
          el('div', {}, [el('small', { text: `Commits, last ${days.length} days` }), el('strong', { text: String(total) })]),
          el('span', { class: 'mf-working-pill', text: `${workingCount} session${workingCount === 1 ? '' : 's'} working` })]),
          dotMatrix({ rows: 1, cols: days.length, cells: days.map(d => !d.commits ? 'empty' : d.commits / max > .5 ? 'a' : 'dim'), label: days.map(d => `${d.date}: ${d.commits} commits`).join(', ') })]));
      }
      const all = button('See all', () => go('forgeHome', { projectId: project.id, mobilePage: 1 }), 'mf-see-all');
      const rows = el('div', { class: 'mf-card mf-working-list rd-stagger' });
      for (const session of working) {
        const status = sessionStatus(session), model = session.model_override || models.find(m => m.id === session.model_endpoint_id)?.name;
        rows.append(button('', () => go('forgeShell', { sessionId: session.id }), `mf-working-row mf-status-${status.key}`));
        rows.lastChild.append(el('span', { class: 'mf-status-dot', 'aria-hidden': 'true' }), el('span', { class: 'mf-working-copy' }, [el('strong', { text: session.title }), el('small', { text: [session.forge.branch || 'In place', model].filter(Boolean).join(' · ') })]), el('small', { text: status.key === 'approval' ? 'Needs you' : 'Working' }));
      }
      board.append(el('section', { class: 'mf-working-section' }, [el('header', {}, [el('h2', { text: working.some(s => sessionStatus(s).key === 'approval') ? 'Needs you & working' : 'Working now' }), all]), working.length ? rows : emptyState({ title: 'Ready to build', text: 'No Forge sessions running.', action: { text: 'New session', onClick: () => newSession.click() } })]));
      const services = getState().apps?.filter(app => app.project_id === project.id);
      const stats = el('div', { class: 'mf-summary-grid' });
      if (services) stats.append(el('section', { class: 'mf-card' }, [el('small', { text: 'Running services' }), el('strong', { text: String(services.length) }), ...services.map(app => button(`:${app.port} preview`, () => go('forgeShell', { sessionId: app.session_id, previewSessionId: app.session_id }), 'mf-service-link'))]));
      if (summary?.lifespan) stats.append(el('section', { class: 'mf-card' }, [el('small', { text: 'Repo age' }), el('strong', { text: `${summary.lifespan.age_days} days` }), el('small', { text: summary.lifespan.first_commit ? 'since first commit' : 'No commits yet' })]));
      board.append(stats); return;
    }
    shell.querySelector('.mf-project-caption').textContent = project?.name || 'Choose a project';
    const files = location?.value === 'new_worktree' ? [] : sessions.filter(s => !s.forge.removed && s.forge.isolation === 'in_place').slice(0, 1).flatMap(s => s._changes || []);
    shell.querySelector('.mf-workspace-line').replaceChildren(el('span', { text: `${location?.value === 'new_worktree' ? 'New worktree' : project?.git?.branch || 'Current checkout'} · ${files.length} files` }), diffCounts(changeTotals(files)));
    history.update(sessions, models, refresh); refreshActivity();
  }
  const gate = () => { if (mobileOn() && !shell) enable(); else if (!mobileOn() && shell) disable(); };
  const projectsChanged = () => { if (mobileOn()) { sheet?.close(); go('forgeHome', { projectId: getState().project?.id, ...(overview ? {} : { mobilePage: lastPage }) }); } };
  // A recent project on the phone overview opens it on the New page, where its composer lives.
  const openProject = id => { if (!overview || !mobileOn()) return false; go('forgeHome', { projectId: id, mobilePage: 0 }); return true; };
  document.addEventListener('kairos:forge-projects', projectsChanged);
  phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate); gate();
  // Where a reload of Forge Home should land: the same phone page (desktop takes no options).
  const here = () => (overview || !mobileOn() ? {} : { mobileWorkspace: true });
  return { update, openProject, here, dispose() { ++metaVersion; document.removeEventListener('kairos:forge-projects', projectsChanged); disable(); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); } };
}

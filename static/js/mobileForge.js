import { api, el } from './api.js';
import { mobileOn, phone, button, go, edgeBlur } from './mobileShared.js';
import { mountPager } from './mobilePager.js';
import { openTabSheet } from './mobileTabSheet.js';
import { openMobileSheet } from './mobileSheet.js';
import { attachActivity, refreshActivity } from './mobileActivity.js';
import { mountForgeSessions } from './mobileForgeSessions.js';
import { diffCounts, changeTotals } from './forgeUi.js';
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
  let metaVersion = 0;
  let shell, pager, history, sheet, detachActivity, keyboard, newSession, homes = [];
  const move = (node, target) => { const home = document.createComment('Forge desktop home'); node.before(home); homes.push([node, home]); target.append(node); };
  function projects(opener) {
    const body = el('div', { class: 'mf-projects' });
    const search = el('input', { type: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects' });
    const list = el('div');
    const draw = () => {
      list.replaceChildren();
      for (const project of getState().projects.filter(p => p.name.toLowerCase().includes(search.value.toLowerCase()))) {
        const source = [...document.querySelectorAll('#nav [data-forge-project]')].find(n => n.dataset.forgeProject === project.id);
        const pick = button(project.name, () => { pickProject(project.id); update(); sheet.close(); });
        pick.setAttribute('aria-pressed', String(project.id === getState().project?.id)); pick.title = project.path;
        const actions = button('...', () => { sheet.close(); source?.forgeProjectActions?.(opener); });
        actions.setAttribute('aria-label', `Project actions for ${project.name}`);
        list.append(el('div', { class: 'mf-project-row' }, [pick, actions]));
      }
      if (!list.childElementCount) list.append(el('p', { text: 'No projects match.' }));
    };
    search.oninput = draw; draw();
    body.append(search, list, button('Add project', () => { sheet.close(); document.querySelector('#nav .forge-project-section > header button')?.forgeProjectActions?.(opener); }));
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
    shell = el('section', { class: 'ms-shell mf-dashboard', 'aria-label': 'Forge overview' });
    const avatar = button(document.querySelector('.sidebar-avatar')?.textContent || 'K', () => openTabSheet(avatar), 'ms-avatar ms-glass'); avatar.setAttribute('aria-label', 'Open workspace tabs');
    // The title takes the avatar's row on the right, like every phone tab; New session joins Customize on the toolbar.
    newSession = button('', () => go('forgeHome', { projectId: getState().project?.id, mobilePage: 0 }), 'ms-settings ms-glass mf-dashboard-new');
    newSession.innerHTML = ICONS.plus; newSession.setAttribute('aria-label', 'New session');
    const header = el('header', { class: 'ms-header' }, [edgeBlur('top'), el('div', { class: 'ms-header-row' }, [avatar, el('h1', { class: 'mf-dashboard-title', text: 'Forge Home' })])]);
    const body = el('div', { class: 'mf-dashboard-body mf-overview' });
    shell.append(header, body); page.prepend(shell);
    move(banner, shell); banner.classList.add('ms-background'); move(toolbar, body); move(grid, body); toolbar.append(newSession);
    page.classList.add('mf-home');
  }
  function enable() {
    if (overview) { enableOverview(); return; }
    shell = el('section', { class: 'ms-shell mf-project', 'aria-label': 'Forge project' });
    const avatar = button(document.querySelector('.sidebar-avatar')?.textContent || 'K', () => openTabSheet(avatar), 'ms-avatar ms-glass'); avatar.setAttribute('aria-label', 'Open workspace tabs');
    const projectButton = button('Projects', () => projects(projectButton)); projectButton.classList.add('mf-project-trigger');
    const tabs = [button('New', () => {}, 'ms-segment'), button('Sessions', () => {}, 'ms-segment')];
    const switcher = el('div', { class: 'ms-switch ms-glass', role: 'tablist', 'aria-label': 'Forge pages' }, [el('span', { class: 'ms-switch-thumb', 'aria-hidden': 'true' }), ...tabs]);
    const line = button('', () => workspace(line), 'mf-workspace-line');
    const header = el('header', { class: 'ms-header' }, [edgeBlur('top'), el('div', { class: 'ms-header-row' }, [avatar, switcher, projectButton]), line]);
    const launch = el('section', { class: 'ms-page ms-launch', role: 'tabpanel', id: 'mf-new' });
    const sessionsPage = el('section', { class: 'ms-page ms-history', role: 'tabpanel', id: 'mf-sessions' });
    tabs.forEach((tab, i) => { tab.setAttribute('role', 'tab'); tab.id = `mf-tab-${i}`; tab.setAttribute('aria-controls', i ? 'mf-sessions' : 'mf-new'); [launch, sessionsPage][i].setAttribute('aria-labelledby', tab.id); });
    const mark = el('div', { class: 'mf-mark', 'aria-hidden': 'true' });
    const caption = el('p', { class: 'mf-project-caption' });
    launch.append(el('div', { class: 'ms-intro' }, [mark, el('h1', { text: 'What should we work on?' }), caption]));
    const bottom = el('div', { class: 'ms-launch-bottom' }), activity = el('div', { class: 'ms-activity-slot' }); bottom.append(activity); launch.append(bottom);
    const track = el('div', { class: 'ms-page-track' }, [launch, sessionsPage]);
    shell.append(header, el('div', { class: 'ms-page-window' }, [track])); page.prepend(shell);
    move(banner, shell); banner.classList.add('ms-background'); move(composer, bottom); move(hint, bottom);
    page.classList.add('mf-home');
    pager = mountPager(shell, [launch, sessionsPage], tabs, lastPage, index => { lastPage = index; });
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
  function update(refreshCounts = true) { paint(); if (shell && refreshCounts && !overview) loadCounts(); }
  function paint() {
    if (!shell) return;
    const { project, sessions, models, location } = getState();
    if (project) lastProject = project.id;
    if (overview) return;
    shell.querySelector('.mf-mark').textContent = project?.name.slice(0, 1).toUpperCase() || 'K';
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

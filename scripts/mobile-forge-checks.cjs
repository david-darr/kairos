// Shared phone Forge contract for mobile-tabs-checks and ui-smoke.
// Uses only the smoke harness's synthetic backend.
const assert = require('node:assert/strict');

module.exports = async function mobileForgeChecks({ js, win, waitFor, delay, navigate, capture, writes, reads, demoState, overflow }) {
  let assertions = 0;
  const ok = (value, message) => { assertions++; assert.ok(value, message); };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const textButton = (root, text) => js(`[...document.querySelectorAll(${JSON.stringify(root + ' button')})].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const escape = () => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  const close = async () => { await click('dialog.ms-sheet[open] .ms-sheet-header button'); await delay(100); };
  const input = (selector, value) => js(`{ const n = document.querySelector(${JSON.stringify(selector)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); }`);
  const fit = async name => {
    ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), name + ' fits the viewport');
    ok((await overflow()).length === 0, name + ' has no page overflow');
  };
  const phoneSizes = async name => {
    const original = win.getContentSize();
    for (const [width, height] of [[390, 844], [430, 932]]) {
      win.setContentSize(width, height); await delay(300);
      await fit(`${name} ${width}x${height}`);
      await capture(`mobile-forge-${name}-${width}x${height}`);
    }
    win.setContentSize(...original); await delay(300);
  };
  const sheetNamed = async title => {
    await waitFor(`document.querySelector('dialog.ms-sheet[open]')?.getAttribute('aria-label') === ${JSON.stringify(title)}`);
    ok(await js("document.querySelector('dialog.ms-sheet[open]').contains(document.activeElement)"), title + ' owns focus');
    ok(await js("[...document.querySelectorAll('dialog.ms-sheet[open] button, dialog.ms-sheet[open] input:not([type=hidden]), dialog.ms-sheet[open] select, dialog.ms-sheet[open] summary')].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').every(n => { const r = n.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5; })"), title + ' has 44px controls');
  };
  const menu = async () => { await click('.mf-session-header [aria-label="Session actions"]'); await sheetNamed('Session actions'); };
  const tool = async name => { await menu(); await textButton('dialog.ms-sheet', name); await sheetNamed(name); };
  const cards = ['Working now', 'Running services', 'Git activity', 'Recent projects', 'Repo lifespan'];
  // The phone tab bar (mobileTabBar.js): Forge Home, New, Sessions and More.
  const barItem = async id => { await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'shown'"); await click(`.ms-tabbar [data-tabbar=${id}]`); await delay(150); };
  const barCurrent = () => js("document.querySelector('.ms-tabbar')?.dataset.state === 'shown' ? document.querySelector('.ms-tabbar [aria-current=page]')?.dataset.tabbar : 'hidden'");
  // Home: as Kairos Home opens the dashboard, Forge Home opens the overview page.
  await navigate('forgeHome');
  await waitFor("!!document.querySelector('.mf-dashboard') && document.querySelectorAll('.mf-dashboard .forge-widget-grid > section').length === 5 && document.querySelectorAll('#nav [data-forge-project]').length > 0");
  await waitFor("!!document.querySelector('.mf-dashboard .forge-activity-total') && ![...document.querySelectorAll('.mf-dashboard .forge-widget-body')].some(b => b.textContent.trim() === 'Loading...')");
  await delay(300);
  ok(await js("!document.querySelector('.mf-project') && !document.querySelector('dialog.ms-sheet[open]')"), 'Home opens the overview as a page, not the pager or a sheet');
  ok(await js("document.querySelector('.mf-dashboard-title').textContent === document.querySelector('[aria-label=Project]').textContent.trim() && !!document.querySelector('.mf-title-copy small') && !document.querySelector('.ms-avatar, #mobile-menu-btn')"), 'Overview uses the phone header, with no avatar');
  await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'shown'");
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-tabbar-item')].map(n => n.querySelector('.ms-tabbar-label').textContent)"), ['Forge Home', 'New', 'Sessions', 'More']); assertions++;
  ok(await js("parseFloat(getComputedStyle(document.querySelector('.mf-dashboard .ms-header')).paddingTop) >= 6"), 'Overview header clears the safe area');
  ok(await js("!!document.querySelector('.mf-board .mf-activity .rd-dot-matrix') && !!document.querySelector('.mf-board .mf-working-section') && document.querySelectorAll('.mf-summary-grid > section').length === 2"), 'Overview presents real activity, working sessions and paired summary cards');
  ok(await js("getComputedStyle(document.querySelector('.mf-dashboard-title')).fontStyle === 'italic' && getComputedStyle(document.querySelector('.mf-card')).borderRadius === '26px' && [...document.querySelectorAll('.mf-dashboard .ms-header-row > button')].filter(n => n.getClientRects().length).length === 2 && [...document.querySelectorAll('.mf-dashboard .mf-icon')].every(n => n.getBoundingClientRect().width === 46 && n.getBoundingClientRect().height === 46)"), 'Overview uses the board title, 26px cards and exactly two round 46px actions');
  await click('.mf-dashboard-extra > summary');
  assert.deepEqual(await js("[...document.querySelectorAll('.mf-dashboard .forge-widget-grid > section > header h2')].map(n => n.textContent)"), cards); assertions++;
  ok(await js("(() => { const s = [...document.querySelectorAll('.mf-dashboard .forge-widget-grid > section')].map(n => n.getBoundingClientRect()); return s.every(r => Math.abs(r.left - s[0].left) < 1 && Math.abs(r.width - s[0].width) < 1) && s.every((r, i) => !i || r.top >= s[i - 1].bottom); })()"), 'Overview cards stack in one full-width column');
  ok(await js("getComputedStyle(document.querySelector('.mf-dashboard .forge-panel')).borderRadius !== '0px' && getComputedStyle(document.querySelector('.mf-dashboard .forge-panel')).boxShadow !== 'none'"), 'Overview cards use the redesign card style');
  ok(await js("[...document.querySelectorAll('.mf-dashboard button, .mf-dashboard .custom-select-btn')].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').every(n => { const r = n.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5; })"), 'Overview controls are 44px');
  ok(await js("![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Project overview')"), 'The Project overview sheet button is gone');
  await fit('Forge overview');
  await click('.mf-dashboard-extra > summary');
  await capture('mobile-forge-overview');
  await phoneSizes('home');
  await click('.mf-dashboard-extra > summary');
  await js("document.querySelector('.mf-dashboard-body').scrollTop = document.querySelector('.mf-dashboard-body').scrollHeight"); await delay(200);
  await capture('mobile-forge-overview-lifespan');
  await js("document.querySelector('.mf-dashboard-body').scrollTop = 0");
  await textButton('.mf-dashboard .forge-toolbar', 'Customize');
  await waitFor("!!document.querySelector('[data-widget-toggle=working]')");
  ok(await js("document.querySelectorAll('[data-widget-toggle]').length === 5"), 'Customize retains all five visibility controls');
  await click('[data-widget-toggle=services]');
  ok(await js("document.querySelectorAll('.mf-dashboard .forge-widget-grid > section').length === 4 && !document.querySelector('.mf-dashboard .forge-widget-grid').textContent.includes('Running services')"), 'Customize hides a card on the phone overview');
  await click('[data-widget-toggle=services]');
  ok(await js("document.querySelectorAll('.mf-dashboard .forge-widget-grid > section').length === 5"), 'Customize shows it again');
  await escape(); await delay(150);
  ok(await js("!document.querySelector('[data-widget-toggle]')?.getClientRects().length"), 'Customize closes');
  ok(await barCurrent() === 'forgeHome', 'The tab bar marks Forge Home current on the overview');
  // New: as Kairos Chats opens What should we work on?, Forge New opens the pager's New page.
  await barItem('new');
  await waitFor("!!document.querySelector('.mf-project') && document.querySelector('#mf-tab-0').getAttribute('aria-selected') === 'true' && !!document.querySelector('[aria-label=Project]')");
  ok(await js("!document.querySelector('.mf-dashboard')"), 'Sessions opens the New / Sessions pager');
  await delay(500);
  await click('#mf-tab-0');
  ok(await js("document.querySelector('#mf-new').inert === false && document.querySelector('#mf-sessions').inert"), 'New is the only interactive page');
  ok(await js("document.querySelector('.mf-project .ms-intro h1').textContent === 'What should we work on?'"), 'Project has the phone introduction');
  ok(await js("document.querySelector('.mf-page-title').textContent === 'New session' && document.querySelector('.mf-home-trigger').getAttribute('aria-label') === 'Back to Forge Home'"), 'New has a serif page title and home action');
  await fit('Project New');
  await phoneSizes('new');
  // Sticky positioning alone can pass the fold checks while painting the
  // activity pills over the intro. Exercise real layout with a finished card,
  // changing activity height, and copy that must scroll within the intro.
  const originalSize = win.getContentSize();
  await js(`(() => {
    const slot = document.querySelector('#mf-new .ms-activity-slot');
    window.__forgeLayoutActivity = [...slot.children].map(node => [node, node.style.display]);
    for (const [node] of window.__forgeLayoutActivity) node.style.display = 'none';
    const activity = document.createElement('section'); activity.className = 'ms-activity';
    activity.dataset.forgeLayoutFixture = '';
    activity.innerHTML = '<div class="ms-finished-deck"><button>Finished (1)</button><button>Clear all</button><div class="ms-finished-cards"><button class="ms-finished-card ms-glass">Chat · Reply ready</button></div></div>';
    slot.append(activity);
    const caption = document.querySelector('#mf-new .mf-project-caption');
    window.__forgeLayoutCaption = caption.textContent;
    caption.textContent = 'A project with a long name that wraps across several lines on a narrow phone';
  })()`);
  try {
    for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [667, 375]]) {
      win.setContentSize(width, height); await delay(300);
      for (const activityHeight of [0, 96]) {
        await js(`document.querySelector('[data-forge-layout-fixture]').style.paddingTop = '${activityHeight}px'`);
        await delay(50);
        const layout = await js(`(() => {
          const intro = document.querySelector('#mf-new .ms-intro'), bottom = document.querySelector('#mf-new .ms-launch-bottom');
          const box = intro.getBoundingClientRect(), group = bottom.getBoundingClientRect();
          intro.scrollTop = 0;
          const first = [...intro.children].find(n => n.getClientRects().length);
          const start = first.getBoundingClientRect().top;
          intro.scrollTop = intro.scrollHeight;
          const end = intro.lastElementChild.getBoundingClientRect().bottom;
          const bar = document.querySelector('.ms-tabbar').getBoundingClientRect();
          const last = Math.max(...[...bottom.children].filter(n => n.getClientRects().length && n.getBoundingClientRect().height).map(n => n.getBoundingClientRect().bottom));
          intro.scrollTop = 0;
          return { separate: box.bottom <= group.top + 1, start: start >= box.top - 1, end: end <= box.bottom + 1, gap: bar.top - last };
        })()`);
        ok(layout.separate && layout.start && layout.end, `Forge intro scrolls fully above activity at ${width}x${height}, growth ${activityHeight}: ${JSON.stringify(layout)}`);
        ok(Math.abs(layout.gap - 10) <= 1, `Forge bottom content stays 10px above the bar at ${width}x${height}: ${JSON.stringify(layout)}`);
      }
      await capture(`mobile-forge-new-clearance-${width}x${height}`);
    }
  } finally {
    await js(`(() => {
      document.querySelector('[data-forge-layout-fixture]').remove();
      for (const [node, display] of window.__forgeLayoutActivity) node.style.display = display;
      document.querySelector('#mf-new .mf-project-caption').textContent = window.__forgeLayoutCaption;
      delete window.__forgeLayoutActivity; delete window.__forgeLayoutCaption;
    })()`);
    win.setContentSize(...originalSize); await delay(300);
  }
  ok(await barCurrent() === 'new', 'The tab bar marks New current on the pager');
  await click('#mf-tab-1'); await delay(200);
  ok(await barCurrent() === 'sessions', 'Swiping the pager to Sessions moves the bar to Sessions');
  await click('#mf-tab-0'); await delay(100);
  await barItem('more');
  await waitFor("!!document.querySelector('.ms-tab-sheet[open]')");
  ok(await js("!!document.querySelector('.ms-sheet-projects') && document.querySelectorAll('.ms-mode-row button').length === 2 && !document.querySelector('.ms-tab-sheet .ms-tab-tile')"), 'More retains projects and both workspace modes, with no tab the bar already has');
  await js("document.querySelector('.ms-tab-sheet').close()");
  await barItem('forgeHome');
  await waitFor("!!document.querySelector('.mf-dashboard') && !document.querySelector('.mf-project')");
  ok(true, 'Forge Home on the tab bar returns to the overview');
  await click('.mf-dashboard-new');
  await waitFor("!!document.querySelector('.mf-project') && document.querySelector('#mf-tab-0').getAttribute('aria-selected') === 'true' && !!document.querySelector('[aria-label=Project]')");
  ok(true, 'New session on the overview opens the New page');
  await delay(300);
  await click('.mf-project-trigger'); await sheetNamed('Projects');
  ok(await js("document.querySelector('dialog.ms-sheet').contains(document.activeElement)"), 'Projects receives focus');
  await phoneSizes('projects');
  await input('dialog.ms-sheet input', 'no-such-project');
  ok(await js("document.querySelector('dialog.ms-sheet').textContent.includes('No projects match.')"), 'Project search has an empty state');
  await input('dialog.ms-sheet input', '');
  ok(await js("document.querySelectorAll('.mf-project-row').length >= 2 && [...document.querySelectorAll('.mf-projects button')].some(b => b.textContent === 'Add project')"), 'Projects offers select, actions and Add');
  await close();
  ok(await js("document.activeElement.classList.contains('mf-project-trigger')"), 'Projects returns focus');
  await click('.mf-workspace-line'); await sheetNamed('Workspace');
  ok(await js("['Current checkout', 'New worktree', 'Existing worktrees', 'View changes'].every(t => document.querySelector('dialog.ms-sheet').textContent.includes(t))"), 'Workspace exposes all locations and review');
  await close();
  ok(await js("!document.querySelector('.mf-project .ms-intro button')"), 'New keeps its introduction without an overview button');
  await js("document.querySelector('.forge-composer textarea').focus()");
  await waitFor("!!document.querySelector('.forge-composer.ms-composer-expanded')");
  ok(await js("getComputedStyle(document.querySelector('.forge-composer .chat-input-left')).display !== 'none'"), 'Expanded composer contains the original location and mode controls');
  await js("document.activeElement.blur()"); await delay(250);
  await click('#mf-tab-1');
  await waitFor("document.querySelectorAll('#mf-sessions .ms-history-row').length > 0");
  ok(await js("document.querySelector('#mf-new').inert && !document.querySelector('#mf-sessions').inert"), 'Sessions owns interaction after paging');
  ok(await js("document.querySelector('#mf-sessions').firstElementChild.classList.contains('ms-history-search') && [...document.querySelectorAll('.mf-session-group h2')].every(n => ['Today', 'Earlier'].includes(n.textContent))"), 'Sessions puts search above its date-grouped cards');
  await phoneSizes('sessions');
  await input('#mf-sessions input[type=search]', 'no-matching-session'); await delay(300);
  ok(await js("document.querySelector('#mf-sessions').textContent.includes('No matching sessions.')"), 'Session search has an empty state');
  await input('#mf-sessions input[type=search]', ''); await delay(300);
  await textButton('#mf-sessions .ms-history-search', 'Filter');
  ok(await js("!!document.querySelector('#mf-sessions [aria-label=\"Filter sessions\"]') && !!document.querySelector('#mf-sessions [aria-label=\"Filter by model\"]')"), 'Search dock offers state and model filters');
  ok(await js("document.querySelector('#mf-sessions .ms-history-filters').getBoundingClientRect().top >= document.querySelector('#mf-sessions .ms-history-search').getBoundingClientRect().bottom"), 'Top search opens its filter menu below the dock');
  await click('#mf-sessions .ms-row-more');
  ok(await js("['Rename', 'Delete'].every(t => document.querySelector('.ms-actions-open').textContent.includes(t))"), 'Session row actions are reachable without gestures');
  await click('#mf-sessions .ms-history-main'); // dismiss revealed actions
  if (demoState) {
    await click('#mf-tab-0');
    await js("{ const project = document.querySelector('[aria-label=Project]').parentElement; project.value = 'fp1'; project.dispatchEvent(new Event('change')); const agent = document.querySelector('[aria-label=Agent]').parentElement; agent.value = 'm2'; agent.dispatchEvent(new Event('change')); }");
    await input('#forge-message', 'Build the Forge fixture');
    await waitFor("!document.querySelector('.forge-composer-send').disabled");
    await require('./forge-first-commit-checks.cjs')({ js, waitFor, capture, writes, demoState, label: 'mobile-project' });
  } else await click('#mf-sessions .ms-history-main');
  await waitFor("!!document.querySelector('.mf-session .forge-transcript-composer')");
  const forgeSessionId = await js("document.querySelector('.forge-surface-tabs [aria-selected=true]').closest('[data-surface-id]').dataset.surfaceId.slice(8)");
  await waitFor("document.querySelector('.forge-send')?.textContent === 'Send'");
  await delay(300);
  await waitFor("document.querySelector('.ms-tabbar')?.dataset.state === 'shown'");
  ok(await barCurrent() === 'sessions', 'The session keeps Sessions current on the tab bar');
  ok(await js("document.querySelector('.forge-project-sidebar').hidden && !document.querySelector('.forge-workspace').inert"), 'Conversation opens directly without the old sidebar modal');
  ok(await js("!!document.querySelector('.mf-session-header strong') && !!document.querySelector('.mf-count')"), 'Session title, subtitle and changes badge are present');
  ok(await js("getComputedStyle(document.querySelector('.forge-surface-bar')).display === 'none' && document.querySelector('.forge-shell').dataset.split === 'false'"), 'Phone has neither desktop tabs nor side-by-side panes');
  await fit('Conversation'); await capture('mobile-forge-session');
  await phoneSizes('session');
  await menu();
  ok(await js("['Run app', 'Terminal', 'Explorer', 'Editor', 'End session', 'Rename', 'Session baseline changes', 'Open sessions and tools'].every(t => document.querySelector('dialog.ms-sheet').textContent.includes(t))"), 'Session menu retains every tool and lifecycle action');
  await close();
  await click('.ms-forge-add'); await sheetNamed('Session tools');
  ok(await js("document.querySelector('dialog.ms-sheet').contains(document.activeElement)"), 'Composer tools move focus into the shared sheet');
  await close();
  ok(await js("document.activeElement.classList.contains('ms-forge-add')"), 'Composer tools restore focus');
  await menu(); await textButton('dialog.ms-sheet', 'Run app');
  await waitFor("!!document.querySelector('.forge-app-command-input')");
  await input('.forge-app-command-input', `npm run dev -- --port {port} --phone-forge-${Date.now()}`);
  const appStart = writes.length;
  await textButton('.modal-panel', 'Save and run');
  // The smoke backend remembers earlier approvals for this project, so the sheet appears only the first time.
  await waitFor("!!document.querySelector('.forge-app-approval') || !!document.querySelector('.forge-pane .forge-app-preview-surface iframe')");
  if (await js("!!document.querySelector('.forge-app-approval')")) {
    ok(await js("document.querySelector('.forge-app-approval').classList.contains('ms-sheet-surface')"), 'Run app retains the approval sheet');
    await textButton('.forge-app-approval', 'Approve command');
  }
  await waitFor("!!document.querySelector('.forge-pane .forge-app-preview-surface iframe')");
  ok(writes.slice(appStart).some(w => w.path.endsWith('/app/start')), 'App startup uses the existing handler');
  ok(await js("document.querySelector('.forge-shell').dataset.split === 'false' && !!document.querySelector('.mf-back')"), 'App preview replaces the conversation and has Back');
  await phoneSizes('preview');
  for (const preset of ['phone', 'tablet', 'desktop']) {
    await click(`[data-preview-width=${preset}]`);
    ok(await js(`document.querySelector('[data-preview-width=${preset}]').getAttribute('aria-pressed') === 'true'`), 'Preview retains ' + preset + ' sizing');
  }
  await js("document.querySelector('.forge-preview-logs').open = true");
  await waitFor("!!document.querySelector('.forge-preview-log-controls')");
  await textButton('.forge-preview-log-controls', 'Stop');
  await waitFor("document.querySelector('.forge-preview-status').textContent.includes('stopped')");
  ok(writes.slice(appStart).some(w => w.path.endsWith('/app/stop')), 'Logs retains Stop app');
  await click('.mf-back');
  await tool('Explorer');
  await waitFor("(() => { document.querySelectorAll('dialog.ms-sheet .forge-tree-directory:not([open])').forEach(d => d.open = true); return [...document.querySelectorAll('dialog.ms-sheet [data-file-path]')].some(n => n.getClientRects().length); })()");
  ok(await js("document.querySelector('dialog.ms-sheet').classList.contains('ms-sheet-full')"), 'Explorer is full-height');
  await js("[...document.querySelectorAll('dialog.ms-sheet [data-file-path]')].find(n => n.getClientRects().length).click()");
  await waitFor("!!document.querySelector('.forge-pane .cm-editor') && !document.querySelector('dialog.ms-sheet')");
  ok(await js("!!document.querySelector('.mf-back') && !!document.querySelector('.forge-pane .forge-editor-toolbar')"), 'Editor pushes with Back and Save');
  await click('.mf-back');
  await waitFor("!!document.querySelector('.forge-pane .forge-transcript-composer')");
  await click('.mf-changes'); await sheetNamed('Changes');
  await waitFor("!!document.querySelector('.mf-git-dock')");
  await phoneSizes('changes');
  ok(await js("[...document.querySelectorAll('.mf-git .forge-git-files > strong')].map(n => n.textContent).join(',') === 'Staged,Changes'"), 'Changes separates staged and unstaged files');
  ok(await js("['Stage all', 'Unstage all'].every(t => [...document.querySelectorAll('.mf-git button')].some(b => b.textContent === t))"), 'Both bulk staging actions are retained');
  const before = writes.length;
  const primary = await js("document.querySelector('.mf-git-dock button')?.textContent");
  if (primary === 'Stage all') {
    await click('.mf-git-dock button');
    await waitFor("document.querySelector('.mf-git-dock button')?.textContent.startsWith('Commit ')");
    ok(writes.slice(before).some(w => /\/git$/.test(w.path) && JSON.parse(w.body).action === 'stage'), 'Stage all uses the existing Git handler');
  }
  if (await js("!!document.querySelector('.mf-file-open')")) {
    await click('.mf-file-open');
    await waitFor("!!document.querySelector('.forge-pane .forge-diff-viewer') && !document.querySelector('dialog.ms-sheet')");
    ok(await js("!!document.querySelector('.forge-diff-scroll[tabindex]')"), 'File opens the original accessible diff');
    if (demoState && reads) await require('./forge-hunk-revert-checks.cjs')({ js, waitFor, capture, writes, reads, demoState, label: 'mobile-project', forgeSessionId });
    await click('.mf-back'); await click('.mf-changes'); await sheetNamed('Changes'); await waitFor("!!document.querySelector('.mf-git-dock')");
  }
  if (await js("document.querySelector('.mf-git-dock button')?.textContent.startsWith('Commit ')")) {
    await click('.mf-git-dock button');
    await waitFor("!!document.querySelector('.mf-commit')");
    ok(await js("document.activeElement.getAttribute('aria-label') === 'Commit message' && document.querySelector('.mf-commit .forge-small-button').disabled"), 'Commit focuses the original empty message and prevents blank submission');
    await input('.mf-commit textarea', 'Phone Forge review');
    const at = writes.length;
    await click('.mf-commit .forge-small-button');
    await waitFor("!document.querySelector('.mf-commit')");
    ok(writes.slice(at).some(w => /\/git$/.test(w.path) && JSON.parse(w.body).message === 'Phone Forge review'), 'Commit sheet uses the existing commit action and draft');
  }
  await capture('mobile-forge-changes');
  // Close any remaining Changes sheet, then inspect the retained lifecycle flow.
  if (await js("!!document.querySelector('dialog.ms-sheet[open]')")) await close();
  if (demoState) {
    // A diff replaced the preview tab; open a file again so the editor flow has its surface.
    await tool('Explorer');
    await waitFor("(() => { document.querySelectorAll('dialog.ms-sheet .forge-tree-directory:not([open])').forEach(d => d.open = true); return [...document.querySelectorAll('dialog.ms-sheet [data-file-path]')].some(n => n.getClientRects().length); })()");
    await js("[...document.querySelectorAll('dialog.ms-sheet [data-file-path]')].find(n => n.getClientRects().length).click()");
    await waitFor("!!document.querySelector('.forge-pane .cm-editor') && !document.querySelector('dialog.ms-sheet')");
  }
  if (demoState) await require('./forge3-checks.cjs')({ js, waitFor, capture, writes, demoState, label: 'mobile-project', forgeSessionId, width: 390 });
  if (!await js("!!document.querySelector('.forge-pane .forge-transcript-composer')")) {
    await menu();
    await js("{ const details = document.querySelector('.mf-session-actions details'); details.open = true; const title = document.querySelector('.forge-surface-tab-group[data-surface-type=session] .forge-surface-tab').textContent; [...details.querySelectorAll('button')].find(button => button.textContent === title).click(); }");
    await waitFor("!!document.querySelector('.forge-pane .forge-transcript-composer')");
    ok(true, 'Open sessions and tools restores the retained conversation');
  }
  await menu(); await textButton('dialog.ms-sheet', 'End session');
  await waitFor("!!document.querySelector('.forge-end-options')");
  ok(await js("document.querySelectorAll('.forge-end-options button').length === 4"), 'All four end-session choices stay reachable');
  await escape(); await delay(100);
  await click('.mf-back');
  await waitFor("!!document.querySelector('.mf-project') && document.querySelector('#mf-tab-1').getAttribute('aria-selected') === 'true'");
  ok(true, 'Back returns to the project Sessions page');
  for (const [width, height] of [[320, 640], [430, 932], [667, 375]]) {
    win.setContentSize(width, height); await delay(250); await fit(`Forge ${width}x${height}`);
  }
  win.setContentSize(1440, 900); await delay(250);
  ok(await js("!document.querySelector('.mf-project') && !!document.querySelector('.forge-hero .forge-composer') && !!document.querySelector('.forge-widget-grid')"), 'Desktop restores the original composer and dashboard nodes');
  win.setContentSize(390, 844); await delay(250);
  ok(await js("document.querySelectorAll('.mf-project').length === 1 && document.querySelectorAll('#forge-message').length === 1"), 'Resize back creates one phone workspace with the original input');
  await navigate('forgeHome');
  await waitFor("document.querySelectorAll('.mf-dashboard .forge-widget-grid > section').length === 5");
  for (const [width, height] of [[390, 844], [430, 932], [320, 640], [667, 375]]) {
    win.setContentSize(width, height); await delay(250); await fit(`Forge overview ${width}x${height}`);
  }
  win.setContentSize(1440, 900); await delay(250);
  ok(await js("!document.querySelector('.mf-dashboard') && !!document.querySelector('.forge-home > .forge-toolbar + .forge-widget-grid') && document.querySelectorAll('.forge-widget-grid > section').length === 5"), 'Desktop restores the toolbar and cards from the overview');
  win.setContentSize(390, 844); await delay(250);
  ok(await js("document.querySelectorAll('.mf-dashboard').length === 1 && document.querySelectorAll('.mf-dashboard .forge-widget-grid').length === 1"), 'Resize back creates one phone overview');
  return { assertions };
};

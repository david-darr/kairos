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
  const sheetNamed = async title => {
    await waitFor(`document.querySelector('dialog.ms-sheet[open]')?.getAttribute('aria-label') === ${JSON.stringify(title)}`);
    ok(await js("document.querySelector('dialog.ms-sheet[open]').contains(document.activeElement)"), title + ' owns focus');
    ok(await js("[...document.querySelectorAll('dialog.ms-sheet[open] button, dialog.ms-sheet[open] input:not([type=hidden]), dialog.ms-sheet[open] select, dialog.ms-sheet[open] summary')].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').every(n => { const r = n.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5; })"), title + ' has 44px controls');
  };
  const menu = async () => { await click('.mf-session-header [aria-label="Session actions"]'); await sheetNamed('Session actions'); };
  const tool = async name => { await menu(); await textButton('dialog.ms-sheet', name); await sheetNamed(name); };
  await navigate('forgeHome');
  await waitFor("!!document.querySelector('.mf-project') && document.querySelectorAll('#nav [data-forge-project]').length > 0 && !!document.querySelector('[aria-label=Project]')");
  await delay(500);
  await click('#mf-tab-0');
  ok(await js("document.querySelector('#mf-new').inert === false && document.querySelector('#mf-sessions').inert"), 'New is the only interactive page');
  ok(await js("document.querySelector('.mf-project .ms-intro h1').textContent === 'What should we work on?'"), 'Project has the phone introduction');
  await fit('Project New');
  await click('.mf-project .ms-avatar');
  await waitFor("!!document.querySelector('.ms-tab-sheet[open]')");
  ok(await js("!!document.querySelector('.ms-sheet-projects') && document.querySelectorAll('.ms-mode-row button').length === 2"), 'Avatar retains projects and both workspace modes');
  await escape(); await delay(100);
  await click('.mf-project-trigger'); await sheetNamed('Projects');
  ok(await js("document.querySelector('dialog.ms-sheet').contains(document.activeElement)"), 'Projects receives focus');
  await input('dialog.ms-sheet input', 'no-such-project');
  ok(await js("document.querySelector('dialog.ms-sheet').textContent.includes('No projects match.')"), 'Project search has an empty state');
  await input('dialog.ms-sheet input', '');
  ok(await js("document.querySelectorAll('.mf-project-row').length >= 2 && [...document.querySelectorAll('.mf-projects button')].some(b => b.textContent === 'Add project')"), 'Projects offers select, actions and Add');
  await close();
  ok(await js("document.activeElement.classList.contains('mf-project-trigger')"), 'Projects returns focus');
  await click('.mf-workspace-line'); await sheetNamed('Workspace');
  ok(await js("['Current checkout', 'New worktree', 'Existing worktrees', 'View changes'].every(t => document.querySelector('dialog.ms-sheet').textContent.includes(t))"), 'Workspace exposes all locations and review');
  await close();
  await textButton('.mf-project .ms-intro', 'Project overview'); await sheetNamed('Project overview');
  await waitFor("document.querySelectorAll('.mf-overview .forge-widget-grid > section').length === 5");
  ok(await js("['Working now', 'Running services', 'Git activity', 'Recent projects', 'Repo lifespan', 'Customize'].every(t => document.querySelector('.mf-overview').textContent.includes(t))"), 'Overview retains every dashboard and Customize');
  await textButton('.mf-overview .forge-toolbar', 'Customize');
  await waitFor("!!document.querySelector('[data-widget-toggle=working]')");
  ok(await js("document.querySelectorAll('[data-widget-toggle]').length === 5"), 'Customize retains all five visibility controls');
  await escape(); await delay(100); await close();
  await js("document.querySelector('.forge-composer textarea').focus()");
  await waitFor("!!document.querySelector('.forge-composer.ms-composer-expanded')");
  ok(await js("getComputedStyle(document.querySelector('.forge-composer .chat-input-left')).display !== 'none'"), 'Expanded composer contains the original location and mode controls');
  await js("document.activeElement.blur()"); await delay(250);
  await click('#mf-tab-1');
  await waitFor("document.querySelectorAll('#mf-sessions .ms-history-row').length > 0");
  ok(await js("document.querySelector('#mf-new').inert && !document.querySelector('#mf-sessions').inert"), 'Sessions owns interaction after paging');
  await input('#mf-sessions input[type=search]', 'no-matching-session'); await delay(300);
  ok(await js("document.querySelector('#mf-sessions').textContent.includes('No matching sessions.')"), 'Session search has an empty state');
  await input('#mf-sessions input[type=search]', ''); await delay(300);
  await textButton('#mf-sessions .ms-history-dock', 'Filter');
  ok(await js("!!document.querySelector('#mf-sessions [aria-label=\"Filter sessions\"]') && !!document.querySelector('#mf-sessions [aria-label=\"Filter by model\"]')"), 'Search dock offers state and model filters');
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
  ok(await js("document.querySelector('.forge-project-sidebar').hidden && !document.querySelector('.forge-workspace').inert"), 'Conversation opens directly without the old sidebar modal');
  ok(await js("!!document.querySelector('.mf-session-header strong') && !!document.querySelector('.mf-count')"), 'Session title, subtitle and changes badge are present');
  ok(await js("getComputedStyle(document.querySelector('.forge-surface-bar')).display === 'none' && document.querySelector('.forge-shell').dataset.split === 'false'"), 'Phone has neither desktop tabs nor side-by-side panes');
  await fit('Conversation'); await capture('mobile-forge-session');
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
  await waitFor("!!document.querySelector('dialog.ms-sheet .forge-tree-row')");
  ok(await js("document.querySelector('dialog.ms-sheet').classList.contains('ms-sheet-full')"), 'Explorer is full-height');
  await js("document.querySelector('dialog.ms-sheet .forge-tree-directory').open = true");
  await waitFor("!!document.querySelector('dialog.ms-sheet [data-file-path]')");
  await click('dialog.ms-sheet [data-file-path]');
  await waitFor("!!document.querySelector('.forge-pane .cm-editor') && !document.querySelector('dialog.ms-sheet')");
  ok(await js("!!document.querySelector('.mf-back') && !!document.querySelector('.forge-pane .forge-editor-toolbar')"), 'Editor pushes with Back and Save');
  await click('.mf-back');
  await waitFor("!!document.querySelector('.forge-pane .forge-transcript-composer')");
  await click('.mf-changes'); await sheetNamed('Changes');
  await waitFor("!!document.querySelector('.mf-git-dock')");
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
    await waitFor("!!document.querySelector('dialog.ms-sheet .forge-tree-row')");
    await js("document.querySelector('dialog.ms-sheet .forge-tree-directory').open = true");
    await waitFor("!!document.querySelector('dialog.ms-sheet [data-file-path]')");
    await click('dialog.ms-sheet [data-file-path]');
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
  return { assertions };
};

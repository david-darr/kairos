// Bots skills, Phase 2 unit U3 (2026-10-29): the Skills section, the Skill library page and the learned-skill card, in the renderer.
// Run: node scripts/run-electron-test.cjs ui-smoke --bots-skills-only (the full run includes it). Spec: Kairos Projects/Agents Redesign/phase-2-design.md, section 7 U3.
//
// Backend: scripts/fixtures/bots-skills-backend.cjs (state under demoState.botsSkills). The check makes its own bot, its own private and library
// skills and its own proposals; it mounts the two section modules into a scratch host (the way scripts/bots-look-checks.cjs does for the row
// kit), flips <html data-app-mode="bots"> for the length of the run, and puts everything back in finally.
// Covers: review before enable, the hash sent, a changed-after-review refusal and reload, imported Markdown staying inert, assignment and
// Every bot with chips, a learned proposal with references (apply, receipt, Undo), a held conflict (422, review again), and no renderer errors.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

const SKILL = (name, body = 'Step one.') => `---\nname: ${name}\ndescription: Does ${name}\n---\n\n# ${name}\n\n${body}\n`;
const HOSTILE = SKILL('hostile-import', '<img src=x onerror="window.__skillsPwned=1"><script>window.__skillsPwned=2</script><style>body{display:none}</style>[click](javascript:window.__skillsPwned=3)');

module.exports = async ({ js, waitFor, delay, win, capture, writes, demoState, base }) => {
  const call = (path, method = 'GET', body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const has = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
  const click = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw new Error('missing ${selector.replace(/'/g, '')}'); n.click(); return true; })()`);
  const fill = (selector, value) => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const state = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.dataset.state || ''`);
  const waitFor2 = (expression) => waitFor(expression);
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";

  const restore = await isolateBotsCheck({ js, demoState }, {
    botsSkills: undefined,
    botsSkillsSource: { 'acme/evil': [{ name: 'hostile-import', skill_md: HOSTILE }] },
  });
  let mounted = false;
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    // Its own bot (the fixture roster belongs to bots-core-backend).
    const created = await call('/api/agents', 'POST', { name: 'Skills Check Bot' });
    assert.equal(created.status, 200, 'the check creates its own bot');
    const botId = created.body.id || created.body.agent?.id;
    assert.ok(botId, 'the new bot has an id');
    const base_ = `/api/bots/${botId}`;

    // The scratch host: Bots tokens and styles apply under <html data-app-mode="bots">.
    await js(`(async () => {
      window.__skillsPrevMode = document.documentElement.dataset.appMode || '';
      document.documentElement.dataset.appMode = 'bots';
      const ui = await import('/static/js/botsUi.js');
      await ui.loadBotsCss('/static/css/bots.css');
      document.getElementById('skills-scratch')?.remove();
      const host = document.createElement('div');
      host.id = 'skills-scratch';
      host.style.cssText = 'position:fixed;left:24px;top:24px;width:460px;max-height:92vh;overflow:auto;z-index:30;background:var(--bots-app);padding:12px';
      document.body.append(host);
      window.__sk = { host, handle: null, advanced: false, pwn: 0 };
      return true;
    })()`);
    mounted = true;
    const mount = (file, advanced = false) => js(`(async () => {
      const s = window.__sk;
      s.handle?.destroy(); s.host.replaceChildren(); s.advanced = ${advanced};
      const module = await import('/static/js/${file}');
      s.handle = module.mount(s.host, { agentId: ${JSON.stringify(botId)}, state: { agent: { id: ${JSON.stringify(botId)} } }, advanced: () => window.__sk.advanced,
        flush: async () => true, refresh() {}, go() {} });
      return typeof s.handle.destroy === 'function' && typeof s.handle.refresh === 'function' && typeof s.handle.flush === 'function';
    })()`);
    const lastWrite = (method, pattern) => [...writes].reverse().find(w => w.method === method && pattern.test(w.path));

    // -- Seed: a written command, a library skill and a proposal with references -------------------------
    assert.equal((await call(`${base_}/skill-template`, 'POST', { name: 'weekly-summary', description: 'Summarise the week', instructions: 'Collect the notes.' })).status, 200);
    assert.equal((await call('/api/bots/skills-library', 'POST', { content: SKILL('shared-playbook', 'Library procedure.') })).status, 200);
    const proposal = await call(`${base_}/skill-requests`, 'POST', { name: 'file-receipts', skill_md: SKILL('file-receipts', 'Rename, then file.'), gist: 'How receipts get filed',
      references: { 'references/naming.md': 'Use the date first, then the shop.' } });
    assert.equal(proposal.status, 200, 'a proposal is staged');

    // -- Skills section: the empty and populated states --------------------------------------------------
    assert.equal(await mount('botsSectionSkills.js'), true, 'mount returns {destroy, refresh, flush}');
    await waitFor("!!document.querySelector('#skills-scratch .bots-skill-item')");
    assert.equal(await state('[data-skill="weekly-summary"]'), 'review', 'a written command waits for review');
    assert.equal(await js("document.querySelector('[data-skill=\"weekly-summary\"] [role=switch]').getAttribute('aria-checked')"), 'false', 'and its switch is off');
    assert.ok(await has('.bots-skill-card[data-request]'), 'the learned proposal shows as a card in Skills, with no conversation needed');
    assert.match(await text('.bots-skill-card .bots-skill-card-head'), /Enable skill file-receipts/);
    assert.ok((await text('.bots-skill-card')).includes('Use the date first, then the shop.'), 'the card shows the reference text');
    assert.ok(await has('.bots-skill-card pre.bots-skill-text'), 'the full text is plain text in a pre');
    await capture?.('desktop-bots-skills-section');

    // -- Review before enable; the reviewed hash is sent ---------------------------------------------------
    await js("document.querySelector('[data-skill=\"weekly-summary\"] [role=switch]').click()");
    await waitFor("!!document.querySelector('[data-skill=\"weekly-summary\"] .bots-skill-inspect pre.bots-skill-text')");
    assert.ok((await text('[data-skill="weekly-summary"] .bots-skill-inspect')).includes('Collect the notes.'), 'the full SKILL.md is shown first');
    assert.equal(await state('[data-skill="weekly-summary"]'), 'review', 'pressing the switch alone does not turn it on');
    const detail = (await call(`${base_}/skills/weekly-summary`)).body;
    await js(`[...document.querySelectorAll('[data-skill="weekly-summary"] .bots-btn')].find(b => b.textContent === 'Enable reviewed skill').click()`);
    await waitFor("document.querySelector('[data-skill=\"weekly-summary\"]')?.dataset.state === 'on'");
    const sent = JSON.parse(lastWrite('PATCH', /\/skills\/weekly-summary$/).body);
    assert.deepEqual([sent.enabled, sent.reviewed_sha256, sent.expected_revision], [true, detail.sha256, detail.storage_revision], 'enable carries the hash of the text on screen');

    // -- Changed after review: the refusal, then Reload and review again ----------------------------------------
    assert.equal((await call(`${base_}/skill-template`, 'POST', { name: 'drifting-notes', description: 'Notes that drift', instructions: 'First text.' })).status, 200);
    await js("window.__sk.handle.refresh()");
    await waitFor("!!document.querySelector('[data-skill=\"drifting-notes\"]')");
    await js("document.querySelector('[data-skill=\"drifting-notes\"] .bots-skill-main').click()");
    await waitFor("!!document.querySelector('[data-skill=\"drifting-notes\"] pre.bots-skill-text')");
    // Behind the open review, the skill is rewritten (a new revision), as if someone edited it after the person started reading.
    const drift = demoState.botsSkills.bots[botId].skills['drifting-notes'];
    drift.sha256 = 'f'.repeat(64); drift.storage_revision = 'rev-drifted'; drift.skill_md += '\nSneaky addition.';
    await js(`[...document.querySelectorAll('[data-skill="drifting-notes"] .bots-btn')].find(b => b.textContent === 'Enable reviewed skill').click()`);
    await waitFor("!!document.querySelector('[data-skill=\"drifting-notes\"] .bots-skill-status.error')");
    assert.match(await text('[data-skill="drifting-notes"] .bots-skill-status.error'), /changed since you opened it/);
    assert.notEqual(await state('[data-skill="drifting-notes"]'), 'on', 'a stale review enables nothing');
    assert.equal(await js(`[...document.querySelectorAll('[data-skill="drifting-notes"] .bots-btn')].find(b => b.textContent === 'Enable reviewed skill').disabled`), true, 'the enable button waits for a reload');
    await js(`[...document.querySelectorAll('[data-skill="drifting-notes"] .bots-btn')].find(b => b.textContent === 'Reload').click()`);
    await waitFor("document.querySelector('[data-skill=\"drifting-notes\"] pre.bots-skill-text')?.textContent.includes('Sneaky addition.')");
    await js(`[...document.querySelectorAll('[data-skill="drifting-notes"] .bots-btn')].find(b => b.textContent === 'Enable reviewed skill').click()`);
    await waitFor("document.querySelector('[data-skill=\"drifting-notes\"]')?.dataset.state === 'on'");

    // Files edited on disk after review: the row says so and offers no enable.
    demoState.botsSkills.bots[botId].skills['weekly-summary'].changed_after_review = true;
    await js("window.__sk.handle.refresh()");
    await waitFor("document.querySelector('[data-skill=\"weekly-summary\"]')?.dataset.state === 'changed'");
    await js("document.querySelector('[data-skill=\"weekly-summary\"] .bots-skill-main').click()");
    await waitFor("!!document.querySelector('[data-skill=\"weekly-summary\"] .bots-skill-inspect .bots-skill-status.error')");
    assert.equal(await js(`[...document.querySelectorAll('[data-skill="weekly-summary"] .bots-btn')].some(b => b.textContent === 'Enable reviewed skill')`), false, 'no enable for changed files');
    demoState.botsSkills.bots[botId].skills['weekly-summary'].changed_after_review = false;

    // -- Imported Markdown is inert ------------------------------------------------------------------------------
    await fill('.bots-skills .bots-text-row input', 'acme/evil');
    await js(`[...document.querySelectorAll('.bots-skills .bots-btn')].find(b => b.textContent === 'Import').click()`);
    await waitFor("!!document.querySelector('[data-skill=\"hostile-import\"]')");
    assert.equal(await state('[data-skill="hostile-import"]'), 'review', 'an import lands switched off');
    assert.match(await text('.bots-skill-outcome'), /1 skill added, switched off until you review them/);
    await js("document.querySelector('[data-skill=\"hostile-import\"] .bots-skill-main').click()");
    await waitFor("!!document.querySelector('[data-skill=\"hostile-import\"] pre.bots-skill-text')");
    const inert = await js(`(() => {
      const pre = document.querySelector('[data-skill="hostile-import"] pre.bots-skill-text');
      return { children: pre.children.length, hasText: pre.textContent.includes('<script>') && pre.textContent.includes('onerror'),
        imgs: document.querySelectorAll('#skills-scratch img').length, scripts: document.querySelectorAll('#skills-scratch script, #skills-scratch style').length,
        links: document.querySelectorAll('#skills-scratch a[href^="javascript"]').length, pwned: window.__skillsPwned || 0,
        bodyDisplay: getComputedStyle(document.body).display, visible: document.querySelector('.dashboard-core') ? getComputedStyle(document.querySelector('.dashboard-core')).display : 'block' };
    })()`);
    assert.deepEqual([inert.children, inert.hasText, inert.imgs, inert.scripts, inert.links, inert.pwned], [0, true, 0, 0, 0, 0], 'imported Markdown is text only: no elements, no handlers, no script');
    assert.notEqual(inert.bodyDisplay, 'none', 'its style rule did not apply to the page');
    await capture?.('desktop-bots-skills-inert');

    // -- A learned proposal: apply, receipt, Undo --------------------------------------------------------------------
    await js(`document.querySelector('.bots-skill-card[data-request] [data-action="apply"]').click()`);
    await waitFor("document.querySelector('[data-skill=\"file-receipts\"]')?.dataset.state === 'on'");
    const applied = JSON.parse(lastWrite('POST', /\/skill-requests\/[^/]+\/apply$/).body);
    assert.equal(applied.reviewed_sha256, proposal.body.bundle_sha256, 'apply sends the hash of the staged bundle');
    assert.equal(applied.expected_base_revision, 'absent', 'and the base revision it was staged against');
    const receipts = (await call(`${base_}/skill-requests?closed=true`)).body.requests.filter(r => r.status === 'applied');
    assert.equal(receipts.length, 1);
    assert.ok(receipts[0].receipt.id, 'the applied card has a receipt');
    // The applied card leaves the waiting list; Undo is the card's own button, so re-mount the card through the API's view.
    await js(`(async () => {
      const m = await import('/static/js/botsSkillRequest.js');
      const request = (await (await fetch(${JSON.stringify(base_ + '/skill-requests?closed=true')})).json()).requests.find(r => r.status === 'applied');
      const slot = document.createElement('div'); slot.id = 'applied-card'; document.getElementById('skills-scratch').prepend(slot);
      window.__sk.card = m.mountSkillRequestCard(slot, { agentId: ${JSON.stringify(botId)}, request });
      return true;
    })()`);
    assert.match(await text('#applied-card'), /Enabled as \/file-receipts/);
    assert.match(await text('#applied-card'), /Receipt rc-/);
    await js(`document.querySelector('#applied-card [data-action="undo"]').click()`);
    await waitFor("/Undone/.test(document.querySelector('#applied-card')?.textContent || '')");
    assert.equal((await call(`${base_}/skills/file-receipts`)).status, 404, 'Undo removed the skill it had created');
    await js("window.__sk.card.destroy(); document.getElementById('applied-card')?.remove(); window.__sk.handle.refresh(); true");

    // -- A held conflict: 422, the reason, Review again, then apply --------------------------------------------------------
    const updateCard = (await call(`${base_}/skill-requests`, 'POST', { name: 'weekly-summary', skill_md: SKILL('weekly-summary', 'Proposed rewrite.') })).body;
    assert.equal(updateCard.kind, 'update', 'a proposal against an existing skill is an update');
    await js("window.__sk.handle.refresh()");
    await waitFor(`!!document.querySelector('.bots-skill-card[data-request="${updateCard.id}"]')`);
    assert.match(await text(`.bots-skill-card[data-request="${updateCard.id}"] .bots-skill-card-head`), /Update skill weekly-summary/);
    assert.ok(await has(`.bots-skill-card[data-request="${updateCard.id}"] .bots-skill-diff`), 'an update shows the changes as a diff');
    // Someone else changes the skill first.
    const current = demoState.botsSkills.bots[botId].skills['weekly-summary'];
    current.storage_revision = 'rev-moved-on';
    await js(`document.querySelector('.bots-skill-card[data-request="${updateCard.id}"] [data-action="apply"]').click()`);
    await waitFor(`document.querySelector('.bots-skill-card[data-request="${updateCard.id}"]')?.dataset.phase === 'held'`);
    assert.match(await text(`.bots-skill-card[data-request="${updateCard.id}"]`), /changed after this was proposed/);
    assert.equal(await js(`document.querySelector('.bots-skill-card[data-request="${updateCard.id}"] [data-action="apply"]') === null`), true, 'a held card cannot be applied');
    assert.ok(await has(`.bots-skill-card[data-request="${updateCard.id}"] [data-action="retry"]`), 'it offers Review again');
    await js(`document.querySelector('.bots-skill-card[data-request="${updateCard.id}"] [data-action="retry"]').click()`);
    await waitFor(`document.querySelector('.bots-skill-card[data-request="${updateCard.id}"]')?.dataset.phase === 'open'`);
    await js(`document.querySelector('.bots-skill-card[data-request="${updateCard.id}"] [data-action="apply"]').click()`);
    await waitFor("document.querySelector('[data-skill=\"weekly-summary\"]') && !document.querySelector('.bots-skill-card[data-request]')");
    assert.ok((await call(`${base_}/skills/weekly-summary`)).body.skill_md.includes('Proposed rewrite.'), 'the retried proposal applied against the current version');

    // -- Written command from the form -----------------------------------------------------------------------------------
    await mount('botsSectionSkills.js', true);
    await waitFor("!!document.querySelector('#skills-scratch .bots-skill-item')");
    assert.ok(await has('#skills-scratch [aria-label="Share learned skills"]'), 'Advanced shows the learning and sharing settings');
    await js(`(() => { const inputs = [...document.querySelectorAll('.bots-skills .bots-text-row')].filter(r => /Command name|One line|Instructions/.test(r.textContent));
      const set = (row, value) => { const f = row.querySelector('input, textarea'); f.value = value; f.dispatchEvent(new Event('input', { bubbles: true })); };
      set(inputs[0], 'Bad Name'); set(inputs[1], 'Does a thing'); set(inputs[2], 'Do the thing.'); return true; })()`);
    await js(`[...document.querySelectorAll('.bots-skills .bots-btn')].find(b => b.textContent === 'Save command').click()`);
    await waitFor("!!document.querySelector('.bots-skills .bots-skill-status.error')");
    assert.match(await text('.bots-skills .bots-skill-status.error'), /lowercase words joined by hyphens/, 'a bad name is explained before anything is sent');
    await js(`(() => { const row = [...document.querySelectorAll('.bots-skills .bots-text-row')].find(r => /Command name/.test(r.textContent)); const f = row.querySelector('input'); f.value = 'from-form'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await js(`[...document.querySelectorAll('.bots-skills .bots-btn')].find(b => b.textContent === 'Save command').click()`);
    await waitFor("!!document.querySelector('[data-skill=\"from-form\"]')");
    assert.equal(await state('[data-skill="from-form"]'), 'review');

    // -- Library: review, Every bot, assignment chips, removal ---------------------------------------------------------------
    assert.equal(await mount('botsSectionSkillLibrary.js'), true);
    await waitFor("!!document.querySelector('.bots-skill-library [data-skill=\"shared-playbook\"]')");
    assert.equal(await state('.bots-skill-library [data-skill="shared-playbook"]'), 'review', 'a library import waits for review');
    assert.equal(await has('.bots-skill-library [data-skill="shared-playbook"] .bots-skill-assign'), false, 'no assignment before it is on');
    await js("document.querySelector('.bots-skill-library [data-skill=\"shared-playbook\"] .bots-skill-main').click()");
    await waitFor("!!document.querySelector('.bots-skill-library [data-skill=\"shared-playbook\"] pre.bots-skill-text')");
    await js(`[...document.querySelectorAll('.bots-skill-library [data-skill="shared-playbook"] .bots-btn')].find(b => b.textContent === 'Enable reviewed skill').click()`);
    await waitFor("document.querySelector('.bots-skill-library [data-skill=\"shared-playbook\"]')?.dataset.state === 'on'");
    const rowSwitch = title => `(() => { const row = [...document.querySelectorAll('.bots-skill-library [data-skill="shared-playbook"] .bots-switch-row')].find(r => r.textContent.startsWith(${JSON.stringify(title)})); return row; })()`;
    await js(`${rowSwitch('Every bot')}.control.click()`);
    await waitFor("!!document.querySelector('.bots-skill-library [data-skill=\"shared-playbook\"] [data-chip=\"*\"]')");
    assert.equal(await text('.bots-skill-library [data-skill="shared-playbook"] [data-chip="*"]'), 'Every bot');
    await js(`${rowSwitch('Every bot')}.control.click()`);
    await waitFor("!document.querySelector('.bots-skill-library [data-skill=\"shared-playbook\"] [data-chip=\"*\"]')");
    await js(`${rowSwitch('This bot')}.control.click()`);
    await waitFor(`!!document.querySelector('.bots-skill-library [data-skill="shared-playbook"] [data-chip="${botId}"]')`);
    assert.equal(await text(`.bots-skill-library [data-skill="shared-playbook"] [data-chip="${botId}"]`), 'Skills Check Bot', 'the chip names the bot');
    await capture?.('desktop-bots-skill-library');
    await mount('botsSectionSkills.js');
    await waitFor("!!document.querySelector('#skills-scratch [data-origin=\"library\"][data-skill=\"shared-playbook\"]')");
    await mount('botsSectionSkillLibrary.js');
    await waitFor("document.querySelector('.bots-skill-library [data-skill=\"shared-playbook\"]')?.dataset.state === 'on'");
    await js(`${rowSwitch('This bot')}.control.click()`);
    await waitFor(`!document.querySelector('.bots-skill-library [data-skill="shared-playbook"] [data-chip="${botId}"]')`);
    await mount('botsSectionSkills.js');
    await waitFor("!!document.querySelector('#skills-scratch .bots-skill-item')");
    assert.equal(await has('#skills-scratch [data-origin="library"]'), false, 'removing the assignment removes the skill from the bot');
    // Search filters the library.
    await mount('botsSectionSkillLibrary.js');
    await waitFor("!!document.querySelector('.bots-skill-library .bots-skill-search')");
    await fill('.bots-skill-library .bots-skill-search', 'nothing-matches');
    assert.match(await text('.bots-skill-library .bots-skill-empty'), /No skills match/);
    await fill('.bots-skill-library .bots-skill-search', 'playbook');
    assert.ok(await has('.bots-skill-library [data-skill="shared-playbook"]'));

    // -- Destroy while a request is pending ----------------------------------------------------------------------------------------
    await js("window.__sk.handle.destroy(); window.__sk.handle = null; true");
    await mount('botsSectionSkills.js');
    await js("window.__sk.handle.destroy(); window.__sk.handle = null; true");
    await delay(150);
    assert.equal(await has('#skills-scratch .bots-skills'), false, 'a destroyed section leaves nothing behind');

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
  } finally {
    try {
      if (mounted) await js(`(() => { window.__sk?.handle?.destroy(); window.__sk?.card?.destroy(); document.getElementById('skills-scratch')?.remove(); document.getElementById('applied-card')?.remove();
        document.documentElement.dataset.appMode = window.__skillsPrevMode || 'kairos'; if (!window.__skillsPrevMode) delete document.documentElement.dataset.appMode; delete window.__sk; delete window.__skillsPwned; delete window.__skillsPrevMode; return true; })()`);
    } finally { await restore(); }
  }
};

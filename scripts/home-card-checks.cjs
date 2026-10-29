// Real Home UI as shipped (the redesign is the default look): cards, honest meters, detail access and navigation.
const assert = require('node:assert/strict');
module.exports = async ({js, win, waitFor, capture, navigate, demoState, delay}) => {
  const usageReady = "document.querySelectorAll('.rd-usage-provider').length===3 && !!document.querySelector('.rd-usage-provider[data-provider=claude] [role=meter]') && !!document.querySelector('.rd-usage-provider[data-provider=codex] [role=meter]') && !!document.querySelector('.rd-usage-provider[data-model=m3]')";
  const ready = async () => waitFor("!!document.querySelector('[data-home-section=projects] .dashboard-row') && !!document.querySelector('[data-home-section=agents] .dashboard-agent-dot') && !!document.querySelector('[data-home-section=store] .dashboard-row') && " + usageReady);
  const home = async () => { await navigate('home'); await ready(); };
  assert.ok(await js("document.documentElement.classList.contains('kairos-redesign')"), 'The redesign is the default look');
  // The fixed hero/week precede the populated default sections.
  await js("import('/static/js/layout.js').then(m=>m.resetHomeLayout())");
  await navigate('home');
  await waitFor(usageReady + " && !!document.querySelector('[data-home-section=chats] .dashboard-row')");
  assert.equal(await js("document.querySelector('.rd-usage-provider[data-model=m3]').querySelector('[role=meter]')"), null, 'Local recorded usage is not a provider quota');
  await waitFor("!!document.querySelector('[data-home-section=needs] .hm-live-row') && !!document.querySelector('[data-home-section=working] .hm-live-row')");
  assert.deepEqual(await js("[...document.querySelectorAll('.dashboard-grid > [data-home-section]')].map(n=>n.dataset.homeSection)"), ['needs','working','chats','schedule','models','system'], 'Default Home shows populated sections in desktop order');
  assert.ok(await js("!!document.querySelector('.hm-customize')"), 'Customize is offered');
  // Show every card (a moved card counts as an arrangement of your own, so the default is not re-applied).
  await js("import('/static/js/layout.js').then(m=>{const l=m.getLayout(); l.home=['activity',...m.HOME_SECTIONS.map(s=>s.id).filter(id=>id!=='activity')]; l.hiddenHome=[]; m.saveLayout(l);})");
  await home();
  assert.ok(await js("document.querySelectorAll('.dashboard-event-date').length>0 && document.querySelectorAll('.dashboard-system-chip').length>=4"));
  assert.ok(await js("[...document.querySelectorAll('[data-home-section=agents] .dashboard-row')].every(b=>b.querySelector('.dashboard-agent-dot[aria-label]') && b.querySelector('.dashboard-row-title').textContent)"), 'Agent rows carry their status');
  assert.equal(await js("document.querySelector('[data-provider=claude] [role=meter]').getAttribute('aria-valuenow')"),'34');
  await waitFor("document.querySelectorAll('.rd-usage-tokens').length === 1");
  assert.equal(await js("document.querySelector('[data-model=m3] .rd-usage-tokens').textContent"), 'None this week · 842K tokens in all');
  assert.ok(await js("[...document.querySelectorAll('.rd-usage-tokens')].every(n=>n.title.includes('Tokens this Kairos install')&&n.title.includes('Not a quota')&&!n.textContent.includes('%'))"),'Token accounting is separate from quota');
  // A Forge chat is marked and opens in Forge (desktop redesign); a regular one opens in Chats.
  assert.ok(await js("[...document.querySelectorAll('[data-home-section=chats] .dashboard-row.is-forge')].every(r => r.querySelector('.rd-forge-tag')?.textContent.includes('Forge'))"), 'Forge chats on Home carry the Forge mark');
  await js("document.querySelector('[data-home-section=chats] .dashboard-row:not(.is-forge)').focus()");
  assert.ok(await js("document.activeElement.matches('button.dashboard-row') && document.activeElement.tabIndex===0"), 'Recent chats remain keyboard focusable');
  await js("document.activeElement.click()");
  await waitFor("document.getElementById('view-content').dataset.view==='chat'");
  await home();
  // Scroll the hero away so review captures show the actual changed cards.
  await js("document.querySelector('.dashboard-grid').scrollIntoView({block:'start'})");
  await delay(700); // Let every staggered Home fill finish before visual QA.
  await capture('desktop-home-visual-cards');
  await js("document.querySelector('.dashboard-activity').focus()");
  assert.ok(await js("document.activeElement.matches('button.dashboard-activity') && document.activeElement.tabIndex===0"),'Activity uses a keyboard-focusable native button');
  await js("document.activeElement.click()");
  await waitFor("!!document.querySelector('.panel-dialog')");
  assert.ok(await js("document.querySelector('.panel-dialog').textContent.includes('Activity')"),'Full Activity details open');
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await waitFor("!document.querySelector('.panel-dialog')");
  assert.ok(await js("document.activeElement.matches('.dashboard-activity')"),'Detail dismissal restores focus');
  await js("document.querySelector('[data-home-section=projects] .dashboard-row').click()");
  await waitFor("document.getElementById('view-content').dataset.view==='chat'");
  await home();
  // Agents became Bots: a Bots row opens that bot's page (the in-memory Bots backend answers it).
  const priorBots = { live: demoState.botsLive, attention: demoState.botsAttention };
  demoState.botsLive = true; demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
  await js("document.querySelector('[data-home-section=agents] .dashboard-row').click()");
  await waitFor("document.getElementById('view-content').dataset.view==='botsShell' && !!document.querySelector('.bots-composer-input')");
  await js("import('/static/js/app.js').then(m => m.switchTab('home'))");
  await waitFor("document.documentElement.dataset.appMode === 'kairos'");
  for (const [key, value] of [['botsLive', priorBots.live], ['botsAttention', priorBots.attention]]) { if (value === undefined) delete demoState[key]; else demoState[key] = value; }
  await home();
  win.setContentSize(390,844); await delay(200);
  await js("document.querySelector('.dashboard-grid').scrollIntoView({block:'start'})");
  await capture('phone-home-visual-cards');
  assert.ok(await js("[...document.querySelectorAll('.dashboard-section,.dashboard-system-chips,.rd-usage-provider')].every(n=>n.scrollWidth<=n.clientWidth+2)"),'Visual cards fit phone width');
  for(const [name,selector] of [['agents','[data-home-section=agents]'],['models','[data-home-section=models]'],['systems','[data-home-section=system]'],['store','[data-home-section=store]']]) {
    await js(`document.querySelector('${selector}').scrollIntoView({block:'start'})`); await capture('phone-home-'+name);
  }
  demoState.quotas = {providers:[
    {provider:'claude',status:'needs_sign_in',note:'Long authentication diagnostics remain available when expanded.',windows:[]},
    {provider:'codex',status:'ok',updated_at:Math.floor(Date.now()/1000)-3600,windows:[{name:'5-hour',used_percent:0.1,resets_at:Math.floor(Date.now()/1000)+600}]},
  ]};
  await navigate('home'); await waitFor("!!document.querySelector('[data-provider=claude] .rd-usage-note')");
  assert.ok(await js("document.querySelector('[data-provider=claude] .rd-usage-note').textContent.includes('Sign in') && document.querySelector('[data-provider=claude] .rd-usage-note').textContent.includes('Long authentication diagnostics')"),'Authentication details are available without filling the card');
  assert.equal(await js("document.querySelector('[data-provider=codex] [role=meter]').getAttribute('aria-valuenow')"),'0.1');
  assert.ok(await js("document.querySelector('[data-provider=codex]').textContent.includes('0.1%') && document.querySelector('[data-provider=codex]').textContent.includes('Updated 1h ago')"),'Tiny usage and stale readings stay honest');
  delete demoState.quotas;
  demoState.empty=true;
  await navigate('home');
  await waitFor("!!document.querySelector('.dashboard-content.is-filled') && !document.querySelector('[data-home-section=chats], [data-home-section=schedule], [data-home-section=projects], [data-home-section=agents]')");
  assert.ok(await js("document.querySelector('[data-home-section=store]')?.dataset.hasItems === 'true'"), 'Installed tabs keep Tool Store visible when other lists are empty');
  demoState.tabs=[];
  await navigate('home');
  await waitFor("!!document.querySelector('.dashboard-content.is-filled') && !document.querySelector('[data-home-section=chats], [data-home-section=schedule], [data-home-section=projects], [data-home-section=agents], [data-home-section=store]')");
  assert.ok(await js("!!document.querySelector('[data-home-section=system]')"), 'Systems remains when every optional list is empty');
  delete demoState.tabs;
  demoState.empty=false;demoState.isAdmin=false;
  await navigate('home');await delay(300);
  assert.ok(await js("![...document.querySelectorAll('[data-home-section=agents],[data-home-section=store]')].some(n=>!n.hidden)"),'Non-admin access is preserved');
  demoState.isAdmin=true; win.setContentSize(1440,1000); await home();
  await js("import('/static/js/layout.js').then(m=>m.resetHomeLayout())");
  console.log('PASS Home visual cards: meters, quota semantics, keyboard details/focus, project/agent navigation, phone overflow, empty and non-admin states.');
};

// Real Home UI: visual summaries, honest meters, detail access and navigation.
const assert = require('node:assert/strict');
module.exports = async ({js, win, waitFor, capture, navigate, demoState, delay}) => {
  const ready = async () => waitFor("!!document.querySelector('.dashboard-project-tile') && !!document.querySelector('.dashboard-agent-tile') && !!document.querySelector('.dashboard-store-categories') && document.querySelectorAll('.dashboard-quota').length===2");
  const home = async () => { await navigate('home'); await ready(); };
  await js("import('/static/js/layout.js').then(m=>m.resetHomeLayout())");
  await home();
  assert.ok(await js("document.querySelectorAll('.dashboard-date-block').length>0 && document.querySelectorAll('.dashboard-system-symbol').length>=4"));
  assert.ok(await js("[...document.querySelectorAll('.dashboard-agent-tile')].every(b=>b.querySelector('img') && b.getAttribute('aria-label'))"));
  assert.equal(await js("document.querySelector('[data-provider=claude] [role=meter]').getAttribute('aria-valuenow')"),'34');
  assert.ok(await js("[...document.querySelectorAll('.dashboard-model-usage')].every(n=>n.textContent.includes('tokens via Kairos')&&!n.textContent.includes('%'))"),'Token accounting is separate from quota');
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
  await js("document.querySelector('.dashboard-project-tile').click()");
  await waitFor("document.getElementById('view-content').dataset.view==='chat'");
  await home();
  await js("document.querySelector('.dashboard-agent-tile').click()");
  await waitFor("document.getElementById('view-content').dataset.view==='agents'");
  await home();
  win.setContentSize(390,844); await delay(200);
  await js("document.querySelector('.dashboard-grid').scrollIntoView({block:'start'})");
  await capture('phone-home-visual-cards');
  assert.ok(await js("[...document.querySelectorAll('.dashboard-section,.dashboard-project-shelf,.dashboard-system-grid,.dashboard-quota')].every(n=>n.scrollWidth<=n.clientWidth+2)"),'Visual cards fit phone width');
  for(const [name,selector] of [['agents','[data-home-section=agents]'],['models','[data-home-section=models]'],['systems','[data-home-section=system]'],['store','[data-home-section=store]']]) {
    await js(`document.querySelector('${selector}').scrollIntoView({block:'start'})`); await capture('phone-home-'+name);
  }
  demoState.quotas = {providers:[
    {provider:'claude',status:'needs_sign_in',note:'Long authentication diagnostics remain available when expanded.',windows:[]},
    {provider:'codex',status:'ok',updated_at:Math.floor(Date.now()/1000)-3600,windows:[{name:'5-hour',used_percent:0.1,resets_at:Math.floor(Date.now()/1000)+600}]},
  ]};
  await navigate('home'); await waitFor("!!document.querySelector('[data-provider=claude] details')");
  assert.ok(await js("!document.querySelector('[data-provider=claude] details').open && document.querySelector('[data-provider=claude] summary').textContent.includes('Sign in')"),'Authentication details are available without filling the card');
  assert.equal(await js("document.querySelector('[data-provider=codex] [role=meter]').getAttribute('aria-valuenow')"),'0.1');
  assert.ok(await js("document.querySelector('[data-provider=codex]').textContent.includes('0.1%') && document.querySelector('[data-provider=codex]').textContent.includes('Updated 1h ago')"),'Tiny usage and stale readings stay honest');
  delete demoState.quotas;
  demoState.empty=true;
  await navigate('home'); await waitFor("document.querySelectorAll('.dashboard-empty').length>=3");
  assert.ok(await js("[...document.querySelectorAll('.dashboard-empty')].every(n=>n.textContent.length<70)"),'Empty cards use short labels');
  demoState.empty=false;demoState.isAdmin=false;
  await navigate('home');await delay(300);
  assert.ok(await js("document.querySelector('[data-home-section=agents]').hidden&&document.querySelector('[data-home-section=store]').hidden"),'Non-admin access is preserved');
  demoState.isAdmin=true; win.setContentSize(1440,1000); await home();
  console.log('PASS Home visual cards: graphics, quota semantics, keyboard details/focus, project/agent navigation, phone overflow, empty and non-admin states.');
};

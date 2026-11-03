// Phase 5 U4. Orchestrator runs this with the machine-wide Electron lock.
// The shell and real Make view need no other Phase 5 fixture lane.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
const { cardSamples } = require('./fixtures/bots-frontdesk-backend.cjs');

module.exports = async ({ js, waitFor, delay, win, capture, demoState, base }) => {
  const q = JSON.stringify;
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('Missing '+${q(selector)}); n.click(); return true; })()`);
  const call = (url, method = 'GET', body) => js(`fetch(${q(url)}, { method:${q(method)}, headers:{'Content-Type':'application/json'}, body:${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r=>({status:r.status,body:await r.json()}))`);
  const restore = await isolateBotsCheck({ js, demoState }, { botsFdFront: { items: [], making: [] } });
  const bounds = win.getBounds(); let botId;
  const debug = win.webContents.debugger;
  let attached = false;
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const made = await call('/api/agents', 'POST', { name: `Front desk check ${Date.now()}`, role: 'Front desk', soul: 'Be brief.' });
    assert.equal(made.status, 200); botId = made.body.id; assert.ok(botId);
    // A new bot has no conversation until one is opened; open its first one.
    const threads = await call(`/api/agents/${botId}/threads`);
    const sid = threads.body.main_id || (await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Front desk check' })).body.id; assert.ok(sid);
    // Fixture records use returned bot and session IDs throughout.
    demoState.botsFdFront = {
      items: [{ id: 'design:abcdef123456', kind: 'design', title: 'Our design', updated_at: 2, thumb_url: null, open: { tab: 'design', id: 'abcdef123456', session_id: sid } },
        { id: 'design:abcdef123457', kind: 'slides', title: 'Our slides', updated_at: 3, thumb_url: null, open: { tab: 'design', id: 'abcdef123457', session_id: sid } },
        { id: 'file:own-file', kind: 'files', title: 'Our report', updated_at: 4, thumb_url: null, open: { tab: 'artifact', id: '/generated-files/own-report.txt', session_id: sid } }],
      making: [{ id: 'own-making', title: 'Making a web page', make_kind: 'website', state: 'working', thread_id: sid }],
    };
    if (!debug.isAttached()) { debug.attach('1.3'); attached = true; }
    await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await js(`(async () => {
      window.__fdPriorMode = document.documentElement.dataset.appMode;
      document.documentElement.dataset.appMode = 'bots';
      window.__fdErrors = []; window.__fdCalls = []; window.__fdNav = [];
      window.__fdOnError = e => window.__fdErrors.push(String(e.message || e.reason));
      window.addEventListener('error', window.__fdOnError); window.addEventListener('unhandledrejection', window.__fdOnError);
      const H = window.__fdModuleHost = await import('/static/js/botsPanelHost.js');
      H.stubBotsModule('frontdesk:chat', { mountBotsChat(host) {
        const input = document.createElement('textarea'); input.setAttribute('aria-label','Message Kip');
        const cards = document.createElement('div'); cards.id='fd-check-cards'; host.append(input,cards);
        return {dispose(){host.replaceChildren();}};
      }});
      H.stubBotsModule('section:Watch', { mount(host) { host.textContent='Watch check'; return {dispose(){}}; }});
      H.stubBotsModule('section:Work', { async mount(host, ctx) {
        const p=document.createElement('p'); p.textContent='Own work'; host.append(p);
        const w=await H.loadBotsModule('section:Watch'); const h=w.mount(host,ctx);
        return {dispose(){h.dispose();host.replaceChildren();},refresh(){}};
      }});
      const host=document.createElement('div'); host.id='fd-check-host';
      host.style.cssText='position:fixed;inset:0;z-index:100;background:var(--bots-app)'; document.body.append(host);
      const realApi=(await import('/static/js/api.js')).api;
      window.__fdApi=async (path,opts={})=>{
        window.__fdCalls.push({path,method:opts.method||'GET',body:opts.body?JSON.parse(opts.body):null});
        if(path.startsWith('/api/front-desk/make')) return realApi(path,opts);
        if(path==='/api/front-desk/work')return {groups:{needs_input:[{id:'own-task'}],working:[]},loose:{questions:[{id:'own-question'}],approvals:[]}};
        if(path==='/api/forge/sessions')return {id:'own-forge'};
        if(path==='/api/front-desk/watch')return {state:'working',connected:{calendar:true,mail:true}};
        if(path==='/api/home/tab-cards')return {cards:[{id:'tab:projects:open',tab_name:'Projects',title:'Open',kind:'stat',value:2,label:'tasks'}]};
        if(path==='/api/front-desk/today')return {date_label:'Monday',sections:[{id:'needs',rows:[{text:'Answer the venue',note:'Draft ready'}],more:0,empty:''},
          {id:'day',rows:[],empty:'No more meetings today.'},{id:'mail',rows:[],empty:'No important emails right now.'},{id:'routines',rows:[{text:'Left out'}],empty:''}]};
        return {thread_id:${q(sid)}};
      };
      const agent={...${q(made.body)},builtin:'front_desk'};
      window.__fd=(await import('/static/js/botsFrontDesk.js')).mountFrontDesk(host,{agent,sessionId:${q(sid)},api:window.__fdApi,navigate:t=>window.__fdNav.push(t),
        openItem:t=>window.__fdNav.push(t)});
      return true;
    })()`);
    await waitFor("!!document.querySelector('#fd-check-cards') && document.querySelector('.fd-badge')?.textContent === '2'");
    await click('[data-fd-tab=tasks]'); await waitFor("document.querySelector('.fd-page-tasks')?.textContent.includes('Watch check')");
    assert.equal(await js("document.querySelector('.fd-page-chat').hidden"), true);
    await js("document.querySelector('[data-fd-tab=tasks]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))");
    assert.equal(await js("document.querySelector('[data-fd-tab=chat]').getAttribute('aria-selected')"), 'true');
    await js("window.__fd.setLive({status:'processing',turnId:'own-turn',step:'Reading mail'})");
    assert.equal(await js("document.querySelector('.bots-frontdesk').dataset.kipState"), 'thinking');
    await js("window.__fd.setLive({status:'processing',permission:{id:'own-permission'}})");
    assert.equal(await js("document.querySelector('.bots-frontdesk').dataset.kipState"), 'needs');
    await js("window.__fd.setLive({status:'done'})");
    assert.equal(await js("document.querySelector('.bots-frontdesk').dataset.kipState"), 'success');
    await js(`(async()=>{
      const C=await import('/static/js/botsFrontDeskCards.js'); window.__fdCards=[];
      const samples=${q(cardSamples)};
      for(const [kind,data] of Object.entries(samples)){
        const row=C.renderFrontDeskCard({id:'own-'+kind,type:'fd_card',fd_kind:kind,fd_status:'open',fd_data:data},{api:window.__fdApi,agent:{id:${q(botId)},name:'Kip'},sessionId:${q(sid)},isLatestTurn:true,send:async text=>window.__fdCalls.push({path:'chip-send',text}),navigate:t=>window.__fdNav.push(t)});
        window.__fdCards.push(row);document.getElementById('fd-check-cards').append(row);
      }return true;
    })()`);
    assert.equal(await js("document.querySelectorAll('#fd-check-cards [data-fd-kind]').length"), Object.keys(cardSamples).length);
    await click('.fd-card-suggestion .primary'); await waitFor("document.querySelector('.fd-card-suggestion')?.dataset.status==='started'");
    assert.ok(await js("window.__fdCalls.some(c=>c.path==='/api/front-desk/suggestions/own-suggestion/start')"));
    await click('.fd-card-forge .primary'); await waitFor("window.__fdNav.some(t=>t.tab==='forge'&&t.sessionId==='own-forge')");
    await click('.fd-card-chips button'); await waitFor("window.__fdCalls.some(c=>c.path==='chip-send'&&c.text==='Yes')");
    await click('.fd-card-brief .fd-card-actions button'); await waitFor("window.__fdCalls.some(c=>c.path.endsWith('/dismiss'))");
    await click('[data-fd-tab=make]'); await waitFor("document.querySelectorAll('.fd-made').length===3");
    await click('[data-make-filter=slides]'); await waitFor("document.querySelectorAll('.fd-made').length===1");
    await click('.fd-made'); assert.equal(await js("window.__fdNav.at(-1).designId"), 'abcdef123457');
    await click('.fd-make-plus'); assert.equal(await js("document.activeElement.getAttribute('role')"), 'menuitem');
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    assert.equal(await js("document.activeElement.classList.contains('fd-make-plus')"), true, 'focus returns to +');
    await click('.fd-make-plus'); await click('.fd-make-fan button'); await waitFor("!!document.querySelector('.fd-newtask[open]')");
    assert.equal(await js("document.querySelector('.fd-newtask .primary').disabled"), true, 'unedited starters cannot start');
    await js("document.querySelector('.fd-newtask textarea').value='Make a design for our plan';document.querySelector('.fd-newtask textarea').dispatchEvent(new Event('input',{bubbles:true}))");
    await click('.fd-newtask .primary'); await waitFor("!document.querySelector('.fd-newtask[open]')");
    assert.ok(await js("window.__fdCalls.some(c=>c.path==='/api/front-desk/tasks'&&c.body.kind==='make'&&c.body.make_kind==='design')"));
    // The desktop front desk (2026-11-02 redesign): what Kip watches under its name, and the Today panel beside the chat.
    await waitFor("document.querySelector('.fd-watching:not(.fd-watching-dock)')?.textContent==='Watching Calendar, Mail and Projects'");
    await waitFor("!!document.querySelector('.fd-today:not([hidden])')");
    assert.deepEqual(await js("[...document.querySelectorAll('.fd-today-section h3')].map(n=>n.textContent)"), ['Needs you', 'Calendar', 'Mail', 'Projects'], 'Today: the brief, then each custom tab');
    assert.ok(await js("document.querySelector('.fd-today').textContent.includes('Answer the venue') && !document.querySelector('.fd-today').textContent.includes('Left out')"));
    assert.equal(await js("getComputedStyle(document.querySelector('.fd-menu')).display"), 'none', 'no phone controls on a desktop');
    await click('.fd-today-add'); assert.equal(await js('window.__fdNav.at(-1).tab'), 'tool-store');
    await capture('desktop-bots-frontdesk');

    await debug.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await debug.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true });
    await delay(400);
    assert.equal(await js("document.querySelector('.fd-tabs').getBoundingClientRect().width <= innerWidth-30"), true);
    assert.equal(await js("document.querySelector('.fd-tabs').getBoundingClientRect().bottom <= innerHeight"), true);
    assert.equal(await js("document.getElementById('fd-check-host').scrollWidth<=innerWidth"), true);
    // Kip on a phone: floating menu, Kip and account controls on top, its own tabs at the bottom, nothing overlapping, no Today panel.
    const phone = await js("(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();const m=r('.fd-menu'),a=r('.fd-account'),k=r('.fd-identity'),t=r('.fd-tabs');return {m:[m.width,m.height],a:[a.width,a.height],k:k.width,kTop:k.top,headBottom:Math.max(m.bottom,a.bottom,k.bottom),tabsTop:t.top,tabsBottom:t.bottom,h:innerHeight,today:!!document.querySelector('.fd-today').getClientRects().length};})()");
    assert.deepEqual([phone.m, phone.a], [[52, 52], [52, 52]], 'menu and account are 52px round buttons');
    assert.ok(phone.k >= 70 && phone.kTop < 40, 'Kip sits at the top centre');
    assert.ok(phone.tabsTop > phone.headBottom + 200 && phone.h - phone.tabsBottom <= 40, 'the tabs sit at the bottom, clear of the controls');
    assert.equal(phone.today, false, 'no Today panel on a phone');
    await click('[data-fd-tab=chat]');
    // A fresh owned suggestion (the stand-in card list gets the real list's top space: Kip's controls float over it)., then a true touch drag left. Buttons were proved above.
    await js(`(async()=>{const C=await import('/static/js/botsFrontDeskCards.js');const r=C.renderFrontDeskCard({id:'swipe',type:'fd_card',fd_kind:'suggestion',fd_data:{suggestion_id:'own-swipe',title:'Swipe me'}},{api:window.__fdApi}); r.id='fd-swipe'; window.__fdCards.push(r);const cards=document.getElementById('fd-check-cards');cards.style.paddingTop='150px';cards.prepend(r);r.scrollIntoView({block:'center'});return true;})()`);
    const point = await js("(()=>{const r=document.getElementById('fd-swipe').getBoundingClientRect();return {x:r.right-24,y:r.top+30};})()");
    await debug.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await debug.sendCommand('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - 160, y: point.y + 2 }] });
    await debug.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitFor("window.__fdCalls.some(c=>c.path==='/api/front-desk/suggestions/own-swipe/hide')");
    await debug.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await delay(80);
    assert.equal(await js("getComputedStyle(document.querySelector('.fd-tabs'),'::before').transitionDuration"), '0s');
    await capture('mobile-bots-frontdesk');
    assert.deepEqual(await js('window.__fdErrors'), []);
  } finally {
    await js(`(()=>{window.__fd?.dispose();for(const r of window.__fdCards||[])r.dispose();document.getElementById('fd-check-host')?.remove();window.__fdModuleHost?.clearBotsStubs();window.removeEventListener('error',window.__fdOnError);window.removeEventListener('unhandledrejection',window.__fdOnError);if(window.__fdPriorMode)document.documentElement.dataset.appMode=window.__fdPriorMode;else delete document.documentElement.dataset.appMode;for(const k of Object.keys(window).filter(k=>k.startsWith('__fd')))delete window[k];return true;})()`).catch(() => {});
    if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
    if (debug.isAttached()) {
      await debug.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await debug.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      await debug.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
      await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      if (attached) debug.detach();
    }
    win.setBounds(bounds); await restore();
  }
};

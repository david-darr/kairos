const assert = require('node:assert/strict');

// UI-3, 2026-10-14: exercise the real bot controls with isolated API fixtures.
module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, inbox, capturesOnly = false, stage = 'after' }) => {
  const appearance = await js("import('/static/js/appearance.js').then(m => { const a=m.getAppearance(); return {mode:a.mode,color:a.color}; })");
  let checks = 0;
  const ok = (value, message) => { assert.ok(value, message); checks++; };
  const savedInbox = [...inbox], savedReview = demoState.agentReview;
  try {
    // Earlier full-suite checks answer their fixtures. Own these waiting rows
    // and restore the prior state so this unit has the same intent in isolation.
    inbox.splice(0, inbox.length,
      { id:'i1', agent_id:'a1', kind:'question', title:'Which area should I focus on?', body:'Choose the next area to investigate.', created_at:Date.now()/1000 },
      { id:'i2', agent_id:'a1', kind:'report', title:'New findings', body:'Two results are ready to look through.', created_at:Date.now()/1000 });
    demoState.agentReview = false;
    // Captures run against HEAD with --agents-layout-before, or the working
    // tree otherwise. No files are checked out or temporarily overwritten.
    for (const [device, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      win.setContentSize(width, height);
      for (const [tone, color] of [['light', '#f3eadb'], ['dark', '#1f1d24']]) {
        await js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode:'color', color:${JSON.stringify(color)} }))`);
        await navigate('agents', { agentId: 'a1', agentTab: 'chat' });
        await waitFor("!!document.querySelector('.agent-chat-main .msg.assistant .msg-body')");
        await delay(300);
        await capture(`ui3-${stage}-${device}-${tone}`);
      }
    }
    if (capturesOnly) return { checks, stage };
    win.setContentSize(1440, 900);
    await navigate('agents', { agentId: 'a1', agentTab: 'chat' });
    await waitFor("!!document.querySelector('.agent-composer-orb .agent-dot-avatar')");
    ok(await js("document.querySelector('.agent-back').getAttribute('aria-label') === 'All agents'"), 'round back button');
    for (const tab of ['chat', 'work', 'routines', 'memory']) {
      await js(`[...document.querySelectorAll('.agent-tab')].find(b => b.textContent.toLowerCase().startsWith('${tab}')).click()`);
      ok(await js(`document.querySelector('.agent-${tab}-host').hidden === false && document.querySelector('.agent-conversation-page').dataset.agentTab === '${tab}'`), `segment opens ${tab}`);
      await navigate('agents', { agentId: 'a1', agentTab: tab });
      await waitFor(`!!document.querySelector('.agent-${tab}-host:not([hidden])')`);
      ok(await js(`document.querySelector('.agent-tab[aria-selected=true]').textContent.toLowerCase().startsWith('${tab}')`), `${tab} deep link`);
    }
    await navigate('agents', { agentId: 'a1' });
    await waitFor("!!document.querySelector('.agent-composer-orb')");
    ok(await js("!!document.querySelector('.agent-live-panel .agent-status-line')"), 'live state uses bot status');
    ok(await js("document.querySelectorAll('.agent-live-panels .agent-approval-card').length >= 2 && [...document.querySelectorAll('.agent-live-panels .agent-approval-card')].every(n => n.querySelector('.btn.primary'))"), 'each waiting item has its action');
    ok(await js("document.querySelector('.agent-next-panel').textContent.includes('Every day at 08:00') && document.querySelector('.agent-routine-preview')"), 'next routines include cadence');
    await js("document.querySelector('.agent-give-job').click()");
    ok(await js("document.querySelector('.agent-job-flow').open && document.activeElement === document.querySelector('.agent-job-flow input')"), 'Give it a job opens and focuses existing flow');
    await js("document.querySelector('.agent-tab').click()");
    ok(await js("!!document.querySelector('.msg.user .msg-body') && !!document.querySelector('.msg.assistant .msg-body') && getComputedStyle(document.querySelector('.msg.user .msg-body')).backgroundColor !== getComputedStyle(document.querySelector('.msg.assistant .msg-body')).backgroundColor"), 'distinct bot/person bubbles');
    ok(await js("!!document.querySelector('.agent-composer-orb .agent-dot-avatar') && !!document.querySelector('.agent-composer-add')"), 'composer face and reference action');
    await js("(() => { const n=document.querySelector('.agent-thread-search'); n.value='no such thread ui3'; n.dispatchEvent(new Event('input')); })()");
    ok(await js("[...document.querySelectorAll('.agent-chat-item')].every(n => n.hidden) && document.querySelector('.agent-search-scope').textContent.includes('loaded titles')"), 'search filters loaded titles and states its scope');
    await js("(() => { const n=document.querySelector('.agent-thread-search'); n.value=''; n.dispatchEvent(new Event('input')); })()");
    await js("[...document.querySelectorAll('.agent-tab')].find(b => b.textContent === 'Routines').click(); document.querySelector('.agent-routines-host .routine-details-open').click()");
    ok(await js("!!document.querySelector('.agent-item-sheet[open]') && document.querySelector('.agent-item-sheet').textContent.includes('Every day at 08:00')"), 'routine opens details sheet with cadence');
    await js("document.querySelector('.agent-item-secondary').click()");
    ok(await js("!document.querySelector('.agent-routines-host .routine-editor').hidden && document.activeElement === document.querySelector('.agent-routines-host .routine-editor input')"), 'routine sheet links to existing editor');
    await js("[...document.querySelectorAll('.agent-tab')].find(b => b.textContent.startsWith('Work')).click(); document.querySelector('.agent-assignment-card').click()");
    ok(await js("!!document.querySelector('.agent-item-sheet[open]') && !!document.querySelector('.agent-item-primary') && !!document.querySelector('.agent-item-secondary')"), 'work item opens details with one primary and one secondary action');
    await js("document.querySelector('.agent-item-close').click(); document.querySelector('.agent-tab').click()");
    await js("document.querySelector('.agent-profile-open').click(); [...document.querySelectorAll('.agent-profile-sheet button')].find(b => b.textContent === 'All settings').click(); document.querySelector('.agent-profile-section[data-section=routines] summary').click()");
    await delay(250);
    await js("(() => { const n=document.querySelector('.agent-profile-section[data-section=routines] .routine-details-open'); n.focus(); n.click(); })()");
    ok(await js("document.querySelector('.agent-item-portrait .agent-dot-avatar').dataset.avatarSpec === document.querySelector('.agent-profile-titlebar .agent-dot-avatar').dataset.avatarSpec"), 'profile routine sheet keeps the selected bot face');
    await js("document.querySelector('.agent-item-sheet').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await delay(250);
    ok(await js("!document.querySelector('.agent-item-sheet') && !document.querySelector('.agent-profile-sheet').hidden && document.activeElement === document.querySelector('.agent-profile-section[data-section=routines] .routine-details-open')"), 'Escape closes only the nested sheet and restores profile focus');
    await js("document.querySelector('.agent-profile-sheet [aria-label=\"Close profile\"]').click()");
    // 2026-10-15 (David): Conversations left the chat column for the left
    // panels, with its search beside the list it filters.
    ok(await js("!!document.querySelector('.agent-live-panels > .agent-conversations-home > .agent-chat-side .agent-thread-search') && !document.querySelector('.agent-chat .agent-chat-side') && !document.querySelector('.agent-chat-side summary')"), 'desktop conversations sit in the left column with their search');
    // The profile sheet once began under the desktop title bar, hiding the
    // face; in a short window its tabs were squeezed to a sliver.
    win.setContentSize(1280, 600);
    await js("document.documentElement.classList.add('electron-shell')");
    await delay(150);
    await js("document.querySelector('.agent-profile-face').click()");
    await delay(300);
    ok(await js("(() => { const bar=document.querySelector('.titlebar').getBoundingClientRect().bottom, sheet=document.querySelector('.agent-profile-sheet').getBoundingClientRect(), face=document.querySelector('.agent-profile-titlebar .agent-dot-avatar').getBoundingClientRect(), tabs=document.querySelector('.agent-profile-tabs').getBoundingClientRect(); return bar > 0 && sheet.top >= bar - 1 && face.top >= bar && Math.abs(sheet.bottom - innerHeight) < 1 && tabs.height >= 40; })()"), 'desktop profile sheet starts below the title bar with full-height tabs');
    await capture('agents-profile-titlebar');
    await js("document.querySelector('.agent-profile-sheet [aria-label=\"Close profile\"]').click()");
    await js("document.documentElement.classList.remove('electron-shell')");
    win.setContentSize(1440, 900);
    // Use a plain question to cover Reply/Dismiss separately from Open computer.
    inbox.push({ id:'i3', agent_id:'a1', kind:'question', title:'Which direction?', body:'Tell me which option to use.', created_at:Date.now()/1000 });
    demoState.agentReview = true;
    win.setContentSize(390, 844);
    await navigate('agents', { agentId:'a1' });
    await waitFor("document.querySelectorAll('.agent-conversation-stream .agent-approval-card').length >= 4");
    ok(await js("(() => { const n=document.querySelector('.agent-profile-face').getBoundingClientRect(), t=document.querySelector('.agent-conversation-topbar').getBoundingClientRect(); return Math.abs(n.left+n.width/2 - (t.left+t.width/2)) < 10 && !!document.querySelector('.agent-profile-face h2') && getComputedStyle(document.querySelector('.agent-profile-open')).display !== 'none'; })()"), 'phone face and name centred with Settings');
    // 2026-10-15 (David): a phone thread reads like Messages. Settings and More
    // sit on the right; More holds the four places the segments held.
    ok(await js("getComputedStyle(document.querySelector('.agent-tabs')).display === 'none' && document.querySelector('.agent-profile-open').getAttribute('aria-label') === 'Settings' && getComputedStyle(document.querySelector('.agent-more')).display !== 'none'"), 'phone top bar swaps the segments for Settings and More');
    ok(await js("(() => { const s=document.querySelector('.agent-profile-open').getBoundingClientRect(), m=document.querySelector('.agent-more').getBoundingClientRect(), t=document.querySelector('.agent-conversation-topbar').getBoundingClientRect(); return s.right <= m.left && t.right - m.right < 2 && s.width >= 44 && m.width >= 44; })()"), 'Settings then More at the right edge, 44px each');
    await js("document.querySelector('.agent-more').click()");
    ok(await js("JSON.stringify([...document.querySelectorAll('.agent-more-item')].map(n => n.textContent.replace(/ \\(\\d+\\)$/, ''))) === JSON.stringify(['Chat and conversations','Work','Routines','Memory']) && document.querySelector('.agent-more').getAttribute('aria-expanded') === 'true' && document.activeElement === document.querySelector('.agent-more-item[aria-checked=true]')"), 'More lists the four places and focuses the current one');
    await capture('agents-phone-more');
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))");
    ok(await js("document.activeElement.dataset.place === 'work'"), 'arrow keys move through More');
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    ok(await js("document.querySelector('.agent-more-menu').hidden && document.activeElement === document.querySelector('.agent-more')"), 'Escape closes More and returns focus');
    await js("document.querySelector('.agent-more').click(); document.querySelector('.agent-more-item[data-place=routines]').click()");
    ok(await js("document.querySelector('.agent-conversation-page').dataset.agentTab === 'routines' && !document.querySelector('.agent-routines-host').hidden"), 'More opens Routines');
    await js("document.querySelector('.agent-more').click(); document.querySelector('.agent-more-item[data-place=chat]').click()");
    await delay(320); // the sheet rises over 240ms; measure it settled
    ok(await js("(() => { const n=document.querySelector('.agent-conversations-home.is-open'); if (!n) return false; const r=n.getBoundingClientRect(); return document.querySelector('.agent-conversation-page').dataset.agentTab === 'chat' && r.top <= 0 && r.height >= innerHeight - 1 && n.contains(document.activeElement) && n.getAttribute('aria-modal') === 'true'; })()"), 'Chat and conversations opens the conversation sheet');
    await capture('agents-phone-conversations');
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    ok(await js("!document.querySelector('.agent-conversations-home.is-open') && document.activeElement === document.querySelector('.agent-more')"), 'Escape closes the conversation sheet');
    await js("document.querySelector('.agent-more').click(); document.querySelector('.agent-more-item[data-place=chat]').click()");
    await js("document.querySelector('.agent-conversations-home .agent-chat-open').click()");
    await waitFor("!document.querySelector('.agent-conversations-home.is-open')");
    ok(await js("[...document.querySelectorAll('.agent-chat-main .side-chat-composer .btn:is(.agent-composer-add, .side-chat-send)')].every(b => { const r=b.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }) && document.querySelector('.agent-chat-main .side-chat-send').textContent === 'Send'"), 'picking a conversation returns to the thread; composer targets stay 44px');
    ok(await js("(() => { const u=getComputedStyle(document.querySelector('.msg.user .msg-body')), a=getComputedStyle(document.querySelector('.msg.assistant .msg-body')); return u.backgroundColor !== a.backgroundColor && document.querySelector('.msg.user .msg-body').getBoundingClientRect().right > document.querySelector('.agent-conversation-stream').getBoundingClientRect().right - 12; })()"), 'phone bubbles: the person on the right, a distinct fill');
    await js("document.querySelector('.agent-profile-open').click()");
    await delay(300);
    ok(await js("document.querySelector('.agent-profile-tabs').getBoundingClientRect().height >= 40 && document.querySelector('.agent-profile-titlebar .agent-dot-avatar').getBoundingClientRect().top >= 0"), 'phone profile keeps its face and full-height tabs on screen');
    await capture('agents-phone-profile');
    await js("document.querySelector('.agent-profile-sheet [aria-label=\"Close profile\"]').click()");
    const question = "[...document.querySelectorAll('.agent-inline-activity .agent-inbox-question')].find(n => n.textContent.includes('Which direction?'))";
    await js(`${question}.scrollIntoView({block:'center'});`);
    await capture('ui3-after-mobile-approvals');
    await js(`${question}.querySelector('.agent-waiting-details').click()`);
    await waitFor("!!document.querySelector('.agent-item-sheet[open]')");
    ok(await js("document.activeElement === document.querySelector('.agent-item-close')"), 'sheet focuses close');
    await js("document.querySelector('.agent-item-close').dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))");
    ok(await js("document.activeElement === document.querySelector('.agent-item-secondary')"), 'sheet traps reverse Tab');
    await js("document.querySelector('.agent-item-secondary').dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true}))");
    ok(await js("document.activeElement === document.querySelector('.agent-item-close')"), 'sheet traps forward Tab');
    await capture('ui3-after-mobile-sheet');
    await js("document.querySelector('.agent-item-close').click()");
    ok(await js("!document.querySelector('.agent-item-sheet')"), 'sheet closes by button');
    await js(`${question}.querySelector('.agent-waiting-details').click(); document.querySelector('.agent-item-sheet').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape',bubbles:true,cancelable:true }))`);
    ok(await js("!document.querySelector('.agent-item-sheet')"), 'sheet closes by Escape');
    await js(`${question}.querySelector('.agent-waiting-details').click(); (() => { const n=document.querySelector('.agent-item-portrait'); n.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientY:100,bubbles:true})); n.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientY:200,bubbles:true})); })()`);
    ok(await js("!document.querySelector('.agent-item-sheet')"), 'sheet closes by downward swipe');
    let start = writes.length;
    await js(`${question}.querySelector('.btn.primary').click(); (() => { const n=${question}.querySelector('input'); n.value='Use the first option'; n.focus(); n.setSelectionRange(7,7); window.__ui3Draft=n; })()`);
    await js("document.querySelector('.agent-inline-activity .agent-inbox-report .btn.primary').click()");
    await waitFor("!document.querySelector('.agent-inline-activity .agent-inbox-report')");
    ok(writes.slice(start).some(w => w.path === '/api/agents/inbox/i2/answer' && JSON.parse(w.body).choice === 'dismiss'), 'dismiss uses existing answer route');
    ok(await js(`${question}.querySelector('input') === window.__ui3Draft && document.activeElement === window.__ui3Draft && window.__ui3Draft.value === 'Use the first option' && window.__ui3Draft.selectionStart === 7`), 'refreshing a neighbour preserves the answer node, draft, focus and caret');
    start = writes.length;
    await js(`[...${question}.querySelectorAll('button')].find(b => b.textContent === 'Send').click(); delete window.__ui3Draft`);
    await waitFor(`!${question}`);
    ok(writes.slice(start).some(w => w.path === '/api/agents/inbox/i3/answer' && JSON.parse(w.body).choice === 'reply'), 'question uses existing answer route');
    start = writes.length;
    await js("document.querySelector('.agent-inline-activity .agent-inbox-review .btn.primary').click()");
    await delay(150);
    ok(writes.slice(start).some(w => w.path === '/api/tasks/c9/status' && JSON.parse(w.body).status === 'done'), 'review uses existing approval route');
    start = writes.length;
    await js(`import('/static/js/permissionPrompt.js').then(m => m.showPermissionPrompt({id:'ui3-permission',tool:'Browser',title:'Open this page',description:'This action needs your permission.',choices:[{id:'deny',label:'Deny',behavior:'deny'},{id:'once',label:'Allow'}]}, null, {mount:document.querySelector('.agent-conversation-stream'),inline:true}))`);
    ok(await js("!!document.querySelector('.agent-inline-permission .agent-blocked-status') && document.querySelector('.agent-inline-permission').querySelectorAll('.permission-choices button').length === 2"), 'inline permission has status and both choices');
    await js("document.querySelector('.agent-inline-permission [data-choice=once]').click()");
    await delay(150);
    ok(writes.slice(start).some(w => w.path === '/api/permissions/ui3-permission/answer' && JSON.parse(w.body).choice === 'once'), 'permission uses existing route');
    // Paint is opaque and token-derived: check computed surfaces and contrast.
    const contrast = await js(`(() => {
      const rgb = value => (value.match(/[\\d.]+/g)||[]).slice(0,3).map(Number).map(n => value.startsWith('color(srgb') ? n : n/255);
      const light = value => rgb(value).map(n => n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
      return ['.msg.assistant .msg-body','.msg.user .msg-body','.agent-live-panel','.agent-approval-card'].map(selector => {
        const s=getComputedStyle(document.querySelector(selector)), b=light(s.backgroundColor), f=light(s.color);
        return {selector,dark:b<.22,ratio:(Math.max(b,f)+.05)/(Math.min(b,f)+.05)};
      });
    })()`);
    for (const c of contrast) ok(c.dark && c.ratio >= 4.5, `${c.selector} dark surface, contrast ${c.ratio}`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await navigate('agents', {agentId:'a1'});
    await waitFor("!!document.querySelector('.agent-composer-orb')");
    await js("document.querySelector('.agent-inline-activity .agent-waiting-details').click()");
    const motion = await js("[...document.querySelector('.agent-conversation-page').getAnimations({subtree:true}), ...document.querySelector('.agent-item-sheet').getAnimations({subtree:true})].map(a => ({ target:a.effect?.target?.className, name:a.animationName || a.transitionProperty, state:a.playState }))");
    ok(motion.length === 0, 'reduced motion disables all new animations: ' + JSON.stringify(motion));
    await js("document.querySelector('.agent-item-close').click()");
    console.log(`PASS: UI-3 conversation layout: ${checks} assertions.`);
    return { checks };
  } finally {
    inbox.splice(0, inbox.length, ...savedInbox); demoState.agentReview = savedReview;
    await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${JSON.stringify(appearance)}))`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    win.setContentSize(1440, 900);
  }
};

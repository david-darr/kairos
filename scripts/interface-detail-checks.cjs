const assert = require('node:assert/strict');
module.exports = async ({ js, win, waitFor, capture, delay, navigate, overflow }) => {
  for (const [label, w, h] of [['desktop', 1440, 900], ['phone', 390, 844], ['small-phone', 320, 568]]) {
    win.setContentSize(w, h); await delay(350);
    await js("import('/static/js/app.js').then(m => m.switchMode('forge'))");
    await waitFor("!!document.querySelector('.forge-composer')");
    assert.deepEqual(await overflow(), [], `${label} Forge Home fits`);
    assert.equal(await js("(() => {const c=document.querySelector('.forge-composer'), t=c.querySelector('textarea'); return t.getBoundingClientRect().width >= c.clientWidth * .7 && t.getBoundingClientRect().height >= 60;})()"), true, `${label} Forge prompt has useful editing space`);
    assert.equal(await js(`(() => {
      const b=document.querySelector('.forge-composer-send'), r=b.getBoundingClientRect(), c=getComputedStyle(b);
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
      const pixels=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].join(',')};
      return r.width>=33.99 && r.right<=innerWidth && pixels(c.color)!==pixels(c.backgroundColor);
    })()`), true, `${label} Forge Send remains visible and within the screen`);
    await capture(`interface-${label}-forge-home`);
    await navigate('forgeShell', { projectId: 'fp1', sessionId: 'fs1' });
    await waitFor("!!document.querySelector('.forge-transcript-composer')");
    await delay(350);
    assert.deepEqual(await overflow(), [], `${label} Forge session fits`);
    if (w <= 768) {
      await js("if (!document.querySelector('.forge-project-sidebar').hidden) document.querySelector('[aria-label=\"Close project sidebar\"]').click()");
    }
    await capture(`interface-${label}-forge-session`);
    await js("import('/static/js/app.js').then(m => m.switchMode('kairos'))");
    await navigate('chat', { sessionId: 's1' });
    await js("import('/static/js/appearance.js').then(m => {window.__originalAppearance=m.getAppearance(); m.updateAppearance({mode:'color', color:'#23302e'});})");
    await delay(350);
    assert.deepEqual(await overflow(), [], `${label} dark custom appearance fits`);
    assert.equal(await js(`(() => {
      const c=getComputedStyle(document.getElementById('model-picker-btn'));
      const bg=getComputedStyle(document.querySelector('.chat-header-model')).backgroundColor;
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d');
      const luminance=color => {ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0)};
      const a=luminance(c.color), b=luminance(bg);
      return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;
    })()`), true, 'Model text has AA contrast on a custom dark surface');
    await capture(`interface-${label}-dark-chat`);
    await js("import('/static/js/appearance.js').then(m=>m.updateAppearance(window.__originalAppearance))");
    await js("import('/static/js/permissionPrompt.js').then(m=>m.showPermissionPrompt({id:'interface-fixture', tool_name:'Read project files', description:'Kairos needs permission before continuing this task.', target:'Project workspace', arguments:{path:'notes/project-brief.md'}, choices:[{id:'once',label:'Allow once',behavior:'allow'},{id:'deny',label:'Decline',behavior:'deny'}]}))");
    assert.equal(await js("(() => {const r=document.querySelector('.permission-dialog').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;})()"), true, `${label} permission request fits`);
    await capture(`interface-${label}-permission`);
    await js("document.querySelector('.permission-dialog').dataset.resolved='true'; import('/static/js/permissionPrompt.js').then(m=>m.dismissPermissionPrompt())");
  }
};

const assert = require('node:assert/strict');

module.exports = async function settingsPatchChecks({ js, win, waitFor, delay, capture }) {
  const open = section => js(`import('/static/js/views/settings.js').then(m => m.openSettingsWindow('${section}'))`);
  const close = () => js(`document.querySelector('.settings-titlebar-btn[title="Close"]').click()`);
  const fits = async label => {
    await delay(250);
    const box = await js(`(() => { const p = document.querySelector('.settings-window'), r = p.getBoundingClientRect();
      return { width:r.width, height:r.height, x:r.left, y:r.top, right:r.right, bottom:r.bottom, W:innerWidth, H:innerHeight }; })()`);
    assert.ok(box.width >= 450 && box.height >= 300, label + ' has usable dimensions ' + JSON.stringify(box));
    assert.ok(box.x >= 0 && box.y >= 0 && box.right <= box.W + 1 && box.bottom <= box.H + 1, label + ' fits viewport ' + JSON.stringify(box));
  };
  win.setContentSize(1440, 900); await open('add-models'); await fits('initial open');
  await close(); await delay(250); win.setContentSize(900, 620); await delay(150);
  await open('add-models'); await fits('closed resize reopen');
  // Recover users already affected by the earlier zero-size bug.
  await js(`{ const p=document.querySelector('.settings-window'); p.style.width='0px'; p.style.height='0px'; }`);
  await close(); await delay(250); await open('add-models'); await fits('legacy zero rect recovery');
  await js(`document.querySelector('.settings-titlebar-btn[title="Minimize"]').click()`);
  await delay(250); win.setContentSize(820, 510); await delay(150);
  await js("document.querySelector('.settings-minimized-pill').click()"); await fits('minimized resize restore');
  await js("document.documentElement.style.setProperty('--titlebar-h','36px')");
  win.setContentSize(850, 510); await delay(150); await fits('titlebar reserved');
  assert.ok(await js("document.querySelector('.settings-window').getBoundingClientRect().top >= 36"), 'reserves desktop titlebar');
  await js("document.documentElement.style.removeProperty('--titlebar-h')");
  const button = await js(`(() => { const b=document.querySelector('.model-setup-start'), row=b.closest('.set-row'), r=b.getBoundingClientRect();
    return { width:r.width, parent:row.clientWidth, inside:!!b.closest('.set-row-control'), height:r.height }; })()`);
  assert.ok(button.inside && button.width < button.parent && button.height < 80, 'model setup is a natural-size padded action');
  await open('integrations'); await waitFor("!!document.querySelector('.mcp-catalog')");
  await js("document.querySelector('.mcp-catalog').open=true"); await delay(250);
  assert.ok(await js("getComputedStyle(document.querySelector('.mcp-catalog > summary')).borderRadius === '0px'"), 'Catalog summary uses Settings row styling');
  assert.ok(await js("[...document.querySelectorAll('.mcp-catalog-row')].every(r => r.scrollWidth <= r.clientWidth + 2)"), 'MCP actions fit narrow Settings rows');
  assert.ok(await js("(() => { const a=document.querySelector('.set-header-text').getBoundingClientRect(), b=document.querySelector('.set-header-actions').getBoundingClientRect(); return b.top >= a.bottom; })()"), 'compact header stacks actions below description');
  await js("document.querySelector('.mcp-catalog').scrollIntoView({block:'start',behavior:'instant'})");
  if (capture) await capture('settings-patch-compact');
  await close(); await delay(250); win.setContentSize(1440, 900);
  console.log('PASS: Settings closed/minimized resize recovery, legacy zero rect, titlebar, model action and Catalog layout');
};

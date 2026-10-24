// Called by ui-smoke (or --home-only). Uses the shared synthetic backend.
const assert = require('node:assert/strict');

module.exports = async function homeChecks({ js, win, waitFor, capture, delay, navigate, demoState }) {
  const original = await js("import('/static/js/appearance.js').then(m => m.getAppearance())");
  const layout = await js("import('/static/js/layout.js').then(m => m.getLayout())");
  const originalEmpty = demoState.empty, originalQuotas = demoState.quotas, originalClear = demoState.homeClear;
  const base = win.webContents.getURL();
  const reload = async () => {
    await win.loadURL(base);
    await navigate('home');
    await waitFor("!!document.querySelector('.hm-home .hm-week .rd-dot-matrix') && !!document.querySelector('.dashboard-system-chip')");
    await waitFor("!!document.querySelector('.dashboard-core')?.classList.contains('is-dithered') && !!document.querySelector('.dashboard-core canvas')");
    await delay(900); // Initial stagger has finished before comparing edges.
  };
  const sections = () => js("[...document.querySelectorAll('.dashboard-grid > [data-home-section]')].map(n => n.dataset.homeSection)");
  const congruent = async () => {
    const result = await js(`(() => {
      const grid = document.querySelector('.dashboard-grid'), bounds = grid.getBoundingClientRect();
      const rows = [];
      for (const node of grid.children) {
        if (!node.getClientRects().length) continue;
        const r = node.getBoundingClientRect();
        let row = rows.find(row => Math.abs(row[0].top - r.top) <= 2);
        if (!row) rows.push(row = []);
        row.push({top:r.top, bottom:r.bottom, left:r.left, right:r.right});
      }
      return rows.every(row => Math.abs(Math.min(...row.map(r=>r.left)) - bounds.left) <= 2 &&
        Math.abs(Math.max(...row.map(r=>r.right)) - bounds.right) <= 2 &&
        row.every(r=>Math.abs(r.top-row[0].top)<=2 && Math.abs(r.bottom-row[0].bottom)<=2));
    })()`);
    assert.ok(result, 'Every desktop row fills the grid and shares top/bottom edges within 2px');
  };
  const hero = async phone => {
    if (phone) {
      assert.ok(await js(`(() => {
        const grid = document.querySelector('.dashboard-grid'), week = grid.querySelector('.hm-week');
        return !document.querySelector('.dashboard-hero, kairos-mascot[follow-pointer]') && grid.firstElementChild === week &&
          !!week.querySelector('.dashboard-core.is-dithered canvas') && week.querySelector('.dashboard-core').dataset.halftoneSrc;
      })()`), 'Phone starts with the week and its Home halftone, without a hero or following eyes');
      assert.ok(await js(`(() => {
        const week = document.querySelector('.hm-week').getBoundingClientRect();
        const wash = getComputedStyle(document.querySelector('.hm-week .dashboard-core'), '::after').backgroundImage;
        return Math.abs(week.left - 20) < 2 && Math.abs(innerWidth - week.right - 20) < 2 && wash.includes('90deg') && wash.includes('55%');
      })()`), 'Phone uses 20px gutters and the horizontal mockup wash');
    } else {
      assert.ok(await js(`(() => {
      const hero = document.querySelector('.dashboard-grid > .dashboard-hero');
      const labels = [...hero.querySelectorAll('.dashboard-actions button')].map(n=>n.textContent);
      return labels.some(s=>s.includes('Start a conversation')) && labels.some(s=>s.includes('Explore your vault')) &&
        !!hero.querySelector('.dashboard-core canvas') && !!hero.querySelector('kairos-mascot[follow-pointer]') &&
        !hero.querySelector('.dashboard-stats, .hm-week-stats, .dashboard-system-pill, .dashboard-next');
    })()`), 'Desktop preserves the original hero, both actions and opted-in Kip');
    assert.ok(await js(`(() => {
      const h = document.querySelector('.dashboard-hero').getBoundingClientRect();
      const k = document.querySelector('.dashboard-mascot').getBoundingClientRect();
      return Math.abs(k.top-h.top-23)<=2 && Math.abs(h.right-k.right-25)<=2 && Math.abs(k.height-72)<=2;
    })()`), 'Kip stays at the top-right corner at the intended size');
      assert.ok(await js("!document.querySelector('.hm-week .dashboard-core, .hm-week canvas')"), 'Desktop week has no picture');
    }
    assert.ok(await js("!!document.querySelector('.hm-week') && !!document.querySelector('[data-home-section=system]')"));
    assert.equal(await js("document.querySelectorAll('.hm-week .rd-dot').length"), 84);
    assert.ok(await js("!document.querySelector('.hm-week-stats').textContent.includes('notes done')"));
    assert.ok(await js(`(() => {
      const week = document.querySelector('.hm-week'), dots = [...week.querySelectorAll('.rd-dot')];
      const stats = [...week.querySelectorAll('.hm-week-stats > div')];
      return dots.every(n => getComputedStyle(n).borderRadius === '2px') &&
        getComputedStyle(week.querySelector('h2')).textTransform === 'uppercase' &&
        getComputedStyle(week.querySelector('.hm-week-range')).borderRadius === '999px' &&
        stats.every(n => getComputedStyle(n).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(n).padding === '0px') &&
        [...week.querySelectorAll('.hm-week-days span')].map(n=>n.textContent).join() === 'Mon,Tue,Wed,Thu,Fri,Sat,Sun' &&
        /Busiest: (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(week.querySelector('.hm-busiest').textContent) &&
        getComputedStyle(week.querySelector('.hm-legend-chats'), '::before').backgroundColor === getComputedStyle(week.querySelector('.rd-dot-a')).backgroundColor &&
        getComputedStyle(week.querySelector('.hm-legend-runs'), '::before').backgroundColor === getComputedStyle(week.querySelector('.rd-dot-b')).backgroundColor &&
        getComputedStyle(week.querySelector('.rd-dot-empty')).backgroundColor !== getComputedStyle(week.querySelector('.rd-dot-dim')).backgroundColor;
    })()`), 'Week matches the label, pill, inline stats, square cells, alternating tones and weekday labels');
  };
  try {
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({classic:false,halftone:true,mascot:true}))");
    await js("import('/static/js/layout.js').then(m => m.resetHomeLayout())");
    for (const clear of [false, true]) {
      demoState.empty = false; demoState.homeClear = clear;
      win.setContentSize(1440, 1000);
      await reload();
      await waitFor(clear ? "!document.querySelector('[data-home-section=needs], [data-home-section=working]')" : "!!document.querySelector('[data-home-section=needs] .hm-live-row') && !!document.querySelector('[data-home-section=working] .hm-live-row')");
      await hero(false);
      assert.ok(await js(`(() => {
        const panel = document.querySelector('[data-home-section=system]');
        const title = panel.querySelector('h2').getBoundingClientRect();
        const details = panel.querySelector('.dashboard-section-header button').getBoundingClientRect();
        const chips = [...panel.querySelectorAll('.dashboard-system-chip')].map(n => n.getBoundingClientRect());
        const center = r => (r.top + r.bottom) / 2;
        return chips.length > 0 && title.right < chips[0].left && chips.at(-1).right < details.left &&
          chips.every(r => Math.abs(center(r) - center(title)) < 2) && Math.abs(center(details) - center(title)) < 2 &&
          panel.getBoundingClientRect().height < 80;
      })()`), 'Desktop Systems is a slim centered strip, title left and Details right');
      const ids = await sections();
      for (const id of ['needs', 'working']) assert.equal(ids.includes(id), !clear, id + ' obeys its item gate');
      for (const id of ['chats', 'schedule']) assert.ok(ids.includes(id), id + ' remains present in all-clear with items');
      assert.ok(ids.includes('models'), 'Quota fixture has usage in both states');
      await congruent();
      await capture(clear ? 'desktop-home-clear' : 'desktop-home');
      if (!clear) {
        await js("import('/static/js/layout.js').then(m => {const l=m.getLayout(); l.home=['chats',...l.home.filter(id=>id!=='chats')]; m.saveLayout(l)})");
        await delay(900); await congruent();
        await reload();
        assert.equal((await sections())[0], 'chats', 'Saved custom order survives reload');
        await congruent();
        await js("document.querySelector('.hm-customize').click()");
        await waitFor("!!document.querySelector('.hm-sheet')");
        await js("document.querySelector('[data-focus=\"models:toggle\"]').click()");
        assert.ok(!(await sections()).includes('models'), 'Customize can hide usage');
        await congruent();
        await js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
        await js("import('/static/js/layout.js').then(m => m.resetHomeLayout())");
        await reload();
      }
      win.setContentSize(390, 844); await delay(900);
      await hero(true);
      for (const patch of [{halftone:false}, {halftone:true,mode:'image'}, {mode:'shader'}]) {
        await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${JSON.stringify(patch)}))`);
        assert.ok(await js("getComputedStyle(document.querySelector('.hm-week .dashboard-core')).display === 'none'"), 'Off, Image and Flow give the phone a plain week surface');
      }
      await js("import('/static/js/appearance.js').then(m => m.updateAppearance({mode:'default',halftone:true}))");
      await delay(300);
      assert.ok(await js(`(() => {
        const panel = document.querySelector('[data-home-section=system]');
        return panel.querySelector('h2').getBoundingClientRect().bottom <= panel.querySelector('.dashboard-system-chips').getBoundingClientRect().top && panel.scrollWidth <= panel.clientWidth + 2;
      })()`), 'Phone Systems keeps its title above the wrapping statuses');
      assert.deepEqual(await sections(), clear ? ['models', 'chats', 'schedule', 'system'] : ['needs', 'working', 'models', 'chats', 'schedule', 'system'], 'Phone uses the required section order');
      assert.ok(await js("[...document.querySelector('.dashboard-grid').children].every(n=>n.scrollWidth<=n.clientWidth+2)"), 'Phone cards fit');
      await capture(clear ? 'mobile-home-clear' : 'mobile-home');
      await reload(); await hero(true); // Mounting at phone width also has no hero.
    }
    // Completely empty optional sections also disappear, including Model usage.
    demoState.empty = true; demoState.quotas = { providers: [] };
    win.setContentSize(1440, 900); await reload();
    assert.deepEqual(await sections(), ['system']); await congruent();
  } finally {
    demoState.empty = originalEmpty; demoState.homeClear = originalClear; demoState.quotas = originalQuotas;
    win.setContentSize(1440, 900);
    await js(`import('/static/js/layout.js').then(m => m.saveLayout(${JSON.stringify(layout)}))`);
    await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${JSON.stringify(original)}))`);
    await win.loadURL(base);
  }
  // Exercise the same immediate switch after reload as ui-smoke's Classic block.
  try {
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({classic:true}))");
    await navigate('home');
    await waitFor("!!document.querySelector('.dashboard-content.is-filled')");
    assert.ok(await js("!document.documentElement.classList.contains('kairos-redesign')"), 'Startup preserves the Classic choice');
    assert.ok(await js("document.querySelector('.dashboard-hero').contains(document.querySelector('.dashboard-header')) && !document.querySelector('.dashboard-hero').contains(document.querySelector('.dashboard-stats'))"), 'Classic keeps its header and introduction above the summary strip');
    // Startup can replace Home between renderer calls. Sample readiness and
    // duration together so the performance assertion measures that same draw.
    await waitFor(`(() => {
      const b = document.querySelector('.dashboard-core');
      if (!b?.classList.contains('is-dithered') || !b.querySelector('canvas') || !Number.isFinite(Number(b.dataset.drawMs))) return false;
      window.__classicBannerTiming = { ms: Number(b.dataset.drawMs), width: b.clientWidth, height: b.clientHeight };
      return true;
    })()`);
    assert.ok(await js("!document.querySelector('.kairos-sky-image, .kairos-sky-point, .core-motion-toggle, .core-caption, .kairos-mark')"), 'Classic has no sky scene, dot or motion control');
    const timing = await js("window.__classicBannerTiming");
    assert.ok(timing.ms < 400, 'Classic banner draws quickly: ' + JSON.stringify(timing));
  } finally {
    await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${JSON.stringify(original)}))`);
  }
};

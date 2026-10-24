// Shared phone Chats header contract, exercised at every safe-area/device size.
// rowTop is safe-top + 6 from the callers; the Chats board starts its title row 14px below the safe area (+8).
module.exports = async ({ js, ok, eq, press }, label, rowTop) => {
  const r = await js(`(() => {
    const header = document.querySelector('.ms-shell .ms-header');
    const row = header?.querySelector('.ms-header-row'), title = row?.querySelector('h1');
    const switches = [...document.querySelectorAll('.ms-shell .ms-switch')];
    const control = switches[0];
    if (!header || !row || !title || !control) return null;
    const box = n => { const b = n.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const buttons = [...row.querySelectorAll('button')], tabs = [...control.querySelectorAll('[role=tab]')];
    const style = getComputedStyle(title);
    const hit = n => { const b = box(n); return n.contains(document.elementFromPoint(b.l + b.w / 2, b.t + b.h / 2)); };
    return { header: box(header), row: box(row), title: box(title), text: title.textContent,
      italic: style.fontStyle, font: style.fontFamily, size: style.fontSize,
      switches: switches.length, direct: row.nextElementSibling === control && control.parentElement === header,
      switch: box(control), role: control.getAttribute('role'), names: tabs.map(n => n.textContent),
      tabs: tabs.map(box), buttons: buttons.map(box), round: buttons.every(n => parseFloat(getComputedStyle(n).borderRadius) >= 23),
      hit: [...buttons, ...tabs].every(hit), width: innerWidth,
      overflow: header.scrollWidth > header.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1 };
  })()`);
  ok(r, `${label}: Chats header, title row and switch exist`);
  eq([r.text, r.italic, r.size], ['Chats', 'italic', '40px'], `${label}: serif-italic Chats title typography`);
  ok(/serif/i.test(r.font), `${label}: Chats title uses the serif family: ${r.font}`);
  ok(Math.abs(r.row.t - (rowTop + 8)) <= 1 && Math.abs(r.row.l - 20) <= 1 && Math.abs(r.row.r - (r.width - 20)) <= 1,
    `${label}: title row clears the status bar and keeps 20px gutters: ${JSON.stringify(r)}`);
  ok(Math.abs(r.title.l - r.row.l) <= 1 && r.buttons.length > 0 && r.buttons.length <= 2 && r.round &&
    r.buttons.every((b, i) => Math.abs(b.w - 46) <= 1 && Math.abs(b.h - 46) <= 1 && b.t >= r.row.t - 1 && b.b <= r.row.b + 1 && b.l >= (i ? r.buttons[i - 1].r : r.title.r) && b.r <= r.row.r + 1),
    `${label}: title left and at most two round 46px actions right, without overlap`);
  eq([r.switches, r.direct, r.role, r.names], [1, true, 'tablist', ['New', 'Chats']], `${label}: one original switch directly follows the title row inside the header`);
  ok(Math.abs(r.switch.t - r.row.b - 18) <= 1 && r.switch.b <= r.header.b + 1 && r.switch.l >= r.header.l && r.switch.r <= r.header.r &&
    r.tabs.length === 2 && r.tabs.every(b => b.w >= 44 && b.h >= 44 && b.t >= r.switch.t && b.b <= r.switch.b) && r.tabs[0].r <= r.tabs[1].l && r.hit && !r.overflow,
    `${label}: switch is 18px below the title row, touch-sized, hit-testable and contained without overflow: ${JSON.stringify(r)}`);
  const selected = await js("document.querySelector('.ms-switch [aria-selected=true]').id");
  await js("document.getElementById('ms-tab-0').focus()");
  for (const [key, vk, index] of [['ArrowRight', 39, 1], ['Home', 36, 0], ['End', 35, 1], ['ArrowLeft', 37, 0]]) {
    await press(key, key, vk);
    ok(await js(`document.activeElement.id === 'ms-tab-${index}' && document.activeElement.tabIndex === 0 && document.activeElement.getAttribute('aria-selected') === 'true' && !document.getElementById('ms-page-${index}').inert && document.getElementById('ms-page-${1 - index}').inert`),
      `${label}: ${key} selects and focuses the tab and exposes its panel`);
  }
  await js(`document.getElementById(${JSON.stringify(selected)}).click(); document.activeElement?.blur()`);
};

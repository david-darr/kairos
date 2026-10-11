// Shared by the full UI smoke and its focused --chat-references-only run.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, capture, delay, navigate, writes }) => {
  await navigate('chat');
  await waitFor("!!document.querySelector('#chat-input')");
  const typeMention = async selector => {
    await js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = 'Review this @'; i.focus(); i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  const key = (selector, name) => js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`);
  const headings = scope => js(`[...document.querySelectorAll(${JSON.stringify(scope + ' .chat-reference-heading')})].map(h => h.textContent)`);
  await typeMention('#chat-input');
  await waitFor("document.querySelectorAll('#chat-main .chat-reference-heading').length === 8");
  assert.deepEqual(await headings('#chat-main'), ['Agents', 'Skills', 'Tools', 'Automations', 'Documents', 'Files', 'Notes', 'Chats']);
  await capture('desktop-chat-mentions-grouped');
  const count = await js("document.querySelectorAll('#chat-main .chat-reference-option').length");
  const visited = new Set();
  for (let index = 0; index < count; index++) {
    const state = await js("(() => { const i = document.querySelector('#chat-input'), option = document.getElementById(i.getAttribute('aria-activedescendant')); return { role: option?.getAttribute('role'), selected: option?.getAttribute('aria-selected'), group: option?.parentElement.getAttribute('aria-label') }; })()");
    assert.equal(state.role, 'option'); assert.equal(state.selected, 'true'); visited.add(state.group);
    await key('#chat-input', 'ArrowDown');
  }
  assert.equal(visited.size, 8, 'Arrow keys cross all groups, without selecting headings');
  await key('#chat-input', 'ArrowUp');
  assert.equal(await js("document.getElementById(document.querySelector('#chat-input').getAttribute('aria-activedescendant')).parentElement.getAttribute('aria-label')"), 'Chats', 'Up wraps across groups');
  await key('#chat-input', 'Escape');
  await js("document.querySelector('#chat-input').value = 'Review this'; document.querySelector('#chat-input').setSelectionRange(11, 11); document.querySelector('#overflow-plus-btn').click(); [...document.querySelectorAll('#overflow-menu .overflow-menu-item')].find(b => b.textContent.trim() === 'Use a skill').click()");
  await waitFor("!document.querySelector('#chat-main .chat-reference-picker').hidden && document.querySelector('#chat-main .chat-reference-heading')?.textContent === 'Skills'");
  assert.deepEqual(await headings('#chat-main'), ['Skills'], 'Use a skill filters the picker');
  assert.equal(await js("document.activeElement.id"), 'chat-input');
  assert.equal(await js("document.querySelector('#chat-input').value"), 'Review this @', 'Only a mention token is inserted');
  await capture('desktop-chat-use-a-skill');
  const writeCount = writes.length;
  await key('#chat-input', 'Enter');
  assert.ok(await js("document.querySelector('#chat-main .chat-reference-chip').textContent.startsWith('Skill · ')") , 'A selected skill has a labelled chip');
  assert.equal(await js("document.querySelector('#chat-input').value"), 'Review this ', 'Skill body is not pasted');
  assert.equal(writes.length, writeCount, 'Selecting a skill does not send');
  await js("document.querySelector('#chat-main .chat-reference-chip button').click()");
  await js("(() => { const i = document.querySelector('#chat-input'); i.value = 'Review this @writing'; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelector('#chat-main .chat-reference-name')?.textContent === 'writing-partner'");
  assert.deepEqual(await headings('#chat-main'), ['Skills'], 'Typing after @ searches across kinds');
  await key('#chat-input', 'Tab');
  assert.ok(await js("document.querySelector('#chat-main .chat-reference-chip').textContent.includes('Skill · writing-partner')"), 'Tab selects the search result');
  await js("document.querySelector('#chat-main .chat-reference-chip button').click()");

  win.setContentSize(390, 844); await delay(300);
  await typeMention('#chat-input');
  await waitFor("document.querySelectorAll('#chat-main .chat-reference-heading').length === 8");
  await capture('mobile-chat-mentions-grouped');
  assert.ok(await js("(() => { const r = document.querySelector('#chat-main .chat-reference-picker').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), 'Mobile picker fits');
  await key('#chat-input', 'Escape');
  await js("document.querySelector('#chat-input').value = ''; document.querySelector('#chat-input').dispatchEvent(new Event('input'))");
  win.setContentSize(1440, 900); await delay(250);

  // Each mounted composer uses the same groups and selection behavior.
  await js("import('/static/js/sideChat.js').then(m => m.openSideChat('s2'))");
  await waitFor("!!document.querySelector('.side-chat .side-chat-input')");
  await typeMention('.side-chat .side-chat-input');
  await waitFor("document.querySelectorAll('.side-chat .chat-reference-heading').length === 8");
  await js("(() => { const i = document.querySelector('.side-chat .side-chat-input'); i.value = 'Review this @writing'; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input')); })()");
  await waitFor("document.querySelector('.side-chat .chat-reference-name')?.textContent === 'writing-partner'");
  await key('.side-chat .side-chat-input', 'Enter');
  assert.ok(await js("document.querySelector('.side-chat .chat-reference-chip').textContent.startsWith('Skill · ')") , 'Side chat supports skills');
  await js("import('/static/js/sideChat.js').then(m => m.closeSideChat())");
  await js("(async () => { const h = document.createElement('div'); h.id = 'reference-embedded-check'; document.body.append(h); window.releaseReferenceChat = await import('/static/js/sessionChat.js').then(m => m.mountSessionChat(h, { sessionId: 's2' })); })()");
  await typeMention('#reference-embedded-check .side-chat-input');
  await waitFor("document.querySelectorAll('#reference-embedded-check .chat-reference-heading').length === 8");
  await js("[...document.querySelectorAll('#reference-embedded-check .chat-reference-option')].find(b => b.parentElement.getAttribute('aria-label') === 'Documents').click()");
  assert.ok(await js("document.querySelector('#reference-embedded-check .chat-reference-chip').textContent.startsWith('Document · ')") , 'Embedded chat supports documents');
  await js("window.releaseReferenceChat(); delete window.releaseReferenceChat; document.querySelector('#reference-embedded-check').remove()");
  assert.equal(writes.length, writeCount, 'Picker interaction never runs tools or automations');
};

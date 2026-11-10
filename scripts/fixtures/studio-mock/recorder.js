// Shared by the mock upload pages (scripts/browser-smoke.cjs, Prepare post): records every click, who made it and on
// what, every form submit, and any press of the final button. These pages only mimic the real flows' shape; they are
// local fixtures, never the real sites. window.__person is set by the test around the clicks it makes as the person.
window.__clicks = [];
window.__submits = 0;
window.__final = 0;
document.addEventListener('click', (event) => {
  const el = event.target.closest('button,a,[role],input,label') || event.target;
  window.__clicks.push({
    who: window.__person ? 'person' : 'kairos', tag: el.tagName, role: el.getAttribute('role') || '', type: el.getAttribute('type') || '',
    name: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 60), final: el.hasAttribute('data-final'),
  });
  if (el.hasAttribute('data-final')) window.__final += 1;
}, true);
document.addEventListener('submit', (event) => { event.preventDefault(); window.__submits += 1; }, true);
// A role=radio or role=switch element turns on when clicked; radios in one group turn the others off.
document.addEventListener('click', (event) => {
  const el = event.target.closest('[role=radio],[role=switch]');
  if (!el || el.tagName === 'BUTTON') return;
  if (el.getAttribute('role') === 'radio') {
    const group = el.closest('[role=radiogroup]');
    if (group) for (const r of group.querySelectorAll('[role=radio]')) r.setAttribute('aria-checked', 'false');
    el.setAttribute('aria-checked', 'true');
  } else el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
});

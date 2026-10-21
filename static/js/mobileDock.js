import { mobileOn, phone, button } from './mobileShared.js';

export const dockTabs = ['notes', 'library', 'tasks', 'tool-store', 'cookbook', 'email', 'calendar'];
export const keyboardLift = (height, viewport) => viewport ? Math.max(0, height - viewport.height - viewport.offsetTop) : 0;
export function watchKeyboard(node) {
  const update = () => node.style.setProperty('--ms-keyboard', `${mobileOn() ? keyboardLift(innerHeight, window.visualViewport) : 0}px`);
  update(); window.visualViewport?.addEventListener('resize', update); window.visualViewport?.addEventListener('scroll', update); window.addEventListener('resize', update);
  phone.addEventListener('change', update); document.addEventListener('kairos:appearance', update);
  return () => { window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update); phone.removeEventListener('change', update); document.removeEventListener('kairos:appearance', update); node.style.removeProperty('--ms-keyboard'); };
}

// Hooks are attached at the existing controls' creation sites. The live search
// field moves, retaining its debounce, listeners, value and IME composition.
export function mountMobileDock(container, tab) {
  if (!dockTabs.includes(tab)) return () => {};
  const dock = document.createElement('div'); dock.className = 'ms-dock ms-glass'; dock.setAttribute('aria-label', `${tab} actions`);
  let search = null, anchor = null, signature = [];
  const restore = () => { if (anchor?.isConnected && search) anchor.after(search); anchor?.remove(); search = anchor = null; };
  const update = () => {
    observer.disconnect();
    const enabled = mobileOn();
    const candidates = [...container.querySelectorAll('[data-mobile-dock]')].filter(node => !node.hidden && !node.closest('[hidden]'));
    const same = signature.length === candidates.length && signature.every(node => candidates.includes(node));
    if (!enabled || !same || !dock.isConnected) {
      restore(); dock.replaceChildren();
      if (enabled) {
        const field = candidates.find(node => node.dataset.mobileDock === 'search');
        if (field) { search = field; anchor = document.createComment('Dock search home'); field.before(anchor); dock.append(field); }
        for (const target of candidates.filter(node => node.dataset.mobileDock !== 'search')) {
          const create = target.dataset.mobileDock === 'create';
          const proxy = button(create ? '+' : target.textContent, () => {
            if (target.matches('summary')) { target.parentElement.open = true; target.parentElement.querySelector('input, textarea, button')?.focus(); target.scrollIntoView({ block: 'center' }); }
            else if (target.matches('input, textarea')) { target.scrollIntoView({ block: 'center' }); target.focus(); }
            else if (target.dataset.mobileCatalog) { target.scrollIntoView({ block: 'start' }); target.querySelector('button')?.focus(); }
            else target.click();
          });
          proxy.setAttribute('aria-label', create ? target.dataset.mobileCreateLabel || 'Create' : target.textContent);
          proxy.disabled = target.disabled;
          if (target.hasAttribute('aria-pressed')) proxy.setAttribute('aria-pressed', target.getAttribute('aria-pressed'));
          dock.append(proxy);
        }
        if (dock.childElementCount) container.append(dock);
      }
      signature = candidates;
    } else {
      const targets = candidates.filter(node => node.dataset.mobileDock !== 'search');
      [...dock.querySelectorAll('button')].forEach((proxy, i) => {
        proxy.disabled = targets[i]?.disabled;
        if (targets[i]?.hasAttribute('aria-pressed')) proxy.setAttribute('aria-pressed', targets[i].getAttribute('aria-pressed'));
      });
    }
    if (!enabled || !dock.childElementCount) dock.remove();
    container.classList.toggle('ms-has-dock', enabled && !!dock.childElementCount);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-pressed'] });
  };
  const observer = new MutationObserver(update);
  const keyboard = watchKeyboard(dock);
  phone.addEventListener('change', update); document.addEventListener('kairos:appearance', update); update();
  return () => { observer.disconnect(); restore(); dock.remove(); container.classList.remove('ms-has-dock'); keyboard(); phone.removeEventListener('change', update); document.removeEventListener('kairos:appearance', update); };
}

export function mountGitDock(panel, { files, message, commit, push, pull, pr }) {
  const dock = document.createElement('div'); dock.className = 'ms-git-dock ms-glass';
  const staged = files.filter(file => file.staged).length;
  if (files.length) {
    const action = button(`Commit ${staged || files.length}`, () => {
      if (message.value.trim() && !commit.disabled) { commit.click(); return; }
      message.scrollIntoView({ block: 'center' }); message.focus();
      // Without a message, reveal the original commit form first.
    });
    action.disabled = message.disabled || (!files.length && commit.disabled); dock.append(action);
  }
  for (const [label, target] of [['Sync: Push', push], ['Sync: Pull', pull], ['PR', pr]]) {
    if (!target) continue;
    const action = button(label, () => target.click()); action.disabled = target.disabled; dock.append(action);
  }
  panel.append(dock);
  const gate = () => { dock.hidden = !mobileOn(); }; gate();
  phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate);
  const keyboard = watchKeyboard(dock);
  return () => { keyboard(); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); dock.remove(); };
}

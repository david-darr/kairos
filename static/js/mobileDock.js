import { mobileOn, phone, button } from './mobileShared.js';

// Tool Store keeps its own header search and phone sheet, so it mounts no dock.
export const dockTabs = ['notes', 'library', 'tasks', 'cookbook', 'email', 'calendar'];
// How far the page runs below the layout viewport: 0, except in an iOS
// home-screen app, where the page is the full screen (style.css
// --ms-page-height) but the layout viewport is short by the status bar.
export const belowFold = () => Math.max(0, (document.documentElement?.getBoundingClientRect().height || 0) - innerHeight);
// The keyboard's height above the layout viewport's bottom (sub-pixel noise is 0).
export const keyboardLift = (height, viewport) => {
  const lift = viewport ? height - viewport.height - viewport.offsetTop : 0;
  return lift > 1 ? lift : 0;
};
// --ms-keyboard is measured from the page bottom: 0 with the keyboard down, so
// surfaces sit at the true bottom; with it up, it includes the page below the
// layout viewport, so they land on the keyboard's top edge.
export function watchKeyboard(node) {
  const lifted = () => { const lift = mobileOn() ? keyboardLift(innerHeight, window.visualViewport) : 0; return lift ? lift + belowFold() : 0; };
  const update = () => node.style.setProperty('--ms-keyboard', `${lifted()}px`);
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
  // A view with no search of its own can mark one wrapper `filter` and its
  // rows `data-mobile-row`: the dock then owns a search field that only hides
  // and shows those rows (a class, never the rows' own `hidden`).
  let filterField = null, filterHost = null, note = null, query = '';
  const clearFilter = () => {
    for (const row of container.querySelectorAll('.ms-filtered-out')) row.classList.remove('ms-filtered-out');
    note?.remove(); note = null;
  };
  const applyFilter = () => {
    if (!filterHost || !filterField) return;
    const q = query.trim().toLowerCase(); let total = 0, shown = 0;
    for (const row of filterHost.querySelectorAll('[data-mobile-row]')) {
      total++; const hit = !q || row.textContent.toLowerCase().includes(q);
      row.classList.toggle('ms-filtered-out', !hit); if (hit) shown++;
    }
    const empty = !!q && total > 0 && !shown;
    if (empty && !note) {
      note = document.createElement('div'); note.className = 'ms-dock-note ms-glass'; note.setAttribute('role', 'status');
      document.body.append(note);
    }
    if (note) { note.textContent = `No matches for "${query.trim()}"`; if (!empty) { note.remove(); note = null; } }
  };
  const makeFilter = host => {
    if (!filterField) {
      filterField = document.createElement('input'); filterField.type = 'search'; filterField.autocomplete = 'off';
      filterField.addEventListener('input', () => { query = filterField.value; applyFilter(); });
    }
    const label = host.dataset.mobileFilterLabel || 'Search';
    filterField.placeholder = label; filterField.setAttribute('aria-label', label);
    filterHost = host; return filterField;
  };
  const restore = () => { if (anchor?.isConnected && search) anchor.after(search); anchor?.remove(); search = anchor = null; };
  const update = () => {
    observer.disconnect();
    const enabled = mobileOn();
    // The dock lives outside the view, so the search it holds is looked up there too.
    const candidates = [...(anchor?.isConnected ? dock.querySelectorAll('[data-mobile-dock]') : []), ...container.querySelectorAll('[data-mobile-dock]')].filter(node => !node.hidden && !node.closest('[hidden]'));
    const same = signature.length === candidates.length && signature.every(node => candidates.includes(node));
    if (!enabled || !same || !dock.isConnected) {
      restore(); dock.replaceChildren(); filterHost = null; clearFilter();
      if (enabled) {
        const field = candidates.find(node => node.dataset.mobileDock === 'search');
        const filter = !field && candidates.find(node => node.dataset.mobileDock === 'filter');
        if (field) { search = field; anchor = document.createComment('Dock search home'); field.before(anchor); dock.append(field); }
        else if (filter) dock.append(makeFilter(filter));
        for (const target of candidates.filter(node => !['search', 'filter'].includes(node.dataset.mobileDock))) {
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
        // The dock lives on the body, outside the view that animates in, so it never rides that entrance.
        if (dock.childElementCount) document.body.append(dock);
      }
      signature = candidates;
    } else {
      const targets = candidates.filter(node => !['search', 'filter'].includes(node.dataset.mobileDock));
      [...dock.querySelectorAll('button')].forEach((proxy, i) => {
        proxy.disabled = targets[i]?.disabled;
        if (targets[i]?.hasAttribute('aria-pressed')) proxy.setAttribute('aria-pressed', targets[i].getAttribute('aria-pressed'));
      });
    }
    if (!enabled || !dock.childElementCount) dock.remove();
    applyFilter();
    container.classList.toggle('ms-has-dock', enabled && !!dock.childElementCount);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-pressed'] });
  };
  const observer = new MutationObserver(update);
  const keyboard = watchKeyboard(dock);
  phone.addEventListener('change', update); document.addEventListener('kairos:appearance', update); update();
  return () => { observer.disconnect(); restore(); clearFilter(); dock.remove(); container.classList.remove('ms-has-dock'); keyboard(); phone.removeEventListener('change', update); document.removeEventListener('kairos:appearance', update); };
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

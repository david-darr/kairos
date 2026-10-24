import { mobileOn, phone } from './mobileShared.js';
import { ICONS } from './icons.js';

const labels = { notes: 'Search notes', tasks: 'Search tasks and cards', email: 'Search mail and accounts', cookbook: 'Search models' };

// Phone-only placement preserves the original field, listeners and desktop home.
// The observer reapplies row filtering when asynchronous lists replace their rows.
export function mountPageSearch(container, tab) {
  if (!labels[tab] && tab !== 'library') return () => {};
  let field, home, pill, note, host, originalType, generated = false, queryValue = '';
  const clearRows = () => {
    for (const row of container.querySelectorAll('.ms-filtered-out')) row.classList.remove('ms-filtered-out');
  };
  const filter = () => {
    if (!generated || !host) return;
    const query = mobileOn() ? field.value.trim().toLowerCase() : '';
    const rows = [...host.querySelectorAll('[data-mobile-row]')];
    let shown = 0;
    for (const row of rows) {
      const hit = !query || row.textContent.toLowerCase().includes(query);
      row.classList.toggle('ms-filtered-out', !hit); if (hit) shown++;
    }
    note.hidden = !query || !rows.length || !!shown;
    const text = `No matches for "${field.value.trim()}"`;
    if (note.textContent !== text) note.textContent = text;
  };
  const restore = () => {
    if (generated && field) queryValue = field.value;
    if (field && !generated) { if (originalType == null) field.removeAttribute('type'); else field.setAttribute('type', originalType); }
    if (home?.isConnected && field) home.after(field);
    home?.remove(); pill?.remove(); note?.remove(); clearRows();
    field = home = pill = note = host = null; generated = false;
  };
  const update = () => {
    observer.disconnect();
    if (!mobileOn()) restore();
    else {
      const header = container.querySelector('.view-header');
      // A subview can replace its native field while retaining the page header
      // (Vault Browse <-> Map). The moved field's home tracks that ownership.
      if (header && (!pill?.isConnected || !header.parentElement.contains(pill) || (!generated && !home?.isConnected))) {
        restore(); host = header.parentElement;
        field = container.querySelector('[data-page-search]');
        generated = !field && !!labels[tab];
        if (generated) {
          field = document.createElement('input'); field.type = 'search'; field.autocomplete = 'off';
          field.value = queryValue; field.placeholder = labels[tab]; field.setAttribute('aria-label', labels[tab]);
          field.addEventListener('input', filter);
        }
        if (field) {
          if (!generated) { originalType = field.getAttribute('type'); field.type = 'search'; home = document.createComment('Page search home'); field.before(home); }
          pill = document.createElement('label'); pill.className = 'ms-page-search';
          const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = ICONS.search;
          pill.append(icon, field); header.after(pill);
          if (generated) {
            note = document.createElement('p'); note.className = 'ms-page-search-note'; note.setAttribute('role', 'status'); note.hidden = true;
            pill.after(note);
          }
        }
      }
      filter();
    }
    observer.observe(container, { childList: true, subtree: true });
  };
  const observer = new MutationObserver(update);
  phone.addEventListener('change', update); document.addEventListener('kairos:appearance', update); update();
  return () => { observer.disconnect(); restore(); phone.removeEventListener('change', update); document.removeEventListener('kairos:appearance', update); };
}

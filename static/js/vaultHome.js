import { api, el, toast } from './api.js';
import { relativeTime, naturalCompare } from './vaultStore.js';
import { icon, propertyPills, statusTone, diffView } from './vaultReader.js';

// Vault Home (Library Vault Polish, 2026-10-22): replaces the dead-end
// "Your vault" state with Today, Pinned, Recently changed, Needs attention,
// property filters and a daily-notes month strip.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function createTodaysNote(store) {
  const result = await api('/api/vault/daily', { method: 'POST', toast: false, body: '{}' });
  await store.load();
  return result;
}

// The one-line prompt after creating today's note. The line is shown as a
// diff and goes in only on a click, through the same version-checked save.
export function indexPrompt(proposal, { onDone }) {
  const add = el('button', { type: 'button', class: 'btn primary', text: 'Add line' });
  const skip = el('button', { type: 'button', class: 'btn quiet', text: 'Not now' });
  const folder = proposal.path.split('/').slice(-2, -1)[0] || proposal.path;
  const bar = el('div', { class: 'vault-index-prompt', role: 'region', 'aria-label': 'Folder index' }, [
    el('p', { text: `Add today to the ${folder} index?` }),
    diffView(`@@ ${proposal.path} @@\n${proposal.after ? ' ' + proposal.after + '\n' : ''}+${proposal.line}`),
    el('div', { class: 'vault-index-actions' }, [skip, add]),
  ]);
  skip.addEventListener('click', () => { bar.remove(); onDone?.(false); });
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api('/api/vault/note', { method: 'POST', toast: false, body: JSON.stringify({ path: proposal.path, content: proposal.content, version: proposal.version }) });
      toast('Added to the index', 'success'); bar.remove(); onDone?.(true);
    } catch (error) {
      add.disabled = false;
      toast(/^409:/.test(error.message) ? 'The index changed since; nothing was added. Open it to add the line by hand.' : error.message.replace(/^\d+: /, ''), 'error');
    }
  });
  return bar;
}

export function renderVaultHome(host, { store, admin, onOpen, onCreated }) {
  let view = { kind: 'home' };
  let monthCursor = null;
  const draw = () => {
    host.replaceChildren(view.kind === 'list' ? listView() : homeView());
  };

  function card(title, body, { className = '', count = null } = {}) {
    return el('section', { class: `vault-home-card ${className}` }, [
      el('h3', {}, [el('span', { text: title }), count != null ? el('span', { class: 'vault-rail-count', text: String(count) }) : null]),
      body,
    ]);
  }

  function noteButton(node, sub) {
    return el('button', { type: 'button', class: 'vault-home-row', title: node.id, onclick: () => onOpen(node.id) }, [
      icon('note'), el('span', { class: 'vault-home-row-copy' }, [el('strong', { text: node.name }), el('small', { text: sub ?? (node.folder || 'Vault root') })]),
    ]);
  }

  function todayCard() {
    const daily = store.daily;
    const body = el('div', { class: 'vault-today' });
    const date = new Date();
    const heading = el('div', { class: 'vault-today-date' }, [
      el('strong', { text: date.toLocaleDateString(undefined, { weekday: 'long' }) }),
      el('span', { text: date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) }),
    ]);
    body.append(heading);
    if (daily?.exists && store.note(daily.path)) {
      body.append(el('button', { type: 'button', class: 'btn primary', text: "Open today's note", onclick: () => onOpen(daily.path) }));
    } else if (daily?.can_create && daily.template_exists) {
      const create = el('button', { type: 'button', class: 'btn primary vault-create-today', text: "Create today's note" });
      create.addEventListener('click', async () => {
        create.disabled = true;
        try { onCreated(await createTodaysNote(store)); }
        catch (error) { create.disabled = false; toast(error.message.replace(/^\d+: /, ''), 'error'); }
      });
      body.append(create, el('small', { class: 'meta', text: `From ${daily.template.split('/').pop()}, into ${daily.folder}` }));
    } else if (daily && !daily.template_exists) {
      body.append(el('small', { class: 'meta', text: `No daily note template at ${daily.template}.` }));
    } else {
      body.append(el('small', { class: 'meta', text: 'No note for today yet.' }));
    }
    return card('Today', body, { className: 'vault-home-today' });
  }

  function monthStrip() {
    const dated = new Map(store.dailies.map(n => [n.name, n]));
    const latest = store.dailies.map(n => n.name).sort().pop();
    const now = new Date();
    if (!monthCursor) monthCursor = { year: now.getFullYear(), month: now.getMonth() };
    const { year, month } = monthCursor;
    const days = new Date(year, month + 1, 0).getDate();
    const grid = el('div', { class: 'vault-month-grid', role: 'group', 'aria-label': `${MONTHS[month]} ${year} daily notes` });
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    for (const d of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) grid.append(el('span', { class: 'vault-month-dow', 'aria-hidden': 'true', text: d }));
    for (let i = 0; i < offset; i++) grid.append(el('span', { class: 'vault-month-blank', 'aria-hidden': 'true' }));
    let count = 0;
    for (let day = 1; day <= days; day++) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const note = dated.get(key);
      const isToday = year === now.getFullYear() && month === now.getMonth() && day === now.getDate();
      if (note) count++;
      grid.append(el('button', { type: 'button', class: 'vault-month-day' + (note ? ' has-note' : '') + (isToday ? ' today' : ''),
        disabled: !note, 'aria-label': `${MONTHS[month]} ${day}${note ? ', open note' : ', no note'}`, title: note ? note.id : '',
        onclick: () => note && onOpen(note.id) }, [el('span', { text: String(day) }), el('i', { 'aria-hidden': 'true' })]));
    }
    const step = delta => { const d = new Date(year, month + delta, 1); monthCursor = { year: d.getFullYear(), month: d.getMonth() }; draw(); };
    const nav = el('div', { class: 'vault-month-nav' }, [
      el('button', { type: 'button', class: 'btn quiet', 'aria-label': 'Previous month', text: '‹', onclick: () => step(-1) }),
      el('strong', { text: `${MONTHS[month]} ${year}` }),
      el('button', { type: 'button', class: 'btn quiet', 'aria-label': 'Next month', text: '›', onclick: () => step(1) }),
    ]);
    const foot = el('small', { class: 'meta', text: count ? `${count} daily note${count === 1 ? '' : 's'} this month` : latest ? `Latest daily note: ${latest}` : 'No daily notes yet.' });
    return card('Daily notes', el('div', {}, [nav, grid, foot]), { className: 'vault-home-month' });
  }

  function pinnedCard() {
    const pins = store.pins.map(id => store.note(id)).filter(Boolean);
    const body = el('div', { class: 'vault-home-list' });
    if (!pins.length) body.append(el('p', { class: 'vault-rail-empty', text: 'Pin a note from its header to keep it here, on every device.' }));
    for (const node of pins) body.append(noteButton(node));
    return card('Pinned', body, { count: pins.length || null });
  }

  function recentCard() {
    const body = el('div', { class: 'vault-home-list' }, [el('p', { class: 'vault-rail-empty', text: 'Loading...' })]);
    const fill = items => body.replaceChildren(...items.slice(0, 8).map(item => {
      const node = store.note(item.path);
      return node ? noteButton(node, `${relativeTime(item.when)}${item.label ? ' · ' + (item.kairos ? item.label : 'outside Kairos') : ''}`) : null;
    }).filter(Boolean));
    if (admin) api('/api/vault/activity').then(data => { if (body.isConnected) fill(data.recent); }).catch(() => fill(byMtime()));
    else fill(byMtime());
    return card('Recently changed', body);
  }
  const byMtime = () => [...store.notes].sort((a, b) => b.mtime - a.mtime).slice(0, 8).map(n => ({ path: n.id, when: n.mtime }));

  function attentionCard() {
    const orphans = store.orphans(), lacking = store.lackingProperties();
    const body = el('div', { class: 'vault-attention' }, [
      el('button', { type: 'button', class: 'vault-attention-item', disabled: !orphans.length, onclick: () => { view = { kind: 'list', title: 'Needs a link', hint: 'No links in or out.', notes: orphans }; draw(); } }, [
        el('strong', { text: String(orphans.length) }), el('span', { text: 'Need a link' }),
      ]),
      el('button', { type: 'button', class: 'vault-attention-item', disabled: !lacking.length, onclick: () => { view = { kind: 'list', title: 'Missing properties', hint: 'No status, project or type.', notes: lacking, showMissing: true }; draw(); } }, [
        el('strong', { text: String(lacking.length) }), el('span', { text: 'Missing properties' }),
      ]),
    ]);
    return card('Needs attention', body);
  }

  function filterCard() {
    const values = { status: new Map(), project: new Map(), type: new Map() };
    for (const note of store.notes) for (const key of Object.keys(values)) {
      const value = note.frontmatter?.[key];
      if (typeof value === 'string' && value) values[key].set(value, (values[key].get(value) || 0) + 1);
    }
    const body = el('div', { class: 'vault-filters' });
    for (const [key, map] of Object.entries(values)) {
      if (!map.size) continue;
      const pills = [...map].sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0])).slice(0, 12).map(([value, n]) => el('button', {
        type: 'button', class: 'vault-pill vault-filter-pill' + (key === 'status' ? ` tone-${statusTone(value)}` : ''), title: `${key}: ${value}`,
        onclick: () => { view = { kind: 'list', title: `${key}: ${value}`, notes: store.notes.filter(note => note.frontmatter?.[key] === value) }; draw(); },
      }, [el('span', { text: value }), el('small', { text: String(n) })]));
      body.append(el('div', { class: 'vault-filter-row' }, [el('span', { class: 'vault-filter-key', text: key }), el('div', { class: 'vault-filter-pills' }, pills)]));
    }
    if (!body.childElementCount) body.append(el('p', { class: 'vault-rail-empty', text: 'No notes have status, project or type properties yet.' }));
    return card('Browse by property', body, { className: 'vault-home-filters' });
  }

  function homeView() {
    const notes = store.notes.length, folders = store.graph.nodes.filter(n => n.type === 'folder').length - 1;
    return el('div', { class: 'vault-home' }, [
      el('div', { class: 'vault-home-head' }, [
        el('h2', { class: 'vault-home-title', text: 'Vault' }),
        el('p', { class: 'meta', text: `${notes} notes · ${folders} folders · ${store.graph.edges.filter(e => e.kind === 'link').length} links` }),
      ]),
      el('div', { class: 'vault-home-grid' }, [todayCard(), pinnedCard(), monthStrip(), recentCard(), attentionCard(), filterCard()]),
    ]);
  }

  function listView() {
    const notes = [...view.notes].sort((a, b) => naturalCompare(a.name, b.name));
    const back = el('button', { type: 'button', class: 'btn quiet vault-list-back', text: '‹ Home', onclick: () => { view = { kind: 'home' }; draw(); } });
    return el('div', { class: 'vault-home vault-home-filtered' }, [
      el('div', { class: 'vault-home-head' }, [back, el('h2', { class: 'vault-home-title', text: view.title }),
        el('p', { class: 'meta', text: `${notes.length} note${notes.length === 1 ? '' : 's'}${view.hint ? ' · ' + view.hint : ''}` })]),
      el('div', { class: 'vault-home-list vault-home-list-wide' }, notes.map(node => {
        const row = noteButton(node);
        if (view.showMissing) row.querySelector('.vault-home-row-copy').append(propertyPills(node));
        return row;
      })),
    ]);
  }

  draw();
  return { redraw: draw, home() { view = { kind: 'home' }; draw(); } };
}

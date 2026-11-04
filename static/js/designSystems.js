// Tool Store > Design systems (vault: Design Canvas (Build Spec), 3d, phase 3).
// The built-in Kairos system, the bundled looks (vault: Creative Output Quality
// and Video Studio (Build Spec), Phase 1), and systems an admin makes from a
// palette and fonts, pasted CSS variables, or a Forge project's stylesheets
// (read only). A design switches look in one click from its Tokens panel.
import { api, el, toast, confirmDialog } from './api.js';

const ROLES = ['bg', 'surface', 'text', 'text-dim', 'accent', 'accent-text', 'danger', 'success'];

function swatches(variables) {
  return el('span', { class: 'design-swatches', 'aria-hidden': 'true' }, ROLES.filter(r => variables[`--ds-${r}`]).map(r => {
    const dot = el('span', { class: 'design-swatch', title: r });
    dot.style.background = variables[`--ds-${r}`];
    return dot;
  }));
}

// Fit the whole preview board when the card's width changes.
const lookPreviewObserver = new ResizeObserver(entries => {
  for (const { target: box, contentRect: { width } } of entries) {
    if (width > 0) box.style.setProperty('--look-scale', String(width / 1200));
  }
});

// A look's preview board, drawn by the backend in the look's own fonts and tokens. The frame runs no
// script (empty sandbox; the route's policy allows none) and is scaled down from 1200x800. A person's
// style or draft is private, so its preview carries the token the authenticated read handed out.
function lookPreview(system, token = system.preview_token) {
  const query = token ? `?rt=${encodeURIComponent(token)}` : '';
  const frame = el('iframe', { class: 'design-look-frame', src: `/api/design-looks/${encodeURIComponent(system.id)}/preview${query}`,
    sandbox: '', loading: 'lazy', scrolling: 'no', tabindex: '-1', title: `${system.name || 'Style'} preview`, 'aria-hidden': 'true' });
  const box = el('div', { class: 'design-look-preview' }, [frame]);
  lookPreviewObserver.observe(box);
  return box;
}

function fontsText(look) {
  return look.fonts ? Object.values(look.fonts).filter((v, i, all) => all.indexOf(v) === i).join(' + ') : 'Cormorant Garamond + Jost';
}

function lookCard(system, { admin, isDefault, host }) {
  const look = system.look || {};
  const mood = (look.mood || (system.builtin ? ['warm', 'calm', 'precise'] : [])).join(', ');
  const label = isDefault ? 'Default' : system.builtin ? 'Kairos brand' : system.style
    ? (system.shared ? 'Shared with everyone' : system.mine ? 'Yours · private' : `${system.owner}'s · private`) : 'Look';
  const actions = [];
  if (admin) actions.push(el('button', { type: 'button', class: 'btn quiet', 'aria-pressed': String(isDefault),
    text: isDefault ? 'Stop using as default' : 'Use as default', onclick: async () => {
      try {
        await api('/api/design-systems/default/look', { method: 'POST', body: JSON.stringify({ id: isDefault ? null : system.id }) });
        toast(isDefault ? 'New designs pick their own look again' : `New designs start in ${system.name}`, 'success');
        renderDesignSystems(host, { admin });
      } catch { /* api() shows the error */ }
    } }));
  if (system.style && admin) actions.push(el('button', { type: 'button', class: 'btn quiet', 'aria-pressed': String(!!system.shared),
    text: system.shared ? 'Stop sharing' : 'Share with everyone', onclick: async () => {
      try {
        await api(`/api/design-systems/${encodeURIComponent(system.id)}/share`, { method: 'POST', body: JSON.stringify({ shared: !system.shared }) });
        toast(system.shared ? `${system.name} is private again` : `Everyone can use ${system.name}`, 'success');
        renderDesignSystems(host, { admin });
      } catch { /* api() shows the error */ }
    } }));
  if (system.style && (system.mine || admin)) actions.push(el('button', { type: 'button', class: 'btn quiet', text: 'Remove', onclick: async () => {
    if (!await confirmDialog({ title: `Remove ${system.name}?`, message: 'Designs using it fall back to Kairos.', confirmLabel: 'Remove' })) return;
    await api(`/api/design-systems/${encodeURIComponent(system.id)}`, { method: 'DELETE' }).catch(() => null);
    renderDesignSystems(host, { admin });
  } }));
  return el('article', { class: `tool-store-card design-system-card design-look-card${isDefault ? ' is-default' : ''}` }, [el('div', { class: 'design-card-body' }, [
    lookPreview(system),
    el('header', {}, [el('strong', { text: system.name }), el('span', { class: 'meta', text: label })]),
    el('p', { class: 'meta', text: `${mood} · ${fontsText(look)}` }),
    actions.length ? el('div', { class: 'design-card-actions' }, actions) : el('span'),
  ])]);
}

// Tool Store > New style from references (Creative Output Quality spec, Phase 1b): files are read on
// the server into a draft (values only; the files are not kept), shown here to change, then saved.
const STYLE_ROLES = ['bg', 'surface', 'text', 'text-dim', 'accent', 'on-accent', 'accent-2'];
const ROLE_LABELS = { bg: 'Background', surface: 'Cards', text: 'Text', 'text-dim': 'Quiet text', accent: 'Accent',
  'on-accent': 'Text on accent', 'accent-2': 'Second accent' };

function styleForm(host, { admin }) {
  const files = el('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,.pdf,.pptx,.docx',
    'aria-label': 'Reference files' });
  const name = el('input', { type: 'text', maxlength: '60', placeholder: 'Bakery menus', 'aria-label': 'Style name' });
  const notes = el('input', { type: 'text', maxlength: '300', placeholder: 'warm, for our menus and flyers', 'aria-label': 'What it is for' });
  const status = el('p', { class: 'meta', role: 'status' });
  const editor = el('div', { class: 'design-style-draft', hidden: true });
  const make = el('button', { type: 'button', class: 'btn primary', text: 'Make a draft', onclick: async () => {
    if (!files.files.length) { files.focus(); toast('Add a photo, screenshot, PDF, PowerPoint or Word file', 'error'); return; }
    const form = new FormData();
    [...files.files].slice(0, 8).forEach(file => form.append('files', file));
    form.append('name', name.value.trim()); form.append('notes', notes.value.trim());
    make.disabled = true; status.textContent = 'Reading the references...';
    try { showDraft(await api('/api/design-systems/drafts', { method: 'POST', headers: {}, body: form })); status.textContent = ''; }
    catch { status.textContent = ''; }
    finally { make.disabled = false; }
  } });

  function showDraft(record) {
    const look = record.look;
    const colors = Object.fromEntries(STYLE_ROLES.map(role => [role, el('input', { type: 'color', value: look.color[role].toLowerCase(),
      'aria-label': `${ROLE_LABELS[role]} colour` })]));
    const fontSelect = role => el('select', { 'aria-label': `${role === 'display' ? 'Headline' : 'Body'} font` },
      record.font_options.map(f => el('option', { value: f.id, text: f.name, selected: f.id === look.fonts[role] })));
    const display = fontSelect('display'), body = fontSelect('body');
    const button = el('select', { 'aria-label': 'Button style' }, ['pill', 'soft', 'square', 'underline'].map(b =>
      el('option', { value: b, text: b[0].toUpperCase() + b.slice(1), selected: b === look.shape.button })));
    const update = async (save = false) => {
      const changes = { colors: Object.fromEntries(STYLE_ROLES.filter(r => colors[r].value.toUpperCase() !== look.color[r]).map(r => [r, colors[r].value.toUpperCase()])),
        fonts: { display: display.value, body: body.value }, shape: { button: button.value }, name: name.value.trim() || undefined };
      try {
        let next = await api(`/api/design-systems/drafts/${record.id}`, { method: 'POST', body: JSON.stringify(changes) });
        if (!save) { showDraft(next); return; }
        const saved = await api(`/api/design-systems/drafts/${next.id}/save`, { method: 'POST', body: '{}' });
        toast(`Saved ${saved.name}: yours until an admin shares it`, 'success');
        renderDesignSystems(host, { admin });
      } catch { /* api() shows the error */ }
    };
    editor.hidden = false;
    editor.replaceChildren(
      lookPreview({ id: record.id, name: look.name }, record.preview_token),
      el('p', { class: 'meta', text: `From ${record.sources.join(', ')}.${record.skipped?.length ? ' Skipped: ' + record.skipped.join('; ') + '.' : ''}` }),
      record.changes?.length ? el('ul', { class: 'design-style-changes meta' }, record.changes.map(c => el('li', { text: c }))) : el('span'),
      el('div', { class: 'design-system-colors' }, STYLE_ROLES.map(role => el('label', { class: 'design-field' }, [el('span', { text: ROLE_LABELS[role] }), colors[role]]))),
      el('div', { class: 'design-style-fonts' }, [el('label', { class: 'design-field' }, [el('span', { text: 'Headline font' }), display]),
        el('label', { class: 'design-field' }, [el('span', { text: 'Body font' }), body]),
        el('label', { class: 'design-field' }, [el('span', { text: 'Buttons' }), button])]),
      el('p', { class: 'meta', text: 'Fonts are the bundled ones, so any design stays safe to share. Text colours are adjusted if they would be hard to read.' }),
      el('div', { class: 'design-card-actions' }, [
        el('button', { type: 'button', class: 'btn quiet', text: 'Update preview', onclick: () => update(false) }),
        el('button', { type: 'button', class: 'btn primary', text: 'Save style', onclick: () => update(true) })]));
  }

  return el('section', { class: 'design-system-new design-style-new' }, [
    el('h3', { class: 'tool-store-heading', text: 'New style from references' }),
    el('p', { class: 'meta', text: 'Photos, screenshots, a PDF, PowerPoint or Word file (up to 8). Kairos reads their colours and fonts on this computer; the files are not kept.' }),
    el('label', { class: 'design-field' }, [el('span', { text: 'References' }), files]),
    el('label', { class: 'design-field' }, [el('span', { text: 'Name' }), name]),
    el('label', { class: 'design-field' }, [el('span', { text: 'What it is for (optional)' }), notes]),
    make, status, editor]);
}

export async function renderDesignSystems(host, { admin = false } = {}) {
  host.replaceChildren(el('p', { class: 'meta', role: 'status', text: 'Loading design systems...' }));
  let systems = [];
  let chosen = null;
  try { systems = await api('/api/design-systems'); } catch { host.replaceChildren(el('p', { class: 'meta', text: 'Design systems could not load.' })); return; }
  try { chosen = (await api('/api/design-systems/default/look')).id; } catch { chosen = null; }
  const looks = systems.filter(s => s.builtin || s.bundled);
  const styles = systems.filter(s => s.style);
  const saved = systems.filter(s => !s.builtin && !s.bundled && !s.style);
  const details = await Promise.all(systems.map(s => api(`/api/design-systems/${s.id}`).catch(() => null)));
  const byId = Object.fromEntries(details.filter(Boolean).map(s => [s.id, s]));
  const lookGrid = el('div', { class: 'tool-store-grid design-system-grid design-look-grid' }, looks.map(s => byId[s.id]).filter(Boolean)
    .map(system => lookCard(system, { admin, isDefault: chosen === system.id, host })));
  const savedGrid = el('div', { class: 'tool-store-grid design-system-grid' }, saved.map(s => byId[s.id]).filter(Boolean).map(system => el('article', { class: 'tool-store-card design-system-card' }, [el('div', { class: 'design-card-body' }, [
    el('header', {}, [el('strong', { text: system.name }), el('span', { class: 'meta', text: chosen === system.id ? 'Default' : system.source || 'Saved' })]),
    swatches(system.variables || {}),
    el('p', { class: 'meta', text: (system.guide || '').split('\n').find(line => line && !line.startsWith('#')) || 'A design system for the Design canvas.' }),
    admin ? el('button', { type: 'button', class: 'btn quiet', text: 'Remove', onclick: async () => {
      if (!await confirmDialog({ title: `Remove ${system.name}?`, message: 'Designs using it fall back to Kairos.', confirmLabel: 'Remove' })) return;
      await api(`/api/design-systems/${system.id}`, { method: 'DELETE' }).catch(() => null);
      renderDesignSystems(host, { admin });
    } }) : el('span'),
  ])])));
  host.replaceChildren(el('h3', { class: 'tool-store-heading', text: `Looks · ${looks.length}` }),
    el('p', { class: 'meta', text: chosen ? 'New designs start in your default look.' : 'Kairos suggests a look for each brief; a design switches look in one click from its Tokens panel.' }),
    lookGrid);
  if (styles.length) host.append(el('h3', { class: 'tool-store-heading', text: `Styles · ${styles.length}` }),
    el('div', { class: 'tool-store-grid design-system-grid design-look-grid' }, styles.map(s => byId[s.id]).filter(Boolean)
      .map(system => lookCard(system, { admin, isDefault: chosen === system.id, host }))));
  if (saved.length) host.append(el('h3', { class: 'tool-store-heading', text: `Saved systems · ${saved.length}` }), savedGrid);
  host.append(styleForm(host, { admin }));
  if (admin) host.append(newSystemForm(host, byId.kairos?.variables || {}));
}

function newSystemForm(host, base) {
  const name = el('input', { type: 'text', maxlength: '60', placeholder: 'Acme', 'aria-label': 'System name' });
  const colors = Object.fromEntries(ROLES.map(role => {
    const input = el('input', { type: 'color', 'aria-label': `${role} colour` });
    // Starts from the Kairos system's value for the same role.
    if (/^#[0-9a-f]{6}$/i.test(base[`--ds-${role}`] || '')) input.value = base[`--ds-${role}`].toLowerCase();
    return [role, input];
  }));
  const sans = el('input', { type: 'text', placeholder: 'Inter, system-ui, sans-serif', 'aria-label': 'Sans font' });
  const serif = el('input', { type: 'text', placeholder: 'Georgia, serif', 'aria-label': 'Serif font' });
  const guide = el('textarea', { rows: '3', maxlength: '4000', placeholder: 'A few lines: intent, do and don\'t', 'aria-label': 'Guide' });
  const css = el('textarea', { rows: '4', maxlength: '400000', placeholder: ':root { --primary: ...; --background: ...; }', 'aria-label': 'CSS variables' });
  const project = el('select', { 'aria-label': 'Forge project' }, [el('option', { value: '', text: 'Choose a Forge project' })]);
  api('/api/forge/projects').then(list => list.forEach(p => project.append(el('option', { value: p.id, text: p.name })))).catch(() => { project.disabled = true; });
  const modes = el('div', { class: 'segmented-tabs', role: 'group', 'aria-label': 'Make it from' });
  const panes = {
    palette: el('div', { class: 'design-system-pane' }, [
      el('div', { class: 'design-system-colors' }, ROLES.map(role => el('label', { class: 'design-field' }, [el('span', { text: role }), colors[role]]))),
      el('label', { class: 'design-field' }, [el('span', { text: 'Sans font' }), sans]),
      el('label', { class: 'design-field' }, [el('span', { text: 'Serif font' }), serif]),
      el('label', { class: 'design-field' }, [el('span', { text: 'Guide' }), guide])]),
    css: el('div', { class: 'design-system-pane', hidden: true }, [el('label', { class: 'design-field' }, [el('span', { text: 'Paste CSS custom properties' }), css])]),
    forge: el('div', { class: 'design-system-pane', hidden: true }, [el('label', { class: 'design-field' }, [el('span', { text: 'Read the CSS variables and Tailwind colours of' }), project]),
      el('p', { class: 'meta', text: 'Read only: nothing in the project changes.' })]),
  };
  let mode = 'palette';
  for (const [id, label] of [['palette', 'Palette and fonts'], ['css', 'Paste CSS'], ['forge', 'Forge project']]) {
    const b = el('button', { type: 'button', class: `segmented-tab${id === mode ? ' active' : ''}`, text: label, 'aria-pressed': String(id === mode), onclick: () => {
      mode = id; for (const node of modes.children) { const on = node === b; node.classList.toggle('active', on); node.setAttribute('aria-pressed', String(on)); }
      for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== id;
    } });
    modes.append(b);
  }
  const save = el('button', { type: 'button', class: 'btn primary', text: 'Save design system', onclick: async () => {
    if (!name.value.trim()) { name.focus(); toast('Name the system first', 'error'); return; }
    const body = { name: name.value.trim() };
    if (mode === 'palette') Object.assign(body, { colors: Object.fromEntries(ROLES.map(r => [r, colors[r].value])), fonts: { ...(sans.value.trim() ? { sans: sans.value.trim() } : {}), ...(serif.value.trim() ? { serif: serif.value.trim() } : {}) }, guide: guide.value });
    else if (mode === 'css') body.css = css.value;
    else body.forge_project_id = project.value;
    save.disabled = true;
    try { const system = await api('/api/design-systems', { method: 'POST', body: JSON.stringify(body) }); toast(`Saved ${system.name}`, 'success'); renderDesignSystems(host, { admin: true }); }
    catch { save.disabled = false; }
  } });
  return el('section', { class: 'design-system-new' }, [el('h3', { class: 'tool-store-heading', text: 'New design system' }),
    el('label', { class: 'design-field' }, [el('span', { text: 'Name' }), name]), modes, panes.palette, panes.css, panes.forge, save]);
}

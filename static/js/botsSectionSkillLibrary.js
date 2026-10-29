// The shared skill library page (Phase 2, unit U3). Phase 1 mounts it as the "Skill library" resource page.
// mount(host, ctx) -> {destroy, refresh, flush}. ctx.agentId is optional: when a bot is open, each row also has
// a switch to give the skill to that bot. Search and tags filter the list, "Every bot" gives a skill to all bots,
// and chips show who has it. A library skill reaches a bot only when it is switched on after a full-text review.
// Imported text is shown as plain text only. Shared skills, imports and migrated Tool Store skills all land here.
import { api, el, confirmDialog } from './api.js';
import { Card, SwitchRow, TextRow, Button, PageHeader, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { skillReviewPanel, SKILLS_CSS } from './botsSkillRequest.js';
import {
  STATE_LABEL, assignmentChips, filterLibrary, givenToBot, importSummary, isStale, libraryTags, messageOf, nextAssignment,
  originLabel, reviewState, sourceLine,
} from './botsSkillsModel.js';

export function mount(host, ctx = {}) {
  loadBotsCss(SKILLS_CSS);
  const agentId = ctx.agentId || '';
  const root = el('div', { class: 'bots-skills bots-skill-library', 'data-section': 'skill-library' });
  host.append(root);

  let destroyed = false, loading = true, loadError = '', skills = [], assignments = { revision: 0 }, pendingShares = [], names = {};
  let generation = 0, busy = '', formError = '', notice = '', open = '', detail = null, detailError = '', detailStale = false, outcome = null;
  const filter = { query: '', tag: '' };
  const draft = { source: '', pasted: '' };

  async function load() {
    const mine = ++generation;
    loading = !skills.length; loadError = '';
    if (loading) draw();
    try {
      const [library, bots] = await Promise.all([
        api('/api/bots/skills-library', { toast: false }),
        api('/api/agents', { toast: false }).catch(() => []),
      ]);
      if (destroyed || mine !== generation) return;
      skills = library.skills || []; assignments = library.assignments || { revision: 0 }; pendingShares = library.pending_shares || [];
      names = Object.fromEntries((Array.isArray(bots) ? bots : bots.agents || []).map(b => [b.id, b.name]));
    } catch (error) {
      if (destroyed || mine !== generation) return;
      loadError = messageOf(error);
    }
    loading = false;
    draw();
  }

  async function mutate(label, call) {
    if (busy || destroyed) return false;
    busy = label; formError = ''; notice = '';
    draw();
    try {
      await ctx.flush?.();
      await call();
      return true;
    } catch (error) {
      if (destroyed) return false;
      detailStale = isStale(error);
      formError = detailStale ? 'This changed since you opened it. Reload and review the current text.' : messageOf(error);
      return false;
    } finally {
      busy = '';
      if (!destroyed) draw();
    }
  }
  const reload = async () => {
    const library = await api('/api/bots/skills-library', { toast: false });
    skills = library.skills || []; assignments = library.assignments || assignments; pendingShares = library.pending_shares || [];
  };
  const patch = (skill, body) => api(`/api/bots/skills-library/${encodeURIComponent(skill.name)}`, { method: 'PATCH', body: JSON.stringify({ expected_revision: skill.storage_revision, ...body }), toast: false });

  async function openSkill(skill) {
    if (open === skill.name) { open = ''; draw(); return; }
    open = skill.name; detail = null; detailError = ''; detailStale = false; formError = '';
    draw();
    await loadDetail(skill.name);
  }
  async function loadDetail(name) {
    try {
      const value = await api(`/api/bots/skills-library/${encodeURIComponent(name)}`, { toast: false });
      if (!destroyed && open === name) { detail = value; detailStale = false; formError = ''; }
    } catch (error) { if (!destroyed && open === name) detailError = messageOf(error); }
    if (!destroyed) draw();
  }

  const enable = () => mutate('enable', async () => {
    await patch(detail, { enabled: true, reviewed_sha256: detail.sha256 });
    notice = `/${detail.name} is on in the library.`; open = ''; detail = null;
    await reload();
  });
  const disable = skill => mutate('disable', async () => { await patch(skill, { enabled: false }); await reload(); });
  const setEvery = (skill, on) => mutate('every', async () => { await patch(skill, { every_bot: on }); await reload(); });
  const give = (skill, on) => mutate('give', async () => {
    await api(`/api/bots/${encodeURIComponent(agentId)}/skills-library`, { method: 'PUT', toast: false,
      body: JSON.stringify({ skills: nextAssignment(skills, agentId, skill.name, on), expected_revision: assignments.revision }) });
    await reload();
  });
  async function retire(skill) {
    if (!await confirmDialog({ title: `Remove /${skill.name} from the library?`, message: 'No bot can use it afterwards. Earlier versions stay saved.', confirmLabel: 'Remove' })) return;
    await mutate('retire', async () => {
      await api(`/api/bots/skills-library/${encodeURIComponent(skill.name)}?expected_revision=${encodeURIComponent(skill.storage_revision)}`, { method: 'DELETE', toast: false });
      if (open === skill.name) { open = ''; detail = null; }
      await reload();
    });
  }
  const importSource = () => !draft.source.trim() ? (formError = 'Enter a link first.', draw()) : mutate('import', async () => {
    outcome = await api('/api/bots/skills-library', { method: 'POST', toast: false, body: JSON.stringify({ source: draft.source.trim() }) });
    draft.source = ''; await reload();
  });
  const importPasted = () => !draft.pasted.trim() ? (formError = 'Paste a SKILL.md first.', draw()) : mutate('paste', async () => {
    outcome = await api('/api/bots/skills-library', { method: 'POST', toast: false, body: JSON.stringify({ content: draft.pasted }) });
    if (outcome.results?.every(r => r.status === 'imported')) draft.pasted = '';
    await reload();
  });
  const answerShare = (id, action) => mutate('share', async () => {
    await api(`/api/bots/shares/${encodeURIComponent(id)}/${action}`, { method: 'POST', toast: false });
    await reload();
  });

  const status = (text, kind = '') => el('div', { class: `bots-skill-status ${kind}`.trim(), role: kind === 'error' ? 'alert' : 'status', text });

  function row(skill) {
    const state = reviewState(skill);
    const isOpen = open === skill.name;
    const meta = [originLabel(skill), skill.description, ...(skill.tags || []).map(t => '#' + t)].filter(Boolean).join(' · ');
    const chips = assignmentChips(skill, names);
    const item = el('div', { class: 'bots-skill-item', 'data-skill': skill.name, 'data-state': state }, [
      el('div', { class: 'bots-row bots-skill-row' }, [
        el('button', { type: 'button', class: 'bots-skill-main', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => openSkill(skill) }, [
          el('span', { class: 'bots-row-title', text: '/' + skill.name }),
          el('span', { class: 'bots-row-hint', text: meta }),
        ]),
        skill.warnings?.length ? el('span', { class: 'bots-skill-chip warn', text: 'Warning' }) : null,
        el('span', { class: `bots-skill-chip ${state}`, text: STATE_LABEL[state] }),
        el('button', { type: 'button', role: 'switch', class: 'bots-switch', 'aria-checked': state === 'on' ? 'true' : 'false', disabled: !!busy,
          'aria-label': `${state === 'on' ? 'Turn off' : 'Review and turn on'} /${skill.name}`,
          onclick: () => { if (state === 'on') disable(skill); else if (open !== skill.name) openSkill(skill); } }),
      ]),
      chips.length ? el('div', { class: 'bots-skill-chips' }, chips.map(c => el('span', { class: 'bots-skill-chip assign', 'data-chip': c.id, text: c.label }))) : null,
    ]);
    if (state === 'on') {
      item.append(el('div', { class: 'bots-skill-assign' }, [
        SwitchRow({ title: 'Every bot', hint: 'Give this skill to all bots, including new ones.', checked: skill.every_bot, disabled: !!busy, onChange: on => setEvery(skill, on) }),
        agentId ? SwitchRow({ title: 'This bot', hint: skill.every_bot ? 'Already given through Every bot.' : 'Give this skill to the open bot.', checked: givenToBot(skill, agentId),
          disabled: !!busy || skill.every_bot, onChange: on => give(skill, on) }) : null,
      ]));
    }
    if (isOpen) item.append(inspector(skill, state));
    return item;
  }

  function inspector(skill, state) {
    const box = el('div', { class: 'bots-skill-inspect' });
    if (detailError) { box.append(status(detailError, 'error'), Button({ label: 'Try again', onClick: () => loadDetail(skill.name) })); return box; }
    if (!detail) { box.append(status('Loading the full text...')); return box; }
    const line = sourceLine(detail);
    if (line) box.append(el('div', { class: 'bots-row-hint', text: 'Source: ' + line }));
    box.append(skillReviewPanel({ skill: detail }));
    if (detail.revisions?.length > 1) box.append(el('div', { class: 'bots-row-hint', text: `${detail.revisions.length} saved versions` }));
    if (detail.changed_after_review) box.append(status('The saved files no longer match what was reviewed. Remove this skill and add it again.', 'error'));
    if (formError) box.append(status(formError, 'error'));
    const actions = el('div', { class: 'bots-skill-card-actions' });
    if (state !== 'on' && !detail.changed_after_review) actions.append(Button({ label: 'Enable reviewed skill', variant: 'primary', disabled: !!busy || detailStale, onClick: enable }));
    if (detailStale) actions.append(Button({ label: 'Reload', onClick: () => loadDetail(skill.name) }));
    actions.append(Button({ label: 'Remove', variant: 'danger', iconName: 'trash-2', disabled: !!busy, onClick: () => retire(detail) }));
    box.append(actions);
    return box;
  }

  function draw() {
    if (destroyed) return;
    if (loading) { root.replaceChildren(status('Loading the library...')); return; }
    if (loadError) { root.replaceChildren(status(loadError, 'error'), Button({ label: 'Retry', iconName: 'refresh-cw', onClick: load })); return; }
    const shown = filterLibrary(skills, filter);
    const tags = libraryTags(skills);
    const search = el('input', { type: 'search', class: 'bots-skill-search', placeholder: 'Search skills', 'aria-label': 'Search skills', value: filter.query });
    search.value = filter.query;
    search.addEventListener('input', () => { filter.query = search.value; drawList(); });
    const list = el('div', { class: 'bots-skill-list' });
    function drawList() {
      const rows = filterLibrary(skills, filter);
      list.replaceChildren(...(rows.length ? rows.map(row) : [el('div', { class: 'bots-skill-empty' }, [icon('wrench', { size: 18 }), el('div', {}, [
        el('div', { class: 'bots-row-title', text: skills.length ? 'No skills match' : 'The library is empty' }),
        el('div', { class: 'bots-row-hint', text: skills.length ? 'Try another search or tag.' : 'Import a skill below, or share one from a bot.' })])])]));
    }
    drawList();
    const parts = [PageHeader({ title: 'Skill library', intro: 'Skills any bot can be given. Each one is read in full before it is switched on.' })];
    if (notice) parts.push(status(notice));
    if (formError && !open) parts.push(status(formError, 'error'));
    if (pendingShares.length) {
      parts.push(Card({ label: 'Waiting for you', children: pendingShares.map(share => el('div', { class: 'bots-row bots-skill-row', 'data-share': share.id }, [
        el('span', { class: 'bots-row-main' }, [el('span', { class: 'bots-row-title', text: `Share /${share.name}?` }),
          el('span', { class: 'bots-row-hint', text: `${names[share.bot_id] || 'A bot'} wants to add it to the library.` })]),
        Button({ label: 'Share', variant: 'primary', disabled: !!busy, onClick: () => answerShare(share.id, 'approve') }),
        Button({ label: 'Not now', disabled: !!busy, onClick: () => answerShare(share.id, 'deny') }),
      ])) }));
    }
    parts.push(el('div', { class: 'bots-skill-filter' }, [search, ...(tags.length ? [el('div', { class: 'bots-skill-tags', role: 'group', 'aria-label': 'Filter by tag' }, tags.map(tag => el('button', {
      type: 'button', class: 'bots-skill-chip tag', 'aria-pressed': filter.tag === tag ? 'true' : 'false', text: tag,
      onclick: () => { filter.tag = filter.tag === tag ? '' : tag; draw(); } })))] : [])]));
    parts.push(Card({ label: shown.length === skills.length ? `Library (${skills.length})` : `Library (${shown.length} of ${skills.length})`, children: [list] }));
    const source = TextRow({ title: 'Import from a link', hint: 'A GitHub link, owner/repo, or a skills.sh link. Imports stay off until you review them.', value: draft.source, placeholder: 'owner/repo' });
    source.field.addEventListener('input', () => { draft.source = source.field.value; });
    source.field.addEventListener('keydown', event => { if (event.key === 'Enter' && draft.source.trim()) { event.preventDefault(); importSource(); } });
    const pasted = TextRow({ title: 'Paste a SKILL.md', hint: 'The whole file, with its name and description at the top.', value: draft.pasted, multiline: true });
    pasted.field.addEventListener('input', () => { draft.pasted = pasted.field.value; });
    parts.push(Card({ label: 'Add to the library', children: [source,
      el('div', { class: 'bots-skill-actions' }, [Button({ label: 'Import', iconName: 'upload', disabled: !!busy, onClick: importSource })]),
      pasted, el('div', { class: 'bots-skill-actions' }, [Button({ label: 'Add pasted skill', disabled: !!busy, onClick: importPasted })]),
      outcome ? el('div', { class: 'bots-skill-outcome' }, [status(importSummary(outcome.results)),
        ...outcome.results.filter(r => r.status !== 'imported').map(r => el('div', { class: 'bots-row-hint', text: `${r.name}: ${r.reason || r.status}` }))]) : null] }));
    root.replaceChildren(...parts);
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
  }

  load();
  return {
    destroy() { destroyed = true; generation++; root.remove(); },
    refresh: () => load(),
    flush: () => Promise.resolve(true),
  };
}

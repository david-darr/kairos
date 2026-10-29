// A bot's Skills section (Phase 2, unit U3). Phase 1 imports `mount` into its Skills section and the Simple
// Settings page. Contract (phase-2-design.md section 6): mount(host, ctx) -> {destroy, refresh, flush}, safe to
// destroy while requests are pending. ctx: agentId, state.agent, advanced, flush(), refresh(), go(section).
//
// What it shows: learned-skill cards waiting for review, the bot's own skills (origin, source, warnings, a switch,
// full-text review before anything is switched on, remove), skills given from the library, and the ways to add one:
// import from a link, paste a SKILL.md (Advanced), write a command. Advanced also shows background review and sharing.
// Imported text is shown as plain text only. The server decides what is allowed; this never trusts its own checks.
import { api, el, confirmDialog } from './api.js';
import { Card, Segmented, SwitchRow, TextRow, Button, isAdvanced, onBotsInterface, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { mountSkillRequestCard, skillReviewPanel, SKILLS_CSS } from './botsSkillRequest.js';
import {
  STATE_LABEL, counts, disableBody, enableBody, importSummary, isStale, mergeCard, messageOf, originLabel, pendingCards,
  reviewState, sortSkills, sourceLine, switchIntent, validateWritten,
} from './botsSkillsModel.js';

const advancedNow = ctx => (typeof ctx.advanced === 'function' ? ctx.advanced() : ctx.advanced ?? isAdvanced());

export function mount(host, ctx) {
  loadBotsCss(SKILLS_CSS);
  const agentId = ctx.agentId;
  const base = `/api/bots/${encodeURIComponent(agentId)}`;
  const root = el('div', { class: 'bots-skills', 'data-section': 'skills' });
  host.append(root);

  let destroyed = false, loading = true, loadError = '', data = null, generation = 0;
  let open = '', detail = null, detailError = '', detailStale = false, busy = '', notice = '', importOutcome = null, formError = '';
  const draft = { source: '', pasted: '', name: '', description: '', instructions: '' };
  const cards = new Map();
  const dropAdvanced = onBotsInterface(() => draw());

  // -- data ---------------------------------------------------------------------------------------------
  async function load() {
    const mine = ++generation;
    loading = !data; loadError = '';
    if (loading) draw();
    try {
      const next = await api(`${base}/skills`, { toast: false });
      if (destroyed || mine !== generation) return;
      data = next;
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
      formError = isStale(error) ? 'This changed since you opened it. Reload and review the current text.' : messageOf(error);
      detailStale = isStale(error);
      return false;
    } finally {
      busy = '';
      if (!destroyed) draw();
    }
  }

  async function openSkill(skill) {
    if (open === skill.name) { open = ''; draw(); return; }
    open = skill.name; detail = null; detailError = ''; detailStale = false;
    draw();
    await loadDetail(skill.name);
  }

  async function loadDetail(name) {
    try {
      const value = await api(`${base}/skills/${encodeURIComponent(name)}`, { toast: false });
      if (!destroyed && open === name) { detail = value; detailStale = false; formError = ''; }
    } catch (error) {
      if (!destroyed && open === name) detailError = messageOf(error);
    }
    if (!destroyed) draw();
  }

  const enable = () => mutate('enable', async () => {
    await api(`${base}/skills/${encodeURIComponent(detail.name)}`, { method: 'PATCH', toast: false,
      body: JSON.stringify(enableBody(detail, { sha256: detail.sha256 })) });
    notice = `/${detail.name} is on.`;
    open = ''; detail = null;
    await refreshData();
  });
  const disable = skill => mutate('disable', async () => {
    await api(`${base}/skills/${encodeURIComponent(skill.name)}`, { method: 'PATCH', toast: false, body: JSON.stringify(disableBody(skill)) });
    await refreshData();
  });
  async function remove(skill) {
    if (!await confirmDialog({ title: `Remove /${skill.name}?`, message: 'The bot stops using it. Earlier versions stay saved.', confirmLabel: 'Remove' })) return;
    await mutate('remove', async () => {
      await api(`${base}/skills/${encodeURIComponent(skill.name)}?expected_revision=${encodeURIComponent(skill.storage_revision)}`, { method: 'DELETE', toast: false });
      if (open === skill.name) { open = ''; detail = null; }
      await refreshData();
    });
  }
  async function refreshData() {
    data = await api(`${base}/skills`, { toast: false });
  }

  const importSource = () => !draft.source.trim() ? (formError = 'Enter a link first.', draw()) : mutate('import', async () => {
    importOutcome = await api(`${base}/skills`, { method: 'POST', toast: false, body: JSON.stringify({ source: draft.source.trim() }) });
    draft.source = '';
    await refreshData();
  });
  const importPasted = () => !draft.pasted.trim() ? (formError = 'Paste a SKILL.md first.', draw()) : mutate('paste', async () => {
    importOutcome = await api(`${base}/skills`, { method: 'POST', toast: false, body: JSON.stringify({ content: draft.pasted }) });
    if (importOutcome.results?.every(r => r.status === 'imported')) draft.pasted = '';
    await refreshData();
  });
  async function saveWritten() {
    const problem = validateWritten(draft);
    if (problem) { formError = problem; draw(); return; }
    await mutate('write', async () => {
      await api(`${base}/skill-template`, { method: 'POST', toast: false, body: JSON.stringify({ name: draft.name, description: draft.description.trim(), instructions: draft.instructions }) });
      notice = `/${draft.name} was saved. Review it to switch it on.`;
      Object.assign(draft, { name: '', description: '', instructions: '' });
      await refreshData();
    });
  }
  const saveSettings = body => mutate('settings', async () => {
    const settings = await api(`${base}/skill-settings`, { method: 'PATCH', toast: false, body: JSON.stringify(body) });
    data = { ...data, settings };
  });

  // -- drawing ------------------------------------------------------------------------------------------
  function statusRow(text, kind = '') {
    return el('div', { class: `bots-skill-status ${kind}`.trim(), role: kind === 'error' ? 'alert' : 'status', text });
  }

  function skillRow(skill) {
    const state = reviewState(skill);
    const isOpen = open === skill.name;
    const hint = [originLabel(skill), skill.description].filter(Boolean).join(' · ');
    const toggle = el('button', {
      type: 'button', role: 'switch', class: 'bots-switch', 'aria-checked': state === 'on' ? 'true' : 'false',
      'aria-label': `${state === 'on' ? 'Turn off' : 'Review and turn on'} /${skill.name}`, disabled: !!busy || state === 'retired',
      onclick: event => { event.stopPropagation(); if (switchIntent(skill) === 'disable') disable(skill); else if (open !== skill.name) openSkill(skill); },
    });
    const row = el('div', { class: 'bots-skill-item', 'data-skill': skill.name, 'data-state': state }, [
      el('div', { class: 'bots-row bots-skill-row' }, [
        el('button', { type: 'button', class: 'bots-skill-main', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => openSkill(skill) }, [
          el('span', { class: 'bots-row-title', text: '/' + skill.name }),
          el('span', { class: 'bots-row-hint', text: hint }),
        ]),
        skill.warnings?.length ? el('span', { class: 'bots-skill-chip warn', title: 'The safety scan left a note. Read it before turning this on.', text: 'Warning' }) : null,
        el('span', { class: `bots-skill-chip ${state}`, text: STATE_LABEL[state] }),
        toggle,
      ]),
    ]);
    if (isOpen) row.append(inspector(skill, state));
    return row;
  }

  function inspector(skill, state) {
    const box = el('div', { class: 'bots-skill-inspect' });
    if (detailError) {
      box.append(statusRow(detailError, 'error'), Button({ label: 'Try again', onClick: () => loadDetail(skill.name) }));
      return box;
    }
    if (!detail) { box.append(statusRow('Loading the full text...')); return box; }
    const line = sourceLine(detail);
    if (line) box.append(el('div', { class: 'bots-row-hint', text: 'Source: ' + line }));
    box.append(skillReviewPanel({ skill: detail }));
    if (detail.changed_after_review) {
      box.append(statusRow('The saved files no longer match what was reviewed. Remove this skill and add it again.', 'error'));
    }
    if (formError) box.append(statusRow(formError, 'error'));
    const actions = el('div', { class: 'bots-skill-card-actions' });
    if (state !== 'on' && !detail.changed_after_review) {
      actions.append(Button({ label: 'Enable reviewed skill', variant: 'primary', disabled: !!busy || detailStale, onClick: enable }));
    }
    if (state === 'on') actions.append(Button({ label: 'Turn off', disabled: !!busy, onClick: () => disable(detail) }));
    if (detailStale) actions.append(Button({ label: 'Reload', onClick: () => { formError = ''; loadDetail(skill.name); } }));
    actions.append(Button({ label: 'Remove', variant: 'danger', iconName: 'trash-2', disabled: !!busy, onClick: () => remove(detail) }));
    box.append(actions);
    return box;
  }

  function libraryRow(skill) {
    return el('div', { class: 'bots-skill-item', 'data-skill': skill.name, 'data-origin': 'library' }, [
      el('div', { class: 'bots-row bots-skill-row' }, [
        el('span', { class: 'bots-skill-main static' }, [
          el('span', { class: 'bots-row-title', text: '/' + skill.name }),
          el('span', { class: 'bots-row-hint', text: ['Library', skill.description].filter(Boolean).join(' · ') }),
        ]),
        el('span', { class: 'bots-skill-chip on', text: skill.assigned_via === 'every' ? 'Every bot' : 'Given' }),
      ]),
    ]);
  }

  function addForms(advanced) {
    const importField = TextRow({ title: 'Import from a link', hint: 'A GitHub link, owner/repo, or a skills.sh link. Nothing runs, and imports stay off until you review them.',
      value: draft.source, placeholder: 'owner/repo' });
    importField.field.addEventListener('input', () => { draft.source = importField.field.value; });
    importField.field.addEventListener('keydown', event => { if (event.key === 'Enter' && draft.source.trim()) { event.preventDefault(); importSource(); } });
    const name = TextRow({ title: 'Command name', hint: 'Lowercase words joined by hyphens. You will type it as /name.', value: draft.name, placeholder: 'weekly-summary', maxLength: 64 });
    name.field.addEventListener('input', () => { draft.name = name.field.value; });
    const description = TextRow({ title: 'One line', hint: 'What it is for.', value: draft.description, maxLength: 1024 });
    description.field.addEventListener('input', () => { draft.description = description.field.value; });
    const instructions = TextRow({ title: 'Instructions', hint: 'Up to 16,000 characters.', value: draft.instructions, multiline: true, maxLength: 16000 });
    instructions.field.addEventListener('input', () => { draft.instructions = instructions.field.value; });
    const out = [
      Card({ label: 'Add a skill', children: [
        importField,
        el('div', { class: 'bots-skill-actions' }, [Button({ label: 'Import', iconName: 'upload', disabled: !!busy, onClick: importSource })]),
        importOutcome ? el('div', { class: 'bots-skill-outcome' }, [
          statusRow(importSummary(importOutcome.results)),
          ...importOutcome.results.filter(r => r.status !== 'imported').map(r => el('div', { class: 'bots-row-hint', text: `${r.name}: ${r.reason || r.status}` })),
          ...(importOutcome.skipped || []).slice(0, 10).map(s => el('div', { class: 'bots-row-hint', text: `${s.path}: skipped, ${s.reason}` })),
        ]) : null,
      ] }),
    ];
    if (advanced) {
      const pasted = TextRow({ title: 'Paste a SKILL.md', hint: 'The whole file, with its name and description at the top.', value: draft.pasted, multiline: true });
      pasted.field.addEventListener('input', () => { draft.pasted = pasted.field.value; });
      out.push(Card({ label: 'Paste', children: [pasted, el('div', { class: 'bots-skill-actions' }, [
        Button({ label: 'Add pasted skill', disabled: !!busy, onClick: importPasted })])] }));
    }
    out.push(Card({ label: 'Write a command', children: [name, description, instructions,
      el('div', { class: 'bots-skill-actions' }, [Button({ label: 'Save command', iconName: 'plus', disabled: !!busy, onClick: saveWritten })])] }));
    return out;
  }

  function advancedCards() {
    const settings = data.settings || { enabled: true, steps: 10, sharing: 'ask' };
    const steps = TextRow({ title: 'Review after this many tool steps', hint: 'From 3 to 100. Default 10.', value: String(settings.steps) });
    steps.field.addEventListener('blur', () => {
      const number = Number(steps.field.value);
      if (number !== settings.steps) saveSettings({ review_steps: number });
    });
    return [
      Card({ label: 'Learning', children: [
        SwitchRow({ title: 'Look for skills in finished work', hint: 'A reviewer with no tools proposes up to three skills. You approve them, unless this bot is at Full access.',
          checked: !!settings.enabled, onChange: on => saveSettings({ review_enabled: on }) }),
        steps,
        el('div', { class: 'bots-row bots-skill-share-row' }, [
          el('span', { class: 'bots-row-main' }, [el('span', { class: 'bots-row-title', text: 'Share learned skills' }),
            el('span', { class: 'bots-row-hint', text: 'Off, ask first, or share on its own. Shared skills go to the library.' })]),
          Segmented({ label: 'Share learned skills', value: settings.sharing, options: [{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask' }, { value: 'auto', label: 'Auto' }],
            onChange: value => saveSettings({ sharing: value }) }),
        ]),
      ] }),
    ];
  }

  function draw() {
    if (destroyed) return;
    for (const handle of cards.values()) handle.destroy();
    cards.clear();
    const advanced = advancedNow(ctx);
    root.dataset.interface = advanced ? 'advanced' : 'simple';
    if (loading) { root.replaceChildren(statusRow('Loading skills...')); return; }
    if (loadError || !data) {
      root.replaceChildren(statusRow(loadError || 'Skills could not be loaded.', 'error'), Button({ label: 'Retry', iconName: 'refresh-cw', onClick: load }));
      return;
    }
    const parts = [];
    if (notice) parts.push(statusRow(notice));
    if (formError && !open) parts.push(statusRow(formError, 'error'));
    const waiting = pendingCards(data.requests);
    if (waiting.length) {
      const holder = el('div', { class: 'bots-skill-cards' });
      parts.push(Card({ label: 'Waiting for you', children: [holder] }));
      for (const request of waiting) {
        const slot = el('div', { class: 'bots-skill-card-slot' });
        holder.append(slot);
        cards.set(request.id, mountSkillRequestCard(slot, { agentId, request, onChanged: (card, action) => {
          data = { ...data, requests: mergeCard(data.requests || [], card) };
          if (action === 'reload') return;
          if (['apply', 'undo', 'deny'].includes(action)) refreshData().then(() => !destroyed && draw()).catch(() => {});
        } }));
      }
    }
    const own = sortSkills(data.skills || []);
    const total = counts(own, data.library);
    const rows = [...own.map(skillRow), ...(data.library || []).map(libraryRow)];
    parts.push(Card({ label: total.total ? `Skills (${total.on} on of ${total.total})` : 'Skills', children: rows.length ? rows : [
      el('div', { class: 'bots-skill-empty' }, [icon('wrench', { size: 18 }), el('div', {}, [
        el('div', { class: 'bots-row-title', text: 'No skills yet' }),
        el('div', { class: 'bots-row-hint', text: 'Add one below, or ask this bot to learn one with /learn.' })])]),
    ] }));
    if ((data.library || []).length === 0 && typeof ctx.go === 'function') {
      parts.push(Button({ label: 'Open the skill library', onClick: () => ctx.go('skill-library') }));
    }
    parts.push(...addForms(advanced));
    if (advanced) parts.push(...advancedCards());
    root.replaceChildren(...parts);
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
  }

  load();
  return {
    destroy() {
      destroyed = true; generation++;
      dropAdvanced();
      for (const handle of cards.values()) handle.destroy();
      cards.clear();
      root.remove();
    },
    refresh: () => load(),
    flush: () => Promise.resolve(true),
  };
}

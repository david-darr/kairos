import { api, el, customSelect, toast, confirmDialog, openPanelDialog } from './api.js';
import { avatarPicker, defaultAvatar } from './agentAvatar.js';
import { agentModelPicker } from './agentModelPicker.js';

// 2026-10-14: keep the entire draft in this dialog until Create succeeds.
// The optional goal is a second existing route, so its failure is reported
// beside the new bot rather than pretending the bot was rolled back.
const PRESETS = [
  ['Researcher', 'Research questions and check sources', 'A curious researcher who brings back clear, sourced findings.', 'Ask what matters, compare reliable sources, and distinguish evidence from inference.'],
  ['Inbox triage', 'Sort incoming messages', 'A calm helper for deciding what needs attention.', 'Group messages by urgency, summarize decisions, and ask before sending anything.'],
  ['Writer', 'Draft and revise writing', 'A careful writing partner.', 'Write plainly, preserve the author’s voice, and flag claims that need checking.'],
  ['Watcher', 'Watch for meaningful changes', 'A quiet observer of chosen topics.', 'Check the chosen sources, report meaningful changes, and avoid repeat alerts.'],
];
const bytes = value => new TextEncoder().encode(value).length;
function limited(input, limit, counter) {
  let value = input.value;
  while (bytes(value) > limit) value = value.slice(0, -1);
  if (value !== input.value) input.value = value;
  counter.textContent = `${bytes(value).toLocaleString()} / ${limit.toLocaleString()} bytes`;
}
const field = (label, control, extra = null) => el('label', { class: 'agent-create-field' }, [el('span', { text: label }), control, extra]);

export async function openCreateAgent() {
  const [models, channels] = await Promise.all([
    api('/api/models').catch(() => []), api('/api/channels').catch(() => []),
  ]);
  const name = el('input', { maxlength: '100', 'aria-label': 'Bot name', placeholder: 'e.g. Scout' });
  const role = el('input', { maxlength: '200', 'aria-label': 'Job', placeholder: 'What is this bot for?' });
  const blurb = el('textarea', { rows: '2', 'aria-label': 'Blurb', placeholder: 'A short introduction' });
  const blurbCount = el('small', { class: 'agent-create-count' });
  const soul = el('textarea', { rows: '7', 'aria-label': 'Soul', placeholder: 'Standing instructions for this bot' });
  const soulCount = el('small', { class: 'agent-create-count' });
  const instructions = el('textarea', { rows: '3', 'aria-label': 'Working approach', placeholder: 'How it should work: sources, boundaries, and reporting.' });
  const model = agentModelPicker(models, {}, () => { dirty = true; });
  const channel = customSelect({}, [el('option', { value: '', text: 'In the app only' }),
    ...channels.map(item => el('option', { value: item.id, text: item.label }))]);
  const goalName = el('input', { 'aria-label': 'Routine name', placeholder: 'e.g. New postings' });
  const goalPrompt = el('textarea', { rows: '3', 'aria-label': 'What to check', placeholder: 'What to check, and what counts as worth telling you' });
  const kind = customSelect({}, [el('option', { value: 'daily', text: 'Every day at' }), el('option', { value: 'interval', text: 'Every N hours' })]);
  const time = el('input', { type: 'time', value: '08:00', 'aria-label': 'Time' });
  const hours = el('input', { type: 'number', min: '1', value: '6', 'aria-label': 'Hours' });
  const report = customSelect({}, [el('option', { value: 'notable', text: 'Only when notable' }), el('option', { value: 'always', text: 'Every time' })]);
  const cadence = el('div', { class: 'agent-create-cadence' }, [kind, time, hours]);
  const syncCadence = () => { time.hidden = kind.value !== 'daily'; hours.hidden = kind.value !== 'interval'; };
  kind.addEventListener('change', syncCadence); syncCadence();
  let dirty = false, creating = false;
  const picker = avatarPicker(defaultAvatar('new-agent'), () => { dirty = true; });
  const validity = el('p', { class: 'agent-create-validity', role: 'status' });
  const create = el('button', { type: 'button', class: 'btn primary', text: 'Create bot', disabled: true });
  const validate = () => {
    const reason = !name.value.trim() ? 'Give the bot a name to create it.' :
      (goalName.value.trim() || goalPrompt.value.trim()) && (!goalName.value.trim() || !goalPrompt.value.trim()) ? 'A first routine needs a name and what to check.' : '';
    validity.textContent = reason; create.disabled = !!reason || creating;
  };
  const presets = el('div', { class: 'agent-create-presets' });
  for (const [title, job, about, standing] of PRESETS) presets.append(el('button', { type: 'button', class: 'btn quiet', text: title, onclick: () => {
    role.value = job; blurb.value = about; soul.value = standing; instructions.value = standing;
    dirty = true; limited(blurb, 4000, blurbCount); limited(soul, 24000, soulCount); validate();
  } }));
  const identity = el('section', { id: 'agent-create-identity', class: 'agent-create-section' }, [
    el('h3', { text: 'Identity' }), el('p', { class: 'meta', text: 'Start with a role, then change every word to make it yours.' }), presets,
    el('div', { class: 'agent-create-identity-grid' }, [
      el('div', {}, [field('Name', name), field('Job / role', role), field('Blurb', blurb, blurbCount)]), picker.root,
    ]),
  ]);
  const sections = [identity,
    el('section', { id: 'agent-create-soul', class: 'agent-create-section' }, [el('h3', { text: 'Soul' }), field('Standing instructions', soul, soulCount), field('Working approach', instructions)]),
    el('section', { id: 'agent-create-model', class: 'agent-create-section' }, [el('h3', { text: 'Model' }), model.root]),
    el('section', { id: 'agent-create-routines', class: 'agent-create-section' }, [el('h3', { text: 'Routines' }), el('p', { class: 'meta', text: 'Optional first scheduled check.' }), field('Name', goalName), field('What to check', goalPrompt), field('When', cadence), field('Report', report)]),
    el('section', { id: 'agent-create-delivery', class: 'agent-create-section' }, [el('h3', { text: 'Delivery' }), field('Tell me on', channel)]),
  ];
  const links = el('nav', { class: 'agent-create-nav', 'aria-label': 'Creation sections' },
    ['Identity', 'Soul', 'Model', 'Routines', 'Delivery'].map((title, index) => el('button', { type: 'button', text: title,
      onclick: () => sections[index].scrollIntoView({ block: 'start', behavior: 'smooth' }) })));
  const body = el('div', { class: 'agent-create-body' }, [links, el('div', { class: 'agent-create-sections' }, sections)]);
  const cancel = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
  const footer = el('div', { class: 'agent-create-footer' }, [validity, cancel, create]);
  const dialog = openPanelDialog({ title: 'New bot', body, footer, className: 'agent-create-dialog', initialFocus: name,
    onClose: () => { document.removeEventListener('keydown', escapeDraft, true); } });
  cancel.addEventListener('click', () => dialog.close());
  // 2026-10-14: the shared panel closes on Escape. Intercept only a typed
  // draft before it reaches that handler; the nested confirmation owns its Escape.
  function escapeDraft(event) {
    if (event.key !== 'Escape' || !dirty || !dialog.panel.isConnected ||
        !dialog.panel.contains(document.activeElement) || creating) return;
    event.preventDefault(); event.stopImmediatePropagation();
    confirmDialog({ title: 'Discard this draft?', message: 'Nothing has been created yet.', confirmLabel: 'Discard draft' })
      .then(yes => { if (yes) dialog.close(); });
  }
  document.addEventListener('keydown', escapeDraft, true);
  for (const input of [name, role, blurb, soul, instructions, goalName, goalPrompt, time, hours]) {
    input.addEventListener('input', () => { dirty = true; if (input === blurb) limited(blurb, 4000, blurbCount);
      if (input === soul) limited(soul, 24000, soulCount); validate(); });
  }
  channel.addEventListener('change', () => { dirty = true; });
  kind.addEventListener('change', () => { dirty = true; }); report.addEventListener('change', () => { dirty = true; });
  limited(blurb, 4000, blurbCount); limited(soul, 24000, soulCount); validate();
  create.addEventListener('click', async () => {
    validate(); if (create.disabled) return;
    creating = true; validate();
    let agent;
    try { agent = await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: name.value.trim(), role: role.value.trim(),
      blurb: blurb.value.trim(), soul: soul.value, instructions: instructions.value.trim(), ...model.get(),
      avatar: picker.getSpec(), deliver_to_channel: channel.value || null }) }); }
    catch (error) { validity.textContent = error.message; creating = false; validate(); toast(error.message, 'error'); return; }
    let goalError = null;
    if (goalName.value.trim()) {
      const goal = { name: goalName.value.trim(), prompt: goalPrompt.value.trim(), schedule_kind: kind.value, report_when: report.value };
      if (kind.value === 'daily') goal.run_time = time.value;
      else goal.interval_seconds = Math.max(1, parseInt(hours.value, 10) || 1) * 3600;
      try { await api(`/api/agents/${agent.id}/goals`, { method: 'POST', body: JSON.stringify(goal) }); }
      catch (error) { goalError = error.message; }
    }
    dialog.close();
    if (goalError) toast(`${agent.name} was created, but the first routine was not: ${goalError}`, 'error');
    else toast(`${agent.name} is ready`, 'success');
    document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'agents', agentId: agent.id, profile: true,
      ...(goalError ? { creationNotice: `Bot created. First routine was not created: ${goalError}` } : {}) } }));
  });
}

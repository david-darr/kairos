import { api, el, openPanelDialog, toast } from './api.js';
import { openRecordingReview } from './recordingReview.js';

// Steps: a model's computer actions in one run, step by step, with the
// before, after and click-marker images Kairos kept (core/computer_trajectory.py;
// vault: Agents - Computer-Use Upgrade from cua, 5.4). Everything from the
// run goes in through textContent; images come from the same-origin routes.

const IMAGE_LABELS = { 'before.jpg': 'Before', 'after.jpg': 'After', 'marker.jpg': 'Click' };
const REASONS = { 'private field': "This step's screenshot was not kept: private field" };

function describe(step) {
  const args = step.arguments || {};
  const target = args.ref || (args.x != null && args.y != null ? `(${args.x}, ${args.y})` : '') || args.url || args.app || '';
  const element = step.element?.label ? ` '${step.element.label}'` : '';
  return `${step.action}${target ? ` ${target}` : ''}${element}`;
}

function whyMissing(step) {
  const missing = step.evidence?.not_kept || {};
  const reasons = [...new Set(Object.entries(missing).filter(([name]) => name !== 'marker.jpg' || step.action === 'click')
    .map(([, why]) => why))];
  return reasons.map(why => REASONS[why] || `Not kept: ${why}.`);
}

export async function openComputerSteps(runId, { opener } = {}) {
  let detail;
  try {
    detail = await api(`/api/computer/steps/${encodeURIComponent(runId)}`);
  } catch (problem) {
    toast(problem.message || 'No computer steps were kept for this run.', 'error');
    return null;
  }
  const steps = detail.steps || [];
  let index = Math.max(0, steps.length - 1);
  let view = 'after.jpg';
  const position = el('div', { class: 'computer-steps-position', role: 'status' });
  const what = el('div', { class: 'computer-steps-action' });
  const result = el('div', { class: 'computer-steps-result' });
  const notes = el('div', { class: 'computer-steps-notes' });
  const picture = el('img', { class: 'computer-steps-image', alt: '' });
  const empty = el('div', { class: 'computer-steps-empty meta' });
  const tabs = el('div', { class: 'computer-steps-tabs', role: 'group', 'aria-label': 'Which screenshot' });
  const previous = el('button', { type: 'button', class: 'btn', text: 'Previous' });
  const next = el('button', { type: 'button', class: 'btn', text: 'Next' });
  const body = el('div', { class: 'computer-steps' }, [
    el('div', { class: 'computer-steps-nav' }, [previous, position, next]),
    what, result, tabs, el('div', { class: 'computer-steps-stage' }, [picture, empty]), notes,
  ]);
  const skill = el('button', { type: 'button', class: 'btn', text: 'Make a skill from this run' });
  const exported = el('a', { class: 'btn quiet', text: 'Export', href: `/api/computer/steps/${encodeURIComponent(runId)}/export`,
    download: `computer-steps-${runId}.zip` });
  const footer = el('div', { class: 'computer-steps-footer' }, [exported, skill]);
  const dialog = openPanelDialog({ title: 'Steps', body, footer, wide: true, className: 'computer-steps-dialog', opener });

  function render() {
    if (!steps.length) {
      position.textContent = 'No steps';
      what.textContent = 'No computer steps were kept for this run.';
      previous.disabled = next.disabled = skill.disabled = true;
      return;
    }
    const step = steps[index];
    position.textContent = `Step ${index + 1} of ${steps.length}`;
    previous.disabled = index === 0;
    next.disabled = index === steps.length - 1;
    what.textContent = describe(step);
    result.textContent = step.result || '';
    result.classList.toggle('is-error', !step.ok);
    const images = step.images || [];
    if (!images.includes(view)) view = images.includes('after.jpg') ? 'after.jpg' : images[0] || '';
    tabs.replaceChildren(...images.map(name => el('button', {
      type: 'button', class: `btn quiet${name === view ? ' active' : ''}`, text: IMAGE_LABELS[name],
      'aria-pressed': String(name === view), onclick: () => { view = name; render(); },
    })));
    if (view) {
      picture.hidden = false;
      empty.hidden = true;
      picture.src = `/api/computer/steps/${encodeURIComponent(runId)}/${step.step}/${view}`;
      picture.alt = `${IMAGE_LABELS[view]} ${describe(step)}`;
    } else {
      picture.hidden = true;
      picture.removeAttribute('src');
      empty.hidden = false;
      empty.textContent = 'No screenshot for this step.';
    }
    notes.replaceChildren(...whyMissing(step).map(text => el('p', { class: 'meta', text })));
  }
  previous.onclick = () => { if (index > 0) { index -= 1; render(); } };
  next.onclick = () => { if (index < steps.length - 1) { index += 1; render(); } };
  body.addEventListener('keydown', event => {
    if (event.target.closest('input, textarea')) return;
    if (event.key === 'ArrowLeft') previous.click();
    if (event.key === 'ArrowRight') next.click();
  });
  skill.onclick = async () => {
    skill.disabled = true;
    try {
      const recording = await api(`/api/computer/steps/${encodeURIComponent(runId)}/skill`);
      dialog.close();
      openRecordingReview(recording);
    } catch (problem) {
      toast(problem.message, 'error');
      skill.disabled = false;
    }
  };
  render();
  return dialog;
}

// The agent's Computer section and a chat's computer: this owner's recent runs.
export async function openOwnerSteps(owner, { opener } = {}) {
  const runs = await api(`/api/computer/${encodeURIComponent(owner)}/steps`).catch(() => []);
  if (!runs.length) { toast('No computer steps are kept for this computer yet.'); return null; }
  if (runs.length === 1) return openComputerSteps(runs[0].run_id, { opener });
  let dialog = null;
  const list = el('div', { class: 'computer-steps-runs' }, runs.map(run => el('button', {
    type: 'button', class: 'btn quiet computer-steps-run',
    text: `${new Date((run.updated || run.started) * 1000).toLocaleString()} · ${run.steps} step${run.steps === 1 ? '' : 's'}`,
    onclick: () => { dialog?.close(); openComputerSteps(run.run_id, { opener }); },
  })));
  dialog = openPanelDialog({ title: 'Steps', body: list, className: 'computer-steps-dialog', opener });
  return dialog;
}

// The learned-skill card and the full-text review panel (Phase 2, unit U3).
//
//   mountSkillRequestCard(host, {agentId, request, onChanged}) -> {update(request), destroy()}
//       Phase 1's card renderer mounts this for a bot's "Enable skill X?" card, and the Skills section mounts
//       the same card, so approving never depends on the conversation. The card shows the whole SKILL.md and
//       every reference as plain text, the hash prefix being approved, and for an update a line diff.
//       Apply sends the hash of the text on screen; a 409 asks the person to reload, a 422 shows a held card.
//   skillReviewPanel({skill, references}) -> node     the same inert text view for a skill being enabled.
//
// Imported text is only ever put in with textContent: it cannot add markup, run or restyle the page.
import { api, el } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import { applyBody, cardActions, cardLine, cardPhase, cardTitle, isHeld, isStale, lineDiff, messageOf, shaPrefix } from './botsSkillsModel.js';

export const SKILLS_CSS = '/static/css/bots-skills.css';

// A block of untrusted text. `max` only limits what is drawn at first; the full text is one click away.
export function inertText(text, className = '') {
  return el('pre', { class: `bots-skill-text ${className}`.trim(), tabindex: '0', text: String(text ?? '') });
}

function details(label, body, open = false) {
  const node = el('details', { class: 'bots-skill-details' }, [el('summary', { text: label }), body]);
  if (open) node.open = true;
  return node;
}

function diffView(before, after) {
  const rows = lineDiff(before, after);
  const box = el('div', { class: 'bots-skill-diff', role: 'group', 'aria-label': 'Changes to the skill text' });
  for (const row of rows) {
    box.append(el('div', { class: `bots-skill-diff-row ${row.kind}`, text: (row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  ') + row.text }));
  }
  return box;
}

export function skillReviewPanel({ skill, references = skill?.references || {}, warnings = skill?.warnings || [] }) {
  const refs = Object.entries(references);
  return el('div', { class: 'bots-skill-review' }, [
    ...warnings.map(w => el('div', { class: 'bots-skill-warning', role: 'note' }, [icon('triangle-alert', { size: 14 }), el('span', { text: String(w).slice(0, 1200) })])),
    el('div', { class: 'bots-caps', text: 'SKILL.md' }),
    inertText(skill.skill_md),
    ...refs.map(([path, text]) => el('div', { class: 'bots-skill-ref' }, [el('div', { class: 'bots-caps', text: path }), inertText(text)])),
    skill.skipped_files?.length ? details(`${skill.skipped_files.length} other files not imported`,
      el('ul', { class: 'bots-skill-skipped' }, skill.skipped_files.slice(0, 50).map(f => el('li', { text: f })))) : null,
    el('div', { class: 'bots-row-hint', text: `Hash ${shaPrefix(skill.sha256 || skill.bundle_sha256)}. A skill gives instructions only. It cannot grant tools or access.` }),
  ]);
}

export function mountSkillRequestCard(host, { agentId, request, onChanged } = {}) {
  let card = request, destroyed = false, busy = false, reloadNeeded = false, error = '';
  loadBotsCss(SKILLS_CSS);
  const root = el('section', { class: 'bots-skill-card', 'data-request': request.id, 'aria-live': 'polite' });
  host.append(root);
  const url = action => `/api/bots/${encodeURIComponent(agentId)}/skill-requests/${encodeURIComponent(card.id)}/${action}`;

  async function run(action) {
    if (busy || destroyed) return;
    busy = true; error = ''; reloadNeeded = false;
    draw();
    try {
      const body = action === 'apply' ? applyBody(card) : {};
      const result = await api(url(action), { method: 'POST', body: JSON.stringify(body), toast: false });
      if (destroyed) return;
      card = result.request || card;
      if (action === 'share') card = { ...card, shared: true };
      onChanged?.(card, action, result);
    } catch (failure) {
      if (destroyed) return;
      if (isHeld(failure)) { await reload(); error = ''; }
      else if (isStale(failure)) { reloadNeeded = true; error = 'This request changed. Reload to review the current text.'; }
      else error = messageOf(failure);
    } finally {
      busy = false;
      if (!destroyed) draw();
    }
  }

  async function reload() {
    try {
      const fresh = await api(`/api/bots/${encodeURIComponent(agentId)}/skill-requests?closed=true`, { toast: false });
      const found = (fresh.requests || []).find(c => c.id === card.id);
      if (!destroyed && found) { card = found; reloadNeeded = false; error = ''; onChanged?.(card, 'reload'); }
    } catch (failure) { error = messageOf(failure); }
    if (!destroyed) draw();
  }

  function draw() {
    if (destroyed) return;
    const phase = cardPhase(card);
    root.dataset.phase = phase;
    root.replaceChildren(...[
      el('div', { class: 'bots-skill-card-head' }, [icon('sparkles', { size: 16 }), el('strong', { text: cardTitle(card) })]),
      card.gist ? el('p', { class: 'bots-skill-card-gist', text: card.gist }) : null,
      el('p', { class: `bots-row-hint${phase === 'held' ? ' bots-skill-held' : ''}`, text: cardLine(card) }),
      phase === 'open' || phase === 'held' ? el('div', { class: 'bots-skill-card-body' }, [
        card.kind === 'update' && card.current_skill_md != null
          ? details('Changes to SKILL.md', diffView(card.current_skill_md, card.skill_md), true) : null,
        details(card.kind === 'update' ? 'Full new text' : 'Full text', skillReviewPanel({ skill: card, references: card.references }), card.kind !== 'update'),
        el('div', { class: 'bots-row-hint', text: `Approving hash ${card.sha_prefix || shaPrefix(card.bundle_sha256)}` }),
      ]) : null,
      phase === 'applied' && card.receipt && !card.receipt.undone ? el('div', { class: 'bots-row-hint', text: `Receipt ${String(card.receipt.id).slice(0, 14)}` }) : null,
      card.shared ? el('div', { class: 'bots-row-hint', text: 'Shared to the library. Assign it to bots there.' }) : null,
      error ? el('div', { class: 'bots-skill-error', role: 'alert', text: error }) : null,
      el('div', { class: 'bots-skill-card-actions' }, [
        ...cardActions(card).map(action => el('button', {
          type: 'button', class: `bots-btn${action.primary ? ' primary' : ''}`, disabled: busy || (reloadNeeded && action.id === 'apply'),
          'data-action': action.id, text: action.label, onclick: () => run(action.id),
        })),
        reloadNeeded ? el('button', { type: 'button', class: 'bots-btn', 'data-action': 'reload', text: 'Reload', onclick: reload }) : null,
      ]),
    ].filter(Boolean));
  }
  draw();
  return {
    update(next) { if (!destroyed) { card = next; draw(); } },
    destroy() { destroyed = true; root.remove(); },
  };
}

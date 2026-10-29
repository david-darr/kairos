// Approval levels for a bot (Phase 3, unit U1): the pure rules behind the Permissions section. No DOM here.
// A level can only be lowered with a plain request; raising it takes the desktop shell's confirmation, which
// runs as prepare (page) -> confirm, activate, commit (desktop). A failed or refused step revokes the request.

export const LEVELS = [
  { value: 'ask', label: 'Ask', rank: 0 },
  { value: 'edits', label: 'Edits', rank: 1 },
  { value: 'auto', label: 'Auto', rank: 2 },
  { value: 'full', label: 'Full', rank: 3 },
  { value: 'custom', label: 'Custom', rank: 0.5 },
];
const BY_VALUE = Object.fromEntries(LEVELS.map(level => [level.value, level]));

export const labelOf = value => BY_VALUE[value]?.label || 'Ask';
export const rankOf = value => (value in BY_VALUE ? BY_VALUE[value].rank : 0);

// Does moving from `current` to `target` raise what the bot may do without asking? Same rule as the server.
export function isRaise(current, target) {
  if (!BY_VALUE[target] || current === target) return false;
  if (target === 'custom') return true;
  return rankOf(target) > rankOf(current);
}

// What the section says about the conversation and the bot. `view` is GET /api/bots-approvals/:bot?thread_id=.
export function describe(view) {
  const effective = labelOf(view.mode);
  const lines = [];
  let chip;
  if (view.thread_id && view.inherited) chip = `This conversation follows the bot (${labelOf(view.bot_mode)})`;
  else if (view.thread_id) chip = `This conversation: ${labelOf(view.thread_mode)}`;
  else chip = `Bot level: ${labelOf(view.bot_mode)}`;
  if (view.reason) lines.push(view.reason);
  const shown = view.thread_id && !view.inherited ? view.thread_mode : view.bot_mode;
  if (shown && shown !== view.mode && !view.reason) lines.push(`Saved as ${labelOf(shown)}, in force as ${effective}.`);
  return { effective, chip, lines, mismatch: !!shown && shown !== view.mode };
}

// Simple view: two choices. A level that is neither does not select either one, so nothing is shown falsely.
export function simpleChoice(view) {
  const shown = view.thread_id && !view.inherited ? view.thread_mode : view.bot_mode;
  if (shown === 'ask') return 'ask';
  if (shown === 'full') return 'full';
  return null;
}

export const SIMPLE_OPTIONS = [
  { value: 'ask', label: 'Ask first', hint: 'It asks before it changes anything or runs anything.' },
  { value: 'full', label: 'Just do it', hint: 'It goes ahead without asking, including sending on its own.' },
];

// Advanced view: all five. A level the bot's AI cannot hold is disabled and says why.
export function levelOptions(view) {
  const current = view.thread_id && !view.inherited ? view.thread_mode : view.bot_mode;
  return (view.levels || []).map(level => ({
    value: level.mode, label: level.label, hint: level.available ? level.blurb : level.reason || level.blurb,
    disabled: !level.available && level.mode !== current, raise: isRaise(view.mode, level.mode),
  }));
}

export function allowanceText(outbound) {
  if (!outbound) return '';
  if (outbound.policy !== 'allow') return `It asks before each outside message. Allowance if you let it send: ${outbound.cap} a day.`;
  return `${outbound.used} of ${outbound.cap} outside messages used today. ${outbound.remaining} left.`;
}

export function messageOf(error) {
  const detail = error?.detail ?? error?.message ?? error;
  return typeof detail === 'string' && detail ? detail : 'That did not work.';
}

// Raise a level through the desktop (which also revokes its own request when a step fails). deps: { prepare(), desktop, revoke?(requestId) }. Resolves {ok, requestId?, message?}.
// Any failure after prepare revokes the request, so nothing is left half confirmed.
export async function raiseLevel(deps) {
  if (!deps.desktop || typeof deps.desktop.elevate !== 'function') {
    return { ok: false, message: 'Raising approval needs the Kairos desktop app. Open it there.' };
  }
  let prepared;
  try { prepared = await deps.prepare(); } catch (error) { return { ok: false, message: messageOf(error) }; }
  const requestId = prepared.request_id;
  try {
    const done = await deps.desktop.elevate(prepared);
    if (!done || done.ok !== true) throw new Error(done?.message || 'It was not confirmed.');
    return { ok: true, requestId };
  } catch (error) {
    try { await deps.revoke?.(requestId); } catch { /* the request expires by itself */ }
    return { ok: false, requestId, message: messageOf(error) };
  }
}

// Change a level. Lowering posts at once and is never queued. Resolves {ok, view?, message?, raised?}.
export async function changeLevel(deps, { view, target, scope = 'bot', threadId = null }) {
  const follow = target === null;
  const current = scope === 'thread' ? view.mode : view.bot_mode;
  if (!follow && isRaise(current, target)) {
    const raised = await raiseLevel({
      desktop: deps.desktop,
      prepare: () => deps.post(`/elevate`, { mode: target, scope: scope === 'thread' ? 'thread' : 'bot', thread_id: scope === 'thread' ? threadId : null,
        expected_revision: view.revision }),
      revoke: id => deps.revoke?.(id),
    });
    if (!raised.ok) return { ok: false, message: raised.message, raised: true };
    return { ok: true, raised: true };
  }
  try {
    const next = await deps.post(`/mode`, { mode: target, scope, thread_id: scope === 'thread' ? threadId : null, expected_revision: view.revision });
    return { ok: true, view: next };
  } catch (error) {
    return { ok: false, message: messageOf(error), stale: error?.status === 409 };
  }
}

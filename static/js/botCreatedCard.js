// The card for a bot made from a conversation (Kairos 2.3.0, core/bot_maker_tools.py create_bot).
// The tool saves an assistant message {type: 'bot_created', bot_created: {bot_id, name, role, avatar, color,
// approval_mode, routines: [{id, name, paused}], made_by}}. Classic chat draws it through agentHandoff.js (its
// history and its live refresh), the Bots conversation through botsRowKinds.js (kind 'bot_created').
// The card shows the bot's look, name and job, then Open bot, Edit and Undo. It reads the bot once when drawn, so
// a later rename shows, and a bot that was removed reads as removed with no buttons.
// Styled in static/css/chat.css (.bot-made-card), which every surface loads.
import { el, toast, confirmDialog, clearSharedReads } from './api.js';
import { agentAvatar } from './agentAvatar.js';

const go = detail => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail }));

// What the card says, from the saved card and (when read) the bot as it is now. Pure, for the Node tests.
export function botCreatedModel(card = {}, live = undefined) {
  const bot = live === null ? null : { ...card, ...(live || {}) };
  const routines = Array.isArray(card.routines) ? card.routines : [];
  const paused = routines.filter(r => r && r.paused).length;
  const level = bot?.approval_mode === 'ask' || !bot ? 'Asks before it acts' : 'Check its approval level';
  return {
    id: String(card.bot_id || ''),
    removed: live === null,
    name: String(bot?.name || card.name || 'New bot'),
    role: String(bot?.role ?? card.role ?? ''),
    avatar: bot?.avatar || card.avatar || null,
    color: bot?.color || card.color || null,
    detail: live === null ? 'Removed' : [level, paused ? `${paused} routine${paused === 1 ? '' : 's'} paused, turn on in Routines` : ''].filter(Boolean).join(' · '),
    hasPaused: paused > 0,
  };
}

export function renderBotCreatedCard(message) {
  const card = message?.bot_created;
  if (!card || !card.bot_id) return null;
  const node = el('div', { class: 'msg assistant bot-made-card', 'data-bot-id': card.bot_id, 'data-handoff-key': message.id || `bot-made:${card.bot_id}`,
    'data-handoff-signature': JSON.stringify(message), role: 'group', 'aria-label': `New bot ${card.name || ''}`.trim() });
  const face = el('span', { class: 'bot-made-face', 'aria-hidden': 'true' });
  const name = el('strong', { class: 'bot-made-name' });
  const role = el('span', { class: 'bot-made-role' });
  const detail = el('span', { class: 'bot-made-detail' });
  const label = el('span', { class: 'bot-made-label', text: 'New bot' });
  const open = el('button', { type: 'button', class: 'btn primary bot-made-open', text: 'Open bot' });
  const edit = el('button', { type: 'button', class: 'btn bot-made-edit', text: 'Edit' });
  const undo = el('button', { type: 'button', class: 'btn quiet bot-made-undo', text: 'Undo' });
  const actions = el('div', { class: 'bot-made-actions' }, [open, edit, undo]);
  node.append(el('div', { class: 'bot-made-top' }, [face, el('div', { class: 'bot-made-text' }, [label, name, role, detail])]), actions);
  let model = botCreatedModel(card);
  const paint = () => {
    face.replaceChildren(agentAvatar({ id: model.id, avatar: model.avatar, color: model.color }, 44));
    name.textContent = model.name;
    role.textContent = model.role;
    role.hidden = !model.role;
    detail.textContent = model.detail;
    node.dataset.state = model.removed ? 'removed' : 'made';
    actions.hidden = model.removed;
  };
  paint();
  open.addEventListener('click', () => go({ tab: 'botsShell', agentId: model.id }));
  edit.addEventListener('click', () => go({ tab: 'botsShell', agentId: model.id, panel: model.hasPaused ? 'routines' : 'identity' }));
  undo.addEventListener('click', async () => {
    const yes = await confirmDialog({ title: `Remove ${model.name}?`, message: 'This deletes the bot that was just made, with its paused routines. Nothing else changes.', confirmLabel: 'Remove bot' });
    if (!yes) return;
    undo.disabled = true;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(model.id)}`, { method: 'DELETE' });
      clearSharedReads();
      if (!res.ok && res.status !== 404) {
        let text = 'The bot could not be removed.';
        try { text = (await res.json()).detail || text; } catch { /* no body */ }
        throw new Error(text);
      }
      model = botCreatedModel(card, null); paint();
      document.dispatchEvent(new CustomEvent('jarvis:agents-changed', { detail: { agentId: model.id } }));
      toast(`${model.name} was removed`, 'success');
    } catch (error) { toast(error.message, 'error'); undo.disabled = false; }
  });
  // The bot as it is now: renamed, restyled, or gone.
  fetch(`/api/agents/${encodeURIComponent(card.bot_id)}`, { cache: 'no-store' }).then(async res => {
    if (res.status === 404) { model = botCreatedModel(card, null); paint(); return; }
    if (res.ok) { model = botCreatedModel(card, await res.json()); paint(); }
  }).catch(() => { /* the saved card stays as it is */ });
  return node;
}

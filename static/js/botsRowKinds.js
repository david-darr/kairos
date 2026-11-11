// Every special row a bot conversation can show, by message kind (Bots Phases 4-6 wiring, 2026-10-29).
// botsTranscript.js draws a row through these renderers (renderRegisteredRow) before its own message row:
// handoffs (botsHandoffChip.js), team chips and goals (botsTeamChips.js), a team setup proposal
// (botsTeamSetupCard.js), front-desk cards (botsFrontDeskCards.js), a bot made from the chat (botCreatedCard.js) and widgets, apps and data results
// (botsRichRows.js). Each renderer receives the transcript row ({message, ...}) and the chat's options.
import { h } from './botsUi.js';
import { teamRowRenderers } from './botsTeamChips.js';
import { renderHandoffChip } from './botsHandoffChip.js';
import { mount as mountTeamSetupCard } from './botsTeamSetupCard.js';
import { renderFrontDeskCard } from './botsFrontDeskCards.js';
import { RICH_KINDS, renderRichRow } from './botsRichRows.js';
import { renderBotCreatedCard } from './botCreatedCard.js';

function teamSetup(row, options) {
  const message = row.message, card = message.card || {};
  const host = h('div', { class: 'bots-team-setup-row', 'data-message-id': message.id });
  mountTeamSetupCard(host, { card, onChanged: () => options.refresh?.() });
  return host;
}

// A handoff row from agent_handoff carries its fields on the message itself.
function handoff(row, options) {
  const node = renderHandoffChip(row.message, { open: target => options.openTarget?.(target), answer: options.answerQuestion });
  node.dataset.messageId = row.message.id;
  return node;
}

export function botRowRenderers(options = {}) {
  const rich = Object.fromEntries(RICH_KINDS.map(kind => [kind, row => renderRichRow(row.message, {
    agentId: options.agentId, sessionId: options.sessionId, botName: options.botName, refresh: options.refresh })]));
  return {
    ...teamRowRenderers, ...rich,
    handoff,
    // kind "card" is a work report (team chip) unless it is a team setup proposal.
    card: (row, opts) => (row.message.card_type === 'team_setup' ? teamSetup(row, opts) : teamRowRenderers.card(row, opts)),
    // A bot Kip made from this conversation (core/bot_maker_tools.py); the same card classic chat shows.
    bot_created: row => { const node = renderBotCreatedCard(row.message); if (node) node.dataset.messageId = row.message.id; return node; },
    fd_card: row => renderFrontDeskCard(row.message, { ...options.frontDesk, agentId: options.agentId, sessionId: options.sessionId }),
  };
}

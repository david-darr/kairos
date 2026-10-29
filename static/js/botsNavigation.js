// One boundary for historical links. This module is pure and safe to use before
// phone routing, mode selection or a view has mounted.
export const targetId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
const SECTIONS = new Set(['overview', 'identity', 'delivery', 'soul', 'skills', 'memory', 'routines', 'access', 'model', 'permissions', 'voice', 'visibility', 'history', 'usage']);
const SECTION_ALIASES = { instructions: 'soul', settings: 'overview', slack: 'delivery', 'voice & alerts': 'voice', 'voice and alerts': 'voice', 'who can see it': 'visibility' };
export function panelSection(value) {
  if (value === true) return 'overview';
  const text = typeof value === 'string' ? value.toLowerCase().trim() : '';
  const section = SECTION_ALIASES[text] || text;
  return SECTIONS.has(section) ? section : undefined;
}

export function normalizeBotsTarget(tab, options = {}) {
  if (tab && typeof tab === 'object') { options = tab; tab = tab.tab; }
  options = options && typeof options === 'object' ? options : {};
  const legacy = tab === 'agents';
  const bots = legacy || tab === 'botsShell' || tab === 'botsHome';
  if (!bots) return { tab: typeof tab === 'string' ? tab : 'home' };
  const team = targetId(options.team?.id) ?? targetId(options.team) ?? targetId(options.systemId);
  if (legacy && team) return { tab: 'swarm', systemId: team };
  const agentId = targetId(options.agentId ?? options.agent_id ?? options.botId);
  const sessionId = targetId(options.sessionId ?? options.session_id ?? options.threadId);
  const messageId = targetId(options.messageId ?? options.message_id);
  const attention = ['inbox', 'notifications', 'activity', 'inspector'].includes(options.attention)
    ? options.attention : options.inbox || options.agentTab === 'inbox' ? 'inbox' : undefined;
  const panel = panelSection(options.panel || options.settingsSection || (options.profile && (options.section || true)));
  const target = { tab: agentId ? 'botsShell' : 'botsHome' };
  if (agentId) target.agentId = agentId;
  if (agentId && sessionId) target.sessionId = sessionId;
  if (agentId && panel) target.panel = panel;
  if (attention) target.attention = attention;
  if (messageId && agentId) target.messageId = messageId;
  const sourceId = targetId(options.sourceId ?? options.itemId ?? options.source_id);
  if (attention && sourceId) target.sourceId = sourceId;
  return target;
}

// A caller supplies the already-authorized session record. Never infer a bot
// from a stored preference when an explicit chat link names another session.
export function sessionTarget(session, sessionId = session?.id) {
  const id = targetId(sessionId);
  if (!id) return { tab: 'chat' };
  const agentId = targetId(session?.agent_id);
  if (agentId) return { tab: 'botsShell', agentId, sessionId: id };
  return { tab: session?.forge || session?.is_forge ? 'forgeShell' : 'chat', sessionId: id };
}

export function notificationTarget(url, origin) {
  let link;
  try { link = new URL(url, origin); } catch { return null; }
  if (link.origin !== origin || link.pathname !== '/' || link.username || link.password) return null;
  const agentId = targetId(link.searchParams.get('agent'));
  const sessionId = targetId(link.searchParams.get('chat'));
  if (link.searchParams.has('agent') && !agentId) return null;
  if (link.searchParams.has('chat') && !sessionId) return null;
  if (agentId) return normalizeBotsTarget('agents', { agentId, sessionId, messageId: link.searchParams.get('message'),
    attention: link.searchParams.get('attention'), sourceId: link.searchParams.get('source') });
  return sessionId ? { tab: 'chat', sessionId } : null;
}

export function threadLink(origin, agentId, sessionId) {
  if (!targetId(agentId) || !targetId(sessionId)) throw new Error('Invalid conversation link');
  const link = new URL('/', origin);
  if (!['http:', 'https:'].includes(link.protocol)) throw new Error('Invalid app address');
  link.searchParams.set('agent', agentId); link.searchParams.set('chat', sessionId);
  return link.href;
}

// The slash-command catalogue for a bot's composer (Phase 2, unit U3). Phase 1's composer imports this.
// Built-in commands come first and shadow a skill of the same name (the server refuses those names for skills).
// Only reviewed, switched-on skills appear. Selecting a skill command sends "/name request" as ordinary text:
// the server expands it (services/bot_skills.py expand_command), so the model sees a run-your-skill instruction.
// No DOM and no imports: runs in plain Node for scripts/test_bots_skills.cjs.

export const BUILT_IN_COMMANDS = [
  { name: 'learn', label: '/learn', description: 'Teach this bot a new skill', kind: 'builtin', icon: 'sparkles', takesText: true },
];

const key = name => String(name || '').toLowerCase();

// skills: the bot's own list, library: the resolved library rows (both from GET /api/bots/<id>/skills),
// extra: built-ins other units add (for example /setup), listed after /learn.
export function skillCommandCatalogue({ skills = [], library = [], extra = [] } = {}) {
  const taken = new Set();
  const commands = [];
  for (const command of [...BUILT_IN_COMMANDS, ...extra]) {
    if (taken.has(key(command.name))) continue;
    taken.add(key(command.name));
    commands.push({ ...command, label: command.label || '/' + command.name, kind: command.kind || 'builtin' });
  }
  // A bot's own skill wins over a library skill of the same name, as it does for the prompt.
  const ranked = [...skills.map(s => ({ s, from: 'private' })), ...library.map(s => ({ s, from: 'library' }))];
  for (const { s, from } of ranked.sort((a, b) => a.s.name.localeCompare(b.s.name))) {
    if (!s.effective_enabled || taken.has(key(s.name))) continue;
    taken.add(key(s.name));
    commands.push({ name: s.name, label: '/' + s.name, description: s.description || '', kind: 'skill', icon: 'sparkles', from });
  }
  return commands;
}

// Match what is typed after the slash. Prefix matches rank above word matches.
export function filterCommands(commands, query = '') {
  const needle = key(query).replace(/^\//, '').trim();
  if (!needle) return commands;
  const rank = command => {
    const name = key(command.name);
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    return key(command.description).includes(needle) ? 3 : 9;
  };
  return commands.filter(c => rank(c) < 9).sort((a, b) => rank(a) - rank(b));
}

// "/name some request" -> {name, request}, or null when the text is not a command.
export function parseSlash(text) {
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return match ? { name: match[1], request: (match[2] || '').trim() } : null;
}

export function matchCommand(commands, text) {
  const parsed = parseSlash(text);
  const command = parsed && commands.find(c => c.name === parsed.name);
  return command ? { command, request: parsed.request } : null;
}

// The text a command puts in the composer when picked from the menu.
export const insertText = command => `/${command.name} `;

// Load the catalogue for one bot. `get` is api() in the app and a stand-in in tests.
export async function loadSkillCommands(agentId, get, extra = []) {
  const data = await get(`/api/bots/${encodeURIComponent(agentId)}/skills`);
  return skillCommandCatalogue({ skills: data?.skills || [], library: data?.library || [], extra });
}

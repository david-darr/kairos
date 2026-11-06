const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/views/settings.js'), 'utf8');
const context = { cachedStatus: { is_admin: true } };
for (const [, name] of source.matchAll(/render: (\w+)/g)) context[name] = () => {};
vm.createContext(context);
const definitions = source.slice(source.indexOf('const SECTION_GROUPS = ['), source.indexOf('\n];', source.indexOf('const SECTION_GROUPS = [')) + 3);
const visible = source.slice(source.indexOf('function visibleSections()'), source.indexOf('\nfunction buildNav()'));
const scope = source.slice(source.indexOf('const THIS_KAIROS'), source.indexOf('const SECTION_GROUPS = [')).replace('export ', '');
vm.runInContext(scope + definitions + '\n' + visible + '\nthis.groups = visibleSections; this.sectionScope = sectionScope; this.registry = SECTION_GROUPS;', context);
const ids = groups => groups.flatMap(group => group.sections.map(section => section.id)).sort();
for (const admin of [true, false]) {
  context.cachedStatus.is_admin = admin;
  const originalGroups = context.registry.filter(group => !group.admin || admin)
    .map(group => ({ ...group, sections: group.sections.filter(section => (!section.admin || admin) && (admin || (context.sectionScope(section) === 'mine' && section.id !== 'bot-computers'))) }))
    .filter(group => group.sections.length);
  const board = context.groups();
  assert.deepEqual(ids(board), ids(originalGroups), 'Every authorized section remains reachable exactly once');
  assert.deepEqual(Array.from(board, group => group.label), admin
    ? ['General', 'Models', 'Connections', 'Agents', 'Bots', 'Your data', 'Access', 'Advanced']
    : ['General', 'Models', 'Bots', 'Your data', 'Access']);
  assert.deepEqual(Array.from(board[0].sections, section => section.id), ['appearance', 'layout', 'notifications', 'speech', 'shortcuts']);
  if (admin) assert.ok(board.find(group => group.id === 'connections').sections.some(section => section.id === 'integrations' && section.label === 'Integrations' && ['calendar', 'email'].every(word => section.keywords.includes(word))));
  assert.ok(!board.find(group => group.id === 'your-data').sections.some(section => section.id === 'integrations'));
  assert.ok(!board.find(group => group.id === 'access').sections.some(section => section.id === 'remote'));
  for (const group of board) for (const section of group.sections) {
    const original = originalGroups.flatMap(group => group.sections).find(item => item.id === section.id);
    assert.equal(section.render, original.render, 'Deep links retain the original renderer');
    for (const word of original.keywords) assert.ok(section.keywords.includes(word), 'Search keywords survive regrouping');
  }
  if (!admin) for (const id of ['permissions', 'agent-tools', 'system', 'file-checkpoints', 'logs', 'computer-use', 'forge']) assert.ok(!ids(board).includes(id));
}
const appearance = fs.readFileSync(path.join(__dirname, '../static/js/appearance.js'), 'utf8');
const nameFunction = appearance.slice(appearance.indexOf('export function appearanceName'), appearance.indexOf('export function getAppearance'));
vm.runInContext(nameFunction.replace('export ', '') + '\nthis.themeName = appearanceName;', context);
assert.equal(context.themeName({ mode: 'color', color: '#233447' }), 'Ocean');
assert.equal(context.themeName({ mode: 'color', color: '#123456' }), '#123456');
assert.equal(context.themeName({ mode: 'shader' }), 'Flow');
assert.equal(context.themeName({ mode: 'default' }), 'Parchment');
console.log('PASS: board groups preserve every route, renderer, authorization gate and search keyword; theme values use saved appearance.');

// Bots Phase 1, unit U2: the avatar editor's pure parts (framing, files, forms), in plain Node.
// Run: node scripts/test_bots_avatar_editor.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', file)).href);
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };
const ID = 'a'.repeat(32);

(async () => {
  const E = await load('botsAvatarEditor.js');
  const A = await load('agentAvatar.js');
  const K = await load('botsKip.js');

  await check('files: only the four picture types, not empty, at most 10 MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(E.checkFile({ type, size: 10 }), '');
    for (const type of ['image/svg+xml', 'text/html', '', 'application/pdf']) assert.match(E.checkFile({ type, size: 10 }), /PNG, JPEG, GIF or WebP/);
    assert.match(E.checkFile({ type: 'image/png', size: 0 }), /empty/);
    assert.match(E.checkFile({ type: 'image/png', size: 10 * 1024 * 1024 + 1 }), /10 MB/);
    assert.equal(E.checkFile({ type: 'image/png', size: 10 * 1024 * 1024 }), '');
    assert.match(E.checkFile(null), /Choose/);
  });

  await check('a framing is always safe: known shape, zoom 1 to 3, focus 0 to 1, a real asset id', () => {
    assert.equal(E.cleanFraming({ asset_id: 'x' }), null);
    assert.equal(E.cleanFraming(null), null);
    assert.deepEqual(E.cleanFraming({ asset_id: ID, shape: 'star', zoom: 9, focus_x: -4, focus_y: 'no' }), { asset_id: ID, shape: 'circle', zoom: 3, focus_x: 0, focus_y: 0.5 });
    assert.deepEqual(E.IMAGE_SHAPES, ['circle', 'rounded', 'square', 'kip']);
    const style = E.framingStyle({ asset_id: ID, shape: 'circle', zoom: 2, focus_x: 0.25, focus_y: 0.75 });
    assert.deepEqual([style.objectPosition, style.transform, style.objectFit], ['25.0% 75.0%', 'scale(2)', 'cover']);
  });

  await check('arrow keys move the focus, shift moves further, plus and minus zoom, all clamped', () => {
    const f = { asset_id: ID, shape: 'circle', zoom: 1, focus_x: 0.5, focus_y: 0.5 };
    assert.equal(E.framingForKey(f, 'ArrowRight').focus_x, 0.52);
    assert.equal(E.framingForKey(f, 'ArrowLeft', { shift: true }).focus_x, 0.4);
    assert.equal(E.framingForKey({ ...f, focus_y: 0.01 }, 'ArrowUp').focus_y, 0);
    assert.equal(E.framingForKey(f, '+').zoom, 1.1);
    assert.equal(E.framingForKey(f, '-').zoom, 1, 'zoom never goes under 1');
    assert.equal(E.framingForKey({ ...f, zoom: 3 }, '=').zoom, 3);
    assert.equal(E.framingForKey(f, 'a'), null);
    assert.equal(E.framingForKey(null, 'ArrowUp'), null);
  });

  await check('dragging moves the picture with the pointer and stays in range', () => {
    const f = { asset_id: ID, shape: 'circle', zoom: 2, focus_x: 0.5, focus_y: 0.5 };
    const moved = E.framingForDrag(f, 20, -10, 100);
    assert.deepEqual([moved.focus_x, moved.focus_y], [0.4, 0.55]);
    assert.equal(E.framingForDrag(f, -9999, 9999, 100).focus_x, 1);
    assert.equal(E.framingForDrag(f, 9999, 0, 100).focus_x, 0);
    assert.equal(E.framingForDrag(f, 5, 5, 0).focus_x, 0.5);
  });

  await check('the apply body carries the framing and the snapshot, and nothing else', () => {
    assert.deepEqual(E.applyBody({ asset_id: ID, shape: 'kip', zoom: 1.5, focus_x: 0.1, focus_y: 0.9, extra: 1 }, 'snap'),
      { asset_id: ID, shape: 'kip', zoom: 1.5, focus_x: 0.1, focus_y: 0.9, expected_snapshot: 'snap' });
    assert.equal('expected_snapshot' in E.applyBody({ asset_id: ID }), false);
    assert.equal(E.applyBody(null), null);
  });

  await check('the generate form checks the direction', () => {
    assert.match(E.checkDirection('  ').error, /Describe/);
    assert.match(E.checkDirection('x'.repeat(401)).error, /400/);
    assert.equal(E.checkDirection('  a fox ').direction, 'a fox');
  });

  await check("the picture comes from the bot's own folder, or the person's draft folder", () => {
    const image = { asset_id: ID, shape: 'circle', zoom: 1, focus_x: 0.5, focus_y: 0.5 };
    assert.equal(A.avatarImageUrl({ id: 'b1', avatar_image: image }), `/api/agents/b1/avatar-image/${ID}`);
    assert.equal(A.avatarImageUrl({ avatar_image: { ...image, draft: true } }), `/api/agents/avatar-drafts/${ID}`);
    assert.equal(A.avatarImageUrl({ avatar_image: image }), '', 'no bot and no draft: nothing to fetch');
    assert.equal(A.avatarImageUrl({ id: 'b1' }), '');
    assert.equal(A.avatarImageUrl({ id: 'b/../x', avatar_image: image }), `/api/agents/b%2F..%2Fx/avatar-image/${ID}`);
  });

  await check('an explicit expression beats the automatic mood; Automatic does not', () => {
    assert.equal(K.stateForBot({ mascot_expression: 'success' }, { status: 'working' }), 'success');
    assert.equal(K.stateForBot({ mascot_expression: null }, { status: 'working' }), 'thinking');
    assert.equal(K.stateForBot({ mascot_expression: 'angry' }, {}), 'idle', 'an unsupported name is ignored');
    assert.deepEqual([...E.PROVIDER_KINDS.map(p => p.value)], ['openai', 'xai', 'compatible']);
    for (const name of K.EXPRESSIONS) assert.ok(E.EXPRESSION_LABELS[name], name);
  });

  console.log(`PASS: ${passed.length} checks: ${passed.join('; ')}`);
})().catch(error => { console.error(error); process.exit(1); });

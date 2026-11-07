// The in-chat media viewer's model (static/js/mediaItems.js): kinds, the
// details row, gestures and which data attributes become viewer items.
//   node scripts/test_media_viewer.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'mediaItems.js')).href);

  // Kinds and labels.
  assert.equal(M.mediaKind('photo.PNG'), 'image');
  assert.equal(M.mediaKind('clip.webm'), 'video');
  assert.equal(M.mediaKind('clip.mov'), 'video');
  assert.equal(M.mediaKind('voice.m4a'), 'audio');
  assert.equal(M.mediaKind('deck.pptx'), 'file');
  assert.equal(M.mediaKind('icon.svg'), 'file', 'SVG is never shown inline as a picture from the server');
  assert.equal(M.mediaKind('no-extension'), 'file');
  assert.equal(M.typeLabel('a.pdf'), 'PDF');
  assert.equal(M.typeLabel('a.xlsx'), 'Spreadsheet');
  assert.equal(M.typeLabel('a.pptx'), 'Slides');
  assert.equal(M.typeLabel('a.docx'), 'Document');
  assert.equal(M.typeLabel('a.py'), 'Code');
  assert.equal(M.typeLabel('a.md'), 'Text');
  assert.equal(M.typeLabel('a.svg'), 'Image');
  assert.equal(M.typeLabel('a.html'), 'Web page');
  assert.equal(M.typeLabel('a.zip'), 'File');

  // Details row, as in the Hermes reference: "Image · PNG · 1920 × 1080 · 906 KB".
  assert.deepEqual(M.detailParts({ name: 'b.png', width: 1920, height: 1080, size: 906 * 1024 }), ['Image', 'PNG', '1920 × 1080', '906 KB']);
  assert.deepEqual(M.detailParts({ name: 'r.pdf', pages: 1, size: 2048 }), ['PDF', '1 page', '2 KB'], 'a format named like its type is not repeated');
  assert.deepEqual(M.detailParts({ name: 'd.pptx', pages: 12, pageUnit: 'slides' }), ['Slides', 'PPTX', '12 slides']);
  assert.deepEqual(M.detailParts({ name: 'c.webm', width: 96, height: 54, duration: 61.4 }), ['Video', 'WEBM', '96 × 54', '1:01']);
  assert.deepEqual(M.detailParts({ name: 'x' }), ['File'], 'unknown parts are left out');
  assert.equal(M.formatBytes(3 * 1048576), '3.0 MB');
  assert.equal(M.formatBytes(25 * 1048576), '25 MB');
  assert.equal(M.formatDuration(3725), '1:02:05');
  assert.equal(M.formatDuration(NaN), '');
  assert.equal(M.counterText(1, 2), '2 of 2');
  assert.equal(M.clampIndex(-3, 4), 0);
  assert.equal(M.clampIndex(9, 4), 3);

  // Gestures: clearly sideways and long enough moves; a downward drag closes.
  assert.equal(M.swipeIntent({ dx: -90, dy: 10, ms: 400 }), 'next');
  assert.equal(M.swipeIntent({ dx: 90, dy: 10, ms: 400 }), 'prev');
  assert.equal(M.swipeIntent({ dx: -40, dy: 4, ms: 400 }), null, 'a slow short drag is not a swipe');
  assert.equal(M.swipeIntent({ dx: -40, dy: 4, ms: 150 }), 'next', 'a quick flick is');
  assert.equal(M.swipeIntent({ dx: -80, dy: 70, ms: 400 }), null, 'a diagonal is neither');
  assert.equal(M.swipeIntent({ dx: 5, dy: 140, ms: 400 }), 'close');
  assert.equal(M.swipeIntent({ dx: 5, dy: -140, ms: 400 }), null, 'dragging up never closes');

  // Card shapes are clamped.
  assert.equal(M.cardAspect(4000, 100), 1.9);
  assert.equal(M.cardAspect(100, 4000), 0.62);
  assert.equal(M.cardAspect(0, 0), 4 / 3);

  // Items from data attributes: only this app's own paths and file links.
  const url = '/generated-images/0123456789ab_photo.png';
  const item = M.itemFromData({ viewerName: 'photo.png', viewerUrl: url, viewerSession: 's1', viewerKind: 'image' });
  assert.deepEqual(item, { kind: 'image', name: 'photo.png', url, sessionId: 's1', src: M.contentURL('s1', url) });
  assert.equal(M.contentURL('s 1', url, true), '/api/chat/artifacts/content?session_id=s+1&url=%2Fgenerated-images%2F0123456789ab_photo.png&download=true');
  assert.equal(M.itemFromData({ viewerName: 'x.png', viewerSrc: 'https://evil.example/x.png', viewerKind: 'image' }), null, 'no remote sources');
  assert.equal(M.itemFromData({ viewerName: 'x.png', viewerSrc: '//evil.example/x.png', viewerKind: 'image' }), null, 'no protocol-relative sources');
  assert.equal(M.itemFromData({ viewerName: 'x.svg', viewerSrc: 'data:image/svg+xml;base64,AAAA', viewerKind: 'image' }), null, 'no SVG data sources');
  assert.equal(M.itemFromData({ viewerName: 'x', viewerUrl: '/etc/passwd', viewerSession: 's1' }), null, 'only artifact links');
  assert.equal(M.itemFromData({ viewerName: 'x.png', viewerUrl: url, viewerKind: 'image' }), null, 'a file link needs its chat');
  const direct = M.itemFromData({ viewerName: 'dot.png', viewerSrc: '/api/chat/images/s1/abc', viewerKind: 'image' });
  assert.deepEqual(direct, { kind: 'image', name: 'dot.png', url: '', sessionId: '', src: '/api/chat/images/s1/abc' });
  const file = M.itemFromData({ viewerName: 'brief.pdf', viewerUrl: '/chat-files/00112233445566778899aabb', viewerSession: 's1', viewerKind: 'file' });
  assert.equal(file.src, '', 'documents render from their link, not a direct source');
  assert.equal(M.itemFromData({ viewerName: 'a.png', viewerSrc: '/x.png', viewerKind: 'script' }).kind, 'image', 'an unknown kind falls back to the name');

  // itemData round-trips through itemFromData.
  const data = M.itemData(item);
  const dataset = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'data-viewer-item')
    .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
  assert.deepEqual(M.itemFromData(dataset), item);
  assert.equal('data-viewer-src' in data, false, 'a file link does not repeat its source');
  console.log('test_media_viewer: all passed');
})().catch(error => { console.error(error); process.exit(1); });

// The in-chat media viewer (In-Chat Media Viewer build spec, 2026-11-07):
// pictures, video and audio in the message, stacks, source cards, and the
// viewer over the chat for every kind, on desktop and at phone width, by
// keyboard and touch, with focus returned and the chat's scroll kept.
// Runs in ui-smoke's full run, under --g2-only and alone with --media-viewer-only.
const assert = require('node:assert/strict');

module.exports = async function checkMediaViewer({ js, win, waitFor, capture, delay, navigate, demoState }) {
  const viewer = '.media-viewer';
  const facts = () => js(`[...document.querySelectorAll('${viewer} .media-viewer-facts span')].map(n => n.textContent)`);
  const count = () => js(`document.querySelector('${viewer} .media-viewer-count')?.textContent`);
  const name = () => js(`document.querySelector('${viewer} .media-viewer-name')?.textContent`);
  const key = (k, target = 'document.activeElement || document.body', extra = '') => js(`(${target}).dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true ${extra} })); true`);
  const assistant = "[...document.querySelectorAll('#chat-messages .msg.assistant')].find(m => m.querySelector('.media-stack'))";
  const userMsg = "[...document.querySelectorAll('#chat-messages .msg.user')].find(m => m.querySelector('.msg-attachments'))";
  const open = async () => {
    demoState.mediaViewer = true;
    await navigate('chat', { sessionId: 's1' });
    try { await waitFor(`!!(${assistant}) && !!(${userMsg})`); }
    catch (error) {
      console.log('media viewer: transcript', await js(`JSON.stringify({ session: document.querySelector('#chat-messages')?.dataset.sessionId, count: document.querySelectorAll('#chat-messages .msg').length,
        cards: document.querySelectorAll('#chat-messages .media-card').length, texts: [...document.querySelectorAll('#chat-messages .msg')].slice(-6).map(m => m.className + ': ' + m.textContent.slice(0, 80)) })`));
      throw error;
    }
  };
  demoState.mediaViewer = true;
  try {
    // ---- Desktop: what sits in the messages ------------------------------------------------------------
    win.setContentSize(1440, 900); await delay(150);
    await open();
    assert.equal(await js(`(${assistant}).querySelectorAll('.media-stack .media-card-image').length`), 2, 'two generated pictures form one stack');
    assert.equal(await js(`(${assistant}).querySelector('.media-stack-count').textContent`), '1 of 2');
    assert.equal(await js(`(${assistant}).querySelectorAll('.media-stack-deck img[src^="/api/chat/artifacts/content?"]').length`), 2, 'pictures load through the chat-checked content route');
    assert.deepEqual(await js(`[...(${assistant}).querySelectorAll('.media-source-site')].map(n => n.textContent)`), ['example.com', 'photos.example.org'], 'source cards under the pictures');
    assert.equal(await js(`(${assistant}).querySelector('.media-source').target`), '_blank');
    assert.equal(await js(`!!(${assistant}).querySelector('.media-card-video video[controls]')`), true, 'video plays in the message');
    assert.equal(await js(`!!(${assistant}).querySelector('.media-card-audio audio[controls]')`), true, 'audio plays in the message');
    assert.equal(await js(`(${assistant}).querySelectorAll('.artifact-card').length`), 7, 'documents keep their file cards');
    assert.equal(await js(`(${assistant}).querySelector('.media-inline').previousElementSibling?.textContent`), 'I found two pictures for the piece and made the files.', 'the stack takes the pictures\' place');
    assert.equal(await js(`(${userMsg}).querySelectorAll('.msg-attachments .media-card-image').length`), 2, 'your attached pictures form a stack');
    assert.equal(await js(`(${userMsg}).querySelector('.msg-attachments .artifact-card strong').textContent`), 'harbor-brief.pdf', 'your attached document is a card');
    // The stack steps in place: buttons, arrow keys and a swipe.
    await js(`(${assistant}).querySelector('[aria-label="Next image"]').click(); true`);
    assert.equal(await js(`(${assistant}).querySelector('.media-stack-count').textContent`), '2 of 2');
    assert.equal(await js(`(${assistant}).querySelector('.media-card[data-depth="0"]').dataset.viewerName`), 'skyline.png');
    await js(`(${assistant}).querySelector('.media-card[data-depth="0"]').focus(); true`);
    await key('ArrowRight');
    assert.equal(await js(`(${assistant}).querySelector('.media-stack-count').textContent`), '1 of 2', 'arrow keys flip the stack and wrap');
    assert.equal(await js(`document.activeElement.dataset.viewerName`), 'harbor.png', 'focus follows the front card');
    await js(`(() => { const d = (${assistant}).querySelector('.media-stack-deck'); const at = (type, x) => d.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: 200, bubbles: true }));
      at('pointerdown', 300); at('pointerup', 200); return true; })()`);
    assert.equal(await js(`(${assistant}).querySelector('.media-stack-count').textContent`), '2 of 2', 'a swipe flips the stack');
    await js(`(${assistant}).querySelector('.media-card[data-depth="0"]').click(); true`);
    assert.equal(await js(`!!document.querySelector('${viewer}')`), false, 'a swipe is never a tap');
    await js(`(${assistant}).querySelector('[aria-label="Previous image"]').click(); true`);
    await capture('media-inline-1440');

    // ---- Desktop: the viewer ---------------------------------------------------------------------------
    // Scroll so the pictures are mid-screen; the chat must be exactly there after closing.
    await js(`(() => { const n = document.querySelector('#chat-messages'), card = (${assistant}).querySelector('.media-stack'); n.scrollTop += card.getBoundingClientRect().top - n.getBoundingClientRect().top - 120; return true; })()`);
    await delay(300);
    const scrollBefore = await js("document.querySelector('#chat-messages').scrollTop");
    assert.ok(scrollBefore > 0, 'the chat is scrolled');
    await js(`window.__mvOpener = (${assistant}).querySelector('.media-card[data-depth="0"]'); window.__mvOpener.click(); true`);
    await waitFor(`!!document.querySelector('${viewer} .artifact-image-viewport img:not([hidden])')`);
    assert.equal(await js(`document.querySelector('${viewer}').getAttribute('role')`), 'dialog');
    assert.equal(await js(`document.querySelector('${viewer}').getAttribute('aria-modal')`), 'true');
    const total = await js(`document.querySelectorAll('${viewer} .media-viewer-thumb').length`);
    assert.equal(total, 15, 'the gallery holds every viewable item in the chat');
    assert.equal(await count(), `5 of ${total}`, 'it opens at the tapped item, in transcript order');
    assert.equal(await name(), 'harbor.png');
    await waitFor(`[...document.querySelectorAll('${viewer} .media-viewer-facts span')].some(n => n.textContent === '480 × 320')`);
    assert.deepEqual(await facts(), ['Image', 'PNG', '480 × 320', '2 KB'], 'details: type, format, dimensions, size');
    assert.equal(await js(`document.activeElement.closest('${viewer}') !== null`), true, 'focus moves into the viewer');
    assert.equal(await js(`document.querySelector('${viewer} .media-viewer-copy').hidden`), false, 'pictures can be copied');
    assert.ok((await js(`document.querySelector('${viewer} .media-viewer-save').getAttribute('href')`)).includes('download=true'), 'Save downloads the original');
    assert.equal(await js(`document.querySelector('${viewer} .media-viewer-pane').getAttribute('aria-label')`), 'Open beside chat');
    assert.equal(await js(`document.querySelector('${viewer} .media-viewer-thumb[aria-current="true"]').getAttribute('aria-label')`), `5 of ${total}: harbor.png`);
    assert.equal(await js(`document.documentElement.classList.contains('media-viewer-open')`), true);
    // Zoom and pan: double-click fills, the wheel zooms, double-click fits again.
    const vp = `document.querySelector('${viewer} .artifact-image-viewport')`;
    await js(`(() => { const r = ${vp}.getBoundingClientRect(); ${vp}.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); return true; })()`);
    assert.equal(await js(`${vp}.classList.contains('is-zoomed')`), true, 'double-click zooms in');
    const zoomed = await js(`document.querySelector('${viewer} .media-viewer-tools .muted').textContent`);
    await js(`(() => { const r = ${vp}.getBoundingClientRect(); ${vp}.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true })); return true; })()`);
    assert.notEqual(await js(`document.querySelector('${viewer} .media-viewer-tools .muted').textContent`), zoomed, 'the wheel zooms in the viewer');
    await capture('media-viewer-zoomed-1440');
    await js(`(() => { const r = ${vp}.getBoundingClientRect(); ${vp}.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + 10, clientY: r.top + 10, bubbles: true, cancelable: true })); return true; })()`);
    assert.equal(await js(`${vp}.classList.contains('is-zoomed')`), false, 'double-click fits again');
    await capture('media-viewer-image-1440');
    // Every kind, by keyboard.
    await key('ArrowRight');
    assert.equal(await name(), 'skyline.png');
    await waitFor(`[...document.querySelectorAll('${viewer} .media-viewer-facts span')].some(n => n.textContent === '640 × 360')`);
    await key('ArrowRight');
    assert.equal(await name(), 'clip.webm');
    await waitFor(`!!document.querySelector('${viewer} .artifact-media-viewport video[controls]')`);
    await waitFor(`[...document.querySelectorAll('${viewer} .media-viewer-facts span')].some(n => n.textContent === '96 × 54')`, 15000);
    assert.equal((await facts())[0], 'Video');
    await capture('media-viewer-video-1440');
    await key('ArrowRight');
    assert.equal(await name(), 'tone.wav');
    await waitFor(`!!document.querySelector('${viewer} .artifact-media-viewport audio[controls]')`);
    assert.equal(await js(`!!document.querySelector('${viewer} .artifact-media-viewport video')`), false, 'the previous player is released');
    await key('ArrowRight');
    assert.equal(await name(), 'reference.pdf');
    await waitFor(`!!document.querySelector('${viewer} canvas.artifact-pdf-page')`, 20000);
    assert.ok((await facts()).includes('2 pages'), 'PDF details count pages');
    assert.equal(await js(`document.querySelector('${viewer} .media-viewer-tools [aria-label="Next PDF page"]')?.disabled`), false, 'PDF is paged');
    await capture('media-viewer-pdf-1440');
    await key('ArrowRight');
    assert.equal(await name(), 'workspace.pptx');
    await waitFor(`!!document.querySelector('${viewer} .office-deck .office-slide')`);
    assert.ok((await facts()).includes('3 slides'));
    // The deck owns its arrows while focused.
    await js(`document.querySelector('${viewer} .office-deck').focus(); true`);
    await key('ArrowRight');
    assert.equal(await name(), 'workspace.pptx', 'arrows inside slides turn slides, not items');
    await js(`document.querySelector('${viewer} .media-viewer-close').focus(); true`);
    await key('ArrowRight');
    assert.equal(await name(), 'brief.docx');
    await waitFor(`!!document.querySelector('${viewer} .office-doc')`);
    await key('ArrowRight');
    assert.equal(await name(), 'budget.xlsx');
    await waitFor(`!!document.querySelector('${viewer} .office-grid')`);
    assert.ok((await facts()).includes('2 sheets'), 'workbook details count sheets');
    await key('ArrowRight');
    assert.equal(await name(), 'example.py');
    await waitFor(`!!document.querySelector('${viewer} .artifact-source .artifact-line')`);
    assert.equal((await facts())[0], 'Code');
    await key('ArrowRight');
    assert.equal(await name(), 'icon.svg');
    await waitFor(`document.querySelector('${viewer} img.artifact-svg-image')?.src.startsWith('blob:')`);
    await waitFor(`[...document.querySelectorAll('${viewer} .media-viewer-facts span')].some(n => n.textContent === '120 × 80')`);
    assert.equal(await js(`!!document.querySelector('${viewer} svg rect[fill="#815e1e"]')`), false, 'SVG is never put into the page as markup');
    await key('ArrowRight');
    assert.equal(await name(), 'preview.html');
    await waitFor(`!!document.querySelector('${viewer} iframe.artifact-frame')`);
    assert.equal(await js(`document.querySelector('${viewer} iframe.artifact-frame').getAttribute('sandbox').includes('allow-scripts')`), false, 'HTML stays in a frame that runs no scripts');
    await capture('media-viewer-html-1440');
    // Home, End, the strip, the edge buttons.
    await key('End');
    assert.equal(await count(), `${total} of ${total}`);
    assert.equal(await js(`document.querySelector('${viewer} .media-viewer-next').disabled`), true);
    await key('Home');
    assert.equal(await count(), `1 of ${total}`);
    assert.equal(await name(), 'project-brief.md');
    await js(`document.querySelectorAll('${viewer} .media-viewer-thumb')[4].click(); true`);
    assert.equal(await name(), 'harbor.png', 'the strip jumps to an item');
    // Focus stays inside: Tab from the last control wraps to the first.
    await js(`(() => { const stops = [...document.querySelectorAll('${viewer} button, ${viewer} a[href]')].filter(n => !n.disabled && !n.closest('[hidden]') && n.getClientRects().length); stops.at(-1).focus(); return true; })()`);
    await key('Tab');
    assert.equal(await js(`document.activeElement.closest('${viewer}') !== null`), true, 'Tab is trapped in the viewer');
    await key('Tab', 'document.activeElement', ', shiftKey: true');
    assert.equal(await js(`document.activeElement.closest('${viewer}') !== null`), true, 'Shift+Tab is trapped too');
    // Escape closes: focus back on the card, the chat where it was.
    await key('Escape');
    assert.equal(await js(`!!document.querySelector('${viewer}')`), false, 'Escape closes');
    assert.equal(await js('document.activeElement === window.__mvOpener'), true, 'focus returns to the item that opened it');
    await delay(100);
    assert.equal(await js("document.querySelector('#chat-messages').scrollTop"), scrollBefore, 'the chat keeps its scroll position');
    assert.equal(await js(`document.documentElement.classList.contains('media-viewer-open')`), false);
    // Clicking the dimmed chat closes too.
    await js(`(${assistant}).querySelector('.media-card[data-depth="0"]').click(); true`);
    await waitFor(`!!document.querySelector('${viewer}')`);
    await js(`document.querySelector('${viewer} .media-viewer-scrim').click(); true`);
    assert.equal(await js(`!!document.querySelector('${viewer}')`), false, 'the scrim closes');

    // A document card opens the viewer; Open beside chat hands it to the Documents pane.
    await js(`[...(${assistant}).querySelectorAll('.artifact-card')].find(c => c.dataset.viewerName === 'brief.docx').click(); true`);
    await waitFor(`document.querySelector('${viewer} .media-viewer-name')?.textContent === 'brief.docx' && !!document.querySelector('${viewer} .office-doc')`);
    assert.equal(await js("!!document.querySelector('.chat-layout .artifact-panel')"), false, 'a tap does not open the pane');
    await js(`document.querySelector('${viewer} .media-viewer-pane').click(); true`);
    await waitFor(`!document.querySelector('${viewer}') && [...document.querySelectorAll('.artifact-tab-label')].some(t => t.textContent === 'brief.docx')`);
    await js("import('/static/js/chatContent.js').then(m => m.closeArtifact())");
    // Ctrl-click still opens a document straight in the pane, without the viewer.
    await js(`[...(${assistant}).querySelectorAll('.artifact-card')].find(c => c.dataset.viewerName === 'budget.xlsx').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true })); true`);
    await waitFor("[...document.querySelectorAll('.artifact-tab-label')].some(t => t.textContent === 'budget.xlsx')");
    assert.equal(await js(`!!document.querySelector('${viewer}')`), false, 'Ctrl-click skips the viewer');
    await js("import('/static/js/chatContent.js').then(m => m.closeArtifact())");
    // Your attached picture opens with its chat-file details.
    await js(`(${userMsg}).querySelector('.media-card[data-depth="0"]').click(); true`);
    await waitFor(`document.querySelector('${viewer} .media-viewer-name')?.textContent === 'harbor.png'`);
    await waitFor(`[...document.querySelectorAll('${viewer} .media-viewer-facts span')].some(n => n.textContent === '480 × 320')`);
    assert.equal(await count(), `2 of ${total}`, 'your attachments are in the same gallery');
    await key('Escape');
    // An inline video hands its place to the viewer and pauses.
    await js(`(${assistant}).querySelector('.media-card-video .media-card-expand').click(); true`);
    await waitFor(`document.querySelector('${viewer} .media-viewer-name')?.textContent === 'clip.webm'`);
    await key('Escape');

    // ---- Phone: a full sheet, swipe between items, drag down to close -----------------------------------
    win.setContentSize(390, 844); await delay(250);
    await open();
    await js(`(${assistant}).querySelector('.media-stack').scrollIntoView({ block: 'center' }); true`);
    await delay(200);
    const phoneScroll = await js("document.querySelector('#chat-messages').scrollTop");
    await js(`window.__mvOpener = (${assistant}).querySelector('.media-card[data-depth="0"]'); window.__mvOpener.click(); true`);
    await waitFor(`!!document.querySelector('${viewer} .artifact-image-viewport img:not([hidden])')`);
    await waitFor(`document.querySelector('${viewer} .media-viewer-sheet').getAnimations().length === 0`);
    const sheet = await js(`(() => { const r = document.querySelector('${viewer} .media-viewer-sheet').getBoundingClientRect(); return { w: Math.round(r.width), bottom: Math.round(r.bottom), left: Math.round(r.left), height: innerHeight, top: Math.round(r.top) }; })()`);
    assert.equal(sheet.w, 390, 'the phone sheet is full width');
    assert.equal(sheet.left, 0);
    assert.ok(Math.abs(sheet.bottom - sheet.height) <= 2, `the sheet reaches the bottom: ${JSON.stringify(sheet)}`);
    assert.equal(await js(`getComputedStyle(document.querySelector('${viewer} .media-viewer-grab')).display`), 'block', 'a grab bar shows');
    assert.equal(await js(`getComputedStyle(document.querySelector('${viewer} .media-viewer-prev')).display`), 'none', 'phones swipe instead of side buttons');
    assert.equal(await js(`document.querySelector('${viewer} .media-viewer-pane').getAttribute('aria-label')`), 'Open in Documents');
    assert.ok(await js(`document.querySelector('${viewer} .media-viewer-close').getBoundingClientRect().width >= 44`), 'touch targets are 44px');
    assert.equal(await js(`document.querySelector('${viewer} .media-viewer-strip').scrollWidth > document.querySelector('${viewer} .media-viewer-strip').clientWidth`), true, 'the strip scrolls sideways on its own');
    assert.equal(await js(`document.querySelector('${viewer} .media-viewer-sheet').scrollWidth <= 392`), true, 'the sheet does not overflow sideways');
    await capture('media-viewer-image-390');
    const swipe = async (selector, from, to) => { await waitFor(`!!document.querySelector('${selector}')`); return js(`(() => { const t = document.querySelector('${selector}'); const ev = (type, [x, y]) => t.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      ev('pointerdown', ${JSON.stringify(from)}); ev('pointermove', ${JSON.stringify(to)}); ev('pointerup', ${JSON.stringify(to)}); return true; })()`); };
    await swipe(`${viewer} .artifact-image-viewport`, [320, 420], [120, 430]);
    assert.equal(await name(), 'skyline.png', 'swipe left goes to the next item');
    await swipe(`${viewer} .artifact-image-viewport`, [80, 420], [300, 425]);
    assert.equal(await name(), 'harbor.png', 'swipe right goes back');
    await swipe(`${viewer} .artifact-image-viewport`, [200, 300], [200, 330]);
    assert.equal(await js(`!!document.querySelector('${viewer}')`), true, 'a small drag does nothing');
    // A wide document scrolls sideways instead of changing items.
    await js(`document.querySelectorAll('${viewer} .media-viewer-thumb')[11].click(); true`);
    await waitFor(`!!document.querySelector('${viewer} .office-grid')`);
    await capture('media-viewer-sheet-390');
    await swipe(`${viewer} .media-viewer-grab`, [195, 20], [195, 260]);
    assert.equal(await js(`!!document.querySelector('${viewer}')`), false, 'dragging the sheet down closes it');
    assert.equal(await js('document.activeElement === window.__mvOpener'), true, 'focus returns on the phone too');
    await delay(100);
    assert.equal(await js("document.querySelector('#chat-messages').scrollTop"), phoneScroll, 'the phone chat keeps its place');
    // Swiping down on a picture closes as well.
    await js(`window.__mvOpener.click(); true`);
    await waitFor(`!!document.querySelector('${viewer} .artifact-image-viewport img:not([hidden])')`);
    await swipe(`${viewer} .artifact-image-viewport`, [195, 300], [200, 520]);
    assert.equal(await js(`!!document.querySelector('${viewer}')`), false, 'a downward swipe on a picture closes');
    await capture('media-inline-390');
    win.setContentSize(1440, 900); await delay(200);
  } finally {
    demoState.mediaViewer = false;
    await js(`import('/static/js/mediaViewer.js').then(m => m.closeMediaViewer())`).catch(() => {});
  }
  console.log('PASS: media viewer: inline pictures, stacks, sources, video, audio; every kind in the viewer; keyboard, focus, scroll, phone sheet and swipes.');
};

// Native cursor polling backs up forwarded mousemove, which Windows does not
// deliver reliably to every transparent click-through window. All coordinates
// from screen and BrowserWindow are DIPs; renderer CSS pixels also account for zoom.
function localPointer(point, bounds, zoom = 1) {
  return { x: (point.x - bounds.x) / zoom, y: (point.y - bounds.y) / zoom };
}

function trackOverlay(win, screen, getBounds, timers = globalThis) {
  let timer = null, last = null;
  const sample = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const point = localPointer(screen.getCursorScreenPoint(), win.getContentBounds(), win.webContents.getZoomFactor());
    if (last && point.x === last.x && point.y === last.y) return;
    last = point;
    win.webContents.send("usage-overlay:pointer", point);
  };
  const place = () => {
    if (win.isDestroyed()) return;
    win.setBounds(getBounds());
    last = null;
    sample();
  };
  const stop = () => { if (timer !== null) timers.clearInterval(timer); timer = null; last = null; };
  const start = () => { stop(); place(); timer = timers.setInterval(sample, 80); };
  win.on("ready-to-show", place);
  win.on("show", start);
  win.on("hide", stop);
  win.on("closed", stop);
  // Recreate renderer hover state after reload and after moving along an edge.
  win.webContents.on("did-finish-load", () => { last = null; sample(); });
  win.on("move", () => { last = null; sample(); });
  win.on("resize", () => { last = null; sample(); });
  return { place, stop };
}

module.exports = { localPointer, trackOverlay };

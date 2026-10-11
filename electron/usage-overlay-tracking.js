// Native cursor polling backs up forwarded mousemove, which Windows does not
// deliver reliably to every transparent click-through window. All coordinates
// from screen and BrowserWindow are DIPs; renderer CSS pixels also account for zoom.
function localPointer(point, bounds, zoom = 1) {
  return { x: (point.x - bounds.x) / zoom, y: (point.y - bounds.y) / zoom };
}

// Fractional DPI can round a native rectangle by one DIP. Do not keep moving
// an already anchored window to correct that harmless rounding.
function boundsDiffer(actual, desired) {
  return ["x", "y", "width", "height"].some(key => Math.abs(actual[key] - desired[key]) > 1);
}

function trackOverlay(win, screen, getBounds, timers = globalThis) {
  let timer = null, dragging = false, placing = false;
  const sample = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const point = localPointer(screen.getCursorScreenPoint(), win.getContentBounds(), win.webContents.getZoomFactor());
    // Repeat even at rest: mouseleave, layout/zoom changes, or a click-through
    // transition can invalidate renderer hover without the cursor moving.
    win.webContents.send("usage-overlay:pointer", point);
  };
  const place = () => {
    if (win.isDestroyed() || dragging || placing) return;
    placing = true;
    try { win.setBounds(getBounds()); } finally { placing = false; }
    sample();
  };
  const tick = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    // Windows can relocate/resize a window AFTER the screen metrics event (or
    // without another event). Reconcile against fresh display DIPs, not against
    // the native move event's new position. Pause while the move handle is held.
    if (!dragging && boundsDiffer(win.getBounds(), getBounds())) place();
    else sample();
  };
  const stop = () => { if (timer !== null) timers.clearInterval(timer); timer = null; };
  const start = () => { stop(); place(); timer = timers.setInterval(tick, 80); };
  win.on("ready-to-show", place);
  win.on("show", start);
  win.on("hide", stop);
  win.on("closed", stop);
  // Recreate renderer hover state after reload and after moving along an edge.
  win.webContents.on("did-finish-load", sample);
  win.on("move", sample);
  win.on("resize", sample);
  return { place, stop, setDragging: on => { dragging = !!on; if (!dragging) place(); } };
}

module.exports = { localPointer, boundsDiffer, trackOverlay };

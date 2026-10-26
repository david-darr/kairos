// Where the usage notch's window goes. Pure functions over plain display
// objects ({id, workArea: {x, y, width, height}}), with no Electron import, so
// scripts/test_overlay_placement.cjs can check every edge and display without a
// screen; electron/main.js passes in Electron's screen.getAllDisplays().
// All sizes and coordinates are DIPs. scaleFactor is only for display labels;
// multiplying these rectangles by it would move the notch away from the edge.

const EDGES = ["top-centre", "left", "right"];

// The side notch (Kairos Mobile v2 board NotchSide): the 380 DIP expanded
// panel and, beside it on the inner side, room for the 246 DIP usage card with
// an 8 DIP margin on each side of it.
// The window spans the whole work-area height; the page puts the notch at the
// chosen offset inside it (static/js/notchSide.js), so a tall expanded panel
// never has to share the window's range with the resting pill.
const SIDE_W = 656;

// `area` is the work area; only the side notch uses its height.
function sizeFor(edge, area) {
  // The v2 board's 820 DIP expanded notch (the quiet view is the tallest, about 350), its shadow, and the usage card below it.
  if (edge === "top-centre") return { width: 860, height: 640 };
  return { width: SIDE_W, height: area ? area.height : 0 };
}

// The chosen display, or the primary one when none is chosen or it has been unplugged.
function chooseDisplay(displays, displayId, primaryId) {
  return displays.find((d) => d.id === displayId) || displays.find((d) => d.id === primaryId) || displays[0];
}

// Flush against the edge of the display's work area (so the taskbar is never
// covered). The top-centre notch sits `offset` of the way along the top: 0 is
// the left end, 1 the right end. The side windows span the work area's height,
// so `offset` places the notch inside the page instead. The window never
// extends past the work area.
function boundsFor(config, display) {
  const area = display.workArea;
  const edge = EDGES.includes(config.edge) ? config.edge : "right";
  const offset = Number.isFinite(config.offset) ? Math.min(1, Math.max(0, config.offset)) : 0.5;
  const size = sizeFor(edge, area);
  const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height);
  const along = (room) => Math.round(Math.max(0, room) * offset);
  switch (edge) {
    case "left": return { x: area.x, y: area.y + along(area.height - height), width, height };
    case "top-centre": return { x: area.x + along(area.width - width), y: area.y, width, height };
    default: return { x: area.x + area.width - width, y: area.y + along(area.height - height), width, height };
  }
}

module.exports = { EDGES, SIDE_W, sizeFor, chooseDisplay, boundsFor };

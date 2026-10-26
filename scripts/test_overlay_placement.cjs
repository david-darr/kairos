// Placement of the desktop usage notch: electron/usage-overlay-placement.js.
// Plain Node, no Electron and no screen. Run: node scripts/test_overlay_placement.cjs
const assert = require("node:assert/strict");
const p = require("../electron/usage-overlay-placement");

// Two monitors as Electron describes them: the main one with a 48 px taskbar at
// the bottom, and a second one to its left at negative coordinates.
const main = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1392 } };
const side = { id: 2, workArea: { x: -1920, y: 120, width: 1920, height: 1040 } };
const displays = [main, side];
let failures = 0;
function check(name, fn) {
  try { fn(); console.log("ok   " + name); } catch (e) { failures += 1; console.log("FAIL " + name + "\n     " + e.message); }
}
const inside = (b, a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;

check("every edge on every display stays inside that display's work area", () => {
  for (const display of displays) for (const edge of p.EDGES) for (const offset of [0, 0.37, 1]) {
    const b = p.boundsFor({ edge, offset }, display);
    assert.ok(inside(b, display.workArea), `${edge} @${offset} on ${display.id}: ${JSON.stringify(b)}`);
  }
});

check("the window is flush against its edge, the taskbar never covered", () => {
  const a = main.workArea;
  assert.equal(p.boundsFor({ edge: "right", offset: 0.5 }, main).x + p.SIDE_W, a.x + a.width);
  assert.equal(p.boundsFor({ edge: "left", offset: 0.5 }, side).x, side.workArea.x);
  assert.equal(p.boundsFor({ edge: "top-centre", offset: 0.5 }, main).y, a.y);
});

check("the three edges are top centre, left and right", () => {
  assert.deepEqual(p.EDGES, ["top-centre", "left", "right"]);
});

check("a side window is 656 wide (380 panel and the 246 usage card) and spans the work area's height", () => {
  assert.deepEqual(p.sizeFor("right", main.workArea), { width: 656, height: main.workArea.height });
  for (const display of displays) for (const edge of ["left", "right"]) for (const offset of [0, 0.5, 1]) {
    const b = p.boundsFor({ edge, offset }, display), a = display.workArea;
    assert.equal(b.height, a.height, `${edge} @${offset} on ${display.id}`);
    assert.equal(b.y, a.y, "the offset places the notch inside the page, not the window");
    assert.equal(b.width, 656);
  }
});

check("a side window never outgrows a narrow work area", () => {
  const narrow = { id: 3, workArea: { x: 100, y: 50, width: 500, height: 700 } };
  assert.deepEqual(p.boundsFor({ edge: "left", offset: 0.5 }, narrow), { x: 100, y: 50, width: 500, height: 700 });
  assert.deepEqual(p.boundsFor({ edge: "right", offset: 0.5 }, narrow), { x: 100, y: 50, width: 500, height: 700 });
});

check("the top-centre offset runs along the top: ends and middle", () => {
  const a = main.workArea;
  assert.equal(p.boundsFor({ edge: "top-centre", offset: 0 }, main).x, a.x);
  assert.equal(p.boundsFor({ edge: "top-centre", offset: 1 }, main).x, a.x + a.width - 860);
  assert.equal(p.boundsFor({ edge: "top-centre", offset: 0.5 }, main).x, Math.round((a.width - 860) / 2));
});

check("an unplugged or unset monitor falls back to the main display", () => {
  assert.equal(p.chooseDisplay(displays, 2, 1), side);
  assert.equal(p.chooseDisplay(displays, 99, 1), main, "a monitor that is no longer attached");
  assert.equal(p.chooseDisplay(displays, null, 1), main);
});

check("unknown values fall back rather than misplace the window", () => {
  assert.deepEqual(p.boundsFor({ edge: "diagonal", offset: 7 }, main), p.boundsFor({ edge: "right", offset: 1 }, main));
});

check("top-centre uses a top-anchored 860 DIP shell centred in the work area", () => {
  for (const display of displays) for (const scaleFactor of [1, 1.25, 1.5]) {
    const b = p.boundsFor({ edge: "top-centre", offset: .5 }, { ...display, scaleFactor });
    assert.equal(b.y, display.workArea.y);
    assert.equal(b.width, 860);
    assert.equal(b.height, 640);
    assert.ok(Math.abs(b.x + 430 - display.workArea.x - display.workArea.width / 2) <= .5);
  }
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("all placement checks passed");

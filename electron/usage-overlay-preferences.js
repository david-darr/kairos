// The top-centre notch replaces the edge notch (Kairos Notch build spec, 4a).
// A preference saved before it (no `notch` version) moves to the top centre
// once; a left or right edge chosen after that keeps its placement (they are
// the side notch now). The top and bottom edges the CodeNotch pill once offered
// no longer exist and become the top centre.
const { EDGES } = require('./usage-overlay-placement');
// 3: the v2 pill at rest (an interim 2 kept the old fold-to-sliver default).
const NOTCH_VERSION = 3;
function overlayPreferences(saved = {}) {
  const current = saved?.notch === NOTCH_VERSION;
  return { edge: current && EDGES.includes(saved?.edge) ? saved.edge : 'top-centre',
    displayId: Number.isFinite(saved?.displayId) ? saved.displayId : null,
    offset: current && Number.isFinite(saved?.offset) ? Math.min(1, Math.max(0, saved.offset)) : .5,
    // The v2 notch rests as its collapsed pill (NotchCollapsed board); folding to a sliver is opt-in.
    foldOnHover: current ? saved.foldOnHover === true : false, notch: NOTCH_VERSION };
}
module.exports = { overlayPreferences, NOTCH_VERSION };

// The top-centre notch replaces the edge notch (Kairos Notch build spec, 4a).
// A preference saved before it (no `notch` version) moves to the top centre
// once; an edge chosen after that keeps its placement.
const { EDGES } = require('./usage-overlay-placement');
const NOTCH_VERSION = 2;
function overlayPreferences(saved = {}) {
  const current = saved?.notch === NOTCH_VERSION;
  return { edge: current && EDGES.includes(saved?.edge) ? saved.edge : 'top-centre',
    displayId: Number.isFinite(saved?.displayId) ? saved.displayId : null,
    offset: current && Number.isFinite(saved?.offset) ? Math.min(1, Math.max(0, saved.offset)) : .5,
    foldOnHover: saved?.foldOnHover !== false, notch: NOTCH_VERSION };
}
module.exports = { overlayPreferences, NOTCH_VERSION };

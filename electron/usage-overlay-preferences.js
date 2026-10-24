// Persisted edges keep their placement. Only a missing preference gets the new default.
const { EDGES } = require('./usage-overlay-placement');
function overlayPreferences(saved = {}) {
  return { edge: EDGES.includes(saved?.edge) ? saved.edge : 'top-centre',
    displayId: Number.isFinite(saved?.displayId) ? saved.displayId : null,
    offset: Number.isFinite(saved?.offset) ? Math.min(1, Math.max(0, saved.offset)) : .5,
    foldOnHover: saved?.foldOnHover !== false };
}
module.exports = { overlayPreferences };

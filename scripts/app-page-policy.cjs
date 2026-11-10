// The app page's one inline script is the three.js import map (static/index.html); the backend's policy allows exactly
// its hash on "/" only (core/middleware.py, core/three_vendor.py). The test servers that mirror that policy add the
// same hash on "/" so the page runs as it does in the app. scripts/test_video_tracks.py keeps the map and the hash equal.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const mapHash = file => {
  try {
    const map = /<script type="importmap">([^<]*)<\/script>/.exec(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    return map ? `'sha256-${crypto.createHash('sha256').update(map[1], 'utf8').digest('base64')}'` : '';
  } catch { return ''; }
};
const IMPORT_MAP_HASH = mapHash('static/index.html');
// The website's demo (docs/demo, built from static/index.html) carries the same map with relative paths. The real site
// sends no policy; ui-smoke serves it under this one, so its page gets its own map's hash the same way.
const DEMO_MAP_HASH = mapHash('docs/demo/index.html');

// The script-src sources for a response at `pathname`.
const scriptSrc = pathname => {
  const hash = pathname === '/' ? IMPORT_MAP_HASH : /^\/(docs|kairos)\/demo\/(index\.html)?$/.test(pathname) ? DEMO_MAP_HASH : '';
  return hash ? `'self' ${hash}` : "'self'";
};

module.exports = { IMPORT_MAP_HASH, scriptSrc };

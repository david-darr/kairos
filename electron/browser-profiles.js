// electron/browser-profiles.js — which account's Browse is open (Kairos
// Browser, multi-account). The app window is signed in to one Kairos account
// at a time; Browse and the side pane follow it. The backend names the
// profile (GET /api/browse/profile, from the window's own sign-in cookie),
// never the page, so one account can't ask for another's profile.
//
// resolve() asks the backend and, if the account changed (or nobody is
// signed in any more), closes the open Browse first: its tabs, permission
// prompts and pending password offers go with it. Browse is opened lazily,
// on the first call that needs it, and closed whenever the app page
// reloads (sign-out reloads it).

const { validProfile } = require("./browser-browse");

function createBrowseProfiles({ fetchProfile, open, onSwitch = () => {}, log = console }) {
  let current = null;
  let profile = null;
  let inflight = null;

  function close() {
    const was = current;
    current = null; profile = null;
    if (was) { try { was.close(); } catch (err) { log.error(`[browse] close: ${err.message}`); } }
  }

  function resolve() {
    if (inflight) return inflight;
    inflight = (async () => {
      let next = null;
      try { next = validProfile(await fetchProfile()); } catch { next = null; }
      if (next !== profile || (next && !current)) {
        const changed = next !== profile;
        close();
        if (next) { current = open(next); profile = next; }
        if (changed) { try { onSwitch(next); } catch { /* best effort */ } }
      }
      return current;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return { resolve, close, get: () => current, profile: () => profile };
}

module.exports = { createBrowseProfiles };

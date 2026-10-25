// The notch takes the keyboard only while something in it is being typed:
// its quick composer, or a question's one-line answer (Kairos Notch build
// spec, 4a). At rest the window is non-focusable, so typing always reaches
// the app underneath. Opening makes it focusable and focuses it; closing
// blurs it, which hands the keyboard back, then makes it non-focusable again.
// Pure over the window object, so scripts/test_notch_focus.cjs checks it.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function setOverlayFocus(win, on) {
  if (!win || win.isDestroyed()) return false;
  if (on) {
    win.setFocusable(true);
    win.focus();
  } else {
    if (win.isFocused()) win.blur();
    win.setFocusable(false);
  }
  return !!on;
}

// A chat or agent id the notch may ask the app to open: server-made, so
// plain letters, digits, dash and underscore.
function validId(value) { return typeof value === "string" && ID.test(value); }

module.exports = { setOverlayFocus, validId };

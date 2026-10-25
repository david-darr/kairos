// The Kip style setting (David, 2026-10-25): one choice for Kairos's own Kip.
// flat, halftone and pixel are the three drawings (mascot.js finishes);
// hidden is the old Show Kip switch turned off. Pure data and rules, no DOM,
// so appearance.js, the notch and scripts/test_mascot.cjs share them.
export const KIP_STYLES = ['flat', 'halftone', 'pixel', 'hidden'];
export const KIP_STYLE_NAMES = { flat: 'Flat', halftone: 'Halftone', pixel: 'Pixel', hidden: 'Hidden' };
// Home's Kip has been halftone since the mascot shipped; that is the default.
export const DEFAULT_KIP_STYLE = 'halftone';

// A stored appearance record in, its Kip style out. Records from before this
// setting carry only the on/off `mascot`: on keeps the default look, off is hidden.
export function kipStyleOf(raw) {
  if (KIP_STYLES.includes(raw?.kip)) return raw.kip;
  return raw?.mascot === false ? 'hidden' : DEFAULT_KIP_STYLE;
}

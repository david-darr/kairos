// Shared validation and the allowlist for local art imports. No account data.
export const EFFECTS = Object.freeze(['dithered', 'halftone', 'ascii', 'numbers', 'binary', 'animated']);
// The effects drawn from a picture, offered under Background effect. Animated art is a background
// style of its own (David, 2026-10-28); its density and motion are still kept under 'animated'.
export const PICTURE_EFFECTS = Object.freeze(EFFECTS.filter(effect => effect !== 'animated'));
// The pieces themselves are listed in artCatalog.js (all of ascii-magic-art, generated).
// The person's own animation (a GIF, animated WebP or PNG, or a short video), kept on this device.
export const OWN_ART = 'own';
// How a piece is drawn: as made, or redrawn in one of the ASCII Magic player's own looks.
export const ART_LOOKS = Object.freeze([
  ['original', 'As made'], ['dots', 'Halftone dots'], ['ascii', 'ASCII'], ['dither', 'Dithered'], ['blocks', 'Blocks'],
]);
export function normalizeEffectOptions(raw) {
  return Object.fromEntries(EFFECTS.map(effect => {
    const v = raw?.[effect];
    return [effect, {
      density: typeof v?.density === 'number' && Number.isFinite(v.density) ? Math.max(3, Math.min(24, v.density)) : effect === 'dithered' ? 4 : 9,
      motion: typeof v?.motion === 'boolean' ? v.motion : true,
      // Original preserves pre-effect Color palettes; explicit Picture always
      // means the source's colours, including in Color mode.
      tint: ['theme', 'picture', ...(effect === 'dithered' ? ['original'] : [])].includes(v?.tint) ? v.tint : effect === 'dithered' ? 'original' : 'theme',
    }];
  }));
}

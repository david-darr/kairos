// Shared validation and the allowlist for local art imports. No account data.
export const EFFECTS = Object.freeze(['dithered', 'halftone', 'ascii', 'numbers', 'binary', 'animated']);
export const ART_PIECES = Object.freeze([
  ['moonlit-sea', 'Moonlit Sea'], ['cloud-drift', 'Cloud Drift'],
  ['ripple-pond', 'Ripple Pond'], ['rain-shower', 'Rain Shower'],
  ['snowfall', 'Snowfall Valley'], ['fireflies', 'Firefly Meadow'],
  ['ocean-waves', 'Breaking Waves'], ['plasma', 'Sine Plasma'],
  // Small characters and objects (desktop redesign, 2026-10-28), shown alone or in Scatter.
  ['bouncing-slime', 'Bouncy Green Slime'], ['cool-sun-shades', 'Sun in Sunglasses'], ['dancing-cactus', 'Dancing Pot Cactus'],
  ['debug-duck-bob', 'Rubber Duck Debugger'], ['friendly-ghost-float', 'Friendly Floating Ghost'], ['idea-lightbulb', 'Bright Idea Bulb'],
  ['laptop-typing-cat', 'Cat at the Keyboard'], ['paper-plane-loop', 'Loop the Loop Plane'], ['planet-astronaut-wave', 'Pocket Planet Astronaut'],
  ['robot-wave-blink', 'Waving Tin Robot'], ['scarf-penguin', 'Penguin in a Scarf'], ['sleepy-moon', 'Drowsy Crescent Moon'],
  ['stomping-dino', 'Stomping Little Dino'], ['wagging-pup', 'Happy Wagging Pup'], ['lava-lamp', 'Lava Lamp'],
  ['candle-flame', 'Candle Flame'], ['hourglass', 'Hourglass'], ['rocket-launch', 'Rocket Launch'], ['ringed-planet', 'Ringed Gas Giant'],
]);
// Scatter (David, 2026-10-28, after ascii-magic's own backdrops): several of these small pieces
// around the edges of one backdrop, each cut out of its own background. Not a file of its own.
export const SCATTER = 'scatter';
export const SCATTER_PIECES = Object.freeze(ART_PIECES.slice(8).map(([id]) => id));
// Living pixels (desktop redesign, 2026-10-28): how an animated piece is drawn,
// each a mode of the ascii-magic runtime's paint(): [id, title, runtime mode].
export const ART_LOOKS = Object.freeze([
  ['ascii', 'ASCII', 'text'], ['dither', 'Dithered', 'dither'],
  ['dots', 'Halftone dots', 'circle'], ['pixels', 'Pixels', 'square'],
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

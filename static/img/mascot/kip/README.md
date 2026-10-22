# Kip terminal assets

Kip, the Kairos mascot, in its pixel style (vault: "Kairos Mascot (Build
Spec)", section 6; the app draws the flat style, Home the halftone). Built by
`node scripts/build_kip_assets.cjs` from `static/js/kip.js` and the brand
tokens; do not edit by hand.

States: `idle`, `thinking`, `needs-you`, `done`, `error`, `sleeping`
(sleeping plays at 4 frames a second).
Themes: `parchment` (light terminals), `night` (dark terminals).
Sizes: `full` (24 x 24 pixels, 24 x 12 cells) and `mini` (12 x 12 pixels,
12 x 6 cells, the CLI's mascot slot).

- `kip-<size>-<theme>.png`: a sprite sheet. One row per state, in the order of
  `states` in kip.json; one column per frame, left to right. Unused cells at
  the end of a row are transparent. For sixel or Kitty graphics.
- `kip.json`: the same frames as text. `sizes.<size>.frames.<theme>.<state>`
  is a list of frames; a frame is a list of rows; each character is `.`
  (clear) or a base-36 index into `themes.<theme>.<size>` (hex colours).
  `fps` and `frame_counts` give the loop. Draw two pixel rows per cell with
  `▀` (upper half: foreground = top pixel, background = bottom pixel).
- `kip-<state>.txt`, `kip-mini-<state>.txt`: the still frame as plain
  half-blocks with no colour, for terminals without truecolour.
- `text_face` (three lines, `unicode` and `ascii`) and `spinner` in
  kip.json: the plain-terminal tiers.

Choose the tier by capability: sixel or Kitty graphics, then truecolour
half-blocks from kip.json, then the plain text face, else hidden. Honour
`--no-motion` by drawing frame 0 only.

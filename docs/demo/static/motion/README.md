# Motion engine

`engine.js` exports `mount(canvas, project, {aspect, tokens, assetsBase})`.
Await `ready` before calling synchronous `drawFrame(seconds)` or `layout(seconds)`.
The returned object also exposes `duration`, `info` and `dispose()` (frees a 3D
stage's WebGL context; Studio calls it when it replaces a preview). Each mount owns
its buffers, images, font metrics and deterministic caches; Studio can mount several
canvases.

`overlay.js` draws a project's overlay tracks (Content Studio Editor step 3): text,
image and shape clips over the beats in track order (the last track on top) and under
the captions, each with its opacity and linear fades, positioned by a box of frame
shares. Hidden tracks and audio tracks draw nothing. `layout(t)` reports each clip on
screen with `clip`, `track` and (text) `role: 'overlay'`, its colours and `truncated`;
`info.clips` lists the visible clips. core/video_tracks.py checks the same data.

`player.html` has exactly one `<!--KD-PROJECT-->` and `<!--KD-TOKENS-->` placeholder.
Replace the former with a complete JSON script element named `kd-project` (escape
`<` as `\u003c` in JSON), and the latter with the look's style/font-face block.
The engine publishes `kdReady`, `kdInfo`, `kdDrawFrame`, `kdLayout`. Add `?play`
(or `&play`) for controls outside the canvas. Assets resolve against `assets/`
beside the player; same-origin image URLs inherit the page's `rt` query token.
Failed images or a look without a 4.5:1 token pair reject readiness explicitly.

`layout.js` is DOM-free: normalization, timing, safe areas, fitting, beat slots,
camera transforms and transition geometry. `kit.js` is also safe to import in Node:
easing, string hashing/seeded PRNG, zoom/scrim/card/window primitives, ordered
dither, sampled halftone type, typed text and sRGB contrast helpers.

Copy sits directly on the look background. Seeded beat/index compositions alternate
between left, centre and bottom anchors; adjacent beats never share a composition.
Headlines use 85?92% wide safe-area slots, balanced wrapping and a width-aware fit.
There is no generic card. Only image captions have opaque backing; split photos
have a frame and quotes have a large opening mark. Numbers sit beside their label
in landscape and stack in portrait/square. Lists fit up to five rows at one size, with a shared left text edge and shape bullets aligned to the first line.
Logos contain-fit above copy. Missing image fields use a token surface placeholder;
named image files must load successfully. End cards freeze for their final 1.5 s.

Type ranges in canvas pixels (all aspects have a 1080px short side):

| Beat | Display size | Approximate cap height (.72em) |
| --- | --- | --- |
| Title | 210?270 | 14?18% of short side |
| Statement / logo | 150?195 | 10?13% |
| Big number | 525?750 | 35?50% |
| List heading | 135?165 | 9?11% |
| Quote / image / split | 135?180 | 9?12% |
| End headline | 180?240 | 12?16% |

Body is 45.36?60px (floor 4.2%); number labels 54?86px, list rows
59.4-86px (floor 5.5%), end CTA 59.4?75px (floor 5.5%). Cap height is an
estimate: supplied fonts retain their own metrics. Wrapping precedes shrinking;
copy that still exceeds its box at the floor ellipsizes and reports `truncated`.
The first beat starts partly revealed; a still first beat starts fully revealed.
Statements balance across two or three lines at their target size before shrinking.
Engine-added ellipses use ASCII dots; opening quote marks check display then body
font metrics against missing glyphs, then fall back to two accent shapes.
A drifting faint pattern and safe bg/surface gradient keep settled scenes alive;
accent rules sit under headlines, with no persistent corner score mark. The final end hold freezes all of these layers.

Camera still/push/pull/pan/shake affects scenery, preserving safe copy. Outgoing
beats specify the next cut's transition: cut, whip with trails, zoom-through,
perspective-like horizontal flip, Bayer dither, seeded mosaic or accent bar wipe.
Non-cut windows run from cut-0.175 to cut+0.175 seconds. Foreground transitions
clip at the safe rectangle; layout returns conservative visible bounds of boxes
(dither/mosaic holes and occlusion by another scene are not individual boxes).
`size`, `color`, `highlightColor`, `bg`, and `truncated` accompany text geometry.
During a reveal, `text` contains only the words whose entrance has begun.

Fonts/colours/radius/case/weight come from `--ds-*` tokens. Optional
`--ds-display-style: italic` and `--ds-pattern: flat|grain|noise|dots|grid|stripes|waves|topo|confetti`
refine the look. Without a pattern hint, mood selects stripes for sport/bold/dynamic,
otherwise bg luminance selects grid or dots. Pattern opacity is 6%. Gradients
stay within the look's readable contrast envelope. Low-contrast accents/dim text
fall back to another readable token; decorative accents retain their colour.
`kdLayout` retains its existing fields and adds `role`, nominal `fontSize`,
`minSize`, estimated `capHeight`, `align` and `composition` for inspection.
Transition-scaled `size` remains the visible size, while `fontSize` permits floor
checks even during zoom/flip transitions.

Normalization limits: 64 beats, BPM 40..240, bars .25..16, text 180 codepoints,
sub 160, number 24, five items of 100 each, ids 64; fps is always 30. Unknown kinds
become statements, unknown cameras/transitions become still/cut. Image names are
single safe filenames with an optional `assets/` prefix. Empty projects get an
end card. These defensive limits should agree with backend validation; the
browser does not replace the backend validator. Extremely short beats can have
overlapping transition windows; the earliest matching cut wins.

Run `node scripts/test_motion_engine.cjs` (Node 22.7+ detects these `.js` ES modules;
the root CommonJS package may emit a harmless MODULE_TYPELESS_PACKAGE_JSON warning).
Run visual checks with `node scripts/motion-engine-checks.cjs`, or give that file
directly to Electron. It mirrors the shared runner because that runner currently
has a fixed allowlist. The caller must already hold the shared
`C:\Users\David\jarvis-app\data\electron.lock`; the suite never acquires or removes
a lock. It uses a local fixture server and writes `data/ui-review/motion-{16x9,9x16,1x1}.png`. Colons are replaced
with `x` for Windows filenames. Each sheet has dark/light rows for every beat. Additional `motion-{aspect}-designed.png`
sheets sample frame 0 and every beat at 60%. Pixel checks cover variance (including
frame 0), >8% non-background coverage, type floors, contrast and determinism.
The visual suite is intentionally not run as part of this lane's implementation.

## Pack A: characters and scenes (Video Styles unit 3)

`rig.js` draws a character from its versioned spec (core/character_store.py): round, square or
triangle body, dot eyes, head, body and two-bone arms and legs, four views (front, three-quarter,
side, back), five expressions and six mouth shapes. `drawCharacter(g, spec, x, feetY, height, state)`
returns the figure's box; `figureBox` gives the same box without drawing. Blinks are seeded per
character and beat; `mouthAt` reads the narration's measured mouth string (one code a frame: X rest,
A, E, O, M for M/B/P, F for F/V, from core/video_mouth.py); `viewAt` steps a head turn through the
neighbouring views; `poseAt` gives the action's bone angles and its squash and stretch (scale curves
from the feet). Everything is a function of (spec, time), so frames are deterministic.

`scene.js` draws a `scene` beat: a setting (meadow, city, space, room, ocean, lab) as four parallax
layers (sky, far, mid, near) in the project's palette (dawn, mint, dusk, night, paper), icon props,
and up to three cast members sized by shot (wide 30%, medium 46%, close 74% of the short side). The
camera moves each layer by its depth. `layout()` reports each character (`kind: 'character'` with
its body centre, height and outline width) and prop outside transitions, for the sheet-match checks.
The player receives the cast's specs as `characters` (routes/video_routes.py). A scene's `text` is a
short label on a card at the top.

`sheet.js` + `sheet.html` render a character's reference sheet (every view, expression and mouth
shape, the palette) in the render worker as a PNG job; the layout comes from core/character_sheet.py.

## User-made style packs

A video made in a user-made style pack (core/style_pack_store.py) gets the pack's look from the
player as `pack`: its scene palette as checked hex colours, its lighting (flat, soft or glow: how
strong the soft light gradients on the flat layers are) and its caption case. `normalizePack` keeps
only those; a malformed palette is dropped and the named palette is used. Nothing else of a pack
reaches the page, and nothing in a pack runs.

Inside a pack, every beat that is not a scene (title, statement, end and the other copy kinds) is a
card in the pack's world, not the design look's plain background: `packCard` gives its sky gradient,
its light (a soft glow from the upper right, CARD_GLOW times the lighting, none when flat) and its
hills and pale ground below the copy's safe area. The type keeps the look's fonts; its colours come
from the pack and are chosen so every colour copy can sit on (sky, gradient end, glow) keeps 4.5:1,
and `kdLayout` reports that lightest ground as the box's `bg`. The rule under a headline is the
pack's prop colour. Captions keep their own card.

One light per sky: a meadow, city or ocean sky draws a soft sun disc and space a far planet only
when the scene has no sun or moon prop (`skyBody`); a scene's own sun or moon is its light, and two
bodies show only when the scene asks for a moon beside its sun.

A title or end card speaks only its own words. The render notes (core/video_checks.card_narration_notes)
name a card whose line is about something else and any caption on screen while a card shows.

Captions stay clear of characters: a captioned scene stands its figures 3% of the height above the
caption band, and a close shot cuts the cast at the near ground layer (`castClip`), so a close
figure is framed from the chest up and its box in `layout()` carries that `clip`. The render notes
name any caption that still covers a character (core/video_checks.caption_clear_notes).

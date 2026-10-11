---
name: motion-video
description: Make a polished animated video, motion graphics, explainer, promo, ad, intro or animated showcase rendered to MP4, with deterministic canvas animation and a soundtrack synthesized in code.
license: MIT
metadata:
  version: "1.0.0"
---

# Motion video

Build a JavaScript canvas animation where each frame is a function of time,
synthesize an original WAV soundtrack, capture with Playwright's Chromium,
and encode with FFmpeg. Review the rendered result before delivering it.

## Before starting

Check `node --version` (18 or newer) and `ffmpeg -version`. In the project
folder check that Playwright is installed and its Chromium executable exists;
after copying the starters, `node motion-render.mjs --check` checks both and
FFmpeg, including a generic cached Chromium fallback. It does not install anything.
If a tool is missing, stop and tell the person exactly which tool is missing.
Give the relevant one-time commands below and ask before installing anything.
Never install silently, including downloading a browser on first render.

- Node: download the LTS installer from https://nodejs.org, or on Windows run
  `winget install --id OpenJS.NodeJS.LTS -e`. Reopen the terminal and check the version.
- FFmpeg: Windows `winget install --id Gyan.FFmpeg -e`; macOS `brew install ffmpeg`;
  Debian/Ubuntu `sudo apt update` then `sudo apt install ffmpeg`. Reopen the terminal
  if needed so FFmpeg is on PATH.
- Playwright and Chromium, in the project folder: `npm init -y` (only if no
  package.json exists), `npm install playwright`, `npx playwright install chromium`.
  Linux may also need Chromium's system libraries; report the launch error and
  ask before running `npx playwright install --with-deps chromium`.

Create a project folder in your working directory. Read and copy these three
top-level files from this skill into it, then adapt the copies:

- [motion-starter.html](motion-starter.html): canvas, scene timing, preview and easing.
- [motion-soundtrack.mjs](motion-soundtrack.mjs): original stereo WAV synthesis.
- [motion-render.mjs](motion-render.mjs): loopback server, capture, MP4 and review images.

Put the final MP4 (and the contact sheet if useful) inside the generated-files
directory your system instructions named (not your vault working directory).
That's what makes the result a real chat download instead of a stray vault file.
The project and draft outputs can stay in the working directory; copy the reviewed
outputs from `out/` into the generated-files directory before handing them over.

## Make and review

1. Establish the brief: length, aspect ratio, tone, music tempo and story beats.
   Ask only for missing choices that materially affect the result. Set the output
   resolution first. The starter is 1920 x 1080, 120 BPM, six bars, 12 seconds.
2. Storyboard scenes in bars: seconds per bar = `240 / BPM` in 4/4 time.
   Declare each scene's start bar and length in bars. Align cuts, impacts and
   reveals with beats. Keep BPM, total bars and scene-cut bars matched in the
   HTML and soundtrack script. The renderer reads duration and size from the HTML.
3. Adapt the copied starters to the brief. Replace example copy and shapes with
   the person's story. Preview with `node motion-render.mjs --preview`, open the
   printed loopback URL ending in `motion-starter.html?play`, and scrub the timeline.
   This preview is visual only; listen to the WAV or rendered MP4 separately.
4. Run `node motion-soundtrack.mjs`, then `node motion-render.mjs --fps 10` for
   a quick draft. Draft and full renders use the same time expressions. These
   commands overwrite `out/video.mp4` and `out/contact-sheet.png`; preserve a pass
   under another name if comparison is useful. Inspect the sheet and exact frames,
   fix problems, and render again. Then run `node motion-render.mjs` for 30 fps.
5. Open and inspect the full render's contact sheet. It samples evenly spaced
   frame indices including the first and last. Also watch the MP4 with sound and
   inspect frames around each cut at full resolution. Check all of the following:
   - Text is legible at the intended viewing size and inside a 5% safe margin.
   - Nothing important is cropped or overlapping another element.
   - No blank frames or unintended half-transition frames remain.
   - Scene timing lands on beats and gives each message time to read.
   - Palette is consistent and text has readable contrast.
   - The final frame is a clean end card, held long enough to read.
6. For an exact frame, run `node motion-render.mjs --fps 30 --frame N` to write
   `out/frame-N.png` at time `N / 30` seconds. Use the same fps as that pass;
   frame indices are zero-based. Inspect the frame before, at and after a cut,
   plus the last frame (`ceil(duration * fps) - 1`). To verify the encoded MP4
   too, use FFmpeg's `select='eq(n,N)'` filter and `-frames:v 1 -fps_mode vfr`
   from a script argument array, exporting a PNG. An `fps=1` contact sheet can
   sample late; it does not prove that the exact cut or ending frame is clean.
7. Listen for clicks, harsh peaks, silent sections, and timing drift. The renderer
   applies `loudnorm=I=-16:TP=-1.5:LRA=11` before AAC encoding. Measure the final
   MP4 with FFmpeg, using arguments `-i out/video.mp4 -af
   loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -` and inspecting
   `input_i` and `input_tp`. Aim around -16 LUFS and peak under -1 dBFS, including
   true peak after AAC encoding. Peak normalization alone does not establish LUFS.
   If the measured output misses these targets, adjust or use two-pass loudnorm
   with the measured values, re-encode, and listen and measure again.
8. Repeat render, look, fix and re-render until the checklist and audio check pass.
   Do not claim the video is done until this review loop passed. If a required
   tool or inspection is unavailable, state the blocker and stop, without claiming
   successful rendering or review. Deliver the real MP4 via `save_generated_file`
   with its generated-files path and a short description. Include the exact
   Markdown download link it returns on its own line. Deliver the sheet similarly
   if useful, and add one line stating what changed between review passes.

## Animation and audio rules

- `window.drawFrame(t)` must produce the same pixels for the same time regardless
  of call order. No `Date.now()`, accumulated frame state or unseeded `Math.random()`
  in drawing. Use the starter's seeded PRNG for precomputed values, or recreate it
  from a time-derived seed inside a frame. Preview clocks only choose `t`.
- Wait for `document.fonts.ready` before capture, and await any added image assets.
  Design at the output resolution, use system font stacks by default, and keep
  text inside 5% safe margins. Use easing helpers instead of linear motion.
- Express all motion, texture changes and reveals in seconds or bars, never frame
  increments. Reset drawing state and fully paint the canvas on every call.
- Synthesize a WAV in code. Use no copyrighted music or samples. Normalize the
  floating-point mix before any soft clipping, then leave headroom for encoding.
  Keep transients on scene cuts and give the ending a short audio fade.

## Capture gotchas

- Opening HTML via `file://` can block canvas pixel reads, particularly with local
  assets. The renderer serves the project over loopback HTTP instead.
- Reading the canvas with `toDataURL` or `ImageData` is faster and more exact than
  page screenshots and excludes preview controls.
- FFmpeg 7+ removed `-vsync`; use `-fps_mode`. Keep FFmpeg filters in script argument
  arrays on Windows, avoiding fragile shell-escaped one-liners.
- Windows `drawtext` needs an explicit escaped fontfile path, for example the
  filter string `fontfile='C\:/Windows/Fonts/arial.ttf'` (double the backslash in a
  JavaScript string). The starter sheet omits drawtext to avoid font dependencies;
  its logged frame-index list identifies each tile in row-major order.

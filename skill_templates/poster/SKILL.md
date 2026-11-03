---
name: poster
description: |
  Make a real poster, flyer or single-page announcement on Kairos's Design
  canvas, in a look chosen for its subject, with real legible text (not an AI
  image, which garbles words), then hand it over as PNG, PDF or PPTX. Use when
  asked to create, design or make a poster, flyer, or one-page promo graphic.
license: MIT
metadata:
  version: "2.0.0"
---

# Poster: a designed, legible poster on the Design canvas

A poster has to be read from across a room: one big idea, a few facts, one
call to action, all as real text. Build it as a `poster` board on the Design
canvas (read `design-canvas` for the tools), so every model makes it the same
way, it is checked as it is built, and the person can change any word later.

## Steps

1. **Direction.** Call `creative_direction` with the request and `type: "poster"`.
   Pick the look that fits the subject (a kids' camp is not a law firm) and say
   why in one line. The Kairos look is only for posters about Kairos.
2. **Size.** `format: "poster"`. Portrait `2:3` unless the person says
   otherwise; `18x24` or `11x17` when they name a print size; `a-series` for A4
   to A0. A poster for social media is a `social` board instead.
3. **Build it in one board** with `design_create` `{title, look, boards: [{title,
   format: "poster", orientation: "portrait", html}]}`. Start from the
   `poster-stack`, `big-number` or `grid-12` skeleton in `design-canvas`:
   - a kicker (who or what, small, in the accent text colour);
   - the headline, huge: 140 to 220px, `var(--ds-font-display)`, the look's
     weight and case, two to five words;
   - the facts as a short block or grid (when, where, who, price), 28 to 40px;
   - one call to action on an accent fill with `var(--ds-on-accent)` text;
   - a visual made of type, colour blocks, numbers or simple shapes when no
     image exists. Never an empty box or grey bars.
4. **Read the notes** the tool returns (type below 20px, empty boxes, contrast)
   and fix each with `design_edit`. With image reading, `design_snapshot` and
   look at it: the headline should be readable at thumbnail size.
5. **Hand it over.** `design_export` with `png` for sharing and printing at
   home, `pdf` for a print shop, `pptx` if they want to edit it in PowerPoint.
   Put the design link and the export link in your reply.

## Notes

- Never invent facts the person didn't give (a date, an address, a phone
  number): leave a visible placeholder like [ADD LOCATION].
- PNG, PDF and PPTX exports need the Kairos desktop app; the offline HTML zip
  works everywhere. If an export says it needs the desktop app, say so and
  give the design link.

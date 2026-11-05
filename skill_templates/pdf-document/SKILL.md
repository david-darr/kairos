---
name: pdf-document
description: |
  Make a designed document or PDF on Kairos's Design canvas: a report, guide,
  cheat sheet, one-pager, proposal, resume, worksheet or certificate, in a
  look chosen for its subject, printed on real Letter or A4 pages with a
  running header and page numbers, then handed over as PDF or Word. Use when
  asked for a PDF, a document, a report, a guide, a handout or anything to print
  or send as pages. Replaces hand-written ReportLab scripts.
license: MIT
metadata:
  version: "1.1.0"
---

# PDF document: real pages, designed, on the Design canvas

A document is one `document` board (read `design-canvas` for the tools). It
is as wide as its page and as long as its content; Kairos prints it on real
pages: the content flows across them, the header runs from page 2, every page
is numbered, table headers repeat and headings stay with what follows. Every
model makes it the same way, it is checked as it is built, and the PDF's text
stays selectable.

## Pictures

Follow the Pictures section in `design-canvas` for photos, generation,
licensed search and credits, treatments, patterns and placement. A type-led
layout is fine; never draw people, objects or scenes with SVG or CSS.

## Steps

1. **Direction.** `creative_direction` with the request and `type: "print"`.
   Pick the look that fits the subject and reader (a law brief is not a kids'
   camp); say why in one line.
2. **Archetype.** Pick one and follow its shape (below).
3. **Build** with `design_create` `{title, look, boards: [{title, format:
   "document", orientation: "portrait", size: "letter", html}]}` (`size: "a4"`
   outside the US, or when asked). The design's title becomes the running
   header. Write the whole document in one board; for a long one, create it
   with the first sections and add the rest with `design_edit` `insert`
   `last_child` on the outermost element.
4. **Read the notes** each call returns (type under 13px, mostly blank
   pages, chart tables that don't parse, contrast) and fix them with
   `design_edit`. With the desktop app, the notes come from the printed pages
   of that very version.
5. **Hand it over.** `design_export` `pdf`, and `docx` too when the person
   wants to edit it in Word. Put both links in your reply.

## Page rules

- Never set a height or draw page frames: the page size, margins (0.75 in),
  header and page numbers are Kairos's. Write top to bottom.
- `<div data-kd-page-break></div>` starts a new page: after the cover, and
  before a part that must open a page (an answer key, an appendix). Never put
  one before every section: a section that runs three lines over leaves the
  next page almost empty. Let sections follow on; the headings already stay
  with what follows. Blocks never split across pages: figures, images, quotes,
  table rows and anything marked `data-kd-keep`, so keep those smaller than a
  page.
- Body text 15 to 17px with line-height 1.5 to 1.65; headings from the look's
  `var(--ds-font-display)`; text never under 13px.
- Tables are real `<table>`s with a `<thead>`, never grids of divs, so they
  split cleanly and the header repeats on every page.
- Numbers that compare are charts: a table inside `<figure data-chart="bar">`
  (or `line`, `donut`, `stat`); see `design-canvas`.
- Real text only: missing facts are visible placeholders like [DATE].
- A cover is the first block: kicker, a big title, who it is for, the date. No
  header prints on page 1.

## Archetypes

**report**: cover, a one-paragraph summary up front, numbered sections with
`h2`, a chart or stat row where the numbers are, tables for detail, next steps
at the end.

**guide**: a short intro, then steps or topics with `h2`/`h3`, lists for
what to bring or do, a quick-reference table at the end.

**cheat sheet**: one or two pages, dense but tidy: a two- or three-column grid
of small sections, each a heading and a short list; no cover.

```html
<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px">
  <section data-kd-keep style="padding: 16px; border: var(--ds-border-w) solid var(--ds-hairline); border-radius: var(--ds-radius-m)">
    <h3 style="margin: 0 0 8px; font: 400 20px/1.1 var(--ds-font-display)">Keyboard</h3>
    <ul style="margin: 0; padding-left: 1.1em; font-size: 14px; line-height: 1.5"><li>Ctrl+K opens search</li><li>Ctrl+/ shows all shortcuts</li></ul>
  </section>
</div>
```

**one-pager**: a headline that states the point, three short blocks (problem,
answer, proof), one call to action. If it must be one page exactly, use the
`print` format instead.

**proposal**: cover, the problem in the reader's words, the plan, scope as a
table, timeline, price as a table, terms, how to say yes.

**resume**: no cover; name large, contact on one line, then experience,
education and skills, each entry a heading line (role, place, dates) and two
or three result bullets. One or two pages.

**worksheet**: a title and instructions, numbered questions, real answer
space (bordered boxes with a set `min-height`, or lines), an answer key after
a page break if asked.

**certificate**: one page, landscape feel inside the portrait page or use the
`print` format landscape: the award in display type, the name very large, the
reason, date and signature lines.

## Cover skeleton

```html
<header style="padding: 160px 0 96px; border-bottom: 3px solid var(--ds-accent)">
  <p style="margin: 0; color: var(--ds-accent-text); font-size: 14px; letter-spacing: .14em; text-transform: uppercase">PSA Soccer, Spring 2026</p>
  <h1 style="margin: 16px 0 24px; font: 400 64px/1.02 var(--ds-font-display)">Week 1 Coaching Guide</h1>
  <p style="margin: 0; color: var(--ds-text-dim); font-size: 18px">For volunteer coaches. Updated [DATE].</p>
</header>
<div data-kd-page-break></div>
<h2 style="font: 400 32px/1.1 var(--ds-font-display); margin: 0 0 12px">What this week is for</h2>
<p style="font-size: 16px; line-height: 1.6">...</p>
```

## Notes

- PDF needs the Kairos desktop app (it prints the pages); Word and the
  offline HTML zip work everywhere. If PDF says it needs the desktop app, offer
  Word and give the design link.
- Never write a ReportLab or HTML-to-PDF script for a designed document; the
  canvas gives it a look, checks it, and keeps it editable.

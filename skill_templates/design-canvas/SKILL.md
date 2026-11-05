---
name: design-canvas
description: Design screens, pages, posters, slides, documents and PDFs, and social posts on Kairos's Design canvas with the design_* tools, in a look chosen for the brief, the same way on every model.
metadata:
  version: "1.1.0"
---

# Design canvas

A design is a canvas of boards. Each board is one plain HTML fragment (no
`<html>`, `<head>`, `<body>` or scripts) styled by its look's `--ds-*`
variables. Kairos gives every element a short id (`data-kd="btn7"`); edits
address elements by those ids. For deeper UI and UX guidance read
`ui-ux-pro-max` and call `ui_design`.

## Pictures

Use the person's own photos first: add them to the design's assets and use
`image_treat` with the look's `image_treatment`. Next use `image_generate`
when an image connection exists. Otherwise `image_search` for an openly
licensed photo: search, pick one, call it again with `use` set to its id,
and put the returned credit line on the board in small type.
Use `image_pattern` with the look's `pattern` for backgrounds and textures.
A type-led layout is always fine.

For an `image_generate` prompt, name the subject, setting, light, framing and
lens, and mood. The look's imagery style is added automatically. Never ask
for text in the picture; set type in HTML on top.

Place the returned path in `<img src="assets/...">` with real `alt` text and
`object-fit: cover` in a sized frame. Text over a photo gets a scrim, a
gradient from the look's `--ds-bg`, so contrast holds.
Never draw people, objects or scenes with SVG or CSS.

## Direction first: pick a look for this brief

Nothing is built before the look is chosen. Two different briefs should never
look like the same template.

1. Call `creative_direction` with the person's request (`brief`) and what you are
   making (`type`). It returns three directions: a look, its palette and type,
   a layout and an imagery plan.
2. Pick the one that fits the subject and audience best. Say which in one line
   of your reply ("Sport look: condensed capitals and volt green, for a kids'
   league that wants energy").
3. Pass it as `look` to `design_create`. Without a look, design_create creates
   nothing and returns the three directions.

The Kairos look (parchment, bistre, gold) is only for work about Kairos itself,
or when the person asks for it. If the person names colours, fonts or a brand,
pick the closest look and change only those tokens with `design_tokens`.

## A style from the person's own references

When the person attaches photos, screenshots, a PDF, a PowerPoint or a Word
file and wants their own style ("make a style from our brand deck"), use
`design_style_from_references`:

1. Call it with a `name` and the attachments' file names as `references`.
   Kairos reads them on this computer and returns a draft: every colour role
   with its value, the fonts (bundled families only; a reference's own font is
   matched, never copied) and what it changed so text stays readable.
2. If you can see the images, check the draft against them; change roles,
   fonts or buttons with `draft` + `adjust` if the person wants.
3. Save with `draft` + `save: true`. It asks the person; the style is theirs
   and private until an admin shares it. Then use it: `design_create`
   `look="<style id>"`. The reference files themselves are not kept.

The person can also do this in Tool Store > Design systems > New style from
references. A brief that names one of their styles gets it first from
`creative_direction`.

## Formats: pick one from the request

Every board is made in a named format, at that format's own size. Read what
the person asked for and pick the format; never invent a width or height.

| Request | format | orientation | size |
|---|---|---|---|
| website, landing page, web page, homepage | `website` | (none) | `pair` (default: desktop 1440 wide AND mobile 390 wide), or `desktop` / `mobile` |
| app, app screens, onboarding, mobile UI | `app` | `portrait` (or `landscape`) | `phone` 390x844 (default) or `tablet` 820x1180 |
| poster, flyer, print ad | `poster` | `portrait` or `landscape` | `2:3` (default), `3:4`, `a-series`, `18x24`, `11x17` |
| slides, deck, presentation | `slides` | `landscape` | `16:9` 1920x1080, one board per slide |
| Instagram or social post, story | `social` | `square` 1:1, `portrait` 4:5, `landscape` 1.91:1 | `post` (default) or `story` 9:16 |
| document or PDF of one or more pages: report, guide, proposal, handout, worksheet, cheat sheet | `document` | (none) | `letter` (default) or `a4`; pages flow (read `pdf-document`) |
| exactly one printed page: one-pager, flyer, certificate, one-page resume | `print` | `portrait` or `landscape` | `letter` (default) or `a4` |
| web banner, ad unit, cover image | `banner` | `landscape` | `header` 3:1 (default), `leaderboard`, `billboard`, `linkedin`, `skyscraper` |
| email, newsletter | `email` | (none) | 600 wide |
| exact pixel sizes the person gave | `custom` | (none) | pass `w` and `h` |

- A website is always a pair: each page gets a desktop board and a mobile
  board. Pass the desktop HTML as `html` and the mobile HTML as
  `mobile_html` (without it the mobile board starts as a copy to rework).
- Website, email and document boards are a fixed width and grow with their
  content. Never set their height; write the page and it becomes as tall as it is.
  A document prints on real Letter or A4 pages with a running header and page
  numbers; read `pdf-document` before making one.
- `custom` only when the person named exact dimensions.

## Workflow

1. `creative_direction`, then `design_create` with the look and the first board
   (or the first page's pair): `{title, look, boards: [{title, format, orientation, size?, html, mobile_html?}]}`.
2. Add the other boards one at a time with `design_add_board` (same fields).
   The person watches the design build beside the chat as you go.
3. Put the design link the tool returns in your reply.
4. Read the notes every call returns: they flag type below the format's floor,
   empty placeholder boxes, grey bars standing in for text, low contrast and a
   mostly blank board. Fix each with `design_edit` before you hand over.
   `design_snapshot` shows a board as an image if you can read images.
5. Change things with `design_edit`, never by recreating the design or
   rewriting a board. One call may carry up to 20 operations on one board.
6. Rename, duplicate, delete, reorder or move boards: `design_boards`.
   Colours and type for the whole design, or another look: `design_tokens`.
   Comments the user pinned: `design_comments`.
7. Files: `design_export` with `html` (offline zip), `png`, `pdf`, `pptx` or
   `docx` (Word, document boards). PPTX is editable: every slide (or poster,
   social or print board) becomes real PowerPoint text boxes, shapes, pictures
   and charts, so write slide text
   as text (never inside an image) and charts as tables (below). Add
   `pptx_mode: "pictures"` only when the person wants exact picture slides, and
   `fonts: "design"` when they have the look's fonts installed. The export
   notes flag any text that may overflow in PowerPoint; shorten it and export
   again.

## design_edit operations

```
{"op": "set_text",  "id": "h2", "text": "Welcome back"}
{"op": "set_style", "id": "btn7", "style": {"width": "100%"}}
{"op": "set_attr",  "id": "img1", "name": "alt", "value": "A calm sunrise"}
{"op": "replace",   "id": "card3", "html": "<div ...>...</div>"}
{"op": "insert",    "ref_id": "list1", "position": "last_child", "html": "<li>New</li>"}
{"op": "remove",    "id": "p4"}
{"op": "move",      "id": "btn8", "ref_id": "btn7", "position": "before"}
{"op": "replace_text", "find": "exact text", "replace": "new text"}
```

`position` is `before`, `after`, `first_child` or `last_child`. A failed call
changes nothing and says what is valid; read it and try again.

## Rules

- Colours, fonts, sizes and spacing come from variables, the same names in
  every look: `var(--ds-bg)`, `var(--ds-surface)`, `var(--ds-surface-2)`,
  `var(--ds-text)`, `var(--ds-text-dim)`, `var(--ds-accent)`,
  `var(--ds-accent-text)`, `var(--ds-on-accent)`, `var(--ds-accent-2)`,
  `var(--ds-hairline)`, `var(--ds-danger)`, `var(--ds-success)`,
  `var(--ds-font-display)` (headlines), `var(--ds-font-sans)` (everything else),
  `var(--ds-font-mono)`, `var(--ds-size-1..7)`, `var(--ds-space-1..8)`,
  `var(--ds-radius-s|m|l|pill)`, `var(--ds-border-w)`, `var(--ds-shadow-1|2)`.
  No raw hex colours. `design_tokens` lists the values and the look's guide.
- Follow the look's guide (`design_tokens` shows it): its headline weight and
  case, its button style, its one accent moment. Copy its components
  (button.primary, button.secondary, card, list.row, nav.bar, tab.bar, input,
  kicker, headline) from `design_outline` instead of inventing structure.
- Text on an accent fill uses `var(--ds-on-accent)`. Elsewhere text uses
  `--ds-text` or `--ds-text-dim`; labels and links `--ds-accent-text`.
- Type floors, in px at the board's size: slides 24, social 22, posters 20,
  documents 13, everything else 12. Headlines on posters and slides are big:
  96 to 220px.
- One idea per slide: a headline that says the point and at most a few short
  lines. More than about 60 words is a document on a slide; split it.
- Real, readable text: no lorem ipsum, no grey bars standing in for text, no
  empty boxes standing in for images. Missing facts become visible
  placeholders like [DATE]. Buttons and tap targets at least 44px tall.
- Images: only the design's own `assets/...` files or `data:image/...` URLs.
  No external links, fonts, iframes, forms or event handlers; they are removed.
  With no image, use type, colour blocks, numbers or simple shapes as the
  visual, never an empty frame.
- Click-through without scripts: `data-kd-goto="<board slug>"` opens a board,
  `data-kd-goto="back"` goes back, `data-kd-goto-mode="overlay"` opens it as an
  overlay, and `data-kd-toggle="<element id>"` shows or hides an element.

## Charts: write the numbers, Kairos draws them

Never draw a chart by hand with divs or SVG. Put a plain table in a figure and
name the chart; every save draws it in the look's colours (bar, line, donut)
or as big numbers (stat), and the PowerPoint export makes it a native chart.

```html
<figure data-chart="bar" style="margin: 0">
  <figcaption style="font-size: 28px; margin-bottom: 16px">Signups by month</figcaption>
  <table><thead><tr><th>Month</th><th>Signups</th><th>Churn</th></tr></thead>
    <tbody><tr><td>Jan</td><td>700</td><td>80</td></tr><tr><td>Feb</td><td>1,500</td><td>95</td></tr></tbody></table>
</figure>
```

- The first column is the labels; each other column is a series (up to six).
  Numbers may be written 1,500, 1.5k, $2.4M or 45%.
- `data-chart="bar"` (add `data-orient="horizontal"` for bars across), `line`,
  `donut` (the first number column, as shares), `stat` (each row a big number:
  label, then the value as written).
- The chart is as wide as its figure; size the figure, not the drawing. Edit the
  table to change the chart.

## Layout skeletons

`creative_direction` names one or two of these for the brief. Copy the shape,
then fill it with the real content; every one uses only tokens.

**poster-stack** (poster, social): a kicker, a huge headline, one block of facts, a call to action.

```html
<main style="display: flex; flex-direction: column; width: 100%; height: 100%; padding: 96px 88px; gap: 40px; background: var(--ds-bg); color: var(--ds-text); font-family: var(--ds-font-sans)">
  <p style="margin: 0; color: var(--ds-accent-text); font-size: 28px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase">Kicker</p>
  <h1 style="margin: 0; font: 400 200px/0.9 var(--ds-font-display)">Big<br>headline</h1>
  <div style="flex: 1"></div>
  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; padding-top: 32px; border-top: var(--ds-border-w) solid var(--ds-hairline)">
    <div><p style="margin: 0; color: var(--ds-text-dim); font-size: 22px">When</p><p style="margin: 6px 0 0; font-size: 34px; font-weight: 600">[DATE]</p></div>
    <div><p style="margin: 0; color: var(--ds-text-dim); font-size: 22px">Where</p><p style="margin: 6px 0 0; font-size: 34px; font-weight: 600">[PLACE]</p></div>
    <div><p style="margin: 0; color: var(--ds-text-dim); font-size: 22px">Who</p><p style="margin: 6px 0 0; font-size: 34px; font-weight: 600">Ages 8 to 10</p></div>
  </div>
  <p style="margin: 0; padding: 28px 36px; background: var(--ds-accent); color: var(--ds-on-accent); font-size: 40px; font-weight: 700">Sign up at [LINK]</p>
</main>
```

**big-number** (poster, slides, social): one figure carries the board.

```html
<section style="display: grid; align-content: center; width: 1920px; height: 1080px; padding: 0 160px; gap: 24px; background: var(--ds-bg); color: var(--ds-text)">
  <p style="margin: 0; color: var(--ds-accent-text); font-size: 32px; letter-spacing: .1em; text-transform: uppercase">The problem</p>
  <p style="margin: 0; font: 400 360px/0.85 var(--ds-font-display); color: var(--ds-accent)">3 hrs</p>
  <p style="margin: 0; max-width: 1100px; font-size: 48px; line-height: 1.2">a week, every freelancer, chasing unpaid invoices.</p>
</section>
```

**slide-title** (slides): the opening or a section slide.

```html
<section style="display: flex; flex-direction: column; justify-content: flex-end; width: 1920px; height: 1080px; padding: 140px 160px; background: var(--ds-bg); color: var(--ds-text)">
  <p style="margin: 0 0 32px; color: var(--ds-accent-text); font-size: 30px; letter-spacing: .12em; text-transform: uppercase">Section 01</p>
  <h1 style="margin: 0; max-width: 1400px; font: 400 150px/0.95 var(--ds-font-display)">One idea per slide</h1>
  <div style="width: 160px; height: 8px; margin-top: 56px; background: var(--ds-accent)" aria-hidden="true"></div>
</section>
```

**comparison** (slides, website, screen): two or three columns side by side.

```html
<section style="display: grid; grid-template-columns: 1fr 1fr; gap: 48px; width: 1920px; height: 1080px; padding: 140px 160px; background: var(--ds-bg); color: var(--ds-text)">
  <div style="padding: 56px; border: var(--ds-border-w) solid var(--ds-hairline); border-radius: var(--ds-radius-l); background: var(--ds-surface)">
    <p style="margin: 0; color: var(--ds-text-dim); font-size: 30px">Before</p>
    <p style="margin: 20px 0 0; font: 400 72px/1.05 var(--ds-font-display)">Spreadsheets and reminders by hand</p>
  </div>
  <div style="padding: 56px; border-radius: var(--ds-radius-l); background: var(--ds-accent); color: var(--ds-on-accent)">
    <p style="margin: 0; font-size: 30px">After</p>
    <p style="margin: 20px 0 0; font: 400 72px/1.05 var(--ds-font-display)">Invoices out in 30 seconds</p>
  </div>
</section>
```

**timeline** (slides, print): steps or a schedule left to right.

```html
<section style="display: grid; align-content: center; gap: 64px; width: 1920px; height: 1080px; padding: 0 160px; background: var(--ds-bg); color: var(--ds-text)">
  <h2 style="margin: 0; font: 400 96px/1 var(--ds-font-display)">Eight Saturdays</h2>
  <ol style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 32px; margin: 0; padding: 0; list-style: none; border-top: var(--ds-border-w) solid var(--ds-hairline)">
    <li style="padding-top: 28px"><p style="margin: 0; color: var(--ds-accent-text); font-size: 28px">Weeks 1-2</p><p style="margin: 8px 0 0; font-size: 40px">First touch</p></li>
    <li style="padding-top: 28px"><p style="margin: 0; color: var(--ds-accent-text); font-size: 28px">Weeks 3-4</p><p style="margin: 8px 0 0; font-size: 40px">Passing</p></li>
    <li style="padding-top: 28px"><p style="margin: 0; color: var(--ds-accent-text); font-size: 28px">Weeks 5-6</p><p style="margin: 8px 0 0; font-size: 40px">Teamwork</p></li>
    <li style="padding-top: 28px"><p style="margin: 0; color: var(--ds-accent-text); font-size: 28px">Weeks 7-8</p><p style="margin: 8px 0 0; font-size: 40px">Game day</p></li>
  </ol>
</section>
```

**quote** (slides, social, print): one sentence, large, with who said it.

```html
<section style="display: grid; align-content: center; width: 1920px; height: 1080px; padding: 0 220px; background: var(--ds-surface); color: var(--ds-text)">
  <p style="margin: 0; font: 400 96px/1.1 var(--ds-font-display)">"The domain was his long before it was theirs."</p>
  <p style="margin: 48px 0 0; color: var(--ds-text-dim); font-size: 34px">Defense theory of the case</p>
</section>
```

**Slides: ten archetypes.** A deck mixes them; never ten of the same. The
skeletons above cover **slide-title** (also the **section** divider: same shape,
a section number as the kicker), **big-number**, **comparison**, **timeline**
and **quote**. The other five:

**big-statement** (slides): one sentence fills the slide.

```html
<section style="display: grid; align-content: center; width: 1920px; height: 1080px; padding: 0 200px; background: var(--ds-accent); color: var(--ds-on-accent)">
  <p style="margin: 0; font: 400 120px/1.02 var(--ds-font-display)">Late payments are a design problem, not a people problem.</p>
</section>
```

**image-led** (slides): a full-height picture from the design's assets beside a short point.

```html
<section style="display: grid; grid-template-columns: 1.2fr 1fr; width: 1920px; height: 1080px; background: var(--ds-bg); color: var(--ds-text)">
  <img src="assets/..." alt="Coach and players at the first session" style="width: 100%; height: 1080px; object-fit: cover; display: block">
  <div style="display: grid; align-content: center; padding: 0 120px; gap: 32px"><h2 style="margin: 0; font: 400 96px/1 var(--ds-font-display)">Every Saturday</h2>
  <p style="margin: 0; color: var(--ds-text-dim); font-size: 36px; line-height: 1.35">Small groups, certified coaches, one ball per player.</p></div>
</section>
```

**two-column** (slides): a point on the left, its three supports on the right.

```html
<section style="display: grid; grid-template-columns: 1fr 1fr; gap: 120px; align-items: center; width: 1920px; height: 1080px; padding: 0 160px; background: var(--ds-bg); color: var(--ds-text)">
  <h2 style="margin: 0; font: 400 104px/1 var(--ds-font-display)">Why studios switch</h2>
  <ul style="margin: 0; padding-left: 1.2em; font-size: 40px; line-height: 1.5"><li>Invoices go out the day the work ships</li><li>Reminders chase late payers</li><li>Card and bank in one place</li></ul>
</section>
```

**chart** (slides): the finding as the headline, the chart as the proof.

```html
<section style="display: grid; grid-template-columns: 1fr 1.3fr; gap: 96px; align-items: center; width: 1920px; height: 1080px; padding: 0 140px; background: var(--ds-bg); color: var(--ds-text)">
  <div><h2 style="margin: 0; font: 400 96px/1 var(--ds-font-display)">Signups tripled</h2><p style="margin: 32px 0 0; color: var(--ds-text-dim); font-size: 36px">From 700 in January to 2,100 in March.</p></div>
  <figure data-chart="bar" style="margin: 0"><table><thead><tr><th>Month</th><th>Signups</th></tr></thead><tbody><tr><td>Jan</td><td>700</td></tr><tr><td>Feb</td><td>1,500</td></tr><tr><td>Mar</td><td>2,100</td></tr></tbody></table></figure>
</section>
```

**closing** (slides): the ask, and how to act on it.

```html
<section style="display: grid; align-content: center; justify-items: start; gap: 48px; width: 1920px; height: 1080px; padding: 0 160px; background: var(--ds-bg); color: var(--ds-text)">
  <h2 style="margin: 0; font: 400 140px/0.95 var(--ds-font-display)">Raising $2M to reach 5,000 studios</h2>
  <p style="margin: 0; padding: 24px 48px; border-radius: var(--ds-radius-pill); background: var(--ds-accent); color: var(--ds-on-accent); font-size: 40px">[EMAIL]</p>
</section>
```

**hero-split** (website desktop, banner): headline and action on one side, the product or picture on the other.

```html
<section style="display: grid; grid-template-columns: 1.1fr 1fr; gap: var(--ds-space-8); align-items: center; min-height: 900px; padding: var(--ds-space-8); background: var(--ds-bg); color: var(--ds-text)">
  <div><p style="margin: 0 0 var(--ds-space-4); color: var(--ds-accent-text); font-size: var(--ds-size-3); letter-spacing: .1em; text-transform: uppercase">For freelancers</p>
  <h1 style="margin: 0 0 var(--ds-space-5); font: 400 88px/0.98 var(--ds-font-display)">Get paid without the paperwork</h1>
  <p style="margin: 0 0 var(--ds-space-6); color: var(--ds-text-dim); font-size: var(--ds-size-4); line-height: 1.5">Send an invoice in 30 seconds. Ledgerly chases it for you.</p>
  <button style="min-height: 56px; padding: 0 var(--ds-space-6); border: 0; border-radius: var(--ds-radius-m); background: var(--ds-accent); color: var(--ds-on-accent); font-size: var(--ds-size-4); font-weight: 600">Start free</button></div>
  <div style="padding: var(--ds-space-6); border: var(--ds-border-w) solid var(--ds-hairline); border-radius: var(--ds-radius-l); background: var(--ds-surface)">
    <p style="margin: 0; color: var(--ds-text-dim)">Invoice #0042</p><p style="margin: var(--ds-space-3) 0 0; font: 400 64px/1 var(--ds-font-display)">$1,800.00</p>
    <p style="margin: var(--ds-space-4) 0 0; color: var(--ds-success); font-weight: 600">Paid by card, 2 days early</p></div>
</section>
```

**bento** (screen, website): a grid of cards of different sizes, each with real content.

```html
<main style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--ds-space-3); min-height: 844px; padding: var(--ds-space-6) var(--ds-space-4); background: var(--ds-bg); color: var(--ds-text); font-family: var(--ds-font-sans)">
  <h1 style="grid-column: 1 / -1; margin: 0 0 var(--ds-space-2); font: 400 var(--ds-size-6)/1.05 var(--ds-font-display)">Saturday, 9 AM</h1>
  <div style="grid-column: 1 / -1; padding: var(--ds-space-5); border-radius: var(--ds-radius-l); background: var(--ds-accent); color: var(--ds-on-accent)"><p style="margin: 0; font-size: var(--ds-size-2)">Next session</p><p style="margin: var(--ds-space-2) 0 0; font-size: var(--ds-size-5); font-weight: 700">First touch drills</p></div>
  <div style="padding: var(--ds-space-4); border: var(--ds-border-w) solid var(--ds-hairline); border-radius: var(--ds-radius-m); background: var(--ds-surface)"><p style="margin: 0; color: var(--ds-text-dim); font-size: var(--ds-size-2)">Players</p><p style="margin: var(--ds-space-1) 0 0; font-size: var(--ds-size-6)">14</p></div>
  <div style="padding: var(--ds-space-4); border: var(--ds-border-w) solid var(--ds-hairline); border-radius: var(--ds-radius-m); background: var(--ds-surface)"><p style="margin: 0; color: var(--ds-text-dim); font-size: var(--ds-size-2)">Week</p><p style="margin: var(--ds-space-1) 0 0; font-size: var(--ds-size-6)">1 of 8</p></div>
</main>
```

**editorial-column** (print, email, website): a narrow reading column under a strong headline.

```html
<article style="display: grid; justify-items: center; padding: 72px 64px; background: var(--ds-bg); color: var(--ds-text)">
  <div style="width: 100%; max-width: 640px">
    <p style="margin: 0; color: var(--ds-accent-text); font-size: 14px; letter-spacing: .14em; text-transform: uppercase">Parent and player guide</p>
    <h1 style="margin: 12px 0 20px; font: 400 56px/1.02 var(--ds-font-display)">Welcome to camp</h1>
    <p style="margin: 0 0 16px; font-size: 17px; line-height: 1.65">Eight Saturdays of first touch, passing and teamwork, coached by certified coaches.</p>
    <hr style="margin: 32px 0; border: 0; border-top: var(--ds-border-w) solid var(--ds-hairline)">
  </div>
</article>
```

**grid-12** (poster, print, website): content locked to a twelve-column grid; headline spans eight, facts four.

```html
<main style="display: grid; grid-template-columns: repeat(12, 1fr); column-gap: 24px; align-content: start; width: 100%; height: 100%; padding: 80px; background: var(--ds-bg); color: var(--ds-text)">
  <h1 style="grid-column: 1 / 9; margin: 0; font: 800 150px/0.9 var(--ds-font-display)">Annual report</h1>
  <div style="grid-column: 10 / 13; align-self: end; border-top: var(--ds-border-w) solid var(--ds-hairline); padding-top: 16px; font-size: 22px">2026<br>Engineering</div>
</main>
```

**app screen** (app): status, title, the main content, one action at the bottom.

```html
<main style="display: flex; flex-direction: column; min-height: 844px; padding: var(--ds-space-7) var(--ds-space-5) var(--ds-space-6); background: var(--ds-bg); color: var(--ds-text); font-family: var(--ds-font-sans)">
  <p style="margin: 0; color: var(--ds-text-dim); font-size: var(--ds-size-2)">Step 1 of 3</p>
  <h1 style="margin: var(--ds-space-3) 0; font: 400 var(--ds-size-7)/1.02 var(--ds-font-display)">Build a habit that lasts</h1>
  <p style="margin: 0; color: var(--ds-text-dim); font-size: var(--ds-size-3)">One small step every day.</p>
  <div style="flex: 1"></div>
  <button data-kd-goto="screen-2" style="min-height: 52px; border: 0; border-radius: var(--ds-radius-m); background: var(--ds-accent); color: var(--ds-on-accent); font-size: var(--ds-size-3); font-weight: 600">Continue</button>
</main>
```

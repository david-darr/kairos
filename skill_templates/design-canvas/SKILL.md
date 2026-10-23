---
name: design-canvas
description: Design screens, pages and slides on Kairos's Design canvas with the design_* tools, the same way on every model.
---

# Design canvas

A design is a canvas of boards. Each board is one plain HTML fragment (no
`<html>`, `<head>`, `<body>` or scripts) styled by the design system's
`--ds-*` variables. Kairos gives every element a short id (`data-kd="btn7"`);
edits address elements by those ids. For visual direction first, read
`ui-ux-pro-max` and call `ui_design` (action `design_system` for a new look).

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
| letter, one-pager, resume, printed page | `print` | `portrait` or `landscape` | `letter` (default) or `a4` |
| web banner, ad unit, cover image | `banner` | `landscape` | `header` 3:1 (default), `leaderboard`, `billboard`, `linkedin`, `skyscraper` |
| email, newsletter | `email` | (none) | 600 wide |
| exact pixel sizes the person gave | `custom` | (none) | pass `w` and `h` |

- A website is always a pair: each page gets a desktop board and a mobile
  board. Pass the desktop HTML as `html` and the mobile HTML as
  `mobile_html` (without it the mobile board starts as a copy to rework).
- Website and email boards are a fixed width and grow with their content.
  Never set their height; write the page and it becomes as tall as it is.
- `custom` only when the person named exact dimensions.

## Workflow

1. `design_create` with the first board (or the first page's pair):
   `{title, format, orientation, size?, html, mobile_html?}`.
2. Add the other boards one at a time with `design_add_board` (same fields).
   The person watches the design build beside the chat as you go.
3. Put the design link the tool returns in your reply.
4. Check your work: `design_outline` (text) and the lint notes in each result;
   `design_snapshot` shows a board as an image if you can read images.
5. Change things with `design_edit`, never by recreating the design or
   rewriting a board. One call may carry up to 20 operations on one board.
6. Rename, duplicate, delete, reorder or move boards: `design_boards`.
   Boards sit in rows by format; `resize` keeps a fixed format's ratio and
   changes a website board's height only. Colours and type for the whole
   design: `design_tokens`. Comments the user pinned: `design_comments`.
7. Files: `design_export` with `html` (offline zip), `png`, `pdf` or `pptx`.

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

- Colours, fonts, sizes and spacing come from variables: `var(--ds-bg)`,
  `var(--ds-surface)`, `var(--ds-text)`, `var(--ds-text-dim)`,
  `var(--ds-accent)`, `var(--ds-accent-text)`, `var(--ds-danger)`,
  `var(--ds-success)`, `var(--ds-hairline)`, `var(--ds-font-sans)`,
  `var(--ds-size-1..7)`, `var(--ds-space-1..8)`, `var(--ds-radius-s|m|l|pill)`,
  `var(--ds-shadow-1|2)`. No raw hex colours. `design_tokens` lists values.
- Keep the design system's look. Change tokens with `design_tokens` only when the
  person asks for a different look or palette; otherwise style with the
  system's variables as they are (the default system is Kairos's own brand).
- The accent is for hairlines, icons and one point of emphasis, never text.
  Text uses `--ds-text`, links `--ds-accent-text`.
- Real, readable text. Buttons and tap targets at least 44px tall.
- Click-through without scripts: `data-kd-goto="<board slug>"` opens a board,
  `data-kd-goto="back"` goes back, `data-kd-goto-mode="overlay"` opens it as an
  overlay, and `data-kd-toggle="<element id>"` shows or hides an element.
- Images: only the design's own `assets/...` files or `data:image/...` URLs.
  No external links, fonts, iframes, forms or event handlers; they are removed.
- Copy the system's components (button.primary, card, list.row, nav.bar,
  tab.bar, input) from `design_outline` instead of inventing structure.

## Skeletons

App phone screen (format app, orientation portrait):

```html
<main style="display: flex; flex-direction: column; min-height: 844px; padding: var(--ds-space-7) var(--ds-space-5) var(--ds-space-6); background: var(--ds-bg); color: var(--ds-text); font-family: var(--ds-font-sans)">
  <p style="margin: 0; color: var(--ds-text-dim); font-size: var(--ds-size-2)">Step 1 of 3</p>
  <h1 style="margin: var(--ds-space-3) 0; font-size: var(--ds-size-6); font-weight: 500">Build a habit that lasts</h1>
  <p style="margin: 0; color: var(--ds-text-dim); font-size: var(--ds-size-3)">One small step every day.</p>
  <div style="flex: 1"></div>
  <button data-kd-goto="screen-2" style="min-height: 52px; border: 0; border-radius: var(--ds-radius-pill); background: var(--ds-text); color: var(--ds-bg); font-size: var(--ds-size-3)">Continue</button>
</main>
```

Website desktop section (format website; its mobile pair stacks the columns):

```html
<section style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--ds-space-7); align-items: center; min-height: 900px; padding: var(--ds-space-8); background: var(--ds-bg); color: var(--ds-text)">
  <div><h1 style="margin: 0 0 var(--ds-space-4); font-size: var(--ds-size-7); font-weight: 500">Headline</h1>
  <p style="margin: 0 0 var(--ds-space-6); color: var(--ds-text-dim); font-size: var(--ds-size-4)">Supporting line.</p>
  <button style="min-height: 52px; padding: 0 var(--ds-space-6); border: 0; border-radius: var(--ds-radius-pill); background: var(--ds-text); color: var(--ds-bg)">Get started</button></div>
  <div style="aspect-ratio: 4 / 3; border: 1px solid var(--ds-hairline); border-radius: var(--ds-radius-l); background: var(--ds-surface)"></div>
</section>
```

Slide (format slides, orientation landscape):

```html
<section style="display: flex; flex-direction: column; justify-content: center; width: 1920px; height: 1080px; padding: 0 160px; background: var(--ds-bg); color: var(--ds-text)">
  <p style="margin: 0 0 var(--ds-space-4); color: var(--ds-accent-text); font-size: 28px">Section</p>
  <h1 style="margin: 0; font-size: 96px; font-weight: 500; line-height: 1.05">One idea per slide</h1>
</section>
```

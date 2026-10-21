---
name: ui-ux-pro-max
description: Design, build, refine and review UI/UX for web, mobile and desktop interfaces using local design intelligence, accessibility and interaction guidance.
---

# UI/UX Pro Max for Kairos

Use this built-in skill whenever work changes an interface's layout, visual
design, interaction, navigation, responsive behavior, accessibility or usability.
This includes Kairos, Forge projects, user-built tabs, bots' UI work and game UI.
Pure backend, infrastructure and nonvisual scripts do not need it.

## Start from the actual product

Read the user's reference and the existing interface, stack, branding and design
tokens. Preserve their chosen direction. A recommendation from the catalog does
not authorize a new theme, framework, package, external action or unrelated work.
Do not assume Tailwind or another stack when the project uses plain HTML/CSS.

## Search the local design intelligence

Use the read-only `ui_design` tool. It works with every connected model, without
shell access, external services, installation commands or private-data queries.

- New product or new visual system: `action=design_system`, with a concise
  product/platform/style query. Fit recommendations to the existing constraints.
- A targeted change: `action=search`, one explicit `domain` and 2–5 relevant
  terms, such as `keyboard focus modal` or `badge label wrapping`.
- Implementation guidance: `action=search` with the detected `stack`.
  Omit stack guidance when no supported stack accurately matches the project.

Domains: `style`, `product`, `color`, `typography`, `google-fonts`, `chart`,
`landing`, `ux`, `icons`, `gsap`, `react`, `web`.

Check that the returned results fit the task. Retry once with a narrower query
if needed; report an empty/off-topic result honestly and use general guidance
as a labeled fallback. Never invent search matches or metrics.

The tool does not persist recommendations. Read any existing project design
system first. Saving design decisions or replacing an existing design system
uses the normal project editing tools and the user's authorization.

## Build and verify

Use clear hierarchy, restrained copy, coherent spacing and real information.
Use existing icons and assets; preserve meaningful empty, loading, failure,
disabled and permission states. Match reference structure without copying its
unrelated branding, browser chrome, placeholder text or unsupported behavior.

Read `references/quick-reference.md` for the relevant UX rules and
`references/pro-rules.md` for the delivery checklist. Prioritize keyboard/focus
access, readable contrast, touch targets, text reflow, honest status indicators
and reduced motion. Adapt guidance to the platform and actual user needs.

Verify actual controls and data flow, not only a screenshot. Inspect desktop
and phone renders, long content and error states; report what was tested and
any remaining limitation. Never call a decorative mockup a working feature.

## Provenance and deeper guidance

Adapted from Next Level Builder's MIT-licensed UI UX Pro Max. `LICENSE` and
`UPSTREAM.json` preserve attribution, the pinned revision and original file
hashes. `references/upstream-skill.md` contains the complete upstream workflow;
its Claude-plugin shell paths are not Kairos invocation paths. Use `ui_design`
instead. The Python helpers and searchable data ship locally with this skill.

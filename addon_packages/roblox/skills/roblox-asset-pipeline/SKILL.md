---
name: roblox-asset-pipeline
description: Turn Roblox model, material and UI references into tracked game assets using Blender, Higgsfield and native Studio. Use for asset briefs, provenance, budgets, export/import handoffs and verification, including user supplied reference images or files.
---

# Roblox asset pipeline

Read `roblox-dev-skill` and its `references/file-formats-and-assets.md`.
Use `roblox_style` action=read for model/UI defaults in this project.

## Asset brief

For each asset, establish purpose, silhouette, desired style, scale, pivot,
orientation, material palette, UV/textures, collision and animation needs.
Choose triangle and texture budgets for the target device and asset frequency;
do not apply an invented universal Roblox limit. Verify current official import
requirements when needed. Ask only for choices that materially affect the work.

Distinguish four inputs: visual reference, source 3D file, generated output,
and existing Roblox asset ID. A screenshot is not a mesh. A downloaded model
may contain scripts or unsupported materials; inspect it before use.

## Choose the connected tool

- `blender-creation`: geometry, UVs, materials, retopology, pivots and exports
  in the saved native Blender project. Discover `creative_tools` connections
  and schemas. Ask the owner to select Blender if absent; never start another
  unrestricted bridge to bypass the managed connection.
- `higgsfield-creation`: concept art, texture/UI visuals and supported 3D
  generation. Discover actual tools and supported formats. A generation can
  cost credits and always requires approval. Do not replace the user's chosen
  native Roblox workflow with a browser-game generator.
- `roblox_studio`: native procedural blockouts and installed import/insertion
  capabilities, followed by inspection and playtesting in the bound place.

## Handoff and provenance

Use `roblox_assets` action=record for each meaningful artifact. Include source,
attachment/job ID or public source page, creator and known license (or unknown),
specifications, existing relative project file, import status and actual Roblox
asset ID if available. Never retain credentials or signed download URLs.
Update the same asset_id through reference → generated → exported → imported
→ verified as those steps actually happen. These entries are reported evidence,
not automatic proof. Never label an unimported asset as verified.

Export only into the project workspace where practical; record exact filenames
and versions. Preserve source .blend files and checkpoints. Inspect exported
scale/axes, UVs/material slots, texture channels, transparent edges and collision.
In Studio verify size, pivot, appearance, performance and gameplay interaction.
Use supported import capabilities; if uploads/import are unavailable, give the
exact manual handoff and keep status exported until actual import is observed.
Never purchase, publish, upload publicly or require asset scripts without the
user's explicit request. Report licensing uncertainty and actual test coverage.

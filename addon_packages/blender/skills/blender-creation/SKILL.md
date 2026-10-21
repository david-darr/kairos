---
name: blender-creation
description: Create, inspect, refine and export 3D assets in the user's native Blender desktop app through Kairos's selected creative connection. Use for Blender modeling, materials, UVs, geometry cleanup, viewport review and game asset preparation across any Kairos workspace.
---

# Blender creation

Use `creative_tools` action=connections, then action=tools provider=blender.
The person installs Kairos's add-on from Tool Store, saves a .blend file,
pairs its local token and selects the connection for this chat or bot.
Native execution requires an administrator. Never expose the pairing token,
start an alternate bridge, change host/port through model calls, or bypass a
denial with shell/UI automation. The managed add-on is the connection contract.

## Work in the actual app

1. Inspect the connected file and scene through the current schema. Confirm
   the requested collection/object names, units, scene organization and export
   directory. The checked file identity must match the app's actual saved file.
2. Use short, scoped Blender Python edits with explicit names and predictable
   results. Preserve unrelated objects and materials. Prefer the data API when
   operators need an unavailable UI context. Do not install packages or run
   unrelated system commands as part of asset creation.
3. Each execute request shows Python for approval, even under Auto mode, and
   saves a .blend checkpoint before execution. Python has the user's native
   Blender permissions; it is not sandboxed. A checkpoint preserves Blender
   data, not unrelated filesystem side effects. Stop on a denied request.
4. Inspect after each meaningful step. Capture a viewport with the installed
   viewport tool; it needs an open 3D View. For game assets check silhouette,
   topology, UVs, materials, normal directions, transforms, scale and pivot.
5. Export in the actual requested format supported by the installed Blender
   version. Record the path and inspect the output. A successful execute call
   is not proof of a usable exported model. Do not overwrite the only source.

If the request times out, check Blender before retrying. Kairos keeps an
uncertain-operation guard; only the owner can clear it after checking results.
Never repeat generated Python automatically to recover from uncertain status.

For Roblox, read `roblox-asset-pipeline`; use its project budgets and provenance
manifest. For other workspaces, retain the same source/reference/export trail
in the project's existing files. Follow the current prompt's visual direction.

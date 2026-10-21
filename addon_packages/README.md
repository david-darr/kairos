# Optional Tool Store add-ons

Roblox Development, Blender and Higgsfield are independent first-party Store
packages. Their payloads are kept here rather than in base `skill_templates`,
`core` or `tabs`. They are available as local Store installation sources in the
desktop distribution; a fresh installation activates none of them.

Tool Store installs the selected payload into the user's `addons/<id>` folder.
Only enabled packages expose tools, API operations, project context and skills.
Blender and Higgsfield independently install the shared `_creative` runtime.
They can be selected in any chat or bot and are optional for Roblox.

Disabling/removing revokes runtime use immediately. Saved projects, encrypted
connections, private styles, edited skill files and package payload caches are
retained for reinstall. No credentials are included in packages. Installation
and lifecycle changes require an administrator. Existing explicitly enabled
Roblox and paired creative setups migrate once; automatically seeded skills
alone do not count as an installation request.

After editing a payload, run `python scripts/build_addon_manifests.py` and
commit its updated `addon.json` hashes alongside the change. Runtime imports
and served files verify those hashes, including prebuilt tab source. Packages
are first-party distribution assets; this is not an arbitrary Python plugin
upload mechanism or a publication to the online community catalog.

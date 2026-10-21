def __getattr__(name):
    # Compatibility for tab API v1 and existing integrations. Optional code is
    # loaded from an installed Tool Store package, never from base app modules.
    if name in {'roblox_workspace', 'roblox_style', 'roblox_assets', 'creative_tools'}:
        from core import addons
        return addons.module(name)
    raise AttributeError(name)

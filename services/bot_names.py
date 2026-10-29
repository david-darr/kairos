"""Friendly names offered for a new bot (Bots redesign, Phase 0, 2026-10-28).

Written fresh for Kairos: short, easy to say, easy to tell apart. `suggest`
returns the first one no bot is using, so "New bot" never opens on a clash.
"""

NAMES = (
    "Juniper", "Maple", "Pebble", "Tansy", "Wren", "Sorrel", "Fennel", "Cricket",
    "Marlow", "Basil", "Linden", "Quill", "Rowan", "Clover", "Ember", "Willow",
    "Sparrow", "Hazel", "Pip", "Nimbus", "Olive", "Birch", "Cedar", "Dune",
    "Fable", "Gable", "Heron", "Indigo", "Jasper", "Kestrel", "Lark", "Mosaic",
    "Nettle", "Orchid", "Plover", "Quince", "Reed", "Sable", "Thistle", "Umber",
    "Vesper", "Wisp", "Yarrow", "Zephyr", "Acorn", "Bramble", "Cobalt", "Dapple",
    "Elm", "Flint", "Gorse", "Harbor", "Ivy", "Juno", "Kite", "Lumen",
    "Moss", "Nova", "Opal", "Pine", "Quartz", "Ripple", "Sage", "Tamsin",
)


def suggest(taken) -> str:
    """The first name nobody has (case-insensitive); once all 64 are used, the
    first name with the lowest free number after it."""
    used = {str(name).strip().lower() for name in taken or ()}
    for name in NAMES:
        if name.lower() not in used:
            return name
    number = 2
    while True:
        for name in NAMES:
            candidate = f"{name} {number}"
            if candidate.lower() not in used:
                return candidate
        number += 1

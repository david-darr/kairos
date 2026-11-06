"""The `content_studio` package section: which imported bot is which team role (services/content_studio/team.py).

Nothing travels with an export; an import records the roles in the importing account's studio store.
"""
from services import bot_package


def export_section(bot_ids):
    return {}


def import_section(data, mapping):
    from services.content_studio import studio, team
    return team.import_roles(studio, data, mapping)


bot_package.register_section("content_studio", export_section, import_section)

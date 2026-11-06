"""Contacts — David's ask 2026-08-31 (add Contacts/CardDAV to Settings >
Integrations). No dedicated Contacts tab exists yet, so this is deliberately
minimal: a flat synced-contacts store, viewable from the Integrations panel
itself rather than a full contacts feature. Real data, honestly scoped
surface — not a stub, just not a whole new tab.
"""
from core import accounts
from core.atomic_io import read_json, write_json_atomic

# Each account's own contacts.json (Multi-Account phase 2); a test may point this at its own file.
CONTACTS_FILE = None


def contacts_file() -> str:
    return CONTACTS_FILE or accounts.path("contacts.json")


def _load() -> dict:
    return read_json(contacts_file(), {})


def list_contacts(sync_id: str | None = None) -> list[dict]:
    items = list(_load().values())
    if sync_id:
        items = [c for c in items if c.get("sync_id") == sync_id]
    return sorted(items, key=lambda c: c.get("name", ""))


def replace_synced_contacts(sync_id: str, contacts: list[dict]) -> int:
    data = _load()
    for cid, c in list(data.items()):
        if c.get("sync_id") == sync_id:
            del data[cid]
    for c in contacts:
        cid = f"{sync_id}:{c['uid']}"
        data[cid] = {"id": cid, "name": c["name"], "email": c.get("email"), "phone": c.get("phone"), "sync_id": sync_id}
    write_json_atomic(contacts_file(), data)
    return len(contacts)

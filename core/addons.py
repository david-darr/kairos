"""Optional first-party Tool Store packages, installed separately from base skills.

Payloads are trusted app distribution assets, not arbitrary executable uploads.
Only manifest-listed files are installed; their hashes bind runtime imports.
Projects, account secrets, style profiles and edited skills are never deleted.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import threading
import uuid

from core import accounts, atomic_io, settings
from core.constants import BASE_DIR, DATA_DIR

SOURCE = Path(BASE_DIR) / 'addon_packages'
ROOT = Path(DATA_DIR) / 'addons'
STATE = str(Path(DATA_DIR) / 'addons.json')
IDS = ('roblox', 'blender', 'higgsfield')
MODULES = {'roblox_workspace': 'roblox', 'roblox_style': 'roblox',
           'roblox_assets': 'roblox', 'creative_tools': '_creative'}
TOOLS = {'roblox_studio': 'roblox', 'roblox_style': 'roblox', 'roblox_assets': 'roblox',
         'creative_tools': '_creative'}
SKILLS = {'roblox-dev-skill': 'roblox', 'roblox-ui-design': 'roblox',
          'roblox-asset-pipeline': 'roblox', 'blender-creation': 'blender',
          'higgsfield-creation': 'higgsfield'}
_lock = threading.RLock()


def _load():
    return atomic_io.read_json(STATE, {'version': 1, 'packages': {}})


def _save(state):
    atomic_io.write_json_atomic(STATE, state)


def manifest(ident):
    if ident not in (*IDS, '_creative'):
        raise ValueError('Unknown add-on')
    return json.loads((SOURCE / ident / 'addon.json').read_text(encoding='utf-8'))


def enabled(ident):
    rows = _load()['packages']
    if ident == '_creative':
        return any(rows.get(p, {}).get('enabled', False) and rows.get(p, {}).get('installed', False) for p in ('blender', 'higgsfield'))
    return bool(rows.get(ident, {}).get('installed') and rows[ident].get('enabled'))


def require(ident):
    if not enabled(ident):
        raise ValueError('Install and enable this add-on in Tool Store first')


def skill_available(slug):
    return slug not in SKILLS or enabled(SKILLS[slug])


def tool_available(name):
    return name not in TOOLS or enabled(TOOLS[name])


def _safe_file(root, relative):
    from core.store_schema import safe_path
    from core.tab_folders import is_link
    safe_path(relative)
    root = Path(root).absolute()
    path = root / relative
    for part in (root, path, *path.parents):
        if is_link(str(part)):
            raise ValueError('Add-on paths cannot contain links')
    if root.resolve() not in path.resolve().parents:
        raise ValueError('Add-on path escaped its package')
    return path


def file(ident, relative):
    require(ident)
    meta = manifest(ident)
    expected = meta['files'].get(relative)
    path = _safe_file(ROOT / ident, relative)
    if not expected or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError('Add-on files changed or are missing. Reinstall from Tool Store')
    return path


def module(name):
    ident = MODULES[name]
    path = file(ident, 'runtime/' + name + '.py')
    key = 'core.' + name
    with _lock:
        cached = sys.modules.get(key)
        if cached is not None:
            if getattr(cached, '__addon_digest__', None) != manifest(ident)['files']['runtime/' + name + '.py']:
                raise ValueError('Restart Kairos to load the updated add-on')
            return cached
        spec = importlib.util.spec_from_file_location(key, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[key] = mod
        try:
            blob = path.read_bytes()
            if hashlib.sha256(blob).hexdigest() != manifest(ident)['files']['runtime/' + name + '.py']:
                raise ValueError('Add-on runtime changed during loading')
            exec(compile(blob, str(path), 'exec'), mod.__dict__)
            mod.__addon_digest__ = hashlib.sha256(blob).hexdigest()
        except BaseException:
            sys.modules.pop(key, None)
            raise
        return mod


def catalog():
    rows = _load()['packages']
    return [{**{k: v for k, v in manifest(ident).items() if k != 'files'},
             'installed': bool(rows.get(ident, {}).get('installed')),
             'enabled': enabled(ident)} for ident in IDS]


def verify_tab(slug):
    if slug != 'roblox': return True
    try:
        for relative in manifest('roblox')['files']:
            if relative.startswith('tabs/roblox/'):
                file('roblox', relative)
        return True
    except (ValueError, OSError):
        return False


def _payload(ident):
    meta = manifest(ident)
    target = ROOT / ident
    # Keep a fixed package location for the tab loader. Files are replaced
    # atomically; activation happens only after the complete payload verifies.
    for relative, digest in meta['files'].items():
        src = _safe_file(SOURCE / ident, relative)
        blob = src.read_bytes()
        if hashlib.sha256(blob).hexdigest() != digest:
            raise ValueError('Store package hash mismatch')
        dst = _safe_file(target, relative)
        dst.parent.mkdir(parents=True, exist_ok=True)
        temp = dst.with_name(dst.name + '.' + uuid.uuid4().hex + '.tmp')
        temp.write_bytes(blob); temp.replace(dst)


def change(ident, action):
    if ident not in IDS or action not in {'install', 'enable', 'disable', 'remove'}:
        raise ValueError('Choose an add-on and install, enable, disable or remove')
    with _lock:
        state = _load(); rows = state['packages']; previous = rows.get(ident, {})
        if action in {'install', 'disable', 'remove'}:
            # Do not revoke an operation partway through a native write or an
            # approval wait. Stop/finish it before changing its installation.
            creative = sys.modules.get('core.creative_tools')
            workspace = sys.modules.get('core.roblox_workspace')
            if creative and any(p == ident or (action == 'install' and ident in {'blender', 'higgsfield'}) for _, p in creative._busy):
                raise ValueError('Stop or finish the current creative request first')
            if workspace and ident == 'roblox' and any(lock.locked() for lock in workspace._studio_locks.values()):
                raise ValueError('Wait for the Studio operation to finish first')
        if action == 'enable' and not previous.get('installed'):
            raise ValueError('Install the add-on first')
        if action == 'install':
            rows[ident] = {**previous, 'enabled': False}
            _save(state)
            if ident in {'blender', 'higgsfield'}: _payload('_creative')
            _payload(ident)
            from services import skills_service, skill_curator
            for slug, owner in SKILLS.items():
                if owner != ident: continue
                src = ROOT / ident / 'skills' / slug
                dst = Path(skills_service.skills_dir()) / slug
                for source in src.rglob('*'):
                    if not source.is_file(): continue
                    target = _safe_file(dst, source.relative_to(src).as_posix())
                    if not target.exists():
                        target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(source, target)
                # Existing edited/imported skills keep their curation and source.
                if not skill_curator._load().get(slug):
                    skill_curator.record(slug, skill_curator.BUNDLED, origin='addon:' + ident)
        rows[ident] = {'installed': action != 'remove', 'enabled': action in {'install', 'enable'},
                       'version': manifest(ident)['version']}
        _save(state)
        if action in {'disable', 'remove'} and ident == 'higgsfield':
            creative = sys.modules.get('core.creative_tools')
            if creative:
                for key, pending in list(creative._pending.items()):
                    pending['task'].cancel(); creative._pending.pop(key, None)
        if ident == 'roblox':
            current = set(settings.get_setting('enabled_tab_templates') or [])
            if rows[ident]['enabled']: current.add('roblox')
            else: current.discard('roblox')
            settings.update_settings(enabled_tab_templates=sorted(current))
        result = next(row for row in catalog() if row['id'] == ident)
        result['restart_required'] = any(name in sys.modules and
            getattr(sys.modules[name], '__addon_digest__', None) != manifest(owner)['files']['runtime/' + key + '.py']
            for key, owner in MODULES.items() for name in ['core.' + key]
            if owner == ident or (ident in {'blender', 'higgsfield'} and owner == '_creative'))
        return result


def migrate():
    """Adopt existing explicit setups once, never infer intent from auto-seeded skills."""
    with _lock:
        state = _load()
        if state.get('migrated'): return
        active = set()
        if 'roblox' in (settings.get_setting('enabled_tab_templates') or []): active.add('roblox')
        connections = atomic_io.read_json(accounts.path('creative-connections.json'), {})
        for row in connections.get('accounts', {}).values():
            if row.get('token'): active.add('blender')
            if row.get('oauth'): active.add('higgsfield')
        for ident in active:
            if ident not in _load()['packages']: change(ident, 'install')
        state = _load(); state['migrated'] = True; _save(state)


def _stale(ident):
    """True when any manifest-listed installed file is missing or differs from the manifest."""
    for relative, digest in manifest(ident)['files'].items():
        path = _safe_file(ROOT / ident, relative)
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            return True
    return False


def refresh():
    """Re-install the payload of every installed package whose files no longer match the app's manifest
    (an app update changed them). Only manifest-listed files are written; projects, account secrets,
    style profiles and skills are never touched. Returns the package ids refreshed."""
    done = []
    with _lock:
        state = _load(); rows = state['packages']
        installed = [i for i in IDS if rows.get(i, {}).get('installed')]
        targets = list(installed)
        if any(i in installed for i in ('blender', 'higgsfield')): targets.append('_creative')
        for ident in targets:
            if _stale(ident):
                _payload(ident); done.append(ident)
            if ident in rows and rows[ident].get('version') != manifest(ident)['version']:
                rows[ident]['version'] = manifest(ident)['version']; _save(state)
    return done

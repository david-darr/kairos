"""Refresh the hashes of local first-party Tool Store payloads after editing.

Payload files are hashed as raw bytes and .gitattributes marks addon_packages
`-text`, so every checkout holds the exact committed (LF) bytes.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'addon_packages'
for folder in sorted(ROOT.iterdir()):
    if not (folder / 'addon.json').is_file(): continue
    meta = json.loads((folder / 'addon.json').read_text(encoding='utf-8'))
    meta['files'] = {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(folder.rglob('*')) if p.is_file() and p.name != 'addon.json'
                     and '__pycache__' not in p.parts and p.suffix != '.pyc'}
    # Bytes, not write_text: Windows text mode would write CRLF into the manifest.
    (folder / 'addon.json').write_bytes((json.dumps(meta, indent=2) + chr(10)).encode('utf-8'))

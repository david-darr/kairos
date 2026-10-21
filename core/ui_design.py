"""Read-only, offline access to the pinned UI/UX skill's local search engine."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from core.constants import BASE_DIR

ROOT = Path(BASE_DIR) / 'skill_templates' / 'ui-ux-pro-max'
DOMAINS = ('style', 'product', 'color', 'typography', 'google-fonts', 'chart',
           'landing', 'ux', 'icons', 'gsap', 'react', 'web')
STACKS = ('react', 'nextjs', 'vue', 'svelte', 'astro', 'nuxtjs', 'nuxt-ui', 'angular',
          'laravel', 'swiftui', 'react-native', 'flutter', 'jetpack-compose', 'html-tailwind',
          'shadcn', 'threejs', 'javafx', 'wpf', 'winui', 'avalonia', 'uno', 'uwp')


def _run(query, action, domain, stack, limit):
    # Execute distribution code, never a user's editable skill copy. Bytecode
    # caches and inherited Python/module configuration cannot replace it.
    provenance = json.loads((ROOT / 'UPSTREAM.json').read_text(encoding='utf-8'))
    for name, meta in provenance['files'].items():
        path = ROOT / name
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != meta['sha256']:
            raise ValueError('The bundled UI/UX search files changed; restore the trusted package before running them')
    args = [sys.executable, '-B', '-X', 'utf8', str(ROOT / 'scripts/search.py'), query, '--json', '-n', str(limit)]
    if action == 'design_system': args.append('--design-system')
    elif stack: args += ['--stack', stack]
    elif domain: args += ['--domain', domain]
    env = {key: value for key, value in os.environ.items() if key.upper() in {'SYSTEMROOT','WINDIR','PATH','TEMP','TMP','LANG','LC_ALL'}}
    env.update(PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1')
    result = subprocess.run(args, cwd=ROOT, env=env, shell=False, capture_output=True,
                            text=True, encoding='utf-8', timeout=15,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('UI/UX search failed: ' + result.stderr[-1200:])
    if len(result.stdout) > 100000:
        raise ValueError('UI/UX result is too large; use a narrower query')
    value = json.loads(result.stdout)
    return json.dumps({'source': 'ui-ux-pro-max', 'commit': provenance['commit'], 'result': value}, ensure_ascii=False)


def search_sync(query, action='search', domain='', stack='', limit=3):
    from services import skill_curator
    if not skill_curator.model_visible('ui-ux-pro-max'):
        raise ValueError('UI/UX skill is unavailable or disabled in Tool Store')
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 500 or query.lstrip().startswith('-'):
        raise ValueError('Provide a design query of 1–500 characters')
    if action not in {'search', 'design_system'} or domain not in ('', *DOMAINS) or stack not in ('', *STACKS):
        raise ValueError('Choose a supported search mode, domain or stack')
    if domain and stack or action == 'design_system' and (domain or stack):
        raise ValueError('Use one domain, one stack or design-system mode per search')
    if type(limit) is not int or not 1 <= limit <= 6:
        raise ValueError('Choose 1–6 results')
    try:
        return _run(query.strip(), action, domain, stack, limit)
    except subprocess.TimeoutExpired as exc:
        raise ValueError('UI/UX search timed out; try a narrower query') from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError('The bundled UI/UX search engine is unavailable') from exc


async def search(**arguments):
    return await asyncio.to_thread(search_sync, **arguments)

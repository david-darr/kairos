"""Antigravity executable and read-only connection probes. No credentials read."""
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess


SIGN_IN = 'Sign in to Antigravity to use Gemini.'
_ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')


def find_antigravity() -> str | None:
    # Like Claude's external-path override, this is backend configuration,
    # never a command string interpreted by a shell.
    custom = os.environ.get('ANTIGRAVITY_CLI_PATH')
    if custom:
        return str(Path(custom)) if Path(custom).is_file() else None
    found = shutil.which('agy')
    if found and Path(found).suffix.lower() not in ('.cmd', '.bat', '.ps1'):
        return found
    if platform.system() == 'Windows':
        root = os.environ.get('LOCALAPPDATA')
        path = Path(root) / 'agy' / 'bin' / 'agy.exe' if root else None
        if path and path.is_file():
            return str(path)
    return None


def parse_models(output: str, *, source='cli_live') -> list[dict]:
    """Collapse CLI effort variants into one picker row; retain real slugs."""
    groups = {}
    for line in _ANSI.sub('', output).splitlines():
        match = re.match(r'^\s*(gemini-[a-zA-Z0-9_.-]+)(?:\s+(.+))?\s*$', line)
        if not match:
            continue
        slug, name = match.groups()
        base, sep, level = slug.rpartition('-')
        effort = level if sep and level in EFFORTS else None
        model_id = base if effort else slug
        name = re.sub(r'\s*\((?:Low|Medium|High|Xhigh|Max)\)\s*$', '', name or model_id, flags=re.I)
        entry = groups.setdefault(model_id, {
            'id': model_id, 'display_name': name, 'description': '', 'alias': None,
            'default_effort': None, 'supported_efforts': [], 'variants': {},
            'context_window': None, 'effective_context_percent': None,
            'source': source, 'estimated': source == 'curated',
        })
        if effort:
            entry['variants'][effort] = slug
        else:
            entry['cli_model'] = slug
    for entry in groups.values():
        levels = [e for e in EFFORTS if e in entry['variants']]
        entry['supported_efforts'] = [{'effort': e, 'description': ''} for e in levels]
        # No claim about the provider's default: when no level was selected,
        # use an actual advertised slug, favouring the balanced variant.
        entry.setdefault('cli_model', entry['variants'].get('medium') or next(iter(entry['variants'].values()), entry['id']))
    return list(groups.values())


def run_readonly(path: str, *args: str, timeout=10):
    process = subprocess.Popen([path, *args], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        start_new_session=os.name != 'nt')
    try:
        out, err = process.communicate(timeout=timeout)
        return process.returncode, out.decode('utf-8', 'replace'), err.decode('utf-8', 'replace')
    finally:
        if process.poll() is None:
            if os.name == 'nt':
                try:
                    subprocess.run(['taskkill', '/T', '/F', '/PID', str(process.pid)],
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
                except (OSError, subprocess.SubprocessError):
                    pass
                if process.poll() is None:
                    process.kill()
            else:
                import signal
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        for stream in (process.stdout, process.stderr):
            if stream:
                stream.close()


def auth_error(text: str) -> bool:
    return any(word in text.lower() for word in (
        'not logged in', 'authentication required', 'unauthenticated',
        'sign in', 'sign-in', 'login required', '401', 'invalid token', 'expired token'))


def probe() -> dict:
    path = find_antigravity()
    result = {'installed': bool(path), 'path': path, 'version': None,
              'signed_in': False, 'models': [], 'models_found': 0,
              'status': 'missing' if not path else 'unavailable', 'message': ''}
    if not path:
        result['message'] = 'Install Antigravity CLI (agy), then recheck.'
        return result
    try:
        code, out, _ = run_readonly(path, '--version', timeout=5)
        version = re.search(r'\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b', out)
        if code == 0 and version:
            result['version'] = version.group()
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        code, out, err = run_readonly(path, 'models')
        if auth_error(out + '\n' + err):
            result.update(status='needs_sign_in', message=SIGN_IN)
        elif code == 0:
            models = parse_models(out)
            result.update(models=models, models_found=len(models), signed_in=bool(models),
                          status='connected' if models else 'unavailable')
    except (OSError, subprocess.SubprocessError):
        pass
    if result['status'] == 'unavailable':
        result['message'] = 'Antigravity could not list Gemini models. Recheck after signing in in the Antigravity app or CLI.'
    return result

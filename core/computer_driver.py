"""Playwright side of the contained computer's line protocol.

This source is passed as the container's Python command. It never runs on the
host. Stdout carries only JSON lines: a reply to each numbered command, and,
while someone watches the live view, `{"event": "frame"}` lines from
Chromium's screencast (pushed as the page changes, at the rate the host sets:
10 a second, 30 while the person has control on this computer).
Commands run one at a time, except watch_* and record_*, which are
answered at once so the live view never waits behind a page load.
"""
from core.computer_image import DESKTOP_APPS

SOURCE = r'''
import asyncio, base64, io, json, os, re, sys, time
from pathlib import Path
import xml.etree.ElementTree as ET
from playwright.async_api import async_playwright

PROXY = os.environ['KAIROS_COMPUTER_PROXY']
DESKTOP = os.environ.get('KAIROS_COMPUTER_DESKTOP') == '1'
APPS = DESKTOP_APPS_MAPPING
BROWSER_REFUSAL = "That is the browser window: use the computer's web actions (open, read, click by ref) so its safety checks apply."
MAX_FRAME_DEPTH = 5
FIXTURE_ORIGIN = 'https://bench.kairos.test'
MAX_FPS = 30
PRIVATE_SELECTOR = 'input[type=password],input[autocomplete=current-password],input[autocomplete=new-password],input[autocomplete=one-time-code],input[autocomplete^=cc-]'
PRIVATE_STYLE = PRIVATE_SELECTOR + ' { visibility: hidden !important; }'
# The live view is a screencast, which screenshot masks don't reach: private
# fields show as dots in every document instead.
DOTS = """(() => { const css = %s; const add = () => { const s = document.createElement('style'); s.textContent = css;
  (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add(); })()""" % json.dumps(
  PRIVATE_SELECTOR + ' { -webkit-text-security: disc !important; }')

def emit(message):
    sys.stdout.write(json.dumps(message) + '\n')
    sys.stdout.flush()

# The action contract (vault: "Agents - Computer-Use Upgrade from cua (Build
# Spec)" 5.2). A read is a snapshot: its refs print as <snapshot>:<n>, and
# only the page's live snapshot resolves. A coded error starts "[code] ".
SCAN_LIMIT = 400
ROW_FIELDS = ('ref', 'tag', 'role', 'type', 'label', 'href', 'value', 'checked', 'disabled', 'heading')

def row_key(row):
    return (row.get('tag') or '', row.get('role') or '', row.get('type') or '',
            (row.get('label') or '')[:160], row.get('href') or '')

def row_state(row):
    return (row.get('value'), row.get('checked'), row.get('disabled'))

def suggest_ref(older, snap):
    """The current read's ref for an older row, when exactly one row matches."""
    if not older or not snap.get('id') or snap.get('stale'): return ''
    matches = [row for row in snap.get('rows') or [] if row_key(row) == row_key(older)]
    return matches[0]['ref'] if len(matches) == 1 else ''

def resolve_ref(ref, snap, history):
    """(number, note) for a ref in the live snapshot, else a coded refusal."""
    ref = str(ref).strip()
    current, stale = snap.get('id'), snap.get('stale')
    match = re.fullmatch(r'([rd]\d+):(\d+)', ref)
    if match:
        sid, number = match.groups()
        if sid == current and not stale: return number, ''
        if sid == current:
            raise ValueError('[stale_ref] That ref is from %s, and %s since. Read again.' % (sid, stale))
        hint = suggest_ref((history.get(sid) or {}).get(number), snap)
        raise ValueError('[stale_ref] That ref is from an older read (%s). %s' % (
            sid, ('Use %s or read again.' % hint) if hint else 'Read again.'))
    if re.fullmatch(r'\d+', ref):
        if not current: raise ValueError('[stale_ref] There is no current read of this page. Read again.')
        if stale: raise ValueError('[stale_ref] %s since the last read (%s). Read again.' % (stale[0].upper() + stale[1:], current))
        return ref, 'Ref %s was taken from the current read, %s.' % (ref, current)
    raise ValueError('[bad_arguments] Give a ref from read, such as r3:12.')

def diff_rows(old, new):
    """Rows added, changed (same control, new value or state) and removed."""
    pool = {}
    for row in old: pool.setdefault(row_key(row), []).append(row)
    added, changed = [], []
    for row in new:
        bucket = pool.get(row_key(row))
        if bucket:
            before = bucket.pop(0)
            if row_state(before) != row_state(row): changed.append(row)
        else: added.append(row)
    return added, changed, [row for bucket in pool.values() for row in bucket]

def diff_lines(old, new):
    """Visible text lines that appeared and disappeared, counted, in order."""
    def lines(text): return [line.strip() for line in (text or '').splitlines() if line.strip()]
    before, after = {}, {}
    for line in lines(old): before[line] = before.get(line, 0) + 1
    for line in lines(new): after[line] = after.get(line, 0) + 1
    added, removed, seen = [], [], dict(before)
    for line in lines(new):
        if seen.get(line, 0) > 0: seen[line] -= 1
        else: added.append(line)
    seen = dict(after)
    for line in lines(old):
        if seen.get(line, 0) > 0: seen[line] -= 1
        else: removed.append(line)
    return added, removed

def query_rows(rows, query):
    query = query.lower()
    return [row for row in rows if any(query in str(row.get(key) or '').lower()
                                       for key in ('label', 'role', 'tag', 'type', 'value', 'href', 'heading'))]

def verify_checks(expect, found):
    """Each expected condition, whether it held, and what was actually there."""
    checks = []
    def snippet(text, needle):
        at = text.lower().find(needle.lower())
        return text[max(0, at - 40):at + len(needle) + 40].replace('\n', ' ').strip()
    for key in ('url_contains', 'title_contains', 'text_present', 'text_absent'):
        if key not in expect: continue
        wanted = str(expect[key])
        if key == 'url_contains':
            met, seen = wanted.lower() in (found.get('url') or '').lower(), 'URL is ' + (found.get('url') or '')
        elif key == 'title_contains':
            met, seen = wanted.lower() in (found.get('title') or '').lower(), 'title is ' + (found.get('title') or '(none)')
        else:
            present = wanted.lower() in (found.get('text') or '').lower()
            met = present if key == 'text_present' else not present
            seen = ('found: "%s"' % snippet(found.get('text') or '', wanted)) if present else 'not on the page'
        checks.append({'check': key, 'expected': wanted, 'met': met, 'found': seen})
    if 'element' in expect:
        count = found.get('element_count') or 0
        element = expect['element']
        checks.append({'check': 'element', 'expected': element, 'met': count > 0,
                       'found': found.get('element_error') or ('%d matching element%s' % (count, '' if count == 1 else 's'))})
    return checks

async def xdo(*args, optional=False):
    proc = await asyncio.create_subprocess_exec('xdotool', *map(str, args),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), 5)
    except asyncio.TimeoutError:
        proc.kill(); await proc.wait()
        raise ValueError('desktop input timed out')
    if proc.returncode and not optional:
        raise ValueError('could not inspect or control the desktop window')
    return out.decode(errors='replace').strip() if proc.returncode == 0 else ''

def xclass(ident):
    """(class, window) for the window's application. The window under the
    pointer is usually Openbox's frame around the app, whose client window
    (the one with WM_CLASS) is a child, so search down the frame first; an
    unnamed inner window is handled by walking up. Noble's xdotool predates
    getwindowclassname, so this reads the X11 property directly."""
    import ctypes
    class ClassHint(ctypes.Structure):
        _fields_ = [('name', ctypes.c_void_p), ('cls', ctypes.c_void_p)]
    lib = ctypes.CDLL('libX11.so.6')
    lib.XOpenDisplay.argtypes = [ctypes.c_char_p]; lib.XOpenDisplay.restype = ctypes.c_void_p
    lib.XGetClassHint.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ClassHint)]
    lib.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                               ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint)]
    lib.XFree.argtypes = [ctypes.c_void_p]
    lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = lib.XOpenDisplay(b':99')
    if not display: raise ValueError('the desktop display is unavailable')
    def class_of(window):
        hint = ClassHint()
        found = ''
        if lib.XGetClassHint(display, window, ctypes.byref(hint)):
            found = ctypes.string_at(hint.cls).decode(errors='replace') if hint.cls else ''
        if hint.name: lib.XFree(hint.name)
        if hint.cls: lib.XFree(hint.cls)
        return found

    def tree(window):
        root, parent, children, count = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p(), ctypes.c_uint()
        if not lib.XQueryTree(display, window, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
            return None, None, []
        kids = [ctypes.cast(children, ctypes.POINTER(ctypes.c_ulong))[i] for i in range(count.value)] if children.value else []
        if children.value: lib.XFree(children)
        return root.value, parent.value, kids

    try:
        start = int(ident)
        found = class_of(start)
        if found: return found, str(start)
        # Down: the frame's client, breadth first, a few levels deep.
        level = [start]
        for _ in range(4):
            level = [kid for window in level for kid in tree(window)[2]]
            for window in level:
                found = class_of(window)
                if found: return found, str(window)
        # Up: an unnamed inner window's named ancestor.
        window = start
        for _ in range(12):
            root, parent, _kids = tree(window)
            if not parent or parent == root: break
            window = parent
            found = class_of(window)
            if found: return found, str(window)
        return '', str(ident)
    finally:
        lib.XCloseDisplay(display)

async def window_info(ident):
    if not ident or ident == '0': raise ValueError('could not identify the desktop window')
    cls, owner = xclass(ident)
    return {'id': owner, 'class': cls, 'title': await xdo('getwindowname', owner, optional=True)}

def point(cmd):
    # These bounds are for the display; web actions use page coordinates.
    x, y = cmd.get('x'), cmd.get('y')
    if not isinstance(x, int) or not isinstance(y, int) or not 0 <= x < 1280 or not 0 <= y < 800:
        raise ValueError('choose a point in the desktop frame')
    return x, y

async def mouse_location():
    return dict(line.split('=', 1) for line in (await xdo('getmouselocation', '--shell')).splitlines() if '=' in line)

async def window_at(cmd):
    location = await mouse_location()
    if cmd.get('x') is not None or cmd.get('y') is not None:
        x, y = point(cmd)
        # `mousemove --sync` waits for the pointer to move, so it hangs when the
        # pointer is already there (a recorded click inspects, then clicks).
        if (location.get('X'), location.get('Y')) != (str(x), str(y)):
            await xdo('mousemove', '--sync', x, y)
            location = await mouse_location()
    return await window_info(location.get('WINDOW'))

async def focused_window():
    return await window_info(await xdo('getactivewindow'))

def browser_window(info):
    return any(word in info.get('class', '').lower() for word in ('chromium', 'chrome', 'kairos-computer-browser'))

def desktop_capture(jpeg=False):
    from PIL import ImageGrab
    output = io.BytesIO()
    ImageGrab.grab(xdisplay=':99').save(output, 'JPEG' if jpeg else 'PNG', **({'quality': 60} if jpeg else {}))
    return base64.b64encode(output.getvalue()).decode()

async def desktop_input(cmd):
    kind = cmd.get('kind')
    if kind not in ('click', 'type', 'key', 'scroll'): raise ValueError('unknown desktop input')
    if kind == 'click': point(cmd)
    at_point = kind in ('click', 'scroll')
    info = await (window_at(cmd) if at_point else focused_window())
    if not cmd.get('person'):
        if browser_window(info): raise ValueError(BROWSER_REFUSAL)
        if not info.get('class'): raise ValueError('could not identify the desktop window; ask the person to take over')
        if info != cmd.get('expected_window'): raise ValueError('the desktop window changed; inspect it again')
    if kind == 'click': await xdo('click', '1')
    elif kind == 'type':
        text = cmd.get('text') or ''
        if len(text) > 10000: raise ValueError('give at most 10000 characters to type')
        await xdo('type', '--clearmodifiers', '--delay', '0', '--', text)
    elif kind == 'key':
        key = cmd.get('key') or ''
        aliases = {'Control': 'ctrl', 'Meta': 'super', 'Enter': 'Return', 'Backspace': 'BackSpace',
                   'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', ' ': 'space'}
        parts = [aliases.get(part, part) for part in key.split('+')]
        if not re.fullmatch(r'[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*', '+'.join(parts)) or len(key) > 80:
            raise ValueError('give one key or key combination')
        # xdotool recognises command names even among key arguments.
        if any(part.lower() in ('exec', 'type', 'click', 'key', 'sleep', 'search', 'windowactivate', 'mousemove') for part in parts):
            raise ValueError('give a key, not a desktop command')
        await xdo('key', '--clearmodifiers', '+'.join(parts))
    else:
        for axis, negative, positive in (('dy', 4, 5), ('dx', 6, 7)):
            delta = int(cmd.get(axis) or 0)
            if delta: await xdo('click', '--repeat', min(30, max(1, (abs(delta) + 99) // 100)), '--delay', 0,
                                positive if delta > 0 else negative)

# Desktop semantics (vault: "Agents - Computer-Use Upgrade from cua (Build
# Spec)" 5.3): the focused window's controls from AT-SPI, the accessibility
# bus LibreOffice, GTK apps and the file manager publish to. Every call runs
# on one thread with a D-Bus timeout; a hung app answers "unavailable", never
# a stuck driver. Extents are not used as click points: under Openbox they
# measured a row off (2026-10-22), so a ref acts by its accessible action or
# by focus, and refuses rather than guess a point.
A11Y = {'pool': None, 'lib': None}
A11Y_ACTIONABLE = {'push button', 'toggle button', 'check box', 'radio button', 'menu item', 'check menu item',
    'radio menu item', 'menu', 'combo box', 'text', 'password text', 'entry', 'spin button', 'link', 'page tab',
    'list item', 'table cell', 'tree item', 'slider', 'icon', 'paragraph', 'heading', 'label', 'document text'}
A11Y_CONTAINERS = {'filler', 'panel', 'scroll pane', 'viewport', 'layered pane', 'root pane', 'glass pane',
    'split pane', 'section', 'unknown', 'redundant object', 'tool bar', 'menu bar', 'status bar', 'separator',
    'grouping', 'form', 'page tab list', 'internal frame', 'option pane', 'application', 'frame', 'dialog',
    'window', 'table', 'tree table', 'list', 'tree', 'canvas', 'document spreadsheet', 'document frame'}
# Unnamed controls say nothing to a model; fields and cells still matter.
A11Y_TEXT = {'text', 'password text', 'entry', 'paragraph', 'document text', 'table cell', 'spin button', 'combo box'}
A11Y_ACTIONS = ('click', 'press', 'activate', 'jump', 'toggle', 'open', 'select')
BROWSER_APPS = ('chromium', 'chrome', 'kairos-computer-browser')

def atspi():
    if A11Y['lib'] is None:
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi
        Atspi.set_timeout(2000, 5000)
        A11Y['lib'] = Atspi
    return A11Y['lib']

async def on_a11y(fn, *args, seconds=8):
    if A11Y['pool'] is None:
        import concurrent.futures
        A11Y['pool'] = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix='a11y')
    try:
        return await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(A11Y['pool'], fn, *args), seconds)
    except asyncio.TimeoutError:
        raise ValueError('[a11y_unavailable] The desktop app did not answer its accessibility request in time.')

def a11y_name(node):
    return ' '.join((node.get_name() or '').split())[:160]

def a11y_label(node):
    """An unnamed field's label through its labelled-by relation, as GTK
    forms and dialogs link them ("Name:" beside the Save dialog's field)."""
    try:
        Atspi = atspi()
        for relation in node.get_relation_set() or []:
            if relation.get_relation_type() == Atspi.RelationType.LABELLED_BY and relation.get_n_targets():
                return a11y_name(relation.get_target(0)).rstrip(':').strip()
    except Exception:
        return ''
    return ''

def a11y_states(node):
    S = atspi().StateType
    states = node.get_state_set()
    return {name: states.contains(getattr(S, name)) for name in
            ('SHOWING', 'ACTIVE', 'FOCUSED', 'CHECKED', 'ENABLED', 'SENSITIVE', 'DEFUNCT', 'IS_DEFAULT', 'CHECKABLE')}

def a11y_app_name(node):
    try:
        app = node.get_application()
        return (app.get_name() or '').lower() if app else ''
    except Exception:
        return ''

def a11y_window(title=''):
    """The active top-level window and its app: AT-SPI's ACTIVE state first,
    else the X window title, plus the app's open popup windows."""
    Atspi = atspi()
    desktop = Atspi.get_desktop(0)
    candidates = []
    for i in range(min(desktop.get_child_count(), 40)):
        app = desktop.get_child_at_index(i)
        if app is None: continue
        for j in range(min(app.get_child_count(), 40)):
            window = app.get_child_at_index(j)
            if window is None: continue
            states = a11y_states(window)
            candidates.append((app, window, states))
    for app, window, states in candidates:
        if states['ACTIVE']: break
    else:
        match = [c for c in candidates if title and a11y_name(c[1]) == ' '.join(title.split())[:160]]
        if not match: return None, []
        app, window, states = match[0]
    popups = [w for a, w, s in candidates if a is app and w is not window and s['SHOWING']
              and w.get_role_name() in ('window', 'menu', 'popup menu', 'tool tip')]
    return window, popups

def a11y_text(node, role):
    if role == 'password text': return None
    try:
        if 'Text' in node.get_interfaces():
            # An end past the text is refused by LibreOffice, so ask for its length.
            Text = atspi().Text
            text = Text.get_text(node, 0, min(200, Text.get_character_count(node))) or ''
            return ' '.join(text.split())[:120]
    except Exception:
        return None
    return None

def a11y_row(node, role, name, states, app):
    row = {'tag': role, 'label': name, 'app': app}
    value = a11y_text(node, role)
    if value and value != name: row['value'] = value
    if states['CHECKABLE'] or role in ('check box', 'radio button', 'toggle button', 'check menu item', 'radio menu item'):
        row['checked'] = states['CHECKED']
    if not (states['ENABLED'] or states['SENSITIVE']): row['disabled'] = True
    if role == 'password text': row['private'] = True
    if states['FOCUSED']: row['focused'] = True
    if states['IS_DEFAULT']: row['default'] = True
    return row

CELL = re.compile(r'([A-Z]{1,3})([0-9]{1,7})')

def a11y_cell(name):
    match = CELL.fullmatch(name.upper())
    if not match: return None
    column = 0
    for letter in match.group(1): column = column * 26 + ord(letter) - 64
    return int(match.group(2)) - 1, column - 1

def a11y_walk(roots, app, query=''):
    """Visible rows of a window, bounded: at most SCAN_LIMIT rows, 4000 nodes
    and 4 seconds. A spreadsheet's million cells are not walked: its top-left
    cells, and a cell named in the query, are fetched through its table."""
    Atspi = atspi()
    rows, nodes, seen, started, menu_bars = [], [], [0], time.monotonic(), set()
    def add(node, role, name, states):
        rows.append(a11y_row(node, role, name, states, app)); nodes.append(node)
    def visit(node, depth):
        if len(rows) >= SCAN_LIMIT or seen[0] >= 4000 or depth > 40 or time.monotonic() - started > 4: return
        seen[0] += 1
        try:
            role, name, states = node.get_role_name(), a11y_name(node), a11y_states(node)
            count = node.get_child_count()
        except Exception:
            return
        if states['DEFUNCT'] or not states['SHOWING']: return
        if role == 'menu bar':
            # LibreOffice's GTK3 front end publishes its menu bar twice, both
            # showing: list one, skip any later bar with the same menus.
            try:
                menus = tuple(a11y_name(node.get_child_at_index(i)) for i in range(min(count, 40)))
            except Exception:
                menus = None
            if menus is not None and menus in menu_bars: return
            if menus is not None: menu_bars.add(menus)
        if not name and role in A11Y_TEXT: name = a11y_label(node)
        if (role in A11Y_ACTIONABLE and (name or role in A11Y_TEXT)) or (name and role not in A11Y_CONTAINERS):
            add(node, role, name, states)
        if role in ('table', 'tree table') and count > 500:
            wanted = {(r, c) for r in range(15) for c in range(8)}
            cell = a11y_cell(query) if query else None
            if cell: wanted.add(cell)
            for r, c in sorted(wanted):
                try:
                    child = Atspi.Table.get_accessible_at(node, r, c)
                    child_states = a11y_states(child)
                    if child_states['SHOWING'] or (r, c) == cell:
                        add(child, child.get_role_name(), a11y_name(child), child_states)
                except Exception:
                    continue
            return
        for index in range(min(count, 300)):
            try: child = node.get_child_at_index(index)
            except Exception: continue
            if child is not None: visit(child, depth + 1)
    for root in roots: visit(root, 0)
    return rows, nodes

def a11y_snapshot(title, query):
    window, popups = a11y_window(title)
    if window is None:
        raise ValueError('[a11y_unavailable] No desktop window publishes its controls; use a screenshot and desktop coordinates.')
    app = a11y_app_name(window)
    if any(name in app for name in BROWSER_APPS):
        raise ValueError('[use_web_actions] ' + BROWSER_REFUSAL)
    rows, nodes = a11y_walk([window, *popups], app, query)
    return {'title': a11y_name(window), 'app': app, 'rows': rows, 'nodes': nodes}

def a11y_focused(title):
    """The focused control and the window's default buttons (what Enter
    presses), for the type and key guards."""
    window, popups = a11y_window(title)
    app = a11y_app_name(window) if window is not None else ''
    if window is None or any(name in app for name in BROWSER_APPS): return {}, []
    rows, _ = a11y_walk([window, *popups], app)
    focused = next((row for row in rows if row.get('focused')), {})
    return focused, [row for row in rows if row.get('default')]

def a11y_act(node, kind):
    """Press by the control's own accessible action, or focus it to type.
    Returns how it was done; never a guessed screen point."""
    Atspi = atspi()
    states = a11y_states(node)
    if states['DEFUNCT']: raise ValueError('[stale_ref] That control has gone. Read again.')
    if kind == 'click':
        try:
            names = [(Atspi.Action.get_action_name(node, i) or '').lower() for i in range(Atspi.Action.get_n_actions(node))]
        except Exception:
            names = []
        for wanted in A11Y_ACTIONS:
            if wanted in names:
                Atspi.Action.do_action(node, names.index(wanted)); return 'action ' + wanted
        if names and node.get_role_name() in ('menu', 'menu item', 'push button', 'toggle button', 'check box',
                                              'radio button', 'link', 'page tab', 'check menu item', 'radio menu item'):
            Atspi.Action.do_action(node, 0); return 'action ' + (names[0] or 'default')
    try:
        if Atspi.Component.grab_focus(node): return 'focus'
    except Exception:
        pass
    raise ValueError('[no_accessible_action] That control offers no accessible action or focus. Click it by desktop coordinates from a screenshot.')

def seed_libreoffice(home=None, registry='/usr/lib/libreoffice/share/registry'):
    config = (Path(home) if home is not None else Path.home()) / '.config/libreoffice/4/user/registrymodifications.xcu'
    if config.exists(): return
    ns = {'oor': 'http://openoffice.org/2001/registry'}
    version = ''
    for installed in sorted(Path(registry).glob('*.xcd')):
        product = ET.parse(installed).find(".//oor:component-data[@oor:name='Setup'][@oor:package='org.openoffice']/"
            "node[@oor:name='Product']/prop[@oor:name='ooSetupVersion']/value", ns)
        if product is not None and product.text:
            version = product.text.strip()
            if re.fullmatch(r'\d+(?:\.\d+)+', version): break
    else: raise ValueError('could not read the installed LibreOffice version')
    config.parent.mkdir(parents=True, exist_ok=True)
    # Seed only new profiles, so kept profiles retain the person's preferences.
    with config.open('x', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
                '<item oor:path="/org.openoffice.Office.Common/Misc">'
                '<prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop>'
                '<prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>'
                '<item oor:path="/org.openoffice.Setup/Product">'
                '<prop oor:name="ooSetupLastVersion" oor:op="fuse"><value>%s</value></prop></item>'
                '</oor:items>\n' % version)

def browser_launch_options(desktop):
    options = {'headless': not desktop,
        'args': ['--no-sandbox', '--disable-dev-shm-usage', '--proxy-bypass-list=<-loopback>'],
        'proxy': {'server': PROXY, 'bypass': ''}, 'accept_downloads': False}
    if desktop:
        options['args'] += ['--class=kairos-computer-browser', '--window-position=0,0', '--window-size=1280,800']
        options['no_viewport'] = True
    else:
        options['viewport'] = {'width': 1280, 'height': 800}
    return options

async def start_desktop():
    os.environ['DISPLAY'] = ':99'
    os.environ['XDG_RUNTIME_DIR'] = '/tmp/kairos-runtime'
    os.makedirs('/tmp/kairos-runtime', mode=0o700, exist_ok=True)
    os.makedirs('/profile/Documents', exist_ok=True)
    os.makedirs('/profile/.config', exist_ok=True)
    seed_libreoffice()
    with open('/profile/.config/user-dirs.dirs', 'w') as f:
        f.write('XDG_DOCUMENTS_DIR="$HOME/Documents"\n')
    # Use our own menu and bindings: Openbox's default menu includes a terminal.
    menu = '<openbox_menu xmlns="http://openbox.org/3.4/menu"><menu id="root-menu" label="Agent desktop">'
    for app, label in (('files', 'Files'), ('editor', 'Text editor'), ('pdf', 'PDF viewer'), ('images', 'Image viewer')):
        menu += '<item label="%s"><action name="Execute"><command>%s</command></action></item>' % (label, ' '.join(APPS[app]))
    menu += '<menu id="office" label="LibreOffice">'
    for app in ('writer', 'calc', 'impress'):
        menu += '<item label="%s"><action name="Execute"><command>%s</command></action></item>' % (app.title(), ' '.join(APPS[app]))
    menu += '</menu></menu></openbox_menu>'
    with open('/tmp/kairos-menu.xml', 'w') as f: f.write(menu)
    with open('/tmp/kairos-openbox.xml', 'w') as f:
        f.write('<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><followMouse>no</followMouse></focus>'
                '<menu><file>/tmp/kairos-menu.xml</file></menu><keyboard>'
                '<keybind key="C-Escape"><action name="ShowMenu"><menu>root-menu</menu></action></keybind>'
                '<keybind key="A-Tab"><action name="NextWindow"/></keybind>'
                '<keybind key="A-F4"><action name="Close"/></keybind></keyboard>'
                '<mouse><context name="Root"><mousebind button="Left" action="Press">'
                '<action name="ShowMenu"><menu>root-menu</menu></action></mousebind></context>'
                '<context name="Client"><mousebind button="Left" action="Press"><action name="Focus"/>'
                '<action name="Raise"/></mousebind></context></mouse></openbox_config>')
    display = await asyncio.create_subprocess_exec('Xvfb', ':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp',
        stdout=sys.stderr, stderr=sys.stderr)
    for _ in range(100):
        if display.returncode is not None: raise ValueError('the desktop display stopped')
        if await xdo('getdisplaygeometry', optional=True): break
        await asyncio.sleep(0.05)
    else: raise ValueError('the desktop display did not start')
    await asyncio.create_subprocess_exec('openbox', '--config-file', '/tmp/kairos-openbox.xml',
        stdout=sys.stderr, stderr=sys.stderr)
    await start_a11y_bus()

async def start_a11y_bus():
    """A private session bus and the accessibility bus on it, so desktop apps
    publish their controls (LibreOffice through its GTK3 front end). Without
    them desktop read says so; nothing else depends on them."""
    os.environ['SAL_USE_VCLPLUGIN'] = 'gtk3'
    try:
        launch = await asyncio.create_subprocess_exec('dbus-launch', '--sh-syntax',
            stdout=asyncio.subprocess.PIPE, stderr=sys.stderr)
        out, _ = await asyncio.wait_for(launch.communicate(), 10)
        for name, value in re.findall(r"(DBUS_SESSION_BUS_\w+)='([^']*)'", out.decode()):
            os.environ[name] = value
        await asyncio.create_subprocess_exec('/usr/libexec/at-spi-bus-launcher', '--launch-immediately',
            stdout=sys.stderr, stderr=sys.stderr)
        await asyncio.sleep(0.5)
    except (OSError, asyncio.TimeoutError) as error:
        sys.stderr.write('accessibility bus unavailable: %s\n' % error)
ELEMENT = """e => {if (!e) return {}; const a = e.closest('a,button,input,textarea,select,[role=button],[contenteditable=true]') || e;
const f = a.closest('form');
const signals = n => [n.getAttribute('aria-label'), n.labels?.[0]?.innerText, n.innerText,
  n.matches('button,input[type=submit],input[type=button],input[type=reset],input[type=image],[role=button]') ? n.value : '',
  n.getAttribute('alt'), n.getAttribute('placeholder'), n.getAttribute('title')].map(v => (v || '').trim()).filter(Boolean);
const labels = signals(a);
const submitControls = f ? Array.from(document.querySelectorAll('button:not([type]),button[type=submit],input[type=submit],input[type=image]')).filter(n => n.form === f) : [];
return {tag:a.tagName.toLowerCase(), type:(a.getAttribute('type')||'').toLowerCase(), autocomplete:(a.getAttribute('autocomplete')||'').toLowerCase(), role:a.getAttribute('role')||'', label:(labels[0] || '').slice(0,160),
submit: a.matches('button:not([type]),button[type=submit],input[type=submit],input[type=image]') || !!(f && a.type === 'submit'),
signals:labels, form_submits:submitControls.map(n => ({label:(signals(n)[0] || '').slice(0,160), signals:signals(n)})),
form:!!f, href:a.href||''};}"""
CONTROLS = 'a,button,input,textarea,select,[role=button],[contenteditable=true]'
# One page call for every candidate: visible rows only, each with its value
# or state (never a private field's value) and the heading it sits under.
READ_ROWS = """(els) => { const info = ELEMENT_JS;
const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'));
return els.map(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
  if (!(r.width > 0 && r.height > 0) || s.visibility === 'hidden') return null;
  const row = info(e); let heading = '';
  for (const h of heads) { if (h !== e && (h.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) heading = (h.innerText || '').trim().slice(0, 120); else break; }
  const auto = row.autocomplete || '';
  const secret = (row.tag === 'input' && row.type === 'password') || ['current-password','new-password','one-time-code'].includes(auto) || auto.startsWith('cc-');
  if (['input','textarea','select'].includes(row.tag) && !secret && !['checkbox','radio','submit','button','reset','image','hidden','file'].includes(row.type)) row.value = String(e.value || '').slice(0, 120);
  if (row.type === 'checkbox' || row.type === 'radio' || e.hasAttribute('aria-checked')) row.checked = !!(e.checked || e.getAttribute('aria-checked') === 'true');
  if (e.disabled || e.getAttribute('aria-disabled') === 'true') row.disabled = true;
  if (heading) row.heading = heading;
  return row; }); }""".replace('ELEMENT_JS', ELEMENT)

def recorded_input(kind, values, info, url, window=None):
    step = {'kind': kind, 'url': url}
    if window: step['window'] = window
    autocomplete = info.get('autocomplete') or ''
    private = (info.get('opaque_frame') or info.get('tag') == 'input' and info.get('type') == 'password'
        or autocomplete in ('current-password', 'new-password', 'one-time-code') or autocomplete.startswith('cc-'))
    if private:
        step.update(private=True, label='(private field: entered by the person)',
            field='opaque frame' if info.get('opaque_frame') else 'password' if info.get('type') == 'password' or
            autocomplete in ('current-password', 'new-password')
            else 'one-time code' if autocomplete == 'one-time-code' else 'payment details')
        return step
    step['element'] = {key: info[key] for key in ('label', 'role', 'tag', 'type', 'signals', 'form_submits') if key in info}
    for key in ('text', 'key', 'dx', 'dy'):
        if key in values: step[key] = values[key]
    if kind == 'click' and not info.get('label'):
        step.update({key: values[key] for key in ('x', 'y') if key in values})
    return step

def desktop_app(window):
    klass, title = window.get('class', '').lower(), window.get('title', '').lower()
    for name, app in (('pcmanfm', 'files'), ('mousepad', 'editor'), ('atril', 'pdf'), ('ristretto', 'images')):
        if name in klass: return app
    if 'libreoffice' in klass:
        for app in ('writer', 'calc', 'impress'):
            if app in klass or app in title: return app
    return None

async def main():
    if DESKTOP: await start_desktop()
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context('/profile', **browser_launch_options(DESKTOP))
        await context.add_init_script(script=DOTS)
        page = context.pages[0] if context.pages else await context.new_page()
        fixtures = globals().get('FIXTURES') or {}
        if fixtures:
            # Benchmark pages (scripts/computer_bench.py): answered here, so
            # they never cross the filtered network. Only a manager built
            # with fixtures sends them; Kairos's own manager never does.
            async def fixture(route):
                path = route.request.url.split(FIXTURE_ORIGIN, 1)[1].split('?', 1)[0].split('#', 1)[0] or '/'
                item = fixtures.get(path) or fixtures.get(path.rstrip('/') + '/index.html')
                if item is None: await route.fulfill(status=404, body='not found', content_type='text/plain')
                else: await route.fulfill(status=200, body=item['body'], content_type=item.get('type') or 'text/html')
            await context.route(FIXTURE_ORIGIN + '/**', fixture)
        snap = {'seq': 0, 'id': None, 'stale': '', 'rows': [], 'handles': {}, 'text': ''}
        history = {}
        dsnap = {'seq': 0, 'id': None, 'stale': '', 'rows': [], 'nodes': {}, 'window': ''}
        dhistory = {}
        def invalidate(why):
            if snap['id'] and not snap['stale']: snap['stale'] = why
        recording = {'id': None, 'task': None, 'windows': set()}
        def step_event(step, ident):
            if ident and recording['id'] == ident:
                emit({'event': 'step', 'recording_id': ident, 'step': step})
        def navigation(frame):
            if frame is frame.page.main_frame:
                if frame.page is page: invalidate('the page navigated')
                step_event({'kind': 'open', 'url': frame.url}, recording['id'])
        def observe(tab):
            tab.on('framenavigated', navigation)
        for tab in context.pages: observe(tab)
        context.on('page', observe)
        async def desktop_launches(ident):
            while recording['id'] == ident:
                for wid in (await xdo('search', '--onlyvisible', '--class', '.', optional=True)).splitlines():
                    if wid in recording['windows']: continue
                    try:
                        info = await window_info(wid)
                    except ValueError:
                        continue
                    if not info['class']: continue
                    recording['windows'].add(wid)
                    app = desktop_app(info)
                    if app: step_event({'kind': 'launch', 'app': app, 'window': info}, ident)
                await asyncio.sleep(0.25)
        async def record_input(cmd, kind):
            nonlocal page
            ident = cmd.get('recording_id')
            if not ident or ident != recording['id']: return
            window, values, info = None, cmd, {}
            try:
                if DESKTOP:
                    window = await (window_at(cmd) if kind in ('click', 'scroll') else focused_window())
                    geometry = await xdo('getwindowgeometry', '--shell', window['id'])
                    geometry = dict(line.split('=', 1) for line in geometry.splitlines() if '=' in line)
                    window = {key: window[key] for key in ('class', 'title')}
                    if kind == 'click':
                        values = {**cmd, 'x': cmd['x'] - int(geometry['X']), 'y': cmd['y'] - int(geometry['Y'])}
                    if browser_window(window):
                        # The person can change tabs or focus the address bar directly.
                        focused_pages = [tab for tab in context.pages if await tab.evaluate(
                            "document.visibilityState === 'visible'" if kind == 'click' else 'document.hasFocus()')]
                        if not focused_pages: info = {'opaque_frame': True}
                        else:
                            page = focused_pages[-1]
                            if kind == 'click':
                                bounds = await page.evaluate('({x:screenX+(outerWidth-innerWidth)/2,y:screenY+outerHeight-innerHeight})')
                                info = await inspect({'x': cmd['x'] - bounds['x'], 'y': cmd['y'] - bounds['y']})
                                if not info: info = {'opaque_frame': True}
                            else: info = await inspect_focused()
                    elif not window['class']:
                        info = {'opaque_frame': True}
                else:
                    info = await (inspect(cmd) if kind == 'click' else inspect_focused())
            except Exception:
                info = {'opaque_frame': True}
            step_event(recorded_input(kind, values, info, page.url, window), ident)
        cast = {'session': None, 'page': None, 'sent': 0.0, 'watching': False, 'gap': 0.1, 'task': None}
        async def capture_loop():
            while cast['watching']:
                emit({'event': 'frame', 'data': await asyncio.to_thread(desktop_capture, True)})
                await asyncio.sleep(cast['gap'])
        def on_frame(params):
            session = cast['session']
            if session is None: return
            asyncio.ensure_future(session.send('Page.screencastFrameAck', {'sessionId': params['sessionId']}))
            now = time.monotonic()
            if now - cast['sent'] >= cast['gap']:
                cast['sent'] = now
                emit({'event': 'frame', 'data': params['data']})
        async def stop_cast():
            task, cast['task'] = cast['task'], None
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            session, cast['session'] = cast['session'], None
            if session is not None:
                try:
                    await session.send('Page.stopScreencast')
                    await session.detach()
                except Exception:
                    pass
        async def start_cast():
            await stop_cast()
            if DESKTOP:
                cast['task'] = asyncio.create_task(capture_loop())
                return
            session = await context.new_cdp_session(page)
            cast['session'], cast['page'] = session, page
            session.on('Page.screencastFrame', on_frame)
            await session.send('Page.startScreencast', {'format': 'jpeg', 'quality': 60,
                                                        'maxWidth': 1280, 'maxHeight': 800, 'everyNthFrame': 1})
        async def follow_page():
            # A popup or new tab became the page: the screencast follows it.
            if not DESKTOP and cast['watching'] and cast['page'] is not page:
                await start_cast()
        async def _frame_child(handle):
            try:
                return await handle.content_frame()
            except Exception:
                return None
        async def element(arg):
            if arg.get('ref'):
                number, _ = resolve_ref(arg['ref'], snap, history)
                handle = snap['handles'].get(number)
                if not handle: raise ValueError('[stale_ref] Read %s has no element %s. Read again.' % (snap['id'], number))
                try:
                    tag, connected = await handle.evaluate('(e) => [e.tagName.toLowerCase(), e.isConnected]')
                except Exception:
                    return None, True
                if not connected:
                    raise ValueError('[stale_ref] That element left the page (it re-rendered) after %s. Read again.' % snap['id'])
                return (None, True) if tag in ('iframe', 'frame') else (handle, False)
            if arg.get('x') is None or arg.get('y') is None:
                return None, False
            frame = page.main_frame
            point = {'x': arg['x'], 'y': arg['y']}
            inside_frame = False
            for depth in range(MAX_FRAME_DEPTH + 1):
                try:
                    hit = await frame.evaluate_handle('p => document.elementFromPoint(p.x,p.y)', point)
                    handle = hit.as_element()
                    if not handle: return None, inside_frame
                    tag = await handle.evaluate('(e) => e.tagName.toLowerCase()')
                    if tag not in ('iframe', 'frame'): return handle, False
                    inside_frame = True
                    if depth == MAX_FRAME_DEPTH: return None, True
                    child = await _frame_child(handle)
                    if not child: return None, True
                    offset = await handle.evaluate('e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return {'
                        'x:r.left + parseFloat(s.borderLeftWidth || 0) + parseFloat(s.paddingLeft || 0),'
                        'y:r.top + parseFloat(s.borderTopWidth || 0) + parseFloat(s.paddingTop || 0)}; }')
                    point = {'x': point['x'] - offset['x'], 'y': point['y'] - offset['y']}
                    frame = child
                except Exception:
                    if inside_frame: return None, True
                    raise
            return None, True
        async def focused():
            frame = page.main_frame
            inside_frame = False
            for depth in range(MAX_FRAME_DEPTH + 1):
                try:
                    hit = await frame.evaluate_handle('document.activeElement')
                    handle = hit.as_element()
                    if not handle: return None, inside_frame
                    tag = await handle.evaluate('(e) => e.tagName.toLowerCase()')
                    if tag not in ('iframe', 'frame'): return handle, False
                    inside_frame = True
                    if depth == MAX_FRAME_DEPTH: return None, True
                    child = await _frame_child(handle)
                    if not child: return None, True
                    frame = child
                except Exception:
                    if inside_frame: return None, True
                    raise
            return None, True
        async def inspect(arg):
            handle, opaque = await element(arg)
            if opaque: return {'opaque_frame': True, 'tag': 'iframe'}
            if not handle: return {}
            try:
                return await handle.evaluate(ELEMENT)
            except Exception:
                return {'opaque_frame': True, 'tag': 'iframe'}
        async def inspect_focused():
            handle, opaque = await focused()
            if opaque: return {'opaque_frame': True, 'tag': 'iframe'}
            if not handle: return {}
            try:
                return await handle.evaluate(ELEMENT)
            except Exception:
                return {'opaque_frame': True, 'tag': 'iframe'}
        async def read_page(cmd):
            """A new snapshot of the page: refs <id>:<n>, narrowed by query,
            or only what changed since the live snapshot (since: latest)."""
            query = str(cmd.get('query') or '').strip()[:200]
            limit = min(200, max(1, int(cmd.get('max_elements') or 60)))
            since = cmd.get('since') == 'latest'
            previous = None if snap['stale'] or not snap['id'] else {'id': snap['id'], 'rows': snap['rows'], 'text': snap['text']}
            why_full = snap['stale'] or ('there was no earlier read of this page' if not snap['id'] else '')
            handles = await page.locator(CONTROLS).element_handles()
            scanned, extra = handles[:SCAN_LIMIT], handles[SCAN_LIMIT:]
            infos = await page.evaluate(READ_ROWS, scanned) if scanned else []
            visible = await page.locator('body').inner_text(timeout=10000)
            snap['seq'] += 1
            sid = 'r%d' % snap['seq']
            rows, kept, unused = [], {}, list(extra)
            for handle, info in zip(scanned, infos):
                if not info: unused.append(handle); continue
                number = str(len(rows) + 1)
                rows.append({'ref': '%s:%s' % (sid, number), **{k: info[k] for k in ROW_FIELDS if k in info and k != 'ref'}})
                kept[number] = handle
            unused += list(snap['handles'].values())
            if snap['id']:
                history[snap['id']] = {row['ref'].split(':', 1)[1]: row for row in snap['rows']}
                for old in sorted(history, key=lambda key: int(key[1:]))[:-8]: history.pop(old, None)
            snap.update(id=sid, stale='', rows=rows, handles=kept, text=visible)
            await asyncio.gather(*(handle.dispose() for handle in unused), return_exceptions=True)
            result = {'snapshot': sid, 'total_elements': len(rows), 'scan_capped': bool(extra)}
            if since and previous:
                added, changed, removed = diff_rows(previous['rows'], rows)
                text_added, text_removed = diff_lines(previous['text'], visible)
                if query:
                    added, changed, removed = (query_rows(part, query) for part in (added, changed, removed))
                    text_added = [line for line in text_added if query.lower() in line.lower()]
                    text_removed = [line for line in text_removed if query.lower() in line.lower()]
                result['diff'] = {'since': previous['id'], 'added': added[:limit], 'changed': changed[:limit],
                    'removed': removed[:limit], 'text_added': text_added[:40], 'text_removed': text_removed[:40],
                    'counts': [len(added), len(changed), len(removed), len(text_added), len(text_removed)]}
                return result
            if since: result['full_reason'] = why_full
            if query:
                matched = query_rows(rows, query)
                lines = [line.strip() for line in visible.splitlines() if query.lower() in line.lower() and line.strip()]
                result.update(query=query, matched=len(matched), elements=matched[:limit],
                              text='\n'.join(lines[:60])[:4000], text_lines=len(lines))
            else:
                result.update(elements=rows[:limit],
                              text=visible[:12000] + ('\n... page text cut here' if len(visible) > 12000 else ''))
            return result
        async def desktop_semantics(cmd, action):
            """Desktop read, inspect, act, focus and verify by AT-SPI. Refs are
            d<n>:<k>, valid while the same window keeps focus."""
            title = await xdo('getactivewindow', 'getwindowname', optional=True)
            if action == 'desktop_focused':
                # Without the accessibility bus the guard has nothing to read,
                # as before desktop semantics; the window checks still apply.
                try:
                    focused, defaults = await on_a11y(a11y_focused, title)
                except Exception as error:
                    return {'element': {}, 'defaults': [], 'a11y_error': str(error)[:200]}
                return {'element': focused, 'defaults': defaults}
            query = str(cmd.get('query') or '').strip()[:200]
            if action in ('desktop_read', 'desktop_verify'):
                shot = await on_a11y(a11y_snapshot, title, query)
                if action == 'desktop_verify':
                    expect = cmd.get('expect') or {}
                    rows = shot['rows']
                    found = {'url': 'desktop: ' + shot['app'], 'title': shot['title'],
                             'text': '\n'.join(' '.join(filter(None, (row.get('label'), row.get('value')))) for row in rows)}
                    if 'element' in expect:
                        role, name = expect['element']['role'].lower(), (expect['element'].get('name') or '').lower()
                        found['element_count'] = sum(1 for row in rows if (role == row['tag'] or role in row['tag'].split())
                                                     and name in (row.get('label') or '').lower())
                    return {'url': page.url, 'title': shot['title'], 'checks': verify_checks(expect, found)}
                since = cmd.get('since') == 'latest'
                same = dsnap['id'] and not dsnap['stale'] and dsnap['window'] == shot['title']
                previous = dsnap['rows'] if same else None
                why_full = ('there was no earlier desktop read' if not dsnap['id'] else
                            dsnap['stale'] or 'the focused window changed')
                dsnap['seq'] += 1
                sid = 'd%d' % dsnap['seq']
                rows = [{'ref': '%s:%d' % (sid, index + 1), **row} for index, row in enumerate(shot['rows'])]
                if dsnap['id']:
                    dhistory[dsnap['id']] = {row['ref'].split(':', 1)[1]: row for row in dsnap['rows']}
                    for old in sorted(dhistory, key=lambda key: int(key[1:]))[:-8]: dhistory.pop(old, None)
                dsnap.update(id=sid, stale='', rows=rows, window=shot['title'],
                             nodes={str(index + 1): node for index, node in enumerate(shot['nodes'])})
                limit = min(200, max(1, int(cmd.get('max_elements') or 60)))
                result = {'snapshot': sid, 'total_elements': len(rows), 'window': {'title': shot['title'], 'app': shot['app']}}
                if since and previous is not None:
                    added, changed, removed = diff_rows(previous, rows)
                    if query: added, changed, removed = (query_rows(part, query) for part in (added, changed, removed))
                    result['diff'] = {'since': dhistory and max(dhistory, key=lambda key: int(key[1:])), 'added': added[:limit],
                        'changed': changed[:limit], 'removed': removed[:limit], 'text_added': [], 'text_removed': [],
                        'counts': [len(added), len(changed), len(removed), 0, 0]}
                elif query:
                    matched = query_rows(rows, query)
                    result.update(query=query, matched=len(matched), elements=matched[:limit], text='', text_lines=0)
                else:
                    if since: result['full_reason'] = why_full
                    result.update(elements=rows[:limit], text='Window: %s (%s)' % (shot['title'], shot['app']))
                result.update(url=page.url, title=await page.title(), screenshot=await asyncio.to_thread(desktop_capture))
                return result
            if dsnap['id'] and dsnap['window'] != title and not dsnap['stale']:
                dsnap['stale'] = 'the focused window changed'
            number, note = resolve_ref(cmd['ref'], dsnap, dhistory)
            node = dsnap['nodes'].get(number)
            row = next((row for row in dsnap['rows'] if row['ref'].endswith(':' + number)), None)
            if node is None or row is None:
                raise ValueError('[stale_ref] Read %s has no control %s. Read again.' % (dsnap['id'], number))
            info = {key: row[key] for key in ('tag', 'label', 'app', 'private', 'default') if key in row}
            info['role'] = row['tag']
            info['signals'] = [value for value in (row.get('label'), row.get('value')) if value]
            if action == 'desktop_inspect':
                return {'element': info, 'note': note}
            if cmd.get('expected') != info:
                raise ValueError('[stale_ref] That control changed since %s. Read again.' % dsnap['id'])
            if any(name in (row.get('app') or '') for name in BROWSER_APPS):
                raise ValueError('[use_web_actions] ' + BROWSER_REFUSAL)
            kind = cmd.get('kind')
            if kind == 'type' and row.get('private'):
                raise ValueError('[private_field] private fields need the person to take over')
            how = await on_a11y(a11y_act, node, 'click' if kind == 'click' else 'type')
            if kind == 'type':
                text = cmd.get('text') or ''
                if len(text) > 10000: raise ValueError('give at most 10000 characters to type')
                await asyncio.sleep(0.2)
                window = await focused_window()
                if browser_window(window) or not window.get('class'):
                    raise ValueError('[use_web_actions] ' + BROWSER_REFUSAL)
                await xdo('type', '--clearmodifiers', '--delay', '0', '--', text)
            await asyncio.sleep(0.3)
            return {'how': how, 'url': page.url, 'title': await page.title(), 'screenshot': await asyncio.to_thread(desktop_capture)}
        async def execute(cmd):
            nonlocal page
            action = cmd['action']
            result = {}
            if action == 'state': return {'url':page.url, 'title':await page.title()}
            if 'expected_url' in cmd and page.url != cmd['expected_url']:
                raise ValueError('the page changed; inspect it again')
            if action in ('desktop_read', 'desktop_inspect', 'desktop_ref_input', 'desktop_focused', 'desktop_verify'):
                if not DESKTOP: raise ValueError('[needs_desktop] the agent desktop is off')
                return await desktop_semantics(cmd, action)
            if action in ('desktop_screenshot', 'desktop_input', 'window_at', 'focused_window', 'launch', 'windows'):
                if not DESKTOP: raise ValueError('the agent desktop is off')
                if action == 'window_at': return {'window': await window_at(cmd)}
                if action == 'focused_window': return {'window': await focused_window()}
                if action == 'desktop_input':
                    if cmd.get('person'): await record_input(cmd, cmd['kind'])
                    await desktop_input(cmd)
                elif action == 'launch':
                    app = cmd.get('app')
                    if app not in APPS: raise ValueError('choose files, editor, pdf, images, writer, calc or impress')
                    await asyncio.create_subprocess_exec(*APPS[app], cwd='/profile/Documents', stdout=sys.stderr, stderr=sys.stderr)
                    await asyncio.sleep(0.5)
                elif action == 'windows':
                    result['windows'] = []
                    for ident in (await xdo('search', '--onlyvisible', '--class', '.', optional=True)).splitlines():
                        try:
                            info = await window_info(ident)
                            if not info['class']: continue
                            geometry = await xdo('getwindowgeometry', '--shell', ident)
                            info['geometry'] = {k.lower(): int(v) for k, v in
                                (line.split('=', 1) for line in geometry.splitlines() if '=' in line)
                                if k in ('X', 'Y', 'WIDTH', 'HEIGHT')}
                            result['windows'].append(info)
                        except ValueError: continue
                result.update(url=page.url, title=await page.title(), screenshot=await asyncio.to_thread(desktop_capture))
                return result
            if action == 'snapshot' and DESKTOP:
                return {'url':page.url, 'title':await page.title(), 'screenshot':await asyncio.to_thread(desktop_capture, True)}
            if action == 'inspect':
                note = resolve_ref(cmd['ref'], snap, history)[1] if cmd.get('ref') else ''
                return {'element': await inspect(cmd), 'note': note}
            if action == 'capture':
                # A trajectory's before image: no wait, private fields masked.
                if cmd.get('desktop') and DESKTOP:
                    return {'url': page.url, 'screenshot': await asyncio.to_thread(desktop_capture, True)}
                return {'url': page.url, 'screenshot': base64.b64encode(await page.screenshot(type='jpeg', quality=65,
                    mask=[page.locator(PRIVATE_SELECTOR)], style=PRIVATE_STYLE)).decode()}
            if action == 'verify':
                expect = cmd.get('expect') or {}
                found = {'url': page.url, 'title': await page.title()}
                if 'text_present' in expect or 'text_absent' in expect:
                    found['text'] = await page.locator('body').inner_text(timeout=10000)
                if 'element' in expect:
                    wanted = expect['element']
                    try:
                        found['element_count'] = await page.get_by_role(wanted['role'], **({'name': wanted['name']} if wanted.get('name') else {})).count()
                    except Exception:
                        found['element_error'] = 'not a role this check knows'
                return {'url': page.url, 'title': found['title'], 'checks': verify_checks(expect, found)}
            if action == 'focused': return {'element': await inspect_focused()}
            if action in ('click','type','key') and 'expected' in cmd:
                current = await (inspect_focused() if action == 'key' or
                                 (action == 'type' and not cmd.get('ref') and cmd.get('x') is None)
                                 else inspect(cmd))
                if current.get('opaque_frame'): raise ValueError('embedded frame needs the person to take over')
                if current != cmd['expected']: raise ValueError('the element changed; inspect again')
                autocomplete = current.get('autocomplete','')
                private = (current.get('type') == 'password' and current.get('tag') == 'input'
                           or autocomplete in ('current-password','new-password','one-time-code')
                           or autocomplete.startswith('cc-'))
                if private and (action == 'type' or action == 'key' and cmd.get('key','').lower() not in ('tab','shift+tab','escape')):
                    raise ValueError('private fields need the person to take over')
            if action.startswith('person_'): await record_input(cmd, action.removeprefix('person_'))
            if action == 'person_click': await page.mouse.click(cmd['x'], cmd['y'])
            elif action == 'person_type': await page.keyboard.insert_text(cmd['text'])
            elif action == 'person_key': await page.keyboard.press(cmd['key'])
            elif action == 'person_scroll': await page.mouse.wheel(cmd.get('dx',0), cmd.get('dy',0))
            elif action == 'open':
                response = await page.goto(cmd['url'], wait_until='domcontentloaded', timeout=30000)
                # 2026-10-16: surface the proxy's local-preview error to the model.
                if response and response.headers.get('x-kairos-egress-error') == '1':
                    raise ValueError(await response.text())
            elif action == 'click':
                h, opaque = await element(cmd)
                if opaque: raise ValueError('embedded frame needs the person to take over')
                if not h: raise ValueError('no element at that point or ref')
                if cmd.get('x') is not None and cmd.get('y') is not None:
                    result['point'] = {'x': cmd['x'], 'y': cmd['y']}
                    await page.mouse.click(cmd['x'], cmd['y'])
                else:
                    box = await h.bounding_box()
                    if box: result['point'] = {'x': round(box['x'] + box['width'] / 2), 'y': round(box['y'] + box['height'] / 2)}
                    await h.click(timeout=10000)
            elif action == 'type':
                h, opaque = await element(cmd)
                if opaque: raise ValueError('embedded frame needs the person to take over')
                if h: await h.fill(cmd['text'])
                else: await page.keyboard.insert_text(cmd['text'])
            elif action == 'key': await page.keyboard.press(cmd['key'])
            elif action == 'scroll': await page.mouse.wheel(cmd.get('dx',0),cmd.get('dy',0))
            elif action == 'back': await page.go_back(wait_until='domcontentloaded', timeout=30000)
            elif action == 'wait': await asyncio.sleep(min(10,max(0,float(cmd.get('seconds',1)))))
            elif action == 'read':
                result = await read_page(cmd)
            elif action not in ('screenshot','snapshot','done'): raise ValueError('unknown action')
            if action == 'done':
                cast['watching'] = False
                await stop_cast()
                await context.close(); return {'done':True}
            if action.startswith('person_'):
                if context.pages and context.pages[-1] is not page:
                    page = context.pages[-1]
                    invalidate('a new tab opened')
                    await follow_page()
                return {'url':page.url, 'title':await page.title()}
            await page.wait_for_timeout(250)
            if context.pages and context.pages[-1] is not page:
                page = context.pages[-1]
                await page.wait_for_load_state('domcontentloaded', timeout=10000)
                invalidate('a new tab opened')
                await follow_page()
            private = page.locator(PRIVATE_SELECTOR)
            screenshot_type = 'jpeg' if action == 'snapshot' else 'png'
            quality = {'quality': 65} if action == 'snapshot' else {}
            result.update(url=page.url, title=await page.title(),
                screenshot=base64.b64encode(await page.screenshot(type=screenshot_type, mask=[private],
                    style=PRIVATE_STYLE, **quality)).decode())
            return result
        async def run(cmd):
            try:
                return {'id':cmd['id'], **(await execute(cmd))}
            except Exception as e:
                return {'id':cmd.get('id'), 'error':str(e)}
        async def watch(cmd):
            try:
                if cmd.get('fps'):
                    cast['gap'] = 1 / min(MAX_FPS, max(1, int(cmd['fps'])))
                if cmd['action'] == 'watch_start' and not cast['session'] and not cast['task']:
                    cast['watching'] = True
                    await start_cast()
                elif cmd['action'] == 'watch_stop':
                    cast['watching'] = False
                    await stop_cast()
                emit({'id':cmd['id'], 'ok':True})
            except Exception as e:
                emit({'id':cmd['id'], 'error':str(e)})
        async def record(cmd):
            try:
                ident = cmd.get('recording_id')
                if cmd['action'] == 'record_start':
                    recording['id'] = ident
                    if recording['task']:
                        recording['task'].cancel()
                        await asyncio.gather(recording['task'], return_exceptions=True)
                    if DESKTOP:
                        recording['windows'] = set((await xdo('search', '--onlyvisible', '--class', '.', optional=True)).splitlines())
                        recording['task'] = asyncio.create_task(desktop_launches(ident))
                    step_event({'kind': 'open', 'url': page.url}, ident)
                elif recording['id'] == ident:
                    recording['id'] = None
                    if recording['task']:
                        recording['task'].cancel()
                        await asyncio.gather(recording['task'], return_exceptions=True)
                        recording['task'] = None
                emit({'id': cmd['id'], 'ok': True})
            except Exception as e:
                emit({'id': cmd['id'], 'error': str(e)})
        queue = asyncio.Queue()
        async def worker():
            while (cmd := await queue.get()) is not None:
                reply = await run(cmd)
                emit(reply)
                if reply.get('done'): return
        working = asyncio.create_task(worker())
        while line := await asyncio.to_thread(sys.stdin.readline):
            try:
                cmd = json.loads(line)
            except ValueError:
                emit({'id':None, 'error':'unreadable command'})
                continue
            if cmd.get('action') in ('watch_start', 'watch_rate', 'watch_stop'):
                asyncio.ensure_future(watch(cmd))
            elif cmd.get('action') in ('record_start', 'record_stop'):
                await record(cmd)
            else:
                await queue.put(cmd)
            if working.done(): break
        if not working.done():
            await queue.put(None)
            await working
        cast['watching'] = False
        recording['id'] = None
        if recording['task']:
            recording['task'].cancel()
            await asyncio.gather(recording['task'], return_exceptions=True)
        await stop_cast()

asyncio.run(main())
'''.replace('DESKTOP_APPS_MAPPING', repr(DESKTOP_APPS))

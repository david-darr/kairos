"""Part 2 group g10 (A16 Forge Home and sessions): disposable-repository integration contracts
and benchmarks. Real local Git, real bare "remotes", real PTY and a real app process. Everything
lives under the system TEMP; nothing touches this checkout's remote and nothing is pushed anywhere
but a local bare repository.

Run:  python -B -X utf8 scripts/test_g10_forge_integration.py
Set G10_BIG=1 to also probe a 130k-commit history (slow, ~30 s). Timings are written to
%TEMP%/g10/bench.json and printed as one JSON line prefixed BENCH.
"""
import asyncio
import json
import os
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
environment = tempfile.TemporaryDirectory(prefix='kairos-g10-')
os.environ['JARVIS_DATA_DIR'] = str(Path(environment.name) / 'app-data')

from core import permissions, session_manager_store
from core.session_manager import session_manager
from services import forge_git, forge_projects as projects_module, forge_sessions as sessions_module
from services import forge_apps as apps_module
from services.forge_session_git import ForgeSessionGit
from services.forge_terminals import ForgeTerminals
import test_forge_sessions as _ts, test_forge_apps as _ta
_S, _A = _ts.ForgeSessionTests, _ta.AppTests   # borrowed fixtures only; not module attributes, so not re-run

BENCH = {}


def tearDownModule():
    out = Path(tempfile.gettempdir()) / 'g10'
    out.mkdir(exist_ok=True)
    (out / 'bench.json').write_text(json.dumps(BENCH, indent=1))
    print('BENCH ' + json.dumps(BENCH))
    session_manager_store.close()
    environment.cleanup()


def stats(samples):
    s = sorted(samples)
    return dict(n=len(s), p50_ms=round(statistics.median(s) * 1000, 1),
                p95_ms=round(s[min(len(s) - 1, int(len(s) * 0.95))] * 1000, 1), max_ms=round(s[-1] * 1000, 1))


def timed(fn, repeat=7):
    out = []
    for _ in range(repeat):
        t = time.perf_counter(); fn(); out.append(time.perf_counter() - t)
    return stats(out)


def fast_import(repo, commits, files_per_commit=3, base_files=0):
    """Linear history of `commits` commits with git fast-import (no per-commit process)."""
    parts = []
    ts = 1700000000
    for i in range(commits):
        msg = f'Commit {i}'
        parts.append(f'commit refs/heads/main\nauthor Dev{i % 5} <d{i % 5}@fixture.test> {ts + i * 600} +0000\n'
                     f'committer Dev{i % 5} <d{i % 5}@fixture.test> {ts + i * 600} +0000\ndata {len(msg)}\n{msg}\n')
        if i == 0:
            for f in range(base_files):
                body = f'file {f}\n' * 5
                parts.append(f'M 100644 inline src/dir{f % 40}/file{f}.py\ndata {len(body)}\n{body}\n')
        for f in range(files_per_commit):
            body = f'rev {i} f {f}\n'
            parts.append(f'M 100644 inline src/hot{f}.py\ndata {len(body)}\n{body}\n')
    data = ''.join(parts).encode()
    subprocess.run(['git', '-c', 'core.hooksPath=' + os.devnull, 'fast-import', '--quiet'], cwd=repo, input=data,
                   check=True, capture_output=True, timeout=300)
    subprocess.run(['git', 'symbolic-ref', 'HEAD', 'refs/heads/main'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'reset', '--hard', '-q'], cwd=repo, check=True, capture_output=True, timeout=300)


class G10Sessions(unittest.TestCase):
    setUp = _S.setUp
    git = _S.git
    write = staticmethod(_S.write)
    create = _S.create

    def bare_remote(self):
        bare = self.root / 'remote.git'
        self.git('init', '--bare', '-b', 'main', str(bare))
        self.git('remote', 'add', 'origin', str(bare))
        self.git('push', 'origin', 'main')
        return bare

    def session_git(self):
        return ForgeSessionGit(self.service)

    def allow(self):
        return patch.object(permissions, 'decide', new=AsyncMock(return_value=permissions.Decision('allow')))

    # --- Git: no force, ff-only, actual status ----------------------------------------------
    def test_diverged_push_and_pull_are_refused_and_leave_both_sides_intact(self):
        bare = self.bare_remote()
        session = self.create(); root = Path(session['workspace_dir']); branch = session['forge']['branch']
        self.git('config', 'user.name', 'Fixture'); self.git('config', 'user.email', 'f@example.test')
        self.write(root / 'code.txt', 'topic 1\n'); self.git('add', '.', cwd=root); self.git('commit', '-m', 'Topic 1', cwd=root)
        target = forge_git.push_target(root)
        forge_git.push(root, target)
        remote_head = self.git('rev-parse', branch, cwd=bare)
        # Someone else rewrites the remote branch: clone, add a commit, push.
        other = self.root / 'other'
        self.git('clone', str(bare), str(other), cwd=self.root)
        self.git('checkout', branch, cwd=other)
        self.write(other / 'code.txt', 'someone else\n')
        self.git('add', '.', cwd=other); self.git('commit', '-m', 'Remote work', cwd=other); self.git('push', 'origin', branch, cwd=other)
        remote_head = self.git('rev-parse', branch, cwd=bare)
        # Our branch diverges.
        self.write(root / 'code.txt', 'topic 2\n'); self.git('add', '.', cwd=root); self.git('commit', '-m', 'Topic 2', cwd=root)
        local_head = self.git('rev-parse', 'HEAD', cwd=root)
        with self.assertRaises(forge_git.GitError):
            forge_git.push(root, forge_git.push_target(root))
        self.assertEqual(self.git('rev-parse', branch, cwd=bare), remote_head, 'a refused push must not move the remote')
        with self.assertRaises(forge_git.GitError):
            forge_git.pull(root)
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=root), local_head, 'ff-only pull never rewrites local history')
        self.assertEqual(self.git('status', '--porcelain', cwd=root), '')
        self.assertFalse((root / '.git').is_dir() and (root / '.git' / 'MERGE_HEAD').exists())

    def test_merge_back_conflict_through_approval_keeps_session_branch_and_conversation(self):
        session = self.create(); sid = session['id']; root = Path(session['workspace_dir']); branch = session['forge']['branch']
        self.write(root / 'code.txt', 'topic\n'); self.git('add', '.', cwd=root); self.git('commit', '-m', 'Topic', cwd=root)
        self.write(self.repo / 'code.txt', 'base\n'); self.git('add', '.'); self.git('commit', '-m', 'Base')
        service = self.session_git()
        with self.allow() as decide:
            with self.assertRaisesRegex(ValueError, 'Conflicted files'):
                asyncio.run(service.approved(sid, 'merge', 'forge-git:' + sid, remove_after=True))
        self.assertTrue(decide.call_args.kwargs['force_prompt'], 'merge asks every time even with a standing allow')
        self.assertEqual(self.git('status', '--porcelain'), '', 'main checkout is left clean after the aborted merge')
        self.assertEqual((self.repo / 'code.txt').read_text(), 'base\n')
        self.assertTrue(root.is_dir(), 'conflicted merge-and-end must keep the worktree')
        self.assertIn(branch, self.git('branch', '--list', branch))
        self.assertFalse(session_manager.get_session(sid)['forge'].get('removed'))
        self.assertEqual(service.status(sid)['branch'], branch)

    def test_merge_back_and_end_removes_worktree_but_keeps_branch_and_conversation(self):
        session = self.create(); sid = session['id']; root = Path(session['workspace_dir']); branch = session['forge']['branch']
        self.write(root / 'new.txt', 'merged\n'); self.git('add', '.', cwd=root); self.git('commit', '-m', 'Topic', cwd=root)
        service = self.session_git()
        closed = []
        from services import chat_service
        async def close_brain(session_id): closed.append(session_id)
        with self.allow(), patch.object(chat_service, 'close_session_brain', close_brain):
            result = asyncio.run(service.approved(sid, 'merge', 'forge-git:' + sid, remove_after=True))
        self.assertTrue(result['ok']); self.assertEqual(closed, [sid])
        self.assertEqual((self.repo / 'new.txt').read_text(), 'merged\n')
        self.assertFalse(root.exists())
        self.assertIn(branch, self.git('branch', '--list', branch), 'merge keeps the branch (no destructive cleanup)')
        record = session_manager.get_session(sid)
        self.assertTrue(record['forge']['removed']); self.assertEqual(record['id'], sid)

    def test_merge_refuses_dirty_session_dirty_main_and_wrong_base_branch(self):
        session = self.create(); sid = session['id']; root = Path(session['workspace_dir'])
        service = self.session_git()
        self.write(root / 'dirty.txt', 'x')
        with self.assertRaisesRegex(ValueError, 'Commit your session changes'): service.merge_target(sid)
        self.git('add', '.', cwd=root); self.git('commit', '-m', 'Topic', cwd=root)
        self.write(self.repo / 'main-dirty.txt', 'x')
        with self.assertRaisesRegex(ValueError, 'main project folder has uncommitted'): service.merge_target(sid)
        (self.repo / 'main-dirty.txt').unlink()
        self.git('checkout', '-b', 'elsewhere')
        with self.assertRaisesRegex(ValueError, 'Open main in the main project folder'): service.merge_target(sid)

    # --- End session: keep / discard on dirty and conflicted sessions ----------------------
    def test_end_session_dirty_and_conflicted_never_lose_work_without_confirmation(self):
        session = self.create(); sid = session['id']; root = Path(session['workspace_dir']); branch = session['forge']['branch']
        service = self.session_git()
        self.write(root / 'code.txt', 'uncommitted\n')
        with self.assertRaises(sessions_module.ReviewConflict): service.end(sid, 'keep-branch')
        with self.assertRaises(sessions_module.ReviewConflict): service.end(sid, 'discard')
        self.assertEqual((root / 'code.txt').read_text(), 'uncommitted\n')
        self.git('add', '.', cwd=root); self.git('commit', '-m', 'Topic', cwd=root)
        # Conflict inside the worktree: merge the (diverged) base into the session branch.
        self.write(self.repo / 'code.txt', 'base\n'); self.git('add', '.'); self.git('commit', '-m', 'Base')
        completed = subprocess.run(['git', 'merge', 'main'], cwd=root, capture_output=True, text=True, env=forge_git.git_env())
        self.assertNotEqual(completed.returncode, 0)
        state = service.status(sid)
        self.assertTrue(state['files'], 'conflicted worktree reports files')
        with self.assertRaises(sessions_module.ReviewConflict): service.end(sid, 'keep-branch')
        with self.assertRaises(sessions_module.ReviewConflict): service.end(sid, 'discard')
        self.assertTrue(root.is_dir())
        # Confirmed discard removes worktree and the session branch; main checkout is untouched.
        result = service.end(sid, 'discard', confirmed=True)
        self.assertTrue(result['ok']); self.assertFalse(root.exists())
        self.assertEqual((self.repo / 'code.txt').read_text(), 'base\n')
        self.assertEqual(self.git('branch', '--show-current'), 'main')
        self.assertTrue(session_manager.get_session(sid)['forge']['removed'], 'conversation record stays, flagged removed')

    def test_keep_branch_on_clean_unmerged_session_keeps_branch_and_discard_names_it(self):
        session = self.create(); sid = session['id']; root = Path(session['workspace_dir']); branch = session['forge']['branch']
        self.write(root / 'a.txt', 'a'); self.git('add', '.', cwd=root); self.git('commit', '-m', 'A', cwd=root)
        service = self.session_git()
        with self.assertRaises(sessions_module.ReviewConflict): service.end(sid, 'discard')   # unmerged commit
        result = service.end(sid, 'keep-branch')
        self.assertEqual(result['branch'], branch)
        self.assertIn(branch, self.git('branch', '--list', branch))
        self.assertFalse(root.exists())
        # A removed worktree is a read-only session: every workspace operation refuses.
        for call in (lambda: self.service.files(sid), lambda: self.service.changes(sid),
                     lambda: self.service.save_file(sid, 'a.txt', 'x', 'h', 1)):
            with self.assertRaises((ValueError, KeyError, OSError)): call()

    def test_end_route_leave_keep_and_discard_paths(self):
        import httpx
        from fastapi import FastAPI
        from core import middleware
        from routes import forge_routes
        app = FastAPI(); app.include_router(forge_routes.router)
        app.dependency_overrides[middleware.require_admin] = lambda: 'admin'
        keep = self.create(); gone = self.create(); leave = self.create()
        service = self.session_git()
        kroot = Path(keep['workspace_dir']); groot = Path(gone['workspace_dir']); lroot = Path(leave['workspace_dir'])
        self.write(groot / 'work.txt', 'unsaved' + chr(10))
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                post = lambda sid, **body: client.post(f'/api/forge/sessions/{sid}/end', json=body)
                with patch.object(forge_routes, 'forge_sessions', self.service), patch.object(forge_routes, 'forge_session_git', service):
                    # Keep and leave: worktree, branch and files stay; only processes stop.
                    self.assertEqual((await post(leave['id'], option='leave')).status_code, 200)
                    self.assertTrue(lroot.is_dir())
                    self.assertFalse(session_manager.get_session(leave['id'])['forge'].get('removed'))
                    # Dirty worktree: neither keep-branch nor an unconfirmed discard may proceed.
                    for body in (dict(option='keep-branch'), dict(option='discard'), dict(option='discard', confirmed=False)):
                        response = await post(gone['id'], **body)
                        self.assertEqual(response.status_code, 409, body)
                    self.assertEqual((groot / 'work.txt').read_text(), 'unsaved' + chr(10))
                    self.assertEqual((await post(gone['id'], option='bogus')).status_code, 422)
                    # Clean worktree: keep-branch removes the folder and keeps the branch.
                    self.assertEqual((await post(keep['id'], option='keep-branch')).status_code, 200)
                    self.assertFalse(kroot.exists())
                    self.assertIn(keep['forge']['branch'], self.git('branch', '--list', keep['forge']['branch']))
                    self.assertTrue(session_manager.get_session(keep['id'])['forge']['removed'])
                    # Confirmed discard of the dirty one removes folder and branch.
                    done = await post(gone['id'], option='discard', confirmed=True)
                    self.assertEqual(done.status_code, 200, done.text)
                    self.assertFalse(groot.exists())
                    self.assertEqual(self.git('branch', '--list', gone['forge']['branch']), '')
                    # An ended session refuses a second end.
                    self.assertGreaterEqual((await post(gone['id'], option='keep-branch')).status_code, 400)
        asyncio.run(run())

    # --- Benchmarks (disposable repos) ------------------------------------------------------
    def test_bench_worktree_setup_changes_and_file_save(self):
        # 1,500-file project: worktree create, scan, 40 changed files, save.
        for i in range(1500):
            d = self.repo / f'pkg{i % 30}'; d.mkdir(exist_ok=True)
            self.write(d / f'mod{i}.py', f'value = {i}\n' * 20)
        self.git('add', '.'); self.git('commit', '-m', 'Many files')
        created = []
        def make():
            s = self.create(); created.append(s)
        BENCH['worktree_create_1500_files'] = timed(make, 5)
        session = created[-1]; sid = session['id']; root = Path(session['workspace_dir'])
        for i in range(40):
            self.write(root / f'pkg{i % 30}' / f'mod{i}.py', f'changed {i}\n' * 50)
        BENCH['changes_40_files'] = timed(lambda: self.service.changes(sid))
        # Regression bound (Part 2 F1; before the fix 3,000 ms, target 300 ms): generous for loaded machines.
        self.assertLess(BENCH['changes_40_files']['p50_ms'], 1500, BENCH['changes_40_files'])
        changes = self.service.changes(sid)
        self.assertEqual(len([c for c in changes['files']]), 40) if isinstance(changes, dict) and 'files' in changes else None
        BENCH['tree_root_listing'] = timed(lambda: self.service.files(sid))
        BENCH['file_read'] = timed(lambda: self.service.file(sid, 'pkg0/mod0.py'))
        snap = self.service.file(sid, 'pkg0/mod0.py')
        # Save ladder: each save rechecks the hash/mtime of the file it opened.
        def saves(size):
            state = {'f': self.service.file(sid, 'pkg1/mod1.py')}
            n = [0]
            def one():
                n[0] += 1
                f = state['f']
                state['f'] = self.service.save_file(sid, 'pkg1/mod1.py', ('x' * (size - 1) + '\n') + str(n[0]), f['hash'], f['mtime'])
            return timed(one, 15)
        for label, size in (('10KB', 10_000), ('500KB', 500_000)):
            BENCH['save_' + label] = saves(size)
        # Session git status (the Git panel refresh) with 40 dirty files.
        service = self.session_git()
        # Explorer folder expansion while 40 files are changed: it should not cost a diff per file.
        BENCH['explorer_expand_folder_40_changed'] = timed(lambda: self.service.files(sid, 'pkg1'))
        # Regression bound (Part 2 F2; before the fix 3,250 ms, target 300 ms).
        self.assertLess(BENCH['explorer_expand_folder_40_changed']['p50_ms'], 1200, BENCH['explorer_expand_folder_40_changed'])
        self.assertLess(BENCH['tree_root_listing']['p50_ms'], 1500, BENCH['tree_root_listing'])
        (root / 'untracked').mkdir(exist_ok=True)
        for i in range(300): self.write(root / 'untracked' / f'u{i}.txt', 'x' + chr(10) * 30)
        BENCH['changes_40_modified_300_untracked'] = timed(lambda: self.service.changes(sid), 3)
        BENCH['git_status_40_dirty'] = timed(lambda: service.status(sid))
        # Remove cost.
        t = time.perf_counter(); self.service.remove(sid, discard=True, confirmed=True)
        BENCH['worktree_remove_discard'] = round((time.perf_counter() - t) * 1000, 1)

    def test_bench_repo_scan_and_history(self):
        repo = self.root / 'history'; repo.mkdir()
        subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=repo, check=True)
        t = time.perf_counter(); fast_import(repo, 3000, 3, base_files=800)
        BENCH['fixture_3000_commits_build_s'] = round(time.perf_counter() - t, 2)
        project = self.projects.add(str(repo), 'History')
        cold = []
        for _ in range(3):
            forge_git._cache.clear()
            t = time.perf_counter(); result = forge_git.summary(project); cold.append(time.perf_counter() - t)
        self.assertEqual(result['state'], 'ok'); self.assertEqual(result['lifespan']['commits'], 3000)
        self.assertEqual(result['lifespan']['contributors'], 5)
        self.assertEqual(result['hotspots'][0]['commits'], 3000)
        BENCH['summary_cold_3000_commits_800_files'] = stats(cold)
        BENCH['summary_warm_cache_hit'] = timed(lambda: forge_git.summary(project), 20)
        # Same-day re-read after an unrelated index touch must still be a cache miss (stale key), then hit.
        # Home loads the list route and the activity route: with the cache that is one scan, not two.
        from routes import forge_routes
        self._route = patch.object(forge_routes, 'forge_projects', self.projects); self._route.start(); self.addCleanup(self._route.stop)
        t = time.perf_counter(); forge_git._cache.clear(); forge_routes.projects(); first = time.perf_counter() - t
        t = time.perf_counter(); forge_routes.activity(); second = time.perf_counter() - t
        BENCH['home_projects_route_cold'] = round(first * 1000, 1)
        BENCH['home_activity_route_after_projects'] = round(second * 1000, 1)
        if os.environ.get('G10_BIG'):
            big = self.root / 'big'; big.mkdir()
            subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=big, check=True)
            t = time.perf_counter(); fast_import(big, 130000, 3); BENCH['fixture_130k_build_s'] = round(time.perf_counter() - t, 1)
            bp = self.projects.add(str(big), 'Big')
            forge_git._cache.clear()
            t = time.perf_counter(); r = forge_routes.read_summary(bp)
            BENCH['summary_130k_commits'] = dict(seconds=round(time.perf_counter() - t, 1), state=r['state'], message=r.get('message'))

    def test_bench_many_projects_home_list_is_serial(self):
        projects = []
        for i in range(8):
            repo = self.root / f'p{i}'; repo.mkdir()
            subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=repo, check=True)
            fast_import(repo, 400, 3, base_files=100)
            projects.append(self.projects.add(str(repo), f'P{i}'))
        from routes import forge_routes
        self._route = patch.object(forge_routes, 'forge_projects', self.projects); self._route.start(); self.addCleanup(self._route.stop)
        forge_git._cache.clear()
        t = time.perf_counter(); rows = forge_routes.projects(); cold = time.perf_counter() - t
        t = time.perf_counter(); forge_routes.projects(); warm = time.perf_counter() - t
        self.assertEqual([r['git']['state'] for r in rows].count('ok'), 9, [r['git'] for r in rows])  # 8 + fixture project
        BENCH['home_projects_8x400_cold_ms'] = round(cold * 1000, 1)
        BENCH['home_projects_8x400_warm_ms'] = round(warm * 1000, 1)


class G10Apps(unittest.TestCase):
    setUp = _A.setUp
    _cleanup_temp = _A._cleanup_temp
    start = _A.start
    approved = _A.approved
    wait = _A.wait

    def test_bench_preview_lifecycle_and_cleanup(self):
        with self.approved():
            t = time.perf_counter(); status = self.start(); start_s = time.perf_counter() - t
            port = status['port']; self.assertTrue(status['ready'])
            pid = self.apps.records[self.sid]['process'].pid
            t = time.perf_counter(); self.apps.stop(self.sid); stop_s = time.perf_counter() - t
            self.wait(lambda: not self._listening(port))
            self.assertFalse(self._listening(port), 'port is released after stop')
            restarts = []
            for _ in range(3):
                t = time.perf_counter(); self.start(); restarts.append(time.perf_counter() - t)
                self.apps.stop(self.sid)
        BENCH['preview'] = dict(first_start_ready_ms=round(start_s * 1000), stop_ms=round(stop_s * 1000),
                                restart_ready=stats(restarts))
        self.assertEqual(self.apps.running(), [])

    def test_end_session_stops_app_and_frees_port(self):
        with self.approved():
            status = self.start()
        port = status['port']
        self.assertTrue(self._listening(port))
        self.sessions.remove(self.sid, discard=True, confirmed=True)
        self.wait(lambda: not self._listening(port))
        self.assertEqual(self.apps.running(), [])

    @staticmethod
    def _listening(port):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.3):
                return True
        except OSError:
            return False


class G10Terminal(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='g10-pty-')
        self.addCleanup(self.folder.cleanup)
        from types import SimpleNamespace
        sessions = SimpleNamespace(lock=threading.RLock(), workspace=lambda _id: Path(self.folder.name), get=lambda _id: {})
        self.service = ForgeTerminals(sessions); self.addCleanup(self.service.shutdown)
        self.tid = self.service.start('s', is_admin=True)['id']

    def collect(self, needle, timeout=30, after=0):
        text, cursor, end = '', after, time.time() + timeout
        while time.time() < end:
            out = self.service.output('s', self.tid, cursor)
            for e in out['events']:
                text += e['data']; cursor = max(cursor, e['id'])
            if needle in text: return text, cursor
            time.sleep(.02)
        self.fail('terminal never produced ' + needle + '; tail=' + repr(text[-200:]))

    def test_throughput_paste_reconnect_resize_and_cleanup(self):
        # Warm shell, then 4 MB of output: the ring keeps 200 KB; reconnect replays only the tail.
        self.service.write('s', self.tid, 'echo READY_G10\r\n'); self.collect('READY_G10')
        script = "[Console]::Out.Write(('A'*99+[char]10)*40000); echo DONE_G10_$((6*7))\r\n"
        t = time.perf_counter()
        self.service.write('s', self.tid, script)
        text, cursor = self.collect('DONE_G10_42', timeout=60)
        seconds = time.perf_counter() - t
        BENCH['terminal_output_4MB'] = dict(seconds=round(seconds, 2), mb_per_s=round(4.0 / seconds, 2))
        replay = self.service.output('s', self.tid, 0)
        size = sum(len(e['data'].encode()) for e in replay['events'])
        self.assertLessEqual(size, 200 * 1024 + 4096, 'ring buffer cap holds')
        # A client that reconnects with its cursor gets nothing it already has.
        self.assertEqual(self.service.output('s', self.tid, cursor)['events'], [])
        # 64 KB paste (the server cap) round-trips; one byte over is refused.
        # Paste the way the client does: 8192-character chunks, in order. Windows PowerShell's
        # line editor redraws per character, so cost grows faster than linearly (see report).
        paste = {}
        for size in (2000, 8000, 20000):
            data = "$g='" + 'B' * size + "'; echo LEN_$($g.Length)\r\n"
            t = time.perf_counter()
            for i in range(0, len(data), 8192): self.service.write('s', self.tid, data[i:i + 8192])
            _, cursor = self.collect('LEN_%d' % size, after=cursor, timeout=120)
            paste[str(size)] = round(time.perf_counter() - t, 2)
        BENCH['terminal_paste_seconds_by_chars'] = paste
        with self.assertRaises(ValueError): self.service.write('s', self.tid, 'C' * (64 * 1024 + 1))
        # Resize inside and outside the bounds.
        self.service.resize('s', self.tid, 40, 120)
        for rows, cols in ((1, 80), (24, 1), (301, 80), (24, 501), ('24', 80), (True, 80)):
            with self.assertRaises(ValueError): self.service.resize('s', self.tid, rows, cols)
        # Real-shell isolation: Kairos secrets are not in the shell's environment.
        with patch.dict(os.environ, {'JARVIS_G10_SECRET': 'x', 'OPENAI_API_KEY': 'x'}):
            tid2 = self.service.start('s', is_admin=True)['id']
        self.service.write('s', tid2, "echo ENV_$([bool](Get-ChildItem Env: | Where-Object { $_.Name -match 'JARVIS|OPENAI|TOKEN|SECRET|KEY' }))\r\n")
        text2 = ''
        end = time.time() + 20
        while time.time() < end and 'ENV_' + 'False' not in text2 and 'ENV_True' not in text2:
            text2 += ''.join(e['data'] for e in self.service.output('s', tid2, 0)['events']); time.sleep(.05)
        self.assertIn('ENV_False', text2, 'no secret-looking variable reaches a Forge terminal')
        # Close: process tree gone and a closed terminal refuses input.
        self.service.close('s', self.tid)
        with self.assertRaises(KeyError): self.service.write('s', self.tid, 'x')
        self.service.stop_session('s'); self.assertFalse(self.service.records)


if __name__ == '__main__':
    unittest.main()

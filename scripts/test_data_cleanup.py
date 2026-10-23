"""Subprocess checks for test fixtures escaping into the checkout or leaking."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

REPO = Path(__file__).resolve().parents[1]


def repo_fixtures():
    found = set()
    for parent, directories, _ in os.walk(REPO, followlinks=False):
        descend = []
        for name in directories:
            path = Path(parent) / name
            if name.startswith(('ask-user-', 'bg-test-')):
                found.add(str(path.relative_to(REPO)))
            elif name not in ('.git', '.venv', 'node_modules') and not path.is_junction() and not path.is_symlink():
                descend.append(name)
        directories[:] = descend
    return found


class TestDataCleanupTests(unittest.TestCase):
    def test_suites_leave_no_repo_or_temp_data(self):
        for module, fixture in (('test_ask_user', 'environment'),
                                ('test_background_tasks', 'fixture')):
            with self.subTest(module=module):
                before = repo_fixtures()
                code = f'''
import importlib, json, unittest
module = importlib.import_module('scripts.{module}')
print('TEST_DATA_ROOT=' + json.dumps(module.{fixture}.name), flush=True)
result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(module))
raise SystemExit(not result.wasSuccessful())
'''
                process = subprocess.run([sys.executable, '-c', code], cwd=REPO,
                                         capture_output=True, text=True, timeout=180)
                self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
                roots = [json.loads(line.removeprefix('TEST_DATA_ROOT='))
                         for line in process.stdout.splitlines() if line.startswith('TEST_DATA_ROOT=')]
                self.assertEqual(len(roots), 1, process.stdout)
                self.assertEqual(repo_fixtures() - before, set(), 'New test data inside checkout')
                self.assertFalse(Path(roots[0]).is_relative_to(REPO), roots[0])
                self.assertFalse(Path(roots[0]).exists(), 'Fixture was not removed: ' + roots[0])


if __name__ == '__main__':
    unittest.main(verbosity=2)

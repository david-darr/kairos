"""Offline UI/UX guidance, shipped provenance and model-surface parity."""
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
environment = tempfile.TemporaryDirectory(prefix='kairos-ui-design-')
os.environ['JARVIS_DATA_DIR'] = environment.name
from core import ui_design, system_prompt, memory_tools, tool_registry
from services import skills_service, skill_curator
from core.swarm.tools import ToolService, ToolRejected


class DesignTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        skills_service.seed_default_skills()

    def test_shipped_skill_and_references_are_seeded(self):
        self.assertTrue(skill_curator.model_visible('ui-ux-pro-max'))
        self.assertIn('ui_design', memory_tools.read_skill('ui-ux-pro-max'))
        self.assertIn('Accessibility', memory_tools.read_skill('ui-ux-pro-max', 'references/quick-reference.md'))
        manifest = json.loads((ui_design.ROOT / 'UPSTREAM.json').read_text(encoding='utf-8'))
        for name in manifest['files']:
            self.assertEqual((Path(environment.name) / 'skills' / 'ui-ux-pro-max' / name).read_bytes(), (ui_design.ROOT / name).read_bytes())

    def test_actual_local_search_and_no_persistence(self):
        before = {str(p) for p in ui_design.ROOT.rglob('*')}
        result = json.loads(ui_design.search_sync('keyboard focus modal', domain='ux'))
        self.assertEqual(result['source'], 'ui-ux-pro-max')
        self.assertIn('focus', json.dumps(result).lower())
        design = json.loads(ui_design.search_sync('desktop messaging interface', action='design_system'))
        self.assertTrue(design['result'])
        self.assertEqual(before, {str(p) for p in ui_design.ROOT.rglob('*')})

    def test_arguments_cannot_become_helper_commands_or_paths(self):
        for args in ({'query':'--persist'}, {'query':'x','action':'persist'}, {'query':'x','stack':'../../x'},
                     {'query':'x','domain':'ux','stack':'react'}, {'query':'x','limit':True}, {'query':'x','limit':7}):
            with self.subTest(args=args), self.assertRaises(ValueError): ui_design.search_sync(**args)
        with self.assertRaises(TypeError): ui_design.search_sync('x', output_dir=environment.name)
        with patch.object(skill_curator, 'model_visible', return_value=False), self.assertRaises(ValueError): ui_design.search_sync('focus')

    def test_hash_change_refuses_execution(self):
        with patch('core.ui_design.hashlib.sha256') as hash_fn:
            hash_fn.return_value.hexdigest.return_value = 'tampered'
            with patch('core.ui_design.subprocess.run') as process, self.assertRaises(ValueError): ui_design.search_sync('focus')
            process.assert_not_called()

    def test_missing_engine_and_timeout_are_readable_tool_errors(self):
        for problem in (OSError('missing'), subprocess.TimeoutExpired('search', 15)):
            with self.subTest(problem=type(problem).__name__), patch.object(ui_design, '_run', side_effect=problem), self.assertRaises(ValueError):
                ui_design.search_sync('focus')

    def test_all_general_models_and_helpers_receive_the_rule(self):
        for prompt in (system_prompt.for_claude(), system_prompt.for_external(), system_prompt.for_codex('python','cli'), system_prompt.HELPER_PROMPT):
            self.assertIn('ui-ux-pro-max', prompt)
            self.assertIn('ui_design', prompt)
        for surface in (tool_registry.CLAUDE, tool_registry.OPENAI, tool_registry.CODEX):
            for helper in (False, True):
                self.assertIn('ui_design', [s.name for s in tool_registry.specs(surface, helper=helper)])

    def test_team_workers_get_only_the_fixed_public_guide(self):
        for lead in (False, True):
            worker = ToolService(None, is_lead=lead)
            self.assertIn('ui_design', worker.definitions)
            self.assertIn('UI/UX Pro Max', worker.call('ui_design', {'action':'guide'}))
            self.assertIn('focus', worker.call('ui_design', {'action':'search','query':'keyboard focus','domain':'ux'}).lower())
            with self.assertRaises(ToolRejected): worker.call('ui_design', {'action':'guide','reference':'../../private.txt'})


if __name__ == '__main__': unittest.main()

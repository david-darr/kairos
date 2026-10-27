"""Keep tab implementations behind the stable API. Run without an app."""
import ast
import re
import unittest
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from core.tab_checks import check_python
SLUG_CODE = re.compile(r'''tab-crm|tab-school|crm_|["'](?:crm|school)["']''')


def python_code(source):
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if hasattr(node, "body") and isinstance(node.body, list):
            node.body = [n for n in node.body if not (isinstance(n, ast.Expr)
                         and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str))]
    return ast.unparse(tree), tree


def javascript_code(source):
    # Preserve quoted/template strings while discarding comments.
    tokens = r'''("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|//[^\n]*|/\*[\s\S]*?\*/'''
    return re.sub(tokens, lambda m: m[1] or "", source)


# These three exact literal spans describe the Ecosystem landscape, not tabs.
# Mask only their quoted value; imports are always checked against unmasked code.
PRESENTATION_LITERALS = {
    "static/js/ecosystemArt.js": ("if (kind === 'school') return svg(common +",),
    "static/js/ecosystemModel.js": (
        "school: { name: 'School', description: 'Classes, coursework and studying', kind: 'school' }",
        r"['school', /\b(school|homework|coursework|course|class|classes|assignment|semester|exam|quiz|lecture|study|studying|student|tutor|curriculum)\b/i],",
    ),
}
TAB_IMPORT = re.compile(r'''(?:from\s*|import\s*(?:\(\s*)?)["'][^"']*(?:kairos_tabs|/tabs/)''')

# Direct custom-tab endpoints are dependencies even without a tab DOM slug.
TAB_ROUTE = re.compile(r'''["'`]/api/(?:school|crm|tabs/(?:school|crm))(?=[/?#"'`])''')


class TabBoundaries(unittest.TestCase):
    def assert_javascript_boundary(self, source, relative):
        code = javascript_code(source)
        self.assertIsNone(TAB_IMPORT.search(code), "tab import in base JavaScript")
        self.assertIsNone(TAB_ROUTE.search(code), "direct tab route in base JavaScript")
        for span in PRESENTATION_LITERALS.get(relative, ()):
            self.assertEqual(code.count(span), 1, f"reviewed presentation span changed: {relative}")
            code = code.replace(span, span.replace("'school'", "'landscape-school'"), 1)
        self.assertIsNone(SLUG_CODE.search(code))

    def test_presentation_exceptions_do_not_hide_tab_dependencies(self):
        dependencies = (
            "import tab from '../tabs/school/index.js';",
            "import('../tabs/school/index.js');",
            "import '../tabs/school/index.js';",
            "import tab from 'kairos_tabs/school';",
            "const route = '/api/tab-school/items';",
            "fetch('/api/school/courses');",
            "api('/api/crm/contacts');",
            "api('/api/tabs/crm/items');",
            "fetch('/api/tabs/school/courses');",
            "const route = `/api/tabs/school/${id}`;",
            "document.querySelector('#tab-school');",
            "navigate('school');",
            "const crm_state = {};",
        )
        for relative in PRESENTATION_LITERALS:
            source = (REPO / relative).read_text(encoding="utf-8")
            self.assert_javascript_boundary(source, relative)
            for dependency in dependencies:
                with self.subTest(file=relative, dependency=dependency):
                    with self.assertRaises(AssertionError):
                        self.assert_javascript_boundary(source + "\n" + dependency, relative)
            for span in PRESENTATION_LITERALS[relative]:
                for changed in (source.replace(span, "", 1), source + "\n" + span):
                    with self.subTest(file=relative, span=span, mutation="missing or duplicated"):
                        with self.assertRaises(AssertionError):
                            self.assert_javascript_boundary(changed, relative)

    def test_base_code_has_no_tab_implementation_dependencies(self):
        files = [REPO / "app.py"]
        for folder in ("core", "routes", "services"):
            files += list((REPO / folder).rglob("*.py"))
        for path in files:
            with self.subTest(file=str(path.relative_to(REPO))):
                code, tree = python_code(path.read_text(encoding="utf-8-sig"))
                self.assertIsNone(SLUG_CODE.search(code))
                for node in ast.walk(tree):
                    modules = ([a.name for a in node.names] if isinstance(node, ast.Import)
                               else [node.module or ""] if isinstance(node, ast.ImportFrom) else [])
                    self.assertFalse(any(m.split(".")[0] in ("kairos_tabs", "tabs") for m in modules))
        for path in (REPO / "static/js").rglob("*.js"):
            with self.subTest(file=str(path.relative_to(REPO))):
                self.assert_javascript_boundary(path.read_text(encoding="utf-8"), path.relative_to(REPO).as_posix())

    def test_tabs_import_kairos_only_through_tab_api(self):
        for path in (REPO / "tabs").rglob("*.py"):
            with self.subTest(file=str(path.relative_to(REPO))):
                check_python(path.read_text(encoding="utf-8"), str(path))


if __name__ == "__main__":
    unittest.main()

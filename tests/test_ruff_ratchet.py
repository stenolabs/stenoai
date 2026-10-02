import ast
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import ruff_ratchet


class RuffRatchetTests(unittest.TestCase):
    FINDING_A = "a" * 64
    FINDING_B = "b" * 64

    def _baseline(self, root: Path, content: dict) -> Path:
        path = root / "baseline.json"
        path.write_text(json.dumps(content), encoding="utf-8")
        return path

    def test_matches_the_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            findings = {"src/example.py": {"F401": {self.FINDING_A: 2}}}
            baseline = self._baseline(root, findings)
            with patch.object(ruff_ratchet, "ruff_findings", return_value=findings):
                self.assertEqual(ruff_ratchet.check(baseline_path=baseline, update=False, root=root), 0)

    def test_new_finding_fails_without_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = self._baseline(root, {"src/example.py": {"F401": {self.FINDING_A: 1}}})
            findings = {"src/example.py": {"F401": {self.FINDING_A: 1, self.FINDING_B: 1}}}
            with patch.object(ruff_ratchet, "ruff_findings", return_value=findings):
                self.assertEqual(ruff_ratchet.check(baseline_path=baseline, update=False, root=root), 1)

    def test_burn_down_also_requires_an_explicit_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = self._baseline(root, {"src/example.py": {"F401": {self.FINDING_A: 2}}})
            findings = {"src/example.py": {"F401": {self.FINDING_A: 1}}}
            with patch.object(ruff_ratchet, "ruff_findings", return_value=findings):
                self.assertEqual(ruff_ratchet.check(baseline_path=baseline, update=False, root=root), 1)

    def test_update_writes_stably_sorted_current_findings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = self._baseline(root, {})
            findings = {
                "z.py": {"F841": {self.FINDING_B: 1}},
                "a.py": {
                    "F401": {self.FINDING_B: 1, self.FINDING_A: 2},
                    "E401": {self.FINDING_A: 1},
                },
            }
            with patch.object(ruff_ratchet, "ruff_findings", return_value=findings):
                self.assertEqual(ruff_ratchet.check(baseline_path=baseline, update=True, root=root), 0)
            self.assertEqual(json.loads(baseline.read_text(encoding="utf-8")), {
                "a.py": {
                    "E401": {self.FINDING_A: 1},
                    "F401": {self.FINDING_A: 2, self.FINDING_B: 1},
                },
                "z.py": {"F841": {self.FINDING_B: 1}},
            })

    def test_absolute_ruff_paths_are_normalized_to_posix_repo_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()
            filename.write_text("x = 1\n", encoding="utf-8")
            version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
            diagnostics = unittest.mock.Mock(
                returncode=1,
                stdout=json.dumps([{
                    "filename": str(filename),
                    "code": "F401",
                    "message": "example finding",
                    "location": {"row": 1, "column": 1},
                    "end_location": {"row": 1, "column": 2},
                }]),
                stderr="",
            )
            with patch.object(ruff_ratchet, "_run", side_effect=[version, diagnostics]):
                findings = ruff_ratchet.ruff_findings(root)
            identities = findings["src/example.py"]["F401"]
            self.assertEqual(sum(identities.values()), 1)
            self.assertRegex(next(iter(identities)), r"^[0-9a-f]{64}$")

    def test_clean_ruff_exit_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
            clean = unittest.mock.Mock(returncode=0, stdout="[]", stderr="")
            with patch.object(ruff_ratchet, "_run", side_effect=[version, clean]):
                self.assertEqual(ruff_ratchet.ruff_findings(root), {})

    def test_baseline_rejects_non_posix_or_absolute_filenames(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = self._baseline(root, {"C:\\repo\\file.py": {"F401": 1}})
            with self.assertRaisesRegex(RuntimeError, "POSIX relative"):
                ruff_ratchet.read_baseline(baseline)

    def test_wrong_ruff_version_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bad_version = unittest.mock.Mock(returncode=0, stdout="ruff 0.16.0\n", stderr="")
            with patch.object(ruff_ratchet, "_run", return_value=bad_version):
                with self.assertRaisesRegex(RuntimeError, "Expected ruff 0.15.21"):
                    ruff_ratchet.ruff_findings(root)

    def test_same_count_with_a_different_concrete_finding_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def findings(source: str, message: str):
                filename.write_text(source, encoding="utf-8")
                version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
                diagnostics = unittest.mock.Mock(
                    returncode=1,
                    stdout=json.dumps([{
                        "filename": str(filename),
                        "code": "F401",
                        "message": message,
                        "location": {"row": 1, "column": 8},
                        "end_location": {"row": 1, "column": len(source)},
                    }]),
                    stderr="",
                )
                with patch.object(ruff_ratchet, "_run", side_effect=[version, diagnostics]):
                    return ruff_ratchet.ruff_findings(root)

            before = findings("import os\n", "`os` imported but unused")
            after = findings("import sys\n", "`sys` imported but unused")

            self.assertNotEqual(before, after)
            self.assertTrue(ruff_ratchet.differences(before, after))

    def test_pure_line_shift_keeps_the_same_concrete_finding_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def findings(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
                diagnostics = unittest.mock.Mock(
                    returncode=1,
                    stdout=json.dumps([{
                        "filename": str(filename),
                        "code": "F401",
                        "message": "`os` imported but unused",
                        "location": {"row": row, "column": 8},
                        "end_location": {"row": row, "column": 10},
                    }]),
                    stderr="",
                )
                with patch.object(ruff_ratchet, "_run", side_effect=[version, diagnostics]):
                    return ruff_ratchet.ruff_findings(root)

            before = findings("import os\n", 1)
            after = findings("\n\nimport os\n", 3)

            self.assertEqual(before, after)
            self.assertEqual(ruff_ratchet.differences(before, after), [])

    def test_same_finding_text_moved_between_function_scopes_is_a_swap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def findings(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
                diagnostics = unittest.mock.Mock(
                    returncode=1,
                    stdout=json.dumps([{
                        "filename": str(filename),
                        "code": "F841",
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 5},
                        "end_location": {"row": row, "column": 11},
                    }]),
                    stderr="",
                )
                with patch.object(ruff_ratchet, "_run", side_effect=[version, diagnostics]):
                    return ruff_ratchet.ruff_findings(root)

            before = findings(
                "def old_scope():\n"
                "    unused = 1\n\n"
                "def new_scope():\n"
                "    return 1\n",
                2,
            )
            after = findings(
                "def old_scope():\n"
                "    return 1\n\n"
                "def new_scope():\n"
                "    unused = 1\n",
                5,
            )

            self.assertNotEqual(before, after)
            self.assertTrue(ruff_ratchet.differences(before, after))

    def test_formatting_outside_ruff_span_keeps_the_same_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def findings(source: str):
                filename.write_text(source, encoding="utf-8")
                version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
                diagnostics = unittest.mock.Mock(
                    returncode=1,
                    stdout=json.dumps([{
                        "filename": str(filename),
                        "code": "F841",
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": 2, "column": 5},
                        "end_location": {"row": 2, "column": 11},
                    }]),
                    stderr="",
                )
                with patch.object(ruff_ratchet, "_run", side_effect=[version, diagnostics]):
                    return ruff_ratchet.ruff_findings(root)

            before = findings("def f():\n    unused = dict(a = 1)\n")
            after = findings("def f():\n    unused = dict(a=1)\n")

            self.assertEqual(before, after)
            self.assertEqual(ruff_ratchet.differences(before, after), [])

    def test_spacing_change_inside_e401_span_keeps_the_same_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def findings(source: str):
                filename.write_text(source, encoding="utf-8")
                line = source.rstrip("\n")
                version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
                diagnostics = unittest.mock.Mock(
                    returncode=1,
                    stdout=json.dumps([{
                        "filename": str(filename),
                        "code": "E401",
                        "message": "Multiple imports on one line",
                        "location": {"row": 1, "column": 1},
                        "end_location": {"row": 1, "column": len(line) + 1},
                    }]),
                    stderr="",
                )
                with patch.object(ruff_ratchet, "_run", side_effect=[version, diagnostics]):
                    return ruff_ratchet.ruff_findings(root)

            before = findings("import os,sys\n")
            after = findings("import os, sys\n")

            self.assertEqual(before, after)
            self.assertEqual(ruff_ratchet.differences(before, after), [])

    def test_quote_change_inside_f541_span_keeps_the_same_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def findings(source: str):
                filename.write_text(source, encoding="utf-8")
                line = source.splitlines()[1]
                version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
                diagnostics = unittest.mock.Mock(
                    returncode=1,
                    stdout=json.dumps([{
                        "filename": str(filename),
                        "code": "F541",
                        "message": "f-string without any placeholders",
                        "location": {"row": 2, "column": line.index("f") + 1},
                        "end_location": {"row": 2, "column": line.rindex(")") + 1},
                    }]),
                    stderr="",
                )
                with patch.object(ruff_ratchet, "_run", side_effect=[version, diagnostics]):
                    return ruff_ratchet.ruff_findings(root)

            before = findings('def f():\n    print(f"constant")\n')
            after = findings("def f():\n    print(f'constant')\n")

            self.assertEqual(before, after)
            self.assertEqual(ruff_ratchet.differences(before, after), [])

    def test_same_named_platform_scopes_have_distinct_identities(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def findings(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                version = unittest.mock.Mock(returncode=0, stdout="ruff 0.15.21\n", stderr="")
                diagnostics = unittest.mock.Mock(
                    returncode=1,
                    stdout=json.dumps([{
                        "filename": str(filename),
                        "code": "F841",
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 13},
                        "end_location": {"row": row, "column": 19},
                    }]),
                    stderr="",
                )
                with patch.object(ruff_ratchet, "_run", side_effect=[version, diagnostics]):
                    return ruff_ratchet.ruff_findings(root)

            before = findings(
                "import sys\n"
                "if sys.platform == 'win32':\n"
                "    class Backend:\n"
                "        def start(self):\n"
                "            unused = 1\n"
                "else:\n"
                "    class Backend:\n"
                "        def start(self):\n"
                "            return 1\n",
                5,
            )
            after = findings(
                "import sys\n"
                "if sys.platform == 'win32':\n"
                "    class Backend:\n"
                "        def start(self):\n"
                "            return 1\n"
                "else:\n"
                "    class Backend:\n"
                "        def start(self):\n"
                "            unused = 1\n",
                9,
            )

            self.assertNotEqual(before, after)
            self.assertTrue(ruff_ratchet.differences(before, after))

    @unittest.skipUnless(sys.version_info >= (3, 10), "match requires Python 3.10+")
    def test_control_flow_arms_have_distinct_finding_identities(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def fingerprints(source: str) -> set[str]:
                filename.write_text(source, encoding="utf-8")
                results = set()
                for row, line in enumerate(source.splitlines(), start=1):
                    if "unused = 1" not in line:
                        continue
                    column = line.index("unused") + 1
                    results.add(ruff_ratchet._finding_fingerprint(
                        {
                            "message": "Local variable `unused` is assigned to but never used",
                            "location": {"row": row, "column": column},
                            "end_location": {"row": row, "column": column + len("unused")},
                        },
                        filename="src/example.py",
                        code="F841",
                        root=root,
                    ))
                return results

            try_source = (
                "def f(value):\n"
                "    try:\n"
                "        unused = 1\n"
                "    except ValueError as error:\n"
                "        unused = 1\n"
                "    else:\n"
                "        unused = 1\n"
                "    finally:\n"
                "        unused = 1\n"
            )
            for_source = (
                "def f(items):\n"
                "    for item in items:\n"
                "        unused = 1\n"
                "    else:\n"
                "        unused = 1\n"
            )
            while_source = (
                "def f(ready):\n"
                "    while ready:\n"
                "        unused = 1\n"
                "    else:\n"
                "        unused = 1\n"
            )
            match_source = (
                "def f(value):\n"
                "    match value:\n"
                "        case 1:\n"
                "            unused = 1\n"
                "        case _:\n"
                "            unused = 1\n"
            )

            self.assertEqual(len(fingerprints(try_source)), 4)
            self.assertEqual(len(fingerprints(for_source)), 2)
            self.assertEqual(len(fingerprints(while_source)), 2)
            self.assertEqual(len(fingerprints(match_source)), 2)

    @unittest.skipUnless(sys.version_info >= (3, 10), "match requires Python 3.10+")
    def test_except_and_match_header_bindings_keep_their_arm_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def fingerprints(source: str) -> set[str]:
                filename.write_text(source, encoding="utf-8")
                results = set()
                for row, line in enumerate(source.splitlines(), start=1):
                    if "unused" not in line:
                        continue
                    column = line.index("unused") + 1
                    results.add(ruff_ratchet._finding_fingerprint(
                        {
                            "message": "Local variable `unused` is assigned to but never used",
                            "location": {"row": row, "column": column},
                            "end_location": {"row": row, "column": column + len("unused")},
                        },
                        filename="src/example.py",
                        code="F841",
                        root=root,
                    ))
                return results

            except_source = (
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError as unused:\n"
                "        pass\n"
                "    except TypeError as unused:\n"
                "        pass\n"
            )
            match_source = (
                "def f(value):\n"
                "    match value:\n"
                "        case {'a': unused}:\n"
                "            pass\n"
                "        case {'b': unused}:\n"
                "            pass\n"
            )
            loop_source = (
                "def f(first, second):\n"
                "    for unused in first:\n"
                "        pass\n"
                "    for unused in second:\n"
                "        pass\n"
            )
            duplicate_except_source = (
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError as unused:\n"
                "        pass\n"
                "    except ValueError as unused:\n"
                "        pass\n"
            )
            duplicate_match_source = (
                "def f(value):\n"
                "    match value:\n"
                "        case {'a': unused}:\n"
                "            pass\n"
                "        case {'a': unused}:\n"
                "            pass\n"
            )

            self.assertEqual(len(fingerprints(except_source)), 2)
            self.assertEqual(len(fingerprints(match_source)), 2)
            self.assertEqual(len(fingerprints(loop_source)), 2)
            self.assertEqual(len(fingerprints(duplicate_except_source)), 2)
            self.assertEqual(len(fingerprints(duplicate_match_source)), 2)

    def test_identical_sibling_loops_keep_findings_in_their_own_occurrence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 9},
                        "end_location": {"row": row, "column": 15},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f(items):\n"
                "    for item in items:\n"
                "        unused = 1\n"
                "    for item in items:\n"
                "        pass\n",
                3,
            )
            after = finding(
                "def f(items):\n"
                "    for item in items:\n"
                "        pass\n"
                "    for item in items:\n"
                "        unused = 1\n",
                5,
            )
            shifted_after = finding(
                "\n"
                "def f(items):\n"
                "    marker = 1\n"
                "    for item in items:\n"
                "        pass\n"
                "\n"
                "    for item in items:\n"
                "        unused = 1\n",
                8,
            )

            self.assertNotEqual(before, after)
            self.assertEqual(after, shifted_after)

    def test_try_handler_identity_ignores_an_inserted_unrelated_handler(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 26},
                        "end_location": {"row": row, "column": 32},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                4,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except KeyError:\n"
                "        pass\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                6,
            )
            appended = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError as unused:\n"
                "        pass\n"
                "    except KeyError:\n"
                "        pass\n",
                4,
            )

            self.assertEqual(before, after)
            self.assertEqual(before, appended)

    def test_try_handler_identity_ignores_an_unrelated_try_body_statement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 26},
                        "end_location": {"row": row, "column": 32},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        work()\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                4,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        log()\n"
                "        work()\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                5,
            )
            appended = finding(
                "def f():\n"
                "    try:\n"
                "        work()\n"
                "        log()\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                5,
            )

            self.assertEqual(before, after)
            self.assertEqual(before, appended)

    def test_try_body_finding_ignores_exception_alias_rename(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 9},
                        "end_location": {"row": row, "column": 15},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        unused = 1\n"
                "    except ValueError as error:\n"
                "        report(error)\n",
                3,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        unused = 1\n"
                "    except ValueError as exc:\n"
                "        report(exc)\n",
                3,
            )

            self.assertEqual(before, after)

    def test_handler_finding_ignores_exception_alias_rename(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 9},
                        "end_location": {"row": row, "column": 15},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError as error:\n"
                "        report(error)\n"
                "        unused = 1\n",
                6,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError as exc:\n"
                "        report(exc)\n"
                "        unused = 1\n",
                6,
            )

            self.assertEqual(before, after)

    @unittest.skipUnless(sys.version_info >= (3, 10), "match requires Python 3.10+")
    def test_match_case_identity_ignores_an_inserted_unrelated_case(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 13},
                        "end_location": {"row": row, "column": 19},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 1:\n"
                "            unused = 1\n",
                4,
            )
            after = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 0:\n"
                "            pass\n"
                "        case 1:\n"
                "            unused = 1\n",
                6,
            )
            appended = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 1:\n"
                "            unused = 1\n"
                "        case 0:\n"
                "            pass\n",
                4,
            )

            self.assertEqual(before, after)
            self.assertEqual(before, appended)

    def test_nonidentical_sibling_loop_insert_keeps_existing_occurrence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 9},
                        "end_location": {"row": row, "column": 15},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f(items, other_items):\n"
                "    for item in items:\n"
                "        pass\n"
                "    for item in items:\n"
                "        unused = 1\n",
                5,
            )
            after = finding(
                "def f(items, other_items):\n"
                "    for other in other_items:\n"
                "        pass\n"
                "    for item in items:\n"
                "        pass\n"
                "    for item in items:\n"
                "        unused = 1\n",
                7,
            )

            self.assertEqual(before, after)

    def test_unrelated_try_insert_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 26},
                        "end_location": {"row": row, "column": 32},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        primary()\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                4,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        secondary()\n"
                "    except KeyError:\n"
                "        pass\n"
                "    try:\n"
                "        primary()\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                8,
            )

            self.assertEqual(before, after)

    def test_try_move_plus_reorder_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 26},
                        "end_location": {"row": row, "column": 32},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        first()\n"
                "    except ValueError as unused:\n"
                "        pass\n"
                "    try:\n"
                "        second()\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                4,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        first()\n"
                "    except ValueError as unused:\n"
                "        pass\n"
                "    try:\n"
                "        second()\n"
                "    except ValueError as unused:\n"
                "        pass\n",
                8,
            )

            self.assertNotEqual(before, after)

    def test_try_body_move_between_same_handler_siblings_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 9},
                        "end_location": {"row": row, "column": 15},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        unused = 1\n"
                "    except ValueError:\n"
                "        pass\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError:\n"
                "        pass\n",
                3,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError:\n"
                "        pass\n"
                "    try:\n"
                "        unused = 1\n"
                "    except ValueError:\n"
                "        pass\n",
                7,
            )

            self.assertNotEqual(before, after)

    def test_unrelated_try_prepend_keeps_body_finding_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 9},
                        "end_location": {"row": row, "column": 15},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        unused = 1\n"
                "    except ValueError:\n"
                "        pass\n",
                3,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except KeyError:\n"
                "        pass\n"
                "    try:\n"
                "        unused = 1\n"
                "    except ValueError:\n"
                "        pass\n",
                7,
            )

            self.assertEqual(before, after)

    def test_try_body_move_between_different_handler_structures_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 9},
                        "end_location": {"row": row, "column": 15},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        unused = 1\n"
                "    except ValueError:\n"
                "        pass\n"
                "    try:\n"
                "        pass\n"
                "    except KeyError:\n"
                "        pass\n",
                3,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError:\n"
                "        pass\n"
                "    try:\n"
                "        unused = 1\n"
                "    except KeyError:\n"
                "        pass\n",
                7,
            )

            self.assertNotEqual(before, after)

    def test_absent_else_and_finally_arms_do_not_create_siblings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 9},
                        "end_location": {"row": row, "column": 15},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError:\n"
                "        pass\n"
                "    else:\n"
                "        unused = 1\n",
                7,
            )
            after = finding(
                "def f():\n"
                "    try:\n"
                "        pass\n"
                "    except KeyError:\n"
                "        pass\n"
                "    try:\n"
                "        pass\n"
                "    except ValueError:\n"
                "        pass\n"
                "    else:\n"
                "        unused = 1\n",
                11,
            )

            self.assertEqual(before, after)

        for source in (
            "if ready:\n    pass\n",
            "for item in items:\n    pass\n",
            "while ready:\n    pass\n",
        ):
            node = ast.parse(source).body[0]
            self.assertFalse(any(token.endswith(":else") for token in ruff_ratchet._control_flow_branch_tokens(node)))

    @unittest.skipUnless(sys.version_info >= (3, 10), "match requires Python 3.10+")
    def test_unrelated_match_insert_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 13},
                        "end_location": {"row": row, "column": 19},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 1:\n"
                "            unused = 1\n",
                4,
            )
            after = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 0:\n"
                "            pass\n"
                "    match value:\n"
                "        case 1:\n"
                "            unused = 1\n",
                7,
            )

            self.assertEqual(before, after)

    @unittest.skipUnless(sys.version_info >= (3, 10), "match requires Python 3.10+")
    def test_match_moves_between_different_case_structures_are_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 13},
                        "end_location": {"row": row, "column": 19},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 1:\n"
                "            unused = 1\n"
                "    match value:\n"
                "        case 2:\n"
                "            pass\n",
                4,
            )
            after = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 2:\n"
                "            unused = 1\n"
                "    match value:\n"
                "        case 1:\n"
                "            pass\n",
                4,
            )

            self.assertNotEqual(before, after)

    @unittest.skipUnless(sys.version_info >= (3, 10), "match requires Python 3.10+")
    def test_match_case_move_between_same_case_siblings_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            filename = root / "src" / "example.py"
            filename.parent.mkdir()

            def finding(source: str, row: int):
                filename.write_text(source, encoding="utf-8")
                return ruff_ratchet._finding_fingerprint(
                    {
                        "message": "Local variable `unused` is assigned to but never used",
                        "location": {"row": row, "column": 13},
                        "end_location": {"row": row, "column": 19},
                    },
                    filename="src/example.py",
                    code="F841",
                    root=root,
                )

            before = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 1:\n"
                "            unused = 1\n"
                "        case 2:\n"
                "            pass\n"
                "    match value:\n"
                "        case 1:\n"
                "            pass\n"
                "        case 3:\n"
                "            pass\n",
                4,
            )
            after = finding(
                "def f(value):\n"
                "    match value:\n"
                "        case 1:\n"
                "            pass\n"
                "        case 2:\n"
                "            pass\n"
                "    match value:\n"
                "        case 1:\n"
                "            unused = 1\n"
                "        case 3:\n"
                "            pass\n",
                9,
            )

            self.assertNotEqual(before, after)

    def test_scope_context_handles_ast_classes_absent_on_python_39(self):
        missing = object()
        try_star = getattr(ruff_ratchet.ast, "TryStar", missing)
        match = getattr(ruff_ratchet.ast, "Match", missing)
        try:
            if try_star is not missing:
                delattr(ruff_ratchet.ast, "TryStar")
            if match is not missing:
                delattr(ruff_ratchet.ast, "Match")
            context = ruff_ratchet._scope_context(ast.parse("if ready:\n    unused = 1\n"), 2)
            self.assertEqual(len(context), 2)
            self.assertTrue(context[-1].endswith(":body"))
        finally:
            if try_star is not missing:
                setattr(ruff_ratchet.ast, "TryStar", try_star)
            if match is not missing:
                setattr(ruff_ratchet.ast, "Match", match)

    def test_ast_serialization_is_independent_of_runtime_dump_defaults(self):
        def complete_dump(node: ast.AST) -> str:
            try:
                return ast.dump(node, include_attributes=False, show_empty=True)
            except TypeError:
                # Python 3.11 and 3.12 always include empty fields and do not
                # expose the show_empty switch added in Python 3.13.
                return ast.dump(node, include_attributes=False)

        module = ast.parse("import os, sys")
        function_args = ast.parse("def example():\n    pass\n").body[0].args

        self.assertEqual(ruff_ratchet._stable_ast_dump(module), complete_dump(module))
        self.assertEqual(
            ruff_ratchet._stable_ast_dump(function_args),
            complete_dump(function_args),
        )

    def test_protected_t1_job_directly_runs_both_new_lint_gates(self):
        workflow = (Path(__file__).parents[1] / ".github" / "workflows" / "e2e.yml").read_text()
        t1_body = workflow.split("  t1-renderer:\n", 1)[1].split("\n  lint-renderer:\n", 1)[0]

        self.assertIn("npm run lint:main", t1_body)
        self.assertIn("python scripts/ruff_ratchet.py", t1_body)
        self.assertNotIn("continue-on-error:", t1_body)

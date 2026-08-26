import hashlib
import importlib.util
from pathlib import Path
import re
import unittest


_SCRIPT = Path(__file__).parents[1] / "dev" / "scripts" / "repository_privacy_guard.py"
_SPEC = importlib.util.spec_from_file_location("repository_privacy_guard", _SCRIPT)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("Unable to load repository privacy guard")
privacy_guard = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(privacy_guard)


class RepositoryPrivacyGuardTests(unittest.TestCase):
    @staticmethod
    def fingerprint(value: str) -> str:
        return hashlib.sha256(
            privacy_guard.normalize_candidate(value).encode("utf-8")
        ).hexdigest()

    def test_fingerprint_detects_a_blocked_phrase_without_storing_it_in_the_guard(self):
        blocked = "Private Fixture"
        fingerprints = {
            hashlib.sha256(privacy_guard.normalize_candidate(blocked).encode("utf-8")).hexdigest()
        }

        violations = privacy_guard.scan_text(
            Path("example.test.ts"),
            "const participant = 'Private Fixture';",
            blocked_fingerprints=fingerprints,
        )

        self.assertEqual([(item.line, item.rule) for item in violations], [(1, "blocked-value")])

    def test_fingerprint_does_not_reject_unrelated_synthetic_fixtures(self):
        blocked = "Private Fixture"
        fingerprints = {
            hashlib.sha256(privacy_guard.normalize_candidate(blocked).encode("utf-8")).hexdigest()
        }

        violations = privacy_guard.scan_text(
            Path("example.test.ts"),
            "const participant = 'Casey Example';",
            blocked_fingerprints=fingerprints,
        )

        self.assertEqual(violations, [])

    def test_known_literal_local_home_directory_is_rejected(self):
        local_path = "/" + "Users" + "/alice/Dev/project"
        private_path_fingerprints = {
            hashlib.sha256(privacy_guard.normalize_candidate("alice").encode("utf-8")).hexdigest()
        }

        violations = privacy_guard.scan_text(
            Path("notes.md"),
            f"Run the tool from {local_path}.",
            blocked_fingerprints=set(),
            blocked_path_fingerprints=private_path_fingerprints,
        )

        self.assertEqual([(item.line, item.rule) for item in violations], [(1, "local-user-path")])

    def test_escaped_windows_home_directory_is_rejected(self):
        fingerprints = {self.fingerprint("alice")}

        violations = privacy_guard.scan_text(
            Path("example.test.ts"),
            r"const home = 'C:\\Users\\alice\\project';",
            blocked_fingerprints=set(),
            blocked_path_fingerprints=fingerprints,
        )

        self.assertEqual([(item.line, item.rule) for item in violations], [(1, "local-user-path")])

    def test_documented_user_placeholder_is_allowed(self):
        placeholder = "/" + "Users" + "/<user>/Dev/project"
        fingerprints = {self.fingerprint("alice")}

        violations = privacy_guard.scan_text(
            Path("notes.md"),
            f"Run the tool from {placeholder}.",
            blocked_fingerprints=set(),
            blocked_path_fingerprints=fingerprints,
        )

        self.assertEqual(violations, [])

    def test_synthetic_local_home_directory_is_allowed(self):
        synthetic_path = "/" + "Users" + "/alice/Dev/project"

        violations = privacy_guard.scan_text(
            Path("notes.md"),
            f"The redaction test uses {synthetic_path}.",
            blocked_fingerprints=set(),
            blocked_path_fingerprints={self.fingerprint("bob")},
        )

        self.assertEqual(violations, [])

    def test_single_name_fingerprint_is_limited_to_fixture_contexts(self):
        fixture_name = "Fixtureperson"
        fingerprints = {
            hashlib.sha256(
                privacy_guard.normalize_candidate(fixture_name).encode("utf-8")
            ).hexdigest()
        }

        public_attribution = privacy_guard.scan_text(
            Path("README.md"),
            f"Maintainer: {fixture_name}",
            blocked_fingerprints=set(),
            fixture_only_fingerprints=fingerprints,
        )
        fixture = privacy_guard.scan_text(
            Path("tests/example_test.py"),
            f"participant = '{fixture_name}'",
            blocked_fingerprints=set(),
            fixture_only_fingerprints=fingerprints,
        )

        self.assertEqual(public_attribution, [])
        self.assertEqual([(item.line, item.rule) for item in fixture], [(1, "blocked-value")])

    def test_fixture_fingerprint_detects_a_possessive_name(self):
        fixture_name = "Fixtureperson"
        fingerprints = {
            hashlib.sha256(
                privacy_guard.normalize_candidate(fixture_name).encode("utf-8")
            ).hexdigest()
        }

        violations = privacy_guard.scan_text(
            Path("docs/superpowers/plans/example.md"),
            "Publishing is Fixtureperson's call.",
            blocked_fingerprints=set(),
            fixture_only_fingerprints=fingerprints,
        )

        self.assertEqual([(item.line, item.rule) for item in violations], [(1, "blocked-value")])

    def test_fixture_context_covers_repo_fixture_conventions(self):
        fingerprints = {self.fingerprint("Fixtureperson")}
        fixture_paths = (
            Path("app/e2e-mock-ipc.js"),
            Path("app/__tests__/example.js"),
            Path("app/fixtures/example.js"),
            Path("src/example.spec.ts"),
            Path("src/test_example.py"),
            Path("src/example_test.py"),
            Path("docs/superpowers/specs/example.md"),
        )

        for path in fixture_paths:
            with self.subTest(path=path):
                violations = privacy_guard.scan_text(
                    path,
                    "Fixtureperson",
                    blocked_fingerprints=set(),
                    fixture_only_fingerprints=fingerprints,
                )
                self.assertEqual(
                    [(item.line, item.rule) for item in violations],
                    [(1, "blocked-value")],
                )

    def test_hyphenated_full_name_is_rejected(self):
        fingerprints = {self.fingerprint("Private Fixture")}

        violations = privacy_guard.scan_text(
            Path("example.md"),
            "private-fixture",
            blocked_fingerprints=fingerprints,
        )

        self.assertEqual([(item.line, item.rule) for item in violations], [(1, "blocked-value")])

    def test_camel_case_fixture_name_is_rejected(self):
        fingerprints = {self.fingerprint("Fixtureperson")}

        violations = privacy_guard.scan_text(
            Path("example.test.ts"),
            "const fixturepersonNotes = true;",
            blocked_fingerprints=set(),
            fixture_only_fingerprints=fingerprints,
        )

        self.assertEqual([(item.line, item.rule) for item in violations], [(1, "blocked-value")])

    def test_blocked_name_in_a_path_is_rejected(self):
        fingerprints = {self.fingerprint("Private Fixture")}

        violations = privacy_guard.scan_path(
            Path("docs/private-fixture-notes.md"),
            blocked_fingerprints=fingerprints,
        )

        self.assertIn("blocked-path-value", {item.rule for item in violations})

    def test_recording_and_transcript_artifacts_are_rejected_by_path(self):
        recording = Path("recordings") / "meeting.wav"
        transcript = Path("fixtures") / "private-transcript.m4a"

        self.assertIn("user-data-artifact", {item.rule for item in privacy_guard.scan_path(recording)})
        self.assertIn("media-artifact", {item.rule for item in privacy_guard.scan_path(transcript)})

    def test_source_files_about_recording_are_allowed(self):
        self.assertEqual(privacy_guard.scan_path(Path("docs/features/recording.mdx")), [])

    def test_shipped_fingerprints_are_well_formed(self):
        collections = (
            privacy_guard.KNOWN_PRIVATE_FINGERPRINTS,
            privacy_guard.KNOWN_PRIVATE_FIXTURE_FINGERPRINTS,
            privacy_guard.KNOWN_PRIVATE_PATH_FINGERPRINTS,
        )

        for fingerprints in collections:
            self.assertTrue(fingerprints)
            self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", value) for value in fingerprints))

    def test_primary_ci_runs_the_repository_privacy_guard(self):
        privacy_workflow = (
            Path(__file__).parents[1] / ".github" / "workflows" / "privacy.yml"
        ).read_text()
        e2e_workflow = (
            Path(__file__).parents[1] / ".github" / "workflows" / "e2e.yml"
        ).read_text()
        triggers = privacy_workflow.split("jobs:", maxsplit=1)[0]
        required_t1_match = re.search(
            r"(?ms)^  t1-renderer:\n(?P<body>.*?)(?=^  [A-Za-z0-9_-]+:\n)",
            e2e_workflow,
        )

        self.assertIn("python dev/scripts/repository_privacy_guard.py", privacy_workflow)
        self.assertIsNotNone(required_t1_match)
        self.assertIn(
            "python dev/scripts/repository_privacy_guard.py",
            required_t1_match.group("body"),
        )
        self.assertNotIn("paths:", triggers)
        self.assertNotIn("paths-ignore:", triggers)
        self.assertRegex(triggers, r"push:\n\s+branches:\n\s+- main")
        self.assertRegex(triggers, r"pull_request:\s*\n")


if __name__ == "__main__":
    unittest.main()

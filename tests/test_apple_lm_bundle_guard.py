import tempfile
import sys
import unittest
from pathlib import Path

from scripts.apple_lm_bundle_guard import resolve_apple_lm_sidecar


class AppleLMBundleGuardTests(unittest.TestCase):
    @staticmethod
    def _make_helper(root: str, *, executable: bool) -> tuple[Path, Path]:
        helper = Path(root) / "Steno Apple LM.app"
        binary = helper / "Contents" / "MacOS" / "steno-apple-lm"
        binary.parent.mkdir(parents=True)
        (helper / "Contents" / "Info.plist").write_text("<plist/>")
        binary.write_bytes(b"helper")
        if executable:
            binary.chmod(0o755)
        return helper, binary

    def test_release_build_fails_when_sidecar_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "Steno Apple LM.app"

            with self.assertRaisesRegex(FileNotFoundError, "helper app"):
                resolve_apple_lm_sidecar(
                    missing,
                    platform="darwin",
                    required=True,
                )

    def test_development_build_may_omit_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "Steno Apple LM.app"

            self.assertIsNone(
                resolve_apple_lm_sidecar(
                    missing,
                    platform="darwin",
                    required=False,
                )
            )

    def test_existing_bundle_must_contain_helper_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            helper = Path(tmp) / "Steno Apple LM.app"
            helper.joinpath("Contents").mkdir(parents=True)
            helper.joinpath("Contents", "Info.plist").write_text("<plist/>")

            with self.assertRaisesRegex(FileNotFoundError, "executable is missing"):
                resolve_apple_lm_sidecar(helper, platform="darwin")

    @unittest.skipIf(sys.platform == "win32", "POSIX executable fixture")
    def test_existing_sidecar_must_be_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            helper, _binary = self._make_helper(tmp, executable=False)

            with self.assertRaisesRegex(PermissionError, "executable"):
                resolve_apple_lm_sidecar(helper, platform="darwin")

    @unittest.skipIf(sys.platform == "win32", "POSIX executable fixture")
    def test_macos_build_accepts_executable_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            helper, binary = self._make_helper(tmp, executable=True)

            self.assertEqual(
                resolve_apple_lm_sidecar(helper, platform="darwin"),
                binary,
            )

    def test_other_platforms_ignore_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "Steno Apple LM.app"

            self.assertIsNone(
                resolve_apple_lm_sidecar(
                    missing,
                    platform="win32",
                    required=True,
                )
            )


if __name__ == "__main__":
    unittest.main()

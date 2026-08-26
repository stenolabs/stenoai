import tempfile
import unittest
from pathlib import Path

from scripts.diarize_bundle_guard import require_diarize_sidecar


class DiarizeBundleGuardTests(unittest.TestCase):
    def test_macos_build_fails_when_sidecar_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "steno-diarize"

            with self.assertRaisesRegex(FileNotFoundError, "steno-diarize"):
                require_diarize_sidecar(missing, platform="darwin")

    def test_macos_build_fails_when_sidecar_is_not_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-diarize"
            sidecar.write_bytes(b"not executable")

            with self.assertRaisesRegex(PermissionError, "executable"):
                require_diarize_sidecar(sidecar, platform="darwin")

    def test_macos_build_accepts_executable_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-diarize"
            sidecar.write_bytes(b"executable")
            sidecar.chmod(0o755)

            self.assertEqual(
                require_diarize_sidecar(sidecar, platform="darwin"),
                sidecar,
            )

    def test_other_platforms_do_not_require_the_macos_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "steno-diarize"

            self.assertIsNone(require_diarize_sidecar(missing, platform="win32"))


if __name__ == "__main__":
    unittest.main()

import tempfile
import unittest
from pathlib import Path

from scripts.sidecar_bundle_guard import require_macos_sidecar


class SidecarBundleGuardTests(unittest.TestCase):
    def require(self, path: Path, platform: str = "darwin"):
        return require_macos_sidecar(
            path,
            name="Apple transcription",
            build_script="scripts/build-transcribe-sidecar.sh",
            platform=platform,
        )

    def test_macos_build_fails_when_sidecar_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "steno-transcribe"

            with self.assertRaisesRegex(FileNotFoundError, "steno-transcribe"):
                self.require(missing)

    def test_macos_build_fails_when_sidecar_is_not_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-transcribe"
            sidecar.write_bytes(b"not executable")

            with self.assertRaisesRegex(PermissionError, "executable"):
                self.require(sidecar)

    def test_macos_build_accepts_executable_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-transcribe"
            sidecar.write_bytes(b"executable")
            sidecar.chmod(0o755)

            self.assertEqual(self.require(sidecar), sidecar)

    def test_other_platforms_do_not_require_the_macos_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "steno-transcribe"

            self.assertIsNone(self.require(missing, platform="win32"))


if __name__ == "__main__":
    unittest.main()

"""Thin unittest wrapper around scripts/verify_mlx_bundle.py.

The real guard is the standalone script (invoked from CI right after the
PyInstaller build). This wrapper lets the same checks run under
`python -m unittest discover tests` when a fresh darwin-arm64 bundle happens to
be present locally. It is hardware/artifact-gated: it `skipTest`s loudly when
the platform isn't darwin-arm64 or when `dist/stenoai/_internal` doesn't exist,
matching this repo's skip convention for environment-dependent tests - it never
fails just because the bundle wasn't built.
"""

import os
import platform
import subprocess
import sys
import unittest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPT = os.path.join(_REPO_ROOT, 'scripts', 'verify_mlx_bundle.py')
_INTERNAL = os.path.join(_REPO_ROOT, 'dist', 'stenoai', '_internal')

class BundleMLXCollisionTests(unittest.TestCase):
    def test_no_libmlx_abi_collision_in_bundle(self):
        if sys.platform != 'darwin' or platform.machine() != 'arm64':
            self.skipTest(f"darwin-arm64 only (host: {sys.platform}/{platform.machine()})")
        if not os.path.isdir(_INTERNAL):
            self.skipTest(
                "no PyInstaller bundle at dist/stenoai/_internal - "
                "run `pyinstaller stenoai.spec --noconfirm` first"
            )
        # Run in a clean process. Other tests may already have imported the pip
        # MLX dylib, which changes dyld's resolution for Ollama's incompatible
        # libmlx build and creates a false collision failure in this process.
        result = subprocess.run(
            [sys.executable, _SCRIPT],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            "verify_mlx_bundle reported failures:\n"
            f"{result.stdout}\n{result.stderr}",
        )


if __name__ == '__main__':
    unittest.main()


class PinnedMLXVersionTests(unittest.TestCase):
    """Unit tests for check_pinned_version, the guard that would have caught
    the unpinned-mlx regression.

    Deliberately NOT artifact-gated like the collision test above: this check is
    pure text comparison (requirements.txt pin vs the bundled version.h), so it
    can and should run on every platform in the ordinary `python -m unittest`
    job, rather than only when a darwin-arm64 bundle happens to exist. The guard
    exists precisely because no CI job can load Metal to test mlx for real, so
    its own logic had better be covered.
    """

    def _module(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('_verify_mlx_bundle', _SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def _run(self, *, pin: str | None, bundled: str | None):
        """Drive check_pinned_version against synthetic requirements/version.h."""
        import tempfile
        mod = self._module()
        with tempfile.TemporaryDirectory() as tmp:
            req = os.path.join(tmp, 'requirements.txt')
            with open(req, 'w', encoding='utf-8') as fh:
                fh.write('sounddevice>=0.4.6\n')
                if pin is not None:
                    fh.write(f"mlx=={pin}; sys_platform == 'darwin'\n")
            mod._REQUIREMENTS = req

            if bundled is None:
                mod._VERSION_H = os.path.join(tmp, 'missing', 'version.h')
            else:
                major, minor, patch = bundled.split('.')
                vh = os.path.join(tmp, 'version.h')
                with open(vh, 'w', encoding='utf-8') as fh:
                    fh.write(
                        f'#define MLX_VERSION_MAJOR {major}\n'
                        f'#define MLX_VERSION_MINOR {minor}\n'
                        f'#define MLX_VERSION_PATCH {patch}\n'
                    )
                mod._VERSION_H = vh

            mod._failures = []
            mod._passes = []
            mod.check_pinned_version()
            return mod._failures, mod._passes

    def test_matching_version_passes(self):
        failures, passes = self._run(pin='0.31.2', bundled='0.31.2')
        self.assertEqual(failures, [])
        self.assertTrue(any('0.31.2' in p for p in passes))

    def test_drifted_version_fails(self):
        # The exact regression: an unpinned rebuild picked up 0.32.2.
        failures, _ = self._run(pin='0.31.2', bundled='0.32.2')
        self.assertEqual(len(failures), 1)
        self.assertIn('0.32.2', failures[0])
        self.assertIn('0.31.2', failures[0])

    def test_removing_the_pin_fails(self):
        # Deleting the pin must not silently disable the guard.
        failures, _ = self._run(pin=None, bundled='0.31.2')
        self.assertEqual(len(failures), 1)
        self.assertIn('no longer pins mlx', failures[0])

    def test_missing_bundled_version_header_fails(self):
        failures, _ = self._run(pin='0.31.2', bundled=None)
        self.assertEqual(len(failures), 1)
        self.assertIn('version.h', failures[0])

    def test_repo_requirements_actually_pins_mlx(self):
        """The real requirements.txt must carry the pin -- not a fixture."""
        import re
        req = os.path.join(_REPO_ROOT, 'requirements.txt')
        with open(req, encoding='utf-8') as fh:
            content = fh.read()
        self.assertRegex(
            content,
            re.compile(r"^mlx==[0-9][^\s;]*", re.MULTILINE),
            'requirements.txt must pin mlx exactly; a floor lets an unverified '
            'mlx reach the shipped bundle and break Parakeet.',
        )

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

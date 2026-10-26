"""Check the Linux build rejects a missing checksum tool before downloading."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build-ffmpeg-minimal.sh"


class BuildFfmpegPreflightTests(unittest.TestCase):
    def test_linux_requires_sha256sum_before_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = root / "tools"
            tools.mkdir()
            for name in ("basename", "dirname", "mkdir"):
                (tools / name).symlink_to(shutil.which(name))
            for name in ("musl-gcc", "readelf", "nproc"):
                stub = tools / name
                stub.write_text("#!/bin/sh\nexit 0\n")
                stub.chmod(0o755)
            uname = tools / "uname"
            uname.write_text('#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
            uname.chmod(0o755)
            result = subprocess.run(
                [shutil.which("bash"), str(SCRIPT), str(root / "ffmpeg")],
                env={**os.environ, "PATH": str(tools)},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("requires sha256sum", result.stderr)
            self.assertFalse((root / "ffmpeg").exists())


if __name__ == "__main__":
    unittest.main()

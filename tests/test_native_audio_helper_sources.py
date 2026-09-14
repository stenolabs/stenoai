"""The build must reject source drift even with optimized Python."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class NativeAudioHelperIntegrityTests(unittest.TestCase):
    def test_build_verifier_under_optimization(self):
        script = (Path(__file__).resolve().parents[1] / "scripts/build-audio-helper.sh").read_text()
        verifier = script.split("<<'PY'\n", 1)[1].split("\nPY", 1)[0]
        with tempfile.TemporaryDirectory(prefix="steno-helper-integrity-") as directory:
            root = Path(directory) / "native-audio-helper"
            sources = root / "Sources"
            sources.mkdir(parents=True)
            expected = b"// Synthetic fixture\n"
            (root / "upstream.json").write_text(json.dumps({"files": {
                "fixture.swift": {"sha256": hashlib.sha256(expected).hexdigest()}
            }}))
            for optimized in (False, True):
                for variant in ("valid", "changed", "extra", "missing"):
                    with self.subTest(optimized=optimized, variant=variant):
                        fixture = sources / "fixture.swift"
                        extra = sources / "extra.swift"
                        extra.unlink(missing_ok=True)
                        fixture.write_bytes(expected if variant != "changed" else b"// Drift\n")
                        if variant == "extra":
                            extra.write_bytes(expected)
                        if variant == "missing":
                            fixture.unlink()
                        result = subprocess.run(
                            [sys.executable, *(["-O"] if optimized else []), "-", directory],
                            input=verifier, text=True, capture_output=True, check=False,
                        )
                        self.assertEqual(result.returncode == 0, variant == "valid", result.stderr)

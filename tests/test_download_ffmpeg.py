"""Exercise the Linux ffmpeg build dispatch without network or a toolchain."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == 'posix' and shutil.which('bash'), 'needs bash')
class LinuxFfmpegBuildDispatchTests(unittest.TestCase):
    def run_stage(self, mode):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / 'scripts'
            scripts.mkdir()
            stubs = root / 'stubs'
            stubs.mkdir()
            source = (Path(__file__).resolve().parents[1] / 'scripts/download-ollama.sh').read_text()
            script = scripts / 'download-ollama.sh'
            script.write_text(source.split('# --- Download Ollama ---')[0])
            builder = scripts / 'build-ffmpeg-minimal.sh'
            builder.write_text('''#!/bin/bash
echo "$1" >> "$FIXTURE_ROOT/build-calls"
if [ "$FIXTURE_MODE" = fail ]; then exit 7; fi
mkdir -p "$(dirname "$1")"
printf '#!/bin/sh\\n' > "$1"
if [ "$FIXTURE_MODE" = bad-version ]; then
    printf 'echo "ffmpeg version 6.0"\\n' >> "$1"
else
    printf 'echo "ffmpeg version 7.1.1"\\n' >> "$1"
fi
yes '#' | head -c 1000000 >> "$1"
chmod +x "$1"
''')
            builder.chmod(0o755)
            for name, body in {
                'uname': '#!/bin/sh\necho Linux\n',
                'curl': '#!/bin/sh\necho unexpected curl >&2; exit 99\n',
            }.items():
                stub = stubs / name
                stub.write_text(body)
                stub.chmod(0o755)
            result = subprocess.run(
                ['bash', str(script)], capture_output=True, text=True,
                env={**os.environ, 'PATH': str(stubs) + os.pathsep + os.environ['PATH'],
                     'FIXTURE_ROOT': str(root), 'FIXTURE_MODE': mode}, timeout=30,
            )
            calls = (root / 'build-calls').read_text().splitlines()
            return result, calls, (root / 'bin/ffmpeg').exists()

    def test_builds_once_and_uses_local_output(self):
        result, calls, built = self.run_stage('valid')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertEqual(Path(calls[0]).name, 'ffmpeg')
        self.assertTrue(built)

    def test_failed_build_stops(self):
        result, calls, built = self.run_stage('fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)
        self.assertFalse(built)

    def test_wrong_version_stops(self):
        result, calls, built = self.run_stage('bad-version')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)
        self.assertTrue(built)
        self.assertIn('not 7.1.1', result.stderr)

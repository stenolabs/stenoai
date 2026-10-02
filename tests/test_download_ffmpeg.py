"""Exercise the Linux ffmpeg download stage with deterministic HTTP payloads."""
import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


@unittest.skipUnless(
    os.name == 'posix' and all(shutil.which(tool) for tool in ('bash', 'tar', 'xz')),
    'Linux download stage requires a POSIX shell, tar and xz',
)
class LinuxFfmpegDownloadTests(unittest.TestCase):
    def run_download(self, mode):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / 'scripts'
            scripts.mkdir()
            stubs = root / 'stubs'
            stubs.mkdir()
            # Execute the actual ffmpeg stage without downloading unrelated Ollama.
            source = (Path(__file__).resolve().parents[1] / 'scripts/download-ollama.sh').read_text()
            script = scripts / 'download.sh'
            script.write_text(source.split('# --- Download Ollama ---')[0])
            payload = b'fake ffmpeg\n' + b'\0' * 5_000_000
            with tarfile.open(root / 'valid.tar.xz', 'w:xz') as archive:
                entry = tarfile.TarInfo('ffmpeg-static/ffmpeg')
                entry.size = len(payload)
                archive.addfile(entry, io.BytesIO(payload))
            with tarfile.open(root / 'missing.tar.xz', 'w:xz') as archive:
                entry = tarfile.TarInfo('ffmpeg-static/README')
                archive.addfile(entry, io.BytesIO(b''))
            for name, body in {
                'uname': 'echo Linux\n',
                'sleep': 'exit 0\n',
                'curl': '''count=0
[ ! -f "$FIXTURE_ROOT/count" ] || count=$(cat "$FIXTURE_ROOT/count")
count=$((count + 1))
echo "$count" > "$FIXTURE_ROOT/count"
while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then shift; output=$1; fi
    shift
done
case "$FIXTURE_MODE" in
    invalid) printf '<html>upstream unavailable</html>' > "$output" ;;
    missing) cp "$FIXTURE_ROOT/missing.tar.xz" "$output" ;;
    retry)
        if [ "$count" -eq 1 ]; then
            printf '<html>upstream unavailable</html>' > "$output"
        else
            cp "$FIXTURE_ROOT/valid.tar.xz" "$output"
        fi ;;
    valid) cp "$FIXTURE_ROOT/valid.tar.xz" "$output" ;;
esac
''',
            }.items():
                stub = stubs / name
                stub.write_text('#!/bin/sh\n' + body)
                stub.chmod(0o755)
            result = subprocess.run(
                ['bash', str(script)], capture_output=True, text=True,
                env={**os.environ, 'PATH': str(stubs) + os.pathsep + os.environ['PATH'],
                     'FIXTURE_ROOT': str(root), 'FIXTURE_MODE': mode},
                timeout=30,
            )
            return result, int((root / 'count').read_text()), (root / 'bin/ffmpeg').exists()

    def test_valid_archive_succeeds_without_retry(self):
        result, calls, extracted = self.run_download('valid')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 1)
        self.assertTrue(extracted)

    def test_http_200_error_page_is_retried(self):
        result, calls, extracted = self.run_download('retry')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 2)
        self.assertTrue(extracted)

    def test_invalid_payloads_fail_after_bounded_retries(self):
        for mode in ('invalid', 'missing'):
            with self.subTest(mode=mode):
                result, calls, extracted = self.run_download(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, 3)
                self.assertFalse(extracted)
                self.assertIn('after 3 attempts', result.stderr)

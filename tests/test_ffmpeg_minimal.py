"""Check the bundled ffmpeg can do everything the app asks of it.

The macOS bundle ships an audio-only ffmpeg (scripts/build-ffmpeg-minimal.sh)
compiled with an explicit list of demuxers, decoders, filters and muxers. A
component missing from that list only fails at runtime, so this exercises the
real pipeline invocations against bin/ffmpeg over one sample of every import
format (app/main.js IMPORT_AUDIO_EXTENSIONS). wav/aiff/caf/m4a are made at test
time with macOS's own `say` and `afconvert`; the formats afconvert cannot
write (mp3, aac, webm, ogg vorbis/opus, flac, mp4, mov) are committed one-second
stereo tones in tests/fixtures/ffmpeg_formats, generated once with a full
ffmpeg. A full ffmpeg (an older dev checkout) passes too -- it is a superset.
"""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from src.transcriber import (
    AUDIO_HIGHPASS_HZ,
    _audio_filter_chain,
    _parse_channels_from_ffmpeg_stderr,
    _parse_duration_from_ffmpeg_stderr,
)

FFMPEG = Path(__file__).resolve().parents[1] / "bin" / "ffmpeg"
COMMITTED_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ffmpeg_formats"

# Components named explicitly by an ffmpeg invocation in src/, simple_recorder.py
# or app/meeting-transfer-audio.js, or required for an import format.
REQUIRED = {
    "-decoders": ["pcm_s16le", "pcm_f32le", "mp3", "aac", "alac", "flac", "opus", "vorbis"],
    "-filters": ["pan", "highpass", "loudnorm", "volume", "aresample"],
    "-demuxers": ["wav", "aiff", "caf", "mp3", "aac", "mov", "matroska", "ogg", "flac"],
    "-muxers": ["wav", "caf", "s16le", "null"],
    "-encoders": ["pcm_s16le", "pcm_f32le"],
}


@unittest.skipUnless(
    sys.platform == "darwin" and FFMPEG.is_file() and shutil.which("afconvert") and shutil.which("say"),
    "needs macOS (say/afconvert) and a built bin/ffmpeg",
)
class BundledFfmpegTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        src = cls.tmp / "src.aiff"
        subprocess.run(["say", "-o", str(src), "testing the bundled ffmpeg"], check=True)
        stereo = cls.tmp / "stereo.wav"
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@48000", "-c", "2", str(src), str(stereo)], check=True)
        cls.fixtures = {"stereo.wav": stereo, "mono.aiff": src}
        for name, fmt, data in [
            ("aac.m4a", "m4af", "aac"),
            ("alac.m4a", "m4af", "alac"),
            ("float.caf", "caff", "LEF32"),
            ("pcm.aiff", "AIFF", "BEI16"),
        ]:
            out = cls.tmp / name
            subprocess.run(["afconvert", "-f", fmt, "-d", data, str(stereo), str(out)], check=True)
            cls.fixtures[name] = out
        for path in sorted(COMMITTED_FIXTURES.iterdir()):
            cls.fixtures[path.name] = path

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def ffmpeg(self, *args):
        return subprocess.run([str(FFMPEG), "-nostdin", "-v", "error", *args], capture_output=True)

    def test_required_components_present(self):
        for flag, names in REQUIRED.items():
            listing = subprocess.run([str(FFMPEG), "-hide_banner", flag], capture_output=True, text=True).stdout
            # Format listings join aliases with commas ("mov,mp4,m4a,...").
            available = {n for line in listing.splitlines() if len(line.split()) > 1
                         for n in line.split()[1].split(",")}
            for name in names:
                self.assertIn(name, available, f"{name} missing from ffmpeg {flag}")

    def test_pipeline_invocations(self):
        for name, path in self.fixtures.items():
            with self.subTest(name):
                out = self.tmp / f"{name}.mono.wav"
                r = self.ffmpeg("-y", "-i", str(path), "-af", _audio_filter_chain(),
                                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(out))
                self.assertEqual(r.returncode, 0, r.stderr)
                split = self.tmp / f"{name}.ch0.wav"
                r = self.ffmpeg("-y", "-i", str(path), "-af", f"pan=mono|c0=c0,highpass=f={AUDIO_HIGHPASS_HZ}",
                                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(split))
                self.assertEqual(r.returncode, 0, r.stderr)
                caf = self.tmp / f"{name}.f32.caf"
                r = self.ffmpeg("-n", "-i", str(path), "-vn", "-c:a", "pcm_f32le", "-f", "caf", str(caf))
                self.assertEqual(r.returncode, 0, r.stderr)
                # parakeet-mlx's load_audio: raw s16le on stdout.
                r = self.ffmpeg("-i", str(path), "-threads", "0", "-f", "s16le", "-ac", "1",
                                "-acodec", "pcm_s16le", "-ar", "16000", "-")
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertGreater(len(r.stdout), 16000, "decoded under half a second of audio")

    def test_probe_output_parses(self):
        r = subprocess.run([str(FFMPEG), "-hide_banner", "-t", "0", "-i", str(self.fixtures["stereo.wav"]),
                            "-f", "null", "-"], capture_output=True, text=True)
        self.assertEqual(_parse_channels_from_ffmpeg_stderr(r.stderr), 2)
        self.assertGreater(_parse_duration_from_ffmpeg_stderr(r.stderr) or 0, 1.0)


if __name__ == "__main__":
    unittest.main()

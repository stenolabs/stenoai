"""Check the bundled ffmpeg can do everything the app asks of it.

The macOS and Linux bundles ship an audio-only ffmpeg (scripts/build-ffmpeg-minimal.sh)
compiled with an explicit list of demuxers, decoders, filters and muxers. A
component missing from that list only fails at runtime, so this exercises the
real pipeline invocations against bin/ffmpeg over one sample of every import
format (app/main.js IMPORT_AUDIO_EXTENSIONS). wav/aiff/caf/m4a are made at test
time with macOS's own `say` and `afconvert`. The formats afconvert cannot write
(mp3, aac, webm, ogg vorbis/opus, flac, mp4, mov) are encoded at test time by a
full reference ffmpeg -- STENOAI_REF_FFMPEG, or Homebrew's -- and skipped,
loudly, without one. Media files are never committed (the repository privacy
guard rejects them). A full ffmpeg as bin/ffmpeg passes too -- it is a superset.
"""

import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

from src.transcriber import (
    AUDIO_HIGHPASS_HZ,
    _audio_filter_chain,
    _parse_channels_from_ffmpeg_stderr,
    _parse_duration_from_ffmpeg_stderr,
)

FFMPEG = Path(__file__).resolve().parents[1] / "bin" / "ffmpeg"

# (file name, encoder args) for the formats afconvert cannot write.
REFERENCE_ENCODED = [
    ("tone.mp3", ["-c:a", "libmp3lame"]),
    ("tone.aac", ["-c:a", "aac", "-f", "adts"]),
    ("tone.webm", ["-c:a", "libopus"]),
    ("tone.ogg", ["-c:a", "libvorbis"]),
    ("tone_opus.ogg", ["-c:a", "libopus", "-f", "ogg"]),
    ("tone.flac", ["-c:a", "flac"]),
]
REFERENCE_VIDEO = [("tone.mp4", ["-c:a", "aac"]), ("tone.mov", ["-c:a", "alac"])]


def _reference_ffmpeg():
    import os
    for candidate in (os.environ.get("STENOAI_REF_FFMPEG"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if candidate and Path(candidate).is_file() and Path(candidate).resolve() != FFMPEG.resolve():
            return candidate
    return None

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
        # A reference build may lack an encoder (Homebrew's has no libvorbis);
        # such formats are listed, by name, in the coverage test's skip.
        cls.reference = _reference_ffmpeg()
        if cls.reference:
            ref = [cls.reference, "-nostdin", "-v", "error", "-y"]
            video = ["-f", "lavfi", "-i", "color=black:s=16x16:r=2:d=2"]
            jobs = [(n, ["-i", str(stereo), *a]) for n, a in REFERENCE_ENCODED] + [
                (n, [*video, "-i", str(stereo), "-c:v", "libx264", "-pix_fmt", "yuv420p", *a, "-shortest"])
                for n, a in REFERENCE_VIDEO
            ]
            for name, args in jobs:
                out = cls.tmp / name
                if subprocess.run([*ref, *args, str(out)], capture_output=True).returncode == 0:
                    cls.fixtures[name] = out

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

    def test_reference_formats_were_exercised(self):
        if not self.reference:
            self.skipTest(
                "no full reference ffmpeg (set STENOAI_REF_FFMPEG or brew install ffmpeg): "
                "mp3/aac/webm/ogg/flac/mp4/mov decoding NOT checked"
            )
        missing = sorted({n for n, _ in REFERENCE_ENCODED + REFERENCE_VIDEO} - set(self.fixtures))
        if missing:
            self.skipTest(f"reference ffmpeg {self.reference} cannot encode {missing}: those NOT checked")

    def test_probe_output_parses(self):
        r = subprocess.run([str(FFMPEG), "-hide_banner", "-t", "0", "-i", str(self.fixtures["stereo.wav"]),
                            "-f", "null", "-"], capture_output=True, text=True)
        self.assertEqual(_parse_channels_from_ffmpeg_stderr(r.stderr), 2)
        self.assertGreater(_parse_duration_from_ffmpeg_stderr(r.stderr) or 0, 1.0)


@unittest.skipUnless(sys.platform == "linux" and FFMPEG.is_file(), "needs built Linux bin/ffmpeg")
class LinuxBundledFfmpegTests(unittest.TestCase):
    def test_static_audio_pipeline(self):
        # The packaged binary must load on its own, with no runtime linker or
        # shared libs from the CI runner. Check this before exercising codecs.
        elf = subprocess.run(["readelf", "-l", str(FFMPEG)], capture_output=True, text=True, check=True)
        self.assertNotIn("INTERP", elf.stdout)
        dynamic = subprocess.run(["readelf", "-d", str(FFMPEG)], capture_output=True, text=True, check=True)
        self.assertNotIn("NEEDED", dynamic.stdout)
        self.assertIn("ffmpeg version 7.1.1", subprocess.run(
            [str(FFMPEG), "-version"], capture_output=True, text=True, check=True).stdout)
        license_text = subprocess.run([str(FFMPEG), "-L"], capture_output=True,
                                      text=True, check=True).stdout
        self.assertIn("GNU Lesser General Public License", " ".join(license_text.split()))
        for flag, names in REQUIRED.items():
            listing = subprocess.run([str(FFMPEG), "-hide_banner", flag],
                                     capture_output=True, text=True, check=True).stdout
            available = {n for line in listing.splitlines() if len(line.split()) > 1
                         for n in line.split()[1].split(",")}
            for name in names:
                self.assertIn(name, available, f"{name} missing from ffmpeg {flag}")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav = root / "input.wav"
            with wave.open(str(wav), "wb") as out:
                out.setnchannels(2)
                out.setsampwidth(2)
                out.setframerate(16000)
                out.writeframes(b"\0\0\0\0" * 16000)
            reference = _reference_ffmpeg()
            self.assertIsNotNone(reference, "set STENOAI_REF_FFMPEG to a full system ffmpeg")
            fixtures = {"wav": wav}
            for name, args in REFERENCE_ENCODED + REFERENCE_VIDEO:
                path = root / name
                video = ["-f", "lavfi", "-i", "color=black:s=16x16:r=2:d=2"] if (name, args) in REFERENCE_VIDEO else []
                result = subprocess.run([reference, "-nostdin", "-v", "error", "-y", *video,
                                         "-i", str(wav), *(["-c:v", "mpeg4", "-shortest"] if video else []),
                                         *args, str(path)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, f"reference encode {name}: {result.stderr}")
                fixtures[name] = path
            for name, path in fixtures.items():
                with self.subTest(name=name):
                    output = root / f"{name}.mono.wav"
                    result = subprocess.run([str(FFMPEG), "-nostdin", "-v", "error", "-y", "-i", str(path),
                                             "-af", _audio_filter_chain(), "-ar", "16000", "-ac", "1",
                                             "-c:a", "pcm_s16le", str(output)], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertGreater(output.stat().st_size, 16000)


if __name__ == "__main__":
    unittest.main()

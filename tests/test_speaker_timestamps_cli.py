import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.speaker_suggestions import write_speakers_sidecar


class SpeakerTimestampsCliTests(unittest.TestCase):
    def _run(self, args, tmp):
        with mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            return CliRunner().invoke(simple_recorder.speaker_timestamps, args)

    def _seed_sidecar(self, tmp, meeting_stem="mtg001"):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, meeting_stem, {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_00": {
                        "embedding": [1.0, 0.0],
                        "speech_duration_seconds": 30.0,
                        "segment_count": 2,
                        "segments": [{"start": 1.5, "end": 10.0}, {"start": 65.0, "end": 86.5}],
                    },
                },
            },
        })

    def test_prints_formatted_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result = self._run(["mtg001", "mic", "SPEAKER_00"], tmp)
            self.assertEqual(result.exit_code, 0)
            self.assertIn("30.0s total across 2 turns", result.output)
            self.assertIn("[00:01 - 00:10]", result.output)
            self.assertIn("[01:05 - 01:26]", result.output)

    def test_missing_sidecar_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "output").mkdir(parents=True, exist_ok=True)
            result = self._run(["mtg_nonexistent", "mic", "SPEAKER_00"], tmp)
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(json.loads(result.output), {
                "success": False,
                "error": "No speakers sidecar found for 'mtg_nonexistent'",
            })

    def test_missing_channel_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result = self._run(["mtg001", "system", "SPEAKER_00"], tmp)
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(json.loads(result.output), {
                "success": False,
                "error": "No 'system' channel in sidecar for 'mtg001'",
            })

    def test_missing_cluster_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result = self._run(["mtg001", "mic", "SPEAKER_99"], tmp)
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(json.loads(result.output), {
                "success": False,
                "error": "No cluster 'SPEAKER_99' in 'mic' channel of 'mtg001'",
            })

    def test_cluster_with_no_segments_field_prints_empty_list_gracefully(self):
        # Sidecars written before the `segments` field existed shouldn't crash.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 2},
                    },
                },
            })
            result = self._run(["mtg001", "mic", "SPEAKER_00"], tmp)
            self.assertEqual(result.exit_code, 0)
            self.assertIn("across 0 turns", result.output)


if __name__ == "__main__":
    unittest.main()

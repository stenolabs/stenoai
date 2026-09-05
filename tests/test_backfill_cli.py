import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config
from simple_recorder import _find_recording_file, _enumerate_meeting_stems


def _last_json(output):
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


class FindRecordingFileTests(unittest.TestCase):
    """Regression coverage for a real bug: backfill-speaker-embeddings
    originally only looked for `{stem}.wav`, silently skipping the
    majority of a real library where recordings are `.webm` (or `.m4a`) --
    there's no single fixed extension the capture pipeline uses."""

    def test_finds_webm_only_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            recordings_dir = Path(tmp)
            (recordings_dir / "mtg001.webm").write_bytes(b"stub")
            found = _find_recording_file(recordings_dir, "mtg001")
            self.assertEqual(found, recordings_dir / "mtg001.webm")

    def test_finds_m4a_only_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            recordings_dir = Path(tmp)
            (recordings_dir / "mtg001.m4a").write_bytes(b"stub")
            found = _find_recording_file(recordings_dir, "mtg001")
            self.assertEqual(found, recordings_dir / "mtg001.m4a")

    def test_prefers_wav_when_multiple_formats_exist_for_same_stem(self):
        with tempfile.TemporaryDirectory() as tmp:
            recordings_dir = Path(tmp)
            (recordings_dir / "mtg001.webm").write_bytes(b"stub")
            (recordings_dir / "mtg001.wav").write_bytes(b"stub")
            found = _find_recording_file(recordings_dir, "mtg001")
            self.assertEqual(found, recordings_dir / "mtg001.wav")

    def test_returns_none_when_no_recording_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            recordings_dir = Path(tmp)
            found = _find_recording_file(recordings_dir, "mtg_deleted")
            self.assertIsNone(found)

    def test_does_not_match_unrelated_stem_with_shared_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            recordings_dir = Path(tmp)
            (recordings_dir / "mtg001-extra.webm").write_bytes(b"stub")
            found = _find_recording_file(recordings_dir, "mtg001")
            self.assertIsNone(found)

    def test_explicit_extension_ignores_other_formats_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            recordings_dir = Path(tmp)
            (recordings_dir / "mtg001.wav").write_bytes(b"stub")
            (recordings_dir / "mtg001.webm").write_bytes(b"stub")
            found = _find_recording_file(recordings_dir, "mtg001", extension="webm")
            self.assertEqual(found, recordings_dir / "mtg001.webm")

    def test_explicit_extension_returns_none_when_absent_even_if_other_formats_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            recordings_dir = Path(tmp)
            (recordings_dir / "mtg001.wav").write_bytes(b"stub")
            found = _find_recording_file(recordings_dir, "mtg001", extension="webm")
            self.assertIsNone(found)

    def test_explicit_extension_strips_leading_dot(self):
        with tempfile.TemporaryDirectory() as tmp:
            recordings_dir = Path(tmp)
            (recordings_dir / "mtg001.webm").write_bytes(b"stub")
            found = _find_recording_file(recordings_dir, "mtg001", extension=".webm")
            self.assertEqual(found, recordings_dir / "mtg001.webm")


class EnumerateMeetingStemsTests(unittest.TestCase):
    def test_prefers_json_over_md_for_same_stem(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            (output_dir / "mtg001_summary.json").write_text("{}")
            (output_dir / "mtg001_summary.md").write_text("# stub")
            (output_dir / "mtg002_summary.md").write_text("# stub")
            stems = _enumerate_meeting_stems(output_dir)
            self.assertEqual(stems, ["mtg001", "mtg002"])


class BackfillSpeakerEmbeddingsCliTests(unittest.TestCase):
    """Diarization/embedding extraction is expensive (real recordings can
    take 10+ minutes) -- skip-by-default/--force behavior is the actual
    thing under test here, so the diarizer itself is mocked (module-level
    patch, matching tests/test_transcriber_diarisation.py's convention)."""

    def _seed_meeting(self, tmp, stem="mtg001"):
        output_dir = Path(tmp) / "output"
        recordings_dir = Path(tmp) / "recordings"
        output_dir.mkdir(parents=True, exist_ok=True)
        recordings_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / f"{stem}_summary.json").write_text(json.dumps({
            "session_info": {"name": stem}, "summary": "test",
            "participants": [], "key_points": [],
        }))
        (recordings_dir / f"{stem}.wav").write_bytes(b"stub")

    def _run(self, args, tmp):
        cfg = Config(config_path=Path(tmp) / "config.json")
        # Backfill is an identity-matching operation. The production default is
        # deliberately off, so this test must opt in to exercise the command.
        cfg.set_identity_matching_enabled(True)
        diar_segments = [{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"}]
        embeddings = {"SPEAKER_0": [1.0, 0.0]}
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}), \
             mock.patch(
                 "src.transcriber.WhisperTranscriber._split_stereo_to_channels",
                 return_value=(None, None, None),  # mono path -> single "mic" channel
             ), \
             mock.patch(
                 "src.transcriber.WhisperTranscriber._check_rms_energy", return_value=True,
             ), \
             mock.patch(
                 "src.transcriber._run_steno_diarize", return_value=(diar_segments, embeddings),
             ):
            result = CliRunner().invoke(simple_recorder.backfill_speaker_embeddings, args)
        return result

    def test_first_run_processes_meeting(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp)
            result = self._run([], tmp)
            data = _last_json(result.output)
            self.assertEqual(data["processed"], ["mtg001"])
            self.assertEqual(data["skipped_already_processed"], [])
            self.assertTrue((Path(tmp) / "output" / "mtg001_speakers.json").exists())

    def test_diarization_failure_reports_skipped_no_clusters_not_no_audio(self):
        # skipped_no_audio and skipped_no_clusters used to be the same list,
        # which read as "no audio found" for a meeting that in fact HAD a
        # real recording file -- diarization just failed/produced nothing
        # usable. Actively misleading when diagnosing why a specific
        # meeting has no sidecar (confirmed against a real recording this
        # session, where a JSON-parsing bug in the diarizer looked
        # indistinguishable from a missing file until this split).
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            cfg.set_identity_matching_enabled(True)
            with mock.patch("src.config.get_config", return_value=cfg), \
                 mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}), \
                 mock.patch(
                     "src.transcriber.WhisperTranscriber._split_stereo_to_channels",
                     return_value=(None, None, None),
                 ), \
                 mock.patch(
                     "src.transcriber.WhisperTranscriber._check_rms_energy", return_value=True,
                 ), \
                 mock.patch("src.transcriber._run_steno_diarize", return_value=None):
                result = CliRunner().invoke(simple_recorder.backfill_speaker_embeddings, [])
            data = _last_json(result.output)
            self.assertEqual(data["processed"], [])
            self.assertEqual(data["skipped_no_audio"], [])
            self.assertEqual(data["skipped_no_clusters"], ["mtg001"])
            self.assertFalse((Path(tmp) / "output" / "mtg001_speakers.json").exists())

    def test_second_run_without_force_skips(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp)
            self._run([], tmp)  # first run creates the sidecar
            result = self._run([], tmp)  # second run should skip it
            data = _last_json(result.output)
            self.assertEqual(data["processed"], [])
            self.assertEqual(data["skipped_already_processed"], ["mtg001"])

    def test_force_reprocesses_already_done_meeting(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp)
            self._run([], tmp)
            result = self._run(["--force"], tmp)
            data = _last_json(result.output)
            self.assertEqual(data["processed"], ["mtg001"])
            self.assertEqual(data["skipped_already_processed"], [])

    def test_limit_counts_only_meetings_that_need_processing(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp, stem="mtg001")
            self._seed_meeting(tmp, stem="mtg002")
            self._run([], tmp)  # process both once
            # mtg001 is already done; --limit 1 with a fresh mtg003 should
            # process the new one, not burn its budget re-confirming a skip.
            self._seed_meeting(tmp, stem="mtg003")
            result = self._run(["--limit", "1"], tmp)
            data = _last_json(result.output)
            self.assertEqual(data["processed"], ["mtg003"])

    def test_meeting_option_targets_one_stem_ignoring_already_processed_skip(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp, stem="mtg001")
            self._seed_meeting(tmp, stem="mtg002")
            self._run([], tmp)  # both processed once (old-shape sidecar in this mock)

            # Explicitly targeting mtg001 must reprocess it even though it
            # already has a sidecar, and must NOT touch mtg002 at all.
            result = self._run(["--meeting", "mtg001"], tmp)
            data = _last_json(result.output)
            self.assertEqual(data["processed"], ["mtg001"])
            self.assertEqual(data["skipped_already_processed"], [])
            self.assertEqual(data["total_meetings"], 1)

    def test_meeting_option_ignores_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp, stem="mtg001")
            result = self._run(["--meeting", "mtg001", "--limit", "0"], tmp)
            data = _last_json(result.output)
            self.assertEqual(data["processed"], ["mtg001"])


if __name__ == "__main__":
    unittest.main()


class BackfillReportsLostMarkingsTests(BackfillSpeakerEmbeddingsCliTests):
    """A re-diarization drops every human marking on the old clusters, and
    that is correct: the new run numbers its clusters independently, so
    carrying the markings over would attach a person's statement to whichever
    voice happened to inherit an id. Losing them SILENTLY is the defect --
    they are the one thing in that file no re-run can reproduce."""

    def _seed_marked_sidecar(self, tmp, stem="mtg001", multi=False, generic=False):
        from src.speaker_suggestions import (
            REVIEW_STATE_GENERIC, set_cluster_multi_speaker, set_cluster_review_state,
            write_speakers_sidecar,
        )
        output_dir = Path(tmp) / "output"
        write_speakers_sidecar(output_dir, stem, {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0,
                                  "segment_count": 5},
                    "SPEAKER_1": {"embedding": [0.0, 1.0], "speech_duration_seconds": 20.0,
                                  "segment_count": 4},
                },
            },
        })
        if multi:
            set_cluster_multi_speaker(output_dir, stem, "mic", "SPEAKER_0", True)
        if generic:
            set_cluster_review_state(output_dir, stem, "mic", "SPEAKER_1", REVIEW_STATE_GENERIC)

    def test_reports_review_markings_it_is_about_to_discard(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp)
            self._seed_marked_sidecar(tmp, multi=True, generic=True)
            data = _last_json(self._run(["--force"], tmp).output)
            self.assertEqual(data["processed"], ["mtg001"])
            self.assertEqual(
                data["lost_multi_speaker_markings"], [{"stem": "mtg001", "clusters": 1}])
            self.assertEqual(
                data["lost_review_state_markings"], [{"stem": "mtg001", "clusters": 1}])

    def test_says_nothing_when_there_was_nothing_to_lose(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_meeting(tmp)
            self._seed_marked_sidecar(tmp)
            data = _last_json(self._run(["--force"], tmp).output)
            self.assertEqual(data["lost_multi_speaker_markings"], [])
            self.assertEqual(data["lost_review_state_markings"], [])

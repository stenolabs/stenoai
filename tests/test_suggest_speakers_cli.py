import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config
from src.speaker_suggestions import (
    REVIEW_STATE_GENERIC,
    read_speakers_sidecar,
    set_cluster_review_state,
    write_sidecar_document,
    write_speakers_sidecar,
)


def _last_json(output):
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


def _seeded_run_id(tmp, meeting_stem="mtg001"):
    """The run id of the sidecar just written into `tmp`."""
    return read_speakers_sidecar(Path(tmp) / "output", meeting_stem)["diarization_run"]["run_id"]


class SuggestSpeakersCliTests(unittest.TestCase):
    """Covers the identification anchors (channel/duration/segment_count/
    first_timestamp) added to each cluster's output -- without these, a
    human reviewing an "Unidentified speaker" row in the UI has no way to
    go find and listen to that speaker in the recording to figure out who
    they actually are."""

    def _run(self, args, tmp, cfg=None, *, identity_enabled=True):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        cfg.set_identity_matching_enabled(identity_enabled)
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            result = CliRunner().invoke(simple_recorder.suggest_speakers, args)
        return result

    def test_disabled_identity_matching_hides_retained_speaker_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_0": {
                            "embedding": [1.0, 0.0],
                            "speech_duration_seconds": 30.0,
                            "segment_count": 5,
                        },
                    },
                },
            })

            result = self._run(["mtg001"], tmp, identity_enabled=False)

            self.assertEqual(result.exit_code, 0)
            self.assertEqual(_last_json(result.output), {
                "success": True,
                "schema_version": 1,
                "diarization_run_id": None,
                "meeting_id": "mtg001",
                "recording_available": False,
                "minimum_speaker_count": 0,
                "channels": {},
            })

    def test_missing_sidecar_is_an_empty_successful_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run(["missing"], tmp)

            self.assertEqual(result.exit_code, 0)
            self.assertEqual(_last_json(result.output), {
                "success": True,
                "schema_version": 1,
                "diarization_run_id": None,
                "meeting_id": "missing",
                "recording_available": False,
                "minimum_speaker_count": 0,
                "channels": {},
            })

    def test_legacy_sidecar_exposes_a_stale_safe_review_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            legacy = {
                "meeting_id": "legacy",
                "channels": {
                    "mic": {
                        "recording_type": "in_person",
                        "clusters": {
                            "SPEAKER_0": {
                                "embedding": [1.0, 0.0],
                                "speech_duration_seconds": 30.0,
                                "segment_count": 5,
                            },
                        },
                    },
                },
            }
            (output_dir / "legacy_speakers.json").write_text(json.dumps(legacy))

            result = self._run(["legacy"], tmp)
            data = _last_json(result.output)

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertRegex(data["diarization_run_id"], r"^legacy-[0-9a-f]{64}$")
            self.assertIn("SPEAKER_0", data["channels"]["mic"])

    def test_includes_duration_segment_count_and_first_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 30.5, "segment_count": 5,
                            "segments": [{"start": 12.0, "end": 14.0}, {"start": 30.0, "end": 32.0}],
                        },
                    },
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            cluster = data["channels"]["system"]["SPEAKER_0"]
            self.assertEqual(cluster["speech_duration_seconds"], 30.5)
            self.assertEqual(cluster["segment_count"], 5)
            self.assertEqual(cluster["first_timestamp"], "00:12")

    def test_first_timestamp_is_null_when_no_segments(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                    },
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertIsNone(data["channels"]["mic"]["SPEAKER_0"]["first_timestamp"])

    def test_first_timestamp_for_merged_cluster_is_earliest_across_all_fragments(self):
        # Two same-channel fragments of one real voice (Phase 3.6 merge) --
        # first_timestamp must be the earliest segment across BOTH raw
        # fragment ids, not just the merge-primary's own segments.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0, "segment_count": 580,
                            "segments": [{"start": 500.0, "end": 502.0}],
                        },
                        "SPEAKER_2": {
                            "embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0, "segment_count": 552,
                            "segments": [{"start": 45.0, "end": 47.0}],  # earlier than SPEAKER_0's own segments
                        },
                    },
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            # SPEAKER_0 is the merge primary (higher duration); its
            # first_timestamp must reflect SPEAKER_2's earlier segment too.
            merged = data["channels"]["system"]["SPEAKER_0"]
            self.assertEqual(merged["merged_from"], ["SPEAKER_2"])
            self.assertEqual(merged["first_timestamp"], "00:45")

    def test_channel_is_identifiable_from_the_response_structure(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {"SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 2}},
                },
                "system": {
                    "recording_type": "remote",
                    "clusters": {"SPEAKER_0": {"embedding": [0.0, 1.0], "speech_duration_seconds": 20.0, "segment_count": 3}},
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertIn("mic", data["channels"])
            self.assertIn("system", data["channels"])

    def test_confirmed_by_user_persists_across_requests_unlike_transient_ui_state(self):
        # A row's confirmed status must be derivable from real persisted
        # data (an existing prototype), not client-side state that
        # disappears when the panel unmounts (e.g. navigating away and
        # back to the meeting) -- see the speaker_identification plan doc.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 2},
                    },
                },
            })
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            cfg.add_speaker_prototype(
                person["person_id"], [1.0, 0.0],
                recording_type="remote", meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
                speech_duration_seconds=10.0, segment_count=2, created_from="user_confirmed",
                # Stamped with the run on disk, the way a real confirm
                # against this sidecar stamps it. Unstamped it would describe
                # a confirmation made before the meeting was re-diarized,
                # which is a different test (see SuggestSpeakersRunScopeTests).
                diarization_run_id=_seeded_run_id(tmp),
            )
            result = self._run(["mtg001"], tmp, cfg=cfg)
            data = _last_json(result.output)
            self.assertEqual(data["channels"]["system"]["SPEAKER_0"]["confirmed_by_user"], "Person Alpha")

    def test_confirmed_by_user_is_null_when_never_confirmed(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 2},
                    },
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertIsNone(data["channels"]["system"]["SPEAKER_0"]["confirmed_by_user"])

    def test_confirmed_by_user_scoped_to_recording_type_not_just_diarization_id(self):
        # "SPEAKER_0" can independently exist on BOTH channels of the same
        # meeting -- a confirmation on the "mic" (in_person) cluster must
        # not bleed into the "system" (remote) cluster sharing the same
        # raw diarizer id.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {"SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 2}},
                },
                "system": {
                    "recording_type": "remote",
                    "clusters": {"SPEAKER_0": {"embedding": [0.0, 1.0], "speech_duration_seconds": 10.0, "segment_count": 2}},
                },
            })
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            cfg.add_speaker_prototype(
                person["person_id"], [1.0, 0.0],
                recording_type="in_person", meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
                speech_duration_seconds=10.0, segment_count=2, created_from="user_confirmed",
                diarization_run_id=_seeded_run_id(tmp),
            )
            result = self._run(["mtg001"], tmp, cfg=cfg)
            data = _last_json(result.output)
            self.assertEqual(data["channels"]["mic"]["SPEAKER_0"]["confirmed_by_user"], "Person Alpha")
            self.assertIsNone(data["channels"]["system"]["SPEAKER_0"]["confirmed_by_user"])

    def test_confirmed_by_user_resolves_through_merged_fragments(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0, "segment_count": 580,
                        },
                        "SPEAKER_2": {
                            "embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0, "segment_count": 552,
                        },
                    },
                },
            })
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            # Confirmed via the non-primary fragment id (SPEAKER_2) -- same
            # real shape as confirm-speaker's own id-resolution.
            cfg.add_speaker_prototype(
                person["person_id"], [0.995, 0.0999],
                recording_type="remote", meeting_id="mtg001", diarization_speaker_id="SPEAKER_2",
                speech_duration_seconds=1538.0, segment_count=552, created_from="user_confirmed",
                diarization_run_id=_seeded_run_id(tmp),
            )
            result = self._run(["mtg001"], tmp, cfg=cfg)
            data = _last_json(result.output)
            # SPEAKER_0 is the merge primary (higher duration) -- the
            # confirmation must still be found via merged_from.
            merged = data["channels"]["system"]["SPEAKER_0"]
            self.assertEqual(merged["merged_from"], ["SPEAKER_2"])
            self.assertEqual(merged["confirmed_by_user"], "Person Alpha")

    def test_sample_text_quotes_the_transcript_at_the_longest_segment(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            # A turn_manifest is what makes the quote attributable at all.
            # Without one the CLI returns no text rather than matching by
            # timestamp -- a backfilled sidecar's segments come from a
            # different diarization run than the transcript's [MM:SS]
            # markers, and matching across the two put another
            # participant's words under the owner's own cluster on a real
            # recording (see cluster_transcript_lines).
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 1,
                            "segments": [{"start": 5.0, "end": 15.0}],
                        },
                    },
                },
            }, turn_manifest=[
                {"start": 5.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
            ])
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            (transcripts_dir / "mtg001_transcript.txt").write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n[00:05] [Speaker 2] this is what they said",
                encoding="utf-8",
            )
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertEqual(
                data["channels"]["system"]["SPEAKER_0"]["sample_text"], "this is what they said",
            )

    def test_sample_text_is_null_without_a_matching_transcript(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 2},
                    },
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertIsNone(data["channels"]["mic"]["SPEAKER_0"]["sample_text"])

    def test_is_likely_artifact_true_for_short_scattered_turns(self):
        # Real-library shape: many short turns, low avg -- the exact
        # echo-artifact pattern this session's ground-truth investigation
        # found (avg well under SUGGESTION_MIN_AVG_TURN_SECONDS).
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 25.0, "segment_count": 56},
                    },
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["channels"]["system"]["SPEAKER_0"]["is_likely_artifact"])

    def test_is_likely_artifact_false_for_sustained_speech(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 300.0, "segment_count": 100},
                    },
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertFalse(data["channels"]["system"]["SPEAKER_0"]["is_likely_artifact"])

    def test_recording_available_true_when_source_file_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {"SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 2}},
                },
            })
            recordings_dir = Path(tmp) / "recordings"
            recordings_dir.mkdir(parents=True, exist_ok=True)
            (recordings_dir / "mtg001.webm").write_bytes(b"stub")
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["recording_available"])

    def test_recording_available_false_when_source_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {"SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 2}},
                },
            })
            result = self._run(["mtg001"], tmp)
            data = _last_json(result.output)
            self.assertFalse(data["recording_available"])


class GetSpeakerSampleAudioCliTests(unittest.TestCase):
    def _run(self, args, tmp):
        cfg = Config(config_path=Path(tmp) / "config.json")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            result = CliRunner().invoke(simple_recorder.get_speaker_sample_audio, args)
        return result

    def _seed_sidecar_and_recording(self, tmp, stem="mtg001"):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, stem, {
            "system": {
                "recording_type": "remote",
                "clusters": {
                    "SPEAKER_0": {
                        "embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 1,
                        "segments": [{"start": 5.0, "end": 15.0}],
                    },
                },
            },
        })
        recordings_dir = Path(tmp) / "recordings"
        recordings_dir.mkdir(parents=True, exist_ok=True)
        (recordings_dir / f"{stem}.wav").write_bytes(b"stub")

    def test_success_returns_base64_audio_bytes_not_a_path(self):
        # The renderer's CSP (media-src 'self' blob:) has no file:
        # allowance -- a raw filesystem path could never actually play in
        # the packaged app, so the clip's bytes must come back inline.
        import base64
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar_and_recording(tmp)
            with mock.patch(
                "src.speaker_suggestions.extract_speaker_sample_audio",
                side_effect=lambda audio_path, channel, segments, output_path, segment_index=None: (
                    output_path.write_bytes(b"wav-stub-bytes") or True
                ),
            ):
                result = self._run(["mtg001", "system", "SPEAKER_0"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertNotIn("audio_path", data)
            self.assertEqual(base64.b64decode(data["audio_base64"]), b"wav-stub-bytes")

    def test_failed_extraction_removes_partial_temp_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar_and_recording(tmp)

            def leave_partial(_audio_path, _channel, _segments, output_path, segment_index=None):
                output_path.write_bytes(b"private meeting audio")
                return False

            with mock.patch("tempfile.gettempdir", return_value=tmp), \
                 mock.patch(
                     "src.speaker_suggestions.extract_speaker_sample_audio",
                     side_effect=leave_partial,
                 ):
                result = self._run(["mtg001", "system", "SPEAKER_0"], tmp)

            self.assertFalse(_last_json(result.output)["success"])
            self.assertEqual(list(Path(tmp).glob("steno_sample_*.wav")), [])

    def test_temp_extraction_file_is_cleaned_up_after_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar_and_recording(tmp)
            captured_path = {}

            def fake_extract(audio_path, channel, segments, output_path, segment_index=None):
                captured_path["path"] = output_path
                output_path.write_bytes(b"stub")
                return True

            with mock.patch("src.speaker_suggestions.extract_speaker_sample_audio", side_effect=fake_extract):
                self._run(["mtg001", "system", "SPEAKER_0"], tmp)
            self.assertFalse(captured_path["path"].exists())

    def test_parallel_sample_requests_get_unique_temp_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar_and_recording(tmp)
            dirs = {
                "recordings": Path(tmp) / "recordings",
                "transcripts": Path(tmp) / "transcripts",
                "output": Path(tmp) / "output",
            }
            captured_paths = []
            extraction_barrier = threading.Barrier(2)
            capture_lock = threading.Lock()

            def fake_extract(audio_path, channel, segments, output_path, segment_index=None):
                with capture_lock:
                    captured_paths.append(output_path)
                extraction_barrier.wait(timeout=2.0)
                output_path.write_bytes(b"stub")
                return True

            with mock.patch(
                "src.speaker_suggestions.extract_speaker_sample_audio",
                side_effect=fake_extract,
            ), mock.patch(
                "src.config.get_data_dirs", return_value=dirs,
            ), mock.patch("builtins.print"):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    list(executor.map(
                        lambda _index: simple_recorder.get_speaker_sample_audio.callback(
                            "mtg001", "system", "SPEAKER_0", None, None,
                        ),
                        range(2),
                    ))

            self.assertEqual(len(captured_paths), 2)
            self.assertNotEqual(captured_paths[0], captured_paths[1])
            self.assertTrue(all(not path.exists() for path in captured_paths))

    def test_no_source_recording_fails_gracefully(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 10.0, "segment_count": 1,
                            "segments": [{"start": 5.0, "end": 15.0}],
                        },
                    },
                },
            })
            # No recordings dir file seeded -- source audio "deleted".
            result = self._run(["mtg001", "system", "SPEAKER_0"], tmp)
            data = _last_json(result.output)
            self.assertFalse(data["success"])
            self.assertIn("no source audio", data["error"])

    def test_unknown_cluster_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar_and_recording(tmp)
            result = self._run(["mtg001", "system", "SPEAKER_99"], tmp)
            data = _last_json(result.output)
            self.assertFalse(data["success"])

    def test_missing_sidecar_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "output").mkdir(parents=True, exist_ok=True)
            result = self._run(["mtg_nonexistent", "system", "SPEAKER_0"], tmp)
            data = _last_json(result.output)
            self.assertFalse(data["success"])

    def test_extraction_failure_reported_gracefully(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar_and_recording(tmp)
            with mock.patch("src.speaker_suggestions.extract_speaker_sample_audio", return_value=False):
                result = self._run(["mtg001", "system", "SPEAKER_0"], tmp)
            data = _last_json(result.output)
            self.assertFalse(data["success"])
            self.assertIn("could not extract", data["error"])

    def test_either_merged_fragment_id_resolves_to_same_sample(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0, "segment_count": 580,
                            "segments": [{"start": 5.0, "end": 15.0}],
                        },
                        "SPEAKER_2": {
                            "embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0, "segment_count": 552,
                            "segments": [{"start": 100.0, "end": 105.0}],
                        },
                    },
                },
            })
            recordings_dir = Path(tmp) / "recordings"
            recordings_dir.mkdir(parents=True, exist_ok=True)
            (recordings_dir / "mtg001.wav").write_bytes(b"stub")
            captured = {}

            def fake_extract(audio_path, channel, segments, output_path, segment_index=None):
                captured["output_path"] = output_path
                captured["segments"] = segments
                output_path.write_bytes(b"wav-stub")
                return True

            with mock.patch("src.speaker_suggestions.extract_speaker_sample_audio", side_effect=fake_extract):
                # Requesting the lower-duration fragment resolves to the
                # merge primary (SPEAKER_0), same as confirm-speaker --
                # verify that both fragments' segments are pooled together.
                # Temp-file names are intentionally opaque and unique.
                result = self._run(["mtg001", "system", "SPEAKER_2"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(len(captured["segments"]), 2)


class SuggestSpeakersReviewStateTests(unittest.TestCase):
    """The panel reads the "kept generic" marking from here rather than
    holding it in component state, which is what makes it survive a remount
    and a restart by construction."""

    def _run(self, args, tmp, cfg=None):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        cfg.set_identity_matching_enabled(True)
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            return CliRunner().invoke(simple_recorder.suggest_speakers, args)

    def _seed(self, tmp, clusters=None):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "system": {
                "recording_type": "remote",
                "clusters": clusters or {
                    "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                                  "segment_count": 10},
                    "SPEAKER_1": {"embedding": [0.0, 1.0], "speech_duration_seconds": 40.0,
                                  "segment_count": 8},
                },
            },
        })
        return output_dir

    def test_review_state_is_echoed_per_cluster(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            set_cluster_review_state(output_dir, "mtg001", "system", "SPEAKER_0",
                                     REVIEW_STATE_GENERIC)
            data = _last_json(self._run(["mtg001"], tmp).output)
            self.assertEqual(
                data["channels"]["system"]["SPEAKER_0"]["review_state"], REVIEW_STATE_GENERIC)
            self.assertIsNone(data["channels"]["system"]["SPEAKER_1"]["review_state"])

    def test_a_marking_on_a_fragment_marks_the_row_it_was_made_on(self):
        # The reviewer clicked one row; the sidecar records raw clusters.
        # Reading the marking back on the row they saw is the whole point.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp, clusters={
                "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0,
                              "segment_count": 580},
                "SPEAKER_2": {"embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0,
                              "segment_count": 552},
            })
            set_cluster_review_state(output_dir, "mtg001", "system", "SPEAKER_2",
                                     REVIEW_STATE_GENERIC)
            data = _last_json(self._run(["mtg001"], tmp).output)
            row = data["channels"]["system"]["SPEAKER_0"]
            self.assertEqual(row["merged_from"], ["SPEAKER_2"])
            self.assertEqual(row["review_state"], REVIEW_STATE_GENERIC)


class SuggestSpeakersRunScopeTests(unittest.TestCase):
    """What the panel may still call "confirmed" after the meeting was
    diarized a second time.

    A re-diarization numbers its clusters from SPEAKER_0 again with no
    memory of who held that id, so an older run's prototype describes a
    voice this run may have given to somebody else. Reporting it as
    `confirmed_by_user` puts a name the user never chose on a stranger's
    row -- and it looks exactly like a confirmation they made themselves,
    so nothing invites them to check it.
    """

    def _run(self, args, tmp, cfg=None):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        cfg.set_identity_matching_enabled(True)
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            return CliRunner().invoke(simple_recorder.suggest_speakers, args)

    def _seed(self, tmp, clusters=None):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "system": {
                "recording_type": "remote",
                "clusters": clusters or {
                    "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                                  "segment_count": 10, "segments": [{"start": 1.0, "end": 5.0}]},
                    "SPEAKER_1": {"embedding": [0.0, 1.0], "speech_duration_seconds": 40.0,
                                  "segment_count": 8, "segments": [{"start": 20.0, "end": 24.0}]},
                },
            },
        })
        return output_dir

    def _run_id(self, tmp):
        return read_speakers_sidecar(Path(tmp) / "output", "mtg001")["diarization_run"]["run_id"]

    def _rediarize(self, tmp):
        """A second diarization run over the same meeting: same cluster ids,
        swapped voices. Returns the new run id."""
        self._seed(tmp, clusters={
            "SPEAKER_0": {"embedding": [0.0, 1.0], "speech_duration_seconds": 55.0,
                          "segment_count": 9, "segments": [{"start": 2.0, "end": 6.0}]},
            "SPEAKER_1": {"embedding": [1.0, 0.0], "speech_duration_seconds": 35.0,
                          "segment_count": 7, "segments": [{"start": 21.0, "end": 25.0}]},
        })
        return self._run_id(tmp)

    def _make_legacy(self, tmp):
        """Strip the run block, leaving the pre-run-stamping sidecar shape
        every already-processed meeting on disk still has."""
        output_dir = Path(tmp) / "output"
        sidecar = read_speakers_sidecar(output_dir, "mtg001")
        sidecar.pop("diarization_run", None)
        write_sidecar_document(output_dir, "mtg001", sidecar)

    def _confirm_by_hand(self, cfg, name, sid, run_id, embedding=(1.0, 0.0)):
        person = cfg.create_person_profile(name)
        cfg.add_speaker_prototype(
            person["person_id"], list(embedding), recording_type="remote",
            meeting_id="mtg001", diarization_speaker_id=sid,
            speech_duration_seconds=60.0, segment_count=10,
            created_from="user_confirmed", channel="system",
            diarization_run_id=run_id,
        )
        return person

    def test_a_confirmation_from_a_superseded_run_is_not_reported_as_confirmed(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = self._confirm_by_hand(cfg, "Person Alpha", "SPEAKER_0", self._run_id(tmp))
            self._rediarize(tmp)
            data = _last_json(self._run(["mtg001"], tmp, cfg=cfg).output)
            cluster = data["channels"]["system"]["SPEAKER_0"]
            self.assertIsNone(cluster["confirmed_by_user"])
            self.assertIsNone(cluster["confirmed_person_id"])
            self.assertEqual(
                data["stale_assignments"],
                [{"person_id": person["person_id"], "display_name": "Person Alpha"}],
            )

    def test_a_confirmation_from_this_run_is_reported_and_is_not_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = self._confirm_by_hand(cfg, "Person Alpha", "SPEAKER_0", self._run_id(tmp))
            data = _last_json(self._run(["mtg001"], tmp, cfg=cfg).output)
            cluster = data["channels"]["system"]["SPEAKER_0"]
            self.assertEqual(cluster["confirmed_by_user"], "Person Alpha")
            self.assertEqual(cluster["confirmed_person_id"], person["person_id"])
            self.assertEqual(data["stale_assignments"], [])

    def test_a_legacy_pair_with_no_run_ids_anywhere_still_reports_the_confirmation(self):
        # The whole installed base: sidecars written before run stamping,
        # prototypes confirmed against them. Nothing here was ever
        # re-diarized, so nothing may be reported as superseded.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            self._make_legacy(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            self._confirm_by_hand(cfg, "Person Alpha", "SPEAKER_0", None)
            data = _last_json(self._run(["mtg001"], tmp, cfg=cfg).output)
            self.assertEqual(
                data["channels"]["system"]["SPEAKER_0"]["confirmed_by_user"], "Person Alpha",
            )
            self.assertEqual(data["stale_assignments"], [])

    def test_a_person_who_lost_two_clusters_is_reported_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = self._confirm_by_hand(cfg, "Person Alpha", "SPEAKER_0", self._run_id(tmp))
            cfg.add_speaker_prototype(
                person["person_id"], [0.0, 1.0], recording_type="remote",
                meeting_id="mtg001", diarization_speaker_id="SPEAKER_1",
                speech_duration_seconds=40.0, segment_count=8,
                created_from="user_confirmed", channel="system",
                diarization_run_id=self._run_id(tmp),
            )
            self._rediarize(tmp)
            data = _last_json(self._run(["mtg001"], tmp, cfg=cfg).output)
            self.assertEqual(len(data["stale_assignments"]), 1)
            self.assertEqual(data["stale_assignments"][0]["display_name"], "Person Alpha")

    def test_a_cluster_someone_has_since_confirmed_reports_no_stale_owner(self):
        # The notice has to be able to go away. Nothing deletes a
        # superseded prototype -- that is the point of the run scoping -- so
        # if a re-confirmed cluster kept reporting its previous owner, the
        # panel would carry the notice for the rest of the meeting's life
        # with no action left that could clear it.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            self._confirm_by_hand(cfg, "Person Alpha", "SPEAKER_0", self._run_id(tmp))
            new_run = self._rediarize(tmp)
            self._confirm_by_hand(cfg, "Sarah", "SPEAKER_0", new_run, embedding=(0.0, 1.0))
            data = _last_json(self._run(["mtg001"], tmp, cfg=cfg).output)
            self.assertEqual(
                data["channels"]["system"]["SPEAKER_0"]["confirmed_by_user"], "Sarah",
            )
            self.assertEqual(data["stale_assignments"], [])


if __name__ == "__main__":
    unittest.main()

import base64
import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from simple_recorder import _resolve_person_sample
from src.config import Config
from src.speaker_suggestions import read_speakers_sidecar, write_speakers_sidecar


def _write_wav(path: Path, seconds: float = 2.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(b"\0\0" * int(16_000 * seconds))


def _write_sidecar(
    output_dir: Path,
    meeting_id: str,
    *,
    channel: str = "system",
    speaker_id: str = "SPEAKER_0",
    segments: list[dict] | None = None,
) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    write_speakers_sidecar(output_dir, meeting_id, {
        channel: {
            "recording_type": "remote" if channel == "system" else "in_person",
            "clusters": {
                speaker_id: {
                    "embedding": [1.0, 0.0],
                    "speech_duration_seconds": 30.0,
                    "segment_count": 4,
                    "segments": segments if segments is not None else [
                        {"start": 0.25, "end": 1.75},
                    ],
                },
            },
        },
    })
    return read_speakers_sidecar(output_dir, meeting_id)["diarization_run"]["run_id"]


def _prototype(
    meeting_id: str,
    run_id: str | None,
    *,
    quality: float = 1.0,
    created_at: float = 1.0,
    channel: str = "system",
    speaker_id: str = "SPEAKER_0",
) -> dict:
    return {
        "prototype_id": f"proto-{meeting_id}",
        "embedding_mean": [1.0, 0.0],
        "recording_type": "remote" if channel == "system" else "in_person",
        "meeting_id": meeting_id,
        "channel": channel,
        "diarization_speaker_id": speaker_id,
        "diarization_run_id": run_id,
        "quality_score": quality,
        "created_at": created_at,
    }


class PersonSampleResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.dirs = {
            "output": self.root / "output",
            "recordings": self.root / "recordings",
            "transcripts": self.root / "transcripts",
        }

    def tearDown(self):
        self.temp.cleanup()

    def _playable_prototype(self, meeting_id: str, **overrides) -> dict:
        run_id = _write_sidecar(self.dirs["output"], meeting_id)
        _write_wav(self.dirs["recordings"] / f"{meeting_id}.wav")
        return _prototype(meeting_id, run_id, **overrides)

    def test_selects_highest_quality_current_positive_prototype(self):
        lower = self._playable_prototype("lower", quality=0.4, created_at=20.0)
        higher = self._playable_prototype("higher", quality=0.9, created_at=10.0)
        profile = {"person_id": "p1", "prototypes": [lower, higher], "hard_negatives": []}

        sample = _resolve_person_sample(profile, self.dirs)

        self.assertEqual(sample["meeting_id"], "higher")
        self.assertEqual(sample["channel"], "system")
        self.assertEqual(sample["diarization_speaker_id"], "SPEAKER_0")
        self.assertEqual(sample["pooled_segments"], [{"start": 0.25, "end": 1.75}])

    def test_uses_recency_then_stable_provenance_for_ties(self):
        older = self._playable_prototype("older", quality=1.0, created_at=1.0)
        newer = self._playable_prototype("newer", quality=1.0, created_at=2.0)
        profile = {"person_id": "p1", "prototypes": [older, newer], "hard_negatives": []}
        self.assertEqual(_resolve_person_sample(profile, self.dirs)["meeting_id"], "newer")

        alpha = self._playable_prototype("alpha", quality=1.0, created_at=2.0)
        beta = self._playable_prototype("beta", quality=1.0, created_at=2.0)
        profile["prototypes"] = [beta, alpha]
        self.assertEqual(_resolve_person_sample(profile, self.dirs)["meeting_id"], "alpha")

    def test_rejects_stale_diarization_run(self):
        _write_sidecar(self.dirs["output"], "stale")
        _write_wav(self.dirs["recordings"] / "stale.wav")
        profile = {
            "person_id": "p1",
            "prototypes": [_prototype("stale", "older-run")],
            "hard_negatives": [],
        }

        self.assertIsNone(_resolve_person_sample(profile, self.dirs))

    def test_rejects_missing_recording_sidecar_channel_cluster_and_segments(self):
        no_recording_run = _write_sidecar(self.dirs["output"], "no-recording")

        _write_wav(self.dirs["recordings"] / "no-sidecar.wav")

        no_channel_run = _write_sidecar(
            self.dirs["output"], "no-channel", channel="mic",
        )
        _write_wav(self.dirs["recordings"] / "no-channel.wav")

        no_cluster_run = _write_sidecar(
            self.dirs["output"], "no-cluster", speaker_id="SPEAKER_1",
        )
        _write_wav(self.dirs["recordings"] / "no-cluster.wav")

        no_segments_run = _write_sidecar(
            self.dirs["output"], "no-segments", segments=[],
        )
        _write_wav(self.dirs["recordings"] / "no-segments.wav")

        cases = {
            "recording": _prototype("no-recording", no_recording_run),
            "sidecar": _prototype("no-sidecar", None),
            "channel": _prototype("no-channel", no_channel_run),
            "cluster": _prototype("no-cluster", no_cluster_run),
            "segments": _prototype("no-segments", no_segments_run),
        }
        for missing, prototype in cases.items():
            with self.subTest(missing=missing):
                profile = {"person_id": "p1", "prototypes": [prototype], "hard_negatives": []}
                self.assertIsNone(_resolve_person_sample(profile, self.dirs))

    def test_ignores_hard_negatives(self):
        negative = self._playable_prototype("negative")
        profile = {"person_id": "p1", "prototypes": [], "hard_negatives": [negative]}

        self.assertIsNone(_resolve_person_sample(profile, self.dirs))

    def test_corrupt_meeting_identifier_is_quarantined(self):
        profile = {
            "person_id": "p1",
            "prototypes": [_prototype("../outside", None)],
            "hard_negatives": [],
        }

        self.assertIsNone(_resolve_person_sample(profile, self.dirs))


class PersonSampleCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.output_dir = self.root / "output"
        self.recordings_dir = self.root / "recordings"
        self.config = Config(config_path=self.root / "config.json")

    def tearDown(self):
        self.temp.cleanup()

    def _run(self, command, args):
        with mock.patch("src.config.get_config", return_value=self.config), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": str(self.root)}):
            return CliRunner().invoke(command, args)

    def _seed_playable_person(self, name="Person Alpha") -> dict:
        profile = self.config.create_person_profile(name)
        run_id = _write_sidecar(self.output_dir, "meeting")
        _write_wav(self.recordings_dir / "meeting.wav")
        self.config.add_speaker_prototype(
            profile["person_id"],
            [1.0, 0.0],
            recording_type="remote",
            meeting_id="meeting",
            diarization_speaker_id="SPEAKER_0",
            speech_duration_seconds=30.0,
            segment_count=4,
            created_from="user_confirmed",
            channel="system",
            diarization_run_id=run_id,
        )
        return profile

    def test_list_profiles_reports_only_boolean_availability(self):
        self._seed_playable_person()

        result = self._run(simple_recorder.list_person_profiles, [])

        self.assertEqual(result.exit_code, 0)
        profile = json.loads(result.output)["person_profiles"][0]
        self.assertIs(profile["sample_available"], True)
        private_keys = {
            "meeting_id", "channel", "diarization_speaker_id", "recording_path",
            "prototypes", "embedding", "embedding_mean",
        }
        self.assertTrue(private_keys.isdisjoint(profile))

    def test_list_profiles_reuses_sidecar_resolution_across_people(self):
        self._seed_playable_person("Person Alpha")
        second = self.config.create_person_profile("Person Beta")
        run_id = read_speakers_sidecar(
            self.output_dir, "meeting",
        )["diarization_run"]["run_id"]
        self.config.add_speaker_prototype(
            second["person_id"],
            [1.0, 0.0],
            recording_type="remote",
            meeting_id="meeting",
            diarization_speaker_id="SPEAKER_0",
            speech_duration_seconds=30.0,
            segment_count=4,
            created_from="user_confirmed",
            channel="system",
            diarization_run_id=run_id,
        )

        with mock.patch(
            "src.speaker_suggestions.read_speakers_sidecar",
            wraps=read_speakers_sidecar,
        ) as read_sidecar:
            result = self._run(simple_recorder.list_person_profiles, [])

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(read_sidecar.call_count, 1)

    def test_list_profiles_treats_structurally_invalid_sidecars_as_unplayable(self):
        self._seed_playable_person()
        sidecar_path = self.output_dir / "meeting_speakers.json"

        malformed_sidecars = [
            {
                "meeting_id": "meeting",
                "diarization_run": {"run_id": read_speakers_sidecar(
                    self.output_dir, "meeting",
                )["diarization_run"]["run_id"]},
                "channels": [],
            },
            {
                "meeting_id": "meeting",
                "diarization_run": {"run_id": read_speakers_sidecar(
                    self.output_dir, "meeting",
                )["diarization_run"]["run_id"]},
                "channels": {
                    "system": {
                        "recording_type": "remote",
                        "clusters": {
                            "SPEAKER_0": {
                                "speech_duration_seconds": 30.0,
                                "segment_count": 4,
                                "segments": [{"start": 0.25, "end": 1.75}],
                            },
                        },
                    },
                },
            },
        ]
        for sidecar in malformed_sidecars:
            with self.subTest(sidecar=sidecar):
                sidecar_path.write_text(json.dumps(sidecar))

                result = self._run(simple_recorder.list_person_profiles, [])

                self.assertEqual(result.exit_code, 0)
                profile = json.loads(result.output)["person_profiles"][0]
                self.assertIs(profile["sample_available"], False)

    def test_get_person_sample_audio_returns_valid_wav_base64(self):
        profile = self._seed_playable_person()

        def fake_extract(_recording_path, _channel, _segments, output_path):
            _write_wav(Path(output_path), seconds=0.25)
            return True

        with mock.patch(
            "src.speaker_suggestions.extract_speaker_sample_audio",
            side_effect=fake_extract,
        ) as extract:
            result = self._run(
                simple_recorder.get_person_sample_audio,
                [profile["person_id"]],
            )

        self.assertEqual(result.exit_code, 0)
        payload = json.loads(result.output)
        self.assertIs(payload["success"], True)
        audio = base64.b64decode(payload["audio_base64"])
        self.assertEqual(audio[:4], b"RIFF")
        self.assertEqual(audio[8:12], b"WAVE")
        extract.assert_called_once()

    def test_missing_person_returns_fixed_failure_without_provenance(self):
        result = self._run(simple_recorder.get_person_sample_audio, ["missing"])

        self.assertEqual(result.exit_code, 0)
        self.assertEqual(json.loads(result.output), {
            "success": False,
            "error": "voice sample unavailable",
        })

    def test_unplayable_person_returns_fixed_failure_without_provenance(self):
        profile = self.config.create_person_profile("No recording")

        result = self._run(simple_recorder.get_person_sample_audio, [profile["person_id"]])

        self.assertEqual(result.exit_code, 0)
        self.assertEqual(json.loads(result.output), {
            "success": False,
            "error": "voice sample unavailable",
        })

if __name__ == "__main__":
    unittest.main()

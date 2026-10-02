import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config
from src.speaker_suggestions import (
    REVIEW_STATE_GENERIC,
    REVIEW_STATE_KEY,
    read_speakers_sidecar,
    set_cluster_review_state,
    write_sidecar_document,
    write_speakers_sidecar,
)


def _last_json(output):
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


class ConfirmSpeakerCliTests(unittest.TestCase):
    def _run(self, args, tmp, cfg=None, *, identity_enabled=True):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        cfg.set_identity_matching_enabled(identity_enabled)
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            result = CliRunner().invoke(simple_recorder.confirm_speaker, args)
        return result, cfg

    def _seed_sidecar(self, tmp, meeting_stem="mtg001"):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, meeting_stem, {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_00": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                    "SPEAKER_01": {"embedding": [0.0, 1.0], "speech_duration_seconds": 25.0, "segment_count": 4},
                },
            },
        })

    def _seed_two_cluster_relabel_artifacts(self, tmp, *, same_rendered_timestamp=False):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        second_timestamp = "00:05" if same_rendered_timestamp else "00:10"
        second_start = 5.8 if same_rendered_timestamp else 10.1
        body = f"[00:05] [Speaker 2] first\n[{second_timestamp}] [Speaker 3] second"
        summary_path = output_dir / "mtg001_summary.md"
        summary_path.write_text("## Transcript\n\n" + body + "\n", encoding="utf-8")
        write_speakers_sidecar(output_dir, "mtg001", {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_00": {
                        "embedding": [1.0, 0.0], "speech_duration_seconds": 30.0,
                        "segment_count": 5, "segments": [{"start": 4.0, "end": 6.0}],
                    },
                    "SPEAKER_01": {
                        "embedding": [0.0, 1.0], "speech_duration_seconds": 30.0,
                        "segment_count": 5, "segments": [{"start": 9.0, "end": 11.0}],
                    },
                },
            },
        }, turn_manifest=[
            {"start": 5.1, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"},
            {"start": second_start, "channel": "mic", "diarization_speaker_id": "SPEAKER_01"},
        ])
        transcript_path = Path(tmp) / "transcripts" / "mtg001_transcript.txt"
        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        transcript_path.write_text(
            "Session: mtg001\n\n" + "=" * 60 + "\n\n" + body,
            encoding="utf-8",
        )
        return output_dir, summary_path, transcript_path

    def test_requires_exactly_one_of_person_id_or_new_person(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result, _ = self._run(["mtg001", "mic", "SPEAKER_00"], tmp)
            self.assertNotEqual(result.exit_code, 0)
            self.assertFalse(_last_json(result.output)["success"])

    def test_disabled_identity_matching_refuses_to_persist_a_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result, cfg = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"],
                tmp,
                identity_enabled=False,
            )

            self.assertNotEqual(result.exit_code, 0)
            self.assertEqual(_last_json(result.output), {
                "success": False,
                "error": "Speaker identification is disabled in settings.",
            })
            self.assertEqual(cfg.get_person_profiles(), [])

    def test_config_save_failure_does_not_relabel_or_report_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            transcript_dir = Path(tmp) / "transcripts"
            transcript_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcript_dir / "mtg001_transcript.txt"
            original = "[00:00] [You] hello\n"
            transcript_path.write_text(original)
            cfg = Config(config_path=Path(tmp) / "config.json")
            cfg.set_identity_matching_enabled(True)

            with mock.patch("src.config._atomic_write_json", side_effect=OSError("disk full")), \
                 mock.patch("src.config.get_config", return_value=cfg), \
                 mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
                result = CliRunner().invoke(
                    simple_recorder.confirm_speaker,
                    [
                        "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma",
                        "--relabel-transcript",
                    ],
                )

            self.assertNotEqual(result.exit_code, 0)
            self.assertFalse(_last_json(result.output)["success"])
            self.assertEqual(transcript_path.read_text(), original)
            self.assertEqual(cfg.get_person_profiles(), [])

    def test_rejects_both_person_id_and_new_person(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result, _ = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--person-id", "x", "--new-person", "Person Gamma"], tmp,
            )
            self.assertNotEqual(result.exit_code, 0)

    def test_new_person_creates_profile_and_prototype(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["display_name"], "Person Gamma")
            self.assertEqual(data["hard_negatives_added_against"], [])

            profile = cfg.get_person_profile(data["person_id"])
            self.assertEqual(len(profile["prototypes"]), 1)
            self.assertEqual(profile["prototypes"][0]["embedding_mean"], [1.0, 0.0])
            self.assertEqual(profile["prototypes"][0]["recording_type"], "in_person")
            self.assertEqual(profile["prototypes"][0]["diarization_speaker_id"], "SPEAKER_00")
            self.assertEqual(profile["prototypes"][0]["channel"], "mic")
            self.assertEqual(profile["prototypes"][0]["created_from"], "user_confirmed")

    def test_existing_person_id_adds_second_prototype(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            existing = cfg.create_person_profile("Person Gamma")
            first = cfg.add_speaker_prototype(
                existing["person_id"],
                [0.9, 0.1],
                recording_type="in_person",
                meeting_id="older-meeting",
                diarization_speaker_id="SPEAKER_07",
                speech_duration_seconds=25.0,
                segment_count=4,
                created_from="user_confirmed",
                channel="mic",
                diarization_run_id="older-run",
            )
            self.assertIsNotNone(first)
            result, cfg = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--person-id", existing["person_id"]], tmp, cfg=cfg,
            )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["person_id"], existing["person_id"])
            profile = cfg.get_person_profile(existing["person_id"])
            self.assertEqual(len(profile["prototypes"]), 2)
            self.assertEqual(
                {prototype["meeting_id"] for prototype in profile["prototypes"]},
                {"older-meeting", "mtg001"},
            )

    def test_new_person_with_existing_name_fails_gracefully(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            cfg.create_person_profile("Person Gamma")
            result, cfg = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp, cfg=cfg,
            )
            self.assertNotEqual(result.exit_code, 0)
            data = _last_json(result.output)
            self.assertFalse(data["success"])
            self.assertIn("already exists", data["error"])
            # No second profile, no prototype added anywhere -- the whole
            # confirm bails out before touching any state.
            self.assertEqual(len(cfg.get_person_profiles()), 1)
            self.assertEqual(cfg.get_person_profiles()[0]["prototypes"], [])

    def test_unknown_person_id_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result, _ = self._run(["mtg001", "mic", "SPEAKER_00", "--person-id", "nonexistent"], tmp)
            self.assertNotEqual(result.exit_code, 0)
            self.assertFalse(_last_json(result.output)["success"])

    def test_missing_sidecar_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "output").mkdir(parents=True, exist_ok=True)
            result, _ = self._run(["mtg_nonexistent", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp)
            self.assertNotEqual(result.exit_code, 0)

    def test_unknown_cluster_id_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            result, _ = self._run(["mtg001", "mic", "SPEAKER_99", "--new-person", "Person Gamma"], tmp)
            self.assertNotEqual(result.exit_code, 0)

    def test_second_confirmation_in_same_meeting_creates_mutual_hard_negatives(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp, cfg=cfg)
            max_id = _last_json(result1.output)["person_id"]

            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)
            data2 = _last_json(result2.output)
            sarah_id = data2["person_id"]
            self.assertEqual(data2["hard_negatives_added_against"], ["Person Gamma"])

            max_profile = cfg.get_person_profile(max_id)
            sarah_profile = cfg.get_person_profile(sarah_id)

            # Person Gamma has one positive prototype (his own cluster) and one
            # hard-negative (Sarah's cluster) -- and vice versa.
            self.assertEqual(len(max_profile["prototypes"]), 1)
            self.assertEqual(max_profile["prototypes"][0]["embedding_mean"], [1.0, 0.0])
            self.assertEqual(len(max_profile["hard_negatives"]), 1)
            self.assertEqual(max_profile["hard_negatives"][0]["embedding_mean"], [0.0, 1.0])

            self.assertEqual(len(sarah_profile["prototypes"]), 1)
            self.assertEqual(sarah_profile["prototypes"][0]["embedding_mean"], [0.0, 1.0])
            self.assertEqual(len(sarah_profile["hard_negatives"]), 1)
            self.assertEqual(sarah_profile["hard_negatives"][0]["embedding_mean"], [1.0, 0.0])

    def test_confirm_stamps_prototypes_and_hard_negatives_with_the_sidecars_run_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            output_dir = Path(tmp) / "output"
            run_id = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            cfg = Config(config_path=Path(tmp) / "config.json")

            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(result1.output)["person_id"]
            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)
            sarah_id = _last_json(result2.output)["person_id"]

            max_profile = cfg.get_person_profile(max_id)
            sarah_profile = cfg.get_person_profile(sarah_id)
            # Positive prototype and mutual hard negative both carry it, on
            # both sides -- every add_speaker_prototype call this command
            # makes is expected to thread the same id.
            self.assertEqual(max_profile["prototypes"][0]["diarization_run_id"], run_id)
            self.assertEqual(max_profile["hard_negatives"][0]["diarization_run_id"], run_id)
            self.assertEqual(sarah_profile["prototypes"][0]["diarization_run_id"], run_id)
            self.assertEqual(sarah_profile["hard_negatives"][0]["diarization_run_id"], run_id)

    def test_stale_run_failure_has_a_stable_machine_readable_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            output_dir = Path(tmp) / "output"
            reviewed_run_id = read_speakers_sidecar(
                output_dir, "mtg001",
            )["diarization_run"]["run_id"]
            self._rediarize(tmp)

            result, _ = self._run(
                [
                    "mtg001", "mic", "SPEAKER_00",
                    "--new-person", "Person Gamma",
                    "--expected-run-id", reviewed_run_id,
                ],
                tmp,
            )

            self.assertNotEqual(result.exit_code, 0)
            self.assertEqual(
                _last_json(result.output)["error_code"],
                "stale_diarization_run",
            )

    def test_confirm_against_legacy_sidecar_produces_prototypes_without_run_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_legacy_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(result1.output)["person_id"]
            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)
            sarah_id = _last_json(result2.output)["person_id"]

            max_profile = cfg.get_person_profile(max_id)
            sarah_profile = cfg.get_person_profile(sarah_id)
            self.assertNotIn("diarization_run_id", max_profile["prototypes"][0])
            self.assertNotIn("diarization_run_id", max_profile["hard_negatives"][0])
            self.assertNotIn("diarization_run_id", sarah_profile["prototypes"][0])
            self.assertNotIn("diarization_run_id", sarah_profile["hard_negatives"][0])

    def _rediarize(self, tmp, meeting_stem="mtg001"):
        """Overwrite the sidecar with a run whose cluster ids are the same but
        whose voices are not -- exactly what a re-diarization produces, since
        the diarizer numbers from SPEAKER_00 every time with no memory of who
        held that id before. Returns the new run id."""
        output_dir = Path(tmp) / "output"
        write_speakers_sidecar(output_dir, meeting_stem, {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_00": {"embedding": [0.0, 1.0], "speech_duration_seconds": 28.0, "segment_count": 5},
                    "SPEAKER_01": {"embedding": [1.0, 0.0], "speech_duration_seconds": 22.0, "segment_count": 4},
                },
            },
        })
        return read_speakers_sidecar(output_dir, meeting_stem)["diarization_run"]["run_id"]

    def test_confirming_a_reused_cluster_id_from_a_newer_run_spares_the_older_runs_person(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            output_dir = Path(tmp) / "output"
            run1 = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            cfg = Config(config_path=Path(tmp) / "config.json")

            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(result1.output)["person_id"]

            run2 = self._rediarize(tmp)
            self.assertNotEqual(run1, run2)

            # Same id, genuinely different voice. Nothing here supersedes
            # Max's confirmation -- it was made about a cluster that no longer
            # exists, not about this one.
            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Sarah"], tmp, cfg=cfg)
            data2 = _last_json(result2.output)
            self.assertTrue(data2["success"])
            self.assertEqual(data2["reassigned_from"], [])

            max_profile = cfg.get_person_profile(max_id)
            self.assertEqual(len(max_profile["prototypes"]), 1)
            self.assertEqual(max_profile["prototypes"][0]["diarization_run_id"], run1)
            self.assertEqual(max_profile["prototypes"][0]["embedding_mean"], [1.0, 0.0])

            sarah_profile = cfg.get_person_profile(data2["person_id"])
            self.assertEqual(len(sarah_profile["prototypes"]), 1)
            self.assertEqual(sarah_profile["prototypes"][0]["diarization_run_id"], run2)
            self.assertEqual(sarah_profile["prototypes"][0]["embedding_mean"], [0.0, 1.0])

    def test_confirming_a_reused_cluster_id_keeps_an_older_runs_negatives(self):
        # The idempotency-rebuild removals, which the test above never
        # reaches: it stops at a positive removal that matches nothing. Those
        # two clear the negatives THIS confirm is about to rewrite, so
        # unscoped they take a previous run's negatives with them -- evidence
        # about a different voice that nothing in this confirm questioned.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            output_dir = Path(tmp) / "output"
            run1 = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            cfg = Config(config_path=Path(tmp) / "config.json")

            r1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(r1.output)["person_id"]
            r2, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)
            sarah_id = _last_json(r2.output)["person_id"]

            run2 = self._rediarize(tmp)
            # Sarah is confirmed on the new run's SPEAKER_00 -- the id her own
            # run-1 hard negative is recorded against.
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--person-id", sarah_id], tmp, cfg=cfg)

            sarah_profile = cfg.get_person_profile(sarah_id)
            self.assertEqual(
                [n["diarization_run_id"] for n in sarah_profile["hard_negatives"]], [run1],
                "her run-1 negative is about the voice that held SPEAKER_00 back then",
            )
            self.assertEqual(
                sorted(p["diarization_run_id"] for p in sarah_profile["prototypes"]),
                sorted([run1, run2]),
            )
            max_profile = cfg.get_person_profile(max_id)
            self.assertEqual([p["diarization_run_id"] for p in max_profile["prototypes"]], [run1])
            self.assertEqual([n["diarization_run_id"] for n in max_profile["hard_negatives"]], [run1])

    def test_reassigning_this_runs_cluster_leaves_the_previous_runs_negatives_standing(self):
        # The reassignment loop's two negative cleanups, reached only when a
        # confirm actually supersedes somebody. Both are about the cluster
        # being taken away, so neither may reach into a previous run's
        # evidence about a reused id.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            output_dir = Path(tmp) / "output"
            run1 = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            cfg = Config(config_path=Path(tmp) / "config.json")

            self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            r2, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)
            sarah_id = _last_json(r2.output)["person_id"]
            sarah_run1_negative = cfg.get_person_profile(sarah_id)["hard_negatives"][0]["prototype_id"]

            self._rediarize(tmp)
            r3, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Ida"], tmp, cfg=cfg)
            ida_id = _last_json(r3.output)["person_id"]
            # Hand-built rather than earned, because a run-1 confirmation
            # would also leave Ida a run-1 prototype, and the cleanup under
            # test only runs for someone who owns no cluster here any more.
            ida_run1_negative = cfg.add_speaker_prototype(
                ida_id, [0.5, 0.5], recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_01", speech_duration_seconds=20.0,
                segment_count=4, created_from="user_confirmed", channel="mic",
                negative=True, diarization_run_id=run1,
            )["prototype_id"]

            # Ida loses the cluster to Jon, so both cleanups fire.
            r4, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Jon"], tmp, cfg=cfg)
            self.assertEqual(_last_json(r4.output)["reassigned_from"], ["Ida"])

            self.assertEqual(
                [n["prototype_id"] for n in cfg.get_person_profile(ida_id)["hard_negatives"]],
                [ida_run1_negative],
                "her run-2 negative went with the cluster; the run-1 one is not this confirm's",
            )
            self.assertIn(
                sarah_run1_negative,
                [n["prototype_id"] for n in cfg.get_person_profile(sarah_id)["hard_negatives"]],
                "a bystander's run-1 negative survives a reassignment in run 2",
            )

    def test_reconfirming_a_cluster_on_a_legacy_sidecar_still_supersedes(self):
        # The correction path on a library that predates run stamping: with no
        # run id anywhere, re-confirming is still the "Change" flow and must
        # take the prototype off the person who no longer owns the cluster.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_legacy_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(result1.output)["person_id"]

            self._seed_legacy_sidecar(tmp)  # rewritten, still no run block
            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Sarah"], tmp, cfg=cfg)
            data2 = _last_json(result2.output)
            self.assertTrue(data2["success"])
            self.assertEqual(data2["reassigned_from"], ["Max"])

            self.assertEqual(cfg.get_person_profile(max_id)["prototypes"], [])
            sarah_profile = cfg.get_person_profile(data2["person_id"])
            self.assertEqual(len(sarah_profile["prototypes"]), 1)
            self.assertNotIn("diarization_run_id", sarah_profile["prototypes"][0])

    def test_a_superseded_prototype_does_not_keep_someone_present_in_this_channel(self):
        # The `still_present` read that guards the negative cleanup. When a
        # person loses their only cluster of THIS run, the negatives they
        # earned by being here go with it -- but a leftover prototype from a
        # superseded run reads as "they still own a cluster here" and
        # suppresses that cleanup, leaving evidence behind that nothing in
        # this meeting justifies any more.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            output_dir = Path(tmp) / "output"
            run1 = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            cfg = Config(config_path=Path(tmp) / "config.json")
            max_id = cfg.create_person_profile("Max")["person_id"]
            # His run-1 cluster, on the id he does NOT hold in run 2.
            cfg.add_speaker_prototype(
                max_id, [0.0, 1.0], recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_01", speech_duration_seconds=25.0,
                segment_count=4, created_from="user_confirmed", channel="mic",
                diarization_run_id=run1,
            )

            self._rediarize(tmp)
            # Earned, not hand-built: confirming him and then Sarah is what
            # mints his run-2 negative in the first place.
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--person-id", max_id], tmp, cfg=cfg)
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)
            self.assertEqual(len(cfg.get_person_profile(max_id)["hard_negatives"]), 1)

            # He loses his one run-2 cluster to Ida, so he is no longer
            # present in this channel in this run at all.
            r, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Ida"], tmp, cfg=cfg)
            self.assertEqual(_last_json(r.output)["reassigned_from"], ["Max"])

            max_profile = cfg.get_person_profile(max_id)
            self.assertEqual(
                max_profile["hard_negatives"], [],
                "his run-2 negatives rest on a presence he no longer has",
            )
            self.assertEqual(
                [p["diarization_run_id"] for p in max_profile["prototypes"]], [run1],
                "and his run-1 prototype is still not this confirm's to touch",
            )

    def test_a_superseded_prototype_does_not_seed_negatives_from_this_runs_voices(self):
        # The mutual-negative source selection. It picks a person by
        # meeting+cluster id and then mints a negative from the CURRENT run's
        # embedding for that id -- so an unscoped match records "Sarah is not
        # this voice" about a voice Max was never confirmed next to, and
        # hands Max the same about Sarah. Hard negatives are permanent
        # suppression, so a wrong one is not noise: it refuses a real match
        # for either of them in meetings that have nothing to do with this.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            output_dir = Path(tmp) / "output"
            run1 = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            cfg = Config(config_path=Path(tmp) / "config.json")
            max_id = cfg.create_person_profile("Max")["person_id"]
            cfg.add_speaker_prototype(
                max_id, [0.0, 1.0], recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_01", speech_duration_seconds=25.0,
                segment_count=4, created_from="user_confirmed", channel="mic",
                diarization_run_id=run1,
            )

            self._rediarize(tmp)
            result, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Sarah"], tmp, cfg=cfg)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["hard_negatives_added_against"], [])
            self.assertEqual(cfg.get_person_profile(data["person_id"])["hard_negatives"], [])
            self.assertEqual(cfg.get_person_profile(max_id)["hard_negatives"], [])

    def _seed_legacy_sidecar(self, tmp, meeting_stem="mtg001"):
        # A sidecar written before diarization_run existed -- no top-level
        # "diarization_run" key at all, not one holding None. Written by
        # hand rather than through write_speakers_sidecar, which always
        # stamps a run now.
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "meeting_id": meeting_stem,
            "created_at": time.time(),
            "channels": {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                        "SPEAKER_01": {"embedding": [0.0, 1.0], "speech_duration_seconds": 25.0, "segment_count": 4},
                    },
                },
            },
        }
        (output_dir / f"{meeting_stem}_speakers.json").write_text(json.dumps(payload))
        return output_dir

    def _seed_three_cluster_sidecar(self, tmp, meeting_stem="mtg001"):
        """One channel, three clusters -- the shape that appears as soon as the
        diarizer splits one person across two clusters, which is the normal
        case under deliberate over-segmentation."""
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, meeting_stem, {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    # Two clusters of ONE voice, deliberately far enough apart
                    # that merge_same_channel_fragments leaves them separate.
                    "SPEAKER_00": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                    "SPEAKER_02": {"embedding": [0.0, 0.0, 1.0], "speech_duration_seconds": 20.0, "segment_count": 4},
                    "SPEAKER_01": {"embedding": [0.0, 1.0], "speech_duration_seconds": 25.0, "segment_count": 4},
                },
            },
        })

    def test_one_person_owning_two_clusters_keeps_both_hard_negatives(self):
        # Many-to-one: the user assigns SPEAKER_00 and SPEAKER_02 to Max, and
        # SPEAKER_01 to Sarah. Sarah must be a hard negative against BOTH of
        # Max's clusters -- the loop matched only the FIRST prototype per
        # person (`next(...)`), so the second cluster of a person silently
        # produced no negative evidence at all.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_three_cluster_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            r1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(r1.output)["person_id"]
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_02", "--person-id", max_id], tmp, cfg=cfg)
            r3, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)
            sarah_id = _last_json(r3.output)["person_id"]

            max_profile = cfg.get_person_profile(max_id)
            sarah_profile = cfg.get_person_profile(sarah_id)

            self.assertEqual(
                len(max_profile["prototypes"]), 2,
                "one person may own several clusters of the same meeting",
            )
            negative_sids = sorted(
                h.get("diarization_speaker_id") for h in sarah_profile["hard_negatives"]
            )
            self.assertEqual(
                negative_sids, ["SPEAKER_00", "SPEAKER_02"],
                "Sarah is demonstrably not either of Max's clusters",
            )

    def test_reassigning_one_cluster_keeps_the_persons_other_negatives(self):
        # The displaced person's negatives were removed for the WHOLE
        # meeting+channel rather than only those citing the cluster being
        # taken away. With one person owning two clusters that silently
        # stripped the evidence belonging to the cluster they keep.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_three_cluster_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            r1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(r1.output)["person_id"]
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_02", "--person-id", max_id], tmp, cfg=cfg)
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)

            # Max loses SPEAKER_02 to a third person; SPEAKER_00 stays his.
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_02", "--new-person", "Tom"], tmp, cfg=cfg)

            max_profile = cfg.get_person_profile(max_id)
            self.assertEqual(
                [p["diarization_speaker_id"] for p in max_profile["prototypes"]], ["SPEAKER_00"],
            )
            negative_sids = sorted(
                h.get("diarization_speaker_id") for h in max_profile["hard_negatives"]
            )
            self.assertIn(
                "SPEAKER_01", negative_sids,
                "the evidence that Max is not Sarah belongs to the cluster he kept",
            )

    def test_hard_negatives_scoped_to_same_channel_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {"SPEAKER_00": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5}},
                },
                "system": {
                    "recording_type": "remote",
                    "clusters": {"SPEAKER_00": {"embedding": [0.0, 1.0], "speech_duration_seconds": 30.0, "segment_count": 5}},
                },
            })
            cfg = Config(config_path=Path(tmp) / "config.json")
            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp, cfg=cfg)
            result2, cfg = self._run(["mtg001", "system", "SPEAKER_00", "--new-person", "RemoteGuest"], tmp, cfg=cfg)
            data2 = _last_json(result2.output)
            # Same meeting, but a DIFFERENT channel -- must not be treated
            # as confirmed-different (mic vs. system isn't reliable
            # cross-channel negative evidence, e.g. echo/feedback bleed).
            self.assertEqual(data2["hard_negatives_added_against"], [])

    def test_cross_channel_id_collision_does_not_create_hard_negatives(self):
        # The real collision shape: the OTHER channel's confirmed sid
        # (system SPEAKER_00) also exists as a DIFFERENT cluster id in the
        # channel being confirmed (mic SPEAKER_00, an unrelated voice).
        # Without channel scoping, confirming mic SPEAKER_01 would mistake
        # Alice (system SPEAKER_00) for a same-channel confirmation and
        # record negatives built from mic SPEAKER_00's embedding.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        # distance 0.4 apart -- far enough not to merge.
                        "SPEAKER_00": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                        "SPEAKER_01": {"embedding": [0.6, 0.8], "speech_duration_seconds": 25.0, "segment_count": 4},
                    },
                },
                "system": {
                    "recording_type": "remote",
                    "clusters": {"SPEAKER_00": {"embedding": [0.0, 1.0], "speech_duration_seconds": 30.0, "segment_count": 5}},
                },
            })
            cfg = Config(config_path=Path(tmp) / "config.json")
            result1, cfg = self._run(["mtg001", "system", "SPEAKER_00", "--new-person", "Alice"], tmp, cfg=cfg)
            alice_id = _last_json(result1.output)["person_id"]
            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Bob"], tmp, cfg=cfg)
            data2 = _last_json(result2.output)
            self.assertEqual(data2["hard_negatives_added_against"], [])
            self.assertEqual(cfg.get_person_profile(alice_id)["hard_negatives"], [])
            self.assertEqual(cfg.get_person_profile(data2["person_id"])["hard_negatives"], [])

    def test_legacy_prototype_without_channel_still_matches_via_recording_type(self):
        # A prototype confirmed before the channel field existed must still
        # count as a same-channel confirmation via the recording_type proxy.
        # On a legacy sidecar, because that is where such a prototype
        # actually lives: a build old enough to write no `channel` wrote no
        # run block either, and pairing it with a freshly stamped sidecar
        # would describe a meeting re-diarized since that confirm -- which
        # the run scope correctly refuses, testing something else entirely.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_legacy_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            alice = cfg.create_person_profile("Alice")
            cfg.add_speaker_prototype(
                alice["person_id"], [1.0, 0.0],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=30.0, segment_count=5,
                created_from="user_confirmed",  # no channel -- legacy shape
            )
            result, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Bob"], tmp, cfg=cfg)
            data = _last_json(result.output)
            self.assertEqual(data["hard_negatives_added_against"], ["Alice"])

    def test_reconfirming_cluster_as_different_person_reassigns(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Alice"], tmp, cfg=cfg)
            alice_id = _last_json(result1.output)["person_id"]

            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Bob"], tmp, cfg=cfg)
            data2 = _last_json(result2.output)
            self.assertEqual(data2["reassigned_from"], ["Alice"])
            self.assertEqual(data2["participants_updated"], ["Bob"])

            # Alice's wrong prototype is gone -- not kept alongside Bob's.
            self.assertEqual(cfg.get_person_profile(alice_id)["prototypes"], [])
            bob = cfg.get_person_profile(data2["person_id"])
            self.assertEqual(len(bob["prototypes"]), 1)
            self.assertEqual(bob["prototypes"][0]["created_from"], "user_corrected")

    def test_reconfirming_same_person_replaces_instead_of_duplicating(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Alice"], tmp, cfg=cfg)
            alice_id = _last_json(result1.output)["person_id"]
            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--person-id", alice_id], tmp, cfg=cfg)
            data2 = _last_json(result2.output)
            self.assertTrue(data2["success"])
            self.assertEqual(data2["reassigned_from"], [])
            profile = cfg.get_person_profile(alice_id)
            self.assertEqual(len(profile["prototypes"]), 1)
            # A plain re-confirm is not a correction.
            self.assertEqual(profile["prototypes"][0]["created_from"], "user_confirmed")

    def test_reassignment_cleans_stale_hard_negatives_and_rebuilds(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            result1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Alice"], tmp, cfg=cfg)
            alice_id = _last_json(result1.output)["person_id"]
            result2, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Bob"], tmp, cfg=cfg)
            bob_id = _last_json(result2.output)["person_id"]

            # Wrong call discovered: SPEAKER_00 was actually Carol.
            result3, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Carol"], tmp, cfg=cfg)
            data3 = _last_json(result3.output)
            self.assertEqual(data3["reassigned_from"], ["Alice"])
            self.assertEqual(data3["hard_negatives_added_against"], ["Bob"])

            alice = cfg.get_person_profile(alice_id)
            bob = cfg.get_person_profile(bob_id)
            carol = cfg.get_person_profile(data3["person_id"])
            # Alice was never in this meeting: no positives, no negatives.
            self.assertEqual(alice["prototypes"], [])
            self.assertEqual(alice["hard_negatives"], [])
            # Bob's negative citing SPEAKER_00 was rebuilt (once, not
            # stacked on the stale one from Alice's wrongful confirm).
            self.assertEqual(len(bob["hard_negatives"]), 1)
            self.assertEqual(bob["hard_negatives"][0]["embedding_mean"], [1.0, 0.0])
            self.assertEqual(len(carol["hard_negatives"]), 1)
            self.assertEqual(carol["hard_negatives"][0]["embedding_mean"], [0.0, 1.0])
            self.assertEqual(carol["prototypes"][0]["created_from"], "user_corrected")

    def test_relabel_transcript_flag_rewrites_saved_transcript(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text(
                "---\nis_diarised: true\n---\n\n"
                "## Summary\n\nA three-person meeting.\n\n"
                "## Transcript\n\n"
                "[00:05] [Speaker 2] hello there\n\n[00:20] [You] hi back\n",
                encoding="utf-8",
            )
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            })
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcripts_dir / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n"
                "[00:05] [Speaker 2] hello there\n\n[00:20] [You] hi back",
                encoding="utf-8",
            )
            result, _ = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma", "--relabel-transcript"], tmp,
            )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["relabeled_lines"], 1)
            text = transcript_path.read_text()
            self.assertIn("[00:05] [Person Gamma] hello there", text)
            self.assertIn("[00:20] [You] hi back", text)  # untouched
            summary_text = summary_path.read_text()
            self.assertIn("[00:05] [Person Gamma] hello there", summary_text)
            self.assertNotIn("[00:05] [Speaker 2] hello there", summary_text)

    def test_relabel_transcript_preserves_a_manually_edited_summary_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5,
                            "segments": [{"start": 0.0, "end": 1.0}],
                        },
                    },
                },
            })
            summary_path = output_dir / "mtg001_summary.md"
            edited_summary = (
                "---\nis_diarised: true\n---\n\n## Summary\n\nEdited note.\n\n"
                "## Transcript\n\n[00:00] [Speaker 2] manually corrected wording\n"
            )
            summary_path.write_text(edited_summary, encoding="utf-8")
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcripts_dir / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n[00:00] [Speaker 2] original wording",
                encoding="utf-8",
            )

            result, _ = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma", "--relabel-transcript"],
                tmp,
            )

            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["relabeled_lines"], 1)
            self.assertIn("[00:00] [Person Gamma] original wording", transcript_path.read_text(encoding="utf-8"))
            summary_text = summary_path.read_text(encoding="utf-8")
            self.assertIn("[00:00] [Speaker 2] manually corrected wording", summary_text)
            self.assertNotIn("[00:00] [Person Gamma] manually corrected wording", summary_text)
            self.assertNotIn("[00:00] [Speaker 2] original wording", summary_text)

    def test_relabel_retry_repairs_summary_after_its_first_write_fails(self):
        # The canonical transcript write can complete before the best-effort
        # summary write fails. Repeating this confirmation must repair the
        # matching summary even though there are no new transcript relabels.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text(
                "## Summary\n\nText.\n\n"
                "## Transcript\n\n[00:05] [Speaker 2] hello there\n",
                encoding="utf-8",
            )
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0],
                            "speech_duration_seconds": 30.0,
                            "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            }, turn_manifest=[{
                "start": 5.1,
                "channel": "mic",
                "diarization_speaker_id": "SPEAKER_00",
            }])
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcripts_dir / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n"
                "[00:05] [Speaker 2] hello there",
                encoding="utf-8",
            )
            real_atomic_write = simple_recorder._atomic_write_text
            failed_once = False

            def fail_first_summary_transcript_write(path, text, *args, **kwargs):
                nonlocal failed_once
                if path == summary_path and not failed_once and "[Person Gamma]" in text:
                    failed_once = True
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, text, *args, **kwargs)

            request = [
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma",
                "--relabel-transcript",
            ]
            with mock.patch(
                "simple_recorder._atomic_write_text",
                side_effect=fail_first_summary_transcript_write,
            ):
                first, cfg = self._run(request, tmp)

            first_data = _last_json(first.output)
            self.assertNotEqual(first.exit_code, 0)
            self.assertFalse(first_data["success"])
            self.assertTrue(failed_once)
            self.assertIn("[Person Gamma] hello there", transcript_path.read_text())
            self.assertIn("[Speaker 2] hello there", summary_path.read_text())
            self.assertIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

            retry, _ = self._run(request, tmp, cfg=cfg)
            retry_data = _last_json(retry.output)
            self.assertTrue(retry_data["success"])
            self.assertEqual(len(cfg.get_person_profiles()), 1)
            self.assertEqual(retry_data["relabeled_lines"], 0)
            self.assertIn("[Person Gamma] hello there", summary_path.read_text())
            self.assertNotIn("[Speaker 2] hello there", summary_path.read_text())
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

    def test_noncanonical_existing_name_uses_one_canonical_retry_operation(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = (
                self._seed_two_cluster_relabel_artifacts(tmp)
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Alice")
            cfg._config["person_profiles"][0]["display_name"] = "\uff21\uff4c\uff49\uff43\uff45"
            self.assertTrue(cfg._save())
            request = [
                "mtg001", "mic", "SPEAKER_00", "--person-id", person["person_id"],
                "--relabel-transcript",
            ]
            real_atomic_write = simple_recorder._atomic_write_text
            failed_once = False

            def fail_first_summary_write(path, text, *args, **kwargs):
                nonlocal failed_once
                if path == summary_path and not failed_once:
                    failed_once = True
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, text, *args, **kwargs)

            with mock.patch(
                "simple_recorder._atomic_write_text", side_effect=fail_first_summary_write,
            ):
                first, _ = self._run(request, tmp, cfg=cfg)

            self.assertNotEqual(first.exit_code, 0)
            self.assertTrue(failed_once)
            self.assertIn("[Alice] first", transcript_path.read_text(encoding="utf-8"))
            self.assertNotIn("\uff21\uff4c\uff49\uff43\uff45", transcript_path.read_text(encoding="utf-8"))
            marker = read_speakers_sidecar(output_dir, "mtg001")[
                "pending_summary_transcript_sync"
            ]
            self.assertEqual(
                marker["operation_sha256"],
                simple_recorder._summary_sync_operation_hash({("mic", "SPEAKER_00")}, "Alice"),
            )
            self.assertEqual(cfg.get_person_profile(person["person_id"])["display_name"], "Alice")

            retry, _ = self._run(request, tmp, cfg=cfg)

            self.assertTrue(_last_json(retry.output)["success"])
            self.assertIn("[Alice] first", summary_path.read_text(encoding="utf-8"))
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

    def test_legacy_relabel_summary_io_failure_retries_same_new_person_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text(
                "## Summary\n\nText.\n\n"
                "## Transcript\n\n[00:05] [Speaker 2] hello there\n",
                encoding="utf-8",
            )
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0],
                            "speech_duration_seconds": 30.0,
                            "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            })
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcripts_dir / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n"
                "[00:05] [Speaker 2] hello there",
                encoding="utf-8",
            )
            request = [
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Legacy",
                "--relabel-transcript",
            ]
            real_atomic_write = simple_recorder._atomic_write_text
            failed_once = False

            def fail_first_summary_write(path, text, *args, **kwargs):
                nonlocal failed_once
                if path == summary_path and not failed_once and "[Person Legacy]" in text:
                    failed_once = True
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, text, *args, **kwargs)

            with mock.patch(
                "simple_recorder._atomic_write_text",
                side_effect=fail_first_summary_write,
            ):
                first, cfg = self._run(request, tmp)

            self.assertNotEqual(first.exit_code, 0)
            self.assertFalse(_last_json(first.output)["success"])
            self.assertTrue(failed_once)
            self.assertEqual(len(cfg.get_person_profiles()), 1)
            committed_person_id = cfg.get_person_profiles()[0]["person_id"]
            self.assertIn("[Person Legacy] hello there", transcript_path.read_text())
            self.assertIn("[Speaker 2] hello there", summary_path.read_text())
            self.assertIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

            retry, _ = self._run(request, tmp, cfg=cfg)

            self.assertTrue(_last_json(retry.output)["success"])
            self.assertEqual(len(cfg.get_person_profiles()), 1)
            self.assertEqual(cfg.get_person_profiles()[0]["person_id"], committed_person_id)
            self.assertIn("[Person Legacy] hello there", summary_path.read_text())
            self.assertNotIn("[Speaker 2] hello there", summary_path.read_text())
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

    def test_retry_marker_survives_review_or_participants_followup_failure(self):
        for failure_stage in ("review_state", "participants"):
            with self.subTest(failure_stage=failure_stage), tempfile.TemporaryDirectory() as tmp:
                output_dir, summary_path, transcript_path = (
                    self._seed_two_cluster_relabel_artifacts(tmp)
                )
                set_cluster_review_state(
                    output_dir,
                    "mtg001",
                    "mic",
                    "SPEAKER_00",
                    REVIEW_STATE_GENERIC,
                )
                request = [
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ]

                if failure_stage == "review_state":
                    failure_patch = mock.patch(
                        "src.speaker_suggestions.clear_cluster_review_state",
                        return_value=0,
                    )
                else:
                    real_write_text = Path.write_text
                    summary_tmp = summary_path.with_name(summary_path.name + ".tmp")

                    def fail_participants_write(path, text, *args, **kwargs):
                        if path == summary_tmp and "## Participants" in text:
                            raise OSError("simulated participants write failure")
                        return real_write_text(path, text, *args, **kwargs)

                    failure_patch = mock.patch.object(
                        Path,
                        "write_text",
                        new=fail_participants_write,
                    )

                with failure_patch:
                    failed, cfg = self._run(request, tmp)

                self.assertNotEqual(failed.exit_code, 0)
                self.assertFalse(_last_json(failed.output)["success"])
                self.assertEqual(len(cfg.get_person_profiles()), 1)
                committed_person_id = cfg.get_person_profiles()[0]["person_id"]
                sidecar_after_failure = read_speakers_sidecar(output_dir, "mtg001")
                self.assertIn("pending_summary_transcript_sync", sidecar_after_failure)
                self.assertIn("[00:05] [Person Alpha] first", transcript_path.read_text())
                self.assertIn("[00:05] [Person Alpha] first", summary_path.read_text())
                if failure_stage == "review_state":
                    self.assertEqual(
                        sidecar_after_failure["channels"]["mic"]["clusters"][
                            "SPEAKER_00"
                        ][REVIEW_STATE_KEY],
                        REVIEW_STATE_GENERIC,
                    )
                else:
                    self.assertNotIn("## Participants", summary_path.read_text())

                retry, _ = self._run(request, tmp, cfg=cfg)

                self.assertTrue(_last_json(retry.output)["success"])
                self.assertEqual(len(cfg.get_person_profiles()), 1)
                self.assertEqual(
                    cfg.get_person_profiles()[0]["person_id"], committed_person_id,
                )
                sidecar_after_retry = read_speakers_sidecar(output_dir, "mtg001")
                self.assertNotIn("pending_summary_transcript_sync", sidecar_after_retry)
                self.assertNotIn(
                    REVIEW_STATE_KEY,
                    sidecar_after_retry["channels"]["mic"]["clusters"]["SPEAKER_00"],
                )
                self.assertIn("Person Alpha", summary_path.read_text())

    def test_merged_you_turn_is_skipped_during_summary_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            body = "[00:05] [You] owner words\n[00:10] [Speaker 2] guest words"
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text("## Transcript\n\n" + body + "\n", encoding="utf-8")
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0],
                            "speech_duration_seconds": 20.0,
                            "segment_count": 3,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                        "SPEAKER_01": {
                            "embedding": [0.999, 0.001],
                            "speech_duration_seconds": 20.0,
                            "segment_count": 3,
                            "segments": [{"start": 9.0, "end": 11.0}],
                        },
                    },
                },
            }, turn_manifest=[
                {"start": 5.1, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"},
                {"start": 10.1, "channel": "mic", "diarization_speaker_id": "SPEAKER_01"},
            ])
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcripts_dir / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n" + body,
                encoding="utf-8",
            )
            request = [
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Guest",
                "--relabel-transcript",
            ]
            real_atomic_write = simple_recorder._atomic_write_text
            failed_once = False

            def fail_first_summary_write(path, text, *args, **kwargs):
                nonlocal failed_once
                if path == summary_path and not failed_once and "[Person Guest]" in text:
                    failed_once = True
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, text, *args, **kwargs)

            with mock.patch(
                "simple_recorder._atomic_write_text",
                side_effect=fail_first_summary_write,
            ):
                first, cfg = self._run(request, tmp)

            self.assertNotEqual(first.exit_code, 0)
            self.assertFalse(_last_json(first.output)["success"])
            canonical_after_failure = simple_recorder._saved_transcript_body(transcript_path)
            self.assertEqual(
                canonical_after_failure,
                "[00:05] [You] owner words\n[00:10] [Person Guest] guest words",
            )
            marker = read_speakers_sidecar(output_dir, "mtg001")[
                "pending_summary_transcript_sync"
            ]
            self.assertEqual(
                marker["canonical_after_sha256"],
                simple_recorder._transcript_body_hash(canonical_after_failure),
            )

            retry, _ = self._run(request, tmp, cfg=cfg)

            self.assertTrue(_last_json(retry.output)["success"])
            summary_after = summary_path.read_text(encoding="utf-8")
            self.assertIn("[00:05] [You] owner words", summary_after)
            self.assertIn("[00:10] [Person Guest] guest words", summary_after)
            self.assertNotIn("[00:05] [Person Guest] owner words", summary_after)
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

    def test_existing_reserved_you_profile_fails_before_confirmation_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = (
                self._seed_two_cluster_relabel_artifacts(tmp)
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            cfg._config["person_profiles"][0]["display_name"] = "You"
            self.assertTrue(cfg._save())
            profiles_before = cfg.get_person_profiles()
            sidecar_before = read_speakers_sidecar(output_dir, "mtg001")
            transcript_before = transcript_path.read_text(encoding="utf-8")
            summary_before = summary_path.read_text(encoding="utf-8")

            failed, _ = self._run(
                [
                    "mtg001", "mic", "SPEAKER_00", "--person-id", person["person_id"],
                    "--relabel-transcript",
                ],
                tmp,
                cfg=cfg,
            )

            self.assertNotEqual(failed.exit_code, 0)
            self.assertFalse(_last_json(failed.output)["success"])
            self.assertEqual(cfg.get_person_profiles(), profiles_before)
            self.assertEqual(read_speakers_sidecar(output_dir, "mtg001"), sidecar_before)
            self.assertEqual(transcript_path.read_text(encoding="utf-8"), transcript_before)
            self.assertEqual(summary_path.read_text(encoding="utf-8"), summary_before)

    def test_corrupt_neighbouring_reserved_you_profile_fails_before_confirmation_mutation(self):
        """A persisted lookalike of the reserved self label cannot become
        hard-negative or participant evidence during a different confirm."""
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = (
                self._seed_two_cluster_relabel_artifacts(tmp)
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            first, cfg = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha"],
                tmp,
                cfg=cfg,
            )
            self.assertTrue(_last_json(first.output)["success"])
            cfg._config["person_profiles"][0]["display_name"] = "\uff39\uff4f\uff55"
            self.assertTrue(cfg._save())
            profiles_before = cfg.get_person_profiles()
            sidecar_before = read_speakers_sidecar(output_dir, "mtg001")
            transcript_before = transcript_path.read_text(encoding="utf-8")
            summary_before = summary_path.read_text(encoding="utf-8")

            failed, _ = self._run(
                ["mtg001", "mic", "SPEAKER_01", "--new-person", "Person Beta"],
                tmp,
                cfg=cfg,
            )

            self.assertNotEqual(failed.exit_code, 0)
            self.assertFalse(_last_json(failed.output)["success"])
            self.assertEqual(cfg.get_person_profiles(), profiles_before)
            self.assertEqual(read_speakers_sidecar(output_dir, "mtg001"), sidecar_before)
            self.assertEqual(transcript_path.read_text(encoding="utf-8"), transcript_before)
            self.assertEqual(summary_path.read_text(encoding="utf-8"), summary_before)

    def test_pending_sync_blocks_confirm_without_relabel_before_profile_mutation(self):
        for blocked_mode in ("new_person", "person_id"):
            with self.subTest(blocked_mode=blocked_mode), tempfile.TemporaryDirectory() as tmp:
                output_dir, summary_path, transcript_path = (
                    self._seed_two_cluster_relabel_artifacts(tmp)
                )
                cfg = Config(config_path=Path(tmp) / "config.json")
                if blocked_mode == "person_id":
                    person_beta = cfg.create_person_profile("Person Beta")
                    blocked_request = [
                        "mtg001", "mic", "SPEAKER_01", "--person-id",
                        person_beta["person_id"],
                    ]
                else:
                    blocked_request = [
                        "mtg001", "mic", "SPEAKER_01", "--new-person", "Person Beta",
                    ]
                original_request = [
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ]
                real_atomic_write = simple_recorder._atomic_write_text

                def fail_summary_write(path, text, *args, **kwargs):
                    if path == summary_path and "[Person Alpha]" in text:
                        raise OSError("simulated summary write failure")
                    return real_atomic_write(path, text, *args, **kwargs)

                with mock.patch(
                    "simple_recorder._atomic_write_text",
                    side_effect=fail_summary_write,
                ):
                    interrupted, _ = self._run(original_request, tmp, cfg=cfg)
                self.assertNotEqual(interrupted.exit_code, 0)
                marker_state = read_speakers_sidecar(output_dir, "mtg001")
                self.assertIn("pending_summary_transcript_sync", marker_state)
                profiles_before = cfg.get_person_profiles()
                transcript_before = transcript_path.read_text(encoding="utf-8")
                summary_before = summary_path.read_text(encoding="utf-8")

                blocked, _ = self._run(blocked_request, tmp, cfg=cfg)

                self.assertNotEqual(blocked.exit_code, 0)
                self.assertFalse(_last_json(blocked.output)["success"])
                self.assertEqual(cfg.get_person_profiles(), profiles_before)
                self.assertEqual(read_speakers_sidecar(output_dir, "mtg001"), marker_state)
                self.assertEqual(transcript_path.read_text(encoding="utf-8"), transcript_before)
                self.assertEqual(summary_path.read_text(encoding="utf-8"), summary_before)

                original_retry, _ = self._run(original_request, tmp, cfg=cfg)
                self.assertTrue(_last_json(original_retry.output)["success"])
                blocked_retry, _ = self._run(blocked_request, tmp, cfg=cfg)
                self.assertTrue(_last_json(blocked_retry.output)["success"])

    def test_foreign_confirm_cannot_clear_completed_hashes_before_review_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = (
                self._seed_two_cluster_relabel_artifacts(tmp)
            )
            set_cluster_review_state(
                output_dir,
                "mtg001",
                "mic",
                "SPEAKER_00",
                REVIEW_STATE_GENERIC,
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            original_request = [
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                "--relabel-transcript",
            ]
            with mock.patch(
                "src.speaker_suggestions.clear_cluster_review_state",
                return_value=0,
            ):
                interrupted, _ = self._run(original_request, tmp, cfg=cfg)
            self.assertNotEqual(interrupted.exit_code, 0)
            marker_state = read_speakers_sidecar(output_dir, "mtg001")
            self.assertIn("pending_summary_transcript_sync", marker_state)
            self.assertEqual(
                marker_state["channels"]["mic"]["clusters"]["SPEAKER_00"][
                    REVIEW_STATE_KEY
                ],
                REVIEW_STATE_GENERIC,
            )
            profiles_before = cfg.get_person_profiles()
            transcript_before = transcript_path.read_text(encoding="utf-8")
            summary_before = summary_path.read_text(encoding="utf-8")
            foreign_request = [
                "mtg001", "mic", "SPEAKER_01", "--new-person", "Person Beta",
                "--relabel-transcript",
            ]

            foreign, _ = self._run(foreign_request, tmp, cfg=cfg)

            self.assertNotEqual(foreign.exit_code, 0)
            self.assertFalse(_last_json(foreign.output)["success"])
            self.assertEqual(cfg.get_person_profiles(), profiles_before)
            self.assertEqual(read_speakers_sidecar(output_dir, "mtg001"), marker_state)
            self.assertEqual(transcript_path.read_text(encoding="utf-8"), transcript_before)
            self.assertEqual(summary_path.read_text(encoding="utf-8"), summary_before)

            original_retry, _ = self._run(original_request, tmp, cfg=cfg)
            self.assertTrue(_last_json(original_retry.output)["success"])
            foreign_retry, _ = self._run(foreign_request, tmp, cfg=cfg)
            self.assertTrue(_last_json(foreign_retry.output)["success"])
            final_sidecar = read_speakers_sidecar(output_dir, "mtg001")
            self.assertNotIn("pending_summary_transcript_sync", final_sidecar)
            self.assertNotIn(
                REVIEW_STATE_KEY,
                final_sidecar["channels"]["mic"]["clusters"]["SPEAKER_00"],
            )
            final_transcript = transcript_path.read_text(encoding="utf-8")
            final_summary = summary_path.read_text(encoding="utf-8")
            self.assertIn("[Person Alpha]", final_transcript)
            self.assertIn("[Person Beta]", final_transcript)
            self.assertIn("[Person Alpha]", final_summary)
            self.assertIn("[Person Beta]", final_summary)
            self.assertIn("Person Alpha, Person Beta", final_summary)

    def test_new_person_retries_a_legacy_v1_summary_sync_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = (
                self._seed_two_cluster_relabel_artifacts(tmp)
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            request = [
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                "--relabel-transcript",
            ]
            real_atomic_write = simple_recorder._atomic_write_text

            def fail_summary_write(path, text, *args, **kwargs):
                if path == summary_path and "[Person Alpha]" in text:
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, text, *args, **kwargs)

            with mock.patch(
                "simple_recorder._atomic_write_text",
                side_effect=fail_summary_write,
            ):
                interrupted, _ = self._run(request, tmp, cfg=cfg)
            self.assertNotEqual(interrupted.exit_code, 0)
            sidecar = read_speakers_sidecar(output_dir, "mtg001")
            marker = sidecar["pending_summary_transcript_sync"]
            marker["version"] = simple_recorder._LEGACY_PENDING_SUMMARY_TRANSCRIPT_SYNC_VERSION
            marker.pop("target_ids", None)
            write_sidecar_document(output_dir, "mtg001", sidecar)

            retry, _ = self._run(request, tmp, cfg=cfg)

            self.assertTrue(_last_json(retry.output)["success"])
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )
            self.assertIn("[Person Alpha] first", transcript_path.read_text(encoding="utf-8"))
            final_summary = summary_path.read_text(encoding="utf-8")
            self.assertIn("[Person Alpha] first", final_summary)
            self.assertIn("## Participants", final_summary)
            self.assertIn("Person Alpha", final_summary)

    def test_canonical_transcript_write_failure_reports_json_and_retries_same_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = self._seed_two_cluster_relabel_artifacts(tmp)
            summary_path.write_text(
                "## Summary\n\nText.\n\n"
                "## Transcript\n\n[00:05] [Speaker 2] first\n[00:10] [Speaker 3] second\n",
                encoding="utf-8",
            )
            request = [
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                "--relabel-transcript",
            ]
            transcript_before = transcript_path.read_text(encoding="utf-8")
            summary_before = summary_path.read_text(encoding="utf-8")
            sidecar_before = read_speakers_sidecar(output_dir, "mtg001")
            real_write_text = Path.write_text
            transcript_tmp = transcript_path.with_name(transcript_path.name + ".tmp")

            def fail_canonical_tmp_write(path, text, *args, **kwargs):
                if path == transcript_tmp:
                    raise OSError("simulated canonical transcript write failure")
                return real_write_text(path, text, *args, **kwargs)

            with mock.patch.object(Path, "write_text", new=fail_canonical_tmp_write):
                failed, cfg = self._run(request, tmp)

            failed_data = _last_json(failed.output)
            self.assertNotEqual(failed.exit_code, 0)
            self.assertFalse(failed_data["success"])
            profiles = cfg.get_person_profiles()
            self.assertEqual(len(profiles), 1)
            self.assertEqual(profiles[0]["display_name"], "Person Alpha")
            self.assertEqual(len(profiles[0]["prototypes"]), 1)
            committed_person_id = profiles[0]["person_id"]
            sidecar_after_failure = read_speakers_sidecar(output_dir, "mtg001")
            marker = sidecar_after_failure["pending_summary_transcript_sync"]
            expected_sidecar = json.loads(json.dumps(sidecar_before))
            expected_sidecar["pending_summary_transcript_sync"] = marker
            expected_sidecar["transcript_lines"][0]["original_label"] = "Speaker 2"
            self.assertEqual(sidecar_after_failure, expected_sidecar)
            self.assertEqual(transcript_path.read_text(encoding="utf-8"), transcript_before)
            self.assertEqual(summary_path.read_text(encoding="utf-8"), summary_before)
            self.assertNotIn("## Participants", summary_before)

            retry, _ = self._run(request, tmp, cfg=cfg)

            self.assertTrue(_last_json(retry.output)["success"])
            self.assertEqual(len(cfg.get_person_profiles()), 1)
            self.assertEqual(cfg.get_person_profiles()[0]["person_id"], committed_person_id)
            self.assertNotEqual(
                read_speakers_sidecar(output_dir, "mtg001").get(
                    "pending_summary_transcript_sync"
                ),
                marker,
            )
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )
            self.assertIn("[00:05] [Person Alpha] first", transcript_path.read_text())
            self.assertIn("[00:05] [Person Alpha] first", summary_path.read_text())
            self.assertIn("Person Alpha", summary_path.read_text())

    def test_canonical_write_failure_retry_survives_missing_or_diverged_summary(self):
        for summary_state in ("missing", "diverged"):
            with self.subTest(summary_state=summary_state), tempfile.TemporaryDirectory() as tmp:
                output_dir, summary_path, transcript_path = (
                    self._seed_two_cluster_relabel_artifacts(tmp)
                )
                if summary_state == "missing":
                    summary_path.unlink()
                    summary_before = None
                else:
                    summary_path.write_text(
                        "## Summary\n\nManually edited.\n\n"
                        "## Transcript\n\n[00:05] [Manual Person] corrected first\n",
                        encoding="utf-8",
                    )
                    summary_before = summary_path.read_text(encoding="utf-8")

                request = [
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ]
                transcript_before = transcript_path.read_text(encoding="utf-8")
                real_write_text = Path.write_text
                transcript_tmp = transcript_path.with_name(transcript_path.name + ".tmp")

                def fail_canonical_tmp_write(path, text, *args, **kwargs):
                    if path == transcript_tmp:
                        raise OSError("simulated canonical transcript write failure")
                    return real_write_text(path, text, *args, **kwargs)

                with mock.patch.object(Path, "write_text", new=fail_canonical_tmp_write):
                    failed, cfg = self._run(request, tmp)

                self.assertNotEqual(failed.exit_code, 0)
                self.assertFalse(_last_json(failed.output)["success"])
                self.assertEqual(len(cfg.get_person_profiles()), 1)
                committed_person_id = cfg.get_person_profiles()[0]["person_id"]
                self.assertEqual(
                    transcript_path.read_text(encoding="utf-8"), transcript_before,
                )
                if summary_before is None:
                    self.assertFalse(summary_path.exists())
                else:
                    self.assertEqual(summary_path.read_text(encoding="utf-8"), summary_before)
                self.assertIn(
                    "pending_summary_transcript_sync",
                    read_speakers_sidecar(output_dir, "mtg001"),
                )

                retry, _ = self._run(request, tmp, cfg=cfg)

                self.assertTrue(_last_json(retry.output)["success"])
                self.assertEqual(len(cfg.get_person_profiles()), 1)
                self.assertEqual(
                    cfg.get_person_profiles()[0]["person_id"], committed_person_id,
                )
                self.assertIn(
                    "[00:05] [Person Alpha] first",
                    transcript_path.read_text(encoding="utf-8"),
                )
                self.assertNotIn(
                    "pending_summary_transcript_sync",
                    read_speakers_sidecar(output_dir, "mtg001"),
                )
                if summary_before is None:
                    self.assertFalse(summary_path.exists())
                else:
                    summary_after = summary_path.read_text(encoding="utf-8")
                    self.assertIn("[00:05] [Manual Person] corrected first", summary_after)
                    self.assertNotIn("[00:05] [Person Alpha] first", summary_after)

    def test_new_person_retry_does_not_reuse_name_without_matching_cluster_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, _summary_path, _transcript_path = (
                self._seed_two_cluster_relabel_artifacts(tmp)
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            cfg.add_speaker_prototype(
                person["person_id"],
                [1.0, 0.0],
                recording_type="in_person",
                meeting_id="other-meeting",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=30.0,
                segment_count=5,
                created_from="user_confirmed",
                channel="mic",
            )
            sidecar = read_speakers_sidecar(output_dir, "mtg001")
            sidecar["pending_summary_transcript_sync"] = {
                "version": 2,
                "operation_sha256": simple_recorder._summary_sync_operation_hash(
                    {("mic", "SPEAKER_00")}, "Person Alpha"
                ),
            }
            write_sidecar_document(output_dir, "mtg001", sidecar)
            profiles_before = cfg.get_person_profiles()

            failed, _ = self._run(
                [
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ],
                tmp,
                cfg=cfg,
            )

            self.assertNotEqual(failed.exit_code, 0)
            self.assertFalse(_last_json(failed.output)["success"])
            self.assertEqual(cfg.get_person_profiles(), profiles_before)

    def test_relabel_retry_keeps_marker_when_same_second_turns_make_repair_unsafe(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = self._seed_two_cluster_relabel_artifacts(
                tmp, same_rendered_timestamp=True,
            )
            stale_body = (
                "[00:05] [Speaker 2] first\n"
                "[00:05] [Speaker 3] second"
            )
            canonical_body = (
                "[00:05] [Person Alpha] first\n"
                "[00:05] [Speaker 3] second"
            )
            real_atomic_write = simple_recorder._atomic_write_text
            failed_once = False

            def fail_first_summary_transcript_write(path, text, *args, **kwargs):
                nonlocal failed_once
                if path == summary_path and not failed_once and "[Person Alpha]" in text:
                    failed_once = True
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, text, *args, **kwargs)

            with mock.patch(
                "simple_recorder._atomic_write_text",
                side_effect=fail_first_summary_transcript_write,
            ):
                first, cfg = self._run([
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ], tmp)

            self.assertNotEqual(first.exit_code, 0)
            self.assertFalse(_last_json(first.output)["success"])
            self.assertTrue(failed_once)
            self.assertEqual(simple_recorder._saved_transcript_body(transcript_path), canonical_body)
            self.assertIn(stale_body, summary_path.read_text(encoding="utf-8"))
            marker = read_speakers_sidecar(output_dir, "mtg001")[
                "pending_summary_transcript_sync"
            ]
            person_id = cfg.get_person_profiles()[0]["person_id"]

            unsafe_retry, _ = self._run([
                "mtg001", "mic", "SPEAKER_00", "--person-id", person_id,
                "--relabel-transcript",
            ], tmp, cfg=cfg)

            self.assertNotEqual(unsafe_retry.exit_code, 0)
            self.assertFalse(_last_json(unsafe_retry.output)["success"])
            self.assertEqual(simple_recorder._saved_transcript_body(transcript_path), canonical_body)
            self.assertIn(stale_body, summary_path.read_text(encoding="utf-8"))
            self.assertEqual(
                read_speakers_sidecar(output_dir, "mtg001")[
                    "pending_summary_transcript_sync"
                ],
                marker,
            )

            summary_path.write_text(
                "## Transcript\n\n" + canonical_body + "\n",
                encoding="utf-8",
            )
            recovered, _ = self._run([
                "mtg001", "mic", "SPEAKER_00", "--person-id", person_id,
                "--relabel-transcript",
            ], tmp, cfg=cfg)

            self.assertTrue(_last_json(recovered.output)["success"])
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )
            self.assertIn(canonical_body, summary_path.read_text(encoding="utf-8"))

    def test_relabel_retry_preserves_a_json_copy_with_only_its_label_edited(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            summary_path = output_dir / "mtg001_summary.json"
            summary_path.write_text(json.dumps({
                "is_diarised": True,
                "diarised_text": "[00:05] [Speaker 2] hello there",
            }), encoding="utf-8")
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0],
                            "speech_duration_seconds": 30.0,
                            "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            }, turn_manifest=[{
                "start": 5.1,
                "channel": "mic",
                "diarization_speaker_id": "SPEAKER_00",
            }])
            transcript_path = Path(tmp) / "transcripts" / "mtg001_transcript.txt"
            transcript_path.parent.mkdir(parents=True, exist_ok=True)
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n"
                "[00:05] [Speaker 2] hello there",
                encoding="utf-8",
            )
            real_atomic_write = simple_recorder._atomic_write_json

            def fail_summary_write(path, payload, *args, **kwargs):
                if path == summary_path and payload.get("diarised_text", "").find("Person Gamma") >= 0:
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, payload, *args, **kwargs)

            with mock.patch("simple_recorder._atomic_write_json", side_effect=fail_summary_write):
                first, cfg = self._run([
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma",
                    "--relabel-transcript",
                ], tmp)

            first_data = _last_json(first.output)
            self.assertNotEqual(first.exit_code, 0)
            self.assertFalse(first_data["success"])
            edited = json.loads(summary_path.read_text(encoding="utf-8"))
            edited["diarised_text"] = "[00:05] [Person Delta] hello there"
            summary_path.write_text(json.dumps(edited), encoding="utf-8")
            pending = read_speakers_sidecar(output_dir, "mtg001")[
                "pending_summary_transcript_sync"
            ]
            self.assertNotIn("hello there", json.dumps(pending))
            self.assertNotIn("Person Gamma", json.dumps(pending))

            person_id = cfg.get_person_profiles()[0]["person_id"]
            retry, _ = self._run([
                "mtg001", "mic", "SPEAKER_00", "--person-id", person_id,
                "--relabel-transcript",
            ], tmp, cfg=cfg)

            self.assertTrue(_last_json(retry.output)["success"])
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["diarised_text"], "[00:05] [Person Delta] hello there")
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

    def test_completed_marker_after_clear_failure_is_reconciled_before_another_confirm(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = self._seed_two_cluster_relabel_artifacts(tmp)
            with mock.patch("simple_recorder._clear_summary_transcript_sync", return_value=False):
                first, cfg = self._run([
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ], tmp)

            self.assertFalse(_last_json(first.output)["success"])
            self.assertIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

            second, _ = self._run([
                "mtg001", "mic", "SPEAKER_01", "--new-person", "Person Beta",
                "--relabel-transcript",
            ], tmp, cfg=cfg)

            self.assertTrue(_last_json(second.output)["success"])
            self.assertIn("[00:10] [Person Beta] second", transcript_path.read_text(encoding="utf-8"))
            self.assertIn("[00:10] [Person Beta] second", summary_path.read_text(encoding="utf-8"))
            self.assertIn("Person Beta", summary_path.read_text(encoding="utf-8"))
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

    def test_change_confirmation_reconciles_a_completed_marker_from_the_old_person(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = self._seed_two_cluster_relabel_artifacts(tmp)
            with mock.patch("simple_recorder._clear_summary_transcript_sync", return_value=False):
                first, cfg = self._run([
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ], tmp)
            self.assertFalse(_last_json(first.output)["success"])
            person_beta = cfg.create_person_profile("Person Beta")

            changed, _ = self._run([
                "mtg001", "mic", "SPEAKER_00", "--person-id", person_beta["person_id"],
                "--relabel-transcript",
            ], tmp, cfg=cfg)

            self.assertTrue(_last_json(changed.output)["success"])
            self.assertIn("[00:05] [Person Beta] first", transcript_path.read_text(encoding="utf-8"))
            self.assertIn("[00:05] [Person Beta] first", summary_path.read_text(encoding="utf-8"))
            self.assertNotIn(
                "pending_summary_transcript_sync",
                read_speakers_sidecar(output_dir, "mtg001"),
            )

    def test_ambiguous_pending_marker_fails_before_a_second_confirm_mutates_profiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, summary_path, transcript_path = self._seed_two_cluster_relabel_artifacts(tmp)
            real_atomic_write = simple_recorder._atomic_write_text

            def fail_alpha_summary_write(path, text, *args, **kwargs):
                if path == summary_path and "[Person Alpha]" in text:
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, text, *args, **kwargs)

            with mock.patch(
                "simple_recorder._atomic_write_text",
                side_effect=fail_alpha_summary_write,
            ):
                first, cfg = self._run([
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ], tmp)
            self.assertFalse(_last_json(first.output)["success"])

            second, _ = self._run([
                "mtg001", "mic", "SPEAKER_01", "--new-person", "Person Beta",
                "--relabel-transcript",
            ], tmp, cfg=cfg)

            self.assertNotEqual(second.exit_code, 0)
            self.assertFalse(_last_json(second.output)["success"])
            self.assertEqual([p["display_name"] for p in cfg.get_person_profiles()], ["Person Alpha"])
            self.assertIn("[00:10] [Speaker 3] second", transcript_path.read_text(encoding="utf-8"))
            self.assertIn("[00:10] [Speaker 3] second", summary_path.read_text(encoding="utf-8"))

    def test_relabel_prefers_json_when_both_summary_formats_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            before = "[00:05] [Speaker 2] hello there"
            json_path = output_dir / "mtg001_summary.json"
            json_path.write_text(json.dumps({"diarised_text": before}), encoding="utf-8")
            md_path = output_dir / "mtg001_summary.md"
            md_path.write_text(
                "## Summary\n\nText.\n\n## Transcript\n\n" + before + "\n",
                encoding="utf-8",
            )
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0],
                            "speech_duration_seconds": 30.0,
                            "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            }, turn_manifest=[{
                "start": 5.1,
                "channel": "mic",
                "diarization_speaker_id": "SPEAKER_00",
            }])
            transcript_path = Path(tmp) / "transcripts" / "mtg001_transcript.txt"
            transcript_path.parent.mkdir(parents=True, exist_ok=True)
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n" + before,
                encoding="utf-8",
            )

            result, _ = self._run([
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma",
                "--relabel-transcript",
            ], tmp)

            self.assertTrue(_last_json(result.output)["success"])
            self.assertIn(
                "[Person Gamma] hello there",
                json.loads(json_path.read_text(encoding="utf-8"))["diarised_text"],
            )
            self.assertIn("[Speaker 2] hello there", md_path.read_text(encoding="utf-8"))

    def test_marker_write_failure_rolls_back_confirmation_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            before = "[00:05] [Speaker 2] hello there"
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text(
                "## Summary\n\nText.\n\n## Transcript\n\n" + before + "\n",
                encoding="utf-8",
            )
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0],
                            "speech_duration_seconds": 30.0,
                            "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            }, turn_manifest=[{
                "start": 5.1,
                "channel": "mic",
                "diarization_speaker_id": "SPEAKER_00",
            }])
            transcript_path = Path(tmp) / "transcripts" / "mtg001_transcript.txt"
            transcript_path.parent.mkdir(parents=True, exist_ok=True)
            transcript_file_before = "Session: mtg001\n\n" + "=" * 60 + "\n\n" + before
            transcript_path.write_text(transcript_file_before, encoding="utf-8")
            summary_before = summary_path.read_text(encoding="utf-8")
            sidecar_before = read_speakers_sidecar(output_dir, "mtg001")
            import src.speaker_suggestions as speaker_suggestions
            real_write = speaker_suggestions.write_sidecar_document

            def fail_only_marker_write(output, stem, document, **kwargs):
                if "pending_summary_transcript_sync" in document:
                    raise OSError("simulated marker write failure")
                return real_write(output, stem, document, **kwargs)

            with mock.patch.object(
                speaker_suggestions,
                "write_sidecar_document",
                side_effect=fail_only_marker_write,
            ):
                first, cfg = self._run([
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma",
                    "--relabel-transcript",
                ], tmp)

            first_data = _last_json(first.output)
            self.assertNotEqual(first.exit_code, 0)
            self.assertFalse(first_data["success"])
            self.assertEqual(cfg.get_person_profiles(), [])
            self.assertEqual(transcript_path.read_text(encoding="utf-8"), transcript_file_before)
            self.assertEqual(summary_path.read_text(encoding="utf-8"), summary_before)
            self.assertEqual(read_speakers_sidecar(output_dir, "mtg001"), sidecar_before)

            retry, _ = self._run([
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma",
                "--relabel-transcript",
            ], tmp, cfg=cfg)
            self.assertTrue(_last_json(retry.output)["success"])
            self.assertIn("[Person Gamma] hello there", transcript_path.read_text(encoding="utf-8"))
            self.assertIn("[Person Gamma] hello there", summary_path.read_text(encoding="utf-8"))

    def test_change_confirmation_retry_uses_the_exact_old_person_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text(
                "## Summary\n\nText.\n\n"
                "## Transcript\n\n[00:05] [Speaker 2] hello there\n",
                encoding="utf-8",
            )
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0],
                            "speech_duration_seconds": 30.0,
                            "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            }, turn_manifest=[{
                "start": 5.1,
                "channel": "mic",
                "diarization_speaker_id": "SPEAKER_00",
            }])
            transcript_path = Path(tmp) / "transcripts" / "mtg001_transcript.txt"
            transcript_path.parent.mkdir(parents=True, exist_ok=True)
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n"
                "[00:05] [Speaker 2] hello there",
                encoding="utf-8",
            )
            first, cfg = self._run([
                "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                "--relabel-transcript",
            ], tmp)
            self.assertTrue(_last_json(first.output)["success"])
            person_beta = cfg.create_person_profile("Person Beta")
            real_atomic_write = simple_recorder._atomic_write_text
            failed_once = False

            def fail_first_beta_summary_write(path, text, *args, **kwargs):
                nonlocal failed_once
                if path == summary_path and not failed_once and "[Person Beta]" in text:
                    failed_once = True
                    raise OSError("simulated summary write failure")
                return real_atomic_write(path, text, *args, **kwargs)

            with mock.patch(
                "simple_recorder._atomic_write_text",
                side_effect=fail_first_beta_summary_write,
            ):
                changed, _ = self._run([
                    "mtg001", "mic", "SPEAKER_00", "--person-id", person_beta["person_id"],
                    "--relabel-transcript",
                ], tmp, cfg=cfg)

            self.assertNotEqual(changed.exit_code, 0)
            self.assertFalse(_last_json(changed.output)["success"])
            self.assertIn("[Person Beta] hello there", transcript_path.read_text(encoding="utf-8"))
            self.assertIn("[Person Alpha] hello there", summary_path.read_text(encoding="utf-8"))

            retry, _ = self._run([
                "mtg001", "mic", "SPEAKER_00", "--person-id", person_beta["person_id"],
                "--relabel-transcript",
            ], tmp, cfg=cfg)

            self.assertTrue(_last_json(retry.output)["success"])
            self.assertIn("[Person Beta] hello there", summary_path.read_text(encoding="utf-8"))
            self.assertNotIn("[Person Alpha] hello there", summary_path.read_text(encoding="utf-8"))

    def test_relabel_retry_preserves_a_manually_edited_summary_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = Path(tmp) / "transcripts" / "mtg001_transcript.txt"
            transcript_path.parent.mkdir(parents=True, exist_ok=True)
            canonical_body = "[00:05] [Person Gamma] original wording"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n" + canonical_body,
                encoding="utf-8",
            )
            summary_path = output_dir / "mtg001_summary.md"
            edited_summary = (
                "## Summary\n\nEdited note.\n\n## Transcript\n\n"
                "[00:05] [Speaker 2] manually corrected wording\n"
            )
            summary_path.write_text(edited_summary, encoding="utf-8")

            simple_recorder._update_summary_transcript(
                output_dir,
                "mtg001",
                transcript_path,
                canonical_body,
                restore_manifest=[{
                    "start": 5.1,
                    "channel": "mic",
                    "diarization_speaker_id": "SPEAKER_00",
                }],
                restore_target_ids={("mic", "SPEAKER_00")},
                retry_relabel_to="Person Gamma",
            )

            self.assertEqual(summary_path.read_text(encoding="utf-8"), edited_summary)

    def test_saved_transcript_body_does_not_treat_a_body_divider_as_a_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            transcript_path = Path(tmp) / "body-only.txt"
            body = "[00:00] [You] before\n\n" + "=" * 60 + "\n\n[00:05] [Others] after"
            transcript_path.write_text(body, encoding="utf-8")

            self.assertEqual(simple_recorder._saved_transcript_body(transcript_path), body)

    def test_update_summary_transcript_updates_a_matching_json_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            summary_path = output_dir / "mtg001_summary.json"
            previous = "[00:00] [Speaker 2] original wording"
            summary_path.write_text(
                json.dumps({"is_diarised": True, "diarised_text": previous}),
                encoding="utf-8",
            )
            transcript_path = Path(tmp) / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n[00:00] [Person Gamma] original wording",
                encoding="utf-8",
            )

            simple_recorder._update_summary_transcript(
                output_dir,
                "mtg001",
                transcript_path,
                previous,
            )

            data = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(data["diarised_text"], "[00:00] [Person Gamma] original wording")

    def test_update_summary_transcript_preserves_a_redacted_json_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            summary_path = output_dir / "mtg001_summary.json"
            redacted = "[00:00] [Speaker 2] [redacted]"
            summary_path.write_text(
                json.dumps({"is_diarised": True, "diarised_text": redacted}),
                encoding="utf-8",
            )
            transcript_path = Path(tmp) / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n[00:00] [Person Gamma] sensitive wording",
                encoding="utf-8",
            )

            simple_recorder._update_summary_transcript(
                output_dir,
                "mtg001",
                transcript_path,
                "[00:00] [Speaker 2] sensitive wording",
            )

            data = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(data["diarised_text"], redacted)

    def test_relabel_transcript_uses_exact_matching_when_sidecar_has_manifest(self):
        # See the plan doc's Phase 8: when the sidecar carries
        # transcript_lines (written by a post-Phase-8 live pipeline run),
        # confirm-speaker must relabel by EXACT recorded (channel, sid)
        # provenance, not the fuzzy timestamp matching the other tests in
        # this class exercise -- proven here by a line whose TIMESTAMP
        # would fuzzy-match the confirmed cluster's segment, but whose
        # manifest entry says it came from a DIFFERENT cluster: it must be
        # left untouched.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            }, turn_manifest=[
                {"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_99"},
            ])
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcripts_dir / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n[00:05] [Speaker 2] hello there",
                encoding="utf-8",
            )
            result, _ = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma", "--relabel-transcript"], tmp,
            )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            # Fuzzy matching would have relabeled this (00:05 falls inside
            # SPEAKER_00's [4.0, 6.0] segment) -- exact matching correctly
            # refuses, since the manifest says this line is SPEAKER_99.
            self.assertEqual(data["relabeled_lines"], 0)
            self.assertIn("[00:05] [Speaker 2] hello there", transcript_path.read_text())

    def test_relabel_transcript_exact_match_relabels_the_right_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            }, turn_manifest=[
                {"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"},
            ])
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcripts_dir / "mtg001_transcript.txt"
            transcript_path.write_text(
                "Session: mtg001\n\n" + "=" * 60 + "\n\n[00:05] [Speaker 2] hello there",
                encoding="utf-8",
            )
            result, _ = self._run(
                ["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma", "--relabel-transcript"], tmp,
            )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["relabeled_lines"], 1)
            self.assertIn("[00:05] [Person Gamma] hello there", transcript_path.read_text())

    def test_without_relabel_flag_transcript_is_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_00": {
                            "embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5,
                            "segments": [{"start": 4.0, "end": 6.0}],
                        },
                    },
                },
            })
            transcripts_dir = Path(tmp) / "transcripts"
            transcripts_dir.mkdir(parents=True, exist_ok=True)
            transcript_path = transcripts_dir / "mtg001_transcript.txt"
            original = (
                "Session: mtg001\n\n" + "=" * 60 + "\n\n[00:05] [Speaker 2] hello there"
            )
            transcript_path.write_text(original, encoding="utf-8")
            result, _ = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["relabeled_lines"], 0)
            self.assertEqual(transcript_path.read_text(), original)

    def test_either_merged_fragment_id_resolves_to_same_combined_prototype(self):
        # Two diarizer IDs on the same channel that are really the same
        # continuous voice (near-identical embeddings, e.g. one real
        # speaker fragmented over a long recording -- see the plan doc's
        # Phase 3.6) must produce the SAME prototype regardless of which
        # fragment id is named on the command line.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            write_speakers_sidecar(output_dir, "mtg001", {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0, "segment_count": 580},
                        "SPEAKER_2": {"embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0, "segment_count": 552},
                    },
                },
            })
            result, cfg = self._run(["mtg001", "system", "SPEAKER_2", "--new-person", "Person Alpha"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            # SPEAKER_2 has less duration than SPEAKER_0 -> SPEAKER_0 is
            # the merge-group primary, even though SPEAKER_2 was requested.
            self.assertEqual(data["resolved_diarization_speaker_id"], "SPEAKER_0")
            self.assertEqual(data["merged_from"], ["SPEAKER_2"])

            profile = cfg.get_person_profile(data["person_id"])
            self.assertEqual(len(profile["prototypes"]), 1)
            prototype = profile["prototypes"][0]
            self.assertEqual(prototype["diarization_speaker_id"], "SPEAKER_0")
            self.assertAlmostEqual(prototype["speech_duration_seconds"], 1600.0 + 1538.0)
            self.assertEqual(prototype["segment_count"], 580 + 552)


class ConfirmSpeakerUpdatesParticipantsTests(unittest.TestCase):
    """Confirming a speaker should keep the meeting summary's `participants`
    (JSON field / `## Participants` markdown section) in sync -- see the
    plan doc's Phase 7."""

    def _run(self, args, tmp, cfg=None):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        cfg.set_identity_matching_enabled(True)
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            result = CliRunner().invoke(simple_recorder.confirm_speaker, args)
        return result, cfg

    def _seed_sidecar(self, tmp, meeting_stem="mtg001"):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, meeting_stem, {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_00": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                    "SPEAKER_01": {"embedding": [0.0, 1.0], "speech_duration_seconds": 25.0, "segment_count": 4},
                },
            },
        })
        return output_dir

    def test_updates_json_summary_participants(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed_sidecar(tmp)
            summary_path = output_dir / "mtg001_summary.json"
            summary_path.write_text(json.dumps({"session_info": {}, "participants": []}), encoding="utf-8")

            result, _ = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["participants_updated"], ["Person Gamma"])

            on_disk = json.loads(summary_path.read_text())
            self.assertEqual(on_disk["participants"], ["Person Gamma"])

    def test_inserts_participants_section_into_markdown_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed_sidecar(tmp)
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text(
                "---\ntitle: \"Mtg\"\n---\n\n## Summary\n\nSome notes.\n\n## Key Points\n\n- a point\n",
                encoding="utf-8",
            )

            result, _ = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp)
            self.assertTrue(_last_json(result.output)["success"])

            text = summary_path.read_text()
            self.assertIn("## Participants\n\nPerson Gamma", text)
            # Inserted after Summary, before Key Points -- and Key Points
            # itself is untouched.
            self.assertLess(text.index("## Summary"), text.index("## Participants"))
            self.assertLess(text.index("## Participants"), text.index("## Key Points"))
            self.assertIn("- a point", text)

    def test_replaces_existing_participants_section_not_duplicated(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed_sidecar(tmp)
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text(
                "---\ntitle: \"Mtg\"\n---\n\n## Summary\n\nSome notes.\n\n"
                "## Participants\n\nOldName\n\n## Key Points\n\n- a point\n",
                encoding="utf-8",
            )

            result, _ = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp)
            self.assertTrue(_last_json(result.output)["success"])

            text = summary_path.read_text()
            self.assertEqual(text.count("## Participants"), 1)
            self.assertIn("## Participants\n\nPerson Gamma", text)
            self.assertNotIn("OldName", text)
            self.assertIn("- a point", text)

    def test_second_person_confirmed_in_same_meeting_appends_not_clobbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed_sidecar(tmp)
            summary_path = output_dir / "mtg001_summary.md"
            summary_path.write_text("---\ntitle: \"Mtg\"\n---\n\n## Summary\n\nSome notes.\n", encoding="utf-8")
            cfg = Config(config_path=Path(tmp) / "config.json")

            _, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp, cfg=cfg)
            result, _ = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Person Alpha"], tmp, cfg=cfg)
            self.assertTrue(_last_json(result.output)["success"])

            text = summary_path.read_text()
            self.assertIn("## Participants\n\nPerson Gamma, Person Alpha", text)

    def test_noops_when_no_summary_file_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)  # no _summary.json/.md written at all
            result, _ = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Person Gamma"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["participants_updated"], ["Person Gamma"])  # computed fine, just nothing to write to


class ConfirmSpeakerEvidenceHygieneTests(ConfirmSpeakerCliTests):
    """Hard negatives are permanent suppression evidence, so a duplicate is
    not merely untidy: every copy is another reason the matcher will refuse a
    real match later."""

    def test_a_person_with_two_clusters_does_not_collect_duplicate_negatives(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_three_cluster_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            r1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(r1.output)["person_id"]
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_02", "--person-id", max_id], tmp, cfg=cfg)
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)

            max_negatives = [
                h.get("diarization_speaker_id")
                for h in cfg.get_person_profile(max_id)["hard_negatives"]
            ]
            self.assertEqual(
                max_negatives, ["SPEAKER_01"],
                "Sarah's one cluster is one piece of evidence, however many clusters Max owns",
            )

    def test_reconfirming_the_same_person_does_not_stack_negatives(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed_sidecar(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            r1, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--new-person", "Max"], tmp, cfg=cfg)
            max_id = _last_json(r1.output)["person_id"]
            r2, cfg = self._run(["mtg001", "mic", "SPEAKER_01", "--new-person", "Sarah"], tmp, cfg=cfg)
            sarah_id = _last_json(r2.output)["person_id"]

            # The UI's Approve on an already-confirmed row, or a user simply
            # redoing the same assignment.
            _, cfg = self._run(["mtg001", "mic", "SPEAKER_00", "--person-id", max_id], tmp, cfg=cfg)

            self.assertEqual(len(cfg.get_person_profile(max_id)["hard_negatives"]), 1)
            self.assertEqual(len(cfg.get_person_profile(sarah_id)["hard_negatives"]), 1)


if __name__ == "__main__":
    unittest.main()

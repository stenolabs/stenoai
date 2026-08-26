import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config
from src.speaker_suggestions import read_speakers_sidecar, write_speakers_sidecar


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

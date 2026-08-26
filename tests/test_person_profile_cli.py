import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config


def _last_json(output):
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


class PersonProfileCliTests(unittest.TestCase):
    """create/rename-person-profile: the CLI wrapper layer around
    Config's name-uniqueness invariant (see ConfigPersonProfileTests in
    tests/test_config.py for the underlying Config-level behavior) --
    these tests only prove the click command surfaces ValueError as a
    graceful {"success": false, "error": ...} instead of a stack trace."""

    def _run(self, command, args, tmp, cfg=None):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            result = CliRunner().invoke(command, args)
        return result, cfg

    def test_create_person_profile_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, cfg = self._run(simple_recorder.create_person_profile, ["Person Gamma"], tmp)
            self.assertEqual(result.exit_code, 0)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["display_name"], "Person Gamma")
            self.assertEqual(len(cfg.get_person_profiles()), 1)

    def test_create_person_profile_rejects_duplicate_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(config_path=Path(tmp) / "config.json")
            cfg.create_person_profile("Person Gamma")
            result, cfg = self._run(simple_recorder.create_person_profile, ["Person Gamma"], tmp, cfg=cfg)
            self.assertNotEqual(result.exit_code, 0)
            data = _last_json(result.output)
            self.assertFalse(data["success"])
            self.assertIn("already exists", data["error"])
            self.assertEqual(len(cfg.get_person_profiles()), 1)

    def test_create_person_profile_reports_config_save_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(config_path=Path(tmp) / "config.json")
            with mock.patch(
                "src.config._atomic_write_json",
                side_effect=OSError("disk full"),
            ):
                result, cfg = self._run(
                    simple_recorder.create_person_profile,
                    ["Person Gamma"],
                    tmp,
                    cfg=cfg,
                )

            self.assertNotEqual(result.exit_code, 0)
            self.assertEqual(_last_json(result.output), {
                "success": False,
                "error": "Could not save the person profile.",
            })
            self.assertEqual(cfg.get_person_profiles(), [])

    def test_rename_person_profile_rejects_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(config_path=Path(tmp) / "config.json")
            cfg.create_person_profile("Person Gamma")
            person_alpha = cfg.create_person_profile("Person Alpha")
            result, cfg = self._run(
                simple_recorder.rename_person_profile, [person_alpha["person_id"], "Person Gamma"], tmp, cfg=cfg,
            )
            self.assertNotEqual(result.exit_code, 0)
            data = _last_json(result.output)
            self.assertFalse(data["success"])
            self.assertIn("already exists", data["error"])
            self.assertEqual(cfg.get_person_profile(person_alpha["person_id"])["display_name"], "Person Alpha")


class PersonProfileParticipantsPropagationTests(unittest.TestCase):
    """rename/delete-person-profile must refresh the Participants list of
    every meeting summary the person was confirmed in (see the plan doc's
    Phase 7) -- a name change or removal must not leave a stale name
    baked into an already-written meeting summary."""

    def _run(self, command, args, tmp, cfg=None):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            result = CliRunner().invoke(command, args)
        return result, cfg

    def _seed_confirmed_person(self, tmp, cfg, display_name, meeting_stem):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        summary_path = output_dir / f"{meeting_stem}_summary.md"
        summary_path.write_text("---\ntitle: \"Mtg\"\n---\n\n## Summary\n\nSome notes.\n", encoding="utf-8")
        person = cfg.create_person_profile(display_name)
        cfg.add_speaker_prototype(
            person["person_id"], [1.0, 0.0],
            recording_type="in_person", meeting_id=meeting_stem,
            diarization_speaker_id="SPEAKER_00",
            speech_duration_seconds=30.0, segment_count=5,
            created_from="user_confirmed",
        )
        # Recompute participants the same way confirm-speaker would, so
        # the summary reflects the seeded confirmation before the
        # rename/delete under test runs.
        from src.speaker_suggestions import confirmed_participant_names
        simple_recorder._update_summary_participants(
            output_dir, meeting_stem, confirmed_participant_names(meeting_stem, cfg.get_person_profiles()),
        )
        return person, summary_path

    def test_rename_updates_participants_in_every_confirmed_meeting(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(config_path=Path(tmp) / "config.json")
            person, summary_path = self._seed_confirmed_person(tmp, cfg, "Julain", "mtg001")
            self.assertIn("## Participants\n\nJulain", summary_path.read_text())

            result, cfg = self._run(
                simple_recorder.rename_person_profile, [person["person_id"], "Person Alpha"], tmp, cfg=cfg,
            )
            self.assertTrue(_last_json(result.output)["success"])
            text = summary_path.read_text()
            self.assertIn("## Participants\n\nPerson Alpha", text)
            self.assertNotIn("Julain", text)

    def test_delete_removes_name_from_every_confirmed_meeting(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(config_path=Path(tmp) / "config.json")
            person, summary_path = self._seed_confirmed_person(tmp, cfg, "Person Gamma", "mtg001")
            self.assertIn("## Participants\n\nPerson Gamma", summary_path.read_text())

            result, cfg = self._run(
                simple_recorder.delete_person_profile, [person["person_id"]], tmp, cfg=cfg,
            )
            self.assertTrue(_last_json(result.output)["success"])
            text = summary_path.read_text()
            self.assertNotIn("## Participants", text)
            self.assertNotIn("Person Gamma", text)

    def test_rename_of_person_never_confirmed_anywhere_is_a_noop_on_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Gamma")
            result, _ = self._run(
                simple_recorder.rename_person_profile, [person["person_id"], "Maximilian"], tmp, cfg=cfg,
            )
            self.assertTrue(_last_json(result.output)["success"])
            # No meeting summaries exist at all -- must not raise.


if __name__ == "__main__":
    unittest.main()

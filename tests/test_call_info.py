"""Caller recognition: the call a recording captured (src.call_info), how it
reaches Participants and the prompts, and the apply-call-info command.

Data is invented: numbers from the fictional 555-01xx range."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.call_info import (
    call_sidecar_path, meeting_context, merge_calls, normalize_calls, read_calls, with_callers,
    write_calls,
)
from src.config import Config
from src.summarizer import OllamaSummarizer

ERIKA = {"name": "Erika Mustermann", "number": "+12025550100", "direction": "incoming",
         "service": "phone", "started_at": "2026-03-02T14:00:00Z"}
UNKNOWN = {"name": None, "number": "+12025550101", "direction": "outgoing",
           "service": "facetime", "started_at": "2026-03-02T15:00:00Z"}
MAX = {"name": "Max Mustermann", "number": "+12025550102", "direction": "outgoing",
       "service": "phone", "started_at": "2026-03-02T16:00:00Z"}

NOTE = """---
title: "Note"
date: "2026-03-02T14:05:00"
---

## Summary
The printer prints blank pages.

## Key Points
- Toner checked

## Transcript

[You] Hello.
[Others] Hello, it is about the printer.
"""


def _last_json(output):
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


def _participants(md_path):
    return simple_recorder._parse_meeting_markdown(md_path).get("participants")


class CallInfoTests(unittest.TestCase):

    def test_normalize_calls_keeps_only_usable_entries(self):
        calls = normalize_calls({"calls": [
            ERIKA, "not a dict", {"name": "", "number": None},
            {"name": "  Max   Mustermann ", "direction": "sideways", "service": "pager"},
        ]})
        self.assertEqual(calls[0], ERIKA)
        self.assertEqual(calls[1], {"name": "Max Mustermann", "number": None, "direction": None,
                                    "service": None, "started_at": None})
        self.assertEqual(len(calls), 2)
        self.assertEqual(normalize_calls("nonsense"), [])
        # A list or object where a word belongs is dropped, not an error.
        odd = normalize_calls([{**ERIKA, "service": ["phone"], "direction": {"in": 1}}])
        self.assertEqual((odd[0]["service"], odd[0]["direction"]), (None, None))

    def test_read_calls_is_empty_without_a_sidecar_or_with_a_broken_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(read_calls(tmp, "stem"), [])
            call_sidecar_path(tmp, "stem").write_text("{not json", encoding="utf-8")
            self.assertEqual(read_calls(tmp, "stem"), [])
            write_calls(tmp, "stem", [ERIKA])
            self.assertEqual(read_calls(tmp, "stem"), [ERIKA])

    def test_with_callers_adds_each_named_caller_once(self):
        self.assertEqual(with_callers([ERIKA], ["Speaker 2"]), ["Erika Mustermann", "Speaker 2"])
        self.assertEqual(with_callers([ERIKA], ["erika mustermann"]), ["erika mustermann"])
        self.assertEqual(with_callers([], ["Speaker 2"]), ["Speaker 2"])
        # Callers lead in the order of the calls, wherever they were listed.
        self.assertEqual(with_callers([ERIKA, MAX], ["Max Mustermann", "Erika Mustermann"]),
                         ["Erika Mustermann", "Max Mustermann"])

    def test_with_callers_never_lists_a_number(self):
        # Participants reach the models (prompts, chat over notes): a caller
        # without a name is left out, as if caller recognition were off.
        self.assertEqual(with_callers([UNKNOWN], ["Speaker 2"]), ["Speaker 2"])
        self.assertEqual(with_callers([ERIKA, UNKNOWN], []), ["Erika Mustermann"])

    def test_merge_calls_adds_new_calls_and_updates_known_ones(self):
        self.assertEqual(merge_calls([ERIKA], [UNKNOWN]), [ERIKA, UNKNOWN])
        self.assertEqual(merge_calls([ERIKA, UNKNOWN], [ERIKA]), [ERIKA, UNKNOWN])
        # Found again without a name (Contacts off this time): the name stays.
        self.assertEqual(merge_calls([ERIKA], [{**ERIKA, "name": None}]), [ERIKA])
        named = {**UNKNOWN, "name": "Max Mustermann"}
        self.assertEqual(merge_calls([UNKNOWN], [named]), [named])
        self.assertEqual(merge_calls([], [ERIKA]), [ERIKA])

    def test_meeting_context_names_the_other_party(self):
        text = meeting_context([ERIKA])
        self.assertTrue(text.startswith("CALL: This recording is an incoming phone call "
                                        "with Erika Mustermann."))
        # A name is enough: the number stays out of the prompts.
        self.assertNotIn("+12025550100", text)
        self.assertIn("[Others] in the transcript is the other party", text)
        self.assertIn("Refer to them by name.", text)
        self.assertTrue(text.endswith("\n\n"))

    def test_meeting_context_leaves_out_a_call_without_a_name(self):
        # No name: the prompts read as with caller recognition off.
        self.assertEqual(meeting_context([UNKNOWN]), "")
        text = meeting_context([ERIKA, UNKNOWN])
        self.assertIn("with Erika Mustermann.", text)
        self.assertNotIn("FaceTime", text)
        self.assertNotIn("+12025550101", text)

    def test_meeting_context_is_empty_without_a_call(self):
        self.assertEqual(meeting_context([]), "")


class ParticipantsKeepCallersTests(unittest.TestCase):
    """Participants is rewritten wholesale from confirmed speakers; callers must survive."""

    def _note(self, tmp, calls):
        (Path(tmp) / "stem_summary.md").write_text(NOTE, encoding="utf-8")
        if calls:
            write_calls(tmp, "stem", calls)
        return Path(tmp) / "stem_summary.md"

    def test_a_speaker_rewrite_keeps_the_caller(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = self._note(tmp, [ERIKA])
            simple_recorder._update_summary_participants(Path(tmp), "stem", ["Max Mustermann"])
            self.assertEqual(_participants(md), ["Erika Mustermann", "Max Mustermann"])

    def test_removing_every_speaker_keeps_the_caller(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = self._note(tmp, [ERIKA])
            simple_recorder._update_summary_participants(Path(tmp), "stem", [])
            self.assertEqual(_participants(md), ["Erika Mustermann"])

    def test_without_a_call_nothing_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = self._note(tmp, [])
            simple_recorder._add_callers_to_participants(Path(tmp), "stem")
            self.assertEqual(md.read_text(encoding="utf-8"), NOTE)

    def test_a_note_it_cannot_read_is_left_alone(self):
        # Not knowing who is listed, it must not write the caller alone.
        with tempfile.TemporaryDirectory() as tmp:
            write_calls(tmp, "stem", [ERIKA])
            path = Path(tmp) / "stem_summary.json"
            path.write_text("{not json", encoding="utf-8")
            self.assertIs(simple_recorder._add_callers_to_participants(Path(tmp), "stem"), False)
            self.assertEqual(path.read_text(encoding="utf-8"), "{not json")

    def test_the_snapshot_taken_after_the_merge_has_the_caller(self):
        # The pipeline and reprocess add the caller before snapshotting, so the
        # snapshot is the note as written; a later diff against it must not
        # read the caller as a user edit.
        with tempfile.TemporaryDirectory() as tmp:
            md = self._note(tmp, [ERIKA])
            simple_recorder._add_callers_to_participants(Path(tmp), "stem")
            simple_recorder._write_original_snapshot(md)
            snapshot = json.loads((Path(tmp) / "stem_original.json").read_text(encoding="utf-8"))
            self.assertEqual(snapshot["original"]["participants"], ["Erika Mustermann"])

    def test_a_legacy_json_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stem_summary.json"
            path.write_text(json.dumps({"participants": ["Max Mustermann"]}), encoding="utf-8")
            write_calls(tmp, "stem", [ERIKA])
            simple_recorder._add_callers_to_participants(Path(tmp), "stem")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["participants"],
                             ["Erika Mustermann", "Max Mustermann"])


class ApplyCallInfoCliTests(unittest.TestCase):

    def _run(self, args, tmp):
        from src.config import get_data_dirs
        cfg = Config(config_path=Path(tmp) / "config.json")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            result = CliRunner().invoke(simple_recorder.apply_call_info, args)
            output_dir = Path(get_data_dirs()["output"])
        return result, output_dir

    def _with_note(self, tmp):
        cfg = Config(config_path=Path(tmp) / "config.json")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            from src.config import get_data_dirs
            output_dir = Path(get_data_dirs()["output"])
        (output_dir / "stem_summary.md").write_text(NOTE, encoding="utf-8")
        return output_dir / "stem_summary.md"

    def test_stores_the_call_and_adds_the_caller_to_participants(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = self._with_note(tmp)
            result, output_dir = self._run(["stem", "--calls", json.dumps([ERIKA])], tmp)
            self.assertEqual(result.exit_code, 0, result.output)
            self.assertEqual(_last_json(result.output),
                             {"success": True, "calls": 1, "note_updated": True})
            self.assertEqual(read_calls(output_dir, "stem"), [ERIKA])
            self.assertEqual(_participants(md), ["Erika Mustermann"])
            # Participants sits after the Summary, and nothing else moved.
            text = md.read_text(encoding="utf-8")
            self.assertIn("pages.\n\n## Participants\n\nErika Mustermann\n\n## Key Points", text)

    def test_a_late_caller_leaves_the_snapshot_alone(self):
        # Only the writer that generated the note may replace its snapshot
        # (app/note-snapshot.js); the caller is not an edit either.
        with tempfile.TemporaryDirectory() as tmp:
            md = self._with_note(tmp)
            simple_recorder._write_original_snapshot(md)
            snapshot_path = md.with_name("stem_original.json")
            before = snapshot_path.read_text(encoding="utf-8")
            result, _ = self._run(["stem", "--calls", json.dumps([ERIKA])], tmp)
            self.assertEqual(result.exit_code, 0, result.output)
            self.assertEqual(_participants(md), ["Erika Mustermann"])
            self.assertEqual(snapshot_path.read_text(encoding="utf-8"), before)

    def test_running_it_twice_changes_nothing_more(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = self._with_note(tmp)
            self._run(["stem", "--calls", json.dumps([ERIKA])], tmp)
            once = md.read_text(encoding="utf-8")
            result, output_dir = self._run(["stem", "--calls", json.dumps([ERIKA])], tmp)
            self.assertEqual(md.read_text(encoding="utf-8"), once)
            self.assertEqual(read_calls(output_dir, "stem"), [ERIKA])

    def test_a_continued_note_keeps_the_earlier_caller(self):
        # The first recording was a call with Erika; the continuation, recorded
        # into the same note, a call with Max.
        with tempfile.TemporaryDirectory() as tmp:
            md = self._with_note(tmp)
            self._run(["stem", "--calls", json.dumps([ERIKA])], tmp)
            result, output_dir = self._run(["stem", "--calls", json.dumps([MAX])], tmp)
            self.assertEqual(_last_json(result.output),
                             {"success": True, "calls": 2, "note_updated": True})
            self.assertEqual(read_calls(output_dir, "stem"), [ERIKA, MAX])
            self.assertEqual(_participants(md), ["Erika Mustermann", "Max Mustermann"])
            # And the next speaker rewrite keeps both.
            simple_recorder._update_summary_participants(output_dir, "stem", ["Speaker 2"])
            self.assertEqual(_participants(md),
                             ["Erika Mustermann", "Max Mustermann", "Speaker 2"])

    def test_a_caller_without_a_name_is_stored_but_not_listed(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = self._with_note(tmp)
            result, output_dir = self._run(["stem", "--calls", json.dumps([UNKNOWN])], tmp)
            self.assertEqual(result.exit_code, 0, result.output)
            self.assertEqual(read_calls(output_dir, "stem"), [UNKNOWN])
            self.assertEqual(md.read_text(encoding="utf-8"), NOTE)

    def test_sidecar_only_leaves_the_note_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = self._with_note(tmp)
            result, output_dir = self._run(["stem", "--sidecar-only", "--calls", json.dumps([ERIKA])], tmp)
            self.assertEqual(_last_json(result.output)["note_updated"], False)
            self.assertEqual(md.read_text(encoding="utf-8"), NOTE)
            self.assertEqual(read_calls(output_dir, "stem"), [ERIKA])

    def test_a_note_it_could_not_update_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._with_note(tmp)
            with mock.patch.object(simple_recorder, "_update_summary_participants", return_value=False):
                result, output_dir = self._run(["stem", "--calls", json.dumps([ERIKA])], tmp)
            self.assertEqual(_last_json(result.output)["note_updated"], False)
            self.assertEqual(read_calls(output_dir, "stem"), [ERIKA])

    def test_before_the_note_exists_it_only_stores_the_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, output_dir = self._run(["stem", "--calls", json.dumps([ERIKA])], tmp)
            self.assertEqual(_last_json(result.output)["note_updated"], False)
            self.assertEqual(read_calls(output_dir, "stem"), [ERIKA])

    def test_rejects_bad_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            for args in (["../escape", "--calls", json.dumps([ERIKA])],
                         ["stem", "--calls", "{not json"],
                         ["stem", "--calls", json.dumps([{"name": None, "number": None}])]):
                result, output_dir = self._run(args, tmp)
                self.assertNotEqual(result.exit_code, 0, args)
                self.assertFalse(_last_json(result.output)["success"], args)
            self.assertFalse(any(Path(tmp).rglob("*_call.json")))


class NumbersNeverReachTheModelsTests(unittest.TestCase):
    """A caller's number stays in <stem>_call.json: it is in no note text, no
    prompt and no chat context, named callers and unnamed ones alike."""

    NUMBERS = ("+12025550100", "+12025550101", "+12025550102")

    def _assert_no_number(self, text, where):
        for number in self.NUMBERS:
            self.assertNotIn(number, text, where)
            self.assertNotIn(number.lstrip("+"), text, where)

    def test_note_prompts_and_chat_carry_no_number(self):
        with tempfile.TemporaryDirectory() as tmp:
            from src.config import get_data_dirs
            cfg = Config(config_path=Path(tmp) / "config.json")
            with mock.patch("src.config.get_config", return_value=cfg), \
                 mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
                output_dir = Path(get_data_dirs()["output"])
                md = output_dir / "stem_summary.md"
                md.write_text(NOTE, encoding="utf-8")
                result = CliRunner().invoke(
                    simple_recorder.apply_call_info,
                    ["stem", "--calls", json.dumps([ERIKA, UNKNOWN, MAX])])
                self.assertEqual(result.exit_code, 0, result.output)
                # Stored, with every number.
                self.assertEqual(len(read_calls(output_dir, "stem")), 3)
                # The note: Participants by name only.
                self._assert_no_number(md.read_text(encoding="utf-8"), "note")
                self.assertEqual(_participants(md), ["Erika Mustermann", "Max Mustermann"])
                # The prompts.
                with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready"):
                    s = OllamaSummarizer(model_name="m", ai_provider="local", config=cfg)
                simple_recorder._set_call_context(s, output_dir, "stem")
                self.assertIn("Erika Mustermann", s.meeting_context)
                transcript = "[You] Hello.\n[Others] Hello."
                for prompt in (s._create_markdown_prompt(transcript),
                               s._create_template_report_prompt(transcript, "Write a report."),
                               s._create_reduce_prompt(["one", "two"])):
                    self._assert_no_number(prompt, "prompt")
                # Single-note chat and chat across notes.
                parts = simple_recorder._build_meeting_chat_context_parts(
                    simple_recorder._parse_meeting_markdown(md))
                self._assert_no_number("\n".join(parts), "note chat")
                self._assert_no_number(simple_recorder._build_chat_corpus(), "global chat")


class PromptContextTests(unittest.TestCase):
    """Every prompt the summarizer builds carries what the recorder knows about the call."""

    CONTEXT = "CALL: This recording is an incoming phone call with Erika Mustermann.\n\n"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config = Config(config_path=Path(self._tmp.name) / "config.json")

    def _summarizer(self):
        with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready"):
            s = OllamaSummarizer(model_name="m", ai_provider="local", config=self.config)
        s.meeting_context = self.CONTEXT
        return s

    def test_summary_and_report_prompts(self):
        s = self._summarizer()
        transcript = "[You] Hello.\n[Others] Hello."
        for prompt in (
            s._create_markdown_prompt(transcript),
            s._create_permissive_prompt(transcript),
            s._create_template_report_prompt(transcript, "Write a report."),
            s._create_reduce_prompt(["extract one", "extract two"]),
        ):
            self.assertTrue(prompt.startswith(self.CONTEXT), prompt[:120])

    def test_title_prompt(self):
        s = self._summarizer()
        with mock.patch.object(s, "_chat_no_think",
                               return_value={"message": {"content": "Printer support"}}) as chat:
            s.generate_title("The printer prints blank pages.", "", language="en")
        prompt = chat.call_args.kwargs["messages"][0]["content"]
        self.assertTrue(prompt.startswith(self.CONTEXT), prompt[:120])

    def test_no_call_means_no_context(self):
        with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready"):
            s = OllamaSummarizer(model_name="m", ai_provider="local", config=self.config)
        self.assertEqual(s.meeting_context, "")
        self.assertTrue(s._create_markdown_prompt("[You] Hi.").startswith("Summarise"))


if __name__ == "__main__":
    unittest.main()

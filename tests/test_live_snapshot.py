"""Instant transcript: the live-transcript snapshot format and the
process-streaming early-summary path that consumes it.

The snapshot is written by app/live-transcript-format.js (node:test covers
that side in app/live-transcript-format.test.js); these tests pin the Python
half: both the v1 JSON and the legacy plain-text shapes parse, and
``process-streaming --early-summary`` saves notes from the live transcript
BEFORE the batch re-transcription, then replaces them with the refined note.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.live_snapshot import LIVE_SNAPSHOT_FORMAT, parse_live_snapshot


def _v1(segments):
    return json.dumps({"format": LIVE_SNAPSHOT_FORMAT, "segments": segments})


TWO_SPEAKERS = [
    {"start": 1.2, "end": 3.0, "speaker": "You", "text": "Let's review the budget."},
    {"start": 3.5, "end": 5.0, "speaker": "You", "text": "Starting with Q3."},
    {"start": 6.0, "end": 9.4, "speaker": "Others", "text": "Q3 came in under plan."},
    {"start": 3725.0, "end": 3730.0, "speaker": "You", "text": "Ship it tomorrow."},
]


class ParseLiveSnapshotTests(unittest.TestCase):
    def test_v1_keeps_speakers_and_timestamps_in_the_batch_shape(self):
        snap = parse_live_snapshot(_v1(TWO_SPEAKERS))
        self.assertTrue(snap.is_diarised)
        # Adjacent same-speaker segments collapse into one turn, stamped with
        # the turn's first start -- the same shape _assemble_diarised_turns saves.
        self.assertEqual(
            snap.diarised_text,
            "[00:01] [You] Let's review the budget. Starting with Q3.\n\n"
            "[00:06] [Others] Q3 came in under plan.\n\n"
            "[1:02:05] [You] Ship it tomorrow.",
        )
        self.assertEqual(
            snap.transcript_text,
            "Let's review the budget. Starting with Q3.\n\n"
            "Q3 came in under plan.\n\nShip it tomorrow.",
        )
        self.assertEqual(snap.text_for_note, snap.diarised_text)
        self.assertEqual(snap.duration_seconds, 3730.0)

    def test_v1_single_speaker_is_saved_plain_like_the_batch_path(self):
        snap = parse_live_snapshot(_v1(TWO_SPEAKERS[:2]))
        self.assertFalse(snap.is_diarised)
        self.assertIsNone(snap.diarised_text)
        self.assertEqual(snap.text_for_note, "Let's review the budget. Starting with Q3.")

    def test_v1_sanitises_bad_segments(self):
        snap = parse_live_snapshot(_v1([
            "not a dict",
            {"start": "nan", "end": None, "speaker": "Mallory", "text": "  hi  "},
            {"start": 2, "end": 3, "speaker": "Others", "text": "   "},
            {"start": 4, "end": 5, "speaker": "Others", "text": 7},
        ]))
        # Unknown speaker -> the mic lane ("You"); blank/non-string text dropped.
        self.assertEqual(snap.transcript_text, "hi")
        self.assertEqual(snap.segments[0]["speaker"], "You")
        self.assertEqual(snap.segments[0]["start"], 0.0)

    def test_v1_with_no_text_is_unusable(self):
        self.assertIsNone(parse_live_snapshot(_v1([])))

    def test_legacy_plain_text_still_parses(self):
        snap = parse_live_snapshot("  first line\n\nsecond line \n")
        self.assertEqual(snap.transcript_text, "first line\n\nsecond line")
        self.assertFalse(snap.is_diarised)
        self.assertIsNone(snap.diarised_text)
        self.assertIsNone(snap.duration_seconds)

    def test_brace_text_that_is_not_a_v1_snapshot_is_plain_text(self):
        for raw in ['{not json at all', '{"format": "other", "segments": []}']:
            snap = parse_live_snapshot(raw)
            self.assertEqual(snap.transcript_text, raw)
            self.assertFalse(snap.is_diarised)

    def test_empty_is_none(self):
        self.assertIsNone(parse_live_snapshot(None))
        self.assertIsNone(parse_live_snapshot("   \n"))


LIVE_SUMMARY = "## Summary\nEARLY summary from the live transcript.\n\n## Key Points\n- early\n"
FINAL_SUMMARY = "## Summary\nFINAL summary from the refined transcript.\n\n## Key Points\n- final\n"
BATCH_DIARISED = "[00:01] [You] Let's review the budget.\n\n[00:06] [Speaker 2] Q3 came in under plan."


def _frontmatter(md):
    return md.split("---")[1]


class EarlySummaryStreamingTests(unittest.TestCase):
    """process-streaming --early-summary, with the ASR and the LLM mocked."""

    def _run(self, *, batch, summaries, args_extra=(), auto_summarize=True, rename_to=None, edit_during=None):
        from click.testing import CliRunner
        import simple_recorder
        from simple_recorder import MeetingPipeline

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        audio = root / "meeting.wav"
        audio.write_bytes(b"synthetic audio fixture")
        live = root / "live.txt"
        live.write_text(_v1(TWO_SPEAKERS[:3]), encoding="utf-8")
        note = root / "meeting_summary.md"

        recorder = MeetingPipeline.__new__(MeetingPipeline)
        recorder.output_dir = root
        recorder.transcripts_dir = root / "transcripts"
        recorder.transcripts_dir.mkdir()
        recorder.summarizer = mock.Mock()
        calls = []

        def _summarize(text, *_a, **_k):
            calls.append(text)
            outcome = summaries[len(calls) - 1]
            if isinstance(outcome, Exception):
                raise outcome
            yield outcome

        recorder.summarizer.summarize_transcript_streaming.side_effect = _summarize
        recorder.summarizer.generate_title.return_value = "Budget sync"
        seen_at_transcribe = {}

        async def _transcribe(_audio, _name):
            # What the user sees while the batch pass runs.
            seen_at_transcribe["note"] = note.read_text(encoding="utf-8") if note.exists() else None
            if rename_to and note.exists():
                # The user renames the early note while the batch pass runs.
                note.write_text(
                    seen_at_transcribe["note"].replace('title: "Budget sync"', f'title: "{rename_to}"'),
                    encoding="utf-8",
                )
            if edit_during and note.exists():
                # Any other edit the user makes to the early note mid-run.
                note.write_text(edit_during(note.read_text(encoding="utf-8")), encoding="utf-8")
            return dict(batch)

        recorder.transcribe_audio = _transcribe
        config = mock.Mock()
        config.get_language.return_value = "en"
        config.get_auto_summarize_enabled.return_value = auto_summarize
        config.get_keep_recordings.return_value = True
        with (
            mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp.name}),
            mock.patch("simple_recorder.MeetingPipeline", return_value=recorder),
            mock.patch("src.config.get_config", return_value=config),
            mock.patch("simple_recorder.generate_default_template_report"),
        ):
            result = CliRunner().invoke(simple_recorder.process_streaming, [
                str(audio), "--name", "Note", "--live-transcript", str(live), *args_extra,
            ])
        final = note.read_text(encoding="utf-8") if note.exists() else ""
        self._last_note = str(note)
        return result, calls, seen_at_transcribe.get("note"), final

    def _usable_batch(self):
        return {
            "transcript_text": "Let's review the budget. Q3 came in under plan.",
            "diarised_text": BATCH_DIARISED,
            "is_diarised": True,
            "duration_seconds": 10,
            "detected_language": "en",
        }

    def test_early_note_is_saved_before_the_batch_pass_then_refined(self):
        result, calls, during, final = self._run(
            batch=self._usable_batch(), summaries=[LIVE_SUMMARY, FINAL_SUMMARY],
            args_extra=["--early-summary"],
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        out = result.output
        # Early note first, batch after; the refine summary is silent.
        self.assertLess(out.index("EARLY_SAVED:"), out.index("TRANSCRIPTION_COMPLETE:"))
        after_early = out[out.index("EARLY_SAVED:"):]
        self.assertNotIn("CHUNK:", after_early)
        self.assertIn("CHUNK:", out[:out.index("EARLY_SAVED:")])
        self.assertEqual(out.count("TITLE:Budget sync"), 1)
        # The first summary was made from the LABELLED live transcript.
        self.assertIn("[00:06] [Others] Q3 came in under plan.", calls[0])
        self.assertEqual(calls[1], BATCH_DIARISED)
        # While the batch pass ran, the note already had notes + live labels.
        self.assertIsNotNone(during)
        self.assertIn("refining: true", _frontmatter(during))
        self.assertIn("is_live_transcript: true", _frontmatter(during))
        self.assertIn("is_diarised: true", _frontmatter(during))
        self.assertIn("EARLY summary", during)
        self.assertIn("[00:01] [You] Let's review the budget. Starting with Q3.", during)
        # The final note replaced it: refined transcript + summary, no flags.
        self.assertNotIn("refining", _frontmatter(final))
        self.assertNotIn("is_live_transcript", _frontmatter(final))
        self.assertNotIn("notes_stale", _frontmatter(final))
        self.assertIn("FINAL summary", final)
        self.assertNotIn("EARLY summary", final)
        self.assertIn("[Speaker 2] Q3 came in under plan.", final)
        self.assertIn('title: "Budget sync"', final)
        self.assertRegex(out, r"(?m)^SAVED:")

    def test_a_rename_made_on_the_early_note_survives_the_refine(self):
        result, _calls, _during, final = self._run(
            batch=self._usable_batch(), summaries=[LIVE_SUMMARY, FINAL_SUMMARY],
            args_extra=["--early-summary"], rename_to="Q3 budget review",
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertIn('title: "Q3 budget review"', final)
        self.assertEqual(result.output.count("TITLE:"), 1)

    def test_a_space_and_my_notes_added_to_the_early_note_survive_the_refine(self):
        # The early note is readable for the whole refine pass: moving it into
        # a space patches `folders:` into its frontmatter (src/folders.py) and
        # typing My notes appends a User Notes section. The final write must
        # carry both, not rebuild the note from the pre-refine snapshot.
        def _edit(md):
            md = md.replace("refining: true", 'refining: true\nfolders: ["f-budget"]')
            return md + "\n## User Notes\n\nRemember to send the deck\n"

        result, _calls, during, final = self._run(
            batch=self._usable_batch(), summaries=[LIVE_SUMMARY, FINAL_SUMMARY],
            args_extra=["--early-summary"], edit_during=_edit,
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertNotIn("folders", _frontmatter(during))
        self.assertIn('folders: ["f-budget"]', _frontmatter(final))
        self.assertIn("FINAL summary", final)
        self.assertIn("## User Notes\n\nRemember to send the deck", final)
        import simple_recorder
        parsed = simple_recorder._parse_meeting_markdown(Path(self._last_note))
        self.assertEqual(parsed["folders"], ["f-budget"])
        self.assertEqual(parsed["user_notes"], "Remember to send the deck")

    def test_refine_summary_failure_keeps_the_early_summary_and_flags_it_stale(self):
        result, calls, _during, final = self._run(
            batch=self._usable_batch(),
            summaries=[LIVE_SUMMARY, RuntimeError("context overflow")],
            args_extra=["--early-summary"],
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertNotIn("STREAM_ERROR:", result.output)
        self.assertIn("EARLY summary", final)
        self.assertIn(BATCH_DIARISED, final)
        self.assertIn("notes_stale: true", _frontmatter(final))
        self.assertNotIn("refining", _frontmatter(final))

    def test_an_empty_refine_summary_never_replaces_the_early_one(self):
        result, _calls, _during, final = self._run(
            batch=self._usable_batch(), summaries=[LIVE_SUMMARY, "   "],
            args_extra=["--early-summary"],
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertIn("EARLY summary", final)
        self.assertIn("notes_stale: true", _frontmatter(final))

    def test_unusable_batch_falls_back_to_the_live_note_without_a_second_summary(self):
        from simple_recorder import _SILENCE_SENTINEL
        result, calls, _during, final = self._run(
            batch={"transcript_text": _SILENCE_SENTINEL, "diarised_text": None,
                   "is_diarised": False, "duration_seconds": 10},
            summaries=[LIVE_SUMMARY],
            args_extra=["--early-summary"],
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertEqual(len(calls), 1)
        self.assertIn("EARLY summary", final)
        self.assertIn("is_live_transcript: true", _frontmatter(final))
        self.assertIn("is_diarised: true", _frontmatter(final))
        self.assertIn("[00:06] [Others] Q3 came in under plan.", final)
        self.assertNotIn("refining", _frontmatter(final))

    def test_early_summary_failure_falls_back_to_the_normal_streamed_pass(self):
        result, calls, during, final = self._run(
            batch=self._usable_batch(),
            summaries=[RuntimeError("ollama down"), FINAL_SUMMARY],
            args_extra=["--early-summary"],
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        out = result.output
        self.assertIn("EARLY_SUMMARY_FAILED", out)
        self.assertNotIn("EARLY_SAVED:", out)
        self.assertIsNone(during)
        # The normal pass streams its summary as today.
        self.assertIn("CHUNK:", out[out.index("TRANSCRIPTION_COMPLETE:"):])
        self.assertIn("FINAL summary", final)

    def test_auto_summarize_off_writes_no_early_note(self):
        result, calls, during, final = self._run(
            batch=self._usable_batch(), summaries=[], args_extra=["--early-summary"],
            auto_summarize=False,
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertEqual(calls, [])
        self.assertIsNone(during)
        self.assertIn("SUMMARY_SKIPPED", result.output)
        self.assertIn("notes_generated: false", _frontmatter(final))

    def test_without_the_flag_nothing_runs_early(self):
        result, calls, during, final = self._run(
            batch=self._usable_batch(), summaries=[FINAL_SUMMARY],
        )
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertNotIn("EARLY_", result.output)
        self.assertIsNone(during)
        self.assertEqual(len(calls), 1)
        self.assertIn("FINAL summary", final)


if __name__ == "__main__":
    unittest.main()

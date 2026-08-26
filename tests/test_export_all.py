"""Unit tests for export-all CLI command (Markdown and CSV formats, path safety, round-trip).
"""
import csv
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner
import simple_recorder
from simple_recorder import export_all
from src.config import Config


class ExportAllCliTests(unittest.TestCase):
    def _create_note(self, out_dir, stem, title, date, duration=60, folders=None, attendees=None, summary="Summary text", transcript="Transcript text"):
        p = out_dir / f"{stem}_summary.md"
        frontmatter = {
            "title": title,
            "date": date,
            "duration_seconds": duration,
        }
        if folders is not None:
            frontmatter["folders"] = folders
        if attendees is not None:
            frontmatter["attendees"] = attendees
        fm_lines = ["---"]
        for k, v in frontmatter.items():
            fm_lines.append(f"{k}: {json.dumps(v)}")
        fm_lines.append("---")
        content = "\n".join(fm_lines) + f"\n\n## Summary\n{summary}\n\n## Transcript\n{transcript}"
        p.write_text(content, encoding="utf-8")
        return p

    def test_csv_export_round_trip_with_commas_quotes_and_newlines(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            notes_dir = tmp / "notes"
            notes_dir.mkdir(parents=True, exist_ok=True)
            export_target = tmp / "exports" / "all_meetings.csv"

            tricky_transcript = (
                '[00:01] Alice: Hello, world!\n'
                '[00:05] Bob: She said, "Let\'s do it," and smiled.\n'
                '[00:10] Alice: Yes, commas, "quotes", and\nnewlines should all work!'
            )
            tricky_summary = 'Discussed commas, quotes ("hello"), and\nnewlines.'

            self._create_note(
                notes_dir, "meeting_1", 'Weekly "Sync", Part 1', "2026-08-01",
                duration=125, folders=["f1", "f2"], attendees=["Alice Smith", "Bob Jones"],
                summary=tricky_summary, transcript=tricky_transcript,
            )
            self._create_note(
                notes_dir, "meeting_2", "Simple Meeting", "2026-08-02",
                duration=30, folders=[], attendees=["Charlie"],
                summary="Simple summary", transcript="Simple transcript",
            )

            with patch("src.config.get_data_dirs", return_value={"output": notes_dir, "transcripts": tmp}):
                runner = CliRunner()
                res = runner.invoke(export_all, ["--format", "csv", "--out", str(export_target)])
                self.assertEqual(res.exit_code, 0)
                data = json.loads(res.output)
                self.assertTrue(data["success"])
                self.assertEqual(data["count"], 2)

            self.assertTrue(export_target.exists())
            with open(export_target, "r", encoding="utf-8", newline="") as fh:
                reader = csv.reader(fh)
                rows = list(reader)

            self.assertEqual(len(rows), 3)  # Header + 2 rows
            header = rows[0]
            self.assertEqual(header, ["title", "date", "duration", "folders", "attendees", "summary", "transcript"])

            # Find tricky note row
            tricky_row = next(r for r in rows[1:] if 'Part 1' in r[0])
            self.assertEqual(tricky_row[0], 'Weekly "Sync", Part 1')
            self.assertEqual(tricky_row[1], '2026-08-01')
            self.assertEqual(tricky_row[2], '125')
            self.assertEqual(tricky_row[3], 'f1, f2')
            self.assertEqual(tricky_row[4], 'Alice Smith, Bob Jones')
            self.assertEqual(tricky_row[5], tricky_summary)
            self.assertEqual(tricky_row[6], tricky_transcript)

    def test_csv_export_guards_formula_trigger_characters(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            notes_dir = tmp / "notes"
            notes_dir.mkdir(parents=True, exist_ok=True)
            export_target = tmp / "exports" / "guarded_export.csv"

            self._create_note(
                notes_dir, "meeting_formula", "=SUM(A1:A9)", "2026-08-01",
                duration=60, folders=["+finance", "-ops"], attendees=["@boss"],
                summary="- bullet point starting with dash",
                transcript="[00:01] Alice: Regular transcript not modified",
            )

            with patch("src.config.get_data_dirs", return_value={"output": notes_dir, "transcripts": tmp}):
                runner = CliRunner()
                res = runner.invoke(export_all, ["--format", "csv", "--out", str(export_target)])
                self.assertEqual(res.exit_code, 0)
                data = json.loads(res.output)
                self.assertTrue(data["success"])

            with open(export_target, "r", encoding="utf-8", newline="") as fh:
                reader = csv.reader(fh)
                rows = list(reader)

            self.assertEqual(len(rows), 2)
            row = rows[1]
            # Title starting with = gets quote prefix
            self.assertEqual(row[0], "'=SUM(A1:A9)")
            self.assertEqual(row[1], "2026-08-01")
            self.assertEqual(row[2], "60")
            # Folders starting with + gets quote prefix
            self.assertEqual(row[3], "'+finance, -ops")
            # Attendees starting with @ gets quote prefix
            self.assertEqual(row[4], "'@boss")
            # Summary starting with - gets quote prefix
            self.assertEqual(row[5], "'- bullet point starting with dash")
            # Transcript starting with [ is unmodified
            self.assertEqual(row[6], "[00:01] Alice: Regular transcript not modified")

    def test_md_export_writes_one_file_per_note(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            notes_dir = tmp / "notes"
            notes_dir.mkdir(parents=True, exist_ok=True)
            target_dir = tmp / "md_export"

            self._create_note(notes_dir, "note_alpha", "Note Alpha", "2026-08-01", summary="Alpha sum")
            self._create_note(notes_dir, "note_beta", "Note Beta", "2026-08-02", summary="Beta sum")

            with patch("src.config.get_data_dirs", return_value={"output": notes_dir, "transcripts": tmp}):
                runner = CliRunner()
                res = runner.invoke(export_all, ["--format", "md", "--out", str(target_dir)])
                self.assertEqual(res.exit_code, 0)
                data = json.loads(res.output)
                self.assertTrue(data["success"])
                self.assertEqual(data["count"], 2)

            self.assertTrue(target_dir.exists())
            exported_files = sorted(list(target_dir.glob("*.md")))
            self.assertEqual(len(exported_files), 2)
            filenames = [f.name for f in exported_files]
            self.assertIn("note_alpha.md", filenames)
            self.assertIn("note_beta.md", filenames)
            self.assertIn("Alpha sum", (target_dir / "note_alpha.md").read_text(encoding="utf-8"))

    def test_export_rejects_target_inside_notes_directory(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            notes_dir = tmp / "notes"
            notes_dir.mkdir(parents=True, exist_ok=True)

            with patch("src.config.get_data_dirs", return_value={"output": notes_dir, "transcripts": tmp}):
                runner = CliRunner()
                # Target is notes dir directly
                res = runner.invoke(export_all, ["--format", "md", "--out", str(notes_dir)])
                self.assertNotEqual(res.exit_code, 0)
                data = json.loads(res.output)
                self.assertFalse(data["success"])
                self.assertIn("Cannot export directly into the StenoAI notes directory", data["error"])

                # Target is subfolder of notes dir
                sub_target = notes_dir / "nested_export"
                res2 = runner.invoke(export_all, ["--format", "csv", "--out", str(sub_target / "out.csv")])
                self.assertNotEqual(res2.exit_code, 0)
                data2 = json.loads(res2.output)
                self.assertFalse(data2["success"])
                self.assertIn("Cannot export directly into the StenoAI notes directory", data2["error"])


if __name__ == "__main__":
    unittest.main()

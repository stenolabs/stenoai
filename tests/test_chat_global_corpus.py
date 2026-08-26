"""Unit tests for cross-meeting chat corpus assembly, relevance scoring,
selected-meetings scoping, and transcript excerpt extraction.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

import simple_recorder
from simple_recorder import (
    _question_relevance_score,
    _extract_transcript_excerpt,
    _extract_query_features,
    _chat_corpus_char_budget,
    chat_global_streaming,
)
from click.testing import CliRunner
from src.config import Config


class QuestionRelevanceScoringTests(unittest.TestCase):
    def test_english_scoring_strips_stopwords_and_matches_keywords(self):
        question = "What was the budget discussed for Q3?"
        haystack_match = "In this meeting we discussed the Q3 budget allocation."
        haystack_unrelated = "Weekly team sync regarding customer support tickets."

        score_match = _question_relevance_score(question, haystack_match)
        score_unrelated = _question_relevance_score(question, haystack_unrelated)

        self.assertGreater(score_match, 0.0)
        self.assertEqual(score_unrelated, 0.0)

    def test_zh_hant_scoring_uses_character_bigrams(self):
        question = "第三季預算會議決定了什麼？"
        haystack_match = "我們在會議中審查並通過了第三季預算。"
        haystack_unrelated = "今天討論辦公室搬遷事宜與設備採購。"

        score_match = _question_relevance_score(question, haystack_match)
        score_unrelated = _question_relevance_score(question, haystack_unrelated)

        self.assertGreater(score_match, 0.0)
        self.assertEqual(score_unrelated, 0.0)

    def test_empty_or_no_overlap_returns_zero(self):
        self.assertEqual(_question_relevance_score("", "some text"), 0.0)
        self.assertEqual(_question_relevance_score("question", ""), 0.0)
        self.assertEqual(_question_relevance_score("completely different words", "xyz abc 123"), 0.0)


class RecencyAndRelevanceOrderingTests(unittest.TestCase):
    def test_all_zero_scores_preserve_exact_recency_order(self):
        notes = [
            {"score": 0.0, "processed_at": "2026-08-01T10:00:00", "id": "older"},
            {"score": 0.0, "processed_at": "2026-08-20T10:00:00", "id": "newer"},
            {"score": 0.0, "processed_at": "2026-08-10T10:00:00", "id": "middle"},
        ]
        sorted_notes = sorted(notes, key=lambda x: (x["score"], x["processed_at"]), reverse=True)
        self.assertEqual([n["id"] for n in sorted_notes], ["newer", "middle", "older"])

    def test_relevant_older_note_ranks_above_irrelevant_newer_note(self):
        notes = [
            {"score": 0.0, "processed_at": "2026-08-20T10:00:00", "id": "new_irrelevant"},
            {"score": 0.8, "processed_at": "2026-08-01T10:00:00", "id": "old_relevant"},
        ]
        sorted_notes = sorted(notes, key=lambda x: (x["score"], x["processed_at"]), reverse=True)
        self.assertEqual([n["id"] for n in sorted_notes], ["old_relevant", "new_irrelevant"])


class TranscriptExcerptExtractionTests(unittest.TestCase):
    def test_extracts_highest_scoring_window(self):
        transcript = (
            "Alice: Good morning everyone.\n"
            "Bob: Hello Alice.\n"
            "Alice: Let us talk about general updates.\n"
            "Bob: Sure thing.\n"
            "Alice: Regarding the secret project codename Falcon, the launch date is October 15.\n"
            "Bob: Falcon launch date is confirmed for October 15.\n"
            "Alice: Thanks everyone, let us wrap up.\n"
            "Bob: Bye."
        )
        excerpt = _extract_transcript_excerpt("When is Falcon launch date?", transcript, max_chars=300)
        self.assertIn("Falcon", excerpt)
        self.assertIn("October 15", excerpt)

    def test_bounds_excerpt_to_max_chars(self):
        long_transcript = "\n".join(f"Speaker {i}: Line {i} discussion about product strategy." for i in range(100))
        excerpt = _extract_transcript_excerpt("product strategy", long_transcript, max_chars=200)
        self.assertLessEqual(len(excerpt), 250)  # max_chars + ellipsis markers

    def test_empty_transcript_returns_empty(self):
        self.assertEqual(_extract_transcript_excerpt("question", ""), "")


class ChatGlobalStreamingCliTests(unittest.TestCase):
    def test_meeting_option_restricts_corpus_and_ignores_folder(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            out_dir = tmp / "output"
            out_dir.mkdir(parents=True, exist_ok=True)
            cfg_path = tmp / "config.json"
            cfg = Config(config_path=cfg_path)
            cfg._config["ai_provider"] = "cloud"
            cfg._config["cloud_model"] = "gpt-4o"
            cfg._save()

            # Create 3 notes: note1 in folder_a, note2 in folder_b, note3 in folder_a
            n1 = out_dir / "note1_summary.md"
            n1.write_text(
                "---\ntitle: Note 1\ndate: '2026-08-01'\nfolders: ['folder_a']\n---\n\n"
                "## Summary\nFirst note summary.\n\n## Transcript\nFirst transcript line.",
                encoding="utf-8"
            )
            n2 = out_dir / "note2_summary.md"
            n2.write_text(
                "---\ntitle: Note 2\ndate: '2026-08-02'\nfolders: ['folder_b']\n---\n\n"
                "## Summary\nSecond note summary.\n\n## Transcript\nSecond transcript line.",
                encoding="utf-8"
            )
            n3 = out_dir / "note3_summary.md"
            n3.write_text(
                "---\ntitle: Note 3\ndate: '2026-08-03'\nfolders: ['folder_a']\n---\n\n"
                "## Summary\nThird note summary.\n\n## Transcript\nThird transcript line.",
                encoding="utf-8"
            )

            # Mock OllamaSummarizer
            captured_corpus = []

            class _FakeSummarizer:
                def query_transcript_streaming(self, corpus, question, language="en"):
                    captured_corpus.append(corpus)
                    yield "Answer to " + question

            with patch("src.config.get_config", return_value=cfg), \
                 patch("src.config.get_data_dirs", return_value={"output": out_dir, "transcripts": tmp}), \
                 patch("simple_recorder.OllamaSummarizer", return_value=_FakeSummarizer()):

                runner = CliRunner()
                # Query with --meeting specifying note1 and note2, but with --folder folder_a
                # Note 2 is not in folder_a, but because --meeting is provided, --folder is ignored!
                res = runner.invoke(
                    chat_global_streaming,
                    ["-q", "Tell me about notes", "--meeting", str(n1), "--meeting", str(n2), "--folder", "folder_a"]
                )
                self.assertEqual(res.exit_code, 0)
                self.assertTrue(len(captured_corpus) > 0)
                corpus = captured_corpus[0]
                self.assertIn("Note 1", corpus)
                self.assertIn("Note 2", corpus)
                self.assertNotIn("Note 3", corpus)
                self.assertIn("Transcript excerpt:", corpus)

    def test_meeting_skips_unreadable_or_missing_paths(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            out_dir = tmp / "output"
            out_dir.mkdir(parents=True, exist_ok=True)
            cfg_path = tmp / "config.json"
            cfg = Config(config_path=cfg_path)
            cfg._config["ai_provider"] = "cloud"
            cfg._config["cloud_model"] = "gpt-4o"
            cfg._save()

            n1 = out_dir / "valid_summary.md"
            n1.write_text(
                "---\ntitle: Valid Note\ndate: '2026-08-01'\n---\n\n"
                "## Summary\nValid summary.\n\n## Transcript\nValid transcript.",
                encoding="utf-8"
            )
            missing = out_dir / "missing_summary.md"

            captured_corpus = []

            class _FakeSummarizer:
                def query_transcript_streaming(self, corpus, question, language="en"):
                    captured_corpus.append(corpus)
                    yield "Done"

            with patch("src.config.get_config", return_value=cfg), \
                 patch("src.config.get_data_dirs", return_value={"output": out_dir, "transcripts": tmp}), \
                 patch("simple_recorder.OllamaSummarizer", return_value=_FakeSummarizer()):

                runner = CliRunner()
                res = runner.invoke(
                    chat_global_streaming,
                    ["-q", "Valid test", "--meeting", str(n1), "--meeting", str(missing)]
                )
                self.assertEqual(res.exit_code, 0)
                self.assertTrue(len(captured_corpus) > 0)
                self.assertIn("Valid Note", captured_corpus[0])


if __name__ == "__main__":
    unittest.main()

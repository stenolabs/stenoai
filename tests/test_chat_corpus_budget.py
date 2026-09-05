"""Tests for the cross-note chat corpus budget (_chat_corpus_char_budget).

The budget caps how much note context is assembled for cross-note chat. Cloud/
adapter get a generous fixed budget; local/remote are sized to the model's
num_ctx so a smaller local window answers over fewer recent notes rather than
overflowing (WS3). Pure function — no notes or model needed.
"""

import unittest
from unittest import mock

from simple_recorder import _chat_corpus_char_budget
from src.summarizer import resolve_num_ctx


class ChatCorpusBudgetTests(unittest.TestCase):
    def test_cloud_and_adapter_use_the_generous_fixed_budget(self):
        self.assertEqual(_chat_corpus_char_budget("cloud", "gpt-4o"), 400_000)
        self.assertEqual(_chat_corpus_char_budget("adapter", "adapter (org)"), 400_000)

    def test_local_budget_is_derived_from_the_model_window(self):
        expected = int(resolve_num_ctx("gemma4:e2b-it-qat") * 3.5 * 0.55)
        self.assertEqual(_chat_corpus_char_budget("local", "gemma4:e2b-it-qat"), expected)

    def test_remote_is_sized_like_local(self):
        self.assertEqual(
            _chat_corpus_char_budget("remote", "gemma4:e2b-it-qat"),
            _chat_corpus_char_budget("local", "gemma4:e2b-it-qat"),
        )

    def test_local_budget_is_smaller_than_cloud(self):
        # The whole point: a local window must not be handed the cloud-sized
        # corpus, or it would overflow.
        local = _chat_corpus_char_budget("local", "gemma4:e2b-it-qat")
        cloud = _chat_corpus_char_budget("cloud", "gpt-4o")
        self.assertLess(local, cloud)
        self.assertGreater(local, 0)

    def test_unknown_local_model_still_gets_a_sane_budget(self):
        budget = _chat_corpus_char_budget("local", "some-future-model:7b")
        # Falls back to the default num_ctx → a positive, sub-cloud budget.
        self.assertGreater(budget, 0)
        self.assertLess(budget, 400_000)

class AppleSupportedWindowTests(unittest.TestCase):
    """A newer model's measured capacity must not break supported macOS 26."""

    def test_window_uses_the_documented_4k_fallback(self):
        from src.apple_lm import APPLE_LM_NUM_CTX

        self.assertEqual(APPLE_LM_NUM_CTX, 4096)
        self.assertEqual(resolve_num_ctx("apple:system"), 4096)

    def test_apple_corpus_budget_reserves_space_for_prompt_and_response(self):
        budget = _chat_corpus_char_budget("local", "apple:system")
        self.assertEqual(budget, int(4096 * 3.5 * 0.55))

    def test_apple_input_budget_reserves_a_response_in_the_4k_window(self):
        from src.summarizer import OllamaSummarizer, _APPLE_RESPONSE_RESERVE_CHARS

        s = OllamaSummarizer.__new__(OllamaSummarizer)
        s.model_name = "apple:system"
        self.assertGreater(s._apple_input_budget_chars(), 0)
        self.assertLessEqual(
            s._apple_input_budget_chars() + _APPLE_RESPONSE_RESERVE_CHARS,
            4096 * 2,
        )

    def test_meeting_that_fitted_the_beta_budget_is_rejected_without_model_calls(self):
        from src.summarizer import OllamaSummarizer

        s = OllamaSummarizer.__new__(OllamaSummarizer)
        s.model_name = "apple:system"
        s.ai_provider = "local"
        s._stream_completion = mock.Mock()
        with self.assertRaisesRegex(ValueError, "only short transcripts"):
            list(s.summarize_transcript_streaming("meeting text " * 500))
        s._stream_completion.assert_not_called()

    def test_query_trims_the_assembled_corpus_to_the_supported_input_budget(self):
        from src.summarizer import OllamaSummarizer, _APPLE_RESPONSE_RESERVE_CHARS

        s = OllamaSummarizer.__new__(OllamaSummarizer)
        s.model_name = "apple:system"
        corpus = "H" + "X" * 7882 + "T"
        prompt = s._build_bounded_apple_query_prompt(corpus, "What changed?")
        self.assertNotIn(corpus, prompt)
        self.assertLessEqual(len(prompt) + _APPLE_RESPONSE_RESERVE_CHARS, 4096 * 2)


if __name__ == "__main__":
    unittest.main()

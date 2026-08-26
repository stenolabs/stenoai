"""Tests for the cross-note chat corpus budget (_chat_corpus_char_budget).

The budget caps how much note context is assembled for cross-note chat. Cloud/
adapter get a generous fixed budget; local/remote are sized to the model's
num_ctx so a smaller local window answers over fewer recent notes rather than
overflowing (WS3). Pure function — no notes or model needed.
"""

import unittest

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


if __name__ == "__main__":
    unittest.main()


class AppleWindowMeasuredCeilingTests(unittest.TestCase):
    """Pins the Apple on-device window against what the hardware actually does.

    APPLE_LM_NUM_CTX only sizes OUR prompt budgets, so nothing fails loudly if
    it drifts — it shipped at 4096, which silently halved every Apple budget and
    no test noticed, because every other test derives from the constant instead
    of pinning it.

    The numbers below come from feeding needle-in-filler prompts straight at the
    sidecar on AFM 3 Core Advanced / macOS 27: clean answers with the needle
    recovered through ~37.9k chars, hard refusal from ~40.0k. These assertions
    encode both halves of that: the window must not shrink back, and the largest
    derived budget must stay well under the measured cliff.
    """

    MEASURED_CLIFF_CHARS = 40_000
    MEASURED_LAST_GOOD_CHARS = 37_900

    def test_window_is_the_measured_8k_not_the_old_4k(self):
        from src.apple_lm import APPLE_LM_NUM_CTX

        self.assertEqual(APPLE_LM_NUM_CTX, 8192)
        self.assertEqual(resolve_num_ctx("apple:system"), 8192)

    def test_apple_corpus_budget_is_bigger_than_the_old_4k_figure(self):
        budget = _chat_corpus_char_budget("local", "apple:system")
        # The 4096 window produced 7884 chars; anything at or below that means
        # the regression is back.
        self.assertGreater(budget, 7884 * 1.5)

    def test_apple_budget_stays_under_the_measured_cliff(self):
        budget = _chat_corpus_char_budget("local", "apple:system")
        # Half the last-known-good size is the margin: the prompt also carries
        # scaffolding, the question, and the model's own answer.
        self.assertLess(budget, self.MEASURED_LAST_GOOD_CHARS / 2)
        self.assertLess(budget, self.MEASURED_CLIFF_CHARS)

    def test_apple_snapshot_slice_budget_grew_with_the_window(self):
        from src.summarizer import OllamaSummarizer

        s = OllamaSummarizer.__new__(OllamaSummarizer)
        s.model_name = "apple:system"
        # The 4096 window produced 3292 chars per slice.
        self.assertGreater(s._snapshot_slice_budget_chars(), 3292 * 2)


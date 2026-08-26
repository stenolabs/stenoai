import unittest
from types import SimpleNamespace

from src._parakeet_mlx import _result_to_dict


class ParakeetMlxResultContractTests(unittest.TestCase):
    def test_sentence_and_token_attributes_survive_result_conversion(self):
        result = SimpleNamespace(
            text="Hello world.",
            sentences=[
                SimpleNamespace(
                    text=" Hello world. ",
                    start=1.25,
                    end=2.75,
                    tokens=[
                        SimpleNamespace(text="Hello", start=1.25, end=1.7),
                        SimpleNamespace(text=" world", start=1.7, end=2.4),
                        SimpleNamespace(text=".", start=2.4, end=2.75),
                    ],
                ),
            ],
        )

        converted = _result_to_dict(result, "de")

        self.assertEqual(converted["text"], "Hello world.")
        self.assertEqual(converted["duration_seconds"], 2.75)
        self.assertEqual(converted["detected_language"], "de")
        self.assertEqual(converted["segments"], [{
            "text": "Hello world.",
            "start": 1.25,
            "end": 2.75,
            "tokens": [
                {"text": "Hello", "start": 1.25, "end": 1.7},
                {"text": " world", "start": 1.7, "end": 2.4},
                {"text": ".", "start": 2.4, "end": 2.75},
            ],
        }])

    def test_empty_sentence_text_is_ignored_without_losing_valid_merged_sentences(self):
        result = SimpleNamespace(
            text="Valid tail.",
            sentences=[
                SimpleNamespace(text=" ", start=0.0, end=1.0, tokens=[]),
                SimpleNamespace(
                    text="Valid tail.",
                    start=60.0,
                    end=61.0,
                    tokens=[SimpleNamespace(text="Valid tail.", start=60.0, end=61.0)],
                ),
            ],
        )

        converted = _result_to_dict(result, "auto")

        self.assertEqual(len(converted["segments"]), 1)
        self.assertEqual(converted["segments"][0]["start"], 60.0)
        self.assertIsNone(converted["detected_language"])


if __name__ == "__main__":
    unittest.main()

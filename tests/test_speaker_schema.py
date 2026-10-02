import math
import unittest

from src.speaker_schema import validate_display_name, validate_embedding, validate_meeting_stem
from src.speaker_suggestions import speakers_sidecar_path, write_speakers_sidecar
from src.voiceprint import cosine_distance


class SpeakerSchemaTests(unittest.TestCase):
    def test_meeting_stem_accepts_one_basename_and_rejects_traversal(self):
        self.assertEqual(validate_meeting_stem("2026-08-10_team-call"), "2026-08-10_team-call")
        for value in ("", ".", "..", "../meeting", "folder/meeting", "folder\\meeting", None, 42):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    validate_meeting_stem(value)

    def test_embedding_requires_exactly_256_finite_nonzero_numbers(self):
        invalid = (
            [],
            [1.0],
            [0.0] * 256,
            [math.nan] * 256,
            [math.inf] * 256,
            ["not-a-number"] * 256,
            [10**10000] * 256,
        )
        for value in invalid:
            with self.subTest(kind=type(value[0]).__name__ if value else "empty"):
                with self.assertRaises(ValueError):
                    validate_embedding(value)

        valid = validate_embedding([1.0] + [0.0] * 255)
        self.assertEqual(len(valid), 256)
        self.assertTrue(all(isinstance(value, float) for value in valid))

    def test_display_name_is_trimmed_and_cannot_break_transcript_markers(self):
        self.assertEqual(validate_display_name("  Alice Example  "), "Alice Example")
        self.assertEqual(validate_display_name(" Person\nAlpha "), "Person Alpha")
        self.assertEqual(validate_display_name("Ｐｅｒｓｏｎ"), "Person")
        for value in ("", "   ", "Alice] [Others", "[Alice", "Person\x00Alpha", None, 42):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    validate_display_name(value)

    def test_display_name_rejects_reserved_self_label(self):
        for value in ("You", " you ", "Ｙｏｕ"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_display_name(value)

    def test_sidecar_path_rejects_a_stem_outside_the_output_directory(self):
        with self.assertRaises(ValueError):
            speakers_sidecar_path(self.temp_dir, "../private")

    def test_sidecar_writer_rejects_unknown_channels(self):
        with self.assertRaises(ValueError):
            write_speakers_sidecar(
                self.temp_dir,
                "meeting",
                {"left": {"recording_type": "unknown", "clusters": {}}},
            )

    def test_distance_rejects_mismatched_or_malformed_vectors(self):
        for left, right in (
            ([1.0], [1.0, 0.0]),
            ([math.nan, 0.0], [1.0, 0.0]),
            (["bad", 0.0], [1.0, 0.0]),
        ):
            with self.subTest(left=left, right=right):
                with self.assertRaises(ValueError):
                    cosine_distance(left, right)

    def setUp(self):
        from pathlib import Path
        import tempfile

        self._temporary_directory = tempfile.TemporaryDirectory()
        self.temp_dir = Path(self._temporary_directory.name)

    def tearDown(self):
        self._temporary_directory.cleanup()


if __name__ == "__main__":
    unittest.main()

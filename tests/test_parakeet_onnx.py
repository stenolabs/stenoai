"""Coverage for the ONNX Parakeet backend's pure helpers.

We don't (and can't) exercise the actual onnx-asr session here — that
needs the 670 MB int8 encoder weights on disk and onnxruntime installed.
What we do verify is the bookkeeping that sits around the model call:
token-to-sentence grouping (the only piece of logic that diverges from
the MLX path and that we wrote by hand), timestamp shape normalisation,
and the empty-result envelope. Those bugs would silently corrupt the
batch transcript shape if they regressed.
"""
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from src import _parakeet_onnx as onnx_backend


class GroupTokensIntoSentencesTests(unittest.TestCase):
    def test_groups_multiple_sentences_on_punctuation(self):
        tokens = ["Hello", " world", ".", " How", " are", " you", "?", " Fine"]
        timestamps = [
            (0.0, 0.5),
            (0.5, 1.0),
            (1.0, 1.1),
            (1.5, 1.8),
            (1.8, 2.0),
            (2.0, 2.3),
            (2.3, 2.4),
            (2.5, 2.8),
        ]
        segments = onnx_backend._group_tokens_into_sentences(tokens, timestamps)
        self.assertEqual(len(segments), 3)
        self.assertEqual(segments[0]["text"], "Hello world.")
        self.assertAlmostEqual(segments[0]["start"], 0.0)
        self.assertAlmostEqual(segments[0]["end"], 1.1)
        self.assertEqual(segments[1]["text"], "How are you?")
        self.assertAlmostEqual(segments[1]["start"], 1.5)
        self.assertAlmostEqual(segments[1]["end"], 2.4)
        # Tail tokens with no sentence-ending punctuation still become a segment
        # rather than being silently dropped.
        self.assertEqual(segments[2]["text"], "Fine")
        self.assertAlmostEqual(segments[2]["start"], 2.5)
        self.assertAlmostEqual(segments[2]["end"], 2.8)

    def test_single_sentence_no_terminator_returns_one_segment(self):
        tokens = ["hello", " world"]
        timestamps = [(0.0, 0.5), (0.5, 1.0)]
        segments = onnx_backend._group_tokens_into_sentences(tokens, timestamps)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "hello world")
        self.assertAlmostEqual(segments[0]["start"], 0.0)
        self.assertAlmostEqual(segments[0]["end"], 1.0)

    def test_mismatched_lengths_fall_back_to_single_segment(self):
        # The defensive branch: if a future onnx-asr release inserts a
        # leading <eos> token without a paired timestamp we should still
        # surface the transcript rather than dropping the utterance.
        tokens = ["hello", " world"]
        timestamps = [(0.0, 1.0)]  # length mismatch
        segments = onnx_backend._group_tokens_into_sentences(tokens, timestamps)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "hello world")
        # Whole-utterance bounds derived from the single timestamp pair.
        self.assertAlmostEqual(segments[0]["start"], 0.0)
        self.assertAlmostEqual(segments[0]["end"], 1.0)

    def test_empty_tokens_returns_empty_segments(self):
        self.assertEqual(onnx_backend._group_tokens_into_sentences([], []), [])
        self.assertEqual(onnx_backend._group_tokens_into_sentences([], [(0.0, 1.0)]), [])

    def test_whitespace_only_tokens_are_skipped(self):
        # tok_str is appended but empty-string tokens skip the loop body
        # entirely, so a leading "" token shouldn't drag the start time
        # backward to 0.0.
        tokens = ["", "Real", " text", "."]
        timestamps = [(0.0, 0.0), (1.0, 1.3), (1.3, 1.6), (1.6, 1.7)]
        segments = onnx_backend._group_tokens_into_sentences(tokens, timestamps)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "Real text.")
        # Start must come from the first non-empty token, not the skipped "".
        self.assertAlmostEqual(segments[0]["start"], 1.0)


class TimestampShapeNormalisationTests(unittest.TestCase):
    """The helpers tolerate three timestamp shapes (tuple/list, dict, object)
    so a minor onnx-asr API shift doesn't crash the live path. These cover
    each branch."""

    def test_tuple_shape(self):
        self.assertAlmostEqual(onnx_backend._ts_start((1.5, 2.5)), 1.5)
        self.assertAlmostEqual(onnx_backend._ts_end((1.5, 2.5)), 2.5)

    def test_list_shape(self):
        self.assertAlmostEqual(onnx_backend._ts_start([1.5, 2.5]), 1.5)
        self.assertAlmostEqual(onnx_backend._ts_end([1.5, 2.5]), 2.5)

    def test_dict_shape(self):
        self.assertAlmostEqual(onnx_backend._ts_start({"start": 1.5, "end": 2.5}), 1.5)
        self.assertAlmostEqual(onnx_backend._ts_end({"start": 1.5, "end": 2.5}), 2.5)

    def test_object_shape(self):
        class TS:
            def __init__(self, start: float, end: float) -> None:
                self.start = start
                self.end = end

        ts = TS(1.5, 2.5)
        self.assertAlmostEqual(onnx_backend._ts_start(ts), 1.5)
        self.assertAlmostEqual(onnx_backend._ts_end(ts), 2.5)

    def test_dict_end_falls_back_to_start_when_missing(self):
        # Some onnx-asr versions emit timestamps with only `start` populated
        # for the final boundary marker. Fall back to start so we don't
        # produce a 0.0 end time that segments would treat as "before start".
        self.assertAlmostEqual(
            onnx_backend._ts_end({"start": 3.0}),
            3.0,
        )


class ExtractTextTests(unittest.TestCase):
    def test_bare_string(self):
        self.assertEqual(onnx_backend._extract_text("  hello  "), "hello")

    def test_object_with_text_attribute(self):
        class R:
            text = "  world  "

        self.assertEqual(onnx_backend._extract_text(R()), "world")

    def test_object_without_text_returns_empty(self):
        class R:
            pass

        self.assertEqual(onnx_backend._extract_text(R()), "")

    def test_object_with_non_string_text_returns_empty(self):
        # Defensive — if a future onnx-asr release types `.text` as bytes or
        # None on empty utterances, we don't want to crash with AttributeError
        # on .strip().
        class R:
            text = None

        self.assertEqual(onnx_backend._extract_text(R()), "")


class EmptyResultEnvelopeTests(unittest.TestCase):
    """Locks the exact dict shape that the rest of the pipeline (transcriber,
    summariser, IPC) reads. A typo here would silently regress diarisation
    and downstream callers."""

    def test_empty_result_shape(self):
        result = onnx_backend._empty_result()
        self.assertEqual(set(result.keys()), {
            "text",
            "segments",
            "duration_seconds",
            "detected_language",
            "detected_language_probability",
        })
        self.assertIsNone(result["text"])
        self.assertEqual(result["segments"], [])
        self.assertIsNone(result["duration_seconds"])


class _FakeTsModel:
    """Drives ``_transcribe_windows`` with a scripted token stream per window.

    Each ``recognize`` call returns the next ``(tokens, local_timestamps)``
    entry as a result object with ``.text`` / ``.tokens`` / ``.timestamps``,
    so the offset + overlap-dedup bookkeeping can be exercised without
    onnxruntime. A ``RuntimeError`` entry simulates a window that crashes.
    """

    def __init__(self, per_window):
        self.per_window = per_window
        self.calls = 0

    def recognize(self, window, sample_rate=None):
        entry = self.per_window[self.calls]
        self.calls += 1
        if isinstance(entry, Exception):
            raise entry
        tokens, timestamps = entry
        return SimpleNamespace(
            text="".join(tokens),
            tokens=list(tokens),
            timestamps=list(timestamps),
        )


class TranscribeWindowsMergeTests(unittest.TestCase):
    """The manual long-file windowing is the ONNX-only piece that can't run
    on this Mac (no onnxruntime), so its offset/dedupe math is pinned here in
    pure Python. 80 s of samples at 16 kHz → exactly two 60 s windows stepping
    by 45 s, overlapping on [45 s, 60 s]."""

    def _eighty_seconds(self):
        return np.zeros(80 * onnx_backend._SAMPLE_RATE, dtype=np.float32)

    def test_offsets_and_dedupes_overlap(self):
        # Window 0 covers 0–60 s; "Foo." sits at 50 s, inside the overlap.
        # Window 1 (offset 45 s) re-emits "Foo." at local 5 s (= global 50 s)
        # and adds "Bar." at local 20 s (= global 65 s).
        model = _FakeTsModel([
            (["Hello", " world.", " Foo."], [(0.0, 0.5), (1.0, 1.5), (50.0, 50.5)]),
            ([" Foo.", " Bar."], [(5.0, 5.5), (20.0, 20.5)]),
        ])
        merged = onnx_backend._transcribe_windows(model, self._eighty_seconds())

        self.assertIsInstance(merged, onnx_backend._SimpleResult)
        # The duplicated "Foo." in the overlap region is dropped — one copy only.
        self.assertEqual(merged.tokens.count(" Foo."), 1)
        # Global timestamps are offset and non-decreasing.
        starts = [onnx_backend._ts_start(ts) for ts in merged.timestamps]
        self.assertEqual(starts, sorted(starts))
        # "Bar." landed at global 65 s (45 s window offset + 20 s local).
        self.assertEqual(merged.tokens[-1], " Bar.")
        self.assertAlmostEqual(onnx_backend._ts_start(merged.timestamps[-1]), 65.0)
        # Through the normal shaping path the text is whole and ordered.
        out = onnx_backend._result_to_dict(merged, language=None)
        self.assertEqual(out["text"], "Hello world. Foo. Bar.")

    def test_failed_window_is_skipped_not_fatal(self):
        # Window 1 crashes; window 0's tokens must still survive.
        model = _FakeTsModel([
            (["Hello", " world."], [(0.0, 0.5), (1.0, 1.5)]),
            RuntimeError("onnx blew up on this window"),
        ])
        merged = onnx_backend._transcribe_windows(model, self._eighty_seconds())
        self.assertEqual(merged.tokens, ["Hello", " world."])

    def test_a_skipped_window_is_reported_not_just_swallowed(self):
        # Skipping the window keeps the meeting alive, but the transcript now
        # covers less audio than the recording holds. Downstream has to be
        # able to see that -- silently handing back a short transcript is how
        # a half-read file used to beat a complete live transcript.
        model = _FakeTsModel([
            (["Hello", " world."], [(0.0, 0.5), (1.0, 1.5)]),
            RuntimeError("onnx blew up on this window"),
        ])
        merged = onnx_backend._transcribe_windows(model, self._eighty_seconds())
        self.assertEqual(merged.windows_attempted, 2)
        self.assertEqual(merged.windows_recognized, 1)
        self.assertEqual(onnx_backend._result_to_dict(merged, language=None)["window_coverage"], 60 / 80)

    def test_misaligned_tokens_and_timestamps_do_not_count_as_recognized(self):
        model = _FakeTsModel([
            (["broken", " window"], [(0.0, 0.5)]),
            (["Valid."], [(20.0, 20.5)]),
        ])

        merged = onnx_backend._transcribe_windows(model, self._eighty_seconds())

        self.assertEqual(merged.tokens, ["Valid."])
        self.assertEqual(merged.windows_attempted, 2)
        self.assertEqual(merged.windows_recognized, 1)
        self.assertEqual(onnx_backend._result_to_dict(merged, language=None)["window_coverage"], 35 / 80)

    def test_short_tail_does_not_weigh_as_much_as_first_window(self):
        samples = np.zeros(61 * onnx_backend._SAMPLE_RATE, dtype=np.float32)
        valid = (["Words."], [(0.0, 0.5)])
        for responses, expected in [
            ([RuntimeError("failed"), valid], 16 / 61),
            ([valid, RuntimeError("failed")], 60 / 61),
        ]:
            with self.subTest(expected=expected):
                merged = onnx_backend._transcribe_windows(_FakeTsModel(responses), samples)
                coverage = onnx_backend._result_to_dict(merged, language=None)["window_coverage"]
                self.assertAlmostEqual(coverage, expected)

    def test_middle_gap_is_excluded_and_overlap_counted_once(self):
        samples = np.zeros(180 * onnx_backend._SAMPLE_RATE, dtype=np.float32)
        valid = (["Words."], [(0.0, 0.5)])
        merged = onnx_backend._transcribe_windows(
            _FakeTsModel([valid, RuntimeError("failed"), valid, valid]), samples,
        )
        self.assertEqual(merged.covered_seconds, 150)
        self.assertAlmostEqual(
            onnx_backend._result_to_dict(merged, language=None)["window_coverage"], 150 / 180,
        )

    def test_all_malformed_windows_still_raise(self):
        invalid = (["missing timestamp"], [])
        with self.assertRaisesRegex(RuntimeError, "all 2 ONNX transcription windows failed"):
            onnx_backend._transcribe_windows(_FakeTsModel([invalid, invalid]), self._eighty_seconds())

    def test_warning_counts_only_usable_windows_and_uncovered_audio(self):
        model = _FakeTsModel([(["broken"], []), (["Valid."], [(0.0, 0.5)])])
        with self.assertLogs(onnx_backend.logger, level="WARNING") as logs:
            onnx_backend._transcribe_windows(model, self._eighty_seconds())
        self.assertIn("read 35s of 80s (1 of 2 windows usable)", logs.output[-1])
        self.assertIn("missing roughly 45s", logs.output[-1])

    def test_a_clean_run_reports_full_coverage(self):
        model = _FakeTsModel([
            (["Hello", " world."], [(0.0, 0.5), (1.0, 1.5)]),
            ([" Bar."], [(20.0, 20.5)]),
        ])
        merged = onnx_backend._transcribe_windows(model, self._eighty_seconds())
        self.assertEqual(merged.windows_attempted, merged.windows_recognized)
        self.assertEqual(onnx_backend._result_to_dict(merged, language=None)["window_coverage"], 1.0)

    def test_a_result_that_never_windowed_reports_unknown_not_complete(self):
        # onnx-asr's own TimestampedResult carries no counters. That must read
        # as "no figure available", never as a clean bill of health.
        class _Plain:
            text = "Hello world."
            tokens = ["Hello", " world."]
            timestamps = [(0.0, 0.5), (1.0, 1.5)]

        self.assertIsNone(onnx_backend._result_to_dict(_Plain(), language=None)["window_coverage"])

    def test_all_windows_failing_raises_not_empty(self):
        # A broken model/session where EVERY window raises is a real failure,
        # not silence — _transcribe_windows must raise so the caller marks it
        # transcription_failed rather than returning an empty (silent) result.
        model = _FakeTsModel([
            RuntimeError("window 0 dead"),
            RuntimeError("window 1 dead"),
            RuntimeError("window 2 dead"),
            RuntimeError("window 3 dead"),
            RuntimeError("window 4 dead"),
            RuntimeError("window 5 dead"),
        ])
        with self.assertRaises(RuntimeError):
            onnx_backend._transcribe_windows(model, self._eighty_seconds())

    def test_mismatched_window_tokens_skipped(self):
        # A window whose tokens/timestamps lengths disagree is dropped cleanly
        # rather than emitting corrupt global timestamps.
        model = _FakeTsModel([
            (["Hello", " world."], [(0.0, 0.5), (1.0, 1.5)]),
            ([" Tail.", " Extra."], [(5.0, 5.5)]),  # 2 tokens, 1 timestamp
        ])
        merged = onnx_backend._transcribe_windows(model, self._eighty_seconds())
        self.assertEqual(merged.tokens, ["Hello", " world."])


class TranscribeWindowsHeartbeatTests(unittest.TestCase):
    """Per-window heartbeat: the liveness signal the Electron inactivity
    watchdog relies on. One emit per recognized window, ``done`` strictly
    increasing, failed windows emit nothing."""

    def setUp(self):
        from src import _heartbeat
        self.beats = []
        _heartbeat.set_chunk_heartbeat(lambda done, total: self.beats.append((done, total)))
        self.addCleanup(_heartbeat.set_chunk_heartbeat, None)

    def _eighty_seconds(self):
        return np.zeros(80 * onnx_backend._SAMPLE_RATE, dtype=np.float32)

    def test_heartbeat_fires_once_per_window_with_increasing_done(self):
        model = _FakeTsModel([
            (["Hello."], [(0.0, 0.5)]),
            ([" World."], [(20.0, 20.5)]),
        ])
        onnx_backend._transcribe_windows(model, self._eighty_seconds())
        # 80 s at 16 kHz → two 60 s windows stepping by 45 s.
        self.assertEqual(self.beats, [(1, 2), (2, 2)])

    def test_failed_window_emits_no_heartbeat(self):
        model = _FakeTsModel([
            RuntimeError("window 0 dead"),
            ([" World."], [(20.0, 20.5)]),
        ])
        onnx_backend._transcribe_windows(model, self._eighty_seconds())
        self.assertEqual(self.beats, [(2, 2)])

    def test_malformed_result_still_emits_liveness_heartbeat(self):
        model = _FakeTsModel([
            (["broken", "window"], [(0.0, 0.5)]),
            (["Valid."], [(20.0, 20.5)]),
        ])
        onnx_backend._transcribe_windows(model, self._eighty_seconds())
        self.assertEqual(self.beats, [(1, 2), (2, 2)])


class LoadWav16kMonoTests(unittest.TestCase):
    def _write_wav(self, path, samples_int16, n_channels, framerate):
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(n_channels)
            wf.setsampwidth(2)
            wf.setframerate(framerate)
            wf.writeframes(samples_int16.tobytes())

    def test_loads_16k_mono(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "mono.wav"
            data = np.array([0, 16384, -16384, 32767], dtype=np.int16)
            self._write_wav(path, data, n_channels=1, framerate=16000)
            out = onnx_backend._load_wav_16k_mono(path)
        self.assertEqual(out.shape[0], 4)
        self.assertAlmostEqual(float(out[1]), 0.5, places=3)

    def test_downmixes_stereo_to_mono(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "stereo.wav"
            # Two frames: L/R = (16384, 0) then (0, 16384) — each averages to ~0.25.
            data = np.array([16384, 0, 0, 16384], dtype=np.int16)
            self._write_wav(path, data, n_channels=2, framerate=16000)
            out = onnx_backend._load_wav_16k_mono(path)
        self.assertEqual(out.shape[0], 2)
        self.assertAlmostEqual(float(out[0]), 0.25, places=3)
        self.assertAlmostEqual(float(out[1]), 0.25, places=3)

    def test_unexpected_samplerate_returns_none(self):
        # A non-16 kHz header signals the path-based fallback in transcribe_file.
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "hi.wav"
            data = np.zeros(8, dtype=np.int16)
            self._write_wav(path, data, n_channels=1, framerate=44100)
            self.assertIsNone(onnx_backend._load_wav_16k_mono(path))


if __name__ == "__main__":
    unittest.main()

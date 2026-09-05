import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import src.speaker_suggestions as speaker_suggestions
from src.speaker_sidecar_store import SpeakerSidecarStore, StaleDiarizationRun
from src.speaker_suggestions import record_original_labels, write_sidecar_document, write_speakers_sidecar


class SpeakerSidecarStoreTests(unittest.TestCase):
    def setUp(self):
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.output_dir = Path(self._temporary_directory.name)
        self.store = SpeakerSidecarStore(self.output_dir)
        self.path = self.output_dir / "meeting_speakers.json"
        self.path.write_text(json.dumps({
            "meeting_id": "meeting",
            "diarization_run": {"run_id": "current-run"},
            "channels": {
                "mic": {
                    "clusters": {
                        "SPEAKER_0": {},
                        "SPEAKER_1": {},
                    },
                },
            },
        }))

    def tearDown(self):
        self._temporary_directory.cleanup()

    def test_mutation_rejects_a_stale_diarization_run(self):
        with self.assertRaises(StaleDiarizationRun):
            self.store.mutate("meeting", "old-run", lambda document: document)

    def test_two_locked_mutations_preserve_both_cluster_updates(self):
        barrier = threading.Barrier(2)

        def update(speaker_id, key, value):
            barrier.wait()

            def mutation(document):
                document["channels"]["mic"]["clusters"][speaker_id][key] = value

            self.store.mutate("meeting", "current-run", mutation)

        first = threading.Thread(
            target=update,
            args=("SPEAKER_0", "contains_multiple_speakers", True),
        )
        second = threading.Thread(
            target=update,
            args=("SPEAKER_1", "review_state", "generic"),
        )
        first.start()
        second.start()
        first.join()
        second.join()

        document = self.store.read("meeting")
        clusters = document["channels"]["mic"]["clusters"]
        self.assertTrue(clusters["SPEAKER_0"]["contains_multiple_speakers"])
        self.assertEqual(clusters["SPEAKER_1"]["review_state"], "generic")

    def test_missing_run_is_rejected_when_an_expected_run_is_supplied(self):
        document = json.loads(self.path.read_text())
        document.pop("diarization_run")
        self.path.write_text(json.dumps(document))
        with self.assertRaises(StaleDiarizationRun):
            self.store.mutate("meeting", "current-run", lambda value: value)

    def test_structurally_invalid_document_is_rejected_before_mutation(self):
        self.path.write_text("[]")
        called = False

        def mutation(_document):
            nonlocal called
            called = True

        with self.assertRaises(ValueError):
            self.store.mutate("meeting", None, mutation)
        self.assertFalse(called)

    def test_fresh_diarization_writer_uses_the_same_lock_as_review_mutations(self):
        started = threading.Event()
        finished = threading.Event()

        def replace_analysis():
            started.set()
            write_speakers_sidecar(
                self.output_dir,
                "meeting",
                {"mic": {"recording_type": "in_person", "clusters": {}}},
            )
            finished.set()

        with self.store.lock("meeting"):
            worker = threading.Thread(target=replace_analysis)
            worker.start()
            self.assertTrue(started.wait(timeout=1.0))
            time.sleep(0.05)
            self.assertFalse(finished.is_set())
        worker.join(timeout=2.0)

        self.assertTrue(finished.is_set())
        self.assertNotEqual(
            self.store.read("meeting")["diarization_run"]["run_id"],
            "current-run",
        )

    def test_lock_filename_does_not_retain_the_meeting_stem(self):
        lock_path = self.store.lock_path("Private board meeting")

        self.assertNotIn("Private board meeting", lock_path.name)
        self.assertRegex(lock_path.name, r"^\.speaker-[0-9a-f]{64}\.lock$")

    def test_original_label_recording_locks_before_reading(self):
        document = json.loads(self.path.read_text())
        document["transcript_lines"] = [{
            "start": 1.0,
            "channel": "mic",
            "diarization_speaker_id": "SPEAKER_0",
        }]
        self.path.write_text(json.dumps(document))
        transcript = self.output_dir / "meeting_transcript.txt"
        transcript.write_text("[00:01] [You] Hello")
        worker_read = threading.Event()
        original_read = speaker_suggestions.read_speakers_sidecar

        def observed_read(*args, **kwargs):
            if threading.current_thread().name == "record-original-labels":
                worker_read.set()
            return original_read(*args, **kwargs)

        with mock.patch.object(
            speaker_suggestions, "read_speakers_sidecar", side_effect=observed_read,
        ), self.store.lock("meeting"):
            worker = threading.Thread(
                name="record-original-labels",
                target=record_original_labels,
                args=(self.output_dir, "meeting", transcript, {("mic", "SPEAKER_0")}),
            )
            worker.start()
            time.sleep(0.05)
            self.assertFalse(worker_read.is_set())
            latest = self.store.read("meeting")
            latest["channels"]["mic"]["clusters"]["SPEAKER_1"]["review_state"] = "generic"
            write_sidecar_document(
                self.output_dir, "meeting", latest, acquire_lock=False,
            )
        worker.join(timeout=2.0)

        self.assertFalse(worker.is_alive())
        stored = self.store.read("meeting")
        self.assertEqual(stored["transcript_lines"][0]["original_label"], "You")
        self.assertEqual(
            stored["channels"]["mic"]["clusters"]["SPEAKER_1"]["review_state"],
            "generic",
        )

    def test_legacy_run_token_ignores_review_metadata_but_tracks_acoustic_data(self):
        document = json.loads(self.path.read_text())
        document.pop("diarization_run")
        self.path.write_text(json.dumps(document))

        token = self.store.run_token(document)
        self.assertRegex(token, r"^legacy-[0-9a-f]{64}$")
        self.assertEqual(token, self.store.run_token(self.store.read("meeting")))

        self.store.mutate(
            "meeting",
            token,
            lambda value: value["channels"]["mic"]["clusters"]["SPEAKER_0"].update(
                {"review_state": "generic"},
            ),
        )
        self.store.mutate("meeting", token, lambda value: value)

        replaced = self.store.read("meeting")
        replaced["channels"]["mic"]["clusters"]["SPEAKER_0"]["embedding"] = [0.0, 1.0]
        self.path.write_text(json.dumps(replaced))
        with self.assertRaises(StaleDiarizationRun):
            self.store.mutate("meeting", token, lambda value: value)


if __name__ == "__main__":
    unittest.main()

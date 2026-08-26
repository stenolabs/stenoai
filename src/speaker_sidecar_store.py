"""Locked, run-scoped access to speaker sidecar documents."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Callable, Optional, TypeVar

import filelock

from src.speaker_schema import validate_meeting_stem


T = TypeVar("T")


class StaleDiarizationRun(RuntimeError):
    """The caller reviewed a different diarization run than the durable one."""

    error_code = "stale_diarization_run"

    def __init__(self, expected: str, actual: Optional[str]):
        super().__init__(
            "This speaker analysis changed. Reload the meeting before making changes."
        )
        self.expected = expected
        self.actual = actual


class SpeakerSidecarStore:
    """Serialize speaker sidecar read-modify-write operations per meeting."""

    def __init__(self, output_dir: Path, *, lock_timeout: float = 10.0):
        self.output_dir = Path(output_dir)
        self.lock_timeout = lock_timeout

    def path(self, meeting_stem: str) -> Path:
        stem = validate_meeting_stem(meeting_stem)
        return self.output_dir / f"{stem}_speakers.json"

    def read(self, meeting_stem: str) -> Optional[dict]:
        from src.speaker_suggestions import read_speakers_sidecar

        return read_speakers_sidecar(self.output_dir, validate_meeting_stem(meeting_stem))

    def lock_path(self, meeting_stem: str) -> Path:
        """Return a stable lock path without retaining the meeting title."""
        stem = validate_meeting_stem(meeting_stem)
        digest = hashlib.sha256(stem.encode("utf-8")).hexdigest()
        return self.output_dir / f".speaker-{digest}.lock"

    def lock(self, meeting_stem: str) -> filelock.FileLock:
        return filelock.FileLock(
            str(self.lock_path(meeting_stem)), timeout=self.lock_timeout,
        )

    def assert_current(self, meeting_stem: str, expected_run_id: Optional[str]) -> dict:
        document = self.read(meeting_stem)
        if document is not None and not isinstance(document, dict):
            raise ValueError("Invalid speaker sidecar document.")
        actual = self.run_token(document)
        if actual != expected_run_id:
            raise StaleDiarizationRun(expected_run_id, actual)
        return document

    def mutate(
        self,
        meeting_stem: str,
        expected_run_id: Optional[str],
        mutation: Callable[[dict], T],
    ) -> dict:
        with self.lock(meeting_stem):
            return self.mutate_locked(meeting_stem, expected_run_id, mutation)

    def mutate_locked(
        self,
        meeting_stem: str,
        expected_run_id: Optional[str],
        mutation: Callable[[dict], T],
    ) -> dict:
        """Mutate while the caller already holds ``lock(meeting_stem)``."""
        path = self.path(meeting_stem)
        document = self.read(meeting_stem)
        if document is None:
            raise FileNotFoundError(path)
        if not isinstance(document, dict):
            raise ValueError("Invalid speaker sidecar document.")
        actual = self.run_token(document)
        if actual != expected_run_id:
            raise StaleDiarizationRun(expected_run_id, actual)
        mutation(document)
        from src.speaker_suggestions import write_sidecar_document

        write_sidecar_document(
            self.output_dir,
            meeting_stem,
            document,
            acquire_lock=False,
        )
        return document

    @staticmethod
    def _run_id(document: Optional[dict]) -> Optional[str]:
        run = document.get("diarization_run") if isinstance(document, dict) else None
        return run.get("run_id") if isinstance(run, dict) else None

    @classmethod
    def run_token(cls, document: Optional[dict]) -> Optional[str]:
        """Return the explicit run id or an acoustic token for a legacy document.

        Legacy sidecars predate ``diarization_run``. Their fallback token must
        change when the diarizer output changes, but not when a reviewer adds
        metadata to that same output. The lock already merges review-state
        writes against the latest document. Hashing those fields as well would
        turn a harmless review action into a false stale-run error for every
        other row still visible from the same analysis.
        """
        run_id = cls._run_id(document)
        if isinstance(run_id, str) and run_id:
            return run_id
        if not isinstance(document, dict):
            return None
        channels = document.get("channels")
        acoustic_channels = {}
        if isinstance(channels, dict):
            for channel_name, channel in channels.items():
                if not isinstance(channel, dict):
                    acoustic_channels[channel_name] = channel
                    continue
                clusters = channel.get("clusters")
                acoustic_clusters = {}
                if isinstance(clusters, dict):
                    for speaker_id, cluster in clusters.items():
                        if not isinstance(cluster, dict):
                            acoustic_clusters[speaker_id] = cluster
                            continue
                        acoustic_clusters[speaker_id] = {
                            key: cluster[key]
                            for key in (
                                "embedding",
                                "speech_duration_seconds",
                                "segment_count",
                                "segments",
                            )
                            if key in cluster
                        }
                acoustic_channels[channel_name] = {
                    "recording_type": channel.get("recording_type"),
                    "clusters": acoustic_clusters,
                }
        transcript_lines = document.get("transcript_lines")
        acoustic_manifest = None
        if isinstance(transcript_lines, list):
            acoustic_manifest = [
                {
                    key: entry[key]
                    for key in ("start", "channel", "diarization_speaker_id")
                    if key in entry
                }
                if isinstance(entry, dict) else entry
                for entry in transcript_lines
            ]
        acoustic_document = {
            "meeting_id": document.get("meeting_id"),
            "channels": acoustic_channels,
            "transcript_lines": acoustic_manifest,
        }
        canonical = json.dumps(
            acoustic_document, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")
        return "legacy-" + hashlib.sha256(canonical).hexdigest()

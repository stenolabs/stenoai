"""Tests for the OpenAI-compatible batch transcription backend."""

import asyncio
import contextlib
import http.client
import http.server
import io
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Optional
from unittest.mock import Mock, patch

import src.config as config_mod
import src.transcriber as transcriber_mod
from simple_recorder import MeetingPipeline, _parse_meeting_markdown
from src.config import Config
from src.transcriber import WhisperTranscriber


OPENAI_ASR_CHUNK_THRESHOLD_BYTES = 23 * 1024 * 1024


class _FakeResponse:
    def __init__(
        self,
        body: bytes,
        content_type: str = "application/json",
        content_length: Optional[str] = None,
    ):
        self._body = body
        self.headers = {"Content-Type": content_type}
        if content_length is not None:
            self.headers["Content-Length"] = content_length
        self.read_sizes = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, size=-1):
        self.read_sizes.append(size)
        return self._body if size < 0 else self._body[:size]

    def close(self):
        pass


class _TricklingResponse(_FakeResponse):
    """A body that never completes until close() proves the wall-clock cap."""
    def __init__(self):
        super().__init__(b"")
        import threading
        self.released = threading.Event()

    def read(self, _size=-1):
        self.released.wait()
        return b""

    def close(self):
        self.released.set()


class _FakeOpener:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def open(self, request, timeout):
        stream = request.data
        self.requests.append(
            {
                "file_size": stream.file_size,
                "prefix": stream.prefix_bytes,
                "timeout": timeout,
                "url": request.full_url,
            }
        )
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class _BlockingOpener:
    def __init__(self):
        self.entered = threading.Event()
        self.released = threading.Event()

    def open(self, request, timeout):
        self.entered.set()
        self.released.wait()
        return _json_response({"text": "late", "segments": []})


class _DelayedFallbackOpener:
    """Makes each response-format negotiation step consume wall-clock time."""
    def __init__(self, responses, delay_seconds: float):
        self.responses = iter(responses)
        self.delay_seconds = delay_seconds
        self.calls = 0

    def open(self, request, timeout):
        self.calls += 1
        time.sleep(self.delay_seconds)
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class _PausedUploadOpener:
    """Consumes one audio chunk, then simulates a stalled socket write."""
    def __init__(self):
        self.audio_path = None
        self.audio_chunk_read = threading.Event()
        self.released = threading.Event()
        self.finished = threading.Event()
        self.post_cancel_chunks = []

    def open(self, request, timeout):
        stream = request.data
        self.audio_path = stream.audio_path
        iterator = iter(stream)
        next(iterator)  # Multipart prefix.
        next(iterator)  # First audio chunk.
        self.audio_chunk_read.set()
        self.released.wait()
        self.post_cancel_chunks = list(iterator)
        self.finished.set()
        return _json_response({"text": "late", "segments": []})


def _json_response(payload):
    return _FakeResponse(json.dumps(payload).encode())


def _http_error(code: int, body: bytes = b"error"):
    return urllib.error.HTTPError(
        "https://api.example/v1/audio/transcriptions",
        code,
        "failure",
        {},
        io.BytesIO(body),
    )


def _streaming_http_error(code: int, response):
    return urllib.error.HTTPError(
        "https://api.example/v1/audio/transcriptions",
        code,
        "failure",
        {},
        response,
    )


def _build_transcriber() -> WhisperTranscriber:
    transcriber = WhisperTranscriber.__new__(WhisperTranscriber)
    transcriber.model = None
    transcriber.model_size = "large-v3-turbo"
    transcriber.backend = "openai-asr"
    transcriber._openai_asr_api_url = "https://api.example/v1"
    transcriber._openai_asr_api_key = "sk-test-token"
    transcriber._openai_asr_model = "whisper-1"
    return transcriber


def _write_pcm_wav(path: Path, frame_count: int) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        remaining = frame_count
        silence = b"\0" * (16000 * 2)
        while remaining:
            frames = min(remaining, 16000)
            wav_file.writeframesraw(silence[:frames * 2])
            remaining -= frames


def _write_signal_wav(path: Path, frame_count: int) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframesraw((1200).to_bytes(2, "little", signed=True) * frame_count)


def _write_stereo_burst_wav(path: Path, frame_count: int, burst_start: int, burst_frames: int) -> None:
    """Write digital silence with a left-channel-only signal burst."""
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(2)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        for frame in range(frame_count):
            # Per-channel RMS is above the gate while a stereo-wide average
            # would dilute this below it.
            left = 150 if burst_start <= frame < burst_start + burst_frames else 0
            wav_file.writeframesraw(
                left.to_bytes(2, "little", signed=True) + b"\0\0"
            )


class OpenAiAsrTests(unittest.TestCase):
    def setUp(self):
        self._previous_origin = os.environ.get("STENOAI_OAI_API_ORIGIN")
        self._previous_url = os.environ.get("STENOAI_OAI_API_URL")
        os.environ["STENOAI_OAI_API_ORIGIN"] = "https://api.example"
        os.environ["STENOAI_OAI_API_URL"] = "https://api.example/v1"

    def tearDown(self):
        if self._previous_origin is None:
            os.environ.pop("STENOAI_OAI_API_ORIGIN", None)
        else:
            os.environ["STENOAI_OAI_API_ORIGIN"] = self._previous_origin
        if self._previous_url is None:
            os.environ.pop("STENOAI_OAI_API_URL", None)
        else:
            os.environ["STENOAI_OAI_API_URL"] = self._previous_url

    def test_loopback_http_upload_bypasses_a_configured_proxy(self):
        target_hits = []
        proxy_hits = []

        class TargetHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                target_hits.append(self.path)
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps({"text": "local transcript", "segments": []}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *args):
                pass

        class ProxyHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                proxy_hits.append(self.path)
                self.send_response(502)
                self.end_headers()

            def log_message(self, _format, *args):
                pass

        target = http.server.ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
        proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
        target_thread = threading.Thread(target=target.serve_forever, daemon=True)
        proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        target_thread.start()
        proxy_thread.start()
        try:
            transcriber = _build_transcriber()
            transcriber._openai_asr_api_url = (
                f"http://127.0.0.1:{target.server_port}/v1"
            )
            with tempfile.TemporaryDirectory() as tmp_dir:
                audio = Path(tmp_dir) / "short.wav"
                _write_pcm_wav(audio, frame_count=16000)
                with patch.dict(
                    os.environ,
                    {
                        "STENOAI_OAI_API_ORIGIN": f"http://127.0.0.1:{target.server_port}",
                        "STENOAI_OAI_API_URL": f"http://127.0.0.1:{target.server_port}/v1",
                    },
                ), patch(
                    "urllib.request.getproxies",
                    return_value={"http": f"http://127.0.0.1:{proxy.server_port}"},
                ), patch("urllib.request.proxy_bypass", return_value=False):
                    result = transcriber._run_openai_asr(audio, language="en")
            self.assertEqual(result["text"], "local transcript")
            self.assertEqual(len(target_hits), 1)
            self.assertEqual(proxy_hits, [], "API key and audio must never reach HTTP_PROXY")
        finally:
            target.shutdown()
            proxy.shutdown()
            target.server_close()
            proxy.server_close()

    def test_loopback_http_disables_environment_proxies_but_https_keeps_defaults(self):
        endpoints = (
            "http://localhost:9000/v1",
            "http://127.0.0.1:9000/v1",
            "http://[::1]:9000/v1",
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            for endpoint in endpoints:
                with self.subTest(endpoint=endpoint):
                    transcriber = _build_transcriber()
                    transcriber._openai_asr_api_url = endpoint
                    opener = _FakeOpener([_json_response({"text": "local", "segments": []})])
                    origin = endpoint.split("/v1", 1)[0]
                    with patch.dict(
                        os.environ,
                        {"STENOAI_OAI_API_ORIGIN": origin, "STENOAI_OAI_API_URL": endpoint},
                    ), patch("urllib.request.build_opener", return_value=opener) as build:
                        transcriber._run_openai_asr(audio, language="en")
                    proxy_handlers = [
                        handler for handler in build.call_args.args
                        if isinstance(handler, urllib.request.ProxyHandler)
                    ]
                    self.assertEqual(len(proxy_handlers), 1)
                    self.assertEqual(proxy_handlers[0].proxies, {})

            transcriber = _build_transcriber()
            opener = _FakeOpener([_json_response({"text": "remote", "segments": []})])
            with patch("urllib.request.build_opener", return_value=opener) as build:
                transcriber._run_openai_asr(audio, language="en")
            self.assertFalse(any(
                isinstance(handler, urllib.request.ProxyHandler)
                for handler in build.call_args.args
            ), "HTTPS must retain urllib's standard environment-proxy behavior")

    def test_origin_bound_credential_never_reaches_a_changed_endpoint(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({"text": "must not upload", "segments": []})])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch.dict(
                os.environ,
                {"STENOAI_OAI_API_ORIGIN": "https://other.example"},
                clear=False,
            ), patch("urllib.request.build_opener", return_value=opener) as build_opener:
                with self.assertRaisesRegex(RuntimeError, "credential origin"):
                    transcriber._run_openai_asr(audio, language="en")
        build_opener.assert_not_called()

    def test_origin_bound_credential_accepts_an_equivalent_default_port_origin(self):
        transcriber = _build_transcriber()
        transcriber._openai_asr_api_url = "https://api.example:443/v1"
        opener = _FakeOpener([_json_response({"text": "safe", "segments": []})])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch.dict(
                os.environ, {"STENOAI_OAI_API_URL": "https://api.example/v1"},
            ), patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="en")
        self.assertEqual(result["text"], "safe")
        self.assertEqual(len(opener.requests), 1)

    def test_invalid_credential_never_reaches_logs_or_failure_metadata(self):
        marker = "PRIVATE-CREDENTIAL-MARKER"
        transcriber = _build_transcriber()
        transcriber._openai_asr_api_key = f"secret\n{marker}: yes"
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            stderr = io.StringIO()
            with self.assertLogs("src.transcriber", level="ERROR") as logs, contextlib.redirect_stderr(stderr), patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ), patch("urllib.request.build_opener") as build_opener:
                failure = transcriber.transcribe_audio(audio, language="en")

            build_opener.assert_not_called()
            self.assertTrue(failure["transcription_failed"])
            self.assertEqual(
                failure["error"], "openai-asr API key has an invalid format"
            )
            self.assertNotIn(marker, "\n".join(logs.output))
            self.assertNotIn(marker, stderr.getvalue())

            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = Path(tmp_dir) / "output"
            recorder.output_dir.mkdir()
            recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = Mock()
            recorder.transcriber.transcribe_diarised.return_value = failure
            recorder.summarizer = None
            config = Mock()
            config.get_language.return_value = "en"
            config.get_whisper_language.return_value = "en"
            config.get_keep_recordings.return_value = False
            with patch("src.config.get_config", return_value=config), patch.dict(
                "os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}
            ), contextlib.redirect_stdout(io.StringIO()):
                pipeline_result = asyncio.run(
                    recorder.process_recording_streaming(str(audio), "Bad credential")
                )
            body = Path(pipeline_result["session_info"]["summary_file"]).read_text()
            self.assertNotIn(marker, body)
            self.assertTrue(audio.exists())

    def test_header_serialization_error_is_neutralized(self):
        marker = "PRIVATEVALIDKEY123"
        transcriber = _build_transcriber()
        transcriber._openai_asr_api_key = marker
        opener = _FakeOpener([
            ValueError(f"Invalid header value b'Bearer {marker}'"),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with self.assertLogs("src.transcriber", level="ERROR") as logs, patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ), patch("urllib.request.build_opener", return_value=opener):
                failure = transcriber.transcribe_audio(audio, language="en")

        self.assertTrue(failure["transcription_failed"])
        self.assertEqual(
            failure["error"],
            "openai-asr request metadata could not be serialized",
        )
        self.assertNotIn(marker, "\n".join(logs.output))

    def test_large_wav_is_chunked_and_segment_timestamps_are_offset(self):
        transcriber = _build_transcriber()
        responses = [
            _json_response(
                {
                    "text": "first",
                    "segments": [{"text": "first", "start": 1.0, "end": 2.0}],
                    "duration": 600.0,
                    "language": "english",
                }
            ),
            _json_response(
                {
                    "text": "second",
                    "segments": [{"text": "second", "start": 3.0, "end": 4.0}],
                    "duration": 190.0,
                    "language": "german",
                }
            ),
        ]
        opener = _FakeOpener(responses)
        heartbeats = []

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "long.wav"
            _write_pcm_wav(audio, frame_count=16000 * 790)
            self.assertGreater(audio.stat().st_size, OPENAI_ASR_CHUNK_THRESHOLD_BYTES)
            with patch("urllib.request.build_opener", return_value=opener), patch(
                "src.transcriber._emit_heartbeat",
                side_effect=lambda done, total: heartbeats.append((done, total)),
            ):
                result = transcriber._run_openai_asr(audio, language="auto")

        self.assertEqual(len(opener.requests), 2)
        self.assertLessEqual(max(req["file_size"] for req in opener.requests), 16000 * 2 * 600 + 44)
        self.assertEqual(result["text"], "first second")
        self.assertEqual(
            result["segments"],
            [
                {"text": "first", "start": 1.0, "end": 2.0},
                {"text": "second", "start": 598.0, "end": 599.0},
            ],
        )
        self.assertEqual(result["duration_seconds"], 790.0)
        self.assertEqual(result["detected_language"], "en")
        self.assertEqual(heartbeats, [(1, 2), (2, 2)])

    def test_chunk_duration_must_fit_the_actual_request(self):
        transcriber = _build_transcriber()
        responses = [
            _json_response(
                {
                    "text": f"chunk {index}",
                    "segments": [
                        {"text": f"chunk {index}", "start": 0.0, "end": 1.0}
                    ],
                    "duration": 1e308,
                }
            )
            for index in (1, 2)
        ]
        opener = _FakeOpener(responses)

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "two-chunks.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            with patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ), patch.object(
                transcriber, "_build_whisper_fallback", return_value=False
            ), patch(
                "src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1
            ), patch(
                "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
            ), patch(
                "src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0
            ), patch(
                "urllib.request.build_opener", return_value=opener
            ):
                failure = transcriber.transcribe_audio(audio, language="en")

            self.assertTrue(failure["transcription_failed"])
            self.assertEqual(
                failure["error"],
                "openai-asr response timestamps exceed request duration",
            )
            self.assertTrue(audio.exists(), "failed ASR must retain retry audio")

    def test_file_under_limit_uses_single_request_path(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener(
            [
                _json_response(
                    {
                        "text": "short",
                        "segments": [{"text": "short", "start": 0.5, "end": 1.0}],
                        "duration": 1.0,
                    }
                )
            ]
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(result["text"], "short")
        self.assertEqual(result["segments"][0]["start"], 0.5)
        self.assertEqual(result["detected_language"], "en")

    def test_canonical_wav_gate_runs_once_before_network_then_rechecks_response(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({"text": "short", "segments": []})])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch(
                "src.transcriber._openai_asr_analyse_canonical_wav",
                wraps=transcriber_mod._openai_asr_analyse_canonical_wav,
            ) as analyse, patch("urllib.request.build_opener", return_value=opener):
                transcriber._run_openai_asr(audio, language="en")

        # First call gates the opener/upload. The second is deliberate
        # post-response validation of the bytes whose result is accepted.
        self.assertEqual(analyse.call_count, 2)

    def test_request_wait_is_guarded_by_a_heartbeat_context(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({"text": "short", "segments": []})])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener), patch(
                "src.transcriber._heartbeat_while_waiting",
                return_value=contextlib.nullcontext(),
            ) as heartbeat:
                transcriber._run_openai_asr(audio, language="en")

        heartbeat.assert_called_once_with("openai-asr-request")

    def test_total_deadline_closes_a_trickling_response(self):
        response = _TricklingResponse()
        with self.assertRaisesRegex(TimeoutError, "total deadline"):
            transcriber_mod._read_openai_asr_response_with_deadline(
                response, time.monotonic() + 0.01
            )
        self.assertTrue(response.released.is_set())

    def test_success_response_body_is_bounded_without_content_length(self):
        marker = b"PRIVATE-OVERSIZED-PROVIDER-BODY"
        limit = 64
        response = _FakeResponse(marker + b"x" * limit)
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("src.transcriber.OPENAI_ASR_MAX_RESPONSE_BYTES", limit), patch(
                "urllib.request.build_opener", return_value=_FakeOpener([response])
            ):
                with self.assertRaisesRegex(RuntimeError, "response exceeds safe size") as raised:
                    transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(response.read_sizes, [limit + 1])
        self.assertNotIn(marker.decode(), str(raised.exception))

    def test_oversized_declared_response_fails_before_body_read(self):
        limit = 64
        response = _FakeResponse(
            b"PRIVATE-DECLARED-OVERSIZED-BODY",
            content_length=str(limit + 1),
        )
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("src.transcriber.OPENAI_ASR_MAX_RESPONSE_BYTES", limit), patch(
                "urllib.request.build_opener", return_value=_FakeOpener([response])
            ):
                with self.assertRaisesRegex(RuntimeError, "response exceeds safe size"):
                    transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(response.read_sizes, [])

    def test_run_enforces_deadline_while_opening_request(self):
        transcriber = _build_transcriber()
        opener = _BlockingOpener()
        started = time.monotonic()
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                audio = Path(tmp_dir) / "short.wav"
                _write_pcm_wav(audio, frame_count=16000)
                with patch("urllib.request.build_opener", return_value=opener), patch(
                    "src.transcriber.OPENAI_ASR_REQUEST_DEADLINE_SECONDS", 0.02,
                ), patch(
                    "src.transcriber._heartbeat_while_waiting",
                    return_value=contextlib.nullcontext(),
                ):
                    with self.assertRaisesRegex(TimeoutError, "total deadline"):
                        transcriber._run_openai_asr(audio, language="en")
        finally:
            opener.released.set()

        self.assertTrue(opener.entered.is_set())
        self.assertLess(time.monotonic() - started, 1.0)

    def test_deadline_cancels_upload_before_windows_chunk_cleanup(self):
        """A stalled urllib upload must release its temp WAV before timeout returns."""
        class _TrackedFile:
            def __init__(self, file_handle, open_counter):
                self._file_handle = file_handle
                self._open_counter = open_counter
                self._closed = False
                self._open_counter[0] += 1

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                self.close()
                return False

            def close(self):
                if not self._closed:
                    self._closed = True
                    self._open_counter[0] -= 1
                    self._file_handle.close()

            def __getattr__(self, name):
                return getattr(self._file_handle, name)

        transcriber = _build_transcriber()
        opener = _PausedUploadOpener()
        open_counter = [0]
        real_open = open
        real_unlink = Path.unlink

        def track_chunk_open(file, *args, **kwargs):
            file_handle = real_open(file, *args, **kwargs)
            if opener.audio_path is not None and Path(file) == opener.audio_path:
                return _TrackedFile(file_handle, open_counter)
            return file_handle

        def windows_unlink(path, *args, **kwargs):
            if path == opener.audio_path and open_counter[0]:
                raise PermissionError("Windows cannot remove an open WAV")
            return real_unlink(path, *args, **kwargs)

        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                audio = Path(tmp_dir) / "two-seconds.wav"
                _write_pcm_wav(audio, frame_count=16000 * 2)
                with patch("src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1), patch(
                    "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
                ), patch("src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0), patch(
                    "src.transcriber.OPENAI_ASR_REQUEST_DEADLINE_SECONDS", 0.05
                ), patch("src.transcriber._heartbeat_while_waiting", return_value=contextlib.nullcontext()), patch(
                    "urllib.request.build_opener", return_value=opener
                ), patch("builtins.open", side_effect=track_chunk_open), patch.object(
                    Path, "unlink", new=windows_unlink
                ), self.assertRaisesRegex(TimeoutError, "total deadline"):
                    transcriber._run_openai_asr(audio, language="en")

            self.assertTrue(opener.audio_chunk_read.is_set())
            self.assertEqual(open_counter[0], 0)
            self.assertFalse(opener.audio_path.exists())
        finally:
            opener.released.set()
            self.assertTrue(opener.finished.wait(1))
        self.assertEqual(opener.post_cancel_chunks, [])

    def test_temporary_audio_cleanup_retries_and_redacts_unresolved_path(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            temp_audio = Path(tmp_dir) / "PRIVATE-MEETING-AUDIO.wav"
            temp_audio.write_bytes(b"private audio")
            real_unlink = Path.unlink
            attempts = [0]

            def flaky_unlink(path, *args, **kwargs):
                if path == temp_audio:
                    attempts[0] += 1
                    if attempts[0] < 3:
                        raise PermissionError(str(path))
                return real_unlink(path, *args, **kwargs)

            with patch.object(Path, "unlink", new=flaky_unlink), patch(
                "src.transcriber.time.sleep"
            ) as sleep:
                transcriber_mod._unlink_temporary_audio(temp_audio, "pre-processed")

        self.assertEqual(attempts[0], 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertFalse(temp_audio.exists())

    def test_temporary_audio_cleanup_logs_unresolved_file_without_path(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            temp_audio = Path(tmp_dir) / "PRIVATE-MEETING-AUDIO.wav"
            temp_audio.write_bytes(b"private audio")

            def locked_unlink(path, *args, **kwargs):
                if path == temp_audio:
                    raise PermissionError(str(path))
                return Path.unlink(path, *args, **kwargs)

            try:
                with self.assertLogs("src.transcriber", level="ERROR") as logs, patch.object(
                    Path, "unlink", new=locked_unlink
                ), patch("src.transcriber.time.sleep"):
                    transcriber_mod._unlink_temporary_audio(temp_audio, "openai-asr chunk")
            finally:
                temp_audio.unlink()

        self.assertTrue(any("may remain on disk" in message for message in logs.output))
        self.assertNotIn(str(temp_audio), "\n".join(logs.output))

    def test_run_enforces_deadline_while_reading_success_body(self):
        transcriber = _build_transcriber()
        response = _TricklingResponse()
        opener = _FakeOpener([response])
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener), patch(
                "src.transcriber.OPENAI_ASR_REQUEST_DEADLINE_SECONDS", 0.02,
            ), patch(
                "src.transcriber._heartbeat_while_waiting",
                return_value=contextlib.nullcontext(),
            ):
                with self.assertRaisesRegex(TimeoutError, "total deadline"):
                    transcriber._run_openai_asr(audio, language="en")

        self.assertTrue(response.released.is_set())
        self.assertLess(time.monotonic() - started, 1.0)

    def test_run_never_reads_http_error_body_and_closes_it(self):
        transcriber = _build_transcriber()
        response = _TricklingResponse()
        opener = _FakeOpener([_streaming_http_error(401, response)])
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener), patch(
                "src.transcriber.OPENAI_ASR_REQUEST_DEADLINE_SECONDS", 0.02,
            ), patch(
                "src.transcriber._heartbeat_while_waiting",
                return_value=contextlib.nullcontext(),
            ):
                with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                    transcriber._run_openai_asr(audio, language="en")

        self.assertTrue(response.released.is_set())
        self.assertLess(time.monotonic() - started, 1.0)

    def test_total_deadline_spans_all_response_format_fallbacks(self):
        """Late 400 fallbacks must not reset the one upload attempt's budget."""
        transcriber = _build_transcriber()
        opener = _DelayedFallbackOpener(
            [
                _http_error(400, b"verbose_json unsupported"),
                _http_error(400, b"json unsupported"),
                _FakeResponse(b"late third-format success", "text/plain"),
            ],
            delay_seconds=0.015,
        )
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener), patch(
                "src.transcriber.OPENAI_ASR_REQUEST_DEADLINE_SECONDS", 0.02,
            ), patch(
                "src.transcriber._heartbeat_while_waiting",
                return_value=contextlib.nullcontext(),
            ):
                with self.assertRaisesRegex(TimeoutError, "total deadline"):
                    transcriber._run_openai_asr(audio, language="en")

        self.assertLess(opener.calls, 3, "deadline must prevent the third-format success")
        self.assertLess(time.monotonic() - started, 1.0)

    def test_oversized_non_wav_fails_before_any_upload(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "invalid.wav"
            with audio.open("wb") as fh:
                fh.truncate(OPENAI_ASR_CHUNK_THRESHOLD_BYTES + 1)
            with patch("urllib.request.build_opener") as build_opener:
                with self.assertRaisesRegex(RuntimeError, "canonical WAV"):
                    transcriber._run_openai_asr(audio, language="en")
            build_opener.assert_not_called()

    def test_verbose_json_missing_text_raises(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({"segments": []})])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "text"):
                    transcriber._run_openai_asr(audio, language="auto")

    def test_invalid_200_response_uses_the_transcription_failure_path(self):
        """An invalid success payload is not mistaken for real silence.

        ``transcribe_audio`` is the boundary whose failure flag tells the
        meeting pipeline to retain its recording. Exercise the malformed-200
        response through that boundary, rather than only asserting that the
        lower-level request helper raises.
        """
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({"segments": []})])

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ), patch("urllib.request.build_opener", return_value=opener):
                result = transcriber.transcribe_audio(audio, language="auto")

        self.assertTrue(result["transcription_failed"])
        self.assertIn("containing 'text'", result["error"])

    def test_verbose_json_non_object_raises(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response([])])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "JSON object"):
                    transcriber._run_openai_asr(audio, language="auto")

    def test_verbose_json_empty_text_requires_empty_segments(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({"text": ""})])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "segments"):
                    transcriber._run_openai_asr(audio, language="auto")

    def test_html_content_type_in_text_fallback_is_rejected(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener(
            [
                _FakeResponse(b"not-json"),
                _FakeResponse(b"still-not-json"),
                _FakeResponse(b"proxy landing page", "text/html; charset=utf-8"),
            ]
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "unexpected content type"):
                    transcriber._run_openai_asr(audio, language="auto")

    def test_html_body_marker_in_text_fallback_is_rejected(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener(
            [
                _FakeResponse(b"not-json"),
                _FakeResponse(b"still-not-json"),
                _FakeResponse(
                    b"  <!DOCTYPE html><title>Wrong URL</title>",
                    "text/plain",
                ),
            ]
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "misconfigured endpoint"):
                    transcriber._run_openai_asr(audio, language="auto")

    def test_text_fallback_accepts_only_text_plain_media_type(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            problem_failure = None

            transcriber = _build_transcriber()
            opener = _FakeOpener([
                _FakeResponse(b"not-json"),
                _FakeResponse(b"still-not-json"),
                _FakeResponse(b"legitimate transcript", "text/plain; charset=utf-8"),
            ])
            with patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="en")
            self.assertEqual(result["text"], "legitimate transcript")

            for content_type in (
                "application/problem+json",
                "application/json",
                "application/octet-stream",
                "",
            ):
                with self.subTest(content_type=content_type):
                    transcriber = _build_transcriber()
                    marker = "PRIVATE-PROVIDER-ERROR-BODY"
                    opener = _FakeOpener([
                        _FakeResponse(b"not-json"),
                        _FakeResponse(b"still-not-json"),
                        _FakeResponse(
                            json.dumps({"error": marker}).encode(),
                            content_type,
                        ),
                    ])
                    with patch.object(
                        transcriber, "_preprocess_audio", return_value=(audio, False)
                    ), patch.object(
                        transcriber, "_build_whisper_fallback", return_value=False
                    ), patch("urllib.request.build_opener", return_value=opener):
                        failure = transcriber.transcribe_audio(audio, language="en")
                    self.assertTrue(failure["transcription_failed"])
                    self.assertNotIn(marker, failure["error"])
                    self.assertTrue(audio.exists(), "failed ASR must retain retry audio")
                    if content_type == "application/problem+json":
                        problem_failure = failure

            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = Path(tmp_dir) / "output"
            recorder.output_dir.mkdir()
            recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = Mock()
            recorder.transcriber.transcribe_diarised.return_value = problem_failure
            recorder.summarizer = None
            config = Mock()
            config.get_language.return_value = "en"
            config.get_whisper_language.return_value = "en"
            config.get_keep_recordings.return_value = False
            with patch("src.config.get_config", return_value=config), patch.dict(
                "os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}
            ), contextlib.redirect_stdout(io.StringIO()):
                pipeline_result = asyncio.run(
                    recorder.process_recording_streaming(str(audio), "Bad text fallback")
                )
            self.assertTrue(pipeline_result["session_info"]["transcription_failed"])
            self.assertTrue(
                audio.exists(),
                "application/problem+json failure must bypass keep_recordings=false deletion",
            )

    def test_invalid_utf8_text_fallback_uses_transcription_failure_path(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener(
            [
                _FakeResponse(b"not-json"),
                _FakeResponse(b"still-not-json"),
                _FakeResponse(b"\xff\xfe", "text/plain; charset=utf-8"),
            ]
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ), patch.object(
                transcriber, "_build_whisper_fallback", return_value=False
            ), patch("urllib.request.build_opener", return_value=opener):
                failure = transcriber.transcribe_audio(audio, language="en")

            self.assertTrue(failure["transcription_failed"])
            self.assertEqual(
                failure["error"],
                "openai-asr text response is not valid UTF-8",
            )
            self.assertTrue(audio.exists(), "failed ASR must retain retry audio")

    def test_http_error_body_never_reaches_exception_logs_result_or_meeting_metadata(self):
        marker = "PRIVATE-PROVIDER-ERROR-BODY"
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)

            transcriber = _build_transcriber()
            with patch(
                "urllib.request.build_opener",
                return_value=_FakeOpener([_http_error(401, marker.encode())]),
            ):
                with self.assertRaises(RuntimeError) as raised:
                    transcriber._run_openai_asr(audio, language="en")
            self.assertNotIn(marker, str(raised.exception))

            transcriber = _build_transcriber()
            stderr = io.StringIO()
            with self.assertLogs("src.transcriber", level="ERROR") as logs, contextlib.redirect_stderr(stderr), patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ), patch.object(
                transcriber, "_build_whisper_fallback", return_value=False
            ), patch(
                "urllib.request.build_opener",
                return_value=_FakeOpener([_http_error(401, marker.encode())]),
            ):
                failure = transcriber.transcribe_audio(audio, language="en")
            self.assertTrue(failure["transcription_failed"])
            self.assertNotIn(marker, failure["error"])
            self.assertNotIn(marker, "\n".join(logs.output))
            self.assertNotIn(marker, stderr.getvalue())

            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = Path(tmp_dir) / "output"
            recorder.output_dir.mkdir()
            recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = Mock()
            recorder.transcriber.transcribe_diarised.return_value = failure
            recorder.summarizer = None
            config = Mock()
            config.get_language.return_value = "en"
            config.get_whisper_language.return_value = "en"
            config.get_keep_recordings.return_value = False
            stdout = io.StringIO()
            with patch("src.config.get_config", return_value=config), patch.dict(
                "os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}
            ), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = asyncio.run(
                    recorder.process_recording_streaming(str(audio), "Private failure")
                )

            summary_path = Path(result["session_info"]["summary_file"])
            parsed = _parse_meeting_markdown(summary_path)
            self.assertTrue(audio.exists(), "keep_recordings=false must not delete retry audio")
            self.assertNotIn(marker, stdout.getvalue())
            self.assertNotIn(marker, summary_path.read_text(encoding="utf-8"))
            self.assertNotIn(marker, parsed["session_info"]["error"])

    def test_protocol_error_never_reaches_exception_logs_result_or_meeting_metadata(self):
        marker = "PRIVATE-PROTOCOL-STATUS-LINE"

        def protocol_errors():
            return [
                http.client.BadStatusLine(f"{marker}\r\n"),
                http.client.BadStatusLine(f"{marker}\r\n"),
            ]

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)

            transcriber = _build_transcriber()
            with patch(
                "urllib.request.build_opener",
                return_value=_FakeOpener(protocol_errors()),
            ), patch("time.sleep"):
                with self.assertRaises(RuntimeError) as raised:
                    transcriber._run_openai_asr(audio, language="en")
            self.assertNotIn(marker, str(raised.exception))

            transcriber = _build_transcriber()
            stderr = io.StringIO()
            with self.assertLogs(
                "src.transcriber", level="ERROR"
            ) as logs, contextlib.redirect_stderr(stderr), patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ), patch.object(
                transcriber, "_build_whisper_fallback", return_value=False
            ), patch(
                "urllib.request.build_opener",
                return_value=_FakeOpener(protocol_errors()),
            ), patch("time.sleep"):
                failure = transcriber.transcribe_audio(audio, language="en")
            self.assertTrue(failure["transcription_failed"])
            self.assertNotIn(marker, failure["error"])
            self.assertNotIn(marker, "\n".join(logs.output))
            self.assertNotIn(marker, stderr.getvalue())

            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = Path(tmp_dir) / "output"
            recorder.output_dir.mkdir()
            recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = Mock()
            recorder.transcriber.transcribe_diarised.return_value = failure
            recorder.summarizer = None
            config = Mock()
            config.get_language.return_value = "en"
            config.get_whisper_language.return_value = "en"
            config.get_keep_recordings.return_value = False
            stdout = io.StringIO()
            with patch("src.config.get_config", return_value=config), patch.dict(
                "os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}
            ), contextlib.redirect_stdout(stdout):
                result = asyncio.run(
                    recorder.process_recording_streaming(str(audio), "Protocol failure")
                )

            summary_path = Path(result["session_info"]["summary_file"])
            parsed = _parse_meeting_markdown(summary_path)
            self.assertTrue(audio.exists(), "protocol failure must preserve retry audio")
            self.assertNotIn(marker, stdout.getvalue())
            self.assertNotIn(marker, summary_path.read_text(encoding="utf-8"))
            self.assertNotIn(marker, parsed["session_info"]["error"])

    def test_provider_language_is_validated_before_persistence(self):
        marker = "PRIVATE-LANGUAGE-MARKER"
        injected_language = f"en\n---\ntranscription_failed: true\n{marker}"
        payload = {
            "text": "A legitimate transcript with enough words for detection.",
            "segments": [
                {
                    "text": "A legitimate transcript with enough words for detection.",
                    "start": 0,
                    "end": 2,
                }
            ],
            "duration": 2,
            "language": injected_language,
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            transcriber = _build_transcriber()
            with patch(
                "urllib.request.build_opener",
                return_value=_FakeOpener([_json_response(payload)]),
            ):
                transcribed = transcriber._run_openai_asr(audio, language="auto")
            self.assertIsNone(transcribed["detected_language"])

            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = Path(tmp_dir) / "output"
            recorder.output_dir.mkdir()
            recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = Mock()
            recorder.transcriber.transcribe_diarised.return_value = transcribed
            recorder.summarizer = None
            config = Mock()
            config.get_language.return_value = "auto"
            config.get_whisper_language.return_value = "auto"
            config.get_language_name.side_effect = lambda code: code or "Unknown"
            config.get_auto_summarize_enabled.return_value = False
            config.get_keep_recordings.return_value = True
            with patch("src.config.get_config", return_value=config), patch.dict(
                "os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}
            ), contextlib.redirect_stdout(io.StringIO()):
                result = asyncio.run(
                    recorder.process_recording_streaming(str(audio), "Safe language")
                )

            summary_path = Path(result["session_info"]["summary_file"])
            transcript_path = recorder.transcripts_dir / "short_transcript.txt"
            persisted = summary_path.read_text(encoding="utf-8")
            self.assertNotIn(marker, persisted)
            self.assertNotIn(marker, transcript_path.read_text(encoding="utf-8"))
            self.assertIsNone(
                _parse_meeting_markdown(summary_path)["session_info"]["detected_language"]
            )

    def test_fallback_warning_never_includes_http_error_body(self):
        marker = "PRIVATE-PROVIDER-ERROR-BODY"
        transcriber = _build_transcriber()
        opener = _FakeOpener([
            _http_error(400, marker.encode()),
            _json_response({"text": "safe transcript"}),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with self.assertLogs("src.transcriber", level="WARNING") as logs, patch(
                "urllib.request.build_opener", return_value=opener
            ):
                result = transcriber._run_openai_asr(audio, language="en")
        self.assertEqual(result["text"], "safe transcript")
        self.assertNotIn(marker, "\n".join(logs.output))

    def test_invalid_provider_numeric_metadata_never_reaches_failure_output(self):
        marker = "PRIVATE-PROVIDER-METADATA"
        payloads = (
            {
                "text": "provider transcript",
                "segments": [{"text": "provider transcript", "start": marker, "end": 1}],
            },
            {
                "text": "provider transcript",
                "segments": [{"text": "provider transcript", "start": 0, "end": 1}],
                "duration": marker,
            },
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            for payload in payloads:
                with self.subTest(payload=payload):
                    transcriber = _build_transcriber()
                    with self.assertLogs("src.transcriber", level="ERROR") as logs, patch.object(
                        transcriber, "_preprocess_audio", return_value=(audio, False)
                    ), patch.object(
                        transcriber, "_build_whisper_fallback", return_value=False
                    ), patch(
                        "urllib.request.build_opener",
                        return_value=_FakeOpener([_json_response(payload)]),
                    ):
                        failure = transcriber.transcribe_audio(audio, language="en")
                    self.assertTrue(failure["transcription_failed"])
                    self.assertNotIn(marker, failure["error"])
                    self.assertNotIn(marker, "\n".join(logs.output))

    def test_provider_timestamps_must_be_finite_nonnegative_and_ordered(self):
        def payload(duration, start=0, end=1, segment_text="provider transcript"):
            return {
                "text": "provider transcript",
                "segments": [{"text": segment_text, "start": start, "end": end}],
                "duration": duration,
            }

        bad_payloads = (
            payload(float("nan")),
            payload(float("inf")),
            payload("1e999"),
            payload(-1),
            payload(1, start=float("nan")),
            payload(1, start=float("inf")),
            payload(1, start=-0.1),
            payload(1, start=0.8, end=0.7),
            {
                "text": "provider transcript",
                "segments": [{"text": "provider transcript", "start": 0}],
                "duration": 1,
            },
            {
                "text": "provider transcript",
                "segments": [{"text": "provider transcript", "end": 1}],
                "duration": 1,
            },
            {"text": "provider transcript", "segments": [], "duration": "1e999"},
            payload(1, start="1e999", segment_text=""),
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            streaming_failure = None
            for provider_payload in bad_payloads:
                with self.subTest(payload=provider_payload):
                    transcriber = _build_transcriber()
                    with patch.object(
                        transcriber, "_preprocess_audio", return_value=(audio, False)
                    ), patch.object(
                        transcriber, "_build_whisper_fallback", return_value=False
                    ), patch(
                        "urllib.request.build_opener",
                        return_value=_FakeOpener([_json_response(provider_payload)]),
                    ):
                        failure = transcriber.transcribe_audio(audio, language="en")
                    self.assertTrue(failure["transcription_failed"])
                    self.assertEqual(
                        failure["error"],
                        "openai-asr verbose_json response has invalid segment metadata",
                    )
                    if provider_payload.get("duration") == "1e999":
                        streaming_failure = failure

            self.assertIsNotNone(streaming_failure)
            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = Path(tmp_dir) / "output"
            recorder.output_dir.mkdir()
            recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = Mock()
            recorder.transcriber.transcribe_diarised.return_value = streaming_failure
            recorder.summarizer = None
            config = Mock()
            config.get_language.return_value = "en"
            config.get_whisper_language.return_value = "en"
            config.get_keep_recordings.return_value = False
            with patch("src.config.get_config", return_value=config), patch.dict(
                "os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}
            ), contextlib.redirect_stdout(io.StringIO()):
                result = asyncio.run(
                    recorder.process_recording_streaming(str(audio), "Bad timestamps")
                )

            summary_path = Path(result["session_info"]["summary_file"])
            parsed = _parse_meeting_markdown(summary_path)
            self.assertTrue(audio.exists())
            self.assertTrue(parsed["session_info"]["transcription_failed"])
            self.assertTrue(parsed["session_info"]["reprocessable"])

    def test_multipart_filename_and_logs_never_expose_meeting_name(self):
        marker = "PRIVATE-MEETING-STEM"
        model_marker = "PRIVATE-CLIENT-MODEL"
        transcriber = _build_transcriber()
        transcriber._openai_asr_model = model_marker
        opener = _FakeOpener([
            _json_response({"text": "safe transcript", "segments": []})
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / f"{marker}-quote-marker.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with self.assertLogs("src.transcriber", level="INFO") as logs, patch(
                "urllib.request.build_opener", return_value=opener
            ), patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ):
                result = transcriber.transcribe_audio(audio, language="en")

        self.assertEqual(result["text"], "safe transcript")
        prefix = opener.requests[0]["prefix"]
        self.assertIn(b'name="file"; filename="audio.wav"\r\n', prefix)
        self.assertIn(b'Content-Type: audio/wav\r\n', prefix)
        self.assertNotIn(marker.encode(), prefix)
        self.assertNotIn(marker, "\n".join(logs.output))
        self.assertNotIn(model_marker, "\n".join(logs.output))

    def test_empty_cloud_response_for_energetic_wav_is_a_failure_but_digital_silence_is_valid(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "energetic.wav"
            _write_signal_wav(audio, frame_count=16000)
            transcriber = _build_transcriber()
            with patch.object(transcriber, "_preprocess_audio", return_value=(audio, False)), patch.object(
                transcriber, "_build_whisper_fallback", return_value=False
            ), patch("urllib.request.build_opener", return_value=_FakeOpener([
                _json_response({"text": "", "segments": []}),
            ])):
                failed = transcriber.transcribe_audio(audio, language="en")
            self.assertTrue(failed["transcription_failed"])
            self.assertTrue(audio.exists(), "empty cloud output must preserve retry audio")

            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = Path(tmp_dir) / "output"
            recorder.output_dir.mkdir()
            recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = Mock()
            recorder.transcriber.transcribe_diarised.return_value = failed
            recorder.summarizer = None
            config = Mock()
            config.get_language.return_value = "en"
            config.get_whisper_language.return_value = "en"
            config.get_keep_recordings.return_value = False
            with patch("src.config.get_config", return_value=config), patch.dict(
                "os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}
            ), contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(recorder.process_recording_streaming(str(audio), "Empty cloud response"))
            self.assertTrue(
                audio.exists(),
                "keep_recordings=false must retain an energetic WAV after empty cloud output",
            )

            silent = Path(tmp_dir) / "silence.wav"
            _write_pcm_wav(silent, frame_count=16000)
            transcriber = _build_transcriber()
            with patch.object(transcriber, "_preprocess_audio", return_value=(silent, False)), patch(
                "urllib.request.build_opener", return_value=_FakeOpener([
                    _json_response({"text": "", "segments": []}),
                ])
            ):
                result = transcriber.transcribe_audio(silent, language="en")
            self.assertFalse(result.get("transcription_failed"))
            self.assertEqual(result["text"], transcriber_mod.SILENCE_SENTINEL)

    def test_noncanonical_audio_fails_closed_before_any_network_interaction(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "unverified.mp3"
            audio.write_bytes(b"not a wav" * 200)
            with patch("urllib.request.build_opener") as build_opener:
                with self.assertRaisesRegex(RuntimeError, "canonical WAV"):
                    transcriber._run_openai_asr(audio, language="en")
            build_opener.assert_not_called()

    def test_malicious_model_metadata_fails_before_network_interaction(self):
        transcriber = _build_transcriber()
        transcriber._openai_asr_model = "whisper-1\r\nInjected: yes"
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener") as build_opener:
                with self.assertRaisesRegex(RuntimeError, "multipart metadata"):
                    transcriber._run_openai_asr(audio, language="en")
            build_opener.assert_not_called()

    def test_sub_1kb_cloud_inputs_fail_and_pipeline_preserves_recording(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            truncated = Path(tmp_dir) / "truncated.mp3"
            truncated.write_bytes(b"x" * 900)
            silent_header = Path(tmp_dir) / "silent.wav"
            _write_pcm_wav(silent_header, frame_count=0)

            failure = None
            for audio in (truncated, silent_header):
                with self.subTest(audio=audio.name):
                    transcriber = _build_transcriber()
                    with patch.object(transcriber, "_run_backend") as backend:
                        result = transcriber.transcribe_audio(audio, language="en")
                    backend.assert_not_called()
                    self.assertTrue(result["transcription_failed"])
                    self.assertEqual(
                        result["error"],
                        "openai-asr audio input is too small or unreadable",
                    )
                    failure = result

            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = Path(tmp_dir) / "output"
            recorder.output_dir.mkdir()
            recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = Mock()
            recorder.transcriber.transcribe_diarised.return_value = failure
            recorder.summarizer = None
            config = Mock()
            config.get_language.return_value = "en"
            config.get_whisper_language.return_value = "en"
            config.get_keep_recordings.return_value = False
            with patch("src.config.get_config", return_value=config), patch.dict(
                "os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}
            ), contextlib.redirect_stdout(io.StringIO()):
                pipeline_result = asyncio.run(
                    recorder.process_recording_streaming(
                        str(truncated), "Truncated cloud input"
                    )
                )

            self.assertTrue(pipeline_result["session_info"]["transcription_failed"])
            self.assertTrue(truncated.exists())

    def test_empty_cloud_response_scans_every_wav_block_including_one_stereo_channel(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "sparse-burst.wav"
            # The narrow burst sits between the former sparse 1-second sample
            # positions. Only the left channel carries it.
            _write_stereo_burst_wav(
                audio,
                frame_count=16000 * 120,
                burst_start=16000 * 37 + 8000,
                burst_frames=80,
            )
            analysis = transcriber_mod._openai_asr_analyse_canonical_wav(audio)
            self.assertIsNotNone(analysis)
            self.assertTrue(analysis[1])

    def test_canonical_analysis_reads_past_early_signal_and_rejects_truncation(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "truncated-after-signal.wav"
            _write_signal_wav(audio, frame_count=16000)
            raw = bytearray(audio.read_bytes())
            # Claim two seconds in the data header while only one is present.
            raw[4:8] = (36 + 64000).to_bytes(4, "little")
            raw[40:44] = (64000).to_bytes(4, "little")
            audio.write_bytes(raw)

            self.assertIsNone(
                transcriber_mod._openai_asr_analyse_canonical_wav(audio)
            )

            transcriber = _build_transcriber()
            opener = _FakeOpener([_json_response({
                "text": "untrusted tail",
                "segments": [{
                    "text": "untrusted tail", "start": 1.5, "end": 1.8,
                }],
                "duration": 1.8,
            })])
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "canonical WAV"):
                    transcriber._run_openai_asr(audio, language="en")

    def test_verified_upload_duration_overrides_shorter_provider_duration(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({
            "text": "late speech",
            "segments": [{
                "text": "late speech", "start": 0.8, "end": 0.9,
            }],
            "duration": 0.1,
        })])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "one-second.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(result["duration_seconds"], 1.0)
        self.assertEqual(result["segments"][0]["end"], 0.9)

    def test_chunk_overlap_preserves_every_timed_observation(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([
            _json_response({"text": "alpha boundary", "segments": [
                {"text": "alpha", "start": 0.1, "end": 0.2},
                {"text": "boundary", "start": 0.9, "end": 1.0},
            ]}),
            _json_response({"text": "boundary words", "segments": [
                {"text": "boundary", "start": 0.15, "end": 0.25},
                {"text": "words", "start": 0.4, "end": 0.5},
            ]}),
            _json_response({"text": "words omega", "segments": [
                {"text": "words", "start": 0.0, "end": 0.1},
                {"text": "omega", "start": 0.3, "end": 0.4},
            ]}),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "long.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            with patch("src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1), patch(
                "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
            ), patch("src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0.25, create=True), patch(
                "urllib.request.build_opener", return_value=opener
            ):
                result = transcriber._run_openai_asr(audio, language="en")
        self.assertEqual(
            result["text"],
            "alpha boundary boundary words words omega",
        )

    def test_untimed_chunk_text_keeps_real_repeated_words_without_lexical_deduplication(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([
            _json_response({"text": "again again", "segments": []}),
            _json_response({"text": "again end", "segments": []}),
            _json_response({"text": "final", "segments": []}),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "long.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            with patch("src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1), patch(
                "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
            ), patch("src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0.25), patch(
                "urllib.request.build_opener", return_value=opener
            ):
                result = transcriber._run_openai_asr(audio, language="en")
        self.assertEqual(result["text"], "again again again end final")

    def test_timed_chunk_overlap_never_deduplicates_equal_or_jittered_text(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([
            _json_response({"text": "Again Again", "segments": [
                {"text": "Again", "start": 0.70, "end": 0.80},
                {"text": "Again", "start": 0.90, "end": 1.00},
            ]}),
            _json_response({"text": "again! Again", "segments": [
                # Similar text and timestamps still do not prove identity.
                {"text": "again!", "start": 0.00, "end": 0.10},
                {"text": "Again", "start": 0.15, "end": 0.25},
            ]}),
            _json_response({"text": "end", "segments": [
                {"text": "end", "start": 0.30, "end": 0.40},
            ]}),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "long.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            with patch("src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1), patch(
                "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
            ), patch("src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0.25), patch(
                "urllib.request.build_opener", return_value=opener
            ):
                result = transcriber._run_openai_asr(audio, language="en")
        self.assertEqual(result["text"], "Again again! Again Again end")
        self.assertEqual(
            [(segment["text"], segment["start"], segment["end"]) for segment in result["segments"]],
            [
                ("Again", 0.7, 0.8),
                ("again!", 0.75, 0.85),
                ("Again", 0.9, 1.0),
                ("Again", 0.9, 1.0),
                ("end", 1.8, 1.9),
            ],
        )

    def test_production_790s_overlap_jitter_keeps_boundary_text(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([
            _json_response({
                "text": "boundary",
                "segments": [{
                    "text": "boundary", "start": 597.45, "end": 597.65,
                }],
                "duration": 600.0,
            }),
            _json_response({
                "text": "boundary end",
                "segments": [
                    {"text": "boundary", "start": 2.35, "end": 2.45},
                    {"text": "end", "start": 10.0, "end": 11.0},
                ],
                "duration": 195.0,
            }),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "production-values.wav"
            _write_pcm_wav(audio, frame_count=16000 * 790)
            self.assertGreater(audio.stat().st_size, OPENAI_ASR_CHUNK_THRESHOLD_BYTES)
            with patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(result["text"], "boundary boundary end")
        self.assertEqual(
            [(segment["text"], segment["start"], segment["end"]) for segment in result["segments"]],
            [
                ("boundary", 597.35, 597.45),
                ("boundary", 597.45, 597.65),
                ("end", 605.0, 606.0),
            ],
        )

    def test_nested_overlap_jitter_fails_closed_and_preserves_audio(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([
            _json_response({"text": "outer", "segments": [
                {"text": "outer", "start": 0.7, "end": 1.0},
            ]}),
            _json_response({"text": "inner", "segments": [
                {"text": "inner", "start": 0.0, "end": 0.05},
            ]}),
            _json_response({"text": "end", "segments": [
                {"text": "end", "start": 0.3, "end": 0.4},
            ]}),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "nested.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            with patch.object(
                transcriber, "_preprocess_audio", return_value=(audio, False)
            ), patch.object(
                transcriber, "_build_whisper_fallback", return_value=False
            ), patch(
                "src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1
            ), patch(
                "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
            ), patch(
                "src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0.25
            ), patch(
                "urllib.request.build_opener", return_value=opener
            ):
                failure = transcriber.transcribe_audio(audio, language="en")
            self.assertTrue(failure["transcription_failed"])
            self.assertEqual(
                failure["error"],
                "openai-asr final segment times are not globally monotone",
            )
            self.assertTrue(audio.exists())

    def test_global_segment_times_fail_closed_instead_of_clamping_overlap_regressions(self):
        with self.assertRaisesRegex(RuntimeError, "globally monotone"):
            transcriber_mod._validate_openai_asr_global_segments([
                {"text": "long", "start": 590.0, "end": 600.0},
                {"text": "nested", "start": 595.0, "end": 596.0},
            ], duration_seconds=600.0)

    def test_overlapped_chunk_segments_are_returned_in_global_time_order(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([
            _json_response({"text": "first", "segments": [
                {"text": "first", "start": 0.6, "end": 0.7},
            ]}),
            _json_response({"text": "second", "segments": [
                {"text": "second", "start": 0.3, "end": 0.4},
            ]}),
            _json_response({"text": "third", "segments": [
                {"text": "third", "start": 0.3, "end": 0.4},
            ]}),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "long.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            with patch("src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1), patch(
                "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
            ), patch("src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0.25), patch(
                "urllib.request.build_opener", return_value=opener
            ):
                result = transcriber._run_openai_asr(audio, language="en")
        self.assertEqual(
            [segment["start"] for segment in result["segments"]],
            [0.6, 1.05, 1.8],
        )

    def test_chunk_temp_paths_do_not_contain_source_stem(self):
        marker = "PRIVATE-SOURCE-STEM"
        seen_paths = []
        real_mkstemp = tempfile.mkstemp

        def capture_mkstemp(*args, **kwargs):
            fd, chunk_path = real_mkstemp(*args, **kwargs)
            seen_paths.append(chunk_path)
            return fd, chunk_path

        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / f"{marker}.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            with patch("src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1), patch(
                "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
            ), patch("src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0), patch(
                "tempfile.mkstemp", side_effect=capture_mkstemp), patch(
                "urllib.request.build_opener", return_value=_FakeOpener([
                    _json_response({"text": "one", "segments": []}),
                    _json_response({"text": "two", "segments": []}),
                ])
            ):
                transcriber._run_openai_asr(audio, language="en")
        self.assertTrue(seen_paths)
        self.assertTrue(all(marker not in chunk_path for chunk_path in seen_paths))

    def test_provider_timestamps_must_fit_each_request_and_be_monotone(self):
        invalid_responses = (
            {"text": "late", "segments": [{"text": "late", "start": 0.0, "end": 2.1}]},
            {"text": "later earlier", "segments": [
                {"text": "later", "start": 0.7, "end": 0.8},
                {"text": "earlier", "start": 0.2, "end": 0.3},
            ]},
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            for payload in invalid_responses:
                with self.subTest(payload=payload):
                    transcriber = _build_transcriber()
                    with patch.object(transcriber, "_preprocess_audio", return_value=(audio, False)), patch.object(
                        transcriber, "_build_whisper_fallback", return_value=False
                    ), patch("urllib.request.build_opener", return_value=_FakeOpener([
                        _json_response(payload),
                    ])):
                        result = transcriber.transcribe_audio(audio, language="en")
                self.assertTrue(result["transcription_failed"])

    def test_json_rung_fallback_synthesizes_segment(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener(
            [
                _http_error(400, b"verbose_json unsupported"),
                _json_response({"text": "json response"}),
            ]
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="de")

        self.assertEqual(len(opener.requests), 2)
        self.assertIn(b'name="response_format"\r\n\r\njson\r\n', opener.requests[1]["prefix"])
        self.assertEqual(
            result["segments"],
            [{
                "text": "json response", "start": 0.0, "end": 0.0,
                "has_timestamps": False,
            }],
        )
        self.assertEqual(result["detected_language"], "de")

    def test_verbose_json_text_without_segments_is_preserved_as_untimed(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({"text": "whole-channel response"})])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(result["text"], "whole-channel response")
        self.assertEqual(result["segments"], [{
            "text": "whole-channel response", "start": 0.0, "end": 0.0,
            "has_timestamps": False,
        }])

    def test_degraded_verbose_json_validates_duration_and_discarded_timestamps(self):
        payloads = (
            {"text": "hello", "segments": [], "duration": 999999},
            {
                "text": "hello extra",
                "segments": [{"text": "hello", "start": 0.0, "end": 1.0}],
                "duration": 999999,
            },
            {
                "text": "hello extra",
                "segments": [{"text": "hello", "start": 998, "end": 999}],
                "duration": 1,
            },
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "one-second.wav"
            _write_pcm_wav(audio, frame_count=16000)
            for payload in payloads:
                with self.subTest(payload=payload):
                    transcriber = _build_transcriber()
                    with patch("urllib.request.build_opener", return_value=_FakeOpener([
                        _json_response(payload),
                    ])), self.assertRaisesRegex(RuntimeError, "timestamps exceed request duration"):
                        transcriber._run_openai_asr(audio, language="en")

    def test_verbose_json_partial_segments_fall_back_to_complete_untimed_text(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([_json_response({
            "text": "complete sentence one. complete sentence two.",
            "segments": [{
                "text": "complete sentence one.", "start": 0.0, "end": 1.0,
            }],
        })])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(
            result["text"], "complete sentence one. complete sentence two."
        )
        self.assertEqual(result["segments"], [{
            "text": "complete sentence one. complete sentence two.",
            "start": 0.0,
            "end": 0.0,
            "has_timestamps": False,
        }])

    def test_chunked_segments_without_times_remain_untimed(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener([
            _json_response({"text": "first", "segments": [{"text": "first"}]}),
            _json_response({"text": "second", "segments": [{"text": "second"}]}),
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "two-seconds.wav"
            _write_pcm_wav(audio, frame_count=16000 * 2)
            with patch(
                "src.transcriber.OPENAI_ASR_CHUNK_THRESHOLD_BYTES", 1
            ), patch(
                "src.transcriber.OPENAI_ASR_MAX_CHUNK_SECONDS", 1
            ), patch(
                "src.transcriber.OPENAI_ASR_CHUNK_OVERLAP_SECONDS", 0
            ), patch(
                "urllib.request.build_opener", return_value=opener
            ):
                result = transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(result["text"], "first second")
        self.assertEqual(result["segments"], [
            {
                "text": "first", "start": 0.0, "end": 0.0,
                "has_timestamps": False,
            },
            {
                "text": "second", "start": 0.0, "end": 0.0,
                "has_timestamps": False,
            },
        ])

    def test_429_is_retried_once_then_succeeds(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener(
            [
                _http_error(429, b"slow down"),
                _json_response({"text": "recovered", "segments": []}),
            ]
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener), patch(
                "time.sleep"
            ) as sleep_mock:
                result = transcriber._run_openai_asr(audio, language="en")

        self.assertEqual(result["text"], "recovered")
        self.assertEqual(len(opener.requests), 2)
        sleep_mock.assert_called_once_with(2)

    def test_http_error_drops_bearer_and_sk_body_entirely(self):
        transcriber = _build_transcriber()
        opener = _FakeOpener(
            [
                _http_error(
                    401,
                    b"Authorization: Bearer secret-token\nprovider key sk-abcdefgh12345678",
                )
            ]
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaises(RuntimeError) as raised:
                    transcriber._run_openai_asr(audio, language="en")

        message = str(raised.exception)
        self.assertNotIn("secret-token", message)
        self.assertNotIn("sk-abcdefgh12345678", message)
        self.assertEqual(message, "openai-asr HTTP 401")

    def test_http_error_drops_configured_non_openai_key_body_entirely(self):
        transcriber = _build_transcriber()
        configured_key = "test-provider-credential-987654"
        transcriber._openai_asr_api_key = configured_key
        opener = _FakeOpener([
            _http_error(401, f"token={configured_key} api_key=other-test-token".encode())
        ])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaises(RuntimeError) as raised:
                    transcriber._run_openai_asr(audio, language="en")

        message = str(raised.exception)
        self.assertNotIn(configured_key, message)
        self.assertNotIn("other-test-token", message)
        self.assertEqual(message, "openai-asr HTTP 401")

    def test_config_diagnostic_redacts_userinfo_and_query_credentials(self):
        redacted = config_mod._redact_url_credentials(
            "http://user:password@evil.example/v1?access_token=secret-value"
        )
        self.assertEqual(redacted, "[redacted-url]")

    def test_url_guard_rejects_remote_http_and_accepts_loopback_or_https(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertFalse(config.set_openai_asr_api_url("http://evil.example/v1"))
            self.assertTrue(config.set_openai_asr_api_url("http://127.0.0.1:9000/v1"))
            self.assertTrue(config.set_openai_asr_api_url("https://safe.example/v1"))

    def test_legacy_unsafe_url_fails_closed_and_never_reaches_the_transcriber(self):
        unsafe_urls = (
            "http://user:password@evil.example/v1",
            "https://safe.example/v1?key=secret",
            "https://safe.example/v1?subscription-key=secret",
            "https://safe.example/v1?sig=secret",
            "https://safe.example/v1?unknown=secret",
        )
        for unsafe_url in unsafe_urls:
            with self.subTest(url=unsafe_url), tempfile.TemporaryDirectory() as tmp_dir:
                config_path = Path(tmp_dir) / "config.json"
                config_path.write_text(json.dumps({"openai_asr_api_url": unsafe_url}))
                config = Config(config_path=config_path)
                self.assertEqual(config.get_openai_asr_api_url(), "")

                transcriber = _build_transcriber()
                transcriber._openai_asr_api_url = unsafe_url
                with patch.dict(
                    os.environ, {"STENOAI_OAI_API_URL": unsafe_url},
                ), patch("urllib.request.build_opener") as build_opener:
                    with self.assertRaisesRegex(RuntimeError, "endpoint snapshot is unsafe or invalid"):
                        transcriber._run_openai_asr(Path("unused.wav"), language="en")
                build_opener.assert_not_called()

    def test_node_canonical_punycode_snapshot_is_used_without_python_idna_rebinding(self):
        transcriber = _build_transcriber()
        # A stale Python config value would map this host using IDNA2003. The
        # Node-owned snapshot is ASCII and must be the only request endpoint.
        transcriber._openai_asr_api_url = "https://faß.de/v1"
        opener = _FakeOpener([_json_response({"text": "safe", "segments": []})])
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "short.wav"
            _write_pcm_wav(audio, frame_count=16000)
            with patch.dict(os.environ, {
                "STENOAI_OAI_API_URL": "https://xn--fa-hia.de/v1",
                "STENOAI_OAI_API_ORIGIN": "https://xn--fa-hia.de",
            }), patch("urllib.request.build_opener", return_value=opener):
                result = transcriber._run_openai_asr(audio, language="en")
        self.assertEqual(result["text"], "safe")
        self.assertEqual(opener.requests[0]["url"], "https://xn--fa-hia.de/v1/audio/transcriptions")

    def test_endpoint_snapshot_rejects_bare_query_or_fragment_before_network(self):
        transcriber = _build_transcriber()
        for endpoint in ("https://api.example/v1?", "https://api.example/v1#"):
            with self.subTest(endpoint=endpoint), patch.dict(
                os.environ, {"STENOAI_OAI_API_URL": endpoint},
            ), patch("urllib.request.build_opener") as build_opener:
                with self.assertRaisesRegex(RuntimeError, "endpoint snapshot is unsafe or invalid"):
                    transcriber._run_openai_asr(Path("unused.wav"), language="en")
                build_opener.assert_not_called()

    def test_language_normalization(self):
        normalize = getattr(transcriber_mod, "_normalize_openai_language")
        self.assertEqual(normalize("English"), "en")
        self.assertEqual(normalize("german"), "de")
        self.assertEqual(normalize("en"), "en")
        self.assertEqual(normalize(" EN "), "en")
        self.assertEqual(normalize("haw"), "haw")
        self.assertEqual(normalize("uk"), "uk")
        self.assertEqual(normalize("Finnish"), "fi")
        self.assertEqual(normalize("Swedish"), "sv")
        self.assertIsNone(normalize("xx"))
        self.assertIsNone(normalize("zzz"))
        self.assertIsNone(normalize("unknown language"))
        self.assertIsNone(normalize("en\n---\ninjected: true"))
        self.assertIsNone(normalize(42))
        self.assertIsNone(normalize(None))


if __name__ == "__main__":
    unittest.main()

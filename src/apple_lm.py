"""Apple SystemLanguageModel helper for optional on-device summarization.

The sidecar wraps ``SystemLanguageModel.default`` and leaves model selection to
the OS. Steno exposes it as an explicit local-model choice; availability never
changes the configured model during config loading.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

logger = logging.getLogger(__name__)

APPLE_SYSTEM_MODEL = "apple:system"
# Conservative shared input/output window for the supported macOS 26 model.
# Apple TN3193 documents 4096 tokens per session. A larger window observed on
# macOS 27 must not enlarge budgets on older supported runtimes. Keep this
# fallback until the helper reports a verified model-specific context size.
# This only sizes OUR prompts; it does not configure the OS-owned model.
# https://developer.apple.com/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window
APPLE_LM_NUM_CTX = 4096

_DISABLE_ENV = "STENOAI_DISABLE_APPLE_LM"
_EXPERIMENTAL_ENV = "STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM"
_BIN_ENV = "STENOAI_APPLE_LM_BIN"
_E2E_ENV = "STENOAI_E2E"
_E2E_STATE_FILE_ENV = "STENOAI_APPLE_LM_STATE_FILE"

_HELPER_APP_NAME = "Steno Apple LM.app"
_HELPER_EXECUTABLE = "steno-apple-lm"
_HELPER_PID_PREFIX = "steno-apple-lm-pid:"
_HELPER_PID_GRACE_SECONDS = 5
_HELPER_LEASE_ENV = "STENOAI_APPLE_LM_LEASE_FILE"

_STATUS_LOCK = threading.Lock()
_STATUS_CACHE: Optional[Dict[str, Any]] = None
_STATUS_CACHE_BIN: Optional[str] = None


def is_apple_system_model(model_id: Optional[str]) -> bool:
    return model_id == APPLE_SYSTEM_MODEL


def apple_lm_disabled() -> bool:
    return os.environ.get(_DISABLE_ENV) == "1"


def apple_lm_experimental_enabled() -> bool:
    """Explicit process opt-in; never inferred from hardware or saved selection."""
    return os.environ.get(_EXPERIMENTAL_ENV) == "1"


def _direct_test_helper_allowed() -> bool:
    """True only for an unpackaged E2E process, never a shipped backend."""
    return os.environ.get(_E2E_ENV) == "1" and not getattr(sys, "frozen", False)


def _e2e_status_fixture() -> Optional[Dict[str, Any]]:
    """Return deterministic status without executing a test helper."""
    state_file = os.environ.get(_E2E_STATE_FILE_ENV)
    if os.environ.get(_E2E_ENV) != "1" or not state_file:
        return None
    if Path(state_file).is_file():
        return {"available": False, "reason": "appleIntelligenceNotEnabled"}
    return {"available": True, "display_name": "Apple Intelligence"}


def reset_apple_lm_cache() -> None:
    """Drop the process-wide status cache. Tests only."""
    global _STATUS_CACHE, _STATUS_CACHE_BIN
    with _STATUS_LOCK:
        _STATUS_CACHE = None
        _STATUS_CACHE_BIN = None


def resolve_apple_lm_bin() -> Optional[str]:
    """Locate the Apple LM helper executable. Darwin only."""
    if apple_lm_disabled() or sys.platform != "darwin" or not apple_lm_experimental_enabled():
        return None
    candidates: list[str] = []
    # A direct executable override exists only for deterministic E2E fixtures.
    # Production prompts must go through the canonical nested helper app so
    # LaunchServices applies its App Sandbox before any meeting content enters
    # the process.
    override = os.environ.get(_BIN_ENV)
    if override and _direct_test_helper_allowed():
        candidates.append(override)
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).parent
        try:
            contents_dir = exe_dir.parents[1]
        except IndexError:
            contents_dir = exe_dir
        candidates.append(
            str(
                contents_dir
                / "Helpers"
                / _HELPER_APP_NAME
                / "Contents"
                / "MacOS"
                / _HELPER_EXECUTABLE
            )
        )
    else:
        repo_root = Path(__file__).resolve().parent.parent
        candidates.append(
            str(
                repo_root
                / "bin"
                / _HELPER_APP_NAME
                / "Contents"
                / "MacOS"
                / _HELPER_EXECUTABLE
            )
        )
    for cand in candidates:
        if os.access(cand, os.X_OK):
            return str(Path(cand).resolve())
    return None


def _helper_app_for_binary(binary: str) -> Optional[Path]:
    """Return the enclosing helper app for a canonical bundled executable."""
    path = Path(binary)
    try:
        app = path.parents[2]
    except IndexError:
        return None
    expected = app / "Contents" / "MacOS" / _HELPER_EXECUTABLE
    if app.name != _HELPER_APP_NAME or path != expected:
        return None
    return app


def apple_lm_status() -> Dict[str, Any]:
    """Probe helper ``status``. Cached per process and executable path."""
    global _STATUS_CACHE, _STATUS_CACHE_BIN
    if apple_lm_disabled():
        return {"available": False, "reason": "disabled"}
    if sys.platform != "darwin":
        return {"available": False, "reason": "unsupported_os"}
    if not apple_lm_experimental_enabled():
        return {"available": False, "reason": "experimental_disabled"}
    # Packaged T2 uses a status-only fixture. It cannot execute arbitrary code
    # or receive meeting content, so the production helper boundary remains
    # enforced even when the frozen backend is under test.
    test_status = _e2e_status_fixture()
    if test_status is not None:
        return test_status
    try:
        macos_major = int(platform.mac_ver()[0].split(".", 1)[0])
    except (TypeError, ValueError):
        macos_major = 0
    # T2 runs on the normal macOS app runner, which may predate Tahoe. Its
    # explicitly supplied mock sidecar still needs to exercise the integration
    # path. Production cannot bypass the OS gate: both the E2E marker and an
    # explicit test binary are required.
    test_sidecar = _direct_test_helper_allowed() and bool(os.environ.get(_BIN_ENV))
    if macos_major < 26 and not test_sidecar:
        return {"available": False, "reason": "unsupported_os"}
    binary = resolve_apple_lm_bin()
    if not binary:
        return {"available": False, "reason": "sidecar_missing"}
    with _STATUS_LOCK:
        if _STATUS_CACHE is not None and _STATUS_CACHE_BIN == binary:
            return dict(_STATUS_CACHE)
    try:
        raw = _run_apple_lm(["status"], timeout=15)
        payload = json.loads(raw)
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("available"), bool)
        ):
            raise ValueError("status payload has no boolean availability")
    except Exception as exc:
        logger.info("apple-lm status failed: %s", type(exc).__name__)
        payload = {"available": False, "reason": "sidecar_error"}
    if payload.get("reason") != "sidecar_error":
        with _STATUS_LOCK:
            _STATUS_CACHE = dict(payload)
            _STATUS_CACHE_BIN = binary
    return dict(payload)


def apple_lm_available() -> bool:
    return apple_lm_status().get("available") is True


_UNAVAILABLE_MESSAGES = {
    "experimental_disabled": (
        "Apple Intelligence is experimental and disabled by default. "
        "Choose another model in Settings to continue. Your selection was not changed."
    ),
    "disabled": "Apple Intelligence is disabled for this run.",
    "unsupported_os": "Apple Intelligence requires macOS 26 or later.",
    "sidecar_missing": "This Steno build does not include the Apple Intelligence helper.",
    "sidecar_error": "Steno could not check Apple Intelligence availability.",
    "deviceNotEligible": "Apple Intelligence is not supported on this Mac.",
    "appleIntelligenceNotEnabled": "Enable Apple Intelligence in System Settings before selecting this model.",
    "modelNotReady": "Apple Intelligence is still downloading or preparing its model.",
    "unavailable": "Apple Intelligence is not available on this system.",
}

_HIDDEN_UNAVAILABLE_REASONS = {"disabled", "unsupported_os", "experimental_disabled"}

_GENERATION_ERROR_MESSAGES = {
    "guardrail": "Apple Intelligence could not process this content.",
    "refusal": "Apple Intelligence declined to process this content.",
    "context_window": "This meeting is too long for Apple Intelligence to process in one request.",
    "assets_unavailable": "Apple Intelligence model assets are unavailable.",
    "unsupported_language": "Apple Intelligence does not support the selected language or locale.",
    "rate_limited": "Apple Intelligence is temporarily busy. Try again shortly.",
    "concurrent_requests": "Apple Intelligence is already processing another request.",
    "timeout": "Apple Intelligence timed out.",
    "invalid_input": "Apple Intelligence received no content to process.",
}


def apple_lm_unavailable_message(status: Optional[Dict[str, Any]] = None) -> str:
    """Return user-safe copy for the sidecar's fixed availability reasons."""
    payload = status if status is not None else apple_lm_status()
    reason = payload.get("reason") if isinstance(payload, dict) else None
    return _UNAVAILABLE_MESSAGES.get(
        reason,
        "Apple Intelligence is not available on this system.",
    )


def apple_lm_should_list(
    status: Optional[Dict[str, Any]] = None,
    *,
    selected: bool = False,
) -> bool:
    """Show actionable Tahoe availability states without advertising on older OSes."""
    payload = status if status is not None else apple_lm_status()
    if selected or payload.get("available") is True:
        return True
    return payload.get("reason") not in _HIDDEN_UNAVAILABLE_REASONS


def apple_lm_generation_error_message(reason: Optional[str]) -> str:
    """Return user-safe copy for fixed sidecar generation failure reasons."""
    return _GENERATION_ERROR_MESSAGES.get(
        reason,
        "Apple Intelligence request failed",
    )


def apple_system_model_info(
    *,
    is_default: bool = False,
    status: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    # Keep ``is_default`` for compatibility with existing metadata callers.
    # Selection is already represented structurally and rendered by the UI.
    del is_default
    display = (status or {}).get("display_name") or "Apple Intelligence"
    if status is None:
        # Metadata reads (including get-model during setup) must not launch the
        # helper. Settings/list-models passes an explicit probed status when it
        # needs availability-specific copy.
        availability_bit = "OS-managed on-device model"
    else:
        availability_bit = (
            "OS-managed on-device model"
            if status.get("available") is True
            else apple_lm_unavailable_message(status)
        )
    return {
        "name": f"{display if isinstance(display, str) and display.strip() else 'Apple Intelligence'} (Experimental)",
        "size": "",
        "params": "OS-managed",
        "description": (
            f"On-device System Language Model - {availability_bit}. "
            "Experimental: may omit facts or invent details. Review every result. "
            "Short inputs only (transcript, notes and template combined: "
            "up to 2,000 UTF-8 bytes)."
        ),
        "speed": "fast",
        "quality": "experimental",
    }


class _AppleLMAppInvocation:
    """One LaunchServices invocation using private FIFOs for content-free IPC."""

    def __init__(self, app: Path, args: list[str], prompt: str):
        self._temp_dir = tempfile.TemporaryDirectory(prefix="steno-apple-lm-")
        root = Path(self._temp_dir.name)
        os.chmod(root, 0o700)
        self._stdin_path = root / "stdin"
        self._stdout_path = root / "stdout"
        self._stderr_path = root / "stderr"
        self._lease_path = root / "lease"
        self._lease_path.write_text("active", encoding="utf-8")
        os.chmod(self._lease_path, 0o600)
        self._invocation_token = f"steno-apple-lm-invocation={uuid.uuid4()}"
        for fifo in (self._stdin_path, self._stdout_path, self._stderr_path):
            os.mkfifo(fifo, 0o600)

        self._lines: queue.Queue[Optional[str]] = queue.Queue()
        self._helper_pid: Optional[int] = None
        self._helper_pid_ready = threading.Event()
        self._threads = [
            threading.Thread(
                target=self._write_prompt,
                args=(prompt,),
                daemon=True,
            ),
            threading.Thread(target=self._read_stdout, daemon=True),
            threading.Thread(target=self._read_stderr, daemon=True),
        ]
        for thread in self._threads:
            thread.start()

        command = [
            "/usr/bin/open",
            "-W",
            "-n",
            "-g",
            "--stdin",
            str(self._stdin_path),
            "--stdout",
            str(self._stdout_path),
            "--stderr",
            str(self._stderr_path),
            "--env",
            "STENOAI_APPLE_LM_REPORT_PID=1",
            "--env",
            f"{_HELPER_LEASE_ENV}={self._lease_path}",
            "-a",
            str(app),
            "--args",
            *args,
            self._invocation_token,
        ]
        try:
            self._launcher = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
        except Exception:
            self._unblock_fifos()
            self._join_threads()
            self._temp_dir.cleanup()
            raise

    def _write_prompt(self, prompt: str) -> None:
        try:
            with self._stdin_path.open("w", encoding="utf-8") as handle:
                handle.write(prompt)
        except OSError:
            pass

    def _read_stdout(self) -> None:
        try:
            with self._stdout_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    self._lines.put(line)
        except OSError:
            pass
        finally:
            self._lines.put(None)

    def _read_stderr(self) -> None:
        try:
            with self._stderr_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    stripped = line.strip()
                    if stripped.startswith(_HELPER_PID_PREFIX):
                        try:
                            self._helper_pid = int(
                                stripped.removeprefix(_HELPER_PID_PREFIX)
                            )
                        except ValueError:
                            pass
                        else:
                            self._helper_pid_ready.set()
        except OSError:
            pass

    def iter_lines(self, timeout: float) -> Iterator[str]:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Apple Intelligence timed out")
            try:
                line = self._lines.get(timeout=min(remaining, 0.1))
            except queue.Empty:
                if self._launcher.poll() is not None:
                    self._unblock_fifos()
                continue
            if line is None:
                break
            yield line

    def wait(self, timeout: float = 5) -> None:
        try:
            return_code = self._launcher.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError("Apple Intelligence timed out") from exc
        if return_code != 0:
            launcher_error = ""
            if self._launcher.stderr is not None:
                launcher_error = self._launcher.stderr.read().strip()
            logger.info(
                "apple-lm LaunchServices failed (%s): %s",
                return_code,
                launcher_error or "no diagnostic",
            )
            raise RuntimeError("Apple Intelligence request failed")

    def close(self) -> None:
        # Prevent a launch request that is still queued in LaunchServices from
        # beginning model work after this invocation has timed out.
        try:
            self._lease_path.unlink()
        except OSError:
            pass
        if self._launcher.poll() is None:
            self._helper_pid_ready.wait(timeout=_HELPER_PID_GRACE_SECONDS)
            if not self._signal_helper_processes(signal.SIGTERM):
                logger.warning(
                    "apple-lm helper PID was not reported before cleanup"
                )
            try:
                self._launcher.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._signal_helper_processes(signal.SIGKILL)
                self._launcher.kill()
                try:
                    self._launcher.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        self._unblock_fifos()
        self._join_threads()
        if self._launcher.stderr is not None:
            self._launcher.stderr.close()
        self._temp_dir.cleanup()

    def _matching_invocation_pids(self) -> set[int]:
        """Find only processes carrying this invocation's unguessable token."""
        try:
            result = subprocess.run(
                ["/usr/bin/pgrep", "-f", self._invocation_token],
                capture_output=True,
                text=True,
                timeout=1,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return set()
        if result.returncode not in (0, 1):
            return set()
        pids = set()
        for line in result.stdout.splitlines():
            try:
                pid = int(line.strip())
            except ValueError:
                continue
            if pid > 0 and pid != os.getpid():
                pids.add(pid)
        return pids

    def _signal_helper_processes(self, sig: signal.Signals) -> bool:
        pids = (
            {self._helper_pid}
            if self._helper_pid is not None
            else self._matching_invocation_pids()
        )
        signaled = False
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                continue
            signaled = True
        return signaled

    def _unblock_fifos(self) -> None:
        for fifo in (self._stdin_path, self._stdout_path, self._stderr_path):
            try:
                fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
            except OSError:
                continue
            os.close(fd)

    def _join_threads(self) -> None:
        for thread in self._threads:
            thread.join(timeout=1)


def _run_apple_lm_app(
    app: Path,
    args: list[str],
    *,
    stdin: Optional[str],
    timeout: float,
) -> str:
    invocation = _AppleLMAppInvocation(app, args, stdin or "")
    try:
        output = "".join(invocation.iter_lines(timeout)).strip()
        try:
            invocation.wait()
        except RuntimeError as launch_error:
            try:
                payload = json.loads(output)
            except json.JSONDecodeError:
                raise launch_error
            if not isinstance(payload, dict) or not payload.get("error"):
                raise launch_error
        return output
    finally:
        invocation.close()


def complete(prompt: str, timeout: float = 7200) -> str:
    if not apple_lm_experimental_enabled():
        raise RuntimeError(apple_lm_unavailable_message({"reason": "experimental_disabled"}))
    raw = _run_apple_lm(["complete"], stdin=prompt, timeout=timeout)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Apple Intelligence returned invalid output") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Apple Intelligence request failed")
    if payload.get("error"):
        raise RuntimeError(apple_lm_generation_error_message(payload.get("reason")))
    text = payload.get("text") or ""
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("Apple Intelligence returned an empty response")
    return text


def stream_complete(prompt: str, timeout: float = 7200) -> Iterator[str]:
    if not apple_lm_experimental_enabled():
        raise RuntimeError(apple_lm_unavailable_message({"reason": "experimental_disabled"}))
    binary = resolve_apple_lm_bin()
    if not binary:
        raise RuntimeError("Apple Intelligence helper is not available")
    helper_app = _helper_app_for_binary(binary)
    if helper_app is not None:
        yield from _stream_apple_lm_app(helper_app, prompt, timeout)
        return
    if not _direct_test_helper_allowed():
        raise RuntimeError("Apple Intelligence helper is not sandboxed")
    proc = subprocess.Popen(
        [binary, "stream"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin is not None
    assert proc.stdout is not None
    reader_thread: Optional[threading.Thread] = None
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
        deadline = time.monotonic() + timeout
        line_queue: queue.Queue[Optional[str]] = queue.Queue()

        def _reader():
            try:
                for line in proc.stdout:
                    line_queue.put(line)
            except Exception:
                pass
            finally:
                line_queue.put(None)

        reader_thread = threading.Thread(target=_reader, daemon=True)
        reader_thread.start()

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Apple Intelligence stream timed out")
            try:
                line = line_queue.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError("Apple Intelligence stream timed out")
            if line is None:
                break
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError("Apple Intelligence returned invalid output") from exc
            if not isinstance(rec, dict):
                raise RuntimeError("Apple Intelligence request failed")
            if rec.get("error"):
                raise RuntimeError(apple_lm_generation_error_message(rec.get("reason")))
            if rec.get("done"):
                return
            delta = rec.get("delta") or ""
            if delta:
                yield delta
        if proc.wait(timeout=5) not in (0, None):
            raise RuntimeError("Apple Intelligence request failed")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        if reader_thread is not None:
            reader_thread.join(timeout=1)
        proc.stdout.close()
        if proc.stderr is not None:
            proc.stderr.close()


def _stream_apple_lm_app(
    app: Path,
    prompt: str,
    timeout: float,
) -> Iterator[str]:
    invocation = _AppleLMAppInvocation(app, ["stream"], prompt)
    saw_done = False
    try:
        for line in invocation.iter_lines(timeout):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    "Apple Intelligence returned invalid output"
                ) from exc
            if not isinstance(rec, dict):
                raise RuntimeError("Apple Intelligence request failed")
            if rec.get("error"):
                raise RuntimeError(
                    apple_lm_generation_error_message(rec.get("reason"))
                )
            if rec.get("done"):
                saw_done = True
                break
            delta = rec.get("delta") or ""
            if delta:
                yield delta
        invocation.wait()
        if not saw_done:
            raise RuntimeError("Apple Intelligence request failed")
    finally:
        invocation.close()


def _run_apple_lm(
    args: list[str],
    *,
    stdin: Optional[str] = None,
    timeout: float = 30,
) -> str:
    binary = resolve_apple_lm_bin()
    if not binary:
        raise FileNotFoundError("steno-apple-lm not found")
    logger.info("apple-lm %s (%s chars stdin)", args[0] if args else "?", len(stdin or ""))
    helper_app = _helper_app_for_binary(binary)
    if helper_app is not None:
        return _run_apple_lm_app(
            helper_app,
            args,
            stdin=stdin,
            timeout=timeout,
        )
    if not _direct_test_helper_allowed():
        raise RuntimeError("Apple Intelligence helper is not sandboxed")
    try:
        proc = subprocess.run(
            [binary, *args],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError("Apple Intelligence timed out") from exc
    if proc.returncode != 0:
        try:
            payload = json.loads(proc.stdout or "")
        except json.JSONDecodeError:
            payload = None
        reason = payload.get("reason") if isinstance(payload, dict) else None
        raise RuntimeError(apple_lm_generation_error_message(reason))
    return (proc.stdout or "").strip()


class AppleLMClient:
    """Duck-types the Ollama ``Client.chat`` surface used by OllamaSummarizer."""

    def chat(self, *, stream: bool = False, messages=None, **_kwargs):
        prompt = ""
        if messages:
            last = messages[-1] or {}
            prompt = last.get("content") or ""
        if stream:
            return self._stream(prompt)
        return {"message": {"content": complete(prompt)}}

    def _stream(self, prompt: str):
        for delta in stream_complete(prompt):
            yield {"message": {"content": delta}}

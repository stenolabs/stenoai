"""Unit tests for Apple SystemLanguageModel integration."""

import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from click.testing import CliRunner

import simple_recorder
import src.config as config_module
from src.apple_lm import (
    APPLE_SYSTEM_MODEL,
    APPLE_LM_NUM_CTX,
    AppleLMClient,
    _AppleLMAppInvocation,
    _helper_app_for_binary,
    _run_apple_lm_app,
    apple_lm_generation_error_message,
    apple_lm_status,
    apple_lm_should_list,
    apple_system_model_info,
    apple_lm_unavailable_message,
    complete,
    is_apple_system_model,
    resolve_apple_lm_bin,
    reset_apple_lm_cache,
    stream_complete,
)
from src.config import Config
from src.summarizer import OllamaSummarizer, resolve_num_ctx


class BaseAppleLMTest(unittest.TestCase):
    def setUp(self):
        reset_apple_lm_cache()
        self._experiment = mock.patch.dict(os.environ, {"STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM": "1"})
        self._experiment.start()
        self.addCleanup(self._experiment.stop)
        self._old_config_instance = config_module._config_instance
        config_module._config_instance = None
        self._tmp_dir = tempfile.TemporaryDirectory()
        self._old_user_data = os.environ.get("STENOAI_USER_DATA_DIR")
        os.environ["STENOAI_USER_DATA_DIR"] = self._tmp_dir.name

    def tearDown(self):
        reset_apple_lm_cache()
        config_module._config_instance = self._old_config_instance
        if self._old_user_data is not None:
            os.environ["STENOAI_USER_DATA_DIR"] = self._old_user_data
        else:
            os.environ.pop("STENOAI_USER_DATA_DIR", None)
        self._tmp_dir.cleanup()


class AppleLMResolutionTests(BaseAppleLMTest):
    def test_experimental_gate_is_default_off_and_cannot_be_bypassed_by_fixture(self):
        for value in (None, "0", "true", "yes"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {
                "STENOAI_DISABLE_APPLE_LM": "0",
                "STENOAI_E2E": "1",
                "STENOAI_APPLE_LM_STATE_FILE": str(Path(self._tmp_dir.name) / "missing"),
            }), mock.patch("src.apple_lm.sys.platform", "darwin"), \
                 mock.patch("src.apple_lm._run_apple_lm") as run:
                if value is None:
                    os.environ.pop("STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM", None)
                else:
                    os.environ["STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM"] = value
                self.assertEqual(apple_lm_status(), {"available": False, "reason": "experimental_disabled"})
                self.assertIsNone(resolve_apple_lm_bin())
                self.assertFalse(apple_lm_should_list())
                self.assertTrue(apple_lm_should_list(selected=True))
                with self.assertRaisesRegex(RuntimeError, "experimental and disabled"):
                    complete("synthetic")
                with self.assertRaisesRegex(RuntimeError, "experimental and disabled"):
                    list(stream_complete("synthetic"))
                run.assert_not_called()

    def test_disabling_experiment_overrides_cached_available_status(self):
        with mock.patch.dict(os.environ, {
            "STENOAI_DISABLE_APPLE_LM": "0",
            "STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM": "0",
        }), mock.patch("src.apple_lm.sys.platform", "darwin"), \
             mock.patch("src.apple_lm._STATUS_CACHE", {"available": True}), \
             mock.patch("src.apple_lm._STATUS_CACHE_BIN", "/synthetic/helper"), \
             mock.patch("src.apple_lm.resolve_apple_lm_bin") as resolve:
            self.assertEqual(apple_lm_status()["reason"], "experimental_disabled")
        resolve.assert_not_called()

    def test_kill_switch_wins_over_experimental_opt_in(self):
        with mock.patch.dict(os.environ, {
            "STENOAI_DISABLE_APPLE_LM": "1",
            "STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM": "1",
        }):
            self.assertEqual(apple_lm_status()["reason"], "disabled")
            self.assertIsNone(resolve_apple_lm_bin())

    def test_is_apple_system_model(self):
        self.assertTrue(is_apple_system_model("apple:system"))
        self.assertFalse(is_apple_system_model("gemma4:e2b-it-qat"))
        self.assertFalse(is_apple_system_model(None))

    def test_helper_app_is_recognized_from_canonical_executable(self):
        binary = (
            Path("/Applications/Steno.app/Contents/Helpers")
            / "Steno Apple LM.app"
            / "Contents"
            / "MacOS"
            / "steno-apple-lm"
        )

        self.assertEqual(
            _helper_app_for_binary(str(binary)),
            Path("/Applications/Steno.app/Contents/Helpers/Steno Apple LM.app"),
        )
        self.assertIsNone(_helper_app_for_binary("/tmp/mock-steno-apple-lm"))

    def test_frozen_backend_resolves_nested_helper(self):
        executable = (
            "/Applications/Steno.app/Contents/Helpers/Steno Apple LM.app/"
            "Contents/MacOS/steno-apple-lm"
        )
        with mock.patch("src.apple_lm.sys.platform", "darwin"), mock.patch.object(
            sys,
            "frozen",
            True,
            create=True,
        ), mock.patch(
            "src.apple_lm.sys.executable",
            "/Applications/Steno.app/Contents/Resources/stenoai/stenoai",
        ), mock.patch(
            "src.apple_lm.os.access",
            side_effect=lambda path, _mode: str(path) == executable,
        ), mock.patch.dict(
            os.environ,
            {"STENOAI_DISABLE_APPLE_LM": "0"},
        ):
            self.assertEqual(resolve_apple_lm_bin(), executable)

    def test_relative_override_is_canonicalized(self):
        override = Path(self._tmp_dir.name) / "mock-steno-apple-lm"
        override.write_bytes(b"mock")
        relative = os.path.relpath(override, Path.cwd())

        with mock.patch("src.apple_lm.sys.platform", "darwin"), mock.patch(
            "src.apple_lm.os.access",
            side_effect=lambda path, _mode: Path(path).resolve() == override.resolve(),
        ), mock.patch.dict(
            os.environ,
            {
                "STENOAI_APPLE_LM_BIN": relative,
                "STENOAI_DISABLE_APPLE_LM": "0",
                "STENOAI_E2E": "1",
            },
        ):
            self.assertEqual(resolve_apple_lm_bin(), str(override.resolve()))

    def test_production_ignores_direct_binary_override(self):
        override = Path(self._tmp_dir.name) / "mock-steno-apple-lm"
        override.write_bytes(b"mock")
        override.chmod(0o755)

        with mock.patch("src.apple_lm.sys.platform", "darwin"), mock.patch.dict(
            os.environ,
            {
                "STENOAI_APPLE_LM_BIN": str(override),
                "STENOAI_DISABLE_APPLE_LM": "0",
                "STENOAI_E2E": "0",
            },
        ):
            self.assertNotEqual(resolve_apple_lm_bin(), str(override.resolve()))

    def test_frozen_backend_ignores_e2e_binary_override(self):
        override = Path(self._tmp_dir.name) / "mock-steno-apple-lm"
        override.write_bytes(b"mock")
        override.chmod(0o755)

        with mock.patch("src.apple_lm.sys.platform", "darwin"), mock.patch.object(
            sys,
            "frozen",
            True,
            create=True,
        ), mock.patch.dict(
            os.environ,
            {
                "STENOAI_APPLE_LM_BIN": str(override),
                "STENOAI_DISABLE_APPLE_LM": "0",
                "STENOAI_E2E": "1",
            },
        ):
            self.assertNotEqual(resolve_apple_lm_bin(), str(override.resolve()))

    def test_production_rejects_noncanonical_helper(self):
        with mock.patch(
            "src.apple_lm.resolve_apple_lm_bin",
            return_value="/tmp/mock-steno-apple-lm",
        ), mock.patch.dict(os.environ, {"STENOAI_E2E": "0"}), mock.patch(
            "src.apple_lm.subprocess.Popen"
        ) as popen:
            with self.assertRaisesRegex(RuntimeError, "not sandboxed"):
                list(stream_complete("synthetic prompt"))

        popen.assert_not_called()

    def test_unavailable_message_maps_fixed_reason(self):
        self.assertIn(
            "still downloading",
            apple_lm_unavailable_message({"available": False, "reason": "modelNotReady"}),
        )

    def test_pre_tahoe_status_does_not_start_sidecar(self):
        with mock.patch("src.apple_lm.sys.platform", "darwin"), \
             mock.patch("src.apple_lm.platform.mac_ver", return_value=("15.7", ("", "", ""), "")), \
             mock.patch.dict(os.environ, {"STENOAI_DISABLE_APPLE_LM": "0"}), \
             mock.patch("src.apple_lm._run_apple_lm") as run_sidecar:
            from src.apple_lm import apple_lm_status

            self.assertEqual(
                apple_lm_status(),
                {"available": False, "reason": "unsupported_os"},
            )
        run_sidecar.assert_not_called()

    def test_e2e_status_fixture_can_run_on_pre_tahoe_runner(self):
        state_file = Path(self._tmp_dir.name) / "unavailable"
        env = {
            "STENOAI_DISABLE_APPLE_LM": "0",
            "STENOAI_E2E": "1",
            "STENOAI_APPLE_LM_STATE_FILE": str(state_file),
        }
        with mock.patch("src.apple_lm.sys.platform", "darwin"), \
             mock.patch("src.apple_lm.platform.mac_ver", return_value=("15.7", ("", "", ""), "")), \
             mock.patch.dict(os.environ, env, clear=False), \
             mock.patch("src.apple_lm._run_apple_lm") as run_sidecar:
            from src.apple_lm import apple_lm_status

            self.assertEqual(
                apple_lm_status(),
                {"available": True, "display_name": "Apple Intelligence"},
            )
            state_file.write_text("", encoding="utf-8")
            self.assertEqual(
                apple_lm_status(),
                {"available": False, "reason": "appleIntelligenceNotEnabled"},
            )
        run_sidecar.assert_not_called()

    def test_production_ignores_e2e_status_fixture(self):
        env = {
            "STENOAI_DISABLE_APPLE_LM": "0",
            "STENOAI_E2E": "0",
            "STENOAI_APPLE_LM_STATE_FILE": str(
                Path(self._tmp_dir.name) / "missing"
            ),
        }
        with mock.patch("src.apple_lm.sys.platform", "darwin"), \
             mock.patch("src.apple_lm.platform.mac_ver", return_value=("15.7", ("", "", ""), "")), \
             mock.patch.dict(os.environ, env, clear=False), \
             mock.patch("src.apple_lm._run_apple_lm") as run_sidecar:
            self.assertEqual(
                apple_lm_status(),
                {"available": False, "reason": "unsupported_os"},
            )
        run_sidecar.assert_not_called()

    def test_transient_status_failure_is_not_cached(self):
        env = {"STENOAI_DISABLE_APPLE_LM": "0"}
        with mock.patch("src.apple_lm.sys.platform", "darwin"), mock.patch(
            "src.apple_lm.platform.mac_ver",
            return_value=("27.0", ("", "", ""), ""),
        ), mock.patch.dict(os.environ, env, clear=False), mock.patch(
            "src.apple_lm.resolve_apple_lm_bin",
            return_value="/tmp/steno-apple-lm",
        ), mock.patch(
            "src.apple_lm._run_apple_lm",
            side_effect=[
                RuntimeError("temporary launch failure"),
                json.dumps({"available": True}),
            ],
        ) as run_sidecar:
            self.assertEqual(
                apple_lm_status(),
                {"available": False, "reason": "sidecar_error"},
            )
            self.assertEqual(apple_lm_status(), {"available": True})

        self.assertEqual(run_sidecar.call_count, 2)

    def test_non_boolean_availability_is_rejected_and_not_cached(self):
        env = {"STENOAI_DISABLE_APPLE_LM": "0"}
        with mock.patch("src.apple_lm.sys.platform", "darwin"), mock.patch(
            "src.apple_lm.platform.mac_ver",
            return_value=("27.0", ("", "", ""), ""),
        ), mock.patch.dict(os.environ, env, clear=False), mock.patch(
            "src.apple_lm.resolve_apple_lm_bin",
            return_value="/tmp/steno-apple-lm",
        ), mock.patch(
            "src.apple_lm._run_apple_lm",
            side_effect=[
                json.dumps({"available": "false"}),
                json.dumps({"available": False, "reason": "modelNotReady"}),
            ],
        ) as run_sidecar:
            self.assertEqual(
                apple_lm_status(),
                {"available": False, "reason": "sidecar_error"},
            )
            self.assertEqual(
                apple_lm_status(),
                {"available": False, "reason": "modelNotReady"},
            )

        self.assertEqual(run_sidecar.call_count, 2)

    def test_apple_system_model_info_describes_os_managed_model(self):
        with mock.patch("src.apple_lm.apple_lm_status") as status:
            info = apple_system_model_info(is_default=True)
        self.assertIn("OS-managed", info["description"])
        self.assertNotIn("(selected)", info["description"])
        status.assert_not_called()

    def test_actionable_unavailability_is_listed(self):
        status = {"available": False, "reason": "appleIntelligenceNotEnabled"}
        self.assertTrue(apple_lm_should_list(status))
        self.assertFalse(
            apple_lm_should_list({"available": False, "reason": "unsupported_os"})
        )

    def test_generation_error_maps_fixed_reason(self):
        self.assertIn("declined", apple_lm_generation_error_message("refusal"))
        self.assertEqual(
            apple_lm_generation_error_message("unknown"),
            "Apple Intelligence request failed",
        )

    def test_complete_preserves_fixed_refusal_reason(self):
        payload = json.dumps({"error": "apple_lm_failed", "reason": "refusal"})
        with mock.patch("src.apple_lm._run_apple_lm", return_value=payload):
            with self.assertRaisesRegex(RuntimeError, "declined"):
                complete("synthetic prompt")

    def test_launch_services_preserves_helper_error_payload(self):
        payload = json.dumps(
            {"error": "apple_lm_failed", "reason": "guardrail"}
        )
        invocation = mock.Mock()
        invocation.iter_lines.return_value = iter([payload])
        invocation.wait.side_effect = RuntimeError("launcher failed")

        with mock.patch(
            "src.apple_lm._AppleLMAppInvocation",
            return_value=invocation,
        ):
            self.assertEqual(
                _run_apple_lm_app(
                    Path("/tmp/Steno Apple LM.app"),
                    ["complete"],
                    stdin="synthetic prompt",
                    timeout=30,
                ),
                payload,
            )

        invocation.close.assert_called_once_with()

    @unittest.skipIf(sys.platform == "win32", "LaunchServices fixture uses FIFOs")
    def test_launch_services_adds_private_cleanup_identity(self):
        launcher = mock.Mock()
        launcher.poll.return_value = 0
        launcher.stderr = None
        with mock.patch.object(_AppleLMAppInvocation, "_write_prompt"), \
             mock.patch.object(_AppleLMAppInvocation, "_read_stdout"), \
             mock.patch.object(_AppleLMAppInvocation, "_read_stderr"), \
             mock.patch("src.apple_lm.subprocess.Popen", return_value=launcher) as popen:
            invocation = _AppleLMAppInvocation(
                Path("/tmp/Steno Apple LM.app"),
                ["complete"],
                "synthetic prompt",
            )
            command = popen.call_args.args[0]
            try:
                self.assertIn(
                    f"STENOAI_APPLE_LM_LEASE_FILE={invocation._lease_path}",
                    command,
                )
                self.assertIn(invocation._invocation_token, command)
            finally:
                invocation.close()

    @unittest.skipIf(sys.platform == "win32", "POSIX kill-signal fixture")
    def test_cleanup_finds_token_process_when_pid_report_is_missing(self):
        invocation = _AppleLMAppInvocation.__new__(_AppleLMAppInvocation)
        invocation._helper_pid = None
        invocation._helper_pid_ready = mock.Mock()
        invocation._launcher = mock.Mock()
        invocation._launcher.poll.return_value = None
        invocation._launcher.wait.side_effect = [
            subprocess.TimeoutExpired("open", 2),
            None,
        ]
        invocation._launcher.stderr = None
        invocation._matching_invocation_pids = mock.Mock(
            side_effect=[{4321}, {4321}]
        )
        invocation._unblock_fifos = mock.Mock()
        invocation._join_threads = mock.Mock()
        invocation._temp_dir = mock.Mock()
        with tempfile.TemporaryDirectory() as tmp:
            invocation._lease_path = Path(tmp) / "lease"
            invocation._lease_path.write_text("active", encoding="utf-8")
            with mock.patch("src.apple_lm.os.kill") as kill:
                invocation.close()
            self.assertFalse(invocation._lease_path.exists())

        self.assertEqual(
            kill.call_args_list,
            [
                mock.call(4321, signal.SIGTERM),
                mock.call(4321, signal.SIGKILL),
            ],
        )
        invocation._launcher.kill.assert_called_once_with()

    def test_launch_services_preserves_launcher_failure(self):
        invocation = mock.Mock()
        invocation.iter_lines.return_value = iter([])
        invocation.wait.side_effect = RuntimeError("launcher failed")

        with mock.patch(
            "src.apple_lm._AppleLMAppInvocation",
            return_value=invocation,
        ):
            with self.assertRaisesRegex(RuntimeError, "launcher failed"):
                _run_apple_lm_app(
                    Path("/tmp/Steno Apple LM.app"),
                    ["status"],
                    stdin=None,
                    timeout=30,
                )

        invocation.close.assert_called_once_with()

    def test_complete_uses_launch_services_for_helper_app(self):
        app = Path(self._tmp_dir.name) / "Steno Apple LM.app"
        binary = app / "Contents" / "MacOS" / "steno-apple-lm"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"helper")
        binary.chmod(0o755)

        with mock.patch(
            "src.apple_lm.resolve_apple_lm_bin",
            return_value=str(binary),
        ), mock.patch(
            "src.apple_lm._run_apple_lm_app",
            return_value=json.dumps({"text": "Sandboxed response"}),
        ) as run_app, mock.patch("src.apple_lm.subprocess.run") as run_direct:
            self.assertEqual(complete("synthetic prompt"), "Sandboxed response")

        run_app.assert_called_once_with(
            app,
            ["complete"],
            stdin="synthetic prompt",
            timeout=7200,
        )
        run_direct.assert_not_called()

    def test_nonzero_sidecar_preserves_fixed_guardrail_reason(self):
        failed = subprocess.CompletedProcess(
            args=["steno-apple-lm", "complete"],
            returncode=1,
            stdout=json.dumps(
                {"error": "apple_lm_failed", "reason": "guardrail"}
            ),
            stderr="",
        )
        with mock.patch("src.apple_lm.resolve_apple_lm_bin", return_value="sidecar"), \
             mock.patch.dict(os.environ, {"STENOAI_E2E": "1"}), \
             mock.patch("src.apple_lm.subprocess.run", return_value=failed):
            with self.assertRaisesRegex(RuntimeError, "could not process"):
                complete("synthetic prompt")

    @unittest.skipIf(sys.platform == "win32", "POSIX executable fixture")
    def test_stream_timeout_terminates_sidecar_process(self):
        script = Path(self._tmp_dir.name) / "slow-apple-lm"
        script.write_text(
            f"#!{sys.executable}\n"
            "import sys, time\n"
            "sys.stdin.read()\n"
            "time.sleep(30)\n"
        )
        script.chmod(0o755)
        captured = []
        real_popen = subprocess.Popen

        def capture_process(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            captured.append(proc)
            return proc

        with mock.patch("src.apple_lm.resolve_apple_lm_bin", return_value=str(script)), \
             mock.patch.dict(os.environ, {"STENOAI_E2E": "1"}), \
             mock.patch("src.apple_lm.subprocess.Popen", side_effect=capture_process):
            with self.assertRaisesRegex(TimeoutError, "stream timed out"):
                list(stream_complete("synthetic prompt", timeout=0.05))

        self.assertEqual(len(captured), 1)
        self.assertIsNotNone(captured[0].poll())

    def test_stream_uses_launch_services_for_helper_app(self):
        app = Path(self._tmp_dir.name) / "Steno Apple LM.app"
        binary = app / "Contents" / "MacOS" / "steno-apple-lm"

        with mock.patch(
            "src.apple_lm.resolve_apple_lm_bin",
            return_value=str(binary),
        ), mock.patch(
            "src.apple_lm._stream_apple_lm_app",
            return_value=iter(["Hello", " world"]),
        ) as stream_app, mock.patch("src.apple_lm.subprocess.Popen") as popen:
            self.assertEqual(
                list(stream_complete("synthetic prompt")),
                ["Hello", " world"],
            )

        stream_app.assert_called_once_with(app, "synthetic prompt", 7200)
        popen.assert_not_called()


class AppleLMConfigOptInTests(BaseAppleLMTest):
    def test_fresh_config_does_not_probe_or_adopt_apple_system(self):
        cfg_path = Path(self._tmp_dir.name) / "config.json"
        with mock.patch("src.apple_lm.apple_lm_available") as available, \
             mock.patch("src.apple_lm.apple_lm_status") as status:
            config = Config(config_path=cfg_path)
        self.assertEqual(config.get_model(), Config.DEFAULT_MODEL)
        available.assert_not_called()
        status.assert_not_called()

    def test_existing_auto_config_is_not_changed_when_apple_is_available(self):
        cfg_path = Path(self._tmp_dir.name) / "config.json"
        cfg_path.write_text(json.dumps({
            "model": Config.DEFAULT_MODEL,
            "summary_model_source": "auto",
        }))
        with mock.patch(
            "src.apple_lm.apple_lm_available",
            return_value=True,
        ) as available, mock.patch("src.apple_lm.apple_lm_status") as status:
            config = Config(config_path=cfg_path)
        self.assertEqual(config.get_model(), Config.DEFAULT_MODEL)
        available.assert_not_called()
        status.assert_not_called()

    def test_existing_config_without_model_source_is_preserved_as_user_choice(self):
        cfg_path = Path(self._tmp_dir.name) / "config.json"
        cfg_path.write_text(json.dumps({"model": "qwen3.5:9b"}))

        config = Config(config_path=cfg_path)

        self.assertEqual(config.get_model(), "qwen3.5:9b")
        self.assertEqual(config.get("summary_model_source"), "user")
        self.assertEqual(
            json.loads(cfg_path.read_text())["summary_model_source"],
            "user",
        )

    def test_fresh_config_marks_setup_model_as_automatic(self):
        config = Config(config_path=Path(self._tmp_dir.name) / "config.json")

        self.assertEqual(config.get("summary_model_source"), "auto")

    def test_explicit_apple_choice_survives_temporary_unavailability(self):
        cfg_path = Path(self._tmp_dir.name) / "config.json"
        cfg_path.write_text(json.dumps({"model": APPLE_SYSTEM_MODEL, "summary_model_source": "user"}))
        with mock.patch("src.apple_lm.apple_lm_available", return_value=False):
            config = Config(config_path=cfg_path)
        self.assertEqual(config.get_model(), APPLE_SYSTEM_MODEL)

    def test_explicit_user_choice_is_not_overwritten_by_auto_adoption(self):
        cfg_path = Path(self._tmp_dir.name) / "config.json"
        cfg_path.write_text(json.dumps({"model": "qwen3.5:9b", "summary_model_source": "user"}))
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            config = Config(config_path=cfg_path)
            self.assertEqual(config.get_model(), "qwen3.5:9b")

    def test_get_model_info_returns_apple_metadata(self):
        with mock.patch("src.apple_lm.apple_lm_status") as status:
            config = Config(config_path=Path(self._tmp_dir.name) / "config.json")
            info = config.get_model_info(APPLE_SYSTEM_MODEL)
        self.assertIsNotNone(info)
        self.assertEqual(info["name"], "Apple Intelligence (Experimental)")
        self.assertEqual(info["quality"], "experimental")
        self.assertIn("may omit facts or invent details", info["description"])
        self.assertEqual(info["params"], "OS-managed")
        status.assert_not_called()


class AppleLMSummarizerIntegrationTests(BaseAppleLMTest):
    def test_resolve_num_ctx_for_apple_system(self):
        self.assertEqual(resolve_num_ctx(APPLE_SYSTEM_MODEL), APPLE_LM_NUM_CTX)

    def test_summarizer_initializes_apple_client_without_ollama(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL

        with mock.patch("src.summarizer.OLLAMA_AVAILABLE", False), \
             mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True}):
            summarizer = OllamaSummarizer(config=cfg)
            self.assertTrue(summarizer._using_apple_lm())
            self.assertIsInstance(summarizer.client, AppleLMClient)
            self.assertTrue(summarizer._ensure_ollama_ready())
    def test_apple_lm_client_chat(self):
        client = AppleLMClient()
        with mock.patch("src.apple_lm.complete", return_value="Summary of meeting"):
            res = client.chat(messages=[{"role": "user", "content": "summarize"}])
            self.assertEqual(res, {"message": {"content": "Summary of meeting"}})

    def test_apple_lm_client_stream(self):
        client = AppleLMClient()
        with mock.patch("src.apple_lm.stream_complete", return_value=iter(["Hello", " world"])):
            stream = client.chat(stream=True, messages=[{"role": "user", "content": "hi"}])
            chunks = [c["message"]["content"] for c in stream]
            self.assertEqual(chunks, ["Hello", " world"])

    def test_set_model_switches_from_apple_to_ollama_client(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "local"
        summarizer.model_name = APPLE_SYSTEM_MODEL
        summarizer.client = AppleLMClient()
        next_client = mock.Mock()
        next_client.list.return_value.models = [mock.Mock(model="qwen3.5:9b")]

        with mock.patch("src.summarizer.OLLAMA_AVAILABLE", True), mock.patch(
            "src.summarizer.resolve_runtime_tag", return_value="qwen3.5:9b"
        ), mock.patch.object(
            summarizer, "_is_ollama_running", return_value=True
        ) as running, mock.patch(
            "src.summarizer.ollama.Client", return_value=next_client
        ):
            self.assertTrue(summarizer.set_model("qwen3.5:9b"))

        running.assert_called_once_with()
        self.assertEqual(summarizer.model_name, "qwen3.5:9b")
        self.assertIs(summarizer.client, next_client)

    def test_set_model_switches_from_ollama_to_available_apple(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "local"
        summarizer.model_name = "qwen3.5:9b"
        summarizer.client = mock.Mock()

        with mock.patch(
            "src.apple_lm.apple_lm_status", return_value={"available": True}
        ):
            self.assertTrue(summarizer.set_model(APPLE_SYSTEM_MODEL))

        self.assertEqual(summarizer.model_name, APPLE_SYSTEM_MODEL)
        self.assertIsInstance(summarizer.client, AppleLMClient)

    def test_set_model_rejects_apple_for_remote_provider(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "remote"
        summarizer.model_name = "qwen3.5:9b"
        summarizer.client = mock.Mock()

        self.assertFalse(summarizer.set_model(APPLE_SYSTEM_MODEL))

        self.assertEqual(summarizer.model_name, "qwen3.5:9b")
        summarizer.client.list.assert_not_called()

    def test_set_model_keeps_apple_when_ollama_switch_fails(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "local"
        summarizer.model_name = APPLE_SYSTEM_MODEL
        apple_client = AppleLMClient()
        summarizer.client = apple_client

        with mock.patch("src.summarizer.OLLAMA_AVAILABLE", True), mock.patch(
            "src.summarizer.resolve_runtime_tag", return_value="qwen3.5:9b"
        ), mock.patch.object(
            summarizer, "_is_ollama_running", return_value=False
        ), mock.patch.object(
            summarizer, "_start_ollama_service", return_value=False
        ):
            self.assertFalse(summarizer.set_model("qwen3.5:9b"))

        self.assertEqual(summarizer.model_name, APPLE_SYSTEM_MODEL)
        self.assertIs(summarizer.client, apple_client)

    def test_set_model_does_not_substitute_fallback_when_leaving_apple(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "local"
        summarizer.model_name = APPLE_SYSTEM_MODEL
        apple_client = AppleLMClient()
        summarizer.client = apple_client
        next_client = mock.Mock()
        next_client.list.return_value.models = [mock.Mock(model="gemma4:e2b-it-qat")]

        with mock.patch("src.summarizer.OLLAMA_AVAILABLE", True), mock.patch(
            "src.summarizer.resolve_runtime_tag", return_value="missing:model"
        ), mock.patch.object(
            summarizer, "_is_ollama_running", return_value=True
        ), mock.patch(
            "src.summarizer.ollama.Client", return_value=next_client
        ):
            self.assertFalse(summarizer.set_model("missing:model"))

        self.assertEqual(summarizer.model_name, APPLE_SYSTEM_MODEL)
        self.assertIs(summarizer.client, apple_client)

    def test_apple_failure_does_not_retry_ignored_think_option(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "local"
        summarizer.model_name = APPLE_SYSTEM_MODEL
        client = mock.Mock()
        client.chat.side_effect = RuntimeError("synthetic failure")

        with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
            summarizer._chat_no_think(
                client,
                model=APPLE_SYSTEM_MODEL,
                messages=[{"role": "user", "content": "prompt"}],
            )

        client.chat.assert_called_once()
        self.assertNotIn("think", client.chat.call_args.kwargs)

    def test_apple_stream_failure_does_not_retry_ignored_think_option(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "local"
        summarizer.model_name = APPLE_SYSTEM_MODEL
        client = mock.Mock()

        def failed_stream():
            raise RuntimeError("synthetic stream failure")
            yield

        client.chat.return_value = failed_stream()
        with self.assertRaisesRegex(RuntimeError, "synthetic stream failure"):
            list(
                summarizer._chat_stream_no_think(
                    client,
                    model=APPLE_SYSTEM_MODEL,
                    messages=[{"role": "user", "content": "prompt"}],
                )
            )

        client.chat.assert_called_once()
        self.assertNotIn("think", client.chat.call_args.kwargs)

    def test_generate_title_routes_through_apple_lm(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL
        cfg.get_language_name.return_value = "English"

        with mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True}):
            summarizer = OllamaSummarizer(config=cfg)
            with mock.patch("src.apple_lm.complete", return_value="Project Kickoff"):
                title = summarizer.generate_title("Summary here", "transcript")
                self.assertEqual(title, "Project Kickoff")

    def test_summarizer_fails_visibly_when_apple_configured_but_unavailable(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL
        cfg.DEFAULT_MODEL = "gemma4:e2b-it-qat"

        status = {"available": False, "reason": "appleIntelligenceNotEnabled"}
        with mock.patch("src.apple_lm.apple_lm_status", return_value=status), \
             mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready") as ensure, \
             mock.patch("ollama.Client") as ollama_client:
            with self.assertRaisesRegex(RuntimeError, "Enable Apple Intelligence"):
                OllamaSummarizer(config=cfg)
        ensure.assert_not_called()
        ollama_client.assert_not_called()

    def test_remote_provider_rejects_preserved_apple_model(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "remote"
        cfg.get_remote_ollama_url.return_value = "http://192.0.2.10:11434"
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL

        with mock.patch("src.summarizer.OLLAMA_AVAILABLE", True), mock.patch(
            "src.summarizer.ollama.Client"
        ) as ollama_client:
            with self.assertRaisesRegex(ValueError, "local AI provider"):
                OllamaSummarizer(config=cfg)

        ollama_client.assert_not_called()

    def test_query_transcript_ollama_retry_is_bounded(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = "gemma4:e2b-it-qat"
        cfg.DEFAULT_MODEL = "gemma4:e2b-it-qat"

        client = mock.MagicMock()
        client.chat.side_effect = RuntimeError("synthetic failure")
        with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready"), \
             mock.patch("src.summarizer.ollama.Client", return_value=client), \
             mock.patch("src.summarizer.time.sleep"):
            summarizer = OllamaSummarizer(config=cfg)
            res = summarizer.query_transcript("Transcript", "Question?")
        self.assertIsNone(res)
        self.assertEqual(client.chat.call_count, 2)

    def test_batch_failure_does_not_retry_or_switch_apple_client(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL

        payload = json.dumps({"overview": "Summary", "participants": []})
        with mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True}), \
             mock.patch("src.summarizer.time.sleep"), \
             mock.patch("src.summarizer.ollama.Client") as ollama_client:
            summarizer = OllamaSummarizer(config=cfg)
            apple_client = summarizer.client
            with mock.patch.object(
                apple_client,
                "chat",
                side_effect=[
                    RuntimeError("first call failed"),
                    {"message": {"content": payload}},
                ],
            ) as chat:
                result = summarizer.summarize_transcript("Transcript", 1)

        self.assertIsNone(result)
        self.assertEqual(chat.call_count, 1)
        self.assertIs(summarizer.client, apple_client)
        ollama_client.assert_not_called()

    def test_long_legacy_batch_summary_rejects_before_generation(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "local"
        summarizer.model_name = APPLE_SYSTEM_MODEL
        summarizer.client = mock.Mock()
        with self.assertRaisesRegex(ValueError, "only short transcripts"):
            summarizer.summarize_transcript("X" * 2001, 30)
        summarizer.client.chat.assert_not_called()

    def test_connection_checks_apple_availability_without_ollama_list(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL

        with mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True}):
            summarizer = OllamaSummarizer(config=cfg)
            with mock.patch.object(summarizer.client, "list", create=True) as list_models:
                self.assertTrue(summarizer.test_connection())
        list_models.assert_not_called()

    def test_generate_title_passes_timeout_to_complete(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL
        cfg.get_language_name.return_value = "English"

        with mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True}):
            summarizer = OllamaSummarizer(config=cfg)
            with mock.patch("src.apple_lm.complete", return_value="Project Title") as mock_complete:
                title = summarizer.generate_title("Summary here", "transcript")
                self.assertEqual(title, "Project Title")
                mock_complete.assert_called_once()
                self.assertEqual(mock_complete.call_args.kwargs.get("timeout"), 90)

    def _short_input_summarizer(self):
        s = OllamaSummarizer.__new__(OllamaSummarizer)
        s.ai_provider = "local"
        s.model_name = APPLE_SYSTEM_MODEL
        s.config = mock.Mock()
        s.client = mock.Mock()
        return s

    def test_apple_transcript_byte_boundary_preserves_entire_direct_input(self):
        for transcript in ("A" * 1999, "A" * 2000, "ä" * 1000, "🙂" * 500):
            with self.subTest(byte_count=len(transcript.encode("utf-8"))):
                s = self._short_input_summarizer()
                with mock.patch.object(s, "_stream_completion", return_value=iter(["summary"])) as stream, \
                     mock.patch.object(s, "_map_reduce_streaming") as reduce:
                    self.assertEqual("".join(s.summarize_transcript_streaming(transcript)), "summary")
                self.assertIn(transcript, stream.call_args.args[0])
                stream.assert_called_once()
                reduce.assert_not_called()

    def test_apple_rejects_oversize_transcript_notes_and_template_without_generation(self):
        cases = [
            ("A" * 2001, None, None),
            ("ä" * 1001, None, None),
            ("🙂" * 501, None, None),
            ("short", "notes " * 1000, None),
            ("short", None, "template " * 1000),
        ]
        for transcript, notes, template in cases:
            with self.subTest(notes=bool(notes), template=bool(template)):
                s = self._short_input_summarizer()
                with mock.patch("src.apple_lm.complete") as complete, \
                     mock.patch("src.apple_lm.stream_complete") as stream, \
                     mock.patch("src.summarizer.ollama.Client") as ollama_client, \
                     mock.patch.object(s, "_map_reduce_streaming") as reduce:
                    with self.assertRaisesRegex(ValueError, "No model was switched automatically"):
                        list(s.summarize_transcript_streaming(transcript, notes=notes, template_prompt=template))
                complete.assert_not_called()
                stream.assert_not_called()
                ollama_client.assert_not_called()
                reduce.assert_not_called()
                s.config.set_model.assert_not_called()
                self.assertEqual(s.model_name, APPLE_SYSTEM_MODEL)

    def test_combined_byte_boundary_counts_notes_and_templates(self):
        s = self._short_input_summarizer()
        for template in (None, "Write a factual report."):
            template_size = len((template or "").encode("utf-8"))
            notes = "N" * (2000 - len("short") - template_size)
            for size in (1999, 2000, 2001):
                value = notes[:len(notes) - 1] if size == 1999 else notes + ("x" if size == 2001 else "")
                with self.subTest(size=size, template=bool(template)):
                    with mock.patch.object(s, "_stream_completion", return_value=iter(["report"])) as stream:
                        if size > 2000:
                            with self.assertRaisesRegex(ValueError, "only short transcripts"):
                                list(s.summarize_transcript_streaming("short", notes=value, template_prompt=template))
                            stream.assert_not_called()
                        else:
                            list(s.summarize_transcript_streaming("short", notes=value, template_prompt=template))
                            self.assertIn(value, stream.call_args.args[0])

    def test_full_prompt_byte_boundary_is_checked_independently(self):
        s = self._short_input_summarizer()
        for size in (4999, 5000, 5001):
            with self.subTest(size=size):
                # A future formatting/language scaffold must not bypass the
                # complete-prompt guard even with tiny user inputs.
                with mock.patch.object(s, "_create_markdown_prompt", return_value="x" * size), \
                     mock.patch.object(s, "_stream_completion", return_value=iter(["summary"])) as stream:
                    if size > 5000:
                        with self.assertRaisesRegex(ValueError, "only short transcripts"):
                            list(s.summarize_transcript_streaming("short"))
                        stream.assert_not_called()
                    else:
                        list(s.summarize_transcript_streaming("short"))
                        stream.assert_called_once()

    def test_timestamp_removal_and_apple_fact_instruction(self):
        s = self._short_input_summarizer()
        with mock.patch.object(s, "_stream_completion", return_value=iter(["summary"])) as stream:
            list(s.summarize_transcript_streaming("[01:00] " + "A" * 2000))
        self.assertNotIn("[01:00]", stream.call_args.args[0])
        self.assertIn("Pending tasks stay pending", stream.call_args.args[0])

    def test_legacy_batch_rejects_large_notes_without_calling_model(self):
        s = self._short_input_summarizer()
        with self.assertRaisesRegex(ValueError, "only short transcripts"):
            s.summarize_transcript("short", 1, notes="N" * 5000)
        s.client.chat.assert_not_called()

    def test_non_apple_summary_limit_is_unchanged(self):
        for provider in ("local", "remote", "cloud", "adapter"):
            with self.subTest(provider=provider):
                s = self._short_input_summarizer()
                s.ai_provider = provider
                s.model_name = "gemma4:e2b-it-qat"
                transcript = "X" * 6000
                with mock.patch.object(s, "_needs_chunking", return_value=False), \
                     mock.patch.object(s, "_stream_completion", return_value=iter(["summary"])) as stream:
                    self.assertEqual("".join(s.summarize_transcript_streaming(transcript)), "summary")
                self.assertIn(transcript, stream.call_args.args[0])

    def test_apple_query_prompt_bounds_long_transcript_and_keeps_edges(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.model_name = APPLE_SYSTEM_MODEL
        transcript = "HEAD-NEEDLE\n" + "M" * 30_000 + "\nTAIL-NEEDLE"

        prompt = summarizer._build_bounded_apple_query_prompt(
            transcript, "What changed?"
        )

        self.assertLessEqual(len(prompt), summarizer._apple_input_budget_chars())
        self.assertIn("HEAD-NEEDLE", prompt)
        self.assertIn("TAIL-NEEDLE", prompt)
        self.assertIn("middle of transcript omitted", prompt)

    def test_both_apple_query_paths_use_bounded_prompt(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        summarizer.ai_provider = "local"
        summarizer.model_name = APPLE_SYSTEM_MODEL
        transcript = "H" * 30_000 + "TAIL"
        prompts = []

        def fake_stream(prompt, timeout=300):
            prompts.append(prompt)
            return iter(["streamed"])

        def fake_complete(prompt, timeout=120):
            prompts.append(prompt)
            return "complete"

        with mock.patch("src.apple_lm.stream_complete", side_effect=fake_stream), \
             mock.patch("src.apple_lm.complete", side_effect=fake_complete):
            self.assertEqual(
                "".join(summarizer.query_transcript_streaming(transcript, "Question?")),
                "streamed",
            )
            self.assertEqual(
                summarizer.query_transcript(transcript, "Question?"),
                "complete",
            )

        self.assertEqual(len(prompts), 2)
        self.assertTrue(
            all(len(prompt) <= summarizer._apple_input_budget_chars() for prompt in prompts)
        )
        self.assertTrue(all("middle of transcript omitted" in prompt for prompt in prompts))

    def test_query_prompt_preserves_uncertainty_and_empty_content_rules(self):
        summarizer = OllamaSummarizer.__new__(OllamaSummarizer)

        prompt = summarizer._build_query_prompt("Transcript", "Question?")

        self.assertIn("Only say you don't know if the topic truly wasn't discussed", prompt)
        self.assertIn("contains no speech", prompt)


class AppleLMCLITests(BaseAppleLMTest):
    def test_set_model_rejects_unavailable_apple_system(self):
        config = mock.Mock()
        config.get_ai_provider.return_value = "local"
        status = {"available": False, "reason": "appleIntelligenceNotEnabled"}
        with mock.patch("src.config.get_config", return_value=config), mock.patch(
            "src.apple_lm.apple_lm_status", return_value=status
        ):
            result = CliRunner().invoke(
                simple_recorder.set_model,
                [APPLE_SYSTEM_MODEL],
            )

        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            json.loads(result.output),
            {
                "success": False,
                "error": "Enable Apple Intelligence in System Settings before selecting this model.",
            },
        )
        config.set_model.assert_not_called()

    def test_set_model_accepts_available_apple_system(self):
        config = mock.Mock()
        config.get_ai_provider.return_value = "local"
        config.SUPPORTED_MODELS = {}
        config.set_model.return_value = True
        with mock.patch("src.config.get_config", return_value=config), mock.patch(
            "src.apple_lm.apple_lm_status", return_value={"available": True}
        ):
            result = CliRunner().invoke(
                simple_recorder.set_model,
                [APPLE_SYSTEM_MODEL],
            )

        self.assertEqual(result.exit_code, 0, result.output)
        config.set_model.assert_called_once_with(APPLE_SYSTEM_MODEL)

    def test_set_model_rejects_apple_system_for_remote_provider(self):
        config = mock.Mock()
        config.get_ai_provider.return_value = "remote"
        with mock.patch("src.config.get_config", return_value=config), mock.patch(
            "src.apple_lm.apple_lm_status"
        ) as status:
            result = CliRunner().invoke(
                simple_recorder.set_model,
                [APPLE_SYSTEM_MODEL],
            )

        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            json.loads(result.output),
            {
                "success": False,
                "error": "Apple Intelligence can only be used with the local AI provider.",
            },
        )
        status.assert_not_called()
        config.set_model.assert_not_called()

    def test_set_ai_provider_rejects_remote_while_apple_system_is_selected(self):
        config = mock.Mock()
        config.VALID_AI_PROVIDERS = {"local", "remote", "cloud"}
        config.get_model.return_value = APPLE_SYSTEM_MODEL
        with mock.patch("src.config.get_config", return_value=config):
            result = CliRunner().invoke(
                simple_recorder.set_ai_provider,
                ["remote"],
            )

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(
            json.loads(result.output),
            {
                "success": False,
                "error": "Choose an Ollama model before switching to the remote AI provider.",
            },
        )
        config.set_ai_provider.assert_not_called()

    def test_list_models_prepends_apple_system_when_available(self):
        with mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True}), \
             mock.patch("src.config.Config.get_model", return_value=APPLE_SYSTEM_MODEL), \
             mock.patch("ollama.list", return_value=mock.Mock(models=[])):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.list_models)
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertIn(APPLE_SYSTEM_MODEL, data["supported_models"])
            self.assertTrue(data["supported_models"][APPLE_SYSTEM_MODEL]["installed"])
            self.assertFalse(data["supported_models"][APPLE_SYSTEM_MODEL]["deletable"])
            self.assertFalse(data["supported_models"][APPLE_SYSTEM_MODEL]["downloadable"])

    def test_list_models_shows_apple_system_not_installed_when_unavailable(self):
        status = {"available": False, "reason": "appleIntelligenceNotEnabled"}
        with mock.patch("src.apple_lm.apple_lm_status", return_value=status), \
             mock.patch("src.config.Config.get_model", return_value=APPLE_SYSTEM_MODEL), \
             mock.patch("ollama.list", return_value=mock.Mock(models=[])):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.list_models)
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertIn(APPLE_SYSTEM_MODEL, data["supported_models"])
            self.assertFalse(data["supported_models"][APPLE_SYSTEM_MODEL]["installed"])

    def test_list_models_offers_actionable_unavailable_apple_system(self):
        status = {"available": False, "reason": "appleIntelligenceNotEnabled"}
        with mock.patch("src.apple_lm.apple_lm_status", return_value=status), \
             mock.patch("src.config.Config.get_model", return_value=Config.DEFAULT_MODEL), \
             mock.patch("ollama.list", return_value=mock.Mock(models=[])):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.list_models)
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            apple = data["supported_models"][APPLE_SYSTEM_MODEL]
            self.assertFalse(apple["installed"])
            self.assertFalse(apple["selectable"])
            self.assertFalse(apple["downloadable"])
            self.assertIn("Enable Apple Intelligence", apple["description"])

    def test_list_models_hides_apple_system_on_unsupported_os(self):
        status = {"available": False, "reason": "unsupported_os"}
        with mock.patch("src.apple_lm.apple_lm_status", return_value=status), \
             mock.patch("src.config.Config.get_model", return_value=Config.DEFAULT_MODEL), \
             mock.patch("ollama.list", return_value=mock.Mock(models=[])):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.list_models)
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertNotIn(APPLE_SYSTEM_MODEL, data["supported_models"])

    def test_check_model_for_apple_system(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.check_model, [APPLE_SYSTEM_MODEL])
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertTrue(data["installed"])

    def test_pull_model_for_apple_system_succeeds_when_available(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.pull_model, [APPLE_SYSTEM_MODEL])
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertTrue(data["success"])

    def test_delete_model_refuses_apple_system(self):
        runner = CliRunner()
        result = runner.invoke(simple_recorder.delete_model, [APPLE_SYSTEM_MODEL])
        self.assertEqual(result.exit_code, 0)
        data = json.loads(result.output)
        self.assertFalse(data["success"])
        self.assertIn("Cannot delete", data["error"])

    def test_resolve_setup_model_does_not_auto_select_apple_system(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True), \
             mock.patch("src.ollama_manager.start_ollama_server") as start_ollama, \
             mock.patch("ollama.list", return_value=mock.Mock(models=[])):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.resolve_setup_model)
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertIsNone(data["installed"])
            self.assertIsNotNone(data["pull_target"])
            start_ollama.assert_not_called()

    def test_setup_check_reports_apple_system_model(self):
        with mock.patch("sys.platform", "darwin"), \
             mock.patch("src.config.Config.get_model", return_value=APPLE_SYSTEM_MODEL), \
             mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True}), \
             mock.patch("simple_recorder._run_speaker_model_command", return_value={"success": False}), \
             mock.patch("src.ollama_manager.get_ollama_binary", return_value=Path("/tmp/ollama")), \
             mock.patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0)):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.setup_check, ["--json"])
            self.assertEqual(result.exit_code, 0)
            lines = [line for line in result.output.splitlines() if line.strip().startswith("{")]
            data = json.loads(lines[0])
            llm_check = next((c for c in data["checks"] if c["name"] == "llm-model"), None)
            self.assertIsNotNone(llm_check)
            self.assertEqual(llm_check["status"], "pass")
            self.assertIn("Apple System Language Model (available)", llm_check["detail"])


if __name__ == "__main__":
    unittest.main()

"""Unit tests for Apple SystemLanguageModel (Advanced / 3B Core) integration."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from click.testing import CliRunner

# `python -m unittest discover tests` uses tests/ as top_level_dir, so
# tests/__init__.py is never imported. Seed isolation here — this module is
# alphabetically first among test_*.py — before any src.apple_lm import.
os.environ.setdefault("STENOAI_DISABLE_APPLE_LM", "1")

import simple_recorder
from src.apple_lm import (
    APPLE_SYSTEM_MODEL,
    APPLE_LM_NUM_CTX,
    AppleLMClient,
    apple_system_model_info,
    is_apple_system_model,
    reset_apple_lm_cache,
    resolve_default_summary_model,
)
from src.config import Config
from src.summarizer import OllamaSummarizer, resolve_num_ctx


class BaseAppleLMTest(unittest.TestCase):
    def setUp(self):
        # Save both env keys before any test body (including the one that
        # patch.dict-flips STENOAI_DISABLE_APPLE_LM to "0" at line 57-era).
        self._old_disable = os.environ.get("STENOAI_DISABLE_APPLE_LM")
        self._old_user_data = os.environ.get("STENOAI_USER_DATA_DIR")
        reset_apple_lm_cache()
        self._tmp_dir = tempfile.TemporaryDirectory()
        os.environ["STENOAI_USER_DATA_DIR"] = self._tmp_dir.name
        self.addCleanup(self._restore_apple_lm_isolation)

    def tearDown(self):
        reset_apple_lm_cache()

    def _restore_apple_lm_isolation(self):
        reset_apple_lm_cache()
        if self._old_disable is not None:
            os.environ["STENOAI_DISABLE_APPLE_LM"] = self._old_disable
        else:
            os.environ["STENOAI_DISABLE_APPLE_LM"] = "1"
        if self._old_user_data is not None:
            os.environ["STENOAI_USER_DATA_DIR"] = self._old_user_data
        else:
            os.environ.pop("STENOAI_USER_DATA_DIR", None)
        self._tmp_dir.cleanup()


class AppleLMResolutionTests(BaseAppleLMTest):
    def test_is_apple_system_model(self):
        self.assertTrue(is_apple_system_model("apple:system"))
        self.assertFalse(is_apple_system_model("gemma4:e2b-it-qat"))
        self.assertFalse(is_apple_system_model(None))

    def test_resolve_default_summary_model_when_available(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            self.assertEqual(resolve_default_summary_model(), APPLE_SYSTEM_MODEL)

    def test_resolve_default_summary_model_when_unavailable(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=False):
            self.assertEqual(resolve_default_summary_model(), Config.DEFAULT_MODEL)

    def test_resolve_default_summary_model_off_darwin(self):
        with mock.patch("sys.platform", "win32"), \
             mock.patch.dict(os.environ, {"STENOAI_DISABLE_APPLE_LM": "0"}):
            reset_apple_lm_cache()
            self.assertEqual(resolve_default_summary_model(), Config.DEFAULT_MODEL)

    def test_apple_system_model_info_variant_descriptions(self):
        with mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True, "variant": "coreAdvanced3", "display_name": "Apple Intelligence"}):
            info = apple_system_model_info(is_default=True)
            self.assertIn("Advanced", info["description"])
            self.assertIn("(default)", info["description"])

        with mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True, "variant": "core3", "display_name": "Apple Intelligence"}):
            info = apple_system_model_info(is_default=False)
            self.assertIn("3B Core", info["description"])
            self.assertNotIn("(default)", info["description"])


class AppleLMConfigAdoptionTests(BaseAppleLMTest):
    def test_fresh_config_adopts_apple_system_when_available(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            cfg_path = Path(self._tmp_dir.name) / "config.json"
            config = Config(config_path=cfg_path)
            self.assertEqual(config.get_model(), APPLE_SYSTEM_MODEL)
            self.assertEqual(config._config.get("summary_model_source"), "auto")

    def test_fresh_config_uses_default_when_apple_unavailable(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=False):
            cfg_path = Path(self._tmp_dir.name) / "config.json"
            config = Config(config_path=cfg_path)
            self.assertEqual(config.get_model(), Config.DEFAULT_MODEL)

    def test_existing_auto_config_upgrades_to_apple_when_it_becomes_available(self):
        cfg_path = Path(self._tmp_dir.name) / "config.json"
        cfg_path.write_text(json.dumps({"model": Config.DEFAULT_MODEL, "summary_model_source": "auto"}))
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            config = Config(config_path=cfg_path)
            self.assertEqual(config.get_model(), APPLE_SYSTEM_MODEL)

    def test_existing_auto_config_falls_back_to_gemma_when_apple_becomes_unavailable(self):
        cfg_path = Path(self._tmp_dir.name) / "config.json"
        cfg_path.write_text(json.dumps({"model": APPLE_SYSTEM_MODEL, "summary_model_source": "auto"}))
        with mock.patch("src.apple_lm.apple_lm_available", return_value=False):
            config = Config(config_path=cfg_path)
            self.assertEqual(config.get_model(), Config.DEFAULT_MODEL)

    def test_explicit_user_choice_is_not_overwritten_by_auto_adoption(self):
        cfg_path = Path(self._tmp_dir.name) / "config.json"
        cfg_path.write_text(json.dumps({"model": "qwen3.5:9b", "summary_model_source": "user"}))
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            config = Config(config_path=cfg_path)
            self.assertEqual(config.get_model(), "qwen3.5:9b")

    def test_get_model_info_returns_apple_metadata(self):
        with mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True, "variant": "coreAdvanced3"}):
            config = Config(config_path=Path(self._tmp_dir.name) / "config.json")
            info = config.get_model_info(APPLE_SYSTEM_MODEL)
            self.assertIsNotNone(info)
            self.assertEqual(info["name"], "Apple Intelligence")
            self.assertEqual(info["params"], "3B")


class AppleLMSummarizerIntegrationTests(BaseAppleLMTest):
    def test_resolve_num_ctx_for_apple_system(self):
        self.assertEqual(resolve_num_ctx(APPLE_SYSTEM_MODEL), APPLE_LM_NUM_CTX)

    def test_summarizer_initializes_apple_client_without_ollama(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL

        with mock.patch("src.summarizer.OLLAMA_AVAILABLE", False), \
             mock.patch("src.apple_lm.apple_lm_available", return_value=True):
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

    def test_generate_title_routes_through_apple_lm(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL
        cfg.get_language_name.return_value = "English"

        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            summarizer = OllamaSummarizer(config=cfg)
            with mock.patch("src.apple_lm.complete", return_value="Project Kickoff"):
                title = summarizer.generate_title("Summary here", "transcript")
                self.assertEqual(title, "Project Kickoff")

    def test_summarizer_falls_back_when_apple_configured_but_unavailable(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL
        cfg.DEFAULT_MODEL = "gemma4:e2b-it-qat"

        with mock.patch("src.apple_lm.apple_lm_available", return_value=False), \
             mock.patch("src.config.is_apple_silicon", return_value=False), \
             mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready"), \
             mock.patch("ollama.Client"):
            summarizer = OllamaSummarizer(config=cfg)
            self.assertFalse(summarizer._using_apple_lm())
            self.assertEqual(summarizer.model_name, "gemma4:e2b-it-qat")

    def test_query_transcript_ollama_retry_loop_defines_max_retries(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = "gemma4:e2b-it-qat"
        cfg.DEFAULT_MODEL = "gemma4:e2b-it-qat"

        with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready"), \
             mock.patch("ollama.Client"):
            summarizer = OllamaSummarizer(config=cfg)
            summarizer.client = mock.MagicMock()
            summarizer.client.chat.return_value = {"message": {"content": "Answer here"}}
            res = summarizer.query_transcript("Transcript", "Question?")
            self.assertEqual(res, "Answer here")
            summarizer.client.chat.assert_called_once()

    def test_generate_title_passes_timeout_to_complete(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL
        cfg.get_language_name.return_value = "English"

        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            summarizer = OllamaSummarizer(config=cfg)
            with mock.patch("src.apple_lm.complete", return_value="Project Title") as mock_complete:
                title = summarizer.generate_title("Summary here", "transcript")
                self.assertEqual(title, "Project Title")
                mock_complete.assert_called_once()
                self.assertEqual(mock_complete.call_args.kwargs.get("timeout"), 90)

    def test_long_transcript_uses_snapshot_compact(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL
        cfg.get_language_name.return_value = "English"
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            summarizer = OllamaSummarizer(config=cfg)
        prompts = []

        def fake_complete(prompt, timeout=7200):
            prompts.append(prompt)
            return f"SNAPSHOT-{len(prompts)}\nDECISIONS\n- keep going"

        def fake_stream(prompt, timeout=7200):
            yield "## Summary\nSnapshot formatted."

        transcript = "".join(
            f"Speaker A: unique-line-{i} was discussed.\n" for i in range(500)
        )
        with mock.patch("src.apple_lm.complete", side_effect=fake_complete), \
             mock.patch("src.apple_lm.stream_complete", side_effect=fake_stream), \
             mock.patch.object(summarizer, "_map_reduce_streaming") as map_reduce:
            text = "".join(summarizer.summarize_transcript_streaming(transcript))
        map_reduce.assert_not_called()
        self.assertIn("Snapshot formatted.", text)
        self.assertGreaterEqual(len(prompts), 2)
        self.assertTrue(all("CURRENT SNAPSHOT" in p for p in prompts))
        self.assertIn("SNAPSHOT-1", prompts[1])
        joined = "\n".join(prompts)
        self.assertIn("unique-line-0", joined)
        self.assertIn("unique-line-499", joined)

    def test_hard_trim_snapshot_keeps_head_and_tail(self):
        cfg = mock.Mock()
        cfg.get_ai_provider.return_value = "local"
        cfg.get_remote_ollama_url.return_value = None
        cfg.get_model.return_value = APPLE_SYSTEM_MODEL
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            summarizer = OllamaSummarizer(config=cfg)
        from src.summarizer import _SNAPSHOT_MAX_CHARS
        blob = "H" * 2000 + "MID" + "T" * 2000
        trimmed = summarizer._hard_trim_snapshot(blob)
        self.assertLessEqual(len(trimmed), _SNAPSHOT_MAX_CHARS)
        self.assertTrue(trimmed.startswith("H"))
        self.assertTrue(trimmed.endswith("T"))
        self.assertIn("...", trimmed)


class AppleLMCLITests(BaseAppleLMTest):
    def test_list_models_prepends_apple_system_when_available(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True), \
             mock.patch("src.config.Config.get_model", return_value=APPLE_SYSTEM_MODEL):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.list_models)
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertIn(APPLE_SYSTEM_MODEL, data["supported_models"])
            self.assertTrue(data["supported_models"][APPLE_SYSTEM_MODEL]["installed"])

    def test_list_models_shows_apple_system_not_installed_when_unavailable(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=False), \
             mock.patch("src.config.Config.get_model", return_value=APPLE_SYSTEM_MODEL):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.list_models)
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertIn(APPLE_SYSTEM_MODEL, data["supported_models"])
            self.assertFalse(data["supported_models"][APPLE_SYSTEM_MODEL]["installed"])

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

    def test_resolve_setup_model_returns_apple_system_when_available(self):
        with mock.patch("src.apple_lm.apple_lm_available", return_value=True):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.resolve_setup_model)
            self.assertEqual(result.exit_code, 0)
            data = json.loads(result.output)
            self.assertEqual(data["installed"], APPLE_SYSTEM_MODEL)
            self.assertIsNone(data["pull_target"])

    def test_setup_check_reports_apple_system_model(self):
        with mock.patch("sys.platform", "darwin"), \
             mock.patch("src.apple_lm.apple_lm_available", return_value=True), \
             mock.patch("src.apple_lm.apple_lm_status", return_value={"available": True, "variant": "coreAdvanced3"}):
            runner = CliRunner()
            result = runner.invoke(simple_recorder.setup_check, ["--json"])
            self.assertEqual(result.exit_code, 0)
            lines = [l for l in result.output.splitlines() if l.strip().startswith("{")]
            data = json.loads(lines[0])
            llm_check = next((c for c in data["checks"] if c["name"] == "llm-model"), None)
            self.assertIsNotNone(llm_check)
            self.assertEqual(llm_check["status"], "pass")
            self.assertIn("Apple System Language Model (coreAdvanced3)", llm_check["detail"])


class AppleLMStreamDeadlineTests(BaseAppleLMTest):
    """Pins the exception TYPE the sidecar raises when a stream stalls.

    ``OllamaSummarizer.query_transcript_streaming_strict`` re-raises
    ``TimeoutError`` instead of falling back to Ollama, because main.js kills a
    live query at the same 300 s mark and a retry started after a full stall
    would be SIGKILLed before emitting anything. ``subprocess.TimeoutExpired``
    is NOT a ``TimeoutError`` subclass, so if this ever raised that instead,
    that branch would go dead silently and a stalled sidecar would start being
    retried again. The only test in this suite that spawns the sidecar path —
    against a fake binary, with a 1 s deadline, no model and no network.
    """

    def _fake_sidecar(self, body: str) -> str:
        path = Path(self._tmp_dir.name) / "steno-apple-lm"
        path.write_text(body)
        path.chmod(0o755)
        return str(path)

    def test_stalled_stream_raises_builtin_timeouterror(self):
        import subprocess

        # `exec` so the shell does not leave a grandchild holding the pipe
        binary = self._fake_sidecar("#!/bin/sh\nexec sleep 30\n")
        with mock.patch.dict(os.environ, {
            "STENOAI_DISABLE_APPLE_LM": "0",
            "STENOAI_APPLE_LM_BIN": binary,
        }):
            reset_apple_lm_cache()
            from src.apple_lm import stream_complete
            with self.assertRaises(TimeoutError) as ctx:
                list(stream_complete("hello", timeout=1))
        self.assertNotIsInstance(ctx.exception, subprocess.TimeoutExpired)
        self.assertIn("timed out", str(ctx.exception).lower())

    def test_error_record_raises_runtimeerror_so_it_can_fall_back(self):
        """The refusal case must NOT be a TimeoutError, or the fallback that
        makes guardrail-refused questions answerable would never run."""
        binary = self._fake_sidecar(
            '#!/bin/sh\ncat > /dev/null\necho \'{"error":"apple_lm_failed","reason":"unavailable"}\'\n'
        )
        with mock.patch.dict(os.environ, {
            "STENOAI_DISABLE_APPLE_LM": "0",
            "STENOAI_APPLE_LM_BIN": binary,
        }):
            reset_apple_lm_cache()
            from src.apple_lm import stream_complete
            with self.assertRaises(RuntimeError) as ctx:
                list(stream_complete("hello", timeout=10))
        self.assertNotIsInstance(ctx.exception, TimeoutError)
        self.assertIn("failed", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()

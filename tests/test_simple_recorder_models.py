"""Tests for the list_models() CLI command's platform-conditional MLX enrichment."""

import json
import unittest
from unittest import mock

from click.testing import CliRunner


class ListModelsMlxEnrichmentTests(unittest.TestCase):
    def test_apple_silicon_gemma_entries_gain_mlx_fields(self):
        # Exercises the real Config.SUPPORTED_MODELS + list_supported_models(),
        # only mocking the Ollama HTTP call and the platform gate.
        from simple_recorder import cli

        runner = CliRunner()
        fake_models = [mock.Mock(model="gemma4:e2b-nvfp4")]
        fake_response = mock.Mock(models=fake_models)

        with mock.patch("src.config.is_apple_silicon", return_value=True), \
             mock.patch("ollama.list", return_value=fake_response):
            result = runner.invoke(cli, ["list-models"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        e2b_entry = data["supported_models"]["gemma4:e2b-it-qat"]
        self.assertEqual(e2b_entry["mlx_tag"], "gemma4:e2b-nvfp4")
        self.assertTrue(e2b_entry["mlx_installed"])
        # The NVFP4 blob is a different (larger) download than the GGUF
        # entry's own 'size' -- shown separately so the UI doesn't claim the
        # GGUF size while the NVFP4 tag is what's actually installed/pulled.
        self.assertEqual(e2b_entry["mlx_size"], "6.5GB")
        self.assertNotEqual(e2b_entry["mlx_size"], e2b_entry["size"])
        # Only the NVFP4 tag is in the fake `ollama.list()` response above --
        # the GGUF blob itself was never pulled. It must still report as
        # installed: a model fetched straight to its NVFP4 tag (general
        # "Select" now resolves to that on Apple Silicon) is fully usable,
        # and "installed: false" would leave "Select" offered forever.
        self.assertTrue(e2b_entry["installed"])
        # But 'gguf_installed' must stay false so a caller (e.g. the Settings
        # delete-to-free-space action) can tell the GGUF blob itself was
        # never pulled, and not attempt to delete a tag that was never
        # there (regression: this used to throw and leave the confirm
        # dialog stuck, since ollama.delete() on a nonexistent tag errors).
        self.assertFalse(e2b_entry["gguf_installed"])

    def test_gguf_installed_true_when_gguf_blob_actually_present(self):
        """The ordinary case: both the GGUF id and its NVFP4 sibling are
        actually installed (e.g. after "switch to faster build")."""
        from simple_recorder import cli

        runner = CliRunner()
        fake_models = [
            mock.Mock(model="gemma4:e2b-it-qat"),
            mock.Mock(model="gemma4:e2b-nvfp4"),
        ]
        fake_response = mock.Mock(models=fake_models)

        with mock.patch("src.config.is_apple_silicon", return_value=True), \
             mock.patch("ollama.list", return_value=fake_response):
            result = runner.invoke(cli, ["list-models"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        e2b_entry = data["supported_models"]["gemma4:e2b-it-qat"]
        self.assertTrue(e2b_entry["gguf_installed"])
        self.assertTrue(e2b_entry["mlx_installed"])
        self.assertTrue(e2b_entry["installed"])

        # A model with no MLX equivalent gets neither field.
        llama_entry = data["supported_models"]["llama3.2:3b"]
        self.assertNotIn("mlx_tag", llama_entry)
        self.assertNotIn("mlx_installed", llama_entry)

    def test_off_apple_silicon_payload_has_no_mlx_fields(self):
        from simple_recorder import cli

        runner = CliRunner()
        fake_response = mock.Mock(models=[])

        with mock.patch("src.config.is_apple_silicon", return_value=False), \
             mock.patch("ollama.list", return_value=fake_response):
            result = runner.invoke(cli, ["list-models"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        for entry in data["supported_models"].values():
            self.assertNotIn("mlx_tag", entry)
            self.assertNotIn("mlx_installed", entry)
            self.assertNotIn("mlx_size", entry)


class ResolveSetupModelPullTargetTests(unittest.TestCase):
    def test_pull_target_is_nvfp4_on_apple_silicon(self):
        from simple_recorder import cli

        runner = CliRunner()
        fake_response = mock.Mock(models=[])
        with mock.patch("src.ollama_manager.start_ollama_server") as start_ollama, \
             mock.patch("src.config.is_apple_silicon", return_value=True), \
             mock.patch("ollama.list", return_value=fake_response):
            result = runner.invoke(cli, ["resolve-setup-model"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertEqual(data["pull_target"], "gemma4:e2b-nvfp4")
        self.assertIsNone(data["installed"])
        start_ollama.assert_not_called()

    def test_pull_target_is_gguf_default_off_apple_silicon(self):
        from simple_recorder import cli

        runner = CliRunner()
        fake_response = mock.Mock(models=[])
        with mock.patch("src.ollama_manager.start_ollama_server") as start_ollama, \
             mock.patch("src.config.is_apple_silicon", return_value=False), \
             mock.patch("ollama.list", return_value=fake_response):
            result = runner.invoke(cli, ["resolve-setup-model"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertEqual(data["pull_target"], "gemma4:e2b-it-qat")
        start_ollama.assert_not_called()

    def test_existing_nvfp4_install_is_recognised_as_supported(self):
        from simple_recorder import cli

        runner = CliRunner()
        # Only the NVFP4 tag is installed (e.g. from a prior manual switch) --
        # pick_installed_supported_model must canonicalize it back to the
        # GGUF id to recognise "a supported model is already present".
        fake_response = mock.Mock(models=[mock.Mock(model="gemma4:e2b-nvfp4")])
        with mock.patch("src.ollama_manager.start_ollama_server") as start_ollama, \
             mock.patch("src.config.is_apple_silicon", return_value=True), \
             mock.patch("ollama.list", return_value=fake_response):
            result = runner.invoke(cli, ["resolve-setup-model"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertEqual(data["installed"], "gemma4:e2b-it-qat")
        start_ollama.assert_not_called()

    def test_nvfp4_install_with_extra_tag_detail_is_recognised(self):
        """Ollama can append extra detail after a tag (the same pattern
        list_models() already handles for GGUF ids, e.g. "deepseek-r1:14b"
        matching "deepseek-r1:14b-qwen-distill-q4_K_M"). An exact dict
        lookup alone would miss this for NVFP4 tags and cause a redundant
        re-download even though a supported model is already present."""
        from simple_recorder import cli

        runner = CliRunner()
        fake_response = mock.Mock(models=[mock.Mock(model="gemma4:e2b-nvfp4-extra-detail")])
        with mock.patch("src.ollama_manager.start_ollama_server") as start_ollama, \
             mock.patch("src.config.is_apple_silicon", return_value=True), \
             mock.patch("ollama.list", return_value=fake_response):
            result = runner.invoke(cli, ["resolve-setup-model"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertEqual(data["installed"], "gemma4:e2b-it-qat")
        start_ollama.assert_not_called()


class VerifyModelCommandTests(unittest.TestCase):
    def test_verify_model_success(self):
        from simple_recorder import cli

        runner = CliRunner()
        with mock.patch("src.ollama_manager.start_ollama_server", return_value=True), \
             mock.patch("ollama.Client") as client_cls:
            client_cls.return_value.chat.return_value = {
                "message": {"role": "assistant", "content": "hi"}
            }
            result = runner.invoke(cli, ["verify-model", "gemma4:e2b-nvfp4"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertTrue(data["success"])
        self.assertIsNone(data.get("error"))
        client_cls.return_value.chat.assert_called_once()
        _, kwargs = client_cls.return_value.chat.call_args
        self.assertEqual(kwargs["model"], "gemma4:e2b-nvfp4")

    def test_verify_model_reports_failure(self):
        from simple_recorder import cli

        runner = CliRunner()
        with mock.patch("src.ollama_manager.start_ollama_server", return_value=True), \
             mock.patch("ollama.Client") as client_cls:
            client_cls.return_value.chat.side_effect = RuntimeError("model not found")
            result = runner.invoke(cli, ["verify-model", "gemma4:e2b-nvfp4"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertFalse(data["success"])
        self.assertIn("model not found", data["error"])


class PullModelCommandTests(unittest.TestCase):
    def test_progress_line_includes_raw_byte_counts(self):
        from simple_recorder import cli

        runner = CliRunner()
        progress_events = [
            mock.Mock(status="pulling manifest", total=0, completed=0),
            mock.Mock(status="pulling model", total=1000, completed=210),
        ]
        with mock.patch("src.ollama_manager.start_ollama_server", return_value=True), \
             mock.patch("ollama.pull", return_value=iter(progress_events)):
            result = runner.invoke(cli, ["pull-model", "gemma4:e2b-nvfp4"])

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("pulling model 21% (210/1000) [Part 1]", result.output)
        data = json.loads(result.output.strip().splitlines()[-1])
        self.assertTrue(data["success"])

    def test_progress_line_increments_part_on_each_new_blob(self):
        """A real model pull streams several weighted (total>0) blobs in
        sequence -- the part index must advance once per distinct blob, not
        once per repeated progress tick of the same blob."""
        from simple_recorder import cli

        runner = CliRunner()
        progress_events = [
            mock.Mock(status="pulling abc123", total=1000, completed=500),
            mock.Mock(status="pulling abc123", total=1000, completed=1000),
            mock.Mock(status="pulling def456", total=2000, completed=1000),
            mock.Mock(status="verifying sha256 digest", total=0, completed=0),
        ]
        with mock.patch("src.ollama_manager.start_ollama_server", return_value=True), \
             mock.patch("ollama.pull", return_value=iter(progress_events)):
            result = runner.invoke(cli, ["pull-model", "gemma4:e2b-nvfp4"])

        self.assertEqual(result.exit_code, 0, result.output)
        lines = result.output.strip().splitlines()
        self.assertIn("pulling abc123 50% (500/1000) [Part 1]", lines)
        self.assertIn("pulling abc123 100% (1000/1000) [Part 1]", lines)
        self.assertIn("pulling def456 50% (1000/2000) [Part 2]", lines)
        self.assertIn("verifying sha256 digest", lines)


class DeleteModelCommandTests(unittest.TestCase):
    def test_delete_model_success(self):
        from simple_recorder import cli

        runner = CliRunner()
        with mock.patch("ollama.delete") as delete_mock:
            result = runner.invoke(cli, ["delete-model", "gemma4:e2b-it-qat"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertTrue(data["success"])
        delete_mock.assert_called_once_with(model="gemma4:e2b-it-qat")

    def test_delete_model_reports_failure(self):
        from simple_recorder import cli

        runner = CliRunner()
        with mock.patch("ollama.delete", side_effect=RuntimeError("not found")):
            result = runner.invoke(cli, ["delete-model", "gemma4:e2b-it-qat"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertFalse(data["success"])
        self.assertIn("not found", data["error"])

    def test_delete_model_refuses_unsupported_model(self):
        """delete-model is IPC-reachable and destructive, so it must not
        forward an arbitrary caller-supplied name straight to ollama.delete()
        -- only the canonical supported GGUF ids."""
        from simple_recorder import cli

        runner = CliRunner()
        with mock.patch("ollama.delete") as delete_mock:
            result = runner.invoke(cli, ["delete-model", "not-a-real-model"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertFalse(data["success"])
        self.assertIn("not-a-real-model", data["error"])
        delete_mock.assert_not_called()

    def test_delete_model_allows_nvfp4_sibling(self):
        """The general "delete this model to free up disk space" action can
        target either the GGUF id or its NVFP4 sibling directly -- e.g. to
        remove just the faster build while keeping the GGUF installed."""
        from simple_recorder import cli

        runner = CliRunner()
        with mock.patch("ollama.delete") as delete_mock:
            result = runner.invoke(cli, ["delete-model", "gemma4:e2b-nvfp4"])

        self.assertEqual(result.exit_code, 0, result.output)
        data = json.loads(result.output)
        self.assertTrue(data["success"])
        delete_mock.assert_called_once_with(model="gemma4:e2b-nvfp4")


if __name__ == "__main__":
    unittest.main()

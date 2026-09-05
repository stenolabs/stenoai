"""Tests for the installed-model picker used by `resolve-setup-model` (#123).

First-run setup should reuse a supported Ollama model that's already installed
instead of re-pulling the hardcoded default. `pick_installed_supported_model`
is the decision (which installed model to reuse, in what preference order);
these tests pin that behaviour without touching Ollama or the network.
"""

import json
import unittest
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from simple_recorder import pick_installed_supported_model

# A representative slice of config.SUPPORTED_MODELS order (ascending capability,
# default first) with the two deprecated entries at the tail.
SUPPORTED = [
    "llama3.2:3b",
    "gemma4:e2b-it-qat",
    "gemma4:e4b-it-qat",
    "qwen3.5:9b",
    "gemma4:12b-it-qat",
    "gpt-oss:20b",
    "gemma3:4b",        # deprecated
    "deepseek-r1:14b",  # deprecated
]
DEPRECATED = ["gemma3:4b", "deepseek-r1:14b"]
DEFAULT = "llama3.2:3b"


class PickInstalledSupportedModelTests(unittest.TestCase):
    def test_returns_none_when_nothing_supported_is_installed(self):
        # Only unsupported models present -> caller must pull the default.
        self.assertIsNone(
            pick_installed_supported_model(
                installed_names={"mistral:7b", "phi3:mini"},
                preferred=[DEFAULT, DEFAULT],
                supported_order=SUPPORTED,
                deprecated=DEPRECATED,
            )
        )

    def test_returns_none_when_no_models_installed(self):
        self.assertIsNone(
            pick_installed_supported_model(
                installed_names=set(),
                preferred=[DEFAULT, DEFAULT],
                supported_order=SUPPORTED,
                deprecated=DEPRECATED,
            )
        )

    def test_prefers_the_configured_model_when_installed(self):
        # Configured model differs from the default and both are installed:
        # the configured one wins.
        self.assertEqual(
            pick_installed_supported_model(
                installed_names={"llama3.2:3b", "qwen3.5:9b"},
                preferred=["qwen3.5:9b", DEFAULT],
                supported_order=SUPPORTED,
                deprecated=DEPRECATED,
            ),
            "qwen3.5:9b",
        )

    def test_falls_back_to_default_when_configured_absent(self):
        # Configured model not installed, default is -> default wins (the #123
        # headline: existing llama3.2:3b means no pull).
        self.assertEqual(
            pick_installed_supported_model(
                installed_names={"llama3.2:3b", "gemma4:12b-it-qat"},
                preferred=["gpt-oss:20b", DEFAULT],
                supported_order=SUPPORTED,
                deprecated=DEPRECATED,
            ),
            "llama3.2:3b",
        )

    def test_falls_through_registry_when_no_preferred_installed(self):
        # Neither configured nor default installed: take the first supported,
        # non-deprecated id in registry order.
        self.assertEqual(
            pick_installed_supported_model(
                installed_names={"gemma4:12b-it-qat", "qwen3.5:9b"},
                preferred=["gpt-oss:20b", DEFAULT],
                supported_order=SUPPORTED,
                deprecated=DEPRECATED,
            ),
            "qwen3.5:9b",
        )

    def test_deprecated_only_as_last_resort(self):
        # A deprecated-but-installed model is used only when nothing live is
        # installed -- a live model always beats a retired one.
        self.assertEqual(
            pick_installed_supported_model(
                installed_names={"gemma3:4b", "gemma4:12b-it-qat"},
                preferred=["gpt-oss:20b", DEFAULT],
                supported_order=SUPPORTED,
                deprecated=DEPRECATED,
            ),
            "gemma4:12b-it-qat",
        )
        # ...but a deprecated model is still better than pulling fresh.
        self.assertEqual(
            pick_installed_supported_model(
                installed_names={"deepseek-r1:14b"},
                preferred=["gpt-oss:20b", DEFAULT],
                supported_order=SUPPORTED,
                deprecated=DEPRECATED,
            ),
            "deepseek-r1:14b",
        )

    def test_ignores_blank_preferred_entries(self):
        # A falsy configured model (unset) must not match a blank installed id.
        self.assertEqual(
            pick_installed_supported_model(
                installed_names={"llama3.2:3b"},
                preferred=["", DEFAULT],
                supported_order=SUPPORTED,
                deprecated=DEPRECATED,
            ),
            "llama3.2:3b",
        )


class SetModelExitCodeTests(unittest.TestCase):
    """`set-model` must signal a config-write failure through its EXIT CODE, not
    just a JSON body. The reuse flow (setup-ollama-and-model) shells out to it to
    persist the reused model as active; if the write fails but the process exits
    0, setup reports success while the active model was never saved (#123)."""

    def _invoke(self, *, save_succeeds):
        # Installed fallback model differs from the configured + default model;
        # persisting it as active is what may fail.
        fake_config = mock.Mock()
        fake_config.SUPPORTED_MODELS = {"llama3.2:3b": {}, "qwen3.5:9b": {}}
        fake_config.set_model.return_value = save_succeeds
        with mock.patch("src.config.get_config", return_value=fake_config):
            return CliRunner().invoke(simple_recorder.set_model, ["qwen3.5:9b"])

    def _last_json(self, output):
        line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
        return json.loads(line)

    def test_config_write_failure_exits_nonzero(self):
        result = self._invoke(save_succeeds=False)
        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            self._last_json(result.output),
            {"success": False, "error": "Failed to save config"},
        )

    def test_success_exits_zero(self):
        result = self._invoke(save_succeeds=True)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(
            self._last_json(result.output),
            {"success": True, "model": "qwen3.5:9b"},
        )


class SetModelIfCurrentTests(unittest.TestCase):
    @staticmethod
    def _invoke(fake_config):
        with mock.patch("src.config.get_config", return_value=fake_config):
            return CliRunner().invoke(
                simple_recorder.set_model_if_current,
                ["gemma4:e2b-it-qat", "qwen3.5:9b"],
            )

    def test_preserves_a_newer_user_selection(self):
        fake_config = mock.Mock()
        fake_config.begin_transaction.return_value = True
        fake_config.get_model.return_value = "apple:system"

        result = self._invoke(fake_config)

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(
            json.loads(result.output),
            {"success": True, "updated": False, "model": "apple:system"},
        )
        fake_config.rollback_transaction.assert_called_once_with()
        fake_config.set_model.assert_not_called()

    def test_preserves_same_model_after_user_aba_change(self):
        fake_config = mock.Mock()
        fake_config.begin_transaction.return_value = True
        fake_config.get_model.return_value = "gemma4:e2b-it-qat"
        fake_config.get.return_value = "user"

        result = self._invoke(fake_config)

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(
            json.loads(result.output),
            {
                "success": True,
                "updated": False,
                "model": "gemma4:e2b-it-qat",
            },
        )
        fake_config.rollback_transaction.assert_called_once_with()
        fake_config.set_model.assert_not_called()

    def test_updates_matching_selection_as_setup_provenance(self):
        fake_config = mock.Mock()
        fake_config.begin_transaction.return_value = True
        fake_config.get_model.return_value = "gemma4:e2b-it-qat"
        fake_config.set_model.return_value = True
        fake_config.commit_transaction.return_value = True

        result = self._invoke(fake_config)

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(
            json.loads(result.output),
            {"success": True, "updated": True, "model": "qwen3.5:9b"},
        )
        fake_config.set_model.assert_called_once_with("qwen3.5:9b", source="auto")
        fake_config.commit_transaction.assert_called_once_with()

    def test_lock_failure_exits_nonzero_without_rollback(self):
        fake_config = mock.Mock()
        fake_config.begin_transaction.return_value = False

        result = self._invoke(fake_config)

        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            json.loads(result.output),
            {"success": False, "error": "Could not lock config"},
        )
        fake_config.rollback_transaction.assert_not_called()

    def test_staging_failure_rolls_back_and_exits_nonzero(self):
        fake_config = mock.Mock()
        fake_config.begin_transaction.return_value = True
        fake_config.get_model.return_value = "gemma4:e2b-it-qat"
        fake_config.set_model.return_value = False

        result = self._invoke(fake_config)

        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            json.loads(result.output),
            {"success": False, "error": "Failed to stage model config"},
        )
        fake_config.rollback_transaction.assert_called_once_with()

    def test_commit_failure_exits_nonzero(self):
        fake_config = mock.Mock()
        fake_config.begin_transaction.return_value = True
        fake_config.get_model.return_value = "gemma4:e2b-it-qat"
        fake_config.set_model.return_value = True
        fake_config.commit_transaction.return_value = False

        result = self._invoke(fake_config)

        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            json.loads(result.output),
            {"success": False, "error": "Failed to save config"},
        )
        fake_config.commit_transaction.assert_called_once_with()

    def test_exception_rolls_back_and_exits_nonzero(self):
        fake_config = mock.Mock()
        fake_config.begin_transaction.return_value = True
        fake_config.get_model.side_effect = RuntimeError("synthetic read failure")

        result = self._invoke(fake_config)

        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            json.loads(result.output),
            {"success": False, "error": "synthetic read failure"},
        )
        fake_config.rollback_transaction.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()

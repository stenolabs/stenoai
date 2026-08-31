import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

import simple_recorder
import src.config as config_mod
from src.config import Config


class OpenAiAsrCredentialMigrationTests(unittest.TestCase):
    def test_snapshot_digest_matches_node_for_raw_url_edge_cases(self):
        # These are SHA-256 vectors produced by
        # app/openai-asr-key-store.js's versioned UTF-16BE framing. The raw
        # value, not a normalised origin, makes a concurrent endpoint
        # replacement fail the CLI's compare-and-delete. UTF-16 code units
        # include unpaired surrogates so invalid legacy text remains cleanable.
        cases = (
            ("legacy-key", {}, "2bc3e2811d497bd32c5e13a204d9facd2cb88103f8155b911429c9cddb3d55f0"),
            ("legacy-key", {"openai_asr_api_url": ""}, "7918deaa64299ed799179fb64a17eba5b5de952762d5e15a16c533595a948c00"),
            ("legacy-key", {"openai_asr_api_url": 42}, "8db495143b6300cc8328119233e8dfaa7a855f10e2f8277f565e93b53c546a17"),
            ("legacy-key", {"openai_asr_api_url": "  https://api.example/v1  "}, "3c5006d608c0b37eb38a392b8d177b49fd78f16025f40f96ee432f3d9535bab0"),
            ("\ufefflegacy-key", {}, "77d67fa01f41e32f0c3868e741ec59d6fb7e88cf00c607823948a9940eb37344"),
            ("\x1clegacy-key", {}, "42452496c22c0ae4e32d3aabc6e66f9f55c43e0e9f14f3b17aaa7c031725adee"),
            ("\ud800legacy", {}, "6d7fca01597fc2361653d27d2036b08df282564737641f0ce48fafc6acc3592d"),
        )
        for raw_key, config, expected_digest in cases:
            with self.subTest(raw_key=raw_key, config=config):
                self.assertEqual(
                    config_mod._legacy_openai_asr_snapshot_digest({
                        "openai_asr_api_key": raw_key, **config,
                    }),
                    expected_digest,
                )

    def test_removes_plaintext_legacy_asr_key_after_safe_storage_migration(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config_path.write_text(json.dumps({"openai_asr_api_key": "legacy-test-value"}))
            config = Config(config_path=config_path)

            self.assertTrue(config.remove_legacy_openai_asr_api_key())
            self.assertNotIn("openai_asr_api_key", json.loads(config_path.read_text()))

    def test_keeps_plaintext_legacy_asr_key_when_removal_save_fails(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config_path.write_text(json.dumps({"openai_asr_api_key": "legacy-test-value"}))
            config = Config(config_path=config_path)

            with patch.object(config, "_save", return_value=False):
                self.assertFalse(config.remove_legacy_openai_asr_api_key())

            self.assertEqual(config._config["openai_asr_api_key"], "legacy-test-value")

    def test_cli_removes_invalid_endpoint_legacy_key_when_snapshot_matches(self):
        """Cleanup must not depend on an endpoint being safe to migrate."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            contents = {
                "openai_asr_api_key": "legacy-test-value",
                "openai_asr_api_url": "http://untrusted.example/v1",
            }
            config_path.write_text(json.dumps(contents))
            config = Config(config_path=config_path)
            digest = config_mod._legacy_openai_asr_snapshot_digest(contents)

            with patch("src.config.get_config", return_value=config):
                result = CliRunner().invoke(
                    simple_recorder.remove_legacy_openai_asr_api_key_cmd,
                    env={"STENOAI_OAI_LEGACY_SNAPSHOT_DIGEST": digest},
                )

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertTrue(json.loads(result.output)["success"])
            self.assertNotIn("openai_asr_api_key", json.loads(config_path.read_text()))

    def test_cli_removes_valid_migrated_key_only_with_its_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            contents = {
                "openai_asr_api_key": "legacy-test-value",
                "openai_asr_api_url": "https://api.example/v1",
            }
            config_path.write_text(json.dumps(contents))
            config = Config(config_path=config_path)
            digest = config_mod._legacy_openai_asr_snapshot_digest(contents)

            with patch("src.config.get_config", return_value=config):
                result = CliRunner().invoke(
                    simple_recorder.remove_legacy_openai_asr_api_key_cmd,
                    env={"STENOAI_OAI_LEGACY_SNAPSHOT_DIGEST": digest},
                )

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertTrue(json.loads(result.output)["success"])
            self.assertNotIn("openai_asr_api_key", json.loads(config_path.read_text()))

    def test_cli_removes_unicode_whitespace_raw_keys_by_raw_snapshot_digest(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            for raw_key in (
                "\ufefflegacy-key",
                "\x1cnot-a-valid-credential",
                " \t ",
                "\ud800not-a-valid-credential",
            ):
                with self.subTest(raw_key=raw_key):
                    contents = {
                        "openai_asr_api_key": raw_key,
                        "openai_asr_api_url": "https://api.example/v1",
                    }
                    config_path.write_text(json.dumps(contents))
                    config = Config(config_path=config_path)
                    digest = config_mod._legacy_openai_asr_snapshot_digest(contents)

                    with patch("src.config.get_config", return_value=config):
                        result = CliRunner().invoke(
                            simple_recorder.remove_legacy_openai_asr_api_key_cmd,
                            env={"STENOAI_OAI_LEGACY_SNAPSHOT_DIGEST": digest},
                        )

                    self.assertEqual(result.exit_code, 0, result.output)
                    self.assertTrue(json.loads(result.output)["success"])
                    self.assertNotIn(
                        "openai_asr_api_key", json.loads(config_path.read_text())
                    )

    def test_digest_bound_removal_keeps_a_concurrent_replacement(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            original = {
                "openai_asr_api_key": "old-legacy-key",
                "openai_asr_api_url": "https://old.example/v1",
            }
            replacement = {
                "openai_asr_api_key": "replacement-key",
                "openai_asr_api_url": "https://replacement.example/v1",
            }
            config_path.write_text(json.dumps(original))
            config = Config(config_path=config_path)
            digest = config_mod._legacy_openai_asr_snapshot_digest(original)

            # Model Electron's read occurring before another settings write.
            config_path.write_text(json.dumps(replacement))
            self.assertFalse(config.remove_legacy_openai_asr_api_key(digest))
            self.assertEqual(json.loads(config_path.read_text()), replacement)


class ConfigStoragePathTests(unittest.TestCase):
    def test_set_storage_path_handles_permission_errors(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertEqual(config.get_storage_path(), "")

            with patch("pathlib.Path.mkdir", side_effect=PermissionError("no access")):
                success = config.set_storage_path("/System/Library")

            self.assertFalse(success)
            self.assertEqual(config.get_storage_path(), "")

    def test_set_storage_path_accepts_none_as_reset(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            success = config.set_storage_path(None)
            self.assertTrue(success)
            self.assertEqual(config.get_storage_path(), "")


class ConfigLanguageTests(unittest.TestCase):
    def test_default_language_is_auto_detect(self):
        # A fresh config (no explicit language ever set) must default to
        # "auto" so _resolve_output_language() picks up the transcript's
        # detected language, not silently produce English-only summaries
        # for every user who never visits Settings.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertEqual(config.get_language(), "auto")

    def test_legacy_config_missing_language_key_reads_as_auto(self):
        # A config file saved before the "language" field existed (or a
        # hand-edited one missing just that key) must still auto-detect, not
        # fall back to English. Regression guard for the get_language() read
        # path agreeing with the "auto" default (#281).
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config_path.write_text(json.dumps({"ai_provider": "local"}))
            config = Config(config_path=config_path)
            self.assertEqual(config.get_language(), "auto")

    def test_set_language_accepts_supported_dutch_code(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            success = config.set_language("nl")
            self.assertTrue(success)
            self.assertEqual(config.get_language(), "nl")
            self.assertEqual(config.get_language_name("nl"), "Dutch")

    def test_set_language_accepts_auto_detection_mode(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            success = config.set_language("auto")
            self.assertTrue(success)
            self.assertEqual(config.get_language(), "auto")
            self.assertEqual(config.get_language_name("auto"), "Auto (detect)")

    def test_legacy_zh_migrates_to_simplified_on_load(self):
        # Chinese used to be a single "zh" entry; it's now split into
        # zh-Hans / zh-Hant. An existing "zh" config must migrate to
        # Simplified (what whisper.cpp emitted for "zh" anyway) on load and
        # persist so the Settings dropdown shows a valid selection.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config_path.write_text(json.dumps({"language": "zh"}))

            config = Config(config_path=config_path)
            self.assertEqual(config.get_language(), "zh-Hans")
            # Migration is persisted to disk, not just in memory.
            on_disk = json.loads(config_path.read_text())
            self.assertEqual(on_disk["language"], "zh-Hans")

    def test_set_language_accepts_both_chinese_variants(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")

            self.assertTrue(config.set_language("zh-Hant"))
            self.assertEqual(config.get_language(), "zh-Hant")
            self.assertEqual(config.get_language_name("zh-Hant"), "Chinese (Traditional)")

            self.assertTrue(config.set_language("zh-Hans"))
            self.assertEqual(config.get_language(), "zh-Hans")
            self.assertEqual(config.get_language_name("zh-Hans"), "Chinese (Simplified)")

    def test_set_language_legacy_zh_normalises_to_simplified(self):
        # Back-compat: a caller (or old deep link) passing bare "zh" is still
        # accepted and normalised to Simplified rather than rejected.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_language("zh"))
            self.assertEqual(config.get_language(), "zh-Hans")

    def test_chinese_variants_map_to_zh_for_asr(self):
        # whisper.cpp only knows "zh"; both variants must fold to it for the
        # ASR call while the variant drives post-transcription conversion.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")

            config.set_language("zh-Hant")
            self.assertEqual(config.get_whisper_language(), "zh")
            self.assertEqual(config.get_chinese_variant(), "traditional")

            config.set_language("zh-Hans")
            self.assertEqual(config.get_whisper_language(), "zh")
            self.assertEqual(config.get_chinese_variant(), "simplified")

    def test_non_chinese_language_has_no_variant_and_passes_asr_code(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.set_language("de")
            self.assertIsNone(config.get_chinese_variant())
            self.assertEqual(config.get_whisper_language(), "de")


class ConfigMicrophoneTests(unittest.TestCase):
    def test_default_microphone_is_system_default(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertEqual(
                config.get_microphone_device(), {"device_id": None, "label": None}
            )

    def test_set_microphone_device_persists_id_and_label(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            success = config.set_microphone_device("abc123", "USB Microphone")
            self.assertTrue(success)
            self.assertEqual(
                config.get_microphone_device(),
                {"device_id": "abc123", "label": "USB Microphone"},
            )
            # Round-trip via a fresh Config instance — get_microphone_device()
            # reads the in-memory _config dict directly, so without this a
            # silently-failed _save() would still pass.
            reloaded = Config(config_path=path)
            self.assertEqual(
                reloaded.get_microphone_device(),
                {"device_id": "abc123", "label": "USB Microphone"},
            )

    def test_set_microphone_device_default_clears_selection(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.set_microphone_device("abc123", "USB Microphone")
            success = config.set_microphone_device("default", "")
            self.assertTrue(success)
            self.assertEqual(
                config.get_microphone_device(), {"device_id": None, "label": None}
            )

    def test_set_microphone_device_none_clears_selection(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.set_microphone_device("abc123", "USB Microphone")
            success = config.set_microphone_device(None, None)
            self.assertTrue(success)
            self.assertEqual(
                config.get_microphone_device(), {"device_id": None, "label": None}
            )


class ConfigWhisperModelTests(unittest.TestCase):
    def test_default_whisper_model_is_large_v3_turbo(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertEqual(config.get_whisper_model(), "large-v3-turbo")

    def test_set_whisper_model_persists_supported_size(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_whisper_model("large-v3-turbo"))
            self.assertEqual(config.get_whisper_model(), "large-v3-turbo")
            # Round-trip via a fresh Config instance
            reloaded = Config(config_path=path)
            self.assertEqual(reloaded.get_whisper_model(), "large-v3-turbo")

    def test_set_whisper_model_rejects_unknown_size(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertFalse(config.set_whisper_model("ultra-mega"))
            self.assertEqual(config.get_whisper_model(), "large-v3-turbo")

    def test_get_whisper_model_falls_back_when_stored_value_invalid(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            # Simulate a hand-edited config with a stale model name
            config._config["whisper_model"] = "obsolete-model"
            self.assertEqual(config.get_whisper_model(), "large-v3-turbo")


class ConfigOpenAiAsrTests(unittest.TestCase):
    def test_endpoint_cli_update_rejects_legacy_key_added_before_locked_transaction(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            # Model Electron's successful migration followed by an older
            # writer adding plaintext just before the endpoint writer obtains
            # the lock. begin_transaction() must reload this under that lock.
            path.write_text(json.dumps({
                "openai_asr_api_key": "late-legacy-key",
                "openai_asr_api_url": "https://old.example/v1",
            }))

            with patch("src.config.get_config", return_value=config):
                result = CliRunner().invoke(
                    simple_recorder.set_openai_asr_config_cmd,
                    ["--api-url", "https://replacement.example/v1"],
                )

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertFalse(json.loads(result.output)["success"])
            self.assertNotIn("late-legacy-key", result.output)
            self.assertEqual(json.loads(path.read_text()), {
                "openai_asr_api_key": "late-legacy-key",
                "openai_asr_api_url": "https://old.example/v1",
            })

    def test_model_only_cli_update_preserves_legacy_key_and_remains_available(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({
                "openai_asr_api_key": "legacy-key",
                "openai_asr_api_url": "https://old.example/v1",
            }))
            config = Config(config_path=path)

            with patch("src.config.get_config", return_value=config):
                result = CliRunner().invoke(
                    simple_recorder.set_openai_asr_config_cmd,
                    ["--model", "whisper-large-v3"],
                )

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertTrue(json.loads(result.output)["success"])
            reloaded = json.loads(path.read_text())
            self.assertEqual(reloaded["openai_asr_api_key"], "legacy-key")
            self.assertEqual(reloaded["openai_asr_api_url"], "https://old.example/v1")
            self.assertEqual(reloaded["openai_asr_model"], "whisper-large-v3")

    def test_endpoint_cli_update_fails_closed_when_locked_config_read_fails(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            original = json.loads(path.read_text())

            with patch.object(
                config,
                "_read_disk_for_secure_transaction",
                return_value=(False, None),
            ), patch("src.config.get_config", return_value=config):
                result = CliRunner().invoke(
                    simple_recorder.set_openai_asr_config_cmd,
                    ["--api-url", "https://replacement.example/v1"],
                )

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertFalse(json.loads(result.output)["success"])
            self.assertEqual(json.loads(path.read_text()), original)

    def test_model_only_cli_update_fails_closed_when_locked_config_read_fails(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            original = path.read_text()

            with patch.object(
                config,
                "_read_disk_for_secure_transaction",
                return_value=(False, None),
            ), patch("src.config.get_config", return_value=config):
                result = CliRunner().invoke(
                    simple_recorder.set_openai_asr_config_cmd,
                    ["--model", "whisper-large-v3"],
                )

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertFalse(json.loads(result.output)["success"])
            self.assertEqual(path.read_text(), original)

    def test_multi_field_cli_update_commits_both_fields(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)

            with patch("src.config.get_config", return_value=config):
                result = CliRunner().invoke(
                    simple_recorder.set_openai_asr_config_cmd,
                    [
                        "--api-url", "https://replacement.example/v1",
                        "--model", "replacement-model",
                    ],
                )

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertTrue(json.loads(result.output)["success"])
            reloaded = Config(config_path=path)
            self.assertEqual(
                reloaded.get_openai_asr_api_url(), "https://replacement.example/v1"
            )
            self.assertEqual(
                reloaded.get_openai_asr_model(), "replacement-model"
            )

    def test_multi_field_cli_update_rolls_back_when_one_field_is_invalid(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(
                config.set_openai_asr_api_url("https://original.example/v1")
            )
            self.assertTrue(config.set_openai_asr_model("whisper-1"))

            with patch("src.config.get_config", return_value=config):
                result = CliRunner().invoke(
                    simple_recorder.set_openai_asr_config_cmd,
                    [
                        "--api-url", "https://replacement.example/v1",
                        "--model", "",
                    ],
                )

            self.assertEqual(result.exit_code, 0, result.output)
            self.assertFalse(json.loads(result.output)["success"])
            reloaded = Config(config_path=path)
            self.assertEqual(
                reloaded.get_openai_asr_api_url(), "https://original.example/v1"
            )
            self.assertEqual(reloaded.get_openai_asr_model(), "whisper-1")

    def test_defaults_on_fresh_config(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertEqual(config.get_openai_asr_api_url(), "https://api.openai.com/v1")
            self.assertEqual(config.get_openai_asr_model(), "whisper-1")

    def test_set_api_url_persists_and_strips(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_openai_asr_api_url("  https://api.groq.example/openai/v1  "))
            self.assertEqual(config.get_openai_asr_api_url(), "https://api.groq.example/openai/v1")
            reloaded = Config(config_path=path)
            self.assertEqual(reloaded.get_openai_asr_api_url(), "https://api.groq.example/openai/v1")

    def test_set_api_url_canonicalises_host_case_and_default_port(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_openai_asr_api_url(" HTTPS://API.EXAMPLE.COM:443/v1/ "))
            self.assertEqual(config.get_openai_asr_api_url(), "https://api.example.com/v1")

    def test_set_api_url_rejects_blank_and_keeps_prior(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_openai_asr_api_url("https://custom.example/v1"))
            # A blank / whitespace-only URL is rejected; the prior value stays.
            self.assertFalse(config.set_openai_asr_api_url(""))
            self.assertFalse(config.set_openai_asr_api_url("   "))
            self.assertEqual(config.get_openai_asr_api_url(), "https://custom.example/v1")

    def test_set_api_url_rejects_remote_plain_http_and_keeps_prior(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_openai_asr_api_url("https://custom.example/v1"))
            self.assertFalse(config.set_openai_asr_api_url("http://evil.example/v1"))
            self.assertEqual(config.get_openai_asr_api_url(), "https://custom.example/v1")

    def test_set_api_url_accepts_loopback_plain_http(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            for url in (
                "http://localhost:9000/v1",
                "http://127.0.0.1:9000/v1",
                "http://[::1]:9000/v1",
            ):
                with self.subTest(url=url):
                    self.assertTrue(config.set_openai_asr_api_url(url))
                    self.assertEqual(config.get_openai_asr_api_url(), url)

    def test_set_api_url_rejects_malformed_url_without_raising(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            with self.assertLogs("src.config", level="ERROR") as captured:
                try:
                    result = config.set_openai_asr_api_url("http://[")
                except ValueError as error:
                    self.fail(f"setter raised instead of returning False: {error}")
            self.assertFalse(result)
            self.assertIn("URL", " ".join(captured.output))

    def test_set_api_url_rejects_missing_host_or_embedded_credentials(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            for url in ("https://", "https://key@example.com/v1"):
                with self.subTest(url=url):
                    self.assertFalse(config.set_openai_asr_api_url(url))

    def test_set_api_url_rejects_cross_runtime_ambiguous_text(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            for url in (
                "https://provider.example/space here/v1",
                "https://provider.example\\redirect.example/v1",
                "https://faß.de/v1",
            ):
                with self.subTest(url=url):
                    self.assertFalse(config.set_openai_asr_api_url(url))

    def test_set_api_url_rejects_every_query_and_fragment_and_keeps_prior(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            prior = "https://custom.example/v1"
            self.assertTrue(config.set_openai_asr_api_url(prior))
            for suffix in (
                "?key=secret",
                "?subscription-key=secret",
                "?sig=secret",
                "?unknown-provider-field=secret",
                "#credential-fragment",
                "?",
                "#",
            ):
                with self.subTest(suffix=suffix):
                    self.assertFalse(config.set_openai_asr_api_url(prior + suffix))
                    self.assertEqual(config.get_openai_asr_api_url(), prior)

    def test_set_model_rejects_blank_and_keeps_prior(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_openai_asr_model("whisper-large-v3"))
            self.assertFalse(config.set_openai_asr_model(""))
            self.assertFalse(config.set_openai_asr_model("   "))
            self.assertEqual(config.get_openai_asr_model(), "whisper-large-v3")

    def test_set_model_rejects_option_like_or_non_ascii_values_and_keeps_prior(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_openai_asr_model("whisper-large-v3"))
            for model in ("-whisper-1", "model with spaces", "mødel"):
                with self.subTest(model=model):
                    self.assertFalse(config.set_openai_asr_model(model))
                    self.assertEqual(config.get_openai_asr_model(), "whisper-large-v3")

    def test_get_model_falls_back_for_invalid_legacy_value(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"openai_asr_model": "-unsafe"}))
            self.assertEqual(Config(config_path=path).get_openai_asr_model(), "whisper-1")


class ConfigSummaryModelTests(unittest.TestCase):
    def test_default_model_is_gemma4_e2b(self):
        self.assertEqual(Config.DEFAULT_MODEL, "gemma4:e2b-it-qat")

    def test_get_model_returns_default_on_fresh_config(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertEqual(config.get_model(), "gemma4:e2b-it-qat")

    def test_default_model_is_first_active_entry_in_registry(self):
        # The Settings UI relies on active models being listed first, default
        # first. The default must be a registered model and the first key.
        self.assertIn(Config.DEFAULT_MODEL, Config.SUPPORTED_MODELS)
        first_key = next(iter(Config.SUPPORTED_MODELS))
        self.assertEqual(first_key, Config.DEFAULT_MODEL)
        self.assertNotEqual(
            Config.SUPPORTED_MODELS[Config.DEFAULT_MODEL].get("deprecated"), True
        )

    def test_llama32_deprecated_but_kept(self):
        # Deprecated (tucked into the dimmed Settings section) but NOT removed,
        # so a user already on it keeps a recognised selection.
        self.assertIn("llama3.2:3b", Config.SUPPORTED_MODELS)
        self.assertEqual(
            Config.SUPPORTED_MODELS["llama3.2:3b"].get("deprecated"), True
        )

    def test_existing_user_choice_survives_default_swap(self):
        # Migration safety: a user on a still-supported (even deprecated) model
        # keeps it; only a fresh config (no stored "model") gets the default.
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_model("llama3.2:3b"))
            reloaded = Config(config_path=path)
            self.assertEqual(reloaded.get_model(), "llama3.2:3b")

    def test_removed_model_migrates_to_default(self):
        # A user pinned to a model retired from SUPPORTED_MODELS (e.g. the
        # removed gemma3:4b) is migrated to the default on load, not left stuck.
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"model": "gemma3:4b"}))
            config = Config(config_path=path)
            self.assertEqual(config.get_model(), "gemma4:e2b-it-qat")
            # Persisted so the migration doesn't re-run forever.
            self.assertEqual(json.loads(path.read_text())["model"], "gemma4:e2b-it-qat")

    def test_renamed_model_migrates_to_qat_build(self):
        # A user pinned to a renamed tag (gemma4:12b / gemma4:4b) is moved to
        # the equivalent quantization-aware build, preserving their model choice
        # rather than dropping them to the default.
        for old, new in (("gemma4:12b", "gemma4:12b-it-qat"),
                         ("gemma4:4b", "gemma4:e4b-it-qat")):
            with self.subTest(old=old):
                with tempfile.TemporaryDirectory() as tmp_dir:
                    path = Path(tmp_dir) / "config.json"
                    path.write_text(json.dumps({"model": old}))
                    config = Config(config_path=path)
                    self.assertEqual(config.get_model(), new)
                    # Persisted so the migration doesn't re-run forever.
                    self.assertEqual(json.loads(path.read_text())["model"], new)

    def test_custom_pulled_model_is_not_migrated(self):
        # set_model intentionally allows arbitrary user-pulled Ollama models
        # (not in SUPPORTED_MODELS). The migration must only touch the specific
        # retired ids — a custom model must survive a reload untouched.
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"model": "llama3.2:1b"}))
            config = Config(config_path=path)
            self.assertEqual(config.get_model(), "llama3.2:1b")


class ConfigWhisperModelMigrationTests(unittest.TestCase):
    """_migrate_whisper_model runs at load time to rescue configs that hold
    values outside the current SUPPORTED_WHISPER_MODELS list. Bare 'large'
    is the critical case — pywhispercpp.AVAILABLE_MODELS doesn't include it
    and the native loader segfaults if we let the value through to Model()."""

    def _write_config(self, path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload))

    def test_migrates_bare_large_to_turbo(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            self._write_config(path, {"whisper_model": "large"})
            config = Config(config_path=path)
            self.assertEqual(config.get_whisper_model(), "large-v3-turbo")
            # Persisted to disk so the migration doesn't re-run forever.
            self.assertEqual(
                json.loads(path.read_text())["whisper_model"], "large-v3-turbo"
            )

    def test_migrates_retired_tier_to_turbo(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            self._write_config(path, {"whisper_model": "medium"})
            config = Config(config_path=path)
            self.assertEqual(config.get_whisper_model(), "large-v3-turbo")
            self.assertEqual(
                json.loads(path.read_text())["whisper_model"], "large-v3-turbo"
            )

    def test_leaves_supported_value_untouched(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            self._write_config(path, {"whisper_model": "large-v3-turbo"})
            Config(config_path=path)
            # No rewrite happened — value identical, no migration thrash.
            self.assertEqual(
                json.loads(path.read_text())["whisper_model"], "large-v3-turbo"
            )


class ConfigAutoDetectMeetingsTests(unittest.TestCase):
    def test_default_auto_detect_meetings_is_true(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.get_auto_detect_meetings_enabled())

    def test_auto_detect_meetings_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_auto_detect_meetings_enabled(False))
            self.assertFalse(config.get_auto_detect_meetings_enabled())
            reloaded = Config(config_path=path)
            self.assertFalse(reloaded.get_auto_detect_meetings_enabled())
            self.assertTrue(reloaded.set_auto_detect_meetings_enabled(True))
            self.assertTrue(reloaded.get_auto_detect_meetings_enabled())


class ConfigLaunchOnLoginTests(unittest.TestCase):
    def test_default_launch_on_login_is_true(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.get_launch_on_login())

    def test_legacy_config_without_key_defaults_true(self):
        # Existing installs whose config predates this key must default ON.
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"model": "gemma3:4b"}))
            config = Config(config_path=path)
            self.assertTrue(config.get_launch_on_login())

    def test_launch_on_login_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_launch_on_login(False))
            self.assertFalse(config.get_launch_on_login())
            reloaded = Config(config_path=path)
            self.assertFalse(reloaded.get_launch_on_login())
            self.assertTrue(reloaded.set_launch_on_login(True))
            self.assertTrue(reloaded.get_launch_on_login())


class ConfigRecordHotkeyTests(unittest.TestCase):
    def test_default_record_hotkey_is_true(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.get_record_hotkey_enabled())

    def test_legacy_config_without_key_defaults_true(self):
        # Existing installs whose config predates this key must default ON
        # (back-compat: the shortcut was unconditionally registered before).
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"model": "gemma3:4b"}))
            config = Config(config_path=path)
            self.assertTrue(config.get_record_hotkey_enabled())

    def test_record_hotkey_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_record_hotkey_enabled(False))
            self.assertFalse(config.get_record_hotkey_enabled())
            reloaded = Config(config_path=path)
            self.assertFalse(reloaded.get_record_hotkey_enabled())
            self.assertTrue(reloaded.set_record_hotkey_enabled(True))
            self.assertTrue(reloaded.get_record_hotkey_enabled())


class ConfigPrivacyNoticeTests(unittest.TestCase):
    def test_fresh_install_seeds_notice_seen_true(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)

            self.assertTrue(config.get_privacy_notice_seen())
            self.assertIs(json.loads(path.read_text())["privacy_notice_seen"], True)

    def test_existing_config_without_marker_seeds_false_and_persists(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"model": Config.DEFAULT_MODEL}))

            config = Config(config_path=path)

            self.assertFalse(config.get_privacy_notice_seen())
            self.assertIs(json.loads(path.read_text())["privacy_notice_seen"], False)

    def test_set_notice_seen_true_round_trips_and_persists(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"model": Config.DEFAULT_MODEL}))
            config = Config(config_path=path)

            self.assertTrue(config.set_privacy_notice_seen(True))
            self.assertTrue(config.get_privacy_notice_seen())
            self.assertIs(json.loads(path.read_text())["privacy_notice_seen"], True)
            self.assertTrue(Config(config_path=path).get_privacy_notice_seen())

    def test_present_marker_prevents_retrigger(self):
        for seen in (False, True):
            with self.subTest(seen=seen):
                with tempfile.TemporaryDirectory() as tmp_dir:
                    path = Path(tmp_dir) / "config.json"
                    payload = {
                        "model": Config.DEFAULT_MODEL,
                        "privacy_notice_seen": seen,
                    }
                    path.write_text(json.dumps(payload))

                    config = Config(config_path=path)

                    self.assertIs(config.get_privacy_notice_seen(), seen)
                    self.assertIs(
                        json.loads(path.read_text())["privacy_notice_seen"], seen
                    )

    def test_corrupt_config_never_persisted(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text("{not json")

            config = Config(config_path=path)

            self.assertTrue(config.get_privacy_notice_seen())
            self.assertEqual(path.read_text(), "{not json")

    def test_migration_cas_adopts_marker_that_lands_first(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "model": Config.DEFAULT_MODEL,
                        "privacy_notice_seen": True,
                    }
                )
            )
            config = Config(config_path=path)
            config._config["privacy_notice_seen"] = False
            config._snapshot.pop("privacy_notice_seen", None)

            config._persist_privacy_notice_migration()

            self.assertIs(json.loads(path.read_text())["privacy_notice_seen"], True)
            self.assertTrue(config.get_privacy_notice_seen())
            self.assertIs(config._snapshot["privacy_notice_seen"], True)


class ConfigOrgAutoBackupTests(unittest.TestCase):
    def test_default_auto_backup_is_true(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.get_org_auto_backup_enabled())

    def test_seed_applies_default_when_no_preference(self):
        """First sign-in seeds the org's auto_share_default into config."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertFalse(config.seed_org_auto_backup_default(False))
            self.assertFalse(config.get_org_auto_backup_enabled())
            reloaded = Config(config_path=path)
            self.assertFalse(reloaded.get_org_auto_backup_enabled())

    def test_seed_does_not_clobber_explicit_user_choice(self):
        """Once the user sets the toggle, a later seed must not overwrite it —
        the enterprise sets the default only, the user's choice wins."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_org_auto_backup_enabled(True))
            # Org default is False, but the user already chose True.
            self.assertTrue(config.seed_org_auto_backup_default(False))
            self.assertTrue(config.get_org_auto_backup_enabled())

    def test_has_preference_distinguishes_unset_from_explicit_false(self):
        """The gate skips the /policy fetch + seed once a preference exists, so
        'unset' must be distinguishable from an explicit False (issue #192)."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            # Fresh config: no stored preference (get still defaults to True).
            self.assertFalse(config.has_org_auto_backup_preference())
            self.assertTrue(config.get_org_auto_backup_enabled())
            # An explicit False is a real preference, not "unset".
            self.assertTrue(config.set_org_auto_backup_enabled(False))
            self.assertTrue(config.has_org_auto_backup_preference())
            self.assertTrue(Config(config_path=path).has_org_auto_backup_preference())

    def test_has_preference_true_after_seed(self):
        """Seeding the org default materialises a preference, so subsequent
        backups can skip the seed."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertFalse(config.has_org_auto_backup_preference())
            config.seed_org_auto_backup_default(True)
            self.assertTrue(config.has_org_auto_backup_preference())


class ConfigKeepRecordingsTests(unittest.TestCase):
    def test_default_keep_recordings_is_false(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertFalse(config.get_keep_recordings())

    def test_keep_recordings_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_keep_recordings(True))
            self.assertTrue(config.get_keep_recordings())
            reloaded = Config(config_path=path)
            self.assertTrue(reloaded.get_keep_recordings())
            self.assertTrue(reloaded.set_keep_recordings(False))
            self.assertFalse(reloaded.get_keep_recordings())


class ConfigAutoSummarizeTests(unittest.TestCase):
    def test_default_auto_summarize_is_false(self):
        # Default OFF: a fresh install stops at a transcript-only note; notes are
        # generated on demand (meeting-end "Summarise" prompt / in-note CTA).
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertFalse(config.get_auto_summarize_enabled())

    def test_auto_summarize_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_auto_summarize_enabled(False))
            self.assertFalse(config.get_auto_summarize_enabled())
            reloaded = Config(config_path=path)
            self.assertFalse(reloaded.get_auto_summarize_enabled())
            self.assertTrue(reloaded.set_auto_summarize_enabled(True))
            self.assertTrue(reloaded.get_auto_summarize_enabled())


class ConfigAutoInstallWhenIdleTests(unittest.TestCase):
    def test_default_auto_install_when_idle_is_true(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.get_auto_install_when_idle())

    def test_auto_install_when_idle_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_auto_install_when_idle(False))
            self.assertFalse(config.get_auto_install_when_idle())
            reloaded = Config(config_path=path)
            self.assertFalse(reloaded.get_auto_install_when_idle())
            self.assertTrue(reloaded.set_auto_install_when_idle(True))
            self.assertTrue(reloaded.get_auto_install_when_idle())


class ConfigIdentityMatchingEnabledTests(unittest.TestCase):
    def test_default_identity_matching_enabled_is_false(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertFalse(config.get_identity_matching_enabled())

    def test_string_false_does_not_enable_identity_matching(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({
                "identity_matching_enabled": "false",
                "identity_matching_privacy_default_version": 1,
            }))
            self.assertFalse(Config(config_path=path).get_identity_matching_enabled())

    def test_existing_implicit_default_is_migrated_to_false_once(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"identity_matching_enabled": True}))

            config = Config(config_path=path)

            self.assertFalse(config.get_identity_matching_enabled())
            on_disk = json.loads(path.read_text())
            self.assertFalse(on_disk["identity_matching_enabled"])
            self.assertEqual(on_disk["identity_matching_privacy_default_version"], 1)

    def test_malformed_migration_marker_falls_back_to_privacy_safe_default(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "identity_matching_enabled": True,
                        "identity_matching_privacy_default_version": "invalid",
                    }
                )
            )

            config = Config(config_path=path)

            self.assertFalse(config.get_identity_matching_enabled())
            on_disk = json.loads(path.read_text())
            self.assertFalse(on_disk["identity_matching_enabled"])
            self.assertEqual(on_disk["identity_matching_privacy_default_version"], 1)

    def test_explicit_opt_in_survives_reload_after_privacy_migration(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"identity_matching_enabled": True}))

            migrated = Config(config_path=path)
            self.assertFalse(migrated.get_identity_matching_enabled())
            self.assertTrue(migrated.set_identity_matching_enabled(True))

            reloaded = Config(config_path=path)
            self.assertTrue(reloaded.get_identity_matching_enabled())
            self.assertEqual(
                json.loads(path.read_text())["identity_matching_privacy_default_version"],
                1,
            )

    def test_identity_matching_enabled_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_identity_matching_enabled(False))
            self.assertFalse(config.get_identity_matching_enabled())
            reloaded = Config(config_path=path)
            self.assertFalse(reloaded.get_identity_matching_enabled())
            self.assertTrue(reloaded.set_identity_matching_enabled(True))
            self.assertTrue(reloaded.get_identity_matching_enabled())


class ConfigBedrockSettingsTests(unittest.TestCase):
    def test_default_bedrock_region_is_us_east_1(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertEqual(config.get_bedrock_region(), "us-east-1")

    def test_set_bedrock_region_persists_and_trims(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.set_bedrock_region("  eu-west-1  "))
            self.assertEqual(config.get_bedrock_region(), "eu-west-1")
            reloaded = Config(config_path=path)
            self.assertEqual(reloaded.get_bedrock_region(), "eu-west-1")

    def test_set_bedrock_region_rejects_empty(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            # Seed a known good value so we can assert it isn't clobbered.
            config.set_bedrock_region("ap-southeast-2")
            self.assertFalse(config.set_bedrock_region(""))
            self.assertFalse(config.set_bedrock_region("   "))
            self.assertEqual(config.get_bedrock_region(), "ap-southeast-2")

    def test_set_bedrock_region_rejects_malformed_values(self):
        # A region string shaped to redirect the request to a different host
        # via the `user@host` URL syntax once it's interpolated into
        # bedrock_converse_url() — see issue #299. Must never persist.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.set_bedrock_region("ap-southeast-2")
            self.assertFalse(config.set_bedrock_region("x@127.0.0.1:8443/"))
            self.assertFalse(config.set_bedrock_region("us-east-1/../evil"))
            self.assertFalse(config.set_bedrock_region("not a region"))
            self.assertFalse(config.set_bedrock_region("us-east-١"))  # Arabic-Indic 1
            self.assertEqual(config.get_bedrock_region(), "ap-southeast-2")

    def test_set_bedrock_region_strips_trailing_whitespace_before_validating(self):
        # set_bedrock_region() strips before validating (unlike
        # bedrock_converse_url(), the sink, which must reject a trailing
        # "\n" defensively since it can't assume every caller stripped).
        # A trailing newline here is just whitespace, not a bypass.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_bedrock_region("us-east-1\n"))
            self.assertEqual(config.get_bedrock_region(), "us-east-1")

    def test_set_bedrock_region_accepts_real_aws_shapes(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            for region in ("us-east-1", "eu-west-2", "us-gov-west-1", "cn-northwest-1", "ca-central-1"):
                self.assertTrue(config.set_bedrock_region(region), region)
                self.assertEqual(config.get_bedrock_region(), region)

    def test_default_inference_profile_is_empty_string(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertEqual(config.get_bedrock_inference_profile(), "")

    def test_set_inference_profile_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            profile = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
            self.assertTrue(config.set_bedrock_inference_profile(profile))
            self.assertEqual(config.get_bedrock_inference_profile(), profile)
            reloaded = Config(config_path=path)
            self.assertEqual(reloaded.get_bedrock_inference_profile(), profile)

    def test_empty_inference_profile_clears_value(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.set_bedrock_inference_profile("us.anthropic.claude-x-v1:0")
            self.assertTrue(config.set_bedrock_inference_profile(""))
            self.assertEqual(config.get_bedrock_inference_profile(), "")

    def test_whitespace_inference_profile_stored_in_config_is_normalised(self):
        # A hand-edited config.json with a whitespace-only inference profile
        # would otherwise survive `target = profile or model_id` in
        # _bedrock_chat (truthy string) and produce a URL with %20 in place
        # of the model id. Belt-and-braces strip on read.
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text(json.dumps({"bedrock_inference_profile": "   "}))
            config = Config(config_path=path)
            self.assertEqual(config.get_bedrock_inference_profile(), "")

    def test_bedrock_is_a_valid_cloud_provider(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertIn("bedrock", config.VALID_CLOUD_PROVIDERS)
            self.assertTrue(config.set_cloud_provider("bedrock"))
            self.assertEqual(config.get_cloud_provider(), "bedrock")

    def test_bedrock_has_default_cloud_model(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.set_cloud_provider("bedrock")
            # CLOUD_MODEL_DEFAULTS entry surfaces as the get_cloud_model
            # fallback when no model has been remembered for this provider yet.
            self.assertEqual(
                config.get_cloud_model(),
                "anthropic.claude-haiku-4-5-20251001-v1:0",
            )


class ConfigTemplateSeedingResilienceTests(unittest.TestCase):
    def _config_with(self, custom_templates):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "config.json"
        path.write_text(
            json.dumps({"custom_templates": custom_templates}), encoding="utf-8"
        )
        # Construction runs _seed_sample_template(); must not raise on bad data.
        return Config(config_path=path)

    def test_seeding_survives_non_list_custom_templates(self):
        config = self._config_with({"oops": "not a list"})
        self.assertIsInstance(config._config["custom_templates"], list)

    def test_seeding_drops_non_dict_entries(self):
        config = self._config_with(["nope", 42, None, {"id": "keep", "name": "K"}])
        ids = [t.get("id") for t in config._config["custom_templates"]]
        self.assertIn("keep", ids)
        self.assertNotIn("nope", ids)


class MlxTagResolutionTests(unittest.TestCase):
    def test_is_apple_silicon_true_on_darwin_arm64(self):
        with patch("src.config.sys.platform", "darwin"), \
             patch("src.config.platform.machine", return_value="arm64"):
            from src.config import is_apple_silicon
            self.assertTrue(is_apple_silicon())

    def test_is_apple_silicon_false_on_darwin_x86_64(self):
        with patch("src.config.sys.platform", "darwin"), \
             patch("src.config.platform.machine", return_value="x86_64"):
            from src.config import is_apple_silicon
            self.assertFalse(is_apple_silicon())

    def test_is_apple_silicon_false_on_windows(self):
        with patch("src.config.sys.platform", "win32"), \
             patch("src.config.platform.machine", return_value="ARM64"):
            from src.config import is_apple_silicon
            self.assertFalse(is_apple_silicon())

    def test_resolve_runtime_tag_maps_gguf_to_nvfp4_on_apple_silicon(self):
        from src.config import resolve_runtime_tag
        with patch("src.config.is_apple_silicon", return_value=True):
            self.assertEqual(resolve_runtime_tag("gemma4:e2b-it-qat"), "gemma4:e2b-nvfp4")
            self.assertEqual(resolve_runtime_tag("gemma4:e4b-it-qat"), "gemma4:e4b-nvfp4")
            self.assertEqual(resolve_runtime_tag("gemma4:12b-it-qat"), "gemma4:12b-nvfp4")

    def test_resolve_runtime_tag_is_noop_off_apple_silicon(self):
        from src.config import resolve_runtime_tag
        with patch("src.config.is_apple_silicon", return_value=False):
            self.assertEqual(resolve_runtime_tag("gemma4:e2b-it-qat"), "gemma4:e2b-it-qat")

    def test_resolve_runtime_tag_is_noop_for_non_gemma_models(self):
        from src.config import resolve_runtime_tag
        with patch("src.config.is_apple_silicon", return_value=True):
            self.assertEqual(resolve_runtime_tag("llama3.2:3b"), "llama3.2:3b")
            self.assertEqual(resolve_runtime_tag("qwen3.5:9b"), "qwen3.5:9b")
            self.assertEqual(resolve_runtime_tag("gpt-oss:20b"), "gpt-oss:20b")

    def test_mlx_to_gguf_is_exact_reverse_of_mlx_equivalents(self):
        from src.config import Config
        for gguf_id, mlx_tag in Config._MLX_EQUIVALENTS.items():
            self.assertEqual(Config._MLX_TO_GGUF[mlx_tag], gguf_id)
        self.assertEqual(len(Config._MLX_TO_GGUF), len(Config._MLX_EQUIVALENTS))


class ConfigPersonProfileTests(unittest.TestCase):
    """PersonProfile/SpeakerPrototype: the named (non-self) speaker-identity
    store. See src.speaker_suggestions for how these get consumed — this
    file only covers the Config-level CRUD."""

    def test_create_person_profile_starts_empty(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            profile = config.create_person_profile("Person Gamma")
            self.assertEqual(profile["display_name"], "Person Gamma")
            self.assertEqual(profile["prototypes"], [])
            self.assertEqual(profile["hard_negatives"], [])
            self.assertIn("person_id", profile)

    def test_create_person_profile_reports_a_write_failure(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            with patch.object(config, "commit_transaction", return_value=False):
                with self.assertRaises(OSError):
                    config.create_person_profile("Person Gamma")
            self.assertEqual(config.get_person_profiles(), [])

    def test_save_voiceprint_rolls_back_a_write_failure(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            with patch.object(config, "_save", return_value=False):
                self.assertIsNone(config.save_voiceprint("Person Gamma", [1.0, 0.0]))
            self.assertEqual(config.get_voiceprints(), [])

    def test_pruning_tolerates_malformed_persisted_rank_fields(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config = Config(config_path=config_path)
            person = config.create_person_profile("Person Gamma")
            malformed = {
                "prototype_id": "damaged",
                "person_id": person["person_id"],
                "embedding_mean": [1.0, 0.0],
                "recording_type": "in_person",
                "channel": "mic",
                "meeting_id": "old-meeting",
                "quality_score": "not-a-number",
                "created_at": [],
            }
            malformed_ids = [
                f"damaged-{index}"
                for index in range(Config.MAX_PROTOTYPES_PER_CONTEXT + 6)
            ]
            document = json.loads(config_path.read_text())
            document["person_profiles"][0]["prototypes"] = [
                {**malformed, "prototype_id": prototype_id}
                for prototype_id in malformed_ids
            ]
            config_path.write_text(json.dumps(document))
            persisted_before = json.loads(config_path.read_text())
            self.assertGreater(
                len(persisted_before["person_profiles"][0]["prototypes"]),
                Config.MAX_PROTOTYPES_PER_CONTEXT,
            )

            result = config.add_speaker_prototype(
                person["person_id"], [1.0, 0.0], recording_type="in_person",
                meeting_id="new-meeting", diarization_speaker_id="SPEAKER_0",
                speech_duration_seconds=30.0, segment_count=4,
                created_from="user_confirmed", channel="mic",
            )

            self.assertIsNotNone(result)
            persisted_after = json.loads(config_path.read_text())
            retained = persisted_after["person_profiles"][0]["prototypes"]
            retained_ids = {entry["prototype_id"] for entry in retained}
            self.assertEqual(len(retained), Config.MAX_PROTOTYPES_PER_CONTEXT)
            self.assertIn(result["prototype_id"], retained_ids)
            self.assertEqual(
                retained_ids - {result["prototype_id"]},
                set(
                    sorted(malformed_ids, reverse=True)[
                        :Config.MAX_PROTOTYPES_PER_CONTEXT - 1
                    ]
                ),
            )

    def test_get_person_profiles_persists_across_reload(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config = Config(config_path=config_path)
            config.create_person_profile("Person Gamma")
            reloaded = Config(config_path=config_path)
            names = [p["display_name"] for p in reloaded.get_person_profiles()]
            self.assertEqual(names, ["Person Gamma"])

    def test_get_person_profile_by_id(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            created = config.create_person_profile("Person Gamma")
            fetched = config.get_person_profile(created["person_id"])
            self.assertEqual(fetched["display_name"], "Person Gamma")
            self.assertIsNone(config.get_person_profile("nonexistent"))

    def test_create_person_profile_rejects_exact_duplicate_name(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.create_person_profile("Person Gamma")
            with self.assertRaises(ValueError):
                config.create_person_profile("Person Gamma")
            self.assertEqual(len(config.get_person_profiles()), 1)

    def test_create_person_profile_rejects_case_and_whitespace_variant(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.create_person_profile("Person Gamma")
            with self.assertRaises(ValueError):
                config.create_person_profile("  person gamma  ")
            self.assertEqual(len(config.get_person_profiles()), 1)

    def test_create_person_profile_rejects_unicode_compatibility_variant(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.create_person_profile("Person")
            with self.assertRaises(ValueError):
                config.create_person_profile("Ｐｅｒｓｏｎ")
            self.assertEqual(len(config.get_person_profiles()), 1)

    def test_create_person_profile_allows_distinct_names(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.create_person_profile("Person Gamma")
            config.create_person_profile("Maxine")
            self.assertEqual(len(config.get_person_profiles()), 2)

    def test_rename_person_profile(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            created = config.create_person_profile("Person Gamma")
            self.assertTrue(config.rename_person_profile(created["person_id"], "Maximilian"))
            self.assertEqual(
                config.get_person_profile(created["person_id"])["display_name"],
                "Maximilian",
            )

    def test_rename_person_profile_returns_false_for_missing_person(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertFalse(config.rename_person_profile("nonexistent", "X"))

    def test_rename_person_profile_rejects_collision_with_another_person(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            config.create_person_profile("Person Gamma")
            person_alpha = config.create_person_profile("Person Alpha")
            with self.assertRaises(ValueError):
                config.rename_person_profile(person_alpha["person_id"], "person gamma")
            self.assertEqual(config.get_person_profile(person_alpha["person_id"])["display_name"], "Person Alpha")

    def test_rename_person_profile_to_its_own_current_name_is_a_noop_allowed(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            created = config.create_person_profile("Person Gamma")
            self.assertTrue(config.rename_person_profile(created["person_id"], "Person Gamma"))

    def test_delete_person_profile(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            created = config.create_person_profile("Person Gamma")
            self.assertTrue(config.delete_person_profile(created["person_id"]))
            self.assertEqual(config.get_person_profiles(), [])

    def test_delete_person_profile_returns_false_for_missing_person(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertFalse(config.delete_person_profile("nonexistent"))

    def test_delete_person_profile_strips_hard_negatives_derived_from_them_in_other_profiles(self):
        # Mirrors confirm-speaker's mutual-hard-negative shape: confirming
        # Person Gamma next to Person Alpha in the same meeting+channel writes a
        # hard-negative into Person Alpha's profile whose embedding is literally
        # Person Gamma's own voice sample, tagged with the meeting/channel/sid Person Gamma
        # was confirmed under. Deleting Person Gamma must not leave that sample
        # sitting in Person Alpha's profile forever.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person_gamma = config.create_person_profile("Person Gamma")
            person_alpha = config.create_person_profile("Person Alpha")

            # Person Gamma's own positive evidence -- what delete_person_profile reads
            # to know which cross-referenced hard negatives to strip.
            config.add_speaker_prototype(
                person_gamma["person_id"], [0.1, 0.2, 0.3],
                recording_type="in_person", meeting_id="mtg1",
                diarization_speaker_id="SPEAKER_0", channel="mic",
                speech_duration_seconds=30.0, segment_count=5,
                created_from="user_confirmed",
            )
            # Person Alpha's hard negative derived from Person Gamma's confirmation above.
            config.add_speaker_prototype(
                person_alpha["person_id"], [0.1, 0.2, 0.3],
                recording_type="in_person", meeting_id="mtg1",
                diarization_speaker_id="SPEAKER_0", channel="mic",
                speech_duration_seconds=30.0, segment_count=5,
                created_from="user_confirmed", negative=True,
            )
            # An UNRELATED hard negative on Person Alpha (different meeting) must survive.
            config.add_speaker_prototype(
                person_alpha["person_id"], [0.9, 0.9, 0.9],
                recording_type="in_person", meeting_id="mtg2",
                diarization_speaker_id="SPEAKER_1", channel="mic",
                speech_duration_seconds=30.0, segment_count=5,
                created_from="user_confirmed", negative=True,
            )

            self.assertTrue(config.delete_person_profile(person_gamma["person_id"]))

            alpha_after = config.get_person_profile(person_alpha["person_id"])
            remaining_meetings = {h["meeting_id"] for h in alpha_after["hard_negatives"]}
            self.assertNotIn("mtg1", remaining_meetings)
            self.assertIn("mtg2", remaining_meetings)

    def test_add_speaker_prototype_appends_positive_evidence(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            prototype = config.add_speaker_prototype(
                person["person_id"], [0.1, 0.2, 0.3],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_02",
                speech_duration_seconds=25.0, segment_count=4,
                created_from="user_confirmed",
            )
            self.assertEqual(prototype["embedding_mean"], [0.1, 0.2, 0.3])
            self.assertEqual(prototype["recording_type"], "in_person")
            profile = config.get_person_profile(person["person_id"])
            self.assertEqual(len(profile["prototypes"]), 1)
            self.assertEqual(profile["hard_negatives"], [])

    def test_add_speaker_prototype_negative_goes_to_hard_negatives(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            config.add_speaker_prototype(
                person["person_id"], [0.1, 0.2, 0.3],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=25.0, segment_count=4,
                created_from="user_confirmed", negative=True,
            )
            profile = config.get_person_profile(person["person_id"])
            self.assertEqual(profile["prototypes"], [])
            self.assertEqual(len(profile["hard_negatives"]), 1)

    def test_add_speaker_prototype_returns_none_for_missing_person(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            result = config.add_speaker_prototype(
                "nonexistent", [0.1, 0.2],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=25.0, segment_count=4,
                created_from="user_confirmed",
            )
            self.assertIsNone(result)

    def test_add_speaker_prototype_rejects_invalid_recording_type(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            with self.assertRaises(ValueError):
                config.add_speaker_prototype(
                    person["person_id"], [0.1, 0.2],
                    recording_type="on_the_moon", meeting_id="mtg001",
                    diarization_speaker_id="SPEAKER_00",
                    speech_duration_seconds=25.0, segment_count=4,
                    created_from="user_confirmed",
                )

    def test_add_speaker_prototype_rejects_invalid_created_from(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            with self.assertRaises(ValueError):
                config.add_speaker_prototype(
                    person["person_id"], [0.1, 0.2],
                    recording_type="in_person", meeting_id="mtg001",
                    diarization_speaker_id="SPEAKER_00",
                    speech_duration_seconds=25.0, segment_count=4,
                    created_from="telepathy",
                )

    def test_add_speaker_prototype_stores_channel_when_given(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            prototype = config.add_speaker_prototype(
                person["person_id"], [0.1, 0.2],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=25.0, segment_count=4,
                created_from="user_confirmed", channel="mic",
            )
            self.assertEqual(prototype["channel"], "mic")

    def test_add_speaker_prototype_omits_channel_when_none(self):
        # Legacy/enrollment shape: no channel key at all, so matchers'
        # recording_type fallback path stays distinguishable from an
        # explicitly recorded channel.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            prototype = config.add_speaker_prototype(
                person["person_id"], [0.1, 0.2],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=25.0, segment_count=4,
                created_from="user_confirmed",
            )
            self.assertNotIn("channel", prototype)

    def test_add_speaker_prototype_stores_diarization_run_id_when_given(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Max")
            prototype = config.add_speaker_prototype(
                person["person_id"], [0.1, 0.2],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=25.0, segment_count=4,
                created_from="user_confirmed", diarization_run_id="r1",
            )
            self.assertEqual(prototype["diarization_run_id"], "r1")

    def test_add_speaker_prototype_omits_diarization_run_id_when_none(self):
        # Same absent-means-legacy convention as `channel`: a prototype
        # written before this field existed, or from a caller that has no
        # run to report, must read exactly like one written today with no
        # run id -- not like one that carries an explicit `None`.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Max")
            prototype = config.add_speaker_prototype(
                person["person_id"], [0.1, 0.2],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=25.0, segment_count=4,
                created_from="user_confirmed",
            )
            self.assertNotIn("diarization_run_id", prototype)

    def test_add_speaker_prototype_rejects_invalid_channel(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            with self.assertRaises(ValueError):
                config.add_speaker_prototype(
                    person["person_id"], [0.1, 0.2],
                    recording_type="in_person", meeting_id="mtg001",
                    diarization_speaker_id="SPEAKER_00",
                    speech_duration_seconds=25.0, segment_count=4,
                    created_from="user_confirmed", channel="microphone",
                )

    def _add(self, config, person_id, meeting_id, sid, channel=None,
             recording_type="in_person", negative=False, diarization_run_id=None):
        return config.add_speaker_prototype(
            person_id, [0.1, 0.2],
            recording_type=recording_type, meeting_id=meeting_id,
            diarization_speaker_id=sid,
            speech_duration_seconds=25.0, segment_count=4,
            created_from="user_confirmed", channel=channel, negative=negative,
            diarization_run_id=diarization_run_id,
        )

    def test_remove_speaker_evidence_scopes_to_meeting_and_channel(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            pid = person["person_id"]
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic")
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="system", recording_type="remote")
            self._add(config, pid, "mtg002", "SPEAKER_00", channel="mic")
            removed = config.remove_speaker_evidence(
                pid, meeting_id="mtg001", channel="mic",
                channel_recording_type="in_person",
            )
            self.assertEqual(removed, 1)
            remaining = config.get_person_profile(pid)["prototypes"]
            self.assertEqual(
                {(p["meeting_id"], p["channel"]) for p in remaining},
                {("mtg001", "system"), ("mtg002", "mic")},
            )

    def test_remove_speaker_evidence_sid_restriction_and_negatives(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            pid = person["person_id"]
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic", negative=True)
            self._add(config, pid, "mtg001", "SPEAKER_01", channel="mic", negative=True)
            removed = config.remove_speaker_evidence(
                pid, meeting_id="mtg001", channel="mic",
                channel_recording_type="in_person",
                sids={"SPEAKER_00"}, negative=True,
            )
            self.assertEqual(removed, 1)
            profile = config.get_person_profile(pid)
            self.assertEqual(len(profile["hard_negatives"]), 1)
            self.assertEqual(profile["hard_negatives"][0]["diarization_speaker_id"], "SPEAKER_01")
            # Positives untouched by a negative=True removal.
            self.assertEqual(profile["prototypes"], [])

    def test_remove_speaker_evidence_matches_legacy_entries_via_recording_type(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            pid = person["person_id"]
            self._add(config, pid, "mtg001", "SPEAKER_00")  # legacy: no channel
            removed = config.remove_speaker_evidence(
                pid, meeting_id="mtg001", channel="mic",
                channel_recording_type="in_person",
            )
            self.assertEqual(removed, 1)

    def test_remove_speaker_evidence_without_a_run_scope_ignores_run_ids(self):
        # The sentinel default is what every pre-existing caller relies on:
        # omitting the parameter must not start filtering, or the repair and
        # correction paths that never learned about runs would quietly stop
        # removing anything.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            pid = config.create_person_profile("Max")["person_id"]
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic", diarization_run_id="r1")
            self._add(config, pid, "mtg001", "SPEAKER_01", channel="mic", diarization_run_id="r2")
            self._add(config, pid, "mtg001", "SPEAKER_02", channel="mic")
            removed = config.remove_speaker_evidence(
                pid, meeting_id="mtg001", channel="mic",
                channel_recording_type="in_person",
            )
            self.assertEqual(removed, 3)
            self.assertEqual(config.get_person_profile(pid)["prototypes"], [])

    def test_remove_speaker_evidence_scoped_to_a_run_spares_other_runs(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            pid = config.create_person_profile("Max")["person_id"]
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic", diarization_run_id="r1")
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic", diarization_run_id="r2")
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic")
            removed = config.remove_speaker_evidence(
                pid, meeting_id="mtg001", channel="mic",
                channel_recording_type="in_person",
                sids={"SPEAKER_00"}, diarization_run_id="r2",
            )
            self.assertEqual(removed, 1)
            remaining = config.get_person_profile(pid)["prototypes"]
            self.assertEqual(
                [p.get("diarization_run_id") for p in remaining], ["r1", None],
            )

    def test_remove_speaker_evidence_scoped_to_none_only_removes_run_less_entries(self):
        # An explicit None is a real scope ("the sidecar reports no run"), not
        # the absence of one. Collapsing the two would make a caller working
        # against a legacy sidecar delete run-stamped evidence it cannot have
        # produced.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            pid = config.create_person_profile("Max")["person_id"]
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic", diarization_run_id="r1")
            self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic")
            removed = config.remove_speaker_evidence(
                pid, meeting_id="mtg001", channel="mic",
                channel_recording_type="in_person",
                sids={"SPEAKER_00"}, diarization_run_id=None,
            )
            self.assertEqual(removed, 1)
            remaining = config.get_person_profile(pid)["prototypes"]
            self.assertEqual([p.get("diarization_run_id") for p in remaining], ["r1"])

    def test_delete_person_profile_scopes_negative_cleanup_to_each_prototypes_run(self):
        # The negatives a confirm creates carry that confirm's run id, so the
        # cleanup that follows the deleted person's prototypes must not reach
        # past them into a later run's evidence about a still-existing person.
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            max_id = config.create_person_profile("Max")["person_id"]
            sarah_id = config.create_person_profile("Sarah")["person_id"]
            self._add(config, max_id, "mtg001", "SPEAKER_00", channel="mic", diarization_run_id="r1")
            # Sarah's negative derived from Max's r1 confirm, plus one from a
            # later re-diarization that has nothing to do with him.
            self._add(config, sarah_id, "mtg001", "SPEAKER_00", channel="mic",
                      negative=True, diarization_run_id="r1")
            self._add(config, sarah_id, "mtg001", "SPEAKER_00", channel="mic",
                      negative=True, diarization_run_id="r2")
            self.assertTrue(config.delete_person_profile(max_id))
            remaining = config.get_person_profile(sarah_id)["hard_negatives"]
            self.assertEqual([n["diarization_run_id"] for n in remaining], ["r2"])

    def test_remove_speaker_evidence_missing_person_returns_zero(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            removed = config.remove_speaker_evidence(
                "nonexistent", meeting_id="mtg001", channel="mic",
                channel_recording_type="in_person",
            )
            self.assertEqual(removed, 0)

    def test_remove_speaker_evidence_by_ids(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            pid = person["person_id"]
            keep = self._add(config, pid, "mtg001", "SPEAKER_00", channel="mic")
            drop = self._add(config, pid, "mtg002", "SPEAKER_00", channel="mic")
            removed = config.remove_speaker_evidence_by_ids(pid, {drop["prototype_id"]})
            self.assertEqual(removed, 1)
            remaining = config.get_person_profile(pid)["prototypes"]
            self.assertEqual([p["prototype_id"] for p in remaining], [keep["prototype_id"]])

    def test_set_speaker_evidence_channels_backfills_and_validates(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            pid = person["person_id"]
            legacy = self._add(config, pid, "mtg001", "SPEAKER_00")
            updated = config.set_speaker_evidence_channels(pid, {legacy["prototype_id"]: "mic"})
            self.assertEqual(updated, 1)
            profile = config.get_person_profile(pid)
            self.assertEqual(profile["prototypes"][0]["channel"], "mic")
            # Idempotent: setting the same channel again updates nothing.
            self.assertEqual(
                config.set_speaker_evidence_channels(pid, {legacy["prototype_id"]: "mic"}), 0,
            )
            with self.assertRaises(ValueError):
                config.set_speaker_evidence_channels(pid, {legacy["prototype_id"]: "microphone"})

    def test_quality_score_rewards_clearing_stability_bar(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            strong = config.add_speaker_prototype(
                person["person_id"], [0.1, 0.2],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=30.0, segment_count=5,
                created_from="user_confirmed",
            )
            weak = config.add_speaker_prototype(
                person["person_id"], [0.1, 0.2],
                recording_type="in_person", meeting_id="mtg002",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=2.0, segment_count=1,
                created_from="user_confirmed",
            )
            self.assertEqual(strong["quality_score"], 1.0)
            self.assertLess(weak["quality_score"], strong["quality_score"])

    def test_normalize_person_profiles_drops_malformed_entries(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config_path.write_text(json.dumps({
                "person_profiles": [
                    {"person_id": "p1", "display_name": "Person Gamma"},
                    {"display_name": "missing id"},
                    "not even a dict",
                    None,
                ],
            }))
            config = Config(config_path=config_path)
            profiles = config.get_person_profiles()
            self.assertEqual(len(profiles), 1)
            self.assertEqual(profiles[0]["display_name"], "Person Gamma")

    def test_normalize_person_profiles_handles_non_list(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config_path.write_text(json.dumps({"person_profiles": "not a list"}))
            config = Config(config_path=config_path)
            self.assertEqual(config.get_person_profiles(), [])

    def test_malformed_evidence_is_quarantined_without_being_deleted(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            person = config.create_person_profile("Person Gamma")
            document = json.loads(path.read_text())
            malformed = {"prototype_id": "recoverable", "embedding_mean": ["bad"]}
            document["person_profiles"][0]["prototypes"] = [malformed]
            path.write_text(json.dumps(document))

            reloaded = Config(config_path=path)
            self.assertEqual(reloaded.get_person_profiles()[0]["prototypes"], [])
            self.assertTrue(reloaded.rename_person_profile(person["person_id"], "Person Delta"))
            persisted = json.loads(path.read_text())
            self.assertEqual(persisted["person_profiles"][0]["prototypes"], [malformed])

    def test_prototype_retention_is_bounded_per_context(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            for index in range(Config.MAX_PROTOTYPES_PER_CONTEXT + 5):
                config.add_speaker_prototype(
                    person["person_id"],
                    [1.0, float(index + 1)],
                    recording_type="remote",
                    meeting_id=f"meeting-{index}",
                    diarization_speaker_id="SPEAKER_0",
                    speech_duration_seconds=30.0,
                    segment_count=5,
                    created_from="user_confirmed",
                    channel="system",
                )
            profile = config.get_person_profile(person["person_id"])
            self.assertEqual(
                len(profile["prototypes"]),
                Config.MAX_PROTOTYPES_PER_CONTEXT,
            )

    def test_newly_confirmed_prototype_survives_context_pruning(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            person = config.create_person_profile("Person Gamma")
            for index in range(Config.MAX_PROTOTYPES_PER_CONTEXT):
                config.add_speaker_prototype(
                    person["person_id"], [1.0, float(index + 1)],
                    recording_type="remote", meeting_id=f"strong-{index}",
                    diarization_speaker_id="SPEAKER_0",
                    speech_duration_seconds=30.0, segment_count=5,
                    created_from="user_confirmed", channel="system",
                )

            newest = config.add_speaker_prototype(
                person["person_id"], [1.0, 999.0],
                recording_type="remote", meeting_id="new-weak-confirmation",
                diarization_speaker_id="SPEAKER_0",
                speech_duration_seconds=1.0, segment_count=1,
                created_from="user_confirmed", channel="system",
            )

            retained = config.get_person_profile(person["person_id"])["prototypes"]
            self.assertIsNotNone(newest)
            self.assertEqual(len(retained), Config.MAX_PROTOTYPES_PER_CONTEXT)
            self.assertIn(newest["prototype_id"], {item["prototype_id"] for item in retained})


if __name__ == "__main__":
    unittest.main()

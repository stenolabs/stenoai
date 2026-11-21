import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.ollama_manager import get_ollama_env


class GetOllamaEnvMLXMetalPathTests(unittest.TestCase):
    def test_does_not_forward_openai_asr_credential_to_ollama(self):
        with patch.dict(
            os.environ,
            {
                "stenoai_oai_api_key": "private-asr-test-key",
                "StenoAi_Oai_Api_Origin": "https://private-asr.example",
                "STENOAI_OAI_API_URL": "https://private-asr.example/v1",
            },
            clear=False,
        ), patch(
            "src.ollama_manager.get_bundled_ollama_dir", return_value=None
        ):
            env = get_ollama_env()

        names = {name.upper() for name in env}
        self.assertNotIn("STENOAI_OAI_API_KEY", names)
        self.assertNotIn("STENOAI_OAI_API_ORIGIN", names)
        self.assertNotIn("STENOAI_OAI_API_URL", names)

    def test_does_not_set_stale_flat_mlx_metal_path_on_macos(self):
        # The bundled Ollama (v0.31.1+) ships its Metal library under
        # versioned subdirectories (mlx_metal_v3/, mlx_metal_v4/), not a
        # flat <bundle>/mlx.metallib file. Pointing MLX_METAL_PATH at the
        # old flat path (which no longer exists) is stale/wrong - Ollama's
        # own internal Metal-family detection must be left to find the
        # right variant itself, matching how a standalone (non-bundled)
        # Ollama install behaves with no override at all.
        with tempfile.TemporaryDirectory() as tmp_dir:
            bundled_dir = Path(tmp_dir)
            with patch("src.ollama_manager.get_bundled_ollama_dir", return_value=bundled_dir), \
                 patch("src.ollama_manager.sys.platform", "darwin"):
                env = get_ollama_env()

        self.assertNotIn("MLX_METAL_PATH", env)

    def test_still_sets_dyld_library_path_on_macos(self):
        # The fix must only remove the stale MLX_METAL_PATH override -
        # DYLD_LIBRARY_PATH (for the bundled dylibs generally) must still
        # be set exactly as before.
        with tempfile.TemporaryDirectory() as tmp_dir:
            bundled_dir = Path(tmp_dir)
            with patch("src.ollama_manager.get_bundled_ollama_dir", return_value=bundled_dir), \
                 patch("src.ollama_manager.sys.platform", "darwin"):
                env = get_ollama_env()

        self.assertIn(str(bundled_dir), env["DYLD_LIBRARY_PATH"])



class StartOllamaServerExitTests(unittest.TestCase):
    """start_ollama_server when its own `ollama serve` exits during the wait."""

    def _start(self, running_answers):
        from unittest.mock import MagicMock
        from src import ollama_manager

        proc = MagicMock(pid=4242, returncode=1)
        proc.poll.return_value = 1
        with patch.object(ollama_manager, "is_ollama_running", side_effect=running_answers), \
             patch.object(ollama_manager, "get_ollama_binary", return_value=Path("/bin/ollama")), \
             patch.object(ollama_manager, "get_ollama_env", return_value={}), \
             patch.object(ollama_manager, "_write_pid"), \
             patch.object(ollama_manager, "_clear_pid") as clear_pid, \
             patch.object(ollama_manager.subprocess, "Popen", return_value=proc), \
             patch.object(ollama_manager.time, "sleep"):
            ok = ollama_manager.start_ollama_server(wait=True, timeout=30)
        return ok, clear_pid

    def test_server_started_elsewhere_counts_as_ready(self):
        # Initial check, first wait-loop check, then the grace poll sees it.
        ok, clear_pid = self._start([False, False, True])
        self.assertTrue(ok)
        clear_pid.assert_called_once_with(expected_pid=4242)

    def test_reports_failure_when_nothing_comes_up(self):
        from src import ollama_manager

        ticks = iter(range(0, 1000))
        with patch.object(ollama_manager.time, "time", side_effect=lambda: next(ticks)):
            ok, _ = self._start(lambda: False)
        self.assertFalse(ok)


class ClearPidOwnershipTests(unittest.TestCase):
    def _pid_file(self, tmp_dir, content):
        path = Path(tmp_dir) / "ollama.pid"
        path.write_text(content, encoding="utf-8")
        return path

    def test_keeps_a_pid_written_by_another_server(self):
        from src import ollama_manager

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = self._pid_file(tmp_dir, "5555")
            with patch.object(ollama_manager, "_get_pid_file", return_value=path):
                ollama_manager._clear_pid(expected_pid=4242)
            self.assertEqual(path.read_text(encoding="utf-8"), "5555")

    def test_removes_its_own_pid(self):
        from src import ollama_manager

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = self._pid_file(tmp_dir, "4242")
            with patch.object(ollama_manager, "_get_pid_file", return_value=path):
                ollama_manager._clear_pid(expected_pid=4242)
            self.assertFalse(path.exists())

if __name__ == "__main__":
    unittest.main()

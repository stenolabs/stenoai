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




class StartOllamaServerPidTests(unittest.TestCase):
    """start_ollama_server records its PID only for a process it owns."""

    def _start(self, running_answers, poll_answers):
        from unittest.mock import MagicMock
        from src import ollama_manager

        proc = MagicMock(pid=4242, returncode=1)
        proc.poll.side_effect = poll_answers
        with patch.object(ollama_manager, "is_ollama_running", side_effect=running_answers), \
             patch.object(ollama_manager, "get_ollama_binary", return_value=Path("/bin/ollama")), \
             patch.object(ollama_manager, "get_ollama_env", return_value={}), \
             patch.object(ollama_manager, "_write_pid") as write_pid, \
             patch.object(ollama_manager, "_clear_pid") as clear_pid, \
             patch.object(ollama_manager.subprocess, "Popen", return_value=proc), \
             patch.object(ollama_manager.time, "sleep"):
            ok = ollama_manager.start_ollama_server(wait=True, timeout=30)
        return ok, write_pid, clear_pid

    def test_own_server_ready_records_its_pid(self):
        # Initial check, then ready while our process is alive.
        ok, write_pid, _ = self._start([False, True], lambda: None)
        self.assertTrue(ok)
        write_pid.assert_called_once_with(4242)

    def test_server_started_elsewhere_counts_as_ready_and_keeps_its_pid(self):
        # Our process exited; the grace poll then sees the other server.
        ok, write_pid, clear_pid = self._start([False, False, True], lambda: 1)
        self.assertTrue(ok)
        write_pid.assert_not_called()
        clear_pid.assert_not_called()

    def test_reports_failure_when_nothing_comes_up(self):
        from src import ollama_manager

        ticks = iter(range(0, 1000))
        with patch.object(ollama_manager.time, "time", side_effect=lambda: next(ticks)):
            ok, write_pid, _ = self._start(lambda: False, lambda: 1)
        self.assertFalse(ok)
        write_pid.assert_not_called()

    def test_still_starting_at_the_deadline_stays_tracked(self):
        from src import ollama_manager

        ticks = iter(range(0, 1000, 10))
        with patch.object(ollama_manager.time, "time", side_effect=lambda: next(ticks)):
            ok, write_pid, _ = self._start(lambda: False, lambda: None)
        self.assertFalse(ok)
        write_pid.assert_called_once_with(4242)

if __name__ == "__main__":
    unittest.main()

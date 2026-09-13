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


if __name__ == "__main__":
    unittest.main()

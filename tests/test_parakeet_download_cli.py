import json
import unittest
from unittest.mock import patch

from click.testing import CliRunner

import simple_recorder


def _last_json(output: str) -> dict:
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


class ParakeetDownloadCliTests(unittest.TestCase):
    def test_failure_json_uses_sanitized_download_error(self):
        with (
            patch("src.parakeet_models.is_installed", return_value=False),
            patch("src.parakeet_models.download", return_value=False),
            patch(
                "src.parakeet_models.get_last_download_error",
                return_value="TLS certificate verification failed while contacting Hugging Face",
            ),
        ):
            result = CliRunner().invoke(simple_recorder.download_parakeet_model_cmd, [])

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(
            _last_json(result.output),
            {
                "success": False,
                "error": "TLS certificate verification failed while contacting Hugging Face",
            },
        )


if __name__ == "__main__":
    unittest.main()

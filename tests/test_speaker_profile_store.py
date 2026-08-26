import json
import tempfile
import threading
import unittest
from pathlib import Path

from src.config import Config


class SpeakerProfileTransactionTests(unittest.TestCase):
    def test_concurrent_profile_creates_preserve_both_people(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            Config(config_path=path).set_identity_matching_enabled(True)
            ready = threading.Barrier(2)
            errors = []

            def create(name):
                try:
                    config = Config(config_path=path)
                    ready.wait()
                    config.create_person_profile(name)
                except Exception as error:
                    errors.append(error)

            first = threading.Thread(target=create, args=("Person Alpha",))
            second = threading.Thread(target=create, args=("Person Beta",))
            first.start()
            second.start()
            first.join()
            second.join()

            self.assertEqual(errors, [])
            document = json.loads(path.read_text())
            self.assertEqual(
                {profile["display_name"] for profile in document["person_profiles"]},
                {"Person Alpha", "Person Beta"},
            )


if __name__ == "__main__":
    unittest.main()

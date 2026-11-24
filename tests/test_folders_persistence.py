"""Persistence safety for folders.json.

The old _load() caught *every* exception and returned an empty folder
list; the next create_folder() then wrote that list back, so a single
transient read failure permanently destroyed the user's folders. These
tests pin the distinction the fix draws:

- provably invalid content is quarantined and recovery starts from empty;
- any other read failure propagates instead of silently emptying the list;
- a failed save leaves the previous file intact;
- two concurrent editors don't clobber each other (read under the lock).
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.config import Config
from src.folders import FoldersManager


def _seed(tmp_dir: str) -> Path:
    """Write a folders.json with two real folders and return its path."""
    path = Path(tmp_dir) / "folders.json"
    path.write_text(json.dumps({"folders": [
        {"id": "aaa", "name": "Kunden", "color": "#6366f1",
         "icon": "folder", "created_at": "2026-01-01T00:00:00", "order": 0},
        {"id": "bbb", "name": "Intern", "color": "#6366f1",
         "icon": "folder", "created_at": "2026-01-01T00:00:00", "order": 1},
    ]}, indent=2), encoding="utf-8")
    return path


class CorruptFoldersTests(unittest.TestCase):
    def test_corrupt_folders_json_is_quarantined_not_silently_emptied(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "folders.json"
            path.write_text('{"folders": [{"id": "aaa", "name": "Kun')  # torn write
            corrupt_bytes = path.read_bytes()

            mgr = FoldersManager(Path(tmp_dir))

            # Unparseable content can't be recovered by retrying, so we start
            # from empty — but the original is preserved next to it.
            self.assertEqual(mgr.list_folders(), [])
            backup = Path(tmp_dir) / "folders.json.corrupt"
            self.assertTrue(backup.exists())
            self.assertEqual(backup.read_bytes(), corrupt_bytes)

            # Recovery works: a new folder lands in a valid file, and the
            # quarantined copy is still there for manual rescue.
            created = mgr.create_folder("Neu")
            self.assertIsNotNone(created)
            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual([f["name"] for f in on_disk["folders"]], ["Neu"])
            self.assertEqual(backup.read_bytes(), corrupt_bytes)

    def test_failed_quarantine_refuses_to_recover(self):
        """The .corrupt copy is the only surviving version of the folder list,
        so recovery must not be reachable when the backup didn't happen — the
        next mutation would write the empty list straight over the original."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "folders.json"
            path.write_text('{"folders": [{"id": "aaa", "name": "Kun')  # torn write
            corrupt_bytes = path.read_bytes()

            with patch("src.folders.shutil.copy2", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    FoldersManager(Path(tmp_dir))

            # The corrupt-but-hand-recoverable original is still there, and no
            # empty list was persisted over it.
            self.assertTrue(path.exists())
            self.assertEqual(path.read_bytes(), corrupt_bytes)

    def test_wrong_shape_json_takes_the_corrupt_path(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "folders.json"
            path.write_text("null", encoding="utf-8")  # parses, but unusable

            mgr = FoldersManager(Path(tmp_dir))

            self.assertEqual(mgr.list_folders(), [])
            self.assertTrue((Path(tmp_dir) / "folders.json.corrupt").exists())


class UnreadableFoldersTests(unittest.TestCase):
    """A read failure that is NOT invalid content must never degrade to an
    empty list that a later save persists — the actual data-loss bug."""

    def test_unreadable_file_raises_instead_of_emptying(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = _seed(tmp_dir)
            before = path.read_bytes()

            with patch("src.folders.open", side_effect=PermissionError("denied")):
                with self.assertRaises(PermissionError):
                    FoldersManager(Path(tmp_dir))

            # Nothing was written, nothing was quarantined: the user's real
            # folders are still on disk, and the failure was loud.
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse((Path(tmp_dir) / "folders.json.corrupt").exists())

    def test_read_failure_during_a_mutation_does_not_persist_an_empty_list(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = _seed(tmp_dir)
            mgr = FoldersManager(Path(tmp_dir))
            before = path.read_bytes()

            # The re-read inside create_folder fails. The old code would have
            # appended to an empty list and written it over the two folders.
            with patch("src.folders.open", side_effect=OSError("I/O error")):
                with self.assertRaises(OSError):
                    mgr.create_folder("Neu")

            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(
                [f["name"] for f in json.loads(path.read_text())["folders"]],
                ["Kunden", "Intern"],
            )


class FoldersSaveTests(unittest.TestCase):
    def test_failed_save_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = _seed(tmp_dir)
            mgr = FoldersManager(Path(tmp_dir))
            before = path.read_text(encoding="utf-8")

            with patch("src.config.os.fsync", side_effect=OSError("disk full")):
                self.assertIsNone(mgr.create_folder("Neu"))

            self.assertEqual(path.read_text(encoding="utf-8"), before)
            leftovers = [p for p in Path(tmp_dir).iterdir() if p.suffix == ".tmp"]
            self.assertEqual(leftovers, [])

    def test_concurrent_editors_both_survive(self):
        """Each CLI operation is its own subprocess, so two managers can hold
        the same baseline. Re-reading under the lock is what keeps the second
        write from dropping the first one's folder."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "folders.json"
            first = FoldersManager(Path(tmp_dir))
            second = FoldersManager(Path(tmp_dir))  # loaded the same baseline

            self.assertIsNotNone(first.create_folder("Alpha"))
            self.assertIsNotNone(second.create_folder("Beta"))

            names = [f["name"] for f in json.loads(path.read_text())["folders"]]
            self.assertEqual(sorted(names), ["Alpha", "Beta"])

    def test_rename_of_unknown_id_reports_failure_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = _seed(tmp_dir)
            mgr = FoldersManager(Path(tmp_dir))
            before = path.read_text(encoding="utf-8")

            self.assertFalse(mgr.rename_folder("nope", "Neuer Name"))
            self.assertEqual(path.read_text(encoding="utf-8"), before)

            self.assertTrue(mgr.rename_folder("aaa", "Neuer Name"))
            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["folders"][0]["name"], "Neuer Name")


if __name__ == "__main__":
    unittest.main()


class DeleteFolderMcpScopeTests(unittest.TestCase):
    """Deleting a space removes it from the Steno MCP allowlist, so the notes
    that were in it (they keep the folder id in their frontmatter) stop being
    shared with connected assistants."""

    def test_deleted_folder_is_pruned_from_the_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            _seed(tmp_dir)
            cfg = Config(config_path=Path(tmp_dir) / "config.json")
            cfg.set_mcp_folder_allowlist(["aaa", "bbb"])
            mgr = FoldersManager(Path(tmp_dir), config=cfg)

            self.assertTrue(mgr.delete_folder("aaa"))

            self.assertEqual([f["id"] for f in mgr.list_folders()], ["bbb"])
            self.assertEqual(cfg.get_mcp_folder_allowlist(), ["bbb"])
            on_disk = json.loads((Path(tmp_dir) / "config.json").read_text())
            self.assertEqual(on_disk["mcp_folder_allowlist"], ["bbb"])

    def test_deleting_the_last_allowed_folder_leaves_an_empty_allowlist(self):
        # Empty means "nothing shared", never a fall-back to every meeting.
        with tempfile.TemporaryDirectory() as tmp_dir:
            _seed(tmp_dir)
            cfg = Config(config_path=Path(tmp_dir) / "config.json")
            cfg.set_mcp_folder_allowlist(["aaa"])
            FoldersManager(Path(tmp_dir), config=cfg).delete_folder("aaa")
            self.assertEqual(cfg.get_mcp_folder_allowlist(), [])

    def test_all_meetings_scope_and_unrelated_folders_are_untouched(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            _seed(tmp_dir)
            cfg = Config(config_path=Path(tmp_dir) / "config.json")
            FoldersManager(Path(tmp_dir), config=cfg).delete_folder("aaa")
            self.assertIsNone(cfg.get_mcp_folder_allowlist())

            cfg.set_mcp_folder_allowlist(["bbb"])
            saves = cfg._save
            with patch.object(cfg, "_save", wraps=saves) as spy:
                FoldersManager(Path(tmp_dir), config=cfg).delete_folder("zzz")
                spy.assert_not_called()
            self.assertEqual(cfg.get_mcp_folder_allowlist(), ["bbb"])

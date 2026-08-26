"""
Folder management for organizing meetings in StenoAI.

Stores folder metadata in folders.json alongside the output directory.
Meeting-to-folder assignment is stored in each meeting's summary JSON.
"""

import json
import logging
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import filelock

from src.config import _atomic_write_json, _atomic_write_text

logger = logging.getLogger(__name__)


class FoldersManager:
    """Manages folders for organizing meetings."""

    # Seconds to wait for the cross-process folders lock before giving up and
    # falling back to an unlocked read-modify-write. Mirrors
    # Config._SAVE_LOCK_TIMEOUT: generous enough for a normal save on a busy
    # disk, short enough that a stuck lock never blocks the CLI for long.
    _SAVE_LOCK_TIMEOUT = 10

    def __init__(self, data_dir: Path):
        self.folders_file = data_dir / "folders.json"
        self._data = self._load()

    def _load(self) -> Dict:
        """Read folders.json, or return an empty folder list.

        Failure kinds are deliberately NOT treated alike — conflating them is
        what made this a data-loss path. A blanket ``except Exception`` turned
        *any* hiccup (a permission problem, an exhausted file-descriptor
        limit, an I/O error) into an empty in-memory folder list, which the
        next create_folder() then persisted over the user's real folders.

        - Provably invalid content (unparseable JSON, or valid JSON of the
          wrong shape) can't be fixed by retrying: quarantine it to
          folders.json.corrupt and start from empty, the same recovery
          config.json gets. Folder *assignments* live in each meeting's own
          summary file, so the folders can be recreated; the quarantined copy
          keeps the original recoverable. If that copy itself fails the
          recovery is abandoned and the error propagates — see
          _quarantine_corrupt.
        - Everything else (PermissionError, OSError, ...) is a transient or
          environmental failure where the file on disk is presumed fine.
          Propagate it so the caller fails loudly instead of silently
          presenting — and then persisting — an empty list.
        """
        if not self.folders_file.exists():
            return self._empty()
        try:
            with open(self.folders_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            self._quarantine_corrupt(e)
            return self._empty()
        if not isinstance(data, dict) or not isinstance(data.get("folders"), list):
            # `null`, `[]` or a hand-edited file parses fine but breaks every
            # accessor below; route it through the corrupt path.
            self._quarantine_corrupt(
                ValueError("folders.json root is not an object with a folders list")
            )
            return self._empty()
        return data

    @staticmethod
    def _empty() -> Dict:
        return {"folders": []}

    def _quarantine_corrupt(self, error: Exception) -> None:
        """Back the unparseable file up to folders.json.corrupt.

        Unlike config.json we go on to write a fresh file over the original,
        so this copy is the only surviving version of the user's folder list.
        A backup that didn't happen would therefore turn recovery into
        deletion — so a failed copy is re-raised and _load() never reaches
        its empty list. Refusing to proceed leaves the corrupt file where the
        user can still salvage or move it by hand; recovering on top of it
        would be the same silent data loss this module exists to remove.
        """
        backup_path = self.folders_file.with_name(self.folders_file.name + ".corrupt")
        try:
            shutil.copy2(self.folders_file, backup_path)
        except Exception as backup_error:
            logger.error(
                f"Error loading folders: {error}. Refusing to start from an "
                f"empty list because the backup to {backup_path} failed too: "
                f"{backup_error}. The corrupt file is left untouched."
            )
            raise
        logger.error(
            f"Error loading folders: {error}. Starting from an empty list; "
            f"corrupt file backed up to {backup_path}"
        )

    def _update(self, mutate: Callable[[Dict], Any]) -> Any:
        """Re-read folders.json under the cross-process lock, apply `mutate`
        to that fresh data, and persist the result atomically.

        The app spawns a fresh CLI subprocess per operation (no daemon), so
        two near-simultaneous folder edits would each build a whole file from
        their own stale read and silently drop the other's change — the same
        lost update config.json fixes. Reading inside the lock, immediately
        before mutating, is what makes the read-modify-write one critical
        section.

        `mutate` returns None to mean "nothing changed, don't write". Returns
        that value, or None when nothing changed or the write failed. Read
        failures propagate (see _load) — a folder edit that can't see the
        current file must not proceed as if there were none.
        """
        lock_path = str(self.folders_file) + ".lock"
        try:
            with filelock.FileLock(lock_path, timeout=self._SAVE_LOCK_TIMEOUT):
                return self._apply(mutate)
        except filelock.Timeout:
            # Deliberate tradeoff: mutual exclusion is given up so a stuck
            # lock can never block folder edits outright. The write stays
            # atomic and stays built on a fresh read, so the file can't tear;
            # what we accept is that two editors racing past this point can
            # still lose one of the two updates.
            logger.warning(
                f"Timed out acquiring folders lock at {lock_path}; "
                f"proceeding without it"
            )
            return self._apply(mutate)

    def _apply(self, mutate: Callable[[Dict], Any]) -> Any:
        data = self._load()
        result = mutate(data)
        if result is None:
            self._data = data
            return None
        try:
            _atomic_write_json(self.folders_file, data)
        except Exception as e:
            logger.error(f"Error saving folders: {e}")
            # The atomic replace never ran, so the previous file is intact.
            return None
        self._data = data
        return result

    def list_folders(self) -> List[Dict]:
        return self._data.get("folders", [])

    def get_folder(self, folder_id: str) -> Optional[Dict]:
        """Get a single folder by its ID."""
        for folder in self.list_folders():
            if folder.get("id") == folder_id:
                return folder
        return None

    def get_folder_for_recurring_title(self, title: str) -> Optional[str]:
        """Find the folder ID whose recurring_titles match the given title
        (exact, case-insensitive, trimmed). Returns None when no match."""
        if not title or not isinstance(title, str) or not title.strip():
            return None
        target = title.strip().lower()
        for folder in self.list_folders():
            recurring = folder.get("recurring_titles") or []
            for r in recurring:
                if isinstance(r, str) and r.strip().lower() == target:
                    return folder["id"]
        return None

    def create_folder(self, name: str, color: str = "#6366f1", template_id: Optional[str] = None, recurring_titles: Optional[List[str]] = None) -> Optional[Dict]:
        def _mutate(data: Dict) -> Dict:
            folder = {
                "id": str(uuid.uuid4())[:8],
                "name": name,
                "color": color,
                "icon": "folder",
                "created_at": datetime.now().isoformat(),
                "order": len(data["folders"]),
            }
            if template_id and template_id.strip() and template_id.lower() not in ("none", "null"):
                folder["template_id"] = template_id.strip()
            if recurring_titles:
                cleaned = [t.strip() for t in recurring_titles if isinstance(t, str) and t.strip()]
                if cleaned:
                    folder["recurring_titles"] = cleaned
            data["folders"].append(folder)
            return folder

        return self._update(_mutate)

    def set_folder_template(self, folder_id: str, template_id: Optional[str]) -> bool:
        """Set or clear a folder's default template ID."""
        def _mutate(data: Dict) -> Optional[bool]:
            for folder in data.get("folders", []):
                if folder["id"] == folder_id:
                    if template_id and template_id.strip() and template_id.lower() not in ("none", "null"):
                        folder["template_id"] = template_id.strip()
                    else:
                        folder.pop("template_id", None)
                    return True
            return None  # unknown id: nothing to write

        return self._update(_mutate) is True

    def set_folder_recurring(self, folder_id: str, titles: List[str]) -> bool:
        """Set or clear a folder's recurring meeting titles."""
        def _mutate(data: Dict) -> Optional[bool]:
            for folder in data.get("folders", []):
                if folder["id"] == folder_id:
                    cleaned = [t.strip() for t in titles if isinstance(t, str) and t.strip()]
                    if cleaned:
                        folder["recurring_titles"] = cleaned
                    else:
                        folder.pop("recurring_titles", None)
                    return True
            return None  # unknown id: nothing to write

        return self._update(_mutate) is True

    def update_icon(self, folder_id: str, icon: str) -> bool:
        def _mutate(data: Dict) -> Optional[bool]:
            for folder in data["folders"]:
                if folder["id"] == folder_id:
                    folder["icon"] = icon
                    return True
            return None  # unknown id: nothing to write

        return self._update(_mutate) is True

    def rename_folder(self, folder_id: str, name: str) -> bool:
        def _mutate(data: Dict) -> Optional[bool]:
            for folder in data["folders"]:
                if folder["id"] == folder_id:
                    folder["name"] = name
                    return True
            return None  # unknown id: nothing to write

        return self._update(_mutate) is True

    def delete_folder(self, folder_id: str) -> bool:
        def _mutate(data: Dict) -> bool:
            data["folders"] = [
                f for f in data["folders"] if f["id"] != folder_id
            ]
            return True

        return self._update(_mutate) is True

    def reorder_folders(self, folder_ids: List[str]) -> bool:
        """Reorder folders to match the given ID order, updating each folder's order field."""
        def _mutate(data: Dict) -> bool:
            existing = {f["id"]: f for f in data["folders"]}
            reordered = []
            for i, fid in enumerate(folder_ids):
                if fid in existing:
                    folder = existing.pop(fid)
                    folder["order"] = i
                    reordered.append(folder)
            # Append any folders not in the provided list (shouldn't happen, but safe)
            for folder in existing.values():
                folder["order"] = len(reordered)
                reordered.append(folder)
            data["folders"] = reordered
            return True

        return self._update(_mutate) is True

    def _update_md_folders(self, summary_path: Path, update_fn) -> bool:
        """Update the folders list in a .md file's YAML frontmatter."""
        import re as _re
        try:
            content = summary_path.read_text(encoding='utf-8')
            frontmatter = ''
            body = content
            if content.startswith('---'):
                parts = content.split('---', 2)
                if len(parts) >= 3:
                    frontmatter = parts[1]
                    body = parts[2]

            current: List[str] = []
            m = _re.search(r'^folders:\s*(.+)$', frontmatter, _re.MULTILINE)
            if m:
                try:
                    current = json.loads(m.group(1))
                except (ValueError, TypeError):
                    current = []

            updated = update_fn(current)
            folders_line = f'folders: {json.dumps(updated)}'

            if m:
                frontmatter = _re.sub(r'^folders:.*$', folders_line, frontmatter, flags=_re.MULTILINE)
            else:
                frontmatter = frontmatter.rstrip('\n') + f'\n{folders_line}\n'

            # Same atomic writer the summary Markdown gets everywhere else:
            # this rewrites the user's whole note to change one frontmatter line.
            _atomic_write_text(summary_path, f'---{frontmatter}---{body}')
            return True
        except Exception as e:
            logger.error(f"Error updating md folders: {e}")
            return False

    def add_meeting_to_folder(self, summary_path: Path, folder_id: str) -> bool:
        """Add a folder reference to a meeting's summary file."""
        if summary_path.suffix == '.md':
            return self._update_md_folders(
                summary_path, lambda f: list({*f, folder_id})
            )
        try:
            with open(summary_path, "r") as f:
                data = json.load(f)
            folders = data.get("folders", [])
            if folder_id not in folders:
                folders.append(folder_id)
                data["folders"] = folders
                with open(summary_path, "w") as f:
                    json.dump(data, f, indent=2)
            return True
        except Exception as e:
            logger.error(f"Error adding meeting to folder: {e}")
            return False

    def remove_meeting_from_folder(self, summary_path: Path, folder_id: str) -> bool:
        """Remove a folder reference from a meeting's summary file."""
        if summary_path.suffix == '.md':
            return self._update_md_folders(
                summary_path, lambda f: [x for x in f if x != folder_id]
            )
        try:
            with open(summary_path, "r") as f:
                data = json.load(f)
            folders = data.get("folders", [])
            if folder_id in folders:
                folders.remove(folder_id)
                data["folders"] = folders
                with open(summary_path, "w") as f:
                    json.dump(data, f, indent=2)
            return True
        except Exception as e:
            logger.error(f"Error removing meeting from folder: {e}")
            return False


def get_folders_manager() -> FoldersManager:
    """Get a FoldersManager using the current data directory."""
    from src.config import get_data_dirs
    dirs = get_data_dirs()
    # Store folders.json alongside the output directory's parent
    data_dir = dirs["output"].parent
    return FoldersManager(data_dir)

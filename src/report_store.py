# src/report_store.py
"""Per-meeting report storage independent of the note's on-disk format.

Real meetings are saved as `<stem>_summary.md` (markdown + YAML frontmatter);
older/reprocessed ones may be `<stem>_summary.json`. Generated template reports
and the active-report pointer live in a SIDECAR `<stem>_reports.json`, so the
report feature works on both formats without touching the canonical note file.
"""
import json
from pathlib import Path


def sidecar_path(meeting_path) -> Path:
    p = Path(meeting_path)
    name = p.name
    for suf in ("_summary.md", "_summary.json"):
        if name.endswith(suf):
            return p.with_name(name[: -len(suf)] + "_reports.json")
    # Fallback: strip extension only.
    return p.with_name(p.stem + "_reports.json")


def load_sidecar(meeting_path) -> dict:
    sp = sidecar_path(meeting_path)
    if sp.exists():
        try:
            data = json.loads(sp.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                # Normalize TYPES, not just presence: a hand-edited or
                # partially-written sidecar could carry a non-list `reports` or a
                # non-string `active_report`, which would break iteration/append
                # downstream. setdefault only fills missing keys, so coerce here.
                reports = data.get("reports")
                data["reports"] = reports if isinstance(reports, list) else []
                active = data.get("active_report")
                data["active_report"] = active if isinstance(active, str) else None
                return data
        except Exception:
            pass
    return {"reports": [], "active_report": None}


def save_sidecar(meeting_path, sidecar: dict) -> None:
    from src.config import _atomic_write_json
    _atomic_write_json(sidecar_path(meeting_path), sidecar)


def _split_frontmatter(text: str):
    """Return (frontmatter_dict, body). Frontmatter is the first --- ... --- block."""
    fm: dict[str, str | None] = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            block = text[3:end].strip("\n")
            body = text[end + 4:].lstrip("\n")
            for line in block.splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    v = v.strip()
                    # Coerce the serialised-None forms to real None (in ONE
                    # place, for every consumer): the writer emits missing values
                    # as unquoted `null`, and an empty value reads back as "".
                    # Leaving them as the truthy strings "null"/"" would make a
                    # provenance key like detected_language look engine-backed and
                    # wrongly pin an auto/Parakeet note's language (#283). Mirrors
                    # _parse_meeting_markdown's null handling.
                    if v == "null" or v == "":
                        fm[k.strip()] = None
                    else:
                        fm[k.strip()] = v.strip('"')
    return fm, body


def _split_on_heading(body: str, heading: str):
    """Split `body` at the first line that IS `heading` (after stripping).

    Mirrors how the meeting writer emits section headers on their own line, so
    the literal heading text appearing inside transcript/summary prose does NOT
    trigger a split. Returns (before, after) where `after` is None if the
    heading line is absent.
    """
    lines = body.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.strip() == heading:
            before = "".join(lines[:i])
            after = "".join(lines[i + 1:])
            return before, after
    return body, None


def _split_md_sections(body: str):
    """Return (summary_markdown, transcript, notes) from a meeting .md body."""
    notes = None
    before_notes, notes_part = _split_on_heading(body, "## User Notes")
    if notes_part is not None:
        body = before_notes
        notes = notes_part.strip() or None
    summary_part, transcript_part = _split_on_heading(body, "## Transcript")
    transcript = transcript_part.strip() if transcript_part is not None else ""
    return summary_part.strip(), transcript, notes


def read_meeting(meeting_path) -> dict:
    """Format-agnostic view used by report generation."""
    p = Path(meeting_path)
    text = p.read_text(encoding="utf-8")
    if p.suffix == ".json":
        d = json.loads(text)
        from src import reports as _reports
        summary_md = _reports.structured_to_markdown(
            d.get("summary", ""), d.get("discussion_areas", []),
            d.get("key_points", []), d.get("action_items", []),
        )
        si = d.get("session_info", {}) or {}
        ds = si.get("duration_seconds")
        return {
            "transcript": d.get("transcript", "") or d.get("diarised_text", "") or "",
            "notes": d.get("user_notes"),
            "language": si.get("output_language") or si.get("language"),
            # Provenance of the persisted language, for the recovery paths to
            # decide whether it was pin-/engine-backed (trustworthy) or a bare
            # fallback (#283). Markdown front matter never stored these, so they
            # are None there - which is the correct "unprovable" signal.
            "configured_language": si.get("configured_language"),
            "detected_language": si.get("detected_language"),
            "duration_minutes": si.get("duration_minutes") or (int(ds / 60) if ds else None),
            "summary_markdown": summary_md,
        }
    fm, body = _split_frontmatter(text)
    summary_md, transcript, notes = _split_md_sections(body)
    ds = fm.get("duration_seconds")
    return {
        "transcript": transcript,
        "notes": notes,
        "language": fm.get("language"),
        "configured_language": fm.get("configured_language"),
        "detected_language": fm.get("detected_language"),
        "duration_minutes": (int(ds) // 60) if (ds and str(ds).isdigit()) else None,
        "summary_markdown": summary_md,
    }

"""The phone or FaceTime call a recording captured.

macOS only. When a recording and the call it captured have both ended, the
Electron app finds the call in the Mac's call history through iMCP
(app/call-matching.js, app/imcp-client.js) and hands it over with the
``apply-call-info`` command, which stores it next to the note:

    <output>/<stem>_call.json
    {"calls": [{"name": "Erika Mustermann", "number": "+12025550100",
                "direction": "incoming", "service": "phone",
                "started_at": "2026-03-02T14:00:00Z"}]}

``name`` is the Contacts name and may be null; ``number`` may be null for a
withheld number. A continued note gets the calls of each recording that went
into it: ``apply-call-info`` adds to the stored calls (``merge_calls``), and
nothing else writes the file. It is the source of truth, and what is derived
from it uses names only, because a note's text reaches the models: the
summary, report and title prompts, and chat over notes, which may be a cloud
provider's (the Settings row asks the user to acknowledge this). A caller with
no name is left to the speaker side, as if caller recognition were off.

- Participants: every named caller is listed, and
  ``_update_summary_participants`` adds them back whenever the speaker side
  rewrites the section, so reprocessing or confirming speakers cannot lose them.
- Prompt context: the summary, report and title prompts are told whom the call
  was with (``OllamaSummarizer.meeting_context``).

The number stays in this file, on the Mac; it is not added to note text, prompts, chat
context, or Obsidian export, since a vault may sync elsewhere or be read by
other tools. ``tests/test_call_info.py`` checks that no prompt or chat context
carries it.

No voice data, no speaker confirmation, no analytics: the caller is a fact
about the recording, not about anyone's voice.
"""

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

CALL_SIDECAR_SUFFIX = "_call.json"
_DIRECTIONS = ("incoming", "outgoing")
_SERVICES = {"phone": "phone call", "facetime": "FaceTime call"}
_MAX_FIELD = 200


def call_sidecar_path(output_dir, meeting_stem: str) -> Path:
    return Path(output_dir) / f"{meeting_stem}{CALL_SIDECAR_SUFFIX}"


def _choice(value, allowed) -> Optional[str]:
    """``value`` if it is one of ``allowed``, else None (also for a list or object)."""
    return value if isinstance(value, str) and value in allowed else None


def _text(value) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())[:_MAX_FIELD]
    return value or None


def normalize_calls(raw) -> list:
    """The valid calls in ``raw`` (a list, or ``{"calls": [...]}``); bad entries dropped."""
    if isinstance(raw, dict):
        raw = raw.get("calls")
    if not isinstance(raw, list):
        return []
    calls = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        call = {
            "name": _text(entry.get("name")),
            "number": _text(entry.get("number")),
            "direction": _choice(entry.get("direction"), _DIRECTIONS),
            "service": _choice(entry.get("service"), _SERVICES),
            "started_at": _text(entry.get("started_at")),
        }
        if call["name"] or call["number"]:
            calls.append(call)
    return calls


def read_calls(output_dir, meeting_stem: str) -> list:
    """The calls stored for a recording, or [] when there are none or the file is unreadable."""
    path = call_sidecar_path(output_dir, meeting_stem)
    try:
        return normalize_calls(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        logger.warning(f"Could not read {path}: {e}")
        return []


def write_calls(output_dir, meeting_stem: str, calls: list) -> Path:
    from src.config import _atomic_write_json
    path = call_sidecar_path(output_dir, meeting_stem)
    _atomic_write_json(path, {"calls": calls})
    return path


def _call_key(call: dict) -> tuple:
    """What makes two entries the same call: when it started, and with whom."""
    return (call.get("started_at"), call.get("number") or call.get("name"))


def merge_calls(stored: list, new: list) -> list:
    """``stored`` with the calls in ``new`` added. A call already stored is
    updated in place, keeping its name if this time none was found."""
    merged = list(stored)
    index = {_call_key(call): i for i, call in enumerate(merged)}
    for call in new:
        key = _call_key(call)
        if key in index:
            old = merged[index[key]]
            merged[index[key]] = {**call, "name": call.get("name") or old.get("name")}
        else:
            index[key] = len(merged)
            merged.append(call)
    return merged


def caller_label(call: dict) -> Optional[str]:
    """How a caller appears in Participants: the Contacts name, or None. Never
    the number, which would reach the models with the note's text."""
    return call.get("name") or None


def with_callers(calls: list, participant_names: list) -> list:
    """``participant_names`` with the named callers first, in the order of the
    calls, each once and as already spelled there if it is."""
    names = list(participant_names or [])
    spelled = {}
    for name in names:
        spelled.setdefault(str(name).casefold(), name)
    callers, seen = [], set()
    for call in calls:
        label = caller_label(call)
        if label and label.casefold() not in seen:
            seen.add(label.casefold())
            callers.append(spelled.get(label.casefold(), label))
    return callers + [n for n in names if str(n).casefold() not in seen]


def meeting_context(calls: list) -> str:
    """The prompt preamble naming the other party, or "" when no call has a
    name. A call without one adds nothing: the prompts then read as they would
    with caller recognition off, and the number never reaches a model."""
    named = [call for call in calls if call.get("name")]
    if not named:
        return ""
    sentences = []
    for call in named:
        kind = _SERVICES.get(call.get("service"), "call")
        if call.get("direction"):
            kind = f"{call['direction']} {kind}"
        article = "an" if kind[0] in "aeiou" else "a"
        sentences.append(f"This recording is {article} {kind} with {call['name']}.")
    sentences.append("[Others] in the transcript is the other party on the call.")
    sentences.append("Refer to them by name.")
    return "CALL: " + " ".join(sentences) + "\n\n"

"""Pure model for the Custom Keywords feature: parsing, validation, alias
replacement, and the summary reference block. No I/O, no config access."""
from __future__ import annotations

import re

MAX_ENTRIES = 200
MAX_ALIASES = 10
MAX_LEN = 80

# Control chars (incl. newlines/tabs) are stripped from persisted values so a
# hand-edited/corrupted config.json can't smuggle in extra lines or break the
# alias matcher. Collapsed to single spaces to avoid merging adjacent tokens.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def _clean_str(value) -> str:
    """Coerce a persisted value to a clean single-line string.

    Non-strings (numbers, None, dicts from a corrupted config) become '' and
    are dropped by the caller. Control/newline characters are neutralised,
    surrounding whitespace trimmed, and length capped at MAX_LEN.
    """
    if not isinstance(value, str):
        return ""
    cleaned = _CONTROL_RE.sub(" ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:MAX_LEN]


def parse_keywords_text(text: str) -> list[dict]:
    """Textarea text -> entries. One entry per line; `Preferred: a, b` for aliases."""
    entries: list[dict] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if ":" in line:
            preferred, _, alias_str = line.partition(":")
            aliases = [a.strip() for a in alias_str.split(",") if a.strip()]
        else:
            preferred, aliases = line, []
        preferred = preferred.strip()
        if preferred:
            entries.append({"preferred": preferred, "aliases": aliases})
    return entries


def format_keywords_text(entries: list[dict]) -> str:
    """Entries -> textarea text (inverse of parse_keywords_text)."""
    lines: list[str] = []
    for e in entries:
        pref = (e.get("preferred") or "").strip()
        if not pref:
            continue
        aliases = [a.strip() for a in (e.get("aliases") or []) if a.strip()]
        lines.append(f"{pref}: {', '.join(aliases)}" if aliases else pref)
    return "\n".join(lines)


def normalize_keywords(entries: list[dict]) -> list[dict]:
    """Validate + de-dupe per spec. Idempotent."""
    out: list[dict] = []
    pref_index: dict[str, int] = {}   # lower(preferred) -> index in out
    seen_alias: set[str] = set()      # global lowercased aliases
    for e in (entries or []):
        # Defensive against a corrupted/hand-edited config.json: a non-dict
        # entry (str, int, None, ...) has no .get and must be skipped.
        if not isinstance(e, dict):
            continue
        pref = _clean_str(e.get("preferred"))  # non-str preferred -> '' -> dropped
        if not pref:
            continue
        pl = pref.lower()
        # last wins: a duplicate preferred releases the superseded entry's aliases
        # so the replacement can reclaim them before its own alias loop runs.
        if pl in pref_index:
            for a in out[pref_index[pl]]["aliases"]:
                seen_alias.discard(a.lower())
        # A string aliases value is treated as a SINGLE alias, never iterated as
        # characters (the char-iteration bug would silently corrupt matching).
        # Any other non-list shape is dropped.
        raw_aliases = e.get("aliases")
        if isinstance(raw_aliases, str):
            raw_aliases = [raw_aliases]
        elif not isinstance(raw_aliases, (list, tuple)):
            raw_aliases = []
        aliases: list[str] = []
        for a in raw_aliases:
            a = _clean_str(a)  # non-str alias -> '' -> skipped below
            al = a.lower()
            if not a or al in seen_alias:
                continue
            aliases.append(a)
            seen_alias.add(al)
            if len(aliases) >= MAX_ALIASES:
                break
        if pl in pref_index:
            out[pref_index[pl]] = {"preferred": pref, "aliases": aliases}  # last wins
        else:
            if len(out) >= MAX_ENTRIES:
                continue
            pref_index[pl] = len(out)
            out.append({"preferred": pref, "aliases": aliases})
    # Drop any alias that equals a preferred term (would be a no-op / loop).
    prefs = {o["preferred"].lower() for o in out}
    for o in out:
        o["aliases"] = [a for a in o["aliases"] if a.lower() not in prefs]
    return out


# Protect EVERY leading `[...]` label on a diarised line, not just the first.
# The real production format is `[MM:SS] [You] text` / `[H:MM:SS] [Others] text`
# (transcriber._format_timestamp + the speaker tag), so both the timestamp and
# the [You]/[Others] speaker label must be skipped by alias replacement -
# otherwise an alias like `you` would rewrite the speaker label itself.
_LABEL_RE = re.compile(r"^((?:\[[^\]]*\]\s*)+)(.*)$")


def _build_matcher(entries: list[dict]):
    """Return (compiled_pattern, lower_alias -> preferred) or (None, {})."""
    mapping: dict[str, str] = {}
    for e in entries or []:
        pref = e.get("preferred")
        if not pref:
            continue
        for a in (e.get("aliases") or []):
            if a:
                mapping.setdefault(a.lower(), pref)
    if not mapping:
        return None, {}
    ordered = sorted(mapping.keys(), key=len, reverse=True)  # longest first
    body = "|".join(re.escape(a) for a in ordered)
    pattern = re.compile(rf"(?<!\w)(?:{body})(?!\w)", re.IGNORECASE)
    return pattern, mapping


def apply_aliases(text: str, entries: list[dict]) -> str:
    """Replace aliases with their preferred term in plain text."""
    if not text or not entries:
        return text
    pattern, mapping = _build_matcher(entries)
    if pattern is None:
        return text
    # Defensive: re.IGNORECASE can match text whose .lower() (Unicode case
    # folding, e.g. 'İ' -> 'i̇') is not a mapping key -> leave it unchanged
    # rather than raising KeyError mid-transcription.
    return pattern.sub(lambda m: mapping.get(m.group(0).lower(), m.group(0)), text)


def apply_aliases_diarised(text: str, entries: list[dict]) -> str:
    """Like apply_aliases but skips the leading `[Label]` on each line."""
    if not text or not entries:
        return text
    out = []
    for line in text.split("\n"):
        m = _LABEL_RE.match(line)
        if m:
            out.append(m.group(1) + apply_aliases(m.group(2), entries))
        else:
            out.append(apply_aliases(line, entries))
    return "\n".join(out)


def apply_to_transcript(text: str, entries: list[dict]) -> str:
    """Auto-route: diarised-aware when speaker labels are present."""
    if not text or not entries:
        return text
    if "[You]" in text or "[Others]" in text:
        return apply_aliases_diarised(text, entries)
    return apply_aliases(text, entries)


def reference_block(entries: list[dict]) -> str:
    """Labelled glossary block for summary prompts. Empty config -> ''."""
    terms = [e["preferred"] for e in (entries or []) if e.get("preferred")]
    if not terms:
        return ""
    bullets = "\n".join(f"- {t}" for t in terms)
    return (
        "REFERENCE TERMS - exact spellings of names that may appear in the "
        "transcript. Use these spellings; do NOT add content from this list.\n"
        f"{bullets}\n\n"
    )

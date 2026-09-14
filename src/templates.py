# src/templates.py
"""Built-in report templates + pure template helpers.

A template shapes how a meeting report is generated/exported. STANDARD is the
only *locked* built-in (drives today's structured note); the rest of
BUILTIN_TEMPLATES is a curated gallery of editable/resettable prompt-driven
templates for common meeting types (issue #297) — same override/reset
mechanism as any editable built-in, just shipped with a useful starting
prompt instead of an empty one. One editable SAMPLE custom template is also
pre-seeded by Config on first run; everything else is user-created. Built-in
definitions live here (source of truth, like whisper_models.py); custom
templates, built-in overrides, the seed flag, and the default id live in
config.json.

This module is pure — no I/O — so it is unit-testable without a running app.
"""

import re

STANDARD_TEMPLATE_ID = "standard"

MAX_NAME_LEN = 200
MAX_PROMPT_LEN = 8000
MAX_ICON_LEN = 64
VALID_FORMATS = {"structured", "markdown"}

# STANDARD is locked + structured: its "prompt" is empty because it routes
# through the existing JSON-schema summary path, not a free-form prompt.
# `format` picks the render/generation path.
#
# The rest are the built-in gallery (issue #297): editable + resettable
# (locked left unset/False) prompt-driven templates for common meeting
# types, so most users get a useful default without writing their own
# prompt — Custom-template CRUD covers anyone who wants more.
BUILTIN_TEMPLATES = {
    "standard": {
        "id": "standard",
        "name": "Standard",
        "icon": "doc",
        "prompt": "",
        "language": "auto",
        "format": "structured",
        "locked": True,
    },
    "product-demo": {
        "id": "product-demo",
        "name": "Product Demo",
        "icon": "presentation",
        "prompt": (
            "Write a concise product-demo report in the same language as the speakers, "
            "including the headings. Use each section once, with brief bullets: Stated "
            "needs and buyer assessment; Capabilities and limitations; Commercial "
            "terms; Open questions and next steps. Omit sections not discussed. For "
            "each capability, state whether it was demonstrated, only promised, or "
            "explicitly unavailable. Include stated needs and participants' own "
            "assessment of fit; do not assess fit yourself. Preserve unsupported "
            "requirements, conditions on pricing, and unresolved questions. Label "
            "follow-up requests as requests until someone explicitly accepts them. "
            "Never turn a proposed date into a deadline. Include action owners and "
            "dates only when stated. Avoid repetition and bilingual headings."
        ),
        "language": "auto",
        "format": "markdown",
    },
    "sales-call": {
        "id": "sales-call",
        "name": "Sales Call",
        "icon": "handshake",
        "prompt": (
            "Write a concise sales-call report in the same language as the speakers, "
            "including the headings. Use each section once, with brief bullets: Needs "
            "and constraints; Budget and decision process; Alternatives; Next steps. "
            "Omit sections not discussed. Record stated buying interest and any "
            "explicit lack of purchase commitment. Keep buyer statements separate from "
            "seller proposals. Preserve objections, conditions, and uncertainty. "
            "Interest is not a purchase commitment; an estimated budget is not "
            "approved; a proposed date is not agreed. Do not infer buying authority or "
            "deal probability. Separate unaccepted requests from agreed actions. "
            "Include action owners and dates only when explicitly stated. State each "
            "fact once and avoid bilingual headings."
        ),
        "language": "auto",
        "format": "markdown",
    },
    "one-on-one": {
        "id": "one-on-one",
        "name": "1:1",
        "icon": "user-check",
        "prompt": (
            "Write a concise 1:1 report in the same language as the speakers, including "
            "the headings. Use each section once, with brief bullets: Updates; Feedback "
            "and concerns; Decisions and next steps. Omit sections not discussed. "
            "Record each person's position when they disagree, with the speaker's name "
            "when clear. Keep both positions without judging who is right. Distinguish "
            "suggestions and requests from agreed decisions and actions. Keep "
            "unresolved requests explicit. Do not infer motives, feelings, or "
            "performance ratings. Include action owners and deadlines only when "
            "explicitly stated, preserving tentative dates and dependencies. State each "
            "point once and avoid bilingual headings."
        ),
        "language": "auto",
        "format": "markdown",
    },
    "standup": {
        "id": "standup",
        "name": "Standup",
        "icon": "list-checks",
        "prompt": (
            "Write concise standup notes in the language of the speakers. Use one short "
            "bullet list per identified person, and a separate topic list for "
            "unattributed work. Each bullet should preserve the actual status: "
            "completed, still in progress, tentative, blocked, or resolved. Keep the "
            "specific work item attached to its status and any dependency; for example, "
            "a plan to test an export is not a plan to test a completed login fix. "
            "Capture explicit requests for help and accepted actions with stated owners "
            "and times. Leave unassigned work unassigned. Include only information "
            "discussed. Avoid empty status categories, repeated updates, and a separate "
            "summary."
        ),
        "language": "auto",
        "format": "markdown",
    },
}

# Pre-seeded once into the user's custom templates (editable + deletable).
SAMPLE_TEMPLATE = {
    "id": "shareable-summary",
    "name": "Shareable summary",
    "icon": "megaphone",
    "prompt": (
        "Write a clear, plain-language summary I can forward to a colleague or "
        "manager: the key points, decisions, and any next steps. Write in the "
        "language of the meeting."
    ),
    "language": "auto",
    "format": "markdown",
}


def new_template_id(name: str, existing_ids: set) -> str:
    """A stable slug id from a display name, de-duped against existing ids."""
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    base = base or "template"
    if base not in existing_ids:
        return base
    n = 2
    while f"{base}-{n}" in existing_ids:
        n += 1
    return f"{base}-{n}"


def validate_template(t: dict, valid_languages: set) -> tuple:
    """Return (ok, error_message) for a template dict.

    Defensive at the Python trust boundary: `t` arrives from the renderer as
    decoded JSON and may be malformed. This never raises — it always returns
    (False, "<message>") on bad input.
    """
    if not isinstance(t, dict):
        return False, "Invalid template payload"

    name = t.get("name")
    if not isinstance(name, str):
        return False, "Template name is required"
    name = name.strip()
    if not name:
        return False, "Template name is required"
    if len(name) > MAX_NAME_LEN:
        return False, f"Template name is too long (max {MAX_NAME_LEN} characters)"

    prompt = t.get("prompt")
    if not isinstance(prompt, str):
        return False, "Template prompt is required"
    if not prompt.strip():
        return False, "Template prompt is required"
    if len(prompt) > MAX_PROMPT_LEN:
        return False, f"Template prompt is too long (max {MAX_PROMPT_LEN} characters)"

    lang = t.get("language", "auto")
    if not isinstance(lang, str) or lang not in valid_languages:
        return False, f"Unsupported language: {lang}"

    fmt = t.get("format")
    if fmt is not None and (not isinstance(fmt, str) or fmt not in VALID_FORMATS):
        return False, f"Unsupported format: {fmt}"

    icon = t.get("icon")
    if icon is not None:
        if not isinstance(icon, str):
            return False, "Invalid template icon"
        if len(icon) > MAX_ICON_LEN:
            return False, "Template icon is too long"

    return True, ""


def merge_templates(overrides: dict, custom: list) -> list:
    """Built-ins (with overrides applied) first, then custom templates.

    Each entry is tagged `builtin` (and `locked` for STANDARD) so the UI knows
    which controls (Reset vs Edit/Delete) to show.
    """
    result = []
    for tid, base in BUILTIN_TEMPLATES.items():
        merged = {**base, **(overrides.get(tid) or {})}
        merged["builtin"] = True
        merged["locked"] = bool(base.get("locked"))
        result.append(merged)
    for c in custom:
        result.append({**c, "builtin": False, "locked": False})
    return result

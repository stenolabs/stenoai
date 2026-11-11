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
    # A richer alternative to Standard that leaves the locked Standard
    # contract untouched (#254): free-form markdown, editable and resettable
    # like the rest of the gallery, selectable per meeting or as the default.
    "detailed": {
        "id": "detailed",
        "name": "Detailed",
        "icon": "doc",
        "prompt": (
            "Write a thorough, complete summary of this meeting as markdown — not terse. "
            "Use these sections with these exact headings:\n\n"
            "## Summary\n"
            "A 2-4 sentence overview of the main topics, decisions and outcomes.\n\n"
            "## Key Topics\n"
            "For each substantive topic, a `### Topic title` followed by a thorough account "
            "written as flowing prose (plain sentences — NOT a nested bullet list and without "
            "inline bold labels): the concrete names of people, organizations and products and "
            "any figures exactly as stated, the reasoning given, and any decision, outcome or "
            "open question. Cover every substantive topic; do not omit important detail or "
            "flatten specifics into vague generalities.\n\n"
            "## Key Points\n"
            "- The concrete takeaways, keeping specific names, figures and decisions.\n\n"
            "## Action Items\n"
            "- Each action; name the responsible person only if explicitly stated.\n\n"
            "Base everything ONLY on what was explicitly discussed; do not infer or invent. "
            "Attribute a statement or action to a person ONLY when it is explicitly stated that "
            "they said or did it — never guess who did what, and never default an action to a "
            "named participant. Write in the language of the meeting."
        ),
        "language": "auto",
        "format": "markdown",
    },
    "product-demo": {
        "id": "product-demo",
        "name": "Product Demo",
        "icon": "presentation",
        "prompt": (
            "Summarise this call for someone evaluating a product or service "
            "being demonstrated to them. Cover: what was demoed and the "
            "problem it's meant to solve; key features or capabilities shown; "
            "pricing or commercial terms if mentioned; how well it fits the "
            "stated needs; concerns or open questions raised; and next steps. "
            "Structure the report with a short markdown heading per area, and "
            "omit any area that wasn't discussed. Write in the language of the "
            "meeting."
        ),
        "language": "auto",
        "format": "markdown",
    },
    "sales-call": {
        "id": "sales-call",
        "name": "Sales Call",
        "icon": "handshake",
        "prompt": (
            "Summarise this call for the person running the sales "
            "conversation. Cover: the prospect's stated needs, pain points, "
            "and priorities; objections or concerns raised; budget, timeline, "
            "or decision-process details mentioned; competitors or "
            "alternatives referenced; and agreed next steps. Structure the "
            "report with a short markdown heading per area, and omit any area "
            "that wasn't discussed. Write in the language of the meeting."
        ),
        "language": "auto",
        "format": "markdown",
    },
    "one-on-one": {
        "id": "one-on-one",
        "name": "1:1",
        "icon": "user-check",
        "prompt": (
            "Summarise this 1:1 conversation. Cover: topics discussed and any "
            "updates shared, feedback given in either direction, concerns or "
            "blockers raised, decisions made, and follow-up actions with who "
            "owns them. Structure the report with a short markdown heading per "
            "area, and omit any area that wasn't discussed. Write in the "
            "language of the meeting."
        ),
        "language": "auto",
        "format": "markdown",
    },
    "standup": {
        "id": "standup",
        "name": "Standup",
        "icon": "list-checks",
        "prompt": (
            "Summarise this standup/status meeting concisely. For each "
            "update, capture what was done, what's planned next, and any "
            "blockers raised. List updates as brief bullet points, grouped by "
            "person or topic. Keep it brief - this is a quick status sync, "
            "not a detailed report. Write in the language of the meeting."
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

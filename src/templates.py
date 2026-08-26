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
    "follow_up_email": {
        "id": "follow_up_email",
        "name": "Follow-up Email",
        "icon": "mail",
        "prompt": (
            "Draft a ready-to-send follow-up email based on this meeting. "
            "Include: a polite greeting, a concise summary of what was "
            "discussed and agreed, clear action items with owners and "
            "timelines if mentioned, the agreed next step, and a professional "
            "sign-off. Write in the language of the meeting."
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


# Label and prompt length caps for chat recipes (issue #297 parity).
MAX_RECIPE_LABEL_LEN = 200
MAX_RECIPE_PROMPT_LEN = 8000


def validate_recipe(r: dict) -> tuple:
    """Return (ok, error_message) for a chat recipe dict.

    Defensive at the Python trust boundary: `r` arrives from the renderer as
    decoded JSON and may be malformed. This never raises — it always returns
    (False, "<message>") on bad input.
    """
    if not isinstance(r, dict):
        return False, "Invalid recipe payload"

    label = r.get("label")
    if not isinstance(label, str):
        return False, "Recipe label is required"
    label = label.strip()
    if not label:
        return False, "Recipe label is required"
    if len(label) > MAX_RECIPE_LABEL_LEN:
        return False, f"Recipe label is too long (max {MAX_RECIPE_LABEL_LEN} characters)"

    prompt = r.get("prompt")
    if not isinstance(prompt, str):
        return False, "Recipe prompt is required"
    if not prompt.strip():
        return False, "Recipe prompt is required"
    if len(prompt) > MAX_RECIPE_PROMPT_LEN:
        return False, f"Recipe prompt is too long (max {MAX_RECIPE_PROMPT_LEN} characters)"

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

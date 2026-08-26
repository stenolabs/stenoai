"""Validation shared by speaker CLI and persistence boundaries."""

from __future__ import annotations

import math
import unicodedata
from pathlib import Path
from typing import Optional


EMBEDDING_DIMENSION = 256
VALID_CHANNELS = frozenset({"mic", "system"})


def validate_meeting_stem(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value in {".", ".."}
        or Path(value).name != value
        or "/" in value
        or "\\" in value
    ):
        raise ValueError("Invalid meeting identifier.")
    return value


def validate_display_name(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Invalid person name.")
    normalized = " ".join(unicodedata.normalize("NFKC", value).split())
    if (
        not normalized
        or "[" in normalized
        or "]" in normalized
        or not normalized.isprintable()
    ):
        raise ValueError("Invalid person name.")
    return normalized


def validate_embedding(
    value,
    *,
    expected_dimension: Optional[int] = EMBEDDING_DIMENSION,
) -> list[float]:
    if not isinstance(value, list) or not value:
        raise ValueError("Speaker embedding must be a non-empty vector.")
    if expected_dimension is not None and len(value) != expected_dimension:
        raise ValueError(f"Speaker embedding must contain {expected_dimension} values.")
    try:
        embedding = [float(item) for item in value]
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("Speaker embedding must be numeric.") from error
    if not all(math.isfinite(item) for item in embedding):
        raise ValueError("Speaker embedding must contain finite values.")
    if not any(item != 0.0 for item in embedding):
        raise ValueError("Speaker embedding must be non-zero.")
    return embedding

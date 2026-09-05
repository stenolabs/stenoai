"""Voiceprint distance math shared by src/transcriber.py's speaker matching.

Speaker embeddings themselves are extracted in Swift, not here — see
diarize-sidecar/Sources/main.swift's extractSortformerEmbeddings(). An
earlier version of this module ran a standalone ONNX WeSpeaker/ECAPA-TDNN
model directly in Python (single-clip, no overlap-exclusion), but a broad
real-recording survey found the embeddings weren't discriminative enough —
unrelated speakers in the *same* recording scored higher similarity than
genuine same-person matches across different recordings. Investigating
github.com/pasrom/meeting-transcriber (a real, tested FluidAudio+Sortformer
meeting app solving this exact problem) showed why: embeddings need to come
from FluidAudio's own WeSpeaker model via its native masked API, with
crosstalk frames excluded and multiple chunks averaged into a centroid —
none of which a single raw audio clip fed through a standalone model can
replicate. That extraction now happens in the Swift sidecar (which already
has the diarizer's frame-level speaker predictions needed to build the
exclusion masks); this module only has the comparison math left.
"""

from __future__ import annotations

import math


def cosine_similarity(a, b) -> float:
    """Cosine similarity between two equal-length vectors, in [-1, 1]."""
    if not isinstance(a, (list, tuple)) or not isinstance(b, (list, tuple)):
        raise ValueError("Speaker embeddings must be vectors.")
    if not a or len(a) != len(b):
        raise ValueError("Speaker embeddings must have equal non-zero dimensions.")
    try:
        left = [float(value) for value in a]
        right = [float(value) for value in b]
    except (TypeError, ValueError) as error:
        raise ValueError("Speaker embeddings must be numeric.") from error
    if not all(math.isfinite(value) for value in [*left, *right]):
        raise ValueError("Speaker embeddings must contain finite values.")
    dot = sum(x * y for x, y in zip(left, right))
    norm_a = sum(x * x for x in left) ** 0.5
    norm_b = sum(y * y for y in right) ** 0.5
    denom = norm_a * norm_b
    if denom == 0:
        return 0.0
    return dot / denom


def cosine_distance(a, b) -> float:
    """Cosine distance: 0 = identical, 2 = opposite. Ported from
    SpeakerMatcher.cosineDistance (github.com/pasrom/meeting-transcriber) —
    same formula as `1 - cosine_similarity`, kept as its own function since
    that's the quantity src/transcriber.py's matching threshold/margin logic
    is expressed in terms of.
    """
    return 1.0 - cosine_similarity(a, b)

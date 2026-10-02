"""Dependency-free text language detection for the Parakeet-supported languages.

Parakeet's transcription backends (``src/_parakeet_mlx.py`` /
``src/_parakeet_onnx.py``) are language-agnostic at inference and never return a
detected language — they only echo an explicit caller pin. With the default
``language="auto"`` that means ``detected_language`` is ``None``, so the output
language resolves to English and a German/French/… meeting gets an English
summary (#283). Whisper is unaffected (whisper.cpp reports a real
``detected_language``).

This module fills that gap with a small stopword/function-word classifier over
the transcript text. It covers exactly the European languages Parakeet
transcribes well (``en, fr, de, es, nl, pt, ru`` — the ``PARAKEET_LANGUAGES`` set
minus ``auto``) and returns ``None`` when the evidence is inconclusive, so the
existing "en" fallback still applies. No pip dependency (PyInstaller bundle size
+ licensing); the method is a plain aggregate word-match count.
"""

import re
from collections import Counter
from typing import Optional

# High-frequency function words per language. Curated for distinctiveness:
# cross-language collisions (e.g. "die" in de/nl/en, "de" in fr/es/pt/nl) are
# fine because the aggregate count decides — every list carries enough words
# that don't collide for the true language to lead. Codes match the Parakeet
# set (transcription-languages.ts: PARAKEET_LANGUAGES minus "auto").
_STOPWORDS: dict[str, frozenset[str]] = {
    "en": frozenset({
        "the", "and", "that", "have", "for", "not", "with", "you", "this",
        "but", "from", "they", "his", "her", "she", "will", "would", "there",
        "their", "what", "about", "which", "when", "can", "like", "just",
        "know", "your", "some", "could", "them", "than", "then", "only",
        "also", "been", "has", "had", "were", "are", "our", "how", "who",
        "why", "where", "into", "over", "these", "those", "being", "does",
        "did", "because", "should", "very", "here", "much", "more",
    }),
    "fr": frozenset({
        "le", "la", "les", "un", "une", "des", "du", "de", "et", "est",
        "que", "qui", "dans", "pour", "pas", "plus", "avec", "sur", "ce",
        "cette", "ces", "mais", "ou", "donc", "il", "elle", "ils", "elles",
        "nous", "vous", "je", "son", "sa", "ses", "leur", "leurs", "être",
        "avoir", "fait", "faire", "très", "bien", "aussi", "comme", "tout",
        "tous", "alors", "parce", "quand", "peut", "cela", "notre", "votre",
        "sont", "était", "ont",
    }),
    "de": frozenset({
        "der", "die", "das", "und", "ist", "nicht", "ein", "eine", "einen",
        "einem", "einer", "den", "dem", "mit", "auf", "für", "auch", "aber",
        "oder", "wir", "ich", "sie", "wenn", "dann", "weil", "dass", "doch",
        "noch", "schon", "immer", "sehr", "mehr", "viel", "hier", "jetzt",
        "was", "wie", "warum", "wer", "haben", "hat", "hatte", "sein", "sind",
        "war", "waren", "wird", "werden", "würde", "kann", "können", "muss",
        "über", "durch", "nach", "diese", "dieser", "dieses",
    }),
    "es": frozenset({
        "el", "la", "los", "las", "un", "una", "unos", "unas", "del", "en",
        "que", "por", "para", "con", "se", "su", "sus", "lo", "le", "como",
        "más", "pero", "este", "esta", "esto", "estos", "ese", "esa", "muy",
        "también", "porque", "cuando", "donde", "hay", "ser", "estar",
        "tiene", "tienen", "tener", "son", "era", "eran", "fue", "fueron",
        "está", "están", "puede", "pueden", "todo", "todos", "nosotros",
        "ellos", "ellas", "usted", "ustedes", "ahora", "entonces",
    }),
    "nl": frozenset({
        "de", "het", "een", "en", "van", "dat", "die", "in", "is", "ik",
        "je", "niet", "met", "op", "te", "zijn", "voor", "maar", "ook",
        "aan", "om", "dan", "wat", "wij", "jij", "hij", "zij", "deze", "dit",
        "daar", "hier", "naar", "door", "over", "worden", "wordt", "heeft",
        "hebben", "heb", "kan", "kunnen", "moet", "moeten", "zou", "zal",
        "nog", "wel", "heel", "veel", "meer", "waarom", "wie", "waar", "hoe",
        "omdat", "wanneer", "alle", "alles",
    }),
    "pt": frozenset({
        "os", "as", "um", "uma", "do", "da", "dos", "das", "em", "no", "na",
        "nos", "nas", "que", "por", "para", "com", "não", "se", "seu", "sua",
        "como", "mais", "mas", "este", "esta", "isto", "esse", "essa", "isso",
        "muito", "também", "porque", "quando", "onde", "ser", "estar", "tem",
        "têm", "ter", "são", "era", "eram", "foi", "foram", "está", "estão",
        "pode", "podem", "tudo", "nós", "eles", "elas", "você", "vocês",
        "agora", "então",
    }),
    "ru": frozenset({
        "и", "в", "не", "на", "что", "с", "он", "как", "это", "по",
        "но", "они", "все", "так", "его", "от", "за", "к", "же", "вы",
        "ты", "мы", "для", "был", "была", "было", "были", "быть", "есть",
        "или", "если", "когда", "уже", "только", "ещё", "еще", "также", "этот",
        "эта", "эти", "будет", "может", "можно", "нужно", "очень",
        "здесь", "там", "чем", "потому", "чтобы", "меня", "мне", "нас",
        "вам",
    }),
}

# Strip diarisation markers ([You] / [Others] / [Together]) and bracketed
# timestamps like [00:12:34] so they don't dilute the word count.
_BRACKET_RE = re.compile(r"\[[^\]]*\]")
# Strip bare clock timestamps (12:34 or 00:12:34) that appear without brackets.
_TIMESTAMP_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")
# Unicode letter runs (keeps accented characters: é, ü, ñ, ç, ã, …).
_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)

# Only look at the start of a transcript — enough signal without scanning a
# multi-megabyte file.
_MAX_CHARS = 8000
# Require a solid base of evidence and a clear lead over the runner-up before
# committing to a language; otherwise return None and let "en" apply.
_MIN_HITS = 15
_LEAD_RATIO = 1.3


def detect_transcript_language(text: str) -> Optional[str]:
    """Best-effort language of ``text``, or ``None`` when inconclusive.

    Returns one of ``{en, fr, de, es, nl, pt, ru}`` — the Parakeet-supported set —
    only when the winning language clears ``_MIN_HITS`` stopword matches and
    leads the runner-up by at least ``_LEAD_RATIO``. Diarisation markers and
    timestamps are ignored and only the first ``_MAX_CHARS`` are scanned.
    """
    if not text:
        return None

    sample = text[:_MAX_CHARS]
    sample = _BRACKET_RE.sub(" ", sample)
    sample = _TIMESTAMP_RE.sub(" ", sample)

    tokens = _WORD_RE.findall(sample.lower())
    if not tokens:
        return None

    counts = Counter(tokens)
    scores = {
        lang: sum(counts[word] for word in words)
        for lang, words in _STOPWORDS.items()
    }

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    top_lang, top_score = ranked[0]
    runner_score = ranked[1][1] if len(ranked) > 1 else 0

    if top_score < _MIN_HITS:
        return None
    if runner_score and top_score < runner_score * _LEAD_RATIO:
        return None

    return top_lang

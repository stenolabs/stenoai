"""Unit coverage for the transcript language detector (#283).

Parakeet never reports a detected language, so auto-mode meetings used to fall
back to English summaries. ``detect_transcript_language`` fills that gap with a
stopword classifier over the Parakeet-supported languages, and
``resolve_output_language`` slots it into the priority chain
(pin > engine-detected > text-detected > "en").
"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from simple_recorder import (
    MeetingPipeline,
    _parse_meeting_markdown,
    resolve_output_language,
    resolve_persisted_output_language,
)
from src.config import Config
from src.language_detect import detect_transcript_language

# Realistic meeting-style paragraphs (>=80 words each). Function-word rich so
# the aggregate classifier has enough signal, as a real transcript would.
EN_TEXT = (
    "So the main thing that we need to decide today is whether we should ship "
    "the new onboarding flow this week or wait until the next release. I think "
    "the data we have from the last test is good, but there are still a couple "
    "of things that could be better before we send it to all of our users. "
    "What would you like to do about the pricing page? Can we also talk about "
    "how the team will handle support when more people start using it, because "
    "that is the part that worries me the most right now."
)
FR_TEXT = (
    "Donc, la question que nous devons trancher aujourd'hui est de savoir si "
    "nous allons lancer le nouveau parcours cette semaine ou attendre la "
    "prochaine version. Je pense que les données que nous avons sont bonnes, "
    "mais il y a encore des choses qui pourraient être meilleures avant de "
    "les envoyer à tous nos utilisateurs. Que voulez-vous faire pour la page "
    "des prix ? Nous devons aussi parler de la façon dont l'équipe va gérer le "
    "support quand plus de personnes vont commencer à l'utiliser, parce que "
    "c'est la partie qui m'inquiète le plus."
)
DE_TEXT = (
    "Also, die Frage, die wir heute entscheiden müssen, ist, ob wir den neuen "
    "Ablauf diese Woche ausliefern oder bis zur nächsten Version warten "
    "sollen. Ich denke, dass die Daten, die wir aus dem letzten Test haben, "
    "gut sind, aber es gibt noch ein paar Dinge, die besser sein könnten, "
    "bevor wir es an alle unsere Nutzer schicken. Was möchtest du mit der "
    "Preisseite machen? Wir müssen auch darüber reden, wie das Team den "
    "Support macht, wenn mehr Leute anfangen, es zu benutzen, weil das der "
    "Teil ist, der mir am meisten Sorgen macht."
)
ES_TEXT = (
    "Entonces, la pregunta que tenemos que decidir hoy es si deberíamos lanzar "
    "el nuevo flujo esta semana o esperar hasta la próxima versión. Creo que "
    "los datos que tenemos de la última prueba son buenos, pero todavía hay un "
    "par de cosas que podrían ser mejores antes de enviarlo a todos nuestros "
    "usuarios. ¿Qué te gustaría hacer con la página de precios? También "
    "tenemos que hablar de cómo el equipo va a gestionar el soporte cuando más "
    "personas empiecen a usarlo, porque esa es la parte que más me preocupa "
    "en este momento."
)
NL_TEXT = (
    "Dus de vraag die we vandaag moeten beslissen is of we de nieuwe flow deze "
    "week gaan uitbrengen of wachten tot de volgende versie. Ik denk dat de "
    "gegevens die we van de laatste test hebben goed zijn, maar er zijn nog "
    "een paar dingen die beter kunnen voordat we het naar al onze gebruikers "
    "sturen. Wat wil je doen met de prijspagina? We moeten het er ook over "
    "hebben hoe het team de ondersteuning gaat doen wanneer meer mensen het "
    "gaan gebruiken, omdat dat het deel is waar ik me het meest zorgen over "
    "maak."
)
PT_TEXT = (
    "Então, a questão que precisamos decidir hoje é se devemos lançar o novo "
    "fluxo esta semana ou esperar até a próxima versão. Eu acho que os dados "
    "que temos do último teste são bons, mas ainda há algumas coisas que "
    "poderiam ser melhores antes de enviá-lo para todos os nossos usuários. O "
    "que você gostaria de fazer com a página de preços? Nós também precisamos "
    "falar sobre como a equipe vai lidar com o suporte quando mais pessoas "
    "começarem a usá-lo, porque essa é a parte que mais me preocupa agora."
)
RU_TEXT = (
    "Итак, вопрос, который нам нужно решить сегодня, это запускать ли новый "
    "процесс на этой неделе или подождать до следующей версии. Я думаю, что "
    "данные, которые у нас есть с последнего теста, хорошие, но есть ещё "
    "несколько вещей, которые можно сделать лучше, прежде чем мы отправим это "
    "всем нашим пользователям. Что вы хотите сделать со страницей цен? Нам "
    "также нужно поговорить о том, как команда будет обрабатывать поддержку, "
    "когда больше людей начнут этим пользоваться, потому что это та часть, "
    "которая меня сейчас беспокоит больше всего. Если можно, давайте также "
    "обсудим, что уже готово и что ещё нужно доделать, чтобы мы могли "
    "запустить это очень скоро."
)

# A diarised transcript with speaker markers and timestamps — the detector must
# ignore the [You]/[Others] labels and clock stamps and still read German.
DE_DIARISED_TEXT = (
    "[00:00:02] [You] Also ich denke, dass wir die neue Version diese Woche "
    "ausliefern sollten, weil die Daten wirklich gut sind.\n"
    "[00:00:11] [Others] Ja, aber wir müssen noch über den Support reden, "
    "wenn mehr Nutzer anfangen, es zu benutzen.\n"
    "[00:00:20] [You] Das stimmt. Was möchtest du mit der Preisseite machen, "
    "bevor wir es an alle unsere Kunden schicken?\n"
    "[00:00:29] [Others] Ich glaube, wir sollten hier noch ein paar Dinge "
    "besser machen, sonst gibt es zu viele Fragen."
)


class DetectTranscriptLanguageTests(unittest.TestCase):
    def test_detects_each_supported_language(self):
        cases = {
            "en": EN_TEXT,
            "fr": FR_TEXT,
            "de": DE_TEXT,
            "es": ES_TEXT,
            "nl": NL_TEXT,
            "pt": PT_TEXT,
            "ru": RU_TEXT,
        }
        for expected, text in cases.items():
            with self.subTest(language=expected):
                self.assertEqual(detect_transcript_language(text), expected)

    def test_ignores_diarisation_markers_and_timestamps(self):
        # Markers ([You]/[Others]) and [HH:MM:SS] stamps must not derail the
        # aggregate — this German transcript still reads as German.
        self.assertEqual(detect_transcript_language(DE_DIARISED_TEXT), "de")

    def test_mixed_text_dominated_by_german_is_de(self):
        mixed = (
            "Quick note in English at the start. " + DE_TEXT +
            " That is all for now, thanks everyone."
        )
        self.assertEqual(detect_transcript_language(mixed), "de")

    def test_empty_input_is_none(self):
        self.assertIsNone(detect_transcript_language(""))

    def test_none_input_is_none(self):
        self.assertIsNone(detect_transcript_language(None))

    def test_whitespace_only_input_is_none(self):
        self.assertIsNone(detect_transcript_language("   \n\t  "))

    def test_short_ambiguous_input_is_none(self):
        # Too few stopword hits to clear the evidence threshold.
        self.assertIsNone(detect_transcript_language("Okay. Yes. Thanks."))

    def test_numeric_and_symbol_only_input_is_none(self):
        self.assertIsNone(detect_transcript_language("123 456 !!! @@@ 00:12:34 ### 99"))


class ResolveOutputLanguagePriorityTests(unittest.TestCase):
    def test_pinned_config_wins_over_everything(self):
        # A concrete pin beats both an engine language and the transcript body.
        self.assertEqual(
            resolve_output_language("fr", detected_language="de", transcript_text=EN_TEXT),
            "fr",
        )

    def test_engine_detected_wins_over_text_detection(self):
        # In auto mode a real engine language (Whisper) takes precedence over
        # the text classifier, even if the text looks like another language.
        self.assertEqual(
            resolve_output_language("auto", detected_language="es", transcript_text=DE_TEXT),
            "es",
        )

    def test_text_detection_used_only_in_auto_plus_none(self):
        self.assertEqual(
            resolve_output_language("auto", detected_language=None, transcript_text=DE_TEXT),
            "de",
        )

    def test_text_detection_resolves_russian_in_auto(self):
        self.assertEqual(
            resolve_output_language("auto", detected_language=None, transcript_text=RU_TEXT),
            "ru",
        )

    def test_falls_back_to_en_when_detector_inconclusive(self):
        self.assertEqual(
            resolve_output_language("auto", detected_language=None, transcript_text="Yes. No."),
            "en",
        )

    def test_falls_back_to_en_without_transcript(self):
        self.assertEqual(resolve_output_language("auto"), "en")

    def test_method_delegates_to_module_function(self):
        # The MeetingPipeline method is a thin delegate — same priority result
        # without constructing the (heavy) pipeline.
        recorder = MeetingPipeline.__new__(MeetingPipeline)
        self.assertEqual(
            recorder._resolve_output_language("auto", None, transcript_text=FR_TEXT),
            "fr",
        )
        self.assertEqual(recorder._resolve_output_language("de"), "de")


class ResolvePersistedOutputLanguageTests(unittest.TestCase):
    """Provenance rule for the reprocess / generate-report / regen-title paths.

    A persisted output_language is trusted only when pin- or engine-backed;
    a bare fallback "en" from the old Parakeet auto-mode bug (#283) is
    re-detected from the transcript instead of being re-pinned to English.
    """

    def test_stale_en_auto_mode_no_engine_is_redetected(self):
        # The #283 case: a markdown note persisted "en" with no configured/
        # detected provenance, user still on auto → re-detect from the German
        # transcript rather than trusting the stale "en".
        session_info = {"output_language": "en"}
        self.assertEqual(
            resolve_persisted_output_language(session_info, DE_TEXT, "auto"),
            "de",
        )

    def test_persisted_pin_respected_even_with_foreign_transcript(self):
        # A pin-backed note keeps its language even if the transcript text looks
        # like another language.
        session_info = {"output_language": "en", "configured_language": "en"}
        self.assertEqual(
            resolve_persisted_output_language(session_info, DE_TEXT, "auto"),
            "en",
        )

    def test_persisted_with_engine_detection_respected(self):
        # Engine (Whisper) detection is trustworthy provenance: keep the
        # persisted value even though the current config is auto and the text
        # reads as German.
        session_info = {"output_language": "fr", "detected_language": "fr"}
        self.assertEqual(
            resolve_persisted_output_language(session_info, DE_TEXT, "auto"),
            "fr",
        )

    def test_empty_session_info_auto_config_redetects(self):
        # No persisted value at all → detection from the transcript.
        self.assertEqual(
            resolve_persisted_output_language({}, DE_TEXT, "auto"),
            "de",
        )

    def test_empty_session_info_auto_config_inconclusive_is_en(self):
        # No persisted value and nothing to detect → "en" fallback.
        self.assertEqual(
            resolve_persisted_output_language({}, "Yes. No.", "auto"),
            "en",
        )

    def test_legacy_note_honors_current_pin_not_stale_persisted(self):
        # HIGH fix: a legacy note persisted "en" with NO stored provenance must
        # NOT be authenticated by the caller's CURRENT pin. With config pinned to
        # "fr", the current "fr" pin wins over the stale "en" (and over the
        # German transcript, because a pin beats detection).
        session_info = {"output_language": "en"}
        self.assertEqual(
            resolve_persisted_output_language(session_info, DE_TEXT, "fr"),
            "fr",
        )

    def test_legacy_note_current_auto_redetects_from_transcript(self):
        # Same legacy note, but the caller is on auto now -> re-detect the German
        # transcript instead of trusting the stale "en".
        session_info = {"output_language": "en"}
        self.assertEqual(
            resolve_persisted_output_language(session_info, DE_TEXT, "auto"),
            "de",
        )

    def test_stored_pin_honored_regardless_of_current_config(self):
        # A note with a STORED pin keeps it even when current config differs.
        session_info = {"output_language": "en", "configured_language": "en"}
        self.assertEqual(
            resolve_persisted_output_language(session_info, DE_TEXT, "fr"),
            "en",
        )

    def test_stored_pin_without_persisted_output_language_is_honored(self):
        # A real stored pin with no persisted output_language must still win over
        # the caller's current config (it reaches the untrusted branch because
        # output_language is empty, but the stored pin is preferred there).
        session_info = {"configured_language": "de"}
        self.assertEqual(
            resolve_persisted_output_language(session_info, EN_TEXT, "fr"),
            "de",
        )


def _write_md(tmp: str, frontmatter: str) -> Path:
    p = Path(tmp) / "meeting_summary.md"
    p.write_text(
        f"---\n{frontmatter}---\n\n## Summary\n\nEin kurzer Ueberblick.\n\n"
        "## Transcript\n\n[You] Hallo zusammen. [Others] Guten Morgen.\n",
        encoding="utf-8",
    )
    return p


class MarkdownProvenanceTests(unittest.TestCase):
    """Markdown notes must persist + restore language provenance (#283).

    Without it, reprocessing / chatting a Whisper .md note loses the engine
    detection (re-detection could discard a valid 'de'), and a stale Parakeet
    'en' can't be told apart from a real pin.
    """

    def test_provenance_keys_round_trip_through_parser(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = _write_md(
                tmp,
                "title: Standup\nlanguage: de\nconfigured_language: auto\n"
                "detected_language: de\nduration_seconds: 120\n",
            )
            session_info = _parse_meeting_markdown(md)["session_info"]
            self.assertEqual(session_info["output_language"], "de")
            self.assertEqual(session_info["configured_language"], "auto")
            self.assertEqual(session_info["detected_language"], "de")

    def test_old_markdown_without_keys_parses_with_none_provenance(self):
        # A .md written before these keys existed must still parse; missing keys
        # read as None (no provenance -> re-detect, prior behaviour preserved).
        with tempfile.TemporaryDirectory() as tmp:
            md = _write_md(tmp, "title: Legacy\nlanguage: en\nduration_seconds: 60\n")
            session_info = _parse_meeting_markdown(md)["session_info"]
            self.assertEqual(session_info["output_language"], "en")
            self.assertIsNone(session_info["configured_language"])
            self.assertIsNone(session_info["detected_language"])

    def test_query_decision_stale_en_note_redetects_from_transcript(self):
        # The chat/query seam (Python-side): a legacy Parakeet auto-mode note
        # persisted "en" with no provenance. Parsing it then running the
        # resolver over a German transcript must recover German, not stay English.
        with tempfile.TemporaryDirectory() as tmp:
            md = _write_md(tmp, "title: Legacy\nlanguage: en\nduration_seconds: 60\n")
            session_info = _parse_meeting_markdown(md)["session_info"]
            self.assertEqual(
                resolve_persisted_output_language(session_info, DE_TEXT, "auto"),
                "de",
            )

    def test_query_decision_whisper_note_keeps_engine_language(self):
        # A Whisper note carries detected_language provenance, so its persisted
        # language is kept even when the (foreign) transcript text disagrees.
        with tempfile.TemporaryDirectory() as tmp:
            md = _write_md(
                tmp,
                "title: Whisper\nlanguage: de\ndetected_language: de\n"
                "duration_seconds: 60\n",
            )
            session_info = _parse_meeting_markdown(md)["session_info"]
            self.assertEqual(
                resolve_persisted_output_language(session_info, EN_TEXT, "auto"),
                "de",
            )


class QueryPathLanguageTests(unittest.TestCase):
    """The chat/query paths must detect over the RAW transcript, not the combined
    summary+topics+transcript context (#283).

    Detection samples only the first ~8000 chars, so a legacy English summary at
    the front of the combined text could otherwise flip a German meeting to "en".
    """

    def _run_query(self, tmp: str, md_body: str) -> str:
        md = Path(tmp) / "meeting_summary.md"
        md.write_text(md_body, encoding="utf-8")
        cfg = Config(config_path=Path(tmp) / "config.json")  # defaults to "auto"
        fake = mock.MagicMock()
        fake.query_transcript.return_value = "antwort"
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.object(simple_recorder, "OllamaSummarizer", return_value=fake):
            res = CliRunner().invoke(
                simple_recorder.query, [str(md), "-q", "Worum ging es?"]
            )
        self.assertEqual(res.exit_code, 0, res.output)
        fake.query_transcript.assert_called_once()
        return fake.query_transcript.call_args.kwargs["language"]

    def test_english_summary_german_transcript_resolves_to_de(self):
        # Legacy note labelled English (no provenance) with an English summary but
        # a German transcript: chat must answer in German, driven by the RAW
        # transcript. Under the old combined-context detection this flipped to en.
        md_body = (
            f"---\ntitle: Sync\nlanguage: en\n---\n\n"
            f"## Summary\n\n{EN_TEXT}\n\n## Transcript\n\n{DE_TEXT}\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self._run_query(tmp, md_body), "de")


if __name__ == "__main__":
    unittest.main()

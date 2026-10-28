import unittest
from src import keywords


class ParseFormatTests(unittest.TestCase):
    def test_no_colon_line(self):
        self.assertEqual(
            keywords.parse_keywords_text("DataFlow GmbH"),
            [{"preferred": "DataFlow GmbH", "aliases": []}],
        )

    def test_aliases_split_on_first_colon(self):
        self.assertEqual(
            keywords.parse_keywords_text("NexGen Suite: NexGan Suite, NexGin Suite"),
            [{"preferred": "NexGen Suite", "aliases": ["NexGan Suite", "NexGin Suite"]}],
        )

    def test_trims_and_drops_blank_lines_and_aliases(self):
        self.assertEqual(
            keywords.parse_keywords_text("  BrightLedger :  bright ledger , \n\n"),
            [{"preferred": "BrightLedger", "aliases": ["bright ledger"]}],
        )

    def test_round_trip(self):
        text = "NexGen Suite: NexGan Suite, NexGin Suite\nBrightLedger: bright ledger\nDataFlow GmbH"
        self.assertEqual(
            keywords.format_keywords_text(keywords.parse_keywords_text(text)),
            text,
        )


class NormalizeTests(unittest.TestCase):
    def test_drops_empty_preferred(self):
        self.assertEqual(keywords.normalize_keywords([{"preferred": "  ", "aliases": ["x"]}]), [])

    def test_preferred_dedupe_case_insensitive_last_wins(self):
        out = keywords.normalize_keywords([
            {"preferred": "BrightLedger", "aliases": ["bright ledger"]},
            {"preferred": "brightledger", "aliases": ["ledger"]},
        ])
        self.assertEqual(out, [{"preferred": "brightledger", "aliases": ["ledger"]}])

    def test_global_alias_dedupe(self):
        out = keywords.normalize_keywords([
            {"preferred": "A", "aliases": ["shared"]},
            {"preferred": "B", "aliases": ["shared", "bee"]},
        ])
        self.assertEqual(out, [
            {"preferred": "A", "aliases": ["shared"]},
            {"preferred": "B", "aliases": ["bee"]},
        ])

    def test_alias_equal_to_preferred_dropped(self):
        out = keywords.normalize_keywords([
            {"preferred": "Steno", "aliases": []},
            {"preferred": "X", "aliases": ["steno", "ex"]},
        ])
        self.assertEqual(out[1]["aliases"], ["ex"])

    def test_caps(self):
        many = [{"preferred": f"T{i}", "aliases": []} for i in range(300)]
        self.assertEqual(len(keywords.normalize_keywords(many)), 200)
        long = keywords.normalize_keywords([{"preferred": "p" * 200, "aliases": ["a" * 200]}])
        self.assertEqual(len(long[0]["preferred"]), 80)
        self.assertEqual(len(long[0]["aliases"][0]), 80)

    def test_alias_cap(self):
        out = keywords.normalize_keywords([
            {"preferred": "P", "aliases": [f"a{i}" for i in range(15)]},
        ])
        self.assertEqual(len(out[0]["aliases"]), 10)

    def test_last_wins_reclaims_alias(self):
        out = keywords.normalize_keywords([
            {"preferred": "A", "aliases": ["x"]},
            {"preferred": "a", "aliases": ["x"]},
        ])
        self.assertEqual(out, [{"preferred": "a", "aliases": ["x"]}])


ENTRIES = [
    {"preferred": "NexGen Suite", "aliases": ["NexGan Suite", "bright ledger", "C++"]},
]


class ApplyAliasesTests(unittest.TestCase):
    def test_empty_entries_is_identity(self):
        self.assertEqual(keywords.apply_aliases("anything", []), "anything")

    def test_replaces_case_insensitive_whole_token(self):
        self.assertEqual(
            keywords.apply_aliases("we discussed nexgan suite today", ENTRIES),
            "we discussed NexGen Suite today",
        )

    def test_does_not_match_inside_word(self):
        # "bright ledger" must not fire inside "rebright ledgery" style runs
        self.assertEqual(keywords.apply_aliases("xbright ledgerx", ENTRIES), "xbright ledgerx")

    def test_punctuation_alias_bounded(self):
        # alias "C++" matches standalone but NOT inside C++17
        self.assertEqual(keywords.apply_aliases("use C++ now", ENTRIES), "use NexGen Suite now")
        self.assertEqual(keywords.apply_aliases("C++17 release", ENTRIES), "C++17 release")

    def test_longest_alias_first(self):
        entries = [
            {"preferred": "FOO", "aliases": ["ab"]},
            {"preferred": "BAR", "aliases": ["abc"]},
        ]
        self.assertEqual(keywords.apply_aliases("abc", entries), "BAR")

    def test_diarised_label_protected(self):
        entries = [{"preferred": "PREF", "aliases": ["you"]}]
        out = keywords.apply_aliases_diarised("[You] you said hi", entries)
        self.assertEqual(out, "[You] PREF said hi")

    def test_apply_to_transcript_autoroutes(self):
        entries = [{"preferred": "PREF", "aliases": ["others"]}]
        self.assertEqual(
            keywords.apply_to_transcript("[Others] the others left", entries),
            "[Others] the PREF left",
        )


class ApplyAliasesUnicodeTests(unittest.TestCase):
    def test_unicode_case_fold_does_not_raise(self):
        # 'İSTANBUL'.lower() -> 'i̇stanbul' (combining dot), not a mapping key.
        # Must not raise KeyError; returns a string (matched text left unchanged
        # is acceptable for the fold-asymmetry edge case).
        entries = [{"preferred": "Istanbul City", "aliases": ["istanbul"]}]
        result = keywords.apply_aliases("İSTANBUL", entries)
        self.assertIsInstance(result, str)

    def test_unicode_letter_is_word_boundary(self):
        # alias "foo" must NOT match inside äfoo / fooä (non-ASCII letter = \w)
        entries = [{"preferred": "FOO_PREF", "aliases": ["foo"]}]
        self.assertEqual(keywords.apply_aliases("äfoo", entries), "äfoo")
        self.assertEqual(keywords.apply_aliases("fooä", entries), "fooä")
        # but standalone still fires
        self.assertEqual(keywords.apply_aliases("a foo b", entries), "a FOO_PREF b")

    def test_cpp_boundaries_hold_after_unicode_switch(self):
        self.assertEqual(keywords.apply_aliases("use C++ now", ENTRIES), "use NexGen Suite now")
        self.assertEqual(keywords.apply_aliases("C++17 release", ENTRIES), "C++17 release")


class DiarisedTimestampLabelTests(unittest.TestCase):
    """FIX 2: the REAL production diarised line is `[MM:SS] [You] text` /
    `[H:MM:SS] [Others] text` (transcriber._format_timestamp + speaker tag).
    Both the timestamp AND the [You]/[Others] speaker label must be protected
    from alias replacement - an alias `you`/`others` must not rewrite the label.
    """

    def test_speaker_label_protected_with_timestamp(self):
        entries = [{"preferred": "Speaker Alpha", "aliases": ["you"]}]
        line = "[00:05] [You] you said we should ship"
        self.assertEqual(
            keywords.apply_to_transcript(line, entries),
            "[00:05] [You] Speaker Alpha said we should ship",
        )

    def test_others_label_protected_with_hour_timestamp(self):
        entries = [{"preferred": "Team", "aliases": ["others"]}]
        line = "[1:02:33] [Others] the others agreed"
        self.assertEqual(
            keywords.apply_to_transcript(line, entries),
            "[1:02:33] [Others] the Team agreed",
        )

    def test_multiline_timestamped_diarised_block(self):
        entries = [{"preferred": "NexGen Suite", "aliases": ["NexGan Suite"]}]
        text = "[00:01] [You] we shipped NexGan Suite\n\n[00:09] [Others] great, NexGan Suite rocks"
        self.assertEqual(
            keywords.apply_to_transcript(text, entries),
            "[00:01] [You] we shipped NexGen Suite\n\n[00:09] [Others] great, NexGen Suite rocks",
        )


class NormalizeMalformedConfigTests(unittest.TestCase):
    """FIX 4: normalize_keywords must survive a hand-edited / corrupted
    config.json without crashing or silently corrupting the alias table."""

    def test_non_dict_entries_dropped(self):
        out = keywords.normalize_keywords(
            ["oops", 5, None, ["x"], {"preferred": "OK", "aliases": []}]
        )
        self.assertEqual(out, [{"preferred": "OK", "aliases": []}])

    def test_numeric_preferred_dropped(self):
        self.assertEqual(
            keywords.normalize_keywords([{"preferred": 42, "aliases": ["x"]}]), []
        )

    def test_string_aliases_treated_as_single_alias_not_chars(self):
        # The bug: `for a in "foo"` yields 'f','o','o'. Must be one alias "foo".
        out = keywords.normalize_keywords([{"preferred": "P", "aliases": "foo"}])
        self.assertEqual(out, [{"preferred": "P", "aliases": ["foo"]}])

    def test_non_list_aliases_dropped(self):
        out = keywords.normalize_keywords([{"preferred": "P", "aliases": 123}])
        self.assertEqual(out, [{"preferred": "P", "aliases": []}])

    def test_numeric_alias_elements_dropped(self):
        out = keywords.normalize_keywords(
            [{"preferred": "P", "aliases": [1, "ok", None]}]
        )
        self.assertEqual(out, [{"preferred": "P", "aliases": ["ok"]}])

    def test_control_and_newline_chars_stripped(self):
        out = keywords.normalize_keywords(
            [{"preferred": "A\nB\tC", "aliases": ["x\x00y"]}]
        )
        self.assertEqual(out, [{"preferred": "A B C", "aliases": ["x y"]}])

    def test_no_crash_on_fully_garbage_input(self):
        # Must not raise, just yield [].
        self.assertEqual(keywords.normalize_keywords([1, "a", None, 3.5]), [])


class ReferenceBlockTests(unittest.TestCase):
    def test_empty_is_empty_string(self):
        self.assertEqual(keywords.reference_block([]), "")

    def test_lists_preferred_terms(self):
        block = keywords.reference_block([
            {"preferred": "NexGen Suite", "aliases": ["x"]},
            {"preferred": "BrightLedger", "aliases": []},
        ])
        self.assertIn("REFERENCE TERMS", block)
        self.assertIn("- NexGen Suite", block)
        self.assertIn("- BrightLedger", block)
        self.assertTrue(block.endswith("\n\n"))


if __name__ == "__main__":
    unittest.main()

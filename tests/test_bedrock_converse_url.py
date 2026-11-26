"""Regression tests for the Bedrock Converse URL builder.

The original release shipped two copies of this URL-encoding logic — one
in src/summarizer._bedrock_chat and another in
simple_recorder.test_cloud_api — both with the same too-narrow safe set
(``":.-"``). That worked for system inference profile ids and bare model
ids, but silently broke for application inference profile ARNs in
governed AWS environments because the ARN contains a path-style
``application-inference-profile/<id>`` segment. Leaving the slash
literal made Bedrock's router return HTTP 200 with an
``UnknownOperationException`` body instead of routing to Converse; the
fix fully percent-encodes the identifier (``safe=""``).

These tests pin the three concrete shapes we expect to construct URLs
for, so a regression on the safe set surfaces here before it ships.
"""
import unittest

from src.summarizer import bedrock_converse_url


class BedrockConverseUrlTests(unittest.TestCase):
    def test_application_inference_profile_arn_is_fully_encoded(self):
        arn = (
            "arn:aws:bedrock:eu-west-2:745078845594:"
            "application-inference-profile/acgdk9re2ouo"
        )
        url = bedrock_converse_url("eu-west-2", arn)
        # The ARN is fully percent-encoded: `:` -> %3A, `/` -> %2F. Left
        # literal, the slash makes Bedrock return HTTP 200 with an
        # UnknownOperationException instead of routing to Converse.
        self.assertIn("%3A", url)
        self.assertIn("%2F", url)
        self.assertIn(
            "arn%3Aaws%3Abedrock%3Aeu-west-2%3A745078845594%3A"
            "application-inference-profile%2Facgdk9re2ouo",
            url,
        )
        # Host + path shape.
        self.assertTrue(
            url.startswith("https://bedrock-runtime.eu-west-2.amazonaws.com/model/")
        )
        self.assertTrue(url.endswith("/converse"))

    def test_system_inference_profile_id_unchanged(self):
        # The Anthropic system profile shape from the AWS docs. The `:0`
        # version suffix now percent-encodes to %3A0.
        profile = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        encoded = "us.anthropic.claude-haiku-4-5-20251001-v1%3A0"
        url = bedrock_converse_url("us-east-1", profile)
        self.assertIn(f"/model/{encoded}/converse", url)

    def test_bare_model_id_unchanged(self):
        # Direct-invoke shape. Same expectations as the system profile —
        # the `:0` version suffix percent-encodes to %3A0.
        model = "anthropic.claude-haiku-4-5-20251001-v1:0"
        encoded = "anthropic.claude-haiku-4-5-20251001-v1%3A0"
        url = bedrock_converse_url("us-east-1", model)
        self.assertIn(f"/model/{encoded}/converse", url)

    def test_region_lands_in_host_segment(self):
        # Defensive — ensures the region argument flows through rather
        # than getting silently dropped into the path.
        url = bedrock_converse_url("ap-southeast-2", "model-x")
        self.assertIn("bedrock-runtime.ap-southeast-2.amazonaws.com", url)

    def test_rejects_region_shaped_to_redirect_the_host(self):
        # `user@host` URL syntax: an attacker- or accident-crafted region
        # value that would silently point the request (with the real
        # Bedrock bearer credential attached) at a different host instead
        # of AWS. See issue #299 — set_bedrock_region() also guards this,
        # but the sink itself must not trust its caller either.
        with self.assertRaises(ValueError):
            bedrock_converse_url("x@127.0.0.1:8443/", "model-x")

    def test_rejects_non_aws_shaped_region(self):
        with self.assertRaises(ValueError):
            bedrock_converse_url("not a region", "model-x")

    def test_rejects_unicode_digit_lookalikes(self):
        # Python's \d matches non-ASCII decimal digits under re.UNICODE
        # (the default) — e.g. Arabic-Indic ١ or fullwidth １ — which would
        # otherwise slip a visually-similar-but-wrong region past the
        # regex. Region codes are ASCII by definition.
        with self.assertRaises(ValueError):
            bedrock_converse_url("us-east-١", "model-x")  # Arabic-Indic 1

    def test_rejects_trailing_newline(self):
        # `re.match(..., "$")` allows a trailing "\n" ("$" matches just
        # before it). fullmatch() must be used so a region smuggled with a
        # trailing newline (e.g. from a config/env value) is rejected too.
        with self.assertRaises(ValueError):
            bedrock_converse_url("us-east-1\n", "model-x")



class BedrockConverseStreamUrlTests(unittest.TestCase):
    def test_stream_flag_targets_converse_stream_with_same_encoding(self):
        arn = "arn:aws:bedrock:eu-west-2:745078845594:application-inference-profile/acgdk9re2ouo"
        url = bedrock_converse_url("eu-west-2", arn, stream=True)
        self.assertEqual(
            url,
            "https://bedrock-runtime.eu-west-2.amazonaws.com/model/"
            "arn%3Aaws%3Abedrock%3Aeu-west-2%3A745078845594%3A"
            "application-inference-profile%2Facgdk9re2ouo/converse-stream",
        )

    def test_stream_url_rejects_malformed_region_too(self):
        with self.assertRaises(ValueError):
            bedrock_converse_url("x@127.0.0.1:8443/", "m", stream=True)


if __name__ == "__main__":
    unittest.main()

"""Tests for the hand-written AWS event-stream decoder (src.aws_eventstream).

Frames are built by hand (struct + zlib) rather than through encode_message
so the decoder and the encoder cannot agree on a shared mistake.
"""

import io
import json
import struct
import unittest
import zlib

from src.aws_eventstream import (
    EventStreamDecoder,
    EventStreamError,
    EventStreamFormatError,
    encode_message,
    iter_event_stream,
    iter_events,
)


def _crc(data):
    return zlib.crc32(data) & 0xFFFFFFFF


def _string_header(name, value):
    n, v = name.encode(), value.encode()
    return bytes([len(n)]) + n + bytes([7]) + struct.pack(">H", len(v)) + v


def _frame(headers, payload):
    """Hand-built frame: prelude | headers | payload | message CRC."""
    total = 12 + len(headers) + len(payload) + 4
    prelude = struct.pack(">II", total, len(headers))
    prelude += struct.pack(">I", _crc(prelude))
    body = prelude + headers + payload
    return body + struct.pack(">I", _crc(body))


def _event(event_type, obj):
    headers = (
        _string_header(":event-type", event_type)
        + _string_header(":content-type", "application/json")
        + _string_header(":message-type", "event")
    )
    return _frame(headers, json.dumps(obj).encode())


class DecoderTests(unittest.TestCase):
    def test_decodes_one_hand_built_message(self):
        frame = _event("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": "Hi"}})
        messages = list(EventStreamDecoder().feed(frame))
        self.assertEqual(len(messages), 1)
        m = messages[0]
        self.assertEqual(m.message_type, "event")
        self.assertEqual(m.event_type, "contentBlockDelta")
        self.assertEqual(m.headers[":content-type"], "application/json")
        self.assertEqual(m.json(), {"contentBlockIndex": 0, "delta": {"text": "Hi"}})

    def test_message_split_across_chunks_at_every_offset(self):
        a = _event("messageStart", {"role": "assistant"})
        b = _event("contentBlockDelta", {"delta": {"text": "x" * 300}})
        stream = a + b
        for cut in range(1, len(stream)):
            decoder = EventStreamDecoder()
            got = list(decoder.feed(stream[:cut])) + list(decoder.feed(stream[cut:]))
            self.assertEqual([m.event_type for m in got], ["messageStart", "contentBlockDelta"], cut)
            self.assertEqual(decoder.pending, 0, cut)

    def test_byte_at_a_time_feed(self):
        frame = _event("messageStop", {"stopReason": "end_turn"})
        decoder = EventStreamDecoder()
        got = []
        for i in range(len(frame)):
            got += list(decoder.feed(frame[i:i + 1]))
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].json(), {"stopReason": "end_turn"})

    def test_multiple_messages_in_one_chunk(self):
        stream = b"".join(_event("contentBlockDelta", {"delta": {"text": t}}) for t in ("a", "b", "c"))
        got = list(EventStreamDecoder().feed(stream))
        self.assertEqual([m.json()["delta"]["text"] for m in got], ["a", "b", "c"])

    def test_bad_prelude_crc_raises(self):
        frame = bytearray(_event("messageStart", {"role": "assistant"}))
        frame[9] ^= 0xFF  # inside the prelude CRC
        with self.assertRaises(EventStreamFormatError):
            list(EventStreamDecoder().feed(bytes(frame)))

    def test_bad_message_crc_raises(self):
        frame = bytearray(_event("messageStart", {"role": "assistant"}))
        frame[-1] ^= 0xFF
        with self.assertRaises(EventStreamFormatError):
            list(EventStreamDecoder().feed(bytes(frame)))

    def test_corrupted_payload_fails_message_crc(self):
        frame = bytearray(_event("contentBlockDelta", {"delta": {"text": "Hi"}}))
        frame[-6] ^= 0x01  # a payload byte
        with self.assertRaises(EventStreamFormatError):
            list(EventStreamDecoder().feed(bytes(frame)))

    def test_absurd_length_is_rejected_without_buffering(self):
        prelude = struct.pack(">II", 0x7FFFFFFF, 0)
        prelude += struct.pack(">I", _crc(prelude))
        with self.assertRaises(EventStreamFormatError):
            list(EventStreamDecoder().feed(prelude))

    def test_non_string_header_types_are_walked(self):
        headers = (
            _string_header(":message-type", "event")
            + b"\x04bool" + bytes([0])
            + b"\x03int" + bytes([4]) + struct.pack(">i", -7)
            + b"\x04long" + bytes([5]) + struct.pack(">q", 1 << 40)
            + b"\x04blob" + bytes([6]) + struct.pack(">H", 2) + b"\x01\x02"
            + b"\x02ts" + bytes([8]) + struct.pack(">q", 1700000000000)
            + b"\x04uuid" + bytes([9]) + bytes(range(16))
            + _string_header(":event-type", "metadata")
        )
        (m,) = EventStreamDecoder().feed(_frame(headers, b"{}"))
        self.assertEqual(m.headers["bool"], True)
        self.assertEqual(m.headers["int"], -7)
        self.assertEqual(m.headers["long"], 1 << 40)
        self.assertEqual(m.headers["blob"], b"\x01\x02")
        self.assertEqual(m.headers["ts"], 1700000000000)
        self.assertEqual(m.headers["uuid"], bytes(range(16)))
        self.assertEqual(m.event_type, "metadata")

    def test_unknown_header_type_raises(self):
        headers = _string_header(":message-type", "event") + b"\x01x" + bytes([42])
        with self.assertRaises(EventStreamFormatError):
            list(EventStreamDecoder().feed(_frame(headers, b"")))

    def test_encode_message_round_trips_through_hand_decoder(self):
        frame = encode_message({":message-type": "event", ":event-type": "x", "flag": True, "raw": b"\x00"}, b"hi")
        (m,) = EventStreamDecoder().feed(frame)
        self.assertEqual(m.headers, {":message-type": "event", ":event-type": "x", "flag": True, "raw": b"\x00"})
        self.assertEqual(m.payload, b"hi")


class _Read1Reader(io.BytesIO):
    """Serves tiny slices per read1 to prove the stream reader loops."""

    def read1(self, size=-1):
        return super().read(min(size if size > 0 else 7, 7))


class StreamReaderTests(unittest.TestCase):
    def test_iter_event_stream_uses_read1_and_reassembles(self):
        stream = _event("messageStart", {"role": "assistant"}) + _event("messageStop", {"stopReason": "end_turn"})
        got = list(iter_event_stream(_Read1Reader(stream)))
        self.assertEqual([m.event_type for m in got], ["messageStart", "messageStop"])

    def test_truncated_stream_raises(self):
        stream = _event("messageStart", {"role": "assistant"})[:-3]
        with self.assertRaises(EventStreamFormatError):
            list(iter_event_stream(io.BytesIO(stream)))

    def test_iter_events_yields_type_and_payload(self):
        stream = _event("contentBlockDelta", {"delta": {"text": "Hi"}}) + _event("messageStop", {"stopReason": "end_turn"})
        self.assertEqual(list(iter_events(io.BytesIO(stream))), [
            ("contentBlockDelta", {"delta": {"text": "Hi"}}),
            ("messageStop", {"stopReason": "end_turn"}),
        ])

    def test_exception_message_raises_with_type_but_not_body(self):
        secret = "the prompt said: launch codes"
        headers = (
            _string_header(":exception-type", "throttlingException")
            + _string_header(":content-type", "application/json")
            + _string_header(":message-type", "exception")
        )
        stream = _event("messageStart", {"role": "assistant"}) + _frame(headers, json.dumps({"message": secret}).encode())
        events = iter_events(io.BytesIO(stream))
        self.assertEqual(next(events)[0], "messageStart")
        with self.assertRaises(EventStreamError) as ctx:
            next(events)
        self.assertEqual(ctx.exception.code, "throttlingException")
        self.assertEqual(ctx.exception.type, "throttlingException")
        self.assertNotIn(secret, str(ctx.exception))
        self.assertNotIn("launch", repr(ctx.exception))

    def test_error_message_uses_error_code_header(self):
        headers = _string_header(":message-type", "error") + _string_header(":error-code", "InternalError")
        with self.assertRaises(EventStreamError) as ctx:
            list(iter_events(io.BytesIO(_frame(headers, b"private detail"))))
        self.assertEqual(ctx.exception.code, "InternalError")
        self.assertNotIn("private", str(ctx.exception))

    def test_non_json_event_payload_raises_format_error(self):
        headers = _string_header(":message-type", "event") + _string_header(":event-type", "metadata")
        with self.assertRaises(EventStreamFormatError):
            list(iter_events(io.BytesIO(_frame(headers, b"not json"))))


if __name__ == "__main__":
    unittest.main()

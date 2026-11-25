"""Minimal decoder for the AWS binary event-stream framing.

Bedrock's ``converse-stream`` endpoint answers with
``application/vnd.amazon.eventstream``: a sequence of length-prefixed binary
messages. boto3/botocore ship a decoder, but pulling either into the
PyInstaller bundle just for this framing would add tens of megabytes, so this
module implements the small subset Steno needs by hand.

Wire format of one message (all integers big-endian)::

    prelude        total_length (4) | headers_length (4) | prelude_crc (4)
    headers        headers_length bytes of typed headers
    payload        total_length - headers_length - 16 bytes
    message_crc    (4) CRC32 of everything before it

Each header is ``name_length (1) | name | value_type (1) | value``. The
value types are: 0/1 bool true/false, 2 byte, 3 short, 4 int, 5 long,
6 byte-array (2-byte length prefix), 7 string (2-byte length prefix,
UTF-8), 8 timestamp (8), 9 UUID (16). Bedrock uses string headers for
``:message-type``, ``:event-type``, ``:content-type`` and
``:exception-type``; the other types are decoded only so the header block
can be walked past them.

Both CRCs are plain CRC32 (``zlib.crc32``). A CRC mismatch raises
``EventStreamFormatError``; the decoder is not resumable after that.

Nothing here logs or embeds payload bytes in an exception message: the
payloads carry model output and provider error text, which must stay
private (see ``src.ai_errors``).
"""

from __future__ import annotations

import json
import struct
import zlib
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, Optional

PRELUDE_LENGTH = 12
MESSAGE_CRC_LENGTH = 4
# The framing allows up to 16 MiB plus overhead per message. Bedrock events
# are a few KiB; a far larger length almost certainly means we are not
# looking at an event stream at all, so refuse rather than buffer it.
MAX_MESSAGE_LENGTH = 16 * 1024 * 1024 + 128

_HEADER_FIXED_SIZES = {2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16}
_HEADER_INT_FORMATS = {2: ">b", 3: ">h", 4: ">i", 5: ">q", 8: ">q"}


class EventStreamFormatError(ValueError):
    """The bytes are not a well-formed AWS event stream (bad CRC/framing)."""


class EventStreamError(RuntimeError):
    """The stream carried an ``exception`` or ``error`` message.

    ``code`` is the provider's machine-readable type (for Bedrock e.g.
    ``throttlingException`` or ``modelStreamErrorException``); it is also
    exposed as ``type`` so ``src.ai_errors`` can classify it. The message
    text is a fixed string: the payload is never included.
    """

    def __init__(self, code: str):
        self.code = code or "unknown"
        self.type = self.code
        super().__init__(f"AWS event stream reported {self.code}")


@dataclass
class EventStreamMessage:
    headers: Dict[str, Any] = field(default_factory=dict)
    payload: bytes = b""

    @property
    def message_type(self) -> str:
        return str(self.headers.get(":message-type") or "")

    @property
    def event_type(self) -> str:
        return str(self.headers.get(":event-type") or "")

    @property
    def exception_type(self) -> str:
        return str(self.headers.get(":exception-type") or self.headers.get(":error-code") or "")

    def json(self) -> Any:
        """The payload decoded as JSON (``None`` when it is empty)."""
        if not self.payload:
            return None
        return json.loads(self.payload.decode("utf-8"))


def _crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def _decode_headers(raw: bytes) -> Dict[str, Any]:
    headers: Dict[str, Any] = {}
    pos = 0
    end = len(raw)
    while pos < end:
        name_len = raw[pos]
        pos += 1
        if name_len == 0 or pos + name_len + 1 > end:
            raise EventStreamFormatError("event stream header name is malformed")
        name = raw[pos:pos + name_len].decode("utf-8")
        pos += name_len
        value_type = raw[pos]
        pos += 1
        if value_type == 0:
            value: Any = True
        elif value_type == 1:
            value = False
        elif value_type in (6, 7):
            if pos + 2 > end:
                raise EventStreamFormatError("event stream header value is truncated")
            (value_len,) = struct.unpack_from(">H", raw, pos)
            pos += 2
            if pos + value_len > end:
                raise EventStreamFormatError("event stream header value is truncated")
            chunk = raw[pos:pos + value_len]
            pos += value_len
            value = chunk.decode("utf-8") if value_type == 7 else bytes(chunk)
        elif value_type in _HEADER_FIXED_SIZES:
            size = _HEADER_FIXED_SIZES[value_type]
            if pos + size > end:
                raise EventStreamFormatError("event stream header value is truncated")
            chunk = raw[pos:pos + size]
            pos += size
            if value_type == 9:
                value = bytes(chunk)
            else:
                (value,) = struct.unpack(_HEADER_INT_FORMATS[value_type], chunk)
        else:
            raise EventStreamFormatError(f"unknown event stream header type {value_type}")
        headers[name] = value
    return headers


def encode_message(headers: Dict[str, Any], payload: bytes = b"") -> bytes:
    """Frame one message. Used by tests and fixtures; string values only.

    Bools encode as types 0/1, ``bytes`` as type 6, everything else as a
    string header (type 7), which is all Bedrock itself ever sends.
    """
    header_bytes = bytearray()
    for name, value in headers.items():
        encoded_name = name.encode("utf-8")
        header_bytes.append(len(encoded_name))
        header_bytes += encoded_name
        if isinstance(value, bool):
            header_bytes.append(0 if value else 1)
        elif isinstance(value, (bytes, bytearray)):
            header_bytes.append(6)
            header_bytes += struct.pack(">H", len(value))
            header_bytes += bytes(value)
        else:
            encoded_value = str(value).encode("utf-8")
            header_bytes.append(7)
            header_bytes += struct.pack(">H", len(encoded_value))
            header_bytes += encoded_value
    total_length = PRELUDE_LENGTH + len(header_bytes) + len(payload) + MESSAGE_CRC_LENGTH
    prelude = struct.pack(">II", total_length, len(header_bytes))
    prelude += struct.pack(">I", _crc32(prelude))
    body = prelude + bytes(header_bytes) + payload
    return body + struct.pack(">I", _crc32(body))


class EventStreamDecoder:
    """Incremental decoder: ``feed`` arbitrary byte chunks, get whole messages.

    Bytes may be split at any point, including inside the prelude or the
    trailing CRC; partial data is buffered until the message completes.
    """

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes) -> Iterator[EventStreamMessage]:
        if data:
            self._buffer += data
        while True:
            message = self._next_message()
            if message is None:
                return
            yield message

    def _next_message(self) -> Optional[EventStreamMessage]:
        buf = self._buffer
        if len(buf) < PRELUDE_LENGTH:
            return None
        total_length, headers_length, prelude_crc = struct.unpack_from(">III", buf, 0)
        if _crc32(bytes(buf[:8])) != prelude_crc:
            raise EventStreamFormatError("event stream prelude CRC mismatch")
        if total_length > MAX_MESSAGE_LENGTH or total_length < PRELUDE_LENGTH + MESSAGE_CRC_LENGTH:
            raise EventStreamFormatError("event stream message length is out of range")
        if headers_length > total_length - PRELUDE_LENGTH - MESSAGE_CRC_LENGTH:
            raise EventStreamFormatError("event stream headers length is out of range")
        if len(buf) < total_length:
            return None
        frame = bytes(buf[:total_length])
        del buf[:total_length]
        (message_crc,) = struct.unpack_from(">I", frame, total_length - MESSAGE_CRC_LENGTH)
        if _crc32(frame[:-MESSAGE_CRC_LENGTH]) != message_crc:
            raise EventStreamFormatError("event stream message CRC mismatch")
        headers_end = PRELUDE_LENGTH + headers_length
        headers = _decode_headers(frame[PRELUDE_LENGTH:headers_end])
        payload = frame[headers_end:total_length - MESSAGE_CRC_LENGTH]
        return EventStreamMessage(headers=headers, payload=payload)

    @property
    def pending(self) -> int:
        """Bytes buffered that do not yet form a complete message."""
        return len(self._buffer)


def _read_some(fp, size: int) -> bytes:
    # ``read1`` returns whatever is available after at most one underlying
    # read, which keeps latency per event low. ``read(size)`` on an
    # http.client response blocks until ``size`` bytes have arrived, so it is
    # only the fallback for file-likes without ``read1``.
    reader = getattr(fp, "read1", None)
    if callable(reader):
        return reader(size)
    return fp.read(size)


def iter_event_stream(fp, chunk_size: int = 65536) -> Iterator[EventStreamMessage]:
    """Yield decoded messages from a binary file-like as bytes arrive.

    Stops at EOF. Trailing bytes that never complete a message raise
    ``EventStreamFormatError`` so a truncated response is not mistaken for
    a clean end of stream.
    """
    decoder = EventStreamDecoder()
    while True:
        chunk = _read_some(fp, chunk_size)
        if not chunk:
            break
        yield from decoder.feed(chunk)
    if decoder.pending:
        raise EventStreamFormatError("event stream ended inside a message")


def iter_events(fp, chunk_size: int = 65536):
    """Yield ``(event_type, payload)`` for each ``event`` message.

    ``payload`` is the decoded JSON object (or ``None`` when empty).
    ``exception`` and ``error`` messages raise ``EventStreamError`` carrying
    only the machine-readable type, never the body.
    """
    for message in iter_event_stream(fp, chunk_size=chunk_size):
        kind = message.message_type
        if kind == "event":
            try:
                payload = message.json()
            except (UnicodeDecodeError, ValueError) as exc:
                raise EventStreamFormatError("event stream payload is not JSON") from exc
            yield message.event_type, payload
        elif kind in ("exception", "error"):
            raise EventStreamError(message.exception_type)
        else:
            raise EventStreamFormatError("event stream message type is unsupported")

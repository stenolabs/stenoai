'use strict';

// The v1 contract is shared with StenoKit/StenoExchange. This deliberately
// supports its raw AA01 subset, not general-purpose archive extraction.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const MiB = 1024 * 1024;
const LIMITS = Object.freeze({
  files: 32, manifest: MiB, meeting: MiB, notes: 16 * MiB,
  transcript: 64 * MiB, audioMetadata: 64 * 1024, audio: 16 * 1024 * MiB,
  total: 24 * 1024 * MiB, archiveOverhead: 2 * MiB,
  reserve: 2_000_000_000, speakers: 10_000, turns: 200_000,
  words: 2_000_000, label: 1024,
});
const APPLE_EPOCH_SECONDS = 978307200;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_NONBLOCK || 0);

class TransferError extends Error {
  constructor(code = 'invalid_package') {
    const messages = {
      invalid_package: 'This meeting package is invalid or damaged.',
      unsupported_format: 'This meeting package uses an unsupported format.',
      package_too_large: 'This meeting package exceeds the supported size limit.',
      insufficient_space: 'There is not enough free space to import or export this meeting.',
      unsafe_file: 'The selected file is not a regular file.',
      source_changed: 'The selected file changed while it was being read.',
      unsupported_audio: 'This meeting package contains unsupported audio. Export uncompressed CAF audio and try again.',
      destination_exists: 'A file already exists at the selected destination.',
      transfer_io: 'The meeting package could not be read or written.',
    };
    super(messages[code] || messages.invalid_package);
    this.name = 'TransferError';
    this.code = code;
  }
}

function requireValue(condition, code) {
  if (!condition) throw new TransferError(code);
}
function object(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}
function string(value, maximum = LIMITS.transcript) {
  requireValue(typeof value === 'string');
  requireValue(Buffer.byteLength(value, 'utf8') <= maximum, 'package_too_large');
  // JSON can contain lone UTF-16 surrogates, which are not valid UTF-8 strings.
  requireValue(Buffer.from(value, 'utf8').toString('utf8') === value);
  return value;
}
function number(value) {
  requireValue(typeof value === 'number' && Number.isFinite(value));
  return value;
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= 0);
  requireValue(value <= maximum, 'package_too_large');
  return value;
}
function uuid(value) {
  requireValue(typeof value === 'string' && UUID.test(value));
  return value;
}
function date(value) {
  number(value);
  requireValue(Math.abs((value + APPLE_EPOCH_SECONDS) * 1000) <= 8.64e15);
  return value;
}
function choice(value, options) {
  requireValue(options.includes(value));
  return value;
}
function decodeJSON(data) {
  try {
    const text = utf8.decode(data);
    const decoded = object(JSON.parse(text));
    // JSON implementations disagree about repeated keys. Reject ambiguous
    // objects before comparing the Swift and JavaScript interpretations.
    const stack = [];
    for (let offset = 0; offset < text.length; offset++) {
      const character = text[offset];
      if (character === '"') {
        const start = offset++;
        for (; offset < text.length; offset++) {
          if (text[offset] === '\\') offset++;
          else if (text[offset] === '"') break;
        }
        const current = stack.at(-1);
        if (current?.expectKey) {
          const key = JSON.parse(text.slice(start, offset + 1));
          requireValue(!current.keys.has(key));
          current.keys.add(key);
          current.expectKey = false;
        }
      } else if (character === '{' || character === '[') {
        requireValue(stack.length < 128);
        stack.push(character === '{' ? { keys: new Set(), expectKey: true } : null);
      } else if (character === '}' || character === ']') stack.pop();
      else if (character === ',' && stack.at(-1)) stack.at(-1).expectKey = true;
    }
    return decoded;
  }
  catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError();
  }
}
function encodeJSON(value, maximum) {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  requireValue(data.length <= maximum, 'package_too_large');
  return data;
}
function digest(data) { return createHash('sha256').update(data).digest('hex'); }

function locale(identifier, origin) {
  choice(origin, ['explicit', 'estimated', 'absent']);
  if (identifier === null || identifier === undefined) {
    requireValue(origin === 'absent');
    return { localeOrigin: 'absent' };
  }
  string(identifier, LIMITS.label);
  requireValue(identifier.length > 0 && !/[\s\p{Cc}]/u.test(identifier) && origin !== 'absent');
  return { localeIdentifier: identifier, localeOrigin: origin };
}
function sameLocale(a, b) {
  return a.localeIdentifier === b.localeIdentifier && a.localeOrigin === b.localeOrigin;
}
function meetingDocument(value) {
  object(value);
  return {
    sourceMeetingID: uuid(value.sourceMeetingID),
    title: string(value.title, LIMITS.label),
    createdAt: date(value.createdAt),
    sourceStatus: choice(value.sourceStatus, ['draft', 'recording', 'interrupted', 'ready', 'processing']),
  };
}
function timed(value) {
  object(value);
  const start = number(value.start);
  const end = number(value.end);
  requireValue(start >= 0 && end >= start);
  return { start, end };
}
function transcriptDocument(value) {
  object(value);
  const sourceLocale = locale(value.localeIdentifier, value.localeOrigin);
  requireValue(Array.isArray(value.speakers) && Array.isArray(value.turns));
  requireValue(value.speakers.length <= LIMITS.speakers && value.turns.length <= LIMITS.turns, 'package_too_large');
  const ids = new Set();
  const speakers = value.speakers.map((speaker) => {
    object(speaker);
    const id = string(speaker.id, LIMITS.label);
    const label = string(speaker.label, LIMITS.label);
    requireValue(id.length > 0 && label.trim().length > 0 && !ids.has(id));
    ids.add(id);
    return { id, label, kind: choice(speaker.kind, ['generic', 'confirmedDisplayName']) };
  });
  let wordCount = 0;
  const turns = value.turns.map((turn) => {
    const range = timed(turn);
    requireValue(Array.isArray(turn.segments));
    const speakerID = turn.speakerID;
    requireValue(speakerID == null || (typeof speakerID === 'string' && ids.has(speakerID)));
    const segments = turn.segments.map((segment) => {
      const segmentRange = timed(segment);
      requireValue(Array.isArray(segment.words));
      wordCount += segment.words.length;
      requireValue(wordCount <= LIMITS.words, 'package_too_large');
      return {
        text: string(segment.text), ...segmentRange,
        words: segment.words.map((word) => ({ text: string(word.text), ...timed(word) })),
      };
    });
    return { ...(speakerID == null ? {} : { speakerID }), ...range, segments };
  });
  const result = { ...sourceLocale, speakers, turns };
  encodeJSON(result, LIMITS.transcript);
  return result;
}
function audioDocument(value) {
  object(value);
  const result = {
    logicalTrackID: string(value.logicalTrackID, LIMITS.label),
    kind: choice(value.kind, ['micTrack', 'systemTrack', 'imported']),
    byteCount: integer(value.byteCount, LIMITS.audio),
    sha256: string(value.sha256, 64),
    sampleRate: number(value.sampleRate),
    channelCount: integer(value.channelCount),
    duration: number(value.duration),
  };
  requireValue(result.logicalTrackID.length > 0 && result.byteCount > 0
    && HASH.test(result.sha256) && result.sampleRate > 0
    && result.channelCount > 0 && result.duration > 0);
  return result;
}
function entrySpec(name) {
  if (name === 'manifest.json') return ['application/json', LIMITS.manifest];
  if (name === 'meeting.json') return ['application/json', LIMITS.meeting];
  if (name === 'notes.md') return ['text/markdown', LIMITS.notes];
  if (name === 'transcript.json') return ['application/json', LIMITS.transcript];
  if (/^audio\/track-[1-9][0-9]*\.caf$/.test(name)) return ['audio/x-caf', LIMITS.audio];
  if (/^audio\/track-[1-9][0-9]*\.json$/.test(name)) return ['application/json', LIMITS.audioMetadata];
  throw new TransferError();
}

function contentDigest(entries) {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    for (const value of [entry.path, String(entry.byteCount), entry.sha256]) {
      const bytes = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(length).update(bytes);
    }
  }
  return hash.digest('hex');
}

function manifestDocument(value) {
  object(value);
  requireValue(value.formatMajor === 1, 'unsupported_format');
  integer(value.formatMinor);
  const sourceLocale = locale(value.localeIdentifier, value.localeOrigin);
  requireValue(Array.isArray(value.entries) && Array.isArray(value.capabilities));
  requireValue(value.entries.length + 1 <= LIMITS.files, 'package_too_large');
  const paths = new Set();
  let total = 0;
  const entries = value.entries.map((entry) => {
    object(entry);
    const name = string(entry.path, LIMITS.label);
    requireValue(name !== 'manifest.json' && !paths.has(name));
    paths.add(name);
    const [mediaType, maximum] = entrySpec(name);
    requireValue(entry.mediaType === mediaType);
    const byteCount = integer(entry.byteCount, maximum);
    requireValue(HASH.test(entry.sha256));
    total += byteCount;
    requireValue(total <= LIMITS.total, 'package_too_large');
    return { path: name, mediaType, byteCount, sha256: entry.sha256 };
  });
  requireValue(paths.has('meeting.json'));
  const tracks = entries.filter((entry) => entry.path.endsWith('.caf'));
  for (let i = 1; i <= tracks.length; i++) {
    requireValue(paths.has(`audio/track-${i}.caf`) && paths.has(`audio/track-${i}.json`));
  }
  requireValue(entries.filter((entry) => entry.path.startsWith('audio/')).length === tracks.length * 2);
  const capabilities = [...value.capabilities].sort();
  requireValue(new Set(capabilities).size === capabilities.length);
  capabilities.forEach((item) => choice(item, ['notes', 'transcript', 'audio']));
  const expected = [paths.has('notes.md') && 'notes', paths.has('transcript.json') && 'transcript', tracks.length > 0 && 'audio'].filter(Boolean).sort();
  requireValue(expected.length > 0 && JSON.stringify(capabilities) === JSON.stringify(expected));
  requireValue(HASH.test(value.contentDigest) && contentDigest(entries) === value.contentDigest);
  const result = {
    formatMajor: 1, formatMinor: value.formatMinor,
    sourceMeetingID: uuid(value.sourceMeetingID),
    ...(value.sourceRevisionID == null ? {} : { sourceRevisionID: uuid(value.sourceRevisionID) }),
    exportedAt: date(value.exportedAt),
    ...(value.sourceAppVersion == null ? {} : { sourceAppVersion: string(value.sourceAppVersion, LIMITS.label) }),
    capabilities, ...sourceLocale, entries, contentDigest: value.contentDigest,
  };
  encodeJSON(result, LIMITS.manifest);
  return result;
}

async function readExactly(handle, count, offset) {
  const buffer = Buffer.alloc(count);
  let done = 0;
  while (done < count) {
    const { bytesRead } = await handle.read(buffer, done, count - done, offset + done);
    requireValue(bytesRead > 0);
    done += bytesRead;
  }
  return buffer;
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function openRegular(filePath, maximum) {
  // The lstat check also covers platforms without O_NOFOLLOW. On Darwin and
  // Linux the subsequent open is the authority, not this pathname check.
  const before = await fsp.lstat(filePath, { bigint: true });
  requireValue(before.isFile(), 'unsafe_file');
  let handle;
  try {
    handle = await fsp.open(filePath, FLAGS);
    const status = await handle.stat({ bigint: true });
    requireValue(status.isFile() && sameFile(before, status), 'unsafe_file');
    requireValue(status.size <= BigInt(maximum), 'package_too_large');
    return { handle, status };
  } catch (error) {
    if (handle) await handle.close();
    throw error;
  }
}
async function ensureSpace(directory, required) {
  const stat = await fsp.statfs(directory, { bigint: true });
  requireValue(stat.bavail * stat.bsize >= BigInt(required) + BigInt(LIMITS.reserve), 'insufficient_space');
}
async function hashRegion(handle, offset, length, destination = null) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(MiB, length));
  let done = 0;
  while (done < length) {
    const wanted = Math.min(buffer.length, length - done);
    const { bytesRead } = await handle.read(buffer, 0, wanted, offset + done);
    requireValue(bytesRead > 0);
    hash.update(buffer.subarray(0, bytesRead));
    if (destination) {
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written);
        requireValue(result.bytesWritten > 0, 'transfer_io');
        written += result.bytesWritten;
      }
    }
    done += bytesRead;
  }
  return hash.digest('hex');
}

function decodeHeader(buffer) {
  requireValue(buffer.length >= 6 && buffer.toString('latin1', 0, 4) === 'AA01'
    && buffer.readUInt16LE(4) === buffer.length);
  let offset = 6;
  const fields = {};
  while (offset < buffer.length) {
    requireValue(offset + 4 <= buffer.length);
    const key = buffer.toString('latin1', offset, offset + 3);
    const type = String.fromCharCode(buffer[offset + 3]);
    offset += 4;
    requireValue(['TYP', 'PAT', 'SIZ', 'DAT'].includes(key) && !Object.hasOwn(fields, key));
    let value;
    if (key === 'PAT') {
      requireValue(type === 'P' && offset + 2 <= buffer.length);
      const size = buffer.readUInt16LE(offset);
      offset += 2;
      requireValue(offset + size <= buffer.length);
      try { value = utf8.decode(buffer.subarray(offset, offset + size)); }
      catch { throw new TransferError(); }
      offset += size;
    } else {
      const widths = key === 'DAT' ? { A: 2, B: 4, C: 8 } : { 1: 1, 2: 2, 4: 4, 8: 8 };
      const width = widths[type];
      requireValue(width && offset + width <= buffer.length);
      const raw = width === 8 ? buffer.readBigUInt64LE(offset) : BigInt(buffer.readUIntLE(offset, width));
      requireValue(raw <= BigInt(Number.MAX_SAFE_INTEGER), 'package_too_large');
      value = Number(raw);
      offset += width;
    }
    fields[key] = value;
  }
  requireValue(Object.keys(fields).length === 4 && fields.TYP === 0x46 && fields.SIZ === fields.DAT);
  const [, maximum] = entrySpec(fields.PAT);
  requireValue(fields.SIZ <= maximum, 'package_too_large');
  return { path: fields.PAT, size: fields.SIZ };
}
function encodeHeader(name, size) {
  const nameData = Buffer.from(name, 'utf8');
  const uint = (key, width, tag) => {
    const bytes = Buffer.alloc(4 + width);
    bytes.write(key + tag, 0, 'ascii');
    if (width === 8) bytes.writeBigUInt64LE(BigInt(size), 4);
    else bytes.writeUIntLE(size, 4, width);
    return bytes;
  };
  const width = size <= 255 ? 1 : size <= 65535 ? 2 : size <= 0xffffffff ? 4 : 8;
  const blobWidth = Math.max(2, width);
  const namePrefix = Buffer.alloc(6);
  namePrefix.write('PATP', 0, 'ascii');
  namePrefix.writeUInt16LE(nameData.length, 4);
  const fields = Buffer.concat([Buffer.from('TYP1F'), namePrefix, nameData,
    uint('SIZ', width, String(width)), uint('DAT', blobWidth, { 2: 'A', 4: 'B', 8: 'C' }[blobWidth])]);
  const prefix = Buffer.alloc(6);
  prefix.write('AA01', 0, 'ascii');
  prefix.writeUInt16LE(fields.length + 6, 4);
  return Buffer.concat([prefix, fields]);
}

async function inspectCAFHandle(handle, byteCount) {
  requireValue(byteCount >= 8, 'unsupported_audio');
  const header = await readExactly(handle, 8, 0);
  requireValue(header.equals(Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0])), 'unsupported_audio');
  let offset = 8;
  let description;
  let audioBytes;
  let chunks = 0;
  while (offset < byteCount) {
    requireValue(offset + 12 <= byteCount && ++chunks <= 1024, 'unsupported_audio');
    const chunk = await readExactly(handle, 12, offset);
    const type = chunk.toString('latin1', 0, 4);
    const declared = chunk.readBigInt64BE(4);
    offset += 12;
    requireValue(declared >= 0 || (type === 'data' && declared === -1n), 'unsupported_audio');
    const size = declared === -1n ? byteCount - offset : Number(declared);
    requireValue(Number.isSafeInteger(size) && size <= byteCount - offset, 'unsupported_audio');
    if (type === 'desc') {
      requireValue(!description && size === 32, 'unsupported_audio');
      const data = await readExactly(handle, 32, offset);
      const sampleRate = data.readDoubleBE(0);
      const format = data.toString('latin1', 8, 12);
      const flags = data.readUInt32BE(12);
      const bytesPerPacket = data.readUInt32BE(16);
      const framesPerPacket = data.readUInt32BE(20);
      const channelCount = data.readUInt32BE(24);
      const bits = data.readUInt32BE(28);
      requireValue(format === 'lpcm' && flags <= 3 && framesPerPacket === 1
        && Number.isFinite(sampleRate) && sampleRate > 0 && channelCount > 0
        && ((flags & 1) ? [32, 64].includes(bits) : [8, 16, 24, 32].includes(bits))
        && bytesPerPacket === channelCount * (bits / 8), 'unsupported_audio');
      description = { sampleRate, channelCount, bytesPerPacket };
    } else if (type === 'data') {
      requireValue(description && audioBytes === undefined && size > 4, 'unsupported_audio');
      audioBytes = size - 4; // First four bytes are the CAF edit counter.
    }
    offset += size;
  }
  requireValue(description && audioBytes > 0 && audioBytes % description.bytesPerPacket === 0, 'unsupported_audio');
  const duration = (audioBytes / description.bytesPerPacket) / description.sampleRate;
  requireValue(Number.isFinite(duration) && duration > 0, 'unsupported_audio');
  return { sampleRate: description.sampleRate, channelCount: description.channelCount, duration };
}
function checkAudioMetadata(metadata, actual) {
  const tolerance = Math.max(0.000001, actual.sampleRate * 0.000001);
  requireValue(metadata.byteCount === actual.byteCount && metadata.sha256 === actual.sha256
    && metadata.channelCount === actual.channelCount
    && Math.abs(metadata.sampleRate - actual.sampleRate) <= tolerance
    && Math.abs(metadata.duration - actual.duration) <= Math.max(0.001, 1 / actual.sampleRate));
}
async function inspectCAF(sourcePath) {
  let handle;
  try {
    const opened = await openRegular(sourcePath, LIMITS.audio);
    handle = opened.handle;
    const byteCount = Number(opened.status.size);
    const values = await inspectCAFHandle(handle, byteCount);
    const sha256 = await hashRegion(handle, 0, byteCount);
    requireValue(sameFile(opened.status, await handle.stat({ bigint: true })), 'source_changed');
    return { ...values, byteCount, sha256 };
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError('transfer_io');
  } finally { if (handle) await handle.close(); }
}

async function readPackage(filePath) {
  let handle;
  let temporary;
  try {
    const opened = await openRegular(filePath, LIMITS.total + LIMITS.archiveOverhead);
    handle = opened.handle;
    const fileSize = Number(opened.status.size);
    let offset = 0;
    let total = 0;
    const entries = new Map();
    let manifest;
    while (offset < fileSize) {
      requireValue(entries.size < LIMITS.files && offset + 6 <= fileSize);
      const prefix = await readExactly(handle, 6, offset);
      requireValue(prefix.toString('latin1', 0, 4) === 'AA01', 'unsupported_format');
      const headerSize = prefix.readUInt16LE(4);
      requireValue(headerSize >= 6 && offset + headerSize <= fileSize);
      const header = decodeHeader(await readExactly(handle, headerSize, offset));
      offset += headerSize;
      requireValue(!entries.has(header.path) && offset + header.size <= fileSize);
      total += header.size;
      requireValue(total <= LIMITS.total, 'package_too_large');
      if (!manifest) requireValue(header.path === 'manifest.json');
      else {
        const expected = manifest.entries.find((entry) => entry.path === header.path);
        requireValue(expected && expected.byteCount === header.size);
      }
      let entry;
      if (header.path.endsWith('.caf')) {
        if (!temporary) {
          temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'stenomeeting-'));
          await fsp.chmod(temporary, 0o700);
          await ensureSpace(temporary, manifest.entries.reduce((sum, item) => sum + item.byteCount, 0));
        }
        const sourcePath = path.join(temporary, path.basename(header.path));
        const output = await fsp.open(sourcePath, 'wx', 0o600);
        let sha256;
        try { sha256 = await hashRegion(handle, offset, header.size, output); await output.sync(); }
        finally { await output.close(); }
        entry = { sourcePath, sha256, byteCount: header.size };
      } else {
        const data = await readExactly(handle, header.size, offset);
        entry = { data, sha256: digest(data), byteCount: header.size };
      }
      entries.set(header.path, entry);
      if (header.path === 'manifest.json') {
        manifest = manifestDocument(decodeJSON(entry.data));
        requireValue(manifest.entries.reduce((sum, item) => sum + item.byteCount, entry.byteCount) <= LIMITS.total, 'package_too_large');
      } else {
        requireValue(entry.sha256 === manifest.entries.find((item) => item.path === header.path).sha256);
      }
      offset += header.size;
    }
    requireValue(manifest && entries.size === manifest.entries.length + 1);
    requireValue(sameFile(opened.status, await handle.stat({ bigint: true })), 'source_changed');
    const meeting = meetingDocument(decodeJSON(entries.get('meeting.json').data));
    requireValue(meeting.sourceMeetingID.toLowerCase() === manifest.sourceMeetingID.toLowerCase());
    const notes = entries.has('notes.md') ? utf8.decode(entries.get('notes.md').data) : null;
    const transcript = entries.has('transcript.json') ? transcriptDocument(decodeJSON(entries.get('transcript.json').data)) : null;
    if (transcript) requireValue(sameLocale(manifest, transcript));
    const audio = [];
    const logicalIDs = new Set();
    for (let i = 1; entries.has(`audio/track-${i}.caf`); i++) {
      const source = entries.get(`audio/track-${i}.caf`);
      const metadata = audioDocument(decodeJSON(entries.get(`audio/track-${i}.json`).data));
      requireValue(!logicalIDs.has(metadata.logicalTrackID));
      logicalIDs.add(metadata.logicalTrackID);
      checkAudioMetadata(metadata, await inspectCAF(source.sourcePath));
      audio.push({ metadata, sourcePath: source.sourcePath });
    }
    requireValue(audio.length === 0 || meeting.sourceStatus === 'ready');
    const ownedTemporary = temporary;
    const cleanup = async () => { if (ownedTemporary) await fsp.rm(ownedTemporary, { recursive: true, force: true }); };
    temporary = null;
    return { manifest, meeting, notes, transcript, audio, cleanup };
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError('invalid_package');
  } finally {
    if (handle) await handle.close();
    if (temporary) await fsp.rm(temporary, { recursive: true, force: true });
  }
}

async function writePackage(destinationPath, content) {
  const openedAudio = [];
  let output;
  let createdStatus;
  try {
    object(content);
    const meeting = meetingDocument(content.meeting);
    const transcript = content.transcript == null ? null : transcriptDocument(content.transcript);
    const notes = content.notes == null ? null : string(content.notes, LIMITS.notes);
    const audio = content.audio || [];
    requireValue(Array.isArray(audio) && audio.length * 2 + 4 <= LIMITS.files, 'package_too_large');
    requireValue(notes !== null || transcript !== null || audio.length > 0);
    requireValue(audio.length === 0 || meeting.sourceStatus === 'ready');
    let sourceLocale = transcript ? locale(transcript.localeIdentifier, transcript.localeOrigin) : locale(null, 'absent');
    if (content.sourceLocale) {
      const selected = locale(content.sourceLocale.localeIdentifier, content.sourceLocale.origin ?? content.sourceLocale.localeOrigin);
      if (transcript) requireValue(sameLocale(sourceLocale, selected));
      sourceLocale = selected;
    }
    const payload = [];
    const append = (name, data) => {
      const [mediaType, maximum] = entrySpec(name);
      requireValue(data.length <= maximum, 'package_too_large');
      payload.push({ path: name, mediaType, byteCount: data.length, sha256: digest(data), data });
    };
    append('meeting.json', encodeJSON(meeting, LIMITS.meeting));
    if (notes !== null) append('notes.md', Buffer.from(notes, 'utf8'));
    if (transcript !== null) append('transcript.json', encodeJSON(transcript, LIMITS.transcript));
    const logicalIDs = new Set();
    for (const [index, source] of audio.entries()) {
      object(source);
      const metadata = audioDocument(source.metadata);
      requireValue(!logicalIDs.has(metadata.logicalTrackID));
      logicalIDs.add(metadata.logicalTrackID);
      const opened = await openRegular(source.sourcePath, LIMITS.audio);
      openedAudio.push(opened);
      const byteCount = Number(opened.status.size);
      const values = await inspectCAFHandle(opened.handle, byteCount);
      const sha256 = await hashRegion(opened.handle, 0, byteCount);
      checkAudioMetadata(metadata, { ...values, byteCount, sha256 });
      const name = `audio/track-${index + 1}`;
      payload.push({ path: `${name}.caf`, mediaType: 'audio/x-caf', byteCount, sha256, handle: opened.handle, status: opened.status });
      append(`${name}.json`, encodeJSON(metadata, LIMITS.audioMetadata));
    }
    const entries = payload.map(({ path: name, byteCount, mediaType, sha256 }) => ({ path: name, byteCount, mediaType, sha256 }));
    const manifest = manifestDocument({
      formatMajor: 1, formatMinor: 0, sourceMeetingID: meeting.sourceMeetingID,
      sourceRevisionID: content.sourceRevisionID,
      exportedAt: Date.now() / 1000 - APPLE_EPOCH_SECONDS,
      sourceAppVersion: content.sourceAppVersion,
      capabilities: [notes !== null && 'notes', transcript !== null && 'transcript', audio.length > 0 && 'audio'].filter(Boolean),
      ...sourceLocale, entries, contentDigest: contentDigest(entries),
    });
    const manifestData = encodeJSON(manifest, LIMITS.manifest);
    const archiveEntries = [{ path: 'manifest.json', byteCount: manifestData.length, data: manifestData }, ...payload];
    const total = archiveEntries.reduce((sum, entry) => sum + entry.byteCount, 0);
    requireValue(total <= LIMITS.total, 'package_too_large');
    await ensureSpace(path.dirname(destinationPath), total + LIMITS.archiveOverhead);
    output = await fsp.open(destinationPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    createdStatus = await output.stat({ bigint: true });
    for (const entry of archiveEntries) {
      await output.writeFile(encodeHeader(entry.path, entry.byteCount));
      if (entry.data) await output.writeFile(entry.data);
      else {
        const writtenHash = await hashRegion(entry.handle, 0, entry.byteCount, output);
        requireValue(writtenHash === entry.sha256 && sameFile(entry.status, await entry.handle.stat({ bigint: true })), 'source_changed');
      }
    }
    await output.sync();
    await output.close();
    output = null;
    createdStatus = null;
    return { manifest };
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError(error.code === 'EEXIST' ? 'destination_exists' : 'transfer_io');
  } finally {
    if (output) await output.close();
    for (const opened of openedAudio) await opened.handle.close();
    if (createdStatus) {
      const current = await fsp.lstat(destinationPath, { bigint: true }).catch(() => null);
      // Never remove a replacement placed at the caller's destination.
      if (current && current.dev === createdStatus.dev && current.ino === createdStatus.ino) await fsp.unlink(destinationPath);
    }
  }
}

module.exports = {
  LIMITS, APPLE_EPOCH_SECONDS, TransferError, contentDigest,
  readPackage, writePackage, inspectCAF,
};

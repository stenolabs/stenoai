'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readPackage, writePackage, inspectCAF, contentDigest, LIMITS } = require('./meeting-transfer-codec');

const meeting = {
  sourceMeetingID: '00000000-0000-7000-8000-000000000031',
  title: 'Synthetic transfer', createdAt: 1000, sourceStatus: 'ready',
};
const transcript = {
  localeIdentifier: 'de-DE', localeOrigin: 'explicit',
  speakers: [{ id: 'speaker-1', label: 'Speaker 1', kind: 'generic' }],
  turns: [{ speakerID: 'speaker-1', start: 0, end: 1,
    segments: [{ text: 'Synthetic words.', start: 0, end: 1,
      words: [{ text: 'Synthetic', start: 0, end: 0.5 }] }] }],
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stenomeeting-codec-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function header(name, length, extra = Buffer.alloc(0)) {
  const string = Buffer.from(name);
  const pat = Buffer.alloc(6);
  pat.write('PATP'); pat.writeUInt16LE(string.length, 4);
  const siz = Buffer.alloc(12);
  siz.write('SIZ8'); siz.writeBigUInt64LE(BigInt(length), 4);
  const dat = Buffer.alloc(12);
  dat.write('DATC'); dat.writeBigUInt64LE(BigInt(length), 4);
  const body = Buffer.concat([Buffer.from('TYP1F'), pat, string, siz, dat, extra]);
  const prefix = Buffer.alloc(6);
  prefix.write('AA01'); prefix.writeUInt16LE(body.length + 6, 4);
  return Buffer.concat([prefix, body]);
}
function packageBytes(change = () => {}, archiveChange = (entries) => entries) {
  const payload = [
    { path: 'meeting.json', data: Buffer.from(JSON.stringify(meeting)), mediaType: 'application/json' },
    { path: 'notes.md', data: Buffer.from('Synthetic notes'), mediaType: 'text/markdown' },
    { path: 'transcript.json', data: Buffer.from(JSON.stringify(transcript)), mediaType: 'application/json' },
  ];
  const manifest = {
    formatMajor: 1, formatMinor: 0, sourceMeetingID: meeting.sourceMeetingID,
    exportedAt: 2000, capabilities: ['notes', 'transcript'],
    localeIdentifier: 'de-DE', localeOrigin: 'explicit',
    entries: payload.map(({ path: name, data, mediaType }) => ({ path: name, byteCount: data.length, mediaType, sha256: sha256(data) })),
  };
  manifest.contentDigest = contentDigest(manifest.entries);
  change(manifest, payload);
  const entries = archiveChange([{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...payload]);
  return Buffer.concat(entries.flatMap((entry) => [header(entry.path, entry.data.length, entry.extra), entry.data]));
}
async function rejectBytes(t, bytes, code = 'invalid_package') {
  const root = await workspace(t);
  const source = path.join(root, 'Hostile.stenomeeting');
  await fs.writeFile(source, bytes);
  await assert.rejects(readPackage(source), { code });
}
function caf({ float = false, channels = 1, frames = 80, sampleRate = 8000, flags } = {}) {
  const desc = Buffer.alloc(32);
  desc.writeDoubleBE(sampleRate, 0); desc.write('lpcm', 8);
  const bits = float ? 32 : 16;
  desc.writeUInt32BE(flags ?? (float ? 3 : 2), 12);
  desc.writeUInt32BE(channels * bits / 8, 16);
  desc.writeUInt32BE(1, 20); desc.writeUInt32BE(channels, 24); desc.writeUInt32BE(bits, 28);
  const chunk = (type, data) => {
    const start = Buffer.alloc(12); start.write(type); start.writeBigInt64BE(BigInt(data.length), 4);
    return Buffer.concat([start, data]);
  };
  return Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]), chunk('desc', desc), chunk('data', Buffer.alloc(4 + frames * channels * bits / 8))]);
}

test('text package preserves Unicode, locale and transcript with no audio by default', async (t) => {
  const root = await workspace(t);
  const target = path.join(root, 'Meeting.stenomeeting');
  const content = { meeting: { ...meeting, title: 'Planung 📋' }, notes: '# Plan\n\nBeschluss ä', transcript };
  const exported = await writePackage(target, content);
  const loaded = await readPackage(target);
  t.after(loaded.cleanup);
  assert.deepEqual(loaded.meeting, content.meeting);
  assert.equal(loaded.notes, content.notes);
  assert.deepEqual(loaded.transcript, transcript);
  assert.deepEqual(loaded.audio, []);
  assert.equal(loaded.manifest.contentDigest, exported.manifest.contentDigest);
  assert.equal(loaded.manifest.localeOrigin, 'explicit');
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

test('digest excludes export time and uses sorted, length-prefixed file facts', () => {
  const entries = [{ path: 'z', byteCount: 12, sha256: 'abc' }, { path: 'a', byteCount: 3, sha256: 'def' }];
  const pieces = ['a', '3', 'def', 'z', '12', 'abc'].flatMap((value) => {
    const bytes = Buffer.from(value); const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
    return [length, bytes];
  });
  assert.equal(contentDigest(entries), sha256(Buffer.concat(pieces)));
  assert.equal(contentDigest(entries), contentDigest(entries.reverse()));
});

test('independent raw AA01 fixture with 64-bit numeric fields is accepted', async (t) => {
  const root = await workspace(t);
  const source = path.join(root, 'Reference.stenomeeting');
  await fs.writeFile(source, packageBytes());
  const loaded = await readPackage(source); t.after(loaded.cleanup);
  assert.equal(loaded.notes, 'Synthetic notes');
});

test('real Swift writer fixture imports transcript, notes, locale and AVAudioFile CAF', async (t) => {
  const source = path.join(__dirname, '..', 'tests', 'fixtures', 'swift-meeting-v1.stenomeeting');
  assert.equal(sha256(await fs.readFile(source)), 'feda9e9286dc489762bcf13fc7d66b7b40a7a385bc0ef59fb63bcf093d5a5b91');
  const loaded = await readPackage(source); t.after(loaded.cleanup);
  assert.equal(loaded.meeting.title, 'Synthetic Swift transfer 📋');
  assert.equal(loaded.meeting.createdAt, 1000);
  assert.equal(loaded.notes, '# Synthetic notes\n\nBeschluss ä 📋');
  assert.equal(loaded.transcript.turns[0].segments[0].text, 'Synthetic interop text.');
  assert.equal(loaded.manifest.localeOrigin, 'explicit');
  assert.equal(loaded.audio.length, 1);
  assert.equal(loaded.audio[0].metadata.duration, 0.01);
  assert.equal(loaded.audio[0].metadata.sampleRate, 8000);
});

for (const phase of ['opening', 'reading']) for (const continuous of [false, true]) {
  test(`${continuous ? 'repeated source metadata changes stop after one full retry'
    : 'one source metadata change retries with closed handles and cleaned staging'} during ${phase}`,
  { skip: process.platform !== 'darwin' }, async (t) => {
    const root = await workspace(t);
    const source = path.join(root, 'Metadata.stenomeeting');
    const bytes = await fs.readFile(path.join(__dirname, '..', 'tests', 'fixtures', 'swift-meeting-v1.stenomeeting'));
    await fs.writeFile(source, bytes);
    const handles = [];
    const staging = [];
    const originalOpen = fs.open.bind(fs);
    const originalMkdtemp = fs.mkdtemp.bind(fs);
    t.mock.method(fs, 'mkdtemp', async (...args) => {
      const directory = await originalMkdtemp(...args);
      if (path.basename(args[0]) === 'stenomeeting-') staging.push(directory);
      return directory;
    });
    t.mock.method(fs, 'open', async (file, ...args) => {
      if (file === source && handles.length) {
        assert.equal(handles.at(-1).fd, -1, 'previous source handle must be closed');
        for (const directory of staging) await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
      }
      const handle = await originalOpen(file, ...args);
      if (file === source) {
        handles.push(handle);
        const changeMetadata = async () => {
          const before = await handle.stat({ bigint: true });
          execFileSync('/usr/bin/xattr', ['-w', 'org.steno.synthetic-transfer-test', String(handles.length), source]);
          const after = await handle.stat({ bigint: true });
          assert.equal(after.mtimeNs, before.mtimeNs);
          assert.notEqual(after.ctimeNs, before.ctimeNs);
        };
        if (phase === 'opening' && (continuous || handles.length === 1)) await changeMetadata();
        let firstRead = true;
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          if (phase === 'reading' && firstRead && (continuous || handles.length === 1)) {
            firstRead = false;
            await changeMetadata();
          }
          return result;
        };
      }
      return handle;
    });
    if (continuous) await assert.rejects(readPackage(source), { code: 'source_changed' });
    else {
      const loaded = await readPackage(source);
      assert.equal(loaded.notes, '# Synthetic notes\n\nBeschluss ä 📋');
      assert.equal(loaded.audio.length, 1);
      await loaded.cleanup();
    }
    assert.equal(handles.length, 2);
    assert.deepEqual(await fs.readFile(source), bytes);
    for (const directory of staging) await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  });
}

test('payload mutation during reading still fails integrity validation without retry', async (t) => {
  const root = await workspace(t);
  const source = path.join(root, 'Changing.stenomeeting');
  const bytes = packageBytes();
  await fs.writeFile(source, bytes);
  const originalOpen = fs.open.bind(fs);
  let opens = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (file === source) {
      opens += 1;
      let firstRead = true;
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (firstRead) {
          firstRead = false;
          const changed = Buffer.from(bytes);
          changed[changed.length - 1] ^= 1;
          await fs.writeFile(source, changed);
        }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(readPackage(source), { code: 'invalid_package' });
  assert.equal(opens, 1);
});

test('identical content has stable digest across repeated exports', async (t) => {
  const root = await workspace(t);
  const first = await writePackage(path.join(root, 'One.stenomeeting'), { meeting, notes: '' });
  const second = await writePackage(path.join(root, 'Two.stenomeeting'), { meeting, notes: '' });
  assert.equal(first.manifest.contentDigest, second.manifest.contentDigest);
});

test('existing destination is preserved exactly', async (t) => {
  const root = await workspace(t); const target = path.join(root, 'Existing.stenomeeting');
  await fs.writeFile(target, 'keep');
  await assert.rejects(writePackage(target, { meeting, notes: 'replacement' }), { code: 'destination_exists' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});

test('symlinks and directories are rejected without reading target content', { skip: process.platform === 'win32' }, async (t) => {
  const root = await workspace(t); const source = path.join(root, 'Source.stenomeeting');
  await fs.writeFile(source, packageBytes());
  const link = path.join(root, 'Link.stenomeeting'); await fs.symlink(source, link);
  await assert.rejects(readPackage(link), { code: 'unsafe_file' });
  await assert.rejects(readPackage(root), { code: 'unsafe_file' });
});

test('unsupported major format is explicit', async (t) => {
  await rejectBytes(t, packageBytes((manifest) => { manifest.formatMajor = 2; }), 'unsupported_format');
});
test('compressed archive magic is rejected', async (t) => {
  await rejectBytes(t, Buffer.from('pbzx1234567'), 'unsupported_format');
});
test('manifest must be first', async (t) => {
  await rejectBytes(t, packageBytes(() => {}, (entries) => entries.reverse()));
});
test('trailing garbage is rejected', async (t) => {
  await rejectBytes(t, Buffer.concat([packageBytes(), Buffer.from('trailer')]), 'unsupported_format');
});
test('truncated data is rejected', async (t) => {
  await rejectBytes(t, packageBytes().subarray(0, -1));
});
test('hash mismatch is rejected', async (t) => {
  const bytes = packageBytes(); bytes[bytes.length - 1] ^= 1;
  await rejectBytes(t, bytes);
});
test('content digest mismatch is rejected', async (t) => {
  await rejectBytes(t, packageBytes((manifest) => { manifest.contentDigest = '0'.repeat(64); }));
});
test('duplicate archive entries are rejected', async (t) => {
  await rejectBytes(t, packageBytes(() => {}, (entries) => [...entries, entries[1]]));
});
test('duplicate header fields are rejected', async (t) => {
  await rejectBytes(t, packageBytes(() => {}, (entries) => entries.map((entry, index) => index ? entry : { ...entry, extra: Buffer.from('TYP1F') })));
});
test('unknown header fields are rejected', async (t) => {
  await rejectBytes(t, packageBytes(() => {}, (entries) => entries.map((entry, index) => index ? entry : { ...entry, extra: Buffer.from('UID1\0', 'binary') })));
});
test('high-bit magic and field keys cannot alias ASCII tokens', async (t) => {
  const magic = packageBytes(); magic[0] |= 0x80;
  await rejectBytes(t, magic, 'unsupported_format');
  const field = packageBytes(); field[6] |= 0x80;
  await rejectBytes(t, field);
});
test('duplicate JSON keys are rejected before interpreting the manifest', async (t) => {
  await rejectBytes(t, packageBytes(() => {}, (entries) => entries.map((entry, index) => index ? entry : {
    ...entry, data: Buffer.from(entry.data.toString().replace('"formatMajor":1', '"formatMajor":2,"formatMajor":1')),
  })));
});
test('unsafe, case-changed and unknown archive paths are rejected', async (t) => {
  for (const name of ['../notes.md', '/notes.md', 'NOTES.md', 'audio/../notes.md', 'notes.md\0', 'audio\\track-1.caf', 'extra.json']) {
    await t.test(name, async (sub) => rejectBytes(sub, packageBytes(() => {}, (entries) => entries.map((entry, i) => i === 2 ? { ...entry, path: name } : entry))));
  }
});
test('header size and data size must match', async (t) => {
  const bytes = packageBytes(); const siz = bytes.indexOf(Buffer.from('SIZ8'));
  bytes.writeBigUInt64LE(1n, siz + 4);
  await rejectBytes(t, bytes);
});
test('declared excessive size is rejected before allocating payload', async (t) => {
  await rejectBytes(t, header('manifest.json', LIMITS.manifest + 1), 'package_too_large');
});
test('capabilities must match exact payload', async (t) => {
  await rejectBytes(t, packageBytes((manifest) => { manifest.capabilities.push('audio'); }));
});
test('manifest entry media types and byte counts are enforced', async (t) => {
  await rejectBytes(t, packageBytes((manifest) => {
    manifest.entries[1].mediaType = 'application/json'; manifest.contentDigest = contentDigest(manifest.entries);
  }));
});
test('source meeting identity must match manifest', async (t) => {
  await rejectBytes(t, packageBytes((manifest) => { manifest.sourceMeetingID = '00000000-0000-7000-8000-000000000032'; }));
});
test('estimated or absent locale is not upgraded during a round trip', async (t) => {
  const root = await workspace(t); const target = path.join(root, 'Estimated.stenomeeting');
  await writePackage(target, { meeting, notes: 'note', sourceLocale: { localeIdentifier: 'de-DE', origin: 'estimated' } });
  const loaded = await readPackage(target); t.after(loaded.cleanup);
  assert.equal(loaded.manifest.localeOrigin, 'estimated');
  assert.equal(loaded.transcript, null);
});
test('inconsistent or whitespace-containing locales are rejected', async (t) => {
  const root = await workspace(t); const target = path.join(root, 'Invalid.stenomeeting');
  await assert.rejects(writePackage(target, { meeting, transcript, sourceLocale: { localeIdentifier: 'en-US', origin: 'explicit' } }), { code: 'invalid_package' });
  await assert.rejects(writePackage(target, { meeting, notes: 'x', sourceLocale: { localeIdentifier: 'de DE', origin: 'explicit' } }), { code: 'invalid_package' });
});
test('invalid transcript time, speaker identity and excess labels are rejected', async (t) => {
  const root = await workspace(t);
  for (const mutate of [
    (value) => { value.turns[0].end = -1; },
    (value) => { value.turns[0].speakerID = 'missing'; },
    (value) => { value.speakers[0].label = ' '; },
  ]) {
    const invalid = structuredClone(transcript); mutate(invalid);
    await assert.rejects(writePackage(path.join(root, 'Invalid.stenomeeting'), { meeting, transcript: invalid }), { code: 'invalid_package' });
  }
});
test('audio is copied privately, checked and cleaned up after a round trip', async (t) => {
  const root = await workspace(t); const sourcePath = path.join(root, 'Source.caf');
  await fs.writeFile(sourcePath, caf({ float: true, channels: 2, frames: 300_000 }));
  const values = await inspectCAF(sourcePath);
  assert.deepEqual({ sampleRate: values.sampleRate, channelCount: values.channelCount, duration: values.duration }, { sampleRate: 8000, channelCount: 2, duration: 37.5 });
  const metadata = { logicalTrackID: 'source-track', kind: 'micTrack', ...values };
  const target = path.join(root, 'Audio.stenomeeting');
  await writePackage(target, { meeting, notes: 'Notes', audio: [{ sourcePath, metadata }] });
  const loaded = await readPackage(target); t.after(loaded.cleanup);
  assert.equal(loaded.audio.length, 1);
  assert.deepEqual(loaded.audio[0].metadata, metadata);
  const staged = loaded.audio[0].sourcePath;
  assert.notEqual(staged, sourcePath);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(staged)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(staged))).mode & 0o777, 0o700);
  }
  assert.deepEqual(await fs.readFile(staged), await fs.readFile(sourcePath));
  await loaded.cleanup();
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
  assert.equal((await fs.stat(sourcePath)).isFile(), true);
});
test('inconsistent audio metadata is rejected before publication', async (t) => {
  const root = await workspace(t); const sourcePath = path.join(root, 'Source.caf');
  await fs.writeFile(sourcePath, caf());
  const metadata = { logicalTrackID: 'track', kind: 'imported', ...await inspectCAF(sourcePath), duration: 999 };
  const target = path.join(root, 'Invalid.stenomeeting');
  await assert.rejects(writePackage(target, { meeting, audio: [{ sourcePath, metadata }] }), { code: 'invalid_package' });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});
test('empty, compressed and unknown-flag CAF audio is rejected explicitly', async (t) => {
  const root = await workspace(t);
  for (const [index, bytes] of [caf({ frames: 0 }), caf({ flags: 4 }), Buffer.from('RIFFwave')].entries()) {
    const source = path.join(root, `${index}.caf`); await fs.writeFile(source, bytes);
    await assert.rejects(inspectCAF(source), { code: 'unsupported_audio' });
  }
});
test('audio cannot be exported from an active recording', async (t) => {
  const root = await workspace(t);
  await assert.rejects(writePackage(path.join(root, 'Invalid.stenomeeting'), { meeting: { ...meeting, sourceStatus: 'recording' }, audio: [{}] }), { code: 'invalid_package' });
});

const aacFixture = path.join(__dirname, '..', 'tests', 'fixtures', 'swift-meeting-aac-v1.stenomeeting');
test('native Swift AAC package preserves valid frames and both tracks on re-export', async t => {
  const root = await workspace(t);
  const loaded = await readPackage(aacFixture);
  t.after(loaded.cleanup);
  assert.equal(loaded.audio.length, 2);
  assert.deepEqual(loaded.audio.map(a => a.metadata.channelCount), [1, 2]);
  for (const audio of loaded.audio) assert.equal(audio.metadata.duration, 480013 / 48000);
  const target = path.join(root, 'AAC.stenomeeting');
  await writePackage(target, loaded);
  const again = await readPackage(target);
  t.after(again.cleanup);
  assert.deepEqual(again.audio.map(a => a.metadata), loaded.audio.map(a => a.metadata));
});

function cafChunks(bytes) {
  const chunks = new Map();
  for (let offset = 8; offset < bytes.length;) {
    const size = Number(bytes.readBigInt64BE(offset + 4));
    chunks.set(bytes.toString('ascii', offset, offset + 4), { header: offset, start: offset + 12, size });
    offset += 12 + size;
  }
  return chunks;
}
test('AAC rejects corrupt cookies and contradictory or unbounded packet tables', async t => {
  const root = await workspace(t);
  const loaded = await readPackage(aacFixture);
  t.after(loaded.cleanup);
  const original = await fs.readFile(loaded.audio[0].sourcePath);
  const chunks = cafChunks(original);
  const pakt = chunks.get('pakt').start;
  const kuki = chunks.get('kuki').start;
  const desc = chunks.get('desc').start;
  const mutations = {
    'missing cookie': b => b.write('free', kuki - 12),
    'missing packet table': b => b.write('free', pakt - 12),
    'cookie descriptor overflow': b => b.fill(255, kuki + 1, kuki + 5),
    'wrong cookie profile': b => { b[kuki + 29] = 0x19; },
    'wrong cookie channels': b => { b[kuki + 30] ^= 24; },
    'description disagrees with cookie': b => b.writeDoubleBE(44100, desc),
    'negative priming': b => b.writeInt32BE(-1, pakt + 16),
    'incorrect remainder': b => b.writeInt32BE(0, pakt + 20),
    'huge count': b => b.writeBigInt64BE(9223372036854775807n, pakt),
    'negative valid frames': b => b.writeBigInt64BE(-1n, pakt + 8),
    'zero packet': b => { b[pakt + 24] = 0; },
    'endless packet varint': b => b.fill(255, pakt + 24, pakt + 28),
    'wrong packet bytes': b => { b[pakt + 24]++; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const bytes = Buffer.from(original);
      mutate(bytes);
      const target = path.join(root, 'bad.caf');
      await fs.writeFile(target, bytes);
      await assert.rejects(inspectCAF(target), { code: 'unsupported_audio' });
    });
  }
  for (const type of ['desc', 'kuki', 'pakt', 'data']) {
    await t.test(`duplicate ${type}`, async () => {
      const chunk = chunks.get(type);
      const target = path.join(root, 'duplicate.caf');
      await fs.writeFile(target, Buffer.concat([original, original.subarray(chunk.header, chunk.start + chunk.size)]));
      await assert.rejects(inspectCAF(target), { code: 'unsupported_audio' });
    });
  }
});

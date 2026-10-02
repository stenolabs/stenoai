'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IDENTITY_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
function sameFileIdentity(expected, actual) {
  return !!expected && !!actual && IDENTITY_FIELDS.every(key =>
    typeof expected[key] === 'bigint' && expected[key] === actual[key]);
}
function sameAudioSource(expected, actual) {
  return !!expected && !!actual && expected.sourcePath === actual.sourcePath
    && sameFileIdentity(expected.identity, actual.identity);
}

async function findAudioSource(summaryFile, baseDirs, extensions) {
  const base = path.dirname(path.dirname(summaryFile));
  const allowed = await Promise.all(baseDirs.map(dir => fs.realpath(dir).catch(() => null)));
  if (!allowed.includes(base) || path.dirname(summaryFile) !== path.join(base, 'output')) throw { code: 'unsafe_storage' };
  const dir = path.join(base, 'recordings');
  let before;
  try { before = await fs.lstat(dir); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(dir) !== dir) throw { code: 'unsafe_storage' };
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const after = await fs.lstat(dir);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw { code: 'source_changed' };
  const stem = path.basename(summaryFile).replace(/_summary\.(md|json)$/, '');
  const matches = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink()
    && path.parse(entry.name).name === stem && extensions.includes(path.extname(entry.name).slice(1).toLowerCase()));
  if (matches.length !== 1) return null;
  const sourcePath = path.join(dir, matches[0].name);
  let status;
  try { status = await fs.lstat(sourcePath, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') throw { code: 'source_changed' }; throw error; }
  if (!status.isFile()) throw { code: 'source_changed' };
  return { sourcePath, identity: Object.fromEntries(IDENTITY_FIELDS.map(key => [key, status[key]])) };
}

function runAudioConverter(binary, args, { spawnProcess = spawn, timeoutMs = 120000, graceMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnProcess(binary, args, { stdio: 'ignore' });
    let failed = false;
    let escalation;
    const timeout = setTimeout(() => {
      failed = true;
      proc.kill('SIGTERM');
      escalation = setTimeout(() => proc.kill('SIGKILL'), graceMs);
    }, timeoutMs);
    // Even spawn errors are followed by close. Never release the scratch
    // directory until the process and its stdio have actually closed.
    proc.once('error', () => { failed = true; });
    proc.once('close', code => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      if (failed) reject({ code: 'transfer_failed' });
      else if (code !== 0) reject({ code: 'unsupported_audio' });
      else resolve();
    });
  });
}
module.exports = { findAudioSource, runAudioConverter, sameAudioSource, sameFileIdentity };

const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const MAX_AUDIO_BYTES = 16 * 1024 * 1024 * 1024;

async function hashAudioHandle(handle, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  for (let position = 0; position < size;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (!bytesRead) throw { code: 'source_changed' };
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function runNativeAudioConverter(binary, inputFD, outputFD, {
  spawnProcess = spawn, timeoutMs = 120000, graceMs = 1000, outputLimit = 65536,
} = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnProcess(binary, ['--input-fd', '3', '--output-fd', '4'], {
        shell: false, stdio: ['ignore', 'pipe', 'pipe', inputFD, outputFD],
      });
    } catch { reject({ code: 'unsupported_audio' }); return; }
    let failed = false;
    let escalation;
    let stdout = Buffer.alloc(0);
    let received = 0;
    const stop = () => {
      if (failed) return;
      failed = true;
      proc.kill('SIGTERM');
      escalation = setTimeout(() => proc.kill('SIGKILL'), graceMs);
    };
    const timeout = setTimeout(stop, timeoutMs);
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.on('data', bytes => {
        received += bytes.length;
        if (received > outputLimit) { stop(); return; }
        if (!failed && stream === proc.stdout) stdout = Buffer.concat([stdout, bytes]);
      });
      stream.on('error', stop);
    }
    proc.once('error', () => { failed = true; });
    // close, not exit: inherited descriptors and output streams must be released
    // before the caller closes its FDs or removes the private scratch directory.
    proc.once('close', code => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      if (failed) { reject({ code: 'transfer_failed' }); return; }
      if (code !== 0) { reject({ code: 'unsupported_audio' }); return; }
      try { resolve(JSON.parse(stdout.toString('utf8'))); }
      catch { reject({ code: 'transfer_failed' }); }
    });
  });
}

async function encodeNativeAudio(input, target, binary, { run = runNativeAudioConverter } = {}) {
  const source = await fs.open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_AUDIO_BYTES)) throw { code: 'unsupported_audio' };
    const sourceHash = await hashAudioHandle(source, Number(before.size));
    output = await fs.open(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const created = await output.stat({ bigint: true });
    const result = await run(binary, source.fd, output.fd);
    if (!sameFileIdentity(before, await source.stat({ bigint: true }))
      || sourceHash !== await hashAudioHandle(source, Number(before.size))
      || !sameFileIdentity(before, await source.stat({ bigint: true }))) throw { code: 'source_changed' };
    const written = await output.stat({ bigint: true });
    const named = await fs.lstat(target, { bigint: true });
    if (written.dev !== created.dev || written.ino !== created.ino || !sameFileIdentity(written, named)) throw { code: 'source_changed' };
    const metadata = await require('./meeting-transfer-codec').inspectCAF(target, { includeFormat: true });
    const valid = result && typeof result === 'object' && !Array.isArray(result)
      && ((result.codec === 'aac' && result.operation === 'encoded-aac' && metadata.format === 'aac '
        && Number.isInteger(result.bitRate) && result.bitRate > 0 && result.bitRate <= 0xffffffff)
        || (result.codec === 'opus' && result.operation === 'repackaged-opus' && metadata.format === 'opus' && result.bitRate === undefined))
      && result.sourceSHA256 === sourceHash && result.outputSHA256 === metadata.sha256
      && result.byteCount === metadata.byteCount && result.sampleRate === metadata.sampleRate
      && result.channelCount === metadata.channelCount
      && Number.isSafeInteger(result.frameCount) && result.frameCount > 0
      && result.frameCount === Math.round(metadata.duration * metadata.sampleRate);
    if (!valid) throw { code: 'transfer_failed' };
    if (!sameFileIdentity(written, await output.stat({ bigint: true }))
      || !sameFileIdentity(written, await fs.lstat(target, { bigint: true }))) throw { code: 'source_changed' };
    const { format: _format, ...audioMetadata } = metadata;
    return audioMetadata;
  } finally {
    if (output) await output.close();
    await source.close();
  }
}

async function waveChannelCount(input) {
  const handle = await fs.open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = Number((await handle.stat()).size);
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return 0;
    const chunk = Buffer.alloc(8);
    for (let offset = 12, count = 0; offset + 8 <= size && count < 1024; count++) {
      if ((await handle.read(chunk, 0, 8, offset)).bytesRead !== 8) return 0;
      const length = chunk.readUInt32LE(4);
      if (length > size - offset - 8) return 0;
      if (chunk.toString('ascii', 0, 4) === 'fmt ' && length >= 16) {
        const fmt = Buffer.alloc(4);
        if ((await handle.read(fmt, 0, 4, offset + 8)).bytesRead !== 4) return 0;
        return fmt.readUInt16LE(2);
      }
      offset += 8 + length + (length & 1);
    }
    return 0;
  } finally { await handle.close(); }
}

// Input is already an exclusively created, identity-checked private copy.
async function convertTransferAudio(input, target, {
  nativeHelper, ffmpeg, platform = process.platform, arch = process.arch,
} = {}) {
  const extension = path.extname(input).toLowerCase();
  const native = platform === 'darwin' && arch === 'arm64';
  const { inspectCAF } = require('./meeting-transfer-codec');
  let pcm = input;
  let original;
  if (extension === '.caf') {
    original = await inspectCAF(input, { includeFormat: true });
    if (!native || original.format !== 'lpcm' || original.channelCount > 2 || original.byteCount <= 32768) {
      await fs.copyFile(input, target, constants.COPYFILE_EXCL);
      return inspectCAF(target);
    }
  }
  if (native && !nativeHelper) throw { code: 'unsupported_audio' };
  const multichannelWave = native && extension === '.wav' && await waveChannelCount(input) > 2;
  if (!native || multichannelWave || !['.wav', '.caf', '.webm'].includes(extension)) {
    if (!ffmpeg) throw { code: 'unsupported_audio' };
    pcm = native ? path.join(path.dirname(target), 'normalized.caf') : target;
    await runAudioConverter(ffmpeg, ['-nostdin', '-v', 'error', '-n', '-i', input, '-vn', '-c:a', 'pcm_f32le', '-f', 'caf', pcm]);
    if (!native) return inspectCAF(target);
    const normalized = await inspectCAF(pcm);
    if (normalized.channelCount > 2) {
      await fs.copyFile(pcm, target, constants.COPYFILE_EXCL);
      return inspectCAF(target);
    }
  }
  const metadata = await encodeNativeAudio(pcm, target, nativeHelper);
  if (original && metadata.byteCount >= original.byteCount) {
    await fs.unlink(target);
    await fs.copyFile(input, target, constants.COPYFILE_EXCL);
    return inspectCAF(target);
  }
  return metadata;
}
module.exports.runNativeAudioConverter = runNativeAudioConverter;
module.exports.encodeNativeAudio = encodeNativeAudio;
module.exports.convertTransferAudio = convertTransferAudio;

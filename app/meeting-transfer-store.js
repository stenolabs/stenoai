'use strict';

// Library mapping is separate from the untrusted archive decoder. The only
// publication point is the exclusive link of a complete summary document.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectCAF, LIMITS, TransferError } = require('./meeting-transfer-codec');
const STORE_DOCUMENT_LIMIT = 100 * 1024 * 1024;
const EPOCH = Date.UTC(2001, 0, 1) / 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class StoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function privateDirectory(parent, name) {
  const root = path.join(parent, name);
  await fs.mkdir(root, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new StoreError('unsafe_storage');
  }
  await fs.chmod(root, 0o700);
  return fs.realpath(root);
}

async function readJSON(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > STORE_DOCUMENT_LIMIT) throw new StoreError('unsafe_storage');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

function transcriptText(snapshot) {
  if (!snapshot) return '';
  const labels = new Map(snapshot.speakers.map(speaker => [speaker.id, speaker.label]));
  return snapshot.turns.map(turn => {
    const text = turn.segments.map(segment => segment.text).join(' ');
    const label = turn.speakerID ? labels.get(turn.speakerID) : null;
    return label ? `${label}: ${text}` : text;
  }).join('\n');
}

async function existingImport(summaryFile, sourceID, digest) {
  let existing;
  try { existing = await readJSON(summaryFile); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const receipt = existing.steno_transfer;
  if (!receipt || receipt.sourceMeetingID.toLowerCase() !== sourceID.toLowerCase()
    || receipt.contentDigest !== digest) throw new StoreError('transfer_conflict');
  return { summaryFile, duplicate: true };
}

function transcriptFingerprint(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function importIntoLibrary(pkg, outputDir, { documentLimit = STORE_DOCUMENT_LIMIT } = {}) {
  // A caller may impose a smaller bound (including in tests), never relax the
  // document limit shared with the application's summary reader.
  if (!Number.isSafeInteger(documentLimit) || documentLimit < 1 || documentLimit > STORE_DOCUMENT_LIMIT) {
    throw new TransferError('package_too_large');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const output = await fs.realpath(outputDir);
  const sourceID = pkg.manifest.sourceMeetingID;
  if (!UUID.test(sourceID)) throw new StoreError('invalid_package');
  const summaryFile = path.join(output, `transfer_${sourceID.toLowerCase()}_summary.json`);
  const duplicate = await existingImport(summaryFile, sourceID, pkg.manifest.contentDigest);
  if (duplicate) return duplicate;
  const root = await privateDirectory(output, '.meeting-transfer');
  let owned = await fs.mkdtemp(path.join(root, 'import-'));
  const mediaName = `transfer_${sourceID.toLowerCase()}`;
  let published = false;
  try {
    const audio = pkg.audio.map((track, index) => ({ name: `track-${index + 1}.caf`, metadata: track.metadata }));
    const text = transcriptText(pkg.transcript);
    const duration = (pkg.transcript?.turns ?? []).reduce((max, turn) => Math.max(max, turn.end),
      pkg.audio.reduce((max, a) => Math.max(max, a.metadata.duration), 0));
    const date = new Date((pkg.meeting.createdAt + EPOCH) * 1000).toISOString();
    const meeting = {
      session_info: {
        name: pkg.meeting.title, summary_file: summaryFile, processed_at: date,
        duration_seconds: duration, notes_generated: false,
      },
      summary: '', transcript: text, user_notes: pkg.notes ?? '',
      participants: [], discussion_areas: [], key_points: [], action_items: [], folders: [],
      steno_transfer: {
        sourceMeetingID: sourceID, contentDigest: pkg.manifest.contentDigest,
        sourceRevisionID: pkg.manifest.sourceRevisionID ?? null,
        sourceAppVersion: pkg.manifest.sourceAppVersion ?? null,
        sourceLocale: pkg.manifest.localeOrigin === 'absent' ? null : {
          localeIdentifier: pkg.manifest.localeIdentifier, origin: pkg.manifest.localeOrigin,
        },
        meeting: pkg.meeting, transcript: pkg.transcript,
        importedTranscriptSHA256: transcriptFingerprint(text), importedAt: new Date().toISOString(),
        mediaDirectory: audio.length ? mediaName : null, audio,
      },
    };
    const serialized = JSON.stringify(meeting);
    const documentBytes = Buffer.byteLength(serialized, 'utf8');
    if (documentBytes > documentLimit) throw new TransferError('package_too_large');
    const requiredBytes = pkg.audio.reduce((sum, track) => {
      if (!Number.isSafeInteger(track.metadata.byteCount) || track.metadata.byteCount < 0) {
        throw new StoreError('invalid_package');
      }
      return sum + BigInt(track.metadata.byteCount);
    }, BigInt(documentBytes) + BigInt(LIMITS.reserve));
    // The decoded package may live on another volume. Check the actual library
    // destination before copying any audio into it.
    const capacity = await fs.statfs(owned, { bigint: true });
    if (capacity.bavail * capacity.bsize < requiredBytes) throw new TransferError('insufficient_space');
    for (const [index, track] of pkg.audio.entries()) {
      const target = path.join(owned, audio[index].name);
      await fs.copyFile(track.sourcePath, target, constants.COPYFILE_EXCL);
      await fs.chmod(target, 0o600);
      // Validate the actual bytes retained in the library, not a former path.
      const actual = await inspectCAF(target);
      if (actual.sha256 !== track.metadata.sha256 || actual.byteCount !== track.metadata.byteCount) {
        throw new StoreError('invalid_package');
      }
    }
    if (audio.length) {
      const mediaDestination = path.join(root, mediaName);
      // A pending deletion or an interrupted earlier import must never be
      // replaced implicitly. Leave its retained media for explicit recovery.
      try { await fs.lstat(mediaDestination); throw new StoreError('transfer_conflict'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(owned, mediaDestination);
      owned = mediaDestination;
    }
    const staged = path.join(owned, 'meeting.json');
    const handle = await fs.open(staged, 'wx', 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    try {
      await fs.link(staged, summaryFile);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return await existingImport(summaryFile, sourceID, pkg.manifest.contentDigest);
    }
    published = true;
    await fs.unlink(staged).catch(() => {});
    if (!audio.length) await fs.rmdir(owned).catch(() => {});
    return { summaryFile, duplicate: false };
  } finally {
    if (!published) await fs.rm(owned, { recursive: true, force: true });
  }
}

function visibleNotes(meeting) {
  const parts = [];
  if (meeting.summary?.trim()) parts.push(`## Summary\n\n${meeting.summary.trim()}`);
  if (meeting.key_points?.length) parts.push(`## Key Points\n\n${meeting.key_points.map(p => `- ${p}`).join('\n')}`);
  if (meeting.action_items?.length) parts.push(`## Action Items\n\n${meeting.action_items.map(p => `- ${typeof p === 'string' ? p : JSON.stringify(p)}`).join('\n')}`);
  if (meeting.discussion_areas?.length) parts.push(`## Discussion\n\n${meeting.discussion_areas.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join('\n\n')}`);
  if (meeting.user_notes?.trim()) parts.push(parts.length ? `## My notes\n\n${meeting.user_notes}` : meeting.user_notes);
  return parts.join('\n\n') || null;
}

async function exportSourceID(summaryFile, userDataDir, receipt) {
  if (receipt && UUID.test(receipt.sourceMeetingID)) return receipt.sourceMeetingID;
  const root = await privateDirectory(userDataDir, 'meeting-transfer');
  const key = crypto.createHash('sha256').update(summaryFile).digest('hex');
  const file = path.join(root, `${key}.json`);
  try {
    const existing = await readJSON(file);
    if (!UUID.test(existing.sourceMeetingID)) throw new StoreError('unsafe_storage');
    return existing.sourceMeetingID;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const id = crypto.randomUUID().toUpperCase();
  try { await fs.writeFile(file, JSON.stringify({ sourceMeetingID: id }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readJSON(file);
    if (!UUID.test(existing.sourceMeetingID)) throw new StoreError('unsafe_storage');
    return existing.sourceMeetingID;
  }
  return id;
}

async function importedAudioSources(meeting, summaryFile) {
  const receipt = meeting.steno_transfer;
  if (!receipt?.audio?.length) return [];
  const expectedMedia = path.basename(summaryFile).replace(/_summary\.json$/, '');
  if (!/^transfer_[0-9a-f-]{36}$/.test(expectedMedia) || receipt.mediaDirectory !== expectedMedia) throw new StoreError('unsafe_storage');
  const root = path.join(await fs.realpath(path.dirname(summaryFile)), '.meeting-transfer');
  if (!(await fs.lstat(root)).isDirectory() || await fs.realpath(root) !== root) throw new StoreError('unsafe_storage');
  const folder = path.join(root, receipt.mediaDirectory);
  if (await fs.realpath(folder) !== folder || !(await fs.lstat(folder)).isDirectory()) throw new StoreError('unsafe_storage');
  return Promise.all(receipt.audio.map(async (track, index) => {
    if (track.name !== `track-${index + 1}.caf`) throw new StoreError('unsafe_storage');
    const sourcePath = path.join(folder, track.name);
    const actual = await inspectCAF(sourcePath);
    if (actual.sha256 !== track.metadata.sha256) throw new StoreError('invalid_package');
    return { metadata: track.metadata, sourcePath };
  }));
}

async function makeExportContent(meeting, summaryFile, userDataDir, audio = [], sourceAppVersion) {
  const receipt = meeting.steno_transfer;
  const sourceMeetingID = await exportSourceID(summaryFile, userDataDir, receipt);
  const notes = visibleNotes(meeting);
  const text = meeting.transcript ?? '';
  let transcript = null;
  let sourceLocale = receipt?.sourceLocale ?? null;
  if (text.trim()) {
    const unchanged = receipt?.importedTranscriptSHA256
      ? receipt.importedTranscriptSHA256 === transcriptFingerprint(text)
      : receipt?.importedTranscriptText === text;
    if (receipt?.transcript && unchanged) transcript = receipt.transcript;
    else {
      // Legacy text has no reliable word timing or confirmed speaker identity.
      // Preserve its exact text without inventing either.
      sourceLocale = null;
      const duration = Number.isFinite(meeting.session_info.duration_seconds) ? Math.max(0, meeting.session_info.duration_seconds) : 0;
      transcript = { localeOrigin: 'absent', speakers: [], turns: [
        { start: 0, end: duration, segments: [{ text, start: 0, end: duration, words: [] }] },
      ] };
    }
  }
  if (!notes && !transcript && !audio.length) throw new StoreError('empty_package');
  const parsedDate = Date.parse(meeting.session_info.processed_at);
  const createdAt = Number.isFinite(parsedDate) ? parsedDate / 1000 - EPOCH : Date.now() / 1000 - EPOCH;
  return {
    meeting: { sourceMeetingID, title: meeting.session_info.name ?? 'Meeting', createdAt, sourceStatus: 'ready' },
    notes, transcript, audio, sourceLocale,
    sourceAppVersion,
  };
}

module.exports = { importIntoLibrary, makeExportContent, importedAudioSources, privateDirectory, transcriptText, StoreError, STORE_DOCUMENT_LIMIT };

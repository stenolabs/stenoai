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

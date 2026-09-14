const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomicSync } = require('./atomic-write');

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
  const file = path.join(dir, 'note.md');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('writeFileAtomicSync replaces the file contents', () => {
  const file = tmpFile('old');
  writeFileAtomicSync(file, 'new');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
});

test('writeFileAtomicSync creates a file that does not exist yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
  const file = path.join(dir, 'fresh.md');
  writeFileAtomicSync(file, 'hello');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hello');
});

test('a failed write leaves the original intact and removes the temp file', (t) => {
  const file = tmpFile('original');
  const dir = path.dirname(file);
  const before = fs.readdirSync(dir);

  // Force the failure AFTER the temp file has genuinely been written to disk,
  // by making the rename step itself throw. This is the real window the
  // atomic-write guarantee protects: the temp file exists, the rename fails,
  // and the catch block's cleanup must remove it without touching the
  // original. Using node:test's built-in mock keeps this dependency-free and
  // restores fs.renameSync automatically once the test ends.
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('boom');
  });

  assert.throws(() => {
    writeFileAtomicSync(file, 'new');
  });

  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before.sort());
});

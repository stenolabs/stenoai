'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyUserData } = require('./legacy-user-data');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'steno-legacy-'));
}

test('copies v0.8.0 chat sessions into the renamed userData dir', () => {
  const appData = tmp();
  fs.mkdirSync(path.join(appData, 'StenoAI'));
  fs.writeFileSync(path.join(appData, 'StenoAI', 'chat_sessions_v2.json'), '{"v":2}');
  const userData = path.join(appData, 'Steno');
  const copied = migrateLegacyUserData({ fs, path, appDataDir: appData, userDataDir: userData });
  assert.deepEqual(copied, ['chat_sessions_v2.json']);
  assert.equal(fs.readFileSync(path.join(userData, 'chat_sessions_v2.json'), 'utf8'), '{"v":2}');
});

test('never overwrites sessions already in the current userData dir', () => {
  const appData = tmp();
  fs.mkdirSync(path.join(appData, 'StenoAI'));
  fs.mkdirSync(path.join(appData, 'Steno'));
  fs.writeFileSync(path.join(appData, 'StenoAI', 'chat_sessions_v2.json'), 'old');
  fs.writeFileSync(path.join(appData, 'Steno', 'chat_sessions_v2.json'), 'current');
  const copied = migrateLegacyUserData({ fs, path, appDataDir: appData, userDataDir: path.join(appData, 'Steno') });
  assert.deepEqual(copied, []);
  assert.equal(fs.readFileSync(path.join(appData, 'Steno', 'chat_sessions_v2.json'), 'utf8'), 'current');
});

test('is a no-op when there is no legacy dir or it is the current dir', () => {
  const appData = tmp();
  assert.deepEqual(migrateLegacyUserData({ fs, path, appDataDir: appData, userDataDir: path.join(appData, 'Steno') }), []);
  assert.deepEqual(migrateLegacyUserData({ fs, path, appDataDir: appData, userDataDir: path.join(appData, 'stenoai') }), []);
});

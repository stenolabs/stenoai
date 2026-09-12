'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('if (process.env.STENOAI_USER_DATA_DIR)');
const end = source.indexOf('const IS_E2E =', start);
assert.ok(start >= 0 && end > start, 'userData initialization must be present');
const initialization = source.slice(start, end);

function userDataPath(isPackaged, override, paths, appData) {
  let result = paths.join(appData, 'stenoai');
  let name = 'stenoai';
  vm.runInNewContext(initialization, {
    path: paths,
    process: { env: { STENOAI_USER_DATA_DIR: override } },
    app: {
      isPackaged,
      getPath(key) {
  function userDataPath(isPackaged, override, paths, appData) {
    let result;
    let name = 'stenoai';
    vm.runInNewContext(initialization, {
      path: paths,
      process: { env: { STENOAI_USER_DATA_DIR: override } },
      app: {
        isPackaged,
        getPath(key) {
          assert.equal(key, 'userData');
          return result === undefined ? paths.join(appData, name) : result;
        },
        setPath(key, value) {
          assert.equal(key, 'userData');
          result = value;
        },
        setName(value) {
          name = value;
        },
      },
    });
    assert.equal(name, isPackaged ? 'StenoAI' : 'stenoai');
    return result;
  }
      setPath(key, value) {
        assert.equal(key, 'userData');
        result = value;
      },
      setName(value) {
        name = value;
      },
    },
  });
  assert.equal(name, isPackaged ? 'StenoAI' : 'stenoai');
  return result;
}

test('renamed packages retain Electron data on macOS, Windows, and Linux', () => {
  for (const [paths, root] of [
    [path.posix, '/users/test/Library/Application Support'],
    [path.win32, 'C:\\Users\\test\\AppData\\Roaming'],
    [path.posix, '/home/test/.config'],
  ]) {
    assert.equal(userDataPath(true, undefined, paths, root), paths.join(root, 'stenoai'));
  }
});

test('explicit isolation overrides the legacy packaged data path', () => {
  for (const packaged of [true, false]) {
    assert.equal(userDataPath(packaged, '/isolated', path.posix, '/unused'), '/isolated');
  }
});

test('development runs retain their existing default data directory', () => {
  assert.equal(userDataPath(false, undefined, path.posix, '/unused'), '/unused/stenoai');
});

test('installed app and shortcuts use StenoAI while update identity stays stable', () => {
  const { build } = require('./package.json');
  assert.equal(build.productName, 'StenoAI');
  assert.equal(build.nsis.shortcutName, 'StenoAI');
  assert.equal(build.appId, 'com.stenoai.recorder');
  assert.deepEqual(build.protocols[0].schemes, ['stenoai']);
});

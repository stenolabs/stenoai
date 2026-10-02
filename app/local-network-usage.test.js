'use strict';

// #499: macOS 15+ blocks outbound connections to local-network addresses
// unless the app declares NSLocalNetworkUsageDescription in its Info.plist.
// Without it, pointing the Ollama server URL (or any other user-supplied host
// setting) at a LAN address fails with a generic connection error.
//
// The key has to be in BOTH configs: electron-builder.ci.yml is a standalone
// config, not an override on top of package.json (see #438), so a key added
// only to package.json never reaches a CI-built Info.plist.
//
// A Playwright e2e spec cannot cover this — it drives a dev-mode Electron
// process, not a packaged bundle — so this test guards the configs instead.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'NSLocalNetworkUsageDescription';

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
);
const ciYml = fs.readFileSync(
  path.join(__dirname, 'electron-builder.ci.yml'),
  'utf8'
);

// Minimal reader for `mac: > extendInfo: > <key>: "<value>"` in the CI yml.
// Deliberately dependency-free: js-yaml is only a transitive dependency here.
function readCiExtendInfo(key) {
  const lines = ciYml.split('\n');
  const macAt = lines.findIndex((l) => l === 'mac:');
  assert.notStrictEqual(macAt, -1, 'electron-builder.ci.yml has no mac: block');

  let inExtendInfo = false;
  for (const line of lines.slice(macAt + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    // Any non-indented line ends the mac: block.
    if (!/^\s/.test(line)) break;
    if (/^ {2}extendInfo:\s*$/.test(line)) {
      inExtendInfo = true;
      continue;
    }
    if (inExtendInfo && !/^ {4}/.test(line)) inExtendInfo = false;
    if (!inExtendInfo) continue;
    const m = line.match(/^ {4}([A-Za-z0-9_]+):\s*"(.*)"\s*$/);
    if (m && m[1] === key) {
      // This reader does not decode YAML escapes, so a value containing one
      // would be compared wrongly. Fail loudly instead of silently.
      assert.ok(
        !m[2].includes('\\'),
        `${key} contains a YAML escape; this reader cannot decode it`
      );
      return m[2];
    }
  }
  return undefined;
}

test('package.json declares NSLocalNetworkUsageDescription for macOS', () => {
  const extendInfo = pkg.build.mac.extendInfo;
  assert.ok(extendInfo, 'build.mac.extendInfo is missing');
  assert.strictEqual(typeof extendInfo[KEY], 'string');
  assert.ok(extendInfo[KEY].length > 0, `${KEY} must not be empty`);
});

test('electron-builder.ci.yml declares it too (it does not inherit, see #438)', () => {
  const value = readCiExtendInfo(KEY);
  assert.ok(value, `${KEY} missing from the mac.extendInfo block of the CI config`);
});

test('both configs use the same wording', () => {
  assert.strictEqual(readCiExtendInfo(KEY), pkg.build.mac.extendInfo[KEY]);
});

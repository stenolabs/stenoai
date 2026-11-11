'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { compareVersions } = require('./version-compare');

test('equal versions compare as 0', () => {
  assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
});

test('older current returns -1, newer current returns 1', () => {
  assert.strictEqual(compareVersions('1.2.3', '1.2.4'), -1);
  assert.strictEqual(compareVersions('1.2.4', '1.2.3'), 1);
  assert.strictEqual(compareVersions('0.9.0', '1.0.0'), -1);
  assert.strictEqual(compareVersions('2.0.0', '1.9.9'), 1);
});

test('parts compare numerically, not lexically', () => {
  assert.strictEqual(compareVersions('1.10.0', '1.9.0'), 1);
  assert.strictEqual(compareVersions('1.9.0', '1.10.0'), -1);
});

test('missing trailing parts count as 0', () => {
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
  assert.strictEqual(compareVersions('1.2.0', '1.2'), 0);
  assert.strictEqual(compareVersions('1.2', '1.2.1'), -1);
  assert.strictEqual(compareVersions('1.2.1', '1.2'), 1);
  assert.strictEqual(compareVersions('1', '1.0.0.1'), -1);
});

test('non-numeric parts become NaN and are treated as 0 (pre-release suffix is not ordered)', () => {
  // '3-beta' -> NaN -> 0, so a pre-release patch compares as .0
  assert.strictEqual(compareVersions('1.2.3-beta', '1.2.0'), 0);
  assert.strictEqual(compareVersions('1.2.3-beta', '1.2.3'), -1);
  assert.strictEqual(compareVersions('1.2.3', '1.2.3-beta'), 1);
  assert.strictEqual(compareVersions('1.2.3-beta', '1.2.1'), -1);
  assert.strictEqual(compareVersions('1.x.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('abc', '0'), 0);
});

test('a leading v is a NaN first part, treated as 0', () => {
  assert.strictEqual(compareVersions('v1.2.3', '1.2.3'), -1);
  assert.strictEqual(compareVersions('v1.2.3', 'v1.2.3'), 0);
});

test('empty string parses to 0', () => {
  assert.strictEqual(compareVersions('', '0'), 0);
  assert.strictEqual(compareVersions('', '0.0.1'), -1);
});

test('non-string input throws', () => {
  assert.throws(() => compareVersions(undefined, '1.0.0'), TypeError);
});

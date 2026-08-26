'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { mayExposeMainWindow } = require('./e2e-window-visibility');

test('normal application windows may be shown', () => {
  assert.strictEqual(mayExposeMainWindow({ isE2EHeadless: false }), true);
});

test('headless E2E windows may never be shown or focused', () => {
  assert.strictEqual(mayExposeMainWindow({ isE2EHeadless: true }), false);
});

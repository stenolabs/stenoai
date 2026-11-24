'use strict';

// The e2e seams in main.js are gated on ALLOW_E2E_PATH_SEAMS (IS_E2E and not
// packaged), never on IS_E2E alone, so a stray STENOAI_E2E_* variable in a
// packaged build cannot change behaviour. Checked at the source level because
// main.js needs a running Electron to load.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('the local-command confirmation seam is gated on ALLOW_E2E_PATH_SEAMS', () => {
  const start = source.indexOf('async function confirmLocalCommand(');
  assert.ok(start > 0, 'confirmLocalCommand is defined in main.js');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /ALLOW_E2E_PATH_SEAMS && process\.env\.STENOAI_E2E_CONFIRM_LOCAL_COMMAND === '1'/);
  assert.doesNotMatch(body, /IS_E2E && process\.env\.STENOAI_E2E_CONFIRM_LOCAL_COMMAND/);
});

test('ALLOW_E2E_PATH_SEAMS itself requires an unpackaged app', () => {
  assert.match(source, /const ALLOW_E2E_PATH_SEAMS = IS_E2E && !app\.isPackaged;/);
});

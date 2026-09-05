const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createOptionsForFile,
  isAppleLMHelper,
} = require('./sign-macos');

test('recognizes the nested Apple LM helper bundle and executable', () => {
  assert.equal(
    isAppleLMHelper('/tmp/Steno.app/Contents/Helpers/Steno Apple LM.app'),
    true,
  );
  assert.equal(
    isAppleLMHelper(
      '/tmp/Steno.app/Contents/Helpers/Steno Apple LM.app/Contents/MacOS/steno-apple-lm',
    ),
    true,
  );
  assert.equal(isAppleLMHelper('/tmp/Steno.app/Contents/MacOS/Steno'), false);
});

test('uses dedicated sandbox entitlements only for the Apple LM helper', () => {
  const original = () => ({
    entitlements: '/tmp/parent-entitlements.plist',
    hardenedRuntime: true,
  });
  const optionsForFile = createOptionsForFile(original);

  const helper = optionsForFile(
    '/tmp/Steno.app/Contents/Helpers/Steno Apple LM.app',
  );
  const parent = optionsForFile('/tmp/Steno.app');

  assert.match(helper.entitlements, /entitlements\.apple-lm\.plist$/);
  assert.equal(parent.entitlements, '/tmp/parent-entitlements.plist');
});

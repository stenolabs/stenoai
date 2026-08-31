const { test } = require('node:test');
const assert = require('node:assert/strict');

const { notificationsEnabledFromDisk } = require('./notification-settings');

test('reads the notification preference synchronously from config', () => {
  const reads = [];
  const enabled = notificationsEnabledFromDisk('/tmp/config.json', {
    existsSync: (file) => file === '/tmp/config.json',
    readFileSync: (file, encoding) => {
      reads.push([file, encoding]);
      return JSON.stringify({ notifications_enabled: false });
    },
  });

  assert.strictEqual(enabled, false);
  assert.deepStrictEqual(reads, [['/tmp/config.json', 'utf-8']]);
});

test('keeps notifications enabled when the config is absent or unreadable', () => {
  assert.strictEqual(
    notificationsEnabledFromDisk('/tmp/config.json', { existsSync: () => false }),
    true,
  );
  assert.strictEqual(
    notificationsEnabledFromDisk('/tmp/config.json', {
      existsSync: () => true,
      readFileSync: () => { throw new Error('locked'); },
    }),
    true,
  );
});

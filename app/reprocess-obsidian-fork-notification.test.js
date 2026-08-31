const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  reserveReprocessObsidianForkNotification,
} = require('./reprocess-obsidian-fork-notification');

const summaryFile = '/tmp/output/meeting_summary.md';
const fork = {
  status: 'forked',
  vaultRelPath: 'Meetings/meeting (conflict).md',
};

test('a summarized fork reserves one main-side toast and strips the renderer payload', async () => {
  const shown = [];

  const result = await reserveReprocessObsidianForkNotification({
    obsidianFork: fork,
    summaryFile,
    summarizationCompleted: true,
    showObsidianForkNotification: (payload) => {
      shown.push(payload);
      return Promise.resolve({ success: true, shown: true });
    },
  });

  assert.strictEqual(result.forkReserved, true);
  assert.strictEqual(result.mainObsidianForkNotificationShown, true);
  assert.strictEqual(result.obsidianSync, undefined);
  assert.deepStrictEqual(shown, [{ ...fork, summaryFile }]);
});

test('a transcript-only fork leaves the renderer payload and does not reserve a main toast', async () => {
  let shown = 0;

  const result = await reserveReprocessObsidianForkNotification({
    obsidianFork: fork,
    summaryFile,
    summarizationCompleted: false,
    showObsidianForkNotification: () => { shown += 1; },
  });

  assert.strictEqual(result.forkReserved, false);
  assert.strictEqual(result.mainObsidianForkNotificationShown, false);
  assert.strictEqual(result.obsidianSync, fork);
  assert.strictEqual(shown, 0);
});

test('a summarized fork waits for main toast scheduling before stripping the renderer payload', async () => {
  let finishScheduling;
  const scheduling = new Promise((resolve) => { finishScheduling = resolve; });

  const result = reserveReprocessObsidianForkNotification({
    obsidianFork: fork,
    summaryFile,
    summarizationCompleted: true,
    showObsidianForkNotification: () => scheduling,
  });

  assert.strictEqual(typeof result.then, 'function');
  finishScheduling({ success: true, shown: true });
  assert.deepStrictEqual(await result, {
    forkReserved: true,
    mainObsidianForkNotificationShown: true,
    obsidianSync: undefined,
  });
});

test('a main notification error leaves the fork for the renderer fallback', async () => {
  const errors = [];

  const result = await reserveReprocessObsidianForkNotification({
    obsidianFork: fork,
    summaryFile,
    summarizationCompleted: true,
    showObsidianForkNotification: () => { throw new Error('notification unavailable'); },
    onNotificationError: (error) => errors.push(error.message),
  });

  assert.deepStrictEqual(result, {
    forkReserved: false,
    mainObsidianForkNotificationShown: false,
    obsidianSync: fork,
  });
  assert.deepStrictEqual(errors, ['notification unavailable']);
});

test('reprocess carries main fork-toast ownership through processing-complete', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('reprocess-meeting'");
  const end = source.indexOf("ipcMain.handle('recording-available'", start);
  const handler = source.slice(start, end);
  const reservation = handler.indexOf('await reserveReprocessObsidianForkNotification');
  const completion = handler.indexOf("webContents.send('processing-complete'");

  assert.ok(reservation >= 0, 'reprocess must await the main-side fork toast');
  assert.ok(completion > reservation, 'completion must be dispatched after the fork toast is scheduled');
  assert.match(
    handler,
    /const \{\s*mainObsidianForkNotificationShown,\s*obsidianSync: completionObsidianSync,?\s*\}/,
    'reprocess must retain the durable main notification result',
  );
  assert.strictEqual(
    (handler.match(/mainObsidianForkNotificationShown,/g) || []).length,
    3,
    'both successful processing-complete payloads must carry the main notification result',
  );
  const notificationStart = source.indexOf('function showObsidianForkNotification');
  const notificationEnd = source.indexOf("ipcMain.handle('show-obsidian-fork-notification'", notificationStart);
  const notification = source.slice(notificationStart, notificationEnd);
  assert.match(
    notification,
    /notificationsEnabledFromDisk\(path\.join\(getUserDataDir\(\), 'config\.json'\)\)/,
    'the completion path must use the bounded local settings snapshot',
  );
  assert.doesNotMatch(
    notification,
    /await notificationsEnabled\(/,
    'the completion path must not wait indefinitely for get-notifications',
  );
});

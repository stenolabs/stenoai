'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerNotificationIpc } = require('./notification-ipc');

function harness({ currentWindow, senderWindow, senderDestroyed = false, windowDestroyed = false } = {}) {
  let handler;
  const sent = [];
  const sender = {
    isDestroyed: () => senderDestroyed,
    send: (...args) => sent.push(args),
  };
  const window = senderWindow || {
    isDestroyed: () => windowDestroyed,
    _activeCustomNotification: { payload: { title: 'Private meeting title' } },
  };
  registerNotificationIpc({
    ipcMain: { on: (channel, fn) => {
      assert.strictEqual(channel, 'notification-renderer-ready');
      handler = fn;
    } },
    BrowserWindow: { fromWebContents: (webContents) => {
      assert.strictEqual(webContents, sender);
      return window;
    } },
    getNotificationWindow: () => currentWindow === undefined ? window : currentWindow,
  });
  return { handler, sender, sent, window };
}

test('notification renderer ready returns the active sender window payload exactly once', () => {
  const h = harness();

  h.handler({ sender: h.sender });

  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0][0], 'show-notification');
  assert.strictEqual(h.sent[0][1], h.window._activeCustomNotification.payload);
});

test('notification renderer ready ignores destroyed, superseded, and foreign senders', () => {
  const destroyedSender = harness({ senderDestroyed: true });
  destroyedSender.handler({ sender: destroyedSender.sender });
  assert.deepStrictEqual(destroyedSender.sent, []);

  const destroyedWindow = harness({ windowDestroyed: true });
  destroyedWindow.handler({ sender: destroyedWindow.sender });
  assert.deepStrictEqual(destroyedWindow.sent, []);

  const staleWindow = { isDestroyed: () => false, _activeCustomNotification: { payload: { title: 'old' } } };
  const currentWindow = { isDestroyed: () => false, _activeCustomNotification: { payload: { title: 'current' } } };
  const superseded = harness({ senderWindow: staleWindow, currentWindow });
  superseded.handler({ sender: superseded.sender });
  assert.deepStrictEqual(superseded.sent, []);
});

test('notification renderer ready ignores a current window without an active notification', () => {
  const h = harness();
  h.window._activeCustomNotification = undefined;

  h.handler({ sender: h.sender });

  assert.deepStrictEqual(h.sent, []);
});

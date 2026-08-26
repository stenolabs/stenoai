'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerPersonSampleIpc } = require('./person-sample-ipc');

function harness(runPythonScript) {
  const handlers = {};
  registerPersonSampleIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers[channel] = handler;
      },
    },
    runPythonScript,
  });
  return handlers;
}

test('person sample IPC forwards only the person id and returns parsed audio', async () => {
  const calls = [];
  const handlers = harness(async (script, args) => {
    calls.push({ script, args });
    return '{"success":true,"audio_base64":"UklGRg=="}';
  });

  const result = await handlers['get-person-sample-audio']({}, 'person-1');

  assert.deepStrictEqual(calls, [{
    script: 'simple_recorder.py',
    args: ['get-person-sample-audio', 'person-1'],
  }]);
  assert.deepStrictEqual(result, { success: true, audio_base64: 'UklGRg==' });
});

test('person sample IPC replaces backend crashes and malformed output with a fixed error', async () => {
  for (const runPythonScript of [
    async () => { throw new Error('/private/user/path\nTraceback: private detail'); },
    async () => 'not json',
  ]) {
    const handlers = harness(runPythonScript);

    const result = await handlers['get-person-sample-audio']({}, 'person-1');

    assert.deepStrictEqual(result, {
      success: false,
      error: 'voice sample unavailable',
    });
  }
});

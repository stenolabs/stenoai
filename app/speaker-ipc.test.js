'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  validateMeetingStem,
  parseSpeakerMutation,
  registerSpeakerIpc,
} = require('./speaker-ipc');

test('validateMeetingStem accepts one basename and rejects traversal or separators', () => {
  assert.strictEqual(validateMeetingStem('2026-08-10_team-call'), '2026-08-10_team-call');
  for (const value of ['', '.', '..', '../meeting', 'folder/meeting', 'folder\\meeting', 42, null]) {
    assert.throws(() => validateMeetingStem(value), { name: 'TypeError' }, String(value));
  }
});

test('parseSpeakerMutation rejects invalid channels, ids, booleans, and stale-run omissions', () => {
  const valid = {
    meetingStem: 'meeting',
    channel: 'mic',
    diarizationSpeakerId: 'SPEAKER_0',
    expectedRunId: 'run-1',
    containsMultipleSpeakers: true,
  };
  assert.deepStrictEqual(parseSpeakerMutation(valid), valid);
  for (const patch of [
    { channel: 'left' },
    { diarizationSpeakerId: '../SPEAKER_0' },
    { expectedRunId: '' },
    { expectedRunId: 'run\u0000one' },
    { expectedRunId: '--relabel-transcript' },
    { expectedRunId: 'x'.repeat(129) },
    { personId: 'person\u001fone' },
    { personId: '..' },
    { personId: '-person' },
    { containsMultipleSpeakers: 'true' },
  ]) {
    assert.throws(() => parseSpeakerMutation({ ...valid, ...patch }), { name: 'TypeError' });
  }
});

test('parseSpeakerMutation canonicalizes safe names and rejects control characters', () => {
  const valid = {
    meetingStem: 'meeting',
    channel: 'mic',
    diarizationSpeakerId: 'SPEAKER_0',
    expectedRunId: 'run-1',
  };
  assert.strictEqual(
    parseSpeakerMutation({ ...valid, newPersonName: '  Person\nAlpha  ' }).newPersonName,
    'Person Alpha',
  );
  assert.strictEqual(
    parseSpeakerMutation({ ...valid, newPersonName: 'Ｐｅｒｓｏｎ' }).newPersonName,
    'Person',
  );
  assert.throws(
    () => parseSpeakerMutation({ ...valid, newPersonName: 'Person\u0000Alpha' }),
    { name: 'TypeError' },
  );
});

test('registerSpeakerIpc rejects traversal before invoking the backend', async () => {
  const handlers = {};
  const calls = [];
  registerSpeakerIpc({
    ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; } },
    runPythonScript: async (_script, args) => {
      calls.push(args);
      return '{"success":true}';
    },
    parsePythonFailureJson: (error) => ({ success: false, error: error.message }),
  });

  const result = await handlers['speaker-naming-status']({}, '../private');
  assert.deepStrictEqual(result, { success: false, error: 'Invalid meeting identifier.' });
  assert.deepStrictEqual(calls, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpeakerModelStatusOutput } = require('./speaker-model-status');

const VALID = {
  success: true,
  ready: false,
  cache_directory: '/tmp/isolated/models/speaker-diarization',
  required_models: ['sortformer/a.mlmodelc'],
  missing_models: ['sortformer/a.mlmodelc'],
};

test('parses the final valid model status after unrelated output', () => {
  const output = `loader chatter\n${JSON.stringify(VALID)}\n`;
  assert.deepEqual(parseSpeakerModelStatusOutput(output), VALID);
});

test('rejects malformed or internally inconsistent status payloads', () => {
  assert.throws(() => parseSpeakerModelStatusOutput('{}'), /valid JSON status/);
  assert.throws(
    () => parseSpeakerModelStatusOutput(JSON.stringify({ ...VALID, ready: true })),
    /inconsistent/,
  );
  assert.throws(
    () => parseSpeakerModelStatusOutput(JSON.stringify({ ...VALID, cache_directory: 42 })),
    /valid JSON status/,
  );
});

test('accepts a structured unavailable result without cache fields', () => {
  const unavailable = {
    success: false,
    ready: false,
    error: 'Speaker diarization is unavailable on this system',
  };
  assert.deepEqual(parseSpeakerModelStatusOutput(JSON.stringify(unavailable)), unavailable);
});

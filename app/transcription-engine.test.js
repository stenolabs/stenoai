const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appleSpeechSupported,
  defaultTranscriptionEngine,
  normalizeTranscriptionEngine,
  isLiveTranscriptionEngine,
} = require('./transcription-engine');

test('Apple SpeechTranscriber requires macOS 26 / Darwin 25', () => {
  assert.equal(appleSpeechSupported('darwin', '25.0.0'), true);
  assert.equal(appleSpeechSupported('darwin', '24.6.0'), false);
  assert.equal(appleSpeechSupported('win32', '25.0.0'), false);
});

test('fresh supported Macs default to Apple without changing other platforms', () => {
  assert.equal(defaultTranscriptionEngine('darwin', '25.0.0'), 'apple');
  assert.equal(defaultTranscriptionEngine('darwin', '24.6.0'), 'parakeet');
  assert.equal(defaultTranscriptionEngine('win32', '10.0.0'), 'parakeet');
});

test('Apple copied to an unsupported host falls back without hiding explicit engines', () => {
  assert.equal(normalizeTranscriptionEngine('apple', 'darwin', '24.6.0'), 'parakeet');
  assert.equal(normalizeTranscriptionEngine('apple', 'darwin', '25.0.0'), 'apple');
  assert.equal(normalizeTranscriptionEngine('whisper', 'win32', '10.0.0'), 'whisper');
  assert.equal(normalizeTranscriptionEngine('parakeet', 'darwin', '25.0.0'), 'parakeet');
});

test('Apple and Parakeet are live; Whisper remains post-stop only', () => {
  assert.equal(isLiveTranscriptionEngine('apple'), true);
  assert.equal(isLiveTranscriptionEngine('parakeet'), true);
  assert.equal(isLiveTranscriptionEngine('whisper'), false);
});

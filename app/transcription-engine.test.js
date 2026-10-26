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

test('fresh installs keep Parakeet as the default on every platform', () => {
  assert.equal(defaultTranscriptionEngine('darwin', '25.0.0'), 'parakeet');
  assert.equal(defaultTranscriptionEngine('darwin', '24.6.0'), 'parakeet');
  assert.equal(defaultTranscriptionEngine('win32', '10.0.0'), 'parakeet');
});

test('Apple copied to an unsupported host falls back without hiding explicit engines', () => {
  assert.equal(normalizeTranscriptionEngine('apple', 'darwin', '24.6.0'), 'parakeet');
  assert.equal(normalizeTranscriptionEngine('apple', 'darwin', '25.0.0'), 'apple');
  assert.equal(normalizeTranscriptionEngine('whisper', 'win32', '10.0.0'), 'whisper');
  assert.equal(normalizeTranscriptionEngine('openai-asr', 'darwin', '25.0.0'), 'openai-asr');
  assert.equal(normalizeTranscriptionEngine('parakeet', 'darwin', '25.0.0'), 'parakeet');
});

test('Apple and Parakeet are live; Whisper and cloud ASR are post-stop only', () => {
  assert.equal(isLiveTranscriptionEngine('apple'), true);
  assert.equal(isLiveTranscriptionEngine('parakeet'), true);
  assert.equal(isLiveTranscriptionEngine('whisper'), false);
  assert.equal(isLiveTranscriptionEngine('openai-asr'), false);
});

test('Apple readiness needs a successful supported installed asset', () => {
  const { appleSpeechReady } = require('./transcription-engine');
  assert.equal(appleSpeechReady({ success: true, available: true, supported: true, installed: true }), true);
  for (const field of ['success', 'available', 'supported', 'installed']) {
    const status = { success: true, available: true, supported: true, installed: true, [field]: false };
    assert.equal(appleSpeechReady(status), false, field);
  }
});

const os = require('os');

function appleSpeechSupported(
  platform = process.platform,
  release = os.release(),
) {
  if (platform !== 'darwin') return false;
  const darwinMajor = Number.parseInt(String(release).split('.')[0], 10);
  return Number.isFinite(darwinMajor) && darwinMajor >= 25;
}

function defaultTranscriptionEngine() {
  return 'parakeet';
}

function normalizeTranscriptionEngine(value, platform, release) {
  if (value === 'apple' && appleSpeechSupported(platform, release)) return 'apple';
  if (value === 'whisper') return 'whisper';
  if (value === 'openai-asr') return 'openai-asr';
  return 'parakeet';
}

function isLiveTranscriptionEngine(engine) {
  return engine === 'apple' || engine === 'parakeet';
}

function appleSpeechReady(status) {
  return status?.success === true && status.available === true
    && status.supported === true && status.installed === true;
}

module.exports = {
  appleSpeechSupported,
  defaultTranscriptionEngine,
  normalizeTranscriptionEngine,
  isLiveTranscriptionEngine,
  appleSpeechReady,
};

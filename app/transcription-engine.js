const os = require('os');

function appleSpeechSupported(
  platform = process.platform,
  release = os.release(),
) {
  if (platform !== 'darwin') return false;
  const darwinMajor = Number.parseInt(String(release).split('.')[0], 10);
  return Number.isFinite(darwinMajor) && darwinMajor >= 25;
}

function defaultTranscriptionEngine(platform, release) {
  return appleSpeechSupported(platform, release) ? 'apple' : 'parakeet';
}

function normalizeTranscriptionEngine(value, platform, release) {
  if (value === 'apple' && appleSpeechSupported(platform, release)) return 'apple';
  if (value === 'whisper') return 'whisper';
  return 'parakeet';
}

function isLiveTranscriptionEngine(engine) {
  return engine === 'apple' || engine === 'parakeet';
}

module.exports = {
  appleSpeechSupported,
  defaultTranscriptionEngine,
  normalizeTranscriptionEngine,
  isLiveTranscriptionEngine,
};

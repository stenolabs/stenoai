'use strict';

const { parseSpeakerModelStatusOutput } = require('./speaker-model-status');

const PROGRESS_PREFIX = 'SPEAKER_MODELS_PROGRESS:';
const FAILED = { success: false, ready: false, error: 'Speaker diarization model setup failed' };

function isProgress(value) {
  return Boolean(value) && typeof value === 'object'
    && Number.isInteger(value.percent) && value.percent >= 0 && value.percent <= 100
    && ['listing', 'downloading', 'compiling'].includes(value.phase);
}

/**
 * Runs `prepare-speaker-models` and relays its SPEAKER_MODELS_PROGRESS lines
 * through `onProgress` ({ percent, phase }). Only one download runs at a time:
 * a second call while one is in flight (onboarding and Settings both offer the
 * download) shares the same promise instead of racing two writers into the
 * same model cache.
 */
function createSpeakerModelPreparer({
  spawn, getBackendPath, getBackendCwd, makeLineReader, onProgress, onLog = () => {}, platform,
}) {
  let inFlight = null;

  function run() {
    if (platform !== 'darwin') {
      return Promise.resolve({
        success: false,
        ready: false,
        error: 'Speaker diarization is unavailable on this system',
      });
    }
    return new Promise((resolve) => {
      const proc = spawn(getBackendPath(), ['prepare-speaker-models'], { stdio: 'pipe', cwd: getBackendCwd() });
      const reader = makeLineReader();
      let stdout = '';
      proc.stdout.on('data', (data) => {
        for (const line of reader.feed(data)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith(PROGRESS_PREFIX)) {
            stdout += `${line}\n`;
            continue;
          }
          let progress;
          try { progress = JSON.parse(trimmed.slice(PROGRESS_PREFIX.length)); } catch (_) { continue; }
          if (isProgress(progress)) onProgress({ percent: progress.percent, phase: progress.phase });
        }
      });
      // The backend's own log lines (the Python wrapper never forwards the
      // sidecar's stderr) go to the local debug console, like setup-parakeet.
      proc.stderr?.on('data', (data) => {
        const text = data.toString().trim();
        if (text) onLog(`STDERR: ${text}`);
      });
      proc.on('close', () => {
        try {
          resolve(parseSpeakerModelStatusOutput(stdout));
        } catch (_) {
          resolve(FAILED);
        }
      });
      proc.on('error', () => resolve(FAILED));
    });
  }

  return function prepare() {
    if (!inFlight) {
      inFlight = run().finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}

module.exports = { createSpeakerModelPreparer };

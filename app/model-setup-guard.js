'use strict';

const APPLE_SYSTEM_MODEL = 'apple:system';
const SAFE_MODEL_SAVE_ERRORS = new Set([
  'Could not lock config',
  'Failed to stage model config',
  'Failed to save config',
]);

function assertOllamaSetupModel(model) {
  if (typeof model !== 'string' || !model || model === APPLE_SYSTEM_MODEL) {
    throw new Error('Ollama setup cannot select Apple Intelligence');
  }
  return model;
}

function modelSetupSaveError(error) {
  try {
    let result = error;
    if (!result || typeof result !== 'object' || typeof result.error !== 'string') {
      const jsonLine = String(error?.stdout || '').trim().split('\n').reverse()
        .find((line) => line.trim().startsWith('{'));
      result = jsonLine ? JSON.parse(jsonLine) : null;
    }
    if (result && SAFE_MODEL_SAVE_ERRORS.has(result.error)) {
      return result.error;
    }
  } catch (_) {}
  return 'Failed to save the selected model.';
}

function cleanupFailedOllamaSetup({
  startedProcess,
  startedPid,
  currentProcess,
  currentPid,
  pidFile,
  killProcessTree,
  fs,
  processExited = false,
}) {
  if (startedPid && !processExited) {
    killProcessTree(startedPid);
  }
  if (startedPid) {
    try {
      const recordedPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (recordedPid === startedPid) fs.unlinkSync(pidFile);
    } catch (_) {}
  }
  return {
    ollamaProcess: currentProcess === startedProcess ? null : currentProcess,
    ollamaPid: currentPid === startedPid ? null : currentPid,
  };
}

module.exports = {
  assertOllamaSetupModel,
  modelSetupSaveError,
  cleanupFailedOllamaSetup,
};

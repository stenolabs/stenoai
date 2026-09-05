'use strict';

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidStatus(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.success !== 'boolean' || typeof payload.ready !== 'boolean') return false;
  if (!payload.success) {
    return payload.ready === false && typeof payload.error === 'string' && payload.error.length > 0;
  }
  return (
    typeof payload.cache_directory === 'string' &&
    isStringArray(payload.required_models) &&
    isStringArray(payload.missing_models)
  );
}

function parseSpeakerModelStatusOutput(stdout) {
  if (typeof stdout !== 'string') {
    throw new Error('speaker model command produced no valid JSON status');
  }
  for (const rawLine of stdout.split('\n').reverse()) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!isValidStatus(payload)) continue;
    if (payload.success && payload.ready !== (payload.missing_models.length === 0)) {
      throw new Error('speaker model status is internally inconsistent');
    }
    return payload;
  }
  throw new Error('speaker model command produced no valid JSON status');
}

module.exports = { parseSpeakerModelStatusOutput };

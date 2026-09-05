'use strict';

const path = require('path');

const VALID_CHANNELS = new Set(['mic', 'system']);
const SPEAKER_ID_RE = /^SPEAKER_\d+$/;

function invalid(message) {
  throw new TypeError(message);
}

function validateMeetingStem(value) {
  if (
    typeof value !== 'string'
    || !value
    || value === '.'
    || value === '..'
    || path.basename(value) !== value
    || value.includes('/')
    || value.includes('\\')
  ) invalid('Invalid meeting identifier.');
  return value;
}

function validateOpaqueId(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 128
    || value === '.'
    || value === '..'
    || value.startsWith('-')
    || value.includes('/')
    || value.includes('\\')
    || /\p{C}/u.test(value)
  ) {
    invalid(`Invalid ${label}.`);
  }
  return value;
}

function validateDisplayName(value) {
  if (typeof value !== 'string') {
    invalid('Invalid person name.');
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (
    !normalized
    || normalized.includes('[')
    || normalized.includes(']')
    || /\p{C}/u.test(normalized)
  ) invalid('Invalid person name.');
  return normalized;
}

function parseSpeakerMutation(value, { requireExpectedRun = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid speaker request.');
  const parsed = {
    ...value,
    meetingStem: validateMeetingStem(value.meetingStem),
  };
  if (!VALID_CHANNELS.has(value.channel)) invalid('Invalid speaker channel.');
  parsed.channel = value.channel;
  if (typeof value.diarizationSpeakerId !== 'string' || !SPEAKER_ID_RE.test(value.diarizationSpeakerId)) {
    invalid('Invalid speaker identifier.');
  }
  parsed.diarizationSpeakerId = value.diarizationSpeakerId;
  if (requireExpectedRun || value.expectedRunId !== undefined) {
    parsed.expectedRunId = validateOpaqueId(value.expectedRunId, 'diarization run');
  }
  if (value.personId !== undefined && value.personId !== null && value.personId !== '') {
    parsed.personId = validateOpaqueId(value.personId, 'person identifier');
  }
  if (value.newPersonName !== undefined && value.newPersonName !== null && value.newPersonName !== '') {
    parsed.newPersonName = validateDisplayName(value.newPersonName);
  }
  if (value.containsMultipleSpeakers !== undefined && typeof value.containsMultipleSpeakers !== 'boolean') {
    invalid('Invalid multiple-speaker setting.');
  }
  if (value.generic !== undefined && typeof value.generic !== 'boolean') {
    invalid('Invalid review setting.');
  }
  return parsed;
}

function errorResponse(error) {
  return { success: false, error: error instanceof TypeError ? error.message : 'Speaker operation failed.' };
}

function registerSpeakerIpc({ ipcMain, runPythonScript, parsePythonFailureJson }) {
  ipcMain.handle('list-person-profiles', async () => {
    try {
      const out = await runPythonScript('simple_recorder.py', ['list-person-profiles']);
      return { success: true, ...JSON.parse(out) };
    } catch (error) {
      return errorResponse(error);
    }
  });

  ipcMain.handle('suggest-speakers', async (_event, meetingStem) => {
    try {
      const safeStem = validateMeetingStem(meetingStem);
      const out = await runPythonScript('simple_recorder.py', ['suggest-speakers', safeStem]);
      return JSON.parse(out);
    } catch (error) {
      return errorResponse(error);
    }
  });

  ipcMain.handle('confirm-speaker', async (_event, value) => {
    try {
      const params = parseSpeakerMutation(value);
      const args = ['confirm-speaker', params.meetingStem, params.channel, params.diarizationSpeakerId];
      if (params.personId) args.push('--person-id', params.personId);
      if (params.newPersonName) args.push('--new-person', params.newPersonName);
      args.push('--expected-run-id', params.expectedRunId);
      args.push('--relabel-transcript');
      return JSON.parse(await runPythonScript('simple_recorder.py', args));
    } catch (error) {
      return error instanceof TypeError ? errorResponse(error) : parsePythonFailureJson(error);
    }
  });

  ipcMain.handle('create-person-profile', async (_event, displayName) => {
    try {
      const name = validateDisplayName(displayName);
      return JSON.parse(await runPythonScript('simple_recorder.py', ['create-person-profile', name]));
    } catch (error) {
      return error instanceof TypeError ? errorResponse(error) : parsePythonFailureJson(error);
    }
  });

  ipcMain.handle('rename-person-profile', async (_event, id, displayName) => {
    try {
      const personId = validateOpaqueId(id, 'person identifier');
      const name = validateDisplayName(displayName);
      return JSON.parse(await runPythonScript('simple_recorder.py', ['rename-person-profile', personId, name]));
    } catch (error) {
      return error instanceof TypeError ? errorResponse(error) : parsePythonFailureJson(error);
    }
  });

  ipcMain.handle('delete-person-profile', async (_event, id) => {
    try {
      const personId = validateOpaqueId(id, 'person identifier');
      return JSON.parse(await runPythonScript('simple_recorder.py', ['delete-person-profile', personId]));
    } catch (error) {
      return error instanceof TypeError ? errorResponse(error) : parsePythonFailureJson(error);
    }
  });

  ipcMain.handle('get-speaker-sample-audio', async (
    _event, meetingStem, channel, diarizationSpeakerId, expectedRunId, segmentIndex,
  ) => {
    try {
      const params = parseSpeakerMutation(
        { meetingStem, channel, diarizationSpeakerId, expectedRunId },
      );
      const args = [
        'get-speaker-sample-audio',
        params.meetingStem,
        params.channel,
        params.diarizationSpeakerId,
        '--expected-run-id',
        params.expectedRunId,
      ];
      if (segmentIndex !== undefined) {
        if (!Number.isInteger(segmentIndex) || segmentIndex < 0) invalid('Invalid sample index.');
        args.push('--segment-index', String(segmentIndex));
      }
      return JSON.parse(await runPythonScript('simple_recorder.py', args));
    } catch (error) {
      return error instanceof TypeError ? errorResponse(error) : parsePythonFailureJson(error);
    }
  });

  ipcMain.handle('mark-speaker-cluster', async (_event, value) => {
    try {
      const params = parseSpeakerMutation(value);
      if (typeof params.containsMultipleSpeakers !== 'boolean') invalid('Invalid multiple-speaker setting.');
      const args = [
        'mark-speaker-cluster', params.meetingStem, params.channel, params.diarizationSpeakerId,
        params.containsMultipleSpeakers ? '--multiple' : '--single',
        '--expected-run-id', params.expectedRunId,
      ];
      return JSON.parse(await runPythonScript('simple_recorder.py', args));
    } catch (error) {
      return error instanceof TypeError ? errorResponse(error) : parsePythonFailureJson(error);
    }
  });

  ipcMain.handle('set-cluster-review-state', async (_event, value) => {
    try {
      const params = parseSpeakerMutation(value);
      if (typeof params.generic !== 'boolean') invalid('Invalid review setting.');
      const args = [
        'set-cluster-review-state', params.meetingStem, params.channel, params.diarizationSpeakerId,
        params.generic ? '--generic' : '--clear',
        '--expected-run-id', params.expectedRunId,
      ];
      return JSON.parse(await runPythonScript('simple_recorder.py', args));
    } catch (error) {
      return error instanceof TypeError ? errorResponse(error) : parsePythonFailureJson(error);
    }
  });

  ipcMain.handle('speaker-naming-status', async (_event, meetingStem) => {
    try {
      const safeStem = validateMeetingStem(meetingStem);
      return JSON.parse(await runPythonScript('simple_recorder.py', ['speaker-naming-status', safeStem]));
    } catch (error) {
      return errorResponse(error);
    }
  });
}

module.exports = {
  parseSpeakerMutation,
  registerSpeakerIpc,
  validateDisplayName,
  validateMeetingStem,
};

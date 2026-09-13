'use strict';

const { normalizeOpenAiAsrApiUrl } = require('./openai-asr-key-store');

const OPENAI_ASR_MAX_MODEL_LENGTH = 256;

function normalizeOpenAiAsrModel(model) {
  if (typeof model !== 'string') return null;
  const normalized = model.trim();
  if (
    !normalized
    || normalized.length > OPENAI_ASR_MAX_MODEL_LENGTH
    || normalized.startsWith('-')
    || !/^[\x21-\x7e]+$/.test(normalized)
  ) return null;
  return normalized;
}

// Keep the sensitive endpoint argument construction outside main.js so it can
// be exercised without Electron. The URL is validated before any backend
// process is spawned: query strings, fragments, and userinfo can carry secrets
// and must never briefly appear in a local process listing.
function registerOpenAiAsrIpc({
  ipcMain,
  runPythonScript,
  migrateLegacyOpenAiAsrApiKey,
  hasOpenAiAsrKey,
}) {
  ipcMain.handle('set-openai-asr-config', async (_event, cfg) => {
    const args = ['set-openai-asr-config'];
    const updatesEndpoint = cfg && cfg.api_url !== undefined;
    if (updatesEndpoint) {
      const apiUrl = normalizeOpenAiAsrApiUrl(cfg.api_url);
      if (!apiUrl) {
        return { success: false, error: 'OpenAI ASR endpoint is invalid' };
      }
      args.push('--api-url', apiUrl);
    }
    if (cfg && cfg.model !== undefined) {
      const model = normalizeOpenAiAsrModel(cfg.model);
      if (!model) {
        return { success: false, error: 'OpenAI ASR model is invalid' };
      }
      args.push('--model', model);
    }

    try {
      const migrated = await migrateLegacyOpenAiAsrApiKey();
      // A surviving plaintext snapshot is bound to its old endpoint. Do not
      // commit a new endpoint while cleanup failed, or a later migration
      // could associate that credential with the replacement origin.
      if (updatesEndpoint && !migrated) {
        return { success: false, error: 'OpenAI ASR credential migration is incomplete' };
      }
      const result = await runPythonScript('simple_recorder.py', args, true);
      const jsonData = JSON.parse(result.trim());
      jsonData.api_key_set = hasOpenAiAsrKey();
      return jsonData;
    } catch (e) { return { success: false, error: e.message }; }
  });
}

module.exports = { normalizeOpenAiAsrModel, registerOpenAiAsrIpc };

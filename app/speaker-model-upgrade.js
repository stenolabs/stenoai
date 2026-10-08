'use strict';

const fs = require('fs');
const path = require('path');

// The high-context Sortformer bundle FluidAudio 0.15 cached directly under
// sortformer/. FluidAudio 0.17 reads only the rebuilt sortformer/v3/fp16/
// set, so a Steno cache that still holds this bundle belongs to someone who
// downloaded speaker models before the upgrade and now has none that load.
// The sidecar removes it only after a successful prepare, so it stays until
// the re-download works.
const LEGACY_SORTFORMER_BUNDLE = path.join(
  'models', 'speaker-diarization', 'sortformer', 'SortformerNvidiaHigh_v2.mlmodelc',
);

/**
 * Whether Steno's own speaker-model cache predates the FluidAudio 0.17
 * upgrade. Never true under STENOAI_DIARIZE_MODEL_DIR: that override may be a
 * cache another app owns, and the sidecar never cleans it up either.
 */
function hasLegacySpeakerModelCache(userDataDir, env = process.env) {
  if ((env.STENOAI_DIARIZE_MODEL_DIR || '').trim()) return false;
  return fs.existsSync(path.join(userDataDir, LEGACY_SORTFORMER_BUNDLE));
}

/**
 * Re-download the speaker models in the background for an install whose
 * pre-upgrade cache no longer loads. The user opted in when they first
 * downloaded them, and meeting processing never downloads, so without this
 * every recording would fall back to You / Others until they found Download
 * in Settings. A cheap file check comes first, so installs without the old
 * cache never start the backend; the sidecar's own status then decides. A
 * failed download leaves the old bundle in place, so the next launch retries.
 * Resolves to whether a download ran and ended ready.
 */
async function reprepareSpeakerModelsAfterUpgrade({
  platform, userDataDir, env, checkStatus, prepare, onLog = () => {},
}) {
  if (platform !== 'darwin' || !hasLegacySpeakerModelCache(userDataDir, env)) return false;
  let status;
  try {
    status = await checkStatus();
  } catch (_) {
    return false;
  }
  if (!status || !status.success || status.ready) return false;
  onLog('Speaker models predate this version; downloading them again in the background');
  const result = await prepare();
  const ready = Boolean(result && result.success && result.ready);
  onLog(ready
    ? 'Speaker models downloaded again after the upgrade'
    : 'Speaker model re-download failed; it will be retried on the next launch');
  return ready;
}

module.exports = { hasLegacySpeakerModelCache, reprepareSpeakerModelsAfterUpgrade };

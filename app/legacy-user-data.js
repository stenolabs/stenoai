'use strict';

// v0.8.0 shipped with productName "StenoAI"; every other release used
// "Steno". Electron derives its userData dir from the product name, so chat
// sessions written by v0.8.0 live under <appData>/StenoAI. Copy them into the
// current userData dir once, never overwriting anything already there.
// (Meetings, transcripts and config are unaffected: the Python backend and
// getUserDataDir() use the fixed "stenoai" dir.)
const LEGACY_PRODUCT_NAME = 'StenoAI';
const MIGRATED_FILES = ['chat_sessions_v2.json', 'chat_sessions.json'];

function migrateLegacyUserData({ fs, path, appDataDir, userDataDir }) {
  const legacyDir = path.join(appDataDir, LEGACY_PRODUCT_NAME);
  const copied = [];
  if (path.resolve(legacyDir).toLowerCase() === path.resolve(userDataDir).toLowerCase()) return copied;
  for (const name of MIGRATED_FILES) {
    const from = path.join(legacyDir, name);
    const to = path.join(userDataDir, name);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      copied.push(name);
    } catch (err) {
      console.warn(`Legacy user-data migration skipped ${name}: ${err.message}`);
    }
  }
  return copied;
}

module.exports = { migrateLegacyUserData, LEGACY_PRODUCT_NAME, MIGRATED_FILES };

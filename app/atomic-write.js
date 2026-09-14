const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Write via a temp file in the SAME directory, then rename. rename(2) is atomic
// within a filesystem, so a reader either sees the old file or the new one and
// never a truncated one. The temp name is randomised so two concurrent writers
// cannot collide, and it is dot-prefixed so a directory listing stays clean.
function writeFileAtomicSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      // The temp file may never have been created. Nothing to clean up.
    }
    throw err;
  }
}

module.exports = { writeFileAtomicSync };

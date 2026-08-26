import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * Mirror app/main.js getUserDataDir() / src/config.get_user_data_dir() for the
 * PRODUCTION (no-override) location. Computed independently of the code under
 * test on purpose: if a keystone bug broke getUserDataDir(), sharing the prod
 * helper would make both the app and the assertion wrong in the same direction
 * and the "real dir untouched" check would pass falsely.
 */
export function realUserDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'stenoai');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(base, 'stenoai');
  }
  const base = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(base, 'stenoai');
}

/** Recursive metadata fingerprint so nested writes cannot hide behind an
 * unchanged root-directory stat. Paths are hashed and never printed. */
export function fileSig(p: string): string {
  if (!existsSync(p)) return 'absent';
  const hash = createHash('sha256');
  const visit = (current: string, relative: string) => {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      hash.update(`${relative}:disappeared\n`);
      return;
    }
    const kind = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f';
    hash.update(`${relative}:${kind}:${stat.mtimeMs}:${stat.size}\n`);
    if (!stat.isDirectory()) return;
    let children: string[];
    try {
      children = readdirSync(current).sort();
    } catch {
      hash.update(`${relative}:unreadable\n`);
      return;
    }
    for (const child of children) {
      visit(path.join(current, child), path.join(relative, child));
    }
  };
  visit(p, '.');
  return hash.digest('hex');
}

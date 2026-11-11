import { spawn } from 'child_process';
import { test, expect } from '../fixtures/electron';

// The launch fixture kills what a test's app leaves behind (#598). A recording
// spec that leaks its `process-streaming` child starves every later spec on the
// runner, so the cleanup itself is worth pinning: the first test leaves an
// orphan the way a restart spec does (app closed by the spec, child still
// running with a path below the user-data dir), the second checks it is gone.
test.describe.configure({ mode: 'serial' });

let orphanPid = 0;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a spec that closes the app itself leaves an orphan behind', async ({
  launchApp,
  userDataDir,
}) => {
  test.skip(process.platform === 'win32', 'the leftover sweep is macOS/Linux only');

  const { app } = await launchApp({ mockIpc: true, releaseHighlightsSeen: true });
  // Stands in for the backend child: detached, and handed a path below the
  // user-data dir exactly as `process-streaming <dir>/recordings/x.wav` is.
  const orphan = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 120000)', `${userDataDir}/recordings/orphan.wav`],
    { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  orphan.unref();
  orphanPid = orphan.pid ?? 0;
  expect(orphanPid).toBeGreaterThan(0);

  await app.close();
  expect(isAlive(orphanPid)).toBe(true);
});

test('the fixture teardown killed that orphan', async () => {
  test.skip(process.platform === 'win32', 'the leftover sweep is macOS/Linux only');
  test.skip(orphanPid === 0, 'the previous test did not start an orphan');

  await expect.poll(() => isAlive(orphanPid), { timeout: 5_000 }).toBe(false);
});

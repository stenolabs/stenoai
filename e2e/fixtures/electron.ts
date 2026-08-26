import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execSync } from 'child_process';

// Repo-root/app — the Electron app dir (package.json main: main.js). Resolved
// from this file so the helper works regardless of the cwd Playwright runs in.
const APP_DIR = path.resolve(__dirname, '..', '..', 'app');

type LaunchOptions = {
  /** Install the deterministic mock IPC layer (T1, no backend). */
  mockIpc?: boolean;
  /**
   * Hand Chromium a synthetic capture device so `getUserMedia` resolves on a
   * machine with no audio hardware. Required by any spec that starts a
   * recording: a failed renderer-side capture reports
   * `reportSystemAudioState(false)`, which drops the optimistic recording
   * state, clears `useRecording().sessionName`, and makes `useLiveTranscript`
   * discard every `live-transcript-chunk` (it filters strictly on the
   * session name). That looks like "the panel never renders the segment"
   * and only happens where there is no device, i.e. CI, never on a dev Mac.
   */
  fakeAudio?: boolean;
  /** Extra env vars merged over the e2e defaults. */
  env?: Record<string, string>;
};

type LaunchResult = { app: ElectronApplication; page: Page };

type Fixtures = {
  userDataDir: string;
  launchApp: (opts?: LaunchOptions) => Promise<LaunchResult>;
};

export const test = base.extend<Fixtures>({
  // Per-test isolated user-data dir. The keystone (STENOAI_USER_DATA_DIR) routes
  // every app + backend write here instead of the real ~/Library/... dir, so a
  // test can never corrupt real user data. Removed after the test.
  userDataDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stenoai-e2e-'));
    await use(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  },

  // Factory so each spec decides when/how to launch (T1 passes mockIpc:true).
  // Every app launched through it is closed at teardown.
  launchApp: async ({ userDataDir }, use) => {
    const launched: ElectronApplication[] = [];

    const launch = async (opts: LaunchOptions = {}): Promise<LaunchResult> => {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        STENOAI_E2E: '1',
        // A hidden BrowserWindow still renders and remains fully controllable
        // through Playwright, without repeatedly taking over the host desktop.
        // A specific focus/visibility test can override this with "0".
        STENOAI_E2E_HEADLESS: '1',
        STENOAI_USER_DATA_DIR: userDataDir,
        ...(opts.mockIpc ? { STENOAI_E2E_MOCK_IPC: '1' } : {}),
        ...(opts.env ?? {}),
      };

      // Electron occasionally fails its very first launch on a cold CI runner;
      // retry once before surfacing the error (test-level retries are the
      // second line of defence, configured in playwright.config.ts).
      let app: ElectronApplication | undefined;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          app = await electron.launch({
            args: [
              '.',
              ...(opts.fakeAudio
                ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
                : []),
            ],
            cwd: APP_DIR,
            env,
          });
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!app) throw lastErr;
      launched.push(app);

      const page = await app.firstWindow();
      // Deterministic launch gate — set in App.tsx's readiness effect. No
      // fixed timeouts anywhere in the suite.
      await page.waitForSelector('[data-app-ready]', { timeout: 30_000 });
      return { app, page };
    };

    await use(launch);

    for (const app of launched) {
      // app.close() can hang on Windows: the app spawns children (the backend
      // pipeline subprocess, a stray `ollama serve`) that keep the Electron main
      // process alive, so a graceful close never returns and Playwright's worker
      // teardown times out. Race the close with a grace window, then force-kill
      // the whole process tree. macOS closes well within the window, so the
      // fallback never fires there.
      const proc = app.process();
      try {
        await Promise.race([
          app.close(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('close-timeout')), 10_000),
          ),
        ]);
      } catch {
        try {
          const pid = proc?.pid;
          if (pid) {
            if (process.platform === 'win32') {
              execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
            } else {
              proc!.kill('SIGKILL');
            }
          }
        } catch {
          /* already gone */
        }
      }
    }
  },
});

export { expect };

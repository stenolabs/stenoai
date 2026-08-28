import type { ElectronApplication } from '@playwright/test';

/**
 * Drive the Linux loopback bridge from a test, pushing PCM on the real
 * `linux-loopback-chunk` / `linux-loopback-ended` channels main.js emits on —
 * so the renderer path under test (preload subscribe → linuxLoopbackStream →
 * useSystemAudioCapture) is the production one, with no test-only seam.
 */

/** Interleaved stereo s16 at a constant amplitude — the shape pw-record emits. */
export function pcmChunk(frames: number, amplitude = 8000): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < 2; ch++) {
      bytes.push(amplitude & 0xff, (amplitude >> 8) & 0xff);
    }
  }
  return bytes;
}

export async function emitLoopbackChunks(
  app: ElectronApplication,
  chunks: number[][],
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload: number[][]) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no BrowserWindow to emit into');
    for (const bytes of payload) {
      win.webContents.send('linux-loopback-chunk', Buffer.from(bytes));
    }
  }, chunks);
}

export async function emitLoopbackEnded(
  app: ElectronApplication,
  detail: { code: number | null; signal: string | null } = { code: 1, signal: null },
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no BrowserWindow to emit into');
      win.webContents.send('linux-loopback-ended', payload);
    },
    detail,
  );
}

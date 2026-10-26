import type { ElectronApplication } from '@playwright/test';

/**
 * Drive the live transcript from a test.
 *
 * Segments are pushed on `live-transcript-chunk` straight from the main
 * process - the same channel main.js's `handleLiveTranscribeLine` emits on when
 * the Python sidecar prints a LIVE_SEG. That keeps the renderer path under test
 * the real one (preload subscribe → useLiveTranscript → LiveTranscriptBar) and
 * means no test-only seam has to exist in production code.
 */
export type LiveSegmentInput = {
  text: string;
  start: number;
  end: number;
  isFinal: boolean;
  speaker: 'You' | 'Others';
};

export async function emitLiveSegments(
  app: ElectronApplication,
  sessionName: string,
  segments: LiveSegmentInput[],
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload: { sessionName: string; segments: LiveSegmentInput[] }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no BrowserWindow to emit into');
      for (const segment of payload.segments) {
        win.webContents.send('live-transcript-chunk', {
          sessionName: payload.sessionName,
          segment,
        });
      }
    },
    { sessionName, segments },
  );
}

export async function emitLiveRevoke(
  app: ElectronApplication,
  sessionName: string,
  speaker: 'You' | 'Others',
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload: { sessionName: string; speaker: 'You' | 'Others' }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no BrowserWindow to emit into');
      win.webContents.send('live-transcript-revoke', payload);
    },
    { sessionName, speaker },
  );
}

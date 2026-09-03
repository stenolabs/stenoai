import { test, expect } from '../fixtures/electron';
import type { Page } from '@playwright/test';
import { readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * T1 — renderer-only, mock IPC, no backend. Drives the REAL MeetingDetail
 * transcript actions (Copy transcript / Save transcript as .md…) against a
 * seeded meeting, proving the renderer BUILDS the bundle from meeting data and
 * WIRES it to both sinks. The T2 spec only asserts the backend writes whatever
 * string it's handed; the build + the copy/save wiring the renderer performs
 * live here.
 *
 * Seams (mirrors of the real ones, see app/e2e-mock-ipc.js):
 *  - STENOAI_E2E_SEED_MEETING=1 makes list-meetings return one known meeting, so
 *    #/meetings/<summary_file> resolves to it (useMeeting filters that list).
 *  - the clipboard is captured by replacing navigator.clipboard in-page (no OS
 *    clipboard dependency in CI), which also lets us force a rejected write.
 *  - STENOAI_E2E_EXPORT_PATH makes the export-transcript mock write the bundle
 *    to disk, so Save's payload is observable byte-for-byte.
 */

const SUMMARY_FILE = 'epsilon_summary.json';

// Replace navigator.clipboard with a recorder. __clipboardReject toggles a
// rejected write so the "Copied only on a successful write" path is testable.
async function installClipboardRecorder(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __clipboardWrites: string[];
      __clipboardReject: boolean;
    };
    w.__clipboardWrites = [];
    w.__clipboardReject = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          w.__clipboardWrites.push(text);
          return w.__clipboardReject
            ? Promise.reject(new Error('denied'))
            : Promise.resolve();
        },
      },
    });
  });
}

const clipboardWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites);

async function openDetail(page: Page) {
  await page.evaluate((f) => {
    window.location.hash = `#/meetings/${encodeURIComponent(f)}`;
  }, SUMMARY_FILE);
  // The seeded meeting's title and the transcript actions are present once the
  // detail route has resolved the meeting from the mocked list.
  await expect(page.getByRole('button', { name: 'Copy transcript' })).toBeVisible();
}

test('Copy transcript copies the renderer-built bundle and confirms only on success', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_MEETING: '1' } });
  await openDetail(page);
  await installClipboardRecorder(page);

  await page.getByRole('button', { name: 'Copy transcript' }).click();

  // Exactly one write, carrying the bundle BUILT from the meeting (not an
  // arbitrary string): English metadata labels + headings, the notes and the
  // transcript body — and none of the old German labels.
  const writes = await clipboardWrites(page);
  expect(writes).toHaveLength(1);
  const bundle = writes[0];
  expect(bundle).toContain('# Epsilon Planning');
  expect(bundle).toContain('Date: ');
  expect(bundle).toContain('Duration: 25 min');
  expect(bundle).toContain('Participants: Alice, Bob');
  expect(bundle).toContain('## Notes\nRemember to send the deck.');
  expect(bundle).toContain('## Transcript\nAlice: we ship Friday.\nBob: I will prep the release notes.');
  for (const german of ['Datum', 'Dauer', 'Teilnehmer', 'Notizen', 'Transkript']) {
    expect(bundle).not.toContain(german);
  }

  // The button confirms the copy only after the write resolved.
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
});

test('Copy transcript includes a readable diarised view and the timestamped source', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      STENOAI_E2E_SEED_MEETING: '1',
      STENOAI_E2E_SEED_DIARISED_EXPORT: '1',
    },
  });
  await openDetail(page);
  await installClipboardRecorder(page);

  await page.getByRole('button', { name: 'Copy transcript' }).click();

  const writes = await clipboardWrites(page);
  expect(writes).toHaveLength(1);
  const bundle = writes[0];
  expect(bundle).toContain(
    '## Transcript\nMe: We should ship Friday. I will prepare the release.\n\nOthers: Sounds good.',
  );
  expect(bundle).toContain(
    '## Timestamped transcript\n[00:00] [You] We should ship Friday.\n[00:02] [You] I will prepare the release.\n[00:06] [Others] Sounds good.',
  );
});

test('Copy transcript does not confirm when the clipboard write is rejected', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_MEETING: '1' } });
  await openDetail(page);
  await installClipboardRecorder(page);
  await page.evaluate(() => {
    (window as unknown as { __clipboardReject: boolean }).__clipboardReject = true;
  });

  await page.getByRole('button', { name: 'Copy transcript' }).click();

  // The write was attempted but rejected, so the button must NOT flip to
  // "Copied"; the failure surfaces instead.
  await expect(page.getByText(/Couldn't copy transcript/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copied' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy transcript' })).toBeVisible();
});

test('Save transcript as .md passes the same built bundle to export-transcript', async ({
  launchApp,
}) => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'steno-export-t1-'));
  const outFile = path.join(outDir, 'epsilon.md');
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_EXPORT_PATH: outFile },
  });

  try {
    await openDetail(page);
    await installClipboardRecorder(page);

    // Capture what Copy puts on the clipboard, then Save, and assert the file
    // the export handler received is byte-for-byte the same bundle.
    await page.getByRole('button', { name: 'Copy transcript' }).click();
    const [copied] = await clipboardWrites(page);
    expect(copied).toBeTruthy();

    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('button', { name: /Save transcript as \.md/ }).click();

    await expect.poll(() => {
      try {
        return readFileSync(outFile, 'utf8');
      } catch {
        return null;
      }
    }, { timeout: 10_000, intervals: [200] }).toBe(copied);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

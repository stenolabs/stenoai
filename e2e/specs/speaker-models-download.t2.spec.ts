import { test, expect } from '../fixtures/electron';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * T2 - the opt-in speaker-model download, end to end through the real backend:
 * renderer bridge -> main.js -> `stenoai prepare-speaker-models` -> sidecar.
 * STENOAI_DIARIZE_SIDECAR_PATH points at a fixture script standing in for
 * steno-diarize, so nothing is downloaded. Asserts that the sidecar's
 * STENO_PROGRESS stderr lines arrive in the renderer as validated
 * speaker-models-progress events (stderr noise and malformed lines dropped),
 * and that the status flips to ready once the files are on disk.
 * macOS-only: main.js reports speaker models unavailable elsewhere.
 */

type Status = { success: boolean; ready: boolean; error?: string };
type Progress = { percent: number; phase: string };
type StenoWindow = Window & {
  stenoai: {
    setup: { speakerModelsStatus: () => Promise<Status>; speakerModels: () => Promise<Status> };
    on: { speakerModelsProgress: (cb: (p: Progress) => void) => () => void };
  };
  __speakerProgress?: Progress[];
};

test('speaker model download relays sidecar progress and ends ready', async ({ launchApp, userDataDir }) => {
  test.skip(process.platform !== 'darwin', 'speaker diarization models are macOS-only');

  const marker = path.join(userDataDir, 'models', 'speaker-diarization', 'fixture-ready');
  const status = (ready: boolean) => JSON.stringify({
    ready,
    cache_directory: path.dirname(marker),
    required_models: ['sortformer/SortformerNvidiaHigh_v2.mlmodelc'],
    missing_models: ready ? [] : ['sortformer/SortformerNvidiaHigh_v2.mlmodelc'],
  });
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'stenoai-e2e-speaker-models-'));
  const script = path.join(fixtureDir, 'mock-steno-diarize.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'case "$1" in',
    '  model-status)',
    `    if [ -f '${marker}' ]; then echo '${status(true)}'; exit 0; fi`,
    `    echo '${status(false)}'; exit 3 ;;`,
    '  prepare-models)',
    `    echo 'STENO_PROGRESS {"percent":10,"phase":"downloading"}' >&2`,
    `    echo 'E5RT diagnostic /private/var/folders/x' >&2`,
    `    echo 'STENO_PROGRESS {"percent":250,"phase":"downloading"}' >&2`,
    `    echo 'STENO_PROGRESS {"percent":60,"phase":"compiling"}' >&2`,
    `    mkdir -p '${path.dirname(marker)}' && touch '${marker}'`,
    `    echo 'STENO_PROGRESS {"percent":100,"phase":"compiling"}' >&2`,
    `    echo '${status(true)}' ;;`,
    '  *) exit 2 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);

  const { page } = await launchApp({ env: { STENOAI_DIARIZE_SIDECAR_PATH: script } });

  const before = await page.evaluate(() => (window as StenoWindow).stenoai.setup.speakerModelsStatus());
  expect(before).toMatchObject({ success: true, ready: false });

  await page.evaluate(() => {
    const w = window as StenoWindow;
    w.__speakerProgress = [];
    w.stenoai.on.speakerModelsProgress((p) => w.__speakerProgress!.push(p));
  });
  const result = await page.evaluate(() => (window as StenoWindow).stenoai.setup.speakerModels());
  expect(result).toMatchObject({ success: true, ready: true });

  await expect
    .poll(() => page.evaluate(() => (window as StenoWindow).__speakerProgress))
    .toEqual([
      { percent: 10, phase: 'downloading' },
      { percent: 60, phase: 'compiling' },
      { percent: 100, phase: 'compiling' },
    ]);

  expect(existsSync(marker)).toBe(true);
  const after = await page.evaluate(() => (window as StenoWindow).stenoai.setup.speakerModelsStatus());
  expect(after).toMatchObject({ success: true, ready: true });
});

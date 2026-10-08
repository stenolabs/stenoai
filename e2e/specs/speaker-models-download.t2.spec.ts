import { test, expect } from '../fixtures/electron';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    setup: {
      speakerModelsStatus: () => Promise<Status>;
      speakerModels: (engine?: string) => Promise<Status>;
    };
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

test('a download prepares the engine Settings asked for, not the saved one', async ({
  launchApp,
  userDataDir,
}) => {
  test.skip(process.platform !== 'darwin', 'speaker diarization models are macOS-only');

  // The sidecar records the engine its environment selected. Downloads stream
  // progress through their own runner, so this pins the engine reaching the
  // sidecar on that path: renderer -> main.js -> CLI --engine -> sidecar env.
  const engineFile = path.join(userDataDir, 'prepared-engine');
  const ready = JSON.stringify({
    ready: true,
    cache_directory: path.join(userDataDir, 'models', 'speaker-diarization'),
    required_models: [],
    missing_models: [],
  });
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'stenoai-e2e-speaker-engine-'));
  const script = path.join(fixtureDir, 'mock-steno-diarize.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'case "$1" in',
    '  prepare-models)',
    `    echo 'STENO_PROGRESS {"percent":10,"phase":"downloading"}' >&2`,
    `    printf '%s' "\${STENOAI_DIARIZE_ENGINE:-}" > '${engineFile}'`,
    `    echo '${ready}' ;;`,
    '  *) exit 2 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);

  const { page } = await launchApp({ env: { STENOAI_DIARIZE_SIDECAR_PATH: script } });

  const result = await page.evaluate(() =>
    (window as StenoWindow).stenoai.setup.speakerModels('nemotron3'),
  );
  expect(result).toMatchObject({ success: true, ready: true });
  expect(readFileSync(engineFile, 'utf8')).toBe('nemotron3');

  const rejected = await page.evaluate(() =>
    (window as StenoWindow).stenoai.setup.speakerModels('pyannote'),
  );
  expect(rejected).toMatchObject({ success: false, ready: false });
});

test('an install upgraded from FluidAudio 0.15 downloads its speaker models again on launch', async ({
  launchApp,
  userDataDir,
}) => {
  test.skip(process.platform !== 'darwin', 'speaker diarization models are macOS-only');

  // What a user who opted in on a FluidAudio 0.15 build has: the old
  // root-level Sortformer bundle, which 0.17 no longer loads.
  const cache = path.join(userDataDir, 'models', 'speaker-diarization');
  mkdirSync(path.join(cache, 'sortformer', 'SortformerNvidiaHigh_v2.mlmodelc'), { recursive: true });
  const prepared = path.join(userDataDir, 'prepared-after-upgrade');
  const status = (ready: boolean) => JSON.stringify({
    ready,
    cache_directory: cache,
    required_models: ['sortformer/v3/fp16/SortformerNvidiaHigh_v2.mlmodelc'],
    missing_models: ready ? [] : ['sortformer/v3/fp16/SortformerNvidiaHigh_v2.mlmodelc'],
  });
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'stenoai-e2e-speaker-upgrade-'));
  const script = path.join(fixtureDir, 'mock-steno-diarize.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'case "$1" in',
    '  model-status)',
    `    if [ -f '${prepared}' ]; then echo '${status(true)}'; exit 0; fi`,
    `    echo '${status(false)}'; exit 3 ;;`,
    '  prepare-models)',
    `    touch '${prepared}'`,
    `    echo '${status(true)}' ;;`,
    '  *) exit 2 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);

  // Nothing in the renderer asks for it: the launch itself must start it.
  await launchApp({
    env: { STENOAI_DIARIZE_SIDECAR_PATH: script, STENOAI_E2E_SPEAKER_UPGRADE: '1' },
  });

  await expect.poll(() => existsSync(prepared), { timeout: 30_000 }).toBe(true);
});

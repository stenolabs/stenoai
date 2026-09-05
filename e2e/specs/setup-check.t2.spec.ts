import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * T2 — startup setup check. The onboarding wizard polls setup.check() to decide
 * which steps are needed; it reads system state (bundled binaries, model caches,
 * deps) with NO installs and NO network. This asserts the result CONTRACT on a
 * clean profile — the shape the wizard depends on — without asserting any
 * specific host's install state (that varies by runner). The heavy install steps
 * (setup-ollama-and-model, setup-parakeet, …) download hundreds of MB and are
 * deferred to manual /verify + the nightly packaged cold-start.
 */

type Check = { name: string; ok: boolean; status: 'pass' | 'fail' | 'warn'; detail: string };
type SetupResult = { success: boolean; allGood?: boolean; checks?: Check[]; error?: string };

type StenoWindow = Window & {
  stenoai: { setup: { check: () => Promise<SetupResult> } };
};

test('setup.check returns a coherent allGood + checks contract on a clean profile; real dir untouched', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  const res = await page.evaluate(() => (window as StenoWindow).stenoai.setup.check());

  expect(res.success).toBe(true);
  // allGood is a boolean verdict (its value is host-dependent — a CI runner
  // without the LLM model reports false — so we assert the type, not the value).
  expect(typeof res.allGood).toBe('boolean');

  // checks is a non-empty list of structured records the backend emits as JSON
  // (setup-check --json) — no emoji-scraping. Each entry is
  // { name, ok, status, detail } with status in {pass, fail, warn} and ok mirroring
  // status !== 'fail'.
  expect(Array.isArray(res.checks)).toBe(true);
  expect(res.checks!.length).toBeGreaterThan(0);
  for (const entry of res.checks!) {
    expect(typeof entry).toBe('object');
    expect(typeof entry.name).toBe('string');
    expect(entry.name.length).toBeGreaterThan(0);
    expect(['pass', 'fail', 'warn']).toContain(entry.status);
    expect(entry.ok).toBe(entry.status !== 'fail');
    expect(typeof entry.detail).toBe('string');
  }

  // allGood is exactly "no failing check" — the same verdict the backend computes.
  expect(res.allGood).toBe(res.checks!.every((c) => c.ok));

  // The Python check is deterministic on any runner (the interpreter is running
  // the backend), so it must be present and passing.
  const python = res.checks!.find((c) => c.name === 'Python');
  expect(python).toBeDefined();
  expect(python!.status).toBe('pass');
  expect(python!.ok).toBe(true);

  // The speaker-model readiness probe is intentionally read-only. A clean
  // profile must stay clean until the explicit setup action is invoked.
  expect(existsSync(join(userDataDir, 'models', 'speaker-diarization'))).toBe(false);

  // setup.check is a read — it must not write into the real user-data dir.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

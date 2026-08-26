import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { readUserConfig } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { killOllama } from '../fixtures/kill-ollama';

/**
 * T2 — model management (the deterministic, model-free subset). Covers the
 * summary-model and whisper-model config round-trips plus the whisper / parakeet
 * list + status SHAPE. Model PULLS (pull-model / pull-whisper-model /
 * pull-parakeet-model) download hundreds of MB and are NOT covered here — they
 * belong to the model-bearing @pipeline jobs. "installed" reflects the host's
 * real model cache (not the temp dir), so we assert the SHAPE of those flags,
 * never a specific install state.
 */

type ModelInfo = { installed?: boolean; mlx_tag?: string; mlx_installed?: boolean };
type ListResult = {
  success: boolean;
  current_model?: string;
  supported_models?: Record<string, ModelInfo>;
  provider?: string;
};
type CurrentModel = { success: boolean; model?: string };
type StatusResult = { success: boolean; model?: string; installed?: boolean };
type Result = { success?: boolean };
type PullResult = { success: boolean; error?: string; cancelled?: boolean };
type VerifyResult = { success: boolean; error: string | null };
type DeleteResult = { success: boolean; error: string | null };
type CancelPullResult = { success: boolean; error: string | null };

type StenoWindow = Window & {
  stenoai: {
    models: {
      list: () => Promise<ListResult>;
      getCurrent: () => Promise<CurrentModel>;
      set: (name: string) => Promise<Result>;
      pull: (name: string) => Promise<PullResult>;
      cancelPull: (name: string) => Promise<CancelPullResult>;
      verify: (name: string) => Promise<VerifyResult>;
      delete: (name: string) => Promise<DeleteResult>;
    };
    whisperModels: {
      list: () => Promise<ListResult>;
      set: (name: string) => Promise<Result>;
    };
    parakeetModels: {
      list: () => Promise<ListResult>;
      status: () => Promise<StatusResult>;
    };
  };
};


/** Every entry in a supported-models map must carry a boolean `installed` flag. */
function assertInstalledShape(models: Record<string, ModelInfo> | undefined) {
  expect(models && typeof models === 'object').toBeTruthy();
  const entries = Object.values(models!);
  expect(entries.length).toBeGreaterThan(0);
  for (const m of entries) {
    expect(typeof m.installed).toBe('boolean');
  }
}

test('a fresh install defaults the summary model to gemma4:e2b-it-qat', async ({
  launchApp,
}) => {
  // No config is seeded, so get-current-model returns Config.DEFAULT_MODEL.
  // This pins the WS1 default swap (was llama3.2:3b).
  const { page } = await launchApp();
  const current = await page.evaluate(() =>
    (window as StenoWindow).stenoai.models.getCurrent(),
  );
  expect(current.success).toBe(true);
  expect(current.model).toBe('gemma4:e2b-it-qat');
});

test('summary model set persists to config.model and round-trips through get-current-model', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  // There's always a current model (config default).
  const before = await page.evaluate(() =>
    (window as StenoWindow).stenoai.models.getCurrent(),
  );
  expect(before.success).toBe(true);
  expect(before.model).toBeTruthy();

  await page.evaluate(() => (window as StenoWindow).stenoai.models.set('llama3.2:1b'));
  await expect.poll(() => readUserConfig(userDataDir).model).toBe('llama3.2:1b');
  await expect
    .poll(async () => (await page.evaluate(() => (window as StenoWindow).stenoai.models.getCurrent())).model)
    .toBe('llama3.2:1b');

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('whisper models: list reports installed flags; set persists to config.whisper_model', async ({
  launchApp,
  userDataDir,
}) => {
  const { page } = await launchApp();

  const listed = await page.evaluate(() =>
    (window as StenoWindow).stenoai.whisperModels.list(),
  );
  expect(listed.success).toBe(true);
  expect(listed.provider).toBe('local');
  assertInstalledShape(listed.supported_models);

  // Pick the supported key (SUPPORTED_WHISPER_MODELS = large-v3-turbo;
  // set-whisper-model validates against it) and set it; it persists + the
  // list's current model follows.
  await page.evaluate(() => (window as StenoWindow).stenoai.whisperModels.set('large-v3-turbo'));
  await expect.poll(() => readUserConfig(userDataDir).whisper_model).toBe('large-v3-turbo');
  await expect
    .poll(async () => (await page.evaluate(() => (window as StenoWindow).stenoai.whisperModels.list())).current_model)
    .toBe('large-v3-turbo');
});

test('parakeet models: list + status return a coherent installed shape', async ({
  launchApp,
}) => {
  const { page } = await launchApp();

  const listed = await page.evaluate(() =>
    (window as StenoWindow).stenoai.parakeetModels.list(),
  );
  expect(listed.success).toBe(true);
  expect(listed.current_model).toBeTruthy();
  assertInstalledShape(listed.supported_models);

  const status = await page.evaluate(() =>
    (window as StenoWindow).stenoai.parakeetModels.status(),
  );
  expect(status.success).toBe(true);
  expect(status.model).toBeTruthy();
  expect(typeof status.installed).toBe('boolean');
  // status + list agree on the default model id.
  expect(status.model).toBe(listed.current_model);
});

test('a model pulled straight to its NVFP4 tag (no GGUF ever downloaded) still reports installed', async ({
  launchApp,
}) => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64', 'MLX enrichment only applies on Apple Silicon');
  killOllama();
  // Only the NVFP4 tag is "installed" -- the GGUF blob was never pulled,
  // e.g. because "Select" resolved straight to the faster build.
  const mockOllama = await startMockOllama({ installedModels: ['gemma4:e2b-nvfp4'] });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${mockOllama.port}` },
    });
    const listed = await page.evaluate(() => (window as StenoWindow).stenoai.models.list());
    expect(listed.success).toBe(true);
    const e2bEntry = listed.supported_models?.['gemma4:e2b-it-qat'];
    expect(e2bEntry?.mlx_tag).toBe('gemma4:e2b-nvfp4');
    expect(e2bEntry?.mlx_installed).toBe(true);
    // The GGUF id itself was never pulled, but the model is fully usable via
    // its NVFP4 sibling -- must not leave "Select" offered forever.
    expect(e2bEntry?.installed).toBe(true);
  } finally {
    await mockOllama.close();
  }
});

test('switch-to-faster-build: pull, verify, and delete the old tag all round-trip through IPC', async ({
  launchApp,
}) => {
  killOllama();
  const mockOllama = await startMockOllama();
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${mockOllama.port}` },
    });
    const pullResult = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.pull('gemma4:e2b-nvfp4'),
    );
    expect(pullResult.success).toBe(true);
    expect(mockOllama.lastPulledModel()).toBe('gemma4:e2b-nvfp4');

    const verifyResult = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.verify('gemma4:e2b-nvfp4'),
    );
    expect(verifyResult.success).toBe(true);
    expect(verifyResult.error).toBeNull();

    const deleteResult = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.delete('gemma4:e2b-it-qat'),
    );
    expect(deleteResult.success).toBe(true);
    expect(deleteResult.error).toBeNull();
    expect(mockOllama.deleteCalls()).toBe(1);
    expect(mockOllama.lastDeletedModel()).toBe('gemma4:e2b-it-qat');
  } finally {
    await mockOllama.close();
  }
});

test('delete-model: the general "free up disk space" action can remove a GGUF model and its NVFP4 sibling directly', async ({
  launchApp,
}) => {
  killOllama();
  const mockOllama = await startMockOllama();
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${mockOllama.port}` },
    });
    // Unlike the switch-to-faster-build flow (which only ever deletes the
    // GGUF id), the general delete action can target either tag on its own.
    const ggufDelete = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.delete('gemma4:e4b-it-qat'),
    );
    expect(ggufDelete.success).toBe(true);
    expect(mockOllama.lastDeletedModel()).toBe('gemma4:e4b-it-qat');

    const nvfp4Delete = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.delete('gemma4:e4b-nvfp4'),
    );
    expect(nvfp4Delete.success).toBe(true);
    expect(mockOllama.lastDeletedModel()).toBe('gemma4:e4b-nvfp4');
    expect(mockOllama.deleteCalls()).toBe(2);
  } finally {
    await mockOllama.close();
  }
});

test('cancel-pull: stops an in-flight download and reports it as cancelled, not a failure', async ({
  launchApp,
}) => {
  killOllama();
  // Holds the mock's /api/pull response open so there's a real window to
  // cancel before it would otherwise complete on its own.
  const mockOllama = await startMockOllama({ pullDelayMs: 3000 });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${mockOllama.port}` },
    });
    const pullPromise = page.evaluate(() =>
      (window as StenoWindow).stenoai.models.pull('gemma4:e2b-nvfp4'),
    );

    // Wait for the pull-model subprocess to actually reach the mock server
    // (PyInstaller cold start can take longer than a short fixed sleep)
    // before cancelling, so this exercises a real in-flight download rather
    // than racing the subprocess's own startup time. Windows CI cold-starts
    // the bundled exe slower than the 5s default (seen exceeding it when
    // the backend bundle was just downloaded in the same job) -- 15s matches
    // the same wait-on-spawned-backend pattern in org-lock-lifecycle.t2.
    await expect.poll(() => mockOllama.pullCalls(), { timeout: 15_000 }).toBeGreaterThan(0);

    const cancelResult = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.cancelPull('gemma4:e2b-nvfp4'),
    );
    expect(cancelResult.success).toBe(true);
    expect(cancelResult.error).toBeNull();

    const pullResult = await pullPromise;
    expect(pullResult.success).toBe(false);
    expect(pullResult.cancelled).toBe(true);
    expect(mockOllama.pullCalls()).toBe(1);

    // Nothing left to cancel now -- a second call must fail cleanly rather
    // than silently succeeding or throwing.
    const secondCancel = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.cancelPull('gemma4:e2b-nvfp4'),
    );
    expect(secondCancel.success).toBe(false);
  } finally {
    await mockOllama.close();
  }
});

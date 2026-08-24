import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type ListedModel, type TranscriptionEngine } from '@/lib/ipc';
import { unwrap } from '@/lib/result';
import { APPLE_LANGUAGE_CODES, PARAKEET_LANGUAGE_CODES } from '@/lib/transcription-languages';

export const modelsKeys = {
  all: ['models'] as const,
  list: () => [...modelsKeys.all, 'list'] as const,
  current: () => [...modelsKeys.all, 'current'] as const,
  ollama: () => [...modelsKeys.all, 'ollama'] as const,
};

export const whisperKeys = {
  all: ['whisperModels'] as const,
  list: () => [...whisperKeys.all, 'list'] as const,
};

export const parakeetKeys = {
  all: ['parakeetModels'] as const,
  list: () => [...parakeetKeys.all, 'list'] as const,
  status: () => [...parakeetKeys.all, 'status'] as const,
};

export const appleSpeechKeys = {
  all: ['appleSpeech'] as const,
  status: (language: string) => [...appleSpeechKeys.all, 'status', language] as const,
};

export const transcriptionEngineKeys = {
  all: ['transcriptionEngine'] as const,
  current: () => [...transcriptionEngineKeys.all, 'current'] as const,
};

function parseSizeGb(size?: string): number | undefined {
  if (!size) return undefined;
  const match = size.match(/^([\d.]+)\s*(GB|MB|KB|B)?$/i);
  if (!match) return undefined;
  const value = parseFloat(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase();
  if (unit === 'GB') return value;
  if (unit === 'MB') return value / 1024;
  if (unit === 'KB') return value / (1024 * 1024);
  return value / (1024 * 1024 * 1024);
}

export function useModels() {
  return useQuery({
    queryKey: modelsKeys.list(),
    queryFn: async (): Promise<{
      models: ListedModel[];
      current: string;
      provider: string;
      totalRamGb?: number;
    }> => {
      const raw = unwrap(await ipc().models.list());
      const models: ListedModel[] = Object.entries(raw.supported_models).map(([id, info]) => ({
        name: id,
        displayName: info.name,
        size_gb: parseSizeGb(info.size),
        installed: info.installed ?? false,
        current: id === raw.current_model,
        deprecated: info.deprecated,
        description: info.description,
        speed: info.speed,
        quality: info.quality,
        mlxTag: info.mlx_tag,
        mlxInstalled: info.mlx_installed,
        mlxSizeGb: parseSizeGb(info.mlx_size),
        ggufInstalled: info.gguf_installed,
      }));
      return {
        models,
        current: raw.current_model,
        provider: raw.provider,
        totalRamGb: raw.total_ram_gb,
      };
    },
  });
}

export function useCurrentModel() {
  return useQuery({
    queryKey: modelsKeys.current(),
    queryFn: async () => unwrap(await ipc().models.getCurrent()).model,
  });
}

export function useOllamaStatus() {
  return useQuery({
    queryKey: modelsKeys.ollama(),
    queryFn: async () => unwrap(await ipc().models.checkOllama()),
  });
}

export function useSetCurrentModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => unwrap(await ipc().models.set(name)),
    onMutate: async (name) => {
      await qc.cancelQueries({ queryKey: modelsKeys.current() });
      const previous = qc.getQueryData(modelsKeys.current());
      qc.setQueryData(modelsKeys.current(), name);
      return { previous };
    },
    onError: (_err, _name, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(modelsKeys.current(), ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: modelsKeys.all }),
  });
}

// Shared by usePullModel and useSwitchToFasterBuild: both parse the same
// "<status> <pct>% (<completed>/<total>)" progress string (see pull_model's
// print format in simple_recorder.py) into a live bytes/sec figure, keyed by
// model so multiple downloads can be tracked independently.
function useByteRateTracker() {
  const [bytesPerSecond, setBytesPerSecond] = React.useState<Record<string, number>>({});
  const rateSamplesRef = React.useRef<Record<string, { bytes: number; at: number }>>({});

  const sample = (model: string, progress: string) => {
    const byteMatch = progress.match(/\((\d+)\/(\d+)\)/);
    if (!byteMatch) return;
    const completed = Number(byteMatch[1]);
    const now = Date.now();
    const prevSample = rateSamplesRef.current[model];
    if (prevSample && now > prevSample.at && completed >= prevSample.bytes) {
      const rate = (completed - prevSample.bytes) / ((now - prevSample.at) / 1000);
      setBytesPerSecond((prev) => ({ ...prev, [model]: rate }));
    }
    rateSamplesRef.current[model] = { bytes: completed, at: now };
  };

  const drop = (model: string) => {
    delete rateSamplesRef.current[model];
    setBytesPerSecond((prev) => {
      const { [model]: _drop, ...rest } = prev;
      return rest;
    });
  };

  return { bytesPerSecond, sample, drop };
}

export function usePullModel() {
  const qc = useQueryClient();
  const [progress, setProgress] = React.useState<Record<string, string>>({});
  // `name` is the canonical GGUF id -- what models.set() must receive once
  // the pull succeeds. `pullTarget` is what was actually requested from
  // Ollama, which on Apple Silicon is the NVFP4 sibling (see pullAndSelect
  // below) -- IPC progress/completion events report THAT string, so
  // matching against it (not `name`) is what lets this resolve correctly.
  const [pendingSelect, setPendingSelect] = React.useState<{
    name: string;
    pullTarget: string;
  } | null>(null);
  const rate = useByteRateTracker();

  React.useEffect(() => {
    const offProgress = ipc().on.modelPullProgress(({ model, progress: p }) => {
      setProgress((prev) => ({ ...prev, [model]: p }));
      rate.sample(model, p);
    });
    const offComplete = ipc().on.modelPullComplete(async ({ model, success }) => {
      setProgress((prev) => {
        const { [model]: _drop, ...rest } = prev;
        return rest;
      });
      rate.drop(model);
      // Clear pendingSelect on ANY outcome for its own pullTarget, not just
      // success -- modelPullComplete is a global event with no per-hook
      // filtering, so a stale pendingSelect left behind by a cancelled/failed
      // pull could otherwise be matched later by an unrelated pull of the
      // same tag (e.g. a "switch to faster build" for the same model),
      // silently calling models.set() for a selection change nothing asked for.
      if (pendingSelect?.pullTarget === model) {
        if (success) {
          await ipc().models.set(pendingSelect.name);
        }
        setPendingSelect(null);
      }
      qc.invalidateQueries({ queryKey: modelsKeys.all });
    });
    return () => {
      offProgress();
      offComplete();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, pendingSelect]);

  // `pullTarget` defaults to `name` (the pre-existing behavior) for callers
  // that don't need MLX resolution (e.g. off Apple Silicon, or no MLX
  // equivalent exists for this model).
  const pullAndSelect = async ({ name, pullTarget }: { name: string; pullTarget: string }) => {
    setPendingSelect({ name, pullTarget });
    unwrap(await ipc().models.pull(pullTarget));
  };

  const mutation = useMutation({
    mutationFn: pullAndSelect,
  });

  const cancel = (pullTarget: string) => {
    void ipc().models.cancelPull(pullTarget);
  };

  return { ...mutation, progress, bytesPerSecond: rate.bytesPerSecond, cancel };
}

// ---------------------------------------------------------------------------
// "Switch to faster build" -- pulls a model's NVFP4/MLX sibling, smoke-tests
// it, and (on success) leaves it to the caller to offer deleting the old
// GGUF tag. Deliberately does NOT call models.set() -- config.json already
// points at the canonical GGUF id, and src/summarizer.py resolves it to the
// MLX tag at runtime on Apple Silicon. See docs/superpowers/specs/
// 2026-07-01-ollama-mlx-tag-adoption-design.md.
// ---------------------------------------------------------------------------

export type SwitchToFasterBuildState = 'idle' | 'pulling' | 'verifying' | 'done' | 'error';

export function useSwitchToFasterBuild(onVerified?: (mlxTag: string) => void) {
  const qc = useQueryClient();
  const [state, setState] = React.useState<SwitchToFasterBuildState>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [activeTag, setActiveTag] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<Record<string, string>>({});

  // activeTag is mirrored into a ref so the event listeners below (subscribed
  // exactly once, on mount) always read the CURRENT tag rather than the value
  // captured when the effect last ran. Without this, switchTo() below sets
  // activeTag and immediately fires the pull in the same tick; a completion
  // event racing the effect's re-subscription (before React has committed the
  // new activeTag into this closure) would otherwise be silently dropped by
  // the `model !== activeTag` check.
  const activeTagRef = React.useRef<string | null>(null);
  const onVerifiedRef = React.useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const rate = useByteRateTracker();

  // Shared by the live model-pull-complete listener and the on-mount
  // rehydration effect below -- both need to react identically to a pull's
  // terminal outcome (drop progress tracking, verify on success, surface the
  // error otherwise), the only difference being whether the outcome arrived
  // as a live event or was discovered after the fact via getActivePulls().
  // Only closes over stable setters/refs, so it's safe for the once-run
  // effects to capture the copy from their first render.
  const handlePullOutcome = async (
    model: string,
    success: boolean,
    pullError?: string,
    cancelled?: boolean
  ) => {
    setProgress((prev) => {
      const { [model]: _drop, ...rest } = prev;
      return rest;
    });
    rate.drop(model);
    if (cancelled) {
      // A user-initiated cancel isn't a failure -- go back to the plain
      // "Switch to faster build" prompt rather than an error state.
      ipc().models.ackPullComplete(model);
      setState('idle');
      setError(null);
      setActiveTag(null);
      activeTagRef.current = null;
      return;
    }
    if (!success) {
      ipc().models.ackPullComplete(model);
      setState('error');
      setError(pullError ?? 'Failed to download the faster build.');
      return;
    }
    setState('verifying');
    const verifyResult = await ipc().models.verify(model);
    // Deferred until after verify (not right after the download) so that
    // navigating away mid-verify and back replays this whole outcome --
    // including a redundant but harmless re-verify -- on the new mount,
    // instead of the completedPulls entry already being consumed and the
    // "offer to delete the old build" (onVerified) never firing for anyone.
    ipc().models.ackPullComplete(model);
    if (verifyResult.success) {
      setState('done');
      qc.invalidateQueries({ queryKey: modelsKeys.all });
      onVerifiedRef.current?.(model);
    } else {
      setState('error');
      setError(verifyResult.error ?? "Couldn't verify the faster build.");
    }
  };

  React.useEffect(() => {
    const offProgress = ipc().on.modelPullProgress(({ model, progress: p }) => {
      setProgress((prev) => ({ ...prev, [model]: p }));
      rate.sample(model, p);
    });
    const offComplete = ipc().on.modelPullComplete(
      ({ model, success, error: pullError, cancelled: wasCancelled }) => {
        if (model !== activeTagRef.current) return;
        void handlePullOutcome(model, success, pullError, wasCancelled);
      }
    );
    return () => {
      offProgress();
      offComplete();
    };
    // Empty deps: subscribe once. activeTagRef (not activeTag state) is what
    // the listeners consult, so they never need to be re-subscribed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount, ask the main process whether a switch-to-faster-build download
  // is already running from before this component (re)mounted -- e.g. the
  // user navigated away from Settings and back. The download itself lives in
  // the main process and keeps going regardless of what the renderer does;
  // without this rehydration, the UI would show "Switch to faster build" as
  // if nothing were happening until the user clicked it again. Filtered to
  // "-nvfp4" tags so a regular (non-faster-build) model download in progress
  // elsewhere in the app isn't mistaken for one of ours.
  React.useEffect(() => {
    let cancelled = false;
    void ipc()
      .models.getActivePulls()
      .then((pulls) => {
        if (cancelled) return;
        const activeEntry = Object.entries(pulls).find(([model]) => model.endsWith('-nvfp4'));
        if (!activeEntry) return;
        const [model, entry] = activeEntry;
        setActiveTag(model);
        activeTagRef.current = model;
        if (entry.done) {
          // The pull finished while this component was unmounted (e.g. the
          // user navigated away from Settings mid-download), so the live
          // model-pull-complete listener never ran for it. Replay the same
          // outcome handling now instead of showing "Switch to faster
          // build" as if nothing had happened.
          void handlePullOutcome(model, Boolean(entry.success), entry.error, entry.cancelled);
          return;
        }
        setState('pulling');
        const progressValue = entry.progress ?? '';
        setProgress((prev) => ({ ...prev, [model]: progressValue }));
        rate.sample(model, progressValue);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTo = (mlxTag: string) => {
    setState('pulling');
    setError(null);
    setActiveTag(mlxTag);
    activeTagRef.current = mlxTag;
    void ipc().models.pull(mlxTag);
  };

  const reset = () => {
    setState('idle');
    setError(null);
    setActiveTag(null);
    activeTagRef.current = null;
  };

  // Only meaningful while state === 'pulling' -- the actual state reset
  // happens when the resulting model-pull-complete(cancelled: true) event
  // arrives via handlePullOutcome, not optimistically here.
  const cancel = () => {
    if (!activeTagRef.current) return;
    void ipc().models.cancelPull(activeTagRef.current);
  };

  return {
    state,
    error,
    activeTag,
    progress: activeTag ? progress[activeTag] : undefined,
    bytesPerSecond: activeTag ? rate.bytesPerSecond[activeTag] : undefined,
    switchTo,
    reset,
    cancel,
  };
}

export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tag: string) => {
      const result = await ipc().models.delete(tag);
      if (!result.success) throw new Error(result.error ?? 'Failed to delete the old build.');
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: modelsKeys.all }),
  });
}

// ---------------------------------------------------------------------------
// Whisper models (mirrors the Ollama pattern above)
// ---------------------------------------------------------------------------

export function useWhisperModels() {
  return useQuery({
    queryKey: whisperKeys.list(),
    queryFn: async (): Promise<{ models: ListedModel[]; current: string }> => {
      const raw = unwrap(await ipc().whisperModels.list());
      const models: ListedModel[] = Object.entries(raw.supported_models).map(([id, info]) => ({
        name: id,
        displayName: info.name,
        size_gb: parseSizeGb(info.size),
        installed: info.installed ?? false,
        current: id === raw.current_model,
        deprecated: info.deprecated,
        description: info.description,
        speed: info.speed,
        quality: info.quality,
      }));
      return { models, current: raw.current_model };
    },
  });
}

export function useSetWhisperModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => unwrap(await ipc().whisperModels.set(name)),
    onSuccess: () => qc.invalidateQueries({ queryKey: whisperKeys.all }),
  });
}

export function usePullWhisperModel() {
  const qc = useQueryClient();
  const [progress, setProgress] = React.useState<Record<string, string>>({});
  const [pendingSelect, setPendingSelect] = React.useState<string | null>(null);

  React.useEffect(() => {
    const offProgress = ipc().on.whisperPullProgress(({ model, progress: p }) => {
      setProgress((prev) => ({ ...prev, [model]: p }));
    });
    const offComplete = ipc().on.whisperPullComplete(async ({ model, success }) => {
      setProgress((prev) => {
        const { [model]: _drop, ...rest } = prev;
        return rest;
      });
      if (success && pendingSelect === model) {
        await ipc().whisperModels.set(model);
        await ipc().transcriptionEngine.set('whisper');
        setPendingSelect(null);
      }
      qc.invalidateQueries({ queryKey: whisperKeys.all });
      qc.invalidateQueries({ queryKey: transcriptionEngineKeys.all });
    });
    return () => {
      offProgress();
      offComplete();
    };
  }, [qc, pendingSelect]);

  const pullAndSelect = async (name: string) => {
    setPendingSelect(name);
    unwrap(await ipc().whisperModels.pull(name));
  };

  const mutation = useMutation({
    mutationFn: pullAndSelect,
  });

  return { ...mutation, progress };
}

// ---------------------------------------------------------------------------
// Parakeet models — same shape as the Whisper hooks above so the unified
// TranscriptionModelList can fold both lists with identical card-action wiring.
// ---------------------------------------------------------------------------

export function useParakeetModels() {
  return useQuery({
    queryKey: parakeetKeys.list(),
    queryFn: async (): Promise<{ models: ListedModel[]; current: string }> => {
      const raw = unwrap(await ipc().parakeetModels.list());
      const models: ListedModel[] = Object.entries(raw.supported_models).map(([id, info]) => ({
        name: id,
        displayName: info.name,
        size_gb: parseSizeGb(info.size),
        installed: info.installed ?? false,
        current: id === raw.current_model,
        deprecated: info.deprecated,
        description: info.description,
        speed: info.speed,
        quality: info.quality,
      }));
      return { models, current: raw.current_model };
    },
  });
}

export function usePullParakeetModel() {
  const qc = useQueryClient();
  // Parakeet only has the one model today, but keyed-by-id state still
  // matches the Whisper hook shape so the UI doesn't fork on engine.
  const [progress, setProgress] = React.useState<Record<string, string>>({});
  const [pendingSelect, setPendingSelect] = React.useState<string | null>(null);

  React.useEffect(() => {
    const offProgress = ipc().on.parakeetPullProgress(({ model, stage }) => {
      // Coarse staged progress ("downloading"/"loading") rather than a
      // percentage — see src/parakeet_models.py for rationale. UI shows
      // a localised label per stage.
      const key = model ?? 'mlx-community/parakeet-tdt-0.6b-v3';
      setProgress((prev) => ({ ...prev, [key]: stage }));
    });
    const offComplete = ipc().on.parakeetPullComplete(async ({ model, success }) => {
      const key = model ?? 'mlx-community/parakeet-tdt-0.6b-v3';
      setProgress((prev) => {
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
      if (success && pendingSelect === key) {
        // Same coercion as an explicit switch: auto-selecting Parakeet after a
        // download must not leave a Whisper-only pin (e.g. 'ja') in config.
        await coerceLanguageForParakeet();
        await ipc().transcriptionEngine.set('parakeet');
        setPendingSelect(null);
        // Coercion may have reset the pin to 'auto'; refresh the language query
        // so the Settings dropdown + live dock toggle don't show the stale
        // pre-coercion code. Mirrors useSetActiveTranscription's onSuccess.
        qc.invalidateQueries({ queryKey: ['settings', 'language'] });
      }
      qc.invalidateQueries({ queryKey: parakeetKeys.all });
      qc.invalidateQueries({ queryKey: transcriptionEngineKeys.all });
    });
    return () => {
      offProgress();
      offComplete();
    };
  }, [qc, pendingSelect]);

  const pullAndSelect = async (id: string) => {
    setPendingSelect(id);
    unwrap(await ipc().parakeetModels.pull(id));
  };

  const mutation = useMutation({
    mutationFn: pullAndSelect,
  });

  return { ...mutation, progress };
}

export function useAppleSpeechStatus(language = 'auto') {
  return useQuery({
    queryKey: appleSpeechKeys.status(language),
    queryFn: async () => unwrap(await ipc().appleSpeech.status(language)),
  });
}

export function usePrepareAppleSpeech() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (language: string = 'auto') =>
      unwrap(await ipc().appleSpeech.prepare(language)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: appleSpeechKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Active ASR engine — the toggle that gates which engine the live VAD pipeline
// and the post-stop batch transcriber load.
// ---------------------------------------------------------------------------

export function useTranscriptionEngine() {
  return useQuery({
    queryKey: transcriptionEngineKeys.current(),
    queryFn: async (): Promise<TranscriptionEngine> => {
      const raw = unwrap(await ipc().transcriptionEngine.get());
      return raw.engine;
    },
  });
}

/**
 * Apple SpeechTranscriber and Parakeet both provide live results. Whisper is
 * post-stop only. Default to live while the query hydrates so the first paint
 * does not hide pause/reachability controls.
 */
export function useLiveTranscriptAvailable(): boolean {
  const engineQuery = useTranscriptionEngine();
  return (engineQuery.data ?? 'apple') !== 'whisper';
}

// Activating Parakeet must drop a pin Parakeet can't honour as an output
// language (a Whisper-only 'hi'/'ja'/…) back to 'auto' — otherwise the config
// and live-recording metadata keep a language outside PARAKEET_LANGUAGE_CODES.
// Default to 'auto' (not 'en') so the user's "detect / multi-language" intent
// survives. Shared by every Parakeet-activation path: the explicit engine
// switch (useSetActiveTranscription) and the post-download auto-select
// (usePullParakeetModel's complete handler).
async function coerceLanguageForEngine(
  supportedCodes: Readonly<Record<string, true>>
): Promise<string> {
  try {
    const current = unwrap(await ipc().settings.getLanguage()).language;
    if (supportedCodes[current] === true) return current;
    unwrap(await ipc().settings.setLanguage('auto'));
  } catch {
    // Best-effort: activation should still be able to report its own error.
  }
  return 'auto';
}

async function coerceLanguageForParakeet(): Promise<void> {
  await coerceLanguageForEngine(PARAKEET_LANGUAGE_CODES);
}

export function useSetActiveTranscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      engine,
      whisperModel,
    }: {
      engine: TranscriptionEngine;
      whisperModel?: string;
    }) => {
      if (engine === 'parakeet') {
        await coerceLanguageForParakeet();
      } else if (engine === 'apple') {
        const language = await coerceLanguageForEngine(APPLE_LANGUAGE_CODES);
        unwrap(await ipc().appleSpeech.prepare(language));
      }
      unwrap(await ipc().transcriptionEngine.set(engine));
      if (engine === 'whisper' && whisperModel) {
        unwrap(await ipc().whisperModels.set(whisperModel));
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: transcriptionEngineKeys.all });
      qc.invalidateQueries({ queryKey: whisperKeys.all });
      qc.invalidateQueries({ queryKey: parakeetKeys.all });
      qc.invalidateQueries({ queryKey: appleSpeechKeys.all });
      // Language might have been coerced; refresh the Settings dropdown
      // and the live dock toggle, both of which read from the same key.
      qc.invalidateQueries({ queryKey: ['settings', 'language'] });
    },
  });
}

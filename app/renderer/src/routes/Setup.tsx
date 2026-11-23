import {
  parakeetProgressLabel,
  parakeetProgressPercent,
  speakerModelsProgressLabel,
  speakerModelsProgressPercent,
} from '@/lib/parakeetProgress';
import type { ParakeetPullProgressEvent, SpeakerModelsProgressEvent } from '@/lib/ipc';
import { DownloadProgressBar } from '@/components/DownloadProgressBar';
import { Mascot } from '@/components/Mascot';
import { CookbookCover } from '@/components/cookbooks/CookbookCover';
import { OpenAiIcon } from '@/components/ui/openai-icon';
import { AnthropicIcon } from '@/components/ui/anthropic-icon';
import { speakerModelsStatusKey, useSpeakerModelsStatus } from '@/hooks/useSpeakerModels';
import { useQueryClient } from '@tanstack/react-query';
import { t } from '@/i18n';
import * as React from 'react';
import {
  ArrowLeft,
  AudioLines,
  Check,
  ChevronDown,
  Cloud,
  ExternalLink,
  HardDrive,
  Loader2,
  Mic,
  MessageSquare,
  Waypoints,
  Zap,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Display, Lead, Muted } from '@/components/ui/typography';
import { useNavigate } from '@/lib/router';
import { useCheckMicPermission, useRequestMicPermission, useSetupStep } from '@/hooks/useSetup';
import { useRecording } from '@/hooks/useRecording';
import {
  useLaunchOnLoginSetting,
  useMarkPrivacyNoticeSeen,
  useSetLaunchOnLogin,
  useSetTelemetry,
  useSetUserName,
  useTelemetrySetting,
  useUserName,
} from '@/hooks/useSettings';
import {
  aiKeys,
  useSetAiProvider,
  useSetCloudApiKey,
  useSetCloudModel,
  useSetCloudProvider,
  useTestCloudApi,
  useSetBedrockInferenceProfile,
  useSetBedrockRegion,
  useSetCloudApiUrl,
} from '@/hooks/useAi';
import { ipc, type CloudProvider } from '@/lib/ipc';
import { unwrap } from '@/lib/result';
import {
  cloudErrorKind,
  detectCloudProvider,
  GUIDED_PROVIDERS,
  isGuidedProvider,
  KEY_PAGE_URL,
  type CloudErrorKind,
  type GuidedProvider,
} from '@/lib/cloudKeys';
import { describeModel } from '@/lib/modelNames';
import { cn, isMac } from '@/lib/utils';

type StepStatus = 'waiting' | 'running' | 'done' | 'failed';
type StepId = 'microphone' | 'transcription' | 'speakers' | 'ollama';

interface Step {
  id: StepId;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  status: StepStatus;
  detail?: string;
  /** Optional download-progress affordance rendered under the detail line
   *  while the step is running (see the transcription/summarization steps). */
  progressNode?: React.ReactNode;
}

/** The three screens of onboarding. The background downloads keep running
 *  whichever one is showing. */
type Stage = 'you' | 'engine' | 'ready';
const STAGES: readonly Stage[] = ['you', 'engine', 'ready'];

const PROVIDER_NAME: Record<CloudProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  bedrock: 'AWS Bedrock',
  custom: 'Custom endpoint',
};

function ProviderIcon({ provider, size = 16 }: { provider: GuidedProvider; size?: number }) {
  if (provider === 'openai') return <OpenAiIcon size={size} />;
  if (provider === 'anthropic') return <AnthropicIcon size={size} />;
  return <Waypoints style={{ width: size, height: size }} aria-hidden="true" />;
}

const PROVIDER_GUIDE: Record<GuidedProvider, { tagline: string; steps: string[] }> = {
  openrouter: {
    tagline: t('setup.cloud.openrouter.tagline'),
    steps: [t('setup.cloud.openrouter.step1'), t('setup.cloud.openrouter.step2'), t('setup.cloud.openrouter.step3')],
  },
  openai: {
    tagline: t('setup.cloud.openai.tagline'),
    steps: [t('setup.cloud.openai.step1'), t('setup.cloud.openai.step2'), t('setup.cloud.openai.step3')],
  },
  anthropic: {
    tagline: t('setup.cloud.anthropic.tagline'),
    steps: [t('setup.cloud.anthropic.step1'), t('setup.cloud.anthropic.step2'), t('setup.cloud.anthropic.step3')],
  },
};

function cloudErrorMessage(kind: CloudErrorKind, provider: string, message: string): string {
  if (kind === 'invalid_key') return t('setup.cloud.error.invalidKey', { provider });
  if (kind === 'no_credit') return t('setup.cloud.error.noCredit', { provider });
  if (kind === 'network') return t('setup.cloud.error.network', { provider });
  return t('setup.cloud.error.unknown', { provider, message });
}

/** Result of the live key test on the "How Steno thinks" screen. A success is
 *  only valid for the exact key + provider it was made with. */
type Connection =
  | { state: 'idle' }
  | { state: 'testing'; key: string; provider: CloudProvider }
  | { state: 'ok'; key: string; provider: CloudProvider; model: string; warning?: 'no_credit' }
  | { state: 'error'; key: string; provider: CloudProvider; message: string };

/** Real byte-progress bar for the local summarization-model download. Ollama
 *  streams per-blob progress, so `pct` can step back toward 0 as each new layer
 *  begins - the status label carries the current phase so the bar never reads
 *  as a single misleading aggregate. */
function OllamaProgressBar({ status, pct }: { status: string; pct: number }) {
  return (
    <DownloadProgressBar
      data-setup-ollama-progress
      label={status || t('setup.ollama.downloadingFallback')}
      percent={pct}
      aria-label={t('downloads.ollama.ariaLabel')}
    />
  );
}

/** Activity indicator with measured details in the label; no estimated percentage. */
function IndeterminateBar({ label, kind = 'transcription' }: { label: string; kind?: 'transcription' | 'speakers' }) {
  return (
    <div
      className="mt-2"
      data-setup-transcription-progress={kind === 'transcription' ? '' : undefined}
      data-setup-speaker-progress={kind === 'speakers' ? '' : undefined}
    >
      <div className="mb-1 text-[11px] text-muted-foreground">{label}</div>
      <div
        className="setup-indeterminate-bar relative h-1.5 overflow-hidden rounded-full"
        style={{ background: 'var(--surface-sunken)' }}
        role="progressbar"
        aria-label={label}
      />
    </div>
  );
}

function Badge({ status }: { status: StepStatus }) {
  const label =
    status === 'waiting'
      ? t('setup.status.waiting')
      : status === 'running'
        ? t('setup.status.running')
        : status === 'done'
          ? t('setup.status.done')
          : t('setup.status.failed');
  const cls =
    status === 'done'
      ? 'bg-muted text-foreground'
      : status === 'running'
        ? 'bg-foreground text-background'
        : status === 'failed'
          ? 'bg-destructive text-destructive-foreground'
          : 'bg-transparent text-muted-foreground border border-border';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

function StepCard({ step }: { step: Step }) {
  const Icon = step.icon;
  return (
    <div
      className="flex items-center gap-4 px-5 py-4"
      data-setup-step={step.id}
      data-setup-status={step.status}
    >
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full',
          step.status === 'done'
            ? 'bg-foreground text-background'
            : step.status === 'failed'
              ? 'bg-destructive text-destructive-foreground'
              : 'bg-muted text-foreground',
        )}
      >
        {step.status === 'done' ? (
          <Check className="size-5" />
        ) : step.status === 'failed' ? (
          <X className="size-5" />
        ) : step.status === 'running' ? (
          <Loader2 className="size-5 motion-safe:animate-spin" />
        ) : (
          <Icon className="size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium text-foreground">{step.title}</div>
          <Badge status={step.status} />
        </div>
        <Muted className="mt-0.5">{step.detail ?? step.description}</Muted>
        {step.progressNode}
      </div>
    </div>
  );
}

/** A soft, raised card in the app's paper style. */
function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('overflow-hidden rounded-[16px] border', className)}
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-sm)',
      }}
      {...props}
    />
  );
}

/** One preference row inside a Panel (label + hint on the left, control right). */
function PrefRow({
  title,
  hint,
  htmlFor,
  children,
  ...rest
}: {
  title: string;
  hint: string;
  htmlFor?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="flex items-center gap-4 px-5 py-4" {...rest}>
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
            {title}
          </label>
        ) : (
          <div className="text-sm font-medium text-foreground">{title}</div>
        )}
        <Muted className="mt-0.5 text-[12.5px]">{hint}</Muted>
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="mx-5 h-px" style={{ background: 'var(--border-subtle)' }} />;
}

function Stepper({
  stage,
  onSelect,
  canSelect,
}: {
  stage: Stage;
  onSelect: (s: Stage) => void;
  canSelect: (s: Stage) => boolean;
}) {
  const labels: Record<Stage, string> = {
    you: t('setup.stage.you'),
    engine: t('setup.stage.engine'),
    ready: t('setup.stage.ready'),
  };
  const current = STAGES.indexOf(stage);
  return (
    <ol
      className="mb-8 flex items-center justify-center gap-2 text-[12.5px]"
      aria-label={t('setup.stage.ariaLabel')}
      data-setup-stepper
    >
      {STAGES.map((s, i) => {
        const state = i < current ? 'complete' : i === current ? 'current' : 'upcoming';
        const selectable = s !== stage && canSelect(s);
        return (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && (
              <span
                aria-hidden="true"
                className="h-px w-6 sm:w-10"
                style={{ background: i <= current ? 'var(--fg-1)' : 'var(--border-strong, var(--border))' }}
              />
            )}
            <button
              type="button"
              disabled={!selectable}
              onClick={() => onSelect(s)}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full px-1.5 py-1 transition-colors',
                selectable ? 'cursor-pointer hover:bg-muted' : 'cursor-default',
                state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums',
                  state === 'complete' && 'border-foreground bg-foreground text-background',
                  state === 'current' && 'border-foreground',
                  state === 'upcoming' && 'border-border',
                )}
              >
                {state === 'complete' ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className={state === 'current' ? 'font-medium' : undefined}>{labels[s]}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The "How Steno thinks" choice: a big card with a strip of cover art. */
function EngineCard({
  selected,
  onSelect,
  icon: Icon,
  title,
  line,
  meta,
  seed,
  tone,
  ...rest
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  line: string;
  meta: string;
  seed: string;
  tone: 'sage' | 'sky';
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'>) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'group flex flex-col overflow-hidden rounded-[16px] border text-left',
        'motion-safe:transition-[box-shadow,border-color,transform] motion-safe:duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-foreground' : 'border-[color:var(--border-subtle)] hover:border-[color:var(--border-strong)]',
      )}
      style={{
        background: 'var(--surface-raised)',
        boxShadow: selected ? 'var(--shadow-md)' : 'var(--shadow-sm)',
      }}
      {...rest}
    >
      <CookbookCover seedId={seed} category="everyday" tone={tone} shape="wide" className="h-16 w-full" />
      <div className="flex flex-1 flex-col gap-1 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[15px] font-medium text-foreground">
            <Icon className="size-4" />
            {title}
          </div>
          <span
            aria-hidden="true"
            className={cn(
              'flex size-5 items-center justify-center rounded-full border',
              selected ? 'border-foreground bg-foreground text-background' : 'border-border',
            )}
          >
            {selected && <Check className="size-3" />}
          </span>
        </div>
        <div className="text-[13px] text-foreground">{line}</div>
        <Muted className="text-[12px]">{meta}</Muted>
      </div>
    </button>
  );
}

export function Setup() {
  const navigate = useNavigate();
  const recording = useRecording();
  const [stage, setStage] = React.useState<Stage>('you');
  const [statuses, setStatuses] = React.useState<Record<StepId, StepStatus>>({
    microphone: 'waiting',
    transcription: 'waiting',
    speakers: 'waiting',
    ollama: 'waiting',
  });
  // Mirror of `statuses` for the background tasks, which outlive the render
  // that started them and must not branch on a stale snapshot.
  const statusRef = React.useRef(statuses);
  const [details, setDetails] = React.useState<Record<StepId, string | undefined>>({
    microphone: undefined,
    transcription: undefined,
    speakers: undefined,
    ollama: undefined,
  });
  const [running, setRunning] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [debugOpen, setDebugOpen] = React.useState(false);
  const [logs, setLogs] = React.useState<string[]>([]);
  // Live download progress surfaced on the step cards. Parakeet only exposes a
  // measured file progress (indeterminate bar); Ollama streams byte-level percent.
  const [parakeetStage, setParakeetStage] = React.useState<ParakeetPullProgressEvent | null>(null);
  const [ollamaProgress, setOllamaProgress] = React.useState<{
    status: string;
    pct: number;
  } | null>(null);
  const [speakerProgress, setSpeakerProgress] = React.useState<SpeakerModelsProgressEvent | null>(null);
  // Speaker separation is opt-in: its models are an extra ~250 MB most people
  // can skip, and Settings -> AI offers the same download later.
  const [includeSpeakers, setIncludeSpeakers] = React.useState(false);
  // Models already on disk (e.g. downloaded from Settings): show it on --
  // unless the user has already flipped the switch themselves, since the
  // status check can take a few seconds to answer.
  const speakerStatus = useSpeakerModelsStatus();
  const speakersInstalled = isMac && speakerStatus.data?.success === true && speakerStatus.data.ready;
  const speakerSwitchTouched = React.useRef(false);
  React.useEffect(() => {
    if (speakersInstalled && !speakerSwitchTouched.current) setIncludeSpeakers(true);
  }, [speakersInstalled]);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.stenoai) return;
    return ipc().on.debugLog((line) => {
      setLogs((prev) => {
        const next = [...prev, line];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });
  }, []);

  // Subscribe once to the onboarding download-progress events. These are the
  // setup-specific channels (distinct from the Settings model-management pull
  // events) emitted by main.js 'setup-parakeet' / 'setup-ollama-and-model'.
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.stenoai) return;
    const offParakeet = ipc().on.parakeetPullProgress((progress) => {
      const { model } = progress;
      // Both the setup-parakeet flow and the Settings model-management pull
      // emit on the shared 'parakeet-pull-progress' channel. Settings pulls
      // carry a `model` id; the setup handler emits only { stage }. Ignore
      // model-bearing events so the wizard bar can't reflect an unrelated
      // Settings pull.
      if (model != null) return;
      setParakeetStage(progress);
    });
    const offOllama = ipc().on.setupOllamaProgress(({ status, pct }) => {
      setOllamaProgress({ status, pct });
    });
    const offSpeakers = ipc().on.speakerModelsProgress((progress) => {
      setSpeakerProgress(progress);
    });
    return () => {
      offParakeet();
      offOllama();
      offSpeakers();
    };
  }, []);

  const checkMic = useCheckMicPermission();
  const requestMic = useRequestMicPermission();
  // Installs Parakeet TDT v3 by default — the active engine for fresh
  // installs. Size differs by backend (MLX ~2.5 GB on mac, ONNX int8 ~670 MB
  // on Windows/Linux). Existing Whisper users are skipped past this step
  // once we see their model is already on disk; see the parakeet-status +
  // list-whisper-models precheck in runTranscription().
  const parakeetStep = useSetupStep('parakeet');
  const speakerModelsStep = useSetupStep('speakerModels');
  const ollamaStep = useSetupStep('ollamaAndModel');

  // Telemetry choice surfaced here so users opt in/out during onboarding
  // instead of having to find Settings → Advanced afterwards. Persists
  // immediately via the same backend used by the Settings page.
  const telemetry = useTelemetrySetting();
  const setTelemetry = useSetTelemetry();
  const telemetryEnabled = telemetry.data?.telemetry_enabled ?? true;

  // Launch-on-login disclosed here too (defaults ON) so onboarding fully
  // discloses the two default-on behaviours; both persist immediately via the
  // same backend the Settings page uses.
  const launchOnLogin = useLaunchOnLoginSetting();
  const setLaunchOnLogin = useSetLaunchOnLogin();
  const launchOnLoginEnabled = launchOnLogin.data ?? true;

  // Onboarding discloses telemetry + launch-on-login, so mark the one-time
  // privacy notice seen on the way out. Without this, an upgrader who had a
  // config but no model (so they were routed here) would land on Home and get
  // the consent modal a second time for the same toggles. Idempotent — a fresh
  // install is already seen. Navigate regardless so a persist hiccup never
  // traps the user in Setup. The shared hook flips the gate query synchronously
  // on success so the consent modal can't flash on the way home.
  const { mutateAsync: markPrivacyNoticeSeen } = useMarkPrivacyNoticeSeen();
  const finishOnboarding = React.useCallback(async () => {
    try {
      await markPrivacyNoticeSeen();
    } catch {
      // best-effort; the consent modal is a soft disclosure, not a gate
    } finally {
      navigate('/');
    }
  }, [markPrivacyNoticeSeen, navigate]);

  const { startRecording } = recording;
  const startFirstNote = React.useCallback(async () => {
    await finishOnboarding();
    void startRecording();
  }, [finishOnboarding, startRecording]);

  // First name powers the in-app greeting ("Hi <name>, ask anything"). Stored
  // locally only — never sent anywhere. Persisted on blur to avoid a write
  // per keystroke.
  const userName = useUserName();
  const setUserName = useSetUserName();
  const [name, setName] = React.useState('');
  // Sync once when the initial fetch resolves so we don't clobber user input.
  // Wait for the real query to settle — placeholderData (sessionStorage cache)
  // could be stale or empty, and we don't want to seed from it and then ignore
  // the canonical value when it arrives from disk.
  const [seeded, setSeeded] = React.useState(false);
  if (
    !seeded &&
    !userName.isPending &&
    !userName.isPlaceholderData &&
    userName.data !== undefined
  ) {
    setName(userName.data);
    setSeeded(true);
  }
  const persistName = () => {
    const trimmed = name.trim();
    if (trimmed === (userName.data ?? '')) return;
    setUserName.mutate(trimmed);
  };

  // Summarization-engine choice. 'local' downloads the bundled model
  // (privacy + free, slower); 'cloud' wires up an API key (no download)
  // and the third install step only saves the choice.
  type SummaryMode = 'local' | 'cloud';
  const [summaryMode, setSummaryMode] = React.useState<SummaryMode>('local');
  const [cloudProvider, setCloudProviderChoice] = React.useState<CloudProvider>('openrouter');
  const [cloudApiKey, setCloudApiKey] = React.useState('');
  const [otherProvidersOpen, setOtherProvidersOpen] = React.useState(false);

  const [bedrockRegion, setBedrockRegionState] = React.useState('');
  const [bedrockProfile, setBedrockProfileState] = React.useState('');
  const [apiUrl, setApiUrl] = React.useState('');
  const [connection, setConnection] = React.useState<Connection>({ state: 'idle' });

  const setAiProvider = useSetAiProvider();
  const setCloudProviderMut = useSetCloudProvider();
  const setCloudKeyMut = useSetCloudApiKey();
  const setCloudModelMut = useSetCloudModel();
  const testCloudApi = useTestCloudApi();
  const setBedrockRegion = useSetBedrockRegion();
  const setBedrockProfile = useSetBedrockInferenceProfile();
  const setCloudUrl = useSetCloudApiUrl();

  const trimmedKey = cloudApiKey.trim();
  const connectionCurrent =
    connection.state !== 'idle' && connection.key === trimmedKey && connection.provider === cloudProvider;
  const connected = connection.state === 'ok' && connectionCurrent;
  const cloudFieldsReady = (() => {
    if (!trimmedKey) return false;
    if (cloudProvider === 'bedrock') return bedrockRegion.trim().length > 0;
    if (cloudProvider === 'custom') return apiUrl.trim().length > 0;
    return true;
  })();
  const canBegin = summaryMode === 'local' || connected;

  const setStatus = (id: StepId, s: StepStatus, detail?: string) => {
    statusRef.current = { ...statusRef.current, [id]: s };
    setStatuses((prev) => ({ ...prev, [id]: s }));
    if (detail !== undefined) setDetails((prev) => ({ ...prev, [id]: detail }));
  };

  // ---- background work ---------------------------------------------------
  // The speech model (and, when opted in, the speaker models) start as soon as
  // the person leaves the first screen, so they download while the AI engine
  // is being chosen. A task already in flight is shared rather than restarted.
  const transcriptionTask = React.useRef<Promise<boolean> | null>(null);
  const speakersTask = React.useRef<Promise<void> | null>(null);

  const runTranscription = async (): Promise<boolean> => {
    setStatus('transcription', 'running', t('setup.transcription.checking'));
    try {
      // Skip the install if any ASR engine is already on disk — covers
      // existing Whisper users running setup again and Parakeet users
      // rerunning to fix a different step.
      const [parakeetStatus, whisperList] = await Promise.all([
        ipc().parakeetModels.status(),
        ipc().whisperModels.list(),
      ]);
      const parakeetInstalled =
        parakeetStatus.success && parakeetStatus.installed === true;
      const anyWhisperInstalled =
        whisperList.success &&
        Object.values(whisperList.supported_models ?? {}).some(
          (m) => (m as { installed?: boolean }).installed === true,
        );
      if (parakeetInstalled || anyWhisperInstalled) {
        setStatus('transcription', 'done', t('setup.transcription.ready'));
        return true;
      }
      setStatus(
        'transcription',
        'running',
        t('setup.transcription.downloading', { size: isMac ? '~2.5 GB' : '~670 MB' }),
      );
      setParakeetStage({ stage: 'preparing' });
      await parakeetStep.mutateAsync();
      setParakeetStage(null);
      setStatus('transcription', 'done', t('setup.transcription.ready'));
      return true;
    } catch (err) {
      setParakeetStage(null);
      setStatus('transcription', 'failed', err instanceof Error ? err.message : t('setup.stepFailed'));
      return false;
    }
  };

  const ensureTranscription = (): Promise<boolean> => {
    if (statusRef.current.transcription === 'done') return Promise.resolve(true);
    if (!transcriptionTask.current) {
      transcriptionTask.current = runTranscription().finally(() => {
        transcriptionTask.current = null;
      });
    }
    return transcriptionTask.current;
  };

  const runSpeakers = async (): Promise<void> => {
    setStatus('speakers', 'running', t('setup.speakers.checking'));
    try {
      const status = await ipc().setup.speakerModelsStatus();
      if (!status.success) throw new Error(status.error);
      if (status.ready) {
        setStatus('speakers', 'done', t('setup.speakers.ready'));
        return;
      }
      setStatus('speakers', 'running', t('setup.speakers.downloading'));
      await speakerModelsStep.mutateAsync();
      setSpeakerProgress(null);
      // Settings reads the same cached status; don't let it show
      // Download for models that are now installed.
      void queryClient.invalidateQueries({ queryKey: speakerModelsStatusKey });
      setStatus('speakers', 'done', t('setup.speakers.ready'));
    } catch {
      // Optional: a failure here never blocks the rest of onboarding.
      setSpeakerProgress(null);
      setStatus('speakers', 'failed', t('setup.speakers.failed'));
    }
  };

  const ensureSpeakers = (): Promise<void> => {
    if (!isMac || !includeSpeakers || statusRef.current.speakers === 'done') return Promise.resolve();
    if (!speakersTask.current) {
      speakersTask.current = runSpeakers().finally(() => {
        speakersTask.current = null;
      });
    }
    return speakersTask.current;
  };

  const startBackgroundWork = () => {
    void ensureTranscription();
    void ensureSpeakers();
  };

  // ---- cloud key ---------------------------------------------------------
  const onKeyChange = (value: string) => {
    setCloudApiKey(value);
    // The key format names its provider; follow it, but only between the
    // guided providers - a Bedrock or custom endpoint key can look like
    // anything, including sk-.
    if (isGuidedProvider(cloudProvider)) {
      const detected = detectCloudProvider(value);
      if (detected && detected !== cloudProvider) setCloudProviderChoice(detected);
    }
  };

  const connect = async (keyOverride?: string) => {
    const key = (keyOverride ?? cloudApiKey).trim();
    if (!key) return;
    let provider = cloudProvider;
    if (isGuidedProvider(provider)) provider = detectCloudProvider(key) ?? provider;
    if (provider === 'bedrock' && !bedrockRegion.trim()) return;
    if (provider === 'custom' && !apiUrl.trim()) return;
    setConnection({ state: 'testing', key, provider });
    try {
      await setCloudProviderMut.mutateAsync(provider);
      if (provider === 'bedrock') {
        await setBedrockRegion.mutateAsync(bedrockRegion.trim());
        await setBedrockProfile.mutateAsync(bedrockProfile.trim());
      } else if (provider === 'custom') {
        await setCloudUrl.mutateAsync(apiUrl.trim());
      }
      await setCloudKeyMut.mutateAsync(key);
      // unwrap throws on { success: false }, so reaching the next line means
      // the provider accepted the key.
      const result = await testCloudApi.mutateAsync();
      const snapshot = unwrap(await ipc().ai.getProvider());
      let model = snapshot.cloud_model;
      const offered = result.models ?? [];
      // OpenRouter's picks are filtered to what it still serves; move off a
      // remembered model it no longer lists.
      if (provider === 'openrouter' && offered.length > 0 && !offered.includes(model)) {
        model = offered[0];
        await setCloudModelMut.mutateAsync(model);
      }
      void queryClient.invalidateQueries({ queryKey: aiKeys.provider() });
      setConnection({ state: 'ok', key, provider, model, warning: result.warning });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConnection({
        state: 'error',
        key,
        provider,
        message: cloudErrorMessage(cloudErrorKind(err), PROVIDER_NAME[provider], message),
      });
    }
  };

  // ---- the "Begin setup" run ---------------------------------------------
  const runSummarization = async (): Promise<boolean> => {
    // Always re-run on retry (the choice or key may have changed).
    setStatus('ollama', 'running', '');
    try {
      if (summaryMode === 'cloud') {
        setStatus('ollama', 'running', t('setup.ollama.savingCloud'));
        await setAiProvider.mutateAsync('cloud');
        ipc().analytics.track('ai_provider_selected', { provider: 'cloud' });
        // Defensive: Begin setup is gated on a live test, but a key edited
        // after the test must not slip through untested.
        if (!connected) throw new Error(t('setup.ollama.connectFirst'));
        setStatus('ollama', 'done', t('setup.ollama.connectedTo', { provider: PROVIDER_NAME[cloudProvider] }));
      } else {
        // Make sure provider is local in case the user previously had cloud
        // configured and is re-running the wizard to switch back.
        await setAiProvider.mutateAsync('local');
        ipc().analytics.track('ai_provider_selected', { provider: 'local' });
        setStatus('ollama', 'running', t('setup.ollama.downloading'));
        await ollamaStep.mutateAsync();
        setOllamaProgress(null);
        setStatus('ollama', 'done', t('setup.ollama.installed'));
      }
      return true;
    } catch (err) {
      setOllamaProgress(null);
      setStatus('ollama', 'failed', err instanceof Error ? err.message : t('setup.stepFailed'));
      return false;
    }
  };

  const runSetup = async () => {
    setStage('ready');
    setRunning(true);
    setDone(false);
    // Reset summarization progress left over from a previous (failed) run so
    // a retry starts from a clean bar rather than resuming a stale one. The
    // transcription/speaker bars belong to tasks that may still be running.
    setOllamaProgress(null);
    try {
      // Skipping completed steps keeps retries fast (no re-prompting for mic
      // permission, no re-initialising the model) when the user is just
      // fixing a bad API key.
      if (statusRef.current.microphone !== 'done') {
        setStatus('microphone', 'running', t('setup.mic.checking'));
        const existing = await checkMic.mutateAsync();
        if (existing === 'granted') {
          setStatus('microphone', 'done', t('setup.mic.granted'));
        } else {
          setStatus('microphone', 'running', t('setup.mic.requesting'));
          const granted = await requestMic.mutateAsync();
          if (granted) setStatus('microphone', 'done', t('setup.mic.granted'));
          else {
            setStatus(
              'microphone',
              'failed',
              isMac ? t('setup.mic.deniedMac') : t('setup.mic.deniedOther'),
            );
            return;
          }
        }
      }

      // The downloads run side by side: the speech model has usually been
      // going since the first screen, and the AI engine starts now.
      const [transcriptionOk, summarizationOk] = await Promise.all([
        ensureTranscription(),
        runSummarization(),
        ensureSpeakers(),
      ]);
      if (!transcriptionOk || !summarizationOk) return;

      // Fire unconditionally regardless of which path was taken above -- this
      // is the fix for the multi-month blind spot where the old setup
      // tracking only covered one of several wizard steps (see the July
      // product-analytics review, ACT·4). Calendar connection isn't part of
      // this wizard, but the status reads are cheap local file checks, so we
      // fold it in here rather than firing a separate event later.
      const [googleStatus, outlookStatus] = await Promise.all([
        ipc().calendar.google.status(),
        ipc().calendar.outlook.status(),
      ]);
      const calendarConnected =
        (googleStatus.success && googleStatus.connected) ||
        (outlookStatus.success && outlookStatus.connected);
      ipc().analytics.track('onboarding_completed', {
        ai_provider: summaryMode,
        calendar_connected: Boolean(calendarConnected),
      });

      setDone(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('setup.stepFailed');
      const failId = (Object.keys(statusRef.current) as StepId[]).find(
        (k) => statusRef.current[k] === 'running',
      );
      if (failId) setStatus(failId, 'failed', message);
    } finally {
      setRunning(false);
    }
  };

  const steps: Step[] = [
    {
      id: 'microphone',
      title: t('setup.mic.title'),
      description: t('setup.mic.description'),
      icon: Mic,
      status: statuses.microphone,
      detail: details.microphone,
    },
    {
      id: 'transcription',
      title: t('setup.transcription.title'),
      description: t('setup.transcription.description'),
      icon: MessageSquare,
      status: statuses.transcription,
      detail: details.transcription,
      progressNode:
        statuses.transcription === 'running' && parakeetStage !== null ? (
          parakeetProgressPercent(parakeetStage) !== null ? (
            <DownloadProgressBar
              data-setup-transcription-progress
              label={parakeetProgressLabel(parakeetStage)}
              percent={parakeetProgressPercent(parakeetStage)!}
              aria-label={t('downloads.parakeet.ariaLabel')}
            />
          ) : (
            <IndeterminateBar label={parakeetProgressLabel(parakeetStage)} />
          )
        ) : undefined,
    },
    {
      id: 'ollama',
      title: t('setup.ollama.title'),
      description:
        summaryMode === 'cloud' ? t('setup.ollama.descriptionCloud') : t('setup.ollama.descriptionLocal'),
      icon: summaryMode === 'cloud' ? Cloud : Zap,
      status: statuses.ollama,
      detail: details.ollama,
      progressNode:
        statuses.ollama === 'running' && ollamaProgress !== null ? (
          <OllamaProgressBar status={ollamaProgress.status} pct={ollamaProgress.pct} />
        ) : undefined,
    },
  ];

  if (isMac && includeSpeakers) {
    steps.splice(2, 0, {
      id: 'speakers',
      title: t('settings.ai.speakers.label'),
      description: t('setup.speakers.description'),
      icon: AudioLines,
      status: statuses.speakers,
      detail: details.speakers,
      progressNode:
        statuses.speakers === 'running' && speakerProgress !== null ? (
          <DownloadProgressBar
            data-setup-speaker-progress
            label={speakerModelsProgressLabel(speakerProgress)}
            percent={speakerModelsProgressPercent(speakerProgress)}
            aria-label={t('downloads.speakers.ariaLabel')}
          />
        ) : statuses.speakers === 'running' && details.speakers === t('setup.speakers.downloading') ? (
          <IndeterminateBar label={t('setup.speakers.preparing')} kind="speakers" />
        ) : undefined,
    });
  }

  const anyFailed = (Object.keys(statuses) as StepId[]).some((k) => statuses[k] === 'failed');
  // The engine choice can be revisited until it has been applied successfully.
  const canSelectStage = (s: Stage) => {
    if (running) return false;
    if (s === 'ready') return stage === 'ready' || statuses.ollama !== 'waiting';
    return statuses.ollama !== 'done';
  };

  const leaveWelcome = (next: Stage = 'engine') => {
    persistName();
    startBackgroundWork();
    setStage(next);
  };

  // Keyboard for the Local / Cloud radio group: arrows move the choice.
  const onEngineKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next: SummaryMode = summaryMode === 'local' ? 'cloud' : 'local';
    setSummaryMode(next);
    const target = e.currentTarget.querySelector<HTMLButtonElement>(`[data-engine="${next}"]`);
    target?.focus();
  };

  const transcriptionBusy = statuses.transcription === 'running';
  const connectedModel = connection.state === 'ok' ? describeModel(connection.model).name : '';

  return (
    <div className="min-h-screen bg-background text-foreground" data-setup-stage={stage}>
      <div className="mx-auto w-full max-w-[640px] px-4 pb-32 pt-12 sm:px-8">
        <header className="mb-6 text-center">
          <Mascot resting={stage !== 'you' || done} className="mb-4" testId="setup-mascot" />
          {stage === 'you' ? (
            <>
              <Display className="mb-3">{t('setup.hero.title')}</Display>
              <Lead className="mx-auto max-w-[460px]">{t('setup.hero.subtitle')}</Lead>
            </>
          ) : stage === 'engine' ? (
            <>
              <Display className="mb-3 text-[28px]">{t('setup.engine.title')}</Display>
              <Lead className="mx-auto max-w-[460px]">{t('setup.engine.subtitle')}</Lead>
            </>
          ) : done ? (
            <>
              <Display className="mb-3 text-[28px]">{t('setup.done.title')}</Display>
              <Lead className="mx-auto max-w-[460px]">{t('setup.done.subtitle')}</Lead>
            </>
          ) : (
            <>
              <Display className="mb-3 text-[28px]">{t('setup.ready.title')}</Display>
              <Lead className="mx-auto max-w-[460px]">{t('setup.ready.subtitle')}</Lead>
            </>
          )}
        </header>

        <Stepper
          stage={stage}
          onSelect={(next) => (stage === 'you' ? leaveWelcome(next) : setStage(next))}
          canSelect={canSelectStage}
        />

        <div key={stage} className="setup-stage-in">
          {stage === 'you' && (
            <>
              <Panel>
                <PrefRow
                  title={t('setup.name.label')}
                  hint={t('setup.name.hint')}
                  htmlFor="setup-name-input"
                  data-setup-name
                >
                  <Input
                    id="setup-name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={persistName}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        persistName();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    placeholder={t('setup.name.placeholder')}
                    autoComplete="given-name"
                    className="w-[160px]"
                  />
                </PrefRow>
                {isMac && (
                  <>
                    <Divider />
                    <PrefRow
                      title={t('setup.speakers.optInTitle')}
                      hint={t('setup.speakers.optInDescription')}
                      data-setup-speakers-opt-in
                    >
                      <Switch
                        checked={includeSpeakers}
                        onCheckedChange={(on) => {
                          speakerSwitchTouched.current = true;
                          setIncludeSpeakers(on);
                        }}
                        // Fixed once the download has started: Settings -> AI
                        // handles it from there.
                        disabled={
                          running || done || statuses.speakers === 'done' || statuses.speakers === 'running'
                        }
                        aria-label={t('setup.speakers.optInTitle')}
                      />
                    </PrefRow>
                  </>
                )}
                <Divider />
                <PrefRow
                  title={t('setup.telemetry.title')}
                  hint={t('setup.telemetry.hint')}
                  data-setup-telemetry
                >
                  <Switch
                    checked={telemetryEnabled}
                    onCheckedChange={(v) => setTelemetry.mutate({ enabled: v, source: 'setup' })}
                    disabled={telemetry.data === undefined}
                    aria-label={t('setup.telemetry.title')}
                  />
                </PrefRow>
                <Divider />
                <PrefRow
                  title={t('setup.launch.title')}
                  hint={t('setup.launch.hint')}
                  data-setup-launch
                >
                  <Switch
                    checked={launchOnLoginEnabled}
                    onCheckedChange={(v) => setLaunchOnLogin.mutate(v)}
                    disabled={launchOnLogin.data === undefined}
                    aria-label={t('setup.launch.title')}
                  />
                </PrefRow>
              </Panel>

              <div className="mt-8 flex flex-col items-center gap-2">
                <Button size="lg" onClick={() => leaveWelcome()} data-setup-continue>
                  {t('setup.you.continue')}
                </Button>
                <Muted className="max-w-[420px] text-center text-[12px]">
                  {t('setup.you.backgroundNote', { size: isMac ? '~2.5 GB' : '~670 MB' })}
                </Muted>
              </div>
            </>
          )}

          {stage === 'engine' && (
            <>
              <div data-setup-summary-chooser>
                <div
                  role="radiogroup"
                  aria-label={t('setup.engine.groupLabel')}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  onKeyDown={onEngineKeyDown}
                >
                  <EngineCard
                    data-engine="local"
                    tabIndex={summaryMode === 'local' ? 0 : -1}
                    selected={summaryMode === 'local'}
                    onSelect={() => setSummaryMode('local')}
                    icon={HardDrive}
                    title={t('setup.engine.local.title')}
                    line={t('setup.engine.local.line')}
                    meta={t('setup.engine.local.meta')}
                    seed="setup-local"
                    tone="sage"
                  />
                  <EngineCard
                    data-engine="cloud"
                    tabIndex={summaryMode === 'cloud' ? 0 : -1}
                    selected={summaryMode === 'cloud'}
                    onSelect={() => setSummaryMode('cloud')}
                    icon={Cloud}
                    title={t('setup.engine.cloud.title')}
                    line={t('setup.engine.cloud.line')}
                    meta={t('setup.engine.cloud.meta')}
                    seed="setup-cloud"
                    tone="sky"
                  />
                </div>

                {summaryMode === 'cloud' && (
                  <div className="setup-stage-in mt-6" data-setup-cloud>
                    <div className="mb-3 text-sm font-medium text-foreground">
                      {t('setup.cloud.pickProvider')}
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {GUIDED_PROVIDERS.map((p) => {
                        const selected = cloudProvider === p;
                        const guide = PROVIDER_GUIDE[p];
                        return (
                          <div
                            key={p}
                            data-setup-provider={p}
                            data-selected={selected ? '' : undefined}
                            className={cn(
                              'flex flex-col rounded-[14px] border p-4',
                              'motion-safe:transition-[box-shadow,border-color] motion-safe:duration-200',
                              selected ? 'border-foreground' : 'border-[color:var(--border-subtle)]',
                            )}
                            style={{
                              background: 'var(--surface-raised)',
                              boxShadow: selected ? 'var(--shadow-md)' : 'var(--shadow-sm)',
                            }}
                          >
                            <button
                              type="button"
                              aria-pressed={selected}
                              onClick={() => {
                                setCloudProviderChoice(p);
                                setOtherProvidersOpen(false);
                              }}
                              className="-m-1 mb-2 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className="flex items-center gap-2 text-[14px] font-medium text-foreground">
                                <ProviderIcon provider={p} />
                                {PROVIDER_NAME[p]}
                              </span>
                              {p === 'openrouter' && (
                                <span className="mt-1.5 inline-flex rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-foreground">
                                  {t('setup.cloud.openrouter.badge')}
                                </span>
                              )}
                              <span className="mt-1.5 block text-[12.5px] leading-snug text-muted-foreground">
                                {guide.tagline}
                              </span>
                            </button>
                            <ol className="mb-3 list-decimal space-y-0.5 pl-4 text-[12px] leading-snug text-muted-foreground">
                              {guide.steps.map((stepText) => (
                                <li key={stepText}>{stepText}</li>
                              ))}
                            </ol>
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-auto"
                              onClick={() => {
                                setCloudProviderChoice(p);
                                void ipc().shell.openExternal(KEY_PAGE_URL[p]);
                              }}
                              aria-label={t('setup.cloud.getKeyAria', { provider: PROVIDER_NAME[p] })}
                            >
                              {t('setup.cloud.getKey')}
                              <ExternalLink aria-hidden="true" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        const opening = !otherProvidersOpen;
                        setOtherProvidersOpen(opening);
                        if (opening && isGuidedProvider(cloudProvider)) setCloudProviderChoice('bedrock');
                        if (!opening && !isGuidedProvider(cloudProvider)) setCloudProviderChoice('openrouter');
                      }}
                      aria-expanded={otherProvidersOpen}
                      className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                    >
                      <ChevronDown
                        className={cn('size-3.5 motion-safe:transition-transform', otherProvidersOpen && 'rotate-180')}
                        aria-hidden="true"
                      />
                      {t('setup.cloud.otherProviders')}
                    </button>

                    {otherProvidersOpen && (
                      <Panel className="mt-3 space-y-3 p-4">
                        <div>
                          <label
                            className="mb-1 block text-[12px] font-medium text-foreground"
                            htmlFor="setup-cloud-provider"
                          >
                            {t('setup.cloud.providerLabel')}
                          </label>
                          <Select
                            value={isGuidedProvider(cloudProvider) ? undefined : cloudProvider}
                            onValueChange={(v) => setCloudProviderChoice(v as CloudProvider)}
                          >
                            <SelectTrigger id="setup-cloud-provider" className="h-8 text-[13px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="bedrock">{t('settings.ai.cloud.serviceBedrock')}</SelectItem>
                              <SelectItem value="custom">{t('settings.ai.cloud.customService')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {cloudProvider === 'bedrock' && (
                          <>
                            <div>
                              <label
                                className="mb-1 block text-[12px] font-medium text-foreground"
                                htmlFor="setup-bedrock-region"
                              >
                                {t('settings.ai.cloud.awsRegion')}
                              </label>
                              <Input
                                id="setup-bedrock-region"
                                value={bedrockRegion}
                                onChange={(e) => setBedrockRegionState(e.target.value)}
                                placeholder={t('settings.ai.cloud.awsRegionPlaceholder')}
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </div>
                            <div>
                              <label
                                className="mb-1 block text-[12px] font-medium text-foreground"
                                htmlFor="setup-bedrock-profile"
                              >
                                {t('settings.ai.cloud.inferenceProfile')}
                              </label>
                              <Input
                                id="setup-bedrock-profile"
                                value={bedrockProfile}
                                onChange={(e) => setBedrockProfileState(e.target.value)}
                                placeholder={t('settings.ai.cloud.inferenceProfilePlaceholder')}
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </div>
                          </>
                        )}
                        {cloudProvider === 'custom' && (
                          <div>
                            <label
                              className="mb-1 block text-[12px] font-medium text-foreground"
                              htmlFor="setup-custom-api"
                            >
                              {t('settings.ai.cloud.baseUrl')}
                            </label>
                            <Input
                              id="setup-custom-api"
                              value={apiUrl}
                              onChange={(e) => setApiUrl(e.target.value)}
                              placeholder={t('settings.ai.cloud.baseUrlPlaceholder')}
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>
                        )}
                      </Panel>
                    )}

                    <Panel className="mt-4 p-4">
                      <label
                        className="mb-1.5 block text-[13px] font-medium text-foreground"
                        htmlFor="setup-cloud-key"
                      >
                        {t('setup.cloud.keyLabel')}
                      </label>
                      <div className="flex gap-2">
                        <Input
                          id="setup-cloud-key"
                          type="password"
                          value={cloudApiKey}
                          onChange={(e) => onKeyChange(e.target.value)}
                          onPaste={(e) => {
                            // Test straight away on paste: the usual path is
                            // copy from the provider page, paste, done.
                            const pasted = e.clipboardData.getData('text').trim();
                            if (!pasted || cloudApiKey.trim()) return;
                            e.preventDefault();
                            onKeyChange(pasted);
                            if (isGuidedProvider(cloudProvider)) void connect(pasted);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void connect();
                            }
                          }}
                          placeholder={
                            cloudProvider === 'anthropic'
                              ? t('settings.ai.cloud.anthropicKeyPlaceholder')
                              : cloudProvider === 'openrouter'
                                ? t('settings.ai.cloud.openrouterKeyPlaceholder')
                                : cloudProvider === 'bedrock'
                                  ? t('settings.ai.cloud.bedrockKeyPlaceholder')
                                  : t('settings.ai.cloud.openaiKeyPlaceholder')
                          }
                          autoComplete="off"
                          spellCheck={false}
                          aria-describedby="setup-cloud-key-status"
                        />
                        <Button
                          variant="secondary"
                          onClick={() => void connect()}
                          disabled={!cloudFieldsReady || (connection.state === 'testing' && connectionCurrent)}
                        >
                          {connection.state === 'testing' && connectionCurrent
                            ? t('setup.cloud.testing')
                            : t('setup.cloud.connect')}
                        </Button>
                      </div>
                      <div id="setup-cloud-key-status" role="status" className="mt-2 min-h-[18px] text-[12px]">
                        {connected ? (
                          <span className="inline-flex items-center gap-1.5 text-foreground" data-setup-cloud-ok>
                            <Check className="size-3.5" aria-hidden="true" />
                            {t('setup.cloud.connected', { model: connectedModel })}
                          </span>
                        ) : connection.state === 'error' && connectionCurrent ? (
                          <span className="text-destructive" data-setup-cloud-error>
                            {connection.message}
                          </span>
                        ) : connection.state === 'testing' && connectionCurrent ? (
                          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                            {t('setup.cloud.testingWith', { provider: PROVIDER_NAME[cloudProvider] })}
                          </span>
                        ) : trimmedKey && isGuidedProvider(cloudProvider) && detectCloudProvider(trimmedKey) ? (
                          <span className="text-muted-foreground" data-setup-cloud-detected>
                            {t('setup.cloud.detected', { provider: PROVIDER_NAME[cloudProvider] })}
                          </span>
                        ) : null}
                      </div>
                      {connected && connection.state === 'ok' && connection.warning === 'no_credit' && (
                        <Muted className="mt-1 text-[12px]">{t('setup.cloud.warningNoCredit')}</Muted>
                      )}
                      <Muted className="mt-2 text-[11.5px]">{t('setup.cloud.keyStorage')}</Muted>
                    </Panel>
                  </div>
                )}
              </div>

              <div className="mt-8 flex items-center justify-between gap-3">
                <Button variant="ghost" onClick={() => setStage('you')}>
                  <ArrowLeft aria-hidden="true" />
                  {t('setup.back')}
                </Button>
                <div className="flex flex-col items-end gap-1">
                  <Button
                    size="lg"
                    onClick={runSetup}
                    disabled={running || !canBegin}
                    title={!canBegin ? t('setup.cloud.connectFirstTitle') : undefined}
                  >
                    {t('setup.begin')}
                  </Button>
                  {!canBegin && (
                    <Muted className="text-[12px]">{t('setup.cloud.connectToContinue')}</Muted>
                  )}
                </div>
              </div>
              {transcriptionBusy && (
                <Muted className="mt-4 text-center text-[12px]" data-setup-background-hint>
                  {t('setup.engine.backgroundHint')}
                </Muted>
              )}
            </>
          )}

          {stage === 'ready' && (
            <>
              {done && (
                <Panel className="mb-4 p-6 text-center" data-setup-done>
                  <div className="mb-1 font-serif text-[20px] text-foreground">{t('setup.done.cardTitle')}</div>
                  <Muted className="mx-auto mb-5 max-w-[420px] text-[13px]">{t('setup.done.cardBody')}</Muted>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button size="lg" onClick={() => void startFirstNote()}>
                      <Mic aria-hidden="true" />
                      {t('setup.done.startNote')}
                    </Button>
                    <Button size="lg" variant="outline" onClick={() => void finishOnboarding()}>
                      {t('setup.continueToApp')}
                    </Button>
                  </div>
                </Panel>
              )}
              <Panel data-setup-steps>
                {steps.map((step, i) => (
                  <React.Fragment key={step.id}>
                    {i > 0 && <Divider />}
                    <StepCard step={step} />
                  </React.Fragment>
                ))}
              </Panel>
              {!done && (
                <div className="mt-6 flex flex-col items-center gap-2">
                  {running ? (
                    <Muted className="text-center text-[12px]">{t('setup.ready.runningHint')}</Muted>
                  ) : anyFailed ? (
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Button size="lg" onClick={runSetup}>
                        {t('setup.retry')}
                      </Button>
                      {statuses.ollama === 'failed' && (
                        <Button size="lg" variant="outline" onClick={() => setStage('engine')}>
                          {t('setup.changeEngine')}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-12 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setDebugOpen((o) => !o)}
            aria-expanded={debugOpen}
            className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <span>{t('setup.debugConsole')}</span>
            <span aria-hidden="true">{debugOpen ? '−' : '+'}</span>
          </button>
          {debugOpen && (
            <pre className="mt-3 h-64 overflow-auto rounded border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
              {logs.length === 0 ? t('setup.debugEmpty') : logs.join('\n')}
            </pre>
          )}
        </div>

        <div className="mt-8 text-center text-xs text-muted-foreground">
          <a
            href="https://github.com/stenolabs/stenoai/issues"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            {t('setup.reportIssue')}
          </a>
        </div>
      </div>
    </div>
  );
}

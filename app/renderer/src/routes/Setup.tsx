import * as React from 'react';
import { AudioLines, Check, Cloud, HardDrive, Mic, MessageSquare, Zap, X } from 'lucide-react';
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
  useSetAiProvider,
  useSetCloudApiKey,
  useSetCloudProvider,
  useTestCloudApi,
  useSetBedrockInferenceProfile,
  useSetBedrockRegion,
  useSetCloudApiUrl,
} from '@/hooks/useAi';
import { ipc, type CloudProvider } from '@/lib/ipc';
import { cn, isMac } from '@/lib/utils';

type StepStatus = 'waiting' | 'running' | 'done' | 'failed';

interface Step {
  id: 'microphone' | 'transcription' | 'speakers' | 'ollama';
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  status: StepStatus;
  detail?: string;
  /** Optional download-progress affordance rendered under the detail line
   *  while the step is running (see the transcription/summarization steps). */
  progressNode?: React.ReactNode;
}

/** Real byte-progress bar for the local summarization-model download. Ollama
 *  streams per-blob progress, so `pct` can step back toward 0 as each new layer
 *  begins - the status label carries the current phase so the bar never reads
 *  as a single misleading aggregate. */
function OllamaProgressBar({ status, pct }: { status: string; pct: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="mt-2" data-setup-ollama-progress>
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="truncate">{status || 'Downloading model...'}</span>
        <span className="tabular-nums">{clamped}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full"
        style={{ background: 'var(--surface-sunken)' }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label="Summarization model download progress"
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${clamped}%`, background: 'var(--fg-1)' }}
        />
      </div>
    </div>
  );
}

/** Indeterminate bar for the transcription-model download. Parakeet only
 *  exposes coarse stages (no byte counts), so we signal activity without
 *  fabricating a percentage. */
function IndeterminateBar({
  label,
  kind = 'transcription',
}: {
  label: string;
  kind?: 'transcription' | 'speakers';
}) {
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
      ? 'Waiting'
      : status === 'running'
        ? 'Running'
        : status === 'done'
          ? 'Done'
          : 'Failed';
  const cls =
    status === 'done'
      ? 'bg-muted text-foreground'
      : status === 'running'
        ? 'bg-foreground text-background'
        : status === 'failed'
          ? 'bg-destructive text-destructive-foreground'
          : 'bg-transparent text-muted-foreground border border-border';
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function StepCard({ step }: { step: Step }) {
  const Icon = step.icon;
  return (
    <div
      className="flex items-center gap-4 rounded-md border border-border p-4"
      data-setup-step={step.id}
      data-setup-status={step.status}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        {step.status === 'done' ? (
          <Check className="size-5" />
        ) : step.status === 'failed' ? (
          <X className="size-5" />
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

export function Setup() {
  const navigate = useNavigate();
  const [statuses, setStatuses] = React.useState<Record<Step['id'], StepStatus>>({
    microphone: 'waiting',
    transcription: 'waiting',
    speakers: 'waiting',
    ollama: 'waiting',
  });
  const [details, setDetails] = React.useState<Record<Step['id'], string | undefined>>({
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
  // coarse stage (indeterminate bar); Ollama streams byte-level percent.
  const [parakeetStage, setParakeetStage] = React.useState<string | null>(null);
  const [ollamaProgress, setOllamaProgress] = React.useState<{
    status: string;
    pct: number;
  } | null>(null);

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
    const offParakeet = ipc().on.parakeetPullProgress(({ model, stage }) => {
      // Both the setup-parakeet flow and the Settings model-management pull
      // emit on the shared 'parakeet-pull-progress' channel. Settings pulls
      // carry a `model` id; the setup handler emits only { stage }. Ignore
      // model-bearing events so the wizard bar can't reflect an unrelated
      // Settings pull.
      if (model != null) return;
      setParakeetStage(stage);
    });
    const offOllama = ipc().on.setupOllamaProgress(({ status, pct }) => {
      setOllamaProgress({ status, pct });
    });
    return () => {
      offParakeet();
      offOllama();
    };
  }, []);

  const checkMic = useCheckMicPermission();
  const requestMic = useRequestMicPermission();
  // Non-Apple fallback setup still uses the existing Parakeet/Whisper hooks.
  // Fresh macOS 26+ installs take the system-managed Apple path in runSetup.
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
  // (privacy + free, slower); 'cloud' wires up an API key (no download,
  // higher quality) and skips the third install step entirely.
  type SummaryMode = 'local' | 'cloud';
  const [summaryMode, setSummaryMode] = React.useState<SummaryMode>('local');
  const [cloudProvider, setCloudProviderChoice] = React.useState<CloudProvider>('openai');
  const [cloudApiKey, setCloudApiKey] = React.useState('');

  const [bedrockRegion, setBedrockRegionState] = React.useState('');
  const [bedrockProfile, setBedrockProfileState] = React.useState('');
  const [apiUrl, setApiUrl] = React.useState('');

  const setAiProvider = useSetAiProvider();
  const setCloudProviderMut = useSetCloudProvider();
  const setCloudKeyMut = useSetCloudApiKey();
  const testCloudApi = useTestCloudApi();
  const setBedrockRegion = useSetBedrockRegion();
  const setBedrockProfile = useSetBedrockInferenceProfile();
  const setCloudUrl = useSetCloudApiUrl();

  const cloudReady = (() => {
    if (summaryMode !== 'cloud' || !cloudApiKey.trim()) return false;
    if (cloudProvider === 'bedrock') return bedrockRegion.trim().length > 0;
    if (cloudProvider === 'custom') return apiUrl.trim().length > 0;
    return true;
  })();
  const canBegin = summaryMode === 'local' || cloudReady;

  const setStatus = (id: Step['id'], s: StepStatus, detail?: string) => {
    setStatuses((prev) => ({ ...prev, [id]: s }));
    if (detail !== undefined) setDetails((prev) => ({ ...prev, [id]: detail }));
  };

  const runSetup = async () => {
    setRunning(true);
    setDone(false);
    // Reset any progress left over from a previous (failed) run so a retry
    // starts from a clean bar rather than resuming a stale one.
    setParakeetStage(null);
    setOllamaProgress(null);
    // Capture the snapshot so we can branch on what's already done. Skipping
    // completed steps keeps retries fast (no re-prompting for mic permission,
    // no re-initialising Whisper) when the user is just fixing a bad API key.
    const snapshot = statuses;
    try {
      if (snapshot.microphone !== 'done') {
        setStatus('microphone', 'running', 'Checking permission...');
        const existing = await checkMic.mutateAsync();
        if (existing === 'granted') {
          setStatus('microphone', 'done', 'Permission granted');
        } else {
          setStatus('microphone', 'running', 'Requesting permission...');
          const granted = await requestMic.mutateAsync();
          if (granted) setStatus('microphone', 'done', 'Permission granted');
          else {
            setStatus(
              'microphone',
              'failed',
              isMac
                ? 'Permission denied. Grant it in System Settings.'
                : 'Permission denied. Grant it in Settings > Privacy & security > Microphone.'
            );
            setRunning(false);
            return;
          }
        }
      }

      if (snapshot.transcription !== 'done') {
        setStatus('transcription', 'running', 'Checking transcription model...');
        const engineResponse = await ipc().transcriptionEngine.get();
        const selectedEngine =
          engineResponse.success && engineResponse.engine
            ? engineResponse.engine
            : isMac
              ? 'apple'
              : 'parakeet';

        if (selectedEngine === 'apple' && isMac) {
          const languageResponse = await ipc().settings.getLanguage();
          const language =
            languageResponse.success && languageResponse.language
              ? languageResponse.language
              : 'auto';
          const appleStatus = await ipc().appleSpeech.status(language);
          if (!appleStatus.success) throw new Error(appleStatus.error);
          if (!appleStatus.available || !appleStatus.supported) {
            throw new Error('Apple on-device transcription is unavailable for this language.');
          }
          if (!appleStatus.installed) {
            setStatus('transcription', 'running', 'Preparing Apple on-device transcription...');
            const prepared = await ipc().appleSpeech.prepare(language);
            if (!prepared.success) throw new Error(prepared.error);
          }
          setStatus('transcription', 'done', 'Apple on-device transcription ready');
        } else {
          // Existing explicit Parakeet/Whisper choices remain supported.
          const [parakeetStatus, whisperList] = await Promise.all([
            ipc().parakeetModels.status(),
            ipc().whisperModels.list(),
          ]);
          const parakeetInstalled = parakeetStatus.success && parakeetStatus.installed === true;
          const anyWhisperInstalled =
            whisperList.success &&
            Object.values(whisperList.supported_models ?? {}).some(
              (model) => model.installed === true
            );
          if (parakeetInstalled || anyWhisperInstalled) {
            setStatus('transcription', 'done', 'Transcription model ready');
          } else {
            setStatus(
              'transcription',
              'running',
              `Downloading Parakeet TDT v3 (${isMac ? '~572 MB' : '~670 MB'})...`
            );
            await parakeetStep.mutateAsync();
            setParakeetStage(null);
            setStatus('transcription', 'done', 'Transcription model ready');
          }
        }
      }

      if (isMac && snapshot.speakers !== 'done') {
        setStatus('speakers', 'running', 'Checking speaker diarization models...');
        try {
          const status = await ipc().setup.speakerModelsStatus();
          if (!status.success) throw new Error(status.error);
          if (status.ready) {
            setStatus('speakers', 'done', 'Speaker diarization models ready');
          } else {
            setStatus('speakers', 'running', 'Downloading speaker diarization models...');
            await speakerModelsStep.mutateAsync();
            setStatus('speakers', 'done', 'Speaker diarization models ready');
          }
        } catch {
          setStatus('speakers', 'failed', 'Optional setup failed. You can retry later.');
        }
      }

      // Always re-run the summarization step on retry (the choice or key may
      // have changed). Reset its status from 'failed' so the chooser hides
      // while we run.
      setStatus('ollama', 'running', '');

      if (summaryMode === 'cloud') {
        setStatus('ollama', 'running', 'Saving cloud credentials...');
        // Persist provider preference + key, then verify with a small ping
        // call so the user gets immediate feedback if the key is bad.
        await setAiProvider.mutateAsync('cloud');
        ipc().analytics.track('ai_provider_selected', { provider: 'cloud' });
        await setCloudProviderMut.mutateAsync(cloudProvider);
        if (cloudProvider === 'bedrock') {
          if (bedrockRegion) await setBedrockRegion.mutateAsync(bedrockRegion.trim());
          if (bedrockProfile) await setBedrockProfile.mutateAsync(bedrockProfile.trim());
        } else if (cloudProvider === 'custom') {
          if (apiUrl) await setCloudUrl.mutateAsync(apiUrl.trim());
        }
        await setCloudKeyMut.mutateAsync(cloudApiKey.trim());
        setStatus('ollama', 'running', 'Testing connection...');
        // unwrap throws on { success: false } so reaching this line means the
        // provider responded successfully — no extra check needed.
        await testCloudApi.mutateAsync();
        setStatus('ollama', 'done', `Connected to ${cloudProvider}`);
      } else {
        // Make sure provider is local in case the user previously had cloud
        // configured and is re-running the wizard to switch back.
        await setAiProvider.mutateAsync('local');
        ipc().analytics.track('ai_provider_selected', { provider: 'local' });
        setStatus('ollama', 'running', 'Downloading model (~2 GB)...');
        await ollamaStep.mutateAsync();
        setOllamaProgress(null);
        setStatus('ollama', 'done', 'Model installed');
      }

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
      const message = err instanceof Error ? err.message : 'Setup step failed';
      // Clear the bars on failure - a failed step keeps its Failed badge +
      // error detail, not a frozen progress bar.
      setParakeetStage(null);
      setOllamaProgress(null);
      setStatuses((prev) => {
        const failId = (Object.keys(prev) as Step['id'][]).find((k) => prev[k] === 'running');
        if (!failId) return prev;
        setDetails((d) => ({ ...d, [failId]: message }));
        return { ...prev, [failId]: 'failed' };
      });
    } finally {
      setRunning(false);
    }
  };

  const steps: Step[] = [
    {
      id: 'microphone',
      title: 'Microphone Access',
      description: 'Required for recording meetings',
      icon: Mic,
      status: statuses.microphone,
      detail: details.microphone,
    },
    {
      id: 'transcription',
      title: 'Transcription Model',
      description: 'Converts speech to text locally',
      icon: MessageSquare,
      status: statuses.transcription,
      detail: details.transcription,
      progressNode:
        statuses.transcription === 'running' && parakeetStage !== null ? (
          <IndeterminateBar label="Downloading and preparing model..." />
        ) : undefined,
    },
    {
      id: 'ollama',
      title: 'Summarization Engine',
      description:
        summaryMode === 'cloud'
          ? 'Cloud API — fast, no download'
          : 'Local model (~2 GB) — private, runs on your device',
      icon: summaryMode === 'cloud' ? Cloud : Zap,
      status: statuses.ollama,
      detail: details.ollama,
      progressNode:
        statuses.ollama === 'running' && ollamaProgress !== null ? (
          <OllamaProgressBar status={ollamaProgress.status} pct={ollamaProgress.pct} />
        ) : undefined,
    },
  ];

  if (isMac) {
    steps.splice(2, 0, {
      id: 'speakers',
      title: 'Speaker Diarization',
      description: 'Separates individual speakers locally',
      icon: AudioLines,
      status: statuses.speakers,
      detail: details.speakers,
      progressNode:
        statuses.speakers === 'running' && details.speakers?.startsWith('Downloading') ? (
          <IndeterminateBar label="Downloading and preparing models..." kind="speakers" />
        ) : undefined,
    });
  }

  // Show the Local/Cloud chooser before the third step has run AND after a
  // failure, so the user can correct a bad API key (or pick the other path
  // entirely) and retry without exiting the wizard. Hidden while running and
  // when the step has succeeded.
  const showSummaryChooser =
    !running && (statuses.ollama === 'waiting' || statuses.ollama === 'failed');

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[560px] px-8 py-16">
        <div className="mb-8 text-center">
          <Display className="mb-3">Welcome to Steno</Display>
          <Lead>We'll help you set up everything needed for meeting intelligence.</Lead>
        </div>

        <div
          className="mb-6 flex items-center gap-4 rounded-md border border-border p-4"
          data-setup-name
        >
          <div className="min-w-0 flex-1">
            <label htmlFor="setup-name-input" className="text-sm font-medium text-foreground">
              What should we call you?
            </label>
            <Muted className="mt-0.5">
              First name only — used for in-app greetings. Stored locally.
            </Muted>
          </div>
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
            placeholder="Your name"
            autoComplete="given-name"
            className="w-[160px]"
          />
        </div>

        <div className="space-y-3" data-setup-steps>
          {steps.map((step) => (
            <StepCard key={step.id} step={step} />
          ))}
        </div>

        {showSummaryChooser && (
          <div className="mt-3 rounded-md border border-border p-4" data-setup-summary-chooser>
            <div className="mb-3 text-sm font-medium text-foreground">
              How should Steno summarize meetings?
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSummaryMode('local')}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors',
                  summaryMode === 'local'
                    ? 'border-foreground bg-muted/40'
                    : 'border-border hover:bg-muted/20'
                )}
                aria-pressed={summaryMode === 'local'}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <HardDrive className="size-4" />
                    Local
                  </div>
                  {summaryMode === 'local' && <Check className="size-4 text-foreground" />}
                </div>
                <Muted className="text-[12px]">Private. Free. ~2 GB download.</Muted>
              </button>
              <button
                type="button"
                onClick={() => setSummaryMode('cloud')}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors',
                  summaryMode === 'cloud'
                    ? 'border-foreground bg-muted/40'
                    : 'border-border hover:bg-muted/20'
                )}
                aria-pressed={summaryMode === 'cloud'}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Cloud className="size-4" />
                    Cloud
                  </div>
                  {summaryMode === 'cloud' && <Check className="size-4 text-foreground" />}
                </div>
                <Muted className="text-[12px]">Fast. Higher quality. Bring your own API key.</Muted>
              </button>
            </div>

            {summaryMode === 'cloud' && (
              <div className="mt-3 space-y-2">
                <div>
                  <label
                    className="mb-1 block text-[12px] font-medium text-foreground"
                    htmlFor="setup-cloud-provider"
                  >
                    Provider
                  </label>
                  <Select
                    value={cloudProvider}
                    onValueChange={(v) => setCloudProviderChoice(v as CloudProvider)}
                  >
                    <SelectTrigger id="setup-cloud-provider" className="h-8 text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                      <SelectItem value="bedrock">AWS Bedrock (Claude)</SelectItem>
                      <SelectItem value="custom">Custom (OpenAI-compatible)</SelectItem>
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
                        AWS region
                      </label>
                      <Input
                        id="setup-bedrock-region"
                        value={bedrockRegion}
                        onChange={(e) => setBedrockRegionState(e.target.value)}
                        placeholder="us-east-1"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div>
                      <label
                        className="mb-1 block text-[12px] font-medium text-foreground"
                        htmlFor="setup-bedrock-profile"
                      >
                        Inference profile (optional)
                      </label>
                      <Input
                        id="setup-bedrock-profile"
                        value={bedrockProfile}
                        onChange={(e) => setBedrockProfileState(e.target.value)}
                        placeholder="us.anthropic.claude-…"
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
                      API base URL
                    </label>
                    <Input
                      id="setup-custom-api"
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                      placeholder="https://api.example.com/v1"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                )}
                <div>
                  <label
                    className="mb-1 block text-[12px] font-medium text-foreground"
                    htmlFor="setup-cloud-key"
                  >
                    API key
                  </label>
                  <Input
                    id="setup-cloud-key"
                    type="password"
                    value={cloudApiKey}
                    onChange={(e) => setCloudApiKey(e.target.value)}
                    placeholder={cloudProvider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Muted className="mt-1 text-[11px]">
                    Stored locally on this device. Never synced or sent anywhere except the provider
                    you select.
                  </Muted>
                </div>
              </div>
            )}
          </div>
        )}

        <div
          className="mt-3 flex items-start gap-4 rounded-md border border-border p-4"
          data-setup-telemetry
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">Anonymous usage analytics</div>
            <Muted className="mt-0.5">
              Help improve Steno — meeting content is never sent. You can change this any time in
              Settings → Advanced.
            </Muted>
          </div>
          <Switch
            checked={telemetryEnabled}
            onCheckedChange={(v) => setTelemetry.mutate({ enabled: v, source: 'setup' })}
            disabled={telemetry.data === undefined}
            aria-label="Anonymous usage analytics"
          />
        </div>

        <div
          className="mt-3 flex items-start gap-4 rounded-md border border-border p-4"
          data-setup-launch
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">Launch on login</div>
            <Muted className="mt-0.5">
              Start Steno automatically when you log in (hidden in the menu bar). You can change
              this any time in Settings.
            </Muted>
          </div>
          <Switch
            checked={launchOnLoginEnabled}
            onCheckedChange={(v) => setLaunchOnLogin.mutate(v)}
            disabled={launchOnLogin.data === undefined}
            aria-label="Launch on login"
          />
        </div>

        <div className="mt-8 flex flex-col items-center gap-2">
          {done ? (
            <Button size="lg" onClick={() => void finishOnboarding()}>
              Continue to app
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={runSetup}
              disabled={running || !canBegin}
              title={!canBegin ? 'Enter your cloud API key first' : undefined}
            >
              {running ? 'Setting up...' : 'Begin setup'}
            </Button>
          )}
          {!done && !running && !canBegin && (
            <Muted className="text-[12px]">Enter your API key to continue.</Muted>
          )}
        </div>

        <div className="mt-10 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setDebugOpen((o) => !o)}
            className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <span>Debug console</span>
            <span>{debugOpen ? '−' : '+'}</span>
          </button>
          {debugOpen && (
            <pre className="mt-3 h-64 overflow-auto rounded border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
              {logs.length === 0
                ? 'Steno Setup\nCommands and output will appear here...\n'
                : logs.join('\n')}
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
            Report an issue
          </a>
        </div>
      </div>
    </div>
  );
}

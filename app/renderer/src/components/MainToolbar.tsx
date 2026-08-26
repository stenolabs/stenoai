import * as React from 'react';
import { FileAudio, MessageSquare, MoreHorizontal, Monitor, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AudioWave } from '@/components/AudioWave';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  useSetSystemAudio,
  useSystemAudioSetting,
  useSystemAudioSupport,
} from '@/hooks/useSettings';
import type { RecordingStatus } from '@/hooks/useRecording';
import { useImportAudio } from '@/hooks/useImportAudio';
import { useRoute, navigate } from '@/lib/router';
import { cn, isMac } from '@/lib/utils';
import { useTranslation } from '@/i18n';
interface MainToolbarProps {
  recordingStatus: RecordingStatus;
  elapsedSeconds?: number;
  onToggleRecording: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  // While in Settings' full-takeover layout: hides the sidebar-collapse
  // toggle (nothing to collapse — SettingsNav is non-collapsible), the
  // recording-options popover, and the record/new-note button UNLESS a
  // recording is actively in progress (so a user who opens Settings
  // mid-recording never loses the way back to it).
  settingsMode?: boolean;
}

export function MainToolbar({
  recordingStatus,
  elapsedSeconds = 0,
  onToggleRecording,
  sidebarCollapsed,
  onToggleSidebar,
  settingsMode = false,
}: MainToolbarProps) {
  const { t } = useTranslation();
  const isRecording =
    recordingStatus === 'recording' || recordingStatus === 'paused';
  const isPaused = recordingStatus === 'paused';
  // Route-aware primary action. On chat routes the "+ New" affordance maps
  // to a new chat (navigates back to /chat entry). Everywhere else it's
  // the recording button. Recording always wins if a session is active —
  // we don't want a navigation to silently swallow a stop-recording click.
  // Processing of a previous note runs in the background queue and
  // doesn't gate this button.
  const route = useRoute();
  const isChatRoute = route === '/chat' || route.startsWith('/chat/');
  const showChatPrimary = isChatRoute && !isRecording;

  // Matches sb-top padding-left: 82px clears the macOS traffic lights; on
  // Windows/Linux there are none, so align to the sidebar's left edge.
  const toggleLeft = isMac ? 82 : 16;

  // Hoisted here (always mounted) so a long import's onSuccess refresh
  // still fires even if the user closes the options popover mid-import.
  const importAudio = useImportAudio();

  return (
    <div
      className="flex h-10 items-center justify-between gap-2 px-5 pt-2.5"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className="ml-auto flex items-center gap-1.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* Toggle button lives here (inside a no-drag child of a drag ancestor)
            so Electron correctly computes the no-drag region even when the
            sidebar aside has pointer-events:none. position:fixed keeps it at
            the same screen coords as the sb-top button position. Hidden in
            Settings — SettingsNav is non-collapsible, so there's nothing for
            it to toggle. */}
        {!settingsMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleSidebar}
                aria-label={sidebarCollapsed ? t('nav.showSidebar') : t('nav.hideSidebar')}
                style={{
                  position: 'fixed',
                  top: 14,
                  left: toggleLeft,
                  zIndex: 30,
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
                className="inline-flex h-[26px] w-7 items-center justify-center rounded-md text-[color:var(--fg-2)] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]"
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="size-[15px]" />
                ) : (
                  <PanelLeftClose className="size-[15px]" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {sidebarCollapsed ? t('nav.showSidebar') : t('nav.hideSidebar')}
            </TooltipContent>
          </Tooltip>
        )}
        {/* Starting a new recording with options isn't a Settings action. */}
        {!settingsMode && (
          <RecordingOptionsPopover importAudio={importAudio} disabled={isRecording} />
        )}
        {/* Hidden while idle in Settings — there's nothing to start a new
            note for there. Stays visible whenever a recording is actually
            in progress, in Settings or anywhere else, so opening Settings
            mid-recording never loses the way back to it. */}
        {(!settingsMode || isRecording) && (
          <button
            type="button"
            onClick={showChatPrimary ? () => navigate('/chat') : onToggleRecording}
            className={cn('record-btn', isRecording && 'is-recording')}
            aria-label={
              isRecording
                ? t('recording.recordingInProgress')
                : showChatPrimary
                  ? t('nav.newChat')
                  : t('nav.newNote')
            }
            title={
              isRecording
                ? t('recording.recordingInProgress')
                : showChatPrimary
                  ? t('nav.newChat')
                  : t('nav.newNote')
            }
          >
            {isRecording ? (
              <>
                <span style={{ color: '#FFFFFF', display: 'inline-flex' }}>
                  <AudioWave
                    active={!isPaused}
                    paused={isPaused}
                    bars={4}
                    height={13}
                    barWidth={2}
                    gap={2}
                  />
                </span>
                <span
                  className="tabular-nums"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                >
                  {formatElapsed(elapsedSeconds)}
                </span>
                <span>{isPaused ? t('common.paused') : t('common.recording')}</span>
              </>
            ) : showChatPrimary ? (
              <>
                <MessageSquare className="size-[13px]" />
                {t('nav.newChat')}
              </>
            ) : (
              <>
                <Plus className="size-[13px]" />
                {t('nav.newNote')}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function RecordingOptionsPopover({
  importAudio,
  disabled,
}: {
  importAudio: UseMutationResult<boolean, Error, void>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const systemAudio = useSystemAudioSetting();
  const setSystemAudio = useSetSystemAudio();
  const systemAudioSupport = useSystemAudioSupport();
  // macOS default is on (system_audio_enabled defaults true on darwin).
  const enabled = systemAudio.data ?? true;
  // macOS only: the toggle chooses mic-only vs mic+system. On Windows the
  // product decision is always mic+system, so the toggle is hidden (the
  // renderer forces loopback on there). Also hidden while support is loading
  // or on a Mac without loopback support (pre-14.4).
  const showSystemAudio = isMac && systemAudioSupport.data?.supported === true;
  // Controlled so the import action can close the popover when it fires — the
  // import's progress then shows as a processing row in the meeting list,
  // not in this (now closed) popover.
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('nav.recordingOptions')}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('nav.recordingOptions')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72" data-recording-options>
        <div className="space-y-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t('nav.recordingOptions')}</p>
            <p className="text-xs text-muted-foreground">
              {t('recording.deepLinksAndTrayHint')}
            </p>
          </div>

          {showSystemAudio && (
            <div
              className="flex items-start gap-3 rounded-md border p-3"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <Monitor className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground" />
              <div className="flex-1 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="maintoolbar-system-audio"
                    className="text-sm font-medium"
                  >
                    {t('recording.recordSystemAudio')}
                  </label>
                  <Switch
                    id="maintoolbar-system-audio"
                    checked={enabled}
                    disabled={systemAudio.isLoading || setSystemAudio.isPending}
                    onCheckedChange={(v) => setSystemAudio.mutate(v)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('recording.recordSystemAudioDesc')}
                </p>
              </div>
            </div>
          )}

          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              importAudio.mutate();
            }}
            className="flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors hover:bg-[color:var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <FileAudio className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground" />
            <div className="flex-1 space-y-0.5">
              <p className="text-sm font-medium">{t('recording.importAudioFile')}</p>
              <p className="text-xs text-muted-foreground">
                {disabled
                  ? t('recording.importAudioDisabledDesc')
                  : t('recording.importAudioFileDesc')}
              </p>
            </div>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, seconds | 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(rem)}`;
  return `${pad(m)}:${pad(rem)}`;
}

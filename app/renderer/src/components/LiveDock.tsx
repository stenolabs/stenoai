import * as React from 'react';
import { Check, ChevronUp, Play, Square } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { AudioWave } from '@/components/AudioWave';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useRecording } from '@/hooks/useRecording';
import { useLiveTranscriptStatus } from '@/hooks/useLiveTranscript';
import { useLiveTranscriptOpen } from '@/hooks/liveTranscriptOpenStore';
import { useLiveTranscriptAvailable } from '@/hooks/useModels';
import { useTemplates } from '@/hooks/useTemplates';
import { useRecordTemplateStore } from '@/hooks/useSystemAudioCapture';
/**
 * Compact (Granola-style) transcription pill shown whenever a recording is
 * active — recording coexists with whatever the user is viewing; PrimaryDock
 * places this either adjacent to the Ask bar or alone. Icon-only: wave +
 * elapsed + expand chevron (Parakeet) + stop glyph. Layout is owned by the
 * parent; this renders just the pill.
 *
 * There is deliberately NO pause control: stop ends the segment, and a note
 * can be continued later (continue-recording appends to it), so "stop is the
 * new pause". The one exception is a Resume affordance that appears only
 * when the SYSTEM auto-paused the recording (laptop sleep, meeting-app mic
 * drop) — without it an auto-paused recording would be stranded.
 */
export function LiveDock() {
  const recording = useRecording();
  const liveAvailable = useLiveTranscriptAvailable();
  const transcriptOpen = useLiveTranscriptOpen((s) => s.open);
  const toggleTranscript = useLiveTranscriptOpen((s) => s.toggle);
  const paused = recording.status === 'paused';
  const isRecording = recording.status === 'recording';
  // Belt-and-braces: PrimaryDock unmounts the pill before status leaves
  const { templates, defaultId } = useTemplates();
  const activeTemplateId = useRecordTemplateStore((s) => s.activeTemplateId);
  const activeTemplateName = React.useMemo(() => {
    const targetId = activeTemplateId || defaultId;
    const found = templates.find((t) => t.id === targetId);
    return found?.name ?? 'Standard Summary';
  }, [templates, defaultId, activeTemplateId]);
  const [templateOpen, setTemplateOpen] = React.useState(false);

  // recording/paused, so this branch is normally unreachable — it only
  // covers a same-render race between the queue poll and the unmount.
  const stopped = !paused && !isRecording;

  // Surface model warm-up on the pill itself, since the transcript panel
  // (which already shows a loading state) is usually closed while recording.
  // Gated to Parakeet via `liveAvailable` — Whisper never spawns the live
  // sidecar, so its status would sit at 'loading' forever. Only meaningful
  // while actively recording.
  //
  // Status-only subscription on purpose: the pill is mounted for the entire
  // meeting, and the full hook would keep a second complete copy of every
  // segment just to decide whether to show one label.
  const live = useLiveTranscriptStatus(liveAvailable ? recording.sessionName : null);
  const loadingModel = isRecording && live.status === 'loading';
  // Delay the label by ~500ms so a warm-cache load (the common case after
  // the offline-loading fix) goes straight to the timer with no
  // "Preparing…" flash.
  const [showPreparing, setShowPreparing] = React.useState(false);
  React.useEffect(() => {
    if (!loadingModel) return;
    const id = window.setTimeout(() => setShowPreparing(true), 500);
    return () => {
      window.clearTimeout(id);
      setShowPreparing(false);
    };
  }, [loadingModel]);
  const prepareLabel = showPreparing
    ? live.slow
      ? 'Still preparing…'
      : 'Preparing…'
    : null;

  const onResume = () => {
    if (paused) void recording.resumeRecording();
  };

  const onStop = () => {
    void recording.stopRecording();
  };

  return (
    <div
      data-testid="transcription-pill"
      className="pointer-events-auto flex items-center gap-1 whitespace-nowrap rounded-full py-1.5 pl-3 pr-1.5"
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <span
        style={{ color: 'var(--recording)' }}
        title={paused ? 'Paused' : 'Recording'}
        aria-hidden="true"
      >
        <AudioWave
          active={!stopped}
          paused={paused}
          bars={5}
          height={13}
          barWidth={2}
          gap={2}
        />
      </span>
      {/* No elapsed timer here — the toolbar's recording chip already shows it.
          Keep only the transient warm-up hint while the live model loads. */}
      {prepareLabel ? (
        <span
          className="px-1.5"
          style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-2)' }}
        >
          {prepareLabel}
        </span>
      ) : activeTemplateName ? (
        <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="live-dock-template-label"
              aria-label={`Change template: ${activeTemplateName}`}
              title={`Template: ${activeTemplateName}`}
              className="max-w-[120px] truncate rounded px-1.5 py-0.5 text-xs text-[color:var(--fg-muted)] hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)] transition-colors cursor-pointer border-0 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]"
            >
              {activeTemplateName}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            sideOffset={8}
            className="z-50 w-60 rounded-xl border p-1.5 shadow-lg outline-none"
            style={{
              background: 'var(--surface-raised)',
              borderColor: 'var(--border-subtle)',
              boxShadow: 'var(--shadow-lg)',
            }}
            data-testid="live-dock-template-menu"
          >
            <div className="px-2 py-1 text-[11px] font-semibold text-[color:var(--fg-muted)]">
              Change template
            </div>
            <div className="flex flex-col gap-0.5" role="listbox" aria-label="Summary templates">
              {templates.map((tpl) => {
                const isSelected = tpl.id === (activeTemplateId || defaultId);
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      const recordingBridge = ipc().recording;
                      if (
                        'setTemplate' in recordingBridge &&
                        typeof recordingBridge.setTemplate === 'function'
                      ) {
                        void recordingBridge.setTemplate(tpl.id);
                      }
                      useRecordTemplateStore.getState().setActiveTemplateId(tpl.id);
                      setTemplateOpen(false);
                    }}
                    className={cn(
                      'flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition-colors cursor-pointer border-0',
                      isSelected
                        ? 'bg-[color:var(--surface-active)] font-medium text-[color:var(--fg-1)]'
                        : 'text-[color:var(--fg-2)] hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]'
                    )}
                  >
                    <span className="truncate">{tpl.name}</span>
                    {isSelected && <Check className="size-3.5 shrink-0 text-[color:var(--fg-1)]" />}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      {/* Resume — only when the system auto-paused (sleep / meeting-app mic
          drop). There is no manual pause: stop ends the segment and the note
          can be continued later. */}
      {paused && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onResume}
              aria-label="Resume recording"
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full border-0 transition-colors hover:bg-[color:var(--surface-hover)]"
              style={{ background: 'transparent', color: 'var(--fg-1)' }}
            >
              <Play size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Resume recording</TooltipContent>
        </Tooltip>
      )}
      {/* Expand — Parakeet only. Whisper recordings have no live drawer
          (post-stop pipeline produces the final transcript on the meeting
          detail page). Hiding the button entirely rather than disabling
          avoids the dead-control. */}
      {liveAvailable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleTranscript}
              disabled={stopped}
              aria-label={transcriptOpen ? 'Hide transcript' : 'Show transcript'}
              aria-pressed={transcriptOpen}
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full border-0 transition-colors hover:bg-[color:var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: 'transparent', color: 'var(--fg-1)' }}
            >
              <ChevronUp size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{transcriptOpen ? 'Hide transcript' : 'Show transcript'}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onStop}
            disabled={stopped}
            aria-label="Stop recording"
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full border-0 transition-colors hover:bg-[color:var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: 'transparent', color: 'var(--recording)' }}
          >
            <Square size={12} fill="currentColor" stroke="currentColor" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Stop recording</TooltipContent>
      </Tooltip>
    </div>
  );
}

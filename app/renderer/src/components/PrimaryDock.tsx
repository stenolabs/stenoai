import * as React from 'react';
import { Check, ChevronDown, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AskBar, TranscriptToggle } from '@/components/AskBar';
import { LiveDock } from '@/components/LiveDock';
import { LiveTranscriptBar } from '@/components/LiveTranscriptBar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useLiveTranscriptOpen } from '@/hooks/liveTranscriptOpenStore';
import { useRecording } from '@/hooks/useRecording';
import { useLiveTranscriptAvailable } from '@/hooks/useModels';
import { useTemplates } from '@/hooks/useTemplates';
import { useRecordTemplateStore } from '@/hooks/useSystemAudioCapture';

export function RecordTemplatePicker() {
  const { templates, defaultId, isLoading } = useTemplates();
  const chosenTemplateId = useRecordTemplateStore((s) => s.chosenTemplateId);
  const setChosenTemplateId = useRecordTemplateStore((s) => s.setChosenTemplateId);
  const [open, setOpen] = React.useState(false);

  const selectedTemplate = React.useMemo(() => {
    const targetId = chosenTemplateId || defaultId;
    return templates.find((t) => t.id === targetId);
  }, [templates, defaultId, chosenTemplateId]);

  const templateName = selectedTemplate?.name || (isLoading ? 'Standard Summary' : 'Standard Summary');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="record-template-picker"
          aria-label={`Template: ${templateName}`}
          className="pointer-events-auto mb-[3px] inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border-0 px-3.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)]"
          style={{
            background: open ? 'var(--surface-active)' : 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--shadow-md)',
            color: 'var(--fg-1)',
          }}
        >
          <FileText className="size-3.5 shrink-0 text-[color:var(--fg-muted)]" />
          <span className="max-w-[130px] truncate">{templateName}</span>
          <ChevronDown className="size-3 shrink-0 text-[color:var(--fg-muted)]" />
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
        data-testid="record-template-menu"
      >
        <div className="px-2 py-1 text-[11px] font-semibold text-[color:var(--fg-muted)]">
          Summary template
        </div>
        <div className="flex flex-col gap-0.5" role="listbox" aria-label="Summary templates">
          {templates.map((tpl) => {
            const isSelected = (chosenTemplateId || defaultId) === tpl.id;
            const isDefault = defaultId === tpl.id;
            return (
              <button
                key={tpl.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-testid={`record-template-option-${tpl.id}`}
                onClick={() => {
                  setChosenTemplateId(tpl.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                  isSelected
                    ? 'bg-[color:var(--surface-active)] font-medium text-[color:var(--fg-1)]'
                    : 'text-[color:var(--fg-2)] hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]'
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate">{tpl.name}</span>
                  {isDefault && (
                    <span
                      className="shrink-0 rounded px-1 text-[10px] text-[color:var(--fg-muted)]"
                      style={{ background: 'var(--surface-hover)' }}
                    >
                      Default
                    </span>
                  )}
                </div>
                {isSelected && (
                  <Check className="size-3.5 shrink-0 text-[color:var(--fg-1)]" />
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The primary bottom-dock slot (bottomOffset 0). Recording coexists with the
 * app instead of taking over a dedicated route, so this decides what the slot
 * holds from recording *status*, not the route:
 *
 * - recording/paused + transcript open (Parakeet): the expanded
 *   LiveTranscriptBar panel replaces the whole row (it owns Stop + language
 *   in its footer).
 * - recording/paused, collapsed: the compact transcription pill, docked left
 *   of the Ask bar in one row — the Ask bar renders disabled (chat needs the
 *   processed note) — or alone on routes without an Ask bar (chat/settings/
 *   setup, and the processing route).
 * - idle on a note detail: a compact continue-recording button in the pill's
 *   spot — recording from a note APPENDS to that note (stop is the new
 *   pause; the note is regenerated on demand afterwards).
 * - idle elsewhere: the plain Ask bar (or nothing on routes without one).
 *
 * The row keeps ONE stable tree shape across the idle ↔ recording flip so
 * React re-renders AskBar with a new `disabled` prop instead of remounting
 * it — a remount would silently drop a typed draft or an in-flight ask-AI
 * stream's persistence ref (recordings start from global hotkeys/tray, i.e.
 * potentially mid-typing).
 *
 * The processing dock is handled by the caller (route-gated) — but recording
 * wins the slot when both apply (back-to-back notes), so the pill + Stop are
 * never unreachable.
 */
export function PrimaryDock({ showAskBar }: { showAskBar: boolean }) {
  const recording = useRecording();
  const open = useLiveTranscriptOpen((s) => s.open);
  // Whisper has no live transcript. Belt-and-braces vs the LiveDock toggle
  // being hidden: the store could already be open from a prior Parakeet
  // session, and zustand survives across recordings. Force the pill for
  // whisper regardless of stored state.
  const liveAvailable = useLiveTranscriptAvailable();
  const recordingActive =
    recording.status === 'recording' || recording.status === 'paused';

  // Continue-recording ("Resume") now lives in the transcript panel footer
  // (TranscriptBar), Granola-style — open the transcript on a note to resume
  // recording into it. No standalone dock control here.

  if (recordingActive && open && liveAvailable) return <LiveTranscriptBar />;
  if (!recordingActive && !showAskBar) return null;

  return (
    <div
      data-testid="primary-dock-row"
      // items-end, not items-center: the AskBar column grows upward in-flow
      // (chat panel maxHeight 360, suggestion chips), so centering against it
      // would float the left control mid-column when a chat is expanded. The
      // left controls instead carry a small mb-* that optically centers them
      // against the 50px composer row only.
      className={cn('flex items-end gap-3', !showAskBar && 'justify-center')}
    >
      {recordingActive ? (
        // mb-1 only beside the composer - standalone (justify-center) the
        // pill has nothing to align with.
        <div className={cn('shrink-0', showAskBar && 'mb-1')}>
          <LiveDock />
        </div>
      ) : (
        // Idle: the standalone transcript toggle sits left of the Ask bar
        // alongside the pre-recording template choice picker.
        // While recording, the pill owns the left slot.
        <div className={cn('flex items-center gap-2 shrink-0', showAskBar && 'mb-1')}>
          <TranscriptToggle />
          <RecordTemplatePicker />
        </div>
      )}
      {showAskBar && (
        <div className="min-w-0 flex-1">
          <AskBar disabled={recordingActive} />
        </div>
      )}
    </div>
  );
}

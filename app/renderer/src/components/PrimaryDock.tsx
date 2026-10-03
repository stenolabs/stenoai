import { cn } from '@/lib/utils';
import { AskBar, TranscriptToggle } from '@/components/AskBar';
import { LiveDock } from '@/components/LiveDock';
import { LiveTranscriptBar } from '@/components/LiveTranscriptBar';
import { useLiveTranscriptOpen } from '@/hooks/liveTranscriptOpenStore';
import { useRecording } from '@/hooks/useRecording';
import { useLiveTranscriptAvailable } from '@/hooks/useModels';

/** Recording controls and chat share the dock without sharing a lifetime. */
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

  const transcriptExpanded = recordingActive && open && liveAvailable;

  return (
    <>
    {transcriptExpanded && <LiveTranscriptBar />}
    <div
      data-testid="primary-dock-row"
      style={{ display: transcriptExpanded || (!recordingActive && !showAskBar) ? 'none' : undefined }}
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
        // (Granola-style). While recording, the pill owns the left slot.
        <TranscriptToggle />
      )}
      <div className="min-w-0 flex-1" style={{ display: showAskBar ? undefined : 'none' }}>
        <AskBar />
      </div>
    </div>
    </>
  );
}

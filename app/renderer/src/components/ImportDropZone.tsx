import * as React from 'react';
import { Ban, FileAudio } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import {
  basenameStem,
  importAudioFile,
  isAudioFile,
  notifyImportFailed,
} from '@/hooks/useImportAudio';
import { useRecording } from '@/hooks/useRecording';
import { importMeetingPackage, MEETING_TRANSFER_COPY } from '@/hooks/useMeetingTransfer';
import { isMac } from '@/lib/utils';

/**
 * Full-window drag-and-drop target for importing audio files. Mounted once at
 * the App level. Shows an overlay while a file is dragged over the window and,
 * on drop, runs each audio file through the same import pipeline as the
 * "Import audio file…" picker.
 *
 * Electron 32+ removed `File.path`, so the absolute path is resolved via
 * `webUtils.getPathForFile` through the preload bridge. Imports are
 * fire-and-forget — each file lands as a processing row in the meeting list
 * (the queue serialises them); enqueue failures fire a notification.
 *
 * Disabled while a recording is in progress: processNextInQueue only gates on
 * isProcessing, so dropping mid-recording would start a transcription
 * concurrent with the live session (OOM/contention risk on Apple Silicon).
 * This mirrors the picker button's `disabled={isRecording}` guard.
 */
export function ImportDropZone() {
  const [dragging, setDragging] = React.useState(false);

  // The window-level listeners are bound once, so read the live recording
  // status through a ref rather than re-binding on every status change.
  const { status } = useRecording();
  const isRecording = status === 'recording' || status === 'paused';
  const isRecordingRef = React.useRef(isRecording);
  React.useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.stenoai) return;

    // Drag events fire for any drag (incl. internal note→folder drags); only
    // react to OS file drags, which carry the 'Files' type.
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

    // enter/leave fire per child element crossed; a depth counter avoids the
    // overlay flickering as the cursor moves over nested elements.
    let depth = 0;

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault(); // required to allow the drop
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      // Mirror the picker's guard: never start an import concurrent with a
      // live recording. The overlay already shows the "stop recording" state,
      // so silently ignoring the drop here is the right call.
      if (isRecordingRef.current) return;
      const files = Array.from(e.dataTransfer!.files);
      for (const file of files) {
        const path = ipc().recording.getPathForFile(file);
        if (!path) continue;
        if (isMac && file.name.toLowerCase().endsWith('.stenomeeting')) {
          void importMeetingPackage(path).catch(() => {
            // importMeetingPackage already surfaced the failure.
          });
          continue;
        }
        if (!isAudioFile(file.name)) continue;
        void importAudioFile(path).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[importDropZone] import failed', err);
          notifyImportFailed(basenameStem(file.name));
        });
      }
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!dragging) return null;

  return (
    <div
      // pointer-events:none so the overlay never intercepts the drop — the
      // window-level listeners handle it. Ink-based scrim + ~120ms fade match
      // the design system (mirrors DialogOverlay) rather than a hard pop.
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 backdrop-blur-sm animate-in fade-in-0 duration-fast ease-steno"
      style={{ pointerEvents: 'none' }}
    >
      {/* Two visually distinct states so the blocked overlay never reads as a
          live drop target. Active: dashed border + audio icon = "drop here".
          Blocked (recording): solid border + ban icon + muted text = "not a
          target". Neutral palette only (paper+ink), so "blocked" is signalled
          by the ban glyph + muting, not a warning colour. */}
      <div
        className={
          isRecording
            ? 'flex flex-col items-center gap-3 rounded-xl border-2 px-12 py-10 opacity-90'
            : 'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-12 py-10'
        }
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--surface-raised)',
          color: isRecording ? 'var(--fg-2)' : 'var(--fg-1)',
        }}
      >
        {isRecording ? (
          <Ban className="size-8 text-muted-foreground" />
        ) : (
          <FileAudio className="size-8 text-muted-foreground" />
        )}
        <p className="text-sm font-medium">
          {isRecording
            ? 'Stop recording to import'
            : isMac
              ? MEETING_TRANSFER_COPY.drop
              : 'Drop audio to import'}
        </p>
      </div>
    </div>
  );
}

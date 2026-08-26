import { AudioLines, Folder as FolderIcon, Loader2 } from 'lucide-react';
import type { Meeting } from '@/lib/ipc';
import { navigate } from '@/lib/router';
import { useMeetingsList } from '@/lib/meetingsListContext';
import { stripReasoning } from '@/lib/markdown';

interface PreviousRowProps {
  meeting: Meeting;
  folderName?: string;
}

export function PreviousRow({ meeting, folderName }: PreviousRowProps) {
  const info = meeting.session_info;
  const when = formatTime(info.processed_at ?? info.updated_at);
  const duration = formatDuration(info.duration_seconds);
  const preview = previewText(meeting);
  const participants = Array.isArray(meeting.participants)
    ? meeting.participants.length
    : 0;
  const list = useMeetingsList();
  const isLive = meeting.is_recording;
  const isProcessing = meeting.is_processing;
  const isSynthetic = isLive || isProcessing;
  const showPreview = preview && !isSynthetic;

  // Synthetic rows route to the live or processing screen instead of trying
  // to open the sentinel summary_file (which doesn't exist on disk yet).
  const targetPath = isLive
    ? '/recording'
    : isProcessing
      ? '/meetings/processing'
      : `/meetings/${encodeURIComponent(info.summary_file)}`;

  const title = info.name || 'Untitled note';

  return (
    <div
      className="group relative flex cursor-pointer items-center justify-between py-[10px] -mx-3 px-3 rounded-lg transition-colors hover:bg-[color:var(--surface-hover)]"
      data-testid="previous-row"
      data-recording={isLive ? 'true' : undefined}
      data-processing={isProcessing ? 'true' : undefined}
      role="button"
      tabIndex={0}
      draggable={!isSynthetic && !!list}
      onDragStart={(e) =>
        !isSynthetic && list?.startMeetingDrag(info.summary_file, e)
      }
      onContextMenu={(e) =>
        !isSynthetic && list?.openMeetingContextMenu(info.summary_file, e)
      }
      onClick={() => navigate(targetPath)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(targetPath);
        }
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        {/* Letter avatar — the note title's first initial, native-macOS-style.
            Still paper+ink with no per-note colour: notes are told apart by
            title + preview, not an arbitrary hash colour (which read as
            meaningful and collided with the reserved status hues). */}
        <div
          aria-hidden="true"
          className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg text-[15px] font-medium"
          style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
        >
          {title.charAt(0).toUpperCase()}
        </div>
        
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <div
              className="truncate text-[13.5px] font-medium tracking-[-0.005em]"
              style={{ color: 'var(--fg-1)' }}
            >
              {title}
            </div>
            {isLive && <LiveBadge />}
            {isProcessing && <ProcessingBadge />}
          </div>
          
          {(folderName || participants > 0 || showPreview) && (
            <div
              className="flex items-center gap-1.5 truncate text-[12px] font-medium"
              style={{ color: 'var(--fg-muted)' }}
            >
              {folderName && (
                <>
                  <span className="flex items-center gap-1">
                    <FolderIcon className="size-3" />
                    {folderName}
                  </span>
                  {(participants > 0 || showPreview) && <span className="opacity-40">·</span>}
                </>
              )}
              {participants > 0 && (
                <>
                  <span>
                    {participants} {participants === 1 ? 'person' : 'people'}
                  </span>
                  {showPreview && <span className="opacity-40">·</span>}
                </>
              )}
              {showPreview && (
                <span className="truncate">{preview}</span>
              )}
            </div>
          )}
        </div>
      </div>
      
      <div
        className="flex flex-col items-end gap-1.5 pl-4 text-[12.5px] tabular-nums"
        style={{ color: 'var(--fg-2)' }}
      >
        <span>{isSynthetic ? 'Now' : (when ?? '')}</span>
        {/* Original audio still on disk. Shown only when present, never as a
            crossed-out "missing" marker: keep_recordings defaults off, so
            absence is the normal case and flagging it on most rows would be
            noise. What the icon buys is knowing, without opening the note,
            which recordings can still be re-transcribed or listened to for
            speaker review — the actions that silently disappear once the
            audio is gone. Sits beside the duration because both describe
            the recording rather than the note. */}
        {(duration || (!isSynthetic && meeting.has_audio)) && (
          <span className="flex items-center gap-1 text-[11.5px] opacity-70">
            {!isSynthetic && meeting.has_audio && (
              <AudioLines
                className="size-3"
                aria-label="Original audio still available"
                data-testid="previous-row-has-audio"
              >
                <title>Original audio still available</title>
              </AudioLines>
            )}
            {duration}
          </span>
        )}
      </div>
    </div>
  );
}

function LiveBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        background: 'var(--recording)',
        color: '#FFFFFF',
      }}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full bg-white"
        style={{ animation: 'pulse 1.4s ease-in-out infinite' }}
      />
      Recording
    </span>
  );
}

function ProcessingBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium"
      style={{
        background: 'var(--surface-sunken)',
        color: 'var(--fg-2)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <Loader2 className="size-[10px] animate-spin" aria-hidden />
      Processing
    </span>
  );
}

function formatTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(seconds?: number): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function previewText(meeting: Meeting): string | undefined {
  const summary = meeting.summary ? stripReasoning(meeting.summary).trim() : undefined;
  if (summary) return summary;
  const kp = meeting.key_points?.[0];
  if (typeof kp === 'string' && kp.trim()) return kp.trim();
  return undefined;
}

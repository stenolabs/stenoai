import * as React from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { useUndoDeleteStore, type UndoDeleteEntry } from '@/hooks/undoDeleteStore';
import { useUndoDeleteMeeting, useCommitDeleteMeeting } from '@/hooks/useMeetings';
import {
  useSpeakerNamingStatus,
  meetingStemFromSummaryFile,
} from '@/hooks/useSpeakerSuggestions';

/**
 * Bottom-right "Note deleted — Undo?" toast stack (#234). Deletion is a
 * soft-delete: main hides only the note's summary (an atomic rename) and pushes
 * an entry to the undo store. This component (mounted once at shell level so it
 * survives MeetingDetail's post-delete navigate) renders one toast per entry.
 *
 * Undo renames the summary back (near-infallible); letting the window elapse (or
 * dismissing) commits the permanent delete. The countdown is DISPLAY-ONLY — main
 * owns the real deadline (entry.deadline), so a slightly-off renderer countdown
 * is fine and a reload can't drift or lose the window (it rehydrates from main).
 */

// One-shot rehydration guard. AppShell is per-route (FACT B) so this component
// remounts on navigation; the module-level flag makes the list-pending-deletes
// rehydration run exactly once per app session, before any in-session delete, so
// it can never clobber an entry added after mount. `rehydratedPendingDeletes` is
// set ONLY after a SUCCESSFUL response — a transient failure must not permanently
// suppress rehydration (an already-pending delete would then have no Undo UI
// before main commits it), so a failed call leaves the flag false and the next
// mount retries. `rehydratePendingDeletesInFlight` prevents a second concurrent
// call while one is outstanding.
let rehydratedPendingDeletes = false;
let rehydratePendingDeletesInFlight = false;

function UndoDeleteToastItem({
  entry,
  onUndo,
  onExpire,
}: {
  entry: UndoDeleteEntry;
  onUndo: () => void;
  onExpire: () => void;
}) {
  // Keep the expire callback in a ref so the auto-dismiss timer runs exactly once
  // and isn't reset by re-renders (it must expire relative to main's deadline,
  // not the last render).
  const onExpireRef = React.useRef(onExpire);
  React.useEffect(() => {
    onExpireRef.current = onExpire;
  });

  // Remaining window is anchored to MAIN's deadline (entry.deadline), NOT this
  // component's mount. AppShell is rendered per-route (FACT B), so navigation
  // remounts this toast — a mount-relative timer would reset the window on every
  // navigate. Anchoring to the deadline makes a remount RESUME the countdown, and
  // keeps the renderer's display honest against main's authoritative timer.
  const remainingAtMount = React.useMemo(
    () => Math.max(0, entry.deadline - Date.now()),
    [entry.deadline],
  );

  const [progress, setProgress] = React.useState(remainingAtMount > 0 ? 1 : 0);

  React.useEffect(() => {
    if (remainingAtMount <= 0) {
      // Window already elapsed before this mount — expire immediately.
      onExpireRef.current();
      return;
    }
    const timer = setTimeout(() => onExpireRef.current(), remainingAtMount);
    // Kick the countdown bar off on the next frame so the CSS width transition
    // animates down to empty over the remaining time.
    const raf = requestAnimationFrame(() => setProgress(0));
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [remainingAtMount]);

  const name = entry.meeting?.session_info?.name?.trim();

  // What this delete costs that the note itself doesn't say.
  //
  // A person already CONFIRMED survives being deleted: their voiceprint
  // lives in config.json bound to the person, not to any meeting (checked
  // against a real library, where working prototypes came from meetings
  // deleted long ago). An UNNAMED cluster does not survive, and unlike
  // almost everything else here it cannot be reconstructed afterwards by
  // any means: putting a name to a voice means listening to it, listening
  // means the source audio, and committing this delete takes the audio.
  //
  // Shown HERE rather than in a confirmation dialog because there is no
  // confirmation dialog -- deleting a note is deliberately immediate, with
  // this undo window as the safety net ("asking first *and* offering undo
  // made the flow feel heavy", see MeetingDetail/MeetingsShell). Adding a
  // modal would undo that decision to say something a line in the toast
  // says while the delete is still reversible. The sidecar this reads is
  // unlinked at COMMIT, not at delete, so it is still on disk for exactly
  // as long as the window it is describing.
  //
  // Purely informational: no button, no blocked delete. Someone who knows
  // the meeting is worthless does not need to hear about its speakers.
  const namingStatus = useSpeakerNamingStatus(
    meetingStemFromSummaryFile(entry.summaryFile), true,
  );
  const unnamed = namingStatus.data?.unnamed_clusters ?? 0;

  return (
    <div
      className="pointer-events-auto relative flex w-[280px] flex-col overflow-hidden rounded-xl"
      style={{
        background: 'var(--surface-raised)',
        color: 'var(--fg-1)',
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-md)',
        fontFamily: 'var(--font-sans)',
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Trash2 size={14} style={{ color: 'var(--fg-2)', flexShrink: 0 }} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Note deleted</div>
          {name && (
            <div className="truncate text-[12px]" style={{ color: 'var(--fg-2)' }}>
              {name}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onUndo}
          className="cursor-pointer rounded-full border-0 px-2.5 py-1 text-[12px] font-medium"
          style={{ background: 'var(--fg-1)', color: 'var(--fg-inverse)' }}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={onExpire}
          aria-label="Dismiss and delete permanently"
          className="inline-flex cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-1"
          style={{ color: 'var(--fg-2)' }}
        >
          <X size={12} />
        </button>
      </div>
      {unnamed > 0 && (
        <div
          className="px-3 pb-2.5 text-[11.5px]"
          style={{ color: 'var(--fg-2)' }}
          data-testid="undo-delete-unnamed-speakers"
        >
          {`${unnamed} ${unnamed === 1 ? 'speaker was' : 'speakers were'} never named. `}
          {'Undo to name them — it needs the recording, which goes with this note.'}
        </div>
      )}
      {/* Countdown bar depleting over the undo window. */}
      <div
        aria-hidden
        style={{
          height: 2,
          width: `${progress * 100}%`,
          background: 'var(--fg-2)',
          opacity: 0.35,
          transition: `width ${Math.max(1, remainingAtMount)}ms linear`,
        }}
      />
    </div>
  );
}

export function UndoDeleteToast() {
  const entries = useUndoDeleteStore((s) => s.entries);
  const remove = useUndoDeleteStore((s) => s.remove);
  const undo = useUndoDeleteMeeting();
  const commit = useCommitDeleteMeeting();

  // One-shot rehydration: load main's in-flight soft-deletes so a renderer reload
  // during a window restores the toast(s) with main's authoritative deadline.
  React.useEffect(() => {
    if (rehydratedPendingDeletes || rehydratePendingDeletesInFlight) return;
    rehydratePendingDeletesInFlight = true;
    ipc()
      .meetings.listPendingDeletes()
      .then((res) => {
        if (!res.success) return; // leaves the flag false → next mount retries
        useUndoDeleteStore.getState().hydrate(
          res.pending.map((p) => ({
            id: p.id,
            meeting: p.meeting,
            summaryFile: p.summaryFile,
            deadline: p.deadline,
          })),
        );
        // Mark done ONLY on a successful response so a transient failure can't
        // permanently suppress rehydration for the session.
        rehydratedPendingDeletes = true;
      })
      .catch(() => {
        /* best-effort — a failed rehydrate just means no toasts to restore;
           the flag stays false so the next AppShell mount retries. */
      })
      .finally(() => {
        rehydratePendingDeletesInFlight = false;
      });
  }, []);

  const host = typeof document !== 'undefined' ? document.getElementById('toast-host') : null;
  if (!host || entries.length === 0) return null;

  const handleUndo = (entry: UndoDeleteEntry) => {
    // Fire the undo. On success the hook re-inserts the row + drops the store
    // entry; on failure the toast stays up and main's timer is the backstop.
    undo.mutate(entry.id);
  };

  const handleExpire = (entry: UndoDeleteEntry) => {
    // Dismiss / window elapsed: drop the toast and commit the permanent delete.
    // The list row was already removed from the cache on delete (and can't be
    // re-introduced — the summary is hidden on disk), so no cache surgery here.
    // Main's own timer is an idempotent backstop if this never fires (reload).
    remove(entry.id);
    commit.mutate(entry.id);
  };

  return createPortal(
    entries.map((entry) => (
      <UndoDeleteToastItem
        key={entry.id}
        entry={entry}
        onUndo={() => handleUndo(entry)}
        onExpire={() => handleExpire(entry)}
      />
    )),
    host,
  );
}

import * as React from 'react';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  Clock,
  FolderPlus,
  PencilLine,
} from 'lucide-react';
import { MeetingsShell } from '@/components/MeetingsShell';
import { useNavigate } from '@/lib/router';
import { useRecording } from '@/hooks/useRecording';
import { useLiveMeeting } from '@/hooks/useLiveMeeting';
import { useTranslation } from '@/i18n';
export function Recording() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const recording = useRecording();
  const live = useLiveMeeting();

  // If we land on /recording with no active recording (e.g. cold reload after
  // it stopped), bounce back home so we don't leave the user on a dead page.
  // We only bounce when the session is genuinely gone: a recording/paused
  // status means one is active or just starting (via "Take Notes" from another
  // route, whose ~2s Parakeet warm-up leaves live.active briefly false) — never
  // bounce that, or the user gets kicked off the page they just opened and it
  // reads as a no-op needing a second tap. Status 'processing' is handled by
  // the global listener which redirects to /meetings/processing.
  //
  // 500ms grace period: during a normal stop, the optimistic cache write
  // briefly transitions status (idle ↔ processing) and live.active flips off
  // BEFORE navigate('/meetings/processing') completes its render. Without the
  // delay this effect raced the optimistic flow and bounced the user back
  // home — visible most reliably when the user had been typing notes (queue
  // poll cadence + cache updates landed in a different order). The delay
  // lets the transition settle before we make any bouncing decision.
  const hasSession =
    live.active ||
    recording.status === 'recording' ||
    recording.status === 'paused' ||
    recording.status === 'processing';
  React.useEffect(() => {
    if (recording.isLoading) return;
    if (hasSession) return;
    const t = setTimeout(() => {
      if (!recording.isLoading && !hasSession) {
        navigate('/');
      }
    }, 500);
    return () => clearTimeout(t);
  }, [recording.isLoading, hasSession, navigate]);

  const startedAt = live.startedAt ?? new Date();

  return (
    <MeetingsShell activeSummaryFile={null} hideToolbar>
      <div
        data-testid="recording-page"
        className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        style={{ background: 'var(--page)' }}
      >
        <div className="scrollbar-clean min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[760px] px-12 pb-40 pt-8">
            <header className="mb-8">
              <button
                type="button"
                onClick={() => navigate('/')}
                className="mb-6 inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-[13px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]"
                style={{ color: 'var(--fg-2)' }}
                aria-label={t('recording.backToHome')}
              >
                <ChevronLeft size={15} />
                {t('nav.home')}
              </button>

              <EditableTitle
                value={live.title}
                onChange={live.setTitle}
                placeholder={t('recording.newNoteTitlePlaceholder')}
              />

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Chip icon={<CalendarIcon size={11} />}>
                  {formatDate(startedAt)}
                </Chip>
                <Chip icon={<Clock size={11} />}>
                  {t('recording.startedAt', { time: formatTime(startedAt) })}
                </Chip>
                <Chip icon={<FolderPlus size={11} />} dashed>
                  {t('recording.addToFolder')}
                </Chip>
              </div>
            </header>

            <section>
              <div
                className="mb-2 inline-flex items-center gap-1.5 text-[13px]"
                style={{ color: 'var(--fg-2)' }}
              >
                <PencilLine size={13} />
                {t('recording.myNotes')}
              </div>
              <textarea
                value={live.notes}
                onChange={(e) => live.setNotes(e.target.value)}
                placeholder={t('recording.myNotesPlaceholder')}
                spellCheck
                className="block w-full resize-none border-0 bg-transparent text-[15px] outline-none"
                style={{
                  color: 'var(--fg-1)',
                  fontFamily: 'var(--font-sans)',
                  lineHeight: 1.6,
                  minHeight: 320,
                }}
              />
            </section>
          </div>
        </div>
      </div>
    </MeetingsShell>
  );
}

interface EditableTitleProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}

function EditableTitle({ value, onChange, placeholder }: EditableTitleProps) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="w-full border-0 bg-transparent p-0 text-[34px] outline-none"
      style={{
        fontFamily: 'var(--font-serif)',
        letterSpacing: '-0.02em',
        color: 'var(--fg-1)',
        lineHeight: 1.15,
      }}
    />
  );
}

function Chip({
  icon,
  children,
  dashed = false,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px]"
      style={{
        color: 'var(--fg-2)',
        border: dashed
          ? '1px dashed var(--border-subtle)'
          : '1px solid var(--border-subtle)',
        background: dashed ? 'transparent' : 'var(--surface-raised)',
      }}
    >
      {icon}
      {children}
    </span>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTime(d: Date): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

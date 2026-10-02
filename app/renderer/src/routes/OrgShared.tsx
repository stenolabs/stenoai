import * as React from 'react';
import { ArrowLeft, Globe, Loader2, Lock, MoreHorizontal, Trash2, Users } from 'lucide-react';
import { MeetingsShell } from '@/components/MeetingsShell';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useActiveOrgMeeting } from '@/lib/askBarContext';
import { renderMarkdown } from '@/lib/markdown';
import { navigate } from '@/lib/router';
import {
  useOrgMeeting,
  useOrgMeetings,
  useOrgSession,
  useUnshareOrgMeeting,
} from '@/hooks/useOrg';
import { UI_LOCALE } from '@/lib/locale';

function formatDate(epoch: number): string {
  const d = new Date(epoch * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return 'today, ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(UI_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
}

function NotSignedIn() {
  return (
    <MeetingsShell activeSummaryFile={null}>
      <div className="mx-auto flex max-w-[480px] flex-col items-center gap-4 py-16 text-center">
        <div
          className="flex size-12 items-center justify-center rounded-full"
          style={{ background: 'var(--surface-raised)', color: 'var(--fg-2)' }}
        >
          <Users size={20} />
        </div>
        <h1 className="text-[24px] font-normal" style={{ fontFamily: 'var(--font-serif)', color: 'var(--fg-1)' }}>
          Connect your organisation
        </h1>
        <p className="text-[14px] leading-[1.55]" style={{ color: 'var(--fg-2)' }}>
          Sign in to your Steno enterprise adapter to see notes shared by your
          colleagues and chat across them.
        </p>
        <Button onClick={() => navigate('/settings')} className="mt-2">
          Open Settings → Organisation
        </Button>
      </div>
    </MeetingsShell>
  );
}

// ----------------------------------------------------------------------------
// LIST: /org/shared
// ----------------------------------------------------------------------------

export function OrgShared() {
  const session = useOrgSession();
  const meetings = useOrgMeetings(session.data?.signedIn ?? false);

  if (session.isLoading) {
    return (
      <MeetingsShell activeSummaryFile={null}>
        <div className="py-8 text-center text-[14px]" style={{ color: 'var(--fg-2)' }}>Loading…</div>
      </MeetingsShell>
    );
  }
  if (!session.data?.signedIn) return <NotSignedIn />;

  const rows = meetings.data ?? [];
  const myEmail = session.data.email;

  return (
    <MeetingsShell activeSummaryFile={null}>
      <div className="mx-auto max-w-[760px]">
        <header className="mb-8">
          <h1
            className="m-0 text-[28px] font-normal"
            style={{ fontFamily: 'var(--font-serif)', letterSpacing: '-0.02em', color: 'var(--fg-1)' }}
          >
            Shared notes
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {session.data.orgId} · {rows.length} {rows.length === 1 ? 'note' : 'notes'}
          </p>
        </header>

        {meetings.isLoading ? (
          <div className="py-8 text-center text-[14px]" style={{ color: 'var(--fg-2)' }}>Loading notes…</div>
        ) : meetings.error ? (
          <div className="rounded-[8px] border border-[color:var(--border-subtle)] p-4 text-[13px]" style={{ color: 'var(--danger, #b3261e)' }}>
            {(meetings.error as Error).message}
          </div>
        ) : rows.length === 0 ? (
          <div
            className="rounded-[10px] p-8 text-center text-[14px]"
            style={{
              background: 'var(--surface-sunken)',
              color: 'var(--fg-2)',
              border: '1px dashed var(--border-subtle)',
            }}
          >
            No shared notes yet — share one of your meetings with{' '}
            <span style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-mono)' }}>{session.data.orgId}</span>{' '}
            to see it here.
          </div>
        ) : (
          <ul className="flex flex-col">
            {rows.map((m) => (
              <SharedRow
                key={m.id}
                id={m.id}
                title={m.title}
                visibility={m.visibility}
                ownerEmail={m.owner_email}
                createdAt={m.created_at}
                isOwner={m.owner_email === myEmail}
              />
            ))}
          </ul>
        )}
      </div>
    </MeetingsShell>
  );
}

// ----------------------------------------------------------------------------
// DETAIL: /org/shared/:id  — body + chat-about-this-note
// ----------------------------------------------------------------------------

export function OrgSharedDetail({ id }: { id: string }) {
  const session = useOrgSession();
  // Don't fire the GET /meetings/:id call until we know the user is
  // signed in — otherwise the query will 401 (and clear the session)
  // before the route's NotSignedIn guard has a chance to render.
  const meeting = useOrgMeeting(session.data?.signedIn ? id : null);

  // Register with the global AskBar so its composer routes questions
  // through the org adapter against this note's body. Memoized so a fresh
  // object isn't synthesised on every render — without this the AskBar
  // context's effect would tear down + re-register every time React
  // re-rendered the route for any unrelated reason.
  const activeOrgMeeting = React.useMemo(
    () =>
      meeting.data
        ? {
            id: meeting.data.id,
            title: meeting.data.title,
            body: meeting.data.body ?? '',
            ownerEmail: meeting.data.owner_email,
            transcript: meeting.data.transcript_body ?? '',
          }
        : null,
    [
      meeting.data?.id,
      meeting.data?.title,
      meeting.data?.body,
      meeting.data?.owner_email,
      meeting.data?.transcript_body,
    ],
  );
  useActiveOrgMeeting(activeOrgMeeting);

  if (!session.data?.signedIn) return <NotSignedIn />;

  const bodyText = meeting.data?.body ?? '';

  return (
    <MeetingsShell activeSummaryFile={null}>
      <button
        type="button"
        onClick={() => navigate('/org/shared')}
        className="mb-5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]"
        style={{ color: 'var(--fg-2)' }}
      >
        <ArrowLeft size={12} /> Shared notes
      </button>

      {meeting.isLoading ? (
        <div className="py-8 text-[14px]" style={{ color: 'var(--fg-2)' }}>Loading…</div>
      ) : meeting.error ? (
        <div className="rounded-[8px] border border-[color:var(--border-subtle)] p-4 text-[13px]" style={{ color: 'var(--danger, #b3261e)' }}>
          {(meeting.error as Error).message}
        </div>
      ) : meeting.data ? (
        <>
          <header className="mb-8">
            <h1
              className="m-0 text-[28px] font-normal"
              style={{ fontFamily: 'var(--font-serif)', letterSpacing: '-0.02em', color: 'var(--fg-1)' }}
            >
              {meeting.data.title}
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px]" style={{ color: 'var(--fg-2)' }}>
              <span>shared by {meeting.data.owner_email}</span>
              <span>·</span>
              <span>{formatDate(meeting.data.created_at)}</span>
              {meeting.data.has_artifact && (
                <>
                  <span>·</span>
                  <span title="Body lives in your org's S3 bucket; the adapter fetched it server-side. Never written to this device.">
                    from S3
                  </span>
                </>
              )}
            </p>
          </header>
          {bodyText ? (
            <article
              className="prose-stenoai"
              style={{
                color: 'var(--fg-1)',
                maxWidth: '64ch',
                fontSize: '15.5px',
                lineHeight: 1.65,
              }}
            >
              {renderMarkdown(bodyText)}
            </article>
          ) : (
            <p className="text-[14px]" style={{ color: 'var(--fg-2)' }}>(no body)</p>
          )}
          {/* Bottom of the page — buffer so the global AskBar doesn't
              overlap the last paragraph when the conversation expands. */}
          <div style={{ height: 96 }} aria-hidden />
        </>
      ) : null}
    </MeetingsShell>
  );
}

// ----------------------------------------------------------------------------
// SharedRow — list row with hover-reveal Unshare action for owned notes.
// ----------------------------------------------------------------------------

interface SharedRowProps {
  id: string;
  title: string;
  visibility: 'private' | 'org';
  ownerEmail: string;
  createdAt: number;
  isOwner: boolean;
}

function SharedRow({ id, title, visibility, ownerEmail, createdAt, isOwner }: SharedRowProps) {
  const unshare = useUnshareOrgMeeting();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleUnshare = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setError(null);
    unshare.mutate(id, {
      onError: (err) => setError(err instanceof Error ? err.message : String(err)),
    });
  };

  return (
    <li
      className="group cursor-pointer border-t border-[color:var(--border-subtle)] py-3 transition-colors last:border-b hover:bg-[color:var(--surface-hover)]"
      onClick={() => navigate(`/org/shared/${encodeURIComponent(id)}`)}
    >
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium" style={{ color: 'var(--fg-1)' }}>
            {title}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px]" style={{ color: 'var(--fg-2)' }}>
            {visibility === 'org' ? <Globe size={11} /> : <Lock size={11} />}
            <span>{isOwner ? 'you' : ownerEmail}</span>
            <span>·</span>
            <span>{formatDate(createdAt)}</span>
            {error && (
              <>
                <span>·</span>
                <span style={{ color: 'var(--danger, #b3261e)' }}>{error}</span>
              </>
            )}
          </div>
        </div>
        {isOwner && (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                aria-label="Note actions"
                title="Actions"
                className={cn(
                  'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-opacity hover:bg-[color:var(--surface-active)]',
                  menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                )}
                style={{ color: 'var(--fg-2)' }}
              >
                {unshare.isPending ? (
                  <Loader2 className="size-[14px] animate-spin" />
                ) : (
                  <MoreHorizontal className="size-[14px]" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="right"
              className="w-[150px] p-1"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={handleUnshare}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 className="size-[13px]" />
                Unshare
              </button>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </li>
  );
}


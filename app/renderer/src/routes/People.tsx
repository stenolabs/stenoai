import * as React from 'react';
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  MessageSquare,
  Search,
  Users,
} from 'lucide-react';
import { MeetingsShell } from '@/components/MeetingsShell';
import { PreviousRow } from '@/components/home/PreviousRow';
import { useMeetings } from '@/hooks/useMeetings';
import { useChatSessions } from '@/hooks/useChatSessions';
import { useGlobalStreaming } from '@/hooks/useStreamingQuery';
import { recordPendingNewChat } from '@/routes/Chat';
import { deriveSessionName, GLOBAL_SCOPE } from '@/lib/chat';
import { buildPeopleIndex, normalizePersonKey, PersonItem } from '@/lib/peopleIndex';
import { navigate, useRoute } from '@/lib/router';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

function formatPersonDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function People() {
  const route = useRoute();
  const meetings = useMeetings();
  const chat = useChatSessions(GLOBAL_SCOPE, null);
  const streaming = useGlobalStreaming();

  const [searchQuery, setSearchQuery] = React.useState('');
  const [askInput, setAskInput] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const people = React.useMemo(() => {
    return buildPeopleIndex(meetings.data ?? []);
  }, [meetings.data]);

  // Decode selected person from route: /people/:personId
  const routePersonKey = React.useMemo(() => {
    if (!route.startsWith('/people/')) return null;
    const raw = route.slice('/people/'.length);
    try {
      return normalizePersonKey(decodeURIComponent(raw));
    } catch {
      return normalizePersonKey(raw);
    }
  }, [route]);

  const selectedPerson = React.useMemo<PersonItem | null>(() => {
    if (!routePersonKey) return null;
    return people.find((p) => p.id === routePersonKey) ?? null;
  }, [people, routePersonKey]);

  const selectedPersonMeetings = React.useMemo(() => {
    if (!selectedPerson) return [];
    const files = new Set(selectedPerson.summaryFiles);
    return (meetings.data ?? []).filter((m) =>
      files.has(m.session_info?.summary_file),
    );
  }, [selectedPerson, meetings.data]);

  const filteredPeople = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) =>
      p.name.toLowerCase().includes(q) || p.id.includes(q),
    );
  }, [people, searchQuery]);

  const handleAskSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = askInput.trim();
    if (!q || !selectedPerson || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);
    let createdSessionId: string | null = null;
    try {
      createdSessionId = await chat.createSession(deriveSessionName(q));
      await chat.appendMessage(createdSessionId, {
        role: 'user',
        content: q,
        ts: Date.now(),
      });
      const streamId = streaming.startGlobalStream(
        q,
        null,
        undefined,
        undefined,
        selectedPerson.summaryFiles,
      );
      recordPendingNewChat({
        sessionId: createdSessionId,
        streamId,
        folderId: null,
        selectedMeetingFiles: selectedPerson.summaryFiles,
      });
      navigate(`/chat/${encodeURIComponent(createdSessionId)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start chat';
      setSubmitError(message);
      if (createdSessionId) {
        try {
          await chat.deleteSession(createdSessionId);
        } catch {
          // best-effort rollback
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (meetings.isLoading) {
    return (
      <MeetingsShell activeSummaryFile={null}>
        <div className="flex min-h-[40vh] items-center justify-center text-[14px]" style={{ color: 'var(--fg-2)' }}>
          Loading people…
        </div>
      </MeetingsShell>
    );
  }

  // If viewing a specific person
  if (selectedPerson) {
    return (
      <MeetingsShell activeSummaryFile={null}>
        <div className="mx-auto max-w-[760px] pb-16">
          <header className="mb-6">
            <button
              type="button"
              onClick={() => navigate('/people')}
              className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors hover:text-[color:var(--fg-1)]"
              style={{ color: 'var(--fg-muted)' }}
              data-testid="people-back-button"
            >
              <ArrowLeft className="size-3.5" />
              <span>All people</span>
            </button>

            <div className="flex items-baseline justify-between gap-4">
              <h1
                className="m-0 text-[28px] font-normal"
                style={{ fontFamily: 'var(--font-serif)', letterSpacing: '-0.02em', color: 'var(--fg-1)' }}
                data-testid="person-detail-name"
              >
                {selectedPerson.name}
              </h1>
              <div className="text-[13px] tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                {selectedPerson.noteCount} {selectedPerson.noteCount === 1 ? 'note' : 'notes'}
                {selectedPerson.lastDate && ` · Last met ${formatPersonDate(selectedPerson.lastDate)}`}
              </div>
            </div>
          </header>

          {/* Ask scoped to this person's notes */}
          <section className="mb-8">
            <form onSubmit={handleAskSubmit} className="relative">
              <div
                className="flex items-center gap-2 rounded-lg border px-3 py-2 transition-all focus-within:shadow-[inset_0_0_0_1px_hsl(var(--border))]"
                style={{
                  background: 'var(--surface-raised)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <MessageSquare className="size-4 flex-shrink-0" style={{ color: 'var(--fg-muted)' }} />
                <input
                  type="text"
                  value={askInput}
                  onChange={(e) => setAskInput(e.target.value)}
                  placeholder={`Ask anything about notes with ${selectedPerson.name}…`}
                  aria-label={`Ask about notes with ${selectedPerson.name}`}
                  data-testid="person-ask-input"
                  className="flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-[color:var(--fg-muted)]"
                  style={{ color: 'var(--fg-1)' }}
                  disabled={isSubmitting}
                />
                <button
                  type="submit"
                  disabled={!askInput.trim() || isSubmitting}
                  data-testid="person-ask-submit"
                  aria-label="Submit question"
                  className="inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40"
                  style={{
                    background: 'var(--surface-hover)',
                    color: 'var(--fg-1)',
                  }}
                >
                  <ArrowUp className="size-4" />
                </button>
              </div>
              {submitError && (
                <div className="mt-2 text-[12.5px] text-red-500">{submitError}</div>
              )}
            </form>
          </section>

          {/* Meeting notes list */}
          <section>
            <h2
              className="mb-3 text-[12px] font-medium tracking-[0.02em] uppercase"
              style={{ color: 'var(--fg-muted)' }}
            >
              Notes with {selectedPerson.name} ({selectedPersonMeetings.length})
            </h2>

            {selectedPersonMeetings.length === 0 ? (
              <div className="py-12 text-center text-[13px]" style={{ color: 'var(--fg-muted)' }}>
                No notes found for this attendee.
              </div>
            ) : (
              <div data-testid="person-notes-list">
                {selectedPersonMeetings.map((m) => (
                  <PreviousRow key={m.session_info.summary_file} meeting={m} />
                ))}
              </div>
            )}
          </section>
        </div>
      </MeetingsShell>
    );
  }

  // Directory listing view
  return (
    <MeetingsShell activeSummaryFile={null}>
      <div className="mx-auto max-w-[760px] pb-16">
        <header className="mb-6 flex items-baseline justify-between gap-4">
          <div>
            <h1
              className="m-0 text-[28px] font-normal"
              style={{ fontFamily: 'var(--font-serif)', letterSpacing: '-0.02em', color: 'var(--fg-1)' }}
            >
              People
            </h1>
            <p className="mt-1 text-[13.5px]" style={{ color: 'var(--fg-muted)' }}>
              Attendees automatically discovered across your notes.
            </p>
          </div>
          {people.length > 0 && (
            <div className="text-[13px] tabular-nums" style={{ color: 'var(--fg-muted)' }}>
              {people.length} {people.length === 1 ? 'person' : 'people'}
            </div>
          )}
        </header>

        {people.length === 0 ? (
          <div className="mx-auto flex max-w-[440px] flex-col items-center gap-3 py-16 text-center">
            <div
              className="flex size-12 items-center justify-center rounded-full"
              style={{ background: 'var(--surface-raised)', color: 'var(--fg-muted)' }}
            >
              <Users className="size-6" />
            </div>
            <h2
              className="m-0 text-[20px] font-normal"
              style={{ fontFamily: 'var(--font-serif)', color: 'var(--fg-1)' }}
            >
              No attendees yet
            </h2>
            <p className="text-[13.5px] leading-[1.55]" style={{ color: 'var(--fg-muted)' }}>
              Attendees are automatically discovered from calendar-matched meetings.
              Once you record or import a meeting with calendar attendees, they will appear here.
            </p>
            <Button onClick={() => navigate('/')} className="mt-2" variant="outline">
              Back to Home
            </Button>
          </div>
        ) : (
          <div>
            {people.length > 5 && (
              <div className="mb-4 relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4"
                  style={{ color: 'var(--fg-muted)' }}
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter people…"
                  data-testid="people-search-input"
                  aria-label="Filter people"
                  className="h-9 w-full rounded-md border px-3 pl-9 text-[13px] outline-none transition-colors focus:shadow-[inset_0_0_0_1px_hsl(var(--border))]"
                  style={{
                    background: 'var(--surface-raised)',
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--fg-1)',
                  }}
                />
              </div>
            )}

            <div className="divide-y rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }} data-testid="people-directory-list">
              {filteredPeople.length === 0 ? (
                <div className="py-8 text-center text-[13px]" style={{ color: 'var(--fg-muted)' }}>
                  No people matching &ldquo;{searchQuery}&rdquo;
                </div>
              ) : (
                filteredPeople.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => navigate(`/people/${encodeURIComponent(p.id)}`)}
                    className={cn(
                      'group flex w-full items-center justify-between px-4 py-3 text-left transition-colors',
                      'hover:bg-[color:var(--surface-hover)] focus-visible:bg-[color:var(--surface-hover)] outline-none',
                    )}
                    data-testid={`person-row-${p.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="flex size-8 items-center justify-center rounded-full text-[13px] font-medium"
                        style={{
                          background: 'var(--surface-sunken)',
                          color: 'var(--fg-1)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        {p.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-[14px] font-medium" style={{ color: 'var(--fg-1)' }}>
                          {p.name}
                        </div>
                        <div className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
                          {p.noteCount} {p.noteCount === 1 ? 'note' : 'notes'}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {p.lastDate && (
                        <span className="text-[12px] tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                          {formatPersonDate(p.lastDate)}
                        </span>
                      )}
                      <ChevronRight
                        className="size-4 opacity-40 transition-opacity group-hover:opacity-100"
                        style={{ color: 'var(--fg-muted)' }}
                      />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </MeetingsShell>
  );
}

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type ChatSessionsBlob } from '@/lib/ipc';

export type ChatSession = ChatSessionsBlob['sessions'][number];
export type ChatMessage = ChatSession['messages'][number];

function newSessionId() {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyBlob(): ChatSessionsBlob {
  return { sessions: [] };
}

const CHAT_KEY = ['chat-sessions'] as const;

// Legacy format written by the old renderer:
// [[meetingName, OldSession[]], ...]
type LegacyMessage = { role: 'user' | 'ai'; content: string };
type LegacySession = { id: string; title: string; messages: LegacyMessage[]; pending: boolean };
type LegacyBlob = [meetingName: string, sessions: LegacySession[]][];

function migrateLegacyBlob(legacy: LegacyBlob): ChatSessionsBlob {
  const sessions: ChatSession[] = legacy.flatMap(([meetingName, oldSessions]) =>
    oldSessions.map((s) => {
      const ts = Number(s.id) || Date.now();
      return {
        id: s.id,
        name: meetingName ? `${meetingName} — ${s.title}` : s.title,
        messages: s.messages.map((m) => ({
          role: m.role === 'ai' ? ('assistant' as const) : ('user' as const),
          content: m.content,
          ts,
        })),
        createdAt: ts,
        updatedAt: ts,
      };
    }),
  );
  return { sessions };
}

/**
 * Returns the full chat blob (every session across every meeting). Used by
 * the Chat tab's Recents list and any future global chat-history view.
 * Shares the same query key as useChatSessions so a save in one place is
 * reflected everywhere.
 */
export function useAllChatSessions() {
  return useQuery<ChatSessionsBlob>({
    queryKey: CHAT_KEY,
    queryFn: async () => {
      const res = await ipc().chat.load();
      if (!res.success) throw new Error(res.error);
      const data = res.data;
      if (!data) return emptyBlob();
      if (Array.isArray(data.sessions)) return data;
      if (Array.isArray(data)) return migrateLegacyBlob(data as unknown as LegacyBlob);
      return emptyBlob();
    },
    staleTime: Infinity,
  });
}

export function useChatSessions(summaryFile: string | null, meetingName?: string | null) {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const query = useQuery<ChatSessionsBlob>({
    queryKey: CHAT_KEY,
    queryFn: async () => {
      const res = await ipc().chat.load();
      if (!res.success) throw new Error(res.error);
      const data = res.data;
      if (!data) return emptyBlob();
      if (Array.isArray(data.sessions)) return data;
      // Migrate legacy format: [[meetingName, OldSession[]], ...]
      // Old sessions have {id, title, messages: [{role:'user'|'ai', content}], pending}
      if (Array.isArray(data)) return migrateLegacyBlob(data as unknown as LegacyBlob);
      return emptyBlob();
    },
    staleTime: Infinity,
  });

  const blob = query.data ?? emptyBlob();

  // Expose sessions that belong to this meeting. Legacy sessions migrated from
  // the old renderer don't have a summaryFile (the legacy format only tracked
  // meeting names), so we best-effort match them via the "meetingName — title"
  // prefix the migration writes into the session name. Sessions that can't be
  // associated with any meeting stay in the blob but aren't surfaced here, so
  // they don't leak across meetings.
  const meetingSessions = React.useMemo(() => {
    if (!summaryFile) return [];
    const matched = blob.sessions.filter((s) => s.summaryFile === summaryFile);
    if (!meetingName) return matched;
    const legacyPrefix = `${meetingName} — `;
    const legacyMatches = blob.sessions.filter(
      (s) => !s.summaryFile && s.name.startsWith(legacyPrefix),
    );
    return [...matched, ...legacyMatches];
  }, [blob.sessions, summaryFile, meetingName]);

  // Always read the freshest blob from the cache so that rapid-fire mutations
  // (createSession → appendMessage in the same tick) don't clobber each other
  // via stale closures.
  const readLatest = React.useCallback((): ChatSessionsBlob => {
    return queryClient.getQueryData<ChatSessionsBlob>(CHAT_KEY) ?? emptyBlob();
  }, [queryClient]);

  // When the meeting changes, restore the most recently updated session for
  // that meeting (so returning to a note shows your previous chat).
  React.useEffect(() => {
    if (!summaryFile) {
      setActiveId(null);
      return;
    }
    const sorted = readLatest()
      .sessions.filter((s) => s.summaryFile === summaryFile)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    setActiveId(sorted[0]?.id ?? null);
  }, [summaryFile, readLatest, query.isSuccess]);

  const persist = React.useCallback(
    async (next: ChatSessionsBlob) => {
      const previous = queryClient.getQueryData<ChatSessionsBlob>(CHAT_KEY);
      queryClient.setQueryData(CHAT_KEY, next);
      const res = await ipc().chat.save(next);
      if (!res.success) {
        // Rollback so the cache and disk stay in sync, and surface the error
        // to callers instead of swallowing the failure.
        queryClient.setQueryData(CHAT_KEY, previous);
        throw new Error(res.error || 'Failed to save chat sessions');
      }
    },
    [queryClient],
  );

  const activeSession = React.useMemo(
    () => meetingSessions.find((s) => s.id === activeId) ?? null,
    [meetingSessions, activeId],
  );

  const createSession = React.useCallback(
    async (name?: string, scopeFolderId?: string | null) => {
      const now = Date.now();
      const session: ChatSession = {
        id: newSessionId(),
        name: name ?? 'New chat',
        ...(scopeFolderId !== undefined ? { scopeFolderId } : {}),
        ...(summaryFile ? { summaryFile } : {}),
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      const current = readLatest();
      // Switch the view to the new empty session immediately. persist() awaits
      // the disk write (ipc().chat.save), which is slow enough on some machines
      // (e.g. Windows) that waiting for it leaves the previous conversation on
      // screen — looking like "New chat" did nothing. setActiveId + the cache
      // update inside persist both run before persist's first await, so React
      // batches them into one clean switch to the empty session.
      setActiveId(session.id);
      await persist({ sessions: [session, ...current.sessions] });
      return session.id;
    },
    [persist, readLatest, summaryFile],
  );

  const appendMessage = React.useCallback(
    async (sessionId: string, message: ChatMessage) => {
      const current = readLatest();
      await persist({
        sessions: current.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                messages: [...s.messages, message],
                updatedAt: Date.now(),
              }
            : s,
        ),
      });
    },
    [persist, readLatest],
  );

  const setScope = React.useCallback(async (sessionId: string, scopeFolderId: string | null) => {
    const current = readLatest();
    await persist({ sessions: current.sessions.map((s) => s.id === sessionId ? { ...s, scopeFolderId } : s) });
  }, [persist, readLatest]);

  const renameSession = React.useCallback(
    async (sessionId: string, name: string) => {
      const current = readLatest();
      await persist({
        sessions: current.sessions.map((s) =>
          s.id === sessionId ? { ...s, name, updatedAt: Date.now() } : s,
        ),
      });
    },
    [persist, readLatest],
  );

  const deleteSession = React.useCallback(
    async (sessionId: string) => {
      const current = readLatest();
      if (activeId === sessionId) setActiveId(null);
      await persist({
        sessions: current.sessions.filter((s) => s.id !== sessionId),
      });
    },
    [persist, readLatest, activeId],
  );

  return {
    sessions: meetingSessions,
    activeId,
    activeSession,
    setActiveId,
    createSession,
    appendMessage,
    renameSession,
    setScope,
    deleteSession,
    isLoading: query.isLoading,
  };
}

import * as React from 'react';
import { ipc } from '@/lib/ipc';
import { ORG_SHARED_SCOPE } from '@/components/FolderScopePicker';
import { buildOrgChatPayload } from '@/lib/orgChat';

export type StreamStatus = 'streaming' | 'done' | 'error';

export interface StreamState {
  text: string;
  status: StreamStatus;
  error: string | null;
}

export interface StreamResult {
  text: string;
  status: 'done' | 'error';
  error: string | null;
}

export interface StreamOptions {
  onChunk?: (chunk: string) => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
  onComplete?: (result: StreamResult) => void;
}
const MAX_LIVE_HISTORY_ENTRIES = 6;
const MAX_LIVE_HISTORY_ENTRY_CHARS = 4000;
const MAX_TOTAL_LIVE_HISTORY_CHARS = 12000;

export function normalizeLiveHistory(
  rawHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
): Array<{ role: 'user' | 'assistant'; content: string }> | undefined {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) return undefined;

  const valid = rawHistory.filter(
    (entry) =>
      entry &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string' &&
      entry.content.trim().length > 0
  );
  if (valid.length === 0) return undefined;

  const sliced = valid.slice(-MAX_LIVE_HISTORY_ENTRIES);
  const boundedEntries = sliced.map((entry) => ({
    role: entry.role,
    content: entry.content.slice(0, MAX_LIVE_HISTORY_ENTRY_CHARS),
  }));

  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let totalChars = 0;
  for (let i = boundedEntries.length - 1; i >= 0; i--) {
    const entry = boundedEntries[i];
    if (totalChars + entry.content.length <= MAX_TOTAL_LIVE_HISTORY_CHARS) {
      result.unshift(entry);
      totalChars += entry.content.length;
    } else {
      const remaining = MAX_TOTAL_LIVE_HISTORY_CHARS - totalChars;
      if (remaining > 0) {
        result.unshift({
          role: entry.role,
          content: entry.content.slice(0, remaining),
        });
        totalChars += remaining;
      }
      break;
    }
  }

  return result.length > 0 ? result : undefined;
}

function newId() {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useStreamingQuery() {
  const [streams, setStreams] = React.useState<Record<string, StreamState>>({});
  const unsubsRef = React.useRef<Map<string, () => void>>(new Map());
  const activeRef = React.useRef<Set<string>>(new Set());

  // Tear down the IPC subscription for a stream and forget its handle.
  // Called from onDone/onError so the listener doesn't linger past the
  // stream's lifetime (otherwise unsubsRef accumulates dead entries until
  // the component unmounts).
  const detachStream = (id: string) => {
    const off = unsubsRef.current.get(id);
    if (off) {
      off();
      unsubsRef.current.delete(id);
    }
    activeRef.current.delete(id);
  };

  const startStream = React.useCallback(
    (file: string, question: string, options?: StreamOptions): string => {
      const id = newId();
      setStreams((prev) => ({
        ...prev,
        [id]: { text: '', status: 'streaming', error: null },
      }));
      activeRef.current.add(id);

      let accumulatedText = '';
      const off = ipc().subscribeQueryStream(id, {
        onChunk: (chunk) => {
          accumulatedText += chunk;
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, text: current.text + chunk } };
          });
          options?.onChunk?.(chunk);
        },
        onDone: () => {
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, status: 'done' } };
          });
          detachStream(id);
          options?.onDone?.();
          options?.onComplete?.({ text: accumulatedText, status: 'done', error: null });
        },
        onError: (err) => {
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, status: 'error', error: err.message } };
          });
          detachStream(id);
          options?.onError?.(err);
          options?.onComplete?.({ text: accumulatedText, status: 'error', error: err.message });
        },
      });
      unsubsRef.current.set(id, off);
      ipc().query.askStream(id, file, question);
      return id;
    },
    []
  );

  // Cross-note variant of startStream — same wire shape, no summaryFile.
  // Used by the Chat tab to ask questions across every meeting summary,
  // optionally scoped to a single folder OR to the org-shared corpus
  // (folderId === ORG_SHARED_SCOPE).
  //
  // For org scope, we asynchronously build the corpus then dispatch through
  // ipc().org.chatStream — chunks land on the same query-chunk channel as
  // local chat so the renderer doesn't need a parallel subscription.
  const startGlobalStream = React.useCallback(
    (
      question: string,
      folderId?: string | null,
      orgHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
      options?: StreamOptions,
      meetingFiles?: string[] | null
    ): string => {
      const id = newId();
      setStreams((prev) => ({
        ...prev,
        [id]: { text: '', status: 'streaming', error: null },
      }));
      activeRef.current.add(id);

      let accumulatedText = '';
      const off = ipc().subscribeQueryStream(id, {
        onChunk: (chunk) => {
          accumulatedText += chunk;
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, text: current.text + chunk } };
          });
          options?.onChunk?.(chunk);
        },
        onDone: () => {
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, status: 'done' } };
          });
          detachStream(id);
          options?.onDone?.();
          options?.onComplete?.({ text: accumulatedText, status: 'done', error: null });
        },
        onError: (err) => {
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, status: 'error', error: err.message } };
          });
          detachStream(id);
          options?.onError?.(err);
          options?.onComplete?.({ text: accumulatedText, status: 'error', error: err.message });
        },
      });
      unsubsRef.current.set(id, off);

      if (folderId === ORG_SHARED_SCOPE) {
        // Build the corpus + dispatch through the org adapter. The fetch is
        // async; the user can cancel before payload-build completes, so we
        // re-check activeRef before firing the actual stream to avoid kicking
        // off a request the renderer no longer cares about.
        void (async () => {
          try {
            const payload = await buildOrgChatPayload(orgHistory ?? [], question);
            if (!activeRef.current.has(id)) return; // cancelled while building
            ipc().org.chatStream(id, payload);
          } catch (e) {
            if (!activeRef.current.has(id)) return; // cancelled while building
            setStreams((prev) => {
              const current = prev[id];
              if (!current) return prev;
              return {
                ...prev,
                [id]: { ...current, status: 'error', error: (e as Error).message },
              };
            });
            detachStream(id);
            const err = e as Error;
            options?.onError?.(err);
            options?.onComplete?.({ text: accumulatedText, status: 'error', error: err.message });
          }
        })();
      } else {
        ipc().query.chatGlobalStream(id, question, folderId ?? null, meetingFiles ?? null);
      }
      return id;
    },
    []
  );

  /** Stream a question against a single shared note's body, via the org
   *  adapter. Mirrors startStream's API but takes the note's system prompt
   *  directly instead of a local file path. */
  const startOrgNoteStream = React.useCallback(
    (
      system: string,
      question: string,
      history?: Array<{ role: 'user' | 'assistant'; content: string }>,
      options?: StreamOptions
    ): string => {
      const id = newId();
      setStreams((prev) => ({
        ...prev,
        [id]: { text: '', status: 'streaming', error: null },
      }));
      activeRef.current.add(id);

      let accumulatedText = '';
      const off = ipc().subscribeQueryStream(id, {
        onChunk: (chunk) => {
          accumulatedText += chunk;
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, text: current.text + chunk } };
          });
          options?.onChunk?.(chunk);
        },
        onDone: () => {
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, status: 'done' } };
          });
          detachStream(id);
          options?.onDone?.();
          options?.onComplete?.({ text: accumulatedText, status: 'done', error: null });
        },
        onError: (err) => {
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, status: 'error', error: err.message } };
          });
          detachStream(id);
          options?.onError?.(err);
          options?.onComplete?.({ text: accumulatedText, status: 'error', error: err.message });
        },
      });
      unsubsRef.current.set(id, off);

      const messages = [...(history ?? []), { role: 'user' as const, content: question }];
      ipc().org.chatStream(id, { system, messages });
      return id;
    },
    []
  );

  /** Stream a question against the live (in-progress) recording transcript.
   *  Routes to ipc().query.askLiveStream; main uses the same configured
   *  provider and model as summaries. Chunks land on the standard query
   *  stream channels so the existing subscription drives the UI. */
  const startLiveStream = React.useCallback(
    (
      sessionName: string,
      question: string,
      historyOrOptions?: Array<{ role: 'user' | 'assistant'; content: string }> | StreamOptions,
      options?: StreamOptions
    ): string => {
      const history = Array.isArray(historyOrOptions) ? historyOrOptions : undefined;
      const opts = Array.isArray(historyOrOptions) ? options : historyOrOptions;

      const id = newId();
      setStreams((prev) => ({
        ...prev,
        [id]: { text: '', status: 'streaming', error: null },
      }));
      activeRef.current.add(id);

      let accumulatedText = '';
      const off = ipc().subscribeQueryStream(id, {
        onChunk: (chunk) => {
          accumulatedText += chunk;
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, text: current.text + chunk } };
          });
          opts?.onChunk?.(chunk);
        },
        onDone: () => {
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, status: 'done' } };
          });
          detachStream(id);
          opts?.onDone?.();
          opts?.onComplete?.({ text: accumulatedText, status: 'done', error: null });
        },
        onError: (err) => {
          setStreams((prev) => {
            const current = prev[id];
            if (!current) return prev;
            return { ...prev, [id]: { ...current, status: 'error', error: err.message } };
          });
          detachStream(id);
          opts?.onError?.(err);
          opts?.onComplete?.({ text: accumulatedText, status: 'error', error: err.message });
        },
      });
      unsubsRef.current.set(id, off);

      const boundedHistory = normalizeLiveHistory(history);
      if (boundedHistory && boundedHistory.length > 0) {
        ipc().query.askLiveStream(id, sessionName, question, boundedHistory);
      } else {
        ipc().query.askLiveStream(id, sessionName, question);
      }
      return id;
    },
    []
  );

  const cancelStream = React.useCallback((id: string) => {
    const off = unsubsRef.current.get(id);
    off?.();
    unsubsRef.current.delete(id);
    ipc().query.cancel(id);
    setStreams((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, status: 'done' } };
    });
    activeRef.current.delete(id);
  }, []);

  const clearStream = React.useCallback((id: string) => {
    setStreams((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  React.useEffect(() => {
    const subscriptions = unsubsRef.current;
    const activeStreams = activeRef.current;
    return () => {
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
      for (const id of activeStreams) {
        try {
          ipc().query.cancel(id);
        } catch {
          // bridge may already be torn down
        }
      }
      activeStreams.clear();
    };
  }, []);

  return {
    streams,
    startStream,
    startGlobalStream,
    startOrgNoteStream,
    startLiveStream,
    cancelStream,
    clearStream,
  };
}

export type StreamingQueryApi = ReturnType<typeof useStreamingQuery>;

// Context-shared streaming state. Mounted at App level so streams survive
// route changes (e.g. submitting on /chat then navigating to /chat/<id>
// without losing the in-flight response). Consumers should prefer
// useGlobalStreaming() over calling useStreamingQuery() directly.
const StreamingContext = React.createContext<StreamingQueryApi | null>(null);

export function StreamingProvider({ children }: { children: React.ReactNode }) {
  const value = useStreamingQuery();
  return React.createElement(StreamingContext.Provider, { value }, children);
}

export function useGlobalStreaming(): StreamingQueryApi {
  const ctx = React.useContext(StreamingContext);
  if (!ctx) {
    throw new Error('useGlobalStreaming must be used inside <StreamingProvider>');
  }
  return ctx;
}

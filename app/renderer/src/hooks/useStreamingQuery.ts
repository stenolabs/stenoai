import * as React from 'react';
import { ipc, type ChatRequest } from '@/lib/ipc';
import { GENERAL_SCOPE, ORG_SHARED_SCOPE } from '@/components/FolderScopePicker';
import { buildOrgChatPayload } from '@/lib/orgChat';

export type StreamStatus = 'streaming' | 'done' | 'error';

export interface StreamState {
  text: string;
  status: StreamStatus;
  error: string | null;
}

function newId() {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useStreamingQuery() {
  const [streams, setStreams] = React.useState<Record<string, StreamState>>({});
  const unsubsRef = React.useRef<Map<string, () => void>>(new Map());
  const activeRef = React.useRef<Set<string>>(new Set());
  const completionsRef = React.useRef(new Map<string, () => void>());

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

  const startStream = React.useCallback((file: string, question: string): string => {
    const id = newId();
    setStreams((prev) => ({
      ...prev,
      [id]: { text: '', status: 'streaming', error: null },
    }));
    activeRef.current.add(id);

    const off = ipc().subscribeQueryStream(id, {
      onChunk: (chunk) => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, text: current.text + chunk } };
        });
      },
      onDone: () => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, status: 'done' } };
        });
        detachStream(id);
      },
      onError: (err) => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, status: 'error', error: err.message } };
        });
        detachStream(id);
      },
    });
    unsubsRef.current.set(id, off);
    ipc().query.askStream(id, file, question);
    return id;
  }, []);

  // Cross-note variant of startStream — same wire shape, no summaryFile.
  // Used by the Chat tab to ask questions across every meeting summary,
  // optionally scoped to a single folder OR to the org-shared corpus
  // (folderId === ORG_SHARED_SCOPE).
  //
  // For org scope, we asynchronously build the corpus then dispatch through
  // ipc().org.chatStream — chunks land on the same query-chunk channel as
  // local chat so the renderer doesn't need a parallel subscription.
  const startGlobalStream = React.useCallback((
    question: string,
    folderId?: string | null,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): string => {
    const id = newId();
    setStreams((prev) => ({
      ...prev,
      [id]: { text: '', status: 'streaming', error: null },
    }));
    activeRef.current.add(id);

    const off = ipc().subscribeQueryStream(id, {
      onChunk: (chunk) => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, text: current.text + chunk } };
        });
      },
      onDone: () => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, status: 'done' } };
        });
        detachStream(id);
      },
      onError: (err) => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, status: 'error', error: err.message } };
        });
        detachStream(id);
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
          const payload = await buildOrgChatPayload(history ?? [], question);
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
        }
      })();
    } else {
      ipc().query.chatContext(id, { scope: folderId === GENERAL_SCOPE ? 'general' : 'notes', question, folder: folderId === GENERAL_SCOPE ? undefined : folderId, history: history ?? [] });
    }
    return id;
  }, []);

  /** Stream a question against a single shared note's body, via the org
   *  adapter. Mirrors startStream's API but takes the note's system prompt
   *  directly instead of a local file path. */
  const startOrgNoteStream = React.useCallback((
    system: string,
    question: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): string => {
    const id = newId();
    setStreams((prev) => ({
      ...prev,
      [id]: { text: '', status: 'streaming', error: null },
    }));
    activeRef.current.add(id);

    const off = ipc().subscribeQueryStream(id, {
      onChunk: (chunk) => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, text: current.text + chunk } };
        });
      },
      onDone: () => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, status: 'done' } };
        });
        detachStream(id);
      },
      onError: (err) => {
        setStreams((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, status: 'error', error: err.message } };
        });
        detachStream(id);
      },
    });
    unsubsRef.current.set(id, off);

    const messages = [
      ...(history ?? []),
      { role: 'user' as const, content: question },
    ];
    ipc().org.chatStream(id, { system, messages });
    return id;
  }, []);

  // Completion belongs to the request, not the composer lifecycle. Closing a
  // transcript panel or stopping recording must not discard an assistant turn.
  const startContextStream = React.useCallback((
    request: ChatRequest,
    onComplete?: (result: StreamState) => void,
  ): string => {
    const id = newId();
    let result: StreamState = { text: '', status: 'streaming', error: null };
    let finished = false;
    setStreams((prev) => ({ ...prev, [id]: result }));
    activeRef.current.add(id);
    const finish = (status: StreamStatus, error: string | null = null) => {
      if (finished) return;
      finished = true;
      result = { ...result, status, error };
      setStreams((prev) => ({ ...prev, [id]: result }));
      completionsRef.current.delete(id);
      detachStream(id);
      onComplete?.(result);
    };
    const off = ipc().subscribeQueryStream(id, {
      onChunk: (chunk) => {
        if (finished) return;
        result = { ...result, text: result.text + chunk };
        const snapshot = result;
        setStreams((prev) => ({ ...prev, [id]: snapshot }));
      },
      onDone: () => finish('done'),
      onError: (error) => finish('error', error.message),
    });
    unsubsRef.current.set(id, off);
    completionsRef.current.set(id, () => finish('done'));
    ipc().query.chatContext(id, request);
    return id;
  }, []);

  const cancelStream = React.useCallback((id: string) => {
    const complete = completionsRef.current.get(id);
    if (complete) { complete(); ipc().query.cancel(id); return; }
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
    return () => {
      for (const off of unsubsRef.current.values()) off();
      unsubsRef.current.clear();
      for (const id of activeRef.current) {
        try {
          ipc().query.cancel(id);
        } catch {
          // bridge may already be torn down
        }
      }
      activeRef.current.clear();
    };
  }, []);

  return {
    streams,
    startStream,
    startContextStream,
    startGlobalStream,
    startOrgNoteStream,
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

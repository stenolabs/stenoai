import * as React from 'react';
import { ArrowUp, Check, ChevronDown, ChevronUp, Copy, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { renderMarkdown } from '@/lib/markdown';
import { useAskBar, type ActiveOrgMeeting } from '@/lib/askBarContext';
import { useChatSessions, type ChatMessage, type ChatSession } from '@/hooks/useChatSessions';
import { useGlobalStreaming, type StreamResult } from '@/hooks/useStreamingQuery';
import { OrgTranscriptPanelContent, TranscriptPanelContent } from '@/components/TranscriptPanel';
import { useMeeting } from '@/hooks/useMeetings';
import { useRecording } from '@/hooks/useRecording';
import { buildTranscriptBundle } from '@/lib/transcriptBundle';

// ---------------------------------------------------------------------------
// Transcript bar — rendered separately above the chat bar
// ---------------------------------------------------------------------------

export function TranscriptBar() {
  const {
    activeSummaryFile,
    activeMeetingName,
    activeOrgMeeting,
    transcriptOpen,
    setTranscriptOpen,
  } = useAskBar();
  const meeting = useMeeting(activeSummaryFile ?? undefined);
  const recording = useRecording();
  const [copied, setCopied] = React.useState(false);
  const orgTranscript = activeOrgMeeting?.transcript ?? '';
  const hasOrgTranscript = orgTranscript.trim().length > 0;

  // Resume = continue recording INTO this note (the new segment is appended;
  // the note is then marked stale → the "Generate notes" CTA). Local notes only —
  // you can't record into a shared org note — and only while idle. Lives in
  // the transcript footer (Granola-style), replacing the old standalone dock
  // mic; the live pill takes over once recording starts.
  const canResume = Boolean(activeSummaryFile) && recording.status === 'idle';
  const onResume = () => {
    if (!activeSummaryFile) return;
    setTranscriptOpen(false);
    // startRecording already surfaces a capture/IPC failure to the user and
    // rethrows; swallow the fire-and-forget rejection here so an unavailable
    // mic or failed IPC doesn't surface as an unhandled renderer rejection.
    void recording
      .startRecording(activeMeetingName ?? undefined, 'manual', activeSummaryFile)
      .catch(() => {});
  };

  const copyTranscript = async () => {
    let text = '';
    if (activeOrgMeeting) {
      text = orgTranscript.trim();
    } else if (meeting.data) {
      text = buildTranscriptBundle(meeting.data);
    }
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject on lost focus / denied permission. Don't surface a
      // false "Copied" state, and swallow the rejection so it isn't unhandled.
      // (The richer MeetingDetail surface shows an inline error; this compact
      // transcript-bar button has nowhere to put one.)
    }
  };

  if (!transcriptOpen) return null;
  // Two valid contexts: a local meeting (activeSummaryFile) or a shared
  // org note that was uploaded with a transcript.
  if (!activeSummaryFile && !hasOrgTranscript) return null;

  return (
    <div
      data-transcript-bar
      className="mv-transcript open"
      style={{ pointerEvents: 'auto', boxShadow: 'var(--shadow-lg)' }}
      // Stop mousedown bubbling so the AskBar click-outside listener treats
      // interactions inside this panel (search input, copy button, scroll)
      // as in-bounds. Without this, the panel closes the instant you click
      // anywhere inside it.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mv-transcript-head">
        <span className="mv-transcript-wave mv-transcript-wave-static" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className="mv-transcript-label">Transcript</span>
        <button
          type="button"
          className="mv-chat-tool"
          onClick={() => void copyTranscript()}
          aria-label="Copy transcript"
          title="Copy transcript"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          className="mv-chat-tool"
          onClick={() => setTranscriptOpen(false)}
          aria-label="Hide transcript"
          title="Hide transcript"
        >
          <ChevronUp size={13} style={{ color: 'var(--fg-2)', flexShrink: 0 }} />
        </button>
      </div>
      <div
        style={{
          height: 260,
          display: 'flex',
          flexDirection: 'column',
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        {activeOrgMeeting ? (
          <OrgTranscriptPanelContent transcript={orgTranscript} />
        ) : (
          <TranscriptPanelContent summaryFile={activeSummaryFile!} />
        )}
      </div>
      {/* Footer — Resume (continue recording into this note), Granola-style. */}
      {canResume && (
        <div
          className="flex items-center px-3 py-2"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <button
            type="button"
            onClick={onResume}
            data-testid="resume-recording-button"
            aria-label="Resume recording on this note"
            title="Resume recording — the new audio is appended to this note"
            className="inline-flex h-8 cursor-pointer items-center rounded-full border-0 px-3.5 text-[13px] font-medium transition-colors hover:bg-[color:var(--surface-hover)]"
            style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
          >
            Resume
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Standalone circular transcript toggle — sits LEFT of the Ask bar (Granola-
 * style, separate from the composer). Opens/closes the floating TranscriptBar.
 * Shown only for a meeting that actually has a transcript.
 */
export function TranscriptToggle() {
  const { activeSummaryFile, activeOrgMeeting, transcriptOpen, setTranscriptOpen } = useAskBar();
  const [hover, setHover] = React.useState(false);
  const hasTranscript =
    Boolean(activeSummaryFile) || (activeOrgMeeting?.transcript ?? '').trim().length > 0;
  if (!hasTranscript) return null;

  return (
    <button
      type="button"
      data-testid="transcript-toggle"
      onClick={() => setTranscriptOpen(!transcriptOpen)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={transcriptOpen ? 'Hide transcript' : 'Show transcript'}
      aria-pressed={transcriptOpen}
      title="Transcript"
      // mb-[3px] optically centers the 44px toggle against the 50px composer
      // row it sits beside (PrimaryDock aligns the row items-end; see there).
      className="pointer-events-auto mb-[3px] inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-0.5 rounded-full border-0 px-3 transition-colors"
      style={{
        background: transcriptOpen ? 'var(--surface-active)' : 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-md)',
        color: 'var(--fg-1)',
      }}
    >
      <span
        className={
          transcriptOpen || hover
            ? 'mv-transcript-wave'
            : 'mv-transcript-wave mv-transcript-wave-static'
        }
        aria-hidden="true"
        style={{ width: 16, height: 13 }}
      >
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>
      {/* Expand indicator (Granola-style) — points up to reveal the transcript,
          flips down when it's open. */}
      <ChevronUp
        size={13}
        className="transition-transform"
        style={{
          color: 'var(--fg-2)',
          transform: transcriptOpen ? 'rotate(180deg)' : 'none',
        }}
      />
    </button>
  );
}

/**
 * The floating chat composer. `disabled` renders it visible-but-inert only
 * for genuinely unsupported cases (no caller-override path). While a recording
 * is active or paused the composer stays enabled and routes to the live
 * transcript stream instead of the processed-note backend, so chat is usable
 * throughout the meeting (input reads "Ask about the live transcript…"). It
 * renders with no active meeting while recording so the transcription pill
 * always has the bar beside it.
 */
export function AskBar({ disabled = false }: { disabled?: boolean }) {
  const {
    activeSummaryFile,
    activeMeetingName,
    activeOrgMeeting,
    transcriptOpen,
    setTranscriptOpen,
  } = useAskBar();

  // Detect active recording so we can enable the bar and route to the live
  // stream rather than the processed-note backend. We read recording state
  // directly here — PrimaryDock passes disabled={recordingActive} for layout
  // reasons (pill coexistence doc comment) but the input itself should be live.
  const recording = useRecording();
  const isRecording = recording.status === 'recording' || recording.status === 'paused';
  const liveSessionName = recording.sessionName ?? undefined;

  // Session key for live recording: stable synthetic key that won't collide
  // with saved notes (summaryFile paths) or org notes (org:id).
  const sessionKey =
    isRecording && liveSessionName
      ? `live:${liveSessionName}`
      : activeOrgMeeting
        ? `org:${activeOrgMeeting.id}`
        : activeSummaryFile;
  const sessionLabel = isRecording
    ? (liveSessionName ?? 'Live recording')
    : (activeOrgMeeting?.title ?? activeMeetingName);

  // Hidden when there is nothing to chat about — recording provides its own
  // context so a live session is always actionable.
  const hidden = !activeSummaryFile && !activeOrgMeeting && !isRecording;
  if (hidden) return null;

  return (
    <AskBarComposer
      key={sessionKey ?? 'idle'}
      sessionKey={sessionKey}
      sessionLabel={sessionLabel}
      activeMeetingName={activeMeetingName}
      activeSummaryFile={activeSummaryFile}
      activeOrgMeeting={activeOrgMeeting}
      isRecording={isRecording}
      liveSessionName={liveSessionName}
      disabled={disabled}
      transcriptOpen={transcriptOpen}
      setTranscriptOpen={setTranscriptOpen}
    />
  );
}

interface AskBarComposerProps {
  sessionKey: string | null;
  sessionLabel: string | null;
  activeMeetingName: string | null;
  activeSummaryFile: string | null;
  activeOrgMeeting: ActiveOrgMeeting | null;
  isRecording: boolean;
  liveSessionName: string | undefined;
  disabled: boolean;
  transcriptOpen: boolean;
  setTranscriptOpen: (open: boolean) => void;
}

function AskBarComposer({
  sessionKey,
  sessionLabel,
  activeMeetingName,
  activeSummaryFile,
  activeOrgMeeting,
  isRecording,
  liveSessionName,
  disabled,
  transcriptOpen,
  setTranscriptOpen,
}: AskBarComposerProps) {
  const chat = useChatSessions(sessionKey, sessionLabel);
  const streaming = useGlobalStreaming();

  const [expanded, setExpanded] = React.useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [activeStreamId, setActiveStreamId] = React.useState<string | null>(null);
  const activeStreamIdRef = React.useRef<string | null>(null);
  const pendingPersistRef = React.useRef<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const activeStream = activeStreamId ? streaming.streams[activeStreamId] : null;
  const isStreaming = activeStream?.status === 'streaming';
  const session = chat.activeSession;
  const hasMessages = (session?.messages.length ?? 0) > 0;

  // canSend: during recording the disabled prop is irrelevant (live chat is
  // always available); otherwise honour the caller's disabled flag.
  const canSend = input.trim().length > 0 && !isStreaming && (isRecording || !disabled);

  // Clean up any in-flight stream on unmount (e.g. when sessionKey changes or component unmounts)
  const cancelStream = streaming.cancelStream;
  React.useEffect(() => {
    return () => {
      const inFlightId = activeStreamIdRef.current;
      if (inFlightId) {
        cancelStream(inFlightId);
        activeStreamIdRef.current = null;
      }
      setTranscriptOpen(false);
    };
  }, [cancelStream, setTranscriptOpen]);

  // Recording started: close the saved-meeting transcript panel because it
  // would overlap the LiveTranscriptBar. Live recording keeps this composer
  // active, so only non-recording disabled states close it.
  React.useEffect(() => {
    if (disabled && !isRecording) setTranscriptOpen(false);
  }, [disabled, isRecording, setTranscriptOpen]);

  React.useEffect(() => {
    if (!expanded && !transcriptOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // Treat the AskBar container AND the floating TranscriptBar as in-bounds.
      // Without the transcript check, clicks inside the transcript's search
      // input or copy button would close the panel before the click resolves.
      const inside =
        (containerRef.current && containerRef.current.contains(target as Node)) ||
        (target && target.closest?.('[data-transcript-bar]'));
      if (!inside) {
        setExpanded(false);
        setSessionMenuOpen(false);
        setTranscriptOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expanded, transcriptOpen, setTranscriptOpen]);

  React.useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [session?.messages.length, activeStream?.text, expanded]);

  const handleStreamComplete = (
    streamId: string,
    targetSessionId: string,
    result: StreamResult
  ) => {
    const content =
      result.text.trim() ||
      (result.status === 'error' ? `Error: ${result.error ?? 'query failed'}` : '(empty response)');
    const message: ChatMessage = { role: 'assistant', content, ts: Date.now() };
    void chat.appendMessage(targetSessionId, message);
    if (pendingPersistRef.current === targetSessionId) {
      pendingPersistRef.current = null;
    }
    streaming.clearStream(streamId);
    if (activeStreamIdRef.current === streamId) {
      activeStreamIdRef.current = null;
    }
    setActiveStreamId((current) => (current === streamId ? null : current));
  };

  // Re-entrancy guard. submitPrompt awaits createSession/appendMessage; rapid
  // suggestion-chip clicks (or Enter) before those resolve would otherwise
  // create duplicate sessions and clobber the persistence ref.
  const submittingRef = React.useRef(false);

  const submitPrompt = async (raw: string) => {
    const q = raw.trim();
    // During recording: not disabled; no summaryFile needed — use live route.
    if (!q || isStreaming) return;
    if (!isRecording && disabled) return;
    if (!isRecording && !activeSummaryFile && !activeOrgMeeting) return;
    if (submittingRef.current) return;
    submittingRef.current = true;

    try {
      let sessionId = session?.id ?? null;
      if (!sessionId) {
        sessionId = await chat.createSession(deriveSessionName(q));
      }

      const userMsg: ChatMessage = { role: 'user', content: q, ts: Date.now() };
      await chat.appendMessage(sessionId, userMsg);
      setInput('');

      let streamId: string;
      const targetSessionId = sessionId;
      const onComplete = (result: StreamResult) => {
        handleStreamComplete(streamId, targetSessionId, result);
      };

      if (isRecording && liveSessionName) {
        // Live route — question sent against the in-progress recording.
        streamId = streaming.startLiveStream(liveSessionName, q, { onComplete });
      } else if (activeOrgMeeting) {
        // Org route — system prompt built from the shared note's body.
        const system =
          `You answer questions about a single shared meeting note titled "${activeOrgMeeting.title}". ` +
          `Be concise and cite content from the note when relevant.\n\n--- NOTE ---\n${activeOrgMeeting.body}`;
        const history = (session?.messages ?? []).map((m) => ({
          role: m.role,
          content: m.content,
        }));
        streamId = streaming.startOrgNoteStream(system, q, history, { onComplete });
      } else {
        streamId = streaming.startStream(activeSummaryFile!, q, { onComplete });
      }
      pendingPersistRef.current = targetSessionId;
      activeStreamIdRef.current = streamId;
      setActiveStreamId(streamId);

      setExpanded(true);
      setTranscriptOpen(false);
    } finally {
      submittingRef.current = false;
    }
  };

  const submit = () => submitPrompt(input);

  const stop = () => {
    if (!activeStreamId) return;
    const streamId = activeStreamId;
    const stream = streaming.streams[streamId];
    streaming.cancelStream(streamId);

    const sessionId = pendingPersistRef.current;
    if (sessionId && stream) {
      const content =
        stream.text.trim() ||
        (stream.status === 'error'
          ? `Error: ${stream.error ?? 'query failed'}`
          : '(empty response)');
      const message: ChatMessage = { role: 'assistant', content, ts: Date.now() };
      void chat.appendMessage(sessionId, message);
      pendingPersistRef.current = null;
    }
    streaming.clearStream(streamId);
    activeStreamIdRef.current = null;
    setActiveStreamId(null);
  };

  const onPickSession = (id: string) => {
    chat.setActiveId(id);
    setSessionMenuOpen(false);
    setExpanded(true);
  };

  const onNewSession = async () => {
    setSessionMenuOpen(false);
    if (session && session.messages.length === 0) {
      setExpanded(true);
      return;
    }
    await chat.createSession();
    setExpanded(true);
  };

  const handleInputFocus = () => {
    setExpanded(true);
    if (transcriptOpen) setTranscriptOpen(false);
  };

  const handleCollapse = () => {
    setExpanded(false);
    setSessionMenuOpen(false);
  };

  const showChatPanel = (isRecording || !disabled) && expanded && (hasMessages || isStreaming);

  return (
    <div
      ref={containerRef}
      data-ask-bar
      className="flex w-full flex-col gap-2.5"
      style={{ pointerEvents: 'auto' }}
    >
      {/* Chat message panel */}
      {showChatPanel && (
        <div className="mv-transcript open" style={{ maxHeight: 360 }}>
          <ChatHeader
            session={session}
            meetingName={activeMeetingName}
            sessions={chat.sessions}
            activeId={chat.activeId}
            sessionMenuOpen={sessionMenuOpen}
            onOpenSessions={() => setSessionMenuOpen((v) => !v)}
            onPickSession={onPickSession}
            onDeleteSession={(id) => void chat.deleteSession(id)}
            onNewSession={() => void onNewSession()}
            onCollapse={handleCollapse}
          />
          <div
            ref={scrollRef}
            data-testid="chat-messages"
            className="scrollbar-clean overflow-y-auto px-4 py-3"
            style={{ maxHeight: 300 }}
          >
            <MessageList
              messages={session?.messages ?? []}
              liveText={isStreaming ? (activeStream?.text ?? '') : ''}
              streaming={isStreaming}
            />
          </div>
        </div>
      )}

      {/* Suggestion chips — appear when ask bar is focused with empty conversation */}
      {!isRecording && !disabled && expanded && !hasMessages && !isStreaming && (
        <div className="mv-chat flex flex-wrap items-center gap-2" style={{ padding: '10px 14px' }}>
          {SUGGESTION_CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => void submitPrompt(chip.prompt)}
              className="rounded-lg border px-2.5 py-1 text-xs transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-2)' }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Chat composer */}
      <form
        className="mv-chat"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Transcript toggle lives as a standalone circular button LEFT of the
            Ask bar (see TranscriptToggle, rendered by PrimaryDock) — Granola-
            style, separate from the composer. */}

        {/* Text input */}
        <input
          ref={inputRef}
          className="mv-chat-input"
          value={input}
          disabled={disabled && !isRecording}
          onChange={(e) => setInput(e.target.value)}
          onFocus={handleInputFocus}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (isStreaming) stop();
              else void submit();
            }
            if (e.key === 'Escape') {
              handleCollapse();
              (e.target as HTMLElement).blur();
            }
          }}
          placeholder={
            isRecording
              ? 'Ask about the live transcript…'
              : disabled
                ? 'Chat available after recording'
                : hasMessages
                  ? 'Continue chat…'
                  : 'Ask anything about this meeting…'
          }
          aria-label="Ask about this meeting"
        />

        {/* Send / stop */}
        {isStreaming ? (
          <button type="button" className="mv-chat-send active" onClick={stop} aria-label="Stop">
            <Square size={12} />
          </button>
        ) : (
          <button
            type="submit"
            className={cn('mv-chat-send', canSend && 'active')}
            disabled={!canSend}
            aria-label="Send"
          >
            <ArrowUp size={14} />
          </button>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat header with floating session dropdown
// ---------------------------------------------------------------------------

interface ChatHeaderProps {
  session: ChatSession | null;
  meetingName: string | null;
  sessions: ChatSession[];
  activeId: string | null;
  sessionMenuOpen: boolean;
  onOpenSessions: () => void;
  onPickSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNewSession: () => void;
  onCollapse: () => void;
}

function ChatHeader({
  session,
  meetingName,
  sessions,
  activeId,
  sessionMenuOpen,
  onOpenSessions,
  onPickSession,
  onDeleteSession,
  onNewSession,
  onCollapse,
}: ChatHeaderProps) {
  return (
    <div
      className="relative flex flex-shrink-0 items-center justify-between border-b px-3 py-2"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <div className="relative">
        <button
          type="button"
          onClick={onOpenSessions}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold transition-colors hover:bg-muted',
            sessionMenuOpen && 'bg-muted'
          )}
          style={{ color: 'var(--fg-1)' }}
        >
          <span className="max-w-[340px] truncate">
            {session?.name ?? (meetingName ? `Ask about ${meetingName}` : 'Ask AI')}
          </span>
          <ChevronDown
            className={cn(
              'size-3.5 flex-shrink-0 transition-transform duration-150',
              sessionMenuOpen && 'rotate-180'
            )}
            style={{ color: 'var(--fg-2)' }}
          />
        </button>

        {sessionMenuOpen && (
          <SessionDropdown
            sessions={sessions}
            activeId={activeId}
            onPick={onPickSession}
            onDelete={onDeleteSession}
          />
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onNewSession}
          className="rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-muted"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-2)' }}
        >
          New chat
        </button>
        <button
          type="button"
          onClick={onCollapse}
          title="Collapse"
          aria-label="Collapse"
          className="mv-chat-tool"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session dropdown
// ---------------------------------------------------------------------------

interface SessionDropdownProps {
  sessions: ChatSession[];
  activeId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}

function SessionDropdown({ sessions, activeId, onPick, onDelete }: SessionDropdownProps) {
  return (
    <div
      role="menu"
      data-ask-bar-sessions
      className="absolute left-0 top-[calc(100%+4px)] z-30 min-w-[240px] overflow-hidden rounded-xl border p-1.5 shadow-lg"
      style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-subtle)' }}
    >
      {sessions.length === 0 ? (
        <p className="px-3 py-2 text-xs" style={{ color: 'var(--fg-muted)' }}>
          No saved chats yet.
        </p>
      ) : (
        sessions.map((s) => {
          const isActive = s.id === activeId;
          return (
            <div
              key={s.id}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted',
                isActive && 'bg-muted font-medium'
              )}
            >
              <button
                type="button"
                onClick={() => onPick(s.id)}
                className="flex-1 truncate text-left"
                style={{ color: 'var(--fg-1)' }}
              >
                {s.name}
              </button>
              <button
                type="button"
                onClick={() => onDelete(s.id)}
                aria-label={`Delete chat ${s.name}`}
                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                style={{ color: 'var(--fg-muted)' }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message list + bubbles
// ---------------------------------------------------------------------------

interface MessageListProps {
  messages: ChatMessage[];
  liveText: string;
  streaming: boolean;
}

function MessageList({ messages, liveText, streaming }: MessageListProps) {
  return (
    <div className="flex flex-col gap-3">
      {messages.map((m, i) => (
        <MessageBubble key={i} message={m} />
      ))}
      {streaming && (
        <div className="flex justify-start">
          {liveText ? (
            <div className="max-w-[90%] text-sm leading-[1.7]" style={{ color: 'var(--fg-1)' }}>
              {renderMarkdown(liveText)}
              <span
                className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse align-text-bottom"
                style={{ background: 'var(--fg-2)' }}
              />
            </div>
          ) : (
            <div className="flex items-center gap-1.5 py-1" style={{ color: 'var(--fg-muted)' }}>
              <span className="text-[13px]">Thinking</span>
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      {isUser ? (
        <div
          className="max-w-[75%] rounded-[18px_18px_4px_18px] border px-3.5 py-2 text-sm"
          style={{
            background: 'var(--surface-hover)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--fg-1)',
          }}
        >
          {message.content}
        </div>
      ) : (
        <div className="max-w-[90%] text-sm leading-[1.7]" style={{ color: 'var(--fg-1)' }}>
          {renderMarkdown(message.content)}
        </div>
      )}
    </div>
  );
}

// Markdown rendering moved to lib/markdown.tsx so the Chat tab can share it.

const SUGGESTION_CHIPS: { label: string; prompt: string }[] = [
  { label: 'Summarize key decisions', prompt: 'Summarize the key decisions made' },
  { label: 'Action items', prompt: 'What action items were discussed?' },
  { label: 'Main topics', prompt: 'What were the main topics covered?' },
];

function deriveSessionName(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 40) return trimmed;
  return `${trimmed.slice(0, 40).trimEnd()}…`;
}

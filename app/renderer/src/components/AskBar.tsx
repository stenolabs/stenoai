import * as React from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Square,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { renderMarkdown } from '@/lib/markdown';
import { useAskBar } from '@/lib/askBarContext';
import {
  useChatSessions,
  type ChatMessage,
  type ChatSession,
} from '@/hooks/useChatSessions';
import { useGlobalStreaming } from '@/hooks/useStreamingQuery';
import {
  OrgTranscriptPanelContent,
  TranscriptPanelContent,
} from '@/components/TranscriptPanel';
import { useMeeting } from '@/hooks/useMeetings';
import { useRecording } from '@/hooks/useRecording';
import { buildTranscriptBundle } from '@/lib/transcriptBundle';
import { useTranslation } from '@/i18n';
// ---------------------------------------------------------------------------
// Transcript bar — rendered separately above the chat bar
// ---------------------------------------------------------------------------

export function TranscriptBar() {
  const { t } = useTranslation();
  const { activeSummaryFile, activeMeetingName, activeOrgMeeting, transcriptOpen, setTranscriptOpen } =
    useAskBar();
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
          <span /><span /><span /><span /><span /><span /><span />
        </span>
        <span className="mv-transcript-label">{t('common.transcript')}</span>
        <button
          type="button"
          className="mv-chat-tool"
          onClick={() => void copyTranscript()}
          aria-label={t('meeting.copyTranscript')}
          title={t('meeting.copyTranscript')}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          className="mv-chat-tool"
          onClick={() => setTranscriptOpen(false)}
          aria-label={t('recording.hideTranscriptTooltip')}
          title={t('recording.hideTranscriptTooltip')}
        >
          <ChevronUp size={13} style={{ color: 'var(--fg-2)', flexShrink: 0 }} />
        </button>
      </div>
      <div style={{ height: 260, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-subtle)' }}>
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
            aria-label={t('recording.resumeRecordingTooltip')}
            title={t('recording.resumeRecordingTooltip')}
            className="inline-flex h-8 cursor-pointer items-center rounded-full border-0 px-3.5 text-[13px] font-medium transition-colors hover:bg-[color:var(--surface-hover)]"
            style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
          >
            {t('common.resume')}
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
  const { t } = useTranslation();
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
      aria-label={transcriptOpen ? t('recording.hideTranscriptTooltip') : t('recording.showTranscriptTooltip')}
      aria-pressed={transcriptOpen}
      title={transcriptOpen ? t('recording.hideTranscriptTooltip') : t('recording.showTranscriptTooltip')}
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
        <span /><span /><span /><span /><span /><span /><span />
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
 * The floating chat composer. `disabled` renders it visible-but-inert while a
 * recording is active (chat needs the processed note, so the input carries a
 * "Chat available after recording" hint instead of a dead field) — and unlike
 * the idle state it renders even with no active meeting, so the recording
 * pill always has the bar beside it.
 */
export function AskBar({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const {
    activeSummaryFile,
    activeMeetingName,
    activeOrgMeeting,
    transcriptOpen,
    setTranscriptOpen,
  } = useAskBar();
  // For shared notes, persist sessions under a synthetic summaryFile key so
  // they don't collide with local meetings. Same useChatSessions plumbing.
  const sessionKey = activeOrgMeeting
    ? `org:${activeOrgMeeting.id}`
    : activeSummaryFile;
  const sessionLabel = activeOrgMeeting?.title ?? activeMeetingName;
  const chat = useChatSessions(sessionKey, sessionLabel);
  const streaming = useGlobalStreaming();

  const [expanded, setExpanded] = React.useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [activeStreamId, setActiveStreamId] = React.useState<string | null>(null);
  const pendingPersistRef = React.useRef<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const activeStream = activeStreamId ? streaming.streams[activeStreamId] : null;
  const isStreaming = activeStream?.status === 'streaming';
  const session = chat.activeSession;
  const hasMessages = (session?.messages.length ?? 0) > 0;
  const hidden = !activeSummaryFile && !activeOrgMeeting;
  const canSend = input.trim().length > 0 && !isStreaming && !disabled;

  const cancelStreamRef = React.useRef(streaming.cancelStream);
  cancelStreamRef.current = streaming.cancelStream;

  React.useEffect(() => {
    setExpanded(false);
    setSessionMenuOpen(false);
    setTranscriptOpen(false);
    setActiveStreamId((prev) => {
      if (prev) {
        cancelStreamRef.current(prev);
        pendingPersistRef.current = null;
      }
      return null;
    });
  }, [activeSummaryFile, activeOrgMeeting?.id, setTranscriptOpen]);

  // Recording started: close a saved-meeting transcript panel that was
  // already open. The whole bar goes inert (the toggle below is hidden while
  // disabled), and leaving the 72-band panel up would let it overlap the
  // expanded LiveTranscriptBar — the one stacking the dock can't resolve.
  React.useEffect(() => {
    if (disabled) setTranscriptOpen(false);
  }, [disabled, setTranscriptOpen]);

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

  React.useEffect(() => {
    if (!activeStreamId) return;
    const stream = streaming.streams[activeStreamId];
    if (!stream) return;
    const sessionId = pendingPersistRef.current;
    if (!sessionId) return;
    if (stream.status === 'streaming') return;

    const content =
      stream.text.trim() ||
      (stream.status === 'error'
        ? `Error: ${stream.error ?? 'query failed'}`
        : '(empty response)');
    const message: ChatMessage = { role: 'assistant', content, ts: Date.now() };
    void chat.appendMessage(sessionId, message);
    pendingPersistRef.current = null;
    streaming.clearStream(activeStreamId);
    setActiveStreamId(null);
  }, [activeStreamId, streaming, chat]);

  // Re-entrancy guard. submitPrompt awaits createSession/appendMessage; rapid
  // suggestion-chip clicks (or Enter) before those resolve would otherwise
  // create duplicate sessions and clobber the persistence ref.
  const submittingRef = React.useRef(false);

  const submitPrompt = async (raw: string) => {
    const q = raw.trim();
    if (!q || isStreaming || disabled) return;
    if (!activeSummaryFile && !activeOrgMeeting) return;
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
      if (activeOrgMeeting) {
        // Org route — system prompt is built from the shared note's body so
        // the model has the same context the user sees on screen.
        const system =
          `You answer questions about a single shared meeting note titled "${activeOrgMeeting.title}". ` +
          `Be concise and cite content from the note when relevant.\n\n--- NOTE ---\n${activeOrgMeeting.body}`;
        const history = (session?.messages ?? []).map((m) => ({
          role: m.role,
          content: m.content,
        }));
        streamId = streaming.startOrgNoteStream(system, q, history);
      } else {
        streamId = streaming.startStream(activeSummaryFile!, q);
      }
      pendingPersistRef.current = sessionId;
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
    streaming.cancelStream(activeStreamId);
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

  // Idle with no meeting in context: nothing to chat about, render nothing.
  // Disabled (recording active) is the exception — the bar stays visible as
  // an inert shell so the transcription pill has the composer beside it and
  // the user can see chat will return after processing.
  if (hidden && !disabled) return null;

  const showChatPanel = !disabled && expanded && (hasMessages || isStreaming);

  return (
    <div ref={containerRef} data-ask-bar className="flex w-full flex-col gap-2.5" style={{ pointerEvents: 'auto' }}>

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
      {!disabled && expanded && !hasMessages && !isStreaming && (
        <div
          className="mv-chat flex flex-wrap items-center gap-2"
          style={{ padding: '10px 14px' }}
        >
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
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        {/* Transcript toggle lives as a standalone circular button LEFT of the
            Ask bar (see TranscriptToggle, rendered by PrimaryDock) — Granola-
            style, separate from the composer. */}

        {/* Text input */}
        <input
          ref={inputRef}
          className="mv-chat-input"
          value={input}
          disabled={disabled}
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
            disabled
              ? t('chat.placeholderDisabled')
              : hasMessages
                ? t('chat.placeholderContinue')
                : t('chat.placeholderEmpty')
          }
          aria-label={t('chat.placeholderEmpty')}
        />

        {/* Send / stop */}
        {isStreaming ? (
          <button
            type="button"
            className="mv-chat-send active"
            onClick={stop}
            aria-label={t('common.stop')}
          >
            <Square size={12} />
          </button>
        ) : (
          <button
            type="submit"
            className={cn('mv-chat-send', canSend && 'active')}
            disabled={!canSend}
            aria-label={t('common.send')}
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
    <div className="relative flex flex-shrink-0 items-center justify-between border-b px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="relative">
        <button
          type="button"
          onClick={onOpenSessions}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold transition-colors hover:bg-muted',
            sessionMenuOpen && 'bg-muted',
          )}
          style={{ color: 'var(--fg-1)' }}
        >
          <span className="max-w-[340px] truncate">
            {session?.name ?? (meetingName ? `Ask about ${meetingName}` : 'Ask AI')}
          </span>
          <ChevronDown
            className={cn('size-3.5 flex-shrink-0 transition-transform duration-150', sessionMenuOpen && 'rotate-180')}
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
        <p className="px-3 py-2 text-xs" style={{ color: 'var(--fg-muted)' }}>No saved chats yet.</p>
      ) : (
        sessions.map((s) => {
          const isActive = s.id === activeId;
          return (
            <div
              key={s.id}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted',
                isActive && 'bg-muted font-medium',
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
              <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse align-text-bottom" style={{ background: 'var(--fg-2)' }} />
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

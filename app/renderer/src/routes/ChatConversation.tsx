import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft,
  ArrowUp,
  BookmarkPlus,
  ChevronDown,
  Square,
} from 'lucide-react';
import { FolderScopePicker, ORG_SHARED_SCOPE } from '@/components/FolderScopePicker';
import { ChatHistoryRow } from '@/components/ChatHistoryRow';
import { MeetingsShell } from '@/components/MeetingsShell';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useRecipes, useDeleteRecipe } from '@/hooks/useRecipes';
import {
  PRESETS,
  ChatRecipesMenuContent,
  SaveRecipeDialog,
  type UnifiedRecipeItem,
} from '@/lib/chatPresets';
import {
  useAllChatSessions,
  useChatSessions,
  type ChatMessage,
} from '@/hooks/useChatSessions';

// Stable empty-array sentinel so `messages` keeps the same reference when
// session is null/loading — otherwise the useMemo around it would produce
// a fresh `[]` on every render, invalidating downstream deps.
const EMPTY_MESSAGES: ChatMessage[] = [];
import { useGlobalStreaming } from '@/hooks/useStreamingQuery';
import { useAiProvider } from '@/hooks/useAi';
import { navigate } from '@/lib/router';
import {
  GLOBAL_SCOPE,
  bucketKey,
  deriveSessionName,
  toBucketLabel,
  formatActiveModel,
  chatProviderReady,
} from '@/lib/chat';
import { consumePendingNewChat } from '@/routes/Chat';
import { renderMarkdown } from '@/lib/markdown';

interface ChatConversationProps {
  sessionId: string;
}

export function ChatConversation({ sessionId }: ChatConversationProps) {
  const allSessions = useAllChatSessions();
  const chat = useChatSessions(GLOBAL_SCOPE, null);
  const streaming = useGlobalStreaming();
  const provider = useAiProvider();

  const [input, setInput] = React.useState('');
  const [activeStreamId, setActiveStreamId] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [presetsOpen, setPresetsOpen] = React.useState(false);
  const [selectedPresetIndex, setSelectedPresetIndex] = React.useState(0);
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false);
  const [recipeToDelete, setRecipeToDelete] = React.useState<UnifiedRecipeItem | null>(null);
  const { recipes } = useRecipes();
  const deleteRecipe = useDeleteRecipe();

  const filterQuery = input.startsWith('/')
    ? input.slice(1).trim().toLowerCase()
    : (presetsOpen ? input.trim().toLowerCase() : '');

  const allItems = React.useMemo<UnifiedRecipeItem[]>(() => {
    const custom: UnifiedRecipeItem[] = (recipes || []).map((r) => ({
      id: r.id,
      label: r.label,
      prompt: r.prompt,
      builtin: false,
    }));
    const builtin: UnifiedRecipeItem[] = PRESETS.map((p, idx) => ({
      id: `builtin-${idx}`,
      label: p.label,
      prompt: p.prompt,
      description: p.description,
      builtin: true,
    }));
    return [...custom, ...builtin];
  }, [recipes]);

  const filteredItems = React.useMemo(() => {
    if (!filterQuery) return allItems;
    return allItems.filter(
      (item) =>
        item.label.toLowerCase().includes(filterQuery) ||
        item.prompt.toLowerCase().includes(filterQuery) ||
        (item.description && item.description.toLowerCase().includes(filterQuery))
    );
  }, [allItems, filterQuery]);

  React.useEffect(() => {
    setSelectedPresetIndex(0);
  }, [filterQuery]);

  const onPickPreset = (prompt: string) => {
    setInput(prompt);
    setPresetsOpen(false);
    inputRef.current?.focus();
  };
  // Folder / meetings scope persists for the lifetime of the conversation page mount.
  // The entry page's scope is handed off via consumePendingNewChat; later
  // turns in the same conversation can be re-scoped from this composer.
  const [scopeFolderId, setScopeFolderId] = React.useState<string | null>(null);
  const [selectedMeetingFiles, setSelectedMeetingFiles] = React.useState<string[]>([]);
  const pendingPersistRef = React.useRef<string | null>(null);
  const submittingRef = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const isLocalEngine =
    provider.data?.ai_provider === 'local' || provider.data?.ai_provider === 'remote';
  // Shared cloud/local/remote readiness; local/remote answer over a
  // context-capped, most-recent slice (see hint).
  const providerReady = chatProviderReady(provider.data);
  // Org-scoped follow-ups go through the adapter and don't need the local
  // cloud provider configured — the cloud-key gate becomes irrelevant.
  const isOrgScope = (s: string | null | undefined) => s === ORG_SHARED_SCOPE;
  const ready = providerReady || isOrgScope(scopeFolderId);

  // Make THIS session the active one as soon as the route mounts so
  // chat.activeSession / chat.appendMessage operate on the right record
  // instead of whichever one useChatSessions's auto-restore landed on.
  React.useEffect(() => {
    chat.setActiveId(sessionId);
  }, [sessionId, chat]);

  // Pick up an in-flight stream the entry page kicked off right before
  // navigating, so we don't lose its tokens during the route change.
  // The entry page's chosen scope rides along with the handoff so the
  // composer here starts with the same folder context.
  React.useEffect(() => {
    const pending = consumePendingNewChat(sessionId);
    if (pending) {
      pendingPersistRef.current = pending.sessionId;
      setActiveStreamId(pending.streamId);
      setScopeFolderId(pending.folderId);
      if (pending.selectedMeetingFiles && pending.selectedMeetingFiles.length > 0) {
        setSelectedMeetingFiles(pending.selectedMeetingFiles);
      }
    }
  }, [sessionId]);

  const session = React.useMemo(() => {
    const list = allSessions.data?.sessions ?? [];
    return list.find((s) => s.id === sessionId) ?? null;
  }, [allSessions.data?.sessions, sessionId]);

  const otherSessions = React.useMemo(() => {
    const list = allSessions.data?.sessions ?? [];
    return list
      .filter((s) => s.summaryFile === GLOBAL_SCOPE)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [allSessions.data?.sessions]);

  // Group sessions into time buckets for the History dropdown ("Today",
  // "Last 2 weeks", "April", etc.) — same pattern Granola uses. Order is
  // determined by the highest updatedAt in each group, so a stale "April"
  // group sinks below a fresh "Today" automatically.
  const groupedSessions = React.useMemo(() => {
    const groups = new Map<string, typeof otherSessions>();
    const now = Date.now();
    for (const s of otherSessions) {
      const k = bucketKey(s.updatedAt, now);
      const arr = groups.get(k) ?? [];
      arr.push(s);
      groups.set(k, arr);
    }
    return Array.from(groups.entries()).map(([key, sessions]) => ({
      key,
      label: toBucketLabel(key),
      sessions,
    }));
  }, [otherSessions]);

  const activeStream = activeStreamId ? streaming.streams[activeStreamId] : null;
  const isStreaming = activeStream?.status === 'streaming';

  // Persist the assistant turn when its stream finishes.
  React.useEffect(() => {
    if (!activeStreamId) return;
    const stream = streaming.streams[activeStreamId];
    if (!stream || stream.status === 'streaming') return;
    const persistId = pendingPersistRef.current;
    if (!persistId) return;
    const content =
      stream.text.trim() ||
      (stream.status === 'error'
        ? `Error: ${stream.error ?? 'query failed'}`
        : '(empty response)');
    const message: ChatMessage = {
      role: 'assistant',
      content,
      ts: Date.now(),
    };
    void chat.appendMessage(persistId, message);
    pendingPersistRef.current = null;
    streaming.clearStream(activeStreamId);
    setActiveStreamId(null);
  }, [activeStreamId, streaming, chat]);

  // Virtualized message list. Long meetings produce thousands of messages
  // (diarised replay + long prompts), and rendering them all on every
  // streaming-text update or message append made input feel laggy on
  // longer conversations. The virtualizer only mounts what's visible
  // (+ overscan), so frame time stays O(visible) instead of O(messages).
  //
  // The streaming bubble is rendered as a synthetic last item when
  // `isStreaming`, derived at render time rather than cloned into a new
  // array — cloning per token was O(messages) work on every streaming
  // update, which defeated the virtualization.
  const messages = React.useMemo(
    () => session?.messages ?? EMPTY_MESSAGES,
    [session?.messages],
  );
  const streamingContent = isStreaming
    ? activeStream?.text || 'Thinking…'
    : null;
  const totalItems = messages.length + (streamingContent !== null ? 1 : 0);

  const rowVirtualizer = useVirtualizer({
    count: totalItems,
    getScrollElement: () => scrollRef.current,
    // Bubbles are typically 60-120 px tall; measureElement reads the real
    // height on first paint so the estimate only matters for off-screen
    // items that haven't been mounted yet.
    estimateSize: () => 96,
    overscan: 6,
  });

  // Keep the conversation pinned to the bottom on new content. Mirrors
  // the previous `scrollTop = scrollHeight` behaviour but routed through
  // the virtualizer so the target row is actually materialised before the
  // scroll lands at the right offset.
  React.useEffect(() => {
    if (totalItems === 0) return;
    rowVirtualizer.scrollToIndex(totalItems - 1, { align: 'end' });
  }, [totalItems, streamingContent, rowVirtualizer]);

  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const submit = async (raw: string) => {
    const q = raw.trim();
    if (!q || isStreaming || submittingRef.current || !ready || !session) return;
    submittingRef.current = true;
    setSubmitError(null);
    let appended = false;
    try {
      await chat.appendMessage(session.id, {
        role: 'user',
        content: q,
        ts: Date.now(),
      });
      appended = true;
      setInput('');

      const hasMeetings = selectedMeetingFiles.length > 0;
      // Hand the running history to the org backend so follow-ups have
      // context. For local scope this third arg is ignored.
      const history = isOrgScope(scopeFolderId)
        ? (session.messages ?? []).map((m) => ({
            role: m.role,
            content: m.content,
          }))
        : undefined;
      const streamId = streaming.startGlobalStream(
        q,
        hasMeetings ? null : scopeFolderId,
        history,
        undefined,
        hasMeetings ? selectedMeetingFiles : null,
      );
      pendingPersistRef.current = session.id;
      setActiveStreamId(streamId);
    } catch (err) {
      // Disk write / IPC / streaming setup can all fail. Surface the error.
      // Only restore the input if nothing made it to disk — once the user
      // message is persisted it's already visible in the thread, and
      // re-populating the box would duplicate it on the next submit.
      const message = err instanceof Error ? err.message : 'Failed to send';
      setSubmitError(message);
      if (!appended) setInput(q);
    } finally {
      submittingRef.current = false;
    }
  };

  const stop = () => {
    if (!activeStreamId) return;
    streaming.cancelStream(activeStreamId);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit(input);
  };

  // Session might not exist yet on cold reload (allSessions is still
  // loading). Show a soft loading state rather than dumping the user
  // back to /chat — the URL is the source of truth.
  if (!session && allSessions.isFetched) {
    return (
      <MeetingsShell activeSummaryFile={null}>
        <div className="mx-auto max-w-[640px] py-20 text-center">
          <h1 className="mv-title mb-3">Chat not found.</h1>
          <p className="text-[14px]" style={{ color: 'var(--fg-2)' }}>
            This conversation may have been deleted.
          </p>
          <button
            type="button"
            onClick={() => navigate('/chat')}
            className="mt-4 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
            style={{ color: 'var(--fg-1)', background: 'var(--surface-raised)' }}
          >
            <ArrowLeft className="size-[13px]" />
            Back to Chat
          </button>
        </div>
      </MeetingsShell>
    );
  }

  return (
    <>
      <MeetingsShell activeSummaryFile={null} bleed>
      <div className="flex min-h-0 flex-1 flex-col" style={{ background: 'var(--page)' }}>
        {/* Toolbar — back, History dropdown, New chat. */}
        <div className="mx-auto flex w-full max-w-[760px] items-center justify-between gap-2 px-10 pb-3 pt-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => navigate('/chat')}
              className="inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)]"
              style={{ color: 'var(--fg-2)' }}
              aria-label="Back to Chat"
              title="Back to Chat"
            >
              <ArrowLeft className="size-[15px]" />
            </button>

            <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="ml-1 inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--fg-1)',
                    background: 'var(--surface-raised)',
                  }}
                  aria-label="Switch chat"
                >
                  History
                  <ChevronDown className="size-[12px]" style={{ color: 'var(--fg-2)' }} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[320px] p-1">
                {otherSessions.length === 0 ? (
                  <div className="px-3 py-3 text-[13px]" style={{ color: 'var(--fg-2)' }}>
                    No other chats yet.
                  </div>
                ) : (
                  <div className="max-h-[420px] overflow-y-auto py-1">
                    {/* Few chats → flat list, no group headers (less visual
                        noise). Many chats → grouped by time bucket so old
                        ones are findable. */}
                    {otherSessions.length <= 5 ? (
                      otherSessions.map((s) => (
                        <ChatHistoryRow
                          key={s.id}
                          session={s}
                          activeId={sessionId}
                          onSelect={() => setHistoryOpen(false)}
                          onRename={(name) => void chat.renameSession(s.id, name)}
                          onDelete={async () => {
                            const wasActive = s.id === sessionId;
                            await chat.deleteSession(s.id);
                            if (wasActive) navigate('/chat');
                          }}
                        />
                      ))
                    ) : (
                      groupedSessions.map((group) => (
                        <div key={group.key} className="mb-1.5 last:mb-0">
                          <div
                            className="px-2 pb-0.5 pt-1 text-[11px] font-medium"
                            style={{ color: 'var(--fg-muted)' }}
                          >
                            {group.label}
                          </div>
                          {group.sessions.map((s) => (
                            <ChatHistoryRow
                              key={s.id}
                              session={s}
                              activeId={sessionId}
                              onSelect={() => setHistoryOpen(false)}
                              onRename={(name) => void chat.renameSession(s.id, name)}
                              onDelete={async () => {
                                const wasActive = s.id === sessionId;
                                await chat.deleteSession(s.id);
                                if (wasActive) navigate('/chat');
                              }}
                            />
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {/* "New chat" lives in the global toolbar (route-aware "+ New" pill)
              when on chat routes, so we don't repeat it here. */}
        </div>

        {/* Scrolling message area. flex-1 takes all remaining vertical space
            so the composer below it renders at the actual viewport bottom
            with no empty band underneath. */}
        <div
          ref={scrollRef}
          className="scrollbar-clean min-h-0 flex-1 overflow-y-auto"
          style={{ scrollbarGutter: 'stable' }}
        >
          <div className="mx-auto w-full max-w-[760px] px-10 pb-6 pt-2">
            <div
              style={{
                height: rowVirtualizer.getTotalSize(),
                position: 'relative',
                width: '100%',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const isStreamingBubble =
                  virtualRow.index >= messages.length;
                const msg = isStreamingBubble
                  ? null
                  : messages[virtualRow.index];
                const role: 'user' | 'assistant' = isStreamingBubble
                  ? 'assistant'
                  : msg!.role;
                const content = isStreamingBubble
                  ? (streamingContent ?? '')
                  : msg!.content;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    // pb-5 recreates the previous flex `gap-5` between
                    // bubbles. Applied to every row including the last —
                    // the wrapper's pb-6 provides additional breathing
                    // room above the composer.
                    className="pb-5"
                  >
                    <Bubble
                      role={role}
                      content={content}
                      live={isStreamingBubble}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Composer pinned at the visual bottom — out of the scroll
            container, in the flex column. No leftover padding underneath. */}
        <div className="mx-auto w-full max-w-[760px] px-10 pb-6 pt-2">
          {submitError && (
            <div
              role="alert"
              className="mb-3 rounded-md border px-3 py-2 text-[13px]"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--danger-bg)',
                color: 'var(--danger)',
              }}
            >
              {submitError}
            </div>
          )}
          <Popover open={presetsOpen} onOpenChange={setPresetsOpen}>
            <PopoverAnchor asChild>
          <form
            onSubmit={onSubmit}
            className="rounded-2xl border p-3 transition-shadow focus-within:shadow-[var(--shadow-md)]"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-raised)',
            }}
          >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);
              if (val.startsWith('/')) {
                setPresetsOpen(true);
              } else if (val === '') {
                setPresetsOpen(false);
              }
            }}
            onKeyDown={(e) => {
              if (presetsOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (filteredItems.length > 0) {
                    setSelectedPresetIndex((prev) => (prev + 1) % filteredItems.length);
                  }
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (filteredItems.length > 0) {
                    setSelectedPresetIndex(
                      (prev) => (prev - 1 + filteredItems.length) % filteredItems.length
                    );
                  }
                  return;
                }
                if (e.key === 'Enter') {
                  if (
                    filteredItems.length > 0 &&
                    selectedPresetIndex >= 0 &&
                    selectedPresetIndex < filteredItems.length
                  ) {
                    e.preventDefault();
                    onPickPreset(filteredItems[selectedPresetIndex].prompt);
                    return;
                  }
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setPresetsOpen(false);
                  return;
                }
              }
              // Same '/' shortcut as the entry page — opens the preset
              // picker when the input is empty so a literal slash typed
              // mid-sentence doesn't surprise the user.
              if (e.key === '/' && input === '' && ready && !isStreaming) {
                setSelectedPresetIndex(0);
                setPresetsOpen(true);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !isStreaming) {
                e.preventDefault();
                void submit(input);
              }
            }}
            disabled={!ready || isStreaming}
            placeholder="Ask anything  /"
            className="block w-full bg-transparent px-2 pb-3 pt-1 outline-none disabled:cursor-not-allowed"
            style={{ fontSize: 15, color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-1">
              <FolderScopePicker
                value={scopeFolderId}
                onChange={(fid) => {
                  setScopeFolderId(fid);
                  if (fid !== null) setSelectedMeetingFiles([]);
                }}
                selectedMeetings={selectedMeetingFiles}
                onSelectedMeetingsChange={(files) => {
                  setSelectedMeetingFiles(files);
                  if (files.length > 0) setScopeFolderId(null);
                }}
              />
              <span
                data-testid="chat-model-indicator"
                className="text-[12px]"
                style={{ color: 'var(--fg-muted)' }}
              >
                {formatActiveModel(provider.data)}
              </span>
              {isLocalEngine && (
                <span
                  data-testid="chat-local-scope-hint"
                  className="text-[12px]"
                  style={{ color: 'var(--fg-muted)' }}
                >
                  · may omit older notes
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {input.trim() && !input.trim().startsWith('/') && !isStreaming && (
                <button
                  type="button"
                  onClick={() => setSaveDialogOpen(true)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors hover:bg-[color:var(--surface-hover)]"
                  style={{ color: 'var(--fg-2)' }}
                  title="Save as recipe"
                  aria-label="Save as recipe"
                  data-testid="save-recipe-button"
                >
                  <BookmarkPlus className="size-3.5" />
                  <span>Save recipe</span>
                </button>
              )}
              {isStreaming ? (
                <button
                  type="button"
                  onClick={stop}
                  className="inline-flex size-7 items-center justify-center rounded-full transition-colors hover:bg-[color:var(--surface-hover)]"
                  style={{ color: 'var(--fg-1)' }}
                  aria-label="Stop"
                >
                  <Square className="size-[12px]" fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() || !ready}
                  className="inline-flex size-7 items-center justify-center rounded-full transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-40"
                  style={{ color: 'var(--fg-1)' }}
                  aria-label="Send"
                >
                  <ArrowUp className="size-[14px]" />
                </button>
              )}
            </div>
          </div>
          </form>
            </PopoverAnchor>
            <PopoverContent
              align="start"
              side="top"
              sideOffset={8}
              className="w-[var(--radix-popover-trigger-width)] max-w-none p-1"
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <ChatRecipesMenuContent
                items={filteredItems}
                selectedIndex={selectedPresetIndex}
                onSelectIndex={setSelectedPresetIndex}
                onPick={onPickPreset}
                onDeleteRequest={setRecipeToDelete}
                filterQuery={filterQuery}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      </MeetingsShell>
      <SaveRecipeDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        defaultPrompt={input}
      />
      <ConfirmDialog
        open={!!recipeToDelete}
        onOpenChange={(open) => {
          if (!open) setRecipeToDelete(null);
        }}
        title={`Delete recipe "${recipeToDelete?.label}"?`}
        description="This permanently deletes the recipe."
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          if (recipeToDelete) {
            await deleteRecipe.mutateAsync(recipeToDelete.id);
            setRecipeToDelete(null);
          }
        }}
        isPending={deleteRecipe.isPending}
      />
    </>
  );
}


function Bubble({
  role,
  content,
  live,
}: {
  role: 'user' | 'assistant';
  content: string;
  live?: boolean;
}) {
  const isUser = role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex'}>
      <div
        className={`chat-bubble max-w-[85%] rounded-2xl px-4 py-3 text-[14px] leading-[1.55] ${live ? 'animate-pulse' : ''}`}
        style={{
          background: isUser ? 'var(--surface-active)' : 'var(--surface-sunken)',
          color: 'var(--fg-1)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* User turns are typed plain text — render as-is to preserve any
            literal asterisks/backticks. Assistant turns get full markdown. */}
        {isUser ? (
          <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>
        ) : (
          renderMarkdown(content)
        )}
      </div>
    </div>
  );
}

// Re-export so callers don't need to know about deriveSessionName here.
export { deriveSessionName };

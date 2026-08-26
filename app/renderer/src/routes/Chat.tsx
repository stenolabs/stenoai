import * as React from 'react';
import {
  ArrowUp,
  BookmarkPlus,
  ChevronRight,
  History,
  Sparkles,
} from 'lucide-react';
import { ChatHistoryRow } from '@/components/ChatHistoryRow';
import { FolderScopePicker, ORG_SHARED_SCOPE } from '@/components/FolderScopePicker';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { MeetingsShell } from '@/components/MeetingsShell';
import {
  useAllChatSessions,
  useChatSessions,
} from '@/hooks/useChatSessions';
import { useGlobalStreaming } from '@/hooks/useStreamingQuery';
import { useAiProvider } from '@/hooks/useAi';
import { useUserName } from '@/hooks/useSettings';
import { useOrgSession } from '@/hooks/useOrg';
import { navigate } from '@/lib/router';
import { GLOBAL_SCOPE, bucketKey, deriveSessionName, toBucketLabel, formatActiveModel, chatProviderReady } from '@/lib/chat';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useRecipes, useDeleteRecipe } from '@/hooks/useRecipes';
import {
  PRESETS,
  PresetGlyph,
  PRESET_COLORS,
  ChatRecipesMenuContent,
  SaveRecipeDialog,
  type UnifiedRecipeItem,
} from '@/lib/chatPresets';

function TypewriterPlaceholder({ index, setIndex }: { index: number, setIndex: React.Dispatch<React.SetStateAction<number>> }) {
  const [text, setText] = React.useState('');
  const [isDeleting, setIsDeleting] = React.useState(false);
  const prefersReducedMotion = React.useSyncExternalStore(
    (callback) => {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', callback);
      return () => mq.removeEventListener('change', callback);
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  React.useEffect(() => {
    if (prefersReducedMotion) return;
    let timeout: ReturnType<typeof setTimeout>;
    const currentFullText = PRESETS[index].label;

    if (isDeleting) {
      if (text === '') {
        timeout = setTimeout(() => {
          setIsDeleting(false);
          setIndex((i) => (i + 1) % PRESETS.length);
        }, 400);
      } else {
        timeout = setTimeout(() => {
          setText(currentFullText.substring(0, text.length - 1));
        }, 30);
      }
    } else {
      if (text === currentFullText) {
        timeout = setTimeout(() => {
          setIsDeleting(true);
        }, 3000); // long pause when fully typed
      } else {
        timeout = setTimeout(() => {
          setText(currentFullText.substring(0, text.length + 1));
        }, 80); // natural typing speed
      }
    }

    return () => clearTimeout(timeout);
  }, [text, isDeleting, index, prefersReducedMotion]);

  const presetColor = PRESET_COLORS[index % PRESET_COLORS.length];

  return (
    <div className="pointer-events-none absolute left-3 top-[10px] flex items-center gap-2">
      <PresetGlyph color={presetColor} size={22} />
      <span style={{ color: 'var(--fg-muted)', fontSize: 16 }}>
        {prefersReducedMotion ? PRESETS[index].label : text}
        {!prefersReducedMotion && (
          <>
            <style>{`
              @keyframes cursor-blink {
                0%, 100% { opacity: 1; }
                50% { opacity: 0; }
              }
            `}</style>
            <span
              className="font-medium ml-[1px]"
              style={{
                color: 'var(--fg-1)',
                animation: 'cursor-blink 1s step-end infinite'
              }}
            >
              |
            </span>
          </>
        )}
      </span>
    </div>
  );
}

export function Chat() {
  const allSessions = useAllChatSessions();
  // Reuse useChatSessions's persist/createSession with the global sentinel
  // so saves go through the same atomic-write path.
  const chat = useChatSessions(GLOBAL_SCOPE, null);
  const streaming = useGlobalStreaming();
  const provider = useAiProvider();
  const userName = useUserName();
  const orgSession = useOrgSession();
  // When signed in to an org adapter, the greeting reflects the org identity
  // (first name from "Alice Chen") so the demo feels like switching users.
  // Falls back to the local user-name setting when no org session is active.
  const greetingName =
    orgSession.data?.signedIn && orgSession.data?.name
      ? orgSession.data.name.split(' ')[0]
      : userName.data;

  const [input, setInput] = React.useState('');
  const [presetsOpen, setPresetsOpen] = React.useState(false);
  const [isFocused, setIsFocused] = React.useState(false);
  const [suggestedIndex, setSuggestedIndex] = React.useState(0);
  const [selectedPresetIndex, setSelectedPresetIndex] = React.useState(0);
  const { recipes } = useRecipes();
  const deleteRecipe = useDeleteRecipe();
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false);
  const [recipeToDelete, setRecipeToDelete] = React.useState<UnifiedRecipeItem | null>(null);

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
  // Scope: null = ask across every note. Folder ID limits the corpus
  // server-side. Default null so first-time users get the broadest
  // possible answer.
  const [scopeFolderId, setScopeFolderId] = React.useState<string | null>(null);
  const [selectedMeetingFiles, setSelectedMeetingFiles] = React.useState<string[]>([]);
  const submittingRef = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const isAdapter = provider.data?.ai_provider === 'adapter';
  const isLocalEngine =
    provider.data?.ai_provider === 'local' || provider.data?.ai_provider === 'remote';
  // Cloud/local/remote readiness is the shared core (chatProviderReady); adapter
  // adds an active-org-session requirement here (a signed-out adapter user would
  // otherwise get an opaque submit failure). Local/remote answer over a
  // context-capped, most-recent slice (the backend sizes the corpus to the
  // model's window) — see the hint below.
  const orgSignedIn = orgSession.data?.signedIn === true;
  const providerReady =
    chatProviderReady(provider.data) || (isAdapter && orgSignedIn);
  const orgScopeActive = scopeFolderId === ORG_SHARED_SCOPE;
  const ready = providerReady || orgScopeActive;

  // Recents = global-scope chats only (sessions started from THIS tab),
  // never the in-meeting AskBar history.
  const allRecents = React.useMemo(() => {
    const list = allSessions.data?.sessions ?? [];
    return list
      .filter((s) => s.summaryFile === GLOBAL_SCOPE)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [allSessions.data?.sessions]);

  // Default view shows the 8 most-recent chats; "See all" expands to the
  // full list grouped by time bucket (Today / Last 2 weeks / April / …).
  // Hide the toggle entirely when the list already fits.
  const COLLAPSED_LIMIT = 8;
  const [recentsExpanded, setRecentsExpanded] = React.useState(false);
  const canExpand = allRecents.length > COLLAPSED_LIMIT;
  const recents = recentsExpanded ? allRecents : allRecents.slice(0, COLLAPSED_LIMIT);
  const groupedRecents = React.useMemo(() => {
    if (!recentsExpanded) return null;
    const now = Date.now();
    const groups = new Map<string, typeof allRecents>();
    for (const s of allRecents) {
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
  }, [recentsExpanded, allRecents]);

  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const submit = async (raw: string) => {
    const q = raw.trim();
    // Org-scoped chat doesn't depend on the cloud-key gate (it goes through
    // the adapter's centrally-managed key). Local chat still does.
    const isOrgScope = scopeFolderId === ORG_SHARED_SCOPE;
    if (!q || submittingRef.current) return;
    if (!isOrgScope && !providerReady) return;
    submittingRef.current = true;
    setSubmitError(null);
    let createdSessionId: string | null = null;
    try {
      createdSessionId = await chat.createSession(deriveSessionName(q));
      await chat.appendMessage(createdSessionId, {
        role: 'user',
        content: q,
        ts: Date.now(),
      });
      setInput('');

      // Streaming for both local AND org scope — startGlobalStream picks
      // the right backend internally based on folderId / meetingFiles.
      const hasMeetings = selectedMeetingFiles.length > 0;
      const streamId = streaming.startGlobalStream(
        q,
        hasMeetings ? null : scopeFolderId,
        undefined,
        undefined,
        hasMeetings ? selectedMeetingFiles : null,
      );
      // Record the handoff under THIS sessionId so a fast double-submit
      // can't clobber an earlier in-flight stream before the conversation
      // page mounts and claims it.
      recordPendingNewChat({
        sessionId: createdSessionId,
        streamId,
        folderId: hasMeetings ? null : scopeFolderId,
        selectedMeetingFiles: hasMeetings ? selectedMeetingFiles : undefined,
      });
      navigate(`/chat/${encodeURIComponent(createdSessionId)}`);
    } catch (err) {
      // appendMessage / startGlobalStream / createSession can all fail
      // (disk full, IPC error, cloud-key revoked). Surface the error,
      // restore the user's text so they don't have to retype, and roll
      // back the empty session so it doesn't appear in History/Recents.
      const message = err instanceof Error ? err.message : 'Failed to send';
      setSubmitError(message);
      setInput(q);
      if (createdSessionId) {
        try {
          await chat.deleteSession(createdSessionId);
        } catch {
          // best-effort cleanup
        }
      }
    } finally {
      submittingRef.current = false;
    }
  };

  const onPickPreset = (prompt: string) => {
    setInput(prompt);
    setPresetsOpen(false);
    inputRef.current?.focus();
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit(input);
  };

  return (
    <>
      <MeetingsShell activeSummaryFile={null}>
      <div className="mx-auto flex w-full max-w-[640px] flex-col min-h-[calc(100vh-64px)] px-2">
        <div className="h-[22vh] min-h-[120px] flex-shrink-0" />

        <div className="w-full">
          <h1
          className="mb-8 text-center"
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 36,
            lineHeight: 1.1,
            letterSpacing: '-0.03em',
            color: 'var(--fg-1)',
          }}
        >
          {greetingName ? (
            <>
              Hi <span style={{ fontStyle: 'italic', fontWeight: 500 }}>{greetingName}</span>, ask anything
            </>
          ) : (
            'Ask anything'
          )}
        </h1>

        {!providerReady && !orgScopeActive && provider.isFetched && <ProviderRequiredBanner />}
        {submitError && (
          <div
            role="alert"
            className="mb-4 rounded-md border px-3 py-2 text-[13px]"
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
              className="glass-input-wrapper mb-12 p-3 relative"
              style={{
                opacity: ready ? 1 : 0.6,
              }}
            >
              <div className="relative">
                {ready && !input && !presetsOpen && !isFocused && <TypewriterPlaceholder index={suggestedIndex} setIndex={setSuggestedIndex} />}
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
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
                    if (e.key === 'Tab' && input === '' && ready) {
                      e.preventDefault();
                      setInput(PRESETS[suggestedIndex].prompt);
                      setPresetsOpen(false);
                      return;
                    }
                    if (e.key === '/' && input === '' && ready) {
                      setSelectedPresetIndex(0);
                      setPresetsOpen(true);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void submit(input);
                    }
                  }}
                  disabled={!ready}
                  placeholder={ready ? (typeof navigator !== 'undefined' && navigator.webdriver ? 'Summarise my meetings this week  /' : (isFocused && !input ? `/ ${PRESETS[suggestedIndex].label}` : '')) : 'Set up an AI provider in Settings to ask across notes'}
                  className="block w-full bg-transparent px-3 pb-4 pt-2.5 outline-none disabled:cursor-not-allowed placeholder:text-[color:var(--fg-muted)]"
                  style={{ fontSize: 16, color: 'var(--fg-1)', fontFamily: 'var(--font-sans)', fontWeight: 400 }}
                />
              </div>
          <div className="flex items-center justify-between gap-2 px-2 pb-1">
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
                // Local/remote windows are smaller than cloud, so the backend
                // caps the corpus to the most-recent notes when it's over budget.
                // "may omit" (not "omits") since a small library fits entirely.
                // TODO: tie to the actual per-response cap (CHAT_SCOPE_CAPPED,
                // descoped from WS3) so the hint only shows when truncation ran.
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
              {input.trim() && !input.trim().startsWith('/') && (
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
              <button
                type="submit"
                disabled={!input.trim() || !ready}
                className="inline-flex size-7 items-center justify-center rounded-full transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-40"
                style={{ color: 'var(--fg-1)' }}
                aria-label="Send"
              >
                <ArrowUp className="size-[14px]" />
              </button>
            </div>
          </div>
        </form>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            sideOffset={8}
            className="w-[var(--radix-popover-trigger-width)] max-w-none p-1"
            // Don't yank focus from the input when the popover opens — the
            // user is mid-typing and Enter/Esc need to keep working there.
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

        <section className="mt-6 flex-1 w-full">
          <SectionHead
            title="Recents"
            action={
              canExpand ? (
                <button
                  type="button"
                  onClick={() => setRecentsExpanded((v) => !v)}
                  className="inline-flex items-center gap-0.5 text-[12px] transition-colors hover:text-[color:var(--fg-1)]"
                  style={{ color: 'var(--fg-2)' }}
                >
                  {recentsExpanded ? 'Show less' : 'See all'}
                  <ChevronRight
                    className={`size-[12px] transition-transform ${recentsExpanded ? 'rotate-90' : ''}`}
                  />
                </button>
              ) : undefined
            }
          />
          {allRecents.length === 0 ? (
            <div
              className="py-12 text-center text-[14px]"
              style={{
                color: 'var(--fg-muted)',
              }}
            >
              <div className="mb-3 flex justify-center">
                <History className="size-4 text-muted-foreground" />
              </div>
              Your past chats will show up here.
            </div>
          ) : recentsExpanded && groupedRecents ? (
            <div className="flex flex-col">
              {groupedRecents.map((group) => (
                <div key={group.key} className="mb-2 last:mb-0">
                  <div
                    className="px-1 pb-1 pt-2 text-[11px] font-medium"
                    style={{ color: 'var(--fg-muted)' }}
                  >
                    {group.label}
                  </div>
                  {group.sessions.map((s) => (
                    <ChatHistoryRow
                      key={s.id}
                      session={s}
                      showTime
                      onRename={(name) => void chat.renameSession(s.id, name)}
                      onDelete={() => void chat.deleteSession(s.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col">
              {recents.map((s) => (
                <ChatHistoryRow
                  key={s.id}
                  session={s}
                  showTime
                  onRename={(name) => void chat.renameSession(s.id, name)}
                  onDelete={() => void chat.deleteSession(s.id)}
                />
              ))}
            </div>
          )}
        </section>
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

// Module-level handoff between the entry page (kicks off the stream right
// before navigating) and the conversation page (picks up the stream id +
// session id on mount). Avoids stuffing them in the URL.
//
// Keyed by sessionId so a fast double-submit can't clobber an earlier
// in-flight handoff before the conversation page mounts to claim it.
export interface PendingNewChat {
  sessionId: string;
  streamId: string;
  folderId: string | null;
  selectedMeetingFiles?: string[];
}
const pendingNewChats = new Map<string, PendingNewChat>();

export function recordPendingNewChat(pending: PendingNewChat) {
  pendingNewChats.set(pending.sessionId, pending);
}

export function consumePendingNewChat(sessionId: string): PendingNewChat | null {
  const out = pendingNewChats.get(sessionId);
  if (!out) return null;
  pendingNewChats.delete(sessionId);
  return out;
}

function ProviderRequiredBanner() {
  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-md border px-3 py-2.5 text-[13px]"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-sunken)',
        color: 'var(--fg-2)',
      }}
    >
      <Sparkles className="mt-0.5 size-[14px] flex-shrink-0" style={{ color: 'var(--fg-2)' }} />
      <div className="flex-1">
        Your AI provider isn't ready for chat yet — add a cloud API key, sign in
        to your Organisation, or set your remote Ollama URL in{' '}
        <button
          type="button"
          className="underline transition-colors hover:text-[color:var(--fg-1)]"
          onClick={() => navigate('/settings')}
          style={{ color: 'var(--fg-1)' }}
        >
          Settings → AI
        </button>
        .
      </div>
    </div>
  );
}

function SectionHead({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-[13px] font-medium tracking-[-0.005em]" style={{ color: 'var(--fg-1)' }}>
        {title}
      </h2>
      {action}
    </div>
  );
}

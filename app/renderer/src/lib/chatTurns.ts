import * as React from 'react';

/**
 * In-flight Chat-tab answers, by session. The answer belongs to the request,
 * not the page: leaving a conversation mid-answer must neither lose the
 * reply nor stop it being saved, and coming back must show it streaming.
 * ChatTurnPersister (mounted once in App) saves each finished turn;
 * ChatConversation reads the live one for its session from here.
 */
export interface ChatTurn {
  sessionId: string;
  streamId: string;
  /** The message context the answer is saved with (folder id or 'notes'). */
  context: string;
  /**
   * Saving the finished answer failed (after a retry). The turn and its
   * stream stay until the user retries or dismisses it, so the answer is
   * never dropped silently (ChatTurnPersister, ChatConversation).
   */
  saveFailed?: boolean;
}

let turns: ChatTurn[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function trackChatTurn(turn: ChatTurn) {
  turns = [...turns.filter((t) => t.sessionId !== turn.sessionId), turn];
  notify();
}

export function untrackChatTurn(streamId: string) {
  const next = turns.filter((t) => t.streamId !== streamId);
  if (next.length !== turns.length) {
    turns = next;
    notify();
  }
}

/** Flag (or clear, to retry) a turn whose save failed. */
export function setChatTurnSaveFailed(streamId: string, saveFailed: boolean) {
  const current = turns.find((t) => t.streamId === streamId);
  if (!current || Boolean(current.saveFailed) === saveFailed) return;
  turns = turns.map((t) => (t.streamId === streamId ? { ...t, saveFailed } : t));
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChatTurns(): ChatTurn[] {
  return React.useSyncExternalStore(subscribe, () => turns);
}

export function useChatTurn(sessionId: string): ChatTurn | null {
  const all = useChatTurns();
  return all.find((t) => t.sessionId === sessionId) ?? null;
}

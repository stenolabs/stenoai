import * as React from 'react';
import { actionRecords } from '@/components/chat/ChatAgentTrail';
import { useChatSessions, type ChatMessage } from '@/hooks/useChatSessions';
import { useGlobalStreaming } from '@/hooks/useStreamingQuery';
import { GLOBAL_SCOPE } from '@/lib/chat';
import { setChatTurnSaveFailed, untrackChatTurn, useChatTurns } from '@/lib/chatTurns';
import { saveWithRetry } from '@/lib/chatSave';
import { aiErrorSavedText } from '@/lib/aiError';

/**
 * Saves each finished Chat-tab answer to its session, wherever the user is
 * in the app (see lib/chatTurns.ts). Renders nothing.
 */
export function ChatTurnPersister() {
  const turns = useChatTurns();
  const streaming = useGlobalStreaming();
  const chat = useChatSessions(GLOBAL_SCOPE, null);
  const saving = React.useRef(new Set<string>());

  React.useEffect(() => {
    for (const turn of turns) {
      const stream = streaming.streams[turn.streamId];
      if (!stream || stream.status === 'streaming' || saving.current.has(turn.streamId)) continue;
      // A failed save waits for the user (retry clears the flag; dismiss
      // untracks the turn) rather than looping here.
      if (turn.saveFailed) continue;
      saving.current.add(turn.streamId);
      // A classified failure saves its code (rendered as AiErrorNotice) and its
      // fixed title as text, never the backend's error message.
      const errorCode = stream.status === 'error' ? stream.errorCode : undefined;
      const content =
        stream.text.trim() ||
        (errorCode
          ? aiErrorSavedText(errorCode)
          : stream.status === 'error'
            ? `Error: ${stream.error ?? 'query failed'}`
            : '(empty response)');
      const actions = actionRecords(stream.cards);
      const message: ChatMessage = {
        role: 'assistant',
        context: turn.context,
        content,
        ...(errorCode ? { error: errorCode } : {}),
        ts: Date.now(),
        ...(stream.steps?.length ? { steps: stream.steps } : {}),
        ...(actions ? { actions } : {}),
      };
      // The stream is cleared only once the answer is on disk. A failed save
      // is retried once; if that fails too the turn stays, flagged, and the
      // conversation shows the answer with a retry and a dismiss.
      void saveWithRetry(() => chat.appendMessage(turn.sessionId, message))
        .then(
          () => {
            streaming.clearStream(turn.streamId);
            untrackChatTurn(turn.streamId);
          },
          () => setChatTurnSaveFailed(turn.streamId, true),
        )
        .finally(() => saving.current.delete(turn.streamId));
    }
  }, [turns, streaming, chat]);

  return null;
}

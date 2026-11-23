import * as React from 'react';
import { actionRecords } from '@/components/chat/ChatAgentTrail';
import { useChatSessions, type ChatMessage } from '@/hooks/useChatSessions';
import { useGlobalStreaming } from '@/hooks/useStreamingQuery';
import { GLOBAL_SCOPE } from '@/lib/chat';
import { untrackChatTurn, useChatTurns } from '@/lib/chatTurns';
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
      void chat.appendMessage(turn.sessionId, message).finally(() => {
        streaming.clearStream(turn.streamId);
        untrackChatTurn(turn.streamId);
        saving.current.delete(turn.streamId);
      });
    }
  }, [turns, streaming, chat]);

  return null;
}

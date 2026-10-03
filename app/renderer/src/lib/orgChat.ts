/**
 * Helpers for chatting against the org-shared notes corpus through the
 * adapter's /ai/chat endpoint. Used by both the Chat tab entry composer and
 * the ChatConversation follow-up composer when scope === ORG_SHARED_SCOPE.
 */
import { ipc } from '@/lib/ipc';
import type { OrgMeetingSummary, OrgMeeting } from '@/lib/ipc';
import { unwrap } from '@/lib/result';
import { CHART_INSTRUCTIONS } from '@/lib/chatChart';

interface OrgChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Fetches every visible org meeting. The adapter inlines bodies (S3-fetched
 * server-side when needed), so we just collect them and concatenate.
 *
 * TODO(retrieval): this naive "inline everything" approach scales to roughly
 * a few hundred shared notes before token cost / latency / context window
 * become real problems. Replace with: embed each note at share time, top-k
 * retrieve at query time, inline only the relevant slice into the system
 * prompt. See the "Retrieval for org chat" issue in the OSS tracker.
 */
async function loadOrgCorpus(): Promise<string> {
  const list = unwrap(await ipc().org.listMeetings()).meetings as OrgMeetingSummary[];
  if (list.length === 0) return '(no shared notes available yet)';
  const blocks = await Promise.all(
    list.map(async (m): Promise<string> => {
      try {
        const meeting = unwrap(await ipc().org.getMeeting(m.id)).meeting as OrgMeeting;
        const body = meeting.body ?? '';
        return [
          `### ${meeting.title}`,
          `_shared by ${meeting.owner_email}_`,
          body || '(empty)',
        ].join('\n');
      } catch (e) {
        return `### ${m.title}\n(could not load: ${(e as Error).message})`;
      }
    }),
  );
  return blocks.join('\n\n---\n\n');
}

const SYSTEM_PREFIX =
  `You answer questions across an organisation's shared meeting notes. ` +
  `When an answer comes from a specific note, cite it by its title only (e.g. "from Pricing Units"). ` +
  `Never invent or mention internal identifiers. ` +
  `If the corpus doesn't contain enough information to answer confidently, say so.`;

/** Builds a streaming-ready payload (system + messages) for org chat.
 *  Used by useStreamingQuery to dispatch through ipc().org.chatStream. */
export async function buildOrgChatPayload(
  history: OrgChatTurn[],
  question: string,
) {
  const corpus = await loadOrgCorpus();
  const system = `${SYSTEM_PREFIX}\n\n${CHART_INSTRUCTIONS}\n\n--- SHARED NOTES ---\n${corpus}`;
  const messages: OrgChatTurn[] = [
    ...history,
    { role: 'user', content: question },
  ];
  return { system, messages };
}

/** One-shot org chat. Kept for callers that don't need streaming. */
export async function askOrgChat(
  history: OrgChatTurn[],
  question: string,
): Promise<string> {
  const { system, messages } = await buildOrgChatPayload(history, question);
  const res = unwrap(await ipc().org.aiChat({ system, messages }));
  return res.reply;
}

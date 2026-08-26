import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';

/**
 * T2 — cross-note chat with a LOCAL provider (WS3). Proves the hard cloud/adapter
 * gate is gone: with ai_provider=local, chat_global_streaming assembles the local
 * notes into a prompt and streams an answer via the capturing mock Ollama —
 * NO real model. Pairs with the chat-corpus-budget unit test (cap sizing) and the
 * chat-local-access T1 (renderer readiness).
 */

const ANSWER = 'Based on your notes, the team is shipping on Friday.';

type StreamResult = { ok: boolean; text: string; error?: string };
type StenoWindow = Window & {
  stenoai: {
    query: { chatGlobalStream: (id: string, q: string, folder: string | null) => void };
    subscribeQueryStream: (
      id: string,
      cbs: { onChunk: (c: string) => void; onDone: () => void; onError: (e: Error) => void },
    ) => () => void;
  };
};

test('local provider answers cross-note chat (no cloud/adapter required)', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  writeUserConfig(userDataDir, { ai_provider: 'local' });
  writeMeetingSummary(userDataDir, 'standup', {
    name: 'Monday Standup',
    summary: 'The team agreed to ship the release on Friday.',
  });
  writeMeetingSummary(userDataDir, 'budget', {
    name: 'Budget Review',
    summary: 'Quarterly budget is fifty thousand dollars.',
  });

  const ollama = await startMockOllama({ chatReply: ANSWER });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    const result: StreamResult = await page.evaluate(
      (q) =>
        new Promise<StreamResult>((resolve) => {
          const id = 'e2e-chat-local';
          let text = '';
          const timer = setTimeout(
            () => resolve({ ok: false, text, error: 'timeout' }),
            25_000,
          );
          const w = window as unknown as StenoWindow;
          w.stenoai.subscribeQueryStream(id, {
            onChunk: (c) => {
              text += c;
            },
            onDone: () => {
              clearTimeout(timer);
              resolve({ ok: true, text });
            },
            onError: (e) => {
              clearTimeout(timer);
              resolve({ ok: false, text, error: e.message });
            },
          });
          w.stenoai.query.chatGlobalStream(id, q, null);
        }),
      'What are we shipping and when?',
    );

    // Not rejected (the old gate would have produced a CHAT_STREAM_ERROR
    // "needs a cloud or organisation AI provider") and the mock reply streamed.
    expect(result.ok).toBe(true);
    expect(result.text).toContain('shipping on Friday');

    // The prompt the local model received embedded the assembled note corpus.
    const prompt = ollama.lastChatPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('ship the release on Friday');
    expect(prompt).toContain('Budget Review');

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});

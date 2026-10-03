import { test, expect } from '../fixtures/electron';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { ChatRequest } from '../../app/renderer/src/lib/ipc';
import type { Page } from '@playwright/test';

async function ask(page: Page, request: ChatRequest) {
  return page.evaluate((request) => new Promise<{ text: string; error?: string }>((resolve) => {
    const id = `t2-${Date.now()}`;
    let text = '';
    const timer = setTimeout(() => { window.stenoai.query.cancel(id); resolve({ text, error: 'timeout' }); }, 20000);
    window.stenoai.subscribeQueryStream(id, {
      onChunk: (chunk) => { text += chunk; },
      onDone: () => { clearTimeout(timer); resolve({ text }); },
      onError: (error) => { clearTimeout(timer); resolve({ text, error: error.message }); },
    });
    window.stenoai.query.chatContext(id, request);
  }), request);
}

for (const format of ['md', 'json']) {
test(`live context, saved notes and general chat work during capture and persist on its ${format} note`, async ({ launchApp, userDataDir }) => {
  test.setTimeout(150000);
  const ollama = await startMockOllama({ port: 0, chatReply: '1. Ship Friday\n\n2. Review Monday' });
  try {
    writeUserConfig(userDataDir, {
      ai_provider: 'remote', remote_ollama_url: ollama.url, model: 'llama3.2:3b',
      transcription_engine: 'whisper', system_audio_enabled: false,
      auto_summarize_enabled: false, privacy_notice_seen: true,
    });
    writeMeetingSummary(userDataDir, 'older', { name: 'Budget Review', summary: 'Prior budget is fifty thousand dollars.' });
    const savedPath = path.join(userDataDir, 'output', `continued_summary.${format}`);
    if (format === 'json') {
      writeMeetingSummary(userDataDir, 'continued', { name: 'Continued', transcript: 'Earlier milestone is Tuesday.' });
    } else {
      writeFileSync(savedPath, '---\nname: Continued\n---\n\n## Transcript\n\nEarlier milestone is Tuesday.\n');
    }
    const longPath = writeMeetingSummary(userDataDir, 'long', {
      name: 'Long meeting', summary: 'Saved decision: launch on Tuesday.',
      action_items: ['Morgan owns the rollout.'],
      transcript: 'Obsolete opening. ' + 'background speech '.repeat(4000) + 'Latest follow-up.',
    });
    const longNote = JSON.parse(readFileSync(longPath, 'utf8'));
    longNote.user_notes = 'Ask finance before extending the pilot.';
    writeFileSync(longPath, JSON.stringify(longNote));
    const { page, app } = await launchApp({ fakeAudio: true });
    // Replace only the ASR sidecar with a deterministic producer. The real main
    // stdout parser, recording lifecycle, preload bridge, bundled query CLI,
    // provider HTTP call and chat persistence all stay in the loop.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.on('system-audio-recording-state', (_event: unknown, active: boolean) => { (global as any).__chatCaptureActive = active; });
      const { ChildProcess } = process.getBuiltinModule('child_process');
      const original = ChildProcess.prototype.spawn;
      ChildProcess.prototype.spawn = function (options: any) {
        if (options.args?.includes('transcribe-stream')) {
          options.file = process.execPath;
          options.args = [process.execPath, '-e', `
            console.log('LIVE_READY:ok');
            console.log('LIVE_SEG:'+JSON.stringify({text:'Current decision is Friday.',start:0,end:3,is_final:true,speaker:'You'}));
            console.log('LIVE_SEG:'+JSON.stringify({text:'UNFINALIZED SECRET',start:3,end:4,is_final:false,speaker:'Others'}));
            process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));
          `];
          options.envPairs = options.envPairs.filter((p: string) => !p.startsWith('ELECTRON_RUN_AS_NODE='));
          options.envPairs.push('ELECTRON_RUN_AS_NODE=1');
        }
        return original.call(this, options);
      };
    });
    await page.evaluate(() => window.stenoai.transcriptionEngine.set('parakeet'));
    // Direct bridge mutation bypasses React Query invalidation; reload to read it.
    await page.reload();
    await page.waitForSelector('[data-app-ready]');
    await page.evaluate(() => window.stenoai.recording.start('Note'));
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.stenoai.liveTranscript.getState());
      return state.success && state.segments.some((s) => s.isFinal);
    }).toBe(true);
    await expect.poll(async () => {
      const queue = await page.evaluate(() => window.stenoai.recording.getQueue());
      return queue.success && !!queue.chatSummaryFile;
    }).toBe(true);
    await expect.poll(() => app.evaluate(() => (global as any).__chatCaptureActive)).toBe(true);
    const queue = await page.evaluate(() => window.stenoai.recording.getQueue());
    if (!queue.success) throw new Error('recording did not start');
    const live = await ask(page, { scope: 'live', recordingId: queue.recordingId!, question: 'What did we decide?' });
    expect(live.error).toBeUndefined();
    expect(live.text).toContain('Ship Friday');
    expect(ollama.lastChatPrompt()).toContain('Current decision is Friday');
    expect(ollama.lastChatPrompt()).not.toContain('UNFINALIZED SECRET');
    const wrong = await ask(page, { scope: 'live', recordingId: 'previous-recording', question: 'What happened?' });
    expect(wrong.error).toContain('no longer active');
    await page.evaluate(() => window.stenoai.recording.pause());
    const paused = await ask(page, { scope: 'live', recordingId: queue.recordingId!, question: 'Who owns that?', history: [{ role: 'user', content: 'What did we decide?' }] });
    expect(paused.error).toBeUndefined();
    expect(ollama.lastChatPrompt()).toContain('USER: What did we decide?');
    await page.evaluate(() => window.stenoai.recording.resume());
    const prior = await ask(page, { scope: 'meeting', file: savedPath, question: 'What is the earlier milestone?' });
    expect(prior.error).toBeUndefined();
    expect(ollama.lastChatPrompt()).toContain('Earlier milestone is Tuesday');
    const long = await ask(page, { scope: 'meeting', file: longPath, question: 'What are the saved decisions?' });
    expect(long.error).toBeUndefined();
    for (const evidence of ['Saved decision: launch on Tuesday.', 'Morgan owns the rollout.', 'Ask finance before extending the pilot.', 'Latest follow-up.']) {
      expect(ollama.lastChatPrompt()).toContain(evidence);
    }
    expect(ollama.lastChatPrompt()).not.toContain('Obsolete opening.');
    expect(ollama.lastChatPrompt().length).toBeLessThan(16000);
    const notes = await ask(page, { scope: 'notes', question: 'What was the budget?' });
    expect(notes.error).toBeUndefined();
    expect(ollama.lastChatPrompt()).toContain('Prior budget is fifty thousand');
    const previousPrompt = ollama.lastChatPrompt();
    const empty = await ask(page, { scope: 'notes', folder: 'empty-folder', question: 'Any decisions?' });
    expect(empty.error).toContain('No notes in this scope');
    expect(empty.text).toBe('');
    expect(ollama.lastChatPrompt()).toBe(previousPrompt);
    const general = await ask(page, { scope: 'general', question: 'Explain DNS' });
    expect(general.error).toBeUndefined();
    expect(ollama.lastChatPrompt()).not.toContain('Current decision');
    expect(ollama.lastChatPrompt()).not.toContain('Prior budget');

    // Exercise renderer persistence too, then stop and read the actual JSON.
    const composer = page.locator('[data-ask-bar]');
    await composer.getByRole('textbox').fill('Summarize the decision');
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(composer.locator('ol > li')).toHaveCount(2);
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(path.join(userDataDir, 'chat_sessions_v2.json'), 'utf8')).sessions[0].messages.length; }
      catch { return 0; }
    }).toBe(2);
    const stopped = await page.evaluate(() => window.stenoai.recording.stop());
    expect(stopped.success).toBe(true);
    const blob = JSON.parse(readFileSync(path.join(userDataDir, 'chat_sessions_v2.json'), 'utf8'));
    expect(blob.sessions[0].summaryFile).toBe(queue.chatSummaryFile);
    expect(stopped.success && stopped.summaryFile).toBe(queue.chatSummaryFile);
    // Wait for the renderer to finish flushing capture before starting another
    // recording; the stop IPC returns before MediaRecorder's async onstop.
    await expect.poll(() => app.evaluate(() => (global as any).__chatCaptureActive)).toBe(false);

    // Continue into either supported saved format, retaining prior speech.
    await page.evaluate((file) => window.stenoai.recording.start('Continued', 'manual', file), savedPath);
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.stenoai.liveTranscript.getState());
      return state.success && state.sessionName === 'Continued' && state.segments.some((s) => s.isFinal);
    }).toBe(true);
    await expect.poll(() => app.evaluate(() => (global as any).__chatCaptureActive)).toBe(true);
    const continued = await page.evaluate(() => window.stenoai.recording.getQueue());
    if (!continued.success) throw new Error('continuation failed');
    const result = await ask(page, { scope: 'live', recordingId: continued.recordingId!, question: 'What changed since earlier?' });
    expect(result.error).toBeUndefined();
    expect(ollama.lastChatPrompt()).toContain('Earlier milestone is Tuesday');
    expect(ollama.lastChatPrompt()).toContain('Current decision is Friday');
    await page.evaluate((file) => { window.location.hash = `#/meetings/${encodeURIComponent(file)}`; }, savedPath);
    await composer.getByRole('textbox').fill('Summarize the continued meeting');
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => {
      const saved = JSON.parse(readFileSync(path.join(userDataDir, 'chat_sessions_v2.json'), 'utf8'));
      return saved.sessions.find((s: any) => s.summaryFile === savedPath)?.messages.length;
    }).toBe(2);
    await page.evaluate(() => window.stenoai.recording.stop());
    const continuedChats = JSON.parse(readFileSync(path.join(userDataDir, 'chat_sessions_v2.json'), 'utf8'));
    expect(continuedChats.sessions.find((s: any) => s.summaryFile === savedPath)?.messages[1].role).toBe('assistant');
  } finally { await ollama.close(); }
});
}

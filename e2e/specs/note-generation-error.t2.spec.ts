import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { test, expect } from '../fixtures/electron';
import { writeMeetingMarkdown, writeUserConfig } from '../fixtures/user-config';

test('reprocess IPC reports a model failure, preserves the note, and succeeds on retry', async ({ launchApp, userDataDir }) => {
  test.setTimeout(60_000);
  let fail = true;
  let calls = 0;
  const reply = '## Summary\n\nThe synthetic release is scheduled for Friday.\n';
  // Explicit remote provider on an ephemeral loopback port. No real Ollama,
  // model loading, downloads or external network are involved.
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/api/chat') {
      calls++;
      if (fail) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'model "synthetic-model" not found' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(JSON.stringify({ model: 'synthetic-model', message: { role: 'assistant', content: reply }, done: false }) + '\n'
          + JSON.stringify({ model: 'synthetic-model', message: { role: 'assistant', content: '' }, done: true }) + '\n');
      }
    } else if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'synthetic-model', model: 'synthetic-model', size: 1 }] }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown synthetic test endpoint' }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing mock port');
    writeUserConfig(userDataDir, {
      ai_provider: 'remote', remote_ollama_url: `http://127.0.0.1:${address.port}`,
      model: 'synthetic-model', privacy_notice_seen: true, telemetry_enabled: false,
    });
    const file = writeMeetingMarkdown(userDataDir, 'synthetic-generation', {
      name: 'Synthetic planning', summaryMarkdown: '## Summary\n\nOriginal summary must survive.',
      transcript: 'The synthetic release is scheduled for Friday.',
      notes: 'Keep the synthetic agenda.', frontmatter: { notes_stale: true },
    });
    const original = readFileSync(file, 'utf8');
    const { page } = await launchApp();
    const failure = await page.evaluate(async (summaryFile) => {
      const events: Array<{ success: boolean; error_code?: string }> = [];
      const off = window.stenoai.on.summaryComplete(e => { if (e.summaryFile === summaryFile) events.push(e); });
      try {
        const result = await window.stenoai.meetings.reprocess(summaryFile, false, 'Synthetic planning');
        return { result, events };
      } finally { off(); }
    }, file);
    expect(failure.result.success).toBe(false);
    if (failure.result.success) throw new Error('Expected a failed reprocess');
    expect(failure.result.error_code).toBe('generation_model_unavailable');
    expect(failure.result.error).toBe('Note generation failed');
    expect(failure.events).toEqual(expect.arrayContaining([expect.objectContaining({ success: false, error_code: 'generation_model_unavailable' })]));
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(calls).toBeGreaterThan(0);

    fail = false;
    const retry = await page.evaluate(summaryFile => window.stenoai.meetings.reprocess(summaryFile, false, 'Synthetic planning'), file);
    expect(retry.success).toBe(true);
    const saved = readFileSync(file, 'utf8');
    expect(saved).toContain('The synthetic release is scheduled for Friday.');
    expect(saved).toContain('Keep the synthetic agenda.');
    expect(saved).not.toContain('Original summary must survive.');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

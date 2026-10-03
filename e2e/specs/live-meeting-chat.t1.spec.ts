import { test, expect } from '../fixtures/electron';

const ENV = { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' };

test('live chat formats loose lists, keeps follow-ups, and allows general questions', async ({ launchApp }) => {
  const { page, app } = await launchApp({ mockIpc: true, fakeAudio: true, env: ENV });
  await page.evaluate(() => window.stenoai.recording.start('Note'));
  const composer = page.locator('[data-ask-bar]');
  const input = composer.getByRole('textbox');
  await expect(input).toBeEnabled();
  await input.fill('What did we decide?');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer.locator('ol')).toHaveCount(1);
  await expect(composer.locator('ol > li')).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath('live-chat.png') });
  expect(await composer.locator('ol').evaluate((el) => getComputedStyle(el).listStyleType)).toBe('decimal');
  await input.fill('Who owns that?');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer.locator('ol')).toHaveCount(2);
  const calls = await app.evaluate(() => (global as any).__mockIpcCalls.filter((c: any) => c.channel === 'chat-context-stream'));
  expect(calls[0].args[1].scope).toBe('live');
  expect(calls[1].args[1].history).toHaveLength(2);
  await composer.getByRole('button', { name: 'Scope: This meeting' }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await input.fill('Explain DNS');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer.locator('ol')).toHaveCount(3);
  const general = await app.evaluate(() => (global as any).__mockIpcCalls.filter((c: any) => c.channel === 'chat-context-stream').at(-1).args[1]);
  expect(general.scope).toBe('general');
  expect(general.history).toEqual([]);
  await expect(page.getByTestId('transcription-pill')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-ask-bar]').getByRole('button', { name: 'Scope: General' })).toBeVisible();
});

test('draft and answer survive transcript expansion and stopping the recording', async ({ launchApp }) => {
  const { page, app } = await launchApp({ mockIpc: true, fakeAudio: true, env: { ...ENV, STENOAI_E2E_HOLD_CHAT: '1' } });
  await page.evaluate(() => window.stenoai.recording.start('Note'));
  const composer = page.locator('[data-ask-bar]');
  const input = composer.getByRole('textbox');
  await expect(input).toBeEnabled();
  await input.fill('Keep this draft');
  await page.getByTestId('transcription-pill').getByRole('button', { name: 'Show transcript' }).click();
  await page.getByRole('button', { name: 'Minimize transcript' }).click();
  await expect(input).toHaveValue('Keep this draft');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  const before = await page.evaluate(() => window.stenoai.chat.load());
  const key = before.success ? before.data?.sessions[0].summaryFile : null;
  await page.getByTestId('transcription-pill').getByRole('button', { name: 'Stop recording' }).click();
  await app.evaluate(() => (global as any).__finishChat());
  await expect.poll(async () => {
    const saved = await page.evaluate(() => window.stenoai.chat.load());
    return saved.success ? saved.data?.sessions[0].messages.length : 0;
  }).toBe(2);
  const saved = await page.evaluate(() => window.stenoai.chat.load());
  expect(saved.success && saved.data?.sessions[0].summaryFile).toBe(key);
  // A new recording with the same display name gets its own conversation.
  await page.evaluate(() => { window.location.hash = '#/'; });
  await page.evaluate(() => window.stenoai.recording.start('Note'));
  await expect(composer.locator('ol')).toHaveCount(0);
});

test('Chat tab renders numbered answers while recording continues', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, fakeAudio: true, env: ENV });
  await page.evaluate(() => window.stenoai.recording.start('Note'));
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  const input = page.getByRole('textbox').first();
  await input.fill('What are the priorities?');
  await input.press('Enter');
  await expect(page.locator('.chat-bubble ol')).toHaveCount(1);
  await expect(page.locator('.chat-bubble ol > li')).toHaveCount(3);
  await expect(page.getByTestId('transcription-pill')).toBeVisible();
});

test('an answer keeps its original conversation and scope after switching history', async ({ launchApp }) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_HOLD_CHAT: '1' } });
  await page.evaluate(() => window.stenoai.chat.save({ sessions: [
    { id: 'general', name: 'General chat', summaryFile: '__global__', scopeFolderId: '__general__', messages: [], createdAt: 1, updatedAt: 1 },
    { id: 'notes', name: 'Notes chat', summaryFile: '__global__', scopeFolderId: null, messages: [], createdAt: 2, updatedAt: 2 },
  ] }));
  await page.reload();
  await page.evaluate(() => { window.location.hash = '#/chat/general'; });
  await expect(page.getByRole('button', { name: 'Scope: General' })).toBeVisible();
  await page.getByRole('textbox').first().fill('Explain DNS');
  await page.getByRole('textbox').first().press('Enter');
  await expect(page.getByText('Thinking…', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/chat/notes'; });
  await expect(page.getByRole('button', { name: 'Scope: All notes' })).toBeVisible();
  await expect(page.getByText('Thinking…', { exact: true })).toHaveCount(0);
  await app.evaluate(() => (global as any).__finishChat());
  await expect.poll(async () => {
    const saved = await page.evaluate(() => window.stenoai.chat.load());
    return saved.success ? saved.data?.sessions.find((s) => s.id === 'general')?.messages.at(-1)?.role : null;
  }).toBe('assistant');
  const saved = await page.evaluate(() => window.stenoai.chat.load());
  expect(saved.success && saved.data?.sessions.find((s) => s.id === 'general')?.messages.at(-1)?.context).toBe('__general__');
  expect(saved.success && saved.data?.sessions.find((s) => s.id === 'notes')?.messages).toEqual([]);
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures/electron';
import { openShareMenu } from '../fixtures/share-menu';
import { writeMeetingMarkdown, writeUserConfig } from '../fixtures/user-config';

test('Standard note exports use the saved summary language', async ({ launchApp, userDataDir }) => {
  const note = writeMeetingMarkdown(userDataDir, 'planning', {
    name: 'Projektplanung',
    frontmatter: { language: 'de-DE' },
    summaryMarkdown: [
      '## Summary',
      'Das Team hat den Termin bestätigt.',
      '## Key Points',
      '- Der Entwurf ist fertig.',
      '## Action Items',
      '- Den Entwurf versenden.',
    ].join('\n\n'),
    transcript: 'Der Termin steht.',
  });
  const original = readFileSync(note, 'utf8');
  writeUserConfig(userDataDir, {
    language: 'en',
    privacy_notice_seen: true,
    telemetry_enabled: false,
  });
  const exported = path.join(userDataDir, 'standard-notes-export');
  const { page } = await launchApp({ env: { STENOAI_E2E_EXPORT_PATH: exported } });
  await page.evaluate((file) => {
    // Capture the text without depending on the OS clipboard in CI.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedNotes = text;
        },
      },
    });
    window.location.hash = '#/meetings/' + encodeURIComponent(file);
  }, note);

  const readExport = () => {
    try {
      return readFileSync(exported, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return '';
    }
  };
  const shareMenu = await openShareMenu(page);
  await shareMenu.getByRole('button', { name: /Save notes as \.md/ }).click();
  await expect.poll(readExport).toContain('## Aufgaben');
  const markdown = readExport();
  expect(markdown).toContain('## Zusammenfassung\n\nDas Team hat den Termin bestätigt.');
  expect(markdown).toContain('## Kernaussagen\n\n- Der Entwurf ist fertig.');
  expect(markdown).toContain('## Aufgaben\n\n- Den Entwurf versenden.');
  expect(markdown).not.toMatch(/^## (Summary|Key Points|Action Items)$/m);

  await shareMenu.getByRole('button', { name: 'Copy notes' }).click();
  const clipboard = page.locator('html');
  await expect(clipboard).toHaveAttribute('data-copied-notes', /\nZUSAMMENFASSUNG\nDas Team/);
  await expect(clipboard).toHaveAttribute('data-copied-notes', /\nKERNAUSSAGEN\n- Der Entwurf/);
  await expect(clipboard).toHaveAttribute('data-copied-notes', /\nAUFGABEN\n- Den Entwurf/);

  await (await openShareMenu(page)).getByRole('button', { name: /Save notes as PDF/ }).click();
  await expect.poll(() => readExport().slice(0, 5)).toBe('%PDF-');
  expect(readFileSync(note, 'utf8')).toBe(original);
});

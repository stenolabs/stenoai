import { expect, test } from 'vitest';
import { noteExportHeadings } from './notesExportHeadings';

test.each([
  ['DE_ch', 'de', 'Aufgaben'],
  ['pt-BR', 'pt', 'Tarefas'],
  ['zh-CN', 'zh-Hans', '待办事项'],
  ['zh-TW', 'zh-Hant', '待辦事項'],
  ['zh-Hant-CN', 'zh-Hant', '待辦事項'],
])('uses the matching export headings for %s', (code, language, actionItems) => {
  expect(noteExportHeadings(code)).toMatchObject({ language, labels: { actionItems } });
});

test.each([undefined, null, '', 'auto', '??', 'sv', 'constructor'])(
  'falls back to English for %s',
  (code) => {
    expect(noteExportHeadings(code)).toMatchObject({
      language: 'en',
      labels: { actionItems: 'Action Items' },
    });
  },
);

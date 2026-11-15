import { test as base, expect } from '../fixtures/electron';
import { readUserConfig, writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

// Model-free T2: real preload/main/backend, synthetic meeting, deterministic
// Ollama fixture. All files stay in the fixture's STENOAI_USER_DATA_DIR.
const DETAILED_ID = 'builtin_detailed';
const CUSTOM_TEMPLATES = [
  { id: 'detailed', name: 'Detailed', prompt: 'Synthetic custom Detailed prompt.',
    icon: 'doc', language: 'auto', format: 'markdown' },
  { id: 'builtin-detailed', name: 'Builtin Detailed', prompt: 'Synthetic custom Builtin Detailed prompt.',
    icon: 'doc', language: 'auto', format: 'markdown' },
];
const TRANSCRIPT = 'Alice: Ship on Friday. Bob: The approved budget is 50000 euros.';
const REPORT_REPLY = [
  '## Summary',
  'Ship on Friday within the approved budget.',
  '',
  '## Key Topics',
  '### Release',
  'Alice confirmed Friday. Bob confirmed a budget of 50000 euros.',
  '',
  '## Key Points',
  '- Budget: 50000 euros',
  '',
  '## Action Items',
  '- Ship on Friday',
].join('\n');

// Bind the mock before every launch, including CRUD-only cases: startup probes
// must not reach an Ollama instance on the developer's machine.
const test = base.extend<{ ollama: Awaited<ReturnType<typeof startMockOllama>> }>({
  launchApp: async ({ launchApp, userDataDir }, use) => {
    const home = path.join(userDataDir, 'home');
    const env = {
      HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    };
    for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
    await use((opts) => launchApp({ ...opts, env: { ...opts?.env, ...env } }));
  },
  ollama: [async ({}, use) => {
    const mock = await startMockOllama({ chatReply: REPORT_REPLY });
    try {
      await use(mock);
    } finally {
      await mock.close();
    }
  }, { auto: true }],
});

type Template = {
  id: string;
  name: string;
  icon: string;
  prompt: string;
  language: string;
  format: string;
  builtin: boolean;
  locked: boolean;
};
type Report = { id: string; template_id: string; template_name: string; content: string };
type Sidecar = { reports: Report[]; active_report: string | null };
type Result = { success: boolean; error?: string };
type StenoWindow = typeof window & {
  stenoai: {
    templates: {
      list: () => Promise<Result & { templates: Template[]; default_template_id: string }>;
      save: (template: Record<string, unknown>) => Promise<Result & { template?: Template }>;
      reset: (id: string) => Promise<Result>;
      setDefault: (id: string) => Promise<Result>;
    };
    meetings: {
      generateReport: (file: string, templateId: string) => Promise<Result>;
      get: (file: string) => Promise<Result & { meeting: Sidecar }>;
    };
  };
};

const readSidecar = (file: string): Sidecar => existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8')) as Sidecar
  : { reports: [], active_report: null };

test('Detailed is an editable markdown built-in alongside Standard and persisted custom templates', async ({
  launchApp, userDataDir,
}) => {
  // Seed pre-upgrade ids directly; saving after launch could hide a collision
  // by assigning a numeric suffix to the custom template.
  writeUserConfig(userDataDir, {
    templates_seeded: true, custom_templates: CUSTOM_TEMPLATES, default_template_id: 'builtin-detailed',
  });
  const { page } = await launchApp();
  const listed = await page.evaluate(() => (window as StenoWindow).stenoai.templates.list());
  expect(listed.success).toBe(true);
  expect(listed.default_template_id).toBe('builtin-detailed');
  const ids = listed.templates.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(listed.templates.find((t) => t.id === 'standard')).toMatchObject({
    builtin: true, locked: true, format: 'structured', prompt: '',
  });
  const detailed = listed.templates.find((t) => t.id === DETAILED_ID)!;
  expect(detailed).toMatchObject({
    name: 'Detailed', builtin: true, locked: false, format: 'markdown', language: 'auto',
  });
  for (const heading of ['## Summary', '## Key Topics', '## Key Points', '## Action Items']) {
    expect(detailed.prompt).toContain(heading);
  }

  for (const custom of CUSTOM_TEMPLATES) {
    expect(listed.templates.find((t) => t.id === custom.id)).toMatchObject({
      ...custom, builtin: false, locked: false,
    });
  }
  expect(readUserConfig(userDataDir).custom_templates).toEqual(CUSTOM_TEMPLATES);
  expect(readUserConfig(userDataDir).default_template_id).toBe('builtin-detailed');
});

test('Detailed edits persist as a built-in override and reset restores the shipped template', async ({
  launchApp, userDataDir,
}) => {
  const { page } = await launchApp();
  const listed = await page.evaluate(() => (window as StenoWindow).stenoai.templates.list());
  expect(listed.success).toBe(true);
  const original = listed.templates.find((t) => t.id === DETAILED_ID)!;
  const override = { name: 'Detailed edited', icon: 'people', prompt: 'Synthetic edited prompt.', language: 'de' };
  const saved = await page.evaluate((template) =>
    (window as StenoWindow).stenoai.templates.save(template), { id: DETAILED_ID, ...override });
  expect(saved.success).toBe(true);
  expect(saved.template).toMatchObject({ id: DETAILED_ID, ...override });
  expect(readUserConfig(userDataDir).template_overrides).toMatchObject({ [DETAILED_ID]: override });
  expect((readUserConfig(userDataDir).custom_templates as Template[])
    .some((t) => t.id === DETAILED_ID)).toBe(false);

  const edited = await page.evaluate(() => (window as StenoWindow).stenoai.templates.list());
  expect(edited.success).toBe(true);
  expect(edited.templates.find((t) => t.id === DETAILED_ID)).toMatchObject({
    ...override, builtin: true, locked: false, format: 'markdown',
  });
  const reset = await page.evaluate((id) => (window as StenoWindow).stenoai.templates.reset(id), DETAILED_ID);
  expect(reset.success).toBe(true);
  expect(readUserConfig(userDataDir).template_overrides).not.toHaveProperty(DETAILED_ID);
  const restored = await page.evaluate(() => (window as StenoWindow).stenoai.templates.list());
  expect(restored.success).toBe(true);
  expect(restored.templates.find((t) => t.id === DETAILED_ID)).toEqual(original);
});

for (const defaultId of [DETAILED_ID, ...CUSTOM_TEMPLATES.map((t) => t.id)]) {
  test(`@contract ${defaultId} default generates a report with its own prompt`, async ({
    launchApp, userDataDir, ollama,
  }) => {
    test.setTimeout(60_000);
    writeUserConfig(userDataDir, {
      ai_provider: 'local', templates_seeded: true, custom_templates: CUSTOM_TEMPLATES,
      default_template_id: defaultId === DETAILED_ID ? 'standard' : defaultId,
    });
    const summaryFile = writeMeetingSummary(userDataDir, 'detailed-contract', {
      name: 'Synthetic Detailed Meeting', summary: 'Original Standard summary', transcript: TRANSCRIPT,
    });
    const originalSummary = readFileSync(summaryFile, 'utf8');
    const sidecarFile = path.join(path.dirname(summaryFile), 'detailed-contract_reports.json');
    const { page } = await launchApp();
    if (defaultId === DETAILED_ID) {
      const selected = await page.evaluate((id) =>
        (window as StenoWindow).stenoai.templates.setDefault(id), defaultId);
      expect(selected.success).toBe(true);
    }
    // Existing custom defaults must survive launch without being re-selected.
    expect(readUserConfig(userDataDir).default_template_id).toBe(defaultId);
    const listed = await page.evaluate(() => (window as StenoWindow).stenoai.templates.list());
    expect(listed.success).toBe(true);
    expect(listed.default_template_id).toBe(defaultId);
    const detailed = listed.templates.find((t) => t.id === DETAILED_ID)!;
    const expected = CUSTOM_TEMPLATES.find((t) => t.id === defaultId) ?? detailed;
    expect(listed.templates.find((t) => t.id === defaultId)).toMatchObject(expected);

    // Use the persisted selection returned through IPC, not a second feature path.
    const result = await page.evaluate(([file, id]) =>
      (window as StenoWindow).stenoai.meetings.generateReport(file, id),
    [summaryFile, listed.default_template_id]);
    expect(result.success, result.error).toBe(true);
    await expect.poll(() => readSidecar(sidecarFile).reports.length).toBe(1);
    const sidecar = readSidecar(sidecarFile);
    expect(sidecar.reports[0]).toMatchObject({
      template_id: defaultId, template_name: expected.name, content: REPORT_REPLY,
    });
    expect(sidecar.active_report).toBe(sidecar.reports[0].id);
    const readBack = await page.evaluate((file) =>
      (window as StenoWindow).stenoai.meetings.get(file), summaryFile);
    expect(readBack.success).toBe(true);
    expect(readBack.meeting.reports).toEqual(sidecar.reports);
    expect(readBack.meeting.active_report).toBe(sidecar.active_report);
    expect(readFileSync(summaryFile, 'utf8')).toBe(originalSummary);
    expect(ollama.lastChatPrompt()).toContain(expected.prompt);
    for (const other of [detailed, ...CUSTOM_TEMPLATES].filter((t) => t.id !== defaultId)) {
      expect(ollama.lastChatPrompt()).not.toContain(other.prompt);
    }
    expect(ollama.lastChatPrompt()).toContain(TRANSCRIPT);
    expect(ollama.chatCalls()).toBe(1);
    expect(ollama.pullCalls()).toBe(0);
    expect(readUserConfig(userDataDir).custom_templates).toEqual(CUSTOM_TEMPLATES);
    expect(readUserConfig(userDataDir).default_template_id).toBe(defaultId);
  });
}

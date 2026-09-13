// Tests for the i18n gate's own configuration (renderer/eslint.config.i18n.mjs).
//
// A lint gate that silently stops matching is worse than no gate: it reports green while
// blind. That is not hypothetical here — the first version of this config passed its
// exclusion patterns as STRINGS, and the plugin compiles those with a bare `new RegExp()`
// with no `u` flag. `\p{L}` degraded to a literal `p`, so `[^\p{L}]+` matched any copy
// without p/{/L/} in it and dropped 258 real user-facing strings from the gate.
//
// So: assert the semantics, not the count. The count lives in i18n-lint-baseline.json.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const eslint = new ESLint({
  cwd: APP_DIR,
  overrideConfigFile: path.join(APP_DIR, 'renderer/eslint.config.i18n.mjs'),
});

// Lint a JSX snippet as if it were a renderer component; return the flagged strings.
async function flagged(jsx) {
  const source = `export function C() {\n  return (\n${jsx}\n  );\n}\n`;
  return flaggedSource(source);
}

async function flaggedSource(source) {
  const [result] = await eslint.lintText(source, {
    filePath: path.join(APP_DIR, 'renderer/src/__fixture__.tsx'),
  });
  const { I18N_GATE_RULE_IDS } = await import('./scripts/i18n-copy-rules.mjs');
  return (result?.messages ?? []).filter((m) => I18N_GATE_RULE_IDS.includes(m.ruleId));
}

async function assertCombinedCopyGate({
  label, beforeSource, afterSource, beforeCopy, afterCopy, expectedLint = 0,
}) {
  // The inventory changes make `npm run i18n:inventory` fail until reviewed, including
  // paths intentionally outside the syntax-only lint rule.
  assert.equal((await flaggedSource(beforeSource)).length, expectedLint, `${label} lint ownership changed`);
  assert.equal(
    (await flaggedSource(afterSource)).length,
    expectedLint,
    `${label} lint ownership changed on the after side`
  );

  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'Fixture.tsx');
    fs.writeFileSync(file, beforeSource);
    const before = collectFromSource(file);
    fs.writeFileSync(file, afterSource);
    const after = collectFromSource(file);
    assert.ok(before.copy.includes(beforeCopy), `${label} must enter the inventory before the change`);
    assert.ok(after.copy.includes(afterCopy), `${label} must enter the inventory after the change`);
    assert.notDeepEqual(before.copy, after.copy, `${label} wording must change the combined gate`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('flags ordinary user-facing JSX text', async () => {
  // "All notes" is the exact regression case: no p, {, L or } in it, so the broken
  // string-pattern version of the config skipped it.
  for (const copy of ['All notes', 'Transcript', 'Import audio file', 'Try again']) {
    const messages = await flagged(`    <span>${copy}</span>`);
    assert.equal(messages.length, 1, `expected "${copy}" to be flagged`);
  }
});

test('ignores symbol-, punctuation- and number-only text', async () => {
  for (const glyph of ['—', '·', '×', '1', '2026', '/', '…', '·  ·']) {
    const messages = await flagged(`    <span>${glyph}</span>`);
    assert.equal(messages.length, 0, `expected "${glyph}" to be ignored`);
  }
});

test('ignores product and vendor names', async () => {
  for (const name of ['Steno', 'Ollama', 'Whisper', 'Parakeet', 'Obsidian']) {
    const messages = await flagged(`    <span>${name}</span>`);
    assert.equal(messages.length, 0, `expected "${name}" to be ignored`);
  }
});

test('ignores structural attributes but flags copy-bearing ones', async () => {
  const structural = await flagged(
    `    <input className="mv-input" data-testid="search" type="text" />`
  );
  assert.equal(structural.length, 0, 'structural attributes must not be flagged');

  for (const attr of ['placeholder', 'title', 'alt', 'aria-label']) {
    const messages = await flagged(`    <input ${attr}="Search notes" />`);
    assert.equal(messages.length, 1, `expected ${attr} to be flagged`);
  }
});

test('exclusion patterns are RegExp objects, not strings', async () => {
  // The structural guard behind the failure described at the top of this file.
  const { default: config } = await import('./renderer/eslint.config.i18n.mjs');
  const rule = config.flatMap((b) => Object.entries(b.rules ?? {}))
    .find(([id]) => id === 'i18next/no-literal-string');
  assert.ok(rule, 'the gate must configure i18next/no-literal-string');
  for (const pattern of rule[1][1].words.exclude) {
    assert.ok(
      pattern instanceof RegExp,
      `word exclusions must be RegExp objects — a string is compiled without the u flag ` +
        `and \\p{L} silently degrades to a literal p (got ${JSON.stringify(pattern)})`
    );
  }
});

// --- the inventory's own rules -------------------------------------------------------
// Both cases below are regressions that actually happened while building this gate, and
// both were silent: the tooling reported success while quietly covering less than it
// claimed. That is the failure mode a gate must not have.

import { globToRegExp, definitelyNotCopy, readsAsCopy } from './scripts/i18n-copy-rules.mjs';

test('globToRegExp expands a double-star segment across path depth', async () => {
  const rx = globToRegExp('**/*.test.ts');
  // The bug: chained replaces rewrote the star inside the expansion, narrowing it to a
  // single path segment — so nothing below renderer/src matched and every test file's
  // strings leaked into the inventory.
  assert.ok(rx.test('renderer/src/lib/hero.test.ts'), 'must match at any depth');
  assert.ok(rx.test('hero.test.ts'), 'must match with no directory at all');
  assert.ok(!rx.test('renderer/src/lib/hero.ts'), 'must not match a non-test file');

  const sandbox = globToRegExp('**/routes/Sandbox.tsx');
  assert.ok(sandbox.test('renderer/src/routes/Sandbox.tsx'));
  assert.ok(!sandbox.test('renderer/src/routes/Home.tsx'));
});

test('the inventory keeps prose and rejects only provable markup', async () => {
  // Burden of proof is inverted here: a string is copy unless provably not. The previous
  // accept-list dropped all of these, each discovered in a separate review round.
  for (const copy of [
    'Nothing to process',
    'Ready to capture beautiful notes',
    'Ask AI',
    'AI provider',
    'AI',
    'note',
    'notes',
    'Re-run first-time setup',
    'permission denied',
    'Processing',
  ]) {
    assert.ok(!definitelyNotCopy(copy), `expected copy: ${JSON.stringify(copy)}`);
  }

  for (const markup of [
    'flex flex-col items-center gap-3 rounded-xl',
    'text-[11.5px]',
    'hover:bg-red-500',
    'var(--fg-1)',
    '0 14px',
    '#FAF9F5',
    'M514.833,1703.333h1228.316c18.901,0.096,37.335-5.874',
    'camelCaseThing',
    'SCREAMING_CONST',
    'https://example.com/x',
    './relative/path',
    '--fg-1',
  ]) {
    assert.ok(definitelyNotCopy(markup), `expected NOT copy: ${JSON.stringify(markup)}`);
  }
});

test('lowercase copy containing a number is kept', async () => {
  // The digit branch was the same hole one level over: any lowercase string with a
  // number in it counted as markup, so "last 7 days" was dropped like "mt-2 flex-1".
  // Numbers are more common in copy than hyphens, which made this the wider gap.
  for (const copy of [
    'last 7 days',
    '2 speakers detected',
    'top 3 results',
    'up to 10 notes',
    'step 2 of 3',
    '1 of 5',
    // Reported by cubic after the first pass: every token carries a digit, so the
    // marker test alone was satisfied and the string fell out. None of them is a
    // utility class, which is what now tells the two apart.
    'v2 beta3',
    'v2 active',
    '1080p 60fps',
  ]) {
    assert.ok(!definitelyNotCopy(copy), `expected copy: ${JSON.stringify(copy)}`);
  }

  for (const markup of [
    'mt-2 flex-1',
    'text-[11.5px]',
    'h-8 w-28 text-sm',
    'absolute inset-0 bg-ink-900/40 backdrop-blur-sm',
    'px-2 py-1.5 text-sm',
    'gap-1.5 rounded-full',
    '2xl:grid grid-cols-2',
  ]) {
    assert.ok(definitelyNotCopy(markup), `expected NOT copy: ${JSON.stringify(markup)}`);
  }
});

test('bare numeric status copy stays in the combined gate', async () => {
  for (const copy of ['2 active', '3 active']) {
    assert.ok(!definitelyNotCopy(copy), `expected copy: ${JSON.stringify(copy)}`);
    assert.ok(readsAsCopy(copy), `expected copy contract: ${JSON.stringify(copy)}`);
  }

  await assertCombinedCopyGate({
    label: 'rendered numeric status identifier',
    beforeCopy: '2 active',
    afterCopy: '3 active',
    beforeSource: `export function C() { const status = '2 active'; return <span>{status}</span>; }`,
    afterSource: `export function C() { const status = '3 active'; return <span>{status}</span>; }`,
  });

  await assertCombinedCopyGate({
    label: 'direct numeric ReactNode action',
    expectedLint: 1,
    beforeCopy: '2 active',
    afterCopy: '3 active',
    beforeSource: `export function C() { return <SectionHead action="2 active" />; }`,
    afterSource: `export function C() { return <SectionHead action="3 active" />; }`,
  });
});

test('lowercase copy with a hyphenated word is kept; class lists are still rejected', async () => {
  // A hyphen alone was treated as proof of markup as soon as a second token followed, so
  // every lowercase multi-word phrase containing one fell out of the inventory -- exactly
  // the "e-mail"/"opt-in"/"sign-in" family the rule above claims to protect. No such copy
  // exists in the renderer today, which is why nothing went red: the hole is a trap for
  // the copy that gets written next, not a loss that already happened.
  for (const copy of [
    'sign-in required',
    'opt-in only',
    'built-in template',
    'read-only mode',
    'follow-up notes',
    'drag-and-drop a file',
    'e-mail address',
    'per-channel labels',
    // Both tokens are bare utilities that are also English words -- only the missing
    // hyphen keeps this out of the class-list branch.
    'open group',
  ]) {
    assert.ok(!definitelyNotCopy(copy), `expected copy: ${JSON.stringify(copy)}`);
  }

  // Every one of these is a real class list from the renderer, and each is rejected by
  // the utility vocabulary rather than by the bare presence of a hyphen.
  for (const markup of [
    'flex items-center',
    'flex flex-col',
    'text-sm font-medium',
    'bg-muted text-foreground',
    'inline-flex items-stretch overflow-hidden rounded-full',
    'border border-border bg-card shadow-sm',
    'min-h-screen bg-background text-foreground',
    'h-full max-w-full flex flex-col',
    'font-mono text-sm tabular-nums',
    'mv-transcript-wave mv-transcript-wave-static',
    'mv-title group',
    'mv-transcript open',
  ]) {
    assert.ok(definitelyNotCopy(markup), `expected NOT copy: ${JSON.stringify(markup)}`);
  }
});

test('copy that opens with a label is kept; colon-shaped identifiers are still rejected', async () => {
  // The protocol rule was case-insensitive and unbounded, so it matched a colon anywhere
  // after a leading word -- which is the shape of an ordinary labelled sentence. Every
  // "Error: ..." the app might ever show was dropped before reaching the inventory.
  // Reported by Codex on the second cross-family pass; the renderer has no such copy
  // today, so nothing went red, and that is exactly what makes it worth a test.
  for (const copy of [
    'Error: Try again',
    'Warning: Unsaved changes',
    'Note: Changes are saved automatically',
    'Duration: 3 min',
    'Speaker: You',
    // Bare labels are copy too. Casing cannot prove that a colon-shaped literal is
    // technical, so lowercase labels must stay in the inventory as well.
    'Duration:',
    'URL:',
    'status:',
    'note:',
  ]) {
    assert.ok(!definitelyNotCopy(copy), `expected copy: ${JSON.stringify(copy)}`);
  }

  for (const technical of [
    'var:',
    'data:',
    'https:',
    'sm:hidden',
    'hover:bg-muted',
    'focus-visible:ring-2',
    // Screaming markers carry no whitespace either, which is what keeps them out.
    'PROGRESS:transcribe:',
    'PROGRESS:diarize:',
    'PROGRESS:summarize:',
  ]) {
    assert.ok(definitelyNotCopy(technical), `expected NOT copy: ${JSON.stringify(technical)}`);
  }
});

// --- fixes from the Codex review ------------------------------------------------------

import { decodeEntities, toPosixPath, COPY_ATTRIBUTES } from './scripts/i18n-copy-rules.mjs';

test('records what the user sees, not the JSX source entity', async () => {
  // The inventory stored `Summarisation &amp; Chat` while React renders `Summarisation &
  // Chat`. Untouched copy would then read as changed in a migration diff — the exact
  // comparison the inventory exists to make.
  assert.equal(decodeEntities('Summarisation &amp; Chat'), 'Summarisation & Chat');
  assert.equal(decodeEntities('Settings &gt; People'), 'Settings > People');
  assert.equal(decodeEntities('it&apos;s'), "it's");
  assert.equal(decodeEntities('&#39;x&#39;'), "'x'");
  assert.equal(decodeEntities('&#x2014;'), '—');
  // An entity nobody declared stays put rather than turning into something wrong.
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('translation lookups preserve English inventory copy across migration', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const catalogue = {
    'fixture.confirmTitle': 'Send audio to a cloud service?',
    'fixture.modelPlaceholder': 'whisper-1',
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-translation-'));
  try {
    const file = path.join(dir, 'Fixture.tsx');
    fs.writeFileSync(
      file,
      `export function C() { return <p>Send audio to a cloud service?</p>; }`,
    );
    const before = collectFromSource(file);

    fs.writeFileSync(
      file,
      `import { t as translate } from '@/i18n';\n` +
        `export function C() { return <p>{translate('fixture.confirmTitle')}</p>; }`,
    );
    const after = collectFromSource(file, catalogue);

    assert.deepEqual(after, before, 'moving copy behind t() must not rewrite the inventory');

    fs.writeFileSync(file, `const model = 'whisper-1';`);
    const uncertainBefore = collectFromSource(file);
    fs.writeFileSync(
      file,
      `import { t } from '@/i18n';\nconst model = t('fixture.modelPlaceholder');`,
    );
    const uncertainAfter = collectFromSource(file, catalogue);
    assert.deepEqual(
      uncertainAfter,
      uncertainBefore,
      'moving ambiguous copy behind t() must preserve the uncertain partition',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translation inventory recognises explicit index, namespace, and re-export imports', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const catalogue = {
    'fixture.malformed': '{{count items}} and {{1}} stay visible',
    'fixture.title': 'Translated title',
  };
  const sources = [
    `import { t } from '@/i18n/index';\nconst value = t('fixture.title');`,
    `import * as i18n from '../i18n/index.ts';\nconst value = i18n.t('fixture.title');`,
    `import { t as translate } from '@/lib/translation-reexport';\nconst value = translate('fixture.title');`,
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-translation-'));
  try {
    const file = path.join(dir, 'Fixture.tsx');
    for (const source of sources) {
      fs.writeFileSync(file, source);
      assert.deepEqual(collectFromSource(file, catalogue), {
        copy: ['Translated title'],
        uncertain: [],
      });
    }

    fs.writeFileSync(
      file,
      `import { t } from '@/i18n';\nconst value = t('fixture.malformed');`,
    );
    assert.deepEqual(collectFromSource(file, catalogue), {
      copy: ['{{count items}} and {{1}} stay visible'],
      uncertain: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translation inventory fails closed for missing or dynamic keys', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const catalogue = { 'fixture.title': 'Translated title' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-translation-'));
  try {
    const file = path.join(dir, 'Fixture.tsx');
    fs.writeFileSync(
      file,
      `import { t } from '@/i18n';\nexport function C() { return <p>{t('missing.key')}</p>; }`,
    );
    assert.throws(
      () => collectFromSource(file, catalogue),
      /missing English translation for "missing\.key"/,
    );

    fs.writeFileSync(
      file,
      `import { t } from '@/i18n';\nexport function C({ keyName }) { return <p>{t(keyName)}</p>; }`,
    );
    assert.throws(
      () => collectFromSource(file, catalogue),
      /translation keys must be static string literals/,
    );

    for (const source of [
      `import * as translations from '@/lib/translation-reexport';\n` +
        `export function C() { return <p>{translations.t('fixture.title')}</p>; }`,
      `import translations from '@/lib/translation-reexport';\n` +
        `export function C() { return <p>{translations.t('fixture.title')}</p>; }`,
      `export function C(props) { return <p>{props.t('fixture.title')}</p>; }`,
    ]) {
      fs.writeFileSync(file, source);
      assert.throws(
        () => collectFromSource(file, catalogue),
        /\.t\(\) cannot be verified as a translation lookup/,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('baseline and glob keys are POSIX on every platform', async () => {
  // On Windows path.relative() returns backslashes: the slash-based ignore globs stop
  // matching and every baseline key differs from the committed one, so both gates fail on
  // an untouched checkout.
  assert.equal(toPosixPath('renderer\\src\\routes\\Home.tsx', '\\'), 'renderer/src/routes/Home.tsx');
  assert.equal(toPosixPath('renderer/src/routes/Home.tsx', '/'), 'renderer/src/routes/Home.tsx');

  const rx = globToRegExp('**/*.test.ts');
  assert.ok(rx.test(toPosixPath('renderer\\src\\lib\\hero.test.ts', '\\')));
});

test('copy-bearing component props are gated, not just DOM attributes', async () => {
  // ~170 sites in the renderer use label=/description=/hint=/confirmLabel=. Leaving them
  // out let new hardcoded copy in through the front door with the gate reporting green.
  for (const attr of ['label', 'description', 'hint', 'confirmLabel']) {
    const messages = await flagged(`    <SettingRow ${attr}="Shown to users" />`);
    assert.equal(messages.length, 1, `expected ${attr} to be flagged`);
  }
  assert.ok(COPY_ATTRIBUTES.includes('label'));

  // Still no false positive on the structural props sitting right next to them.
  const structural = await flagged(`    <SettingRow id="general" variant="compact" />`);
  assert.equal(structural.length, 0);
});

test('interpolated copy is blocked by the real JSX linter', async () => {
  for (const jsx of [
    '    <span>{`At least ${count} people spoke`}</span>',
    '    <button aria-label={`Delete ${name}`} />',
    '    <SettingRow description={`Connected to ${provider}`} />',
    '    <Card action={`Retry export for ${name}`} />',
    '    <Card action="Retry export" />',
  ]) {
    const messages = await flagged(jsx);
    assert.equal(messages.length, 1, `expected interpolated copy to be flagged: ${jsx}`);
    assert.equal(messages[0].ruleId, 'steno-i18n/no-interpolated-literal');
  }

  const structural = await flagged('    <span className={`size-${size} flex`} />');
  assert.equal(structural.length, 0, 'an interpolated structural attribute must stay out');
});

test('purely dynamic JSX templates are not treated as hardcoded copy', async () => {
  for (const jsx of [
    '    <span>{`${done} / ${total}`}</span>',
    '    <SectionHead action={`${user.first} ${user.last}`} />',
    '    <SectionHead action={`${first}, ${last}`} />',
    '    <span>{`${dynamicTitle}`}</span>',
    '    <SettingRow description={`${completed} / ${available}`} />',
  ]) {
    const messages = await flagged(jsx);
    assert.equal(messages.length, 0, `expected a dynamic-only template to pass: ${jsx}`);
  }

  // Mutation guard: adding even one authored word must make the same shape fail again.
  const messages = await flagged('    <span>{`${done} of ${total} complete`}</span>');
  assert.equal(messages.length, 1, 'authored template copy must still be blocked');
  assert.equal(messages[0].ruleId, 'steno-i18n/no-interpolated-literal');
});

test('template linting follows only direct transparent JSX wrappers', async () => {
  for (const [jsx, expected] of [
    ['    <span>{ready && `Visible row ${item.id}`}</span>', 1],
    ['    <span>{ready ? `Visible row ${item.id}` : `Hidden row ${item.id}`}</span>', 2],
    ['    <span>{fallback ?? `Visible row ${item.id}`}</span>', 1],
    ['    <span>{(`Visible row ${item.id}` as string)}</span>', 1],
  ]) {
    const messages = await flaggedSource(`export function C({ ready, fallback, item }) { return (${jsx}); }`);
    assert.equal(messages.length, expected, `transparent JSX wrapper must stay blocked: ${jsx}`);
  }

  for (const source of [
    `export function C({ item }) { return <span>{format(\`Visible row \${item.id}\`)}</span>; }`,
    `export function C({ context }) { return <ContextMenu action={context} />; }`,
    `export function C({ item }) { return <ContextMenu action={\`row-\${item.id}\`} />; }`,
    `export function C({ item }) { return <span className={\`row-\${item.id}\`} />; }`,
    `export function C({ done, total }) { return <span>{\`\${done} / \${total}\`}</span>; }`,
    `export function C({ items }) { return <div>{items.map((item) => { const rowClass = \`row-\${item.id}\`; return <span className={rowClass}>{item.name}</span>; })}</div>; }`,
    `export function C({ items }) { return <div>{items.filter((item) => item.key === \`Visible row \${item.id}\`).map((item) => item.name)}</div>; }`,
    `export function C({ items }) { return <div>{items.some((item) => item.key === \`Visible row \${item.id}\`) ? items[0]?.name : null}</div>; }`,
    `export function C({ items }) { return <div>{items.find((item) => item.key === \`Visible row \${item.id}\`)?.name}</div>; }`,
  ]) {
    assert.equal(
      (await flaggedSource(source)).length,
      0,
      'calls, callbacks, predicates, ReactNode props, and technical/dynamic templates pass'
    );
  }
});

test('the combined gate covers direct wrappers, callbacks, and ReactNode template copy', async () => {
  const cases = [
    {
      label: 'logical JSX wrapper', expectedLint: 1,
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ ready, item }) { return <div>{ready && \`Visible row \${item.id}\`}</div>; }`,
      afterSource: `export function C({ ready, item }) { return <div>{ready && \`Updated row \${item.id}\`}</div>; }`,
    },
    {
      label: 'ternary JSX wrapper', expectedLint: 2,
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ ready, item }) { return <div>{ready ? \`Visible row \${item.id}\` : \`Hidden row \${item.id}\`}</div>; }`,
      afterSource: `export function C({ ready, item }) { return <div>{ready ? \`Updated row \${item.id}\` : \`Hidden row \${item.id}\`}</div>; }`,
    },
    {
      label: 'nullish JSX wrapper', expectedLint: 1,
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ fallback, item }) { return <div>{fallback ?? \`Visible row \${item.id}\`}</div>; }`,
      afterSource: `export function C({ fallback, item }) { return <div>{fallback ?? \`Updated row \${item.id}\`}</div>; }`,
    },
    {
      label: 'type assertion JSX wrapper', expectedLint: 1,
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ item }) { return <div>{(\`Visible row \${item.id}\` as string)}</div>; }`,
      afterSource: `export function C({ item }) { return <div>{(\`Updated row \${item.id}\` as string)}</div>; }`,
    },
    {
      label: 'optional map callback',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items?.map((item) => \`Visible row \${item.id}\`)}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items?.map((item) => \`Updated row \${item.id}\`)}</div>; }`,
    },
    {
      label: 'nested map callback',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ groups }) { return <div>{groups.map((group) => group.items.map((item) => \`Visible row \${item.id}\`))}</div>; }`,
      afterSource: `export function C({ groups }) { return <div>{groups.map((group) => group.items.map((item) => \`Updated row \${item.id}\`))}</div>; }`,
    },
    {
      label: 'filter then map callback',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items.filter(Boolean).map((item) => \`Visible row \${item.id}\`)}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items.filter(Boolean).map((item) => \`Updated row \${item.id}\`)}</div>; }`,
    },
    {
      label: 'map then filter callback',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items.map((item) => \`Visible row \${item.id}\`).filter(Boolean)}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items.map((item) => \`Updated row \${item.id}\`).filter(Boolean)}</div>; }`,
    },
    {
      label: 'joined map callback',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items.map((item) => \`Visible row \${item.id}\`).join(', ')}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items.map((item) => \`Updated row \${item.id}\`).join(', ')}</div>; }`,
    },
    {
      label: 'ReactNode action helper',
      beforeCopy: 'Retry export for {{…}}', afterCopy: 'Retry save for {{…}}',
      beforeSource: `export function C({ name }) { return <Card action={renderAction(\`Retry export for \${name}\`)} />; }`,
      afterSource: `export function C({ name }) { return <Card action={renderAction(\`Retry save for \${name}\`)} />; }`,
    },
    {
      label: 'property-access callback',
      beforeCopy: 'PDF export ready for {{…}}', afterCopy: 'PDF save ready for {{…}}',
      beforeSource: `export function C({ name }) { return <div>{notesPdf.render().then(() => \`PDF export ready for \${name}\`)}</div>; }`,
      afterSource: `export function C({ name }) { return <div>{notesPdf.render().then(() => \`PDF save ready for \${name}\`)}</div>; }`,
    },
    {
      label: 'block callback return',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items.map((item) => { return \`Visible row \${item.id}\`; })}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items.map((item) => { return \`Updated row \${item.id}\`; })}</div>; }`,
    },
    {
      label: 'if callback return',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items.map((item) => { if (item.visible) return \`Visible row \${item.id}\`; return \`Hidden row \${item.id}\`; })}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items.map((item) => { if (item.visible) return \`Updated row \${item.id}\`; return \`Hidden row \${item.id}\`; })}</div>; }`,
    },
    {
      label: 'switch callback return',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items.map((item) => { switch (item.kind) { case 'visible': return \`Visible row \${item.id}\`; default: return \`Hidden row \${item.id}\`; } })}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items.map((item) => { switch (item.kind) { case 'visible': return \`Updated row \${item.id}\`; default: return \`Hidden row \${item.id}\`; } })}</div>; }`,
    },
    {
      label: 'try callback return',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items.map((item) => { try { return \`Visible row \${item.id}\`; } catch { return \`Hidden row \${item.id}\`; } })}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items.map((item) => { try { return \`Updated row \${item.id}\`; } catch { return \`Hidden row \${item.id}\`; } })}</div>; }`,
    },
    {
      label: 'nested block callback return',
      beforeCopy: 'Visible row {{…}}', afterCopy: 'Updated row {{…}}',
      beforeSource: `export function C({ items }) { return <div>{items.map((item) => { { return \`Visible row \${item.id}\`; } })}</div>; }`,
      afterSource: `export function C({ items }) { return <div>{items.map((item) => { { return \`Updated row \${item.id}\`; } })}</div>; }`,
    },
  ];
  for (const entry of cases) await assertCombinedCopyGate(entry);
});

test('the copy partition holds the contract, uncertain holds the safety net', async () => {
  // `copy` is what a migration diff must hold string-for-string; `uncertain` is recall
  // insurance, so a styling PR that only moves uncertain lines is a five-second read.
  for (const certain of ['Ask AI', 'Nothing to process', 'Delete', 'AI']) {
    assert.ok(readsAsCopy(certain), `expected copy partition: ${JSON.stringify(certain)}`);
  }
  for (const hedged of ['keydown', 'dragover', 'gallery']) {
    assert.ok(!readsAsCopy(hedged), `expected uncertain partition: ${JSON.stringify(hedged)}`);
  }
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB', 'KiB', 'MiB', 'GiB', 'TiB']) {
    assert.ok(!definitelyNotCopy(unit), `storage unit must remain inventoried: ${unit}`);
    assert.ok(!readsAsCopy(unit), `storage unit must stay in the uncertain partition: ${unit}`);
  }
});

// --- fixes from the cubic review on PR #497 -------------------------------------------

test('a duplicate swap changes the inventory (multiset, not Set)', async () => {
  // The real failure: a file holds the same string twice and one occurrence is changed to
  // another string ALREADY present in that file. Set-backed collection produced identical
  // output before and after, so the guard missed exactly the rewording it exists to catch.
  // Drive the real extractor over a fixture rather than asserting on the generated file.
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const write = (body) => {
      const file = path.join(dir, 'Fixture.tsx');
      fs.writeFileSync(file, body);
      return collectFromSource(file);
    };

    const before = write(
      `export function C() {
         return (<div><span>All notes</span><span>All notes</span><span>Shared notes</span></div>);
       }`
    );
    const after = write(
      `export function C() {
         return (<div><span>All notes</span><span>Shared notes</span><span>Shared notes</span></div>);
       }`
    );

    assert.deepEqual(before.copy, ['All notes', 'All notes', 'Shared notes']);
    assert.deepEqual(after.copy, ['All notes', 'Shared notes', 'Shared notes']);
    assert.notDeepEqual(before.copy, after.copy, 'a duplicate swap must change the inventory');
    // The set of distinct strings is identical — this is what a Set-backed version saw.
    assert.deepEqual([...new Set(before.copy)].sort(), [...new Set(after.copy)].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a switch body is inventoried, only the case label is skipped', async () => {
  // Skipping the whole CaseClause dropped every string inside a switch along with the label.
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'Switch.tsx');
    fs.writeFileSync(
      file,
      `export function C({ state }) {
         switch (state) {
            case 'saved':
              return <p>All changes saved</p>;
            case \`pending-\${state}\`:
              return <p>Changes pending</p>;
            default:
              return null;
         }
       }`
    );
    const { copy, uncertain } = collectFromSource(file);
    assert.ok(copy.includes('All changes saved'), 'copy inside a case body must be recorded');
    assert.ok(copy.includes('Changes pending'), 'copy inside a template case body must be recorded');
    assert.ok(![...copy, ...uncertain].includes('saved'), 'the case label itself is structure');
    assert.ok(![...copy, ...uncertain].includes('pending-{{…}}'), 'a template case label is structure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transparent wrappers keep template case labels structural', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'WrappedSwitch.tsx');
    const source = `export function C({ state }) {
       switch (state) {
          case (\`parenthesized-\${state}\`):
            return <p>Parenthesized case pending</p>;
          case (\`asserted-\${state}\` as string):
            return <p>Asserted case pending</p>;
          case (\`satisfied-\${state}\` satisfies string):
            return <p>Satisfied case pending</p>;
          case (\`nonnull-\${state}\`!):
            return <p>Non-null case pending</p>;
          default:
            return null;
       }
     }`;
    fs.writeFileSync(file, source);
    const { copy, uncertain } = collectFromSource(file);
    for (const body of [
      'Parenthesized case pending',
      'Asserted case pending',
      'Satisfied case pending',
      'Non-null case pending',
    ]) {
      assert.ok(
        copy.includes(body),
        `copy inside a wrapped template case body must be recorded: ${body}`
      );
    }
    for (const label of [
      'parenthesized-{{…}}',
      'asserted-{{…}}',
      'satisfied-{{…}}',
      'nonnull-{{…}}',
    ]) {
      assert.ok(
        ![...copy, ...uncertain].includes(label),
        `a wrapped case label is structure: ${label}`
      );
    }
    assert.equal(
      (await flaggedSource(source)).length,
      4,
      'rendered copy in every wrapped case body must remain linted'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real extractor records interpolated copy with stable placeholders', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'Template.tsx');
    fs.writeFileSync(
      file,
      `export function C({ count, capacity, name }) {
         return <div title={\`Delete \${name}\`}>
           {\`At least \${count} people spoke, but only \${capacity} were distinct.\`}
         </div>;
       }`
    );
    const { copy } = collectFromSource(file);
    assert.ok(copy.includes('Delete {{…}}'));
    assert.ok(copy.includes('At least {{…}} people spoke, but only {{…}} were distinct.'));

    fs.writeFileSync(
      file,
      `export function C({ renamedCount, renamedCapacity, renamedName }) {
         return <div title={\`Delete \${renamedName}\`}>
           {\`At least \${renamedCount} people spoke, but only \${renamedCapacity} were distinct.\`}
         </div>;
       }`
    );
    assert.deepEqual(collectFromSource(file).copy, copy, 'expression renames are not copy changes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the extractor follows visible callback branches of structural JSX props', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'Callbacks.tsx');
    const write = (visibleCopy) => {
      fs.writeFileSync(
        file,
        `export function C({ name }) {
           return <ConfirmDialog
             variant="Internal structural token"
             data-testid="confirm-dialog"
             lookup={labels[\`technical-\${name}\`]}
             onConfirm={() => Promise.resolve().then(() => <span>${visibleCopy}</span>)}
           />;
         }`
      );
      return collectFromSource(file);
    };

    const before = write('Save changes');
    assert.ok(before.copy.includes('Save changes'), 'JSX rendered by an onConfirm callback must be recorded');
    assert.ok(![...before.copy, ...before.uncertain].includes('Internal structural token'));
    assert.ok(![...before.copy, ...before.uncertain].includes('confirm-dialog'));
    assert.ok(![...before.copy, ...before.uncertain].includes('technical-{{…}}'));

    const after = write('Discard changes');
    assert.ok(after.copy.includes('Discard changes'));
    assert.notDeepEqual(before, after, 'changing callback copy must change the inventory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the extractor records direct strings and helper arguments for ReactNode props', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'ReactNode.tsx');
    const write = (primaryAction) => {
      fs.writeFileSync(
        file,
        `export function C({ ready }) {
           return <>
             <Card variant="Internal structural token" action={ready ? '${primaryAction}' : 'Discard changes'} />
             <Card action={renderAction('Retry export')} />
           </>;
         }`
      );
      return collectFromSource(file);
    };

    const before = write('Save changes');
    for (const text of ['Save changes', 'Discard changes', 'Retry export']) {
      assert.ok(before.copy.includes(text), `missing rendered ReactNode copy: ${text}`);
    }
    assert.ok(![...before.copy, ...before.uncertain].includes('Internal structural token'));

    const after = write('Save draft');
    assert.ok(after.copy.includes('Save draft'));
    assert.notDeepEqual(before, after, 'changing a direct ReactNode value must change the inventory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copy attributes delegate nested JSX structure to the normal traversal', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'CopyAttribute.tsx');
    fs.writeFileSync(
      file,
      `export function C() {
         return <Card description={<span className="mt-2 flex">Hello there</span>} />;
       }`
    );
    const { copy, uncertain } = collectFromSource(file);
    assert.ok(copy.includes('Hello there'), 'nested JSX text is rendered copy');
    assert.ok(![...copy, ...uncertain].includes('mt-2 flex'), 'nested className stays structural');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('direct conditional literals under a JSX fragment are certain copy', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'Fragment.tsx');
    fs.writeFileSync(
      file,
      `export function C({ count }) { return <>{count === 1 ? 'note' : 'notes'}</>; }`
    );
    const { copy, uncertain } = collectFromSource(file);
    assert.ok(copy.includes('note'));
    assert.ok(copy.includes('notes'));
    assert.ok(!uncertain.includes('note'));
    assert.ok(!uncertain.includes('notes'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rendered traversal excludes equality operands but keeps conditional branches', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'Equality.tsx');
    fs.writeFileSync(
      file,
      `export function C({ tab }) { return <>{tab === 'saved' ? 'All saved' : 'Pending'}</>; }`
    );
    const { copy, uncertain } = collectFromSource(file);
    assert.ok(copy.includes('All saved'));
    assert.ok(copy.includes('Pending'));
    assert.ok(![...copy, ...uncertain].includes('saved'), 'equality operand is structural');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ReactNode action precision distinguishes data tokens from visible copy', async () => {
  const source = `export function C({ name }) {
    return <>
      <Card action="confirm" />
      <Card action="Retry export" />
      <Card action={\`Retry export for \${name}\`} />
      <Card action={\`confirm \${name}\`} />
    </>;
  }`;
  const messages = await flaggedSource(source);
  assert.equal(messages.length, 3, 'only the three visibly worded actions are blocking copy');
  assert.ok(messages.every((message) => message.ruleId === 'steno-i18n/no-interpolated-literal'));

  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'Action.tsx');
    fs.writeFileSync(file, source);
    const { copy, uncertain } = collectFromSource(file);
    assert.ok(uncertain.includes('confirm'), 'ambiguous lowercase action remains inventoried');
    assert.ok(!copy.includes('confirm'), 'data-shaped action is not part of the copy contract');
    assert.ok(copy.includes('Retry export'));
    assert.ok(copy.includes('Retry export for {{…}}'));
    assert.ok(copy.includes('confirm {{…}}'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real utility lists never become contractual copy while ordinary phrases do', async () => {
  const utilities = [
    'bg-secondary text-secondary-foreground hover:bg-paper-2 dark:hover:bg-[hsl(54,7%,18%)]',
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors duration-fast ease-steno focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&_svg]:size-4',
    'border-transparent bg-muted text-muted-foreground hover:bg-paper-2 dark:hover:bg-[hsl(54,7%,18%)]',
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors duration-fast ease-steno focus:outline-none [&_svg]:size-3 [&_svg]:shrink-0',
    'border-transparent bg-paper-1 dark:bg-[hsl(54,7%,14%)]',
    'mt-1 block',
    'mt-1 block',
    'mt-2 block',
    'h-[30px] bg-[color:var(--surface-raised)] text-[13px]',
    'h-[30px] min-w-[150px] rounded-[6px] bg-[color:var(--surface-raised)] px-2.5 py-0 text-[13px]',
    '2xl:grid 2xl:gap-4',
  ];
  const { definitelyNotCopy, readsAsCopy } = await import('./scripts/i18n-copy-rules.mjs');
  for (const utility of utilities) {
    assert.equal(readsAsCopy(utility), false, `utility must not read as copy: ${utility}`);
  }
  assert.equal(readsAsCopy('sign-in required'), true, 'ordinary hyphenated copy keeps its contract');

  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'Utilities.tsx');
    fs.writeFileSync(
      file,
      `export const values = ${JSON.stringify([...utilities, 'sign-in required'])};`
    );
    const { copy, uncertain } = collectFromSource(file);
    for (const utility of new Set(utilities)) {
      assert.ok(!copy.includes(utility), `utility must not be contractual copy: ${utility}`);
      const expectedOccurrences = definitelyNotCopy(utility)
        ? 0
        : utilities.filter((entry) => entry === utility).length;
      assert.equal(uncertain.filter((entry) => entry === utility).length, expectedOccurrences);
    }
    assert.ok(copy.includes('sign-in required'), 'ordinary hyphenated copy keeps its contract');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('property access does not hide callback templates from the extractor', async () => {
  const { collectFromSource } = await import('./scripts/i18n-copy-inventory.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-'));
  try {
    const file = path.join(dir, 'NotesPdf.tsx');
    fs.writeFileSync(
      file,
      `export function C({ name }) {
         return <div>{notesPdf.render().then(() => \`PDF export ready for \${name}\`)}</div>;
       }`
    );
    const { copy } = collectFromSource(file);
    assert.ok(copy.includes('PDF export ready for {{…}}'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approximate sizes are copy while real path prefixes remain technical', () => {
  for (const copy of ['~572 MB', '~670 MB']) {
    assert.ok(!definitelyNotCopy(copy), `expected copy: ${JSON.stringify(copy)}`);
  }
  for (const pathLike of [
    '~/Library/Application Support',
    './relative/path',
    '../parent/path',
    '/absolute/path',
    'C:\\Users\\alice',
    '\\\\server\\share',
  ]) {
    assert.ok(definitelyNotCopy(pathLike), `expected path: ${JSON.stringify(pathLike)}`);
  }
});

test('generated output is ordered independently of host locale', async () => {
  // localeCompare collates per locale, so a contributor and CI on different locales would
  // each see the other's generated file as stale. Both generators use a plain sort now.
  for (const script of ['scripts/i18n-copy-inventory.mjs', 'scripts/i18n-lint-gate.mjs']) {
    const source = fs.readFileSync(new URL(`./${script}`, import.meta.url), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, ''); // ignore the comments explaining this
    assert.ok(!code.includes('localeCompare'), `${script} must not sort with localeCompare`);
  }
});

test('no copy-sounding JSX prop escapes classification (allowlist tripwire)', async () => {
  // COPY_ATTRIBUTES is an allowlist, and an allowlist's incompleteness is invisible — that
  // is how label=/description= stayed outside the gate while it reported green. So make
  // the gap mechanically detectable: every copy-sounding prop the renderer actually uses
  // must be deliberately classified as copy or as data.
  const { KNOWN_NON_COPY_ATTRIBUTES, COPY_SOUNDING_PROP } = await import(
    './scripts/i18n-copy-rules.mjs'
  );
  const srcDir = new URL('./renderer/src/', import.meta.url);

  const names = new Set();
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walkDir(child);
      else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
        const source = fs.readFileSync(child, 'utf8');
        for (const [, name] of source.matchAll(/\s([a-zA-Z][a-zA-Z0-9]*(?:-[a-z]+)?)=[{"]/g)) {
          names.add(name);
        }
      }
    }
  };
  walkDir(srcDir);

  const unclassified = [...names]
    .filter((name) => COPY_SOUNDING_PROP.test(name))
    .filter((name) => !/^on[A-Z]/.test(name)) // event handlers are never copy
    .filter(
      (name) => !COPY_ATTRIBUTES.includes(name) && !KNOWN_NON_COPY_ATTRIBUTES.includes(name)
    );

  assert.deepEqual(
    unclassified,
    [],
    `copy-sounding prop(s) classified in neither list: ${unclassified.join(', ')}. ` +
      `Add each to COPY_ATTRIBUTES (it shows words to a user) or to ` +
      `KNOWN_NON_COPY_ATTRIBUTES (it carries data), in app/scripts/i18n-copy-rules.mjs.`
  );
});

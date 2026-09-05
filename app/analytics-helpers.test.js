'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  textLengthBucket,
  durationBucket,
  RENDERER_TRACK_EVENTS,
  RENDERER_TRACK_EVENT_PROPERTIES,
  RENDERER_TRACK_EVENT_VALUE_ALLOWLIST,
  sanitizeTrackProperties,
  calendarMeetingProvider,
  classifyErrorReason,
  classifySummarizationStreamError,
  captureSanitizedException,
  redactLocalPaths,
  sanitizeModelForAnalytics,
  sanitizeErrorForCrashReport,
  summarizeCalendarWindow,
  summarizeCalendarSnapshot,
  withTimeout,
} = require('./analytics-helpers');

test('textLengthBucket buckets at each boundary', () => {
  assert.strictEqual(textLengthBucket(''), '0');
  assert.strictEqual(textLengthBucket(undefined), '0');
  assert.strictEqual(textLengthBucket('a'.repeat(19)), '1-20');
  assert.strictEqual(textLengthBucket('a'.repeat(20)), '20-50');
  assert.strictEqual(textLengthBucket('a'.repeat(49)), '20-50');
  assert.strictEqual(textLengthBucket('a'.repeat(50)), '50-100');
  assert.strictEqual(textLengthBucket('a'.repeat(99)), '50-100');
  assert.strictEqual(textLengthBucket('a'.repeat(100)), '100-250');
  assert.strictEqual(textLengthBucket('a'.repeat(249)), '100-250');
  assert.strictEqual(textLengthBucket('a'.repeat(250)), '250+');
  assert.strictEqual(textLengthBucket('a'.repeat(5000)), '250+');
});

test('durationBucket buckets at each boundary', () => {
  assert.strictEqual(durationBucket(0), '<1m');
  assert.strictEqual(durationBucket(59), '<1m');
  assert.strictEqual(durationBucket(60), '1-5m');
  assert.strictEqual(durationBucket(299), '1-5m');
  assert.strictEqual(durationBucket(300), '5-15m');
  assert.strictEqual(durationBucket(899), '5-15m');
  assert.strictEqual(durationBucket(900), '15-30m');
  assert.strictEqual(durationBucket(1799), '15-30m');
  assert.strictEqual(durationBucket(1800), '30-60m');
  assert.strictEqual(durationBucket(3599), '30-60m');
  assert.strictEqual(durationBucket(3600), '60m+');
  assert.strictEqual(durationBucket(999999), '60m+');
});

test('sanitizeTrackProperties keeps only allowlisted keys with scalar string/number/boolean values', () => {
  assert.deepStrictEqual(
    sanitizeTrackProperties('notification_shown', {
      type: 'premeeting',
      count: 3,
      enabled: true,
      nested: { title: 'Q3 planning sync' },
      arr: ['a', 'b'],
    }),
    // Only `type` is in notification_shown's allowlist -- count/enabled are
    // scalar-valid but not an allowed key for this event, so they're dropped
    // too, not just the nested/array values.
    { type: 'premeeting' },
  );
});

test('sanitizeTrackProperties enforces the value allowlist, not just the key allowlist (P1: a string under an approved key must still be a known enum value)', () => {
  // `type` is an allowed key for notification_shown, but only 'premeeting' is
  // an allowed VALUE (the only one the renderer bridge actually sends) --
  // anything else must be dropped even though it's short and under an
  // approved key, e.g. a future bug pasting arbitrary text into `type`.
  assert.deepStrictEqual(
    sanitizeTrackProperties('notification_shown', { type: 'meeting_detected' }),
    {},
  );
  assert.deepStrictEqual(
    sanitizeTrackProperties('notification_shown', { type: 'a pasted attendee name' }),
    {},
  );
  assert.deepStrictEqual(
    sanitizeTrackProperties('notification_shown', { type: 'premeeting' }),
    { type: 'premeeting' },
  );

  // Same enforcement for ai_provider_selected / onboarding_completed's enum
  // properties -- only their known literal values survive.
  assert.deepStrictEqual(sanitizeTrackProperties('ai_provider_selected', { provider: 'cloud' }), { provider: 'cloud' });
  assert.deepStrictEqual(sanitizeTrackProperties('ai_provider_selected', { provider: 'openai' }), {});
  assert.deepStrictEqual(
    sanitizeTrackProperties('onboarding_completed', { ai_provider: 'local', calendar_connected: true }),
    { ai_provider: 'local', calendar_connected: true },
  );
  assert.deepStrictEqual(
    sanitizeTrackProperties('onboarding_completed', { ai_provider: 'remote', calendar_connected: true }),
    { calendar_connected: true },
  );
});

test('RENDERER_TRACK_EVENT_VALUE_ALLOWLIST has an entry for every allowlisted string property', () => {
  // Every string-valued property reachable through the renderer bridge
  // should be enum-constrained -- not just key-allowlisted and length-capped.
  const stringProps = [
    'notification_shown.type',
    'notification_clicked.type',
    'notification_dismissed.type',
    'onboarding_completed.ai_provider',
    'ai_provider_selected.provider',
  ];
  for (const prop of stringProps) {
    assert.ok(RENDERER_TRACK_EVENT_VALUE_ALLOWLIST[prop] instanceof Set, `missing value allowlist for ${prop}`);
  }
});

test('sanitizeTrackProperties drops a short scalar value under a key outside the event allowlist (no PII-under-unexpected-key leak)', () => {
  // Regression for the actual privacy boundary: a short string alone used to
  // be enough to pass through. `meeting_title` is well under the 200-char
  // cap, but it is not an allowed key for onboarding_completed.
  const result = sanitizeTrackProperties('onboarding_completed', {
    ai_provider: 'local',
    calendar_connected: true,
    meeting_title: 'Board sync w/ Jane Doe',
  });
  assert.deepStrictEqual(result, { ai_provider: 'local', calendar_connected: true });
});

test('sanitizeTrackProperties drops strings over 200 chars even for an allowlisted key', () => {
  const longTitle = 'x'.repeat(201);
  const result = sanitizeTrackProperties('ai_provider_selected', { provider: 'cloud', extra: longTitle });
  assert.deepStrictEqual(result, { provider: 'cloud' });
});

test('sanitizeTrackProperties returns empty for an event with no allowlist entry', () => {
  assert.deepStrictEqual(sanitizeTrackProperties('not_a_real_event', { type: 'x' }), {});
  assert.deepStrictEqual(sanitizeTrackProperties('__proto__', { type: 'x' }), {});
});

test('sanitizeTrackProperties handles non-object / null / undefined properties', () => {
  assert.deepStrictEqual(sanitizeTrackProperties('notification_shown', null), {});
  assert.deepStrictEqual(sanitizeTrackProperties('notification_shown', undefined), {});
  assert.deepStrictEqual(sanitizeTrackProperties('notification_shown', 'a string'), {});
  assert.deepStrictEqual(sanitizeTrackProperties('notification_shown', 42), {});
});

test('RENDERER_TRACK_EVENTS covers exactly the events the renderer calls via the bridge', () => {
  assert.ok(RENDERER_TRACK_EVENTS.has('notification_shown'));
  assert.ok(RENDERER_TRACK_EVENTS.has('notification_clicked'));
  assert.ok(RENDERER_TRACK_EVENTS.has('notification_dismissed'));
  assert.ok(RENDERER_TRACK_EVENTS.has('onboarding_completed'));
  assert.ok(RENDERER_TRACK_EVENTS.has('ai_provider_selected'));
  assert.ok(!RENDERER_TRACK_EVENTS.has('__proto__'));
  assert.ok(!RENDERER_TRACK_EVENTS.has('arbitrary_event'));
  // chat_message_sent fires directly from main.js's streaming handlers, never
  // via the renderer bridge -- it must NOT be renderer-reachable.
  assert.ok(!RENDERER_TRACK_EVENTS.has('chat_message_sent'));
});

test('RENDERER_TRACK_EVENT_PROPERTIES allowlists are narrow and event-specific', () => {
  assert.deepStrictEqual([...RENDERER_TRACK_EVENT_PROPERTIES.notification_shown], ['type']);
  assert.deepStrictEqual([...RENDERER_TRACK_EVENT_PROPERTIES.ai_provider_selected], ['provider']);
  assert.deepStrictEqual(
    [...RENDERER_TRACK_EVENT_PROPERTIES.onboarding_completed].sort(),
    ['ai_provider', 'calendar_connected'],
  );
});

test('calendarMeetingProvider identifies known providers by hostname', () => {
  assert.strictEqual(calendarMeetingProvider('https://us02web.zoom.us/j/123'), 'zoom');
  assert.strictEqual(calendarMeetingProvider('https://meet.google.com/abc-defg-hij'), 'meet');
  assert.strictEqual(calendarMeetingProvider('https://teams.microsoft.com/l/meetup-join/x'), 'teams');
  assert.strictEqual(calendarMeetingProvider('https://teams.live.com/meet/123'), 'teams');
});

test('calendarMeetingProvider falls back to other/none appropriately', () => {
  assert.strictEqual(calendarMeetingProvider('https://example.com/meeting'), 'other');
  assert.strictEqual(calendarMeetingProvider(undefined), 'none');
  assert.strictEqual(calendarMeetingProvider(null), 'none');
  assert.strictEqual(calendarMeetingProvider(''), 'none');
  assert.strictEqual(calendarMeetingProvider('not a url'), 'other');
});

test('calendarMeetingProvider matches the exact domain or a real subdomain, not any host containing the string (P3)', () => {
  // Bare domain and real subdomains still match.
  assert.strictEqual(calendarMeetingProvider('https://zoom.us/j/123'), 'zoom');
  assert.strictEqual(calendarMeetingProvider('https://us02web.zoom.us/j/123'), 'zoom');
  // A host that merely CONTAINS "zoom.us" as a substring, without it being
  // the actual domain/subdomain, must NOT match -- this was the bug: a
  // naive .includes() check would misclassify these as 'zoom'.
  assert.strictEqual(calendarMeetingProvider('https://evilzoom.us.attacker.com/j/123'), 'other');
  assert.strictEqual(calendarMeetingProvider('https://notzoom.us/j/123'), 'other');
  assert.strictEqual(calendarMeetingProvider('https://myzoom.uscustomdomain.com/x'), 'other');
});

test('classifyErrorReason maps common failure classes to fixed enum values', () => {
  assert.strictEqual(classifyErrorReason(new Error('ENOENT: no such file or directory')), 'not_found');
  assert.strictEqual(classifyErrorReason(new Error('EACCES: permission denied')), 'permission_denied');
  assert.strictEqual(classifyErrorReason(new Error('EPERM: operation not permitted')), 'permission_denied');
  assert.strictEqual(classifyErrorReason(new Error('ENOSPC: no space left')), 'disk_full');
  assert.strictEqual(classifyErrorReason(new Error('process-streaming spawn error: boom')), 'spawn_failed');
  assert.strictEqual(classifyErrorReason(new Error('watchdog timed out after 60000ms')), 'timeout');
  assert.strictEqual(classifyErrorReason(new Error('metal::malloc out of memory')), 'out_of_memory');
  assert.strictEqual(
    classifyErrorReason(new Error('process-streaming exited with code -9: ...')),
    'subprocess_exit_-9',
  );
  assert.strictEqual(classifyErrorReason(new Error('something totally unexpected')), 'unknown');
});

test('classifyErrorReason never leaks the raw message -- fixed enum output only', () => {
  const err = new Error('/Users/alice/Desktop/interview-with-jane-doe.m4a ENOENT');
  const reason = classifyErrorReason(err);
  assert.ok(!reason.includes('alice'));
  assert.ok(!reason.includes('jane'));
  assert.strictEqual(reason, 'not_found');
});

test('classifySummarizationStreamError maps summarizer.py raise-site text to fixed enum values', () => {
  assert.strictEqual(classifySummarizationStreamError('Failed to start Ollama service'), 'ollama_not_running');
  assert.strictEqual(classifySummarizationStreamError('Failed to ensure model gemma4:e2b-it-qat is available'), 'model_unavailable');
  assert.strictEqual(classifySummarizationStreamError("Bedrock could not find model 'foo' in eu-west-2"), 'model_unavailable');
  assert.strictEqual(
    classifySummarizationStreamError('Meeting is too long to summarize even after chunking — try a model with a larger context window.'),
    'context_overflow',
  );
  assert.strictEqual(classifySummarizationStreamError('Reduce step returned empty result'), 'empty_summary');
  assert.strictEqual(
    classifySummarizationStreamError('Chunk 2/5 returned an empty result after retry — Ollama may have run out of context or memory.'),
    'empty_summary',
  );
  assert.strictEqual(classifySummarizationStreamError('Anthropic returned empty response'), 'empty_summary');
  assert.strictEqual(
    classifySummarizationStreamError('Org adapter rejected the request (401). Your session may have expired — re-sign in to your organisation in Settings.'),
    'auth_rejected',
  );
  assert.strictEqual(
    classifySummarizationStreamError("Bedrock rejected the API key (403). Verify the key has bedrock:InvokeModel access in eu-west-2."),
    'auth_rejected',
  );
  assert.strictEqual(classifySummarizationStreamError('Cloud API key is not configured. Set it in Settings > AI.'), 'not_configured');
  assert.strictEqual(classifySummarizationStreamError('Remote Ollama URL is not configured. Set it in Settings > AI.'), 'not_configured');
  assert.strictEqual(classifySummarizationStreamError('Ollama is not installed. Please install ollama-python.'), 'dependency_missing');
  assert.strictEqual(classifySummarizationStreamError('anthropic package is required for Anthropic cloud mode. pip install anthropic'), 'dependency_missing');
  assert.strictEqual(classifySummarizationStreamError('OpenAI chat failed after all retries'), 'api_error');
  assert.strictEqual(classifySummarizationStreamError('Bedrock HTTP 500: Internal Server Error'), 'api_error');
  assert.strictEqual(classifySummarizationStreamError('something totally unexpected'), 'unknown');
  assert.strictEqual(classifySummarizationStreamError(), 'unknown');
});

test('classifySummarizationStreamError catches Ollama dying mid-stream and running out of memory, not just the pre-flight check', () => {
  // These two originate from the Ollama server / a bare-re-raised httpx
  // exception (see _stream_direct / _chat_no_think's bare `raise original`),
  // not a literal in summarizer.py -- the 92.5%-of-users-are-local-Ollama
  // case this classifier most needs to get right.
  assert.strictEqual(
    classifySummarizationStreamError("Ollama streaming failed: [Errno 61] Connection refused"),
    'ollama_not_running',
  );
  assert.strictEqual(
    classifySummarizationStreamError('httpx.ConnectError: All connection attempts failed'),
    'ollama_not_running',
  );
  assert.strictEqual(
    classifySummarizationStreamError('model requires more system memory (10.5 GiB) than is available (8.0 GiB)'),
    'insufficient_memory',
  );
});

test('classifySummarizationStreamError never leaks raw third-party/opaque text -- unmatched messages fall to unknown', () => {
  // A bare re-raise of an underlying SDK/HTTP exception (e.g. OpenAI/Bedrock)
  // can carry unpredictable, potentially sensitive text -- this must never be
  // classified into a false-confidence bucket, only the safe 'unknown' default.
  const opaque = 'RateLimitError: You exceeded your current quota, please check your plan and billing details for account acct_1234567890.';
  const reason = classifySummarizationStreamError(opaque);
  assert.strictEqual(reason, 'unknown');
  assert.ok(!reason.includes('acct_'));
});

test('classifySummarizationStreamError patterns stay in sync with the literal strings in src/summarizer.py (drift guard)', () => {
  // Every substring below is a literal (or fixed portion of an f-string
  // template) a classifySummarizationStreamError branch depends on matching.
  // If a future edit to summarizer.py rewords one of these messages, this
  // test fails loudly instead of the corresponding bucket silently
  // degrading to 'unknown' with no signal anywhere. Excludes the
  // connection-refused half of ollama_not_running and insufficient_memory,
  // which match text from the Ollama server / httpx client, not a literal
  // authored in this file (see the comment above classifySummarizationStreamError).
  const summarizerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'summarizer.py'),
    'utf8',
  );
  const expectedSubstrings = [
    'Failed to start Ollama service',
    'Failed to ensure model',
    'could not find model',
    'too long to summarize even after chunking',
    'returned empty result',
    'returned an empty result',
    'returned empty response',
    'rejected the request',
    'rejected the API key',
    'is not configured',
    'is not installed',
    'package is required',
    'failed after all retries',
  ];
  for (const substr of expectedSubstrings) {
    assert.ok(
      summarizerSrc.includes(substr),
      `src/summarizer.py no longer contains ${JSON.stringify(substr)} -- update classifySummarizationStreamError's matching pattern to match`,
    );
  }
});

test('sanitizeErrorForCrashReport replaces the message with a fixed enum, never the raw text', () => {
  const err = new Error("ENOENT: no such file or directory, open '/Users/will/Library/Application Support/stenoai/recordings/1:1 with Jane Doe.wav'");
  err.name = 'Error';
  const safe = sanitizeErrorForCrashReport(err);
  assert.strictEqual(safe.message, 'not_found');
  assert.ok(!safe.message.includes('Jane'));
  assert.ok(!safe.message.includes('will'));
});

test('sanitizeErrorForCrashReport strips the risky first stack line but keeps the frame list (file:line) intact for triage', () => {
  const err = new Error("ENOENT: open '/Users/will/recordings/Board sync w Jane Doe.wav'");
  err.name = 'Error';
  err.stack =
    "Error: ENOENT: open '/Users/will/recordings/Board sync w Jane Doe.wav'\n" +
    '    at Object.openSync (node:fs:592:3)\n' +
    '    at processNextInQueue (/Applications/Steno.app/Contents/Resources/app.asar/main.js:3820:15)';
  const safe = sanitizeErrorForCrashReport(err);
  const stackLines = safe.stack.split('\n');
  // First line is sanitized -- the fixed reason, not the raw message.
  assert.strictEqual(stackLines[0], 'Error: not_found');
  assert.ok(!safe.stack.includes('Jane'));
  assert.ok(!safe.stack.includes('/Users/will/recordings'));
  // Frame lines (file:line locations in our own source) are preserved verbatim.
  assert.strictEqual(stackLines[1], '    at Object.openSync (node:fs:592:3)');
  assert.ok(stackLines[2].includes('processNextInQueue (/Applications/Steno.app'));
});

test('sanitizeErrorForCrashReport redacts a username/workspace path in a stack FRAME (P2: dev/unpacked installs are not guaranteed path-free)', () => {
  // A signed production build's frames point into /Applications/Steno.app,
  // which is safe (no username). A dev checkout or portable install's
  // frames instead point somewhere like /Users/alice/Downloads/stenoai/...,
  // which embeds the OS username and local folder name -- this must not
  // survive into the crash report.
  const err = new TypeError('Cannot read properties of undefined');
  err.stack =
    'TypeError: Cannot read properties of undefined\n' +
    '    at processNextInQueue (/Users/alice/Downloads/stenoai-dev/app/main.js:3820:15)\n' +
    '    at Object.<anonymous> (/Users/alice/Downloads/stenoai-dev/app/node_modules/posthog-node/lib/index.js:100:5)';
  const safe = sanitizeErrorForCrashReport(err);
  assert.ok(!safe.stack.includes('alice'));
  assert.ok(!safe.stack.includes('/Users/alice'));
  // Function name + relative structure still present for triage.
  assert.ok(safe.stack.includes('processNextInQueue'));
  assert.ok(safe.stack.includes('main.js:3820:15'));
});

test('redactLocalPaths strips the app install root and falls back to redacting bare home-directory paths', () => {
  const path = require('path');
  const appRoot = __dirname; // analytics-helpers.js's own dir == main.js's dir
  const underAppRoot = `${appRoot}${path.sep}main.js:10:1`;
  const result1 = redactLocalPaths(underAppRoot);
  assert.ok(!result1.includes(appRoot));
  assert.ok(result1.includes('<app>'));

  // Not under the app root at all (e.g. an Electron internal frame or an
  // unexpected library path) -- the regex fallback collapses the WHOLE
  // home-relative path (every directory segment, not just the username) to
  // a filename, so a workspace/client/project folder name after the
  // username can't survive either.
  assert.strictEqual(
    redactLocalPaths('at foo (/Users/bob/somewhere/else.js:1:1)'),
    'at foo (<redacted-path>/else.js:1:1)',
  );
  assert.strictEqual(
    redactLocalPaths('at foo (/Users/bob/acme-corp-confidential/steno-fork/lib/else.js:1:1)'),
    'at foo (<redacted-path>/else.js:1:1)',
  );
  assert.ok(!redactLocalPaths('/Users/bob/acme-corp-confidential/else.js').includes('acme-corp'));
  assert.strictEqual(
    redactLocalPaths('at foo (/home/bob/somewhere/else.js:1:1)'),
    'at foo (<redacted-path>/else.js:1:1)',
  );
  assert.strictEqual(
    redactLocalPaths('at foo (C:\\Users\\bob\\somewhere\\else.js:1:1)'),
    'at foo (<redacted-path>/else.js:1:1)',
  );
  // A path with no user-specific segment at all is left alone.
  assert.strictEqual(redactLocalPaths('at node:internal/process/task_queues:95:5'), 'at node:internal/process/task_queues:95:5');
});

test('redactLocalPaths matches through spaces in a path component (P2 regression: macOS "Application Support", a client folder like "Client Project")', () => {
  // The exclusion class used to stop at the FIRST whitespace character, so
  // only the text before the space was redacted -- everything after it
  // (e.g. "Support/stenoai/main.js", or "Project/main.js" from a client
  // workspace literally named "Client Project") leaked through unredacted.
  const macPath = 'at foo (/Users/alice/Library/Application Support/stenoai/main.js:10:1)';
  const result = redactLocalPaths(macPath);
  assert.strictEqual(result, 'at foo (<redacted-path>/main.js:10:1)');
  assert.ok(!result.includes('Support'));
  assert.ok(!result.includes('Library'));

  const clientWorkspace = 'at foo (/Users/alice/Client Project/steno-fork/lib/file.js:1:1)';
  const resultClient = redactLocalPaths(clientWorkspace);
  assert.strictEqual(resultClient, 'at foo (<redacted-path>/file.js:1:1)');
  assert.ok(!resultClient.includes('Client'));
  assert.ok(!resultClient.includes('Project'));
});

test('sanitizeErrorForCrashReport preserves the error name (generic, not PII) and handles a missing/non-Error stack', () => {
  const typeErr = new TypeError('Cannot read properties of undefined');
  const safe = sanitizeErrorForCrashReport(typeErr);
  assert.strictEqual(safe.name, 'TypeError');
  assert.strictEqual(safe.message, 'unknown');

  const noStack = { message: 'ENOSPC: no space left', name: 'Error' };
  const safeNoStack = sanitizeErrorForCrashReport(noStack);
  assert.strictEqual(safeNoStack.message, 'disk_full');
});

test('sanitizeErrorForCrashReport does not leak the real dev-checkout path when the original value has no stack (adversarial regression)', () => {
  // Confirmed live before this fix: `new Error(reason)`'s own auto-captured
  // stack points INTO this file (analytics-helpers.js), so for any thrown
  // value without a real .stack -- a plain object, or a bare `throw "x"`,
  // which uncaughtException receives directly and unwrapped, unlike
  // unhandledRejection which we always wrap in a real Error first -- the
  // untouched auto-generated stack leaked this machine's actual checkout
  // path in full (e.g. "/Users/<real-name>/.../analytics-helpers.js:NNN").
  const path = require('path');
  const appDir = __dirname;

  const objNoStack = { message: 'ENOSPC: no space left', name: 'Error' };
  const safe1 = sanitizeErrorForCrashReport(objNoStack);
  assert.ok(!safe1.stack.includes(appDir));
  assert.ok(!safe1.stack.includes(path.sep + 'Users' + path.sep));
  assert.strictEqual(safe1.stack, 'Error: disk_full');

  const safe2 = sanitizeErrorForCrashReport('a bare string, not an Error');
  assert.ok(!safe2.stack.includes(appDir));
  assert.strictEqual(safe2.stack, 'Error: unknown');
});

test('captureSanitizedException sends only the sanitized crash object to PostHog', () => {
  let captured = null;
  const fakePosthog = {
    captureException(err, distinctId) {
      captured = { err, distinctId };
    },
  };
  const err = new Error("ENOENT: open '/Users/alice/Secret Client/meeting.wav'");
  err.stack =
    "Error: ENOENT: open '/Users/alice/Secret Client/meeting.wav'\n" +
    '    at fail (/Users/alice/Secret Client/steno/app/main.js:10:2)';

  captureSanitizedException(fakePosthog, err, 'anon-123');

  assert.strictEqual(captured.distinctId, 'anon-123');
  assert.strictEqual(captured.err.message, 'not_found');
  assert.ok(!captured.err.stack.includes('alice'));
  assert.ok(!captured.err.stack.includes('Secret Client'));
  assert.ok(captured.err.stack.includes('<redacted-path>/main.js:10:2'));
});

test('sanitizeModelForAnalytics keeps known public model ids but collapses custom/free-form names', () => {
  // Every curated built-in must pass through un-collapsed. This list is a
  // deliberate literal duplicate of ANALYTICS_MODEL_ALLOWLIST so that an
  // accidental removal or typo in the allowlist fails here.
  const curatedPublicIds = [
    'apple:system',
    'gemma4:e2b-it-qat',
    'gemma4:e4b-it-qat',
    'gemma4:12b-it-qat',
    'gemma4:e2b-nvfp4',
    'gemma4:e4b-nvfp4',
    'gemma4:12b-nvfp4',
    'llama3.2:3b',
    'qwen3.5:9b',
    'gpt-oss:20b',
    'parakeet',
    'large-v3-turbo',
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'claude-3-5-haiku-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-7-sonnet-latest',
    'claude-haiku-4-5-20251001',
    'anthropic.claude-sonnet-4-5-20250929-v2:0',
    'anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic.claude-opus-4-1-20250805-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'anthropic.claude-3-5-haiku-20241022-v1:0',
  ];
  for (const id of curatedPublicIds) {
    assert.strictEqual(sanitizeModelForAnalytics(id), id);
  }

  assert.strictEqual(sanitizeModelForAnalytics('/Users/alice/Secret Client/model.gguf'), 'custom');
  assert.strictEqual(sanitizeModelForAnalytics('acme-board-meeting-private-model'), 'custom');
  assert.strictEqual(sanitizeModelForAnalytics('ft:gpt-4o-mini:acme-corp:board:abc123'), 'custom');
  assert.strictEqual(sanitizeModelForAnalytics(''), 'unknown');
  assert.strictEqual(sanitizeModelForAnalytics(null), 'unknown');
});

test('redactLocalPaths never exposes the username itself when nothing follows it in the match (adversarial regression)', () => {
  // Confirmed live before this fix: a match with nothing after the username
  // fell back to treating the username as the "filename" --
  // redactLocalPaths('at foo (/Users/bob:5:10)') produced
  // "at foo (<redacted-path>/bob:5:10)", leaking "bob" outright.
  assert.strictEqual(redactLocalPaths('at foo (/Users/bob:5:10)'), 'at foo (<redacted-path>:5:10)');
  assert.strictEqual(redactLocalPaths('at foo (/home/bob:5:10)'), 'at foo (<redacted-path>:5:10)');
  assert.strictEqual(
    redactLocalPaths('at foo (C:\\Users\\bob:5:10)'),
    'at foo (<redacted-path>:5:10)',
  );
  const result = redactLocalPaths('at foo (/Users/bob:5:10)');
  assert.ok(!result.includes('bob'));
});

test('redactLocalPaths collapses a /root/ workspace path (defense in depth, not an officially shipped platform)', () => {
  assert.strictEqual(
    redactLocalPaths('at foo (/root/acme-corp-project/main.js:5:10)'),
    'at foo (<redacted-path>/main.js:5:10)',
  );
  assert.ok(!redactLocalPaths('at foo (/root/acme-corp-project/main.js:5:10)').includes('acme-corp'));
});

test('redactLocalPaths does not stop early on a `)` or `:` that is part of a legitimate folder name (adversarial regression)', () => {
  // Confirmed live before this fix: a folder literally named "Client
  // (Secret)" or "Project:Next" broke the old character-class approach,
  // which stopped at the FIRST `)` or `:` anywhere -- including one inside
  // the folder name itself -- leaving everything after it (the real
  // workspace/client name) completely unredacted:
  //   redactLocalPaths('at foo (/Users/alice/Client (Secret)/main.js:10:2)')
  //   => 'at foo (<redacted-path>/Client (Secret)/main.js:10:2)'  -- BUG
  const withParens = redactLocalPaths('at foo (/Users/alice/Client (Secret)/main.js:10:2)');
  assert.strictEqual(withParens, 'at foo (<redacted-path>/main.js:10:2)');
  assert.ok(!withParens.includes('Client'));
  assert.ok(!withParens.includes('Secret'));

  const withColon = redactLocalPaths('at foo (/Users/alice/Project:Next/main.js:10:2)');
  assert.strictEqual(withColon, 'at foo (<redacted-path>/main.js:10:2)');
  assert.ok(!withColon.includes('Project'));
  assert.ok(!withColon.includes('Next'));
});

test('summarizeCalendarWindow counts meetings and buckets provider breakdown, content-free', () => {
  const events = [
    { title: 'Standup', meeting_url: 'https://zoom.us/j/1' },
    { title: 'Board planning', meeting_url: 'https://meet.google.com/abc' },
    { title: '1:1', meeting_url: 'https://zoom.us/j/2' },
    { title: 'No video meeting' }, // no meeting_url -> provider 'none'
  ];
  const summary = summarizeCalendarWindow(events);
  assert.strictEqual(summary.meeting_count, 4);
  assert.strictEqual(summary.video_meeting_count, 3);
  assert.deepStrictEqual(summary.provider_breakdown, { zoom: 2, meet: 1 });
  // Content-free: no title/url should ever appear on the summary object.
  assert.strictEqual(JSON.stringify(summary).includes('Standup'), false);
  assert.strictEqual(JSON.stringify(summary).includes('zoom.us'), false);
});

test('summarizeCalendarSnapshot splits events into today vs week windows', () => {
  const now = new Date('2026-07-07T12:00:00Z');
  const events = [
    // Today, timed, zoom
    { title: 'Today standup', start: '2026-07-07T09:00:00Z', meeting_url: 'https://zoom.us/j/1' },
    // Later this week, timed, meet
    { title: 'Later this week', start: '2026-07-09T09:00:00Z', meeting_url: 'https://meet.google.com/abc' },
    // All-day event -- excluded from both windows
    { title: 'On vacation', start: '2026-07-07', is_all_day: true },
    // Declined -- excluded from both windows
    { title: 'Declined meeting', start: '2026-07-07T15:00:00Z', response_status: 'declined' },
  ];
  const { today, week } = summarizeCalendarSnapshot(events, now);
  assert.strictEqual(today.meeting_count, 1);
  assert.strictEqual(today.video_meeting_count, 1);
  assert.strictEqual(week.meeting_count, 2);
  assert.strictEqual(week.video_meeting_count, 2);
  assert.deepStrictEqual(week.provider_breakdown, { zoom: 1, meet: 1 });
});

test('withTimeout resolves with the promise value when it settles before the deadline', async () => {
  const result = await withTimeout(Promise.resolve('calendar-event'), 50);
  assert.strictEqual(result, 'calendar-event');
});

test('withTimeout resolves with the fallback if the promise never settles (a hung token refresh)', async () => {
  const neverSettles = new Promise(() => {});
  const result = await withTimeout(neverSettles, 20, null);
  assert.strictEqual(result, null);
});

test('withTimeout resolves with the fallback (not a rejection) if the promise rejects', async () => {
  const rejecting = Promise.reject(new Error('token refresh failed'));
  const result = await withTimeout(rejecting, 50, null);
  assert.strictEqual(result, null);
});

test('withTimeout supports a custom fallback value', async () => {
  const neverSettles = new Promise(() => {});
  const result = await withTimeout(neverSettles, 20, 'timed-out');
  assert.strictEqual(result, 'timed-out');
});

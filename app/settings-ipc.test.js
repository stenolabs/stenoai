'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerSettingsIpc } = require('./settings-ipc');

// Minimal fakes: capture handlers by channel, record backend calls + debug logs,
// and let each test drive one handler and assert its argv/seam usage. No electron.
function harness(overrides = {}) {
  const handlers = {};
  const calls = { py: [], debug: [] };
  const deps = {
    ipcMain: {
      handle: (ch, fn) => {
        // Mirror Electron: registering the same channel twice throws. Guards the
        // "exactly 17" assertion against an in-module duplicate that would
        // otherwise be silently overwritten (and so counted once).
        if (Object.prototype.hasOwnProperty.call(handlers, ch)) {
          throw new Error(`duplicate ipcMain.handle registration for '${ch}'`);
        }
        handlers[ch] = fn;
      },
    },
    runPythonScript: async (script, args, silent) => {
      calls.py.push({ script, args, silent });
      if (overrides.pyThrows) throw new Error(overrides.pyThrows);
      return overrides.pyResult ?? '{"success": true}';
    },
    sendDebugLog: (msg) => { calls.debug.push(msg); },
    onLanguageChanged: overrides.onLanguageChanged,
  };
  registerSettingsIpc(deps);
  return { handlers, calls };
}

const CHANNELS = [
  'get-keep-recordings', 'set-keep-recordings',
  'get-auto-summarize', 'set-auto-summarize',
  'get-auto-install-when-idle', 'set-auto-install-when-idle',
  'get-identity-matching-enabled', 'set-identity-matching-enabled',
  'get-silence-auto-stop', 'set-silence-auto-stop-enabled', 'set-silence-auto-stop-minutes',
  'get-privacy-notice-seen', 'set-privacy-notice-seen',
  'get-system-audio', 'set-system-audio',
  'get-language', 'set-language',
  'get-microphone', 'set-microphone',
  'get-user-name', 'set-user-name',
];

test('registers exactly the 21 settings-toggle handlers', () => {
  const { handlers } = harness();
  assert.deepStrictEqual(Object.keys(handlers).sort(), [...CHANNELS].sort());
});

// Every spread-getter reads its own subcommand SILENTLY and returns
// { success:true, ...jsonData }. Covers all nine (privacy-notice-seen differs
// and has its own test below).
const SPREAD_GETTERS = [
  'get-keep-recordings', 'get-auto-summarize', 'get-auto-install-when-idle',
  'get-identity-matching-enabled',
  'get-silence-auto-stop',
  'get-user-name', 'get-system-audio', 'get-language', 'get-microphone',
];

test('every spread getter reads its own subcommand silently and spreads the parsed result', async () => {
  for (const ch of SPREAD_GETTERS) {
    const { handlers, calls } = harness({ pyResult: '{"value": 1}' });
    const res = await handlers[ch]();
    assert.deepStrictEqual(calls.py[0].args, [ch], `${ch} argv is its own subcommand`);
    assert.strictEqual(calls.py[0].script, 'simple_recorder.py', `${ch} targets the CLI`);
    assert.strictEqual(calls.py[0].silent, true, `${ch} must read silently`);
    assert.deepStrictEqual(res, { success: true, value: 1 }, `${ch} spreads result`);
  }
});

test('set-keep-recordings / set-auto-summarize / set-auto-install-when-idle stringify the boolean into argv and wrap the result', async () => {
  const keep = harness({ pyResult: '{"keep_recordings": true}' });
  const rk = await keep.handlers['set-keep-recordings']({}, true);
  assert.deepStrictEqual(keep.calls.py[0].args, ['set-keep-recordings', 'true']);
  assert.strictEqual(keep.calls.py[0].silent, undefined); // mutations stream to debug panel
  assert.deepStrictEqual(rk, { success: true, keep_recordings: true }); // {success:true, ...jsonData}

  const auto = harness({ pyResult: '{"auto_summarize": false}' });
  const ra = await auto.handlers['set-auto-summarize']({}, false);
  assert.deepStrictEqual(auto.calls.py[0].args, ['set-auto-summarize', 'false']);
  assert.deepStrictEqual(ra, { success: true, auto_summarize: false });

  const idle = harness({ pyResult: '{"auto_install_when_idle": false}' });
  const ri = await idle.handlers['set-auto-install-when-idle']({}, false);
  assert.deepStrictEqual(idle.calls.py[0].args, ['set-auto-install-when-idle', 'false']);
  assert.deepStrictEqual(ri, { success: true, auto_install_when_idle: false });

  const identity = harness({ pyResult: '{"identity_matching_enabled": false}' });
  const rid = await identity.handlers['set-identity-matching-enabled']({}, false);
  assert.deepStrictEqual(identity.calls.py[0].args, ['set-identity-matching-enabled', 'false']);
  assert.deepStrictEqual(rid, { success: true, identity_matching_enabled: false });
});

test('silence-auto-stop setters map to Python True/False and String(minutes), returning the raw result', async () => {
  const enabled = harness({ pyResult: '{"silence_auto_stop": true}' });
  const r1 = await enabled.handlers['set-silence-auto-stop-enabled']({}, true);
  assert.deepStrictEqual(enabled.calls.py[0].args, ['set-silence-auto-stop-enabled', 'True']);
  assert.deepStrictEqual(r1, { silence_auto_stop: true }); // returns jsonData verbatim, not wrapped

  const disabled = harness();
  await disabled.handlers['set-silence-auto-stop-enabled']({}, false);
  assert.deepStrictEqual(disabled.calls.py[0].args, ['set-silence-auto-stop-enabled', 'False']);

  const minutes = harness({ pyResult: '{"silence_auto_stop_minutes": 5}' });
  const rm = await minutes.handlers['set-silence-auto-stop-minutes']({}, 5);
  assert.deepStrictEqual(minutes.calls.py[0].args, ['set-silence-auto-stop-minutes', '5']);
  assert.deepStrictEqual(rm, { silence_auto_stop_minutes: 5 }); // returns jsonData verbatim
});

test('set-system-audio / set-language parse the first JSON object out of noisy stdout', async () => {
  const sys = harness({ pyResult: 'log line\n{"success": true, "system_audio_enabled": true}\n' });
  const r1 = await sys.handlers['set-system-audio']({}, true);
  assert.deepStrictEqual(sys.calls.py[0].args, ['set-system-audio', 'True']);
  assert.deepStrictEqual(r1, { success: true, system_audio_enabled: true });

  // Fallback path: no JSON in stdout -> synthesised success echoing the input.
  const noJson = harness({ pyResult: 'no json here' });
  const r2 = await noJson.handlers['set-system-audio']({}, false);
  assert.deepStrictEqual(r2, { success: true, system_audio_enabled: false });

  const lang = harness({ pyResult: '{"language": "de"}' });
  const r3 = await lang.handlers['set-language']({}, 'de');
  assert.deepStrictEqual(lang.calls.py[0].args, ['set-language', 'de']);
  assert.deepStrictEqual(r3, { language: 'de' });
});

test('set-microphone inserts the `--` argv delimiter and coalesces null id/label', async () => {
  const picked = harness({ pyResult: 'not json' });
  const r1 = await picked.handlers['set-microphone']({}, 'dev-1', 'USB Mic');
  assert.deepStrictEqual(picked.calls.py[0].args, ['set-microphone', '--', 'dev-1', 'USB Mic']);
  assert.deepStrictEqual(r1, { success: true, device_id: 'dev-1', label: 'USB Mic' });

  // 'default' / undefined normalise to a null selection with a null label.
  const cleared = harness({ pyResult: 'not json' });
  const r2 = await cleared.handlers['set-microphone']({}, 'default', undefined);
  assert.deepStrictEqual(cleared.calls.py[0].args, ['set-microphone', '--', 'default', '']);
  assert.deepStrictEqual(r2, { success: true, device_id: null, label: null });
});

test('set-user-name coerces nullish names to an empty string and trims the echoed fallback', async () => {
  const named = harness({ pyResult: 'noise' });
  const r1 = await named.handlers['set-user-name']({}, '  Casey Example  ');
  assert.deepStrictEqual(named.calls.py[0].args, ['set-user-name', '  Casey Example  ']);
  assert.deepStrictEqual(r1, { success: true, user_name: 'Casey Example' });

  const nullish = harness({ pyResult: 'noise' });
  const r2 = await nullish.handlers['set-user-name']({}, null);
  assert.deepStrictEqual(nullish.calls.py[0].args, ['set-user-name', '']);
  assert.deepStrictEqual(r2, { success: true, user_name: '' });
});

test('privacy-notice handlers use the non-silent backend read and return raw set result', async () => {
  const get = harness({ pyResult: '{"privacy_notice_seen": true}' });
  const r1 = await get.handlers['get-privacy-notice-seen']();
  assert.strictEqual(get.calls.py[0].silent, undefined);
  assert.deepStrictEqual(r1, { success: true, privacy_notice_seen: true });

  const set = harness({ pyResult: '{"success": true, "privacy_notice_seen": true}' });
  const r2 = await set.handlers['set-privacy-notice-seen']();
  assert.deepStrictEqual(set.calls.py[0].args, ['set-privacy-notice-seen']);
  assert.deepStrictEqual(r2, { success: true, privacy_notice_seen: true });
});

test('backend failures surface as { success:false, error } and log via the injected sink', async () => {
  const { handlers, calls } = harness({ pyThrows: 'backend exploded' });
  // A handler that logs on error (system-audio) records to the debug sink.
  const r1 = await handlers['get-system-audio']();
  assert.deepStrictEqual(r1, { success: false, error: 'backend exploded' });
  assert.ok(calls.debug.some((m) => m.includes('backend exploded')));

  // A handler with no error logging (keep-recordings) still fails soft.
  const r2 = await handlers['get-keep-recordings']();
  assert.deepStrictEqual(r2, { success: false, error: 'backend exploded' });
});

test('set-language awaits and calls onLanguageChanged on success with persisted language (zh-Hant trigger)', async () => {
  let callbackFinished = false;
  const hookCalls = [];
  const onLanguageChanged = async (lang, parsed) => {
    await new Promise((resolve) => setImmediate(resolve));
    callbackFinished = true;
    hookCalls.push({ lang, parsed });
  };

  const h = harness({
    pyResult: '{"success": true, "language": "zh-Hant"}',
    onLanguageChanged,
  });
  const res = await h.handlers['set-language']({}, 'zh-Hant');
  assert.strictEqual(callbackFinished, true, 'set-language must await onLanguageChanged before resolving');
  assert.deepStrictEqual(hookCalls, [{ lang: 'zh-Hant', parsed: { success: true, language: 'zh-Hant' } }]);
  assert.deepStrictEqual(res, { success: true, language: 'zh-Hant' });

  // Fallback parsing (non-JSON stdout echoing input):
  const fallbackCalls = [];
  const hFallback = harness({
    pyResult: 'not json',
    onLanguageChanged: async (lang, parsed) => { fallbackCalls.push({ lang, parsed }); },
  });
  const resFallback = await hFallback.handlers['set-language']({}, 'zh-Hant');
  assert.deepStrictEqual(fallbackCalls, [{ lang: 'zh-Hant', parsed: { success: true, language: 'zh-Hant' } }]);
  assert.deepStrictEqual(resFallback, { success: true, language: 'zh-Hant' });
});

test('set-language does not call onLanguageChanged when backend throws or returns failure', async () => {
  const hookCalls = [];
  const onLanguageChanged = async (lang, parsed) => { hookCalls.push({ lang, parsed }); };

  // Backend throws
  const hThrows = harness({
    pyThrows: 'language persistence failed',
    onLanguageChanged,
  });
  const resThrows = await hThrows.handlers['set-language']({}, 'zh-Hant');
  assert.deepStrictEqual(resThrows, { success: false, error: 'language persistence failed' });
  assert.strictEqual(hookCalls.length, 0, 'onLanguageChanged must not be called when backend throws');
  assert.ok(hThrows.calls.debug.some((m) => m.includes('Error setting language: language persistence failed')));

  // Backend returns explicit failure
  const hFail = harness({
    pyResult: '{"success": false, "error": "unsupported language code"}',
    onLanguageChanged,
  });
  const resFail = await hFail.handlers['set-language']({}, 'invalid');
  assert.deepStrictEqual(resFail, { success: false, error: 'unsupported language code' });
  assert.strictEqual(hookCalls.length, 0, 'onLanguageChanged must not be called when backend returns success: false');
});

test('set-language logs onLanguageChanged callback errors without failing the preference save', async () => {
  const hErr = harness({
    pyResult: '{"success": true, "language": "zh-Hant"}',
    onLanguageChanged: async () => {
      throw new Error('sidecar restart failed');
    },
  });
  const res = await hErr.handlers['set-language']({}, 'zh-Hant');
  assert.deepStrictEqual(res, { success: true, language: 'zh-Hant' }, 'preference save still returns success');
  assert.ok(
    hErr.calls.debug.some((m) => m.includes('Error applying language change: sidecar restart failed')),
    'callback failure is logged to debug sink',
  );
});

test('set-language succeeds cleanly when onLanguageChanged is omitted or null', async () => {
  const hNull = harness({
    pyResult: '{"success": true, "language": "zh-Hant"}',
    onLanguageChanged: null,
  });
  const res = await hNull.handlers['set-language']({}, 'zh-Hant');
  assert.deepStrictEqual(res, { success: true, language: 'zh-Hant' });
});

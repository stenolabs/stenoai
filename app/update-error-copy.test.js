'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  describeUpdateError,
  updateErrorPhase,
  isMissingUpdateFeedError,
  PHASE_CHECK,
  PHASE_DOWNLOAD,
  PHASE_INSTALL,
} = require('./update-error-copy');

const check = (msg) => describeUpdateError(msg, { phase: PHASE_CHECK });
const download = (msg) => describeUpdateError(msg, { phase: PHASE_DOWNLOAD });
const install = (msg) => describeUpdateError(msg, { phase: PHASE_INSTALL });

// ── phase decision ─────────────────────────────────────────────────────────
// The bug this replaces: "a staged update exists" was treated as "a download
// failed", so every later check error was mislabelled.

test('a staged update does not make a later check error a download error', () => {
  assert.strictEqual(updateErrorPhase({ downloadInFlight: false }), PHASE_CHECK);
});

test('a transfer in flight is a download error', () => {
  assert.strictEqual(updateErrorPhase({ downloadInFlight: true }), PHASE_DOWNLOAD);
});

test('installing wins over everything else', () => {
  assert.strictEqual(updateErrorPhase({ downloadInFlight: true, installing: true }), PHASE_INSTALL);
  assert.strictEqual(updateErrorPhase({ installing: true }), PHASE_INSTALL);
});

test('no state at all reads as a check', () => {
  assert.strictEqual(updateErrorPhase(), PHASE_CHECK);
  assert.strictEqual(updateErrorPhase({}), PHASE_CHECK);
});

// ── nothing developer-shaped reaches the user ──────────────────────────────

const DEV_SHAPED = /net::|ENOENT|ECONN|EACCES|ENOSPC|sha512|\/|\bat \b/;

const RAW_SAMPLES = [
  "ENOENT: no such file or directory, open '/Applications/Steno.app/Contents/Resources/app-update.yml'",
  'net::ERR_INTERNET_DISCONNECTED',
  'getaddrinfo ENOTFOUND github.com',
  'sha512 checksum mismatch, expected AAA, got BBB',
  'ENOSPC: no space left on device, write',
  "EACCES: permission denied, rename '/Applications/Steno.app'",
  'Error: socket hang up',
  'net::ERR_HTTP_RESPONSE_CODE_FAILURE (404)',
  'HTTP 503',
  '',
  null,
  undefined,
];

test('never leaks developer-shaped text into the UI', () => {
  for (const raw of RAW_SAMPLES) {
    for (const out of [check(raw), download(raw), install(raw)]) {
      assert.doesNotMatch(out.message, DEV_SHAPED, `leaked from: ${raw}`);
      assert.match(out.message, /\.$/, `not a sentence: ${out.message}`);
      assert.strictEqual(typeof out.sticky, 'boolean');
    }
  }
});

// ── the phase must be named honestly ───────────────────────────────────────

test('a failed check is not reported as a failed download', () => {
  assert.match(check('net::ERR_INTERNET_DISCONNECTED').message, /reach the update server/i);
  assert.doesNotMatch(check('net::ERR_INTERNET_DISCONNECTED').message, /download/i);
  assert.doesNotMatch(check('something nobody predicted').message, /download/i);
});

test('a failed download says so', () => {
  assert.match(download('net::ERR_CONNECTION_RESET').message, /download/i);
  assert.match(download('something nobody predicted').message, /download/i);
});

test('a failed install says so, and does not blame the download', () => {
  const out = install('something nobody predicted');
  assert.match(out.message, /install/i);
  assert.doesNotMatch(out.message, /download/i);
  assert.strictEqual(out.sticky, true, 'a failed install is not disproved by a later check');
});

// ── branch precedence (each was a plausible mis-routing) ───────────────────

test('a permission error on the feed file is a permission problem, not a missing feed', () => {
  const out = check("EACCES: permission denied, open '/x/Contents/Resources/app-update.yml'");
  assert.match(out.message, /permission/i);
  assert.strictEqual(out.sticky, true);
});

test('an HTTP status failure is not reported as a connection problem', () => {
  for (const raw of ['net::ERR_HTTP_RESPONSE_CODE_FAILURE (404)', 'HTTP 503', 'status code: 500']) {
    const out = check(raw);
    assert.match(out.message, /update server didn't respond/i, `misrouted: ${raw}`);
    assert.doesNotMatch(out.message, /connection/i, `misrouted: ${raw}`);
  }
});

test('a path that merely contains the word network is not a connection problem', () => {
  const out = check("cannot read '/Users/x/Library/Application Support/network-cache/blob'");
  assert.doesNotMatch(out.message, /connection|reach the update server/i);
  assert.match(out.message, /couldn't check for updates/i);
});

test('a missing update feed is reported as an unconfigured build, whatever the phase', () => {
  const out = check("ENOENT: no such file or directory, open '/x/Resources/app-update.yml'");
  assert.match(out.message, /not set up for automatic updates/i);
  assert.strictEqual(out.sticky, true);
  // Phase-independent: this build can't update either way.
  assert.strictEqual(download('app-update.yml not found').message, out.message);
});

test('an integrity failure says nothing was installed', () => {
  assert.match(download('sha512 mismatch').message, /verified/i);
  assert.match(download("code signature didn't match").message, /verified/i);
});

test('out of disk space is actionable and does not promise a retry', () => {
  const out = download('ENOSPC: no space left on device');
  assert.match(out.message, /disk space/i);
  assert.doesNotMatch(out.message, /try again/i);
  assert.strictEqual(out.sticky, true);
});

// ── sticky: which failures survive a later successful check ────────────────

test('transient failures are cleared by a successful check', () => {
  for (const out of [
    check('net::ERR_INTERNET_DISCONNECTED'),
    check('HTTP 503'),
    check('something nobody predicted'),
    download('sha512 mismatch'),
  ]) {
    assert.strictEqual(out.sticky, false, out.message);
  }
});

test('conditions a check cannot disprove stay on screen', () => {
  for (const out of [
    check("ENOENT ... app-update.yml"),
    download('ENOSPC: no space left on device'),
    install("EPERM: operation not permitted"),
    install('something nobody predicted'),
  ]) {
    assert.strictEqual(out.sticky, true, out.message);
  }
});

test('a non-string error does not throw', () => {
  assert.doesNotThrow(() => describeUpdateError({ code: 42 }));
  assert.doesNotThrow(() => describeUpdateError());
});

// ── permission copy is phase- and platform-specific ────────────────────────
// One sentence used to cover every permission failure: it named the install
// step and told the user to move the app to /Applications. Wrong for a failure
// while fetching (nothing is being installed), and impossible to act on for a
// Windows user (no such folder).

const PERM = "EACCES: permission denied, rename '/x/Steno.app'";

test('a permission failure while downloading is not reported as an install problem', () => {
  const out = describeUpdateError(PERM, { phase: PHASE_DOWNLOAD, platform: 'darwin' });
  assert.match(out.message, /save the update/i);
  assert.doesNotMatch(out.message, /install/i);
  assert.doesNotMatch(out.message, /Applications folder/i);
  assert.strictEqual(out.sticky, true);
});

test('the Applications-folder hint is macOS-only', () => {
  for (const phase of [PHASE_CHECK, PHASE_INSTALL]) {
    const mac = describeUpdateError(PERM, { phase, platform: 'darwin' });
    assert.match(mac.message, /Applications folder/i, `missing on darwin in ${phase}`);

    const win = describeUpdateError(PERM, { phase, platform: 'win32' });
    assert.match(win.message, /permission/i, `wrong copy on win32 in ${phase}`);
    assert.doesNotMatch(win.message, /Applications folder/i, `macOS hint leaked to win32 in ${phase}`);
  }
});

test('a permission failure during a check does not claim an install was attempted', () => {
  for (const platform of ['darwin', 'win32']) {
    const out = describeUpdateError(PERM, { phase: PHASE_CHECK, platform });
    assert.match(out.message, /check for updates/i, `wrong verb on ${platform}`);
    assert.doesNotMatch(out.message, /install/i, `claims an install on ${platform}`);
  }
});

test('permission copy stays sticky on every platform and phase', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const phase of [PHASE_CHECK, PHASE_DOWNLOAD, PHASE_INSTALL]) {
      assert.strictEqual(
        describeUpdateError(PERM, { phase, platform }).sticky,
        true,
        `${platform}/${phase} lost sticky — a permission problem is not disproved by a later check`,
      );
    }
  }
});

test('a transport error during install is not called an interrupted download', () => {
  const out = describeUpdateError('net::ERR_CONNECTION_RESET', { phase: PHASE_INSTALL });
  assert.doesNotMatch(out.message, /download/i);
  assert.match(out.message, /couldn't be installed/i);
  // An install that failed stays until something proves otherwise — a later
  // clean check says nothing about whether the swap can be applied.
  assert.strictEqual(out.sticky, true);
});

test('the same transport error still reads as a transfer problem while downloading', () => {
  const out = describeUpdateError('net::ERR_CONNECTION_RESET', { phase: PHASE_DOWNLOAD });
  assert.match(out.message, /download was interrupted/i);
  assert.strictEqual(out.sticky, false);
});

// The "no feed published yet" 404 is swallowed rather than shown. The match
// used to be spelled /latest(-mac)?\.yml/ inline in main.js, which stopped
// covering the platform it most needed to the moment Linux shipped.
test('the missing-feed 404 is recognised on every platform\'s feed name', () => {
  for (const feed of [
    'latest.yml',            // Windows
    'latest-mac.yml',        // macOS
    'latest-linux.yml',      // Linux x64 — the case /latest(-mac)?/ missed
    'latest-linux-arm64.yml',
  ]) {
    assert.strictEqual(
      isMissingUpdateFeedError(`HttpError: 404 Cannot find ${feed} in the latest release artifacts`),
      true,
      `${feed} should be recognised as a missing feed, not surfaced to the user`,
    );
  }
});

test('a real failure is not mistaken for a missing feed', () => {
  // No feed filename at all.
  assert.strictEqual(isMissingUpdateFeedError('net::ERR_INTERNET_DISCONNECTED'), false);
  // Names a manifest, but app-update.yml is the packaged config, not the feed —
  // and its absence is a genuine packaging fault worth surfacing.
  assert.strictEqual(
    isMissingUpdateFeedError("ENOENT: no such file or directory, open 'app-update.yml'"),
    false,
  );
  // Names the feed, but the cause is not a 404 — a 500 is a real server fault.
  assert.strictEqual(isMissingUpdateFeedError('HttpError: 500 latest-linux.yml'), false);
});

test('a non-string error does not throw', () => {
  assert.strictEqual(isMissingUpdateFeedError(undefined), false);
  assert.strictEqual(isMissingUpdateFeedError(null), false);
  assert.strictEqual(isMissingUpdateFeedError(new Error('404 latest-linux.yml')), true);
});

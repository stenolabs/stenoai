'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { makeLineReader } = require('./backend-stream');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, 'main.js'), 'utf8');

// Parse statement boundaries rather than depending on indentation or brace layout.
function registration(sourceText, channel) {
  const file = ts.createSourceFile('main.js', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = file.statements.filter(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    return ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression)
      && call.expression.expression.text === 'ipcMain'
      && call.expression.name.text === 'handle'
      && call.arguments[0] && ts.isStringLiteral(call.arguments[0])
      && call.arguments[0].text === channel;
  });
  assert.equal(matches.length, 1, `Expected exactly one IPC registration for ${channel}`);
  return matches[0].getText(file);
}

function functionDeclaration(sourceText, name) {
  const file = ts.createSourceFile('main.js', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = file.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.equal(matches.length, 1, `Expected exactly one function declaration for ${name}`);
  return matches[0].getText(file);
}

test('registration extraction tolerates indentation and nested callbacks', () => {
  const input = `  ipcMain.handle('sample', () => {
    nested(() => {
});
  });
  unrelated();`;
  assert.equal(registration(input, 'sample'), input.trim().replace('\n  unrelated();', ''));
  assert.throws(() => registration(input, 'missing'), /Expected exactly one IPC registration/);
});

for (const channel of ['setup-parakeet', 'pull-parakeet-model']) {
  function start() {
    let handler;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const events = [];
    vm.runInNewContext(
      `${functionDeclaration(source, 'describeParakeetDownloadError')}\n${registration(source, channel)}`,
      {
        ipcMain: { handle: (_, fn) => { handler = fn; } },
        spawn: () => proc, getBackendPath: () => '/synthetic/backend', getBackendCwd: () => '/synthetic',
        makeLineReader, sendDebugLog: () => {}, setTimeout, clearTimeout,
        mainWindow: { isDestroyed: () => false, webContents: { send: (name, data) => events.push([name, data]) } },
      },
    );
    return { proc, events, promise: handler({}, 'synthetic-model') };
  }
  test(`${channel}: split progress and final JSON survive arbitrary stdout chunks`, async () => {
    const { proc, events, promise } = start();
    for (const chunk of ['PARAKEET_PULL_PRO', 'GRESS:{"stage":"downloading","file_bytes":42}\r', '\n{"suc', 'cess":true}\n']) {
      proc.stdout.emit('data', Buffer.from(chunk));
    }
    proc.emit('close', 0);
    assert.equal((await promise).success, true);
    assert.equal(events[0][0], 'parakeet-pull-progress');
    assert.equal(events[0][1].file_bytes, 42);
  });
  for (const final of ['', '{"success":false,"error":"Synthetic failure"}\n']) {
    test(`${channel}: missing/failed result cannot masquerade as completion (${Boolean(final)})`, async () => {
      const { proc, promise } = start();
      proc.stdout.emit('data', Buffer.from(final));
      proc.emit('close', 0);
      assert.equal((await promise).success, false);
    });
  }
  test(`${channel}: SSL certificate failures are actionable in app UI`, async () => {
    const { proc, promise } = start();
    proc.stdout.emit('data', Buffer.from('{"success":false,"error":"[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1006)"}\n'));
    proc.emit('close', 0);
    const result = await promise;
    assert.equal(result.success, false);
    assert.match(result.error, /could not verify Hugging Face/i);
    assert.match(result.error, /this computer/i);
    assert.match(result.error, /corporate VPN, proxy, or antivirus/i);
    assert.match(result.error, /SSL_CERT_FILE \/ REQUESTS_CA_BUNDLE/);
  });
}

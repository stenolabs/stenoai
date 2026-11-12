'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function tokenFunctions() {
  const file = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set([
    'getTokenFilePath', 'saveGoogleTokens', 'loadGoogleTokens',
    'deleteGoogleTokens', 'getValidAccessToken',
  ]);
  const functions = file.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && names.has(statement.name?.text));
  assert.equal(functions.length, names.size);
  const generation = file.statements.find((statement) =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(
      (declaration) => declaration.name.getText(file) === 'googleTokenGeneration'));
  return `${generation?.getText(file) || 'let googleTokenGeneration = 0;'}\n`
    + functions.map((statement) => statement.getText(file)).join('\n')
    + '\n({ saveGoogleTokens, loadGoogleTokens, deleteGoogleTokens, getValidAccessToken })';
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-google-refresh-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const refresh = deferred();
  const storage = {
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf8'),
  };
  const api = vm.runInNewContext(tokenFunctions(), {
    fs, path, getUserDataDir: () => userDataDir,
    getSafeStorage: () => storage,
    migrateLegacyCredentialFile: () => {},
    refreshAccessToken: () => refresh.promise,
    mainWindow: null,
    console: { log() {}, error() {} },
  });
  const tokenPath = path.join(userDataDir, '.google-tokens');
  const seed = (accessToken = 'old-access') => api.saveGoogleTokens({
    access_token: accessToken, refresh_token: 'old-refresh', email: 'synthetic@example.test',
    expires_at: 1,
  });
  return { ...api, refresh, seed, tokenPath };
}

test('a normal Google refresh saves the new access token', async (t) => {
  const h = harness(t);
  h.seed();
  const pending = h.getValidAccessToken();
  h.refresh.resolve({ access_token: 'new-access', expires_in: 3600 });
  assert.equal(await pending, 'new-access');
  assert.equal(h.loadGoogleTokens().access_token, 'new-access');
  assert.equal(h.loadGoogleTokens().refresh_token, 'old-refresh');
});

test('concurrent Google refresh callers both receive a token', async (t) => {
  const h = harness(t);
  h.seed();
  const first = h.getValidAccessToken();
  const second = h.getValidAccessToken();
  h.refresh.resolve({ access_token: 'new-access', expires_in: 3600 });
  assert.deepEqual(await Promise.all([first, second]), ['new-access', 'new-access']);
  assert.equal(h.loadGoogleTokens().access_token, 'new-access');
});

test('a refresh resolving after disconnect cannot restore Google tokens', async (t) => {
  const h = harness(t);
  h.seed();
  const pending = h.getValidAccessToken();
  h.deleteGoogleTokens();
  h.refresh.resolve({ access_token: 'stale-access', expires_in: 3600 });
  assert.equal(await pending, null);
  assert.equal(fs.existsSync(h.tokenPath), false);
});

test('a stale invalid_grant after reconnect cannot delete the new connection', async (t) => {
  const h = harness(t);
  h.seed();
  const pending = h.getValidAccessToken();
  h.deleteGoogleTokens();
  h.seed('new-connection');
  h.refresh.reject(new Error('invalid_grant'));
  assert.equal(await pending, null);
  assert.equal(h.loadGoogleTokens().access_token, 'new-connection');
});

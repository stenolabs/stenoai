'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { writePackage, readPackage } = require('./meeting-transfer-codec');
const { registerMeetingTransferIpc } = require('./meeting-transfer-ipc');
const ID = '11111111-2222-4333-8444-555555555555';
async function setup(t, { platform = 'darwin', busy = false, findAudio, onSave, fingerprint } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steno-transfer-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const handlers = {};
  const app = new EventEmitter();
  app.getVersion = () => 'test';
  const webContents = new EventEmitter();
  const events = [];
  webContents.send = (channel, value) => { events.push({ channel, value }); };
  const win = { webContents, isDestroyed: () => false };
  let response = 0;
  let checkBox = false;
  let source = null;
  let shared = null;
  const meeting = { session_info: { name: 'Synthetic export' }, user_notes: 'Synthetic agenda', transcript: 'Synthetic transcript' };
  const file = path.join(root, 'fixture.stenomeeting');
  await writePackage(file, { meeting: { sourceMeetingID: ID, title: 'Synthetic meeting', createdAt: 500000000, sourceStatus: 'ready' }, notes: 'Synthetic agenda' });
  const destination = path.join(root, 'export.stenomeeting');
  const service = registerMeetingTransferIpc({
    app, platform,
    ipcMain: { handle: (name, callback) => { handlers[name] = callback; } },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [file] }),
      showMessageBox: async () => ({ response, checkboxChecked: checkBox }),
      showSaveDialog: async () => { if (onSave) await onSave(); return { canceled: false, filePath: destination }; },
    },
    getMainWindow: () => win, exposeMainWindow() {}, isBusy: () => busy,
    getOutputDir: () => path.join(root, 'output'), getUserDataDir: () => root,
    readMeeting: async () => ({ realPath: path.join(root, 'output', 'original_summary.json'), fingerprint: fingerprint ? fingerprint() : 'same',
      meeting }),
    findAudioSource: findAudio || (async () => source),
    prepareAudio: async () => { throw new Error('Audio must not be read without selection'); },
    makeShareMenu: (items) => ({ popup: () => { shared = items; } }),
  });
  return { root, app, events, webContents, file, destination, service, meeting,
    invoke: (name, ...args) => handlers[name]({ sender: webContents }, ...args),
    response: value => { response = value; }, shared: () => shared,
    source: value => { source = value; },
    includeAudio: value => { checkBox = value; },
  };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected queued transfer completion');
}
test('cold open-file waits for subscribed renderer, reload waits for a fresh ready handshake', async t => {
  const ctx = await setup(t);
  let prevented = false;
  ctx.app.emit('open-file', { preventDefault() { prevented = true; } }, ctx.file);
  assert.equal(prevented, true);
  assert.equal(ctx.events.length, 0);
  await ctx.invoke('meeting-transfer-ready');
  await until(() => ctx.events.length === 1);
  assert.equal(ctx.events[0].channel, 'meeting-transfer-imported');
  ctx.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  ctx.service.openFile(ctx.file);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ctx.events.length, 1);
  await ctx.invoke('meeting-transfer-ready');
  await until(() => ctx.events.length === 2);
  assert.equal(ctx.events[1].value.duplicate, true);
});
test('same-document meeting navigation and subframe loads keep the import listener ready', async t => {
  const ctx = await setup(t);
  await ctx.invoke('meeting-transfer-ready');
  ctx.service.openFile(ctx.file);
  await until(() => ctx.events.length === 1);
  // Electron emits did-start-loading even for the React hash-route change.
  ctx.webContents.emit('did-start-loading');
  ctx.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  ctx.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  ctx.service.openFile(ctx.file);
  await until(() => ctx.events.length === 2);
  assert.equal(ctx.events[1].value.duplicate, true);
});
test('import cancellation leaves no library, and busy states reject before dialogs', async t => {
  const ctx = await setup(t);
  ctx.response(1);
  assert.equal((await ctx.invoke('import-meeting-package', ctx.file)).cancelled, true);
  await assert.rejects(fs.stat(path.join(ctx.root, 'output')), { code: 'ENOENT' });
  const blocked = await setup(t, { busy: true });
  assert.equal((await blocked.invoke('import-meeting-package', blocked.file)).error_code, 'busy');
  assert.equal(blocked.events.length, 0);
});
test('non-macOS readiness is harmless, while transfer operations remain unavailable', async t => {
  const ctx = await setup(t, { platform: 'win32' });
  assert.equal((await ctx.invoke('meeting-transfer-ready')).success, true);
  assert.equal((await ctx.invoke('import-meeting-package', ctx.file)).error_code, 'unsupported_platform');
  assert.equal(ctx.app.listenerCount('open-file'), 0);
});
test('export excludes available audio by default and shares only the completed saved file', async t => {
  const ctx = await setup(t);
  ctx.source('/synthetic/recording.wav');
  const result = await ctx.invoke('export-meeting-package', 'synthetic');
  assert.equal(result.success, true);
  assert.deepEqual(ctx.shared(), { filePaths: [ctx.destination] });
  const pkg = await readPackage(ctx.destination);
  try {
    assert.equal(pkg.audio.length, 0);
    assert.equal(pkg.notes, 'Synthetic agenda');
  } finally { await pkg.cleanup(); }
});
test('text-only export succeeds when imported audio is unavailable; selecting it fails safely', async t => {
  const ctx = await setup(t);
  ctx.meeting.steno_transfer = { sourceMeetingID: ID, audio: [{ name: 'track-1.caf' }] };
  assert.equal((await ctx.invoke('export-meeting-package', 'synthetic')).success, true);
  const pkg = await readPackage(ctx.destination);
  try { assert.equal(pkg.audio.length, 0); } finally { await pkg.cleanup(); }
  await fs.rm(ctx.destination);
  ctx.includeAudio(true);
  assert.equal((await ctx.invoke('export-meeting-package', 'synthetic')).error_code, 'unsafe_storage');
  await assert.rejects(fs.stat(ctx.destination), { code: 'ENOENT' });
});

test('a recording mutated during copy reports source_changed', async t => {
  const { copyRegularFile } = require('./meeting-transfer-ipc');
  const ctx = await setup(t);
  const source = path.join(ctx.root, 'copy.wav');
  await fs.writeFile(source, Buffer.alloc(100000));
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === source) {
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) { changed = true; await fs.appendFile(source, 'mutation'); }
        return result;
      };
    }
    return handle;
  };
  try { await assert.rejects(copyRegularFile(source, path.join(ctx.root, 'copy.caf')), { code: 'source_changed' }); }
  finally { fs.open = originalOpen; }
});


test('unavailable recording storage does not block a text-only export', async t => {
  const ctx = await setup(t, { findAudio: async () => { throw { code: 'unsafe_storage' }; } });
  assert.equal((await ctx.invoke('export-meeting-package', 'synthetic')).success, true);
  const pkg = await readPackage(ctx.destination);
  try { assert.equal(pkg.audio.length, 0); } finally { await pkg.cleanup(); }
});

test('audio storage is revalidated after the save dialog', async t => {
  let replaced = false;
  const ctx = await setup(t, {
    findAudio: async () => { if (replaced) throw { code: 'unsafe_storage' }; return '/synthetic/recording.wav'; },
    onSave: () => { replaced = true; },
  });
  ctx.includeAudio(true);
  assert.equal((await ctx.invoke('export-meeting-package', 'synthetic')).error_code, 'unsafe_storage');
  await assert.rejects(fs.stat(ctx.destination), { code: 'ENOENT' });
});

test('autosave during the dialog reports a changed source instead of busy', async t => {
  let version = 'before';
  const ctx = await setup(t, { fingerprint: () => version, onSave: () => { version = 'after'; } });
  assert.equal((await ctx.invoke('export-meeting-package', 'synthetic')).error_code, 'source_changed');
});

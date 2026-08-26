'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerFoldersIpc } = require('./folders-ipc');

// Minimal fakes: capture handlers by channel, record backend calls, and let
// each test drive one handler and assert its argv/seam usage. No electron.
function harness(overrides = {}) {
  const handlers = {};
  const calls = { py: [], setCache: [], dialog: [], validate: [], noteFoldersChanged: [] };
  const deps = {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    runPythonScript: async (script, args, silent) => {
      calls.py.push({ script, args, silent });
      if (overrides.pyThrows) throw new Error(overrides.pyThrows);
      // Record that the setter had NOT yet fired at backend-return time, so the
      // set-storage-path test can pin "setter runs after the backend call".
      calls.setCacheAtPyReturn = calls.setCache.length;
      return overrides.pyResult ?? '{"success": true}';
    },
    dialog: {
      showOpenDialog: async (win, opts) => {
        calls.dialog.push({ win, opts });
        return overrides.dialogResult ?? { canceled: false, filePaths: ['/picked/dir'] };
      },
    },
    getMainWindow: () => overrides.mainWindow ?? { id: 'win' },
    getUserDataDir: () => overrides.userDataDir ?? '/default/data',
    validateMeetingFilePath: async (p) => {
      calls.validate.push(p);
      return overrides.validate ?? { realPath: `/real/${p}` };
    },
    setCachedCustomStoragePath: (v) => { calls.setCache.push(v); },
    onNoteFoldersChanged: (p) => { calls.noteFoldersChanged.push(p); },
  };
  registerFoldersIpc(deps);
  return { handlers, calls };
}

const CHANNELS = [
  'get-storage-path', 'set-storage-path', 'select-storage-folder',
  'list-folders', 'create-folder', 'rename-folder', 'update-folder-icon',
  'delete-folder', 'reorder-folders', 'add-meeting-to-folder',
  'remove-meeting-from-folder', 'set-folder-template', 'set-folder-recurring',
];

test('registers exactly the 13 folder + storage handlers', () => {
  const { handlers } = harness();
  assert.deepStrictEqual(Object.keys(handlers).sort(), [...CHANNELS].sort());
});

test('list-folders calls the backend silently and spreads the parsed result', async () => {
  const { handlers, calls } = harness({ pyResult: '{"folders": [{"id": "a"}]}' });
  const res = await handlers['list-folders']();
  assert.deepStrictEqual(calls.py[0], { script: 'simple_recorder.py', args: ['list-folders'], silent: true });
  assert.deepStrictEqual(res, { success: true, folders: [{ id: 'a' }] });
});

test('create-folder appends --color only when a color is given', async () => {
  const withColor = harness();
  await withColor.handlers['create-folder']({}, 'Work', '#fff');
  assert.deepStrictEqual(withColor.calls.py[0].args, ['create-folder', 'Work', '--color', '#fff']);

  const noColor = harness();
  await noColor.handlers['create-folder']({}, 'Work', undefined);
  assert.deepStrictEqual(noColor.calls.py[0].args, ['create-folder', 'Work']);
});

test('rename / update-icon / delete pass their ids through verbatim', async () => {
  const h = harness();
  await h.handlers['rename-folder']({}, 'id1', 'New');
  await h.handlers['update-folder-icon']({}, 'id1', '📁');
  await h.handlers['delete-folder']({}, 'id1');
  assert.deepStrictEqual(h.calls.py[0].args, ['rename-folder', 'id1', 'New']);
  assert.deepStrictEqual(h.calls.py[1].args, ['update-folder-icon', 'id1', '📁']);
  assert.deepStrictEqual(h.calls.py[2].args, ['delete-folder', 'id1']);
  // Mutations stream to the debug panel — they must NOT pass silent:true.
  assert.ok(h.calls.py.every((c) => !c.silent));
});

test('reorder-folders spreads the id list into the argv', async () => {
  const h = harness();
  await h.handlers['reorder-folders']({}, ['a', 'b', 'c']);
  assert.deepStrictEqual(h.calls.py[0].args, ['reorder-folders', 'a', 'b', 'c']);
});

test('add-meeting-to-folder validates the path and forwards the canonical realPath', async () => {
  const h = harness({ validate: { realPath: '/real/output/m.json' } });
  const res = await h.handlers['add-meeting-to-folder']({}, 'output/m.json', 'fid');
  assert.deepStrictEqual(h.calls.validate, ['output/m.json']);
  assert.deepStrictEqual(h.calls.py[0].args, ['add-meeting-to-folder', '/real/output/m.json', 'fid']);
  assert.strictEqual(res.success, true);
});

test('add-meeting-to-folder rejects a failed path validation without calling the backend', async () => {
  const h = harness({ validate: { error: 'outside allowed dirs' } });
  const res = await h.handlers['add-meeting-to-folder']({}, '../evil', 'fid');
  assert.deepStrictEqual(res, { success: false, error: 'outside allowed dirs' });
  assert.strictEqual(h.calls.py.length, 0);
});

test('remove-meeting-from-folder mirrors the validate-then-forward contract', async () => {
  const ok = harness({ validate: { realPath: '/real/output/m.json' } });
  await ok.handlers['remove-meeting-from-folder']({}, 'output/m.json', 'fid');
  assert.deepStrictEqual(ok.calls.py[0].args, ['remove-meeting-from-folder', '/real/output/m.json', 'fid']);

  const bad = harness({ validate: { error: 'nope' } });
  const res = await bad.handlers['remove-meeting-from-folder']({}, 'x', 'fid');
  assert.deepStrictEqual(res, { success: false, error: 'nope' });
  assert.strictEqual(bad.calls.py.length, 0);
});

test('get-storage-path augments the custom path with the injected default', async () => {
  const custom = harness({ pyResult: '{"storage_path": "/my/vault"}', userDataDir: '/default/data' });
  const res = await custom.handlers['get-storage-path']();
  assert.deepStrictEqual(custom.calls.py[0], { script: 'simple_recorder.py', args: ['get-storage-path'], silent: true });
  assert.deepStrictEqual(res, {
    success: true, storage_path: '/my/vault', custom_path: '/my/vault', default_path: '/default/data',
  });

  const none = harness({ pyResult: '{"storage_path": ""}', userDataDir: '/default/data' });
  const res2 = await none.handlers['get-storage-path']();
  assert.deepStrictEqual(res2, {
    success: true, storage_path: '/default/data', custom_path: null, default_path: '/default/data',
  });
});

test('set-storage-path updates the injected cache setter (set-path -> reader regression)', async () => {
  const h = harness({ pyResult: '{"success": true, "storage_path": "/vault"}' });
  await h.handlers['set-storage-path']({}, '/vault');
  assert.deepStrictEqual(h.calls.py[0].args, ['set-storage-path', '/vault']);
  assert.deepStrictEqual(h.calls.setCache, ['/vault']);
  // The setter fires AFTER the backend call (0 setter calls at backend return).
  assert.strictEqual(h.calls.setCacheAtPyReturn, 0);

  // Clearing to default: empty path -> null cache, and the setter still fires.
  const cleared = harness({ pyResult: '{"success": true}' });
  await cleared.handlers['set-storage-path']({}, '');
  assert.deepStrictEqual(cleared.calls.py[0].args, ['set-storage-path']); // no path arg appended
  assert.deepStrictEqual(cleared.calls.setCache, [null]);
});

test('set-storage-path does NOT touch the cache when the backend fails', async () => {
  const h = harness({ pyThrows: 'disk full' });
  const res = await h.handlers['set-storage-path']({}, '/vault');
  assert.deepStrictEqual(res, { success: false, error: 'disk full' });
  assert.deepStrictEqual(h.calls.setCache, []); // cache untouched on failure
});

test('select-storage-folder opens the dialog parented to the injected window', async () => {
  const picked = harness({ mainWindow: { id: 'main' }, dialogResult: { canceled: false, filePaths: ['/chosen'] } });
  const res = await picked.handlers['select-storage-folder']();
  assert.deepStrictEqual(picked.calls.dialog[0].win, { id: 'main' });
  // Pin the dialog options — a directory picker with create-folder affordance.
  assert.deepStrictEqual(picked.calls.dialog[0].opts.properties, ['openDirectory', 'createDirectory']);
  assert.strictEqual(picked.calls.dialog[0].opts.buttonLabel, 'Select Folder');
  assert.deepStrictEqual(res, { success: true, folderPath: '/chosen' });

  const canceled = harness({ dialogResult: { canceled: true, filePaths: [] } });
  const res2 = await canceled.handlers['select-storage-folder']();
  assert.deepStrictEqual(res2, { success: false, error: 'No folder selected' });
});

test('backend failures surface as { success:false, error } (not a throw)', async () => {
  const { handlers } = harness({ pyThrows: 'backend exploded' });
  const res = await handlers['list-folders']();
  assert.deepStrictEqual(res, { success: false, error: 'backend exploded' });
});

test('set-folder-template passes template_id or none when cleared', async () => {
  const withTpl = harness();
  await withTpl.handlers['set-folder-template']({}, 'fid1', '1-on-1');
  assert.deepStrictEqual(withTpl.calls.py[0].args, ['set-folder-template', 'fid1', '1-on-1']);

  const withNone = harness();
  await withNone.handlers['set-folder-template']({}, 'fid1', 'none');
  assert.deepStrictEqual(withNone.calls.py[0].args, ['set-folder-template', 'fid1', 'none']);

  const withNull = harness();
  await withNull.handlers['set-folder-template']({}, 'fid1', null);
  assert.deepStrictEqual(withNull.calls.py[0].args, ['set-folder-template', 'fid1', 'none']);

  const withEmpty = harness();
  await withEmpty.handlers['set-folder-template']({}, 'fid1', '');
  assert.deepStrictEqual(withEmpty.calls.py[0].args, ['set-folder-template', 'fid1', 'none']);
});

test('set-folder-template validates folderId and templateId', async () => {
  const badFolder = harness();
  const resFolder = await badFolder.handlers['set-folder-template']({}, '', '1-on-1');
  assert.deepStrictEqual(resFolder, { success: false, error: 'Invalid folder ID' });
  assert.strictEqual(badFolder.calls.py.length, 0);

  const badFolderType = harness();
  const resFolderType = await badFolderType.handlers['set-folder-template']({}, null, '1-on-1');
  assert.deepStrictEqual(resFolderType, { success: false, error: 'Invalid folder ID' });
  assert.strictEqual(badFolderType.calls.py.length, 0);

  const badTemplate = harness();
  const resTemplate = await badTemplate.handlers['set-folder-template']({}, 'fid1', 123);
  assert.deepStrictEqual(resTemplate, { success: false, error: 'Invalid template ID' });
  assert.strictEqual(badTemplate.calls.py.length, 0);
});

test('set-folder-recurring passes repeated --title flags and supports --clear', async () => {
  const withTitles = harness();
  await withTitles.handlers['set-folder-recurring']({}, 'fid1', ['Weekly 1:1', 'Team Standup']);
  assert.deepStrictEqual(withTitles.calls.py[0].args, [
    'set-folder-recurring', 'fid1', '--title', 'Weekly 1:1', '--title', 'Team Standup',
  ]);

  const emptyTitles = harness();
  await emptyTitles.handlers['set-folder-recurring']({}, 'fid1', []);
  assert.deepStrictEqual(emptyTitles.calls.py[0].args, ['set-folder-recurring', 'fid1', '--clear']);

  const whitespaceTitles = harness();
  await whitespaceTitles.handlers['set-folder-recurring']({}, 'fid1', ['', '   ']);
  assert.deepStrictEqual(whitespaceTitles.calls.py[0].args, ['set-folder-recurring', 'fid1', '--clear']);
});

test('set-folder-recurring validates folderId and titles array', async () => {
  const badFolder = harness();
  const resFolder = await badFolder.handlers['set-folder-recurring']({}, '', ['Sync']);
  assert.deepStrictEqual(resFolder, { success: false, error: 'Invalid folder ID' });
  assert.strictEqual(badFolder.calls.py.length, 0);

  const badTitles = harness();
  const resTitles = await badTitles.handlers['set-folder-recurring']({}, 'fid1', 'not an array');
  assert.deepStrictEqual(resTitles, { success: false, error: 'Invalid titles: expected array' });
  assert.strictEqual(badTitles.calls.py.length, 0);

  const badTitleElem = harness();
  const resElem = await badTitleElem.handlers['set-folder-recurring']({}, 'fid1', [123]);
  assert.deepStrictEqual(resElem, { success: false, error: 'Invalid titles: expected array of strings' });
  assert.strictEqual(badTitleElem.calls.py.length, 0);
});

test('onNoteFoldersChanged notification fires only when note membership changes', async () => {
  const h = harness({ validate: { realPath: '/real/output/note.md' } });
  await h.handlers['add-meeting-to-folder']({}, 'output/note.md', 'fid1');
  assert.deepStrictEqual(h.calls.noteFoldersChanged, ['/real/output/note.md']);

  await h.handlers['remove-meeting-from-folder']({}, 'output/note.md', 'fid1');
  assert.deepStrictEqual(h.calls.noteFoldersChanged, ['/real/output/note.md', '/real/output/note.md']);

  // Folder metadata / template / recurring updates do not fire onNoteFoldersChanged
  await h.handlers['set-folder-template']({}, 'fid1', '1-on-1');
  await h.handlers['set-folder-recurring']({}, 'fid1', ['Sync']);
  await h.handlers['rename-folder']({}, 'fid1', 'Renamed');
  assert.strictEqual(h.calls.noteFoldersChanged.length, 2);
});

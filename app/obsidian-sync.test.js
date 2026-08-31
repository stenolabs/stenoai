// Unit tests for the Obsidian sync engine (app/obsidian-sync.js). No Electron,
// no model — a temp dir stands in for the vault and the data dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  registerObsidianSync, transformNote, deriveFilename, sanitizeFilename, parseFrontmatter,
} = require('./obsidian-sync');

const NOTE = `---
title: "Acme Q3 Planning"
date: 2026-07-15T14:00:00
is_diarised: true
folders: ["fold1234"]
---

## Summary

Ship the pricing page Friday. Bob owns the release notes.

## Participants

Alice, Bob

## Action Items

- Bob: draft release notes

## Transcript

[You] we ship Friday.
[Others] I'll prep the notes.

## User Notes

Follow up Monday.
`;

// --- pure helpers ----------------------------------------------------------

test('parseFrontmatter reads line-based frontmatter + JSON folders array', () => {
  const { fm, body } = parseFrontmatter(NOTE);
  assert.equal(fm.title, 'Acme Q3 Planning');
  assert.equal(fm.folders, '["fold1234"]');
  assert.ok(body.startsWith('## Summary'));
});

test('transformNote strips transcript, lifts participants, adds Obsidian props', () => {
  const { vaultBody, title, dateStr, folderName } = transformNote(NOTE, {
    stem: '20260715-1400_acme',
    resolveFolderName: (id) => (id === 'fold1234' ? 'Sales' : null),
  });
  assert.equal(title, 'Acme Q3 Planning');
  assert.equal(dateStr, '2026-07-15');
  assert.equal(folderName, 'Sales');
  assert.match(vaultBody, /source: Steno/);
  assert.match(vaultBody, /steno_stem: "20260715-1400_acme"/);
  assert.match(vaultBody, /folder: "Sales"/);
  assert.match(vaultBody, /participants:\n {2}- "Alice"\n {2}- "Bob"/);
  assert.match(vaultBody, /## User Notes/);
  assert.ok(!/## Transcript/.test(vaultBody), 'transcript section removed');
  assert.ok(!/we ship Friday/.test(vaultBody), 'transcript content removed');
});

test('sanitizeFilename strips fs-hostile chars and falls back to stem', () => {
  assert.equal(sanitizeFilename('A/B: C?', 'stemx'), 'A B C');
  assert.equal(sanitizeFilename('///', 'stemx'), 'stemx');
});

test('deriveFilename disambiguates a collision with the stem', () => {
  const taken = (name) => name === '2026-07-15 Sync.md';
  assert.equal(deriveFilename('2026-07-15', 'Sync', 'abc', () => false), '2026-07-15 Sync.md');
  assert.equal(deriveFilename('2026-07-15', 'Sync', 'abc', taken), '2026-07-15 Sync (abc).md');
});

test('deriveFilename keeps collision names within a cross-platform byte limit', () => {
  const title = 'Planning '.repeat(30);
  const stem = 'recording-'.repeat(20);
  const name = deriveFilename('2026-07-15', title, stem, (candidate) => !candidate.includes('('));
  assert.ok(Buffer.byteLength(name) <= 220, `filename is ${Buffer.byteLength(name)} bytes`);
  assert.match(name, /-[a-f0-9]{8}\)\.md$/);
});

// --- engine (temp vault) ---------------------------------------------------

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
  const dataDir = path.join(root, 'data');
  const vault = path.join(root, 'vault');
  const output = path.join(dataDir, 'output');
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'folders.json'),
    JSON.stringify({ folders: [{ id: 'fold1234', name: 'Sales' }] }));
  const eng = registerObsidianSync({
    getUserDataDir: () => dataDir,
    getAllowedBaseDirs: () => [dataDir],
    validateSafeFilePath: () => true,
    resolveFoldersJsonPath: () => path.join(dataDir, 'folders.json'),
  });
  eng.setCachedConfig({ enabled: true, vaultPath: vault });
  const writeNote = (stem, content) =>
    fs.writeFileSync(path.join(output, `${stem}_summary.md`), content);
  return { root, dataDir, vault, output, eng, writeNote };
}

test('off by default: no write, no state file when disabled', () => {
  const h = harness();
  h.eng.setCachedConfig({ enabled: false, vaultPath: h.vault });
  h.writeNote('n1', NOTE);
  assert.equal(h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md')).status, 'disabled');
  assert.deepEqual(fs.readdirSync(h.vault), []);
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('sync writes a readable file under the folder subdir', () => {
  const h = harness();
  h.writeNote('n1', NOTE);
  const r = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  assert.equal(r.status, 'synced');
  const target = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  assert.ok(fs.existsSync(target), 'file under Sales/ with readable name');
  assert.match(fs.readFileSync(target, 'utf8'), /source: Steno/);
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('an unchanged vault note heals a stale index before checking for edits', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const target = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  const idx = h.eng.loadIndex();
  const expectedHash = idx.notes.n1.lastWrittenHash;
  idx.notes.n1.lastWrittenHash = 'stale-after-crash';
  h.eng.saveIndex(idx);

  const result = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'), { onConflict: 'fork' });

  assert.equal(result.status, 'synced');
  assert.equal(h.eng.loadIndex().notes.n1.lastWrittenHash, expectedHash);
  assert.equal(fs.readdirSync(path.join(h.vault, 'Sales')).length, 1, 'no replacement was forked');
});

test('a healthy destination is read once for an unchanged sync and an update', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const target = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  const readFileSync = fs.readFileSync;
  let unchangedReads = 0;
  let updateReads = 0;
  let phase = 'unchanged';
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (filePath === target) {
      if (phase === 'unchanged') unchangedReads += 1;
      else updateReads += 1;
    }
    return readFileSync.call(this, filePath, ...args);
  };
  try {
    assert.equal(h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md')).status, 'synced');
    phase = 'update';
    h.writeNote('n1', NOTE.replace('Ship the pricing page Friday.', 'Ship the pricing page Thursday.'));
    assert.equal(h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md')).status, 'synced');
  } finally {
    fs.readFileSync = readFileSync;
  }

  assert.equal(unchangedReads, 1);
  assert.equal(updateReads, 1);
});

test('backfillAll mirrors every existing note (one-time export on enable)', async () => {
  const h = harness();
  h.writeNote('n1', NOTE);
  h.writeNote('n2', NOTE.replace('Acme Q3 Planning', 'Second Note'));
  const r = await h.eng.backfillAll();
  assert.equal(r.status, 'done');
  assert.equal(r.count, 2);
  assert.ok(fs.existsSync(path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md')));
  assert.ok(fs.existsSync(path.join(h.vault, 'Sales', '2026-07-15 Second Note.md')));
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('a Steno folder named ".." cannot write outside the vault', () => {
  const h = harness();
  // Point the note at a folder whose name is "..".
  fs.writeFileSync(path.join(h.dataDir, 'folders.json'),
    JSON.stringify({ folders: [{ id: 'evil', name: '..' }] }));
  h.writeNote('n1', NOTE.replace('"fold1234"', '"evil"'));
  const r = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  assert.equal(r.status, 'synced');
  // Nothing was written to the vault's PARENT dir.
  const parentMd = fs.readdirSync(path.dirname(h.vault)).filter((f) => f.endsWith('.md'));
  assert.deepEqual(parentMd, [], 'no note escaped to the vault parent');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('title change renames the vault file (no orphan)', () => {
  const h = harness();
  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const oldPath = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  assert.ok(fs.existsSync(oldPath));
  h.writeNote('n1', NOTE.replace('Acme Q3 Planning', 'Acme Renamed'));
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  assert.ok(!fs.existsSync(oldPath), 'old filename gone');
  assert.ok(fs.existsSync(path.join(h.vault, 'Sales', '2026-07-15 Acme Renamed.md')), 'renamed');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('external edit is not clobbered; conflict recorded', () => {
  const h = harness();
  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const target = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(target, 'MY OWN OBSIDIAN EDIT');
  h.writeNote('n1', NOTE.replace('Friday', 'Thursday'));
  const r = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  assert.equal(r.status, 'conflict');
  assert.equal(fs.readFileSync(target, 'utf8'), 'MY OWN OBSIDIAN EDIT', 'edit preserved');
  assert.ok(h.eng.loadIndex().conflicts.n1, 'conflict flagged');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('reprocess conflict preserves the Obsidian edit and writes a stable replacement', async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const original = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(original, 'HAND-EDITED IN OBSIDIAN');

  h.writeNote('n1', NOTE.replace('Ship the pricing page Friday.', 'Ship the pricing page Thursday.'));
  assert.equal(
    h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md')).status,
    'conflict',
    'an ordinary sync records the active conflict before reprocessing',
  );
  const result = h.eng.syncNoteBySummaryPath(
    path.join(h.output, 'n1_summary.md'),
    { onConflict: 'fork' },
  );

  assert.equal(result.status, 'forked');
  assert.equal(h.eng.loadIndex().conflicts.n1, undefined, 'fork resolves the active conflict');
  assert.equal(result.preservedVaultRelPath, path.join('Sales', '2026-07-15 Acme Q3 Planning.md'));
  assert.equal(result.vaultRelPath, path.join('Sales', '2026-07-15 Acme Q3 Planning (n1).md'));
  assert.equal(fs.readFileSync(original, 'utf8'), 'HAND-EDITED IN OBSIDIAN');
  assert.match(
    fs.readFileSync(path.join(h.vault, result.vaultRelPath), 'utf8'),
    /Ship the pricing page Thursday\./,
  );

  // The replacement becomes the tracked mirror. A later sync updates it in
  // place instead of creating a chain of additional conflict copies.
  h.writeNote('n1', NOTE.replace('Ship the pricing page Friday.', 'Ship the pricing page Wednesday.'));
  const next = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  assert.equal(next.status, 'synced');
  assert.equal(h.eng.loadIndex().notes.n1.vaultRelPath, result.vaultRelPath);
  assert.deepEqual(
    fs.readdirSync(path.join(h.vault, 'Sales')).sort(),
    ['2026-07-15 Acme Q3 Planning (n1).md', '2026-07-15 Acme Q3 Planning.md'],
  );
  assert.equal(
    Object.values(h.eng.loadIndex().conflicts).filter(
      (conflict) => conflict.reason === 'external-edit-preserved',
    ).length,
    1,
    'ordinary sync keeps the preserved-copy history',
  );

  await h.eng.reconcileOnLaunch();
  assert.equal(
    Object.values(h.eng.loadIndex().conflicts).filter(
      (conflict) => conflict.reason === 'external-edit-preserved',
    ).length,
    1,
    'launch reconciliation keeps the preserved-copy history',
  );

  fs.unlinkSync(original);
  await h.eng.reconcileOnLaunch();
  assert.equal(
    Object.values(h.eng.loadIndex().conflicts).filter(
      (conflict) => conflict.reason === 'external-edit-preserved',
    ).length,
    0,
    'launch reconciliation drops history after the preserved file is removed',
  );
});

test('reprocess preserves a vault edit when Windows briefly locks the tracked file', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const original = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(original, 'HAND-EDITED IN OBSIDIAN');
  h.writeNote('n1', NOTE.replace('Ship the pricing page Friday.', 'Ship the pricing page Thursday.'));

  // Windows Defender or an indexer can momentarily make the tracked file
  // unreadable. Two reads used to interpret that as both "not edited" and
  // "not present", then overwrite the user's edit instead of forking it.
  const readFileSync = fs.readFileSync;
  let transientReadFailures = 2;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (filePath === original && transientReadFailures > 0) {
      transientReadFailures -= 1;
      const error = new Error('temporarily locked');
      error.code = 'EBUSY';
      throw error;
    }
    return readFileSync.call(this, filePath, ...args);
  };
  let result;
  try {
    result = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'), { onConflict: 'fork' });
  } finally {
    fs.readFileSync = readFileSync;
  }

  assert.equal(result.status, 'forked');
  assert.equal(fs.readFileSync(original, 'utf8'), 'HAND-EDITED IN OBSIDIAN');
  assert.match(
    fs.readFileSync(path.join(h.vault, result.vaultRelPath), 'utf8'),
    /Ship the pricing page Thursday\./,
  );
});

test('loadIndex treats malformed JSON as corruption rather than an I/O failure', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(h.dataDir, '.obsidian-sync-state.json'), '{not-json');

  assert.deepEqual(h.eng.loadIndex(), {
    version: 1,
    notes: {},
    conflicts: {},
    stale: [],
  });
});

test('reprocess retries a transient Windows lock on the ownership index', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const original = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  const state = path.join(h.dataDir, '.obsidian-sync-state.json');
  fs.writeFileSync(original, 'HAND-EDITED IN OBSIDIAN');
  h.writeNote('n1', NOTE.replace('Ship the pricing page Friday.', 'Ship the pricing page Thursday.'));

  const readFileSync = fs.readFileSync;
  let stateReads = 0;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (filePath === state && stateReads < 2) {
      stateReads += 1;
      const error = new Error('temporarily locked ownership index');
      error.code = 'EBUSY';
      throw error;
    }
    if (filePath === state) stateReads += 1;
    return readFileSync.call(this, filePath, ...args);
  };
  let result;
  try {
    result = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'), { onConflict: 'fork' });
  } finally {
    fs.readFileSync = readFileSync;
  }

  assert.equal(stateReads, 3, 'one attempt plus two bounded retries');
  assert.equal(result.status, 'forked');
  assert.equal(fs.readFileSync(original, 'utf8'), 'HAND-EDITED IN OBSIDIAN');
  assert.match(
    fs.readFileSync(path.join(h.vault, result.vaultRelPath), 'utf8'),
    /Ship the pricing page Thursday\./,
  );
});

test('persistent ownership-index read errors fail closed without changing vault or index', async (t) => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const h = harness();
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

    h.writeNote('n1', NOTE);
    h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
    const original = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
    const state = path.join(h.dataDir, '.obsidian-sync-state.json');
    fs.writeFileSync(original, 'HAND-EDITED IN OBSIDIAN');
    h.writeNote('n1', NOTE.replace('Ship the pricing page Friday.', 'Ship the pricing page Thursday.'));
    const stateBefore = fs.readFileSync(state, 'utf8');
    const vaultBefore = fs.readdirSync(path.dirname(original)).sort();

    const readFileSync = fs.readFileSync;
    let stateReads = 0;
    fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
      if (filePath === state) {
        stateReads += 1;
        const error = new Error(`persistently locked ownership index (${code})`);
        error.code = code;
        throw error;
      }
      return readFileSync.call(this, filePath, ...args);
    };
    let syncResult;
    let removeResult;
    let reconcileResult;
    try {
      syncResult = h.eng.syncNoteBySummaryPath(
        path.join(h.output, 'n1_summary.md'),
        { onConflict: 'fork' },
      );
      removeResult = h.eng.removeNoteBySummaryPath('n1');
      reconcileResult = await h.eng.reconcileOnLaunch();
    } finally {
      fs.readFileSync = readFileSync;
    }

    assert.equal(syncResult.status, 'error', `sync: ${code}`);
    assert.equal(removeResult.status, 'error', `remove: ${code}`);
    assert.equal(reconcileResult.status, 'error', `reconcile: ${code}`);
    assert.equal(stateReads, code === 'EACCES' ? 3 : 9, code);
    assert.equal(fs.readFileSync(state, 'utf8'), stateBefore, code);
    assert.deepEqual(fs.readdirSync(path.dirname(original)).sort(), vaultBefore, code);
    assert.equal(fs.readFileSync(original, 'utf8'), 'HAND-EDITED IN OBSIDIAN', code);
  }
});

test('a persistently locked vault read forks without a long retry', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const original = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(original, 'HAND-EDITED IN OBSIDIAN');
  h.writeNote('n1', NOTE.replace('Ship the pricing page Friday.', 'Ship the pricing page Thursday.'));

  const readFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (filePath === original) {
      reads += 1;
      const error = new Error('persistently locked');
      error.code = 'EBUSY';
      throw error;
    }
    return readFileSync.call(this, filePath, ...args);
  };
  let result;
  const startedAt = Date.now();
  try {
    result = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'), { onConflict: 'fork' });
  } finally {
    fs.readFileSync = readFileSync;
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 'forked');
  assert.ok(elapsedMs < 250, `persistent read lock blocked for ${elapsedMs}ms`);
  assert.equal(reads, 3, 'one attempt plus the two bounded retries');
  assert.equal(fs.readFileSync(original, 'utf8'), 'HAND-EDITED IN OBSIDIAN');
  assert.match(
    fs.readFileSync(path.join(h.vault, result.vaultRelPath), 'utf8'),
    /Ship the pricing page Thursday\./,
  );
});

test('an access-denied vault read forks without retrying', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const original = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(original, 'HAND-EDITED IN OBSIDIAN');
  h.writeNote('n1', NOTE.replace('Ship the pricing page Friday.', 'Ship the pricing page Thursday.'));

  const readFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (filePath === original) {
      reads += 1;
      const error = new Error('access denied');
      error.code = 'EACCES';
      throw error;
    }
    return readFileSync.call(this, filePath, ...args);
  };
  let result;
  try {
    result = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'), { onConflict: 'fork' });
  } finally {
    fs.readFileSync = readFileSync;
  }

  assert.equal(result.status, 'forked');
  assert.equal(reads, 1);
  assert.equal(fs.readFileSync(original, 'utf8'), 'HAND-EDITED IN OBSIDIAN');
  assert.match(
    fs.readFileSync(path.join(h.vault, result.vaultRelPath), 'utf8'),
    /Ship the pricing page Thursday\./,
  );
});

test('repeated reprocess conflicts retain every preserved copy in the ledger', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const originalRelPath = path.join('Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(path.join(h.vault, originalRelPath), 'FIRST OBSIDIAN EDIT');

  h.writeNote('n1', NOTE.replace('Friday.', 'Thursday.'));
  const firstFork = h.eng.syncNoteBySummaryPath(
    path.join(h.output, 'n1_summary.md'),
    { onConflict: 'fork' },
  );
  assert.equal(firstFork.status, 'forked');
  fs.writeFileSync(path.join(h.vault, firstFork.vaultRelPath), 'SECOND OBSIDIAN EDIT');

  h.writeNote('n1', NOTE.replace('Friday.', 'Wednesday.'));
  const secondFork = h.eng.syncNoteBySummaryPath(
    path.join(h.output, 'n1_summary.md'),
    { onConflict: 'fork' },
  );
  assert.equal(secondFork.status, 'forked');

  const preserved = Object.values(h.eng.loadIndex().conflicts)
    .filter((conflict) => conflict.reason === 'external-edit-preserved');
  assert.deepEqual(
    preserved.map((conflict) => [
      conflict.vaultRelPath,
      conflict.replacementVaultRelPath,
    ]),
    [
      [originalRelPath, firstFork.vaultRelPath],
      [firstFork.vaultRelPath, secondFork.vaultRelPath],
    ],
  );
  assert.equal(fs.readFileSync(path.join(h.vault, originalRelPath), 'utf8'), 'FIRST OBSIDIAN EDIT');
  assert.equal(
    fs.readFileSync(path.join(h.vault, firstFork.vaultRelPath), 'utf8'),
    'SECOND OBSIDIAN EDIT',
  );
  assert.match(
    fs.readFileSync(path.join(h.vault, secondFork.vaultRelPath), 'utf8'),
    /Ship the pricing page Wednesday\./,
  );
});

test('deleting a forked note keeps the preserved-copy ledger entry', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const originalRelPath = path.join('Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(path.join(h.vault, originalRelPath), 'HAND-EDITED IN OBSIDIAN');
  h.writeNote('n1', NOTE.replace('Friday.', 'Thursday.'));
  const fork = h.eng.syncNoteBySummaryPath(
    path.join(h.output, 'n1_summary.md'),
    { onConflict: 'fork' },
  );

  assert.equal(h.eng.removeNoteBySummaryPath('n1').status, 'removed');
  assert.ok(fs.existsSync(path.join(h.vault, originalRelPath)));
  assert.ok(!fs.existsSync(path.join(h.vault, fork.vaultRelPath)));
  const preserved = Object.values(h.eng.loadIndex().conflicts)
    .filter((conflict) => conflict.reason === 'external-edit-preserved');
  assert.deepEqual(preserved.map((conflict) => conflict.vaultRelPath), [originalRelPath]);
  assert.equal(
    preserved[0].replacementVaultRelPath,
    undefined,
    'history no longer points at the deleted Steno copy',
  );
});

test('renaming a forked note retargets its preserved-copy history', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const originalRelPath = path.join('Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(path.join(h.vault, originalRelPath), 'HAND-EDITED IN OBSIDIAN');
  h.writeNote('n1', NOTE.replace('Friday.', 'Thursday.'));
  const fork = h.eng.syncNoteBySummaryPath(
    path.join(h.output, 'n1_summary.md'),
    { onConflict: 'fork' },
  );

  h.writeNote('n1', NOTE
    .replace('Acme Q3 Planning', 'Acme Renamed')
    .replace('Friday.', 'Thursday.'));
  assert.equal(h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md')).status, 'synced');
  const renamedRelPath = path.join('Sales', '2026-07-15 Acme Renamed.md');
  assert.ok(!fs.existsSync(path.join(h.vault, fork.vaultRelPath)));
  assert.ok(fs.existsSync(path.join(h.vault, renamedRelPath)));

  const preserved = Object.values(h.eng.loadIndex().conflicts)
    .find((conflict) => conflict.reason === 'external-edit-preserved');
  assert.equal(preserved.vaultRelPath, originalRelPath);
  assert.equal(preserved.replacementVaultRelPath, renamedRelPath);

  assert.equal(h.eng.removeNoteBySummaryPath('n1').status, 'removed');
  const afterDelete = Object.values(h.eng.loadIndex().conflicts)
    .find((conflict) => conflict.reason === 'external-edit-preserved');
  assert.equal(afterDelete.replacementVaultRelPath, undefined);
});

test('legacy stem-keyed preserved history survives a healthy sync', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const idx = h.eng.loadIndex();
  const legacyRelPath = path.join('Sales', 'legacy-preserved.md');
  fs.writeFileSync(path.join(h.vault, legacyRelPath), 'LEGACY OBSIDIAN EDIT');
  idx.conflicts.n1 = {
    vaultRelPath: legacyRelPath,
    replacementVaultRelPath: idx.notes.n1.vaultRelPath,
    detectedAt: new Date().toISOString(),
    reason: 'external-edit-preserved',
  };
  h.eng.saveIndex(idx);

  assert.equal(h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md')).status, 'synced');
  const migrated = h.eng.loadIndex().conflicts;
  assert.equal(migrated.n1, undefined);
  assert.equal(
    Object.values(migrated).filter(
      (conflict) => conflict.reason === 'external-edit-preserved',
    ).length,
    1,
  );
});

test('reprocess conflict with a new title uses the new filename and keeps the old edit', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const original = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(original, 'HAND-EDITED IN OBSIDIAN');

  h.writeNote('n1', NOTE.replace('Acme Q3 Planning', 'Acme Renamed'));
  const result = h.eng.syncNoteBySummaryPath(
    path.join(h.output, 'n1_summary.md'),
    { onConflict: 'fork' },
  );

  assert.equal(result.status, 'forked');
  assert.equal(result.vaultRelPath, path.join('Sales', '2026-07-15 Acme Renamed.md'));
  assert.equal(fs.readFileSync(original, 'utf8'), 'HAND-EDITED IN OBSIDIAN');
  assert.ok(fs.existsSync(path.join(h.vault, result.vaultRelPath)));
});

test('reprocess conflict with a long stem still writes the replacement', (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  const stem = `recording-${'x'.repeat(100)}`;
  const longTitle = 'T'.repeat(180);
  const note = NOTE.replace('Acme Q3 Planning', longTitle);
  const summaryPath = path.join(h.output, `${stem}_summary.md`);
  h.writeNote(stem, note);
  const first = h.eng.syncNoteBySummaryPath(summaryPath);
  assert.equal(first.status, 'synced');
  const firstVaultRelPath = h.eng.loadIndex().notes[stem].vaultRelPath;
  fs.writeFileSync(path.join(h.vault, firstVaultRelPath), 'HAND-EDITED IN OBSIDIAN');

  h.writeNote(stem, note.replace('Friday.', 'Thursday.'));
  const result = h.eng.syncNoteBySummaryPath(summaryPath, { onConflict: 'fork' });

  assert.equal(result.status, 'forked');
  assert.ok(Buffer.byteLength(path.basename(result.vaultRelPath)) <= 220);
  assert.ok(fs.existsSync(path.join(h.vault, result.vaultRelPath)));
});

test('remove deletes the vault copy; preserves an externally-edited one', () => {
  const h = harness();
  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const target = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  // clean delete removes it
  assert.equal(h.eng.removeNoteBySummaryPath('n1').status, 'removed');
  assert.ok(!fs.existsSync(target));
  // re-sync, then externally edit, then delete → preserved + flagged
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  fs.writeFileSync(target, 'EDITED');
  assert.equal(h.eng.removeNoteBySummaryPath('n1').status, 'conflict');
  assert.ok(fs.existsSync(target), 'externally-edited copy kept');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('reconcile removes vault copies whose source note is gone', async () => {
  const h = harness();
  // Two notes so the scan is non-empty after one is deleted (the empty-scan
  // guard deliberately protects the wipe-everything case — see the H2 test).
  h.writeNote('n1', NOTE);
  h.writeNote('n2', NOTE.replace('Acme Q3 Planning', 'Second Note'));
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n2_summary.md'));
  const target = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  const survivor = path.join(h.vault, 'Sales', '2026-07-15 Second Note.md');
  fs.unlinkSync(path.join(h.output, 'n1_summary.md')); // deleted while app closed
  await h.eng.reconcileOnLaunch();
  assert.ok(!fs.existsSync(target), 'orphan vault copy cleaned');
  assert.ok(!h.eng.loadIndex().notes.n1, 'index entry dropped');
  assert.ok(fs.existsSync(survivor), 'the still-present note is untouched');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('reconcile detaches preservation history when a forked source vanished', async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  h.writeNote('n1', NOTE);
  h.writeNote('n2', NOTE.replace('Acme Q3 Planning', 'Second Note'));
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n2_summary.md'));

  const originalRelPath = path.join('Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.writeFileSync(path.join(h.vault, originalRelPath), 'HAND-EDITED IN OBSIDIAN');
  h.writeNote('n1', NOTE.replace('Friday.', 'Thursday.'));
  const fork = h.eng.syncNoteBySummaryPath(
    path.join(h.output, 'n1_summary.md'),
    { onConflict: 'fork' },
  );
  const idx = h.eng.loadIndex();
  idx.conflicts.n1 = {
    stem: 'n1',
    vaultRelPath: fork.vaultRelPath,
    detectedAt: new Date().toISOString(),
    reason: 'external-edit',
  };
  h.eng.saveIndex(idx);

  fs.unlinkSync(path.join(h.output, 'n1_summary.md'));
  await h.eng.reconcileOnLaunch();

  const after = h.eng.loadIndex();
  const preserved = Object.values(after.conflicts)
    .find((conflict) => conflict.reason === 'external-edit-preserved');
  assert.ok(fs.existsSync(path.join(h.vault, originalRelPath)));
  assert.ok(!fs.existsSync(path.join(h.vault, fork.vaultRelPath)));
  assert.equal(after.notes.n1, undefined);
  assert.equal(after.conflicts.n1, undefined, 'resolved active conflict is removed');
  assert.equal(preserved.replacementVaultRelPath, undefined);
});

test('reconcile does NOT mass-delete when the source scan comes back empty (H2)', async () => {
  const h = harness();
  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  const target = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  // Simulate a failed scan (e.g. a custom storage path that didn't load): the
  // output dir is empty/absent — the vault copy must survive, not be wiped.
  fs.rmSync(h.output, { recursive: true, force: true });
  await h.eng.reconcileOnLaunch();
  assert.ok(fs.existsSync(target), 'vault copy preserved on an untrustworthy scan');
  assert.ok(h.eng.loadIndex().notes.n1, 'index entry preserved');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('a stale (blocked-unlink) path is drained on the next sync', () => {
  const h = harness();
  // Simulate a leftover orphan that a prior Windows-locked unlink couldn't
  // remove, recorded in the index's stale list.
  const orphan = path.join(h.vault, 'orphan.md');
  fs.writeFileSync(orphan, 'left-behind');
  h.eng.saveIndex({ version: 1, notes: {}, conflicts: {}, stale: ['orphan.md'] });
  h.writeNote('n1', NOTE);
  h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  assert.ok(!fs.existsSync(orphan), 'stale orphan removed on the next sync');
  assert.deepEqual(h.eng.loadIndex().stale, [], 'stale list cleared');
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('first sync never clobbers a pre-existing untracked vault file (H1)', () => {
  const h = harness();
  const existing = path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning.md');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, 'MY HAND-WRITTEN OBSIDIAN NOTE');
  h.writeNote('n1', NOTE);
  const r = h.eng.syncNoteBySummaryPath(path.join(h.output, 'n1_summary.md'));
  assert.equal(r.status, 'synced');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'MY HAND-WRITTEN OBSIDIAN NOTE', 'user file untouched');
  assert.ok(fs.existsSync(path.join(h.vault, 'Sales', '2026-07-15 Acme Q3 Planning (n1).md')),
    'mirror written to a free, stem-suffixed name');
  fs.rmSync(h.root, { recursive: true, force: true });
});

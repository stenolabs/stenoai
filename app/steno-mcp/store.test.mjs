import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getNote,
  getTranscript,
  getUserDataDir,
  listActionItems,
  listFolders,
  loadStore,
  searchMeetings,
  ToolError,
  ConfigUnreadableError,
} from './store.mjs';
import { callTool } from './server.mjs';
import { makeTempDir, seedStore, writeConfig, writeNote, writeTranscript } from './test-fixtures.mjs';

function seeded(config) {
  const dir = makeTempDir();
  seedStore(dir);
  if (config) writeConfig(dir, config);
  const env = { STENOAI_USER_DATA_DIR: dir };
  return { dir, env, store: () => loadStore({ env }) };
}

const canSymlink = (() => {
  const d = makeTempDir('steno-mcp-link-');
  try {
    fs.symlinkSync(d, path.join(d, 'probe'), 'dir');
    return true;
  } catch {
    return false;
  }
})();

describe('location', () => {
  test('STENOAI_USER_DATA_DIR wins, then per-OS defaults', () => {
    assert.equal(getUserDataDir({ env: { STENOAI_USER_DATA_DIR: '/x' } }), '/x');
    assert.equal(
      getUserDataDir({ env: {}, platform: 'darwin', home: '/Users/a' }),
      path.join('/Users/a', 'Library', 'Application Support', 'stenoai'),
    );
    assert.equal(
      getUserDataDir({ env: { APPDATA: 'C:\\R' }, platform: 'win32', home: 'C:\\U' }),
      path.join('C:\\R', 'stenoai'),
    );
    assert.equal(
      getUserDataDir({ env: {}, platform: 'linux', home: '/home/a' }),
      path.join('/home/a', '.local', 'share', 'stenoai'),
    );
  });

  test('a custom storage_path is read, and the default dir stays visible', () => {
    const home = makeTempDir('steno-mcp-home-');
    const dataDir = getUserDataDir({ env: {}, platform: 'linux', home });
    fs.mkdirSync(dataDir, { recursive: true });
    const custom = makeTempDir('steno-mcp-custom-');
    writeConfig(dataDir, { storage_path: custom });
    writeNote(custom, 'in-custom', { title: 'Custom', date: '2026-11-01', sections: { Summary: 's' } });
    writeNote(dataDir, 'in-default', { title: 'Default', date: '2026-10-01', sections: { Summary: 's' } });
    const store = loadStore({ env: {}, platform: 'linux', home });
    assert.deepEqual(store.meetings.map((m) => m.id), ['in-custom', 'in-default']);
  });
});

describe('search_meetings', () => {
  test('matches every term across notes, newest first, with snippets', () => {
    const { store } = seeded();
    const r = searchMeetings(store(), { query: 'pricing team' });
    assert.deepEqual(r.results.map((m) => m.id), ['acme-kickoff']);
    assert.equal(r.results[0].matched_in, 'note');
    assert.match(r.results[0].snippet, /Pricing/);
    assert.deepEqual(r.results[0].folders, ['Sales']);
  });

  test('falls back to transcripts, and not when transcripts are excluded', () => {
    const { store, dir } = seeded();
    assert.deepEqual(searchMeetings(store(), { query: 'budget approved' }).results.map((m) => m.id), ['acme-kickoff']);
    assert.equal(searchMeetings(store(), { query: 'budget' }).results[0].matched_in, 'transcript');
    writeConfig(dir, { mcp_exclude_transcripts: true });
    assert.equal(searchMeetings(store(), { query: 'budget' }).results.length, 0);
  });

  test('empty query lists recent meetings; date, folder and limit filters apply', () => {
    const { store } = seeded();
    assert.deepEqual(
      searchMeetings(store(), {}).results.map((m) => m.id),
      ['one-on-one', 'eng-standup', 'acme-kickoff', 'legacy-review'],
    );
    assert.deepEqual(
      searchMeetings(store(), { from: '2026-11-05', to: '2026-11-12' }).results.map((m) => m.id),
      ['eng-standup'],
    );
    assert.deepEqual(
      searchMeetings(store(), { folder: 'sales' }).results.map((m) => m.id),
      ['acme-kickoff', 'legacy-review'],
    );
    const limited = searchMeetings(store(), { limit: 1 });
    assert.equal(limited.results.length, 1);
    assert.equal(limited.total_matches, 4);
    assert.equal(limited.truncated, true);
    assert.equal(searchMeetings(store(), { limit: 10_000 }).results.length, 4);
  });

  test('rejects malformed arguments', () => {
    const { store } = seeded();
    assert.throws(() => searchMeetings(store(), { from: 'last week' }), ToolError);
    assert.throws(() => searchMeetings(store(), { folder: 'Nope' }), ToolError);
    assert.throws(() => searchMeetings(store(), { query: 42 }), ToolError);
  });
});

describe('get_note', () => {
  test('returns the note without the inline transcript', () => {
    const { store } = seeded();
    const note = getNote(store(), { id: 'acme-kickoff' });
    assert.match(note.markdown, /^# Acme kickoff/);
    assert.match(note.markdown, /## Action Items/);
    assert.match(note.markdown, /Ask about SSO/);
    assert.match(note.markdown, /Folders: Sales/);
    assert.doesNotMatch(note.markdown, /inline copy/);
    assert.deepEqual(note.meta.participants, ['Alice', 'Bob']);
  });

  test('reads legacy JSON summaries', () => {
    const { store } = seeded();
    const note = getNote(store(), { id: 'legacy-review' });
    assert.match(note.markdown, /Quarterly numbers reviewed/);
    assert.match(note.markdown, /Dana to circulate the deck/);
  });

  test('ids are looked up, never used as paths', () => {
    const { store, dir } = seeded();
    fs.writeFileSync(path.join(path.dirname(dir), 'outside_summary.md'), '---\ntitle: "Outside"\n---\n## Summary\nsecret');
    for (const id of ['../outside', '../../etc/passwd', path.join(dir, 'config'), '', 'acme-kickoff_summary.md']) {
      assert.throws(() => getNote(store(), { id }), ToolError, `id ${JSON.stringify(id)}`);
    }
  });

  test('large notes are bounded', () => {
    const { store, dir } = seeded();
    writeNote(dir, 'huge', { title: 'Huge', date: '2026-11-20', sections: { Summary: 'x'.repeat(200_000) } });
    const note = getNote(store(), { id: 'huge' });
    assert.ok(note.markdown.length < 61_000);
    assert.match(note.markdown, /truncated/);
  });
});

describe('get_transcript', () => {
  test('reads the transcript file without its header, bounded by max_chars', () => {
    const { store } = seeded();
    const t = getTranscript(store(), { id: 'acme-kickoff' });
    assert.match(t.transcript, /^\[00:01\] \[You\] Welcome everyone\./);
    assert.doesNotMatch(t.transcript, /Session:/);
    const short = getTranscript(store(), { id: 'acme-kickoff', max_chars: 10 });
    assert.equal(short.transcript.length, 10);
    assert.equal(short.truncated, true);
  });

  test('falls back to the inline transcript section', () => {
    const { store } = seeded();
    assert.match(getTranscript(store(), { id: 'eng-standup' }).transcript, /release is Friday/);
  });

  test('refused when transcripts are excluded', () => {
    const { store } = seeded({ mcp_exclude_transcripts: true });
    assert.throws(() => getTranscript(store(), { id: 'acme-kickoff' }), /turned off/);
    // The note still says so, so an assistant does not keep asking.
    assert.equal(getNote(store(), { id: 'acme-kickoff' }).meta.transcript_available, false);
  });
});

describe('folder allowlist', () => {
  test('only meetings in allowed folders are visible to every tool', () => {
    const { store } = seeded({ mcp_folder_allowlist: ['f-eng'] });
    const s = store();
    assert.deepEqual(searchMeetings(s, {}).results.map((m) => m.id), ['eng-standup']);
    assert.throws(() => getNote(s, { id: 'acme-kickoff' }), ToolError);
    assert.throws(() => getNote(s, { id: 'one-on-one' }), ToolError);
    assert.throws(() => getTranscript(s, { id: 'acme-kickoff' }), ToolError);
    assert.deepEqual(listActionItems(s, {}).items.map((i) => i.meeting_id), ['eng-standup']);
    assert.deepEqual(listFolders(s).folders.map((f) => f.id), ['f-eng']);
    assert.throws(() => searchMeetings(s, { folder: 'Sales' }), ToolError);
  });

  test('an empty allowlist shows nothing; null shows everything', () => {
    assert.equal(seeded({ mcp_folder_allowlist: [] }).store().meetings.length, 0);
    assert.equal(seeded({ mcp_folder_allowlist: null }).store().meetings.length, 4);
  });

  test('a malformed allowlist fails closed', () => {
    assert.equal(seeded({ mcp_folder_allowlist: 'f-eng' }).store().meetings.length, 0);
    assert.equal(seeded({ mcp_folder_allowlist: { 0: 'f-eng' } }).store().meetings.length, 0);
  });

  test('a deleted folder still named in the allowlist shares nothing', () => {
    // The folder is gone from folders.json but its notes keep the id, and the
    // allowlist was not pruned (an older app, or a hand-edited config).
    const { dir, store } = seeded({ mcp_folder_allowlist: ['f-eng', 'f-gone'] });
    writeNote(path.join(dir, 'output'), 'in-deleted-space', {
      title: 'Was in a deleted space', date: '2026-11-02', folders: ['f-gone'], sections: { Summary: 'secret' },
    });
    const s = store();
    assert.deepEqual(searchMeetings(s, {}).results.map((m) => m.id), ['eng-standup']);
    assert.throws(() => getNote(s, { id: 'in-deleted-space' }), ToolError);
    assert.deepEqual([...s.scope.folderAllowlist], ['f-eng']);
    // Only deleted folders left: nothing is shared, rather than everything.
    assert.equal(seeded({ mcp_folder_allowlist: ['f-gone'] }).store().meetings.length, 0);
  });

  test('a corrupt config.json fails closed', () => {
    const { dir, store, env } = seeded();
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
    assert.throws(() => store(), ConfigUnreadableError);
    const result = callTool('search_meetings', { query: '' }, { env });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  });

  test('settings changes apply without restarting', () => {
    const { dir, env } = seeded();
    assert.equal(JSON.parse(callTool('list_folders', {}, { env }).content[0].text).folders.length, 2);
    writeConfig(dir, { mcp_folder_allowlist: ['f-sales'] });
    assert.equal(JSON.parse(callTool('list_folders', {}, { env }).content[0].text).folders.length, 1);
  });
});

describe('list_action_items', () => {
  test('lists items with done state, filtered by owner and date', () => {
    const { store } = seeded();
    const all = listActionItems(store(), {});
    assert.equal(all.total, 5);
    const bob = all.items.find((i) => i.item.includes('Bob'));
    assert.equal(bob.done, true);
    assert.deepEqual(
      listActionItems(store(), { owner: 'alice' }).items.map((i) => i.meeting_id),
      ['one-on-one', 'acme-kickoff'],
    );
    assert.deepEqual(
      listActionItems(store(), { owner: 'alice', to: '2026-11-05' }).items.map((i) => i.meeting_id),
      ['acme-kickoff'],
    );
  });
});

describe('path escapes', { skip: !canSymlink && 'symlinks unavailable on this host' }, () => {
  test('a summary symlinked out of the store is skipped', () => {
    const { dir, store } = seeded();
    const outside = makeTempDir('steno-mcp-outside-');
    const target = writeNote(outside, 'secret', { title: 'Secret', date: '2026-11-21', sections: { Summary: 'secret' } });
    fs.symlinkSync(target, path.join(dir, 'output', 'secret_summary.md'));
    const s = store();
    assert.equal(s.meetings.find((m) => m.id === 'secret'), undefined);
    assert.throws(() => getNote(s, { id: 'secret' }), ToolError);
  });

  test('a transcript symlinked out of the store is not read', () => {
    const { dir, store } = seeded();
    const outside = makeTempDir('steno-mcp-outside-');
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, `${'='.repeat(60)}\nTOP SECRET`);
    writeNote(dir, 'linked', { title: 'Linked', date: '2026-11-21', sections: { Summary: 's' } });
    fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
    fs.symlinkSync(secret, path.join(dir, 'transcripts', 'linked_transcript.txt'));
    assert.equal(getTranscript(store(), { id: 'linked' }).transcript, '');
    assert.equal(searchMeetings(store(), { query: 'secret' }).results.length, 0);
  });

  test('an output dir symlinked elsewhere is not followed out of the root', () => {
    const root = makeTempDir('steno-mcp-root-');
    const outside = makeTempDir('steno-mcp-outside-');
    writeNote(outside, 'elsewhere', { title: 'Elsewhere', date: '2026-11-21', sections: { Summary: 's' } });
    fs.symlinkSync(path.join(outside, 'output'), path.join(root, 'output'), 'dir');
    assert.equal(loadStore({ env: { STENOAI_USER_DATA_DIR: root } }).meetings.length, 0);
  });

  test('a symlinked folders.json outside the store is ignored', () => {
    const { dir, store } = seeded();
    const outside = makeTempDir('steno-mcp-outside-');
    fs.writeFileSync(path.join(outside, 'f.json'), JSON.stringify({ folders: [{ id: 'x', name: 'Leaked' }] }));
    fs.rmSync(path.join(dir, 'folders.json'));
    fs.symlinkSync(path.join(outside, 'f.json'), path.join(dir, 'folders.json'));
    assert.deepEqual(store().folders, []);
  });

  test('a symlinked storage root itself is fine (e.g. iCloud)', () => {
    const real = makeTempDir('steno-mcp-real-');
    seedStore(real);
    const linkParent = makeTempDir('steno-mcp-linkparent-');
    const link = path.join(linkParent, 'store');
    fs.symlinkSync(real, link, 'dir');
    writeTranscript(real, 'eng-standup', '[00:01] [You] from file');
    const s = loadStore({ env: { STENOAI_USER_DATA_DIR: link } });
    assert.equal(s.meetings.length, 4);
    assert.match(getTranscript(s, { id: 'eng-standup' }).transcript, /from file/);
  });
});

import { test, expect } from '../fixtures/electron';
import { startMockOllama } from '../fixtures/mock-ollama';
import { makeWav } from '../fixtures/make-wav';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { killOllama } from '../fixtures/kill-ollama';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import path from 'path';

/**
 * T2 (model-free) — import collision de-duplication against the durable note.
 *
 * The note lives in output/<stem>_summary.{md,json}, named from the audio stem,
 * and OUTLIVES the audio (process-streaming unlinks the recording after a
 * successful transcribe, keep_recordings off). So a stem that's free in
 * recordings/ can still collide with an EARLIER same-basename import whose audio
 * was already removed — and the old collision check, which looked only at
 * recordings/, would let the second import reuse the stem and silently overwrite
 * the first import's summary. This pins that copyImportIntoRecordings now also
 * skips a stem whose note already exists.
 *
 * Model-free on purpose: the stem is chosen at copy/enqueue time, BEFORE any
 * transcription, so the deduped recordings/ filename is observable without a
 * model. processFile is fire-and-forget; we assert the copy it just made, not
 * the (model-bearing) pipeline result. The end-to-end "original survives the
 * unlink" case stays in audio-import.t2 (@pipeline).
 *
 * The seeded note goes in the output dir that copyImportIntoRecordings actually
 * checks — the sibling of the app's recordings dir (from getDir()). Both
 * resolvers now honor STENOAI_USER_DATA_DIR, so under e2e that's the per-test
 * temp dir (the keystone): fully isolated, never the real ~/Library or repo
 * scratch. (#233 fixed the old dev quirk where getDir() returned repo-root
 * recordings/ while the frozen backend wrote under ~/Library.)
 */

type StenoWindow = Window & {
  stenoai: {
    recording: {
      processFile: (filePath: string, name: string) => Promise<{ success?: boolean; error?: string }>;
      getDir: () => Promise<{ success?: boolean; path?: string }>;
    };
  };
};

// The stem (filename without extension) a recordings/ entry will write its
// note under: output/<stem>_summary.md. Two imports that resolve to the same
// stem collide on that note.
const stemOf = (file: string) => path.basename(file, path.extname(file));

test('a re-import of a same-basename file does not overwrite the first import\'s note', async ({
  launchApp,
  userDataDir,
}) => {
  // Defensive: own 11434 so the queued (modelless) job can't reach a real LLM.
  killOllama();
  const ollama = await startMockOllama();

  const realDirBefore = fileSig(realUserDataDir());

  let firstNote: string | undefined;
  let recordingsDir: string | undefined;

  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    // The dir copyImportIntoRecordings copies into, and its sibling output/ —
    // the same pair the collision check consults.
    const dir = await page.evaluate(() =>
      (window as StenoWindow).stenoai.recording.getDir(),
    );
    recordingsDir = dir?.path;
    expect(recordingsDir).toBeTruthy();
    const outputDir = path.join(path.dirname(recordingsDir!), 'output');

    // Stand in for "an earlier import of imported.wav already produced a note":
    // seed output/imported_summary.md, as if its audio was since unlinked.
    mkdirSync(outputDir, { recursive: true });
    firstNote = path.join(outputDir, 'imported_summary.md');
    const firstNoteBody = '# First import\n\nThis note must survive a re-import.\n';
    writeFileSync(firstNote, firstNoteBody);

    // A fresh, DIFFERENT file that happens to share the basename.
    const srcDir = path.join(userDataDir, 'import-src');
    mkdirSync(srcDir, { recursive: true });
    const srcPath = path.join(srcDir, 'imported.wav');
    makeWav(srcPath, { seconds: 2 });

    // processFile resolves once the file is copied + queued (before transcribe).
    const queued = await page.evaluate(
      (p) => (window as StenoWindow).stenoai.recording.processFile(p, 'Imported Note'),
      srcPath,
    );
    expect(queued?.success).toBe(true);

    // The copy must have side-stepped the existing note's stem: imported-1.wav,
    // NOT imported.wav. (imported.wav being free in recordings/ is exactly the
    // trap the old code fell into.)
    await expect
      .poll(() => existsSync(path.join(recordingsDir!, 'imported-1.wav')), {
        timeout: 10_000,
        intervals: [200],
      })
      .toBe(true);

    // The first import's note is byte-for-byte intact — nothing overwrote it.
    expect(readFileSync(firstNote, 'utf8')).toBe(firstNoteBody);

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    killOllama();
    // Tidy the (non-isolated in dev) scratch this test wrote.
    if (firstNote) rmSync(firstNote, { force: true });
    if (recordingsDir) {
      rmSync(path.join(recordingsDir, 'imported.wav'), { force: true });
      rmSync(path.join(recordingsDir, 'imported-1.wav'), { force: true });
    }
  }
});

test('two parallel imports of the same stem with different extensions get distinct stems', async ({
  launchApp,
  userDataDir,
}) => {
  // Regression for the COPYFILE_EXCL-only reservation: it reserved the full
  // filename (<stem><ext>), so dup.wav and dup.m4a produced different dest names
  // (dup.wav, dup.m4a), neither raising EEXIST — both kept the stem "dup" and
  // would later write the SAME output/dup_summary.md, one clobbering the other.
  // The reservation must be on the stem, independent of extension, so the second
  // import bumps to dup-1.
  killOllama();
  const ollama = await startMockOllama();

  const realDirBefore = fileSig(realUserDataDir());

  let recordingsDir: string | undefined;
  let outputDir: string | undefined;
  const stems = ['dup', 'dup-1'];
  const exts = ['wav', 'm4a'];

  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    const dir = await page.evaluate(() =>
      (window as StenoWindow).stenoai.recording.getDir(),
    );
    recordingsDir = dir?.path;
    expect(recordingsDir).toBeTruthy();
    outputDir = path.join(path.dirname(recordingsDir!), 'output');

    // Same stem, different extensions — the exact pair the old check let through.
    const srcDir = path.join(userDataDir, 'parallel-import-src');
    mkdirSync(srcDir, { recursive: true });
    const wavSrc = path.join(srcDir, 'dup.wav');
    const m4aSrc = path.join(srcDir, 'dup.m4a');
    makeWav(wavSrc, { seconds: 2 });
    makeWav(m4aSrc, { seconds: 2 }); // WAV bytes in a .m4a — only the stem/ext matter here

    // Fire both through the bridge in the same tick so their copies interleave
    // (each copyImportIntoRecordings yields at its first await before either
    // finishes), reproducing the concurrent reservation race.
    const results = await page.evaluate(
      ([a, b]) => {
        const api = (window as StenoWindow).stenoai.recording;
        return Promise.all([
          api.processFile(a, 'Dup A'),
          api.processFile(b, 'Dup B'),
        ]);
      },
      [wavSrc, m4aSrc],
    );
    expect(results.every((r) => r?.success === true)).toBe(true);

    // processFile resolves only after copyImportIntoRecordings has copied the
    // file, so both copies exist now. Snapshot synchronously — the async
    // pipeline unlinks them seconds later, so a poll would race the cleanup.
    // Both imports must live under DISTINCT stems: collect the dup* copies'
    // stems and assert exactly {dup, dup-1} — never a second "dup" under a
    // different extension, which is what would later overwrite dup_summary.md.
    const dupStems = readdirSync(recordingsDir!)
      .filter((f) => !f.startsWith('.') && /^dup(-\d+)?\.(wav|m4a)$/.test(f))
      .map(stemOf);
    expect([...new Set(dupStems)].sort()).toEqual(['dup', 'dup-1']);

    // The two summaries the pipeline will write therefore differ — no clobber.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    killOllama();
    if (recordingsDir) {
      for (const s of stems) for (const e of exts) {
        rmSync(path.join(recordingsDir, `${s}.${e}`), { force: true });
        rmSync(path.join(recordingsDir, `.${s}.import`), { force: true });
      }
    }
    if (outputDir) {
      for (const s of stems) {
        rmSync(path.join(outputDir, `${s}_summary.md`), { force: true });
        rmSync(path.join(outputDir, `${s}_summary.json`), { force: true });
      }
    }
  }
});

test('a stale .import marker left by a crash does not permanently force a suffix', async ({
  launchApp,
  userDataDir,
}) => {
  // The reservation marker (.<stem>.import) is created with 'wx' and removed in
  // a finally. A crash BETWEEN the open and that finally orphans the marker on
  // disk. audioStemTaken skips dotfiles, so the orphan never trips the early
  // skip — instead the next import of that stem hits EEXIST on the open and is
  // bumped to <stem>-1 forever, even though no real file/note collision exists.
  // The fix sweeps orphaned markers at startup (no import is ever in flight at
  // app launch, so a leftover marker is unambiguously stale). This pins that a
  // marker present at launch does not block a later import from claiming the
  // bare stem.
  killOllama();
  const ollama = await startMockOllama();

  const realDirBefore = fileSig(realUserDataDir());

  // The dir the app copies into. Both resolvers now honor STENOAI_USER_DATA_DIR,
  // so under e2e this is the per-test temp dir (isolated). Seeded BEFORE launch
  // so the marker is present when the startup sweep runs.
  const recordingsDir = path.join(userDataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  const stem = 'crashedimport';
  const staleMarker = path.join(recordingsDir, `.${stem}.import`);
  const outputDir = path.join(path.dirname(recordingsDir), 'output');
  writeFileSync(staleMarker, '');

  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    // Sanity: the app copies into exactly the dir we seeded the orphan in.
    const dir = await page.evaluate(() =>
      (window as StenoWindow).stenoai.recording.getDir(),
    );
    expect(dir?.path).toBe(recordingsDir);

    const srcDir = path.join(userDataDir, 'stale-import-src');
    mkdirSync(srcDir, { recursive: true });
    const srcPath = path.join(srcDir, `${stem}.wav`);
    makeWav(srcPath, { seconds: 2 });

    const queued = await page.evaluate(
      (p) => (window as StenoWindow).stenoai.recording.processFile(p, 'Crashed Import'),
      srcPath,
    );
    expect(queued?.success).toBe(true);

    // With the orphan swept at startup, the import claims the bare stem.
    await expect
      .poll(() => existsSync(path.join(recordingsDir, `${stem}.wav`)), {
        timeout: 10_000,
        intervals: [200],
      })
      .toBe(true);
    // Not bumped to <stem>-1 by a leftover marker.
    expect(existsSync(path.join(recordingsDir, `${stem}-1.wav`))).toBe(false);
    // And the orphan itself is gone.
    expect(existsSync(staleMarker)).toBe(false);

    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    killOllama();
    rmSync(staleMarker, { force: true });
    rmSync(path.join(recordingsDir, `${stem}.wav`), { force: true });
    rmSync(path.join(recordingsDir, `${stem}-1.wav`), { force: true });
    rmSync(path.join(recordingsDir, `.${stem}-1.import`), { force: true });
    rmSync(path.join(outputDir, `${stem}_summary.md`), { force: true });
    rmSync(path.join(outputDir, `${stem}_summary.json`), { force: true });
    rmSync(path.join(outputDir, `${stem}-1_summary.md`), { force: true });
    rmSync(path.join(outputDir, `${stem}-1_summary.json`), { force: true });
  }
});

import { test, expect } from "../fixtures/electron";
import { realUserDataDir, fileSig } from "../fixtures/real-user-data";
import { writeMeetingSummary } from "../fixtures/user-config";
import {
  existsSync,
  renameSync,
  symlinkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "fs";
import path from "path";

const { makeWav } = require("../fixtures/make-wav.js") as {
  makeWav: (
    file: string,
    options: { seconds: number; sampleRate: number; channels: number },
  ) => string;
};

const codec = require("../../app/meeting-transfer-codec.js") as {
  writePackage: (file: string, payload: TransferPayload) => Promise<void>;
  readPackage: (file: string) => Promise<
    TransferPayload & {
      audio: Array<{
        sourcePath: string;
        metadata: {
          logicalTrackID: string;
          kind: string;
          byteCount: number;
          sha256: string;
          sampleRate: number;
          channelCount: number;
          duration: number;
        };
      }>;
      cleanup: () => Promise<void>;
    }
  >;
  inspectCAF: (file: string) => Promise<{
    byteCount: number;
    sha256: string;
    sampleRate: number;
    channelCount: number;
    duration: number;
  }>;
};

type TransferPayload = {
  meeting: {
    sourceMeetingID: string;
    title: string;
    createdAt: number;
    sourceStatus: "ready";
  };
  notes: string;
  transcript: {
    localeOrigin: "absent";
    speakers: unknown[];
    turns: Array<{
      start: number;
      end: number;
      segments: Array<{
        text: string;
        start: number;
        end: number;
        words: unknown[];
      }>;
    }>;
  };
};

type Result<T = Record<string, never>> = {
  success: boolean;
  error?: string;
} & T;
type Meeting = {
  has_audio?: boolean;
  session_info: {
    name: string;
    summary_file: string;
    notes_generated?: boolean;
  };
  summary?: string;
  transcript?: string;
  user_notes?: string;
};
type StenoWindow = Window & {
  stenoai: {
    meetingTransfer: {
      importPackage: (filePath?: string) => Promise<
        Result<{
          cancelled?: boolean;
          summaryFile?: string;
          duplicate?: boolean;
        }>
      >;
      exportPackage: (
        summaryFile: string,
      ) => Promise<Result<{ cancelled?: boolean }>>;
      ready: () => Promise<Result>;
    };
    meetings: {
      list: () => Promise<Result<{ meetings: Meeting[] }>>;
      get: (summaryFile: string) => Promise<Result<{ meeting?: Meeting }>>;
      delete: (meeting: Meeting) => Promise<Result<{ id?: string }>>;
      undoDelete: (id: string) => Promise<Result<{ meeting?: Meeting }>>;
      commitDelete: (id: string) => Promise<Result>;
    };
    on: {
      meetingTransferImported: (
        callback: (event: { summaryFile: string; duplicate: boolean }) => void,
      ) => () => void;
    };
  };
};

const { makeWebMOpus } = require("../fixtures/make-webm-opus.js") as { makeWebMOpus: (options?: { gap?: number }) => Buffer };

const UUID = "018f4a12-3456-789a-bcde-f0123456789a";
const CREATED_AT = 780_000_000;
const TEXT = "synthetic transfer text";

function payload(text = TEXT): TransferPayload {
  return {
    meeting: {
      sourceMeetingID: UUID,
      title: "Synthetic Swift Meeting",
      createdAt: CREATED_AT,
      sourceStatus: "ready",
    },
    notes: "Synthetic notes stay local.",
    transcript: {
      localeOrigin: "absent",
      speakers: [],
      turns: [
        {
          start: 0,
          end: 1,
          segments: [{ text, start: 0, end: 1, words: [] }],
        },
      ],
    },
  };
}

async function stubNativeDialogs(
  app: import("@playwright/test").ElectronApplication,
  config: {
    openFile?: string;
    saveFile?: string;
    cancelOpen?: boolean;
    cancelSave?: boolean;
    checkboxAudio?: boolean;
  },
) {
  await app.evaluate(({ dialog }, options) => {
    const calls: Array<{ kind: string; options: unknown }> = [];
    (globalThis as any).__meetingTransferDialogCalls = calls;

    dialog.showOpenDialog = async (_window, dialogOptions) => {
      calls.push({ kind: "open", options: dialogOptions });
      return options.cancelOpen || !options.openFile
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [options.openFile] };
    };
    dialog.showSaveDialog = async (_window, dialogOptions) => {
      calls.push({ kind: "save", options: dialogOptions });
      return options.cancelSave || !options.saveFile
        ? { canceled: true, filePath: undefined }
        : { canceled: false, filePath: options.saveFile };
    };
    dialog.showMessageBox = async (_window, dialogOptions) => {
      calls.push({ kind: "message", options: dialogOptions });
      const response = dialogOptions.title === "Export Steno package" ? 1 : 0;
      return { response, checkboxChecked: options.checkboxAudio === true };
    };
  }, config);
}

const importPackage = (
  page: import("@playwright/test").Page,
  filePath?: string,
) =>
  page.evaluate(
    (p) => (window as StenoWindow).stenoai.meetingTransfer.importPackage(p),
    filePath,
  );

test.describe("macOS meeting transfer", () => {
  test.skip(
    process.platform !== "darwin",
    "The .stenomeeting format is a macOS Swift interop feature.",
  );

  test("imports and re-exports native Swift AAC tracks byte-identically", async ({ launchApp, userDataDir }) => {
    const source = path.resolve(__dirname, "../../tests/fixtures/swift-meeting-aac-v1.stenomeeting");
    const target = path.join(userDataDir, "aac-roundtrip.stenomeeting");
    const original = await codec.readPackage(source);
    try {
      const { app, page } = await launchApp();
      await stubNativeDialogs(app, { saveFile: target, checkboxAudio: true });
      const imported = await importPackage(page, source);
      expect(imported).toMatchObject({ success: true, duplicate: false });
      expect(existsSync(imported.summaryFile!)).toBe(true);
      const listed = await page.evaluate(() => (window as StenoWindow).stenoai.meetings.list());
      expect(listed.meetings[0].has_audio).toBe(true);
      expect(await importPackage(page, source)).toMatchObject({ success: true, duplicate: true });
      const exported = await page.evaluate(
        file => (window as StenoWindow).stenoai.meetingTransfer.exportPackage(file),
        imported.summaryFile!,
      );
      expect(exported).toMatchObject({ success: true, cancelled: false });
      const roundtrip = await codec.readPackage(target);
      try {
        expect(roundtrip.audio.map(a => a.metadata)).toEqual(original.audio.map(a => a.metadata));
      } finally { await roundtrip.cleanup(); }
    } finally { await original.cleanup(); }
  });

  test("imports through native dialogs, deduplicates the same archive, and exports intact text", async ({
    launchApp,
    userDataDir,
  }) => {
    const realDirBefore = fileSig(realUserDataDir());
    const fixtureDir = path.join(userDataDir, "transfer-fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const importFile = path.join(fixtureDir, "swift-origin.stenomeeting");
    const exportFile = path.join(fixtureDir, "roundtrip.stenomeeting");
    await codec.writePackage(importFile, payload());

    const { app, page } = await launchApp();
    await stubNativeDialogs(app, {
      openFile: importFile,
      saveFile: exportFile,
    });
    expect(
      (
        await page.evaluate(() =>
          (window as StenoWindow).stenoai.meetingTransfer.ready(),
        )
      ).success,
    ).toBe(true);

    const imported = await importPackage(page);
    expect(imported).toMatchObject({ success: true, duplicate: false });
    expect(imported.summaryFile).toBe(
      path.join(
        realpathSync(path.join(userDataDir, "output")),
        `transfer_${UUID.toLowerCase()}_summary.json`,
      ),
    );
    expect(existsSync(imported.summaryFile!)).toBe(true);

    const listed = await page.evaluate(() =>
      (window as StenoWindow).stenoai.meetings.list(),
    );
    expect(listed.success).toBe(true);
    expect(listed.meetings).toHaveLength(1);
    expect(listed.meetings[0].session_info.name).toBe(
      "Synthetic Swift Meeting",
    );

    const detail = await page.evaluate(
      (file) => (window as StenoWindow).stenoai.meetings.get(file),
      imported.summaryFile!,
    );
    expect(detail.success).toBe(true);
    expect(detail.meeting).toMatchObject({
      session_info: {
        name: "Synthetic Swift Meeting",
        summary_file: imported.summaryFile,
        notes_generated: false,
      },
      summary: "",
      transcript: TEXT,
      user_notes: "Synthetic notes stay local.",
    });

    const beforeFiles = readdirSync(path.join(userDataDir, "output")).sort();
    const duplicate = await importPackage(page, importFile);
    expect(duplicate).toMatchObject({
      success: true,
      duplicate: true,
      summaryFile: imported.summaryFile,
    });
    expect(readdirSync(path.join(userDataDir, "output")).sort()).toEqual(
      beforeFiles,
    );

    const exported = await page.evaluate(
      (file) =>
        (window as StenoWindow).stenoai.meetingTransfer.exportPackage(file),
      imported.summaryFile!,
    );
    expect(exported).toMatchObject({ success: true, cancelled: false });
    expect(existsSync(exportFile)).toBe(true);
    const roundtrip = await codec.readPackage(exportFile);
    try {
      expect(roundtrip.meeting.title).toBe("Synthetic Swift Meeting");
      expect(JSON.stringify(roundtrip.transcript)).toContain(TEXT);
      expect(roundtrip.notes).toContain("Synthetic notes stay local.");
    } finally {
      await roundtrip.cleanup();
    }

    const calls = await app.evaluate(
      () => (globalThis as any).__meetingTransferDialogCalls,
    );
    expect(calls.some((call: { kind: string }) => call.kind === "open")).toBe(
      true,
    );
    expect(
      calls.some((call: { kind: string }) => call.kind === "message"),
    ).toBe(true);
    expect(calls.some((call: { kind: string }) => call.kind === "save")).toBe(
      true,
    );
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  });

  test("a warm open-file duplicate still emits imported after the first import navigates to its meeting", async ({
    launchApp,
    userDataDir,
  }) => {
    const fixtureDir = path.join(userDataDir, "transfer-fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const importFile = path.join(fixtureDir, "warm-duplicate.stenomeeting");
    await codec.writePackage(importFile, payload());

    const { app, page } = await launchApp();
    await stubNativeDialogs(app, {});
    const first = await importPackage(page, importFile);
    expect(first).toMatchObject({ success: true, duplicate: false });
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/meetings/${encodeURIComponent(first.summaryFile!)}`);

    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __warmTransferEvents?: Array<{
          summaryFile: string;
          duplicate: boolean;
        }>;
      };
      target.__warmTransferEvents = [];
      (window as StenoWindow).stenoai.on.meetingTransferImported((event) => {
        target.__warmTransferEvents!.push(event);
      });
    });
    const messagesBefore = await app.evaluate(
      () =>
        (globalThis as any).__meetingTransferDialogCalls.filter(
          (call: { kind: string }) => call.kind === "message",
        ).length,
    );

    await app.evaluate(({ app: electronApp }, file) => {
      electronApp.emit("open-file", { preventDefault() {} } as any, file);
    }, importFile);

    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as any).__meetingTransferDialogCalls.filter(
              (call: { kind: string }) => call.kind === "message",
            ).length,
        ),
      )
      .toBe(messagesBefore + 1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as any).__warmTransferEvents as Array<{
              summaryFile: string;
              duplicate: boolean;
            }>,
        ),
      )
      .toEqual([{ summaryFile: first.summaryFile, duplicate: true }]);
  });

  test("changed content from the same origin is rejected without creating another meeting", async ({
    launchApp,
    userDataDir,
  }) => {
    const realDirBefore = fileSig(realUserDataDir());
    const fixtureDir = path.join(userDataDir, "transfer-fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const originalFile = path.join(fixtureDir, "original.stenomeeting");
    const changedFile = path.join(fixtureDir, "changed.stenomeeting");
    await codec.writePackage(originalFile, payload());
    await codec.writePackage(changedFile, payload("changed synthetic text"));

    const { app, page } = await launchApp();
    await stubNativeDialogs(app, {});
    const original = await importPackage(page, originalFile);
    expect(original.success).toBe(true);
    const conflict = await importPackage(page, changedFile);
    expect(conflict.success).toBe(false);
    expect(conflict.error).toMatch(/conflict|different|already imported/i);

    const listed = await page.evaluate(() =>
      (window as StenoWindow).stenoai.meetings.list(),
    );
    expect(listed.meetings).toHaveLength(1);
    const detail = await page.evaluate(
      (file) => (window as StenoWindow).stenoai.meetings.get(file),
      original.summaryFile!,
    );
    expect(JSON.stringify(detail.meeting)).toContain(TEXT);
    expect(JSON.stringify(detail.meeting)).not.toContain(
      "changed synthetic text",
    );
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  });

  test("cancelled open/save dialogs and an invalid archive produce no output", async ({
    launchApp,
    userDataDir,
  }) => {
    const realDirBefore = fileSig(realUserDataDir());
    const fixtureDir = path.join(userDataDir, "transfer-fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const invalidFile = path.join(fixtureDir, "invalid.stenomeeting");
    writeFileSync(invalidFile, "not an Apple Archive package");

    const { app, page } = await launchApp();
    await stubNativeDialogs(app, { cancelOpen: true });
    const cancelledImport = await importPackage(page);
    expect(cancelledImport).toMatchObject({ success: true, cancelled: true });

    const invalid = await importPackage(page, invalidFile);
    expect(invalid.success).toBe(false);
    const outputDir = path.join(userDataDir, "output");
    expect(existsSync(outputDir) ? readdirSync(outputDir) : []).toEqual([]);

    const source = path.join(outputDir, "seed_summary.json");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      source,
      JSON.stringify({
        session_info: { name: "Seed", summary_file: source },
        transcript: TEXT,
      }),
    );
    await stubNativeDialogs(app, { cancelSave: true });
    const cancelledExport = await page.evaluate(
      (file) =>
        (window as StenoWindow).stenoai.meetingTransfer.exportPackage(file),
      source,
    );
    expect(cancelledExport).toMatchObject({ success: true, cancelled: true });
    expect(readFileSync(source, "utf8")).toContain(TEXT);
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  });

  test("export refuses a recordings directory linked outside the library", async ({ launchApp, userDataDir }) => {
    const stem = "symlink-export";
    const summary = writeMeetingSummary(userDataDir, stem, { name: "Synthetic", summary: "Synthetic notes." });
    const recordings = path.join(userDataDir, "recordings");
    const outside = path.join(userDataDir, "outside-recordings");
    mkdirSync(outside);
    makeWav(path.join(outside, `${stem}.wav`), { seconds: 0.25, sampleRate: 16000, channels: 1 });
    const target = path.join(userDataDir, "blocked.stenomeeting");
    const { app, page } = await launchApp();
    if (existsSync(recordings)) renameSync(recordings, path.join(userDataDir, "original-recordings"));
    symlinkSync(outside, recordings, "dir");
    await stubNativeDialogs(app, { saveFile: target, checkboxAudio: true });
    const result = await page.evaluate(file => (window as StenoWindow).stenoai.meetingTransfer.exportPackage(file), summary);
    expect(result).toMatchObject({ success: false, error_code: "unsafe_storage" });
    expect(existsSync(target)).toBe(false);
  });

  for (const replacement of ["overwrite", "rename"]) {
    test(`export rejects same-path audio ${replacement} during save dialog`, async ({ launchApp, userDataDir }) => {
      const stem = "changed-recording";
      const summary = writeMeetingSummary(userDataDir, stem, { name: "Synthetic source change", summary: "Synthetic notes." });
      const recordings = path.join(userDataDir, "recordings");
      mkdirSync(recordings, { recursive: true });
      const recording = path.join(recordings, `${stem}.wav`);
      makeWav(recording, { seconds: 0.25, sampleRate: 16000, channels: 1 });
      const target = path.join(userDataDir, "must-not-exist.stenomeeting");
      const { app, page } = await launchApp();
      await stubNativeDialogs(app, { saveFile: target, checkboxAudio: true });
      await app.evaluate(({ dialog }) => {
        dialog.showSaveDialog = () => new Promise(resolve => {
          (globalThis as any).__releaseChangedAudioSave = resolve;
        });
      });
      const exporting = page.evaluate(file => (window as StenoWindow).stenoai.meetingTransfer.exportPackage(file), summary);
      await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__releaseChangedAudioSave)).toBe("function");
      const bytes = readFileSync(recording);
      bytes[bytes.length - 1] ^= 1;
      if (replacement === "rename") {
        writeFileSync(recording + ".new", bytes);
        renameSync(recording + ".new", recording);
      } else writeFileSync(recording, bytes);
      await app.evaluate((_electron, file) => (globalThis as any).__releaseChangedAudioSave({ canceled: false, filePath: file }), target);
      const result = await exporting;
      expect(result).toMatchObject({ success: false, error_code: "source_changed" });
      expect(existsSync(target)).toBe(false);
    });
  }

  for (const container of ["wav", "webm", "webm-gap"] as const) {
    test(container === "webm-gap" ? "rejects a WebM gap without publishing a package"
      : `exports native ${container} through the bundled helper and reimports its CAF`, async ({
      launchApp,
      userDataDir,
    }) => {
      const realDirBefore = fileSig(realUserDataDir());
      const stem = "native-electron-audio";
      const summaryFile = writeMeetingSummary(userDataDir, stem, {
        name: "Native Electron audio",
        summary: "Synthetic native meeting summary.",
        transcript: "Synthetic native meeting transcript.",
      });
      const recordingsDir = path.join(userDataDir, "recordings");
      mkdirSync(recordingsDir, { recursive: true });
      const wavFile = path.join(recordingsDir, `${stem}.${container === "wav" ? "wav" : "webm"}`);
      if (container === "wav") makeWav(wavFile, { seconds: 2, sampleRate: 48_000, channels: 2 });
      else writeFileSync(wavFile, makeWebMOpus({ gap: container === "webm-gap" ? 1000 : 0 }));
      const original = readFileSync(wavFile);
      const duration = container === "wav" ? 2 : 95208 / 48000;

      const transferDir = path.join(userDataDir, "transfer-fixtures");
      mkdirSync(transferDir, { recursive: true });
      const destination = path.join(transferDir, "native-audio.stenomeeting");
      const { app, page } = await launchApp();
      await stubNativeDialogs(app, {
        saveFile: destination,
        checkboxAudio: true,
      });

      const exported = await page.evaluate(
        (file) =>
          (window as StenoWindow).stenoai.meetingTransfer.exportPackage(file),
        summaryFile,
      );
      if (container === "webm-gap") {
        expect(exported).toMatchObject({ success: false, error_code: "unsupported_audio" });
        expect(existsSync(destination)).toBe(false);
        expect(readFileSync(wavFile)).toEqual(original);
        expect(readdirSync(path.join(userDataDir, "meeting-transfer")).filter(name => name.startsWith("audio-"))).toEqual([]);
        expect(fileSig(realUserDataDir())).toBe(realDirBefore);
        return;
      }
      expect(exported).toMatchObject({ success: true, cancelled: false });
      expect(existsSync(destination)).toBe(true);

      const pkg = await codec.readPackage(destination);
      try {
        expect(pkg.audio).toHaveLength(1);
        expect(pkg.audio[0].metadata).toMatchObject({
          logicalTrackID: "track-1",
          kind: "imported",
          sampleRate: 48_000,
          channelCount: 2,
        });
        expect(pkg.audio[0].metadata.duration).toBeCloseTo(duration, 6);
        const bytes = readFileSync(pkg.audio[0].sourcePath);
        expect(bytes.toString("ascii", 28, 32)).toBe(container === "wav" ? "aac " : "opus");
        if (container === "wav") expect(bytes.length).toBeLessThan(statSync(wavFile).size);
        const caf = await codec.inspectCAF(pkg.audio[0].sourcePath);
        expect(caf).toMatchObject({
          sha256: pkg.audio[0].metadata.sha256,
          byteCount: pkg.audio[0].metadata.byteCount,
          sampleRate: 48_000,
          channelCount: 2,
        });
        expect(caf.duration).toBeCloseTo(duration, 6);
        expect(pkg.notes).toContain("Synthetic native meeting summary.");
        expect(JSON.stringify(pkg.transcript)).toContain(
          "Synthetic native meeting transcript.",
        );
      } finally {
        await pkg.cleanup();
      }
      expect(readFileSync(wavFile)).toEqual(original);
      const imported = await page.evaluate((file) =>
        (window as StenoWindow).stenoai.meetingTransfer.importPackage(file), destination);
      expect(imported.success).toBe(true);
      expect(fileSig(realUserDataDir())).toBe(realDirBefore);
    });
  }

  test("a Swift audio package follows the warm open-file route, exports audio by choice, and cleans media on commit", async ({
    launchApp,
    userDataDir,
  }) => {
    const realDirBefore = fileSig(realUserDataDir());
    const swiftFixture = path.resolve(
      __dirname,
      "../../tests/fixtures/swift-meeting-v1.stenomeeting",
    );
    const source = await codec.readPackage(swiftFixture);
    let sourceID: string;
    let sourceAudioHash: string;
    try {
      expect(source.audio).toHaveLength(1);
      sourceID = source.meeting.sourceMeetingID.toLowerCase();
      sourceAudioHash = source.audio[0].metadata.sha256;
    } finally { await source.cleanup(); }

    const transferDir = path.join(userDataDir, "transfer-fixtures");
    mkdirSync(transferDir, { recursive: true });
    const withAudioFile = path.join(transferDir, "with-audio.stenomeeting");
    const withoutAudioFile = path.join(
      transferDir,
      "without-audio.stenomeeting",
    );

    const { app, page } = await launchApp();
    await stubNativeDialogs(app, {});
    await app.evaluate(({ app: electronApp }, file) => {
      electronApp.emit("open-file", { preventDefault() {} } as any, file);
    }, swiftFixture);

    await expect
      .poll(async () => {
        const result = await page.evaluate(() =>
          (window as StenoWindow).stenoai.meetings.list(),
        );
        return result.meetings?.length;
      })
      .toBe(1);
    const afterOpen = await page.evaluate(() =>
      (window as StenoWindow).stenoai.meetings.list(),
    );
    const expectedSummary = afterOpen.meetings[0].session_info.summary_file;
    expect(path.basename(expectedSummary)).toBe(
      `transfer_${sourceID}_summary.json`,
    );
    expect(path.dirname(expectedSummary)).toBe(
      realpathSync(path.join(userDataDir, "output")),
    );

    const mediaFile = path.join(
      userDataDir,
      "output",
      ".meeting-transfer",
      `transfer_${sourceID}`,
      "track-1.caf",
    );
    expect(existsSync(mediaFile)).toBe(true);

    await stubNativeDialogs(app, {
      saveFile: withAudioFile,
      checkboxAudio: true,
    });
    const withAudio = await page.evaluate(
      (file) =>
        (window as StenoWindow).stenoai.meetingTransfer.exportPackage(file),
      expectedSummary,
    );
    expect(withAudio).toMatchObject({ success: true, cancelled: false });
    const included = await codec.readPackage(withAudioFile);
    try {
      expect(included.audio).toHaveLength(1);
      expect(included.audio[0].metadata.sha256).toBe(sourceAudioHash);
    } finally {
      await included.cleanup();
    }

    await stubNativeDialogs(app, {
      saveFile: withoutAudioFile,
      checkboxAudio: false,
    });
    const withoutAudio = await page.evaluate(
      (file) =>
        (window as StenoWindow).stenoai.meetingTransfer.exportPackage(file),
      expectedSummary,
    );
    expect(withoutAudio).toMatchObject({ success: true, cancelled: false });
    const excluded = await codec.readPackage(withoutAudioFile);
    try {
      expect(excluded.audio).toHaveLength(0);
      expect(JSON.stringify(excluded.transcript)).toContain(
        "Synthetic interop text.",
      );
    } finally {
      await excluded.cleanup();
    }

    const listed = await page.evaluate(() =>
      (window as StenoWindow).stenoai.meetings.list(),
    );
    const deleted = await page.evaluate(
      (meeting) => (window as StenoWindow).stenoai.meetings.delete(meeting),
      listed.meetings[0],
    );
    expect(deleted.success).toBe(true);
    expect(deleted.id).toBeTruthy();
    expect(existsSync(expectedSummary)).toBe(false);
    expect(existsSync(mediaFile)).toBe(true);

    const restored = await page.evaluate(
      (id) => (window as StenoWindow).stenoai.meetings.undoDelete(id),
      deleted.id!,
    );
    expect(restored.success).toBe(true);
    expect(existsSync(expectedSummary)).toBe(true);
    expect(existsSync(mediaFile)).toBe(true);

    const deletedAgain = await page.evaluate(
      (meeting) => (window as StenoWindow).stenoai.meetings.delete(meeting),
      restored.meeting!,
    );
    expect(deletedAgain.success).toBe(true);
    const committed = await page.evaluate(
      (id) => (window as StenoWindow).stenoai.meetings.commitDelete(id),
      deletedAgain.id!,
    );
    expect(committed.success).toBe(true);
    expect(existsSync(mediaFile)).toBe(false);

    await stubNativeDialogs(app, {});
    const reimported = await importPackage(page, swiftFixture);
    expect(reimported).toMatchObject({ success: true, duplicate: false });
    expect(existsSync(mediaFile)).toBe(true);
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  });
});

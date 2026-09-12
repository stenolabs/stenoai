'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { readPackage, writePackage } = require('./meeting-transfer-codec');
const { importIntoLibrary, makeExportContent, importedAudioSources } = require('./meeting-transfer-store');

const COPY = {
  invalid_package: 'This Steno package is damaged or invalid.',
  unsupported_format: 'This Steno package uses an unsupported format version.',
  package_too_large: 'This Steno package exceeds the supported transfer limits.',
  insufficient_space: 'There is not enough free disk space for this Steno package.',
  unsafe_file: 'Select a regular Steno package file.',
  source_changed: 'The source changed while it was being read. Try again.',
  destination_exists: 'A file already exists at that location. Choose a new filename.',
  unsupported_audio: 'This package contains an unsupported audio format.',
  transfer_conflict: 'A different version of this meeting has already been imported. The existing meeting was kept.',
  unsafe_storage: 'Steno could not safely access the meeting storage.',
  empty_package: 'This meeting has no notes, transcript, or selected audio to export.',
  busy: 'Wait until recording and processing have finished, then try again.',
  unsupported_platform: 'Steno package sharing is currently available on macOS.',
  transfer_failed: 'The Steno package could not be transferred. Check available disk space and try again.',
};

function safeFailure(error) {
  const code = Object.hasOwn(COPY, error?.code) ? error.code : 'transfer_failed';
  return { success: false, error: COPY[code], error_code: code };
}

function registerMeetingTransferIpc({ app, ipcMain, dialog, getMainWindow, exposeMainWindow,
  isBusy, getOutputDir, getUserDataDir, readMeeting, findAudioSource, prepareAudio,
  makeShareMenu, platform = process.platform }) {
  const pendingFiles = [];
  let readyContents = null;
  const observedContents = new WeakSet();
  let serial = Promise.resolve();
  const run = (operation) => {
    const next = serial.then(operation, operation);
    serial = next.catch(() => {});
    return next;
  };
  const guard = (summaryFile) => {
    if (platform !== 'darwin') throw { code: 'unsupported_platform' };
    if (isBusy(summaryFile)) throw { code: 'busy' };
  };
  const currentWindow = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw { code: 'transfer_failed' };
    return win;
  };
  const checkSender = (event) => event.sender === currentWindow().webContents;

  async function importFile(filePath) {
    let pkg;
    try {
      guard();
      const win = currentWindow();
      if (filePath === undefined) {
        const selected = await dialog.showOpenDialog(win, {
          title: 'Import Steno package', properties: ['openFile'],
          filters: [{ name: 'Steno meeting', extensions: ['stenomeeting'] }],
        });
        if (selected.canceled || !selected.filePaths.length) return { success: true, cancelled: true };
        [filePath] = selected.filePaths;
      }
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.stenomeeting') {
        throw { code: 'invalid_package' };
      }
      pkg = await readPackage(filePath);
      const selection = await dialog.showMessageBox(win, {
        type: 'question', title: 'Import Steno package', message: pkg.meeting.title,
        detail: `Includes ${pkg.manifest.capabilities.join(', ')}. This creates a local meeting. Existing meetings will not be overwritten.`,
        buttons: ['Import', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (selection.response !== 0) return { success: true, cancelled: true };
      guard();
      const result = await importIntoLibrary(pkg, getOutputDir());
      currentWindow().webContents.send('meeting-transfer-imported', result);
      return { success: true, ...result };
    } catch (error) { return safeFailure(error); }
    finally { if (pkg) await pkg.cleanup(); }
  }

  async function exportFile(summaryFile) {
    let prepared;
    try {
      guard(summaryFile);
      const win = currentWindow();
      const snapshot = await readMeeting(summaryFile);
      const hasImportedAudio = Array.isArray(snapshot.meeting.steno_transfer?.audio)
        && snapshot.meeting.steno_transfer.audio.length > 0;
      const sourceAudio = hasImportedAudio ? null : await findAudioSource(snapshot.realPath);
      const canIncludeAudio = hasImportedAudio || !!sourceAudio;
      const selection = await dialog.showMessageBox(win, {
        type: 'question', title: 'Export Steno package', message: snapshot.meeting.session_info.name || 'Meeting',
        detail: 'The package includes the saved notes, summary and transcript. It is not encrypted. After saving, choose AirDrop in the sharing menu to send it to another device.',
        buttons: ['Save and share…', 'Save…', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
        ...(canIncludeAudio ? { checkboxLabel: 'Include audio', checkboxChecked: false } : {}),
      });
      if (selection.response === 2) return { success: true, cancelled: true };
      const selected = await dialog.showSaveDialog(win, {
        title: 'Save Steno package', defaultPath: 'Meeting.stenomeeting',
        filters: [{ name: 'Steno meeting', extensions: ['stenomeeting'] }],
      });
      if (selected.canceled || !selected.filePath) return { success: true, cancelled: true };
      guard(summaryFile);
      // Reject a changed source rather than sending a different snapshot from
      // the one whose title and inclusion choices the user confirmed.
      const fresh = await readMeeting(summaryFile);
      if (snapshot.fingerprint !== fresh.fingerprint) throw { code: 'busy' };
      let audio = [];
      if (canIncludeAudio && selection.checkboxChecked === true) {
        // Audio can be large or independently unavailable. Read and validate it
        // only after selection; a text-only export never depends on its bytes.
        if (hasImportedAudio) audio = await importedAudioSources(snapshot.meeting, snapshot.realPath);
        else {
          prepared = await prepareAudio(sourceAudio);
          audio = prepared.audio;
        }
      }
      const content = await makeExportContent(snapshot.meeting, snapshot.realPath, getUserDataDir(), audio, app.getVersion());
      const destination = path.resolve(selected.filePath);
      if (path.extname(destination).toLowerCase() !== '.stenomeeting') throw { code: 'invalid_package' };
      // The writer uses exclusive create: even a save-dialog overwrite
      // confirmation never allows us to truncate a pre-existing package.
      await writePackage(destination, content);
      if (selection.response === 0) {
        // ShareMenu supplies no transfer-completed event. Share the deliberately
        // saved file, which remains available after the menu closes.
        makeShareMenu({ filePaths: [destination] }).popup({ window: win });
      }
      return { success: true, cancelled: false };
    } catch (error) { return safeFailure(error); }
    finally { if (prepared) await prepared.cleanup(); }
  }

  const drain = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || readyContents !== win.webContents) return;
    while (pendingFiles.length) {
      const file = pendingFiles.shift();
      void run(async () => {
        exposeMainWindow();
        const result = await importFile(file);
        if (!result.success) await dialog.showMessageBox(currentWindow(), {
          type: 'error', title: 'Import Steno package', message: result.error,
        });
      }).catch(() => {});
    }
  };
  const openFile = (file) => {
    if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.stenomeeting') return false;
    if (pendingFiles.length < 32 && !pendingFiles.includes(file)) pendingFiles.push(file);
    drain();
    return true;
  };
  if (platform === 'darwin') app.on('open-file', (event, file) => {
    if (openFile(file)) event.preventDefault();
  });

  ipcMain.handle('import-meeting-package', (event, file) => {
    if (!checkSender(event)) return safeFailure({ code: 'transfer_failed' });
    return run(() => importFile(file));
  });
  ipcMain.handle('export-meeting-package', (event, file) => {
    if (!checkSender(event)) return safeFailure({ code: 'transfer_failed' });
    return run(() => exportFile(file));
  });
  ipcMain.handle('meeting-transfer-ready', (event) => {
    if (!checkSender(event)) return safeFailure({ code: 'transfer_failed' });
    readyContents = event.sender;
    if (!observedContents.has(event.sender)) {
      observedContents.add(event.sender);
      event.sender.on('did-start-loading', () => { if (readyContents === event.sender) readyContents = null; });
      event.sender.once('destroyed', () => { if (readyContents === event.sender) readyContents = null; });
    }
    drain();
    return { success: true };
  });
  return { openFile };
}

// Capture a fixed local source before decoding/converting it. Never pass a
// renderer-supplied arbitrary file into ffmpeg through the export handler.
async function copyRegularFile(source, target) {
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 16n * 1024n ** 3n) throw { code: 'unsupported_audio' };
    const output = await fs.open(target, 'wx', 0o600);
    try {
      const buf = Buffer.alloc(1024 * 1024);
      let position = 0;
      while (position < Number(before.size)) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, Number(before.size) - position), position);
        if (!bytesRead) throw { code: 'unsupported_audio' };
        let written = 0;
        while (written < bytesRead) written += (await output.write(buf, written, bytesRead - written)).bytesWritten;
        position += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw { code: 'busy' };
    } finally { await output.close(); }
  } finally { await handle.close(); }
}

module.exports = { registerMeetingTransferIpc, copyRegularFile, safeFailure };

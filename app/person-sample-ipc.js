'use strict';

const PERSON_SAMPLE_UNAVAILABLE = {
  success: false,
  error: 'voice sample unavailable',
};

function registerPersonSampleIpc({ ipcMain, runPythonScript }) {
  ipcMain.handle('get-person-sample-audio', async (_event, personId) => {
    try {
      const out = await runPythonScript('simple_recorder.py', [
        'get-person-sample-audio',
        personId,
      ]);
      return JSON.parse(out);
    } catch {
      return { ...PERSON_SAMPLE_UNAVAILABLE };
    }
  });
}

module.exports = { registerPersonSampleIpc };

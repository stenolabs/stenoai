'use strict';

/**
 * IPC for Suggested actions (mcp-actions.js): the Connect page's action
 * connections and the action cards under a note. Registered once from
 * main.js, like steno-mcp-ipc.js.
 *
 * The renderer is untrusted: every note path goes through main.js's
 * validateMeetingFilePath (symlink-safe, output/ only) and the service is
 * handed the canonical real path; ids and arguments are type-checked here
 * and validated again inside the service. Errors come back as a stable
 * `code` plus a short message, never a stack, a URL with a token, or a
 * secret.
 */

const { ActionError } = require('./mcp-actions');

const MAX_ARGS_BYTES = 256 * 1024;

function fail(e) {
  if (e instanceof ActionError || (e && typeof e.code === 'string' && e.name === 'ActionError')) {
    return { success: false, error_code: e.code, error: e.message, ...(e.validationErrors ? { validationErrors: e.validationErrors } : {}) };
  }
  return { success: false, error_code: 'error', error: 'Something went wrong' };
}

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

function registerMcpActionsIpc({ ipcMain, getService, validateMeetingFilePath, log = () => {} }) {
  // Each channel is a literal ipcMain.handle so ipc-contract.test.js sees it.
  const wrap = (channel, fn) => async (_event, ...args) => {
    try {
      return { success: true, ...(await fn(...args)) };
    } catch (e) {
      if (!(e instanceof ActionError)) log(`[actions] ${channel} failed: ${e?.name || 'Error'}`);
      return fail(e);
    }
  };

  const notePath = async (summaryFile) => {
    if (typeof summaryFile !== 'string' || !summaryFile) throw new ActionError('invalid-note', 'Note not found');
    const validated = await validateMeetingFilePath(summaryFile);
    if (validated.error) throw new ActionError('invalid-note', 'Note not found');
    return validated.realPath;
  };

  const requireId = (id) => {
    if (!isId(id)) throw new ActionError('invalid-id', 'Unknown item');
    return id;
  };

  ipcMain.handle('actions-list', wrap('actions-list', async () => getService().list()));

  ipcMain.handle('actions-add-custom', wrap('actions-add-custom', async (input) => {
    if (!input || typeof input !== 'object') throw new ActionError('invalid-input', 'Fill in the endpoint details');
    const { name, url, auth, headerName, token } = input;
    return { connection: await getService().addCustom({ name, url, auth, headerName, token }) };
  }));

  // A command on this computer (stdio MCP server). The service validates it
  // and asks for a native confirmation before anything is saved or run.
  ipcMain.handle('actions-add-local', wrap('actions-add-local', async (input) => {
    if (!input || typeof input !== 'object') throw new ActionError('invalid-input', 'Fill in the command');
    const { name, command, args, env } = input;
    return { connection: await getService().addLocal({ name, command, args, env }) };
  }));

  ipcMain.handle('actions-connect-connector', wrap('actions-connect-connector', async (connectorId) => ({
    connection: await getService().connectConnector(requireId(connectorId)),
  })));

  ipcMain.handle('actions-authorize', wrap('actions-authorize', async (id) => ({ connection: await getService().authorize(requireId(id)) })));

  ipcMain.handle('actions-cancel-authorize', wrap('actions-cancel-authorize', async () => ({ cancelled: getService().cancelAuthorize() })));

  ipcMain.handle('actions-refresh-tools', wrap('actions-refresh-tools', async (id) => ({ connection: await getService().refreshTools(requireId(id)) })));

  ipcMain.handle('actions-set-enabled', wrap('actions-set-enabled', async (id, enabled) => {
    if (typeof enabled !== 'boolean') throw new ActionError('invalid-input', 'Invalid setting');
    return { connection: await getService().setEnabled(requireId(id), enabled) };
  }));

  ipcMain.handle('actions-remove', wrap('actions-remove', async (id) => ({ removed: getService().remove(requireId(id)) })));

  ipcMain.handle('actions-set-auto-suggest', wrap('actions-set-auto-suggest', async (value) => {
    if (typeof value !== 'boolean') throw new ActionError('invalid-input', 'Invalid setting');
    return { autoSuggest: getService().setAutoSuggest(value) };
  }));

  ipcMain.handle('actions-get-cards', wrap('actions-get-cards', async (summaryFile) => {
    const service = getService();
    const realPath = await notePath(summaryFile);
    return { cards: await service.getCards(realPath), available: await service.hasUsableConnections() };
  }));

  ipcMain.handle('actions-suggest', wrap('actions-suggest', async (summaryFile, options) => {
    const realPath = await notePath(summaryFile);
    const auto = Boolean(options && options.auto === true);
    return getService().suggest(realPath, { auto });
  }));

  ipcMain.handle('actions-approve', wrap('actions-approve', async (summaryFile, cardId, args) => {
    const realPath = await notePath(summaryFile);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ActionError('invalid-arguments', 'Arguments must be an object');
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) throw new ActionError('invalid-arguments', 'Arguments are too large');
    return { card: await getService().approve(realPath, requireId(cardId), args) };
  }));

  ipcMain.handle('actions-dismiss', wrap('actions-dismiss', async (summaryFile, cardId) => {
    const realPath = await notePath(summaryFile);
    return { cards: await getService().dismiss(realPath, requireId(cardId)) };
  }));

  ipcMain.handle('actions-recent', wrap('actions-recent', async (limit) => ({
    entries: getService().recent(Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50),
  })));
}

module.exports = { registerMcpActionsIpc };

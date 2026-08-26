'use strict';

/**
 * The renderer must keep running during E2E tests, but the native window must
 * not interrupt whoever is using the host Mac. Keeping this decision pure
 * gives the main process one gate for every show/focus path.
 */
function mayExposeMainWindow({ isE2EHeadless = false } = {}) {
  return !isE2EHeadless;
}

module.exports = { mayExposeMainWindow };

'use strict';

// electron-builder beforePack hook: build the Steno MCP server bundle and
// Steno.mcpb into steno-mcp/dist, which extraResources copies into the app's
// resources/steno-mcp. Runs for every package.json and CI-config build, so no
// workflow can package the app without it. Idempotent; runs once per arch.
module.exports = async function beforePack() {
  const { buildStenoMcp } = await import('./build-steno-mcp.mjs');
  await buildStenoMcp();
};

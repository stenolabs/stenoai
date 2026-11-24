#!/usr/bin/env node
// Builds the Steno MCP server for packaging:
//
//   steno-mcp/dist/server/index.mjs   one self-contained ESM file (SDK bundled)
//   steno-mcp/dist/manifest.json      MCPB manifest (spec 0.3)
//   steno-mcp/dist/icon.png
//   steno-mcp/dist/Steno.mcpb         zip of the three above, for Claude Desktop
//
// electron-builder copies steno-mcp/dist to resources/steno-mcp (extraResources),
// so the packaged app ships both the server Steno's own Electron runs with
// ELECTRON_RUN_AS_NODE=1 (Claude Code, Codex, Cursor) and the .mcpb that
// Claude Desktop installs and runs with its own Node.
//
// Run directly (`npm run build:mcp`) or via the electron-builder beforePack hook.
// `--out <dir>` writes elsewhere (tests).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { writeZip } from './zip-store.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(APP_DIR, 'steno-mcp');

export function buildManifest(version) {
  return {
    manifest_version: '0.3',
    name: 'steno',
    display_name: 'Steno',
    version,
    description: 'Read-only access to your Steno meeting notes, on this device.',
    long_description:
      'Search your Steno meetings, read notes and transcripts, and list action items. ' +
      'The server reads the notes Steno stores on this computer. It is read-only and makes no network connections. ' +
      'Choose which folders it can see, and whether transcripts are included, in Steno under Connect.',
    author: { name: 'Steno', url: 'https://stenoai.co' },
    homepage: 'https://github.com/stenolabs/stenoai',
    repository: { type: 'git', url: 'https://github.com/stenolabs/stenoai.git' },
    icon: 'icon.png',
    license: 'MIT',
    keywords: ['meetings', 'notes', 'transcripts', 'local'],
    server: {
      type: 'node',
      entry_point: 'server/index.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.mjs'],
        env: {},
      },
    },
    tools: [
      { name: 'search_meetings', description: 'Search meeting notes and transcripts.' },
      { name: 'get_note', description: 'Get one meeting note as Markdown.' },
      { name: 'get_transcript', description: 'Get one meeting transcript.' },
      { name: 'list_action_items', description: 'List action items across meetings.' },
      { name: 'list_folders', description: 'List the folders shared with assistants.' },
    ],
    compatibility: {
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: '>=20.0.0' },
    },
  };
}

export async function buildStenoMcp({ outDir = path.join(SRC, 'dist'), quiet = false } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  fs.rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: false,
    root: SRC,
    logLevel: quiet ? 'silent' : 'warn',
    resolve: { conditions: ['node', 'import'] },
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: path.join(SRC, 'index.mjs'),
      outDir: path.join(outDir, 'server'),
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      sourcemap: false,
      rollupOptions: {
        // zod's own build notes trip Rollup's comment-position check; harmless.
        onwarn(warning, warn) {
          if (warning.code !== 'INVALID_ANNOTATION') warn(warning);
        },
        output: { format: 'es', entryFileNames: 'index.mjs', inlineDynamicImports: true },
      },
    },
  });
  // The version placeholder is a string literal, not an identifier, so swap it
  // after bundling rather than through `define`.
  const bundlePath = path.join(outDir, 'server', 'index.mjs');
  const bundled = fs.readFileSync(bundlePath, 'utf8');
  if (!bundled.includes('__STENO_VERSION__')) throw new Error('version placeholder missing from bundle');
  fs.writeFileSync(bundlePath, bundled.split('__STENO_VERSION__').join(version));

  const manifest = `${JSON.stringify(buildManifest(version), null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifest);
  const icon = fs.readFileSync(path.join(APP_DIR, 'build', 'icon.png'));
  fs.writeFileSync(path.join(outDir, 'icon.png'), icon);

  const mcpbPath = path.join(outDir, 'Steno.mcpb');
  writeZip(mcpbPath, [
    { name: 'manifest.json', data: Buffer.from(manifest) },
    { name: 'icon.png', data: icon },
    { name: 'server/index.mjs', data: fs.readFileSync(bundlePath) },
  ]);
  if (!quiet) console.log(`steno-mcp: built ${path.relative(APP_DIR, outDir)} (v${version})`);
  return { outDir, bundlePath, mcpbPath, version };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const i = process.argv.indexOf('--out');
  buildStenoMcp(i !== -1 ? { outDir: path.resolve(process.argv[i + 1]) } : {}).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

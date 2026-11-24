'use strict';

/**
 * The text of the native dialog that confirms a local MCP server (main.js
 * confirmLocalCommand). Pure, so the exact wording is unit-tested: the user is
 * about to let a program run with their permissions, and what they are shown
 * must be what will run.
 *
 *   - every argument on its own line, numbered, none dropped: a long argument
 *     is elided in the middle and says how long it really is;
 *   - environment variables as KEY=value with the value elided the same way,
 *     so a value that smuggles a second command (`"x; curl … | sh"`) is
 *     visible, not just its name;
 *   - the name passes through the same cleaner the stored connection uses.
 */

const { cleanName } = require('./mcp-connections');

const MAX_ARG_SHOWN = 160;
const MAX_ENV_VALUE_SHOWN = 80;
// Arguments past this count still appear, under a "+N more" heading, so the
// list stays readable for the common case without ever hiding anything.
const ARGS_BEFORE_MORE = 24;

/** Keep the first and last part of a long string, saying how long it was. */
function elide(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  const keep = Math.max(8, Math.floor((max - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(-keep)} (${s.length} characters)`;
}

/** Control characters would let one argument print as several lines. */
function printable(text) {
  return String(text).replace(/[\u0000-\u001f\u007f]/g, '�');
}

function quoteArg(arg) {
  const s = printable(arg);
  return s === '' || /\s/.test(s) ? JSON.stringify(s) : s;
}

function describeLocalCommand({ name, command, args = [], env = {} } = {}) {
  const shownName = cleanName(name, '');
  const list = Array.isArray(args) ? args : [];
  const lines = [`Program: ${elide(printable(command), MAX_ARG_SHOWN)}`];
  if (list.length) {
    lines.push(`Arguments (${list.length}):`);
    list.slice(0, ARGS_BEFORE_MORE).forEach((a, i) => lines.push(`  ${i + 1}. ${elide(quoteArg(a), MAX_ARG_SHOWN)}`));
    if (list.length > ARGS_BEFORE_MORE) {
      lines.push(`  +${list.length - ARGS_BEFORE_MORE} more arguments:`);
      list.slice(ARGS_BEFORE_MORE).forEach((a, i) => lines.push(`  ${ARGS_BEFORE_MORE + i + 1}. ${elide(quoteArg(a), MAX_ARG_SHOWN)}`));
    }
  } else {
    lines.push('Arguments: none');
  }
  const entries = env && typeof env === 'object' ? Object.entries(env) : [];
  if (entries.length) {
    lines.push('', `Environment variables (${entries.length}):`);
    for (const [k, v] of entries) lines.push(`  ${printable(k)}=${elide(printable(v), MAX_ENV_VALUE_SHOWN)}`);
  }
  return {
    message: shownName ? `Add "${shownName}" as a local MCP server?` : 'Add a local MCP server?',
    detail: 'Steno will run this program on this computer, with your permissions, whenever it lists or uses its tools:\n\n'
      + `${lines.join('\n')}\n\nOnly add programs you trust.`,
  };
}

module.exports = { describeLocalCommand, elide, MAX_ARG_SHOWN, MAX_ENV_VALUE_SHOWN, ARGS_BEFORE_MORE };

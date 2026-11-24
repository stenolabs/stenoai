/**
 * Parsing for the "Command on this computer" form (Connect → Custom MCP
 * server). Nothing here runs anything: the main process validates the result
 * again, asks the user to confirm it in a native dialog, and starts the
 * program without a shell.
 */

/**
 * Split a command line the way a POSIX shell splits words: whitespace
 * separates, single quotes are literal, double quotes group (with \" and \\
 * escapes), a backslash outside quotes escapes the next character. No
 * variables, globs, pipes or `~` expansion (the main process expands a
 * leading `~/`). Returns null for an unterminated quote.
 */
export function splitCommandLine(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < line.length && line[i + 1] !== '\n') {
      cur += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) out.push(cur);
  return out;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `KEY=value` lines into an object. Blank lines and `#` comments are
 * skipped; an `export ` prefix is allowed. Returns { env } or { error: line
 * number (1-based) } for the first line that is not KEY=value.
 */
export function parseEnvLines(text: string): { env: Record<string, string> } | { error: number } {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim();
    if (!raw || raw.startsWith('#')) continue;
    const line = raw.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!ENV_NAME.test(key)) return { error: i + 1 };
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return { env };
}

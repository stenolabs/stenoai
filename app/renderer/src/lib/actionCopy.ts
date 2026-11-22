import type { FormField } from './actionForm';

/**
 * Plain-language pieces of an action card: "Create page in Notion ·
 * Website content cleanup", and which two or three fields are worth showing
 * inline. Everything else stays under "Show what will be sent".
 */

/** "Create page" from a tool's title, or from its name ("notion-create-pages"). */
export function actionPhrase(tool: string, toolTitle: string | null, connectionName: string): string {
  const source = toolTitle?.trim() || tool;
  let words = source
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.:/]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  // Drop a vendor prefix that repeats the connection ("notion-create-pages").
  const vendor = connectionName.trim().toLowerCase().split(/\s+/)[0];
  if (words.length > 1 && vendor && words[0] === vendor) words = words.slice(1);
  if (!words.length) return source;
  const [first, ...rest] = words;
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(' ');
}

const HEADLINE_KEYS = /^(title|name|summary|subject)$/i;

/** The value that names what will be created ("Website content cleanup"), if any. */
export function headlineValue(args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) {
    if (!HEADLINE_KEYS.test(key)) continue;
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // Notion's create-pages nests the title: { pages: [{ properties: { title } }] }.
  const pages = args.pages;
  if (Array.isArray(pages) && pages[0] && typeof pages[0] === 'object') {
    const props = (pages[0] as Record<string, unknown>).properties;
    if (props && typeof props === 'object') {
      const title = (props as Record<string, unknown>).title;
      if (typeof title === 'string' && title.trim()) return title.trim();
    }
  }
  return null;
}

// Most important first. A field matches the first rank whose pattern fits.
const RANKS = [
  /^(title|name)$/i,
  /^(summary|subject)$/i,
  /^(description|body|content|text|message)$/i,
  /^(assignee|assignee_?id|owner)$/i,
  /^(due|due_?date|deadline)$/i,
];

function rankOf(key: string): number {
  const i = RANKS.findIndex((re) => re.test(key));
  return i === -1 ? RANKS.length : i;
}

/**
 * The keys of the fields to show inline: up to `max`, the important ones
 * first (title/name, summary, description, assignee, due), topped up with
 * required fields; plus any required field that still has no value, since
 * Approve cannot work without it. Everything else is under the disclosure.
 */
export function inlineFieldKeys(fields: FormField[], args: Record<string, unknown>, max = 3): string[] {
  const keys = fields
    .map((f, i) => ({ f, i, rank: rankOf(f.key) }))
    .filter((x) => x.rank < RANKS.length)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, max)
    .map((x) => x.f.key);
  for (const f of fields) {
    if (keys.length >= max) break;
    if (f.required && !keys.includes(f.key)) keys.push(f.key);
  }
  for (const f of fields) {
    const empty = args[f.key] === undefined || args[f.key] === null || args[f.key] === '';
    if (f.required && empty && !keys.includes(f.key)) keys.push(f.key);
  }
  return keys;
}

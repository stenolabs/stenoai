import * as React from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CHART_COPY, parseChatChart } from '@/lib/chatChart';
import { ChartErrorBoundary } from '@/components/ChartErrorBoundary';
import yaml, { type EventType, type State } from 'js-yaml';
import { t } from '@/i18n';

const ChatChart = React.lazy(() => import('@/components/ChatChart'));
const MarkdownSource = React.createContext('');

function ChartCodeBlock({ node, children, ...props }: React.ComponentProps<'pre'> & ExtraProps) {
  const source = React.useContext(MarkdownSource);
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
  const classes = code?.type === 'element' ? code.properties.className : undefined;
  const language = Array.isArray(classes)
    ? classes
        .find((name) => typeof name === 'string' && name.startsWith('language-'))
        ?.toString()
        .slice(9)
    : undefined;
  const fallback = (
    <pre {...props} data-lang={language}>
      {children}
    </pre>
  );
  if (language !== 'steno-chart' || code?.type !== 'element') return fallback;

  // CommonMark also produces a code node for an unfinished streaming fence.
  // Inspect the source span so charts only render once the fence is closed.
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return fallback;
  const lines = source.slice(start, end).trimEnd().split(/\r?\n/);
  const opening = lines[0].trimStart().match(/^(`{3,}|~{3,})steno-chart\s*$/)?.[1];
  const closing = lines[lines.length - 1].trim().match(/^(`{3,}|~{3,})$/)?.[1];
  if (!opening || !closing || opening[0] !== closing[0] || closing.length < opening.length)
    return fallback;
  const content = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
  const spec = parseChatChart(content);
  if (!spec) return fallback;
  return (
    <ChartErrorBoundary fallback={fallback}>
      <React.Suspense fallback={<p role="status">{CHART_COPY.loading}</p>}>
        <ChatChart spec={spec} />
      </React.Suspense>
    </ChartErrorBoundary>
  );
}

const markdownComponents = { pre: ChartCodeBlock };

export function stripReasoning(text: string): string {
  if (!text) return text;

  const startsWithReasoning = /^\s*<(think|thought|thinking|reasoning)>/i.test(text);

  // Consumes optional leading spaces on the line, the block, and one optional trailing newline.
  let result = text.replace(
    /(?:^[ \t]*)?<(think|thought|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$(?![\s\S]))\n?/gim,
    ''
  );

  if (startsWithReasoning) {
    result = result.replace(/^\n+/, '');
  }

  return result;
}

// Some providers use typographic bullets rather than Markdown markers. Keep
// those lists readable without changing literal examples inside code fences.
function normalizeBullets(text: string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
          fence = null;
        return line;
      }
      return fence ? line : line.replace(/^( {0,3})•[ \t]+/, '$1- ');
    })
    .join('\n');
}

/** Shared safe Markdown rendering for saved and in-flight chat answers.
 * CommonMark keeps loose lists (blank lines between items) in a single ol,
 * preserves explicit starts and nesting, and handles incomplete streaming text.
 * Raw HTML is never interpreted. GFM retains the existing table support.
 */
export function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;
  const source = normalizeBullets(stripReasoning(text));
  return (
    <MarkdownSource.Provider value={source}>
      <div className="chat-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {source}
        </ReactMarkdown>
      </div>
    </MarkdownSource.Provider>
  );
}

// ---------------------------------------------------------------------------
// Report frontmatter
// ---------------------------------------------------------------------------

// A report template can ask for output that OPENS with YAML frontmatter.
// Markdown has no concept of it. Handed the whole document, react-markdown
// turns the opening `---` into a horizontal rule, and the closing one either
// underlines every key above it into a single heading or, after a list,
// becomes a second rule — which is what the report view showed.
//
// The keys every note already carries in its own frontmatter are dropped
// rather than repeated: the header shows the title, date and duration a few
// pixels above, and the language is the note's, not the report's. Matched
// without regard to case, so a model's `Title:` goes too.
const HEADER_DUPLICATE_KEYS = new Set(['title', 'date', 'duration_seconds', 'duration', 'language']);

// Frontmatter longer than this stays in the body. Real reports' frontmatter
// runs to about 2 KB, so this leaves room for templates that ask for much
// more. With anchors refused and values flat (below), what is parsed and
// shown is no larger than the text, so this bounds both.
const MAX_FRONTMATTER_LENGTH = 30_000;

// js-yaml 4 cannot turn aliases off (5.x has `maxAliases: 0`), and an alias
// expands to a full copy wherever it is used: a few thousand characters of
// nested aliases can stand for hundreds of millions. The parse listener sees
// each node as it closes, with the anchor it defines. An alias can only point
// at an anchor, so refusing anchors refuses aliases.
function refuseAnchors(event: EventType, state: State): void {
  if (event === 'close' && (state as State & { anchor: string | null }).anchor !== null) {
    throw new Error(); // caught in splitFrontmatter, never shown
  }
}

// The shapes Obsidian's properties take: text, numbers, booleans, and lists of
// those.
const isScalar = (value: unknown) => value === null || typeof value !== 'object';
const isFlat = (value: unknown) => isScalar(value) || (Array.isArray(value) && value.every(isScalar));

export type ReportProperty = [string, unknown];

/**
 * Split leading YAML frontmatter from a report.
 *
 * Parsed with js-yaml rather than by hand: a colon inside a value, quoting
 * and lists are where hand-rolled frontmatter parsing goes wrong. The CORE
 * schema, not the default one, so a date stays the text the model wrote
 * (`2026-09-30`) instead of becoming a Date shown in the local time zone.
 *
 * Properties are flat, as Obsidian's are. Frontmatter with a nested map or
 * list stays in the body, and so does frontmatter with an anchor.
 *
 * Returns no properties for ordinary reports, which have no frontmatter, so
 * the caller renders exactly what it always did.
 */
export function splitFrontmatter(text: string): { properties: ReportProperty[]; body: string } {
  const empty = { properties: [] as ReportProperty[], body: text ?? '' };
  // CRLF line endings, from a report written or synced elsewhere, would hide
  // both delimiters.
  const source = text?.replace(/\r\n/g, '\n');
  const open = source && /^---[ \t]*\n/.exec(source);
  if (!open) return empty;
  const rest = source.slice(open[0].length);
  // The closing delimiter is a line of its own: `----` or `---oops` is not one.
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) return empty;
  const raw = rest.slice(0, close.index);
  if (raw.length > MAX_FRONTMATTER_LENGTH) return empty;
  const body = rest.slice(close.index + close[0].length).replace(/^\n+/, '');
  let properties: ReportProperty[];
  try {
    const parsed: unknown = yaml.load(raw, { schema: yaml.CORE_SCHEMA, listener: refuseAnchors });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    properties = Object.entries(parsed as Record<string, unknown>).filter(
      ([k, v]) => !HEADER_DUPLICATE_KEYS.has(k.toLowerCase()) && v !== null && v !== undefined && v !== '' &&
        !(Array.isArray(v) && v.length === 0),
    );
  } catch {
    // Unparseable frontmatter is left in the body rather than thrown away:
    // showing it badly beats losing it silently.
    return empty;
  }
  if (!properties.every(([, v]) => isFlat(v))) return empty;
  return { properties, body };
}

// One value: booleans read yes/no. The lookups stay in JSX, where the i18n
// copy inventory counts them as rendered copy.
function PropertyText({ value }: { value: unknown }): React.ReactElement {
  if (typeof value === 'boolean') {
    return <>{value ? t('report.properties.yes') : t('report.properties.no')}</>;
  }
  return <>{String(value)}</>;
}

function PropertyValue({ value }: { value: unknown }): React.ReactElement {
  if (Array.isArray(value)) {
    return (
      <div className="flex flex-col gap-0.5">
        {value.map((v, i) => (
          <div key={i}>
            <PropertyText value={v} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <span>
      <PropertyText value={value} />
    </span>
  );
}

/** The structured half of a report, as a compact key/value header. The `id`
 *  lets the on-screen disclosure point at it (aria-controls). The same markup
 *  goes into the PDF, which has no Tailwind and maps the colour tokens below
 *  onto its own palette (see notesPdf.ts, `.report dl`). */
export function ReportProperties({
  properties,
  id,
}: {
  properties: ReportProperty[];
  id?: string;
}): React.ReactElement | null {
  if (!properties.length) return null;
  return (
    <dl
      id={id}
      className="grid gap-x-4 gap-y-1 rounded-lg px-3 py-2.5 text-[13px]"
      style={{
        gridTemplateColumns: 'minmax(6rem, max-content) 1fr',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
      }}
      data-testid="report-properties"
    >
      {properties.map(([key, value]) => (
        <React.Fragment key={key}>
          <dt style={{ color: 'var(--fg-2)' }}>{key}</dt>
          <dd className="min-w-0" style={{ color: 'var(--fg-1)' }}>
            <PropertyValue value={value} />
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

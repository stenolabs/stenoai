import * as React from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CHART_COPY, parseChatChart } from '@/lib/chatChart';
import { ChartErrorBoundary } from '@/components/ChartErrorBoundary';

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

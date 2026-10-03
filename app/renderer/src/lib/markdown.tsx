import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function stripReasoning(text: string): string {
  if (!text) return text;

  const startsWithReasoning = /^\s*<(think|thought|thinking|reasoning)>/i.test(text);

  // Consumes optional leading spaces on the line, the block, and one optional trailing newline.
  let result = text.replace(
    /(?:^[ \t]*)?<(think|thought|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$(?![\s\S]))\n?/gim,
    '',
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
  return text.split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    return fence ? line : line.replace(/^( {0,3})•[ \t]+/, '$1- ');
  }).join('\n');
}

/** Shared safe Markdown rendering for saved and in-flight chat answers.
 * CommonMark keeps loose lists (blank lines between items) in a single ol,
 * preserves explicit starts and nesting, and handles incomplete streaming text.
 * Raw HTML is never interpreted. GFM retains the existing table support.
 */
export function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {normalizeBullets(stripReasoning(text))}
      </ReactMarkdown>
    </div>
  );
}

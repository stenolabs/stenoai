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
        {stripReasoning(text)}
      </ReactMarkdown>
    </div>
  );
}

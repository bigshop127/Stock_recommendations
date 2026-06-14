import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

// Obsidian callout（> [!tip] …）markdown 沒有原生支援 → 轉成「emoji + 粗體標題」仍保留 blockquote，
// 內層 markdown（粗體/清單）照常渲染。報告內嵌的 <span style>、<mark> 由 rehype-raw 原樣呈現。
const CALLOUT: Record<string, string> = {
  tip: '💡',
  note: '📝',
  info: 'ℹ️',
  warning: '⚠️',
  danger: '🚨',
  caution: '🚨',
  important: '❗',
  success: '✅',
  question: '❓',
  quote: '💬',
  abstract: '📋',
  example: '📌',
};

function prepareMarkdown(md: string): string {
  return md.replace(/^(\s*>\s*)\[!(\w+)\][+-]?\s*(.*)$/gim, (_m, prefix: string, type: string, title: string) => {
    const emoji = CALLOUT[type.toLowerCase()] || '🔖';
    const t = (title || '').trim();
    return `${prefix}${emoji} **${t || type.toUpperCase()}**`;
  });
}

export function ReportView({ markdown }: { markdown: string }) {
  return (
    <div className="report-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        }}
      >
        {prepareMarkdown(markdown)}
      </ReactMarkdown>
    </div>
  );
}

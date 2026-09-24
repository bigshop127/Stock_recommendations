import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { CircleCheck, CircleHelp, Flame, Info, List, Pencil, Quote, TriangleAlert, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { REPORT_SANITIZE_SCHEMA, rehypeReportColors, remarkCallouts, stripFrontmatter } from '../lib/reportMarkdown';
import type { CalloutKind } from '../lib/reportMarkdown';
import './reportMarkdown.css';

// Obsidian 預設 callout 圖示：note=鉛筆、tip=火焰、warning=三角驚嘆號、danger=閃電…
const ICONS: Record<CalloutKind, LucideIcon> = {
  note: Pencil,
  info: Info,
  tip: Flame,
  warning: TriangleAlert,
  danger: Zap,
  success: CircleCheck,
  question: CircleHelp,
  quote: Quote,
  example: List,
};

const components: Components = {
  a: ({ node, ...props }) => {
    void node;
    return <a {...props} target="_blank" rel="noreferrer noopener" />;
  },
  // 表格外包一層，手機上才能橫向捲動又不撐破整頁
  table: ({ node, children }) => {
    void node;
    return (
      <div className="rpt-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
  // callout 標題：補上圖示（類型放在 data-callout，由 lib/reportMarkdown 的 remark 外掛寫入）
  div: ({ node, className, children, ...rest }) => {
    void node;
    if (className?.split(' ').includes('callout-title')) {
      const kind = (rest as Record<string, unknown>)['data-callout'] as CalloutKind | undefined;
      const Icon = (kind && ICONS[kind]) || Pencil;
      return (
        <div className={className}>
          <Icon className="callout-icon" aria-hidden="true" />
          <div>{children}</div>
        </div>
      );
    }
    return <div className={className}>{children}</div>;
  },
};

const REMARK_PLUGINS = [remarkGfm, remarkCallouts];
const REHYPE_PLUGINS: Options['rehypePlugins'] = [rehypeRaw, rehypeReportColors, [rehypeSanitize, REPORT_SANITIZE_SCHEMA]];

/** 老王每日報告的 markdown 渲染（排版比照 Obsidian，深色主題）。 */
export function ReportView({ markdown }: { markdown: string }) {
  return (
    <div className="report-md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {stripFrontmatter(markdown)}
      </ReactMarkdown>
    </div>
  );
}

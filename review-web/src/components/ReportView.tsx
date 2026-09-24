import { Children } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { CircleCheck, CircleHelp, Flame, Info, List, Pencil, Quote, TriangleAlert, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  REPORT_SANITIZE_SCHEMA,
  rehypeReportColors,
  rehypeReportFlags,
  remarkCallouts,
  remarkSubheads,
  stripFrontmatter,
} from '../lib/reportMarkdown';
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

/**
 * 「主標：副標」拆成兩行（154／617 個 ## 標題有副標，例如「台股評估與選股邏輯：買就要買同族群最強指標股」）：
 * 主標維持標題大小，副標縮小變淡放在下一行，一眼看得出這段在講什麼。
 * 只處理標題最上層文字裡的第一個全形冒號；冒號在粗體等巢狀元素裡就不拆。
 */
function splitSubtitle(children: ReactNode): { main: ReactNode[]; sub: ReactNode[] } {
  const arr = Children.toArray(children);
  const i = arr.findIndex((c) => typeof c === 'string' && c.includes('：'));
  if (i < 0) return { main: arr, sub: [] };
  const text = arr[i] as string;
  const k = text.indexOf('：');
  const main = [...arr.slice(0, i), text.slice(0, k)];
  const sub = [text.slice(k + 1).trimStart(), ...arr.slice(i + 1)];
  const mainHasContent = main.some((c) => typeof c !== 'string' || c.trim() !== '');
  const subHasContent = sub.some((c) => typeof c !== 'string' || c.trim() !== '');
  return mainHasContent && subHasContent ? { main, sub } : { main: arr, sub: [] };
}

const components: Components = {
  h2: ({ node, children, ...rest }) => {
    void node;
    const { main, sub } = splitSubtitle(children);
    return (
      <h2 {...rest}>
        {main}
        {sub.length > 0 && <span className="rpt-h-sub">{sub}</span>}
      </h2>
    );
  },
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

const REMARK_PLUGINS = [remarkGfm, remarkCallouts, remarkSubheads];
const REHYPE_PLUGINS: Options['rehypePlugins'] = [rehypeRaw, rehypeReportColors, rehypeReportFlags, [rehypeSanitize, REPORT_SANITIZE_SCHEMA]];

/**
 * 老王每日報告的 markdown 渲染（排版比照 Obsidian，深色主題）。
 * 字級由外層設的 CSS 變數 --rpt-font-size 決定；panel＝小分頁裡的一段，第一個元素貼齊上緣。
 */
export function ReportView({ markdown, panel = false }: { markdown: string; panel?: boolean }) {
  return (
    <div className={panel ? 'report-md rpt-panel' : 'report-md'}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {stripFrontmatter(markdown)}
      </ReactMarkdown>
    </div>
  );
}

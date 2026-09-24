/**
 * reportMarkdown.ts — 老王每日報告的 markdown 前處理外掛（純函式，可單測）。
 *
 * 報告原檔是給 Obsidian 讀的，用了兩種一般 markdown 渲染器不認得的東西：
 *   1. callout：`> [!tip] 標題` → 這裡轉成有色底＋圖示的方塊，比照 Obsidian。
 *   2. 內嵌 `<span style="color:red">`、`<mark style="background:#FFCDD2">`：
 *      顏色是給淺色底設計的，搬到深色網站會刺眼／看不清。改成語意 class（紅=看多、
 *      綠=看空、橘=中性，與股市紅漲綠跌相反），顏色由 reportMarkdown.css 統一決定。
 * 之後才過 rehype-sanitize，所以報告裡就算混進 <script>／onerror 之類也不會生效。
 */
import type { Blockquote, PhrasingContent, Root as MdastRoot } from 'mdast';
import type { Element, Root as HastRoot, RootContent as HastContent } from 'hast';
import { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';
import { FLAG_LABEL, hasFlag, splitFlags } from './reportFlags';

/**
 * AI 偶爾在報告開頭多吐一段 YAML frontmatter（2026-09-24 出現過）。react-markdown 不認得，
 * 會渲染成一條線加一塊怪標題。gateway 的 /api/reports 已會拆，這裡再拆一次當防線
 * （gateway 沒更新、或直接吃原始檔的時候）。
 */
export function stripFrontmatter(md: string): string {
  return md.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n+/, '');
}

// ── callout ────────────────────────────────────────────────────────────────

export type CalloutKind = 'note' | 'info' | 'tip' | 'warning' | 'danger' | 'success' | 'question' | 'quote' | 'example';

const CALLOUT_ALIAS: Record<string, CalloutKind> = {
  note: 'note', abstract: 'note', summary: 'note', tldr: 'note',
  info: 'info', todo: 'info',
  tip: 'tip', hint: 'tip', important: 'tip',
  success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  danger: 'danger', error: 'danger', bug: 'danger', failure: 'danger', fail: 'danger', missing: 'danger',
  example: 'example',
  quote: 'quote', cite: 'quote',
};

/** callout 沒寫標題時 Obsidian 會顯示類型名稱，這裡用中文。 */
const CALLOUT_DEFAULT_TITLE: Record<CalloutKind, string> = {
  note: '筆記', info: '資訊', tip: '提示', warning: '注意', danger: '危險',
  success: '成功', question: '問題', quote: '引用', example: '範例',
};

const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\][+-]?[ \t]*/;

/** 把「[!type] 標題」這種 blockquote 改寫成 div.callout（標題另成 div.callout-title）。 */
function transformCallout(node: Blockquote): void {
  const first = node.children[0];
  if (!first || first.type !== 'paragraph') return;
  const head = first.children[0];
  if (!head || head.type !== 'text') return;
  const m = CALLOUT_RE.exec(head.value);
  if (!m) return;

  const rawType = m[1].toLowerCase();
  const kind: CalloutKind = CALLOUT_ALIAS[rawType] ?? 'note';

  // 標題 = 標記之後、第一個換行之前的行內內容（可含粗體等行內語法）；同一段後面的行留在內文。
  const kids: PhrasingContent[] = [{ ...head, value: head.value.slice(m[0].length) }, ...first.children.slice(1)];
  const title: PhrasingContent[] = [];
  const body: PhrasingContent[] = [];
  let inBody = false;
  for (const k of kids) {
    if (inBody) { body.push(k); continue; }
    if (k.type === 'break') { inBody = true; continue; }
    if (k.type === 'text') {
      const i = k.value.indexOf('\n');
      if (i >= 0) {
        inBody = true;
        if (k.value.slice(0, i)) title.push({ ...k, value: k.value.slice(0, i) });
        if (k.value.slice(i + 1)) body.push({ ...k, value: k.value.slice(i + 1) });
        continue;
      }
    }
    title.push(k);
  }
  const nonEmpty = (xs: PhrasingContent[]) => xs.filter((x) => !(x.type === 'text' && x.value === ''));
  const titleNodes = nonEmpty(title);
  const bodyNodes = nonEmpty(body);

  node.data = { hName: 'div', hProperties: { className: ['callout', `callout-${kind}`] } };
  node.children = [
    {
      type: 'paragraph',
      data: { hName: 'div', hProperties: { className: ['callout-title'], dataCallout: kind } },
      children: titleNodes.length ? titleNodes : [{ type: 'text', value: CALLOUT_DEFAULT_TITLE[kind] }],
    },
    ...(bodyNodes.length ? [{ type: 'paragraph' as const, children: bodyNodes }] : []),
    ...node.children.slice(1),
  ];
}

type MdNode = { type: string; children?: MdNode[] };

function walkMdast(node: MdNode): void {
  if (node.type === 'blockquote') transformCallout(node as Blockquote);
  if (node.children) for (const c of node.children) walkMdast(c);
}

/** remark 外掛：Obsidian callout → div.callout。 */
export function remarkCallouts() {
  return (tree: MdastRoot) => walkMdast(tree as MdNode);
}

// ── 粗體小標題 ─────────────────────────────────────────────────────────────

/** 整段只有粗體、像小標題的段落（`**基本面驅動漲停的關鍵數據**：`）。字數上限避免把「整句加粗的強調」誤當小標題。 */
const SUBHEAD_MAX = 40;

function plainText(node: { type: string; value?: string; children?: unknown[] }): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map((c) => plainText(c as { type: string })).join('');
}

function isSubhead(p: { children: PhrasingContent[] }): boolean {
  const [first, second, ...rest] = p.children;
  if (!first || first.type !== 'strong' || rest.length > 0) return false;
  if (second && !(second.type === 'text' && /^[\s：:]*$/.test(second.value))) return false;
  const len = plainText(first).trim().length;
  return len > 0 && len <= SUBHEAD_MAX;
}

/**
 * remark 外掛：最上層那種「整行只有粗體」的段落標成 .rpt-subhead（左側色條的小標題），
 * 讓一長串內文裡的小主題有層次（79 份報告共 156 處）。只看最上層——清單項目、表格、callout 裡的粗體不動。
 */
export function remarkSubheads() {
  return (tree: MdastRoot) => {
    for (const node of tree.children) {
      if (node.type === 'paragraph' && !node.data && isSubhead(node)) {
        node.data = { hProperties: { className: ['rpt-subhead'] } };
      }
    }
  };
}

// ── 國旗 emoji → 小旗 ────────────────────────────────────────────────────

function walkFlags(node: HastRoot | Element): void {
  const next: HastContent[] = [];
  let changed = false;
  for (const child of node.children as HastContent[]) {
    if (child.type === 'text' && hasFlag(child.value)) {
      changed = true;
      for (const part of splitFlags(child.value)) {
        next.push(
          'flag' in part
            ? ({
                type: 'element',
                tagName: 'span',
                properties: { className: ['rpt-flag', `rpt-flag-${part.flag}`], title: FLAG_LABEL[part.flag] },
                children: [],
              } as Element)
            : { type: 'text', value: part.text },
        );
      }
    } else {
      if (child.type === 'element') walkFlags(child);
      next.push(child);
    }
  }
  if (changed) node.children = next as typeof node.children;
}

/** rehype 外掛：文字裡的 🇹🇼／🇺🇸 → CSS 小旗（Windows 瀏覽器會把旗幟 emoji 畫成「TW」字母）。 */
export function rehypeReportFlags() {
  return (tree: HastRoot) => walkFlags(tree);
}

// ── 內嵌顏色 → 語意 class ────────────────────────────────────────────────

/** 文字色（style="color:…"）→ class；報告只用過 red / green / #B35A00 三種。 */
export function textColorClass(color: string): string | null {
  const c = color.trim().toLowerCase();
  if (c === 'red' || c === '#ff0000' || c === '#f00') return 'rpt-red';
  if (c === 'green' || c === '#008000' || c === '#00ff00' || c === '#0f0') return 'rpt-green';
  if (c === '#b35a00' || c === 'orange' || c === '#ffa500') return 'rpt-orange';
  return null;
}

/** 螢光底色（<mark style="background:…">）→ class；報告只用過 #FFCDD2 / #FFE0B2 / #C8E6C9。 */
export function markColorClass(color: string): string {
  const c = color.trim().toLowerCase();
  if (c === '#ffcdd2') return 'rpt-mark-red';
  if (c === '#ffe0b2') return 'rpt-mark-orange';
  if (c === '#c8e6c9') return 'rpt-mark-green';
  return 'rpt-mark-yellow';
}

function styleValue(style: string, prop: RegExp): string | null {
  const m = prop.exec(style);
  return m ? m[1] : null;
}

function walkHast(node: HastRoot | HastContent): void {
  if (node.type === 'element') {
    const el = node as Element;
    if (el.tagName === 'span' || el.tagName === 'mark') {
      const style = typeof el.properties?.style === 'string' ? el.properties.style : '';
      const cls: string[] = [];
      if (el.tagName === 'span') {
        const color = styleValue(style, /(?:^|;)\s*color\s*:\s*([^;]+)/i);
        const k = color ? textColorClass(color) : null;
        if (k) cls.push(k);
      } else {
        const bg = styleValue(style, /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i);
        cls.push(bg ? markColorClass(bg) : 'rpt-mark-yellow');
      }
      if (cls.length) el.properties = { ...el.properties, className: cls };
      // 不論有沒有認得，內嵌 style 一律丟掉（顏色改由 CSS 決定，sanitize 也不放行 style）
      if (el.properties && 'style' in el.properties) {
        const { style: _drop, ...rest } = el.properties;
        void _drop;
        el.properties = rest;
      }
    }
  }
  if ('children' in node) for (const c of node.children) walkHast(c as HastContent);
}

/** rehype 外掛：span/mark 的內嵌顏色 → 語意 class。要放在 rehype-raw 之後、rehype-sanitize 之前。 */
export function rehypeReportColors() {
  return (tree: HastRoot) => walkHast(tree);
}

// ── sanitize schema ─────────────────────────────────────────────────────

/** 預設 schema 加上：callout/顏色用的 class（只放行我們自己產生的那幾種），其餘一概照預設。 */
export const REPORT_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), ['className', /^(callout|callout-[a-z]+|callout-title)$/], 'dataCallout'],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^rpt-(red|green|orange|flag|flag-tw|flag-us)$/]],
    p: [...(defaultSchema.attributes?.p ?? []), ['className', /^rpt-subhead$/]],
    mark: [...(defaultSchema.attributes?.mark ?? []), ['className', /^rpt-mark-(red|green|orange|yellow)$/]],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark'],
};

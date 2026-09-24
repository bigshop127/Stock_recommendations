/**
 * reportSections.ts — 把一篇老王報告依「## 段落」切成小分頁（純函式，可單測）。
 *
 * 79 份報告的結構一致：`# 標題` 開頭（有時後面接一個「整體操作水位」callout），
 * 之後是 5～10 個 `## 段落`（大盤與美股觀察／台股評估／今日提到個股／老王重要提醒…），
 * 結尾是 `---` 加一行 `🔗 閱讀原文`。切法：
 *   head     第一個 `##` 之前的內容（標題、副標），永遠顯示在分頁列上方。
 *            例外：標題正下方若直接接一個摘要 callout（`> [!tip] 🎯 整體操作水位…`，2026-09-24 那種版型），
 *            這個 callout 很高，放在分頁列上方會把分頁列擠出螢幕，所以升級成第一個小分頁
 *   sections 每個 `##` 一個小分頁，內容含該段的 `##` 標題行
 *   footer   結尾的「🔗 閱讀原文」連結，永遠顯示在最下方
 * 程式碼圍欄（```）裡的 `##` 不算標題。
 */

/** 「全部」分頁的 key：把所有段落接起來連續顯示（等於原本整篇的樣子）。 */
export const ALL_TAB = '全部';

export interface ReportSection {
  /** 分頁識別（放進網址 ?tab=）；同一篇裡重複的標題會加序號區分。 */
  key: string;
  /** 分頁按鈕上顯示的短標題。 */
  label: string;
  /** 該段完整 markdown（含 `##` 標題行）。 */
  markdown: string;
}

export interface SplitReport {
  head: string;
  sections: ReportSection[];
  footer: string;
}

const H2_RE = /^##(?!#)[ \t]+(\S.*?)[ \t]*$/;
const H1_RE = /^#(?!#)[ \t]+\S/;
/** 摘要 callout 的第一行：`> [!tip] 標題`（捕獲組 1＝標題）。 */
const CALLOUT_LINE_RE = /^>[ \t]*\[![A-Za-z][\w-]*\][+-]?[ \t]*(.*)$/;
const FENCE_RE = /^[ \t]{0,3}(```|~~~)/;
/** 結尾的「--- 換行 🔗 …」原文連結。 */
const FOOTER_RE = /\n+-{3,}[ \t]*\n+(🔗[^\n]*?)[ \t]*$/;
const LABEL_MAX = 12;

/**
 * 段落標題 → 分頁按鈕文字。標題常帶一長串副標（「台股評估與選股邏輯：買就要買同族群最強指標股」），
 * 取冒號前那段；仍太長就截斷（完整標題在分頁內容裡本來就有）。
 */
export function tabLabel(heading: string): string {
  const plain = heading.replace(/<[^>]+>/g, '').replace(/[*`~]/g, '').trim();
  const head = plain.split(/[：:]/)[0].trim() || plain;
  const chars = Array.from(head);
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX).join('')}…` : head;
}

export function splitReport(markdown: string): SplitReport {
  const head: string[] = [];
  const raw: { heading: string; lines: string[] }[] = [];
  let fence: string | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1] === fence) fence = null;
    }
    const h = fence === null ? H2_RE.exec(line) : null;
    if (h) {
      raw.push({ heading: h[1], lines: [line] });
    } else {
      (raw.length ? raw[raw.length - 1].lines : head).push(line);
    }
  }

  // 標題正下方直接接摘要 callout → 升級成第一個小分頁（見檔頭說明）。
  // 它沒有 `##` 行，分頁名稱取 callout 自己的標題（沒寫標題就叫「摘要」）。
  const h1 = head.findIndex((l) => H1_RE.test(l));
  const intro = head.slice(h1 + 1);
  const firstIntro = intro.findIndex((l) => l.trim() !== '');
  const introCallout = firstIntro >= 0 ? CALLOUT_LINE_RE.exec(intro[firstIntro]) : null;
  if (introCallout) {
    raw.unshift({ heading: introCallout[1].trim() || '摘要', lines: intro.slice(firstIntro) });
    head.length = h1 + 1;
  }

  const used = new Set<string>();
  const sections: ReportSection[] = raw.map((r) => {
    const label = tabLabel(r.heading);
    let key = label;
    for (let n = 2; used.has(key); n++) key = `${label} ${n}`;
    used.add(key);
    return { key, label: key, markdown: r.lines.join('\n').trim() };
  });

  let footer = '';
  const last = sections[sections.length - 1];
  if (last) {
    const m = FOOTER_RE.exec(last.markdown);
    if (m) {
      footer = m[1];
      last.markdown = last.markdown.slice(0, m.index).trimEnd();
    }
  }

  return { head: head.join('\n').trim(), sections, footer };
}

/** 「全部」分頁要顯示的內容：所有段落依序接起來。 */
export function joinSections(sections: ReportSection[]): string {
  return sections.map((s) => s.markdown).join('\n\n');
}

/** 由網址的 ?tab= 決定目前分頁：認得就用，不認得（換日後該段不存在）就退回第一段。 */
export function resolveTab(sections: ReportSection[], tab: string | null): string {
  if (tab === ALL_TAB) return ALL_TAB;
  if (tab && sections.some((s) => s.key === tab)) return tab;
  return sections[0]?.key ?? ALL_TAB;
}

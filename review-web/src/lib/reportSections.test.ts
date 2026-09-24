import { describe, it, expect } from 'vitest';
import { ALL_TAB, joinSections, resolveTab, splitReport, tabLabel } from './reportSections';

const SAMPLE = [
  '# 2026/09/24 中秋變盤？',
  '',
  '> [!tip] 🎯 整體操作水位：降至五成',
  '> - 重點一',
  '',
  '## 🌍 大盤與美股觀察',
  '',
  '大盤內文',
  '',
  '## 🇹🇼 台股評估與選股邏輯：買就要買同族群最強指標股',
  '',
  '- 選股邏輯',
  '',
  '### 🔴 景碩',
  '',
  '| 項目 | 內容 |',
  '| --- | --- |',
  '| a | b |',
  '',
  '## ⚠️ 老王重要提醒',
  '',
  '- 提醒',
  '',
  '---',
  '🔗 [閱讀原文](https://example.com/a)',
].join('\n');

describe('splitReport', () => {
  it('第一個 ## 之前是 head，每個 ## 一個分頁，### 留在所屬段落內', () => {
    const r = splitReport(SAMPLE);
    expect(r.head).toBe('# 2026/09/24 中秋變盤？');
    const sec = r.sections.find((s) => s.label.startsWith('🇹🇼'));
    expect(sec?.markdown).toContain('### 🔴 景碩');
    expect(sec?.markdown).toContain('| a | b |');
    expect(sec?.markdown.startsWith('## 🇹🇼 台股評估與選股邏輯：買就要買同族群最強指標股')).toBe(true);
  });

  it('標題正下方的摘要 callout 升級成第一個小分頁（不擠掉分頁列）', () => {
    const r = splitReport(SAMPLE);
    expect(r.sections.map((s) => s.label)).toEqual(['🎯 整體操作水位', '🌍 大盤與美股觀察', '🇹🇼 台股評估與選股邏輯', '⚠️ 老王重要提醒']);
    expect(r.sections[0].markdown).toBe('> [!tip] 🎯 整體操作水位：降至五成\n> - 重點一');
    expect(r.head).not.toContain('[!tip]');
  });

  it('標題後面接的是一般副標（不是 callout）就留在 head', () => {
    const r = splitReport('# 標題\n\n> 浦惠投顧方案最新動態通知\n\n## A\n\nx\n\n## B\n\ny');
    expect(r.head).toBe('# 標題\n\n> 浦惠投顧方案最新動態通知');
    expect(r.sections.map((s) => s.label)).toEqual(['A', 'B']);
  });

  it('摘要 callout 沒寫標題時分頁叫「摘要」', () => {
    const r = splitReport('# 標題\n\n> [!note]\n> 內文\n\n## A\n\nx');
    expect(r.sections[0].label).toBe('摘要');
  });

  it('結尾的「--- 🔗 閱讀原文」拆成 footer，不留在最後一段', () => {
    const r = splitReport(SAMPLE);
    expect(r.footer).toBe('🔗 [閱讀原文](https://example.com/a)');
    const last = r.sections[r.sections.length - 1];
    expect(last.label).toBe('⚠️ 老王重要提醒');
    expect(last.markdown).not.toContain('閱讀原文');
    expect(last.markdown.endsWith('- 提醒')).toBe(true);
  });

  it('沒有結尾連結時 footer 為空、內容不動', () => {
    const r = splitReport('# t\n\n## A\n\nx\n\n## B\n\ny');
    expect(r.footer).toBe('');
    expect(r.sections[1].markdown).toBe('## B\n\ny');
  });

  it('程式碼圍欄裡的 ## 不算標題', () => {
    const r = splitReport('# t\n\n## A\n\n```\n## not a heading\n```\n\n## B\n\nz');
    expect(r.sections.map((s) => s.label)).toEqual(['A', 'B']);
    expect(r.sections[0].markdown).toContain('## not a heading');
  });

  it('CRLF 換行也能切', () => {
    const r = splitReport('# t\r\n\r\n## A\r\n\r\nx\r\n\r\n## B\r\n\r\ny\r\n');
    expect(r.sections.map((s) => s.label)).toEqual(['A', 'B']);
    expect(r.sections[1].markdown).toBe('## B\n\ny');
  });

  it('同一篇裡標題重複時加序號，key 不重複', () => {
    const r = splitReport('# t\n\n## 示警\n\na\n\n## 示警\n\nb');
    expect(r.sections.map((s) => s.key)).toEqual(['示警', '示警 2']);
  });

  it('沒有任何 ## 時全部算 head', () => {
    const r = splitReport('# 只有標題\n\n內文');
    expect(r.sections).toEqual([]);
    expect(r.head).toBe('# 只有標題\n\n內文');
  });

  it('切開再接回來，不掉內容（除了 head/footer 邊界的空白）', () => {
    const r = splitReport(SAMPLE);
    const rebuilt = [r.head, joinSections(r.sections), '---\n' + r.footer].join('\n\n');
    const squash = (s: string) => s.replace(/\s+/g, '');
    expect(squash(rebuilt)).toBe(squash(SAMPLE));
  });
});

describe('tabLabel', () => {
  it('取冒號前的短標題', () => {
    expect(tabLabel('💡 老王實戰SOP：大賺小賠的停損停利心法')).toBe('💡 老王實戰SOP');
    expect(tabLabel('📊 台積電: 7 月營收三連高')).toBe('📊 台積電');
  });
  it('去掉行內 markdown／HTML，太長就截斷', () => {
    expect(tabLabel('<span style="color:red">🔴 **景碩**</span>')).toBe('🔴 景碩');
    const long = tabLabel('🔩 被動元件 + 半導體二極體族群反彈布局');
    expect(long.endsWith('…')).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(13);
  });
  it('冒號開頭時不會變空字串', () => {
    expect(tabLabel('：只有副標')).toBe('：只有副標');
  });
});

describe('resolveTab', () => {
  const sections = splitReport(SAMPLE).sections;
  it('認得的 key 就用', () => {
    expect(resolveTab(sections, '⚠️ 老王重要提醒')).toBe('⚠️ 老王重要提醒');
    expect(resolveTab(sections, ALL_TAB)).toBe(ALL_TAB);
  });
  it('沒指定或當天沒有這一段（換日後）退回第一段', () => {
    expect(resolveTab(sections, null)).toBe('🎯 整體操作水位');
    expect(resolveTab(sections, '不存在的段落')).toBe('🎯 整體操作水位');
  });
});

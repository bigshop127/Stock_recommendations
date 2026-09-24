import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportView } from './ReportView';
import { markColorClass, textColorClass } from '../lib/reportMarkdown';

const html = (md: string) => renderToStaticMarkup(createElement(ReportView, { markdown: md }));

describe('ReportView：Obsidian callout', () => {
  it('把 [!tip] 標題行轉成有色方塊，標題與內文分開', () => {
    const out = html('> [!tip] 🎯 整體操作水位：降至五成\n> - 第一點\n> - 第二點');
    expect(out).toContain('class="callout callout-tip"');
    expect(out).toContain('class="callout-title"');
    expect(out).toContain('🎯 整體操作水位：降至五成');
    // 標記文字本身不該外露
    expect(out).not.toContain('[!tip]');
    expect(out).toContain('<li>第一點</li>');
  });

  it('標題行含粗體等行內語法時照常渲染', () => {
    const out = html('> [!warning] **注意** 連假風險\n> 內文一行');
    expect(out).toContain('callout-warning');
    expect(out).toContain('<strong>注意</strong>');
    expect(out).toContain('內文一行');
  });

  it('同一段的第二行以後留在內文，不進標題', () => {
    const out = html('> [!info] 標題\n> 這是內文');
    const title = out.match(/class="callout-title"[^>]*>(.*?)<\/div><\/div>/s)?.[1] ?? '';
    expect(title).toContain('標題');
    expect(title).not.toContain('這是內文');
    expect(out).toContain('這是內文');
  });

  it('沒寫標題就用中文類型名；未知類型退成 note', () => {
    expect(html('> [!danger]\n> x')).toContain('危險');
    expect(html('> [!whatever] 標題\n> x')).toContain('callout-note');
  });

  it('一般引用（不是 callout）維持 blockquote', () => {
    const out = html('> *ABF：載板　*EPS：每股盈餘');
    expect(out).toContain('<blockquote>');
    expect(out).not.toContain('callout');
  });
});

describe('ReportView：內嵌顏色', () => {
  it('span color 轉語意 class，並丟掉內嵌 style', () => {
    const out = html('<span style="color:red">**八成**</span> 與 <span style="color:#B35A00">5%</span> 與 <span style="color:green">看空</span>');
    expect(out).toContain('class="rpt-red"');
    expect(out).toContain('class="rpt-orange"');
    expect(out).toContain('class="rpt-green"');
    expect(out).not.toContain('style=');
  });

  it('mark 背景色轉語意 class', () => {
    expect(html('<mark style="background:#FFCDD2">a</mark>')).toContain('rpt-mark-red');
    expect(html('<mark style="background:#FFE0B2">a</mark>')).toContain('rpt-mark-orange');
    expect(html('<mark style="background:#C8E6C9">a</mark>')).toContain('rpt-mark-green');
    expect(html('<mark style="background:#123456">a</mark>')).toContain('rpt-mark-yellow');
  });

  it('顏色對照表', () => {
    expect(textColorClass('RED')).toBe('rpt-red');
    expect(textColorClass(' #b35a00 ')).toBe('rpt-orange');
    expect(textColorClass('blue')).toBeNull();
    expect(markColorClass('#ffcdd2')).toBe('rpt-mark-red');
  });
});

describe('ReportView：frontmatter', () => {
  it('開頭的 YAML frontmatter 不會被渲染成標題', () => {
    const out = html('---\ntitle: "中秋連假"\ndate: 2026-09-24\n---\n\n# 報告標題\n\n內文');
    expect(out).not.toContain('title:');
    expect(out).not.toContain('<hr');
    expect(out).toContain('<h1>報告標題</h1>');
  });

  it('不是 frontmatter、只是內容中間有分隔線時不能被吃掉', () => {
    const out = html('# 標題\n\n---\n\n內文');
    expect(out).toContain('內文');
  });
});

describe('ReportView：閱讀排版', () => {
  it('🇹🇼 旗幟 emoji 換成 CSS 小旗（Windows 會把它畫成 TW 字母）', () => {
    const out = html('## 🇹🇼 台股評估：買最強');
    expect(out).toContain('rpt-flag rpt-flag-tw');
    expect(out).not.toContain('🇹🇼');
    const us = html('美股🇺🇸收高');
    expect(us).toContain('rpt-flag-us');
  });

  it('## 標題的「主標：副標」拆成兩行，冒號不外露', () => {
    const out = html('## 📌 台股評估與選股邏輯：買就要買同族群最強指標股');
    expect(out).toContain('<h2>');
    expect(out).toContain('台股評估與選股邏輯<span class="rpt-h-sub">買就要買同族群最強指標股</span>');
    expect(out).not.toContain('：');
  });

  it('沒有冒號、或冒號後沒內容的標題維持原樣', () => {
    expect(html('## 大盤與美股觀察')).not.toContain('rpt-h-sub');
    expect(html('## 標題：')).not.toContain('rpt-h-sub');
    expect(html('## ：只有副標')).not.toContain('rpt-h-sub');
  });

  it('整行只有粗體的最上層段落變小標題（含結尾冒號）', () => {
    expect(html('**基本面驅動漲停的關鍵數據**：')).toContain('<p class="rpt-subhead">');
    expect(html('**均線操作策略總覽：**')).toContain('rpt-subhead');
  });

  it('小標題判斷不誤傷：粗體夾在句子裡、清單項目、過長的整句加粗、callout 內', () => {
    expect(html('這是**重點**在句子中')).not.toContain('rpt-subhead');
    expect(html('- **只有粗體的清單項目**')).not.toContain('rpt-subhead');
    expect(html('**' + '很長的整句強調'.repeat(8) + '**')).not.toContain('rpt-subhead');
    expect(html('> [!tip] 標題\n> **粗體**')).not.toContain('rpt-subhead');
    expect(html('**A** 後面還有字')).not.toContain('rpt-subhead');
  });
});

describe('ReportView：表格與安全', () => {
  it('表格外包捲動容器', () => {
    const out = html('| 項目 | 內容 |\n| --- | --- |\n| **A** | b |');
    expect(out).toContain('class="rpt-table-wrap"');
    expect(out).toContain('<table>');
  });

  it('報告裡混進的腳本／事件屬性／javascript: 連結都會被清掉', () => {
    const out = html('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n<a href="javascript:alert(1)">x</a>\n\n<div style="position:fixed">y</div>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('position:fixed');
  });

  it('外部連結一律新分頁開', () => {
    expect(html('[原文](https://example.com)')).toContain('target="_blank"');
  });
});

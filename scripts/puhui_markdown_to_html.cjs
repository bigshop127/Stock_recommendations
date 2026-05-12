/**
 * puhui_markdown_to_html.cjs — Convert Obsidian markdown to HTML for email
 * 處理 Obsidian 特定語法（callout boxes）、表格、列表、內聯 HTML
 */

const { marked } = require('marked');

// 設定 marked 選項
marked.setOptions({
  breaks: true,
  gfm: true,
});

// HTML 樣式定義
const HTML_STYLE = `
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a73e8; font-size: 24px; margin: 30px 0 10px; }
    h2 { color: #1a73e8; font-size: 18px; margin: 25px 0 15px; border-bottom: 2px solid #e0e0e0; padding-bottom: 8px; }
    h3 { color: #1a73e8; font-size: 16px; margin: 15px 0 10px; }
    p { margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { padding: 12px; text-align: left; border: 1px solid #e0e0e0; }
    th { background: #f5f5f5; font-weight: 600; }
    ul, ol { margin: 10px 0; padding-left: 20px; }
    li { margin: 5px 0; }
    hr { border: none; border-top: 1px solid #e0e0e0; margin: 30px 0; }

    /* Obsidian Callout Boxes */
    .callout { padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid; }
    .callout-tip { background: #e3f2fd; border-left-color: #1976d2; }
    .callout-info { background: #e1f5fe; border-left-color: #0288d1; }
    .callout-warning { background: #fff3e0; border-left-color: #f57c00; }
    .callout-danger { background: #ffebee; border-left-color: #d32f2f; }

    .callout-title { font-weight: 600; margin-bottom: 8px; font-size: 0.95em; }
    .callout-tip .callout-title { color: #1565c0; }
    .callout-info .callout-title { color: #0277bd; }
    .callout-warning .callout-title { color: #e65100; }
    .callout-danger .callout-title { color: #c62828; }

    .callout p { margin: 5px 0; font-size: 0.95em; }
    .callout ul, .callout ol { margin: 5px 0; padding-left: 20px; }

    a { color: #1976d2; text-decoration: none; }
    a:hover { text-decoration: underline; }

    strong { font-weight: 600; }
    em { font-style: italic; }
  </style>
`;

// 正則表達式用於匹配 Obsidian callout boxes
const CALLOUT_REGEX = /^>\s*\[!(tip|info|warning|danger)\]\s+(.*?)(?=^(?:$|#|>|\|))/gms;

/**
 * 轉換 Obsidian callout box 語法到 HTML
 * @param {string} markdown - Markdown 內容
 * @returns {string} 處理後的內容
 */
function convertCalloutBoxes(markdown) {
  let result = markdown;

  // 找出所有 callout box
  const matches = [...markdown.matchAll(CALLOUT_REGEX)];

  matches.forEach((match) => {
    const type = match[1]; // tip, info, warning, danger
    const content = match[2].trim();

    // 保留第一行作為標題（如果有），其他行作為內容
    const lines = content.split('\n');
    const title = lines[0].replace(/^\s*/, '');
    const bodyLines = lines.slice(1).map(line => line.replace(/^>\s*/, '').trim()).filter(l => l);
    const body = bodyLines.join('\n');

    // 建立 HTML callout div
    const htmlCallout = `<div class="callout callout-${type}">
      <div class="callout-title">${title}</div>
      <div>${marked.parseInline(body)}</div>
    </div>`;

    result = result.replace(match[0], htmlCallout);
  });

  return result;
}

/**
 * 清理 Markdown 中的 blockquote 語法（用於 callout 的後續行）
 * @param {string} markdown - Markdown 內容
 * @returns {string} 清理後的內容
 */
function cleanBlockquotes(markdown) {
  return markdown.split('\n')
    .map(line => {
      // 移除單獨的 > 符號（用於 callout 的多行延續）
      if (line.trim().startsWith('>') && !line.includes('[!')) {
        return line.replace(/^\s*>\s*/, '');
      }
      return line;
    })
    .join('\n');
}

/**
 * 將 Markdown 轉換為 HTML
 * @param {string} markdown - Obsidian Markdown 內容
 * @returns {string} 完整的 HTML 文件
 */
function markdownToHtml(markdown) {
  // 1. 先清理多行 blockquote
  let processed = cleanBlockquotes(markdown);

  // 2. 轉換 Obsidian callout boxes
  processed = convertCalloutBoxes(processed);

  // 3. 用 marked 轉換 Markdown 為 HTML
  let htmlContent = marked(processed);

  // 4. 保留內聯 HTML（style 標籤）
  // marked 預設會過濾 HTML，需要配置允許
  // 或者我們已經在 style 標籤中，所以應該被保留

  // 5. 建立完整的 HTML 文件
  const fullHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HTML_STYLE}
</head>
<body>
  <div class="container">
    ${htmlContent}
  </div>
</body>
</html>`;

  return fullHtml;
}

/**
 * 從文件系統讀取 Obsidian 報告並轉換為 HTML
 * @param {string} filePath - 報告文件完整路徑
 * @returns {Promise<string>} HTML 內容
 */
async function loadAndConvertReport(filePath) {
  const fs = require('fs').promises;
  const markdown = await fs.readFile(filePath, 'utf-8');
  return markdownToHtml(markdown);
}

module.exports = {
  markdownToHtml,
  loadAndConvertReport,
  convertCalloutBoxes,
  cleanBlockquotes,
};

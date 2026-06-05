const fs = require('fs');
const path = require('path');

// Read the markdown file
const markdownPath = 'C:\obsidian\儲存庫\浦惠投顧報告整理\2026-05-12.md';
const markdown = fs.readFileSync(markdownPath, 'utf-8');

// Copy the markdownToHTML function from puhui_daily.cjs
function markdownToHTML(markdown) {
  let html = markdown;

  // Process tables first (before line breaks)
  const tableRegex = /^\|[\s\S]*?\n\|.*?\|[\s\S]*?(?=\n\n|\n[^|]|$)/gm;
  html = html.replace(tableRegex, (tableStr) => {
    const rows = tableStr.trim().split('\n');
    if (rows.length < 2) return tableStr;

    const headers = rows[0].split('|').slice(1, -1).map(h => h.trim());
    const cellStyle = 'padding:10px;border:1px solid #ddd;text-align:left';
    const headerStyle = 'padding:12px;border:1px solid #ddd;background:#f5f5f5;font-weight:bold;color:#1a1a1a';

    let table = '<table style="border-collapse:collapse;width:100%;margin:12px 0">';
    table += '<thead><tr>' + headers.map(h => `<th style="${headerStyle}">${h}</th>`).join('') + '</tr></thead>';
    table += '<tbody>';
    for (let i = 2; i < rows.length; i++) {
      const cells = rows[i].split('|').slice(1, -1).map(c => c.trim());
      if (cells.some(c => c.length > 0)) {
        table += '<tr>' + cells.map(c => `<td style="${cellStyle}">${c}</td>`).join('') + '</tr>';
      }
    }
    table += '</tbody></table>';
    return table;
  });

  // Headers (before escaping)
  html = html.replace(/^# (.*?)$/gm, '<h1 style="color:#1a1a1a;margin:24px 0 12px;font-size:28px;font-weight:bold">$1</h1>');
  html = html.replace(/^## (.*?)$/gm, '<h2 style="color:#333;margin:20px 0 10px;font-size:22px;font-weight:bold">$1</h2>');
  html = html.replace(/^### (.*?)$/gm, '<h3 style="color:#555;margin:16px 0 8px;font-size:18px;font-weight:bold">$1</h3>');
  html = html.replace(/^#### (.*?)$/gm, '<h4 style="color:#666;margin:12px 0 6px;font-size:16px;font-weight:bold">$1</h4>');

  // Blockquotes (警示框)
  html = html.replace(/^> (.*?)$/gm, '<div style="background:#fff3cd;border-left:4px solid #ff9800;padding:12px 16px;margin:12px 0;border-radius:4px;color:#e65100">$1</div>');

  // Links (before escaping)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#1976d2;text-decoration:none">$1</a>');

  // Bold and italic (before escaping)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#d32f2f">$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Escape remaining HTML in plain text
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Restore HTML tags
  html = html.replace(/&lt;a href=/g, '<a href=').replace(/&quot;/g, '"').replace(/&lt;\/a&gt;/g, '</a>');
  html = html.replace(/&lt;strong/g, '<strong').replace(/&lt;\/strong&gt;/g, '</strong>');
  html = html.replace(/&lt;em/g, '<em').replace(/&lt;\/em&gt;/g, '</em>');
  html = html.replace(/&lt;h[1-4]/g, (m) => m.replace('&lt;', '<')).replace(/&lt;\/h[1-4]&gt;/g, (m) => m.replace('&lt;', '<').replace('&gt;', '>'));
  html = html.replace(/&lt;div style=/g, '<div style=').replace(/&lt;\/div&gt;/g, '</div>');
  html = html.replace(/&lt;table/g, '<table').replace(/&lt;\/table&gt;/g, '</table>');
  html = html.replace(/&lt;thead/g, '<thead').replace(/&lt;\/thead&gt;/g, '</thead>');
  html = html.replace(/&lt;tbody/g, '<tbody').replace(/&lt;\/tbody&gt;/g, '</tbody>');
  html = html.replace(/&lt;tr/g, '<tr').replace(/&lt;\/tr&gt;/g, '</tr>');
  html = html.replace(/&lt;th/g, '<th').replace(/&lt;\/th&gt;/g, '</th>');
  html = html.replace(/&lt;td/g, '<td').replace(/&lt;\/td&gt;/g, '</td>');

  // Lists
  html = html.replace(/^- (.+?)$/gm, '<li style="margin:6px 0">$1</li>');
  const listRegex = /(<li[^<]*>[^<]*<\/li>[\s\n]*)+/gm;
  html = html.replace(listRegex, (match) => `<ul style="margin:8px 0 8px 20px;padding:0">\n${match}</ul>\n`);

  // Line breaks and paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;

  // Remove double paragraph tags
  html = html.replace(/<\/p>\s*<p>/g, '</p><p>');

  const css = `<style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 900px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a1a1a; font-size: 28px; margin: 24px 0 12px; }
    h2 { color: #333; font-size: 22px; margin: 20px 0 10px; }
    h3 { color: #555; font-size: 18px; margin: 16px 0 8px; }
    h4 { color: #666; font-size: 16px; margin: 12px 0 6px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th { background: #f5f5f5; padding: 12px; border: 1px solid #ddd; font-weight: bold; color: #1a1a1a; }
    td { padding: 10px; border: 1px solid #ddd; }
    a { color: #1976d2; text-decoration: none; }
    strong { color: #d32f2f; font-weight: bold; }
    em { font-style: italic; }
    ul { margin: 8px 0 8px 20px; padding: 0; }
    li { margin: 6px 0; }
    div[style*="background"] { border-radius: 4px; }
  </style>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${css}
</head>
<body>
${html}
</body>
</html>`;
}

// Test the conversion
const htmlOutput = markdownToHTML(markdown);
const outputPath = 'C:\CC AI Agent\data\test_html_output.html';
fs.writeFileSync(outputPath, htmlOutput, 'utf-8');

console.log('✅ HTML conversion successful');
console.log(`📄 Output saved to: ${outputPath}`);
console.log(`📊 HTML size: ${htmlOutput.length} bytes`);

// Verify key elements are present
const checks = [
  { name: 'DOCTYPE', test: htmlOutput.includes('<!DOCTYPE html>') },
  { name: 'HTML tags', test: htmlOutput.includes('<html>') && htmlOutput.includes('</html>') },
  { name: 'Headers (h1-h4)', test: /<h[1-4]/.test(htmlOutput) },
  { name: 'Table', test: htmlOutput.includes('<table') },
  { name: 'CSS styles', test: htmlOutput.includes('<style>') },
  { name: 'Links', test: htmlOutput.includes('<a href=') },
];

console.log('\n🔍 Conversion verification:');
checks.forEach(c => console.log(`  ${c.test ? '✅' : '❌'} ${c.name}`));

const allPassed = checks.every(c => c.test);
console.log(`\n${allPassed ? '✅ All checks passed!' : '❌ Some checks failed'}`);

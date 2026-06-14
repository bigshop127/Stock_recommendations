/**
 * reports.js — 純檔案系統讀老王報告（`reports/**\/*.md`）。
 *
 * 與引擎無關：engine 掛掉時 `/api/reports*` 仍照常可用。
 * 報告路徑慣例 `reports/YYYY-MM/Wn/YYYY-MM-DD.md`（日期在檔名），與 engine repo 同法掃描。
 * 對 Node 既有產物唯讀，不寫任何東西。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

function scanReports() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        const m = ent.name.match(DATE_RE);
        if (!m) continue;
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        const parts = rel.split('/'); // reports / YYYY-MM / Wn / file.md
        out.push({
          date: `${m[1]}-${m[2]}-${m[3]}`,
          path: rel,
          month: parts[1] || null,
          week: parts[2] && parts[2] !== path.basename(rel) ? parts[2] : null,
        });
      }
    }
  };
  walk(REPORTS_DIR);
  out.sort((a, b) => b.date.localeCompare(a.date)); // 由新到舊
  return out;
}

function listReports() {
  return scanReports();
}

/** 讀某日報告 markdown；date 省略 → 最新一篇。查無回 null。 */
function getReport(date) {
  const all = scanReports();
  const item = date ? all.find((r) => r.date === date) : all[0];
  if (!item) return null;
  let markdown = '';
  try { markdown = fs.readFileSync(path.join(ROOT, item.path), 'utf8'); } catch { return null; }
  return { date: item.date, path: item.path, markdown };
}

module.exports = { listReports, getReport };

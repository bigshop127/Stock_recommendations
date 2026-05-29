#!/usr/bin/env node
/**
 * Re-organize existing YYYY-MM-DD.md report files under the new
 * "natural week" (Monday-month + nth Monday) rule. Operates on both
 * the Obsidian vault and the in-repo reports/ tree.
 *
 * Usage:
 *   node scripts/reorganize_reports.cjs            # dry-run
 *   node scripts/reorganize_reports.cjs --apply    # actually move
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APPLY = process.argv.includes('--apply');

const OBSIDIAN_ROOT = 'C:\\obsidian\\儲存庫\\浦惠投顧報告整理';
const REPO_ROOT = path.resolve(__dirname, '..', 'reports');

function getMonthWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = date.getUTCDay() || 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - dayOfWeek + 1);
  const year = monday.getUTCFullYear();
  const month = monday.getUTCMonth() + 1;
  const mondayDay = monday.getUTCDate();
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = firstOfMonth.getUTCDay() || 7;
  const firstMondayDay = firstDow === 1 ? 1 : (1 + (8 - firstDow));
  const weekOfMonth = Math.floor((mondayDay - firstMondayDay) / 7) + 1;
  return { year, month, weekOfMonth };
}

function targetPath(root, dateStr) {
  const { year, month, weekOfMonth } = getMonthWeek(dateStr);
  return path.join(
    root,
    `${year}-${String(month).padStart(2, '0')}`,
    `W${weekOfMonth}`,
    `${dateStr}.md`
  );
}

function walkReportFiles(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  for (const monthDir of fs.readdirSync(root)) {
    const monthPath = path.join(root, monthDir);
    if (!fs.statSync(monthPath).isDirectory()) continue;
    if (!/^\d{4}-\d{2}$/.test(monthDir)) continue;
    for (const weekDir of fs.readdirSync(monthPath)) {
      const weekPath = path.join(monthPath, weekDir);
      if (!fs.statSync(weekPath).isDirectory()) continue;
      if (!/^W\d+$/.test(weekDir)) continue;
      for (const file of fs.readdirSync(weekPath)) {
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(file)) continue;
        results.push({
          dateStr: file.slice(0, 10),
          currentPath: path.join(weekPath, file),
        });
      }
    }
  }
  return results;
}

function buildPlan(root, useGitMv) {
  const files = walkReportFiles(root);
  const moves = [];
  for (const f of files) {
    const target = targetPath(root, f.dateStr);
    if (path.resolve(target) !== path.resolve(f.currentPath)) {
      moves.push({ ...f, target, useGitMv });
    }
  }
  return moves;
}

function execMove(move) {
  fs.mkdirSync(path.dirname(move.target), { recursive: true });
  if (move.useGitMv) {
    try {
      execSync(
        `git mv "${move.currentPath}" "${move.target}"`,
        { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' }
      );
    } catch (e) {
      // fallback to fs.rename if file is not yet tracked
      fs.renameSync(move.currentPath, move.target);
    }
  } else {
    fs.renameSync(move.currentPath, move.target);
  }
}

function pruneEmptyDirs(root) {
  if (!fs.existsSync(root)) return [];
  const pruned = [];
  for (const monthDir of fs.readdirSync(root)) {
    const monthPath = path.join(root, monthDir);
    if (!fs.statSync(monthPath).isDirectory()) continue;
    for (const weekDir of fs.readdirSync(monthPath)) {
      const weekPath = path.join(monthPath, weekDir);
      if (!fs.statSync(weekPath).isDirectory()) continue;
      const entries = fs.readdirSync(weekPath);
      if (entries.length === 0) {
        fs.rmdirSync(weekPath);
        pruned.push(weekPath);
      }
    }
  }
  return pruned;
}

function printPlan(label, moves) {
  console.log(`\n=== ${label} (${moves.length} moves) ===`);
  if (moves.length === 0) {
    console.log('  (no moves needed)');
    return;
  }
  for (const m of moves) {
    const from = path.relative(path.dirname(m.currentPath).split(/[\\/]/).slice(0, -3).join(path.sep), m.currentPath);
    const fromShort = m.currentPath.split(/[\\/]/).slice(-3).join('/');
    const toShort = m.target.split(/[\\/]/).slice(-3).join('/');
    console.log(`  ${fromShort}  ->  ${toShort}`);
  }
}

const obsidianMoves = buildPlan(OBSIDIAN_ROOT, false);
const repoMoves = buildPlan(REPO_ROOT, true);

printPlan('Obsidian', obsidianMoves);
printPlan('Repo reports/', repoMoves);

if (!APPLY) {
  console.log('\n[dry-run] Re-run with --apply to execute');
  process.exit(0);
}

console.log('\n[apply] Executing moves...');
for (const m of obsidianMoves) execMove(m);
for (const m of repoMoves) execMove(m);

console.log('\n[apply] Pruning empty week dirs...');
const prunedO = pruneEmptyDirs(OBSIDIAN_ROOT);
const prunedR = pruneEmptyDirs(REPO_ROOT);
for (const p of [...prunedO, ...prunedR]) {
  console.log(`  removed empty: ${p}`);
}
console.log('\nDone.');

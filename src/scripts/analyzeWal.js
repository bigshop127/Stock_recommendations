
/**
 * CCB v0.12.2 - WAL Replay & Analysis Script
 * CQRS Projection: 讀取 Domain Events 並產生紅旗觸發統計報告
 * 使用 readline 串流讀取，O(1) 記憶體複雜度，支援 GB 級 WAL 檔案
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const WAL_FILE_PATH = path.join(__dirname, '../../logs/ccb_domain_events.jsonl');

async function analyzeWal() {
  console.log("🔍 [WAL Replay] 開始重播領域事件日誌...\n");

  if (!fs.existsSync(WAL_FILE_PATH)) {
    console.log("=== CCB WAL 分析報告 ===");
    console.log("目前無 WAL 日誌可供分析。");
    return;
  }

  const stats = {
    totalEvents: 0,
    flagCounts: {},
    tierCounts: {},
    corruptedLines: 0,
  };

  const fileStream = fs.createReadStream(WAL_FILE_PATH);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "RED_FLAG_TRIGGERED") {
        stats.totalEvents++;
        stats.flagCounts[event.flag] = (stats.flagCounts[event.flag] || 0) + 1;
        stats.tierCounts[event.tier] = (stats.tierCounts[event.tier] || 0) + 1;
      }
    } catch {
      stats.corruptedLines++;
      console.warn(`  ⚠️ 損壞紀錄已跳過: ${line.slice(0, 80)}`);
    }
  }

  const sortedFlags = Object.entries(stats.flagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  console.log("=== CCB WAL 分析報告 ===");
  console.log(`總紅旗事件     : ${stats.totalEvents} 筆`);
  console.log(`損壞紀錄       : ${stats.corruptedLines} 筆`);
  console.log(`Local 攔截     : ${stats.tierCounts.local || 0} 次`);
  console.log("");

  if (sortedFlags.length > 0) {
    console.log("Top 紅旗觸發排行：");
    sortedFlags.forEach(([flag, count], i) => {
      const bar = "█".repeat(Math.round(count / stats.totalEvents * 20));
      console.log(`  ${String(i + 1).padStart(2)}. ${flag.padEnd(25)} ${bar} ${count} 次`);
    });
  } else {
    console.log("尚無紅旗事件記錄。");
  }

  console.log("==========================\n");

  // 回傳給未來的自動閉環腳本使用
  return stats;
}

analyzeWal().catch(console.error);


/**
 * CCB v0.12.2 - Phase 1 Sequential Smoke Test
 * 5 個臨床 payload 串行，驗證端對端邏輯正確性
 */

const { analyzeStaticComplexity } = require('../services/complexityAnalyzer');
const { parseJsonSafe } = require('../utils/outputSanitizer');
const { callLocalModel } = require('../services/ollamaService');

async function checkOllamaModels() {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    const data = await res.json();
    return data.models && data.models.length > 0;
  } catch {
    return false;
  }
}

async function runTier2Baseline(prompt) {
  const testMsg = [{ role: "user", content: `請用一句話回應：${prompt}` }];

  console.log(`  [Tier 2] 冷啟動測試 (keep_alive=0)...`);
  try {
    await callLocalModel(testMsg, "deepseek-r1:14b", { keepAlive: 0 });
    console.log(`  [Tier 2] 暖啟動測試 (keep_alive=-1)...`);
    await callLocalModel(testMsg, "deepseek-r1:14b", { keepAlive: -1 });
  } catch (err) {
    console.log(`  [Tier 2] LLM 呼叫失敗: ${err.message}`);
  }
}

// 5 個代表性 payload：覆蓋 Tier 1 Fast / Local 與 Tier 2 Evaluate 三條路徑
const TEST_PAYLOADS = [
  {
    label: "T1 - 簡單問候（FAST path）",
    prompt: "你好",
    expectedTier: "fast",
  },
  {
    label: "T2 - 紅旗：夜間劇痛（LOCAL path）",
    prompt: "病患主訴夜間劇痛，無法入睡，持續三週",
    expectedTier: "local",
  },
  {
    label: "T3 - 紅旗：英文 Bilateral symptoms（LOCAL path）",
    prompt: "Assessment shows VBI positive with Bilateral symptoms and upper limb weakness",
    expectedTier: "local",
  },
  {
    label: "T4 - 中等複雜臨床（EVALUATE path）",
    prompt: "56 歲女性，右肩夾擠症候群，Neer test 陽性，肌力 4/5，請提供物理治療計畫",
    expectedTier: "evaluate",
  },
  {
    label: "T5 - 複雜多重症狀（EVALUATE path）",
    prompt: "38 歲男性，慢性下背痛合併右腿麻木至膝蓋，SLR 陽性，請進行鑑別診斷並提出治療路徑",
    expectedTier: "evaluate",
  },
];

async function runSmokeTest() {
  console.log("=== CCB v0.12.2 Phase 1 Smoke Test ===");
  console.log(`開始時間: ${new Date().toISOString()}\n`);

  const results = [];

  for (const payload of TEST_PAYLOADS) {
    const start = Date.now();
    console.log(`▶ ${payload.label}`);

    try {
      const analysis = analyzeStaticComplexity(payload.prompt);
      const latencyMs = Date.now() - start;
      const pass = analysis.tier === payload.expectedTier;

      console.log(`  Tier: ${analysis.tier.toUpperCase().padEnd(8)} | 預期: ${payload.expectedTier.toUpperCase().padEnd(8)} | ${pass ? '✅ PASS' : '❌ FAIL'} | ${latencyMs}ms`);
      console.log(`  原因: ${analysis.reason}`);

      // Tier 2 案例：若 Ollama 有模型則實際呼叫，否則僅驗證路由邏輯
      if (analysis.tier === "evaluate") {
        const ollamaReady = await checkOllamaModels();
        if (ollamaReady) {
          await runTier2Baseline(payload.prompt);
        } else {
          console.log(`  [Tier 2] Ollama 模型尚未就緒，跳過 LLM 呼叫`);
        }
      }

      results.push({ label: payload.label, tier: analysis.tier, expected: payload.expectedTier, pass, latencyMs });
    } catch (err) {
      console.error(`  ❌ 錯誤: ${err.message}`);
      results.push({ label: payload.label, pass: false, error: err.message });
    }

    console.log();
  }

  // 摘要報告
  const passed = results.filter(r => r.pass).length;
  console.log("=== 測試摘要 ===");
  console.log(`通過: ${passed} / ${results.length}`);
  console.log(`平均延遲: ${Math.round(results.reduce((s, r) => s + (r.latencyMs || 0), 0) / results.length)}ms`);

  if (passed < results.length) {
    console.log("\n失敗項目:");
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.label}: ${r.error || `got ${r.tier}, expected ${r.expected}`}`));
  }

  console.log("\n=== WAL 落盤驗證 ===");
  const fs = require('fs');
  const walPath = require('path').join(__dirname, '../../logs/ccb_domain_events.jsonl');
  if (fs.existsSync(walPath)) {
    const lines = fs.readFileSync(walPath, 'utf-8').trim().split('\n').filter(Boolean);
    console.log(`WAL 總計: ${lines.length} 筆`);
    const redFlags = lines.map(l => JSON.parse(l)).filter(e => e.type === 'RED_FLAG_TRIGGERED');
    console.log(`紅旗事件: ${redFlags.length} 筆`);
    redFlags.forEach(e => console.log(`  → ${e.flag} (${e.ts})`));
  } else {
    console.log("WAL 檔案不存在");
  }
}

runSmokeTest().catch(console.error);

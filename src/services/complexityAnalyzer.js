
/**
 * CCB v0.12.2 - Tier 1 Static Complexity Analyzer
 * 0ms 靜態特徵攔截，直接從 source_map 載入紅旗規則
 */

const sourceMap = require("../config/source_map.json");
const { logDomainEvent } = require("../utils/walLogger");

// 從 source_map 讀取強制轉介觸發詞，補充中文臨床術語
const MANDATORY_REFERRAL = sourceMap.Safety_Rules.Mandatory_Referral_Triggers;
const NON_ARBITRABLE = sourceMap.Safety_Rules.Non_Arbitrable_Topics;

const RED_FLAG_KEYWORDS = [
  // 來自 source_map（英文）
  ...MANDATORY_REFERRAL,
  ...NON_ARBITRABLE,
  // 中文臨床高風險術語
  "夜間劇痛", "不明原因體重減輕", "雙側症狀", "脊髓病變",
  "椎基底動脈", "神經缺損", "二便失禁", "馬尾症候群",
  "胸痛", "呼吸困難", "昏迷", "意識不清", "抽搐", "休克",
];

// 中文每字語意密度高，閾值設 15（只攔截「你好」「謝謝」等真正簡短問候）
const SIMPLE_TASK_MAX_LENGTH = 15;

/**
 * @returns {{ tier: 'local' | 'fast' | 'evaluate', reason: string, bypassed: boolean }}
 */
function analyzeStaticComplexity(userInput) {
  const input = userInput.trim();

  // Tier 1-A：紅旗 → 強制本地 DeepSeek，不外流
  const triggeredFlag = RED_FLAG_KEYWORDS.find(kw =>
    input.toLowerCase().includes(kw.toLowerCase())
  );
  if (triggeredFlag) {
    logDomainEvent("RED_FLAG_TRIGGERED", {
      flag: triggeredFlag,
      inputLength: input.length,
      tier: "local",
    });
    return {
      tier: "local",
      reason: `紅旗觸發: "${triggeredFlag}"`,
      bypassed: true,
    };
  }

  // Tier 1-B：極短輸入 → 直接 Groq 快速處理
  if (input.length < SIMPLE_TASK_MAX_LENGTH) {
    return {
      tier: "fast",
      reason: `短輸入 (${input.length} chars < ${SIMPLE_TASK_MAX_LENGTH})`,
      bypassed: true,
    };
  }

  // 其餘進入 Tier 2 LLM 語意評估
  return {
    tier: "evaluate",
    reason: "需要 LLM 語意複雜度評估",
    bypassed: false,
  };
}

module.exports = { analyzeStaticComplexity };

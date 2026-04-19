
const sourceMap = require("../config/source_map.json");
const { getGeminiRoutingDecision } = require("../services/geminiService");
const { getGroqRoutingDecision, getGroqRouterStats } = require("../services/groqService");
const { analyzeStaticComplexity } = require("../services/complexityAnalyzer");
const { arbitrateClinicalData } = require("../services/arbitratorService");
const { generateMermaidDiagram } = require("../services/qwenService");
const { saveToObsidian } = require("../utils/obsidianWriter");

// Tier 2：Groq 優先（含 complexity_score），失敗 fallback 到 Gemini
async function getTier2RoutingDecision(prompt) {
  try {
    const { tasks, complexityScore } = await getGroqRoutingDecision(prompt);
    console.log("├─ [Tier 2] Groq UCB 路由成功");
    return { tasks, complexityScore, router: "groq" };
  } catch {
    console.warn("├─ [Tier 2] Groq 不可用，切換至 Gemini...");
    const tasks = await getGeminiRoutingDecision(prompt);
    return { tasks, complexityScore: 0.6, router: "gemini" };
  }
}

/**
 * 決定仲裁步驟應使用本地 DeepSeek 還是跳過
 * score > 0.7  → 本地 DeepSeek-R1 14B（高複雜度）
 * score 0.4~0.7 → Gemini 處理（中等複雜度）
 * score < 0.4  → Groq 已直接處理，跳過額外仲裁
 */
function resolveArbitrationModel(complexityScore) {
  if (complexityScore > 0.7) return "deepseek";
  if (complexityScore >= 0.4) return "gemini";
  return "groq";
}

// 根據來源書名獲取權重
function getWeightForSource(sourceName) {
  if (!sourceName) return 0.5;
  const key = Object.keys(sourceMap.Weights).find(k => sourceName.includes(k));
  return key ? sourceMap.Weights[key] : 0.6;
}

/**
 * CCB 系統終極控制器：全自動化臨床決策流水線
 */
async function handleCCBRequest(req, res) {
  const { prompt, geminiOutput } = req.body;

  if (!geminiOutput) {
    return res.status(400).json({ error: "請提供來自 Gemini 的 Primary_JSON 數據" });
  }

  try {
    console.log("\n🚀 [CCB 系統啟動] 開始處理臨床評估流程...");

    // ==========================================
    // 步驟 1-A: Tier 1 靜態複雜度攔截 (0ms, 0 Token)
    // ==========================================
    console.log("├─ [步驟 1-A] Tier 1 靜態規則掃描...");
    const staticEval = analyzeStaticComplexity(prompt);
    let complexityScore;
    let arbitrationModel;

    if (staticEval.bypassed) {
      // 紅旗 → 強制本地；短輸入 → 快速外部
      complexityScore = staticEval.tier === "local" ? 1.0 : 0.2;
      arbitrationModel = resolveArbitrationModel(complexityScore);
      console.log(`├─ [步驟 1-A] Tier 1 命中: ${staticEval.reason} → ${arbitrationModel} (score=${complexityScore})`);
    } else {
      // ==========================================
      // 步驟 1-B: Tier 2 動態語意評估 (Groq → Gemini fallback)
      // ==========================================
      console.log("├─ [步驟 1-B] Tier 2 語意複雜度評估中...");
      const { complexityScore: score, router: routerUsed } = await getTier2RoutingDecision(prompt);
      complexityScore = score;
      arbitrationModel = resolveArbitrationModel(complexityScore);
      const groqStatus = getGroqRouterStats().map(s => `Key#${s.index}:${s.available ? '✅' : '❄️'}`).join(' ');
      console.log(`├─ [步驟 1-B] 語意評估完成 | score=${complexityScore} → ${arbitrationModel} | router=${routerUsed} | ${groqStatus}`);
    }

    // ==========================================
    // 步驟 1: 權重注入
    // ==========================================
    console.log("├─ [步驟 1] 正在注入學術權重...");
    let weightedData;
    const parsedOutput = typeof geminiOutput === 'string' ? JSON.parse(geminiOutput) : geminiOutput;
    
    const addWeights = (obj) => {
      if (Array.isArray(obj)) return obj.map(addWeights);
      if (typeof obj === 'object' && obj !== null) {
        const newObj = { ...obj };
        if (newObj.source) newObj.academic_weight = getWeightForSource(newObj.source);
        for (const key in newObj) newObj[key] = addWeights(newObj[key]);
        return newObj;
      }
      return obj;
    };
    weightedData = addWeights(parsedOutput);

    // ==========================================
    // 步驟 2: 臨床仲裁（模型由複雜度決定）
    // ==========================================
    console.log(`├─ [步驟 2] 仲裁模型: ${arbitrationModel} (complexity=${complexityScore})`);
    const arbitratedString = await arbitrateClinicalData(weightedData, arbitrationModel);
    const cleanJsonString = arbitratedString.replace(/```json|```/g, "").trim();
    const arbitratedJson = JSON.parse(cleanJsonString);

    // ==========================================
    // 步驟 3: 視覺化轉譯與繁中總編 (Qwen 7B)
    // ==========================================
    console.log("├─ [步驟 3] 7B 總編輯正在生成 Mermaid 流程圖...");
    const mermaidOutput = await generateMermaidDiagram(arbitratedJson);

    // ==========================================
    // 步驟 4: 自動化寫入 Obsidian
    // ==========================================
    console.log("├─ [步驟 4] 正在自動存檔至 Obsidian LifeOS...");
    const pathwayName = arbitratedJson.pathway_id || "Clinical_Pathway";
    const savedPath = saveToObsidian(pathwayName, mermaidOutput, arbitratedJson);

    console.log("└─ 🎉 [CCB 系統完成] 臨床流程圖已產出並自動存檔！");

    return res.json({
      status: "success",
      file_path: savedPath,
      pipeline_result: {
        arbitrated_json: arbitratedJson,
        mermaid_code: mermaidOutput
      }
    });

  } catch (error) {
    console.error("\n❌ [CCB Controller] 流程崩潰:", error);
    return res.status(500).json({ error: "系統內部處理失敗: " + error.message });
  }
}

module.exports = { handleCCBRequest };


const Groq = require("groq-sdk");
const { GroqRouter } = require("./groqRouter");

const GROQ_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4,
];

// 單例 Router，存活於 Node.js 進程生命週期（Local Memory）
const router = new GroqRouter(GROQ_KEYS);

const ROUTING_SYSTEM_PROMPT = `
你是一位極速 AI 任務調度官 (CCB Commander)。
請將使用者請求拆解為多個子任務，並評估整體臨床複雜度。

【複雜度評分標準 (0.0 ~ 1.0)】
- 0.0 ~ 0.3: 日常問答、名詞解釋、單純格式轉換。
- 0.4 ~ 0.7: 一般病情分析、常規用藥建議、輕度症狀分類。
- 0.8 ~ 1.0: 罕見疾病推理、多重併發症、高風險醫療決策。

模型清單：
1. deepseek: 深度邏輯、複雜推理、學術仲裁（本地高成本）。
2. gemini: 巨量文獻結構化提取（中等成本）。
3. groq: 日常問答、簡單分類（低成本快速）。

請嚴格回傳 JSON 物件（不要有 markdown 標記）：
{
  "complexity_score": 0.85,
  "tasks": [
    {"t": "子任務內容", "m": "模型名稱", "d": "領域(med/code/gen)"}
  ]
}
`;

async function getGroqRoutingDecision(userInput) {
  const { key: selectedKey, reason } = router.selectKey(600);

  // 所有 Key 不可用 → 拋出讓上層 fallback 到 Gemini
  if (!selectedKey) {
    console.warn(`[GroqService] ${reason}，轉交 Gemini 處理`);
    throw new Error('GROQ_ALL_KEYS_UNAVAILABLE');
  }

  const groq = new Groq({ apiKey: selectedKey.key });

  try {
    const start = Date.now();
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: ROUTING_SYSTEM_PROMPT },
        { role: "user", content: userInput },
      ],
      model: "llama-3.3-70b-versatile",
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 512,
    });

    const tokensUsed = chatCompletion.usage?.total_tokens || 500;
    const latencyMs = Date.now() - start;

    router.recordSuccess(selectedKey, tokensUsed);

    console.log(
      `[GroqService] Key #${selectedKey.index} 成功 | ` +
      `tokens=${tokensUsed} | latency=${latencyMs}ms | ` +
      `ucb=${selectedKey.ucbScore(router.globalT).toFixed(3)}`
    );

    const parsed = JSON.parse(chatCompletion.choices[0].message.content);
    return {
      tasks: parsed.tasks,
      complexityScore: parsed.complexity_score ?? 0.5,
    };

  } catch (error) {
    if (error.status === 429) {
      // 優先讀取 Groq 回傳的精確冷卻秒數
      const retryAfter = parseInt(error.headers?.['retry-after']) || 60;
      router.record429(selectedKey, retryAfter);
    } else {
      router.recordFailure(selectedKey);
    }
    throw error;
  }
}

function getGroqRouterStats() {
  return router.getStats();
}

module.exports = { getGroqRoutingDecision, getGroqRouterStats };

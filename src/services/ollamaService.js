
const OLLAMA_URL = "http://localhost:11434/api/chat";

// DeepSeek-R1 14B 思維鏈本身就耗 context，給足空間
const MODEL_CTX = {
  "deepseek-r1:14b": 8192,
  "qwen2.5:7b": 4096,
};
const DEFAULT_CTX = 4096;

/**
 * 呼叫本地模型 (14B 或 7B)
 * @param {object[]} messages
 * @param {string} modelName
 * @param {{ numCtx?: number, keepAlive?: number | string }} opts
 *   keepAlive:  0  = 推論完立即釋放（冷啟動測試用）
 *              -1  = 永駐 VRAM（暖啟動測試 / 生產用）
 *             預設 = 由 Ollama 管理（5 分鐘）
 */
async function callLocalModel(messages, modelName = "deepseek-r1:14b", opts = {}) {
  const numCtx = opts.numCtx ?? MODEL_CTX[modelName] ?? DEFAULT_CTX;

  const body = {
    model: modelName,
    messages,
    stream: false,
    options: {
      temperature: 0.6,
      num_ctx: numCtx,
    },
  };

  // 只在明確指定時才傳 keep_alive，避免覆蓋 Ollama 預設行為
  if (opts.keepAlive !== undefined) {
    body.keep_alive = opts.keepAlive;
  }

  try {
    const loadStart = Date.now();
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Ollama Error: ${response.statusText}`);

    const data = await response.json();
    const totalMs = Date.now() - loadStart;

    // load_duration = 模型載入時間（冷啟動時非零）
    const loadMs = Math.round((data.load_duration ?? 0) / 1e6);
    const evalMs = Math.round((data.eval_duration ?? 0) / 1e6);

    console.log(
      `[Ollama] ${modelName} | total=${totalMs}ms` +
      ` load=${loadMs}ms eval=${evalMs}ms` +
      ` tokens=${data.eval_count ?? '?'} ctx=${numCtx}`
    );

    return data.message.content;
  } catch (error) {
    console.error(`[Local Model] ${modelName} 呼叫失敗:`, error);
    throw error;
  }
}

module.exports = { callLocalModel };

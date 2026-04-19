
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
 * @param {{ numCtx?: number }} opts - 可覆寫 context window
 */
async function callLocalModel(messages, modelName = "deepseek-r1:14b", opts = {}) {
  const numCtx = opts.numCtx ?? MODEL_CTX[modelName] ?? DEFAULT_CTX;

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        messages: messages,
        stream: false,
        options: {
          temperature: 0.6,
          num_ctx: numCtx,
        }
      })
    });

    if (!response.ok) throw new Error(`Ollama Error: ${response.statusText}`);

    const data = await response.json();
    console.log(`[Ollama] ${modelName} | num_ctx=${numCtx} | tokens=${data.eval_count ?? '?'}`);
    return data.message.content;
  } catch (error) {
    console.error(`[Local Model] ${modelName} 呼叫失敗:`, error);
    throw error;
  }
}

module.exports = { callLocalModel };

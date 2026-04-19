
/**
 * CCB v0.12.2 - Model Output Sanitizer
 * 處理 DeepSeek-R1 的 <think> 思維鏈污染與 markdown 包裝
 */

/**
 * 清理 R1 / 其他模型的原始輸出，提取純淨 JSON 字串
 * 處理順序：<think> 標籤 → markdown fences → 首尾空白
 */
function sanitizeModelOutput(raw) {
  if (typeof raw !== 'string') return raw;

  // 1. 移除 <think>...</think> 思維鏈（含多行、巢狀換行）
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // 2. 移除 markdown code fences（```json ... ``` 或 ``` ... ```）
  cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1');

  // 3. 移除首尾空白與多餘換行
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * 解析並驗證 JSON，失敗時附帶原始內容方便 debug
 */
function parseJsonSafe(raw, context = 'unknown') {
  const cleaned = sanitizeModelOutput(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error(`[Sanitizer] JSON 解析失敗 (context=${context})`);
    console.error(`[Sanitizer] 清理後內容 (前 300 字): ${cleaned.slice(0, 300)}`);
    throw new Error(`JSON 解析失敗: ${err.message}`);
  }
}

module.exports = { sanitizeModelOutput, parseJsonSafe };

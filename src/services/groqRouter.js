
/**
 * CCB v0.12.2 - Groq Adaptive Key Router
 * MAB/UCB 演算法 + 429 感知冷卻 + Token Budget 追蹤
 */

const EXPLORATION_COEFF = 2.0;

// Groq llama-3.3-70b-versatile 免費方案限制（保守估計）
const TPM_LIMIT = 5000;    // tokens per minute per key
const RPM_LIMIT = 30;      // requests per minute per key

class GroqKeyState {
  constructor(key, index) {
    this.key = key;
    this.index = index;
    this.totalCalls = 0;
    this.totalReward = 0;
    this.cooldownUntil = 0;
    // Token budget 追蹤（滑動視窗 60 秒）
    this.requestTimestamps = [];
    this.tokenUsageWindow = [];
  }

  isAvailable() {
    return Date.now() >= this.cooldownUntil;
  }

  isUnderBudget(estimatedTokens = 500) {
    const now = Date.now();
    const windowStart = now - 60_000;

    // 清除超過 60 秒的記錄
    this.requestTimestamps = this.requestTimestamps.filter(t => t > windowStart);
    this.tokenUsageWindow = this.tokenUsageWindow.filter(t => t.ts > windowStart);

    const recentRequests = this.requestTimestamps.length;
    const recentTokens = this.tokenUsageWindow.reduce((sum, t) => sum + t.tokens, 0);

    return recentRequests < RPM_LIMIT && (recentTokens + estimatedTokens) < TPM_LIMIT;
  }

  recordRequest(tokensUsed = 500) {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.tokenUsageWindow.push({ ts: now, tokens: tokensUsed });
  }

  ucbScore(globalT) {
    if (this.totalCalls === 0) return Infinity;
    const avgReward = this.totalReward / this.totalCalls;
    const exploration = EXPLORATION_COEFF * Math.sqrt(Math.log(globalT) / this.totalCalls);
    return avgReward + exploration;
  }
}

class GroqRouter {
  constructor(keys) {
    this.states = keys
      .filter(k => k)
      .map((key, index) => new GroqKeyState(key, index));
    this.globalT = 1;
  }

  selectKey(estimatedTokens = 500) {
    const now = Date.now();
    const available = this.states.filter(
      s => s.isAvailable() && s.isUnderBudget(estimatedTokens)
    );

    if (available.length === 0) {
      // 計算最早解除冷卻的時間，供上層決定是否要 fallback
      const earliest = this.states.reduce(
        (min, s) => Math.min(min, s.cooldownUntil),
        Infinity
      );
      const waitMs = Math.max(0, earliest - now);
      return { key: null, waitMs, reason: 'ALL_KEYS_UNAVAILABLE' };
    }

    const best = available.reduce((prev, curr) =>
      curr.ucbScore(this.globalT) > prev.ucbScore(this.globalT) ? curr : prev
    );

    return { key: best, waitMs: 0, reason: 'OK' };
  }

  recordSuccess(keyState, tokensUsed = 500) {
    keyState.totalCalls++;
    keyState.totalReward += 1.0;
    keyState.recordRequest(tokensUsed);
    this.globalT++;
  }

  record429(keyState, retryAfterSeconds = 60) {
    keyState.totalCalls++;
    keyState.totalReward -= 0.5;
    keyState.cooldownUntil = Date.now() + retryAfterSeconds * 1000;
    keyState.recordRequest(0);
    this.globalT++;
    console.warn(
      `[GroqRouter] Key #${keyState.index} 觸發 429，冷卻 ${retryAfterSeconds}s`
    );
  }

  recordFailure(keyState) {
    keyState.totalCalls++;
    keyState.totalReward -= 1.0;
    keyState.cooldownUntil = Date.now() + 300_000;
    this.globalT++;
    console.error(`[GroqRouter] Key #${keyState.index} 完全失敗，冷卻 300s`);
  }

  getStats() {
    return this.states.map(s => ({
      index: s.index,
      available: s.isAvailable(),
      cooldownUntil: s.cooldownUntil > Date.now() ? new Date(s.cooldownUntil).toISOString() : null,
      totalCalls: s.totalCalls,
      avgReward: s.totalCalls > 0 ? (s.totalReward / s.totalCalls).toFixed(3) : 'N/A',
      recentRPM: s.requestTimestamps.filter(t => t > Date.now() - 60_000).length,
    }));
  }
}

module.exports = { GroqRouter };

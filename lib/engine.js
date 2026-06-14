/**
 * engine.js — 集中代理 Python FastAPI 引擎（階段 6 gateway）。
 *
 * - base URL 走 `ENGINE_BASE_URL`（預設 http://127.0.0.1:8000），lazy 讀避免 require 順序坑。
 * - 用 Node 22 內建 global `fetch` + AbortController 做 per-call timeout（無第三方依賴）。
 * - 統一錯誤轉譯成 EngineError（帶 HTTP status/code/detail），由上層 sendError 輸出：
 *     連不到引擎      → 503 ENGINE_UNAVAILABLE（degradation 判斷依據）
 *     呼叫逾時        → 504 UPSTREAM_TIMEOUT
 *     引擎 400/422    → 400 BAD_REQUEST
 *     引擎 404        → 404 NOT_FOUND
 *     引擎 5xx/其它   → 502 ENGINE_ERROR
 *
 * gateway 只組合/轉發/降級，不重算數字；此檔不含任何業務邏輯。
 */
'use strict';

function baseUrl() {
  return process.env.ENGINE_BASE_URL || 'http://127.0.0.1:8000';
}

class EngineError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function buildUrl(path, params) {
  const url = new URL(path, baseUrl());
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function briefDetail(d) {
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message;
  return null;
}

async function engineRequest(method, path, { params, body, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let resp;
  try {
    resp = await fetch(buildUrl(path, params), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new EngineError(504, 'UPSTREAM_TIMEOUT',
        `engine 呼叫逾時（${timeout}ms）：${method} ${path}`, String((err && err.message) || err));
    }
    throw new EngineError(503, 'ENGINE_UNAVAILABLE',
      `engine 服務無法連線（${baseUrl()}）`, String((err && err.message) || err));
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  const text = await resp.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (resp.ok) return data;

  // 引擎回了非 2xx → 依 status 轉譯
  const detail = (data && typeof data === 'object') ? (data.detail ?? data.error ?? data) : data;
  if (resp.status === 400 || resp.status === 422) {
    throw new EngineError(400, 'BAD_REQUEST', briefDetail(detail) || `engine 參數錯誤（${resp.status}）`, detail);
  }
  if (resp.status === 404) {
    throw new EngineError(404, 'NOT_FOUND', briefDetail(detail) || 'engine 查無資源', detail);
  }
  throw new EngineError(502, 'ENGINE_ERROR', briefDetail(detail) || `engine 回應 ${resp.status}`, detail);
}

const engineGet = (path, params, timeout) => engineRequest('GET', path, { params, timeout });
const enginePost = (path, body, timeout) => engineRequest('POST', path, { body, timeout });

async function engineHealthy(timeout = 4000) {
  try {
    await engineGet('/health', null, timeout);
    return true;
  } catch {
    return false;
  }
}

module.exports = { baseUrl, EngineError, engineRequest, engineGet, enginePost, engineHealthy };

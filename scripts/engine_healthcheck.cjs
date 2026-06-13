/**
 * engine_healthcheck.cjs — Node ↔ Python 引擎串接 demo（階段 1）
 *
 * 呼叫 FastAPI 引擎 GET /health 並印出結果，驗證 Node 內容線可與 Python 引擎走 HTTP 溝通。
 * 完全不碰 puhui_daily 內容線。
 *
 * 用法：node scripts/engine_healthcheck.cjs [baseUrl]
 *   預設 baseUrl = http://127.0.0.1:8000（或環境變數 ENGINE_URL）
 *
 * 退出碼：0 = 串接成功；1 = 連線失敗或非預期回應。
 */
const http = require('http');

const BASE = (process.argv[2] || process.env.ENGINE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const url = `${BASE}/health`;

function getJson(u) {
  return new Promise((resolve, reject) => {
    const req = http.get(u, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d) });
        } catch (_) {
          resolve({ status: res.statusCode, body: d });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout 5s')));
  });
}

(async () => {
  console.log(`[engine-healthcheck] GET ${url}`);
  try {
    const { status, body } = await getJson(url);
    console.log(`[engine-healthcheck] HTTP ${status}`);
    console.log(JSON.stringify(body, null, 2));
    if (status === 200 && body && body.status === 'ok') {
      console.log('[engine-healthcheck] ✅ Node ↔ Python 串接成功');
      process.exit(0);
    }
    console.error('[engine-healthcheck] ❌ 非預期回應');
    process.exit(1);
  } catch (e) {
    console.error(`[engine-healthcheck] ❌ 連線失敗: ${e.message}`);
    console.error('  請先啟動引擎：cd engine && .\\.venv\\Scripts\\python -m uvicorn app.main:app --port 8000');
    process.exit(1);
  }
})();

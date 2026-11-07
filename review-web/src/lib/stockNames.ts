// 代號 → 中文股名（攤平計算機用）。
//
// 玉山同步的庫存從 2026-11-07 起才帶 stk_na；在那之前存下來的快照、以及手動輸入只填代號的個股，
// 都沒有名稱。這裡用既有的 /api/symbols/search（引擎 FinMind TaiwanStockInfo，含上市櫃與 ETF，
// 閘道本身已有 6 小時快取）補上，只收「代號完全相符」的那一筆。
// 結果在整個分頁存活期間快取在記憶體；網路失敗／服務降級不快取，下次還會再試。
import { api, type SymbolHit } from './api';

/** 從搜尋結果挑出代號完全相符的股名；沒有就回 null（前綴相符、名稱子字串相符都不算）。 */
export function pickName(code: string, hits: readonly SymbolHit[] | null | undefined): string | null {
  const c = code.trim().toUpperCase();
  if (!c || !hits) return null;
  for (const h of hits) {
    if (h && typeof h.code === 'string' && h.code.trim().toUpperCase() === c) {
      const n = typeof h.name === 'string' ? h.name.trim() : '';
      if (n) return n;
    }
  }
  return null;
}

/** 看起來像台股／ETF 代號才去查（4～6 碼數字，可帶一個尾字母，如 2330、00631L、00981A） */
export function looksLikeCode(code: string): boolean {
  return /^\d{4,6}[A-Za-z]?$/.test(code.trim());
}

const cache = new Map<string, string | null>(); // null＝查過、確定沒有
const inflight = new Map<string, Promise<string | null>>();

/** 查一檔的股名。查得到回名稱、確定沒有回 null；網路錯誤或服務降級時回 null 且不快取。 */
export function lookupStockName(code: string): Promise<string | null> {
  const c = code.trim().toUpperCase();
  if (!looksLikeCode(c)) return Promise.resolve(null);
  if (cache.has(c)) return Promise.resolve(cache.get(c) ?? null);
  const pending = inflight.get(c);
  if (pending) return pending;
  const p = api.symbolSearch(c, 10)
    .then((res) => {
      const name = pickName(c, res.results);
      if (name) cache.set(c, name);
      else if (!res.degraded) cache.set(c, null);
      return name;
    })
    .catch(() => null)
    .finally(() => { inflight.delete(c); });
  inflight.set(c, p);
  return p;
}

/** 測試用：清空快取 */
export function _resetStockNameCache(): void {
  cache.clear();
  inflight.clear();
}

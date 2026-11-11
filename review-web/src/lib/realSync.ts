// 玉山「真實同步」：叫 VM 重抓整戶庫存（唯讀、不下單），輪詢到新快照出現後回傳。
// 流程與再平衡頁／攤平計算機的同步一致（觸發 → 每 3 秒輪詢狀態與 saved_at，最多約 3 分鐘）。
import { api } from './api';
import type { FullInventoryPosition, RebalanceHoldingsResp } from './api';
import type { UserStock } from './userStore';

export async function runRealSync(): Promise<RebalanceHoldingsResp> {
  const baseline = (await api.getRebalanceHoldings()).saved_at;
  await api.triggerRealSync();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const s = await api.getRealSyncStatus();
      if (s.state === 'error') throw new SyncFailed(s.message || '同步失敗');
      const resp = await api.getRebalanceHoldings();
      if (resp.exists && resp.saved_at && resp.saved_at !== baseline) return resp;
    } catch (e) {
      if (e instanceof SyncFailed) throw e;
      /* 單次輪詢失敗不中斷 */
    }
  }
  throw new Error('逾時未收到更新（同步跑在 VM 上，請看 VM 的 data/sync_holdings_status.json）');
}

class SyncFailed extends Error {}

/**
 * 把實際持股轉成資料夾用的 UserStock：只收股數 > 0 的、同代號只留一筆
 * （玉山整股／零股會是兩筆）、已經在資料夾裡的略過。
 */
export function holdingsToNewStocks(
  positions: FullInventoryPosition[],
  existingCodes: Iterable<string>,
  now: string = new Date().toISOString(),
): UserStock[] {
  const seen = new Set<string>();
  for (const c of existingCodes) seen.add(c.trim().toUpperCase());
  const out: UserStock[] = [];
  for (const p of positions) {
    const code = (p.code ?? '').trim().toUpperCase();
    if (!code || !(p.shares > 0) || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: (p.name ?? '').trim(), added_at: now });
  }
  return out;
}

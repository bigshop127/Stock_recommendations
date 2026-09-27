import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { StockMetricsResp, HeatmapStock } from './api';
import { CODE_TO_GROUP, STOCK_GROUPS } from './stockGroups';
import { buildPeerValuation, peerCodesFor } from './peerValuation';
import type { PeerValuation } from './peerValuation';

export interface PeerValuationState {
  data: PeerValuation | null;
  meta: StockMetricsResp | null;
  loading: boolean;
  error: string | null;
  /** 沒有細分族群（上櫃、ETF、刻意不收錄）→ 不顯示卡片 */
  unsupported: boolean;
}

/**
 * 抓同業估值（gateway 有 10 分鐘快取、前端同組代號也共用），算合理價＋同業排名。
 * enabled=false 時不發請求（例如還沒切到產業分析分頁）。
 */
export function usePeerValuation(
  code: string,
  heat: HeatmapStock[] | null,
  price: number | null,
  enabled = true,
): PeerValuationState {
  const groupRef = CODE_TO_GROUP.get(code);
  // 結果連同代號一起存：換股後舊結果自動不算數，loading 由「還沒有這一檔的結果」推出來
  const [result, setResult] = useState<{ code: string; meta: StockMetricsResp | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !groupRef) return;
    let cancelled = false;
    api.getStockMetrics(peerCodesFor(code, groupRef, STOCK_GROUPS))
      .then((meta) => { if (!cancelled) setResult({ code, meta, error: null }); })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ code, meta: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => { cancelled = true; };
  }, [code, enabled, groupRef]);

  const current = result?.code === code ? result : null;
  const meta = current?.meta ?? null;
  const data = useMemo(
    () => (meta ? buildPeerValuation(code, groupRef, STOCK_GROUPS, meta.items, heat, price) : null),
    [meta, code, groupRef, heat, price],
  );

  return {
    data,
    meta,
    loading: enabled && !!groupRef && !current,
    error: current?.error ?? null,
    unsupported: !groupRef,
  };
}

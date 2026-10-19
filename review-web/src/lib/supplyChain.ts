// AI 產業鏈 3D 頁（/supply-chain）的台股索引查詢：個股頁標籤、3D 頁外層抓收盤價都從這裡拿。
// 索引由 tools/build-supply-chain-index.ts 從 3D 頁產生，見 supplyChainBuild.ts 檔頭。
import type { SupplyChainCompany, SupplyChainIndex } from './supplyChainBuild';
import indexJson from './supplyChainIndex.json';

const INDEX = indexJson as SupplyChainIndex;

/** 3D 頁上所有有台股代號的公司 */
export const SUPPLY_CHAIN_CODES = Object.keys(INDEX.companies);

/** 這個代號在 3D 頁出現在哪些場景；不在圖上回 null */
export function supplyChainOf(code: string): SupplyChainCompany | null {
  return INDEX.companies[code] ?? null;
}

const MAX_SCENES_IN_LABEL = 3;

/** 個股頁標籤：「AI 產業鏈：CoWoS 封裝・封測檢測」，場景太多只列前三個 */
export function supplyChainLabel(c: SupplyChainCompany): string {
  const names = c.spots.map((s) => s.sceneName);
  const shown = names.slice(0, MAX_SCENES_IN_LABEL).join('・');
  return `AI 產業鏈：${shown}${names.length > MAX_SCENES_IN_LABEL ? ` 等 ${names.length} 處` : ''}`;
}

/** 滑過去看的說明：每個場景一行，列出零件 */
export function supplyChainDetail(c: SupplyChainCompany): string {
  const lines = c.spots.map((s) => `${s.stageName}・${s.sceneName}${s.parts.length ? `：${s.parts.join('、')}` : '（代表廠商）'}`);
  return [...lines, `資料截至 ${INDEX.asOf}，點了打開 3D 拆解圖並標亮`].join('\n');
}
